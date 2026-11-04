// RT-8. Curva de la jornada (55 % del volumen en los primeros 40 minutos)
// y hasta 20.000 conexiones SSE concurrentes.
//
//   CONEXIONES=20000 node src/load_test/scenario.js
//   BASE_URL=http://127.0.0.1:3000/sse/publico?topico=dep CONEXIONES=1000 node src/load_test/scenario.js
//
// Sin BASE_URL levanta un SSE local y abre las conexiones contra él.
// CONEXIONES por defecto: 100. Máximo admitido: 20.000.
import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';

export const MAX_CONEXIONES = 20_000;

/**
 * Reparte el volumen de la jornada: `fraccionPico` cae en los primeros
 * `minutosPico` minutos y el resto se reparte uniforme en lo que queda.
 */
export function planificarCurva({
  volumenTotal = 6400,
  duracionMin = 240,
  minutosPico = 40,
  fraccionPico = 0.55,
} = {}) {
  if (!(minutosPico > 0) || !(duracionMin > minutosPico)) {
    throw new Error('La curva necesita un tramo inicial más corto que la jornada');
  }
  if (!(fraccionPico >= 0) || fraccionPico > 1) {
    throw new Error('fraccionPico debe estar entre 0 y 1');
  }
  const enPico = volumenTotal * fraccionPico;
  const enResto = volumenTotal - enPico;
  const tasaPico = enPico / minutosPico;
  const tasaResto = enResto / (duracionMin - minutosPico);
  const puntos = [];
  for (let minuto = 0; minuto < duracionMin; minuto += 1) {
    puntos.push({
      minuto,
      actasPorMinuto: minuto < minutosPico ? tasaPico : tasaResto,
    });
  }
  return { volumenTotal, duracionMin, minutosPico, fraccionPico, puntos };
}

export function resumenCurva(plan) {
  const enPrimeros = plan.puntos
    .filter((p) => p.minuto < plan.minutosPico)
    .reduce((suma, p) => suma + p.actasPorMinuto, 0);
  const total = plan.puntos.reduce((suma, p) => suma + p.actasPorMinuto, 0);
  return {
    total,
    enPrimeros40: enPrimeros,
    fraccion: total === 0 ? 0 : enPrimeros / total,
  };
}

function crearServidorSse() {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 1000\n\n');
    res.write('event: snapshot\ndata: {"ok":true}\n\n');
  });
  server.on('connection', (socket) => {
    socket.on('error', () => {});
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        cerrar() {
          for (const socket of sockets) socket.destroy();
          server.closeAllConnections?.();
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

function abrirCliente(lib, destino, agente) {
  const objetivo = new URL(destino);
  return new Promise((resolve) => {
    const req = lib.request(
      {
        protocol: objetivo.protocol,
        hostname: objetivo.hostname,
        port: objetivo.port,
        path: `${objetivo.pathname}${objetivo.search}`,
        method: 'GET',
        agent: agente,
        headers: { Accept: 'text/event-stream' },
      },
      (res) => {
        res.on('data', () => {});
        res.on('error', () => {});
        resolve(res);
      },
    );
    req.on('error', () => resolve(null));
    req.end();
  });
}

/**
 * Abre `conexiones` clientes SSE y los mantiene `mantenerMs` milisegundos.
 * Sin `url` el objetivo es un servidor embebido. El CLI pasa BASE_URL cuando existe.
 */
export async function ejecutarEscenario({ conexiones = 100, mantenerMs = 500, url } = {}) {
  if (!Number.isInteger(conexiones) || conexiones < 1) {
    throw new Error('conexiones debe ser un entero positivo');
  }
  if (conexiones > MAX_CONEXIONES) {
    throw new Error(`El escenario admite como máximo ${MAX_CONEXIONES} conexiones`);
  }

  let servidor = null;
  let destino = url || null;
  if (destino) {
    const objetivo = new URL(destino);
    if (objetivo.protocol !== 'http:' && objetivo.protocol !== 'https:') {
      throw new Error('La URL del escenario tiene que ser http o https');
    }
  } else {
    servidor = await crearServidorSse();
    destino = `http://127.0.0.1:${servidor.port}/sse/publico?topico=dep`;
  }
  const lib = destino.startsWith('https:') ? https : http;
  const agente = new lib.Agent({ keepAlive: true, maxSockets: conexiones });
  const abiertos = [];
  let establecidas = 0;
  let errores = 0;

  const respuestas = await Promise.all(
    Array.from({ length: conexiones }, () => abrirCliente(lib, destino, agente)),
  );
  for (const res of respuestas) {
    if (!res) {
      errores += 1;
      continue;
    }
    if (res.statusCode === 200) establecidas += 1;
    else errores += 1;
    abiertos.push(res);
  }

  if (mantenerMs > 0) await new Promise((r) => setTimeout(r, mantenerMs));

  for (const res of abiertos) res.destroy();
  agente.destroy();
  if (servidor) await servidor.cerrar();

  return {
    conteo: { solicitadas: conexiones, abiertas: establecidas, errores },
    curva: resumenCurva(planificarCurva()),
  };
}

function esEjecucionDirecta() {
  const arg = process.argv[1];
  if (!arg) return false;
  return import.meta.url === pathToFileURL(arg).href;
}

async function main() {
  const plan = planificarCurva({
    volumenTotal: Number(process.env.VOLUMEN ?? 6400),
    duracionMin: Number(process.env.DURACION_MIN ?? 240),
    minutosPico: Number(process.env.MINUTOS_PICO ?? 40),
    fraccionPico: Number(process.env.FRACCION_PICO ?? 0.55),
  });
  const resumen = resumenCurva(plan);
  const conexiones = Number(process.env.CONEXIONES ?? 100);
  console.log(
    JSON.stringify(
      {
        curva: {
          volumen: plan.volumenTotal,
          duracionMin: plan.duracionMin,
          fraccionPrimeros40Min: Number(resumen.fraccion.toFixed(4)),
          actasEnEsos40Min: Math.round(resumen.enPrimeros40),
          actasPorMinutoAlInicio: Number(plan.puntos[0].actasPorMinuto.toFixed(2)),
        },
        conexionesSolicitadas: conexiones,
        maximo: MAX_CONEXIONES,
      },
      null,
      2,
    ),
  );
  if (!(conexiones > 0)) return;
  const resultado = await ejecutarEscenario({
    conexiones,
    mantenerMs: Number(process.env.MANTENER_MS ?? 1000),
    url: process.env.BASE_URL || undefined,
  });
  console.log(JSON.stringify(resultado.conteo));
}

if (esEjecucionDirecta()) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exitCode = 1;
  });
}
