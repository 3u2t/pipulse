import { Router } from 'express';
import type { MonitoringProvider } from '../providers/providers.js';
import type { AppConfig } from '../config/config.js';
import { getDb } from '../db/db.js';
import { dockerAvailable, listContainers, containerDetail, containerAction, containerLogs, dockerCounts } from '../docker/containers.js';
import { readLogs } from '../collectors/system.js';
import { collectSmart } from '../collectors/smart.js';
import { listAlerts, getThresholds } from '../alerts/alerts.js';

export function apiRouter(provider: MonitoringProvider, _config: AppConfig): Router {
  const r = Router();

  r.get('/system', async (_req, res) => {
    const s = await provider.snapshot();
    res.json({ cpu: s.cpu, mem: s.mem, filesystems: s.filesystems, uptimeSec: s.uptimeSec, bootTime: s.bootTime, net: s.net, provider: provider.name });
  });
  r.get('/cpu', async (_req, res) => res.json((await provider.snapshot()).cpu));
  r.get('/memory', async (_req, res) => {
    const s = await provider.snapshot();
    res.json({ ...s.mem, top: [...s.processes].sort((a, b) => (b.memPct || 0) - (a.memPct || 0)).slice(0, 10) });
  });
  r.get('/storage', async (_req, res) => {
    const s = await provider.snapshot();
    const t = getThresholds();
    res.json({ filesystems: s.filesystems, diskIo: s.diskIo, smart: await collectSmart({ warn: t.driveTempWarn, crit: t.driveTempCrit }).catch(() => ({ tool: 'ok', drives: [] })) });
  });
  r.get('/network', async (_req, res) => res.json((await provider.snapshot()).net));
  r.get('/processes', async (_req, res) => res.json((await provider.snapshot()).processes));
  r.get('/services', async (_req, res) => res.json((await provider.snapshot()).services));

  r.get('/docker', async (_req, res) => {
    const { available, containers } = await listContainers().catch(() => ({ available: false, containers: [] }));
    const counts = await dockerCounts().catch(() => ({ images: 0, volumes: 0 }));
    res.json({
      available,
      running: containers.filter((c) => c.state === 'healthy' || c.state === 'running' || c.state === 'degraded').length,
      stopped: containers.filter((c) => c.state === 'stopped').length,
      restarting: containers.filter((c) => c.state === 'restarting').length,
      ...counts, containers,
    });
  });
  r.get('/docker/containers', async (_req, res) => {
    const out = await listContainers().catch(() => ({ available: false, containers: [] }));
    res.json(out.available ? out.containers : []);
  });
  r.get('/docker/containers/:id', async (req, res) => {
    const c = await containerDetail(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    res.json(c);
  });
  r.get('/docker/containers/:id/stats', (req, res) => {
    const rows = getDb().prepare('SELECT ts,cpu,mem_pct AS memPct,rx_bps AS rxBps,tx_bps AS txBps,read_bps AS readBps,write_bps AS writeBps FROM metrics WHERE kind=? AND ref=? ORDER BY ts DESC LIMIT 288')
      .all('container', req.params.id) as unknown as object[];
    res.json([...rows].reverse());
  });
  r.post('/docker/containers/:id/:action', async (req, res) => {
    const { id, action } = req.params;
    if (!['start', 'stop', 'restart'].includes(action)) return res.status(400).json({ error: 'action not allowed' });
    const ok = await containerAction(id, action as 'start' | 'stop' | 'restart');
    res.json({ ok });
  });
  r.get('/docker/containers/:id/logs', async (req, res) => {
    res.json(await containerLogs(req.params.id, Number(req.query.tail) || 200));
  });

  r.post('/services/:name/:action', async (req, res) => {
    const { name, action } = req.params;
    if (!/^[a-zA-Z0-9@:_.-]+\.service$/.test(name)) return res.status(400).json({ error: 'invalid service' });
    if (!['start', 'stop', 'restart'].includes(action)) return res.status(400).json({ error: 'action not allowed' });
    const { execFile } = await import('node:child_process');
    execFile('systemctl', [action, name], { timeout: 20000 }, (err) =>
      err ? res.status(500).json({ ok: false }) : res.json({ ok: true }));
  });

  r.get('/logs', async (req, res) => {
    const source = String(req.query.source || 'system');
    if (source === 'docker' && typeof req.query.container === 'string') {
      return res.json(await containerLogs(req.query.container, Number(req.query.tail) || 200));
    }
    res.json(await readLogs(source, typeof req.query.service === 'string' ? req.query.service : undefined, Number(req.query.lines) || 200));
  });

  r.get('/alerts', (req, res) => res.json(listAlerts(String(req.query.status || 'all'), String(req.query.q || '') || undefined)));
  r.post('/alerts/:id/ack', (req, res) => {
    getDb().prepare("UPDATE alerts SET status='acknowledged' WHERE id=?").run(req.params.id);
    res.json({ ok: true });
  });
  r.post('/alerts/:id/resolve', (req, res) => {
    getDb().prepare("UPDATE alerts SET status='resolved', resolved_at=datetime('now') WHERE id=?").run(req.params.id);
    res.json({ ok: true });
  });

  r.get('/settings', (_req, res) => {
    const rows = getDb().prepare('SELECT key,value FROM settings').all() as unknown as { key: string; value: string }[];
    res.json({ settings: Object.fromEntries(rows.map((x) => [x.key, x.value])), thresholds: getThresholds() });
  });
  r.put('/settings', (req, res) => {
    const allowed = new Set(['timezone', 'hostname', 'monitor_interval', 'th_cpu_warn', 'th_cpu_crit', 'th_temp_warn', 'th_temp_crit', 'th_mem_warn', 'th_mem_crit', 'th_disk_warn', 'th_disk_crit', 'th_drive_temp_warn', 'th_drive_temp_crit', 'retention_days', 'theme']);
    const body = req.body as Record<string, unknown>;
    for (const [k, v] of Object.entries(body || {})) {
      if (allowed.has(k) && (typeof v === 'string' || typeof v === 'number')) {
        getDb().prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
      }
    }
    res.json({ ok: true });
  });

  r.get('/history', (req, res) => {
    const kind = String(req.query.kind || 'host');
    const hours = Math.min(24 * 7, Math.max(0.02, Number(req.query.hours) || 1));
    const since = Date.now() - hours * 3600 * 1000;
    const rows = getDb().prepare('SELECT ts,cpu,mem_pct AS memPct,temp_c AS tempC,rx_bps AS rxBps,tx_bps AS txBps,read_bps AS readBps,write_bps AS writeBps FROM metrics WHERE kind=? AND ref=? AND ts>? ORDER BY ts ASC LIMIT 5000')
      .all(kind, String(req.query.ref || ''), since) as unknown as object[];
    res.json(rows.length ? rows : { message: 'Not enough data yet.' });
  });

  r.get('/docker-status', (_req, res) => res.json({ available: dockerAvailable() }));
  return r;
}
