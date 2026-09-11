import { getDb } from './db.js';
import type { HistBucket, HistResponse } from '../shared/types.js';

// Raw samples every few seconds would flood the charts on long ranges, so
// bucket them into per-bucket averages server-side. Buckets grow with the
// requested span; 1h and below stays raw.
export function queryHistory(kind: string, ref: string, hours: number, maxPoints = 300): HistResponse {
  const spanSec = Math.max(60, hours * 3600);
  const bucketSec = Math.max(1, Math.ceil(spanSec / Math.max(1, maxPoints)));
  const since = Date.now() - hours * 3600 * 1000;
  const db = getDb();
  const totalRow = db.prepare('SELECT COUNT(*) AS n FROM metrics WHERE kind=? AND ref=? AND ts>?').get(kind, ref, since) as unknown as { n: number };
  const total = totalRow?.n ?? 0;
  if (!total) return { points: [], bucketSec, total: 0 };
  const rows = db.prepare(
    `SELECT CAST(ts/? AS INTEGER)*? AS ts, AVG(cpu) AS cpu, AVG(mem_pct) AS memPct, AVG(temp_c) AS tempC,
            AVG(rx_bps) AS rxBps, AVG(tx_bps) AS txBps, AVG(read_bps) AS readBps, AVG(write_bps) AS writeBps,
            COUNT(*) AS n
     FROM metrics WHERE kind=? AND ref=? AND ts>? GROUP BY 1 ORDER BY 1 ASC LIMIT 2000`
  ).all(bucketSec * 1000, bucketSec * 1000, kind, ref, since) as unknown as HistBucket[];
  return { points: rows, bucketSec, total };
}

// Latest raw rows, for sparklines that don't need bucketing.
export function latestValues(kind: string, ref: string, limit = 60): { ts: number; cpu: number | null; memPct: number | null }[] {
  return getDb().prepare('SELECT ts, cpu, mem_pct AS memPct FROM metrics WHERE kind=? AND ref=? ORDER BY ts DESC LIMIT ?')
    .all(kind, ref, limit) as unknown as { ts: number; cpu: number | null; memPct: number | null }[];
}
