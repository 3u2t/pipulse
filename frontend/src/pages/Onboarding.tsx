import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';

const STEPS = ['Willkommen', 'Passwort', 'Server', 'Schwellen', 'Benachrichtigungen', 'System-Check', 'Fertig'];
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
  ['th_cpu_warn', 'CPU Warnung %'], ['th_cpu_crit', 'CPU Kritisch %'],
  ['th_temp_warn', 'Temperatur Warnung °C'], ['th_temp_crit', 'Temperatur Kritisch °C'],
  ['th_mem_warn', 'RAM Warnung %'], ['th_mem_crit', 'RAM Kritisch %'],
  ['th_disk_warn', 'Speicher Warnung %'], ['th_disk_crit', 'Speicher Kritisch %'],
  ['th_drive_temp_warn', 'Festplatten-Temp Warnung °C'], ['th_drive_temp_crit', 'Festplatten-Temp Kritisch °C'],
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
    try { await fn(); next(); } catch (e) { say(`Fehler: ${(e as Error).message}`); } finally { setBusy(false); }
  };

  const savePassword = () => run(async () => {
    if (pw1.length < 8) throw new Error('Passwort muss mindestens 8 Zeichen haben.');
    if (pw1 !== pw2) throw new Error('Passwörter stimmen nicht überein.');
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
      say(`Test über ${channel} gesendet — angekommen? Dann stimmt die Konfiguration.`);
    } catch (e) { say(`Test fehlgeschlagen: ${(e as Error).message}`); } finally { setBusy(false); }
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
    <h2>Einrichtung</h2>
    <div className="steps">
      {STEPS.map((l, i) => (
        <span key={l} className={`step${i === step ? ' step-now' : ''}${i < step ? ' step-done' : ''}`} onClick={() => setStep(i)} title={l}>{i + 1}</span>
      ))}
      <span className="small muted" style={{ marginLeft: 8 }}>{STEPS[step]}</span>
    </div>
    {msg && <p>{msg}</p>}

    {step === 0 && (
      <div className="card">
        <h3>Willkommen bei PiPulse 👋</h3>
        <p>In ein paar Schritten richten wir alles ein:</p>
        <ol>
          <li><b>Passwort</b> — das Standard-Passwort ändern.</li>
          <li><b>Server</b> — Name, Zeitzone, Intervall.</li>
          <li><b>Schwellen</b> — ab wann gewarnt wird.</li>
          <li><b>Benachrichtigungen</b> — Webhook, Telegram, E-Mail (damit Probleme bei HDD/SSD sofort ankommen).</li>
          <li><b>System-Check</b> — Agent, SMART und Docker prüfen.</li>
        </ol>
        <p>
          <button onClick={next} disabled={busy}>Los geht's</button>{' '}
          <button onClick={() => finish(true)} disabled={busy}>Überspringen — ich kenne mich aus</button>
        </p>
      </div>
    )}

    {step === 1 && (
      <div className="card">
        <h3>1. Passwort ändern</h3>
        <p className="small muted">Der erste Benutzer (<code>admin</code>) hat ein generiertes Start-Passwort aus den Docker-Logs. Lege hier ein eigenes fest (min. 8 Zeichen).</p>
        <p><label>Neues Passwort<br /><input type="password" value={pw1} onChange={(e) => setPw1(e.target.value)} /></label></p>
        <p><label>Wiederholen<br /><input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></label></p>
        <p><button onClick={savePassword} disabled={busy}>Speichern & weiter</button>{' '}<button onClick={next} disabled={busy}>Später</button>{' '}<button onClick={back} disabled={busy}>Zurück</button></p>
      </div>
    )}

    {step === 2 && (
      <div className="card">
        <h3>2. Server</h3>
        {field('hostname', 'Anzeigename (z. B. tompi)')}
        {field('timezone', 'Zeitzone (z. B. Europe/Berlin)')}
        <p><label>Darstellung<br /><select value={s.theme || localStorage.getItem('pipulse-theme') || 'dark'} onChange={(e) => setS({ ...s, theme: e.target.value })}>
          <option value="dark">dark</option><option value="light">light</option><option value="system">system</option>
        </select></label></p>
        {field('monitor_interval', 'Abfrage-Intervall (ms, z. B. 5000)')}
        {field('retention_days', 'Verlauf speichern (Tage)')}
        <p><button onClick={saveServer} disabled={busy}>Speichern & weiter</button>{' '}<button onClick={back} disabled={busy}>Zurück</button></p>
      </div>
    )}

    {step === 3 && (
      <div className="card">
        <h3>3. Schwellen</h3>
        <p className="small muted">Ab diesen Werten warnt PiPulse (Warnung / kritisch). Standardwerte passen für einen Pi — nur ändern, wenn du es ruhiger oder strenger willst.</p>
        {THRESHOLDS.map(([k, l]) => field(k, l))}
        <p><button onClick={saveThresholds} disabled={busy}>Speichern & weiter</button>{' '}<button onClick={back} disabled={busy}>Zurück</button></p>
      </div>
    )}

    {step === 4 && (
      <div className="card">
        <h3>4. Benachrichtigungen</h3>
        <p className="small muted">So erfährst du von Problemen — z. B. wenn eine HDD/SSD SMART-Fehler meldet. Alles optional, alles auch später in den Settings änderbar.</p>
        <p>Melden bei:{' '}
          {ALL_EVENTS.map((e) => (
            <label key={e} style={{ display: 'inline-block', marginRight: 12, fontWeight: 400 }}>
              <input type="checkbox" checked={n.events.includes(e)} onChange={() => toggleEvent(e)} /> {e}
            </label>
          ))}
        </p>
        <h3>Webhook</h3>
        {nfield('webhook_url', 'Webhook-URL (POST als JSON)', 'https://…')}
        <h3>Telegram</h3>
        <p className="small muted">Bot via <code>@BotFather</code> mit <code>/newbot</code> erstellen, dem Bot einmal schreiben, Chat-ID via <code>@userinfobot</code> holen.</p>
        {nfield('telegram_bot_token', `Bot-Token${n.telegram_bot_token_set ? ' (gespeichert — leer lassen zum Behalten)' : ''}`, '123456789:AA…', 'password')}
        {nfield('telegram_chat_id', 'Chat-ID (Zahl, -100… für Gruppen, oder @Kanal)', '123456789')}
        <h3>E-Mail (SMTP)</h3>
        {nfield('smtp_host', 'SMTP-Server', 'mail.example.com')}
        {nfield('smtp_port', 'Port', '587')}
        <p><label>TLS<br /><select value={n.smtp_tls} onChange={(e) => setN({ ...n, smtp_tls: e.target.value })}>
          <option value="auto">auto</option><option value="direct">direct (Port 465)</option><option value="off">off (lokales Relay)</option>
        </select></label></p>
        {nfield('smtp_user', 'Benutzername')}
        {nfield('smtp_pass', `Passwort${n.smtp_pass_set ? ' (gespeichert — leer lassen zum Behalten)' : ''}`, '', 'password')}
        {nfield('smtp_from', 'Absender', 'pipulse@example.com')}
        {nfield('smtp_to', 'Empfänger', 'ich@example.com')}
        <p>
          <button onClick={saveNotify} disabled={busy}>Speichern & weiter</button>{' '}
          <button onClick={back} disabled={busy}>Zurück</button>
        </p>
        <p className="small muted">Erst speichern, dann testen:</p>
        <p>
          <button onClick={() => testNotify('webhook')} disabled={busy}>Test-Webhook</button>{' '}
          <button onClick={() => testNotify('telegram')} disabled={busy}>Test-Telegram</button>{' '}
          <button onClick={() => testNotify('email')} disabled={busy}>Test-E-Mail</button>
        </p>
      </div>
    )}

    {step === 5 && (
      <div className="card">
        <h3>5. System-Check</h3>
        {!check.health ? <p className="muted">Prüfe…</p> : (
          <table><tbody>
            <tr><td>Backend / Datenbank</td><td>{check.health.backend === 'ok' && check.health.database === 'ok' ? '🟢 ok' : `🔴 ${check.health.backend}/${check.health.database}`}</td></tr>
            <tr><td>Agent</td><td>{check.health.agent === 'connected' ? '🟢 verbunden' : check.health.agent === 'demo' ? '🟡 Demo-Modus' : '🔴 offline — Agent auf dem Host prüfen (systemd, Token)'}</td></tr>
            <tr><td>Docker</td><td>{check.health.docker === 'available' ? '🟢 verfügbar' : '🟡 nicht verfügbar — Socket-Rechte prüfen (docs, group_add)'}</td></tr>
            <tr><td>SMART</td><td>{check.smartTool === null ? '…' : check.smartTool === 'ok' ? '🟢 smartctl liest Laufwerke' : check.smartTool === 'missing' ? '🟡 smartmontools fehlt — `sudo apt install smartmontools`' : '🟡 Zugriff verweigert — siehe docs/smart.md'}</td></tr>
            {check.nodes && <tr><td>Server</td><td>{check.nodes.map((x) => `${x.connected ? '🟢' : '🔴'} ${x.hostname}`).join(' · ') || '—'}</td></tr>}
          </tbody></table>
        )}
        <p><button onClick={next} disabled={busy}>Weiter</button>{' '}<button onClick={back} disabled={busy}>Zurück</button></p>
      </div>
    )}

    {step === 6 && (
      <div className="card">
        <h3>🎉 Fertig!</h3>
        <p>PiPulse ist eingerichtet. Alle Angaben lassen sich später ändern: Server & Schwellen unter <b>Settings</b>, Benachrichtigungen ebenfalls dort, das Passwort auch. Dieses Setup erreichst du jederzeit über <b>Setup</b> in der Navigation oder mit <b>Strg+K</b>.</p>
        <p><button onClick={() => finish(true)} disabled={busy}>Zum Dashboard</button>{' '}<button onClick={back} disabled={busy}>Zurück</button></p>
      </div>
    )}
  </>);
}
