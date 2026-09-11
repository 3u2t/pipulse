import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { getAgentPush } from '../agent/agent.js';
import type { SmartAttribute, SmartDrive, SmartOverall, SmartResult } from '../shared/types.js';

// smartctl is slow and wakes drives; cache results for 5 minutes.
const CACHE_TTL = 5 * 60 * 1000;
let cache: { ts: number; result: SmartResult } | null = null;
let toolCache: { ts: number; present: boolean } | null = null;

function sh(cmd: string, args: string[], timeoutMs = 15000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number'
        ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, out: stdout.toString(), err: stderr.toString() });
    });
  });
}

async function smartctlPresent(): Promise<boolean> {
  if (toolCache && Date.now() - toolCache.ts < CACHE_TTL) return toolCache.present;
  // ENOENT surfaces as code 1 with empty output here; double-check via --version text.
  const r = await sh('smartctl', ['--version'], 5000);
  const present = r.out.toLowerCase().includes('smartctl');
  toolCache = { ts: Date.now(), present };
  return present;
}

export function parseScanOpen(text: string): string[] {
  const devs: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^(\/dev\/[a-zA-Z0-9/_-]+)\s/);
    if (m && !devs.includes(m[1])) devs.push(m[1]);
  }
  return devs.slice(0, 8);
}

