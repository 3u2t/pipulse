# Architecture

```
Pi host (/proc, /sys, docker.sock, systemd, journald)
  │  /proc/stat, /proc/meminfo, /proc/net/dev, /proc/diskstats,
  │  /sys/class/thermal, cpufreq, df-based capacity, smartctl (best effort)
  ├─ Backend collectors (Node, no native deps) ── every MONITOR_INTERVAL_MS
  └─ PiPulse Agent (Go, stdlib only) ── POST /api/agent/push (bearer token)

Backend (Express + ws + node:sqlite)
  ├─ providers: RealMonitoringProvider | DemoMonitoringProvider (DEMO_MODE=true only)
  ├─ alerts: threshold engine, upsert/resolve by stable key
  ├─ db: SQLite via node:sqlite. metrics(kind,ref) rollups pruned by retention_days
  └─ WS /ws: full snapshot per tick; frontend falls back to polling if WS drops

Frontend (React + Vite + uPlot)
  └─ usePiPulseSocket → pages render snapshot; /api/history + container stats feed charts
```

Design notes: every collector returns null instead of throwing, so one missing
source (Docker, SMART, temp sensor, systemd) shows "Unavailable" and the rest
keeps working. Docker/secret access stays server-side; the browser only gets JSON.
