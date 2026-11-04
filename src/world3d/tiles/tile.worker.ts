/// <reference lib="webworker" />
// Fetches a PBF tile and builds GPU-ready arrays off the main thread.
import { buildTile, transferables, type BuildOptions } from './buildTile.ts';
import type { TileId } from '../mercator.ts';

type Request = { type: 'load'; id: number; url: string; tile: TileId; options: BuildOptions } | { type: 'cancel'; id: number };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const running = new Map<number, AbortController>();

scope.onmessage = async (event: MessageEvent<Request>) => {
  const message = event.data;
  if (message.type === 'cancel') {
    running.get(message.id)?.abort();
    running.delete(message.id);
    return;
  }
  const controller = new AbortController();
  running.set(message.id, controller);
  const started = performance.now();
  try {
    const response = await fetch(message.url, { signal: controller.signal });
    if (!response.ok && response.status !== 204 && response.status !== 404) throw new Error(`HTTP ${response.status}`);
    const buffer = response.ok && response.status !== 204 ? await response.arrayBuffer() : new ArrayBuffer(0);
    const fetchMs = performance.now() - started;
    if (controller.signal.aborted) return;
    const data = buildTile(buffer, message.tile, message.options);
    scope.postMessage({ id: message.id, ok: true, data, fetchMs, netBytes: buffer.byteLength }, transferables(data));
  } catch (error) {
    const aborted = controller.signal.aborted;
    scope.postMessage({ id: message.id, ok: false, aborted, error: aborted ? 'aborted' : String(error) });
  } finally {
    running.delete(message.id);
  }
};
