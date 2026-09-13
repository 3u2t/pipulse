import net from 'node:net';
import tls from 'node:tls';
import { getDb, getSetting } from '../db/db.js';
import type { AlertItem } from '../shared/types.js';

export interface NotifyConfig {
  webhookUrl: string;
  events: string[];
  telegramBotToken: string;
  telegramChatId: string;
  telegramApiBase: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
  smtpTo: string;
  smtpTls: 'auto' | 'direct' | 'off';
}

const EVENT_CHOICES = ['critical', 'warning', 'info', 'resolved'];

export function getNotifyConfig(): NotifyConfig {
  const events = getSetting('notify_events', 'critical,warning').split(',').map((s) => s.trim()).filter((s) => EVENT_CHOICES.includes(s));
  const port = Number(getSetting('notify_smtp_port', '587'));
  const tlsMode = getSetting('notify_smtp_tls', 'auto');
  return {
    webhookUrl: getSetting('notify_webhook_url', '').trim(),
    events: events.length ? events : ['critical', 'warning'],
    telegramBotToken: getSetting('notify_telegram_bot_token', '').trim(),
    telegramChatId: getSetting('notify_telegram_chat_id', '').trim(),
    telegramApiBase: getSetting('notify_telegram_api_base', 'https://api.telegram.org').trim() || 'https://api.telegram.org',
    smtpHost: getSetting('notify_smtp_host', '').trim(),
    smtpPort: Number.isFinite(port) && port > 0 && port < 65536 ? port : 587,
    smtpUser: getSetting('notify_smtp_user', ''),
    smtpPass: getSetting('notify_smtp_pass', ''),
    smtpFrom: getSetting('notify_smtp_from', ''),
    smtpTo: getSetting('notify_smtp_to', '').trim(),
    smtpTls: tlsMode === 'direct' || tlsMode === 'off' ? tlsMode : 'auto',
  };
}

export function validateNotifyInput(body: Record<string, unknown>): { ok: boolean; error?: string } {
  if (body.webhook_url !== undefined && body.webhook_url !== '') {
    if (typeof body.webhook_url !== 'string' || !/^https?:\/\/.+/.test(body.webhook_url)) return { ok: false, error: 'webhook URL must start with http:// or https://' };
  }
  if (body.telegram_bot_token !== undefined && body.telegram_bot_token !== '') {
    if (typeof body.telegram_bot_token !== 'string' || body.telegram_bot_token.length < 10 || !/^\d+:[\w-]{10,}$/.test(body.telegram_bot_token.trim())) {
      return { ok: false, error: 'Telegram bot token looks invalid (expected 123456:ABC… from @BotFather)' };
    }
  }
  if (body.telegram_chat_id !== undefined && body.telegram_chat_id !== '') {
    if (typeof body.telegram_chat_id !== 'string' || !/^(-?\d+|@[A-Za-z0-9_]{5,})$/.test(body.telegram_chat_id.trim())) {
      return { ok: false, error: 'Telegram chat ID must be a numeric ID (e.g. 123456789, -100… for groups) or @channel' };
    }
  }
  if (body.smtp_port !== undefined) {
    const p = Number(body.smtp_port);
    if (!Number.isFinite(p) || p < 1 || p > 65535) return { ok: false, error: 'SMTP port must be 1-65535' };
  }
  if (body.smtp_tls !== undefined && !['auto', 'direct', 'off'].includes(String(body.smtp_tls))) {
    return { ok: false, error: 'SMTP TLS mode must be auto, direct or off' };
  }
  if (body.events !== undefined) {
    if (!Array.isArray(body.events) || !(body.events as unknown[]).every((e) => EVENT_CHOICES.includes(String(e)))) {
      return { ok: false, error: 'events must be a subset of critical, warning, info, resolved' };
    }
  }
  if (body.smtp_to !== undefined && body.smtp_to !== '' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(body.smtp_to))) {
    return { ok: false, error: 'recipient address looks invalid' };
  }
  return { ok: true };
}

