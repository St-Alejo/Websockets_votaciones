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

function forward(req, res) {
  if (!backend) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('missing BACKEND_URL');
    return;
  }
  const target = new URL(req.url, backend.endsWith('/') ? backend : `${backend}/`);
  const headers = { ...req.headers, host: target.host };
  delete headers['accept-encoding'];
  const outgoing = http.request(target, { method: req.method, headers }, (incoming) => {
    const out = {};
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (!hop.has(key.toLowerCase())) out[key] = value;
    }
    res.writeHead(incoming.statusCode || 502, out);
    incoming.pipe(res);
  });
  outgoing.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('backend unavailable');
  });
  req.pipe(outgoing);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  if (
    url.pathname.startsWith('/sse') ||
    url.pathname === '/instance' ||
    url.pathname === '/health' ||
    url.pathname === '/metrics'
  ) {
    forward(req, res);
    return;
  }

  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(root, `.${rel}`);
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;
server.listen(port, '0.0.0.0');
