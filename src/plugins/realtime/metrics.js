import { stats } from '../../fanout/index.js';
import { registerRoute } from '../../metrics/dashboard.js';

export default async function metrics(app) {
  registerRoute(app, () => stats().connections);
}
