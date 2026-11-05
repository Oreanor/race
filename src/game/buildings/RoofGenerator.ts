export type RoofPoint = { x: number; z: number };
export type RoofKind = 'gable' | 'hip' | 'tile' | 'mansard' | 'gableFront' | 'compound';

export function simplifyRing(points: RoofPoint[], tolerance = 0.45): RoofPoint[] {
  if (points.length <= 3) return points.slice();
  const kept: RoofPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[(i + points.length - 1) % points.length];
    const next = points[(i + 1) % points.length];
    const cur = points[i];
    if (Math.hypot(cur.x - prev.x, cur.z - prev.z) < 0.3) continue;
    const ax = cur.x - prev.x;
    const az = cur.z - prev.z;
    const bx = next.x - cur.x;
    const bz = next.z - cur.z;
    const base = Math.hypot(ax, az) * Math.hypot(bx, bz);
    const cross = ax * bz - az * bx;
    if (base > 0 && Math.abs(cross) / base < 0.09) continue;
    kept.push(cur);
  }
  return kept.length >= 3 ? kept : points.slice();
}

function edgeLength(a: RoofPoint, b: RoofPoint) {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

export function canPitch(points: RoofPoint[]) {
  const ring = simplifyRing(points);
  if (ring.length !== 4) return false;
  const lens = ring.map((point, index) => edgeLength(point, ring[(index + 1) % 4]));
  if (lens.some((length) => length < 3.2) || Math.max(...lens) > 44) return false;
  for (let i = 0; i < 4; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % 4];
    const c = ring[(i + 2) % 4];
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const bcx = c.x - b.x;
    const bcz = c.z - b.z;
    const denom = Math.hypot(abx, abz) * Math.hypot(bcx, bcz) || 1;
    if (Math.abs((abx * bcx + abz * bcz) / denom) > 0.28) return false;
  }
  const opposite = (index: number) => Math.abs(lens[index] - lens[(index + 2) % 4]) / Math.max(lens[index], lens[(index + 2) % 4]);
  return opposite(0) < 0.16 && opposite(1) < 0.16;
}

type V3 = { x: number; y: number; z: number };

export type RoofMesh = {
  positions: number[];
  normals: number[];
  ridgeY: number;
  eavesY: number;
  halfWidth: number;
  ridgeA: RoofPoint;
  ridgeB: RoofPoint;
};

/** Roof as a collision surface: flat (half ≤ 0) or pitched down from the ridge. */
export type RoofProfile = {
  eaves: number;
  peak: number;
  half: number;
  ridgeA: RoofPoint | null;
  ridgeB: RoofPoint | null;
};

/** Height of the roof skin above the building base at (x, z). */
export function roofClearanceAt(x: number, z: number, roof: RoofProfile) {
  if (roof.half <= 0 || !roof.ridgeA || !roof.ridgeB) return roof.peak;
  const ax = roof.ridgeA.x, az = roof.ridgeA.z;
  const bx = roof.ridgeB.x, bz = roof.ridgeB.z;
  const dx = bx - ax, dz = bz - az;
  const span = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / span));
  const dist = Math.hypot(x - ax - t * dx, z - az - t * dz);
  const fall = Math.min(1, dist / roof.half);
  return roof.peak - fall * (roof.peak - roof.eaves);
}

/**
 * A low-poly roof over a footprint, or null when the shape doesn't take one.
 * gable / tile (gable + ridge cap) / hip on near-rectangles; gableFront turns the ridge
 * across (the gable end on the long side) on squat footprints; mansard has steep lower
 * slopes all round, a low hip on top and, from `seed`, 0–2 small dormers; compound puts
 * two crossing gables on an L-shaped footprint.
 */
export function buildRoof(points: RoofPoint[], yBase: number, kind: RoofKind, seed = 0): RoofMesh | null {
  const ring = simplifyRing(points);
  if (kind === 'compound') return buildCompound(ring, yBase) ?? (canPitch(ring) ? pitched(ring, yBase, 'gable') : null);
  if (!canPitch(ring)) return null;
  if (kind === 'mansard') return buildMansard(ring, yBase, seed);
  if (kind === 'gableFront') {
    const lens = ring.map((point, index) => edgeLength(point, ring[(index + 1) % 4]));
    const ratio = Math.max(lens[0] + lens[2], lens[1] + lens[3]) / Math.max(1e-6, Math.min(lens[0] + lens[2], lens[1] + lens[3]));
    // a ridge across a long block would tower over it: only squat footprints turn
    return pitched(ring, yBase, 'gable', ratio < 1.5 ? 'short' : 'long');
  }
  return pitched(ring, yBase, kind);
}

