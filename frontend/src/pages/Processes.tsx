import { useState } from 'react';
import type { WsPayload } from '../shared/types.js';
import { fmtBytes, fmtPct, fmtUptime } from '../lib/format.js';

export function Processes({ data }: { data: WsPayload | null }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'cpu' | 'ram' | 'pid' | 'name'>('cpu');
  if (!data) return <p className="muted">Waiting for live data…</p>;
  const rows = [...data.processes]
    .filter((p) => (p.name + p.pid).toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => sort === 'cpu' ? (b.cpuPct || 0) - (a.cpuPct || 0) : sort === 'ram' ? (b.memPct || 0) - (a.memPct || 0) : sort === 'pid' ? a.pid - b.pid : a.name.localeCompare(b.name));
  return (<>
    <h2>Processes</h2>
    <p><input placeholder="Search processes…" value={q} onChange={(e) => setQ(e.target.value)} />{' '}
      <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
        <option value="cpu">sort: CPU</option><option value="ram">sort: RAM</option><option value="pid">sort: PID</option><option value="name">sort: name</option>
      </select></p>
    <table><thead><tr><th>PID</th><th>Name</th><th>CPU %</th><th>RAM %</th><th>RAM</th><th>User</th><th>Uptime</th></tr></thead><tbody>
      {rows.map((p) => <tr key={p.pid}><td>{p.pid}</td><td>{p.name}</td><td>{fmtPct(p.cpuPct)}</td><td>{fmtPct(p.memPct)}</td><td>{fmtBytes(p.memKb ? p.memKb * 1024 : null)}</td><td>{p.user}</td><td>{fmtUptime(p.uptimeSec)}</td></tr>)}
    </tbody></table>
  </>);
}
