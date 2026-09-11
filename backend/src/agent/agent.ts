import { Router } from 'express';
import type { AppConfig } from '../config/config.js';
import { getDb } from '../db/db.js';
import type { NodeInfo } from '../shared/types.js';

export interface AgentState { connected: boolean; lastSeen: string | null; hostname: string | null; version: string | null; }

export interface AgentBody {
  agentId?: string;
  hostname?: string;
  arch?: string;
  version?: string;
  metrics?: { cpuUsage?: number; tempC?: number; memUsedKb?: number; memTotalKb?: number; load1?: number; uptimeSec?: number };
  smart?: unknown;
}

export interface AgentPush { ts: number; body: AgentBody }

// One entry per agent id. The old single-agent callers use getAgentPush()
// which returns the most recently seen push.
const pushes = new Map<string, AgentPush>();
export function getAgentPushes(): Map<string, AgentPush> { return pushes; }
export function getAgentPush(id?: string): AgentPush | null {
  if (id) return pushes.get(id) ?? null;
  let best: AgentPush | null = null;
  for (const p of pushes.values()) if (!best || p.ts > best.ts) best = p;
  return best;
}

// Test hooks.
export function _setAgentPush(ts: number, body: unknown, agentId?: string): void {
  const b = (body || {}) as AgentBody;
  pushes.set(agentId ?? b.agentId ?? 'agent', { ts, body: b });
}
export function _clearAgentPushes(): void { pushes.clear(); }

function connected(lastSeen: string | null, intervalMs: number): boolean {
  if (!lastSeen) return false;
  const age = Date.now() - new Date(lastSeen.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(lastSeen) ? lastSeen : lastSeen + 'Z').getTime();
  return Number.isFinite(age) && age < intervalMs * 3;
}

// Freshness from the in-memory push. The DB row is the durable record;
// either one proving liveness is enough.
function pushFresh(id: string, intervalMs: number): boolean {
  const p = getAgentPush(id);
  return !!p && Date.now() - p.ts < intervalMs * 3;
}

export function agentStatus(intervalMs: number): AgentState {
  const row = getDb().prepare('SELECT hostname, version, last_seen AS lastSeen FROM agent ORDER BY last_seen DESC LIMIT 1').get() as unknown as { hostname: string; version: string; lastSeen: string } | undefined;
  const latest = getAgentPush();
  const lastSeen = row?.lastSeen || (latest ? new Date(latest.ts).toISOString() : null);
  return { connected: connected(lastSeen, intervalMs), lastSeen, hostname: row?.hostname || latest?.body?.hostname || null, version: row?.version || latest?.body?.version || null };
}
function nodeMetrics(id: string): Pick<NodeInfo, 'cpuUsage' | 'tempC' | 'memPct' | 'uptimeSec'> {
  const m = getAgentPush(id)?.body.metrics;
  if (!m) return { cpuUsage: null, tempC: null, memPct: null, uptimeSec: null };
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    cpuUsage: num(m.cpuUsage),
    tempC: num(m.tempC),
    memPct: typeof m.memUsedKb === 'number' && m.memTotalKb ? (m.memUsedKb / m.memTotalKb) * 100 : null,
    uptimeSec: num(m.uptimeSec),
  };
}

// Every known agent as a NodeInfo. Rows persist across restarts; liveness
// comes from last_seen, metrics from the latest push (if still fresh).
export function agentNodes(intervalMs: number): NodeInfo[] {
  const rows = getDb().prepare('SELECT id, hostname, arch, version, last_seen AS lastSeen FROM agent ORDER BY hostname').all() as unknown as { id: string; hostname: string; arch: string; version: string; lastSeen: string }[];
  return rows.map((r) => {
    const live = pushFresh(r.id, intervalMs);
    const m = live ? nodeMetrics(r.id) : { cpuUsage: null, tempC: null, memPct: null, uptimeSec: null };
    return {
      id: r.id, hostname: r.hostname || r.id, arch: r.arch || null, version: r.version || null,
      connected: connected(r.lastSeen, intervalMs) || live,
      lastSeen: r.lastSeen, ...m, local: false,
    };
  });
}

export function agentRouter(config: AppConfig): Router {
  const r = Router();
  r.post('/push', (req, res) => {
    if (req.headers.authorization !== `Bearer ${config.agentToken}`) return res.status(401).json({ error: 'unauthorized' });
    const b = req.body as AgentBody;
    if (!b || typeof b.agentId !== 'string' || !b.agentId) return res.status(400).json({ error: 'bad push' });
    pushes.set(b.agentId, { ts: Date.now(), body: b });
    getDb().prepare("INSERT INTO agent(id,hostname,arch,version,last_seen) VALUES(?,?,?,?,datetime('now')) ON CONFLICT(id) DO UPDATE SET hostname=excluded.hostname, arch=excluded.arch, version=excluded.version, last_seen=datetime('now')")
      .run(b.agentId, String(b.hostname || ''), String(b.arch || ''), String(b.version || ''));
    res.json({ ok: true });
  });
  return r;
}
