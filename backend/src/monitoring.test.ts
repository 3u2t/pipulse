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
    evaluateAlerts({ cpu: { usage: 10, tempC: 40 }, mem: { usedPct: 40 }, filesystems: [] }, [{ id: 'a', hostname: 'pi', connected: true }], [bad, gone]);
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

describe('network detail', () => {
  it('classifies interfaces', async () => {
    const { classifyIface } = await import('./collectors/system.js');
    expect(classifyIface('wlan0', { wireless: true, hasDevice: true, devtype: '' })).toBe('wifi');
    expect(classifyIface('wlp3s0', { wireless: false, hasDevice: true, devtype: 'wlan' })).toBe('wifi');
    expect(classifyIface('eth0', { wireless: false, hasDevice: true, devtype: '' })).toBe('eth');
    expect(classifyIface('vethabc123', { wireless: false, hasDevice: false, devtype: '' })).toBe('virtual');
    expect(classifyIface('docker0', { wireless: false, hasDevice: false, devtype: 'bridge' })).toBe('virtual');
    expect(classifyIface('enp1s0', { wireless: false, hasDevice: false, devtype: '' })).toBe('unknown');
  });
  it('parses the default gateway (little-endian hex)', async () => {
    const { parseRouteTable } = await import('./collectors/system.js');
    const table = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n' +
      'eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\n' +
      'eth0\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0\n';
    expect(parseRouteTable(table)).toBe('192.168.1.1');
    expect(parseRouteTable('Iface\tDestination\tGateway\n')).toBe(null);
  });
  it('parses resolv.conf nameservers', async () => {
    const { parseResolvConf } = await import('./collectors/system.js');
    expect(parseResolvConf('# comment\nnameserver 192.168.1.1\nnameserver 9.9.9.9\nsearch lan\n')).toEqual(['192.168.1.1', '9.9.9.9']);
  });
  it('counts established TCP connections', async () => {
    const { countTcpEstablished } = await import('./collectors/system.js');
    const tcp = '  sl  local_address rem_address   st\n' +
      '   0: 0100007F:1F90 00000000:0000 0A\n' +
      '   1: 4D01A8C0:01BB 8E01A8C0:C6E2 01\n' +
      '   2: 4D01A8C0:01BB 8F01A8C0:D3C8 01\n' +
      '   3: 4D01A8C0:01BB 00000000:0000 0A\n';
    expect(countTcpEstablished(tcp, '')).toBe(2);
    expect(countTcpEstablished('', '')).toBe(null);
  });
});

describe('history bucketing', () => {
  it('averages raw samples into buckets', async () => {
    const { openDb, getDb } = await import('./db/db.js');
    const { queryHistory } = await import('./db/history.js');
    openDb('/tmp/pipulse-test-' + process.pid);
    const db = getDb();
    db.prepare('DELETE FROM metrics WHERE kind=? AND ref=?').run('host', 'buck-test');
    const now = Date.now();
    const ins = db.prepare('INSERT INTO metrics(ts,kind,ref,cpu,mem_pct) VALUES(?,?,?,?,?)');
    for (let i = 0; i < 120; i++) ins.run(now - (119 - i) * 5000, 'host', 'buck-test', 10 + (i % 10), 50);
    const r = queryHistory('host', 'buck-test', 0.2, 10);
    expect(r.total).toBe(120);
    expect(r.points.length).toBeLessThanOrEqual(10);
    expect(r.points.length).toBeGreaterThan(0);
    expect(r.bucketSec).toBe(72);
    expect(r.points[0].n).toBeGreaterThan(1);
    expect(r.points[0].cpu).toBeGreaterThanOrEqual(10);
    db.prepare('DELETE FROM metrics WHERE kind=? AND ref=?').run('host', 'buck-test');
  });
  it('returns empty shape when there is nothing', async () => {
    const { openDb } = await import('./db/db.js');
    const { queryHistory } = await import('./db/history.js');
    openDb('/tmp/pipulse-test-' + process.pid);
    const r = queryHistory('host', 'nope-missing', 1, 100);
    expect(r).toEqual({ points: [], bucketSec: expect.any(Number), total: 0 });
  });
});

