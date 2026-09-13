import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { fmtDateTime } from '../lib/format.js';

interface NotifyState {
  webhook_url: string; events: string[];
  telegram_bot_token: string; telegram_chat_id: string; telegram_bot_token_set: boolean;
  smtp_host: string; smtp_port: string; smtp_user: string; smtp_pass: string;
  smtp_from: string; smtp_to: string; smtp_tls: string; smtp_pass_set: boolean;
}
interface NotifyLog { id: number; ts: number; kind: string; title: string; status: string; detail: string }

const ALL_EVENTS = ['critical', 'warning', 'info', 'resolved'];

export function Settings() {
  const [s, setS] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const [health, setHealth] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    api<{ settings: Record<string, string> }>(`/api/settings`).then((r) => setS(r.settings)).catch(() => setS({}));
    api<Record<string, string>>(`/api/health`).then(setHealth).catch(() => setHealth(null));
  }, []);
  const save = async () => {
    await api(`/api/settings`, { method: 'PUT', body: JSON.stringify(s) });
    // Timezone/hostname apply locally without a reload.
    localStorage.setItem('pipulse-tz', s.timezone || '');
    localStorage.setItem('pipulse-hostname', s.hostname || '');
    setMsg('Settings saved.'); setTimeout(() => setMsg(''), 2500);
  };
  const field = (k: string, label: string) => (
    <p><label>{label}<br /><input value={s[k] || ''} onChange={(e) => setS({ ...s, [k]: e.target.value })} /></label></p>
  );
  return (<>
    <h2>Settings</h2>
    {msg && <p>{msg}</p>}
    <h3>General</h3>
    {field('timezone', 'Timezone')}{field('hostname', 'Hostname')}{field('monitor_interval', 'Monitoring interval (ms)')}
    <h3>Monitoring thresholds</h3>
    {field('th_cpu_warn', 'CPU warning %')}{field('th_cpu_crit', 'CPU critical %')}
    {field('th_temp_warn', 'Temperature warning °C')}{field('th_temp_crit', 'Temperature critical °C')}
    {field('th_mem_warn', 'RAM warning %')}{field('th_mem_crit', 'RAM critical %')}
    {field('th_disk_warn', 'Storage warning %')}{field('th_disk_crit', 'Storage critical %')}
    {field('th_drive_temp_warn', 'Drive temp warning °C')}{field('th_drive_temp_crit', 'Drive temp critical °C')}
    {field('retention_days', 'Data retention (days)')}
    <p><button onClick={save}>Save settings</button></p>
    <Notifications />
    <h3>System</h3>
    {!health ? <p className="muted">Loading…</p> : <pre className="small">{JSON.stringify(health, null, 2)}</pre>}
  </>);
}

