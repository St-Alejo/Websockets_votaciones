# Resultados públicos (Persona 3, RT-5)

Página ciudadana de resultados en vivo. **Transporte: Server-Sent Events**
(`GET /sse/publico`, dueño Persona 2); esta página solo lo consume.

## Correr

```bash
cd frontend/publico
npx --yes serve . -l 5176
```

Abrir `http://localhost:5176/?topico=dep` (o `?topico=mun:11`).

> En producción debe servirse bajo el mismo origen del backend (o con proxy),
> porque el EventSource apunta a `/sse/publico` del mismo origen.

## Qué muestra (solo datos del backend)

Snapshot `Acumulado`: votos por candidato + blancos/nulos/no marcados, sufragantes,
mesas informadas/totales, % de avance, última actualización y estado de conexión.
Filtros por nivel (dep/mun/pue/mesa). Sin recargas; reconexión con reanudación por
`ultimo_id` (RF-6, cuando P2 complete el replay) y sin duplicar eventos por `id:`.

## Pendiente de Persona 2

Deltas en vivo tras el snapshot y replay completo desde `ultimo_id` (hoy el plugin
envía snapshot + latidos). La página ya maneja ambos formatos.
