import { buildTile, type BuildOptions, type TileData } from './buildTile.ts';
import type { TileId } from '../mercator.ts';

export type TileResult = { data: TileData; fetchMs: number; netBytes: number };

type Pending = { resolve: (result: TileResult) => void; reject: (error: Error) => void; worker: number };

const TILEJSON = 'https://tiles.openfreemap.org/planet';
const FALLBACK_TEMPLATE = 'https://tiles.openfreemap.org/planet/{z}/{x}/{y}.pbf';

/** Resolves OpenFreeMap's current versioned tile URL template once. */
let templatePromise: Promise<string> | null = null;
export function tileTemplate(): Promise<string> {
  templatePromise ??= fetch(TILEJSON)
    .then((r) => r.json())
    .then((json: { tiles?: string[] }) => json.tiles?.[0] ?? FALLBACK_TEMPLATE)
    .catch(() => FALLBACK_TEMPLATE);
  return templatePromise;
}

/**
 * Small worker pool. Each request fetches + decodes + meshes one tile in a
 * worker and transfers the typed arrays back. Falls back to the main thread
 * if module workers are unavailable.
 */
export class TileClient {
  private workers: Worker[] = [];
  private load: number[] = [];
  private pending = new Map<number, Pending>();
  private nextId = 1;
  readonly threaded: boolean;

  constructor(size = Math.min(3, Math.max(1, (navigator.hardwareConcurrency || 4) - 2))) {
    try {
      for (let i = 0; i < size; i++) {
        const worker = new Worker(new URL('./tile.worker.ts', import.meta.url), { type: 'module' });
        const index = i;
        worker.onmessage = (event) => this.receive(index, event.data);
        worker.onerror = (event) => console.error('[three-world] tile worker error', event.message);
        this.workers.push(worker);
        this.load.push(0);
      }
    } catch (error) {
      console.warn('[three-world] module workers unavailable, decoding on the main thread', error);
      for (const worker of this.workers) worker.terminate();
      this.workers = [];
    }
    this.threaded = this.workers.length > 0;
  }

  request(tile: TileId, options: BuildOptions): { promise: Promise<TileResult>; cancel: () => void } {
    const id = this.nextId++;
    if (!this.threaded) {
      const controller = new AbortController();
      const promise = (async () => {
        const started = performance.now();
        const url = (await tileTemplate()).replace('{z}', String(tile.z)).replace('{x}', String(tile.x)).replace('{y}', String(tile.y));
        const response = await fetch(url, { signal: controller.signal });
        const buffer = response.ok ? await response.arrayBuffer() : new ArrayBuffer(0);
        const fetchMs = performance.now() - started;
        return { data: buildTile(buffer, tile, options), fetchMs, netBytes: buffer.byteLength };
      })();
      return { promise, cancel: () => controller.abort() };
    }
    let worker = 0;
    for (let i = 1; i < this.workers.length; i++) if (this.load[i] < this.load[worker]) worker = i;
    this.load[worker]++;
    const promise = new Promise<TileResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, worker });
      tileTemplate().then((template) => {
        if (!this.pending.has(id)) return;
        const url = template.replace('{z}', String(tile.z)).replace('{x}', String(tile.x)).replace('{y}', String(tile.y));
        this.workers[worker]?.postMessage({ type: 'load', id, url, tile, options });
      });
    });
    return {
      promise,
      cancel: () => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.workers[entry.worker]?.postMessage({ type: 'cancel', id });
        this.settle(id);
        entry.reject(new Error('aborted'));
      },
    };
  }

  private settle(id: number) {
    const entry = this.pending.get(id);
    if (!entry) return null;
    this.pending.delete(id);
    this.load[entry.worker] = Math.max(0, this.load[entry.worker] - 1);
    return entry;
  }

  private receive(_worker: number, message: { id: number; ok: boolean; data?: TileData; fetchMs?: number; netBytes?: number; error?: string }) {
    const entry = this.settle(message.id);
    if (!entry) return;
    if (message.ok && message.data) entry.resolve({ data: message.data, fetchMs: message.fetchMs ?? 0, netBytes: message.netBytes ?? 0 });
    else entry.reject(new Error(message.error ?? 'tile failed'));
  }

  dispose() {
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
    for (const entry of this.pending.values()) entry.reject(new Error('disposed'));
    this.pending.clear();
  }
}
