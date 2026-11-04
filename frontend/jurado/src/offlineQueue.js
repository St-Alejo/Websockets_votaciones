// Cola offline de envíos de actas (RT-6). Sin dependencias de navegador aquí:
// el almacenamiento se inyecta (IndexedDB en app, memoria en tests).
// - Cada envío genera su `idem` UNA vez y lo reutiliza en todos los reintentos
//   (la idempotencia del servidor complementa: reenvíos → `duplicada`, no duplican).
// - Stop-and-wait: un solo envío en vuelo; la correlación es exacta sin cambiar
//   el protocolo (la `respuesta` no trae eco del idem).
// - PENDING nunca se borra por intentar: solo pasa a ACKNOWLEDGED (el servidor
//   confirmó) o FAILED (rechazo estructural o intentos agotados, reintentable).

export const ESTADOS = Object.freeze({
  PENDING: 'PENDING',
  SENDING: 'SENDING',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  FAILED: 'FAILED',
});

/** Respuestas del servidor que confirman recepción (aunque pidan revisión). */
const CONFIRMA = new Set(['registrada', 'duplicada', 'version_obsoleta', 'conflicto', 'dudosa']);

export function crearColaOffline({
  storage,
  generarId = () => (crypto?.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random()}`),
  ahora = () => Date.now(),
  esperar = (ms) => new Promise((r) => setTimeout(r, ms)),
  baseMs = 1000,
  maxMs = 30_000,
  maxIntentos = 20,
} = {}) {
  if (!storage) throw new Error('storage requerido');
  const oyentes = new Set();
  let procesando = false;
  const avisos = () => {
    for (const fn of [...oyentes]) fn();
  };

  /** Guarda el acta ANTES de transmitirla. Devuelve el envío PENDING. */
  async function guardar(acta, idem = null) {
    const envio = {
      id: generarId(),
      idem: idem ?? generarId(),
      acta,
      estado: ESTADOS.PENDING,
      intentos: 0,
      ultimoError: null,
      respuesta: null,
      creadaEn: ahora(),
      actualizadaEn: ahora(),
    };
    await storage.put(envio);
    avisos();
    return envio;
  }

  async function listar() {
    const todos = await storage.getAll();
    return todos.sort((a, b) => a.creadaEn - b.creadaEn);
  }

  async function obtener(id) {
    return storage.get(id);
  }

  async function marcar(id, parche) {
    const previo = await storage.get(id);
    if (!previo) return null;
    const envio = { ...previo, ...parche, actualizadaEn: ahora() };
    await storage.put(envio);
    avisos();
    return envio;
  }

  /** Delay con backoff exponencial + jitter (el jitter evita tormentas al volver la red). */
  function demoraPara(intentos) {
    return Math.min(maxMs, baseMs * 2 ** intentos) + Math.random() * 500;
  }

  /**
   * Procesa la cola en orden. `puedeEnviar` dice si hay transporte;
   * `enviar(envio)` resuelve con la RespuestaRegistro o lanza ante fallo de red.
   * Nunca borra envíos: ante fallo de red quedan PENDING con intentos++.
   */
  async function procesar({ puedeEnviar, enviar }) {
    if (procesando) return;
    procesando = true;
    try {
      for (;;) {
        const pendientes = (await listar()).filter((e) => e.estado === ESTADOS.PENDING);
        if (pendientes.length === 0) return;
        if (!puedeEnviar()) return;
        const envio = pendientes[0];
        await marcar(envio.id, { estado: ESTADOS.SENDING });
        let respuesta;
        try {
          respuesta = await enviar(envio);
        } catch (err) {
          const intentos = envio.intentos + 1;
          if (intentos >= maxIntentos) {
            await marcar(envio.id, {
              estado: ESTADOS.FAILED,
              intentos,
              ultimoError: err?.message ?? 'fallo de red',
            });
            return;
          }
          await marcar(envio.id, {
            estado: ESTADOS.PENDING,
            intentos,
            ultimoError: err?.message ?? 'fallo de red',
          });
          const ms = demoraPara(intentos);
          procesando = false;
          await esperar(ms);
          return procesar({ puedeEnviar, enviar });
        }
        if (respuesta && CONFIRMA.has(respuesta.estado)) {
          await marcar(envio.id, { estado: ESTADOS.ACKNOWLEDGED, respuesta, ultimoError: null });
          // Sigue con el siguiente (mismo tick: la red está bien).
        } else {
          await marcar(envio.id, {
            estado: ESTADOS.FAILED,
            respuesta: respuesta ?? null,
            ultimoError: respuesta?.motivo ?? `estado ${respuesta?.estado ?? 'desconocido'}`,
          });
          return; // Rechazo estructural: requiere corrección manual, no reintentar solo.
        }
      }
    } finally {
      procesando = false;
    }
  }

  /** Devuelve un FAILED a PENDING para reintento manual. */
  async function reintentar(id) {
    return marcar(id, { estado: ESTADOS.PENDING, ultimoError: null });
  }

  function suscribir(fn) {
    oyentes.add(fn);
    return () => oyentes.delete(fn);
  }

  return { guardar, listar, obtener, procesar, reintentar, suscribir, demoraPara, ESTADOS };
}
