// Dueño: Persona 2. Fachada de métricas: el tablero vive en dashboard.js
// y el lag del Event Loop en event_loop_lag.js.
export {
  contarMensajes,
  exponer,
  leerTablero,
  registrarPublicacion,
  registrarRuta,
  reiniciarMetricas,
} from './dashboard.js';
export { leerLag, reiniciarLag } from './event_loop_lag.js';
