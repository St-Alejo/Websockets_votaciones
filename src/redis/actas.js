// Dueño: Persona 1. Registro de actas sobre Redis. Las funciones reciben el cliente
// explícitamente (en los tests, varios clientes simulan varias instancias); la fachada
// src/dominio/index.js las expone con la firma del contrato usando el cliente global.
import { randomBytes } from 'node:crypto';
import * as K from '../contratos/keys.js';
import { CANALES } from '../contratos/canales.js';
import { RespuestaRegistro } from '../contratos/esquemas.js';
import { cumpleReglaContable, descuadre, validarActa } from '../dominio/validacion.js';
import { traducirErrorRedis } from '../dominio/errores.js';
import { hashContenido, TTL_IDEM_S } from './idempotencia.js';

/** Las 12 claves que toca registrar.lua, en el orden que espera. */
export function clavesActa({ acta, idem, mesa, puesto, municipio }) {
  return [
    K.acta(acta),
    K.actaVersiones(acta),
    K.idem(idem),
    K.acum('mesa', mesa),
    K.acum('pue', puesto),
    K.acum('mun', municipio),
    K.acum('dep'),
    K.rank('pue', puesto),
    K.rank('mun', municipio),
    K.rank('dep'),
    K.streamActas,
    K.colaVerificacion,
  ];
}

const nuevoRecibo = (instancia) =>
  `R-${instancia}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;

function normalizar(r) {
  return RespuestaRegistro.parse({ ...r, recibo: r.recibo ?? null });
}

async function ejecutar(promesa) {
  try {
    return JSON.parse(await promesa);
  } catch (err) {
    throw traducirErrorRedis(err);
  }
}

/**
 * Registra un acta. Nunca lanza por datos inválidos (responde "rechazada"); lanza
 * ErrorRedisNoDisponible si Redis no responde y ErrorLimiteTasa si `antesDeRegistrar` lo hace.
 * @param {import('ioredis').Redis} redis
 * @param {unknown} entrada
 * @param {{ instancia?: string, streamMaxlen?: number, antesDeRegistrar?: (acta) => Promise<void> }} [opciones]
 */
export async function registrar(redis, entrada, opciones = {}) {
  const v = validarActa(entrada);
  if (!v.ok) {
    return normalizar({
      estado: 'rechazada',
      acta: typeof entrada?.acta === 'string' ? entrada.acta : '',
      version: Number.isInteger(entrada?.version) ? entrada.version : 0,
      motivo: v.motivo,
    });
  }
  const acta = v.acta;
  if (opciones.antesDeRegistrar) await opciones.antesDeRegistrar(acta);

  const datos = {
    votos: acta.votos,
    sufragantes: acta.sufragantes,
    mesa: acta.mesa,
    puesto: acta.puesto,
    municipio: acta.municipio,
    jurado: acta.jurado,
  };
  const r = await ejecutar(
    redis.registrarActaLua(
      ...clavesActa(acta),
      'registrar',
      acta.acta,
      acta.version,
      hashContenido(acta),
      JSON.stringify(datos),
      cumpleReglaContable(acta) ? '1' : '0',
      nuevoRecibo(opciones.instancia ?? 'local'),
      Date.now(),
      TTL_IDEM_S,
      opciones.streamMaxlen ?? 10_000,
      CANALES.ACTA_NUEVA,
      descuadre(acta),
    ),
  );
  return normalizar(r);
}

/**
 * Aplica una versión dudosa aprobada por un auditor (RF-7 → RF-2).
 * @param {import('ioredis').Redis} redis
 * @param {object|string} actaOId  ActaEntrante o id del acta
 * @param {number} version
 */
export async function aplicarVerificada(redis, actaOId, version, opciones = {}) {
  const id = typeof actaOId === 'string' ? actaOId : actaOId?.acta;
  if (!id || !Number.isInteger(version) || version < 1) {
    return { aplicada: false, motivo: 'parametros_invalidos' };
  }
  // Las claves dependen de la geografía guardada con la versión dudosa: se lee antes del script.
  let guardado;
  try {
    guardado = await redis.hget(K.actaVersiones(id), `${version}:datos`);
  } catch (err) {
    throw traducirErrorRedis(err);
  }
  if (!guardado) return { aplicada: false, motivo: 'version_no_dudosa_o_desconocida' };
  const { mesa, puesto, municipio } = JSON.parse(guardado);

  return ejecutar(
    redis.registrarActaLua(
      ...clavesActa({ acta: id, idem: '-verificacion-', mesa, puesto, municipio }),
      'verificar',
      id,
      version,
      '',
      '',
      '',
      '',
      Date.now(),
      TTL_IDEM_S,
      opciones.streamMaxlen ?? 10_000,
      CANALES.ACTA_NUEVA,
      0,
    ),
  );
}
