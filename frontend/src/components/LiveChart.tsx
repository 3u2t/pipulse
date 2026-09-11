import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

// Chart fed by the live WebSocket stream: created once, updated in place via
// setData so every tick glides in without remounting.
export function LiveChart({ title, unit, color, times, values }: {
  title: string; unit?: string; color?: string; times: number[]; values: number[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const colorRef = useRef(color);
  colorRef.current = color;

  useEffect(() => {
    if (!ref.current) return;
    const css = getComputedStyle(document.body);
    const stroke = colorRef.current || css.getPropertyValue('--accent').trim() || '#58a6ff';
    const muted = css.getPropertyValue('--muted').trim() || '#8b94a3';
    const grid = css.getPropertyValue('--border-soft').trim() || 'rgba(255,255,255,0.05)';
    const m = stroke.replace('#', '');
    const v = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
    const n = parseInt(v, 16);
    const fill = Number.isFinite(n)
      ? `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0.16)` : 'rgba(88,166,255,0.16)';
    const u = new uPlot({
      width: ref.current.clientWidth || 600, height: 170,
      scales: { x: { time: true } },
      axes: [
        { stroke: muted, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid } },
        { stroke: muted, grid: { stroke: grid, width: 1 }, ticks: { show: false }, size: 40 },
      ],
      legend: { show: false },
      series: [{ label: 'time' }, { label: title, stroke, width: 2, fill, points: { show: false } }],
    }, [[], []] as uPlot.AlignedData, ref.current);
    plot.current = u;
    const onResize = () => u.setSize({ width: ref.current?.clientWidth || 600, height: 170 });
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); u.destroy(); plot.current = null; };
  }, [title, unit]);

  useEffect(() => {
    plot.current?.setData([times, values]);
  }, [times, values]);

  return (
    <div className="card"><h3>{title} <span className="live-tag">live</span></h3><div className="chart" ref={ref} /></div>
  );
}
