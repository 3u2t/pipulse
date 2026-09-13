import { getDb } from '../db/db.js';
import { getThresholds, upsert, resolve } from '../alerts/alerts.js';
import type { ListenPort, SecurityStatus, SshAttempt, SshIpStat } from '../shared/types.js';

// Detection window for brute force counting. 10 minutes is long enough to
// catch slow password guessing, short enough to auto-resolve afterwards.
const WINDOW_SEC = 10 * 60;
// Raw SSH events are kept 24h for the Security page; counting uses the window.
const RETENTION_SEC = 24 * 3600;

export interface AgentSecurity {
  ssh?: { ts?: number; user?: string; ip?: string; ok?: boolean }[];
  sshLog?: boolean;
  ports?: { proto?: string; port?: number; addr?: string; exposed?: boolean }[];
  firewall?: string;
  firewallDetail?: string;
  fail2ban?: string;
  secUpdates?: number | null;
  rebootRequired?: boolean;
}

const FIREWALLS = new Set(['ufw', 'nft', 'iptables', 'none', 'unknown']);
const FAIL2BAN = new Set(['active', 'inactive', 'missing']);

// ---------- ingest: store what the agent saw, learn baselines silently ----------

export function ingestAgentSecurity(nodeId: string, hostname: string, sec: AgentSecurity): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const firewall = typeof sec.firewall === 'string' && FIREWALLS.has(sec.firewall) ? sec.firewall : 'unknown';
  const fail2ban = typeof sec.fail2ban === 'string' && FAIL2BAN.has(sec.fail2ban) ? sec.fail2ban : 'missing';
  const ports: ListenPort[] = Array.isArray(sec.ports)
    ? sec.ports
      .filter((p) => p && typeof p.port === 'number' && p.port > 0 && p.port <= 65535 && (p.proto === 'tcp' || p.proto === 'tcp6'))
      .map((p) => ({ proto: p.proto as string, port: p.port as number, addr: typeof p.addr === 'string' ? p.addr : '', exposed: p.exposed === true }))
      .slice(0, 64)
    : [];
  const secUpdates = typeof sec.secUpdates === 'number' && Number.isFinite(sec.secUpdates) && sec.secUpdates >= 0 ? Math.floor(sec.secUpdates) : null;
  db.prepare(`INSERT INTO node_security(node,hostname,firewall,firewall_detail,fail2ban,sec_updates,reboot_required,ssh_log,ports,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,datetime('now')) ON CONFLICT(node) DO UPDATE SET
    hostname=excluded.hostname, firewall=excluded.firewall, firewall_detail=excluded.firewall_detail,
    fail2ban=excluded.fail2ban, sec_updates=excluded.sec_updates, reboot_required=excluded.reboot_required,
    ssh_log=excluded.ssh_log, ports=excluded.ports, updated_at=datetime('now')`)
    .run(nodeId, hostname, firewall, String(sec.firewallDetail || '').slice(0, 200), fail2ban, secUpdates,
      sec.rebootRequired === true ? 1 : 0, sec.sshLog === true ? 1 : 0, JSON.stringify(ports));
  if (Array.isArray(sec.ssh)) {
    const ins = db.prepare('INSERT OR IGNORE INTO ssh_events(ts,node,ip,username,ok) VALUES(?,?,?,?,?)');
    for (const a of sec.ssh.slice(0, 100)) {
      if (!a || typeof a.ip !== 'string' || !a.ip) continue;
      const ts = typeof a.ts === 'number' && Number.isFinite(a.ts) ? Math.floor(a.ts) : now;
      if (ts < now - RETENTION_SEC || ts > now + 300) continue; // ignore ancient/future garbage
      ins.run(ts, nodeId, a.ip.slice(0, 64), String(a.user || '').slice(0, 64), a.ok === true ? 1 : 0);
    }
  }
  db.prepare('DELETE FROM ssh_events WHERE ts < ?').run(now - RETENTION_SEC);
}

