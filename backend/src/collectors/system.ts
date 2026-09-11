import fs from 'node:fs';
import { execFile } from 'node:child_process';
import type { CpuSnapshot, MemSnapshot, FsEntry, DiskIo, NetIface, NetKind, NetSummary, ServiceInfo, ProcInfo } from '../shared/types.js';

const read = (p: string): string | null => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; }; };

// ---------- CPU ----------
let prevCpu: { idle: number; total: number; perCore: { idle: number; total: number }[] } | null = null;

function parseCpuLine(line: string): { idle: number; total: number } {
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (parts[3] || 0) + (parts[4] || 0);
  const total = parts.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  return { idle, total };
}

export function parseProcStat(text: string): { total: { idle: number; total: number }; cores: { idle: number; total: number }[] } {
  const lines = text.split('\n');
  const total = parseCpuLine(lines.find((l) => l.startsWith('cpu ')) || 'cpu 0 0 0 0 0 0 0');
  const cores = lines.filter((l) => /^cpu\d+ /.test(l)).map(parseCpuLine);
  return { total, cores };
}

export function cpuPct(prev: { idle: number; total: number }, cur: { idle: number; total: number }): number | null {
  const dt = cur.total - prev.total;
  const di = cur.idle - prev.idle;
  if (dt <= 0) return null;
  return Math.min(100, Math.max(0, (1 - di / dt) * 100));
}

function cpuTemp(): number | null {
  for (const z of fs.readdirSync('/sys/class/thermal', { withFileTypes: true }).flatMap((d) => (d.isDirectory() || d.isSymbolicLink() ? [d.name] : []))) {
    try {
      const type = fs.readFileSync(`/sys/class/thermal/${z}/type`, 'utf8').trim();
      const raw = Number(fs.readFileSync(`/sys/class/thermal/${z}/temp`, 'utf8').trim());
      if (Number.isFinite(raw) && /cpu|soc|thermal/i.test(type)) return raw / 1000;
    } catch { /* next zone */ }
  }
  // fallback: first zone with plausible value
  try {
    for (const z of fs.readdirSync('/sys/class/thermal')) {
      const raw = Number(fs.readFileSync(`/sys/class/thermal/${z}/temp`, 'utf8').trim());
      if (Number.isFinite(raw) && raw > 0) return raw / 1000;
    }
  } catch { /* unavailable */ }
  return null;
}

function cpuFreq(): number | null {
  let sum = 0, n = 0;
  try {
    for (const c of fs.readdirSync('/sys/devices/system/cpu')) {
      if (!/^cpu\d+$/.test(c)) continue;
      const v = Number(read(`/sys/devices/system/cpu/${c}/cpufreq/scaling_cur_freq`));
      if (Number.isFinite(v) && v > 0) { sum += v / 1000; n++; }
    }
  } catch { return null; }
  return n ? Math.round(sum / n) : null;
}

function loadAvg(): (number | null)[] {
  const t = read('/proc/loadavg');
  if (!t) return [null, null, null];
  const p = t.trim().split(/\s+/).map(Number);
  return [p[0] ?? null, p[1] ?? null, p[2] ?? null];
}

function processCount(): number | null {
  try { return fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).length; }
  catch { return null; }
}

export function collectCpu(): CpuSnapshot {
  const text = read('/proc/stat');
  const [l1, l5, l15] = loadAvg();
  const base: CpuSnapshot = {
    usage: null, perCore: [], freqMhz: cpuFreq(), tempC: cpuTemp(),
    load1: l1, load5: l5, load15: l15, processCount: processCount(),
  };
  if (!text) return base;
  const { total, cores } = parseProcStat(text);
  if (prevCpu && prevCpu.perCore.length === cores.length) {
    base.usage = cpuPct(prevCpu, total);
    base.perCore = cores.map((c, i) => cpuPct(prevCpu!.perCore[i], c));
  } else {
    base.perCore = cores.map(() => null);
  }
  prevCpu = { idle: total.idle, total: total.total, perCore: cores };
  return base;
}

