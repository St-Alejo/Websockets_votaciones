import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PORT || 8080);
const backend = process.env.BACKEND_URL;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webp': 'image/webp',
};
const hop = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection']);

function reenviar(req, res) {
  if (!backend) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('falta BACKEND_URL');
    return;
  }
  const destino = new URL(req.url, backend.endsWith('/') ? backend : `${backend}/`);
  const headers = { ...req.headers, host: destino.host };
  delete headers['accept-encoding'];
  const salida = http.request(destino, { method: req.method, headers }, (entrada) => {
    const out = {};
    for (const [clave, valor] of Object.entries(entrada.headers)) {
      if (!hop.has(clave.toLowerCase())) out[clave] = valor;
    }
    res.writeHead(entrada.statusCode || 502, out);
    entrada.pipe(res);
  });
  salida.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('backend no disponible');
  });
  req.pipe(salida);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  if (
    url.pathname.startsWith('/sse') ||
    url.pathname === '/instancia' ||
    url.pathname === '/salud' ||
    url.pathname === '/metrics'
  ) {
    reenviar(req, res);
    return;
  }

  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const archivo = path.resolve(root, `.${rel}`);
  if (archivo !== root && !archivo.startsWith(`${root}${path.sep}`)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(archivo, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': mime[path.extname(archivo)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;
server.listen(port, '0.0.0.0');