/** Gable, tile or hip over a 4-corner ring; `axis` picks the ridge direction, `riseCap` limits its height. */
function pitched(ring: RoofPoint[], yBase: number, kind: 'gable' | 'hip' | 'tile', axis: 'long' | 'short' | 'edge0' = 'long', riseCap = Infinity): RoofMesh {
  const lens = ring.map((point, index) => edgeLength(point, ring[(index + 1) % 4]));
  const longest = lens[0] + lens[2] >= lens[1] + lens[3];
  const longIs0 = axis === 'edge0' ? true : axis === 'long' ? longest : !longest;
  const eave1a = longIs0 ? ring[0] : ring[1];
  const eave1b = longIs0 ? ring[1] : ring[2];
  const eave2a = longIs0 ? ring[3] : ring[0];
  const eave2b = longIs0 ? ring[2] : ring[3];
  const length = edgeLength(eave1a, eave1b);
  const width = Math.hypot((eave1a.x + eave1b.x) / 2 - (eave2a.x + eave2b.x) / 2, (eave1a.z + eave1b.z) / 2 - (eave2a.z + eave2b.z) / 2);
  const rise = Math.min(riseCap, Math.max(0.75, Math.min(3.3, width * (kind === 'hip' ? 0.34 : 0.38))));
  const positions: number[] = [];
  const normals: number[] = [];
  const center = {
    x: ring.reduce((sum, point) => sum + point.x, 0) / ring.length,
    y: yBase,
    z: ring.reduce((sum, point) => sum + point.z, 0) / ring.length,
  };
  const at = (point: RoofPoint, y: number): V3 => ({ x: point.x, y, z: point.z });
  const y = yBase + rise;
  let ridgeA: V3;
  let ridgeB: V3;
  if (kind === 'hip') {
    const dirX = (eave1b.x - eave1a.x) / (length || 1);
    const dirZ = (eave1b.z - eave1a.z) / (length || 1);
    const center = {
      x: (eave1a.x + eave1b.x + eave2a.x + eave2b.x) / 4,
      z: (eave1a.z + eave1b.z + eave2a.z + eave2b.z) / 4,
    };
    const ridge = Math.max(0, length - width);
    ridgeA = { x: center.x - dirX * ridge / 2, y, z: center.z - dirZ * ridge / 2 };
    ridgeB = { x: center.x + dirX * ridge / 2, y, z: center.z + dirZ * ridge / 2 };
  } else {
    ridgeA = { x: (eave1a.x + eave2a.x) / 2, y, z: (eave1a.z + eave2a.z) / 2 };
    ridgeB = { x: (eave1b.x + eave2b.x) / 2, y, z: (eave1b.z + eave2b.z) / 2 };
  }
  const slope = (a: V3, b: V3, c: V3, d: V3) => {
    pushTri(positions, normals, a, b, c, true);
    if (Math.hypot(c.x - d.x, c.z - d.z) > 0.05) pushTri(positions, normals, a, c, d, true);
  };
  slope(at(eave1a, yBase), at(eave1b, yBase), ridgeB, ridgeA);
  slope(at(eave2b, yBase), at(eave2a, yBase), ridgeA, ridgeB);
  if (kind === 'hip') {
    pushTri(positions, normals, at(eave1a, yBase), ridgeA, at(eave2a, yBase), true);
    pushTri(positions, normals, at(eave1b, yBase), at(eave2b, yBase), ridgeB, true);
  } else {
    pushTri(positions, normals, at(eave1a, yBase), at(eave2a, yBase), ridgeA, false, center);
    pushTri(positions, normals, at(eave1b, yBase), ridgeB, at(eave2b, yBase), false, center);
  }
  if (kind === 'tile') addRidge(positions, normals, ridgeA, ridgeB);
  return { positions, normals, ridgeY: y, eavesY: yBase, halfWidth: width / 2, ridgeA, ridgeB };
}

