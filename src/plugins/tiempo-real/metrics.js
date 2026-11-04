// Dueño: Persona 2. GET /metrics (formato Prometheus, RT-7).
import { estadisticas } from '../../fanout/index.js';
import { registrarRuta } from '../../metrics/dashboard.js';

export default async function metrics(app) {
  registrarRuta(app, () => estadisticas().conexiones);
}
