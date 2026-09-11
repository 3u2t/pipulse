import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig } from './config/config.js';
import { openDb, closeDb } from './db/db.js';
import { RealMonitoringProvider, DemoMonitoringProvider } from './providers/providers.js';
import { apiRouter } from './api/routes.js';
import { agentRouter, agentStatus } from './agent/agent.js';
import { startWs } from './ws/hub.js';
import { ensureAdmin, verifyUser, signSession, verifySession, setPassword } from './auth/auth.js';
import { dockerAvailable } from './docker/containers.js';

const config = loadConfig();
openDb(config.dataDir);
ensureAdmin();
if (config.demoMode) console.log('[pipulse] DEMO_MODE on — metrics are simulated. Never used in production.');

const provider = config.demoMode ? new DemoMonitoringProvider() : new RealMonitoringProvider();
const app = express();
app.use(express.json({ limit: '1mb' }));

const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (verifySession(req.headers.cookie, config.sessionSecret)) return next();
  res.status(401).json({ error: 'unauthorized' });
};

// Health (public)
app.get('/health', (_req, res) => res.json({ status: 'ok', version: '0.1.0' }));
app.get('/api/health', (_req, res) => {
  let database = 'ok';
  try { openDb(config.dataDir).prepare('SELECT 1').get(); } catch { database = 'error'; }
  const agent = agentStatus(config.monitorIntervalMs);
  res.json({
    app: 'ok', backend: 'ok', database,
    agent: config.demoMode ? 'demo' : agent.connected ? 'connected' : 'offline',
    docker: dockerAvailable() ? 'available' : 'unavailable',
    provider: provider.name,
  });
});

// Auth
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password || !verifyUser(username, password)) return res.status(401).json({ error: 'invalid credentials' });
  const token = signSession(username, config.sessionSecret, config.sessionTimeoutMin);
  res.setHeader('Set-Cookie', `pipulse_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${config.sessionTimeoutMin * 60}`);
  res.json({ ok: true });
});
app.post('/api/auth/logout', (_req, res) => {
  res.setHeader('Set-Cookie', 'pipulse_session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.post('/api/auth/password', requireAuth, (req, res) => {
  const user = verifySession(req.headers.cookie, config.sessionSecret);
  const { password } = req.body as { password?: string };
  if (!user || !password || password.length < 8) return res.status(400).json({ error: 'password must be 8+ chars' });
  setPassword(user, password);
  res.json({ ok: true });
});

app.use('/api/agent', agentRouter(config));
app.use('/api', requireAuth, apiRouter(provider, config));

// Frontend static (served when built into backend/public)
const pub = path.join(process.cwd(), 'public');
if (fs.existsSync(pub)) {
  app.use(express.static(pub));
  app.get('*', (_req, res) => res.sendFile(path.join(pub, 'index.html')));
}

const server = app.listen(config.port, () => console.log(`[pipulse] listening on :${config.port} (${provider.name})`));
startWs(server, provider, config);

// Graceful shutdown: close HTTP + SQLite before exit (avoids native teardown crashes on SIGTERM).
let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(() => { closeDb(); process.exit(0); });
    setTimeout(() => { closeDb(); process.exit(0); }, 3000).unref();
  });
}
