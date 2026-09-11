import { useState } from 'react';
import type { WsPayload } from '../shared/types.js';
import { fmtBytes, fmtPct, fmtTemp, fmtUptime, fmtDateTime } from '../lib/format.js';

export function System({ data }: { data: WsPayload | null }) {
  const [tab, setTab] = useState<'overview' | 'cpu' | 'memory'>('overview');
  if (!data) return <p className="muted">Waiting for live data…</p>;
  return (
    <>
      <h2>System</h2>
      <p>
        {(['overview', 'cpu', 'memory'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} style={{ marginRight: 6, fontWeight: tab === t ? 700 : 400 }}>{t}</button>
        ))}
      </p>
      {tab === 'overview' && (
        <div className="grid">
          <div className="card"><h3>Hostname</h3><div className="big" style={{ fontSize: 18 }}>{data.agent.hostname || localStorage.getItem('pipulse-hostname') || '—'}</div><div className="small muted">agent {data.agent.version || '—'} · {data.agent.connected ? 'connected' : `disconnected${data.agent.lastSeen ? ` (last seen ${fmtDateTime(data.agent.lastSeen)})` : ''}`}</div></div>
          <div className="card"><h3>Uptime</h3><div className="big" style={{ fontSize: 18 }}>{fmtUptime(data.uptimeSec)}</div><div className="small muted">boot {data.bootTime ? fmtDateTime(data.bootTime) : 'Unavailable'}</div></div>
          <div className="card"><h3>Load average</h3><div className="big" style={{ fontSize: 18 }}>{data.cpu.load1 ?? '—'} / {data.cpu.load5 ?? '—'} / {data.cpu.load15 ?? '—'}</div><div className="small muted">1m / 5m / 15m</div></div>
        </div>
      )}
      {tab === 'cpu' && (
        <>
          <div className="grid">
            <div className="card"><h3>Overall CPU usage</h3><div className="big">{fmtPct(data.cpu.usage)}</div></div>
            <div className="card"><h3>Temperature</h3><div className="big">{fmtTemp(data.cpu.tempC)}</div></div>
            <div className="card"><h3>Frequency</h3><div className="big">{data.cpu.freqMhz ? `${data.cpu.freqMhz} MHz` : 'Unavailable'}</div></div>
            <div className="card"><h3>Processes</h3><div className="big">{data.cpu.processCount ?? 'Unavailable'}</div></div>
          </div>
          <h3>Per-core usage</h3>
          <table><thead><tr><th>Core</th><th>Usage</th></tr></thead>
            <tbody>{data.cpu.perCore.map((v, i) => <tr key={i}><td>cpu{i}</td><td>{fmtPct(v)}</td></tr>)}</tbody></table>
        </>
      )}
      {tab === 'memory' && (
        <>
          <div className="grid">
            <div className="card"><h3>RAM used</h3><div className="big">{fmtBytes(data.mem.usedKb ? data.mem.usedKb * 1024 : null)}</div><div className="small muted">{fmtPct(data.mem.usedPct)} of {fmtBytes(data.mem.totalKb ? data.mem.totalKb * 1024 : null)}</div></div>
            <div className="card"><h3>Available</h3><div className="big">{fmtBytes(data.mem.availableKb ? data.mem.availableKb * 1024 : null)}</div></div>
            <div className="card"><h3>Cached / buffers</h3><div className="big" style={{ fontSize: 18 }}>{fmtBytes(data.mem.cachedKb ? data.mem.cachedKb * 1024 : null)} / {fmtBytes(data.mem.buffersKb ? data.mem.buffersKb * 1024 : null)}</div></div>
            <div className="card"><h3>Swap</h3><div className="big">{fmtBytes(data.mem.swapUsedKb ? data.mem.swapUsedKb * 1024 : null)}</div><div className="small muted">of {fmtBytes(data.mem.swapTotalKb ? data.mem.swapTotalKb * 1024 : null)}</div></div>
          </div>
          <h3>Top RAM processes</h3>
          <table><thead><tr><th>Process</th><th>RAM %</th><th>RAM</th></tr></thead><tbody>
            {[...data.processes].sort((a, b) => (b.memPct || 0) - (a.memPct || 0)).slice(0, 10).map((p) => (
              <tr key={p.pid}><td>{p.name} ({p.pid})</td><td>{fmtPct(p.memPct)}</td><td>{fmtBytes(p.memKb ? p.memKb * 1024 : null)}</td></tr>
            ))}
          </tbody></table>
        </>
      )}
    </>
  );
}
