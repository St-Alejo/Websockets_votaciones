export default async function sample(app) {
  app.get('/sample/nested', async () => ({ ok: true, instance: app.instanceId }));
}
