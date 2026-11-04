/// <reference lib="webworker" />
// One job = one z14 tile of the world: vector PBF + terrarium DEM fetched in
// parallel, then terrain, ground raster, roads, far buildings and GeoJSON are
// built here and transferred to the main thread in one message. Because the
// DEM arrives with the tile, nothing on the main thread ever sees a tile
// without its final heights.
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { buildWorldTile, paintGround, worldTransferables, type WorldBuildOptions } from './worldTile.ts';
import { decodeTerrarium, DEM_SIZE } from './dem.ts';
import { latFromMercator, tileCorner, tileSpan, type TileId } from '../mercator.ts';

type Job = {
  type: 'world';
  id: number;
  tile: TileId;
  vectorUrl: string;
  demUrl: string | null;
  raster: number;
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
      message.demUrl ? loadDem(message.demUrl, controller.signal).catch((error) => {
        if (controller.signal.aborted) throw error;
        return null;
      }) : Promise.resolve(null),
    ]);
    const fetchMs = performance.now() - started;
    if (controller.signal.aborted) return;
    const data = buildWorldTile(buffer, message.tile, { ...message.options, dem });

    const canvas = new OffscreenCanvas(message.raster, message.raster);
    const ctx = canvas.getContext('2d')!;
    const span = tileSpan(message.tile.z);
    const metersScale = Math.cos(latFromMercator(tileCorner(message.tile)[1] - span / 2) * Math.PI / 180);
    paintGround(ctx, message.raster, new VectorTile(new PbfReader(data.raw)), metersScale, span);
    const raster = canvas.transferToImageBitmap();

    scope.postMessage(
      { id: message.id, ok: true, data, raster, fetchMs, buildMs: performance.now() - started - fetchMs },
      [...worldTransferables(data), raster],
    );
  } catch (error) {
    const aborted = controller.signal.aborted;
    scope.postMessage({ id: message.id, ok: false, aborted, error: aborted ? 'aborted' : String(error) });
  } finally {
    running.delete(message.id);
  }
};
