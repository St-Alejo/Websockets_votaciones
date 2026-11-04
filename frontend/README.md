# frontend/ — Persona 3

Aquí van los frontends: página pública de resultados (SSE), app del jurado con cola offline (WS)
y consola de auditores/coordinador (WS). El stack lo elige Persona 3 y tendrá su **propio**
`package.json`; el `package.json` de la raíz es solo del backend.

ESLint y Prettier de la raíz ignoran esta carpeta: configure aquí el tooling que elija.

Contratos que consume: `docs/contratos.md` (endpoints, protocolo WS y esquemas).
