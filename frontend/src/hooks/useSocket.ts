import { useEffect, useRef, useState } from 'react';
import type { WsPayload } from '../shared/types.js';

export type ConnState = 'live' | 'reconnecting' | 'offline';

// WebSocket with polling fallback. Returns latest payload + connection state.
export function usePiPulseSocket(): { data: WsPayload | null; conn: ConnState } {
  const [data, setData] = useState<WsPayload | null>(null);
  const [conn, setConn] = useState<ConnState>('reconnecting');
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retries = 0;

    const startPoll = () => {
      if (pollRef.current) return;
      pollRef.current = window.setInterval(async () => {
        try {
          const r = await fetch('/api/system');
          if (!r.ok) { setConn('offline'); return; }
          // WS is down but HTTP works: merge the fresh snapshot into what we show.
          const s = await r.json() as Pick<WsPayload, 'cpu' | 'mem' | 'filesystems' | 'net' | 'uptimeSec' | 'bootTime'>;
          setData((d) => d ? { ...d, ...s, ts: new Date().toISOString() } : d);
          setConn('reconnecting');
        } catch { setConn('offline'); }
      }, 10000);
    };
    const stopPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };

    const connect = () => {
      if (closed) return;
      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
      try { ws = new WebSocket(url); } catch { setConn('offline'); startPoll(); return; }
      ws.onopen = () => { setConn('live'); retries = 0; stopPoll(); };
      ws.onmessage = (e) => { try { setData(JSON.parse(e.data)); } catch { /* ignore */ } };
      ws.onclose = () => {
        if (closed) return;
        setConn('reconnecting'); startPoll();
        retries++;
        setTimeout(connect, Math.min(15000, 1000 * 2 ** Math.min(retries, 4)));
      };
      ws.onerror = () => { try { ws?.close(); } catch { /* */ } setConn('offline'); };
    };
    connect();
    return () => { closed = true; stopPoll(); try { ws?.close(); } catch { /* */ } };
  }, []);

  return { data, conn };
}
