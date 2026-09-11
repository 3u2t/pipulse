import { getDb } from '../db/db.js';
import type { AlertItem, SmartDrive } from '../shared/types.js';

export interface Thresholds {
  cpuWarn: number; cpuCrit: number;
  tempWarn: number; tempCrit: number;
  memWarn: number; memCrit: number;
  diskWarn: number; diskCrit: number;
  driveTempWarn: number; driveTempCrit: number;
}

export function getThresholds(): Thresholds {
  const g = (k: string, f: number) => {
    const row = getDb().prepare('SELECT value FROM settings WHERE key=?').get(k) as unknown as { value: string } | undefined;
    const n = Number(row?.value);
    return Number.isFinite(n) ? n : f;
  };
  return {
    cpuWarn: g('th_cpu_warn', 80), cpuCrit: g('th_cpu_crit', 90),
    tempWarn: g('th_temp_warn', 70), tempCrit: g('th_temp_crit', 80),
    memWarn: g('th_mem_warn', 80), memCrit: g('th_mem_crit', 90),
    diskWarn: g('th_disk_warn', 80), diskCrit: g('th_disk_crit', 90),
    driveTempWarn: g('th_drive_temp_warn', 50), driveTempCrit: g('th_drive_temp_crit', 60),
  };
}

function upsert(key: string, severity: AlertItem['severity'], component: string, message: string): void {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM alerts WHERE key=? AND status IN ('active','acknowledged')").get(key) as unknown as { id: number } | undefined;
  if (existing) {
    db.prepare('UPDATE alerts SET severity=?, message=? WHERE id=?').run(severity, message, existing.id);
    return;
  }
  db.prepare('INSERT INTO alerts(key,severity,component,message) VALUES(?,?,?,?)').run(key, severity, component, message);
}

function resolve(key: string): void {
  getDb().prepare("UPDATE alerts SET status='resolved', resolved_at=datetime('now') WHERE key=? AND status IN ('active','acknowledged')").run(key);
}

export interface AgentPresence { id: string; hostname: string; connected: boolean }

