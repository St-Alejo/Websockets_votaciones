const RAILWAY = 'https://api-production-19233.up.railway.app';

const fromQuery = new URLSearchParams(location.search).get('api');
const onVercel = location.hostname.endsWith('.vercel.app');

export const API_HTTP = (fromQuery || (onVercel ? RAILWAY : location.origin)).replace(/\/$/, '');
export const API_WS = API_HTTP.replace(/^http/, 'ws');