// ---------- evaluate: conservative rules, every firing resolves itself ----------

function windowCounts(nodeId: string): { ip: string; failed: number; lastTs: number; users: string[] }[] {
  const since = Math.floor(Date.now() / 1000) - WINDOW_SEC;
  const rows = getDb().prepare(
    `SELECT ip, COUNT(*) AS n, MAX(ts) AS lastTs, GROUP_CONCAT(DISTINCT username) AS users
     FROM ssh_events WHERE node=? AND ok=0 AND ts>=? GROUP BY ip`).all(nodeId, since) as unknown as
    { ip: string; n: number; lastTs: number; users: string | null }[];
  return rows.map((r) => ({ ip: r.ip, failed: r.n, lastTs: r.lastTs, users: (r.users || '').split(',').filter(Boolean).slice(0, 5) }));
}

// freshNodeIds: agents with a recent push. Stale nodes are skipped on purpose:
// their alerts stay as they are, and the agent-disconnect warning covers the
// outage — flapping resolve/upsert on missing data would be worse.
export function evaluateSecurityAlerts(freshNodeIds: string[]): void {
  const db = getDb();
  const t = getThresholds();
  const fresh = new Set(freshNodeIds);
  const nodes = db.prepare('SELECT node, hostname FROM node_security').all() as unknown as { node: string; hostname: string }[];

  for (const { node, hostname } of nodes) {
    if (!fresh.has(node)) continue;
    const label = hostname || node;

    // 1. Brute force: counted failed logins per IP in the window.
    const seen = new Set<string>();
    for (const w of windowCounts(node)) {
      seen.add(w.ip);
      const key = `sec:ssh:${node}:${w.ip}`;
      if (w.failed >= t.sshCrit) upsert(key, 'critical', 'security', `Possible SSH brute force on ${label}: ${w.failed} failed logins from ${w.ip} in 10 min${w.users.length ? ` (users: ${w.users.join(', ')})` : ''}.`);
      else if (w.failed >= t.sshWarn) upsert(key, 'warning', 'security', `SSH password guessing on ${label}: ${w.failed} failed logins from ${w.ip} in 10 min.`);
      else resolve(key);
    }
    // Resolve keys whose IP fell out of the window.
    for (const r of db.prepare("SELECT key FROM alerts WHERE key LIKE ? AND status IN ('active','acknowledged')").all(`sec:ssh:${node}:%`) as unknown as { key: string }[]) {
      if (!seen.has(r.key.slice(`sec:ssh:${node}:`.length))) resolve(r.key);
    }

    // 2. Successful login from a never-seen IP: alert once, then remember.
    const freshLogins = db.prepare('SELECT DISTINCT ip FROM ssh_events WHERE node=? AND ok=1 AND ts>=?').all(node, Math.floor(Date.now() / 1000) - RETENTION_SEC) as unknown as { ip: string }[];
    const known = new Set((db.prepare('SELECT ip FROM known_ssh_ips WHERE node=?').all(node) as unknown as { ip: string }[]).map((r) => r.ip));
    for (const { ip } of freshLogins) {
      if (known.has(ip)) { resolve(`sec:login:${node}:${ip}`); continue; }
      upsert(`sec:login:${node}:${ip}`, 'warning', 'security', `New SSH login on ${label} from ${ip} — if that wasn't you, check immediately.`);
      db.prepare('INSERT OR IGNORE INTO known_ssh_ips(node,ip) VALUES(?,?)').run(node, ip);
    }

    // 3. New listening port: alert once, then remember. Vanished ports don't
    // alert (restarts happen); returning ports don't re-alert (already known).
    const row = db.prepare('SELECT ports FROM node_security WHERE node=?').get(node) as unknown as { ports: string } | undefined;
    let current: ListenPort[] = [];
    try { current = JSON.parse(row?.ports || '[]') as ListenPort[]; } catch { current = []; }
    const knownPorts = new Set((db.prepare('SELECT proto || "/" || port AS k FROM known_ports WHERE node=?').all(node) as unknown as { k: string }[]).map((r) => r.k));
    const insPort = db.prepare('INSERT OR IGNORE INTO known_ports(node,proto,port,addr,exposed) VALUES(?,?,?,?,?)');
    for (const p of current) {
      const k = `${p.proto}/${p.port}`;
      if (knownPorts.has(k)) { resolve(`sec:port:${node}:${k}`); continue; }
      upsert(`sec:port:${node}:${k}`, 'warning', 'security',
        `New listening port on ${label}: ${p.port}/${p.proto}${p.exposed ? ' (exposed to the network' : ' (localhost only'}${p.addr ? `, ${p.addr}` : ''}) — if you didn't open it, investigate.`);
      insPort.run(node, p.proto, p.port, p.addr || '', p.exposed ? 1 : 0);
    }

    // 4. Firewall: "none" is a fact, not a guess — steady warning. "unknown"
    // (no firewall tool on the box) never alerts, it just shows in the UI.
    const fw = db.prepare('SELECT firewall FROM node_security WHERE node=?').get(node) as unknown as { firewall: string } | undefined;
    if (fw?.firewall === 'none') upsert(`sec:firewall:${node}`, 'warning', 'security', `No active firewall on ${label}. Consider ` + '`sudo ufw enable` (SSH stays allowed with `sudo ufw allow ssh`).');
    else resolve(`sec:firewall:${node}`);

    // 5. Hygiene: pending security updates (info), reboot required (warning).
    const hy = db.prepare('SELECT sec_updates, reboot_required FROM node_security WHERE node=?').get(node) as unknown as { sec_updates: number | null; reboot_required: number } | undefined;
    if (typeof hy?.sec_updates === 'number' && hy.sec_updates > 0) upsert(`sec:updates:${node}`, 'info', 'security', `${hy.sec_updates} security updates pending on ${label} (` + '`sudo apt update && sudo apt upgrade`).');
    else resolve(`sec:updates:${node}`);
    if (hy?.reboot_required === 1) upsert(`sec:reboot:${node}`, 'warning', 'security', `${label} needs a reboot to activate kernel updates.`);
    else resolve(`sec:reboot:${node}`);
  }
}

