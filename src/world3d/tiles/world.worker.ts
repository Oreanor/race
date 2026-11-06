/// <reference lib="webworker" />
// One job = one z14 tile of the world: vector PBF + terrarium DEM fetched in
// parallel, then terrain, ground raster, roads, far buildings and GeoJSON are
// built here and transferred to the main thread in one message. Because the
// DEM arrives with the tile, nothing on the main thread ever sees a tile
// without its final heights.
import { buildWorldTile, worldTransferables, type WorldBuildOptions } from './worldTile.ts';
import { decodeTerrarium, DEM_SIZE, padDem } from './dem.ts';
import type { TileId } from '../mercator.ts';

type Job = {
  type: 'world';
  id: number;
  tile: TileId;
  vectorUrl: string;
  demUrl: string | null;
  /** the 8 neighbours' DEMs: w, e, n, s, nw, ne, sw, se (their edges stitch the seams) */
  demNeighbours?: (string | null)[];
  options: Omit<WorldBuildOptions, 'dem'>;
};
type Request = Job | { type: 'cancel'; id: number };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const running = new Map<number, AbortController>();

async function loadDem(url: string, signal: AbortSignal): Promise<Float32Array | null> {
  const response = await fetch(url, { signal });
  if (!response.ok) return null; // sea / no data: flat ground
  const bitmap = await createImageBitmap(await response.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = new OffscreenCanvas(DEM_SIZE, DEM_SIZE);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, DEM_SIZE, DEM_SIZE);
  bitmap.close();
  return decodeTerrarium(ctx.getImageData(0, 0, DEM_SIZE, DEM_SIZE).data);
}

/**
 * Decoded DEMs by url, shared by the jobs of this worker: a tile's neighbours are loaded
 * for their edges, then usually again as tiles of their own. Not tied to one job's abort.
 */
const dems = new Map<string, Promise<Float32Array | null>>();
function cachedDem(url: string) {
  let hit = dems.get(url);
  if (hit) { dems.delete(url); dems.set(url, hit); return hit; } // most recent last
  hit = loadDem(url, new AbortController().signal).catch(() => null);
  dems.set(url, hit);
  while (dems.size > 64) dems.delete(dems.keys().next().value!);
  return hit;
}

async function loadVector(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal });
  if (response.status === 204 || response.status === 404) return new ArrayBuffer(0);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.arrayBuffer();
}

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
    const [buffer, dem] = await Promise.all([
      loadVector(message.vectorUrl, controller.signal),
      message.demUrl ? cachedDem(message.demUrl).then(async (center) => {
        if (!center) return null;
        const [w, e, n, s, nw, ne, sw, se] = await Promise.all((message.demNeighbours ?? []).concat(Array(8).fill(null)).slice(0, 8).map((url) => (url ? cachedDem(url) : Promise.resolve(null))));
        return padDem(center, { w, e, n, s, nw, ne, sw, se });
      }) : Promise.resolve(null),
    ]);
    const fetchMs = performance.now() - started;
    if (controller.signal.aborted) return;
    const data = buildWorldTile(buffer, message.tile, { ...message.options, dem });

    scope.postMessage(
      { id: message.id, ok: true, data, fetchMs, buildMs: performance.now() - started - fetchMs },
      worldTransferables(data),
    );
  } catch (error) {
    const aborted = controller.signal.aborted;
    scope.postMessage({ id: message.id, ok: false, aborted, error: aborted ? 'aborted' : String(error) });
  } finally {
    running.delete(message.id);
  }
};
