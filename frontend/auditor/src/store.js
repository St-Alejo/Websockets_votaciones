// Estado central de la consola. Sin dependencias: pub/sub mínimo.
export function crearStore() {
  const estado = {
    auditor: null,
    instancia: null,
    conectada: false,
    cola: [],
    presentes: [],
    // Auditores vistos en esta sesión (para contar desconectados).
    conocidos: new Map(), // auditor -> { registro, online }
    miCaso: null, // { acta, token }
    resueltasSesion: 0,
    log: [],
  };
  const oyentes = new Set();
  return {
    estado,
    suscribir(fn) {
      oyentes.add(fn);
      return () => oyentes.delete(fn);
    },
    actualizar(parche) {
      Object.assign(estado, parche);
      for (const fn of oyentes) fn(estado);
    },
    marcarVistos(lista) {
      const vistos = new Set(lista.map((p) => p.auditor));
      for (const p of lista) estado.conocidos.set(p.auditor, { registro: p, online: true });
      for (const [auditor, info] of estado.conocidos) {
        if (!vistos.has(auditor)) info.online = false;
      }
      for (const fn of oyentes) fn(estado);
    },
    marcarEventoPresencia(evento) {
      if (!evento || !evento.auditor) return;
      estado.conocidos.set(evento.auditor, {
        registro: { ...evento, acta_actual: evento.acta_actual ?? null },
        online: evento.estado !== 'offline',
      });
      for (const fn of oyentes) fn(estado);
    },
    agregarLog(texto, clase = '') {
      estado.log.unshift({ hora: new Date(), texto, clase });
      estado.log = estado.log.slice(0, 80);
      for (const fn of oyentes) fn(estado);
    },
  };
}
