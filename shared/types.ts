// JSON shapes shared by frontend and backend. This file is the source of truth;
// copies live in backend/src/shared and frontend/src/shared because the two
// tsconfigs can't share a rootDir cleanly — keep them in sync with
// `npm run sync:shared`. The Go agent doesn't use these; it pushes raw JSON.

export interface CpuSnapshot {
  usage: number | null;          // overall %, 0-100
  perCore: (number | null)[];
  freqMhz: number | null;
  tempC: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  processCount: number | null;
}

export interface MemSnapshot {
  totalKb: number | null;
  availableKb: number | null;
  usedKb: number | null;
  usedPct: number | null;
  cachedKb: number | null;
  buffersKb: number | null;
  swapTotalKb: number | null;
  swapFreeKb: number | null;
  swapUsedKb: number | null;
}

export interface FsEntry {
  device: string;
  mount: string;
  fstype: string;
  totalBytes: number | null;
  usedBytes: number | null;
  freeBytes: number | null;
  usedPct: number | null;
}

export interface DiskIo { readBps: number | null; writeBps: number | null; }

export interface NetIface {
  name: string;
  up: boolean;
  ipv4: string | null;
  mac: string | null;
  speedMb: number | null;
  rxBps: number | null;
  txBps: number | null;
  rxPackets: number | null;
  txPackets: number | null;
  rxErrors: number | null;
  txErrors: number | null;
  rxDropped: number | null;
  txDropped: number | null;
}

export type ContainerState =
  | 'healthy' | 'running' | 'degraded' | 'restarting'
  | 'unhealthy' | 'stopped' | 'unknown';

export interface ContainerSummary {
  id: string;
  shortId: string;
  name: string;
  image: string;
  imageTag: string;
  status: string;                 // raw docker status string
  state: ContainerState;
  health: string | null;          // docker health status or null
  uptimeSec: number | null;
  restartCount: number;
  cpuPct: number | null;
  memBytes: number | null;
  memLimit: number | null;
  memPct: number | null;
  netRxBps: number | null;
  netTxBps: number | null;
  blkReadBps: number | null;
  blkWriteBps: number | null;
  pids: number | null;
  ports: string[];
  mounts: string[];
  restartPolicy: string;
  anomalies: { rule: string; reason: string }[];
  miningFlag: boolean;
  miningReason: string | null;
}

export interface ServiceInfo {
  name: string;
  description: string | null;
  active: string;                 // active, inactive, failed, ...
  enabled: string;                // enabled, disabled, static, ...
  uptimeSec: number | null;
}

export interface ProcInfo {
  pid: number;
  name: string;
  user: string;
  cpuPct: number | null;
  memPct: number | null;
  memKb: number | null;
  uptimeSec: number | null;
}

export interface AlertItem {
  id: number;
  key: string;
  severity: 'info' | 'warning' | 'critical';
  component: string;
  message: string;
  status: 'active' | 'acknowledged' | 'resolved';
  createdAt: string;
  resolvedAt: string | null;
}

export interface WsPayload {
  ts: string;
  cpu: CpuSnapshot;
  mem: MemSnapshot;
  filesystems: FsEntry[];
  diskIo: DiskIo;
  net: NetIface[];
  docker: { available: boolean; running: number; stopped: number; containers: ContainerSummary[] };
  services: ServiceInfo[];
  processes: ProcInfo[];
  alerts: AlertItem[];
  agent: { connected: boolean; lastSeen: string | null; hostname: string | null; version: string | null };
  uptimeSec: number | null;
  bootTime: string | null;
}

export interface SmartAttribute {
  id: number; name: string; value: number | null; worst: number | null;
  thresh: number | null; raw: number | null;
}

export type SmartOverall = 'healthy' | 'warning' | 'critical' | 'unavailable';

export interface SmartDrive {
  device: string;
  model: string | null;
  serial: string | null;
  firmware: string | null;
  capacityBytes: number | null;
  interface: string | null;
  usbBridge: boolean;
  tempC: number | null;
  health: 'pass' | 'fail' | 'unknown';
  overall: SmartOverall;
  powerOnHours: number | null;
  powerCycles: number | null;
  reallocated: number | null;
  pending: number | null;
  offlineUncorrectable: number | null;
  reportedUncorrectable: number | null;
  errorCount: number | null;
  selftest: string | null;
  attributes: SmartAttribute[];
  warnings: string[];
  unavailableReason: string | null;
  source: 'local' | 'agent';
}

export interface SmartResult {
  tool: 'ok' | 'missing' | 'denied';
  drives: SmartDrive[];
}