// Physical disk candidates from sysfs (covers USB-attached sd* too).
export function sysBlockCandidates(): string[] {
  try {
    return fs.readdirSync('/sys/block')
      .filter((d) => /^(sd[a-z]+|hd[a-z]+|nvme\d+n\d+)$/.test(d))
      .map((d) => `/dev/${d}`)
      .slice(0, 8);
  } catch { return []; }
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function attrRaw(a: { raw?: { value?: unknown; string?: unknown } }): number | null {
  if (a.raw && typeof a.raw.value === 'number') return a.raw.value;
  const n = Number(String(a.raw?.string ?? '').split(/\s+/)[0]);
  return Number.isFinite(n) ? n : null;
}

function findAttr(table: any[], ...names: string[]): number | null {
  for (const n of names) {
    const hit = table.find((a) => a.name === n);
    if (hit) return attrRaw(hit);
  }
  return null;
}

// Parse one `smartctl -j` document. Exported for tests and agent-merge reuse.
export function parseSmartJson(doc: any, device: string, source: 'local' | 'agent'): SmartDrive | null {
  if (!doc || typeof doc !== 'object') return null;
  const table: any[] = doc.ata_smart_attributes?.table || [];
  const nvme = doc.nvme_smart_health_information_log;
  const model = doc.model_name || doc.model_family || doc.scsi_model_name || null;
  const serial = doc.serial_number || doc.scsi_serial_number || null;

  let tempC: number | null = num(doc.temperature?.current);
  if (tempC === null && nvme) tempC = num(nvme.temperature);
  if (tempC === null) tempC = findAttr(table, 'Temperature_Celsius', 'Temperature_Internal', 'Airflow_Temperature_Cel');
  // NVMe reports Kelvin.
  if (tempC !== null && nvme && tempC > 200) tempC = Math.round(tempC - 273.15);

  const passed = doc.smart_status?.passed;
  const health: SmartDrive['health'] = passed === true ? 'pass' : passed === false ? 'fail' : 'unknown';
  const type: string = doc.device?.type || '';
  const drive: SmartDrive = {
    device,
    model, serial,
    firmware: doc.firmware_version || null,
    capacityBytes: num(doc.user_capacity?.bytes),
    interface: type || null,
    usbBridge: /usb/i.test(type) || /usb/i.test(doc.device?.protocol || ''),
    tempC,
    health,
    overall: 'unavailable',
    powerOnHours: num(doc.power_on_time?.hours) ?? findAttr(table, 'Power_On_Hours'),
    powerCycles: findAttr(table, 'Power_Cycle_Count'),
    reallocated: findAttr(table, 'Reallocated_Sector_Ct'),
    pending: findAttr(table, 'Current_Pending_Sector'),
    offlineUncorrectable: findAttr(table, 'Offline_Uncorrectable'),
    reportedUncorrectable: findAttr(table, 'Reported_Uncorrect', 'Reported_Uncorrectable_Errors'),
    errorCount: num(doc.ata_smart_error_log?.summary?.count),
    selftest: null,
    attributes: table.slice(0, 40).map((a) => ({
      id: num(a.id) || 0, name: String(a.name || ''), value: num(a.value),
      worst: num(a.worst), thresh: num(a.thresh), raw: attrRaw(a),
    })),
    warnings: [],
    unavailableReason: null,
    source,
  };
  if (nvme) {
    if (drive.powerOnHours === null) drive.powerOnHours = num(nvme.power_on_hours);
    if (drive.powerCycles === null) drive.powerCycles = num(nvme.power_cycles);
    drive.errorCount = num(nvme.media_errors) ?? drive.errorCount;
  }
  const log = doc.ata_smart_self_test_log?.standard?.table;
  if (Array.isArray(log) && log.length) {
    const last = log[0];
    drive.selftest = last?.status?.string
      ? `${last.status.string}${last.lifetime_hours ? ` (${last.lifetime_hours}h)` : ''}`
      : null;
  }
  if (!drive.model && drive.health === 'unknown' && drive.attributes.length === 0 && drive.tempC === null) {
    drive.overall = 'unavailable';
    drive.unavailableReason = 'smartctl returned no readable data for this device (unsupported drive, blocked USB bridge, or no permission).';
  } else {
    // Provisional — deriveHealth() finalizes after evaluating real attributes.
    drive.overall = 'healthy';
  }
  return drive;
}

export interface DriveTempThresholds { warn: number; crit: number; }

// Never call a drive healthy just because smartctl exited 0 — evaluate the data.
export function deriveHealth(d: SmartDrive, t: DriveTempThresholds): void {
  d.warnings = [];
  if (d.health === 'fail') {
    d.overall = 'critical';
    d.warnings.push('SMART overall-health self-assessment reported FAILURE.');
    return;
  }
  let level: SmartOverall = 'healthy';
  const flag = (sev: 'warning' | 'critical', msg: string) => {
    d.warnings.push(msg);
    if (sev === 'critical') level = 'critical';
    else if (level !== 'critical') level = 'warning';
  };
  if (d.reallocated !== null && d.reallocated > 0) {
    flag(d.reallocated >= 10 ? 'critical' : 'warning',
      d.reallocated >= 10 ? `SMART critical: ${d.reallocated} reallocated sectors` : `SMART warning: ${d.reallocated} reallocated sectors`);
  }
  if (d.pending !== null && d.pending > 0) flag('warning', `SMART warning: ${d.pending} pending sectors`);
  if (d.offlineUncorrectable !== null && d.offlineUncorrectable > 0) {
    flag(d.offlineUncorrectable >= 10 ? 'critical' : 'warning',
      `SMART warning: ${d.offlineUncorrectable} offline uncorrectable sectors`);
  }
  if (d.reportedUncorrectable !== null && d.reportedUncorrectable > 0) {
    flag('warning', `SMART warning: ${d.reportedUncorrectable} reported uncorrectable errors`);
  }
  if (d.errorCount !== null && d.errorCount > 0) flag('warning', `SMART error log holds ${d.errorCount} entries`);
  if (d.tempC !== null) {
    if (d.tempC >= t.crit) flag('critical', `Drive temperature is critical: ${d.tempC.toFixed(0)}°C`);
    else if (d.tempC >= t.warn) flag('warning', `Drive temperature is high: ${d.tempC.toFixed(0)}°C`);
  }
  d.overall = level;
}

function denied(text: string): boolean {
  return /permission denied|operation not permitted|must be root|requires root/i.test(text);
}

async function readDrive(device: string): Promise<SmartDrive | null> {
  // Normal detection first; SAT fallback for common USB/SATA bridges.
  for (const dtype of [null, 'sat']) {
    const args = dtype ? ['-j', '-H', '-A', '-i', '-d', dtype, device] : ['-j', '-H', '-A', '-i', device];
    const r = await sh('smartctl', args);
    if (r.out.trim().startsWith('{')) {
      try {
        const drive = parseSmartJson(JSON.parse(r.out), device, 'local');
        if (drive) {
          if (dtype) drive.usbBridge = true;
          return drive;
        }
      } catch { /* fall through to retry/unavailable */ }
    }
    if (denied(r.out + r.err)) {
      return {
        device, model: null, serial: null, firmware: null, capacityBytes: null, interface: null,
        usbBridge: false, tempC: null, health: 'unknown', overall: 'unavailable',
        powerOnHours: null, powerCycles: null, reallocated: null, pending: null,
        offlineUncorrectable: null, reportedUncorrectable: null, errorCount: null,
        selftest: null, attributes: [], warnings: [],
        unavailableReason: 'Permission denied reading SMART data. The collector needs read access to the drive device — see docs/smart.md.',
        source: 'local',
      };
    }
    if (/unknown usb bridge|unable to detect device type/i.test(r.out + r.err) && !dtype) continue;
    if (dtype) break;
    // Non-USB failure on plain attempt and device is not USB-ish: stop retrying.
    if (!/usb/i.test(r.out + r.err)) break;
  }
  return {
    device, model: null, serial: null, firmware: null, capacityBytes: null, interface: null,
    usbBridge: /sd[a-z]+$/.test(device), tempC: null, health: 'unknown', overall: 'unavailable',
    powerOnHours: null, powerCycles: null, reallocated: null, pending: null,
    offlineUncorrectable: null, reportedUncorrectable: null, errorCount: null,
    selftest: null, attributes: [], warnings: [],
    unavailableReason: 'SMART unavailable through this USB connection — this USB/SATA bridge does not pass SMART commands through. The drive itself may be fine.',
    source: 'local',
  };
}

// Fresh host-agent SMART docs with health already evaluated.
export function agentDrives(temp: DriveTempThresholds = { warn: 50, crit: 60 }): SmartDrive[] {
  try {
    const push = getAgentPush();
    const fresh = push && Date.now() - push.ts < 5 * 60 * 1000;
    const docs = fresh && Array.isArray((push.body as { smart?: unknown }).smart)
      ? (push.body as { smart: string[] }).smart : null;
    if (!docs) return [];
    const out = mergeAgentSmart(docs);
    for (const d of out) if (!d.unavailableReason) deriveHealth(d, temp);
    return out;
  } catch { return []; }
}

// Agent-provided smartctl JSON documents (collected on the host as root).
export function mergeAgentSmart(docs: string[]): SmartDrive[] {
  const out: SmartDrive[] = [];
  for (const raw of docs.slice(0, 8)) {
    try {
      const doc = JSON.parse(raw);
      const dev = String(doc.device?.name || '');
      const d = parseSmartJson(doc, dev || 'agent-drive', 'agent');
      if (d) out.push(d);
    } catch { /* ignore one bad doc */ }
  }
  return out;
}

export async function collectSmart(temp: DriveTempThresholds = { warn: 50, crit: 60 }): Promise<SmartResult> {
  // Fresh agent data invalidates the cache — new drives should show up promptly.
  const pushTs = (() => { try { return getAgentPush()?.ts || 0; } catch { return 0; } })();
  if (cache && Date.now() - cache.ts < CACHE_TTL && pushTs <= cache.ts) return cache.result;

  // Host-agent data first: the agent runs on the host as root (has smartctl
  // and device access) while the backend itself may run in a minimal
  // container without either. A missing local smartctl must not hide
  // working agent data.
  let drives = agentDrives(temp);

  if (!(await smartctlPresent())) {
    if (drives.length > 0) {
      const result: SmartResult = { tool: 'ok', drives };
      cache = { ts: Date.now(), result };
      return result;
    }
    const result: SmartResult = { tool: 'missing', drives: [] };
    cache = { ts: Date.now(), result };
    return result;
  }

  const localDevs = new Set<string>();
  try {
    const scan = await sh('smartctl', ['--scan-open'], 10000);
    for (const d of parseScanOpen(scan.out)) localDevs.add(d);
  } catch { /* ignore */ }
  for (const d of sysBlockCandidates()) localDevs.add(d);
  const have = new Set(drives.map((d) => d.device));
  for (const dev of [...localDevs].filter((d) => !have.has(d)).slice(0, 6)) {
    const d = await readDrive(dev);
    if (d) drives.push(d);
  }

  let deniedAll = drives.length > 0;
  for (const d of drives) {
    if (!d.unavailableReason) {
      deriveHealth(d, temp);
      deniedAll = false;
    } else if (!/permission denied/i.test(d.unavailableReason)) {
      deniedAll = false;
    }
  }
  const result: SmartResult = { tool: deniedAll ? 'denied' : 'ok', drives };
  cache = { ts: Date.now(), result };
  return result;
}

// Test hook.
export function _resetSmartCache(): void { cache = null; toolCache = null; }
