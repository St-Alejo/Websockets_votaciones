# Consola de auditores (Persona 3)

Consola colaborativa en vivo: cola de verificación (RF-7) y presencia del equipo (RF-8)
sobre WebSocket (RT-5). Sin build ni dependencias: HTML + CSS + JS vanilla con módulos ES.

## Correr

```bash
cd frontend/auditor
npx --yes serve . -l 5174
# o: python3 -m http.server 5174
# o abrir con Live Server de VS Code
```

1. Levanta el backend (`npm run dev` en la raíz, idealmente con `npm run redis:dev`).
2. Abre `http://localhost:5174/?auditor=AUD-7` (el `auditor` también se pide en pantalla).
3. Por defecto el WS apunta al mismo origen (`/ws/auditor`). Si el frontend corre en
   otro puerto, escribe la URL completa en el login, p. ej. `ws://localhost:3000/ws/auditor?auditor=AUD-7`.

## Protocolo (compatible con `docs/contratos.md`, extendido sin romper)

Recibidos: `hola`, `caso`, `liberado`, `completado`, `cola` (snapshot + `evento`),
`presentes` (snapshot + `evento`), `bloqueo_perdido`, `latido_ok`, `error`.
Enviados: `latido`, `tomar`, `liberar`, `completar`, `cola`, `presentes`.

## Datos reales vs. pendientes

- La tabla muestra lo que envía el backend: acta, prioridad, responsable, presencia.
- `E14-puesto-mesa-corp` se parsea a puesto/mesa en el cliente; **municipio y fecha de
  ingreso aparecen como n/d**: la cola Redis guarda solo el id hoy. Pendiente de que
  P1 exponga el payload dudoso completo (entonces se enriquece sin cambiar el WS).
- La consola nunca asigna por su cuenta: `Tomar` pide y el servidor confirma con el
  bloqueo distribuido. Si el caso es `null`, la cola está vacía o todo ocupado.
