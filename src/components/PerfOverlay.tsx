'use client';
import { Fragment } from 'react';
import type { BenchResult, PerfSnapshot } from '@/world3d/perf/PerfMonitor';

const fmt = (n: number, digits = 1) => (n < 0 ? '—' : n.toFixed(digits));
const big = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} k` : String(n));

export default function PerfOverlay({ mode, perf, bench, extra, onBench }: {
  mode: string;
  perf: PerfSnapshot | null;
  bench: BenchResult | null;
  extra?: [string, string][];
  onBench?: () => void;
}) {
  return (
    <aside className="perf-overlay" aria-label="Производительность">
      <div className="perf-title">{mode}</div>
      <dl>
        <dt>FPS</dt><dd>{perf ? perf.fps : '—'}</dd>
        <dt>Кадр, мс</dt><dd>{perf ? `${fmt(perf.frameMs)} (макс ${fmt(perf.worstMs, 0)})` : '—'}</dd>
        <dt>CPU, мс</dt><dd>{perf ? fmt(perf.cpuMs, 2) : '—'}</dd>
        <dt>GPU, мс</dt><dd>{perf ? fmt(perf.gpuMs, 2) : '—'}</dd>
        <dt>Draw calls</dt><dd>{perf ? perf.drawCalls : '—'}</dd>
        <dt>Треугольники</dt><dd>{perf ? big(perf.triangles) : '—'}</dd>
        <dt>Инстансы</dt><dd>{perf ? big(perf.instances) : '—'}</dd>
        {extra?.map(([k, v]) => (<Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>))}
        {bench && (<>
          <dt>Бенчмарк</dt><dd>{fmt(bench.avgMs, 2)} мс · p95 {fmt(bench.p95Ms, 2)}</dd>
          <dt>Без vsync</dt><dd>≈ {Math.round(bench.potentialFps)} FPS</dd>
        </>)}
      </dl>
      {onBench && <button type="button" className="perf-bench" onClick={onBench}>Бенчмарк (B)</button>}
    </aside>
  );
}