export function evaluateAlerts(snap: { cpu: { usage: number | null; tempC: number | null }; mem: { usedPct: number | null }; filesystems: { mount: string; usedPct: number | null }[] }, agents: AgentPresence[], drives: SmartDrive[] = []): void {
  const t = getThresholds();
  // CPU
  if (snap.cpu.usage !== null && snap.cpu.usage >= t.cpuCrit) upsert('cpu-usage', 'critical', 'cpu', `CPU usage is ${snap.cpu.usage.toFixed(0)}% (above ${t.cpuCrit}%).`);
  else if (snap.cpu.usage !== null && snap.cpu.usage >= t.cpuWarn) upsert('cpu-usage', 'warning', 'cpu', `CPU usage is ${snap.cpu.usage.toFixed(0)}% (above ${t.cpuWarn}%).`);
  else resolve('cpu-usage');
  // Temp
  if (snap.cpu.tempC !== null && snap.cpu.tempC >= t.tempCrit) upsert('cpu-temp', 'critical', 'cpu', `CPU temperature is ${snap.cpu.tempC.toFixed(0)}°C (above ${t.tempCrit}°C).`);
  else if (snap.cpu.tempC !== null && snap.cpu.tempC >= t.tempWarn) upsert('cpu-temp', 'warning', 'cpu', `CPU temperature is ${snap.cpu.tempC.toFixed(0)}°C (above ${t.tempWarn}°C).`);
  else resolve('cpu-temp');
  // Mem
  if (snap.mem.usedPct !== null && snap.mem.usedPct >= t.memCrit) upsert('mem', 'critical', 'memory', `Memory usage is ${snap.mem.usedPct.toFixed(0)}% (above ${t.memCrit}%).`);
  else if (snap.mem.usedPct !== null && snap.mem.usedPct >= t.memWarn) upsert('mem', 'warning', 'memory', `Memory usage is ${snap.mem.usedPct.toFixed(0)}% (above ${t.memWarn}%).`);
  else resolve('mem');
  // Disk per mount
  for (const fs of snap.filesystems) {
    const key = `disk:${fs.mount}`;
    if (fs.usedPct !== null && fs.usedPct >= t.diskCrit) upsert(key, 'critical', 'storage', `Disk usage on ${fs.mount} is ${fs.usedPct.toFixed(0)}% (above ${t.diskCrit}%).`);
    else if (fs.usedPct !== null && fs.usedPct >= t.diskWarn) upsert(key, 'warning', 'storage', `Disk usage on ${fs.mount} is ${fs.usedPct.toFixed(0)}% (above ${t.diskWarn}%).`);
    else if (fs.usedPct !== null && fs.usedPct >= 70) upsert(key, 'info', 'storage', `Disk usage on ${fs.mount} is ${fs.usedPct.toFixed(0)}%.`);
    else resolve(key);
  }
  // One key per agent so multi-server setups see exactly which node went quiet.
  // The legacy bare 'agent' key (pre multi-server) resolves itself away.
  resolve('agent');
  for (const a of agents) {
    const key = `agent:${a.id}`;
    if (!a.connected) upsert(key, 'warning', 'agent', `PiPulse agent on ${a.hostname} disconnected.`);
    else resolve(key);
  }
  // SMART drives. "Unavailable" is a state, not a failure — no alert for it.
  for (const d of drives) {
    const node = d.nodeId ? d.nodeId + ':' : '';
    const key = `smart:${node}${d.device}`;
    if (d.nodeId) resolve(`smart:${d.device}`); // legacy key without node prefix
    if (d.overall === 'unavailable') { resolve(key); continue; }
    const label = `${d.nodeId ? d.nodeId + ' ' : ''}${d.device}${d.model ? ` (${d.model})` : ''}`;
    if (d.overall === 'critical') {
      upsert(key, 'critical', 'smart', `SMART critical on ${label}: ${d.warnings[0] || 'health check failed'}`);
    } else if (d.overall === 'warning') {
      upsert(key, 'warning', 'smart', `SMART warning on ${label}: ${d.warnings[0] || 'attention recommended'}`);
    } else resolve(key);
  }
}

// Threshold checks for remote nodes (agent-reported metrics only).
export function evaluateNodeAlerts(nodes: { id: string; hostname: string; cpuUsage: number | null; tempC: number | null; memPct: number | null }[]): void {
  const t = getThresholds();
  const check = (key: string, v: number | null, warn: number, crit: number, msg: (n: string) => string) => {
    if (v !== null && v >= crit) upsert(key, 'critical', 'node', msg(`${crit}`));
    else if (v !== null && v >= warn) upsert(key, 'warning', 'node', msg(`${warn}`));
    else resolve(key);
  };
  for (const n of nodes) {
    check(`node:${n.id}:cpu`, n.cpuUsage, t.cpuWarn, t.cpuCrit, (th) => `CPU usage on ${n.hostname} is ${n.cpuUsage!.toFixed(0)}% (above ${th}%).`);
    check(`node:${n.id}:temp`, n.tempC, t.tempWarn, t.tempCrit, (th) => `CPU temperature on ${n.hostname} is ${n.tempC!.toFixed(0)}°C (above ${th}°C).`);
    check(`node:${n.id}:mem`, n.memPct, t.memWarn, t.memCrit, (th) => `Memory usage on ${n.hostname} is ${n.memPct!.toFixed(0)}% (above ${th}%).`);
  }
}

export function listAlerts(status?: string, q?: string): AlertItem[] {
  let sql = 'SELECT id,key,severity,component,message,status,created_at AS createdAt,resolved_at AS resolvedAt FROM alerts';
  const args: string[] = [];
  const cond: string[] = [];
  if (status && status !== 'all') { cond.push('status=?'); args.push(status); }
  if (q) { cond.push('(message LIKE ? OR component LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
  sql += ' ORDER BY created_at DESC LIMIT 200';
  return getDb().prepare(sql).all(...args) as unknown as AlertItem[];
}
