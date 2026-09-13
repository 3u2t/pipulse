import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { MonitoringProvider } from '../providers/providers.js';
import type { AppConfig } from '../config/config.js';
import { listContainers } from '../docker/containers.js';
import { evaluateAlerts, evaluateNodeAlerts, listAlerts, getThresholds } from '../alerts/alerts.js';
import { evaluateSecurityAlerts } from '../security/security.js';
import { collectSmart } from '../collectors/smart.js';
import { agentStatus, agentNodes } from '../agent/agent.js';
import { reconcileNotifications } from '../notify/notify.js';
import { getDb, pruneMetrics, getSetting } from '../db/db.js';
import type { WsPayload } from '../shared/types.js';

// Interval comes from Settings so it can be changed without a restart.
// Clamped: faster than 1s would hammer the Pi, slower than 60s is pointless.
export function resolveInterval(envMs: number, setting: string): number {
  if (!setting.trim()) return envMs;
  const n = Number(setting);
  if (!Number.isFinite(n)) return envMs;
  return Math.min(60000, Math.max(1000, Math.round(n)));
}

export function startWs(server: Server, provider: MonitoringProvider, config: AppConfig): void {
  const wss = new WebSocketServer({ server, path: '/ws' });
  let latest: WsPayload | null = null;
  let intervalMs = config.monitorIntervalMs;

  async function tick(): Promise<void> {
    try {
      const s = await provider.snapshot();
      const agent = agentStatus(intervalMs);
      const docker = await listContainers().catch(() => ({ available: false, containers: [] }));
      const t = getThresholds();
      // SMART is cached server-side (5 min) so this is cheap after the first tick.
      const smart = await collectSmart({ warn: t.driveTempWarn, crit: t.driveTempCrit }).catch(() => ({ tool: 'ok' as const, drives: [] }));
      const demo = provider.name === 'demo';
      const nodes = demo ? [] : agentNodes(intervalMs);
      evaluateAlerts(s, nodes.map((n) => ({ id: n.id, hostname: n.hostname, connected: demo ? true : n.connected })), smart.drives);
      if (!demo) evaluateNodeAlerts(nodes.filter((n) => n.connected));
      if (!demo) {
        try {
          evaluateSecurityAlerts(nodes.filter((n) => n.connected).map((n) => n.id));
        } catch (e) {
          console.error('[pipulse] security evaluate failed:', (e as Error).message);
        }
      }
      const activeAlerts = listAlerts('active');
      void reconcileNotifications(activeAlerts, agent.hostname || 'pipulse', demo);
      const payload: WsPayload = {
        ts: new Date().toISOString(),
        cpu: s.cpu, mem: s.mem, filesystems: s.filesystems, diskIo: s.diskIo, net: s.net,
        docker: {
          available: docker.available,
          running: docker.containers.filter((c) => ['healthy', 'running', 'degraded'].includes(c.state)).length,
          stopped: docker.containers.filter((c) => c.state === 'stopped').length,
          containers: docker.containers,
        },
        services: s.services.slice(0, 60), processes: s.processes.slice(0, 20),
        alerts: activeAlerts,
        agent, nodes, uptimeSec: s.uptimeSec, bootTime: s.bootTime,
      };
      latest = payload;
      // persist host rollup + per-container rows (cheap: one tick per interval)
      const db = getDb();
      const ins = db.prepare('INSERT INTO metrics(ts,kind,ref,cpu,mem_pct,temp_c,rx_bps,tx_bps,read_bps,write_bps) VALUES(?,?,?,?,?,?,?,?,?,?)');
      const now = Date.now();
      const rx = s.net.reduce((a, n) => a + (n.rxBps || 0), 0), tx = s.net.reduce((a, n) => a + (n.txBps || 0), 0);
      ins.run(now, 'host', '', s.cpu.usage, s.mem.usedPct, s.cpu.tempC, rx, tx, s.diskIo.readBps, s.diskIo.writeBps);
      for (const n of s.net) ins.run(now, 'iface', n.name, null, null, null, n.rxBps, n.txBps, null, null);
      for (const c of docker.containers) {
        ins.run(now, 'container', c.id, c.cpuPct, c.memPct, null, c.netRxBps, c.netTxBps, c.blkReadBps, c.blkWriteBps);
      }
      const msg = JSON.stringify(payload);
      for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    } catch (e) {
      console.error('[pipulse] tick failed:', (e as Error).message);
    }
  }

  // Re-reads the interval every tick so Settings changes apply without a restart.
  // Skips if the previous tick is still running (a hung systemctl/smartctl
  // must not stack up overlapping ticks).
  let ticking = false;
  async function tickAndReschedule(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      await tick();
    } finally {
      ticking = false;
    }
    const want = resolveInterval(config.monitorIntervalMs, getSetting('monitor_interval', String(config.monitorIntervalMs)));
    if (want !== intervalMs) {
      intervalMs = want;
      clearInterval(timer);
      timer = setInterval(tickAndReschedule, intervalMs);
      timer.unref?.();
    }
  }

  let timer: NodeJS.Timeout = setInterval(tickAndReschedule, intervalMs);
  timer.unref?.();
  void tickAndReschedule();
  // retention prune hourly
  const prune = setInterval(() => pruneMetrics(Number(getSetting('retention_days', '7')) || 7), 3600 * 1000);
  prune.unref?.();

  wss.on('connection', (ws) => {
    if (latest) ws.send(JSON.stringify(latest));
    ws.on('message', (m) => {
      if (String(m) === 'refresh') void tick();
    });
  });
}