// ---------- Memory ----------
export function parseMeminfo(text: string): MemSnapshot {
  const m = new Map<string, number>();
  for (const line of text.split('\n')) {
    const mm = line.match(/^(\w+):\s+(\d+)/);
    if (mm) m.set(mm[1], Number(mm[2]));
  }
  const total = m.get('MemTotal') ?? null;
  const avail = m.get('MemAvailable') ?? null;
  const used = total !== null && avail !== null ? total - avail : null;
  const swapTotal = m.get('SwapTotal') ?? null;
  const swapFree = m.get('SwapFree') ?? null;
  return {
    totalKb: total, availableKb: avail, usedKb: used,
    usedPct: total && used !== null ? (used / total) * 100 : null,
    cachedKb: m.get('Cached') ?? null, buffersKb: m.get('Buffers') ?? null,
    swapTotalKb: swapTotal, swapFreeKb: swapFree,
    swapUsedKb: swapTotal !== null && swapFree !== null ? swapTotal - swapFree : null,
  };
}

export function collectMem(): MemSnapshot {
  const t = read('/proc/meminfo');
  if (!t) return { totalKb: null, availableKb: null, usedKb: null, usedPct: null, cachedKb: null, buffersKb: null, swapTotalKb: null, swapFreeKb: null, swapUsedKb: null };
  return parseMeminfo(t);
}

// ---------- Filesystems ----------
export function collectFilesystems(): FsEntry[] {
  const out: FsEntry[] = [];
  const mounts = read('/proc/mounts');
  if (!mounts) return out;
  const seen = new Set<string>();
  try {
    // Use statvfs via shell-free approach: node has no statvfs, so parse `df -kP` once per tick (cheap, ~5s interval).
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const df = execFileSync('df', ['-kP', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'overlay'], { timeout: 5000, encoding: 'utf8' }) as string;
    for (const line of df.split('\n').slice(1)) {
      const p = line.trim().split(/\s+/);
      if (p.length < 6) continue;
      const [device, totalK, usedK, freeK, pct, mount] = p;
      if (seen.has(mount)) continue;
      seen.add(mount);
      const total = Number(totalK) * 1024, used = Number(usedK) * 1024, free = Number(freeK) * 1024;
      // Skip ephemeral/virtual mounts: noise, not storage the user manages.
      if (device.startsWith('/dev/loop') || mount.startsWith('/var/lib/snapd/snap')) continue;
      const fstype = mounts.split('\n').find((l) => l.split(/\s+/)[1] === mount)?.split(/\s+/)[2] || 'unknown';
      if (fstype === 'squashfs') continue;
      out.push({
        device, mount, fstype,
        totalBytes: total, usedBytes: used, freeBytes: free,
        usedPct: total ? (used / total) * 100 : null,
      });
    }
  } catch { /* df unavailable (minimal container) -> Unavailable handled by caller */ }
  return out;
}

// ---------- Disk + Net rates ----------
let prevDisk: { r: number; w: number; t: number } | null = null;
export function collectDiskIo(): DiskIo {
  const t = read('/proc/diskstats');
  if (!t) return { readBps: null, writeBps: null };
  let r = 0, w = 0;
  for (const line of t.split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p.length < 14) continue;
    const name = p[2];
    if (/^(loop|ram|dm-\d+$)/.test(name)) continue;
    if (/\d+$/.test(name) && !/^mmcblk|^nvme/.test(name)) continue; // skip partitions
    r += Number(p[5]) * 512; w += Number(p[9]) * 512;
  }
  const now = Date.now();
  let out: DiskIo = { readBps: null, writeBps: null };
  if (prevDisk) {
    const dt = (now - prevDisk.t) / 1000;
    if (dt > 0) out = { readBps: (r - prevDisk.r) / dt, writeBps: (w - prevDisk.w) / dt };
  }
  prevDisk = { r, w, t: now };
  return out;
}

// Pure helper so tests don't need sysfs. flags come from /sys/class/net/<name>.
export function classifyIface(name: string, flags: { wireless: boolean; hasDevice: boolean; devtype: string }): NetKind {
  if (flags.wireless || flags.devtype === 'wlan') return 'wifi';
  if (flags.hasDevice) return 'eth';
  if (/^(veth|docker|br-|virbr|tun|tap|wg|tailscale|zt|ppp|wwan|rmnet)/.test(name)) return 'virtual';
  return 'unknown';
}

