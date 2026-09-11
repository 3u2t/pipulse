import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ContainerSummary, HistResponse } from '../shared/types.js';
import { fmtBytes, fmtPct, fmtBps, fmtUptime, stateDot } from '../lib/format.js';
import { Chart } from '../components/Chart.js';
import { StatePill } from '../components/pills.js';
import { api } from '../lib/api.js';

type SortKey = 'name' | 'cpu' | 'ram' | 'net' | 'restarts' | 'status';

export function Docker({ data }: { data: { available: boolean; running: number; stopped: number; containers: ContainerSummary[] } | null }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('cpu');
  const [msg, setMsg] = useState('');

  if (!data) return <p className="muted">Waiting for live data…</p>;
  if (!data.available) return (<><h2>Docker</h2><p className="muted">Docker is not available on this host. Mount <code>/var/run/docker.sock</code> read-only into the PiPulse container to enable monitoring.</p></>);

  const act = async (c: ContainerSummary, a: 'start' | 'stop' | 'restart') => {
    if ((a === 'stop' || a === 'restart') && !confirm(`${a} container "${c.name}"? This interrupts its service.`)) return;
    await api(`/api/docker/containers/${c.id}/${a}`, { method: 'POST' });
    setMsg(`${a} sent to ${c.name}.`);
    setTimeout(() => setMsg(''), 3000);
  };

  const rows = useMemo(() => {
    const f = data.containers.filter((c) => (c.name + c.image + c.status).toLowerCase().includes(q.toLowerCase()));
    const val = (c: ContainerSummary): number | string => {
      switch (sort) {
        case 'cpu': return c.cpuPct ?? -1;
        case 'ram': return c.memPct ?? -1;
        case 'net': return (c.netRxBps || 0) + (c.netTxBps || 0);
        case 'restarts': return c.restartCount;
        case 'status': return c.state;
        default: return c.name;
      }
    };
    return [...f].sort((a, b) => (val(a) > val(b) ? -1 : 1));
  }, [data, q, sort]);

  return (
    <>
      <h2>Docker</h2>
      <p className="muted">{data.running} running · {data.stopped} stopped · {data.containers.length} total</p>
      {msg && <p>{msg}</p>}
      <p>
        <input placeholder="Filter containers…" value={q} onChange={(e) => setQ(e.target.value)} />{' '}
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          {(['name', 'cpu', 'ram', 'net', 'restarts', 'status'] as const).map((s) => <option key={s} value={s}>sort: {s}</option>)}
        </select>
      </p>
      {rows.length === 0 ? <p className="muted">No Docker containers found.</p> : (
        <div style={{ overflowX: 'auto' }}><table>
          <thead><tr><th>Name</th><th>Image</th><th>Status</th><th>CPU</th><th>RAM</th><th>Net ↓↑</th><th>Restarts</th><th>Flags</th><th>Actions</th></tr></thead>
          <tbody>{rows.map((c) => (
            <tr key={c.id}>
              <td><Link to={`/docker/${c.shortId}`}>{c.name}</Link><div className="small muted">{c.shortId}</div></td>
              <td>{c.image}:{c.imageTag}</td>
              <td><StatePill state={c.state} extra={c.health || undefined} /></td>
              <td>{fmtPct(c.cpuPct)}</td>
              <td>{fmtBytes(c.memBytes)} {c.memPct !== null ? `(${c.memPct.toFixed(0)}%)` : ''}</td>
              <td className="small">{fmtBps(c.netRxBps)} / {fmtBps(c.netTxBps)}</td>
              <td>{c.restartCount}</td>
              <td className="small">{c.anomalies.map((a) => <div key={a.rule} title={a.reason}>⚠ {a.rule}</div>)}{c.miningFlag && <div title={c.miningReason || ''}>⛏ possible mining</div>}</td>
              <td className="small">
                <button onClick={() => act(c, 'start')}>Start</button>{' '}
                <button onClick={() => act(c, 'stop')}>Stop</button>{' '}
                <button onClick={() => act(c, 'restart')}>Restart</button>
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </>
  );
}

export function DockerDetail() {
  const { id = '' } = useParams();
  const [c, setC] = useState<ContainerSummary | null>(null);
  const [hist, setHist] = useState<HistResponse['points']>([]);
  const [histMeta, setHistMeta] = useState<{ total: number; bucketSec: number } | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  useEffect(() => {
    api<ContainerSummary>(`/api/docker/containers/${id}`).then(setC).catch(() => setC(null));
    api<HistResponse>(`/api/docker/containers/${id}/stats?hours=6`).then((r) => { setHist(r.points || []); setHistMeta({ total: r.total, bucketSec: r.bucketSec }); }).catch(() => { setHist([]); setHistMeta(null); });
    api<string[]>(`/api/docker/containers/${id}/logs?tail=100`).then(setLogs).catch(() => setLogs([]));
  }, [id]);

  if (!c) return <><h2>Container</h2><p className="muted">Loading… (Unknown if the ID is wrong.)</p></>;
  const al = (pick: (r: (typeof hist)[number]) => number | null): number[][] => [[...hist.map((r) => r.ts / 1000)], [...hist.map((r) => pick(r) as number)]];

  return (
    <>
      <h2>{stateDot(c.state)} {c.name}</h2>
      <p className="muted">{c.image}:{c.imageTag} · {c.id} · up {fmtUptime(c.uptimeSec)} · restarts {c.restartCount} · policy {c.restartPolicy}</p>
      {c.miningFlag && <div className="banner warn"><strong>⛏ {c.miningReason}</strong></div>}
      {c.anomalies.map((a) => <div className="banner warn" key={a.rule}><strong>⚠ {a.rule}:</strong> {a.reason}</div>)}
      <div className="grid">
        <div className="card"><h3>CPU</h3><div className="big">{fmtPct(c.cpuPct)}</div></div>
        <div className="card"><h3>RAM</h3><div className="big">{fmtBytes(c.memBytes)}</div><div className="small muted">{c.memPct !== null ? `${c.memPct.toFixed(1)}% of ${fmtBytes(c.memLimit)}` : ''}</div></div>
        <div className="card"><h3>Network</h3><div className="big" style={{ fontSize: 16 }}>↓ {fmtBps(c.netRxBps)} ↑ {fmtBps(c.netTxBps)}</div></div>
        <div className="card"><h3>Disk I/O</h3><div className="big" style={{ fontSize: 16 }}>r {fmtBps(c.blkReadBps)} w {fmtBps(c.blkWriteBps)}</div></div>
        <div className="card"><h3>PIDs</h3><div className="big">{c.pids ?? '—'}</div></div>
        <div className="card"><h3>Ports</h3><div className="small">{c.ports.join(', ') || '—'}</div><h3>Volumes</h3><div className="small">{c.mounts.join(', ') || '—'}</div></div>
      </div>
      <h3>History (last 6 hours{histMeta ? ` · ${histMeta.total} samples → ${hist.length} points` : ''})</h3>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(340px,1fr))' }}>
        <Chart key={`cpu-${id}-${hist.length}`} title="CPU" series={al((r) => r.cpu)} labels={['cpu %']} unit="%" />
        <Chart key={`ram-${id}-${hist.length}`} title="RAM" series={al((r) => r.memPct)} labels={['ram %']} unit="%" />
        <Chart key={`net-${id}-${hist.length}`} title="Network" series={[[...hist.map((r) => r.ts / 1000)], [...hist.map((r) => r.rxBps as number)], [...hist.map((r) => r.txBps as number)]]} labels={['rx', 'tx']} unit="bps" />
      </div>
      <h3>Logs</h3>
      <pre className="small" style={{ background: 'var(--panel)', padding: 12, overflow: 'auto', maxHeight: 360 }}>{logs.join('\n') || 'No logs.'}</pre>
    </>
  );
}
