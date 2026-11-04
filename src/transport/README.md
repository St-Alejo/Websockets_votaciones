# src/transport — Persona 2

Adaptadores de transporte para el público (SSE, y polling si se usa para comparar).
Cada adaptador crea el objeto `conexion` opaco que se pasa a `suscribir(conexion, topico)` y
encapsula el envío, el conteo de bytes pendientes (RF-9) y el cierre con código de "vuelve con
continuidad".
