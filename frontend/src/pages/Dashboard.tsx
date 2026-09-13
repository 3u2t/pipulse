import { useEffect, useRef, useState } from 'react';
import type { HistResponse, NodeInfo, SmartDrive, WsPayload } from '../shared/types.js';
import { fmtBytes, fmtTemp, fmtUptime, fmtBps, fmtDateTime, fmtDuration } from '../lib/format.js';
import { Chart } from '../components/Chart.js';
import { LiveChart } from '../components/LiveChart.js';
import { SevPill } from '../components/pills.js';
import { api } from '../lib/api.js';

const RANGES = [['1m', 1 / 60], ['5m', 5 / 60], ['30m', 0.5], ['1h', 1], ['6h', 6], ['24h', 24], ['7d', 168]] as const;

function statusOf(d: WsPayload | null): { cls: string; dot: string; text: string; reason: string | null } {
  if (!d) return { cls: '', dot: '⚪', text: 'Offline', reason: 'No data from backend yet.' };
  const crit = d.alerts.filter((a) => a.severity === 'critical');
  const warn = d.alerts.filter((a) => a.severity === 'warning');
  if (crit.length) return { cls: 'crit', dot: '🔴', text: 'Critical', reason: crit[0].message };
  if (warn.length) return { cls: 'warn', dot: '🟡', text: 'Warning', reason: warn[0].message };
  return { cls: 'ok', dot: '🟢', text: 'All systems operational', reason: null };
}

