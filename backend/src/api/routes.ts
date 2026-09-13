import { Router } from 'express';
import type { MonitoringProvider } from '../providers/providers.js';
import type { AppConfig } from '../config/config.js';
import { getDb, getSetting } from '../db/db.js';
import { dockerAvailable, listContainers, containerDetail, containerAction, containerLogs, dockerCounts } from '../docker/containers.js';
import { readLogs, collectNetSummary } from '../collectors/system.js';
import { collectSmart } from '../collectors/smart.js';
import { listAlerts, getThresholds } from '../alerts/alerts.js';
import { queryHistory } from '../db/history.js';
import { agentNodes } from '../agent/agent.js';
import { getNotifyConfig, validateNotifyInput, listNotifications, sendWebhook, sendEmail, sendTelegram } from '../notify/notify.js';

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
  r.get('/network', async (_req, res) => {
    res.json({ interfaces: (await provider.snapshot()).net, summary: collectNetSummary() });
  });
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
    const hours = Math.min(24 * 7, Math.max(0.02, Number(req.query.hours) || 1));
    res.json(queryHistory('container', req.params.id, hours, 300));
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
    const allowed = new Set(['timezone', 'hostname', 'monitor_interval', 'th_cpu_warn', 'th_cpu_crit', 'th_temp_warn', 'th_temp_crit', 'th_mem_warn', 'th_mem_crit', 'th_disk_warn', 'th_disk_crit', 'th_drive_temp_warn', 'th_drive_temp_crit', 'retention_days', 'theme', 'setup_completed']);
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
    if (!/^(host|container|iface)$/.test(kind)) return res.status(400).json({ error: 'unknown history kind' });
    const hours = Math.min(24 * 7, Math.max(0.02, Number(req.query.hours) || 1));
    res.json(queryHistory(kind, String(req.query.ref || ''), hours, 300));
  });

  r.get('/nodes', (_req, res) => {
    res.json(agentNodes(Number(getSetting('monitor_interval', '5000')) || 5000));
  });

  r.get('/notify', (_req, res) => {
    const cfg = getNotifyConfig();
    // snake_case to match the PUT contract (the Settings form posts snake_case).
    res.json({
      config: {
        webhook_url: cfg.webhookUrl,
        events: cfg.events,
        telegram_chat_id: cfg.telegramChatId,
        telegram_bot_token_set: cfg.telegramBotToken !== '',
        smtp_host: cfg.smtpHost,
        smtp_port: String(cfg.smtpPort),
        smtp_user: cfg.smtpUser,
        smtp_from: cfg.smtpFrom,
        smtp_to: cfg.smtpTo,
        smtp_tls: cfg.smtpTls,
        smtp_pass_set: cfg.smtpPass !== '',
      },
      log: listNotifications(),
    });
  });
  r.put('/notify', (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const v = validateNotifyInput(body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const db = getDb();
    const set = (k: string, val: unknown) => {
      if (val === undefined) return;
      db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, Array.isArray(val) ? val.join(',') : String(val));
    };
    set('notify_webhook_url', body.webhook_url);
    set('notify_events', body.events);
    if (typeof body.telegram_bot_token === 'string' && body.telegram_bot_token !== '') set('notify_telegram_bot_token', body.telegram_bot_token.trim());
    set('notify_telegram_chat_id', typeof body.telegram_chat_id === 'string' ? body.telegram_chat_id.trim() : body.telegram_chat_id);
    set('notify_smtp_host', body.smtp_host);
    set('notify_smtp_port', body.smtp_port);
    set('notify_smtp_user', body.smtp_user);
    if (typeof body.smtp_pass === 'string' && body.smtp_pass !== '') set('notify_smtp_pass', body.smtp_pass);
    set('notify_smtp_from', body.smtp_from);
    set('notify_smtp_to', body.smtp_to);
    set('notify_smtp_tls', body.smtp_tls);
    res.json({ ok: true });
  });
  r.post('/notify/test', async (req, res) => {
    const body = (req.body || {}) as { channel?: string } & Record<string, unknown>;
    const cfg = getNotifyConfig();
    // Test uses saved config merged with any overrides in the request body.
    const merged = {
      ...cfg,
      webhookUrl: typeof body.webhook_url === 'string' ? body.webhook_url : cfg.webhookUrl,
      telegramBotToken: typeof body.telegram_bot_token === 'string' && body.telegram_bot_token !== '' ? body.telegram_bot_token.trim() : cfg.telegramBotToken,
      telegramChatId: typeof body.telegram_chat_id === 'string' ? body.telegram_chat_id.trim() : cfg.telegramChatId,
      smtpHost: typeof body.smtp_host === 'string' ? body.smtp_host : cfg.smtpHost,
      smtpTo: typeof body.smtp_to === 'string' ? body.smtp_to : cfg.smtpTo,
      smtpPass: typeof body.smtp_pass === 'string' && body.smtp_pass !== '' ? body.smtp_pass : cfg.smtpPass,
    };
    const payload = { event: 'test', severity: 'info', title: 'PiPulse test notification', message: 'If you see this, notifications work.', component: 'system', key: 'test', hostname: 'pipulse', ts: new Date().toISOString() };
    try {
      if (body.channel === 'email') {
        if (!merged.smtpHost || !merged.smtpTo) return res.status(400).json({ error: 'SMTP host and recipient are required' });
        await sendEmail({ host: merged.smtpHost, port: Number(body.smtp_port) || cfg.smtpPort, user: cfg.smtpUser, pass: merged.smtpPass, from: cfg.smtpFrom || cfg.smtpUser, tls: cfg.smtpTls }, merged.smtpTo, '[PiPulse] test notification', 'If you see this, email notifications work.');
      } else if (body.channel === 'telegram') {
        if (!merged.telegramBotToken || !merged.telegramChatId) return res.status(400).json({ error: 'Telegram bot token and chat ID are required' });
        await sendTelegram({ botToken: merged.telegramBotToken, chatId: merged.telegramChatId, apiBase: cfg.telegramApiBase }, '🔵 [PiPulse] test notification\nIf you see this, Telegram notifications work.');
      } else {
        if (!merged.webhookUrl) return res.status(400).json({ error: 'webhook URL is required' });
        await sendWebhook(merged.webhookUrl, payload);
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(502).json({ ok: false, error: (e as Error).message });
    }
  });

  r.get('/docker-status', (_req, res) => res.json({ available: dockerAvailable() }));
  return r;
}
