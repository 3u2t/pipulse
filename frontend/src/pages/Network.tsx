import type { WsPayload } from '../shared/types.js';
import { fmtBps } from '../lib/format.js';

export function Network({ data }: { data: WsPayload | null }) {
  if (!data) return <p className="muted">Waiting for live data…</p>;
  return (<>
    <h2>Network</h2>
    {data.net.length === 0 ? <p className="muted">No network interfaces found.</p> : (
      <table><thead><tr><th>Interface</th><th>Status</th><th>MAC</th><th>Link</th><th>RX</th><th>TX</th><th>Errors</th><th>Dropped</th></tr></thead><tbody>
        {data.net.map((n) => <tr key={n.name}><td>{n.name}</td><td>{n.up ? '🟢 up' : '⚪ down'}</td><td className="small">{n.mac || '—'}</td><td>{n.speedMb ? `${n.speedMb} Mb/s` : '—'}</td><td className="small">↓ {fmtBps(n.rxBps)} ({n.rxPackets ?? '—'} pkts)</td><td className="small">↑ {fmtBps(n.txBps)} ({n.txPackets ?? '—'} pkts)</td><td>{(n.rxErrors || 0) + (n.txErrors || 0)}</td><td>{(n.rxDropped || 0) + (n.txDropped || 0)}</td></tr>)}
      </tbody></table>
    )}
  </>);
}
