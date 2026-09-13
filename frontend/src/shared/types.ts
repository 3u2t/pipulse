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

export type NetKind = 'eth' | 'wifi' | 'virtual' | 'unknown';

export interface NetIface {
  name: string;
  kind: NetKind;
  up: boolean;
  ipv4: string | null;
  mac: string | null;
  speedMb: number | null;
  rxBps: number | null;
  txBps: number | null;
  rxBytes: number | null;
  txBytes: number | null;
  rxPackets: number | null;
  txPackets: number | null;
  rxErrors: number | null;
  txErrors: number | null;
  rxDropped: number | null;
  txDropped: number | null;
}

export interface NetSummary {
  gateway: string | null;
  dns: string[];
  tcpEstablished: number | null;
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
  nodes: NodeInfo[];
  uptimeSec: number | null;
  bootTime: string | null;
}

// One monitored server: either this backend host ('local') or a PiPulse agent.
export interface NodeInfo {
  id: string;
  hostname: string;
  arch: string | null;
  version: string | null;
  connected: boolean;
  lastSeen: string | null;
  cpuUsage: number | null;
  tempC: number | null;
  memPct: number | null;
  uptimeSec: number | null;
  local: boolean;
}

// Bucketed history response: points are per-bucket averages.
export interface HistBucket {
  ts: number;
  cpu: number | null;
  memPct: number | null;
  tempC: number | null;
  rxBps: number | null;
  txBps: number | null;
  readBps: number | null;
  writeBps: number | null;
  n: number;
}

export interface HistResponse {
  points: HistBucket[];
  bucketSec: number;
  total: number;
}

export interface SmartAttribute {
  id: number; name: string; value: number | null; worst: number | null;
  thresh: number | null; raw: number | null;
}

export type SmartOverall = 'healthy' | 'warning' | 'critical' | 'unavailable';

// NVMe health log fields, kept separate from ATA attributes on purpose:
// percentage used, spare and media errors mean different things than
// reallocated/pending sectors, so they get their own rules and UI.
export interface NvmeHealth {
  percentageUsed: number | null;   // 0-100+ of rated endurance
  availableSpare: number | null;   // percent
  spareThreshold: number | null;   // percent
  mediaErrors: number | null;
  dataUnitsRead: number | null;    // units of 1000 x 512 bytes
  dataUnitsWritten: number | null; // units of 1000 x 512 bytes
  unsafeShutdowns: number | null;
  criticalWarning: number | null;  // raw bitmask, decoded for display
  warningTempTime: number | null;  // minutes above warning temp
  critTempTime: number | null;     // minutes above critical temp
}

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
  nvme: NvmeHealth | null;   // set for NVMe drives, null for ATA/SATA/USB
  warnings: string[];
  unavailableReason: string | null;
  source: 'local' | 'agent';
  nodeId: string | null;   // agent id for remote drives, null for local ones
}

export interface SmartResult {
  tool: 'ok' | 'missing' | 'denied';
  drives: SmartDrive[];
}

// Security signals reported by the host agent (root). Everything here is
// first-seen or counted facts — no anomaly scoring, so alerts stay reliable.
export interface SshAttempt {
  ts: number;      // unix seconds
  user: string;
  ip: string;
  ok: boolean;     // accepted vs failed login
}

export interface ListenPort {
  proto: string;   // tcp | tcp6
  port: number;
  addr: string;
  exposed: boolean; // bound to all interfaces (reachable from LAN/WAN)
}

export interface SshIpStat {
  ip: string;
  failed: number;   // failed attempts in the detection window
  lastTs: number;   // unix seconds of the latest attempt
  users: string[];
}

export interface SecurityStatus {
  nodeId: string;
  hostname: string;
  connected: boolean;
  firewall: string;          // ufw | nft | iptables | none | unknown
  firewallDetail: string | null;
  fail2ban: string;          // active | inactive | missing
  secUpdates: number | null; // pending security updates, null = unknown
  rebootRequired: boolean;
  sshLog: boolean;           // an SSH log source was readable
  ports: ListenPort[];
  recent: SshAttempt[];      // latest attempts, newest first
  bruteForce: SshIpStat[];   // IPs currently over the detection window
}
