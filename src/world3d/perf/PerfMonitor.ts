// Renderer-agnostic profiler. It wraps the draw entry points of a WebGL2
// context, so MapLibre mode and three-world are measured the same way:
// draw calls and triangles are what actually reached the GPU, regardless of
// which library issued them.

export type PerfSnapshot = {
  fps: number;
  /** average interval between animation frames, ms */
  frameMs: number;
  /** worst frame interval in the window, ms */
  worstMs: number;
  /** JS time spent in the app frame (update + render submit), ms; -1 if unknown */
  cpuMs: number;
  /** GPU time per frame from EXT_disjoint_timer_query_webgl2, ms; -1 if unavailable */
  gpuMs: number;
  drawCalls: number;
  triangles: number;
  instances: number;
};

const TRIANGLES = 0x0004;
const TRIANGLE_STRIP = 0x0005;
const TRIANGLE_FAN = 0x0006;

function trianglesFor(mode: number, count: number, instances: number) {
  if (mode === TRIANGLES) return Math.floor(count / 3) * instances;
  if (mode === TRIANGLE_STRIP || mode === TRIANGLE_FAN) return Math.max(0, count - 2) * instances;
  return 0;
}

type Counters = { calls: number; triangles: number; instances: number };

const INSTRUMENTED = new WeakMap<WebGL2RenderingContext, Counters>();

/** Idempotent: wraps a context once and returns its live counters. */
export function instrument(gl: WebGL2RenderingContext): Counters {
  const existing = INSTRUMENTED.get(gl);
  if (existing) return existing;
  const counters: Counters = { calls: 0, triangles: 0, instances: 0 };
  const g = gl as unknown as Record<string, (...args: number[]) => void>;
  const wrap = (name: string, count: (args: number[]) => [number, number, number]) => {
    const original = g[name];
    if (typeof original !== 'function') return;
    g[name] = function (this: unknown, ...args: number[]) {
      const [mode, n, instances] = count(args);
      counters.calls++;
      counters.instances += instances;
      counters.triangles += trianglesFor(mode, n, instances);
      return original.apply(gl, args);
    };
  };
  wrap('drawArrays', (a) => [a[0], a[2], 1]);
  wrap('drawElements', (a) => [a[0], a[1], 1]);
  wrap('drawRangeElements', (a) => [a[0], a[3], 1]);
  wrap('drawArraysInstanced', (a) => [a[0], a[2], a[3]]);
  wrap('drawElementsInstanced', (a) => [a[0], a[1], a[4]]);
  INSTRUMENTED.set(gl, counters);
  return counters;
}

/**
 * Samples once per animation frame and publishes averages every `windowMs`.
 * Per-frame numbers are window totals divided by frames, so it does not
 * matter in which order rAF callbacks run.
 */
export class PerfMonitor {
  private counters: Counters;
  private raf = 0;
  private last = 0;
  private windowStart = 0;
  private frames = 0;
  private worst = 0;
  private base: Counters = { calls: 0, triangles: 0, instances: 0 };
  private cpuTotal = 0;
  private cpuFrames = 0;
  private gpuTotal = 0;
  private gpuFrames = 0;
  private timer: { ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }; queries: WebGLQuery[]; active: WebGLQuery | null } | null = null;
  latest: PerfSnapshot = { fps: 0, frameMs: 0, worstMs: 0, cpuMs: -1, gpuMs: -1, drawCalls: 0, triangles: 0, instances: 0 };

  constructor(private gl: WebGL2RenderingContext, private onSample?: (s: PerfSnapshot) => void, private windowMs = 500) {
    this.counters = instrument(gl);
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
    if (ext) this.timer = { ext, queries: [], active: null };
    this.raf = requestAnimationFrame(this.tick);
  }

  /** Optional: the app reports its own JS frame cost. */
  reportCpu(ms: number) {
    this.cpuTotal += ms;
    this.cpuFrames++;
  }

  /** Optional GPU timing around the app's own render call (three-world). */
  beginGpu() {
    const t = this.timer;
    if (!t || t.active) return;
    const query = this.gl.createQuery();
    if (!query) return;
    this.gl.beginQuery(t.ext.TIME_ELAPSED_EXT, query);
    t.active = query;
  }

  endGpu() {
    const t = this.timer;
    if (!t?.active) return;
    this.gl.endQuery(t.ext.TIME_ELAPSED_EXT);
    t.queries.push(t.active);
    t.active = null;
  }

  private pollGpu() {
    const t = this.timer;
    if (!t) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(t.ext.GPU_DISJOINT_EXT);
    while (t.queries.length) {
      const query = t.queries[0];
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
      t.queries.shift();
      const ns = gl.getQueryParameter(query, gl.QUERY_RESULT) as number;
      gl.deleteQuery(query);
      if (!disjoint) {
        this.gpuTotal += ns / 1e6;
        this.gpuFrames++;
      }
    }
    if (t.queries.length > 8) for (const q of t.queries.splice(0)) gl.deleteQuery(q);
  }

  private tick = (now: number) => {
    this.raf = requestAnimationFrame(this.tick);
    if (this.last) {
      const delta = now - this.last;
      this.worst = Math.max(this.worst, delta);
      this.frames++;
    } else this.windowStart = now;
    this.last = now;
    this.pollGpu();
    const span = now - this.windowStart;
    if (span < this.windowMs || !this.frames) return;
    const c = this.counters;
    const frames = this.frames;
    this.latest = {
      fps: Math.round(frames * 1000 / span),
      frameMs: span / frames,
      worstMs: this.worst,
      cpuMs: this.cpuFrames ? this.cpuTotal / this.cpuFrames : -1,
      gpuMs: this.gpuFrames ? this.gpuTotal / this.gpuFrames : -1,
      drawCalls: Math.round((c.calls - this.base.calls) / frames),
      triangles: Math.round((c.triangles - this.base.triangles) / frames),
      instances: Math.round((c.instances - this.base.instances) / frames),
    };
    this.base = { ...c };
    this.frames = 0;
    this.worst = 0;
    this.cpuTotal = this.cpuFrames = 0;
    this.gpuTotal = this.gpuFrames = 0;
    this.windowStart = now;
    this.onSample?.(this.latest);
  };

  dispose() {
    cancelAnimationFrame(this.raf);
    if (this.timer) for (const q of this.timer.queries) this.gl.deleteQuery(q);
  }
}

export type BenchResult = { frames: number; avgMs: number; p95Ms: number; potentialFps: number };

/**
 * Uncapped cost of one frame: render synchronously and wait for the GPU
 * (readPixels forces completion), so vsync does not hide the difference.
 * Same procedure for both renderers.
 */
export function benchmark(gl: WebGL2RenderingContext, renderOnce: () => void, frames = 90): BenchResult {
  const pixel = new Uint8Array(4);
  const times: number[] = [];
  // benchmark draws must not leak into the live per-frame averages
  const counters = instrument(gl);
  const before = { ...counters };
  for (let i = 0; i < frames + 5; i++) {
    const start = performance.now();
    renderOnce();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    const ms = performance.now() - start;
    if (i >= 5) times.push(ms);
  }
  Object.assign(counters, before);
  times.sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))];
  return { frames, avgMs: avg, p95Ms: p95, potentialFps: 1000 / avg };
}
