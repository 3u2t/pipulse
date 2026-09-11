import { useState } from 'react';
import type { SmartDrive, SmartResult, WsPayload } from '../shared/types.js';
import { fmtBytes, fmtPct, fmtTemp, smartDot, maskSerial } from '../lib/format.js';
import { api } from '../lib/api.js';

export function Storage({ data }: { data: WsPayload | null }) {
  const [smart, setSmart] = useState<SmartResult | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [reveal, setReveal] = useState<string | null>(null);
  if (!data) return <p className="muted">Waiting for live data…</p>;
  if (!smart) api<{ filesystems: unknown; smart: SmartResult }>(`/api/storage`).then((r) => setSmart(r.smart || { tool: 'ok', drives: [] })).catch(() => setSmart({ tool: 'ok', drives: [] }));
  const sel = smart?.drives.find((d) => d.device === open);
  return (<>
    <h2>Storage</h2>
    <table><thead><tr><th>Device</th><th>Mount</th><th>Type</th><th>Total</th><th>Used</th><th>Free</th><th>Used %</th></tr></thead><tbody>
      {data.filesystems.map((f) => <tr key={f.mount}><td>{f.device}</td><td>{f.mount}</td><td>{f.fstype}</td><td>{fmtBytes(f.totalBytes)}</td><td>{fmtBytes(f.usedBytes)}</td><td>{fmtBytes(f.freeBytes)}</td><td>{fmtPct(f.usedPct)}</td></tr>)}
    </tbody></table>
    <h3>Drive Health</h3>
    {!smart ? <p className="muted">Loading…</p> : smart.tool === 'missing' ? (
      <p className="muted">SMART unavailable — <code>smartctl</code> was not found. Install <code>smartmontools</code> on the host (or on the Pi running the agent); see docs/smart.md. This is not a disk failure.</p>
    ) : smart.tool === 'denied' ? (
      <p className="muted">SMART unavailable — permission denied reading the drives. The collector needs read access to the device nodes; see docs/smart.md. This is not a disk failure.</p>
    ) : smart.drives.length === 0 ? (
      <p className="muted">No SMART-capable drives detected.</p>
    ) : (<>
      <div style={{ overflowX: 'auto' }}><table>
        <thead><tr><th>Drive</th><th>Temperature</th><th>SMART health</th><th>Power-on hours</th><th>Reallocated</th><th>Pending</th><th>Uncorrectable</th></tr></thead>
        <tbody>{smart.drives.map((d) => (
          <tr key={d.device} onClick={() => setOpen(open === d.device ? null : d.device)} style={{ cursor: 'pointer' }} title="Click for details">
            <td>{d.model || d.device}<div className="small muted">{d.device}{d.usbBridge ? ' · USB' : ''}{d.source === 'agent' ? ' · via agent' : ''}</div></td>
            <td>{fmtTemp(d.tempC)}</td>
            <td>{smartDot(d.overall)}</td>
            <td>{d.powerOnHours ?? '—'}</td>
            <td>{d.reallocated ?? '—'}</td>
            <td>{d.pending ?? '—'}</td>
            <td>{d.offlineUncorrectable ?? '—'}</td>
          </tr>
        ))}</tbody>
      </table></div>
      {sel && <DriveDetail d={sel} revealed={reveal === sel.device} onReveal={() => setReveal(reveal === sel.device ? null : sel.device)} />}
    </>)}
  </>);
}

function DriveDetail({ d, revealed, onReveal }: { d: SmartDrive; revealed: boolean; onReveal: () => void }) {
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <h3>{d.model || d.device} — detailed SMART information</h3>
      {d.overall === 'unavailable'
        ? <p className="muted">{d.unavailableReason || 'SMART unavailable for this drive. This is not a disk failure.'}</p>
        : (<>
          {d.warnings.map((w, i) => <p key={i}>⚠ {w}</p>)}
          {d.warnings.length === 0 && <p>🟢 No SMART warnings on this drive.</p>}
        </>)}
      <table><tbody>
        <tr><td>Device</td><td>{d.device}</td></tr>
        <tr><td>Model</td><td>{d.model || '—'}</td></tr>
        <tr><td>Serial</td><td>{revealed ? (d.serial || '—') : maskSerial(d.serial)} <button className="small" onClick={onReveal}>{revealed ? 'Hide' : 'Reveal'}</button></td></tr>
        <tr><td>Firmware</td><td>{d.firmware || '—'}</td></tr>
        <tr><td>Capacity</td><td>{fmtBytes(d.capacityBytes)}</td></tr>
        <tr><td>Interface</td><td>{d.interface || '—'}{d.usbBridge ? ' (USB bridge)' : ''}</td></tr>
        <tr><td>Overall health</td><td>{d.health}</td></tr>
        <tr><td>Power cycles</td><td>{d.powerCycles ?? '—'}</td></tr>
        <tr><td>Reported uncorrectable errors</td><td>{d.reportedUncorrectable ?? '—'}</td></tr>
        <tr><td>SMART error log entries</td><td>{d.errorCount ?? '—'}</td></tr>
        <tr><td>Last self-test</td><td>{d.selftest || '—'}</td></tr>
      </tbody></table>
      {d.attributes.length > 0 && (<>
        <h3 style={{ marginTop: 12 }}>SMART attributes</h3>
        <div style={{ overflowX: 'auto' }}><table>
          <thead><tr><th>ID</th><th>Name</th><th>Value</th><th>Worst</th><th>Thresh</th><th>Raw</th></tr></thead>
          <tbody>{d.attributes.map((a) => <tr key={a.id}><td>{a.id}</td><td>{a.name}</td><td>{a.value ?? '—'}</td><td>{a.worst ?? '—'}</td><td>{a.thresh ?? '—'}</td><td>{a.raw ?? '—'}</td></tr>)}</tbody>
        </table></div>
      </>)}
    </div>
  );
}
