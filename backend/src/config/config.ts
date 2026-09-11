export interface AppConfig {
  port: number;
  dataDir: string;
  agentToken: string;
  demoMode: boolean;
  monitorIntervalMs: number;
  sessionSecret: string;
  sessionTimeoutMin: number;
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(): AppConfig {
  return {
    port: num(process.env.PORT, 8080),
    dataDir: process.env.DATA_DIR || './data',
    agentToken: process.env.AGENT_TOKEN || 'dev-token-change-me',
    demoMode: process.env.DEMO_MODE === 'true',
    monitorIntervalMs: num(process.env.MONITOR_INTERVAL_MS, 5000),
    sessionSecret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    sessionTimeoutMin: num(process.env.SESSION_TIMEOUT_MIN, 720),
  };
}
