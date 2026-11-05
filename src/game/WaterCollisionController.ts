import { circleHitsPolygon, type Polygon } from './BuildingCollisions.ts';
import { type Position, metersBetween } from './VehicleController.ts';

type Point = [number, number];
type LocalPolygon = { rings: Polygon; bounds: number[] };
type LocalBridge = { ax: number; ay: number; bx: number; by: number; half: number };

export type MapFeature = {
  id?: string | number;
  geometry: { type: string; coordinates: unknown };
  properties?: Record<string, unknown> | null;
};

const METERS = 111319.49;
const REACH = 900;

function inside(point: Point, ring: Point[]) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}

function contained(point: Point, rings: Polygon) {
  if (!rings[0] || !inside(point, rings[0])) return false;
  return !rings.slice(1).some((ring) => inside(point, ring));
}

function distanceToSegment(point: Point, a: Point, b: Point) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy);
}

function bboxNear(origin: Position, ring: Point[], meters: number) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of ring) {
    minX = Math.min(minX, point[0]);
    minY = Math.min(minY, point[1]);
    maxX = Math.max(maxX, point[0]);
    maxY = Math.max(maxY, point[1]);
  }
  const x = Math.max(minX, Math.min(origin[0], maxX));
  const y = Math.max(minY, Math.min(origin[1], maxY));
  return metersBetween(origin, [x, y]) <= meters;
}

function polygonsOf(geometry: MapFeature['geometry']): Polygon[] {
  if (geometry.type === 'Polygon') return [geometry.coordinates as Polygon];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates as Polygon[];
  return [];
}

function linesOf(geometry: MapFeature['geometry']): Position[][] {
  if (geometry.type === 'LineString') return [geometry.coordinates as Position[]];
  if (geometry.type === 'MultiLineString') return geometry.coordinates as Position[][];
  return [];
}

function deckHalf(kind: string) {
  if (kind === 'motorway' || kind === 'trunk') return 14;
  if (kind === 'primary') return 11;
  if (kind === 'secondary' || kind === 'tertiary') return 8;
  return 6;
}

function isBridge(properties: Record<string, unknown> | null | undefined) {
  const brunnel = properties?.brunnel;
  const bridge = properties?.bridge;
  return brunnel === 'bridge' || bridge === 'yes' || bridge === true || bridge === 1;
}

export class WaterCollisionController {
  private origin: Position = [0, 0];
  private anchor: Position = [0, 0];
  private ready = false;
  private polygons: LocalPolygon[] = [];
  private bridges: LocalBridge[] = [];

  covers(position: Position) {
    return this.ready && metersBetween(this.anchor, position) < 220;
  }

  collect(origin: Position, water: Iterable<MapFeature>, roads: Iterable<MapFeature>) {
    const seen = new Set<string>();
    const polygons: Polygon[] = [];
    for (const feature of water) {
      for (const shape of polygonsOf(feature.geometry)) {
        const outer = shape[0];
        if (!outer || outer.length < 3 || !bboxNear(origin, outer, REACH)) continue;
        const key = `${feature.id ?? ''}:${outer[0][0].toFixed(5)}:${outer[0][1].toFixed(5)}:${outer.length}`;
        if (seen.has(key)) continue;
        seen.add(key);
        polygons.push(shape.map((ring) => ring.map((point) => [point[0], point[1]] as Point)));
      }
    }
    const bridges: { line: Position[]; half: number }[] = [];
    for (const feature of roads) {
      if (!isBridge(feature.properties)) continue;
      const half = deckHalf(String(feature.properties?.class ?? ''));
      for (const line of linesOf(feature.geometry)) {
        if (line.length < 2) continue;
        const near = line.some((point) => metersBetween(origin, point) < REACH);
        if (!near) continue;
        bridges.push({ line: line.map((point) => [point[0], point[1]]), half });
      }
    }
    this.update(origin, polygons, bridges);
  }

