# load-test/ — Persona 2

Prueba de carga reproducible (RT-8): al menos 20.000 conexiones SSE simultáneas contra
`http://<host>:8080/sse/publico?topico=...` y el perfil de la jornada (90 actas/min, ráfagas de 300) usando `scripts/simular-actas.js` o `scripts/jurado-falso.js`.

Documentar aquí la herramienta elegida, cómo ejecutarla y los resultados.
