import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { fmtDateTime } from '../lib/format.js';
import type { SecurityStatus } from '../shared/types.js';

function fwLabel(fw: string): string {
  if (fw === 'ufw' || fw === 'nft' || fw === 'iptables') return `🟢 ${fw} active`;
  if (fw === 'none') return '🟡 no firewall';
  return '⚪ unknown';
}

export function Security() {
  const [rows, setRows] = useState<SecurityStatus[] | null>(null);
  const load = async () => {
    try {
      setRows(await api<SecurityStatus[]>(`/api/security`));
    } catch {
      setRows([]);
    }
  };
  useEffect(() => { void load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);
  if (rows === null) return (<><h2>Security</h2><p className="muted">Loading…</p></>);
  return (<>
    <h2>Security</h2>
    <p className="small muted">
      Read-only: PiPulse never blocks IPs or changes firewall rules — it only reports what the host agent sees.
      Brute-force counts use a 10&nbsp;min window; new logins and ports alert once, then are remembered.
    </p>
    {rows.length === 0 ? (
      <div className="card">
        <h3>No agent data yet</h3>
        <p className="small muted">
          Security signals come from the host agent (needs root to read the SSH log and listening ports).
          Install or update the agent on the host, then check back here. See <code>docs/security.md</code>.
        </p>
      </div>
    ) : rows.map((n) => (
      <div className="card" key={n.nodeId} style={{ marginBottom: 16 }}>
        <h3>{n.hostname} {!n.connected && <span className="small muted">· offline (last known state)</span>}</h3>
        <table><tbody>
          <tr><td>Firewall</td><td>{fwLabel(n.firewall)}{n.firewallDetail ? <span className="small muted"> · {n.firewallDetail}</span> : null}</td></tr>
          <tr><td>Fail2ban</td><td>{n.fail2ban === 'active' ? '🟢 active' : n.fail2ban === 'inactive' ? '🟡 installed, inactive' : '⚪ not installed'}</td></tr>
          <tr><td>Security updates</td><td>{n.secUpdates === null ? '⚪ unknown' : n.secUpdates === 0 ? '🟢 none pending' : `🟡 ${n.secUpdates} pending (\`sudo apt update && sudo apt upgrade\`)`}</td></tr>
          <tr><td>Reboot</td><td>{n.rebootRequired ? '🟡 required for kernel updates' : '🟢 not required'}</td></tr>
          <tr><td>SSH log</td><td>{n.sshLog ? '🟢 readable' : '⚪ unreadable — agent needs root / journal or /var/log/auth.log access'}</td></tr>
        </tbody></table>

        {n.bruteForce.length > 0 && (<>
          <h3>Possible brute force (last 10 min)</h3>
          <table><thead><tr><th>IP</th><th>Failed</th><th>Last</th><th>Users tried</th></tr></thead><tbody>
            {n.bruteForce.map((b) => <tr key={b.ip}><td>{b.ip}</td><td>🔴 {b.failed}</td><td className="small">{fmtDateTime(new Date(b.lastTs * 1000).toISOString())}</td><td className="small muted">{b.users.join(', ') || '—'}</td></tr>)}
          </tbody></table>
        </>)}

        <h3>Listening ports ({n.ports.length})</h3>
        {n.ports.length === 0 ? <p className="small muted">No listening TCP ports reported.</p> : (
          <table><thead><tr><th>Port</th><th>Proto</th><th>Bind</th><th>Exposure</th></tr></thead><tbody>
            {[...n.ports].sort((a, b) => a.port - b.port).map((p) => (
              <tr key={`${p.proto}/${p.port}`}><td>{p.port}</td><td>{p.proto}</td><td className="small">{p.addr || '—'}</td><td>{p.exposed ? '🌐 exposed to network' : '🔒 localhost only'}</td></tr>
            ))}
          </tbody></table>
        )}

        <h3>Recent SSH logins</h3>
        {n.recent.length === 0 ? <p className="small muted">No SSH attempts in the last 24 h.</p> : (
          <div style={{ overflowX: 'auto' }}><table><thead><tr><th>Time</th><th>Result</th><th>User</th><th>IP</th></tr></thead><tbody>
            {n.recent.slice(0, 30).map((a, i) => (
              <tr key={i}><td className="small">{fmtDateTime(new Date(a.ts * 1000).toISOString())}</td><td>{a.ok ? '🟢 accepted' : '🔴 failed'}</td><td>{a.user || '—'}</td><td>{a.ip}</td></tr>
            ))}
          </tbody></table></div>
        )}
      </div>
    ))}
  </>);
}
