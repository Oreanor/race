export type OverlapWall = {
  owner?: string;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  y0a: number;
  y0b: number;
  y1: number;
};

const GRID = 0.25;

function quant(value: number) {
  return Math.round(value / GRID);
}

function edgeKey(face: OverlapWall) {
  const a = `${quant(face.ax)},${quant(face.az)}`;
  const b = `${quant(face.bx)},${quant(face.bz)}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function roundVertex(lng: number, lat: number) {
  return `${lng.toFixed(6)},${lat.toFixed(6)}`;
}

type Ring = readonly (readonly number[])[];
type Stacked = { rings: readonly Ring[]; base: number; height: number };

export function footprintKey(rings: readonly Ring[]) {
  // GeoJSON repeats the starting vertex at the end. Ignore that duplicate
  // before sorting, otherwise rotating a closed ring changes its identity.
  return rings.map((ring) => [...new Set(ring.map((point) => roundVertex(point[0] ?? 0, point[1] ?? 0)))].sort().join(';')).sort().join('#');
}

// One footprint must become one volume. Tile copies repeat the same ring,
// and a shorter part under a taller one would paint a second roof and wall.
export function keepVisibleParts<T extends Stacked>(parts: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const part of parts) {
    const key = footprintKey(part.rings);
    const list = groups.get(key);
    if (list) list.push(part);
    else groups.set(key, [part]);
  }
  const drop = new Set<T>();
  for (const list of groups.values()) {
    for (const part of list) {
      const buried = list.some((other) => other !== part
        && other.base <= part.base + 0.05
        && other.height >= part.height - 0.05
        && (other.height - other.base > part.height - part.base + 0.05));
      if (buried) drop.add(part);
    }
  }
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const part of parts) {
    if (drop.has(part)) continue;
    const key = `${footprintKey(part.rings)}@${part.base.toFixed(1)}:${part.height.toFixed(1)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(part);
  }
  return kept;
}

function outlineMeters(ring: Ring, lat = ring[0]?.[1] ?? 0) {
  const cos = Math.cos(lat * Math.PI / 180);
  return ring.map((point) => [(point[0] ?? 0) * 111319.49 * cos, (point[1] ?? 0) * 111319.49]);
}

function centroidOf(points: number[][]) {
  let x = 0;
  let y = 0;
  for (const point of points) { x += point[0]; y += point[1]; }
  const count = points.length || 1;
  return [x / count, y / count];
}

function coversEdge(from: number[][], onto: number[][], slack: number) {
  const slack2 = slack * slack;
  let hit = 0;
  for (const point of from) {
    let close = false;
    for (let i = 0; i < onto.length; i++) {
      const a = onto[i];
      const b = onto[(i + 1) % onto.length];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
      const ex = a[0] + t * dx - point[0];
      const ey = a[1] + t * dy - point[1];
      if (ex * ex + ey * ey <= slack2) { close = true; break; }
    }
    if (close) hit++;
  }
  return from.length > 0 && hit / from.length >= 0.6;
}

function sameHouse(a: Ring, b: Ring) {
  if (a.length < 3 || b.length < 3) return false;
  // Both outlines must use one projection, independent of their first vertex.
  const latitude = a[0]?.[1] ?? 0;
  const ma = outlineMeters(a, latitude);
  const mb = outlineMeters(b, latitude);
  const ca = centroidOf(ma);
  const cb = centroidOf(mb);
  if ((ca[0] - cb[0]) ** 2 + (ca[1] - cb[1]) ** 2 > 12 ** 2) return false;
  return coversEdge(ma, mb, 2.2) && coversEdge(mb, ma, 2.2);
}