function Notifications() {
  const [n, setN] = useState<NotifyState>({ webhook_url: '', events: ['critical', 'warning'], telegram_bot_token: '', telegram_chat_id: '', telegram_bot_token_set: false, smtp_host: '', smtp_port: '587', smtp_user: '', smtp_pass: '', smtp_from: '', smtp_to: '', smtp_tls: 'auto', smtp_pass_set: false });
  const [log, setLog] = useState<NotifyLog[]>([]);
  const [msg, setMsg] = useState('');
  const load = async () => {
    try {
      const r = await api<{ config: NotifyState; log: NotifyLog[] }>(`/api/notify`);
      setN({ ...r.config, telegram_bot_token: '', smtp_pass: '' });
      setLog(r.log);
    } catch { /* backend older than notifications, or offline */ }
  };
  useEffect(() => { void load(); }, []);
  const set = (k: keyof NotifyState, v: string) => setN({ ...n, [k]: v });
  const toggleEvent = (e: string) => setN({ ...n, events: n.events.includes(e) ? n.events.filter((x) => x !== e) : [...n.events, e] });
  const save = async () => {
    await api(`/api/notify`, { method: 'PUT', body: JSON.stringify({ ...n, smtp_pass: n.smtp_pass || undefined }) });
    setMsg('Notification settings saved.');
    setTimeout(() => setMsg(''), 2500);
    void load();
  };
  const test = async (channel: 'webhook' | 'email' | 'telegram') => {
    setMsg('Sending test…');
    try {
      await api(`/api/notify/test`, { method: 'POST', body: JSON.stringify({ channel }) });
      setMsg(`Test sent via ${channel}.`);
    } catch (e) {
      setMsg(`Test failed: ${(e as Error).message}`);
    }
    setTimeout(() => setMsg(''), 4000);
    void load();
  };
  return (<>
    <h3>Notifications</h3>
    {msg && <p>{msg}</p>}
    <p><label>Webhook URL (POSTs JSON on alerts)<br />
      <input value={n.webhook_url} onChange={(e) => set('webhook_url', e.target.value)} placeholder="https://… or http://…:8123/api/webhook/…" style={{ width: 'min(480px, 100%)' }} /></label></p>
    <p>Notify on:{' '}
      {ALL_EVENTS.map((e) => (
        <label key={e} style={{ display: 'inline-block', marginRight: 12, fontWeight: 400 }}>
          <input type="checkbox" checked={n.events.includes(e)} onChange={() => toggleEvent(e)} /> {e}
        </label>
      ))}
    </p>
    <h3>Telegram</h3>
    <p className="small muted">1. Schreib <code>@BotFather</code> auf Telegram an, sende <code>/newbot</code> und kopiere den Token. 2. Starte deinen Bot einmal (damit er dir schreiben darf). 3. Finde deine Chat-ID z. B. über <code>@userinfobot</code> — oder für Gruppen: Bot in die Gruppe einladen, dann ID aus <code>getUpdates</code> lesen. HDD/SSD-Warnungen (SMART critical/warning) kommen automatisch, sobald oben critical/warning aktiviert ist.</p>
    <p><label>Bot token{n.telegram_bot_token_set ? ' (saved — leave empty to keep)' : ''}<br /><input type="password" value={n.telegram_bot_token} onChange={(e) => set('telegram_bot_token', e.target.value)} placeholder="123456789:AA…" style={{ width: 'min(480px, 100%)' }} /></label></p>
    <p><label>Chat ID (Zahl, -100… für Gruppen, oder @channel)<br /><input value={n.telegram_chat_id} onChange={(e) => set('telegram_chat_id', e.target.value)} placeholder="123456789" /></label></p>
    <h3>Email (SMTP)</h3>
    <p className="small muted">Plain SMTP with STARTTLS when offered, AUTH LOGIN when a username is set. For Gmail use an app password.</p>
    <p><label>SMTP host<br /><input value={n.smtp_host} onChange={(e) => set('smtp_host', e.target.value)} placeholder="mail.example.com" /></label></p>
    <p><label>Port<br /><input value={n.smtp_port} onChange={(e) => set('smtp_port', e.target.value)} placeholder="587" /></label></p>
    <p><label>TLS<br /><select value={n.smtp_tls} onChange={(e) => set('smtp_tls', e.target.value)}>
      <option value="auto">auto</option><option value="direct">direct (port 465)</option><option value="off">off (local relay)</option>
    </select></label></p>
    <p><label>Username<br /><input value={n.smtp_user} onChange={(e) => set('smtp_user', e.target.value)} /></label></p>
    <p><label>Password{n.smtp_pass_set ? ' (saved — leave empty to keep)' : ''}<br /><input type="password" value={n.smtp_pass} onChange={(e) => set('smtp_pass', e.target.value)} /></label></p>
    <p><label>From address<br /><input value={n.smtp_from} onChange={(e) => set('smtp_from', e.target.value)} placeholder="pipulse@example.com" /></label></p>
    <p><label>To address<br /><input value={n.smtp_to} onChange={(e) => set('smtp_to', e.target.value)} placeholder="me@example.com" /></label></p>
    <p>
      <button onClick={save}>Save notification settings</button>{' '}
      <button onClick={() => test('webhook')}>Send test webhook</button>{' '}
      <button onClick={() => test('telegram')}>Send test Telegram</button>{' '}
      <button onClick={() => test('email')}>Send test email</button>
    </p>
    <h3>Recent deliveries</h3>
    {log.length === 0 ? <p className="muted">Nothing sent yet.</p> : (
      <div style={{ overflowX: 'auto' }}><table><thead><tr><th>Time</th><th>Channel</th><th>Title</th><th>Status</th><th>Detail</th></tr></thead><tbody>
        {log.map((l) => <tr key={l.id}><td className="small">{fmtDateTime(new Date(l.ts).toISOString())}</td><td>{l.kind}</td><td className="small">{l.title}</td><td>{l.status === 'sent' ? '🟢 sent' : '🔴 failed'}</td><td className="small muted">{l.detail}</td></tr>)}
      </tbody></table></div>
    )}
  </>);
}
