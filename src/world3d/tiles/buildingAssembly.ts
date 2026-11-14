import { VectorTile, classifyRings } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { clipRing } from './buildTile.ts';
import type { TileId } from '../mercator.ts';

type Point = [number, number];
export type BuildingAssembly = { key: string; height: number; base: number; contours: Point[][] };
type Part = { tile: TileId; id: string; ring: Point[]; height: number; base: number; parent: number };
export type BuildingSource = { tile: TileId; buffer: ArrayBuffer };
// Neighbour tiles participate in several assemblies. Decode their polygons once;
// weak keys let the worker's bounded vector cache control their lifetime.
const decodedSources = new WeakMap<ArrayBuffer, {
  extent: number;
  features: { f: number; height: number; base: number; polygons: ReturnType<typeof classifyRings> }[];
}>();

function decodeSource(buffer: ArrayBuffer) {
  const cached = decodedSources.get(buffer);
  if (cached) return cached;
  const layer = new VectorTile(new PbfReader(buffer)).layers.building;
  const decoded = { extent: layer?.extent ?? 4096, features: [] as { f: number; height: number; base: number; polygons: ReturnType<typeof classifyRings> }[] };
  if (layer) for (let f = 0; f < layer.length; f++) {
    const feature = layer.feature(f), props = feature.properties;
    if (feature.type !== 3 || props.hide_3d === true || props.hide_3d === 'true') continue;
    const reported = Number(props.render_height ?? props.height);
    const height = Math.max(3, Math.min(320, reported > 0 && Number.isFinite(reported) ? reported : 10));
    const base = Math.max(0, Number(props.render_min_height ?? props.min_height ?? 0) || 0);
    decoded.features.push({ f, height, base, polygons: classifyRings(feature.loadGeometry()) });
  }
  decodedSources.set(buffer, decoded);
  return decoded;
}

/** Continuous wall span in the assembled footprint, measured from its local start. */
export function assembledWall(assembly: BuildingAssembly, a: Point, b: Point) {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (length < 1e-6) return { length, offset: 0 };
  const ux = (b[0] - a[0]) / length, uy = (b[1] - a[1]) / length;
  const intervals: [number, number][] = [[0, length]];
  for (const ring of assembly.contours) for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    const cross = (v: Point) => Math.abs((v[0] - a[0]) * uy - (v[1] - a[1]) * ux);
    if (cross(p) > 0.25 || cross(q) > 0.25) continue;
    const s = (p[0] - a[0]) * ux + (p[1] - a[1]) * uy;
    const t = (q[0] - a[0]) * ux + (q[1] - a[1]) * uy;
    intervals.push([Math.min(s, t), Math.max(s, t)]);
  }
  intervals.sort((p, q) => p[0] - q[0]);
  let lo = intervals[0][0], hi = intervals[0][1];
  for (let i = 1; i < intervals.length; i++) {
    const next = intervals[i];
    if (next[0] > hi + 0.25) {
      if (lo <= 0 && hi >= length) break;
      lo = next[0]; hi = next[1];
    } else hi = Math.max(hi, next[1]);
  }
  return { length: hi - lo, offset: -lo };
}

/** Assemble clipped fragments in a common integer world grid before choosing a recipe.
 * Source IDs are deliberately ignored: OpenFreeMap aggregates unrelated buildings.
 * Only positive-length shared tile cuts connect fragments, never point contacts.
 */
