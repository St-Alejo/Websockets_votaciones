// Dueño: Persona 2. Fan-out no bloqueante (RF-4, RT-4).
//
// 1. Agrega por ventana de tiempo: las actas que llegan dentro de `ventanaMs`
//    se coalescen por acta (queda la versión más alta). Así no se emite un
//    mensaje por cada repetición — la trampa de escala de RF-4.
// 2. Reparte el envío en lotes de N (`tamanoLote`) y entre lote y lote llama
//    `setImmediate` para devolver el control al Event Loop.

/** Tópicos que deben enterarse de un acta aplicada. */
export function topicosAfectados(evento) {
  const temas = ['dep'];
  if (evento?.mun != null) temas.push(`mun:${evento.mun}`);
  if (evento?.pue != null) temas.push(`pue:${evento.pue}`);
  if (evento?.mesa != null) temas.push(`mesa:${evento.mesa}`);
  return temas;
}

/** Compara ids de Redis Stream ("ms-seq"). Negativo si a < b. */
export function compararStreamId(a, b) {
  const pa = partirId(a);
  const pb = partirId(b);
  if (pa.ms !== pb.ms) return pa.ms - pb.ms;
  return pa.seq - pb.seq;
}

function partirId(id) {
  const [ms, seq] = String(id ?? '0-0').split('-');
  const nms = Number(ms);
  const nseq = Number(seq ?? 0);
  return {
    ms: Number.isFinite(nms) ? nms : 0,
    seq: Number.isFinite(nseq) ? nseq : 0,
  };
}

function eventoPublico(evento) {
  const publico = {
    stream_id: evento.stream_id,
    acta: evento.acta,
    mun: evento.mun,
    pue: evento.pue,
    version: evento.version,
    tipo: evento.tipo,
  };
  if (evento.mesa != null) publico.mesa = evento.mesa;
  return publico;
}

function vistoDe(conexion, topico) {
  const especifico = conexion.vistoPorTopico?.get(topico);
  if (especifico) return especifico;
  return conexion.vistoHasta ?? null;
}

function marcarVisto(conexion, mensaje) {
  const id = mensaje.id;
  if (!id) return;
  if (!conexion.vistoPorTopico) conexion.vistoPorTopico = new Map();
  const actual = conexion.vistoPorTopico.get(mensaje.topico);
  if (!actual || compararStreamId(id, actual) > 0) {
    conexion.vistoPorTopico.set(mensaje.topico, id);
  }
  if (!conexion.vistoHasta || compararStreamId(id, conexion.vistoHasta) > 0) {
    conexion.vistoHasta = id;
  }
}

function filtrarVistos(conexion, mensaje) {
  const piso = vistoDe(conexion, mensaje.topico);
  const originales = mensaje.datos?.eventos;
  if (!Array.isArray(originales)) return mensaje;
  const eventos = piso
    ? originales.filter((e) => e?.stream_id && compararStreamId(e.stream_id, piso) > 0)
    : originales.slice();
  if (eventos.length === 0) return null;
  const streamId = eventos.reduce(
    (max, e) => (compararStreamId(e.stream_id, max) > 0 ? e.stream_id : max),
    eventos[0].stream_id,
  );
  return {
    ...mensaje,
    id: streamId,
    datos: { ...mensaje.datos, eventos, stream_id: streamId },
  };
}

/**
 * @param {object} [opciones]
 * @param {number} [opciones.tamanoLote]  N: envíos por vuelta del Event Loop
 * @param {number} [opciones.ventanaMs]   ventana de agregación del delta
 * @param {(fn: Function) => unknown} [opciones.ceder]  por defecto setImmediate
 */
