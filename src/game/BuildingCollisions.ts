import { METERS_PER_DEGREE, type Position } from './VehicleController.ts';
import { roofClearanceAt, type RoofProfile } from './buildings/RoofGenerator.ts';


type Point = [number, number];
export type Polygon = Point[][];

/** One building for collisions: footprint + roof skin (`crest` already exaggerated). */
export type BuildingSolid = {
  rings: Polygon;
  crest: number;
  roof: RoofProfile;
};

type CollisionPolygon = {
  rings: Polygon;
  bounds: number[];
  crest: number;
  roof: RoofProfile;
};

function inside(point: Point, ring: Point[]) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if (((a[1] > point[1]) !== (b[1] > point[1]))
      && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}

function distanceSquared(point: Point, a: Point, b: Point) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return (point[0] - a[0] - t * dx) ** 2 + (point[1] - a[1] - t * dy) ** 2;
}

export function polygonPenetrationDepth(point: Point, radius: number, polygon: Polygon) {
  let nearestSquared = Infinity;
  for (const ring of polygon) {
    for (let i = 0; i < ring.length; i++) {
      nearestSquared = Math.min(nearestSquared, distanceSquared(point, ring[i], ring[(i + 1) % ring.length]));
    }
  }
  if (!Number.isFinite(nearestSquared)) return 0;

  const insideSolid = inside(point, polygon[0] ?? [])
    && !polygon.slice(1).some(ring => inside(point, ring));
  const distance = Math.sqrt(nearestSquared);
  if (insideSolid) return radius + distance;
  return distance < radius ? radius - distance : 0;
}

export function circleHitsPolygon(point: Point, radius: number, polygon: Polygon) {
  if (inside(point, polygon[0] ?? []) && !polygon.slice(1).some(ring => inside(point, ring))) return true;
  for (const ring of polygon) {
    for (let i = 0; i < ring.length; i++) {
      if (distanceSquared(point, ring[i], ring[(i + 1) % ring.length]) <= radius * radius) return true;
    }
  }
  return false;
}

/** Flat infinite-height stand-in when only rings are known (tests / spawn search). */
function flatSolid(rings: Polygon): BuildingSolid {
  return { rings, crest: 0, roof: { eaves: 1e9, peak: 1e9, half: 0, ridgeA: null, ridgeB: null } };
}

export class BuildingCollisions {
  origin: Position = [0, 0];
  polygons: CollisionPolygon[] = [];
  private cos = 1;

  local(position: Position): Point {
    return [
      (position[0] - this.origin[0]) * METERS_PER_DEGREE * this.cos,
      (position[1] - this.origin[1]) * METERS_PER_DEGREE,
    ];
  }

  private world(point: Point): Position {
    return [this.origin[0] + point[0] / (METERS_PER_DEGREE * this.cos), this.origin[1] + point[1] / METERS_PER_DEGREE];
  }

  /** Absolute roof altitude at a local-metre point. */
  private roofAlt(point: Point, polygon: CollisionPolygon) {
    return polygon.crest + roofClearanceAt(point[0], point[1], polygon.roof);
  }

  /** Belly clears this building at `point` (small margin so we don't clip the skin). */
  private clears(point: Point, polygon: CollisionPolygon, altitude: number) {
    return altitude > this.roofAlt(point, polygon) - 0.05;
  }

