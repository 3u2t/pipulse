import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
import { usePiPulseSocket } from './hooks/useSocket.js';
import { Sidebar, MobileBar, ConnBadge } from './components/layout.js';
import { Toasts } from './components/toasts.js';
import { CommandPalette } from './components/command-palette.js';
import { Dashboard } from './pages/Dashboard.js';
import { System } from './pages/System.js';
import { Docker, DockerDetail } from './pages/Docker.js';
import { Services } from './pages/Services.js';
import { Processes } from './pages/Processes.js';
import { Storage } from './pages/Storage.js';
import { Network } from './pages/Network.js';
import { Logs } from './pages/Logs.js';
import { Alerts } from './pages/Alerts.js';
import { Settings } from './pages/Settings.js';
import { Login } from './pages/Login.js';
import { api } from './lib/api.js';
import './styles.css';

function applyTheme() {
  const t = localStorage.getItem('pipulse-theme') || 'dark';
  const real = t === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t;
  document.documentElement.dataset.theme = real;
}

function Shell() {
  const { data, conn } = usePiPulseSocket();
  const loc = useLocation();
  const [host, setHost] = useState(() => localStorage.getItem('pipulse-hostname') || '');
  useEffect(applyTheme, []);
  // Prefer the live agent hostname; fall back to the name in Settings.
  useEffect(() => { if (data?.agent.hostname) setHost(data.agent.hostname); }, [data?.agent.hostname]);
  useEffect(() => {
    api<{ settings: Record<string, string> }>(`/api/settings`).then((r) => {
      if (r.settings.hostname) { setHost((h) => h || r.settings.hostname); localStorage.setItem('pipulse-hostname', r.settings.hostname); }
      if (r.settings.timezone) localStorage.setItem('pipulse-tz', r.settings.timezone);
    }).catch(() => undefined);
  }, []);
  return (
    <div className="layout">
      <Sidebar />
      <div style={{ flex: 1 }}>
        <MobileBar />
        <main className="main">
          <div className="topbar">
            <strong>PiPulse</strong>
            {host && <span className="small muted">{host}</span>}
            <ConnBadge conn={conn} />
            <span className="spacer" />
            <span className="small faint">Ctrl+K</span>
            <select className="small" defaultValue={localStorage.getItem('pipulse-theme') || 'dark'}
              onChange={(e) => { localStorage.setItem('pipulse-theme', e.target.value); applyTheme(); }}>
              <option value="dark">dark</option><option value="light">light</option><option value="system">system</option>
            </select>
          </div>
          <div key={loc.pathname} className="page">
          <Routes>
            <Route path="/" element={<Dashboard data={data} />} />
            <Route path="/system" element={<System data={data} />} />
            <Route path="/docker" element={<Docker data={data?.docker || null} />} />
            <Route path="/docker/:id" element={<DockerDetail />} />
            <Route path="/services" element={<Services data={data} />} />
            <Route path="/processes" element={<Processes data={data} />} />
            <Route path="/storage" element={<Storage data={data} />} />
            <Route path="/network" element={<Network data={data} />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/alerts" element={<Alerts />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/login" element={<Login />} />
          </Routes>
          </div>
          <Toasts data={data} />
          <CommandPalette data={data} />
        </main>
      </div>
    </div>
  );
}

export function App() {
  return <BrowserRouter><Shell /></BrowserRouter>;
}
