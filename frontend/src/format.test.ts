import { describe, it, expect } from 'vitest';
import { fmtBytes, fmtPct, fmtTemp, fmtUptime, stateDot, maskSerial, smartDot, fmtDateTime } from './lib/format.js';

describe('format', () => {
  it('bytes', () => {
    expect(fmtBytes(null)).toBe('Unavailable');
    expect(fmtBytes(0)).toBe('0 B');
    expect(fmtBytes(1536)).toBe('1.5 KB');
  });
  it('pct/temp', () => {
    expect(fmtPct(null)).toBe('Unavailable');
    expect(fmtTemp(44.4)).toBe('44°C');
  });
  it('uptime', () => {
    expect(fmtUptime(90061)).toBe('1d 1h');
    expect(fmtUptime(null)).toBe('Unavailable');
  });
  it('state dots', () => {
    expect(stateDot('healthy')).toBe('🟢');
    expect(stateDot('unhealthy')).toBe('🔴');
    expect(stateDot('bogus')).toBe('⚪');
  });
  it('serial masking', () => {
    expect(maskSerial('WX72D31N9X4E')).toBe('••••••9X4E');
    expect(maskSerial(null)).toBe('—');
    expect(maskSerial('abc')).toBe('••••');
  });
  it('smart dots distinguish unavailable from failure', () => {
    expect(smartDot('healthy')).toMatch(/Healthy/);
    expect(smartDot('critical')).toMatch(/Critical/);
    expect(smartDot('unavailable')).toMatch(/unavailable/);
  });
  it('datetime honors the timezone setting', () => {
    const store = new Map<string, string>();
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    };
    expect(fmtDateTime(null)).toBe('—');
    localStorage.setItem('pipulse-tz', 'UTC');
    expect(fmtDateTime('2026-01-01T12:00:00Z')).toMatch(/2026/);
    localStorage.removeItem('pipulse-tz');
  });
});
