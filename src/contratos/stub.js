// CONTRATO COMPARTIDO — utilidad para marcar implementaciones falsas.
// Cada stub llama avisoStub(...) al entrar: el aviso sale una sola vez por función.
const avisados = new Set();

export function avisoStub(funcion, dueno) {
  if (avisados.has(funcion)) return;
  avisados.add(funcion);
  console.warn(
    `[STUB] ${funcion} usa una implementación falsa (dueño: ${dueno}). ` +
      'Reemplázala sin cambiar la firma (ver src/contratos/interfaces.js).',
  );
}
