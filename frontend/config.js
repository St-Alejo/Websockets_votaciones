// URL del backend (WebSocket y SSE).
// - Servido por nginx local (docker compose): mismo origen.
// - Servido por Vercel: el backend desplegado en Railway.
// - ?api=https://otro-backend permite apuntar a otro servidor sin tocar código.
const RAILWAY = 'https://api-production-19233.up.railway.app';

const desdeQuery = new URLSearchParams(location.search).get('api');
const enVercel = location.hostname.endsWith('.vercel.app');

export const API_HTTP = (desdeQuery || (enVercel ? RAILWAY : location.origin)).replace(/\/$/, '');
export const API_WS = API_HTTP.replace(/^http/, 'ws');
