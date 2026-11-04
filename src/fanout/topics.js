// Dueño: Persona 2. Índice tópico → conexiones (RF-5).
//
// Estructura: Map<topico, Set<conexiones>> más un índice inverso conexión → tópicos.
// Costos:
//   - subscribe / unsubscribe de un tópico: O(1) (Map.get + Set.add/delete).
//   - lookup del conjunto de un tópico: O(1).
//   - recorrer las conexiones de un tópico: O(suscriptores de ESE tópico), no del total.
//   - cleanup de una conexión: O(k) con k = tópicos de esa conexión (cada baja es O(1)).
// La jerarquía pública del contrato es dep | mun:{id} | pue:{id} | mesa:{id}
// (departamento, municipio, puesto, mesa).

/** @type {Map<string, Set<object>>} */
const porTopico = new Map();

/** @type {Map<object, Set<string>>} */
const porConexion = new Map();

function exigir(conexion, topico) {
  if (!conexion || typeof conexion !== 'object') {
    throw new Error('La conexión es obligatoria');
  }
  if (topico == null || topico === '') {
    throw new Error('El tópico es obligatorio');
  }
}

/** Alta O(1). Repetir el par conexión+tópico no duplica la entrada. */
export function subscribe(conexion, topico) {
  exigir(conexion, topico);
  let conjunto = porTopico.get(topico);
  if (!conjunto) {
    conjunto = new Set();
    porTopico.set(topico, conjunto);
  }
  conjunto.add(conexion);

  let temas = porConexion.get(conexion);
  if (!temas) {
    temas = new Set();
    porConexion.set(conexion, temas);
  }
  temas.add(topico);
}

/** Baja O(1) de un tópico. Si era el último suscriptor, el tópico desaparece del índice. */
export function unsubscribe(conexion, topico) {
  if (!conexion || topico == null) return;
  const conjunto = porTopico.get(topico);
  if (conjunto) {
    conjunto.delete(conexion);
    if (conjunto.size === 0) porTopico.delete(topico);
  }
  const temas = porConexion.get(conexion);
  if (!temas) return;
  temas.delete(topico);
  if (temas.size === 0) porConexion.delete(conexion);
}

/** Saca la conexión de todos sus tópicos. O(k), k = tópicos de esa conexión. */
export function cleanup(conexion) {
  if (!conexion) return;
  const temas = porConexion.get(conexion);
  if (!temas) return;
  for (const topico of temas) {
    const conjunto = porTopico.get(topico);
    if (!conjunto) continue;
    conjunto.delete(conexion);
    if (conjunto.size === 0) porTopico.delete(topico);
  }
  porConexion.delete(conexion);
}

/** Conjunto vivo del tópico, o un Set vacío si nadie escucha. Lookup O(1). */
export function conexionesDe(topico) {
  return porTopico.get(topico) ?? new Set();
}

/** Recorre solo las conexiones de un tópico. Devuelve cuántas visitó. */
export function recorrer(topico, visitar) {
  const conjunto = porTopico.get(topico);
  if (!conjunto) return 0;
  let n = 0;
  for (const conexion of conjunto) {
    visitar(conexion);
    n += 1;
  }
  return n;
}

export function estadisticas() {
  let suscripciones = 0;
  for (const conjunto of porTopico.values()) suscripciones += conjunto.size;
  return {
    topicos: porTopico.size,
    suscripciones,
    conexiones: porConexion.size,
  };
}

/** Solo tests: deja el índice vacío. */
export function reiniciarTopicos() {
  porTopico.clear();
  porConexion.clear();
}