// ---------- delivery log ----------
function logNotification(kind: string, title: string, body: string, status: 'sent' | 'failed', detail: string): void {
  const db = getDb();
  db.prepare('INSERT INTO notifications(ts,kind,title,body,status,detail) VALUES(?,?,?,?,?,?)')
    .run(Date.now(), kind, title, body.slice(0, 500), status, String(detail).slice(0, 500));
  db.prepare('DELETE FROM notifications WHERE id NOT IN (SELECT id FROM notifications ORDER BY ts DESC LIMIT 200)').run();
}

export function listNotifications(): { id: number; ts: number; kind: string; title: string; status: string; detail: string }[] {
  return getDb().prepare('SELECT id,ts,kind,title,status,detail FROM notifications ORDER BY ts DESC LIMIT 100').all() as unknown as { id: number; ts: number; kind: string; title: string; status: string; detail: string }[];
}

// ---------- webhook ----------
export async function sendWebhook(url: string, payload: Record<string, unknown>): Promise<void> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'PiPulse/0.1' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`webhook returned HTTP ${res.status}`);
  } finally {
    clearTimeout(t);
  }
}

// ---------- telegram (Bot API, fetch only — no extra deps) ----------
export interface TelegramOptions { botToken: string; chatId: string; apiBase?: string; timeoutMs?: number }

export function telegramMessageFor(t: NotifyTarget, hostname: string): string {
  const icon = t.severity === 'critical' ? '🔴' : t.severity === 'warning' ? '🟡' : t.severity === 'resolved' ? '🟢' : '🔵';
  return `${icon} [PiPulse] ${t.severity.toUpperCase()}: ${t.title}\n${t.message}\n\nHost: ${hostname}\nTime: ${new Date().toISOString()}\nKey: ${t.key}`.slice(0, 4000);
}

