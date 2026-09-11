import { Router } from 'express';
import type { AppConfig } from '../config/config.js';
import { getDb } from '../db/db.js';

export interface AgentState { connected: boolean; lastSeen: string | null; hostname: string | null; version: string | null; }

// Last agent push: heartbeat (agentStatus) and SMART docs (collectSmart read these).
let lastPush: { ts: number; body: any } | null = null;
export function getAgentPush(): { ts: number; body: any } | null { return lastPush; }

// Test hook.
export function _setAgentPush(ts: number, body: unknown): void { lastPush = { ts, body }; }

export function agentStatus(intervalMs: number): AgentState {
  const row = getDb().prepare('SELECT hostname, version, last_seen AS lastSeen FROM agent ORDER BY last_seen DESC LIMIT 1').get() as unknown as { hostname: string; version: string; lastSeen: string } | undefined;
  const lastSeen = row?.lastSeen || (lastPush ? new Date(lastPush.ts).toISOString() : null);
  const age = lastSeen ? Date.now() - new Date(lastSeen).getTime() : Infinity;
  return { connected: age < intervalMs * 3, lastSeen, hostname: row?.hostname || lastPush?.body?.hostname || null, version: row?.version || lastPush?.body?.version || null };
}

export function agentRouter(config: AppConfig): Router {
  const r = Router();
  r.post('/push', (req, res) => {
    if (req.headers.authorization !== `Bearer ${config.agentToken}`) return res.status(401).json({ error: 'unauthorized' });
    const b = req.body as { agentId?: string; hostname?: string; arch?: string; version?: string; metrics?: unknown };
    if (!b || typeof b.agentId !== 'string' || !b.agentId) return res.status(400).json({ error: 'bad push' });
    lastPush = { ts: Date.now(), body: b };
    getDb().prepare('INSERT INTO agent(id,hostname,arch,version,last_seen) VALUES(?,?,?,?,datetime(?)) ON CONFLICT(id) DO UPDATE SET hostname=excluded.hostname, arch=excluded.arch, version=excluded.version, last_seen=excluded.last_seen')
      .run(b.agentId, String(b.hostname || ''), String(b.arch || ''), String(b.version || ''), Date.now());
    res.json({ ok: true });
  });
  return r;
}
