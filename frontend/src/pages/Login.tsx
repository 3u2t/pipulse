import { useState } from 'react';
import { api } from '../lib/api.js';

export function Login() {
  const [u, setU] = useState('admin');
  const [p, setP] = useState('');
  const [err, setErr] = useState('');
  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api(`/api/auth/login`, { method: 'POST', body: JSON.stringify({ username: u, password: p }) });
      location.href = '/';
    } catch { setErr('Login failed. Check username and password.'); }
  };
  return (<><h2>Log in to PiPulse</h2>{err && <p>{err}</p>}
    <form onSubmit={go}><p><input value={u} onChange={(e) => setU(e.target.value)} placeholder="username" /></p><p><input type="password" value={p} onChange={(e) => setP(e.target.value)} placeholder="password" /></p><p><button type="submit">Log in</button></p></form></>);
}
