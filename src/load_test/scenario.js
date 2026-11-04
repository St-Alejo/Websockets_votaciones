import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';

export const MAX_CONNECTIONS = 20_000;

export function planCurve({
  totalVolume = 6400,
  durationMin = 240,
  peakMinutes = 40,
  peakFraction = 0.55,
} = {}) {
  if (!(peakMinutes > 0) || !(durationMin > peakMinutes)) {
    throw new Error('The curve needs an initial stretch shorter than the election day');
  }
  if (!(peakFraction >= 0) || peakFraction > 1) {
    throw new Error('peakFraction must be between 0 and 1');
  }
  const inPeak = totalVolume * peakFraction;
  const inRest = totalVolume - inPeak;
  const peakRate = inPeak / peakMinutes;
  const restRate = inRest / (durationMin - peakMinutes);
  const points = [];
  for (let minute = 0; minute < durationMin; minute += 1) {
    points.push({
      minute,
      talliesPerMinute: minute < peakMinutes ? peakRate : restRate,
    });
  }
  return { totalVolume, durationMin, peakMinutes, peakFraction, points };
}

export function curveSummary(plan) {
  const inFirst = plan.points
    .filter((p) => p.minute < plan.peakMinutes)
    .reduce((sum, p) => sum + p.talliesPerMinute, 0);
  const total = plan.points.reduce((sum, p) => sum + p.talliesPerMinute, 0);
  return {
    total,
    inFirst40: inFirst,
    fraction: total === 0 ? 0 : inFirst / total,
  };
}

function createSseServer() {
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
        close() {
          for (const socket of sockets) socket.destroy();
          server.closeAllConnections?.();
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

function openClient(lib, destination, agent) {
  const target = new URL(destination);
  return new Promise((resolve) => {
    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        agent,
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

export async function runScenario({ connections = 100, holdMs = 500, url } = {}) {
  if (!Number.isInteger(connections) || connections < 1) {
    throw new Error('connections must be a positive integer');
  }
  if (connections > MAX_CONNECTIONS) {
    throw new Error(`The scenario supports at most ${MAX_CONNECTIONS} connections`);
  }

  let server = null;
  let destination = url || null;
  if (destination) {
    const target = new URL(destination);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new Error('The scenario URL must be http or https');
    }
  } else {
    server = await createSseServer();
    destination = `http://127.0.0.1:${server.port}/sse/public?topic=dept`;
  }
  const lib = destination.startsWith('https:') ? https : http;
  const agent = new lib.Agent({ keepAlive: true, maxSockets: connections });
  const opened = [];
  let established = 0;
  let errors = 0;

  const responses = await Promise.all(
    Array.from({ length: connections }, () => openClient(lib, destination, agent)),
  );
  for (const res of responses) {
    if (!res) {
      errors += 1;
      continue;
    }
    if (res.statusCode === 200) established += 1;
    else errors += 1;
    opened.push(res);
  }

  if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));

  for (const res of opened) res.destroy();
  agent.destroy();
  if (server) await server.close();

  return {
    count: { requested: connections, open: established, errors },
    curve: curveSummary(planCurve()),
  };
}

function isDirectRun() {
  const arg = process.argv[1];
  if (!arg) return false;
  return import.meta.url === pathToFileURL(arg).href;
}

async function main() {
  const plan = planCurve({
    totalVolume: Number(process.env.VOLUME ?? 6400),
    durationMin: Number(process.env.DURATION_MIN ?? 240),
    peakMinutes: Number(process.env.PEAK_MINUTES ?? 40),
    peakFraction: Number(process.env.PEAK_FRACTION ?? 0.55),
  });
  const summary = curveSummary(plan);
  const connections = Number(process.env.CONNECTIONS ?? 100);
  console.log(
    JSON.stringify(
      {
        curve: {
          volume: plan.totalVolume,
          durationMin: plan.durationMin,
          fractionFirst40Min: Number(summary.fraction.toFixed(4)),
          talliesInThose40Min: Math.round(summary.inFirst40),
          talliesPerMinuteAtStart: Number(plan.points[0].talliesPerMinute.toFixed(2)),
        },
        requestedConnections: connections,
        maximum: MAX_CONNECTIONS,
      },
      null,
      2,
    ),
  );
  if (!(connections > 0)) return;
  const result = await runScenario({
    connections,
    holdMs: Number(process.env.HOLD_MS ?? 1000),
    url: process.env.BASE_URL || undefined,
  });
  console.log(JSON.stringify(result.count));
}

if (isDirectRun()) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exitCode = 1;
  });
}
