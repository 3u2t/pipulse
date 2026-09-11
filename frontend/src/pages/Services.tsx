import { useState } from 'react';
import type { WsPayload } from '../shared/types.js';
import { api } from '../lib/api.js';

export function Services({ data }: { data: WsPayload | null }) {
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState('');
  if (!data) return <p className="muted">Waiting for live data…</p>;
  const rows = data.services.filter((s) => s.name.includes(q));
  const act = async (name: string, a: string) => {
    if ((a === 'stop' || a === 'restart') && !confirm(`${a} service "${name}"?`)) return;
    await api(`/api/services/${name}/${a}`, { method: 'POST' });
    setMsg(`${a} sent to ${name}.`); setTimeout(() => setMsg(''), 3000);
  };
  return (<>
    <h2>Services</h2>
    {msg && <p>{msg}</p>}
    <p><input placeholder="Filter services…" value={q} onChange={(e) => setQ(e.target.value)} /></p>
    {rows.length === 0 ? <p className="muted">No services found.</p> : (
      <table><thead><tr><th>Name</th><th>Status</th><th>Enabled</th><th>Description</th><th>Actions</th></tr></thead><tbody>
        {rows.map((s) => (
          <tr key={s.name}><td>{s.name}</td>
            <td>{s.active === 'active' ? '🟢' : s.active === 'failed' ? '🔴' : '⚪'} {s.active}</td>
            <td>{s.enabled}</td><td className="muted">{s.description}</td>
            <td className="small"><button onClick={() => act(s.name, 'start')}>Start</button>{' '}<button onClick={() => act(s.name, 'stop')}>Stop</button>{' '}<button onClick={() => act(s.name, 'restart')}>Restart</button></td></tr>
        ))}
      </tbody></table>
    )}
  </>);
}