// ---------- read model for the Security page ----------

export function getSecurityStatus(connectedIds: Set<string>): SecurityStatus[] {
  const db = getDb();
  const nodes = db.prepare('SELECT node,hostname,firewall,firewall_detail,fail2ban,sec_updates,reboot_required,ssh_log,ports FROM node_security ORDER BY hostname').all() as unknown as
    { node: string; hostname: string; firewall: string; firewall_detail: string; fail2ban: string; sec_updates: number | null; reboot_required: number; ssh_log: number; ports: string }[];
  return nodes.map((n) => {
    let ports: ListenPort[] = [];
    try { ports = JSON.parse(n.ports || '[]') as ListenPort[]; } catch { ports = []; }
    const recent = db.prepare('SELECT ts,username AS user,ip,ok FROM ssh_events WHERE node=? ORDER BY ts DESC LIMIT 30').all(n.node) as unknown as { ts: number; user: string; ip: string; ok: number }[];
    const bruteForce: SshIpStat[] = windowCounts(n.node).map((w) => ({ ip: w.ip, failed: w.failed, lastTs: w.lastTs, users: w.users }));
    return {
      nodeId: n.node, hostname: n.hostname || n.node, connected: connectedIds.has(n.node),
      firewall: n.firewall, firewallDetail: n.firewall_detail || null, fail2ban: n.fail2ban,
      secUpdates: typeof n.sec_updates === 'number' ? n.sec_updates : null,
      rebootRequired: n.reboot_required === 1, sshLog: n.ssh_log === 1, ports,
      recent: recent.map((r) => ({ ts: r.ts, user: r.user, ip: r.ip, ok: r.ok === 1 })),
      bruteForce,
    };
  });
}