let prevNet = new Map<string, { rx: number; tx: number; t: number }>();
export function collectNet(): NetIface[] {
  const dev = read('/proc/net/dev');
  const out: NetIface[] = [];
  if (!dev) return out;
  const now = Date.now();
  // MAC/operstate/speed come from sysfs. IPs intentionally left out: reading
  // them needs `ip` or parsing fib_trie every tick, not worth it here.
  for (const line of dev.split('\n')) {
    const m = line.match(/^\s*([^:]+):\s*(.+)$/);
    if (!m) continue;
    const name = m[1].trim();
    if (name === 'lo') continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    const [rxB, rxP, rxE, rxD, , , , , txB, txP, txE, txD] = f;
    const prev = prevNet.get(name);
    let rxBps: number | null = null, txBps: number | null = null;
    if (prev) {
      const dt = (now - prev.t) / 1000;
      if (dt > 0) { rxBps = Math.max(0, (rxB - prev.rx) / dt); txBps = Math.max(0, (txB - prev.tx) / dt); }
    }
    prevNet.set(name, { rx: rxB, tx: txB, t: now });
    const oper = read(`/sys/class/net/${name}/operstate`)?.trim();
    const mac = read(`/sys/class/net/${name}/address`)?.trim() || null;
    const speed = Number(read(`/sys/class/net/${name}/speed`));
    let kind: NetKind = 'unknown';
    try {
      const base = `/sys/class/net/${name}`;
      const wireless = fs.existsSync(`${base}/wireless`);
      let hasDevice = false;
      try { hasDevice = fs.statSync(base + '/device').isDirectory() || fs.statSync(base + '/device').isSymbolicLink(); } catch { /* no device link */ }
      const uevent = read(`${base}/uevent`) || '';
      const devtype = (uevent.match(/^DEVTYPE=(.*)$/m)?.[1] || '').trim();
      kind = classifyIface(name, { wireless, hasDevice, devtype });
    } catch { /* kind stays unknown */ }
    out.push({
      name, kind, up: oper === 'up', ipv4: null,
      mac, speedMb: Number.isFinite(speed) && speed > 0 ? speed : null,
      rxBps, txBps, rxBytes: rxB, txBytes: txB,
      rxPackets: rxP ?? null, txPackets: txP ?? null,
      rxErrors: rxE ?? null, txErrors: txE ?? null, rxDropped: rxD ?? null, txDropped: txD ?? null,
    });
  }
  return out;
}

// Default gateway from /proc/net/route (little-endian hex, flags & 2 == gateway).
export function parseRouteTable(text: string): string | null {
  for (const line of text.split('\n').slice(1)) {
    const p = line.trim().split(/\s+/);
    if (p.length < 4 || p[1] !== '00000000') continue;
    const flags = parseInt(p[3], 16);
    if (!(flags & 2)) continue;
    const gw = p[2].padStart(8, '0');
    const b = [6, 4, 2, 0].map((i) => parseInt(gw.slice(i, i + 2), 16));
    if (b.some((x) => !Number.isFinite(x))) continue;
    return b.join('.');
  }
  return null;
}

export function parseResolvConf(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*nameserver\s+(\S+)/);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out.slice(0, 3);
}

// Count established TCP connections (state 01) across v4/v6 tables.
export function countTcpEstablished(...tables: string[]): number | null {
  let total = 0, seen = false;
  for (const text of tables) {
    if (!text.includes('rem_address')) continue;
    seen = true;
    for (const line of text.split('\n').slice(1)) {
      const p = line.trim().split(/\s+/);
      if (p.length > 3 && p[3] === '01') total++;
    }
  }
  return seen ? total : null;
}

export function collectNetSummary(): NetSummary {
  return {
    gateway: parseRouteTable(read('/proc/net/route') || ''),
    dns: parseResolvConf(read('/etc/resolv.conf') || ''),
    tcpEstablished: countTcpEstablished(read('/proc/net/tcp') || '', read('/proc/net/tcp6') || ''),
  };
}

// ---------- Uptime ----------
export function collectUptime(): { uptimeSec: number | null; bootTime: string | null } {
  const t = read('/proc/uptime');
  if (!t) return { uptimeSec: null, bootTime: null };
  const up = Number(t.trim().split(/\s+/)[0]);
  if (!Number.isFinite(up)) return { uptimeSec: null, bootTime: null };
  return { uptimeSec: Math.floor(up), bootTime: new Date(Date.now() - up * 1000).toISOString() };
}

