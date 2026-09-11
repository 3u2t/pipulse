import { describe, it, expect, beforeAll } from 'vitest';
import { parseProcStat, cpuPct, parseMeminfo, parseSystemctlList } from './collectors/system.js';
import { deriveState, detectMining, flagAnomalies } from './docker/containers.js';
import { parseSmartJson, deriveHealth, parseScanOpen, mergeAgentSmart, _resetSmartCache } from './collectors/smart.js';
import { openDb } from './db/db.js';
import { evaluateAlerts, listAlerts } from './alerts/alerts.js';

describe('proc stat', () => {
  it('computes usage between two samples', () => {
    const a = parseProcStat('cpu  100 0 50 800 50 0 0\n');
    const b = parseProcStat('cpu  150 0 75 900 50 0 0\n');
    const pct = cpuPct(a.total, b.total)!;
    expect(pct).toBeGreaterThan(0);
    expect(pct).toBeLessThanOrEqual(100);
  });
  it('parses per-core lines', () => {
    const { cores } = parseProcStat('cpu  100 0 50 800 50 0 0\ncpu0 50 0 25 400 25 0 0\ncpu1 50 0 25 400 25 0 0\n');
    expect(cores).toHaveLength(2);
  });
});

describe('meminfo', () => {
  it('derives used + pct', () => {
    const m = parseMeminfo('MemTotal:        8000000 kB\nMemAvailable:    4000000 kB\nBuffers:            64000 kB\nCached:            500000 kB\nSwapTotal:         102400 kB\nSwapFree:          102400 kB\n');
    expect(m.usedKb).toBe(4000000);
    expect(m.usedPct).toBeCloseTo(50);
  });
});

describe('systemctl', () => {
  it('parses list-units output', () => {
    const u = parseSystemctlList('docker.service loaded active running Docker daemon\ncron.service loaded active running cron\n');
    expect(u.map((x) => x.name)).toEqual(['docker.service', 'cron.service']);
  });
});

describe('docker state', () => {
  it('maps health + restart count', () => {
    expect(deriveState({ State: 'running' }, { State: { Status: 'running', Health: { Status: 'healthy' } } }, 0).state).toBe('healthy');
    expect(deriveState({ State: 'running' }, { State: { Status: 'running', Health: { Status: 'unhealthy' } } }, 0).state).toBe('unhealthy');
    expect(deriveState({ State: 'running' }, { State: { Status: 'running' } }, 7).state).toBe('degraded');
    expect(deriveState({ State: 'exited' }, null, 0).state).toBe('stopped');
  });
  it('flags mining by image metadata only', () => {
    expect(detectMining('miner', 'xmrig/xmrig:latest', '')).toContain('Possible mining');
    expect(detectMining('web', 'nginx:alpine', '')).toBeNull();
  });
  it('flags anomalies with reasons', () => {
    const flags = flagAnomalies({ cpuPct: 95, memPct: 10, restartCount: 0, health: null, state: 'running' } as never, { cpu: [], memPct: [] });
    expect(flags[0].rule).toBe('high-cpu');
    expect(flags[0].reason).toMatch(/90%/);
  });
});

const wdUsb = (over: Record<string, number> = {}) => ({
  device: { name: '/dev/sda', type: 'sat', protocol: 'USB' },
  model_name: 'WDC WD40NDZW-11A8JS1',
  serial_number: 'WX72D31N9X4E',
  firmware_version: '01.01A01',
  user_capacity: { bytes: 4000787030016 },
  temperature: { current: 41 },
  smart_status: { passed: true },
  power_on_time: { hours: 12345 },
  ata_smart_attributes: { table: [
    { id: 5, name: 'Reallocated_Sector_Ct', value: 100, worst: 100, thresh: 10, raw: { value: over.reallocated ?? 0 } },
    { id: 9, name: 'Power_On_Hours', value: 78, worst: 78, thresh: 0, raw: { value: 12345 } },
    { id: 12, name: 'Power_Cycle_Count', value: 100, worst: 100, thresh: 0, raw: { value: 312 } },
    { id: 194, name: 'Temperature_Celsius', value: 110, worst: 95, thresh: 0, raw: { value: 41 } },
    { id: 197, name: 'Current_Pending_Sector', value: 100, worst: 100, thresh: 0, raw: { value: over.pending ?? 0 } },
    { id: 198, name: 'Offline_Uncorrectable', value: 100, worst: 100, thresh: 0, raw: { value: over.offline ?? 0 } },
  ] },
  ata_smart_error_log: { summary: { count: over.errors ?? 0 } },
});

