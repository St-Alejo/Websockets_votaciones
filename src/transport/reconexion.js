// Dueño: Persona 2. Reanudación (RF-6) y reintento con jitter (RF-10).
// El cursor llega por el header Last-Event-ID (SSE) o por ?ultimo_id=.
// Si el historial de stream:actas alcanza, se reenvían los deltas perdidos
// del tópico. Si el stream fue recortado o el hueco es demasiado grande,
// se cae a un snapshot completo.
import { parsearTopico } from '../contratos/canales.js';
import { obtenerRedis } from '../redis/cliente.js';
import { leerDesde as leerStream } from '../redis/historial.js';

/** Adapta la firma de Persona 1: leerDesde(redis, cursor, max) y el campo hay_mas. */
async function leerHistorialPublico(cursor, max) {
  const hist = await leerStream(obtenerRedis(), cursor, max);
  if (!hist) return hist;
  return { ...hist, hayMas: Boolean(hist.hayMas || hist.hay_mas) };
}

/** Header Last-Event-ID gana sobre el query: es el cursor que el navegador reenvía. */
export function leerCursor(req = {}) {
  const headers = req.headers ?? {};
  const crudo =
    headers['last-event-id'] ?? headers['Last-Event-ID'] ?? req.query?.ultimo_id ?? null;
  if (crudo == null) return null;
  const texto = String(crudo).trim();
  return texto === '' ? null : texto;
}

/** ¿Este evento cambia el tópico público? `dep` recibe todo. */
export function afectaTopico(evento, tema) {
  const { nivel, id } = parsearTopico(tema);
  if (nivel === 'dep') return true;
  if (nivel === 'mun') return String(evento.mun) === String(id);
  if (nivel === 'pue') return String(evento.pue) === String(id);
  if (nivel === 'mesa') {
    if (evento.mesa != null) return String(evento.mesa) === String(id);
    const partes = String(evento.acta ?? '').split('-');
    return partes[2] != null && String(Number(partes[2])) === String(Number(id));
  }
  return false;
}

/**
 * Decide snapshot vs deltas.
 * @param {object} opciones
 * @param {string|null} opciones.cursor
 * @param {string} opciones.topico
 * @param {number} [opciones.maxDeltas]
 * @param {{ leerDesde: Function }} [opciones.historial]
 * @param {(niveles: string[]) => Promise<object>} [opciones.snapshot]
 */
export async function decidirReanudacion(opciones = {}) {
  const cursor = opciones.cursor ?? null;
  const topico = opciones.topico;
  const limite = opciones.maxDeltas ?? 500;
  const leer = opciones.historial?.leerDesde ?? leerHistorialPublico;
  const foto =
    opciones.snapshot ??
    (async (niveles) => {
      const dominio = await import('../dominio/index.js');
      return dominio.snapshot(niveles);
    });

  if (!cursor) {
    return {
      modo: 'snapshot',
      motivo: 'sin_cursor',
      snapshot: await foto([topico]),
      eventos: [],
    };
  }

  let hist;
  try {
    hist = await leer(cursor, limite);
  } catch {
    return {
      modo: 'snapshot',
      motivo: 'historial_no_disponible',
      snapshot: await foto([topico]),
      eventos: [],
    };
  }

  if (!hist || hist.recortado || hist.hayMas || hist.hay_mas || (hist.eventos?.length ?? 0) >= limite) {
    let motivo = 'hueco_grande';
    if (!hist) motivo = 'historial_no_disponible';
    else if (hist.recortado) motivo = 'historial_recortado';
    return {
      modo: 'snapshot',
      motivo,
      snapshot: await foto([topico]),
      eventos: [],
    };
  }

  const eventos = (hist.eventos ?? []).filter((evento) => afectaTopico(evento, topico));
  return {
    modo: 'deltas',
    motivo: 'al_dia',
    eventos,
    stream_id: hist.stream_id ?? cursor,
  };
}

/**
 * Backoff exponencial con equal jitter (RF-10).
 * techo = min(maxMs, baseMs * 2^intento)
 * espera = techo/2 + aleatorio * techo/2
 * Así nadie reintenta en el mismo milisegundo y el techo sigue siendo exponencial.
 */
export function backoffExponencial({
  intento = 0,
  baseMs = 500,
  maxMs = 30_000,
  aleatorio = Math.random,
} = {}) {
  const n = Math.max(0, intento);
  const bruto = baseMs * 2 ** n;
  const techoMs = Math.min(maxMs, Number.isFinite(bruto) ? bruto : maxMs);
  const mitad = techoMs / 2;
  const esperaMs = Math.min(techoMs, Math.floor(mitad + aleatorio() * mitad));
  return { intento: n, techoMs, esperaMs };
}

/** Valor del campo SSE `retry:`, distinto por conexión para no rearmar la avalancha. */
export function directivaRetry(aleatorio = Math.random) {
  const { esperaMs } = backoffExponencial({
    intento: 1,
    baseMs: 1000,
    maxMs: 15_000,
    aleatorio,
  });
  return Math.max(1000, esperaMs);
}

/**
 * Cliente: conecta y, si falla, reprograma con backoff + jitter.
 * `conectar` debe rechazar la promesa cuando el intento no prospera.
 */
export function crearClienteReconexion({
  conectar,
  baseMs = 250,
  maxMs = 30_000,
  aleatorio = Math.random,
  programar = (fn, ms) => setTimeout(fn, ms),
  cancelar = (id) => clearTimeout(id),
} = {}) {
  let intento = 0;
  let timer = null;
  let activo = true;
  const esperas = [];

  async function arrancar() {
    if (!activo) return;
    try {
      await conectar();
      intento = 0;
    } catch {
      if (!activo) return;
      const plan = backoffExponencial({ intento, baseMs, maxMs, aleatorio });
      esperas.push(plan.esperaMs);
      intento += 1;
      timer = programar(() => {
        arrancar();
      }, plan.esperaMs);
    }
  }

  return {
    arrancar,
    esperas,
    cancelar() {
      activo = false;
      if (timer != null) cancelar(timer);
      timer = null;
    },
    get intento() {
      return intento;
    },
  };
}
