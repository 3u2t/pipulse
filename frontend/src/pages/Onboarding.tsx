import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';

const STEPS = ['Welcome', 'Password', 'Server', 'Thresholds', 'Notifications', 'System check', 'Done'];
const ALL_EVENTS = ['critical', 'warning', 'info', 'resolved'];

interface NotifyForm {
  webhook_url: string; events: string[];
  telegram_bot_token: string; telegram_chat_id: string; telegram_bot_token_set: boolean;
  smtp_host: string; smtp_port: string; smtp_user: string; smtp_pass: string;
  smtp_from: string; smtp_to: string; smtp_tls: string; smtp_pass_set: boolean;
}

const EMPTY_NOTIFY: NotifyForm = {
  webhook_url: '', events: ['critical', 'warning'],
  telegram_bot_token: '', telegram_chat_id: '', telegram_bot_token_set: false,
  smtp_host: '', smtp_port: '587', smtp_user: '', smtp_pass: '',
  smtp_from: '', smtp_to: '', smtp_tls: 'auto', smtp_pass_set: false,
};

const THRESHOLDS: [string, string][] = [
  ['th_cpu_warn', 'CPU warning %'], ['th_cpu_crit', 'CPU critical %'],
  ['th_temp_warn', 'Temperature warning °C'], ['th_temp_crit', 'Temperature critical °C'],
  ['th_mem_warn', 'RAM warning %'], ['th_mem_crit', 'RAM critical %'],
  ['th_disk_warn', 'Storage warning %'], ['th_disk_crit', 'Storage critical %'],
  ['th_drive_temp_warn', 'Drive temp warning °C'], ['th_drive_temp_crit', 'Drive temp critical °C'],
  ['th_ssh_warn', 'SSH failed attempts warning (per IP / 10 min)'], ['th_ssh_crit', 'SSH failed attempts critical (per IP / 10 min)'],
];

