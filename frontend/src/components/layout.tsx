import { NavLink } from 'react-router-dom';

const links = [
  ['/', 'Dashboard'], ['/system', 'System'], ['/docker', 'Docker'], ['/services', 'Services'],
  ['/processes', 'Processes'], ['/storage', 'Storage'], ['/network', 'Network'],
  ['/logs', 'Logs'], ['/alerts', 'Alerts'], ['/settings', 'Settings'], ['/onboarding', 'Setup'],
] as const;

export function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="brand"><span className="pulse" /><span className="brand-name">PiPulse</span></div>
      <div className="tagline">Your server. One pulse.</div>
      <nav className="nav">{links.map(([to, l]) => <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>{l}</NavLink>)}</nav>
    </aside>
  );
}

export function MobileBar() {
  return (
    <nav className="mobilebar">{links.map(([to, l]) => <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>{l}</NavLink>)}</nav>
  );
}

export function ConnBadge({ conn }: { conn: string }) {
  const label = conn === 'live' ? '🟢 Live' : conn === 'reconnecting' ? '🟡 Reconnecting' : '🔴 Offline';
  return <span className={`conn conn-${conn}`}>{label}</span>;
}
