import type { Position } from './VehicleController';
import { roofClearanceAt, type RoofProfile } from './buildings/RoofGenerator';

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
      (position[0] - this.origin[0]) * 111319.49 * this.cos,
      (position[1] - this.origin[1]) * 111319.49,
    ];
  }

  private world(point: Point): Position {
    return [this.origin[0] + point[0] / (111319.49 * this.cos), this.origin[1] + point[1] / 111319.49];
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

  /** Glancing hits slide along the wall; head-on stops. */
  resolve(from: Position, to: Position, heading: number, scale = 1, altitude = -Infinity) {
    const start = this.local(from);
    const end = this.local(to);
    if (!this.hits(start, end, heading, scale, altitude)) return { position: to, stopped: false, slid: false };
    const startDepth = this.depth(start, heading, scale, altitude);
    if (startDepth > 0 && this.depth(end, heading, scale, altitude) < startDepth - 1e-6 && !this.deepens(start, end, heading, scale, altitude)) {
      return { position: to, stopped: false, slid: false };
    }
    const slid = this.slide(start, end, heading, scale, altitude);
    if (slid && !this.hits(start, slid, heading, scale, altitude)) {
      return { position: this.world(slid), stopped: false, slid: true };
    }
    if (slid && this.hits(start, start, heading, scale, altitude) && !this.deepens(start, slid, heading, scale, altitude)) {
      return { position: this.world(slid), stopped: false, slid: true };
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

  private outward(point: Point, polygon: CollisionPolygon): Point {
    let best = Infinity;
    let ax = 0, ay = 0, bx = 0, by = 0;
    for (const ring of polygon.rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        const distance = Math.sqrt(distanceSquared(point, a, b));
        if (distance < best) {
          best = distance;
          ax = a[0]; ay = a[1];
          bx = b[0]; by = b[1];
        }
      }
    }
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((point[0] - ax) * dx + (point[1] - ay) * dy) / (dx * dx + dy * dy || 1)));
    const closest: Point = [ax + t * dx, ay + t * dy];
    let nx = point[0] - closest[0];
    let ny = point[1] - closest[1];
    const length = Math.hypot(nx, ny);
    if (length < 0.001) {
      const span = Math.hypot(dx, dy) || 1;
      nx = -dy / span;
      ny = dx / span;
    } else {
      nx /= length;
      ny /= length;
    }
    const solid = inside(point, polygon.rings[0] ?? [])
      && !polygon.rings.slice(1).some(ring => inside(point, ring));
    // Push out of the building: if we're inside, flip so normal points outward.
    if (solid) {
      nx = -nx;
      ny = -ny;
    } else if (inside([closest[0] + nx * 0.35, closest[1] + ny * 0.35], polygon.rings[0] ?? [])) {
      nx = -nx;
      ny = -ny;
    }
    return [nx, ny];
  }

  private slide(from: Point, to: Point, heading: number, scale: number, altitude: number) {
    const count = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / 0.4));
    let normal: Point | null = null;
    for (let step = 0; step <= count && !normal; step++) {
      const t = step / count;
      const center: Point = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
      const hit = this.contact(center, heading, scale, altitude);
      if (!hit) continue;
      normal = this.outward(hit.point, hit.polygon);
    }
    if (!normal) return null;
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const into = dx * normal[0] + dy * normal[1];
    // Remove only the component pushing into the wall; keep the tangent.
    const sx = into < 0 ? dx - normal[0] * into : dx;
    const sy = into < 0 ? dy - normal[1] * into : dy;
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
