// Dueño: Persona 2. Fachada pública del fan-out. Las demás personas importan solo de aquí.
// Las firmas suscribir(conexion, topico) y desuscribir(conexion, topico) no cambian.
import { CANALES } from '../contratos/canales.js';
import { snapshot } from '../dominio/index.js';
import { registrarPublicacion } from '../metrics/dashboard.js';
import { evaluar } from './backpressure.js';
import { compararStreamId, crearMotor } from './engine.js';
import {
  cleanup,
  conexionesDe,
  estadisticas as estadisticasTopicos,
  subscribe,
  unsubscribe,
} from './topics.js';

const tamanoLote = Number(process.env.FANOUT_LOTE) || 200;
const ventanaMs = Number(process.env.FANOUT_VENTANA_MS ?? 50);

function enviarFoto(conexion, topico) {
  const tema = topico || conexion.topico;
  if (!tema || conexion.cerrada) return;
  Promise.resolve(snapshot([tema]))
    .then((foto) => {
      if (conexion.cerrada || typeof conexion.enviar !== 'function') return;
      if (!conexion.vistoPorTopico) conexion.vistoPorTopico = new Map();
      const previo = conexion.vistoPorTopico.get(tema);
      if (!previo || compararStreamId(foto.stream_id, previo) > 0) {
        conexion.vistoPorTopico.set(tema, foto.stream_id);
      }
      if (!conexion.vistoHasta || compararStreamId(foto.stream_id, conexion.vistoHasta) > 0) {
        conexion.vistoHasta = foto.stream_id;
      }
      conexion.enviar('snapshot', { ...foto, motivo: 'backpressure' }, foto.stream_id);
      registrarPublicacion({ n: 1 });
    })
    .catch(() => {
      /* sin foto no se reintenta en caliente: el próximo delta vuelve a pedirla */
      conexion.necesitaSnapshot = true;
    });
}

const motor = crearMotor({
  tamanoLote: Number.isFinite(tamanoLote) && tamanoLote > 0 ? tamanoLote : 200,
  ventanaMs: Number.isFinite(ventanaMs) && ventanaMs >= 0 ? ventanaMs : 50,
  resolverConexiones: (topico) => conexionesDe(topico),
  evaluar: (conexion) => evaluar(conexion),
  alEmitir: (info) => registrarPublicacion(info),
  alDesconectar: (conexion) => {
    cleanup(conexion);
    try {
      conexion.cerrar?.('lento');
    } catch {
      /* el socket ya no acepta escritura */
    }
  },
  enviarSnapshot: (conexion, topico) => enviarFoto(conexion, topico),
});

/** @type {import('../contratos/interfaces.js').suscribir} */
export function suscribir(conexion, topico) {
  subscribe(conexion, topico);
}

/** @type {import('../contratos/interfaces.js').desuscribir} */
export function desuscribir(conexion, topico) {
  unsubscribe(conexion, topico);
}

/** Conexiones de un tópico (solo lectura del conjunto vivo). */
export function suscriptores(topico) {
  return conexionesDe(topico);
}

/** Saca la conexión de todos los tópicos. */
export function limpiarConexion(conexion) {
  cleanup(conexion);
}

/** Para métricas: suscripciones, conexiones distintas y el ahorro del fan-out. */
export function estadisticas() {
  const temas = estadisticasTopicos();
  const envio = motor.estadisticas();
  return {
    topicos: temas.topicos,
    suscripciones: temas.suscripciones,
    conexiones: temas.conexiones,
    mensajes_naivos: envio.mensajesNaivos,
    mensajes_emitidos: envio.mensajesEmitidos,
    eventos_ingresados: envio.eventosIngresados,
  };
}

/** Ingresa un acta al motor (tests y cualquier emisor en proceso). */
export function publicar(evento) {
  motor.ingresar(evento);
}

/**
 * La conexión dejó de retener deltas (ya se le mandó el snapshot o el historial).
 * Entrega lo que llegó mientras tanto, filtrado por `vistoHasta`.
 */
export function soltarRetenidos(conexion) {
  const cola = conexion.retenido ?? [];
  conexion.retenido = [];
  conexion.acepta = true;
  for (const mensaje of cola) motor.entregar(conexion, mensaje);
}

/**
 * Lo llama el latido SSE: si el buffer ya bajó, manda el snapshot pendiente;
 * si el cliente sigue saturado por encima del corte, lo desconecta.
 */
export function revisarPresion(conexion) {
  if (!conexion || conexion.cerrada) return;
  const decision = evaluar(conexion);
  if (decision.accion === 'desconectar') {
    conexion.cerrada = true;
    conexion.necesitaSnapshot = false;
    cleanup(conexion);
    try {
      conexion.cerrar?.('lento');
    } catch {
      /* ya cerrado */
    }
    return;
  }
  if (decision.accion === 'suspender') {
    conexion.necesitaSnapshot = true;
    return;
  }
  if (decision.accion === 'snapshot') {
    conexion.necesitaSnapshot = false;
    enviarFoto(conexion, conexion.topico);
  }
}

const enlazados = new WeakSet();

/** Se suscribe al canal acta:nueva de esta instancia. Sin Redis no hace nada. */
export async function enlazarBackplane(redisSub) {
  if (!redisSub || typeof redisSub.subscribe !== 'function') return false;
  if (enlazados.has(redisSub)) return true;
  enlazados.add(redisSub);
  redisSub.on('message', (canal, raw) => {
    if (canal !== CANALES.ACTA_NUEVA) return;
    try {
      const evento = JSON.parse(raw);
      evento._recibidoEn = Date.now();
      motor.ingresar(evento);
    } catch {
      /* mensaje que no es JSON del contrato: se ignora */
    }
  });
  await redisSub.subscribe(CANALES.ACTA_NUEVA);
  return true;
}
