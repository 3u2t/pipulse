import http from 'node:http';
import fs from 'node:fs';
import type { ContainerSummary, ContainerState } from '../shared/types.js';

const SOCK = '/var/run/docker.sock';
const MINING_RE = /(xmrig|ethminer|teamredminer|nbminer|lolminer|trexminer|phoenixminer|cgminer|bfgminer|srbminer|nicehash|unmineable|monero| kawpow|ethash)/i;

export function dockerAvailable(): boolean {
  try { fs.accessSync(SOCK, fs.constants.R_OK | fs.constants.W_OK); return true; }
  catch { return false; }
}

function sockGet<T>(path: string, timeoutMs = 6000): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: SOCK, path, method: 'GET' }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf || '{}') as T); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('docker timeout')); });
    req.end();
  });
}

function sockPost(path: string, timeoutMs = 15000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({ socketPath: SOCK, path, method: 'POST' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode !== undefined && res.statusCode < 300));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// Docker stats CPU math
function calcCpuPct(stats: any): number | null {
  try {
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const sysDelta = (stats.cpu_stats.system_cpu_usage || 0) - (stats.precpu_stats.system_cpu_usage || 0);
    const cores = stats.cpu_stats.online_cpus || stats.cpu_stats.cpu_usage.percpu_usage?.length || 1;
    if (sysDelta <= 0 || cpuDelta < 0) return 0;
    return Math.min(100, (cpuDelta / sysDelta) * cores * 100);
  } catch { return null; }
}

function netTotals(networks: any): { rx: number; tx: number } {
  let rx = 0, tx = 0;
  for (const n of Object.values(networks || {}) as any[]) { rx += n.rx_bytes || 0; tx += n.tx_bytes || 0; }
  return { rx, tx };
}
function blkTotals(blk: any): { r: number; w: number } {
  let r = 0, w = 0;
  for (const e of blk?.io_service_bytes_recursive || []) {
    if (e.op === 'read') r += e.value || 0;
    if (e.op === 'write') w += e.value || 0;
  }
  return { r, w };
}

const prevStats = new Map<string, { rx: number; tx: number; r: number; w: number; t: number }>();

export function deriveState(c: any, inspect: any, restartCount: number): { state: ContainerState; health: string | null } {
  const raw = String(c.State || inspect?.State?.Status || 'unknown').toLowerCase();
  const health = inspect?.State?.Health?.Status || null;
  if (raw === 'restarting') return { state: 'restarting', health };
  if (raw === 'exited' || raw === 'dead' || raw === 'created' || raw === 'paused') return { state: 'stopped', health };
  if (raw === 'running' || raw === 'up') {
    if (health === 'unhealthy') return { state: 'unhealthy', health };
    if (health === 'starting' || health === 'degraded' || restartCount >= 5) return { state: 'degraded', health };
    if (health === 'healthy') return { state: 'healthy', health };
    return { state: 'running', health };
  }
  return { state: 'unknown', health };
}

export function detectMining(name: string, image: string, cmd: string): string | null {
  const hay = `${name} ${image} ${cmd}`;
  return MINING_RE.test(hay) ? 'Possible mining workload detected — matched image/name against common miner identifiers. Verify the workload yourself; no mining metrics are collected automatically.' : null;
}

// Rule-based anomaly flags. Every flag carries a human-readable reason.
export function flagAnomalies(s: ContainerSummary, history: { cpu: number[]; memPct: number[] }): { rule: string; reason: string }[] {
  const flags: { rule: string; reason: string }[] = [];
  if (s.cpuPct !== null && s.cpuPct > 90) flags.push({ rule: 'high-cpu', reason: `CPU at ${s.cpuPct.toFixed(0)}% — above the 90% rule threshold.` });
  if (s.memPct !== null && s.memPct > 90) flags.push({ rule: 'high-mem', reason: `Memory at ${s.memPct.toFixed(0)}% of its limit — above the 90% rule threshold.` });
  if (s.restartCount >= 5) flags.push({ rule: 'restarts', reason: `${s.restartCount} restarts recorded — container may be crash-looping.` });
  if (s.health === 'unhealthy' || s.state === 'unhealthy') flags.push({ rule: 'unhealthy', reason: 'Docker healthcheck reports unhealthy.' });
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const sd = (a: number[], m: number) => Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length));
  if (history.cpu.length >= 12 && s.cpuPct !== null) {
    const m = mean(history.cpu), s2 = sd(history.cpu, m);
    if (s2 > 0 && s.cpuPct > m + 3 * s2 && s.cpuPct > 50) flags.push({ rule: 'cpu-spike', reason: `CPU ${s.cpuPct.toFixed(0)}% is unusually high vs recent average ${m.toFixed(0)}%.` });
  }
  return flags;
}

interface DockerListItem { Id: string; Names: string[]; Image: string; State: string; Status: string; Ports: { PublicPort?: number; PrivatePort: number; Type: string }[]; Mounts: { Destination: string }[]; }

