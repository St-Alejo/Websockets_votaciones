// Dueño: Persona 1. Carga en Redis los totales de mesas por nivel (cat:...:mesas), que se
// usan para el % de mesas informadas. Idempotente: se puede correr cuantas veces se quiera.
//   node scripts/seed-catalogo.js            (REDIS_URL o redis://localhost:6379)
//   SEMILLA=7 node scripts/seed-catalogo.js
import { Redis } from 'ioredis';
import { TOTALES, generarCatalogo, sembrarCatalogo } from '../src/dominio/catalogo.js';

const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
const semilla = Number(process.env.SEMILLA ?? 2026);

const redis = new Redis(url, { maxRetriesPerRequest: 3 });
try {
  const claves = await sembrarCatalogo(redis, semilla);
  const cat = generarCatalogo(semilla);
  const capital = cat.municipios[0];
  console.log(
    `[seed-catalogo] ${claves} claves en ${url}: ${TOTALES.municipios} municipios, ` +
      `${TOTALES.puestos} puestos, ${TOTALES.mesas} mesas (semilla ${semilla}). ` +
      `Capital: municipio ${capital.id} con ${capital.puestos.length} puestos.`,
  );
} finally {
  await redis.quit();
}
