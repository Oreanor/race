import type { Position } from './VehicleController';

type Point = [number, number];
export type Polygon = Point[][];
type CollisionPolygon = { rings: Polygon; bounds: number[] };

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

export class BuildingCollisions {
  origin: Position = [0, 0];
  polygons: CollisionPolygon[] = [];

  local(position: Position): Point {
    return [
      (position[0] - this.origin[0]) * 111319.49 * Math.cos(this.origin[1] * Math.PI / 180),
      (position[1] - this.origin[1]) * 111319.49,
    ];
  }

  update(origin: Position, polygons: Polygon[]) {
    this.origin = [...origin];
    this.polygons = polygons.map(rings => {
      const localRings = rings.map(ring => ring.map(point => this.local(point)));
      const outer = localRings[0];
      return {
        rings: localRings,
        bounds: [
          Math.min(...outer.map(point => point[0])),
          Math.min(...outer.map(point => point[1])),
          Math.max(...outer.map(point => point[0])),
          Math.max(...outer.map(point => point[1])),
        ],
      };
    });
  }

  blocked(from: Position, to: Position, heading: number) {
    const start = this.local(from), end = this.local(to);
    const count = Math.max(1, Math.ceil(Math.hypot(end[0] - start[0], end[1] - start[1]) / 0.4));
    const startDepth = this.depth(start, heading);

    for (let step = 0; step <= count; step++) {
      const t = step / count;
      const center: Point = [start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t];
      const depth = this.depth(center, heading);
      if (startDepth === 0 && depth > 0) return true;
      if (startDepth > 0 && depth > startDepth + 1e-4) return true;
    }

    return startDepth > 0 && this.depth(end, heading) >= startDepth - 1e-4;
  }

  private depth(center: Point, heading: number) {
    let deepest = 0;
    for (const shift of [-1.1, 0, 1.1]) {
      const point: Point = [center[0] + Math.sin(heading) * shift, center[1] + Math.cos(heading) * shift];
      for (const polygon of this.polygons) {
        const [x0, y0, x1, y1] = polygon.bounds;
        if (point[0] + 0.95 < x0 || point[0] - 0.95 > x1 || point[1] + 0.95 < y0 || point[1] - 0.95 > y1) continue;
        deepest = Math.max(deepest, polygonPenetrationDepth(point, 0.95, polygon.rings));
      }
    }
    return deepest;
  }
}
