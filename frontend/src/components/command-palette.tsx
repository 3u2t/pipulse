import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { WsPayload } from '../shared/types.js';

export function CommandPalette({ data }: { data: WsPayload | null }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const nav = useNavigate();
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  if (!open) return null;
  const items: { label: string; go: () => void }[] = [
    { label: 'Go: Dashboard', go: () => nav('/') }, { label: 'Go: System', go: () => nav('/system') },
    { label: 'Go: Docker', go: () => nav('/docker') }, { label: 'Go: Storage', go: () => nav('/storage') },
    { label: 'Go: Network', go: () => nav('/network') }, { label: 'Go: Security', go: () => nav('/security') }, { label: 'Go: Logs', go: () => nav('/logs') },
    { label: 'Go: Alerts', go: () => nav('/alerts') }, { label: 'Go: Settings', go: () => nav('/settings') },
    { label: 'Setup: Onboarding wizard', go: () => nav('/onboarding') },
    { label: 'Refresh metrics', go: () => location.reload() },
    ...(data?.docker.containers.map((c) => ({ label: `Container: ${c.name}`, go: () => nav(`/docker/${c.shortId}`) })) || []),
    ...(data?.services.slice(0, 20).map((s) => ({ label: `Service: ${s.name}`, go: () => nav('/services') })) || []),
  ];
  const f = items.filter((i) => i.label.toLowerCase().includes(q.toLowerCase())).slice(0, 12);
  return (
    <><div className="palette-back" onClick={() => setOpen(false)} />
      <div className="palette">
        <input autoFocus placeholder="Search containers, services, pages… (Esc to close)" value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && f[0]) { f[0].go(); setOpen(false); } }} />
        <ul>{f.map((i, n) => <li key={n} onClick={() => { i.go(); setOpen(false); }}>{i.label}</li>)}</ul>
      </div></>
  );
}
