import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

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
    <h3>System</h3>
    {!health ? <p className="muted">Loading…</p> : <pre className="small">{JSON.stringify(health, null, 2)}</pre>}
  </>);
}