// Small usage ring. Color follows the same 80/90 alert bands as the backend.
function Ring({ pct, size = 52 }: { pct: number | null; size?: number }) {
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const v = pct === null || !Number.isFinite(pct) ? null : Math.min(100, Math.max(0, pct));
  const color = v === null ? 'var(--faint)' : v >= 90 ? 'var(--crit)' : v >= 80 ? 'var(--warn)' : 'var(--accent)';
  return (
    <svg className="ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth="4" />
      {v !== null && (
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth="4"
          strokeLinecap="round" strokeDasharray={`${(v / 100) * c} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      )}
    </svg>
  );
}

function StatRing({ title, pct, sub }: { title: string; pct: number | null; sub: string }) {
  return (
    <div className="card stat">
      <h3>{title}</h3>
      <div className="stat-row">
        <Ring pct={pct} />
        <div><div className="big">{pct === null ? 'Unavailable' : `${pct.toFixed(1)}%`}</div><div className="small muted">{sub}</div></div>
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="grid">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div className="card" key={i}><div className="sk sk-title" /><div className="sk sk-big" /><div className="sk sk-sub" /></div>
      ))}
    </div>
  );
}

function nodeStatus(n: NodeInfo, alerts: WsPayload['alerts']): { cls: string; dot: string; text: string; reason: string | null } {
  if (!n.connected) return { cls: 'crit', dot: '🔴', text: 'Offline', reason: `No data from ${n.hostname} — agent disconnected or host down.` };
  const mine = alerts.filter((a) => a.key.startsWith(`node:${n.id}:`) || a.key === `agent:${n.id}`);
  const crit = mine.find((a) => a.severity === 'critical');
  const warn = mine.find((a) => a.severity === 'warning');
  if (crit) return { cls: 'crit', dot: '🔴', text: 'Critical', reason: crit.message };
  if (warn) return { cls: 'warn', dot: '🟡', text: 'Warning', reason: warn.message };
  return { cls: 'ok', dot: '🟢', text: 'All systems operational', reason: null };
}

export function Dashboard({ data }: { data: WsPayload | null }) {
  const [range, setRange] = useState<number>(1);
  const [hist, setHist] = useState<HistResponse | null>(null);
  const [nodeId, setNodeId] = useState('local');
  const [drives, setDrives] = useState<SmartDrive[]>([]);
  const s = statusOf(data);

  // Rolling window fed by the live socket stream (last ~5 minutes at 5s ticks).
  const [live, setLive] = useState<{ t: number[]; cpu: number[]; temp: number[]; mem: number[]; rx: number[] }>(
    { t: [], cpu: [], temp: [], mem: [], rx: [] });
  const lastTs = useRef<string | null>(null);
  useEffect(() => {
    if (!data || data.ts === lastTs.current) return;
    lastTs.current = data.ts;
    setLive((p) => {
      const t = [...p.t, Date.now() / 1000].slice(-60);
      const push = (a: number[], v: number | null) => [...a, v ?? NaN].slice(-60);
      return {
        t,
        cpu: push(p.cpu, data.cpu.usage),
        temp: push(p.temp, data.cpu.tempC),
        mem: push(p.mem, data.mem.usedPct),
        rx: push(p.rx, data.net[0]?.rxBps ?? null),
      };
    });
  }, [data]);

  useEffect(() => {
    api<HistResponse>(`/api/history?kind=host&hours=${range}`).then(setHist).catch(() => setHist(null));
  }, [range]);

  useEffect(() => {
    if (nodeId === 'local' || !data) return;
    api<{ smart: { drives: SmartDrive[] } }>(`/api/storage`).then((r) => setDrives(r.smart?.drives || [])).catch(() => setDrives([]));
  }, [nodeId, data?.ts]);

  const aligned = (pick: (r: HistResponse['points'][number]) => number | null): number[][] => {
    const pts = hist?.points || [];
    return [[...pts.map((r) => r.ts / 1000)], [...pts.map((r) => pick(r) as number)]];
  };

  const nodes = data?.nodes || [];
  const node = nodeId === 'local' ? null : nodes.find((n) => n.id === nodeId) || null;
  const histLen = hist?.points.length || 0;

  return (
    <>
      <h2>Server status</h2>
      {nodes.length > 0 && (
        <p>
          <button onClick={() => setNodeId('local')} style={{ marginRight: 6, fontWeight: nodeId === 'local' ? 700 : 400 }}>This server</button>
          {nodes.map((n) => (
            <button key={n.id} onClick={() => setNodeId(n.id)} style={{ marginRight: 6, fontWeight: nodeId === n.id ? 700 : 400 }} title={n.connected ? `${n.hostname} · agent ${n.version || '?'}` : `${n.hostname} · offline`}>
              {n.connected ? '🟢' : '⚪'} {n.hostname}
            </button>
          ))}
        </p>
      )}
      {!data ? <Skeleton /> : node ? <RemoteNode node={node} alerts={data.alerts} drives={drives.filter((d) => d.nodeId === node.id)} /> : (<>
        <div className={`banner ${s.cls}`}><strong>{s.dot} {s.text}</strong>{s.reason && <div className="small">{s.reason}</div>}</div>
        <div className="grid">
          <StatRing title="CPU usage" pct={data.cpu.usage} sub={`load ${data.cpu.load1 ?? '—'} · ${data.cpu.freqMhz ? `${data.cpu.freqMhz} MHz` : 'freq —'}`} />
          <div className="card"><h3>CPU temperature</h3><div className="big">{fmtTemp(data.cpu.tempC)}</div><div className="small muted">{data.cpu.tempC === null ? 'no sensor reading' : 'SoC sensor · live'}</div></div>
          <StatRing title="Memory" pct={data.mem.usedPct} sub={`${fmtBytes(data.mem.usedKb ? data.mem.usedKb * 1024 : null)} of ${fmtBytes(data.mem.totalKb ? data.mem.totalKb * 1024 : null)}`} />
          <StatRing title="Disk space" pct={data.filesystems[0]?.usedPct ?? null} sub={`${data.filesystems[0]?.mount || ''} · ${fmtBytes(data.filesystems[0]?.freeBytes ?? null)} free`} />
          <div className="card"><h3>Network</h3><div className="big">{fmtBps(data.net[0]?.rxBps ?? null)}</div><div className="small muted">↓ down · ↑ {fmtBps(data.net[0]?.txBps ?? null)}</div></div>
          <div className="card"><h3>Uptime</h3><div className="big">{fmtUptime(data.uptimeSec)}</div><div className="small muted">boot {fmtDateTime(data.bootTime)}</div></div>
          <div className="card"><h3>Running containers</h3><div className="big">{data.docker.available ? data.docker.running : 'Unavailable'}</div><div className="small muted">{data.docker.available ? `${data.docker.containers.length} total` : 'Docker is not available on this host.'}</div></div>
        </div>
        <h3 style={{ marginTop: 18 }}>Live</h3>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(340px,1fr))' }}>
          <LiveChart title="CPU usage" unit="%" times={live.t} values={live.cpu} />
          <LiveChart title="CPU temperature" unit="°C" color="#d29922" times={live.t} values={live.temp} />
          <LiveChart title="RAM usage" unit="%" color="#a371f7" times={live.t} values={live.mem} />
          <LiveChart title="Network download" unit="bps" color="#3fb950" times={live.t} values={live.rx} />
        </div>
        <h3 style={{ marginTop: 18 }}>History&nbsp;
          <select value={range} onChange={(e) => setRange(Number(e.target.value))}>
            {RANGES.map(([l, h]) => <option key={l} value={h}>{l}</option>)}
          </select>
        </h3>
        {!hist || hist.points.length === 0 ? <p className="muted">Not enough data yet.</p> : (<>
          <p className="small muted">{hist.total} samples → {hist.points.length} points, averaged per {fmtDuration(hist.bucketSec)}.</p>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(340px,1fr))' }}>
            <Chart key={`cpu-${range}-${histLen}`} title="CPU usage" series={aligned((r) => r.cpu)} labels={['cpu %']} unit="%" />
            <Chart key={`temp-${range}-${histLen}`} title="CPU temperature" series={aligned((r) => r.tempC)} labels={['°C']} unit="°C" />
            <Chart key={`ram-${range}-${histLen}`} title="RAM usage" series={aligned((r) => r.memPct)} labels={['ram %']} unit="%" />
            <Chart key={`rx-${range}-${histLen}`} title="Network download" series={aligned((r) => r.rxBps)} labels={['rx bps']} unit="bps" />
          </div>
        </>)}
        <h3 style={{ marginTop: 18 }}>Recent alerts</h3>
        {data.alerts.length === 0 ? <p className="muted">No active alerts.</p> : (
          <table><tbody>{data.alerts.slice(0, 5).map((a) => <tr key={a.id}><td><SevPill severity={a.severity} /></td><td>{a.component}</td><td>{a.message}</td></tr>)}</tbody></table>
        )}
      </>)}
    </>
  );
}

// A remote node only reports host metrics through its agent — no Docker,
// services or processes. Say so instead of showing local data as its own.
function RemoteNode({ node, alerts, drives }: { node: NodeInfo; alerts: WsPayload['alerts']; drives: SmartDrive[] }) {
  const s = nodeStatus(node, alerts);
  return (<>
    <div className={`banner ${s.cls}`}><strong>{s.dot} {node.hostname} — {s.text}</strong>{s.reason && <div className="small">{s.reason}</div>}</div>
    {node.connected && (
      <div className="grid">
        <StatRing title="CPU usage" pct={node.cpuUsage} sub={node.arch || 'agent metrics'} />
        <StatRing title="Memory" pct={node.memPct} sub={node.version ? `agent ${node.version}` : 'agent metrics'} />
        <div className="card"><h3>Temperature</h3><div className="big">{fmtTemp(node.tempC)}</div><div className="small muted">CPU sensor</div></div>
        <div className="card"><h3>Uptime</h3><div className="big">{fmtUptime(node.uptimeSec)}</div><div className="small muted">agent {node.version || '?'}</div></div>
      </div>
    )}
    {drives.length > 0 && (<>
      <h3 style={{ marginTop: 18 }}>Drives on {node.hostname}</h3>
      <table><tbody>{drives.map((d) => (
        <tr key={d.device}><td>{d.model || d.device}</td><td className="small muted">{d.device}</td>
          <td>{d.overall === 'healthy' ? '🟢' : d.overall === 'warning' ? '🟡' : d.overall === 'critical' ? '🔴' : '⚪'} {d.overall}</td>
          <td className="small muted">{fmtTemp(d.tempC)}</td></tr>
      ))}</tbody></table>
    </>)}
    <p className="small muted" style={{ marginTop: 14 }}>Docker, services, processes and logs below are this server's — remote nodes report host metrics only.</p>
  </>);
}