describe('notifications', () => {
  it('sends webhooks once per firing, then on resolve', async () => {
    const { openDb, getDb, setSetting } = await import('./db/db.js');
    const notify = await import('./notify/notify.js');
    openDb('/tmp/pipulse-test-' + process.pid);
    const received: { url: string; body: string }[] = [];
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      let buf = '';
      req.on('data', (c) => { buf += c; });
      req.on('end', () => { received.push({ url: req.url || '', body: buf }); res.end('ok'); });
    });
    await new Promise<void>((res) => server.listen(0, res));
    const port = (server.address() as { port: number }).port;
    const db = getDb();
    try {
      setSetting('notify_webhook_url', `http://127.0.0.1:${port}/hook`);
      setSetting('notify_events', 'critical,warning,resolved');
      setSetting('notify_smtp_to', '');
      db.prepare('DELETE FROM notified_keys WHERE key LIKE ?').run('nt-%');
      const alert = (sev: 'critical' | 'warning') => ({ id: 1, key: 'nt-disk', severity: sev, component: 'storage', message: 'disk full', status: 'active' as const, createdAt: '', resolvedAt: null });
      await notify.reconcileNotifications([alert('warning')], 'testpi', false);
      await notify.reconcileNotifications([alert('warning')], 'testpi', false);
      expect(received).toHaveLength(1);
      expect(JSON.parse(received[0].body).event).toBe('firing');
      await notify.reconcileNotifications([alert('critical')], 'testpi', false);
      expect(received).toHaveLength(2);
      await notify.reconcileNotifications([], 'testpi', false);
      expect(received).toHaveLength(3);
      expect(JSON.parse(received[2].body).event).toBe('resolved');
      await notify.reconcileNotifications([], 'testpi', false);
      expect(received).toHaveLength(3);
      const log = notify.listNotifications();
      expect(log.some((l) => l.kind === 'webhook' && l.status === 'sent')).toBe(true);
    } finally {
      server.close();
      db.prepare('DELETE FROM notified_keys WHERE key LIKE ?').run('nt-%');
      setSetting('notify_webhook_url', '');
      setSetting('notify_events', 'critical,warning');
    }
  });
  it('delivers mail through a fake SMTP server', async () => {
    const notify = await import('./notify/notify.js');
    const { createServer } = await import('node:net');
    const got: string[] = [];
    const server = createServer((sock) => {
      let buf = '';
      let authed = 0; // 0 none, 1 user asked, 2 pass asked
      let inData = false;
      sock.write('220 fake ESMTP\r\n');
      sock.on('data', (chunk) => {
        buf += chunk.toString();
        for (;;) {
          const i = buf.indexOf('\r\n');
          if (i < 0) break;
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          got.push(line);
          if (inData) {
            if (line === '.') { inData = false; sock.write('250 queued\r\n'); }
            continue;
          }
          if (/^EHLO/.test(line)) sock.write('250-fake\r\n250 AUTH LOGIN\r\n');
          else if (/^AUTH LOGIN/.test(line)) { authed = 1; sock.write('334 VXNlcm5hbWU6\r\n'); }
          else if (authed === 1) { authed = 2; sock.write('334 UGFzc3dvcmQ6\r\n'); }
          else if (authed === 2) { authed = 0; sock.write('235 ok\r\n'); }
          else if (/^MAIL FROM/.test(line)) sock.write('250 ok\r\n');
          else if (/^RCPT TO/.test(line)) sock.write('250 ok\r\n');
          else if (/^DATA/.test(line)) { inData = true; sock.write('354 go\r\n'); }
          else if (/^QUIT/.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
        }
      });
    });
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
    const port = (server.address() as { port: number }).port;
    try {
      await notify.sendEmail({ host: '127.0.0.1', port, user: 'u', pass: 'p', from: 'pipulse@lan', tls: 'off', timeoutMs: 5000 }, 'me@lan', 'hi', 'body here');
      expect(got.some((l) => l.startsWith('MAIL FROM'))).toBe(true);
      expect(got.some((l) => l.startsWith('RCPT TO:<me@lan>'))).toBe(true);
    } finally {
      server.close();
    }
  });
  it('skips everything in demo mode', async () => {
    const notify = await import('./notify/notify.js');
    await notify.reconcileNotifications([{ id: 1, key: 'nt-x', severity: 'critical', component: 'c', message: 'm', status: 'active', createdAt: '', resolvedAt: null }], 'testpi', true);
    const log = notify.listNotifications();
    expect(log.some((l) => l.title === 'm')).toBe(false);
  });
});

describe('multi-server', () => {
  it('tracks one node per agent and alerts each disconnect separately', async () => {
    const { openDb, getDb } = await import('./db/db.js');
    const agent = await import('./agent/agent.js');
    const { evaluateAlerts, evaluateNodeAlerts, listAlerts } = await import('./alerts/alerts.js');
    openDb('/tmp/pipulse-test-' + process.pid);
    agent._clearAgentPushes();
    const db = getDb();
    db.prepare('DELETE FROM agent WHERE id LIKE ?').run('ms-%');
    const now = Date.now();
    db.prepare("INSERT INTO agent(id,hostname,arch,version,last_seen) VALUES(?,?,?,?,datetime('now'))").run('ms-a', 'pia', 'arm64', '0.1.0');
    db.prepare("INSERT INTO agent(id,hostname,arch,version,last_seen) VALUES(?,?,?,?,datetime('now','-1 hour'))").run('ms-b', 'pib', 'arm64', '0.1.0');
    agent._setAgentPush(now, { agentId: 'ms-a', hostname: 'pia', metrics: { cpuUsage: 95, tempC: 40, memUsedKb: 4000, memTotalKb: 8000, uptimeSec: 100 } }, 'ms-a');
    const nodes = agent.agentNodes(5000);
    expect(nodes).toHaveLength(2);
    expect(nodes.find((n) => n.id === 'ms-a')).toMatchObject({ hostname: 'pia', connected: true, cpuUsage: 95, memPct: 50 });
    expect(nodes.find((n) => n.id === 'ms-b')?.connected).toBe(false);
    evaluateAlerts({ cpu: { usage: 10, tempC: 40 }, mem: { usedPct: 40 }, filesystems: [] }, nodes.map((n) => ({ id: n.id, hostname: n.hostname, connected: n.connected })), []);
    evaluateNodeAlerts(nodes.filter((n) => n.connected));
    const msgs = listAlerts('active').map((a) => a.message);
    expect(msgs.some((m) => /agent on pib disconnected/.test(m))).toBe(true);
    expect(msgs.some((m) => /CPU usage on pia is 95%/.test(m))).toBe(true);
    db.prepare('DELETE FROM agent WHERE id LIKE ?').run('ms-%');
    agent._clearAgentPushes();
  });
});
