import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { fmtDateTime } from '../lib/format.js';
import { SevPill } from '../components/pills.js';

export function Alerts() {
  const [status, setStatus] = useState('all');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<{ id: number; severity: string; component: string; message: string; status: string; createdAt: string; resolvedAt: string | null }[]>([]);
  const load = async () => {
    const r = await api<typeof rows>(`/api/alerts?status=${status}&q=${encodeURIComponent(q)}`);
    setRows(r);
  };
  useEffect(() => { void load(); const t = setInterval(load, 10000); return () => clearInterval(t); });
  const mutate = async (id: number, op: 'ack' | 'resolve') => {
    await api(`/api/alerts/${id}/${op}`, { method: 'POST' }); void load();
  };
  return (<>
    <h2>Alerts</h2>
    <p>
      <select value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="all">all</option><option value="active">active</option><option value="acknowledged">acknowledged</option><option value="resolved">resolved</option>
      </select>{' '}
      <input placeholder="Search alerts…" value={q} onChange={(e) => setQ(e.target.value)} />{' '}
      <button onClick={load}>Refresh</button>
    </p>
    {rows.length === 0 ? <p className="muted">No active alerts.</p> : (
      <table><thead><tr><th>Severity</th><th>Component</th><th>Alert</th><th>Status</th><th>Time</th><th>Actions</th></tr></thead><tbody>
        {rows.map((a) => <tr key={a.id}><td><SevPill severity={a.severity} /></td><td>{a.component}</td><td>{a.message}</td><td>{a.status}</td><td className="small">{fmtDateTime(a.createdAt)}</td><td className="small"><button onClick={() => mutate(a.id, 'ack')}>Ack</button>{' '}<button onClick={() => mutate(a.id, 'resolve')}>Resolve</button></td></tr>)}
      </tbody></table>
    )}
  </>);
}
