// Misma regla que frontend/config.js. En Railway la página y /sse/publico
// comparten origen: server.mjs reenvía /sse al backend (BACKEND_URL).
const RAILWAY = 'https://api-production-19233.up.railway.app';

const desdeQuery = new URLSearchParams(location.search).get('api');
const enVercel = location.hostname.endsWith('.vercel.app');

export const API_HTTP = (desdeQuery || (enVercel ? RAILWAY : location.origin)).replace(/\/$/, '');
export const API_WS = API_HTTP.replace(/^http/, 'ws');
