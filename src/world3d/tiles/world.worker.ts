/// <reference lib="webworker" />
// One job = one z14 tile of the world: vector PBF + terrarium DEM fetched in
// parallel, then terrain, ground raster, roads, far buildings and GeoJSON are
// built here and transferred to the main thread in one message. Because the
// DEM arrives with the tile, nothing on the main thread ever sees a tile
// without its final heights.
import { buildWorldTile, worldTransferables, type WorldBuildOptions } from './worldTile.ts';
import { decodeTerrarium, DEM_SIZE, padDem } from './dem.ts';
import type { TileId } from '../mercator.ts';
import { assembleBuildings } from './buildingAssembly.ts';

type Job = {
  type: 'world';
  id: number;
  tile: TileId;
  vectorUrl: string;
  vectorTemplate?: string;
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

// Neighbour geometry is reused by subsequent jobs, with bounded resident memory.
const vectors = new Map<string, Promise<ArrayBuffer>>();
function cachedVector(url: string) {
  const cached = vectors.get(url);
  if (cached) { vectors.delete(url); vectors.set(url, cached); return cached; }
  const request = loadVector(url, AbortSignal.timeout(15000)).catch(error => { vectors.delete(url); throw error; });
  vectors.set(url, request);
  while (vectors.size > 48) vectors.delete(vectors.keys().next().value!);
  return request;
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
      cachedVector(message.vectorUrl),
      message.demUrl ? cachedDem(message.demUrl).then(async (center) => {
        if (!center) return null;
        const [w, e, n, s, nw, ne, sw, se] = await Promise.all((message.demNeighbours ?? []).concat(Array(8).fill(null)).slice(0, 8).map((url) => (url ? cachedDem(url) : Promise.resolve(null))));
        return padDem(center, { w, e, n, s, nw, ne, sw, se });
      }) : Promise.resolve(null),
    ]);
    const sources = [{ tile: message.tile, buffer }];
    let buildingAssemblies;
    // Follow only buildings intersecting the requested tile. Continue past the
    // immediate neighbours when an airport spans more than a 3x3 neighbourhood.
    for (;;) {
      if (controller.signal.aborted) return;
      const needed: TileId[] = [];
      buildingAssemblies = assembleBuildings(sources, message.tile, needed);
      if (!needed.length || !message.vectorTemplate) break;
      if (sources.length + needed.length > 64) throw new Error('Building assembly exceeded 64 source tiles');
      sources.push(...await Promise.all(needed.map(async tile => {
        const url = message.vectorTemplate!.replace('{z}', String(tile.z)).replace('{x}', String(tile.x)).replace('{y}', String(tile.y));
        return { tile, buffer: await cachedVector(url) };
      })));
    }
    // the eight tiles around: their roads go into the bridge plan, so a bridge over the
    // edge has the same heights on both sides (one that fails to load is left out)
    const neighbours = message.vectorTemplate
      ? (await Promise.all([-1, 0, 1].flatMap((dy) => [-1, 0, 1].map(async (dx) => {
        if (!dx && !dy) return null;
        const tile = { z: message.tile.z, x: message.tile.x + dx, y: message.tile.y + dy };
        const url = message.vectorTemplate!.replace('{z}', String(tile.z)).replace('{x}', String(tile.x)).replace('{y}', String(tile.y));
        try { return { dx, dy, buffer: (await cachedVector(url)).slice(0) }; } catch { return null; }
      })))).filter((n): n is { dx: number; dy: number; buffer: ArrayBuffer } => !!n)
      : [];
    const fetchMs = performance.now() - started;
    if (controller.signal.aborted) return;
    const data = buildWorldTile(buffer.slice(0), message.tile, { ...message.options, dem, buildingAssemblies, neighbours });

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