export async function sendTelegram(o: TelegramOptions, text: string): Promise<void> {
  const base = (o.apiBase || 'https://api.telegram.org').replace(/\/+$/, '');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 10000);
  try {
    const res = await fetch(`${base}/bot${o.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'PiPulse/0.1' },
      body: JSON.stringify({ chat_id: /^-?\d+$/.test(o.chatId) ? Number(o.chatId) : o.chatId, text }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`telegram returned HTTP ${res.status}`);
    const data = (await res.json()) as { ok?: boolean; description?: string };
    if (!data.ok) throw new Error(`telegram rejected message: ${data.description || 'unknown error'}`);
  } finally {
    clearTimeout(t);
  }
}

// ---------- minimal SMTP (stdlib only: net + tls) ----------
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

class SmtpLines {
  private buf = '';
  constructor(private sock: net.Socket) {}
  send(data: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sock.write(data, (e) => (e ? reject(e) : resolve()));
    });
  }
  line(): Promise<string> {
    const sock = this.sock;
    return new Promise((resolve, reject) => {
      const take = (): boolean => {
        const i = this.buf.indexOf('\r\n');
        if (i < 0) return false;
        const l = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 2);
        resolve(l);
        return true;
      };
      if (take()) return;
      const onData = (chunk: Buffer) => { this.buf += chunk.toString('utf8'); if (take()) cleanup(); };
      const onErr = (e: Error) => { cleanup(); reject(e); };
      const onClose = () => { cleanup(); reject(new Error('SMTP connection closed')); };
      const cleanup = () => { sock.off('data', onData); sock.off('error', onErr); sock.off('close', onClose); };
      sock.on('data', onData);
      sock.once('error', onErr);
      sock.once('close', onClose);
    });
  }
}

async function readReply(io: SmtpLines): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  for (;;) {
    const l = await io.line();
    lines.push(l);
    if (/^\d{3} /.test(l)) break;
    if (!/^\d{3}-/.test(l)) throw new Error(`unexpected SMTP reply: ${l}`);
    if (lines.length > 20) throw new Error('SMTP reply too long');
  }
  return { code: Number(lines[lines.length - 1].slice(0, 3)), text: lines.join('\n') };
}

async function smtpCmd(io: SmtpLines, text: string, want: number): Promise<void> {
  await io.send(text + '\r\n');
  const r = await readReply(io);
  if (r.code !== want) throw new Error(`${text.split(' ')[0]} failed: ${r.text.split('\n').pop()}`);
}

export interface SmtpOptions { host: string; port: number; user: string; pass: string; from: string; tls: 'auto' | 'direct' | 'off'; timeoutMs?: number }

export async function sendEmail(o: SmtpOptions, to: string, subject: string, text: string): Promise<void> {
  const timeoutMs = o.timeoutMs ?? 15000;
  await withTimeout((async () => {
    let sock: net.Socket = await new Promise((resolve, reject) => {
      const s = net.connect(o.port, o.host);
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    sock.setTimeout(0);
    try {
      const direct = o.tls === 'direct' || o.port === 465;
      if (direct) {
        sock = await new Promise<tls.TLSSocket>((resolve, reject) => {
          const t = tls.connect({ socket: sock, servername: o.host }, () => resolve(t));
          t.once('error', reject);
        });
      }
      let io = new SmtpLines(sock);
      const greet = await readReply(io);
      if (greet.code !== 220) throw new Error(`greeting failed: ${greet.text}`);
      let ehlo = await (async () => { await io.send('EHLO pipulse\r\n'); return readReply(io); })();
      if (ehlo.code !== 250) throw new Error(`EHLO failed: ${ehlo.text}`);
      if (!direct && o.tls !== 'off' && /STARTTLS/i.test(ehlo.text)) {
        await smtpCmd(io, 'STARTTLS', 220);
        sock = await new Promise<tls.TLSSocket>((resolve, reject) => {
          const t = tls.connect({ socket: sock, servername: o.host }, () => resolve(t));
          t.once('error', reject);
        });
        io = new SmtpLines(sock);
        await io.send('EHLO pipulse\r\n');
        ehlo = await readReply(io);
        if (ehlo.code !== 250) throw new Error(`EHLO after STARTTLS failed: ${ehlo.text}`);
      }
      if (o.user) {
        await smtpCmd(io, 'AUTH LOGIN', 334);
        await smtpCmd(io, Buffer.from(o.user, 'utf8').toString('base64'), 334);
        await smtpCmd(io, Buffer.from(o.pass, 'utf8').toString('base64'), 235);
      }
      await smtpCmd(io, `MAIL FROM:<${o.from || o.user}>`, 250);
      await smtpCmd(io, `RCPT TO:<${to}>`, 250);
      await smtpCmd(io, 'DATA', 354);
      const subj = /[^\x20-\x7e]/.test(subject) ? `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=` : subject;
      await io.send(`From: ${o.from || o.user}\r\nTo: ${to}\r\nSubject: ${subj}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n.\r\n`);
      const done = await readReply(io);
      if (done.code !== 250) throw new Error(`message rejected: ${done.text}`);
      try { await smtpCmd(io, 'QUIT', 221); } catch { /* goodbye anyway */ }
    } finally {
      sock.destroy();
    }
  })(), timeoutMs, 'SMTP send');
}

// ---------- reconcile: only new firings and fresh resolutions notify ----------
export interface NotifyTarget { key: string; severity: string; title: string; message: string; component: string }

function payloadFor(t: NotifyTarget, hostname: string): Record<string, unknown> {
  return {
    event: t.severity === 'resolved' ? 'resolved' : 'firing',
    severity: t.severity, title: t.title, message: t.message,
    component: t.component, key: t.key, hostname, ts: new Date().toISOString(),
  };
}

async function deliver(cfg: NotifyConfig, t: NotifyTarget, hostname: string): Promise<void> {
  const jobs: Promise<void>[] = [];
  if (cfg.webhookUrl) {
    jobs.push((async () => {
      try {
        await sendWebhook(cfg.webhookUrl, payloadFor(t, hostname));
        logNotification('webhook', t.title, t.message, 'sent', cfg.webhookUrl);
      } catch (e) {
        logNotification('webhook', t.title, t.message, 'failed', (e as Error).message);
        throw e;
      }
    })());
  }
  if (cfg.telegramBotToken && cfg.telegramChatId) {
    jobs.push((async () => {
      const text = telegramMessageFor(t, hostname);
      try {
        await sendTelegram({ botToken: cfg.telegramBotToken, chatId: cfg.telegramChatId, apiBase: cfg.telegramApiBase }, text);
        logNotification('telegram', t.title, t.message, 'sent', cfg.telegramChatId);
      } catch (e) {
        logNotification('telegram', t.title, t.message, 'failed', (e as Error).message);
        throw e;
      }
    })());
  }
  if (cfg.smtpTo && cfg.smtpHost) {
    const subject = `[PiPulse] ${t.severity.toUpperCase()}: ${t.title}`;
    jobs.push((async () => {
      try {
        await sendEmail({ host: cfg.smtpHost, port: cfg.smtpPort, user: cfg.smtpUser, pass: cfg.smtpPass, from: cfg.smtpFrom || cfg.smtpUser, tls: cfg.smtpTls }, cfg.smtpTo, subject, `${t.message}\n\nHost: ${hostname}\nTime: ${new Date().toISOString()}\nKey: ${t.key}`);
        logNotification('email', subject, t.message, 'sent', cfg.smtpTo);
      } catch (e) {
        logNotification('email', subject, t.message, 'failed', (e as Error).message);
        throw e;
      }
    })());
  }
  if (!jobs.length) return;
  await Promise.all(jobs);
}

// Called once per monitoring tick, after evaluateAlerts. Returns after all
// sends settle; the hub calls it without awaiting so a slow webhook or mail
// server can never stall the tick.
export async function reconcileNotifications(active: AlertItem[], hostname: string, demo: boolean): Promise<void> {
  if (demo) return;
  try {
    const cfg = getNotifyConfig();
    if (!cfg.webhookUrl && !(cfg.smtpTo && cfg.smtpHost) && !(cfg.telegramBotToken && cfg.telegramChatId)) return;
    const db = getDb();
    const known = new Map(
      (db.prepare('SELECT key, severity, status, updated_at AS updatedAt FROM notified_keys').all() as unknown as { key: string; severity: string; status: string; updatedAt: string }[])
        .map((r) => [r.key, r] as const)
    );
      const activeKeys = new Set(active.map((a) => a.key));
      // New firings and escalations.
      for (const a of active) {
        if (!cfg.events.includes(a.severity)) continue;
        const prev = known.get(a.key);
        if (prev && prev.severity === a.severity && prev.status === 'sent') continue;
        if (prev && prev.status === 'failed' && Date.now() - new Date(prev.updatedAt + 'Z').getTime() < 3600 * 1000) continue; // retry hourly
        const t: NotifyTarget = { key: a.key, severity: a.severity, title: a.message, message: a.message, component: a.component };
        try {
          await deliver(cfg, t, hostname);
          db.prepare("INSERT INTO notified_keys(key,severity,status,updated_at) VALUES(?,?, 'sent', datetime('now')) ON CONFLICT(key) DO UPDATE SET severity=excluded.severity, status='sent', updated_at=datetime('now')").run(a.key, a.severity);
        } catch {
          db.prepare("INSERT INTO notified_keys(key,severity,status,updated_at) VALUES(?,?, 'failed', datetime('now')) ON CONFLICT(key) DO UPDATE SET severity=excluded.severity, status='failed', updated_at=datetime('now')").run(a.key, a.severity);
        }
      }
      // Resolutions are best-effort: try once, then forget the key either way.
      for (const [key, row] of known) {
        if (activeKeys.has(key)) continue;
        db.prepare('DELETE FROM notified_keys WHERE key=?').run(key);
        if (row.severity === 'resolved' || !cfg.events.includes('resolved')) continue;
        const t: NotifyTarget = { key, severity: 'resolved', title: `Resolved: ${key}`, message: `Resolved: ${key}`, component: 'system' };
        try { await deliver(cfg, t, hostname); } catch { /* best effort */ }
      }
  } catch (e) {
    console.error('[pipulse] notify reconcile failed:', (e as Error).message);
  }
}