async function enrich(c: DockerListItem): Promise<ContainerSummary> {
  const id = c.Id, shortId = id.slice(0, 12);
  const name = (c.Names?.[0] || id.slice(0, 12)).replace(/^\//, '');
  const [img, ...tagParts] = (c.Image || 'unknown').split(':');
  const imageTag = tagParts.join(':') || 'latest';
  let inspect: any = null, stats: any = null;
  try { inspect = await sockGet<any>(`/v1.43/containers/${id}/json`); } catch { /* keep nulls */ }
  try { stats = await sockGet<any>(`/v1.43/containers/${id}/stats?stream=false`); } catch { /* keep nulls */ }

  const restartCount = Number(inspect?.RestartCount ?? 0);
  const { state, health } = deriveState(c, inspect, restartCount);
  const startedAt = inspect?.State?.StartedAt;
  const uptimeSec = startedAt && startedAt.startsWith('0001') === false
    ? Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)) : null;

  const cpuPct = stats ? calcCpuPct(stats) : null;
  const memBytes = stats?.memory_stats?.usage ?? null;
  const memLimit = stats?.memory_stats?.limit ?? null;
  const memPct = memBytes !== null && memLimit ? (memBytes / memLimit) * 100 : null;
  const pids = stats?.pids_stats?.current ?? inspect?.State?.Pid ?? null;

  let netRxBps: number | null = null, netTxBps: number | null = null;
  let blkReadBps: number | null = null, blkWriteBps: number | null = null;
  if (stats) {
    const { rx, tx } = netTotals(stats.networks);
    const { r, w } = blkTotals(stats.blkio_stats);
    const prev = prevStats.get(id);
    const now = Date.now();
    if (prev) {
      const dt = (now - prev.t) / 1000;
      if (dt > 0) {
        netRxBps = Math.max(0, (rx - prev.rx) / dt); netTxBps = Math.max(0, (tx - prev.tx) / dt);
        blkReadBps = Math.max(0, (r - prev.r) / dt); blkWriteBps = Math.max(0, (w - prev.w) / dt);
      }
    }
    prevStats.set(id, { rx, tx, r, w, t: now });
  }

  const ports = (c.Ports || inspect?.NetworkSettings?.Ports && Object.entries(inspect.NetworkSettings.Ports).map(([k, v]: [string, any]) =>
    `${(v?.[0]?.HostPort) || '?'}->${k}`) || []).map(String);
  const mounts = (c.Mounts || inspect?.Mounts || []).map((m: any) => String(m.Destination || m.Target || ''));
  const restartPolicy = inspect?.HostConfig?.RestartPolicy?.Name || 'unknown';
  const miningReason = detectMining(name, c.Image || '', [inspect?.Config?.Cmd].flat().filter(Boolean).join(' '));
  const partial: ContainerSummary = {
    id, shortId, name, image: img, imageTag, status: c.Status || inspect?.State?.Status || 'unknown',
    state, health, uptimeSec, restartCount, cpuPct, memBytes, memLimit, memPct,
    netRxBps, netTxBps, blkReadBps, blkWriteBps, pids, ports, mounts, restartPolicy,
    anomalies: [], miningFlag: !!miningReason, miningReason,
  };
  partial.anomalies = flagAnomalies(partial, { cpu: [], memPct: [] });
  return partial;
}

export async function listContainers(): Promise<{ available: boolean; containers: ContainerSummary[] }> {
  if (!dockerAvailable()) return { available: false, containers: [] };
  try {
    const items = await sockGet<DockerListItem[]>('/v1.43/containers/json?all=1');
    const containers = await Promise.all(items.map(enrich));
    return { available: true, containers };
  } catch {
    return { available: false, containers: [] };
  }
}

export async function containerDetail(id: string): Promise<ContainerSummary | null> {
  if (!/^[a-f0-9]{6,64}$/i.test(id)) return null;
  const { containers } = await listContainers();
  return containers.find((c) => c.id.startsWith(id) || c.shortId === id) || null;
}

export async function containerAction(id: string, action: 'start' | 'stop' | 'restart'): Promise<boolean> {
  if (!/^[a-f0-9]{6,64}$/i.test(id)) return false;
  if (!['start', 'stop', 'restart'].includes(action)) return false;
  if (!dockerAvailable()) return false;
  return sockPost(`/v1.43/containers/${id}/${action}`);
}

export async function containerLogs(id: string, tail = 200): Promise<string[]> {
  if (!/^[a-f0-9]{6,64}$/i.test(id)) return [];
  if (!dockerAvailable()) return [];
  return new Promise((resolve) => {
    const req = http.request({ socketPath: SOCK, path: `/v1.43/containers/${id}/logs?stdout=true&stderr=true&timestamps=true&tail=${Math.min(tail, 500)}`, method: 'GET' }, (res) => {
      let buf = Buffer.alloc(0);
      res.on('data', (c) => { buf = Buffer.concat([buf, c]); });
      res.on('end', () => {
        // strip docker multiplexed framing
        const lines: string[] = [];
        let i = 0;
        while (i + 8 <= buf.length) {
          const len = buf.readUInt32BE(i + 4);
          lines.push(buf.slice(i + 8, i + 8 + len).toString('utf8'));
          i += 8 + len;
          if (len === 0) break;
        }
        const text = lines.length ? lines.join('') : buf.toString('utf8');
        resolve(text.split('\n').filter(Boolean).slice(-tail));
      });
    });
    req.on('error', () => resolve([]));
    req.setTimeout(8000, () => { req.destroy(); resolve([]); });
    req.end();
  });
}

export async function dockerCounts(): Promise<{ images: number; volumes: number }> {
  if (!dockerAvailable()) return { images: 0, volumes: 0 };
  try {
    const [imgs, vols] = await Promise.all([
      sockGet<any[]>('/v1.43/images/json').catch(() => []),
      sockGet<{ Volumes: any[] }>('/v1.43/volumes').catch(() => ({ Volumes: [] })),
    ]);
    return { images: imgs.length, volumes: vols.Volumes?.length || 0 };
  } catch { return { images: 0, volumes: 0 }; }
}
