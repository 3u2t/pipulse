import type { CpuSnapshot, MemSnapshot, FsEntry, DiskIo, NetIface, ProcInfo, ServiceInfo } from '../shared/types.js';
import { collectCpu, collectMem, collectFilesystems, collectDiskIo, collectNet, collectUptime, collectProcesses, collectServices } from '../collectors/system.js';

export interface Snapshot {
  cpu: CpuSnapshot; mem: MemSnapshot; filesystems: FsEntry[]; diskIo: DiskIo;
  net: NetIface[]; processes: ProcInfo[]; services: ServiceInfo[];
  uptimeSec: number | null; bootTime: string | null;
}

export interface MonitoringProvider { name: 'real' | 'demo'; snapshot(): Promise<Snapshot>; }

export class RealMonitoringProvider implements MonitoringProvider {
  name = 'real' as const;
  async snapshot(): Promise<Snapshot> {
    const [services, up] = await Promise.all([collectServices().catch(() => [] as ServiceInfo[]), Promise.resolve(collectUptime())]);
    return {
      cpu: collectCpu(), mem: collectMem(), filesystems: collectFilesystems(),
      diskIo: collectDiskIo(), net: collectNet(), processes: collectProcesses(),
      services, uptimeSec: up.uptimeSec, bootTime: up.bootTime,
    };
  }
}

// Demo: believable random-walk values, clearly separated from production.
function walk(v: number, min: number, max: number, step: number): number {
  const n = v + (Math.random() - 0.5) * step;
  return Math.min(max, Math.max(min, n));
}
const d = { cpu: 17.2, temp: 44.1, mem: 43.5, rx: 31.4e6 / 8, tx: 6.2e6 / 8, read: 2e6, write: 1e6 };
const nowIso = () => new Date().toISOString();

export class DemoMonitoringProvider implements MonitoringProvider {
  name = 'demo' as const;
  async snapshot(): Promise<Snapshot> {
    d.cpu = walk(d.cpu, 8, 62, 6); d.temp = walk(d.temp, 41, 58, 1.2);
    d.mem = walk(d.mem, 34, 68, 2); d.rx = walk(d.rx, 0.5e6, 12e6, 2e6); d.tx = walk(d.tx, 0.2e6, 4e6, 1e6);
    const totalKb = 8 * 1024 * 1024;
    const usedKb = Math.round(totalKb * (d.mem / 100));
    return {
      cpu: { usage: +d.cpu.toFixed(1), perCore: [0, 1, 2, 3].map(() => +walk(d.cpu, 5, 80, 10).toFixed(1)), freqMhz: 1500, tempC: +d.temp.toFixed(1), load1: 0.72, load5: 0.61, load15: 0.55, processCount: 132 },
      mem: { totalKb, availableKb: totalKb - usedKb, usedKb, usedPct: +d.mem.toFixed(1), cachedKb: 512000, buffersKb: 64000, swapTotalKb: 102400, swapFreeKb: 98000, swapUsedKb: 4400 },
      filesystems: [{ device: '/dev/mmcblk0p2', mount: '/', fstype: 'ext4', totalBytes: 32e9, usedBytes: 32e9 * 0.46, freeBytes: 32e9 * 0.54, usedPct: 46.2 }],
      diskIo: { readBps: d.read, writeBps: d.write },
      net: [{ name: 'eth0', up: true, ipv4: '192.168.1.20', mac: '2c:cf:67:00:11:22', speedMb: 1000, rxBps: d.rx, txBps: d.tx, rxPackets: 900001, txPackets: 400002, rxErrors: 0, txErrors: 0, rxDropped: 1, txDropped: 0 }],
      processes: [
        { pid: 1, name: 'systemd', user: '0', cpuPct: 0.1, memPct: 0.4, memKb: 12000, uptimeSec: 90000 },
        { pid: 812, name: 'pipulse', user: '1000', cpuPct: 2.4, memPct: 1.1, memKb: 92000, uptimeSec: 80000 },
        { pid: 1204, name: 'casaos', user: '1000', cpuPct: 1.2, memPct: 2.3, memKb: 190000, uptimeSec: 79000 },
      ],
      services: [{ name: 'docker.service', description: 'Docker daemon', active: 'active', enabled: 'enabled', uptimeSec: 80000 }],
      uptimeSec: 90061, bootTime: new Date(Date.now() - 90061 * 1000).toISOString(),
    };
  }
}

export { nowIso };
