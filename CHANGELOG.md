# Changelog

## Unreleased
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
