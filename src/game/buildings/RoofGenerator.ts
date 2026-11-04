export type RoofPoint = { x: number; z: number };
export type RoofKind = 'gable' | 'hip' | 'tile';

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

export function buildRoof(points: RoofPoint[], yBase: number, kind: RoofKind): RoofMesh | null {
  const ring = simplifyRing(points);
  if (!canPitch(ring)) return null;
  const lens = ring.map((point, index) => edgeLength(point, ring[(index + 1) % 4]));
  const longIs0 = lens[0] + lens[2] >= lens[1] + lens[3];
  const eave1a = longIs0 ? ring[0] : ring[1];
  const eave1b = longIs0 ? ring[1] : ring[2];
  const eave2a = longIs0 ? ring[3] : ring[0];
  const eave2b = longIs0 ? ring[2] : ring[3];
  const length = edgeLength(eave1a, eave1b);
  const width = Math.hypot((eave1a.x + eave1b.x) / 2 - (eave2a.x + eave2b.x) / 2, (eave1a.z + eave1b.z) / 2 - (eave2a.z + eave2b.z) / 2);
  const rise = Math.max(0.75, Math.min(3.3, width * (kind === 'hip' ? 0.34 : 0.38)));
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
