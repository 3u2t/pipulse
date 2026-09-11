# PiPulse

**Your server. One pulse.**

A small monitoring dashboard for my home server. One page that tells me if everything is fine, with real numbers behind every chart — no fake graphs.

I run a Raspberry Pi 4 (8 GB, Debian 12) with CasaOS: Immich, Vaultwarden, Home Assistant, a 4 TB Toshiba USB drive, the usual setup. I got tired of SSHing in just to check `htop` and disk space, and everything I tried was either a huge enterprise stack or a pretty dashboard with made-up data. So this is the boring version: CPU, RAM, disks, Docker containers, services, logs, alerts. That's it.

Runs in production on my Pi. If something here looks half-finished, it probably is — open an issue.

## What it does

- Live CPU (usage, per-core, frequency, temperature, load), memory + swap
- Disk usage per mount, network speed per interface
- Every Docker container: CPU/RAM/net/disk, health status, start/stop/restart, detail page with history and logs
- systemd services (start/stop/restart), top processes, journal + container log viewer
- SMART drive health, including USB drives (reallocated/pending sectors, temperature, power-on hours)
- Alerts with configurable thresholds, WebSocket live updates with polling fallback
- Login auth, dark/light/system theme, Ctrl+K search, mobile layout

## Quick start

You need Docker and Docker Compose. On the Pi:

```bash
git clone https://github.com/3u2t/pipulse && cd pipulse
cp .env.example .env   # set AGENT_TOKEN + SESSION_SECRET (long random strings)
docker compose up -d --build
```

Open `http://<pi-ip>:8080`. On first boot the backend prints a generated admin password to the logs — change it under Settings.

```bash
docker logs pipulse 2>&1 | grep "created initial user"
```

## Host agent (recommended)

Without the agent you still get Docker stats and container info, but host CPU/memory/disk numbers inside the container are less accurate, and SMART won't work through most setups. The agent is a tiny Go binary (stdlib only, ~8 MB) that runs on the host via systemd:

```bash
# build for the Pi (from this repo, needs Go)
GOOS=linux GOARCH=arm64 go -C agent build -o pipulse-agent .
# copy pipulse-agent to the Pi, then there:
sudo PIPULSE_TOKEN=<same AGENT_TOKEN as in .env> ./agent/install.sh http://localhost:8080
```

## CasaOS

PiPulse is a normal CasaOS app — no special treatment, port 8080 so it doesn't fight CasaOS for 80/443. Custom install with the `docker-compose.yml` from this repo, set `PORT`, `AGENT_TOKEN`, `SESSION_SECRET`. Data lives in `/DATA/AppData/pipulse/{data,config,logs}` and survives updates.

One thing: if the Docker page says "unavailable" even though the socket is mounted, the container user can't read it. Check the gid with `stat -c %g /var/run/docker.sock` on the host and add it via `group_add` in the compose file. Don't run privileged, that's lazy.

## SMART / USB drives

Install smartmontools on the host:

```bash
sudo apt install smartmontools
```

The agent picks drives up automatically (it retries USB bridges with `-d sat`). My Toshiba 4 TB over USB works fine this way. Some cheap enclosures block SMART completely — then the dashboard says "SMART unavailable through this USB connection", which means "can't see inside", not "drive is dying". See `docs/smart.md` for the permission details.

Serial numbers are masked in the UI unless you click Reveal.

## Config

Everything via environment (see `.env.example`):

| Variable | Default | What |
|---|---|---|
| `PORT` | 8080 | Web UI port |
| `DATA_DIR` | ./data | SQLite + everything persistent |
| `AGENT_TOKEN` | — | Shared secret for the host agent, required |
| `SESSION_SECRET` | — | Cookie signing, required |
| `DEMO_MODE` | false | `true` fakes a Pi on your laptop for development |
| `MONITOR_INTERVAL_MS` | 5000 | Collection interval, changeable in Settings too |

## How it works

```
Pi host (/proc, /sys, docker.sock, systemd, smartctl)
  ├─ backend collectors (Node, every few seconds)
  └─ agent (Go) ──POST /api/agent/push──▶ backend (Express + SQLite)
                                                └─ WebSocket /ws ──▶ frontend (React + uPlot)
```

Production never fakes data. If a sensor is missing you get "Unavailable", not a zero. `DEMO_MODE=true` exists so I can work on the UI without the Pi — it's loud about being fake.

## Dev

```bash
npm install
DEMO_MODE=true npm --workspace backend run dev
npm --workspace frontend run dev   # second terminal
go -C agent test ./...
```

Backend tests: `npm --workspace backend run test`. Types: `npm --workspace backend run typecheck` (same for frontend).

## Known limitations

- Remote nodes report host metrics + SMART only. Docker/services/processes/logs are local to the backend host.
- Webhook + email notifications for alerts (no push to phones — use ntfy or Gotify as the webhook target if you want that).
- Docker actions are start/stop/restart on purpose. No exec, no compose management, never will be arbitrary commands.
- SQLite only. Fine for one Pi, don't @ me about Postgres.
- SMART over weird USB bridges may need a manual `-d` type — tell me which enclosure.
- I test on my Pi 4. x86 servers work (the collectors are plain `/proc` parsing) but that's not where my attention is.

## Roadmap

- [x] Basic monitoring, Docker per-container stats, WebSocket, CasaOS files
- [x] SMART with USB support, mobile layout
- [x] Notifications (webhook + SMTP email, with delivery log)
- [x] Bucketed history graphs, per-interface traffic history
- [x] Multi-server: one backend, several agents, per-node alerts
- [x] More network detail (interface type, totals, gateway, DNS, TCP count)

## Updating / uninstalling

```bash
docker compose pull && docker compose up -d   # data in /DATA/AppData/pipulse survives
docker compose down                            # stop; add --volumes only if you want history gone
```

Uninstalling never touches other apps, containers or volumes.

## License

MIT. Do what you want, no warranty. If it eats your homework that's on you.
