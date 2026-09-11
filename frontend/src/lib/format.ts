export const fmtBytes = (b: number | null): string => {
  if (b === null || !Number.isFinite(b)) return 'Unavailable';
  if (b === 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};
export const fmtBps = (b: number | null): string => {
  if (b === null || !Number.isFinite(b)) return 'Unavailable';
  const u = ['bps', 'Kbps', 'Mbps', 'Gbps'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(Math.max(b, 1)) / Math.log(1000)));
  return `${(b / 1000 ** i).toFixed(1)} ${u[i]}`;
};
export const fmtPct = (v: number | null): string => (v === null || !Number.isFinite(v) ? 'Unavailable' : `${v.toFixed(1)}%`);
export const fmtTemp = (v: number | null): string => (v === null || !Number.isFinite(v) ? 'Unavailable' : `${v.toFixed(0)}°C`);
export const fmtUptime = (s: number | null): string => {
  if (s === null || !Number.isFinite(s)) return 'Unavailable';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};
export const stateDot = (s: string): string =>
  s === 'healthy' || s === 'running' ? '🟢' : s === 'degraded' || s === 'restarting' ? '🟡' : s === 'stopped' || s === 'unhealthy' ? '🔴' : '⚪';
// Short duration for bucket captions: 3661 -> "1h 1m", 90 -> "1m 30s".
export const fmtDuration = (s: number): string => {
  if (!Number.isFinite(s) || s < 0) return '—';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  if (h) return `${h}h ${m}m`;
  if (m) return sec ? `${m}m ${sec}s` : `${m}m`;
  return `${sec}s`;
};
export const smartDot = (s: string): string =>
  s === 'healthy' ? '🟢 Healthy' : s === 'warning' ? '🟡 Warning' : s === 'critical' ? '🔴 Critical' : '⚪ SMART unavailable';
// Server timestamps are UTC. The timezone setting (if set) applies here.
export const fmtDateTime = (iso: string | null): string => {
  if (!iso) return '—';
  try {
    const tz = localStorage.getItem('pipulse-tz') || undefined;
    const dated = /Z$|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + 'Z';
    return new Date(dated).toLocaleString(undefined, tz ? { timeZone: tz } : undefined);
  } catch { return iso; }
};
// Serials stay private by default; reveal is an explicit click per drive.
export const maskSerial = (s: string | null): string => {
  if (!s) return '—';
  return s.length <= 4 ? '••••' : `••••••${s.slice(-4)}`;
};