describe('smart', () => {
  it('parses scan + sysfs helpers', () => {
    expect(parseScanOpen('/dev/sda -d sat # /dev/sda [USB]\n/dev/nvme0 -d nvme\n')).toEqual(['/dev/sda', '/dev/nvme0']);
  });
  it('parses a USB HDD document', () => {
    const d = parseSmartJson(wdUsb(), '/dev/sda', 'local')!;
    expect(d.model).toMatch(/WD40/);
    expect(d.serial).toBe('WX72D31N9X4E');
    expect(d.tempC).toBe(41);
    expect(d.powerOnHours).toBe(12345);
    expect(d.powerCycles).toBe(312);
    expect(d.usbBridge).toBe(true);
    expect(d.health).toBe('pass');
  });
  it('healthy drive with zero counts', () => {
    const d = parseSmartJson(wdUsb(), '/dev/sda', 'local')!;
    deriveHealth(d, { warn: 50, crit: 60 });
    expect(d.overall).toBe('healthy');
    expect(d.warnings).toEqual([]);
  });
  it('pending sectors -> warning with message', () => {
    const d = parseSmartJson(wdUsb({ pending: 4 }), '/dev/sda', 'local')!;
    deriveHealth(d, { warn: 50, crit: 60 });
    expect(d.overall).toBe('warning');
    expect(d.warnings[0]).toMatch(/4 pending sectors/);
  });
  it('12 reallocated -> critical', () => {
    const d = parseSmartJson(wdUsb({ reallocated: 12 }), '/dev/sda', 'local')!;
    deriveHealth(d, { warn: 50, crit: 60 });
    expect(d.overall).toBe('critical');
    expect(d.warnings[0]).toMatch(/12 reallocated sectors/);
  });
  it('failed self-assessment -> critical even with zero counts', () => {
    const doc = wdUsb() as Record<string, unknown>;
    (doc.smart_status as { passed: boolean }).passed = false;
    const d = parseSmartJson(doc, '/dev/sda', 'local')!;
    deriveHealth(d, { warn: 50, crit: 60 });
    expect(d.overall).toBe('critical');
  });
  it('high temp flags warning', () => {
    const doc = wdUsb() as Record<string, unknown>;
    (doc.temperature as { current: number }).current = 52;
    const d = parseSmartJson(doc, '/dev/sda', 'local')!;
    deriveHealth(d, { warn: 50, crit: 60 });
    expect(d.overall).toBe('warning');
    expect(d.warnings.join(' ')).toMatch(/52°C/);
  });
  it('merges agent docs, skips garbage', () => {
    const docs = [JSON.stringify(wdUsb()), 'not json'];
    const out = mergeAgentSmart(docs);
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('agent');
  });
  it('emits smart alerts, never for unavailable', () => {
    openDb('/tmp/pipulse-test-' + process.pid);
    _resetSmartCache();
    const bad = parseSmartJson(wdUsb({ pending: 4 }), '/dev/sda', 'local')!;
    deriveHealth(bad, { warn: 50, crit: 60 });
    const gone = parseSmartJson(wdUsb(), '/dev/sdb', 'local')!;
    gone.overall = 'unavailable';
    gone.unavailableReason = 'SMART unavailable through this USB connection';
    evaluateAlerts({ cpu: { usage: 10, tempC: 40 }, mem: { usedPct: 40 }, filesystems: [] }, true, [bad, gone]);
    const msgs = listAlerts('active').map((a) => a.message);
    expect(msgs.some((m) => /SMART warning.*4 pending sectors/.test(m))).toBe(true);
    expect(msgs.some((m) => /sdb/.test(m))).toBe(false);
  });
});

describe('resolveInterval', () => {
  it('clamps and falls back', async () => {
    const { resolveInterval } = await import('./ws/hub.js');
    expect(resolveInterval(5000, '5000')).toBe(5000);
    expect(resolveInterval(5000, '100')).toBe(1000);
    expect(resolveInterval(5000, '999999')).toBe(60000);
    expect(resolveInterval(5000, 'junk')).toBe(5000);
    expect(resolveInterval(5000, '')).toBe(5000);
  });
});

describe('smart agent fallback', () => {
  it('uses agent data even without local smartctl', async () => {
    const smart = await import('./collectors/smart.js');
    const { _setAgentPush } = await import('./agent/agent.js');
    openDb('/tmp/pipulse-test-' + process.pid);
    smart._resetSmartCache();
    _setAgentPush(Date.now(), { smart: [JSON.stringify(wdUsb({ pending: 4 }))] });
    const oldPath = process.env.PATH;
    process.env.PATH = '/nonexistent-dir-xyz';
    try {
      const r = await smart.collectSmart({ warn: 50, crit: 60 });
      expect(r.tool).toBe('ok');
      expect(r.drives.some((d) => d.device === '/dev/sda' && d.overall === 'warning')).toBe(true);
    } finally {
      process.env.PATH = oldPath;
      smart._resetSmartCache();
    }
  });
});