export function crearMotor(opciones = {}) {
  const tamanoLote = Math.max(1, Math.floor(Number(opciones.tamanoLote ?? 200)) || 1);
  const ventanaCruda = opciones.ventanaMs ?? 50;
  const ventanaMs = Math.max(0, Number.isFinite(Number(ventanaCruda)) ? Number(ventanaCruda) : 0);
  const ceder = opciones.ceder ?? setImmediate;
  const programar = opciones.programar ?? ((fn, ms) => setTimeout(fn, ms));
  const cancelar = opciones.cancelar ?? ((id) => clearTimeout(id));
  const resolver = opciones.resolverConexiones ?? (() => []);
  const topicosDe = opciones.topicosDe ?? topicosAfectados;
  const evaluarCliente = opciones.evaluar ?? (() => ({ accion: 'delta' }));
  const enviar =
    opciones.enviar ??
    ((conexion, mensaje) => {
      conexion.enviar(mensaje.evento, mensaje.datos, mensaje.id);
    });
  const enviarSnapshot =
    opciones.enviarSnapshot ??
    ((conexion, topico) => {
      conexion.enviar('snapshot', { topico, motivo: 'backpressure' }, conexion.vistoHasta);
    });
  const alDesconectar =
    opciones.alDesconectar ??
    ((conexion) => {
      conexion.cerrada = true;
      conexion.cerrar?.('lento');
    });
  const alEmitir = opciones.alEmitir ?? (() => {});

  let pendiente = new Map();
  let crudo = new Map();
  let timer = null;
  const stats = {
    eventosIngresados: 0,
    mensajesNaivos: 0,
    mensajesEmitidos: 0,
    cesiones: 0,
  };

  function contabilizar(mensaje) {
    stats.mensajesEmitidos += 1;
    alEmitir({ n: 1, recibidoEn: mensaje.recibidoEn, publicadoEn: Date.now() });
  }

  function entregar(conexion, mensaje) {
    if (!conexion || conexion.cerrada) return false;
    if (conexion.acepta === false) {
      if (!conexion.retenido) conexion.retenido = [];
      conexion.retenido.push(mensaje);
      return false;
    }
    const filtrado = filtrarVistos(conexion, mensaje);
    if (!filtrado) return false;

    const decision = evaluarCliente(conexion);
    if (decision.accion === 'desconectar') {
      conexion.cerrada = true;
      conexion.necesitaSnapshot = false;
      try {
        alDesconectar(conexion, decision);
      } catch {
        /* un cierre fallido no detiene el resto del lote */
      }
      return false;
    }
    if (decision.accion === 'suspender') {
      conexion.necesitaSnapshot = true;
      return false;
    }
    if (decision.accion === 'snapshot') {
      conexion.necesitaSnapshot = false;
      try {
        // El snapshot reemplaza al delta. Quien envía la foto cuenta el mensaje
        // y avanza el cursor cuando ya conoce el stream_id incluido en ella.
        enviarSnapshot(conexion, filtrado.topico);
        return true;
      } catch {
        conexion.necesitaSnapshot = true;
        return false;
      }
    }
    try {
      enviar(conexion, filtrado);
      marcarVisto(conexion, filtrado);
      contabilizar(filtrado);
      return true;
    } catch {
      return false;
    }
  }

  function enviarLotes(trabajos) {
    let indice = 0;
    const paso = () => {
      const fin = Math.min(indice + tamanoLote, trabajos.length);
      for (; indice < fin; indice += 1) {
        const trabajo = trabajos[indice];
        try {
          entregar(trabajo.conexion, trabajo.mensaje);
        } catch {
          /* aislado por conexión */
        }
      }
      if (indice < trabajos.length) {
        stats.cesiones += 1;
        ceder(paso);
      }
    };
    if (trabajos.length > 0) paso();
  }

  function vaciar() {
    if (timer != null) {
      cancelar(timer);
      timer = null;
    }
    const lote = pendiente;
    const crudos = crudo;
    pendiente = new Map();
    crudo = new Map();

    const trabajos = [];
    for (const [topico, bolsa] of lote) {
      if (bolsa.size === 0) continue;
      const lista = [...bolsa.values()];
      const streamId = lista.reduce(
        (max, e) => (!max || compararStreamId(e.stream_id, max) > 0 ? e.stream_id : max),
        null,
      );
      const recibidoEn = lista.reduce(
        (min, e) => Math.min(min, e._recibidoEn ?? Date.now()),
        Number.POSITIVE_INFINITY,
      );
      const mensaje = {
        evento: 'delta',
        topico,
        id: streamId,
        recibidoEn: Number.isFinite(recibidoEn) ? recibidoEn : Date.now(),
        datos: {
          topico,
          stream_id: streamId,
          eventos: lista.map(eventoPublico),
        },
      };
      const conexiones = [...(resolver(topico) ?? [])];
      stats.mensajesNaivos += (crudos.get(topico) ?? lista.length) * conexiones.length;
      for (const conexion of conexiones) trabajos.push({ conexion, mensaje });
    }
    enviarLotes(trabajos);
  }

  function ingresar(evento) {
    if (!evento) return;
    stats.eventosIngresados += 1;
    const ev = { ...evento };
    if (ev._recibidoEn == null) ev._recibidoEn = Date.now();
    const clave = ev.acta || ev.stream_id;
    for (const topico of topicosDe(ev)) {
      let bolsa = pendiente.get(topico);
      if (!bolsa) {
        bolsa = new Map();
        pendiente.set(topico, bolsa);
      }
      const previo = bolsa.get(clave);
      if (!previo || (Number(ev.version) || 0) >= (Number(previo.version) || 0)) {
        bolsa.set(clave, ev);
      }
      crudo.set(topico, (crudo.get(topico) ?? 0) + 1);
    }
    if (timer == null) timer = programar(vaciar, ventanaMs);
  }

  function detener() {
    if (timer != null) {
      cancelar(timer);
      timer = null;
    }
  }

  return {
    ingresar,
    vaciar,
    entregar,
    detener,
    ceder,
    estadisticas: () => ({ ...stats }),
  };
}