export function assembleBuildings(sources: BuildingSource[], target: TileId, needed?: TileId[]): Map<string, BuildingAssembly> {
  const parts: Part[] = [];
  const seams = new Map<string, { part: number; lo: number; hi: number; side: number }[]>();
  for (const { tile, buffer } of sources) {
    if (!buffer.byteLength) continue;
    const decoded = decodeSource(buffer);
    const extent = decoded.extent, scale = 4096 / extent;
    for (const { f, height, base, polygons } of decoded.features) {
      polygons.forEach((polygon, pi) => {
        const local = clipRing(polygon[0].map(p => [p.x, p.y]), extent);
        if (local.length < 3) return;
        const area = local.reduce((sum, p, i) => { const q = local[(i + 1) % local.length]; return sum + p[0] * q[1] - q[0] * p[1]; }, 0);
        if (Math.abs(area) < 0.01) return; // buffered neighbours may clip to a line
        const index = parts.length;
        const ring: Point[] = local.map(([x, y]) => [tile.x * 4096 + x * scale, tile.y * 4096 + y * scale]);
        parts.push({ tile, id: `${f}:${pi}`, ring, height, base, parent: index });
        for (let i = 0; i < local.length; i++) {
          const a = local[i], b = local[(i + 1) % local.length];
          const vertical = Math.abs(a[0] - b[0]) < 0.01 && (Math.abs(a[0]) < 0.01 || Math.abs(a[0] - extent) < 0.01);
          const horizontal = Math.abs(a[1] - b[1]) < 0.01 && (Math.abs(a[1]) < 0.01 || Math.abs(a[1] - extent) < 0.01);
          if (!vertical && !horizontal) continue;
          const axis = vertical ? 0 : 1, other = 1 - axis;
          const at = Math.round(ring[i][axis]);
          const lo = Math.min(ring[i][other], ring[(i + 1) % ring.length][other]);
          const hi = Math.max(ring[i][other], ring[(i + 1) % ring.length][other]);
          const key = `${axis}:${at}`;
          let list = seams.get(key); if (!list) seams.set(key, list = []);
          list.push({ part: index, lo, hi, side: a[axis] < extent / 2 ? -1 : 1 });
        }
      });
    }
  }
  const root = (i: number): number => {
    let r = i; while (parts[r].parent !== r) r = parts[r].parent;
    while (i !== r) { const next = parts[i].parent; parts[i].parent = r; i = next; }
    return r;
  };
  for (const edges of seams.values()) {
    edges.sort((a, b) => a.lo - b.lo);
    for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length && edges[j].lo < edges[i].hi; j++) {
      const a = edges[i], b = edges[j], pa = parts[a.part], pb = parts[b.part];
      if (a.side === b.side || Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo) < 0.5) continue;
      if (Math.abs(pa.height - pb.height) > 0.5 || Math.abs(pa.base - pb.base) > 0.5) continue;
      parts[root(b.part)].parent = root(a.part);
    }
  }
  const groups = new Map<number, Part[]>();
  parts.forEach((p, i) => { const r = root(i); let g = groups.get(r); if (!g) groups.set(r, g = []); g.push(p); });
  const result = new Map<string, BuildingAssembly>();
  const loaded = new Set(sources.map(s => `${s.tile.x}/${s.tile.y}`));
  const missing = new Set<string>();
  for (const group of groups.values()) {
    if (!group.some(p => p.tile.x === target.x && p.tile.y === target.y)) continue;
    for (const p of group) for (let i = 0; i < p.ring.length; i++) {
      const a = p.ring[i], b = p.ring[(i + 1) % p.ring.length];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.5) continue;
      let dx = 0, dy = 0;
      if (a[0] === b[0] && a[0] === p.tile.x * 4096) dx = -1;
      if (a[0] === b[0] && a[0] === (p.tile.x + 1) * 4096) dx = 1;
      if (a[1] === b[1] && a[1] === p.tile.y * 4096) dy = -1;
      if (a[1] === b[1] && a[1] === (p.tile.y + 1) * 4096) dy = 1;
      if (!dx && !dy) continue;
      const x = p.tile.x + dx, y = p.tile.y + dy, key = `${x}/${y}`, size = 2 ** target.z;
      if (x < 0 || y < 0 || x >= size || y >= size || loaded.has(key) || missing.has(key)) continue;
      missing.add(key); needed?.push({ z: target.z, x, y });
    }
    if (group.length < 2) continue;
    const contours = group.map(p => p.ring);
    // Canonical global geometry, independent of which tile requested this assembly.
    const vertices = [...new Set(contours.flat().map(([x, y]) => `${Math.round(x * 16)},${Math.round(y * 16)}`))].sort();
    const assembly = { key: `assembled:${vertices.join(';')}`, height: Math.max(...group.map(p => p.height)), base: Math.min(...group.map(p => p.base)), contours };
    for (const p of group) if (p.tile.x === target.x && p.tile.y === target.y && p.tile.z === target.z) result.set(p.id, assembly);
  }
  return result;
}
