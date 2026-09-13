# API

Base: `http://<host>:8080`. Auth: `pipulse_session` cookie from `POST /api/auth/login`. Public: `/health`, `/api/health`, login/logout.

- `GET /api/system` — cpu, mem, filesystems, net, uptime
- `GET /api/cpu|/api/memory|/api/storage|/api/processes|/api/services`
- `GET /api/network` — `{ interfaces, summary }` (gateway, DNS resolvers, established TCP count)
- `GET /api/docker` — counts + full container list (per-container CPU/RAM/net/blkio/health/anomalies/mining flag)
- `GET /api/docker/containers`, `GET /api/docker/containers/:id`, `GET /api/docker/containers/:id/stats?hours=6`, `GET /api/docker/containers/:id/logs?tail=200`
- `POST /api/docker/containers/:id/{start,stop,restart}` (allowlist only)
- `POST /api/services/:name/{start,stop,restart}` (`*.service` regex only)
- `GET /api/logs?source=system|service|docker`
- `GET /api/alerts`, `POST /api/alerts/:id/{ack,resolve}`
- `GET|PUT /api/settings` (allowlisted keys, incl. `setup_completed` for the onboarding wizard)
- `GET /api/history?kind=host|container|iface&ref=&hours=1` — bucketed `{ points, bucketSec, total }`
- `GET /api/nodes` — known agents with liveness + last reported metrics
- `GET /api/notify` — notification config (passwords/tokens never returned) + delivery log
- `PUT /api/notify` — webhook URL, Telegram bot token + chat ID, event selection, SMTP settings (validated)
- `POST /api/notify/test` — `{ channel: 'webhook'|'telegram'|'email' }`, sends a test message
- `GET /api/docker-status` — `{ available: boolean }` (cheap check for the Docker page)
- `POST /api/agent/push` (Bearer agent token, never exposed to frontend)
- `WS /ws` — full snapshot each `MONITOR_INTERVAL_MS`, including `nodes`; send `refresh` to force a tick

## Notifications

Webhook POSTs JSON `{ event: 'firing'|'resolved'|'test', severity, title, message, component, key, hostname, ts }`.
Only new firings, escalations and resolutions send — steady-state alerts don't
re-notify (failed sends retry hourly). Nothing sends in demo mode. Email goes
through a minimal stdlib SMTP client (STARTTLS when offered, AUTH LOGIN when
a username is set); recent deliveries land in Settings with status + detail.

Telegram uses the Bot API `sendMessage` (fetch only, no extra deps): create a
bot via `@BotFather` (`/newbot`), start it once, put the token and your chat
ID (from `@userinfobot`, or `-100…` for groups) in Settings → Notifications,
then "Send test Telegram". Drive problems (SMART critical/warning, e.g.
reallocated sectors, pending sectors, NVMe media errors / spare / percentage
used) flow through the same pipeline — no extra wiring needed.
