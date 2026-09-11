import { useEffect, useState } from 'react';
import type { HistResponse, NetIface, NetSummary, WsPayload } from '../shared/types.js';
import { fmtBps, fmtBytes, fmtDuration } from '../lib/format.js';
import { Chart } from '../components/Chart.js';
import { api } from '../lib/api.js';

const kindLabel = (k: NetIface['kind']): string =>
  k === 'eth' ? 'Ethernet' : k === 'wifi' ? 'Wi-Fi' : k === 'virtual' ? 'Virtual' : 'Unknown';

export function Network({ data }: { data: WsPayload | null }) {
  const [detail, setDetail] = useState<{ interfaces: NetIface[]; summary: NetSummary } | null>(null);
  const [iface, setIface] = useState<string>('');
  const [hist, setHist] = useState<HistResponse | null>(null);

  useEffect(() => {
    api<{ interfaces: NetIface[]; summary: NetSummary }>(`/api/network`).then(setDetail).catch(() => setDetail(null));
  }, []);

  const ifaces = detail?.interfaces ?? data?.net ?? [];
  const summary = detail?.summary;
  const shown = iface || ifaces[0]?.name || '';

  useEffect(() => {
    if (!shown) return;
    api<HistResponse>(`/api/history?kind=iface&ref=${encodeURIComponent(shown)}&hours=1`).then(setHist).catch(() => setHist(null));
  }, [shown]);

  if (!data) return <p className="muted">Waiting for live data…</p>;
  return (<>
    <h2>Network</h2>
    <div className="grid">
      <div className="card"><h3>Gateway</h3><div className="big" style={{ fontSize: 20 }}>{summary?.gateway || '—'}</div><div className="small muted">default route</div></div>
      <div className="card"><h3>DNS</h3><div className="big" style={{ fontSize: 20 }}>{summary?.dns[0] || '—'}</div><div className="small muted">{summary && summary.dns.length > 1 ? `+ ${summary.dns.length - 1} more` : 'resolvers'}</div></div>
      <div className="card"><h3>TCP connections</h3><div className="big">{summary?.tcpEstablished ?? '—'}</div><div className="small muted">established</div></div>
    </div>
    {ifaces.length === 0 ? <p className="muted">No network interfaces found.</p> : (<>
      <h3 style={{ marginTop: 18 }}>Interfaces</h3>
      <div style={{ overflowX: 'auto' }}><table>
        <thead><tr><th>Interface</th><th>Type</th><th>Status</th><th>MAC</th><th>Link</th><th>RX rate</th><th>TX rate</th><th>Total RX / TX</th><th>Errors</th><th>Dropped</th></tr></thead>
        <tbody>{ifaces.map((n) => (
          <tr key={n.name} onClick={() => setIface(n.name)} style={{ cursor: 'pointer', fontWeight: shown === n.name ? 650 : undefined }} title="Click for history">
            <td>{n.name}</td><td className="small muted">{kindLabel(n.kind)}</td>
            <td>{n.up ? '🟢 up' : '⚪ down'}</td><td className="small">{n.mac || '—'}</td>
            <td>{n.speedMb ? `${n.speedMb} Mb/s` : '—'}</td>
            <td className="small">↓ {fmtBps(n.rxBps)}</td><td className="small">↑ {fmtBps(n.txBps)}</td>
            <td className="small">{fmtBytes(n.rxBytes)} / {fmtBytes(n.txBytes)}</td>
            <td>{(n.rxErrors || 0) + (n.txErrors || 0)}</td><td>{(n.rxDropped || 0) + (n.txDropped || 0)}</td>
          </tr>
        ))}</tbody>
      </table></div>
      <h3 style={{ marginTop: 18 }}>History: {shown}</h3>
      {!hist || hist.points.length === 0 ? <p className="muted">Not enough data yet — per-interface history starts accumulating now.</p> : (<>
        <p className="small muted">{hist.total} samples → {hist.points.length} points, averaged per {fmtDuration(hist.bucketSec)}.</p>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(340px,1fr))' }}>
          <Chart key={`ifrx-${shown}-${hist.points.length}`} title="Download" series={[[...hist.points.map((r) => r.ts / 1000)], [...hist.points.map((r) => r.rxBps as number)]]} labels={['rx bps']} unit="bps" />
          <Chart key={`iftx-${shown}-${hist.points.length}`} title="Upload" series={[[...hist.points.map((r) => r.ts / 1000)], [...hist.points.map((r) => r.txBps as number)]]} labels={['tx bps']} unit="bps" />
        </div>
      </>)}
    </>)}
  </>);
}