// ---------- Processes (top 30 by cpu) ----------
export function collectProcesses(): ProcInfo[] {
  const out: ProcInfo[] = [];
  let clk = 100, totalJiffies = 1, upSec = 0;
  try {
    const stat = read('/proc/stat');
    const up = read('/proc/uptime');
    if (stat && up) {
      upSec = Number(up.trim().split(/\s+/)[0]);
      const cpuLine = stat.split('\n').find((l) => l.startsWith('cpu '))!;
      totalJiffies = cpuLine.trim().split(/\s+/).slice(1).map(Number).reduce((a, b) => a + b, 0) || 1;
    }
  } catch { return out; }
  let pids: string[] = [];
  try { pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).slice(0, 400); } catch { return out; }
  try { clk = Number(require('node:child_process').execFileSync('getconf', ['CLK_TCK'], { timeout: 2000, encoding: 'utf8' }).trim()) || 100; } catch { clk = 100; }
  const memTotal = Number(read('/proc/meminfo')?.match(/^MemTotal:\s+(\d+)/m)?.[1] || 0);
  for (const pid of pids) {
    try {
      const st = read(`/proc/${pid}/stat`);
      const status = read(`/proc/${pid}/status`);
      if (!st || !status) continue;
      const m = st.match(/^(\d+) \((.+)\) (\w) /);
      if (!m) continue;
      const parts = st.slice(st.lastIndexOf(') ') + 2).trim().split(/\s+/);
      const utime = Number(parts[11]), stime = Number(parts[12]), starttime = Number(parts[19]);
      const rssPages = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] || read(`/proc/${pid}/statm`)?.split(/\s+/)[1] || 0);
      const uid = Number(status.match(/^Uid:\s+(\d+)/m)?.[1] || 0);
      const elapsed = Math.max(1, upSec - starttime / clk);
      const cpuPct = Math.min(100, ((utime + stime) / clk / elapsed) * 100);
      out.push({
        pid: Number(pid), name: m[2], user: String(uid),
        cpuPct: Number.isFinite(cpuPct) ? cpuPct : null,
        memPct: memTotal ? (rssPages / memTotal) * 100 : null,
        memKb: rssPages || null,
        uptimeSec: Math.floor(elapsed),
      });
    } catch { /* process vanished */ }
  }
  return out.sort((a, b) => (b.cpuPct || 0) - (a.cpuPct || 0)).slice(0, 30);
}

function sh(cmd: string, args: string[], timeoutMs = 8000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => resolve(err ? '' : stdout.toString()));
  });
}

// ---------- systemd ----------
export function parseSystemctlList(text: string): ServiceInfo[] {
  return text.split('\n').filter(Boolean).map((line) => {
    const [name, , active, , ...rest] = line.trim().split(/\s+/);
    return { name, description: rest.join(' ') || null, active: active || 'unknown', enabled: 'unknown', uptimeSec: null };
  }).filter((s) => s.name.endsWith('.service')).slice(0, 120);
}

export async function collectServices(): Promise<ServiceInfo[]> {
  const list = await sh('systemctl', ['list-units', '--type=service', '--all', '--no-legend', '--no-pager']);
  if (!list.trim()) return [];
  const units = parseSystemctlList(list);
  // enabled state, batched (one call)
  const enabledRaw = await sh('systemctl', ['list-unit-files', '--type=service', '--no-legend', '--no-pager']);
  const enabled = new Map<string, string>();
  for (const line of enabledRaw.split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p.length >= 2) enabled.set(p[0], p[1].replace(/;.*$/, ''));
  }
  for (const u of units) u.enabled = enabled.get(u.name) || 'unknown';
  return units;
}



// ---------- Logs ----------
export async function readLogs(source: string, service?: string, lines = 200): Promise<string[]> {
  if (source === 'system') {
    const out = await sh('journalctl', ['--no-pager', '-n', String(Math.min(lines, 500)), '--output=short-iso']);
    return out.trim() ? out.trim().split('\n').slice(-lines) : [];
  }
  if (source === 'service' && service && /^[a-zA-Z0-9@:_.-]+\.service$/.test(service)) {
    const out = await sh('journalctl', ['--no-pager', '-n', String(Math.min(lines, 500)), '--output=short-iso', '-u', service]);
    return out.trim() ? out.trim().split('\n').slice(-lines) : [];
  }
  return [];
}
