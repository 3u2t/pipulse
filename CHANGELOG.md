# Changelog

## 0.2.0 (2026-09-11)
- Notifications: generic webhook + SMTP email (stdlib-only client, STARTTLS/AUTH
  LOGIN), per-severity event selection, test buttons, delivery log, hourly retry
  on failure, resolved notices. Nothing sends in demo mode.
- History is bucketed server-side now (7-day graphs stay fast), with sample
  counts in the UI. Per-interface traffic history on the Network page.
- Multi-server: backend tracks one node per agent (metrics, liveness, SMART
  drives tagged by node), dashboard node switcher, per-node threshold alerts
  and per-agent disconnect alerts.
- More network detail: interface type (Ethernet/Wi-Fi/virtual), cumulative
  RX/TX totals, default gateway, DNS resolvers, established TCP count.
- Fixed a real bug found by the tests: agent `last_seen` was stored as
  milliseconds inside SQLite `datetime()`, so liveness silently fell back to
  memory only. Now stored as `datetime('now')` with push freshness as backup.
- Full SMART monitoring: per-drive model/firmware/capacity/temperature/health,
  power-on hours, reallocated/pending/uncorrectable counters, error log,
  self-test status, USB/SATA bridge (`-d sat`) fallback, Drive Health UI with
  masked serials, SMART alert rules, host-agent collection path, docs/smart.md.
- DB moved to Node's built-in `node:sqlite` (better-sqlite3 crashed on Node 24).
- Settings that were stored but ignored now work: monitoring interval applies
  without a restart, timezone formats timestamps, hostname shows in the topbar.
- Tick guard: a hung collector can't stack overlapping ticks.
- Fixed history charts not refreshing on range/container change.
- Fixed agent SMART data being ignored when the backend container has no
  local smartctl (the actual CasaOS deployment case).

## 0.1.0
- Initial release: live CPU/mem/disk/net, Docker per-container monitoring + detail, services, processes, logs, alerts, auth, CasaOS support, Go agent.
