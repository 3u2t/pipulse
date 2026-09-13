import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let db: DatabaseSync | null = null;

export function openDb(dataDir: string): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(dataDir, { recursive: true });
  db = new DatabaseSync(path.join(dataDir, 'pipulse.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      pass_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      severity TEXT NOT NULL,
      component TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
    CREATE TABLE IF NOT EXISTS metrics (
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      ref TEXT NOT NULL DEFAULT '',
      cpu REAL, mem_pct REAL, temp_c REAL,
      rx_bps REAL, tx_bps REAL, read_bps REAL, write_bps REAL,
      extra TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metrics(ts);
    CREATE INDEX IF NOT EXISTS idx_metrics_kind ON metrics(kind);
    CREATE TABLE IF NOT EXISTS agent (
      id TEXT PRIMARY KEY,
      hostname TEXT, arch TEXT, version TEXT,
      last_seen TEXT
    );
    CREATE TABLE IF NOT EXISTS notified_keys (
      key TEXT PRIMARY KEY,
      severity TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'sent',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'sent',
      detail TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_ts ON notifications(ts);
    -- Security: raw SSH attempts (pruned to 24h), learned baselines so every
    -- first-seen event alerts exactly once, latest per-node security snapshot.
    CREATE TABLE IF NOT EXISTS ssh_events (
      ts INTEGER NOT NULL,
      node TEXT NOT NULL,
      ip TEXT NOT NULL,
      username TEXT NOT NULL DEFAULT '',
      ok INTEGER NOT NULL DEFAULT 0,
      UNIQUE(ts, node, ip, username, ok)
    );
    CREATE INDEX IF NOT EXISTS idx_ssh_events_ts ON ssh_events(ts);
    CREATE TABLE IF NOT EXISTS known_ssh_ips (
      node TEXT NOT NULL,
      ip TEXT NOT NULL,
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(node, ip)
    );
    CREATE TABLE IF NOT EXISTS known_ports (
      node TEXT NOT NULL,
      proto TEXT NOT NULL,
      port INTEGER NOT NULL,
      addr TEXT NOT NULL DEFAULT '',
      exposed INTEGER NOT NULL DEFAULT 0,
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(node, proto, port)
    );
    CREATE TABLE IF NOT EXISTS node_security (
      node TEXT PRIMARY KEY,
      hostname TEXT NOT NULL DEFAULT '',
      firewall TEXT NOT NULL DEFAULT 'unknown',
      firewall_detail TEXT NOT NULL DEFAULT '',
      fail2ban TEXT NOT NULL DEFAULT 'missing',
      sec_updates INTEGER,
      reboot_required INTEGER NOT NULL DEFAULT 0,
      ssh_log INTEGER NOT NULL DEFAULT 0,
      ports TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error('db not opened');
  return db;
}

export function closeDb(): void {
  try { db?.close(); } catch { /* already closed */ }
  db = null;
}

export function getSetting(key: string, fallback = ''): string {
  const row = getDb().prepare('SELECT value FROM settings WHERE key=?').get(key) as unknown as { value: string } | undefined;
  return row ? row.value : fallback;
}

export function setSetting(key: string, value: string): void {
  getDb().prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}

// Retention: raw samples pruned by age; called on an interval.
export function pruneMetrics(retentionDays: number): void {
  const cutoff = Date.now() - retentionDays * 86400 * 1000;
  getDb().prepare('DELETE FROM metrics WHERE ts < ?').run(cutoff);
}
