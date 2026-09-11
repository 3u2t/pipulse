import { useEffect, useState } from 'react';
import type { WsPayload } from '../shared/types.js';

export function Toasts({ data }: { data: WsPayload | null }) {
  const [toasts, setToasts] = useState<string[]>([]);
  const [seen, setSeen] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!data) return;
    const notes: string[] = [];
    for (const a of data.alerts) {
      if (!seen.has(`${a.key}:${a.severity}`)) notes.push(a.message);
    }
    if (!data.agent.connected) notes.push('PiPulse Agent disconnected.');
    if (notes.length) {
      setToasts((t) => [...notes.slice(0, 3), ...t].slice(0, 4));
      setSeen((s) => { const n = new Set(s); for (const a of data.alerts) n.add(`${a.key}:${a.severity}`); return n; });
      const timer = setTimeout(() => setToasts([]), 8000);
      return () => clearTimeout(timer);
    }
  }, [data?.alerts.length]);
  return <div className="toasts">{toasts.map((t, i) => <div key={i} className="toast">{t}</div>)}</div>;
}