// Tile copies of one house come back with a slightly different outline and
// each copy paints its own windows a step to the side.
export function collapseCopies<T extends Stacked & { key: string }>(parts: T[]): T[] {
  const info = parts.map((part) => {
    const ring = part.rings[0] ?? [];
    const points = outlineMeters(ring);
    const center = centroidOf(points);
    return { points, x: center[0], y: center[1] };
  });
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < parts.length; i++) {
    const id = `${Math.floor(info[i].x / 40)}:${Math.floor(info[i].y / 40)}`;
    const list = buckets.get(id);
    if (list) list.push(i);
    else buckets.set(id, [i]);
  }
  const drop = new Set<number>();
  const keepIndex = (a: number, b: number) => {
    const spanA = parts[a].height - parts[a].base;
    const spanB = parts[b].height - parts[b].base;
    if (spanA > spanB + 1.5) return a;
    if (spanB > spanA + 1.5) return b;
    return parts[a].key <= parts[b].key ? a : b;
  };
  for (let i = 0; i < parts.length; i++) {
    if (drop.has(i) || info[i].points.length < 3) continue;
    const cx = Math.floor(info[i].x / 40);
    const cy = Math.floor(info[i].y / 40);
    for (let dz = -1; dz <= 1 && !drop.has(i); dz++) for (let dx = -1; dx <= 1 && !drop.has(i); dx++) {
      for (const j of buckets.get(`${cx + dx}:${cy + dz}`) ?? []) {
        if (j <= i || drop.has(j) || info[j].points.length < 3) continue;
        const gapX = info[i].x - info[j].x;
        const gapY = info[i].y - info[j].y;
        if (gapX * gapX + gapY * gapY > 144) continue;
        const ringA = parts[i].rings[0];
        const ringB = parts[j].rings[0];
        if (!ringA || !ringB || !sameHouse(ringA, ringB)) continue;
        drop.add(keepIndex(i, j) === i ? j : i);
        if (drop.has(i)) break;
      }
    }
  }
  return parts.filter((_, index) => !drop.has(index));
}

// A settings change reloads tiles, and one query can omit houses that are
// still on screen. Keep those until the car actually leaves them behind.
export function retainNearParts<T extends { key: string }>(current: T[], previous: Iterable<T>, near: (part: T) => number, keep: number) {
  const have = new Set(current.map((part) => part.key));
  const kept = current.slice();
  for (const part of previous) {
    if (have.has(part.key) || !(near(part) < keep)) continue;
    have.add(part.key);
    kept.push(part);
  }
  return kept;
}

// Shared edges of neighbouring houses are the same plane. Keep the covered
// span once so the two colours stop fighting for the same pixels.
export function resolveWalls<T extends OverlapWall>(faces: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const face of faces) {
    const key = edgeKey(face);
    const list = groups.get(key);
    if (list) list.push(face);
    else groups.set(key, [face]);
  }
  const out: T[] = [];
  for (const group of groups.values()) {
    const ranked = group.slice().sort((a, b) => (b.y1 - Math.min(b.y0a, b.y0b)) - (a.y1 - Math.min(a.y0a, a.y0b)) || (a.owner ?? '').localeCompare(b.owner ?? ''));
    const kept: { y0: number; y1: number }[] = [];
    for (const face of ranked) {
      let y0 = Math.min(face.y0a, face.y0b);
      let y1 = face.y1;
      for (const other of kept) {
        if (y1 <= other.y0 + 0.08 || y0 >= other.y1 - 0.08) continue;
        if (y0 >= other.y0 - 0.08 && y1 <= other.y1 + 0.08) {
          y1 = y0;
          break;
        }
        if (y0 < other.y0 && y1 <= other.y1 + 0.08) y1 = other.y0;
        else if (y1 > other.y1 && y0 >= other.y0 - 0.08) y0 = other.y1;
      }
      if (y1 - y0 < 0.4) continue;
      const lift = y0 - Math.min(face.y0a, face.y0b);
      kept.push({ y0, y1 });
      out.push({ ...face, y0a: face.y0a + lift, y0b: face.y0b + lift, y1 });
    }
  }
  return out;
}
