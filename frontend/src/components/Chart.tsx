import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

const rgba = (hex: string, a: number): string => {
  const m = hex.replace('#', '');
  const v = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const n = parseInt(v, 16);
  return Number.isFinite(n) ? `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})` : `rgba(88,166,255,${a})`;
};

export function Chart({ title, series, labels, unit }: { title: string; series: number[][]; labels: string[]; unit?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current || !series[0]?.length) return;
    const css = getComputedStyle(document.body);
    const accent = css.getPropertyValue('--accent').trim() || '#58a6ff';
    const muted = css.getPropertyValue('--muted').trim() || '#8b94a3';
    const grid = css.getPropertyValue('--border-soft').trim() || '#1a1f27';
    const opts: uPlot.Options = {
      width: ref.current.clientWidth || 600, height: 180,
      scales: { x: { time: true } },
      axes: [
        { stroke: muted, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid } },
        { stroke: muted, grid: { stroke: grid, width: 1 }, ticks: { show: false }, label: unit, size: 44 },
      ],
      legend: { show: false },
      series: [{ label: 'time' }, ...labels.map((l, i) => ({
        label: l, stroke: accent, width: 1.75,
        fill: i === 0 ? rgba(accent, 0.13) : undefined,
        points: { show: false },
      }))],
    };
    const u = new uPlot(opts, series as uPlot.AlignedData, ref.current);
    return () => u.destroy();
  }, [title]); // one uPlot instance per mount; parents remount via key= when the dataset changes

  if (!series[0]?.length) return <div className="card"><h3>{title}</h3><p className="muted">Not enough data yet.</p></div>;
  return <div className="card"><h3>{title}</h3><div className="chart" ref={ref} /></div>;
}
