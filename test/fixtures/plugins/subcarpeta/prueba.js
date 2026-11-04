// Plugin de prueba en una subcarpeta: comprueba que autoload recorre subcarpetas
// SIN anteponer el nombre de la carpeta a la ruta (dirNameRoutePrefix: false).
export default async function prueba(app) {
  app.get('/prueba/anidado', async () => ({ ok: true, instancia: app.instanceId }));
}