/** Mansard: steep lower slopes on all four sides, a low hip over them, a few dormers. */
function buildMansard(ring: RoofPoint[], yBase: number, seed: number): RoofMesh {
  const lens = ring.map((point, index) => edgeLength(point, ring[(index + 1) % 4]));
  const d = Math.min(1.5, Math.min(...lens) * 0.2);
  const h1 = Math.min(2.6, Math.max(1.6, d * 1.9));
  const inner = ring.map((p, i) => {
    const next = ring[(i + 1) % 4], prev = ring[(i + 3) % 4];
    const ul = edgeLength(p, next) || 1, vl = edgeLength(p, prev) || 1;
    return { x: p.x + ((next.x - p.x) / ul + (prev.x - p.x) / vl) * d, z: p.z + ((next.z - p.z) / ul + (prev.z - p.z) / vl) * d };
  });
  const positions: number[] = [];
  const normals: number[] = [];
  const y1 = yBase + h1;
  for (let i = 0; i < 4; i++) {
    const a = ring[i], b = ring[(i + 1) % 4], ib = inner[(i + 1) % 4], ia = inner[i];
    pushTri(positions, normals, { x: a.x, y: yBase, z: a.z }, { x: b.x, y: yBase, z: b.z }, { x: ib.x, y: y1, z: ib.z }, true);
    pushTri(positions, normals, { x: a.x, y: yBase, z: a.z }, { x: ib.x, y: y1, z: ib.z }, { x: ia.x, y: y1, z: ia.z }, true);
  }
  const innerLens = inner.map((point, index) => edgeLength(point, inner[(index + 1) % 4]));
  const top = pitched(inner, y1, 'hip', 'long', Math.min(0.7, Math.min(...innerLens) * 0.12));
  positions.push(...top.positions);
  normals.push(...top.normals);
  // dormers: small shed boxes on the two long lower slopes (none on a third of the roofs)
  const count = seed % 3 === 0 ? 0 : (seed >> 3) % 2 + 1;
  const longIs0 = lens[0] + lens[2] >= lens[1] + lens[3];
  const cx = ring.reduce((s, p) => s + p.x, 0) / 4, cz = ring.reduce((s, p) => s + p.z, 0) / 4;
  for (const e of longIs0 ? [0, 2] : [1, 3]) {
    const a = ring[e], b = ring[(e + 1) % 4];
    const len = edgeLength(a, b);
    if (!count || len < 5) continue;
    const ux = (b.x - a.x) / len, uz = (b.z - a.z) / len;
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    // inward (toward the middle of the roof), across the edge
    let nx = -uz, nz = ux;
    if (nx * (cx - mx) + nz * (cz - mz) < 0) { nx = -nx; nz = -nz; }
    const w = Math.min(0.75, len * 0.08);
    const xf = d * 0.3;                                  // front face, in from the eaves
    const yf = yBase + h1 * 0.3;                         // where the front meets the slope
    const yt = Math.min(y1 - 0.15, yf + 1.05);           // flat top
    const xb = d * (yt - yBase) / h1;                    // where the top meets the slope
    for (let k = 0; k < count; k++) {
      const t = count === 1 ? 0.5 : k === 0 ? 0.32 : 0.68;
      const px = a.x + (b.x - a.x) * t, pz = a.z + (b.z - a.z) * t;
      const P = (along: number, depth: number, y: number): V3 => ({ x: px + ux * along + nx * depth, y, z: pz + uz * along + nz * depth });
      const dc = { x: px + nx * d * 2, y: yt, z: pz + nz * d * 2 };   // a point inside, for facing
      // front
      pushTri(positions, normals, P(-w, xf, yf), P(w, xf, yf), P(w, xf, yt), false, dc);
      pushTri(positions, normals, P(-w, xf, yf), P(w, xf, yt), P(-w, xf, yt), false, dc);
      // top
      pushTri(positions, normals, P(-w, xf, yt), P(w, xf, yt), P(w, xb, yt), true);
      pushTri(positions, normals, P(-w, xf, yt), P(w, xb, yt), P(-w, xb, yt), true);
      // cheeks
      pushTri(positions, normals, P(-w, xf, yf), P(-w, xf, yt), P(-w, xb, yt), false, P(0, xb, yt));
      pushTri(positions, normals, P(w, xf, yf), P(w, xb, yt), P(w, xf, yt), false, P(0, xb, yt));
    }
  }
  return { positions, normals, ridgeY: top.ridgeY, eavesY: yBase, halfWidth: Math.min(...lens) / 2, ridgeA: top.ridgeA, ridgeB: top.ridgeB };
}

/**
 * Two crossing gables on an L-shaped footprint (6 right-angled corners): the long arm
 * keeps its ridge along it, the short arm runs across and meets the main ridge, never higher.
 */
