import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

export function Logs() {
  const [source, setSource] = useState('system');
  const [service, setService] = useState('docker.service');
  const [container, setContainer] = useState('');
  const [q, setQ] = useState('');
  const [level, setLevel] = useState('all');
  const [lines, setLines] = useState<string[]>([]);
  const [live, setLive] = useState(true);

  useEffect(() => {
    if (!live) return;
    let stop = false;
    const load = async () => {
      try {
        const params = new URLSearchParams({ source, lines: '200', service, container });
        const r = await api<string[]>(`/api/logs?${params}`);
        if (!stop) setLines(r);
      } catch { /* keep old */ }
    };
    void load();
    const t = setInterval(load, 5000);
    return () => { stop = true; clearInterval(t); };
  }, [source, service, container, live]);

  const filtered = lines.filter((l) => {
    if (q && !l.toLowerCase().includes(q.toLowerCase())) return false;
    if (level !== 'all') {
      const up = l.toUpperCase();
      if (level === 'error' && !/ERR|FAIL|CRIT/.test(up)) return false;
      if (level === 'warning' && !/WARN/.test(up)) return false;
      if (level === 'debug' && !/DEBUG/.test(up)) return false;
    }
    return true;
  });

  const levelOf = (l: string): string => {
    const up = l.toUpperCase();
    if (/ERR|FAIL|CRIT|FATAL|EXCEPTION|TRACEBACK/.test(up)) return 'log-err';
    if (/WARN/.test(up)) return 'log-warn';
    if (/DEBUG/.test(up)) return 'log-dbg';
    return '';
  };

  return (<>
    <h2>Logs</h2>
    <p>
      <select value={source} onChange={(e) => setSource(e.target.value)}>
        <option value="system">system logs</option><option value="service">service logs</option><option value="docker">container logs</option>
      </select>{' '}
      {source === 'service' && <input value={service} onChange={(e) => setService(e.target.value)} placeholder="service name" />}{' '}
      {source === 'docker' && <input value={container} onChange={(e) => setContainer(e.target.value)} placeholder="container id" />}{' '}
      <input placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />{' '}
      <select value={level} onChange={(e) => setLevel(e.target.value)}>
        <option value="all">all levels</option><option value="error">error</option><option value="warning">warning</option><option value="debug">debug</option>
      </select>{' '}
      <button onClick={() => setLive(!live)}>{live ? 'Pause' : 'Resume'}</button>
    </p>
    <div className="logview small">
      {filtered.length === 0 ? <span className="muted">No log lines.</span> :
        filtered.slice(-300).map((l, i) => <div key={i} className={`logrow ${levelOf(l)}`}>{l}</div>)}
    </div>
  </>);
}
