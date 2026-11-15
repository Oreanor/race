import type { RoadDeck, RoadPoint } from './roadNetwork.ts';

/** The actual upward-facing pavement triangles: x, height, z per vertex. */
export type RoadSurfaceData = {
  triangles: Float32Array;
  cell: number; x0: number; z0: number; nx: number; nz: number;
  offsets: Uint32Array;
  entries: Uint32Array;
};
const physicalSections = new WeakMap<object, ReturnType<typeof makeSections>>();

/** One cross section shared by both adjacent pieces and every part of the deck. */
export function deckSections(deck: Pick<RoadDeck, 'pts' | 'h' | 'frame' | 'half'>, half: number, physical = false) {
  if (physical && deck.half) {
    let sections = physicalSections.get(deck);
    if (!sections) { sections = makeSections(deck, half, true); physicalSections.set(deck, sections); }
    return sections;
  }
  return makeSections(deck, half, physical);
}

function makeSections(deck: Pick<RoadDeck, 'pts' | 'h' | 'frame' | 'half'>, half: number, physical: boolean) {
  return deck.pts.map(([x, z], i) => {
    let normal = deck.frame?.[i];
    if (!normal) {
      const p = deck.pts[Math.max(0, i - 1)], q = deck.pts[Math.min(deck.pts.length - 1, i + 1)];
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
      normal = [-(q[1] - p[1]) / len, (q[0] - p[0]) / len];
    }
    const width = physical ? deck.half?.[i] ?? half : half;
    return { x, z, h: deck.h[i], normal, half: width, left: [x + normal[0] * width, z + normal[1] * width] as RoadPoint, right: [x - normal[0] * width, z - normal[1] * width] as RoadPoint };
  });
}

/** Open a parapet only onto the body of an actually connected road piece. */
export function deckSideOpening(deck: RoadDeck, i: number, side: number, half: number, other: RoadDeck, n: number): boolean {
  if (!deck.nodes || !other.nodes) return false;
  const shared = [deck.nodes[i - 1], deck.nodes[i]].some(id => id === other.nodes![n - 1] || id === other.nodes![n]);
  if (!shared) return false;
  const sections = deckSections(deck, half, true), a = sections[i - 1], b = sections[i];
  const pa = side > 0 ? a.left : a.right, pb = side > 0 ? b.left : b.right;
  const [ax, az] = other.pts[n - 1], [bx, bz] = other.pts[n];
  const dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz;
  if (len2 < 1e-10) return false;
  for (const t of [0.2, 0.5, 0.8]) {
    const x = pa[0] + (pb[0] - pa[0]) * t, z = pa[1] + (pb[1] - pa[1]) * t;
    const u = ((x - ax) * dx + (z - az) * dz) / len2;
    // A rounded proximity test extended the other road past its end and punched
    // holes in intact parapets. An opening must lead onto actual pavement.
    if (u <= 0 || u >= 1) continue;
    const w = (other.half?.[n - 1] ?? half) + ((other.half?.[n] ?? half) - (other.half?.[n - 1] ?? half)) * u;
    const h = other.h[n - 1] + (other.h[n] - other.h[n - 1]) * u;
    if (Math.hypot(x - ax - u * dx, z - az - u * dz) < w - 0.01 && Math.abs(a.h + (b.h - a.h) * t - h) < 0.4) return true;
  }
  return false;
}

/** Build the collision index in the worker, never during the first wheel query. */
export function buildRoadSurface(data: Float32Array): RoadSurfaceData {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < data.length; i += 3) { x0 = Math.min(x0, data[i]); x1 = Math.max(x1, data[i]); z0 = Math.min(z0, data[i + 2]); z1 = Math.max(z1, data[i + 2]); }
  if (!data.length) return { triangles: data, cell: 32, x0: 0, z0: 0, nx: 0, nz: 0, offsets: new Uint32Array(1), entries: new Uint32Array() };
  const cell = Math.max(16, (x1 - x0) / 96, (z1 - z0) / 96);
  x0 = Math.floor(x0 / cell) * cell; z0 = Math.floor(z0 / cell) * cell;
  const nx = Math.floor((x1 - x0) / cell) + 1, nz = Math.floor((z1 - z0) / cell) + 1;
  const counts = new Uint32Array(nx * nz);
  const each = (visit: (key: number, i: number) => void) => {
    for (let i = 0; i < data.length; i += 9) {
      const xa = Math.floor((Math.min(data[i], data[i + 3], data[i + 6]) - x0) / cell), xb = Math.floor((Math.max(data[i], data[i + 3], data[i + 6]) - x0) / cell);
      const za = Math.floor((Math.min(data[i + 2], data[i + 5], data[i + 8]) - z0) / cell), zb = Math.floor((Math.max(data[i + 2], data[i + 5], data[i + 8]) - z0) / cell);
      for (let z = za; z <= zb; z++) for (let x = xa; x <= xb; x++) visit(z * nx + x, i);
    }
  };
  each(key => counts[key]++);
  const offsets = new Uint32Array(counts.length + 1);
  for (let i = 0; i < counts.length; i++) offsets[i + 1] = offsets[i] + counts[i];
  const entries = new Uint32Array(offsets[offsets.length - 1]); counts.fill(0);
  each((key, i) => { entries[offsets[key] + counts[key]++] = i; });
  return { triangles: data, cell, x0, z0, nx, nz, offsets, entries };
}

/** Exact triangle height, selecting the nearest storey when an altitude is supplied. */
export function surfaceHeight(data: RoadSurfaceData, x: number, z: number, altitude?: number): number | null {
  const cx = Math.floor((x - data.x0) / data.cell), cz = Math.floor((z - data.z0) / data.cell);
  if (cx < 0 || cz < 0 || cx >= data.nx || cz >= data.nz) return null;
  const key = cz * data.nx + cx, triangles = data.triangles;
  let best: number | null = null, score = Infinity;
  for (let entry = data.offsets[key]; entry < data.offsets[key + 1]; entry++) {
    const i = data.entries[entry];
    const ax = triangles[i], az = triangles[i + 2], ux = triangles[i + 3] - ax, uz = triangles[i + 5] - az, vx = triangles[i + 6] - ax, vz = triangles[i + 8] - az;
    const den = ux * vz - uz * vx; if (Math.abs(den) < 1e-10) continue;
    const u = ((x - ax) * vz - (z - az) * vx) / den, v = (ux * (z - az) - uz * (x - ax)) / den;
    // Float32 coordinates and neighbouring quads can disagree by a few ulps.
    if (u < -1e-4 || v < -1e-4 || u + v > 1.0001) continue;
    const h = triangles[i + 1] + u * (triangles[i + 4] - triangles[i + 1]) + v * (triangles[i + 7] - triangles[i + 1]);
    const d = altitude == null ? -h : Math.abs(h - altitude);
    if (d < score) { score = d; best = h; }
  }
  return best;
}