  update(origin: Position, buildings: BuildingSolid[] | Polygon[]) {
    this.origin = [...origin];
    this.cos = Math.cos(this.origin[1] * Math.PI / 180);
    const solids: BuildingSolid[] = buildings.length && buildings[0] != null && 'roof' in (buildings[0] as BuildingSolid)
      ? buildings as BuildingSolid[]
      : (buildings as Polygon[]).map(flatSolid);
    this.polygons = solids.map((building) => {
      const localRings = building.rings.map(ring => ring.map(point => this.local(point)));
      const outer = localRings[0];
      const roof: RoofProfile = building.roof.half > 0 && building.roof.ridgeA && building.roof.ridgeB
        ? {
          eaves: building.roof.eaves,
          peak: building.roof.peak,
          half: building.roof.half,
          ridgeA: { x: this.local([building.roof.ridgeA.x, building.roof.ridgeA.z])[0], z: this.local([building.roof.ridgeA.x, building.roof.ridgeA.z])[1] },
          ridgeB: { x: this.local([building.roof.ridgeB.x, building.roof.ridgeB.z])[0], z: this.local([building.roof.ridgeB.x, building.roof.ridgeB.z])[1] },
        }
        : { eaves: building.roof.eaves, peak: building.roof.peak, half: 0, ridgeA: null, ridgeB: null };
      return {
        rings: localRings,
        bounds: [
          Math.min(...outer.map(point => point[0])),
          Math.min(...outer.map(point => point[1])),
          Math.max(...outer.map(point => point[0])),
          Math.max(...outer.map(point => point[1])),
        ],
        crest: building.crest,
        roof,
      };
    });
  }

  /** Highest roof under a world position, or null. */
  supportAt(position: Position): number | null {
    const point = this.local(position);
    let best: number | null = null;
    for (const polygon of this.polygons) {
      const [x0, y0, x1, y1] = polygon.bounds;
      if (point[0] < x0 || point[0] > x1 || point[1] < y0 || point[1] > y1) continue;
      if (!inside(point, polygon.rings[0] ?? []) || polygon.rings.slice(1).some(ring => inside(point, ring))) continue;
      const top = this.roofAlt(point, polygon);
      if (best == null || top > best) best = top;
    }
    return best;
  }

