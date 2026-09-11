import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { getDb } from '../db/db.js';

export function ensureAdmin(): void {
  const row = getDb().prepare('SELECT id FROM users LIMIT 1').get();
  if (!row) {
    const user = process.env.PIPULSE_USER || 'admin';
    const pass = process.env.PIPULSE_PASSWORD || ('pipulse-' + crypto.randomBytes(4).toString('hex'));
    const hash = bcrypt.hashSync(pass, 10);
    getDb().prepare('INSERT INTO users(username,pass_hash) VALUES(?,?)').run(user, hash);
    console.log(`[pipulse] created initial user "${user}" password "${pass}" — change it in Settings.`);
  }
}

export function verifyUser(username: string, password: string): boolean {
  const row = getDb().prepare('SELECT pass_hash FROM users WHERE username=?').get(username) as unknown as { pass_hash: string } | undefined;
  if (!row) return false;
  return bcrypt.compareSync(password, row.pass_hash);
}

export function setPassword(username: string, password: string): void {
  getDb().prepare('UPDATE users SET pass_hash=? WHERE username=?').run(bcrypt.hashSync(password, 10), username);
}

// Minimal signed-cookie sessions (no extra deps).
export function signSession(username: string, secret: string, timeoutMin: number): string {
  const exp = Date.now() + timeoutMin * 60 * 1000;
  const body = Buffer.from(JSON.stringify({ u: username, exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifySession(cookie: string | undefined, secret: string): string | null {
  if (!cookie) return null;
  const m = cookie.match(/(?:^|;\s*)pipulse_session=([^;]+)/);
  if (!m) return null;
  const [body, sig] = m[1].split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try {
    const { u, exp } = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (Date.now() > exp) return null;
    return u;
  } catch { return null; }
}