function buildCompound(ring: RoofPoint[], yBase: number): RoofMesh | null {
  if (ring.length !== 6) return null;
  const lens = ring.map((point, index) => edgeLength(point, ring[(index + 1) % 6]));
  if (lens.some((l) => l < 2.5) || Math.max(...lens) > 44) return null;
  let area = 0;
  for (let i = 0; i < 6; i++) { const a = ring[i], b = ring[(i + 1) % 6]; area += a.x * b.z - b.x * a.z; }
  const turn = (i: number) => {
    const p = ring[(i + 5) % 6], c = ring[i], n = ring[(i + 1) % 6];
    const ax = c.x - p.x, az = c.z - p.z, bx = n.x - c.x, bz = n.z - c.z;
    const dot = (ax * bx + az * bz) / ((Math.hypot(ax, az) * Math.hypot(bx, bz)) || 1);
    return { cross: ax * bz - az * bx, dot };
  };
  let reflex = -1;
  for (let i = 0; i < 6; i++) {
    const { cross, dot } = turn(i);
    if (Math.abs(dot) > 0.2) return null;
    if (cross * area < 0) { if (reflex >= 0) return null; reflex = i; }
  }
  if (reflex < 0) return null;
  // local frame along the longest edge
  const li = lens.indexOf(Math.max(...lens));
  const ux = (ring[(li + 1) % 6].x - ring[li].x) / lens[li], uz = (ring[(li + 1) % 6].z - ring[li].z) / lens[li];
  const vx = -uz, vz = ux;
  const st = ring.map((p) => ({ s: p.x * ux + p.z * uz, t: p.x * vx + p.z * vz }));
  const s0 = Math.min(...st.map((q) => q.s)), s1 = Math.max(...st.map((q) => q.s));
  const t0 = Math.min(...st.map((q) => q.t)), t1 = Math.max(...st.map((q) => q.t));
  const r = st[reflex];
  const highS = r.s > (s0 + s1) / 2, highT = r.t > (t0 + t1) / 2;
  // the main arm runs the full length; the short arm is the rest
  const [at0, at1] = highT ? [t0, r.t] : [r.t, t1];
  const [bs0, bs1] = highS ? [s0, r.s] : [r.s, s1];
  const overlap = (at1 - at0) / 2;
  const [bt0, bt1] = highT ? [r.t - overlap, t1] : [t0, r.t + overlap];
  const back = (s: number, t: number): RoofPoint => ({ x: s * ux + t * vx, z: s * uz + t * vz });
  const rectA = [back(s0, at0), back(s1, at0), back(s1, at1), back(s0, at1)];
  const rectB = [back(bs0, bt0), back(bs0, bt1), back(bs1, bt1), back(bs1, bt0)];
  if (s1 - s0 < 3.2 || at1 - at0 < 3.2 || bs1 - bs0 < 3.2) return null;
  const main = pitched(rectA, yBase, 'gable', 'edge0');
  const arm = pitched(rectB, yBase, 'gable', 'edge0', main.ridgeY - yBase);
  return {
    positions: [...main.positions, ...arm.positions],
    normals: [...main.normals, ...arm.normals],
    ridgeY: main.ridgeY, eavesY: yBase, halfWidth: main.halfWidth, ridgeA: main.ridgeA, ridgeB: main.ridgeB,
  };
}

function pushTri(positions: number[], normals: number[], a: V3, b: V3, c: V3, upward: boolean, center?: V3) {
  let nx = (b.y - a.y) * (c.z - a.z) - (b.z - a.z) * (c.y - a.y);
  let ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
  let nz = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const length = Math.hypot(nx, ny, nz) || 1;
  nx /= length;
  ny /= length;
  nz /= length;
  let pb = b;
  let pc = c;
  const midX = (a.x + b.x + c.x) / 3;
  const midY = (a.y + b.y + c.y) / 3;
  const midZ = (a.z + b.z + c.z) / 3;
  const inward = center ? nx * (center.x - midX) + ny * (center.y - midY) + nz * (center.z - midZ) : 0;
  if ((upward && ny < 0) || (!upward && inward > 0)) {
    pb = c;
    pc = b;
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  positions.push(a.x, a.y, a.z, pb.x, pb.y, pb.z, pc.x, pc.y, pc.z);
  normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
}

function addRidge(positions: number[], normals: number[], a: V3, b: V3) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dz) || 1;
  const px = -dz / length * 0.14;
  const pz = dx / length * 0.14;
  const lift = (point: V3, x: number, z: number, y: number): V3 => ({ x: point.x + x, y, z: point.z + z });
  const a1 = lift(a, px, pz, a.y);
  const a2 = lift(a, -px, -pz, a.y);
  const b1 = lift(b, px, pz, b.y);
  const b2 = lift(b, -px, -pz, b.y);
  const top = a.y + 0.16;
  const a1t = { ...a1, y: top };
  const a2t = { ...a2, y: top };
  const b1t = { ...b1, y: top };
  const b2t = { ...b2, y: top };
  const quad = (p: V3, q: V3, r: V3, s: V3) => {
    pushTri(positions, normals, p, q, r, false);
    pushTri(positions, normals, p, r, s, false);
  };
  quad(a1t, b1t, b2t, a2t);
  quad(a1, b1, b1t, a1t);
  quad(b2, a2, a2t, b2t);
}