  /** A building stands on the straight line between two points (sampled every 2 m; for shots). */
  sightBlocked(from: Position, to: Position) {
    const a = this.local(from), b = this.local(to);
    const count = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2));
    for (let step = 1; step < count; step++) {
      const t = step / count;
      const point: Point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      for (const polygon of this.polygons) {
        const [x0, y0, x1, y1] = polygon.bounds;
        if (point[0] < x0 || point[0] > x1 || point[1] < y0 || point[1] > y1) continue;
        if (inside(point, polygon.rings[0] ?? []) && !polygon.rings.slice(1).some(ring => inside(point, ring))) return true;
      }
    }
    return false;
  }

  blocked(from: Position, to: Position, heading: number, scale = 1, altitude = -Infinity) {
    return this.hits(this.local(from), this.local(to), heading, scale, altitude);
  }

  /** Glancing hits slide along the wall; head-on stops. Corners skim instead of snagging. */
  resolve(from: Position, to: Position, heading: number, scale = 1, altitude = -Infinity) {
    const start = this.local(from);
    const end = this.local(to);
    if (!this.hits(start, end, heading, scale, altitude)) return { position: to, stopped: false, slid: false };
    const startDepth = this.depth(start, heading, scale, altitude);
    if (startDepth > 0 && this.depth(end, heading, scale, altitude) < startDepth - 1e-6 && !this.deepens(start, end, heading, scale, altitude)) {
      return { position: to, stopped: false, slid: false };
    }
    const slid = this.slide(start, end, heading, scale, altitude);
    if (slid) {
      const slidDepth = this.depth(slid, heading, scale, altitude);
      // Accept slides that skim or ease out — including corner grazes that still touch.
      if (slidDepth <= startDepth + 0.12 && !this.deepens(start, slid, heading, scale, altitude)) {
        return { position: this.world(slid), stopped: false, slid: true };
      }
    }
    const clamped = this.clamp(start, end, heading, scale, altitude);
    const moved = Math.hypot(clamped[0] - start[0], clamped[1] - start[1]) > 0.05;
    return { position: moved ? this.world(clamped) : from, stopped: true, slid: false };
  }

  private hits(from: Point, to: Point, heading: number, scale: number, altitude: number) {
    const count = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / 0.4));
    const startDepth = this.depth(from, heading, scale, altitude);
    for (let step = 0; step <= count; step++) {
      const t = step / count;
      const center: Point = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
      const depth = this.depth(center, heading, scale, altitude);
      if (startDepth === 0 && depth > 0) return true;
      if (startDepth > 0 && depth > startDepth + 1e-4) return true;
    }
    return startDepth > 0 && this.depth(to, heading, scale, altitude) >= startDepth - 1e-4;
  }

  private deepens(from: Point, to: Point, heading: number, scale: number, altitude: number) {
    const start = this.depth(from, heading, scale, altitude);
    const count = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / 0.4));
    for (let step = 1; step <= count; step++) {
      const t = step / count;
      const point: Point = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
      if (this.depth(point, heading, scale, altitude) > start + 1e-6) return true;
    }
    return false;
  }

  private depth(center: Point, heading: number, scale: number, altitude: number) {
    let deepest = 0;
    const radius = 1.2 * scale;
    for (const shift of [-1.1, 0, 1.1]) {
      const scaledShift = shift * scale;
      const point: Point = [center[0] + Math.sin(heading) * scaledShift, center[1] + Math.cos(heading) * scaledShift];
      for (const polygon of this.polygons) {
        const [x0, y0, x1, y1] = polygon.bounds;
        if (point[0] + radius < x0 || point[0] - radius > x1 || point[1] + radius < y0 || point[1] - radius > y1) continue;
        if (this.clears(point, polygon, altitude)) continue;
        deepest = Math.max(deepest, polygonPenetrationDepth(point, radius, polygon.rings));
      }
    }
    return deepest;
  }

  private contact(center: Point, heading: number, scale: number, altitude: number) {
    const radius = 1.2 * scale;
    let best: { point: Point; polygon: CollisionPolygon; depth: number } | null = null;
    for (const shift of [-1.1, 0, 1.1]) {
      const scaledShift = shift * scale;
      const point: Point = [center[0] + Math.sin(heading) * scaledShift, center[1] + Math.cos(heading) * scaledShift];
      for (const polygon of this.polygons) {
        const [x0, y0, x1, y1] = polygon.bounds;
        if (point[0] + radius < x0 || point[0] - radius > x1 || point[1] + radius < y0 || point[1] - radius > y1) continue;
        if (this.clears(point, polygon, altitude)) continue;
        const depth = polygonPenetrationDepth(point, radius, polygon.rings);
        if (depth <= 0) continue;
        if (!best || depth > best.depth) best = { point, polygon, depth };
      }
    }
    return best;
  }

  /** Unit outward normal at `point`; near vertices, blend both edges so corners don't snag. */
  private outward(point: Point, polygon: CollisionPolygon): Point {
    type EdgeHit = { ax: number; ay: number; bx: number; by: number; t: number; dist: number };
    let best: EdgeHit | null = null;
    let ring = polygon.rings[0] ?? [];
    let index = 0;
    for (const candidate of polygon.rings) {
      for (let i = 0; i < candidate.length; i++) {
        const a = candidate[i];
        const b = candidate[(i + 1) % candidate.length];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const span2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / span2));
        const cx = a[0] + t * dx, cy = a[1] + t * dy;
        const dist = Math.hypot(point[0] - cx, point[1] - cy);
        if (!best || dist < best.dist) {
          best = { ax: a[0], ay: a[1], bx: b[0], by: b[1], t, dist };
          ring = candidate;
          index = i;
        }
      }
    }
    if (!best) return [0, 1];

    const edgeNormal = (ax: number, ay: number, bx: number, by: number): Point => {
      const dx = bx - ax, dy = by - ay;
      const span = Math.hypot(dx, dy) || 1;
      // outward for CCW rings: right-hand perpendicular
      let nx = dy / span, ny = -dx / span;
      const mid: Point = [(ax + bx) / 2, (ay + by) / 2];
      if (inside([mid[0] + nx * 0.35, mid[1] + ny * 0.35], polygon.rings[0] ?? [])) {
        nx = -nx;
        ny = -ny;
      }
      return [nx, ny];
    };

    let nx: number;
    let ny: number;
    const corner = 0.22; // metres along the edge — blend so sharp corners feel rounded
    if (best.t <= corner || best.t >= 1 - corner) {
      const prev = ring[(index - 1 + ring.length) % ring.length];
      const a = ring[index];
      const b = ring[(index + 1) % ring.length];
      const next = ring[(index + 2) % ring.length];
      const n0 = edgeNormal(prev[0], prev[1], a[0], a[1]);
      const n1 = edgeNormal(a[0], a[1], b[0], b[1]);
      const n2 = edgeNormal(b[0], b[1], next[0], next[1]);
      const blend = best.t <= corner ? (corner - best.t) / corner : (best.t - (1 - corner)) / corner;
      const left = best.t <= corner ? n0 : n1;
      const right = best.t <= corner ? n1 : n2;
      nx = left[0] * blend + right[0] * (1 - blend);
      ny = left[1] * blend + right[1] * (1 - blend);
      // At the vertex itself, average both faces (rounded corner).
      if (best.t < 0.02 || best.t > 0.98) {
        nx = left[0] + right[0];
        ny = left[1] + right[1];
      }
      const len = Math.hypot(nx, ny) || 1;
      nx /= len;
      ny /= len;
    } else {
      const closest: Point = [
        best.ax + best.t * (best.bx - best.ax),
        best.ay + best.t * (best.by - best.ay),
      ];
      nx = point[0] - closest[0];
      ny = point[1] - closest[1];
      const length = Math.hypot(nx, ny);
      if (length < 0.001) {
        [nx, ny] = edgeNormal(best.ax, best.ay, best.bx, best.by);
      } else {
        nx /= length;
        ny /= length;
      }
      const solid = inside(point, polygon.rings[0] ?? [])
        && !polygon.rings.slice(1).some(hole => inside(point, hole));
      if (solid || inside([closest[0] + nx * 0.35, closest[1] + ny * 0.35], polygon.rings[0] ?? [])) {
        nx = -nx;
        ny = -ny;
      }
    }
    return [nx, ny];
  }

  private slide(from: Point, to: Point, heading: number, scale: number, altitude: number) {
    const count = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / 0.4));
    let normal: Point | null = null;
    let sink = 0;
    for (let step = 0; step <= count; step++) {
      const t = step / count;
      const center: Point = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
      const hit = this.contact(center, heading, scale, altitude);
      if (!hit) continue;
      normal = this.outward(hit.point, hit.polygon);
      sink = hit.depth;
      break;
    }
    if (!normal) return null;
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const into = dx * normal[0] + dy * normal[1];
    // Remove only the component pushing into the wall; keep the tangent.
    let sx = into < 0 ? dx - normal[0] * into : dx;
    let sy = into < 0 ? dy - normal[1] * into : dy;
    // Ease off the face a hair so the next frame does not re-catch the same corner.
    const lift = Math.min(0.18, sink + 0.04);
    sx += normal[0] * lift;
    sy += normal[1] * lift;
    if (Math.hypot(sx, sy) < 1e-8) return null;
    return [from[0] + sx, from[1] + sy] as Point;
  }

  private clamp(from: Point, to: Point, heading: number, scale: number, altitude: number) {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 10; i++) {
      const mid = (lo + hi) / 2;
      const point: Point = [from[0] + (to[0] - from[0]) * mid, from[1] + (to[1] - from[1]) * mid];
      if (this.hits(from, point, heading, scale, altitude)) hi = mid;
      else lo = mid;
    }
    if (lo < 0.04) return from;
    return [from[0] + (to[0] - from[0]) * lo, from[1] + (to[1] - from[1]) * lo] as Point;
  }
}