  update(origin: Position, polygons: Polygon[], bridges: { line: Position[]; half: number }[]) {
    this.origin = [...origin];
    this.anchor = [...origin];
    this.ready = true;
    this.polygons = polygons.flatMap((polygon) => {
      const rings = polygon.map((ring) => ring.map((point) => this.local(point)));
      const outer = rings[0];
      if (!outer || outer.length < 3) return [];
      return [{
        rings,
        bounds: [Math.min(...outer.map((point) => point[0])), Math.min(...outer.map((point) => point[1])), Math.max(...outer.map((point) => point[0])), Math.max(...outer.map((point) => point[1]))],
      }];
    });
    this.bridges = [];
    for (const bridge of bridges) {
      const line = bridge.line.map((point) => this.local(point));
      for (let i = 1; i < line.length; i++) {
        if (Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]) < 0.2) continue;
        this.bridges.push({ ax: line[i - 1][0], ay: line[i - 1][1], bx: line[i][0], by: line[i][1], half: bridge.half });
      }
    }
  }

  resolve(from: Position, to: Position, heading: number, scale = 1) {
    const start = this.local(from);
    const end = this.local(to);
    const size = Math.max(0.35, scale);
    if (!this.hits(start, end, heading, size)) return { position: to, stopped: false };
    const startDepth = this.depth(start, heading, size);
    if (startDepth > 0 && this.depth(end, heading, size) < startDepth - 1e-6 && !this.deepens(start, end, heading, size)) return { position: to, stopped: false };
    const slid = this.slide(start, end, heading, size);
    if (slid && !this.hits(start, slid, heading, size)) return { position: this.world(slid), stopped: false };
    if (slid && this.hits(start, start, heading, size) && !this.deepens(start, slid, heading, size)) return { position: this.world(slid), stopped: false };
    const clamped = this.clamp(start, end, heading, size);
    const moved = Math.hypot(clamped[0] - start[0], clamped[1] - start[1]) > 0.05;
    return { position: moved ? this.world(clamped) : from, stopped: true };
  }

  private local(point: Position): Point {
    const cos = Math.cos(this.origin[1] * Math.PI / 180);
    return [(point[0] - this.origin[0]) * METERS * cos, (point[1] - this.origin[1]) * METERS];
  }

  private world(point: Point): Position {
    const cos = Math.cos(this.origin[1] * Math.PI / 180);
    return [this.origin[0] + point[0] / (METERS * cos), this.origin[1] + point[1] / METERS];
  }

  private steps(from: Point, to: Point) {
    return Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / 0.4));
  }

  private footprint(center: Point, heading: number, scale: number) {
    return [-1.5, 0, 1.5].map((along): Point => [center[0] + Math.sin(heading) * along * scale, center[1] + Math.cos(heading) * along * scale]);
  }

  private onBridge(point: Point) {
    return this.bridges.some((bridge) => distanceToSegment(point, [bridge.ax, bridge.ay], [bridge.bx, bridge.by]) <= bridge.half);
  }

  private wet(point: Point, radius: number) {
    if (this.onBridge(point)) return null;
    for (const polygon of this.polygons) {
      const [x0, y0, x1, y1] = polygon.bounds;
      if (point[0] + radius < x0 || point[0] - radius > x1 || point[1] + radius < y0 || point[1] - radius > y1) continue;
      if (circleHitsPolygon(point, radius, polygon.rings)) return polygon;
    }
    return null;
  }

  private hits(from: Point, to: Point, heading: number, scale: number) {
    const count = this.steps(from, to);
    const radius = 1.1 * scale;
    for (let step = 0; step <= count; step++) {
      const t = step / count;
      const center: Point = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
      for (const sample of this.footprint(center, heading, scale)) if (this.wet(sample, radius)) return true;
    }
    return false;
  }

  private depth(center: Point, heading: number, scale: number) {
    let best = 0;
    for (const sample of this.footprint(center, heading, scale)) {
      if (this.onBridge(sample)) continue;
      for (const polygon of this.polygons) {
        const within = contained(sample, polygon.rings);
        let edge = Infinity;
        for (const ring of polygon.rings) for (let i = 0; i < ring.length; i++) edge = Math.min(edge, distanceToSegment(sample, ring[i], ring[(i + 1) % ring.length]));
        if (edge < Infinity) best = Math.max(best, 1.1 * scale + (within ? edge : -edge));
      }
    }
    return best;
  }

  private deepens(from: Point, to: Point, heading: number, scale: number) {
    const start = this.depth(from, heading, scale);
    const count = this.steps(from, to);
    for (let step = 1; step <= count; step++) {
      const t = step / count;
      const point: Point = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
      if (this.depth(point, heading, scale) > start + 1e-6) return true;
    }
    return false;
  }

  private outward(point: Point, polygon: LocalPolygon): Point {
    let best = Infinity;
    let ax = 0;
    let ay = 0;
    let bx = 0;
    let by = 0;
    for (const ring of polygon.rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        const distance = distanceToSegment(point, a, b);
        if (distance < best) {
          best = distance;
          ax = a[0];
          ay = a[1];
          bx = b[0];
          by = b[1];
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
    if (!contained(point, polygon.rings) && contained([closest[0] + nx * 0.4, closest[1] + ny * 0.4], polygon.rings)) {
      nx = -nx;
      ny = -ny;
    }
    if (contained(point, polygon.rings)) {
      nx = -nx;
      ny = -ny;
    }
    return [nx, ny];
  }

  private slide(from: Point, to: Point, heading: number, scale: number) {
    const count = this.steps(from, to);
    const radius = 1.1 * scale;
    let normal: Point | null = null;
    for (let step = 0; step <= count && !normal; step++) {
      const t = step / count;
      const center: Point = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
      for (const sample of this.footprint(center, heading, scale)) {
        const polygon = this.wet(sample, radius);
        if (!polygon) continue;
        normal = this.outward(sample, polygon);
        break;
      }
    }
    if (!normal) return null;
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const into = dx * normal[0] + dy * normal[1];
    const sx = into < 0 ? dx - normal[0] * into : dx;
    const sy = into < 0 ? dy - normal[1] * into : dy;
    if (Math.hypot(sx, sy) < 1e-8) return null;
    return [from[0] + sx, from[1] + sy] as Point;
  }

  private clamp(from: Point, to: Point, heading: number, scale: number) {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 10; i++) {
      const mid = (lo + hi) / 2;
      const point: Point = [from[0] + (to[0] - from[0]) * mid, from[1] + (to[1] - from[1]) * mid];
      if (this.hits(from, point, heading, scale)) hi = mid;
      else lo = mid;
    }
    if (lo < 0.04) return from;
    return [from[0] + (to[0] - from[0]) * lo, from[1] + (to[1] - from[1]) * lo] as Point;
  }
}
