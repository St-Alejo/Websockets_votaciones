// Dueño: Persona 1. Catálogo sintético y DETERMINISTA del departamento: 40 municipios,
// 1.842 puestos y 6.400 mesas. Es una función pura (misma semilla → mismo catálogo), así que
// el seed y el simulador generan exactamente la misma geografía sin compartir archivos.
import { catalogo as claveCatalogo } from '../contratos/keys.js';

export const TOTALES = Object.freeze({ municipios: 40, puestos: 1842, mesas: 6400 });

/** PRNG mulberry32: rápido y reproducible. */
export function prng(semilla) {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Reparte `total` en partes proporcionales a `pesos`, con mínimo `minimo` cada una (resto mayor). */
function repartir(total, pesos, minimo) {
  const libre = total - minimo * pesos.length;
  const suma = pesos.reduce((a, b) => a + b, 0);
  const exactas = pesos.map((p) => (p / suma) * libre);
  const partes = exactas.map((x) => minimo + Math.floor(x));
  let faltan = total - partes.reduce((a, b) => a + b, 0);
  const orden = exactas
    .map((x, i) => [x - Math.floor(x), i])
    .sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; faltan > 0; k++, faltan--) partes[orden[k % orden.length][1]]++;
  return partes;
}

/**
 * @returns {{ municipios: { id: number, puestos: { id: number, mesas: number[] }[] }[],
 *             mesa: Map<number, { puesto: number, municipio: number }> }}
 */
export function generarCatalogo(semilla = 2026) {
  const azar = prng(semilla);
  // Municipio 1 es la capital; tamaño decreciente tipo Zipf.
  const pesosMun = Array.from({ length: TOTALES.municipios }, (_, i) => 1 / (i + 1) ** 0.9);
  const puestosPorMun = repartir(TOTALES.puestos, pesosMun, 3);
  // Puestos urbanos más grandes que los rurales: peso aleatorio 1..10.
  const pesosPue = Array.from({ length: TOTALES.puestos }, () => 1 + Math.floor(azar() * 10));
  const mesasPorPue = repartir(TOTALES.mesas, pesosPue, 1);

  const municipios = [];
  const mesa = new Map();
  let idPuesto = 1;
  let idMesa = 1;
  for (let m = 0; m < TOTALES.municipios; m++) {
    const mun = { id: m + 1, puestos: [] };
    for (let p = 0; p < puestosPorMun[m]; p++, idPuesto++) {
      const pue = { id: idPuesto, mesas: [] };
      for (let k = 0; k < mesasPorPue[idPuesto - 1]; k++, idMesa++) {
        pue.mesas.push(idMesa);
        mesa.set(idMesa, { puesto: pue.id, municipio: mun.id });
      }
      mun.puestos.push(pue);
    }
    municipios.push(mun);
  }
  return { municipios, mesa };
}

/** Pares [clave, total de mesas] para cat:dep:mesas, cat:mun:{id}:mesas y cat:pue:{id}:mesas. */
export function totalesCatalogo(cat) {
  const pares = [[claveCatalogo('dep'), TOTALES.mesas]];
  for (const mun of cat.municipios) {
    let n = 0;
    for (const pue of mun.puestos) {
      pares.push([claveCatalogo('pue', pue.id), pue.mesas.length]);
      n += pue.mesas.length;
    }
    pares.push([claveCatalogo('mun', mun.id), n]);
  }
  return pares;
}

/** Escribe los totales en Redis (idempotente: SET sobre las mismas claves). */
export async function sembrarCatalogo(redis, semilla) {
  const pares = totalesCatalogo(generarCatalogo(semilla));
  await redis.mset(...pares.flat());
  return pares.length;
}
