# API

Base: `http://<host>:8080`. Auth: `pipulse_session` cookie from `POST /api/auth/login`. Public: `/health`, `/api/health`, login/logout.

- `GET /api/system` — cpu, mem, filesystems, net, uptime
- `GET /api/cpu|/api/memory|/api/storage|/api/network|/api/processes|/api/services`
- `GET /api/docker` — counts + full container list (per-container CPU/RAM/net/blkio/health/anomalies/mining flag)
- `GET /api/docker/containers`, `GET /api/docker/containers/:id`, `GET /api/docker/containers/:id/stats`, `GET /api/docker/containers/:id/logs?tail=200`
- `POST /api/docker/containers/:id/{start,stop,restart}` (allowlist only)
- `POST /api/services/:name/{start,stop,restart}` (`*.service` regex only)
- `GET /api/logs?source=system|service|docker`
- `GET /api/alerts`, `POST /api/alerts/:id/{ack,resolve}`
- `GET|PUT /api/settings` (allowlisted keys)
- `GET /api/history?kind=host|container&ref=&hours=1`
- `GET /api/docker-status` — `{ available: boolean }` (cheap check for the Docker page)
- `POST /api/agent/push` (Bearer agent token, never exposed to frontend)
- `WS /ws` — full snapshot each `MONITOR_INTERVAL_MS`; send `refresh` to force a tick
