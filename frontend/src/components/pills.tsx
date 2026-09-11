const dotFor = (state: string): string =>
  state === 'healthy' || state === 'running' ? '🟢'
  : state === 'degraded' || state === 'restarting' ? '🟡'
  : state === 'stopped' || state === 'unhealthy' ? '🔴' : '⚪';

const clsFor = (state: string): string =>
  state === 'healthy' ? 'pill-ok'
  : state === 'running' ? 'pill-info'
  : state === 'degraded' || state === 'restarting' ? 'pill-warn'
  : state === 'unhealthy' || state === 'stopped' ? 'pill-crit' : 'pill-mute';

export function StatePill({ state, extra }: { state: string; extra?: string }) {
  return <span className={`pill ${clsFor(state)}`}>{dotFor(state)} {state}{extra ? ` (${extra})` : ''}</span>;
}

const sevCls = (s: string): string =>
  s === 'critical' ? 'pill-crit' : s === 'warning' ? 'pill-warn' : 'pill-mute';

export function SevPill({ severity }: { severity: string }) {
  return <span className={`pill ${sevCls(severity)}`}>{severity}</span>;
}