export function Onboarding() {
  const nav = useNavigate();
  const [step, setStep] = useState(0);
  const [s, setS] = useState<Record<string, string>>({});
  const [n, setN] = useState<NotifyForm>(EMPTY_NOTIFY);
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<{ health: Record<string, string> | null; nodes: { hostname: string; connected: boolean }[] | null; smartTool: string | null }>({ health: null, nodes: null, smartTool: null });

  useEffect(() => {
    api<{ settings: Record<string, string> }>(`/api/settings`).then((r) => setS(r.settings)).catch(() => undefined);
    api<{ config: NotifyForm }>(`/api/notify`).then((r) => setN({ ...EMPTY_NOTIFY, ...r.config, telegram_bot_token: '', smtp_pass: '' })).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (step !== 5) return;
    api<Record<string, string>>(`/api/health`).then((h) => setCheck((c) => ({ ...c, health: h }))).catch(() => undefined);
    api<{ hostname: string; connected: boolean }[]>(`/api/nodes`).then((ns) => setCheck((c) => ({ ...c, nodes: ns }))).catch(() => undefined);
    api<{ smart: { tool: string } }>(`/api/storage`).then((r) => setCheck((c) => ({ ...c, smartTool: r.smart?.tool || '?' }))).catch(() => undefined);
  }, [step]);

  const say = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 4000); };
  const next = () => { setMsg(''); setStep((x) => Math.min(STEPS.length - 1, x + 1)); window.scrollTo(0, 0); };
  const back = () => { setMsg(''); setStep((x) => Math.max(0, x - 1)); window.scrollTo(0, 0); };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); next(); } catch (e) { say(`Error: ${(e as Error).message}`); } finally { setBusy(false); }
  };

  const savePassword = () => run(async () => {
    if (pw1.length < 8) throw new Error('Password must be at least 8 characters.');
    if (pw1 !== pw2) throw new Error('Passwords do not match.');
    await api(`/api/auth/password`, { method: 'POST', body: JSON.stringify({ password: pw1 }) });
    setPw1(''); setPw2('');
  });

  const saveServer = () => run(async () => {
    await api(`/api/settings`, { method: 'PUT', body: JSON.stringify(s) });
    localStorage.setItem('pipulse-tz', s.timezone || '');
    localStorage.setItem('pipulse-hostname', s.hostname || '');
    if (s.theme) { localStorage.setItem('pipulse-theme', s.theme); document.documentElement.dataset.theme = s.theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : s.theme; }
  });

  const saveThresholds = () => run(async () => {
    await api(`/api/settings`, { method: 'PUT', body: JSON.stringify(s) });
  });

  const saveNotify = () => run(async () => {
    await api(`/api/notify`, { method: 'PUT', body: JSON.stringify({ ...n, smtp_pass: n.smtp_pass || undefined, telegram_bot_token: n.telegram_bot_token || undefined }) });
  });

  const testNotify = async (channel: 'webhook' | 'telegram' | 'email') => {
    setBusy(true);
    try {
      await api(`/api/notify/test`, { method: 'POST', body: JSON.stringify({ channel }) });
      say(`Test sent via ${channel} — arrived? Then the configuration is correct.`);
    } catch (e) { say(`Test failed: ${(e as Error).message}`); } finally { setBusy(false); }
  };

  const finish = (done: boolean) => run(async () => {
    if (done) await api(`/api/settings`, { method: 'PUT', body: JSON.stringify({ setup_completed: '1' }) });
    nav('/');
  });

  const field = (k: string, label: string, placeholder = '') => (
    <p><label>{label}<br /><input value={s[k] || ''} placeholder={placeholder} onChange={(e) => setS({ ...s, [k]: e.target.value })} /></label></p>
  );
  const nfield = (k: keyof NotifyForm, label: string, placeholder = '', type = 'text') => (
    <p><label>{label}<br /><input type={type} value={String(n[k])} placeholder={placeholder} style={{ width: 'min(480px, 100%)' }} onChange={(e) => setN({ ...n, [k]: e.target.value })} /></label></p>
  );
  const toggleEvent = (e: string) => setN({ ...n, events: n.events.includes(e) ? n.events.filter((x) => x !== e) : [...n.events, e] });

  return (<>
    <h2>Setup</h2>
    <div className="steps">
      {STEPS.map((l, i) => (
        <span key={l} className={`step${i === step ? ' step-now' : ''}${i < step ? ' step-done' : ''}`} onClick={() => setStep(i)} title={l}>{i + 1}</span>
      ))}
      <span className="small muted" style={{ marginLeft: 8 }}>{STEPS[step]}</span>
    </div>
    {msg && <p>{msg}</p>}

    {step === 0 && (
      <div className="card">
        <h3>Welcome to PiPulse 👋</h3>
        <p>A few steps and everything is set up:</p>
        <ol>
          <li><b>Password</b> — change the default password.</li>
          <li><b>Server</b> — name, timezone, interval.</li>
          <li><b>Thresholds</b> — when to warn you.</li>
          <li><b>Notifications</b> — webhook, Telegram, email (so HDD/SSD problems reach you immediately).</li>
          <li><b>System check</b> — verify agent, SMART and Docker.</li>
        </ol>
        <p>
          <button onClick={next} disabled={busy}>Let's go</button>{' '}
          <button onClick={() => finish(true)} disabled={busy}>Skip — I know my way around</button>
        </p>
      </div>
    )}

    {step === 1 && (
      <div className="card">
        <h3>1. Change password</h3>
        <p className="small muted">The first user (<code>admin</code>) has a generated starter password from the Docker logs. Set your own here (min. 8 characters).</p>
        <p><label>New password<br /><input type="password" value={pw1} onChange={(e) => setPw1(e.target.value)} /></label></p>
        <p><label>Repeat<br /><input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></label></p>
        <p><button onClick={savePassword} disabled={busy}>Save & continue</button>{' '}<button onClick={next} disabled={busy}>Later</button>{' '}<button onClick={back} disabled={busy}>Back</button></p>
      </div>
    )}

    {step === 2 && (
      <div className="card">
        <h3>2. Server</h3>
        {field('hostname', 'Display name (e.g. homeserver)')}
        {field('timezone', 'Timezone (e.g. Europe/Berlin)')}
        <p><label>Theme<br /><select value={s.theme || localStorage.getItem('pipulse-theme') || 'dark'} onChange={(e) => setS({ ...s, theme: e.target.value })}>
          <option value="dark">dark</option><option value="light">light</option><option value="system">system</option>
        </select></label></p>
        {field('monitor_interval', 'Poll interval (ms, e.g. 5000)')}
        {field('retention_days', 'Keep history (days)')}
        <p><button onClick={saveServer} disabled={busy}>Save & continue</button>{' '}<button onClick={back} disabled={busy}>Back</button></p>
      </div>
    )}

    {step === 3 && (
      <div className="card">
        <h3>3. Thresholds</h3>
        <p className="small muted">PiPulse warns from these values up (warning / critical). Defaults fit a Pi — only change them if you want it quieter or stricter.</p>
        {THRESHOLDS.map(([k, l]) => field(k, l))}
        <p><button onClick={saveThresholds} disabled={busy}>Save & continue</button>{' '}<button onClick={back} disabled={busy}>Back</button></p>
      </div>
    )}

    {step === 4 && (
      <div className="card">
        <h3>4. Notifications</h3>
        <p className="small muted">How you hear about problems — e.g. when an HDD/SSD reports SMART errors. All optional, all changeable later in Settings.</p>
        <p>Notify on:{' '}
          {ALL_EVENTS.map((e) => (
            <label key={e} style={{ display: 'inline-block', marginRight: 12, fontWeight: 400 }}>
              <input type="checkbox" checked={n.events.includes(e)} onChange={() => toggleEvent(e)} /> {e}
            </label>
          ))}
        </p>
        <h3>Webhook</h3>
        {nfield('webhook_url', 'Webhook URL (POST as JSON)', 'https://…')}
        <h3>Telegram</h3>
        <p className="small muted">Create a bot via <code>@BotFather</code> with <code>/newbot</code>, message your bot once, get the chat ID via <code>@userinfobot</code>.</p>
        {nfield('telegram_bot_token', `Bot token${n.telegram_bot_token_set ? ' (saved — leave empty to keep)' : ''}`, '123456789:AA…', 'password')}
        {nfield('telegram_chat_id', 'Chat ID (number, -100… for groups, or @channel)', '123456789')}
        <h3>Email (SMTP)</h3>
        {nfield('smtp_host', 'SMTP server', 'mail.example.com')}
        {nfield('smtp_port', 'Port', '587')}
        <p><label>TLS<br /><select value={n.smtp_tls} onChange={(e) => setN({ ...n, smtp_tls: e.target.value })}>
          <option value="auto">auto</option><option value="direct">direct (port 465)</option><option value="off">off (local relay)</option>
        </select></label></p>
        {nfield('smtp_user', 'Username')}
        {nfield('smtp_pass', `Password${n.smtp_pass_set ? ' (saved — leave empty to keep)' : ''}`, '', 'password')}
        {nfield('smtp_from', 'From', 'pipulse@example.com')}
        {nfield('smtp_to', 'To', 'me@example.com')}
        <p>
          <button onClick={saveNotify} disabled={busy}>Save & continue</button>{' '}
          <button onClick={back} disabled={busy}>Back</button>
        </p>
        <p className="small muted">Save first, then test:</p>
        <p>
          <button onClick={() => testNotify('webhook')} disabled={busy}>Test webhook</button>{' '}
          <button onClick={() => testNotify('telegram')} disabled={busy}>Test Telegram</button>{' '}
          <button onClick={() => testNotify('email')} disabled={busy}>Test email</button>
        </p>
      </div>
    )}

    {step === 5 && (
      <div className="card">
        <h3>5. System check</h3>
        {!check.health ? <p className="muted">Checking…</p> : (
          <table><tbody>
            <tr><td>Backend / database</td><td>{check.health.backend === 'ok' && check.health.database === 'ok' ? '🟢 ok' : `🔴 ${check.health.backend}/${check.health.database}`}</td></tr>
            <tr><td>Agent</td><td>{check.health.agent === 'connected' ? '🟢 connected' : check.health.agent === 'demo' ? '🟡 demo mode' : '🔴 offline — check the agent on the host (systemd, token)'}</td></tr>
            <tr><td>Docker</td><td>{check.health.docker === 'available' ? '🟢 available' : '🟡 unavailable — check socket permissions (docs, group_add)'}</td></tr>
            <tr><td>SMART</td><td>{check.smartTool === null ? '…' : check.smartTool === 'ok' ? '🟢 smartctl reads drives' : check.smartTool === 'missing' ? '🟡 smartmontools missing — `sudo apt install smartmontools`' : '🟡 access denied — see docs/smart.md'}</td></tr>
            {check.nodes && <tr><td>Servers</td><td>{check.nodes.map((x) => `${x.connected ? '🟢' : '🔴'} ${x.hostname}`).join(' · ') || '—'}</td></tr>}
          </tbody></table>
        )}
        <p><button onClick={next} disabled={busy}>Continue</button>{' '}<button onClick={back} disabled={busy}>Back</button></p>
      </div>
    )}

    {step === 6 && (
      <div className="card">
        <h3>🎉 Done!</h3>
        <p>PiPulse is set up. Everything can be changed later: server & thresholds under <b>Settings</b>, notifications there too, the password as well. You can reopen this setup anytime via <b>Setup</b> in the navigation or with <b>Ctrl+K</b>.</p>
        <p><button onClick={() => finish(true)} disabled={busy}>Go to dashboard</button>{' '}<button onClick={back} disabled={busy}>Back</button></p>
      </div>
    )}
  </>);
}
