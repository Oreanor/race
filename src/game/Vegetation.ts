import { polygonPenetrationDepth, type Polygon } from './BuildingCollisions.ts';
import type { MapFeature } from './WaterCollisionController.ts';
import { METERS_PER_DEGREE, type Position } from './VehicleController.ts';

export type Plant = { key: string; position: Position; x: number; z: number; seed: number; bush: boolean; variant: number };
export type FenceEdge = { ax: number; az: number; bx: number; bz: number };
export const PLANT_CAP = 1800;
/** Must stay near ThicketCollision's ±900 m solid window so drive-blocking greens stay marked. */
export const FENCE_REACH = 880;
const PLANT_DENSITY = 0.5;
type Area = { rings: Position[][]; bounds: number[]; kind: string };
const M = METERS_PER_DEGREE;
export function plantRandom(x: number, y: number, salt = 0) {
  let h = Math.imul(x ^ 0x45d9f3b, 374761393) ^ Math.imul(y ^ salt, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function limitVegetation(plants: Plant[], focusEast: number, focusNorth: number, plantCap = PLANT_CAP) {
  const distance = (plant: Plant) => Math.hypot(plant.x - focusEast, plant.z + focusNorth);
  const sorted = plants.sort((a, b) => distance(a) - distance(b));
  const nearPlants: Plant[] = [], middle: Plant[] = [], far: Plant[] = [];
  for (const plant of sorted) {
    const range = distance(plant);
    if (range < 145) nearPlants.push(plant);
    else if (range <= 460) middle.push(plant);
    else far.push(plant);
  }
  const spread = (plants: Plant[], limit: number) => {
    if (plants.length <= limit) return plants;
    const stride = plants.length / limit;
    return Array.from({ length: limit }, (_, index) => plants[Math.floor(index * stride)]);
  };
  const nearLimit = Math.min(450, Math.ceil(plantCap * 0.25));
  const midLimit = Math.min(900, Math.ceil(plantCap * 0.5));
  const farLimit = Math.max(0, plantCap - nearLimit - midLimit);
  const selected = spread(nearPlants, nearLimit)
    .concat(spread(middle, midLimit), spread(far, farLimit));
  if (selected.length >= plantCap) return selected.slice(0, plantCap);
  const included = new Set(selected.map(plant => plant.key));
  for (const plant of sorted) {
    if (selected.length >= plantCap) break;
    if (!included.has(plant.key)) selected.push(plant);
  }
  return selected;
}
function inside(p: Position, ring: Position[]) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}
function segmentDistance(p: Position, a: Position, b: Position) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function near(area: Area, p: Position, margin: number) {
  const [a,b,c,d] = area.bounds;
  return p[0] >= a-margin && p[0] <= c+margin && p[1] >= b-margin && p[1] <= d+margin;
}
function containsRings(rings: Position[][], p: Position) { return inside(p, rings[0]) && !rings.slice(1).some(r => inside(p,r)); }
function contains(area: Area, p: Position) { return containsRings(area.rings, p); }
function edgeNear(area: Area, p: Position, margin: number) {
  return area.rings.some(r => r.some((v,i) => segmentDistance(p,v,r[(i+1)%r.length]) < margin));
}
function onRoad(roads: {a: Position; b: Position; width: number}[], p: Position, extra = 0) {
  return roads.some(r => {
    const pad = r.width + extra;
    return p[0] >= Math.min(r.a[0], r.b[0]) - pad && p[0] <= Math.max(r.a[0], r.b[0]) + pad
      && p[1] >= Math.min(r.a[1], r.b[1]) - pad && p[1] <= Math.max(r.a[1], r.b[1]) + pad
      && segmentDistance(p, r.a, r.b) < pad;
  });
}
/** Dense planting band (still open lawn between trees). */
const DENSE = /^(wood|forest|park|garden)$/;
/** Solid drive-block + fence: real woods only. Parks stay open except at trees. */
const SOLID = /^(wood|forest)$/;
const SOFT = /^(park|garden)$/;
const TREE_SPACING = 8;
const TREE_KEEP = 0.62;
function featureKind(feature: MapFeature) {
  return String(feature.properties?.subclass ?? feature.properties?.class ?? '');
}
export function isThicketKind(kind: string) {
  return SOLID.test(kind);
}
export function isSoftGreenKind(kind: string) {
  return SOFT.test(kind);
}
export type VegetationInput = {
  green: MapFeature[];
  obstacles: MapFeature[];
  roads: MapFeature[];
  focus: Position;
  origin: Position;
  plantCap?: number;
  reachScale?: number;
  /** fence planning radius in meters (default FENCE_REACH); whole-tile planning passes more */
  fenceReach?: number;
};

// Yield throughout preparation and sampling so tile arrivals never monopolize a frame.
export function* planVegetation(input: VegetationInput): Generator<null, Plant[]> {
  const cos = Math.cos(input.origin[1] * Math.PI / 180);
  const local = (p: Position): Position => [(p[0]-input.origin[0])*M*cos, (p[1]-input.origin[1])*M];
  const focus = local(input.focus);
  const reachScale = input.reachScale ?? 1;
  const plantCap = input.plantCap ?? PLANT_CAP;
  const greens: Area[] = [], obstacles: Area[] = [];
  let steps = 0;
  for (const [features, target] of [[input.green, greens], [input.obstacles, obstacles]] as const) {
    for (const f of features) {
      if (++steps % 64 === 0) yield null;
      const kind = String(f.properties?.subclass ?? f.properties?.class ?? '');
      if (target === greens && !/^(wood|forest|park|garden|grass|grassland|meadow|village_green|scrub|shrubbery|flowerbed)$/.test(kind)) continue;
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates as Position[][]] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates as Position[][][] : [];
      for (const poly of polys) {
        const rings = poly.map(r => r.map(local)).filter(r => r.length >= 3);
        if (!rings.length) continue;
        const bounds = [Infinity,Infinity,-Infinity,-Infinity];
        for (const p of rings[0]) { bounds[0]=Math.min(bounds[0],p[0]);bounds[1]=Math.min(bounds[1],p[1]);bounds[2]=Math.max(bounds[2],p[0]);bounds[3]=Math.max(bounds[3],p[1]); }
        const area = {rings,bounds,kind};
        if (near(area,focus,700 * reachScale)) target.push(area);
      }
    }
  }
  const roads: {a: Position; b: Position; width: number}[] = [];
  const roadsideLines: { points: Position[]; width: number }[] = [];
  for (const f of input.roads) {
    if (++steps % 64 === 0) yield null;
    if (f.properties?.brunnel === 'tunnel') continue;
    const kind = String(f.properties?.class ?? '');
    const width = /path|foot|cycle|pedestrian|steps/.test(kind) ? 4 : /motorway|trunk|primary/.test(kind) ? 17 : /secondary|tertiary/.test(kind) ? 12 : 8;
    const lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates as Position[]] : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates as Position[][] : [];
    for (const line of lines) {
      const points = line.map(local);
      const roadReach = 720 * reachScale;
      if (width > 4 && points.some(point => Math.hypot(point[0] - focus[0], point[1] - focus[1]) <= roadReach)) roadsideLines.push({ points, width });
      for (let i=1;i<points.length;i++) {
        const a=points[i-1],b=points[i];
        if (Math.min(a[0],b[0])>focus[0]+roadReach || Math.max(a[0],b[0])<focus[0]-roadReach || Math.min(a[1],b[1])>focus[1]+roadReach || Math.max(a[1],b[1])<focus[1]-roadReach) continue;
        roads.push({a,b,width});
      }
    }
  }
  const plants: Plant[] = [];
  const seen = new Set<string>();
  const thick = greens.filter(area => DENSE.test(area.kind));
  const bands: { areas: Area[]; spacing: number; reach: number; keep: number; tag: string; inset: number; min: number }[] = [
    { areas: thick, spacing: TREE_SPACING, reach: 700 * reachScale, keep: TREE_KEEP, tag: 'b', inset: 0, min: 0 },
    { areas: greens.filter(area => /^(scrub|shrubbery|flowerbed)$/.test(area.kind)), spacing: 8.5, reach: 430 * reachScale, keep: 0.72, tag: 's', inset: 1.4, min: 0 },
    { areas: greens.filter(area => /^(grass|grassland|meadow|village_green)$/.test(area.kind)), spacing: 15, reach: 520 * reachScale, keep: 0.4, tag: 'g', inset: 2.2, min: 0 },
  ];
  for (const band of bands) {
    for (const area of band.areas) {
      const x0 = Math.max(area.bounds[0], focus[0] - band.reach), y0 = Math.max(area.bounds[1], focus[1] - band.reach);
      const x1 = Math.min(area.bounds[2], focus[0] + band.reach), y1 = Math.min(area.bounds[3], focus[1] + band.reach);
      for (let gx = Math.floor(x0 / band.spacing); gx <= Math.ceil(x1 / band.spacing); gx++) {
        for (let gy = Math.floor(y0 / band.spacing); gy <= Math.ceil(y1 / band.spacing); gy++) {
          if (++steps % 128 === 0) yield null;
          const key = `${band.tag}:${gx}:${gy}`;
          if (seen.has(key)) continue;
          const p: Position = [(gx + 0.18 + plantRandom(gx, gy, 11) * 0.64) * band.spacing, (gy + 0.18 + plantRandom(gx, gy, 29) * 0.64) * band.spacing];
          if (Math.hypot(p[0] - focus[0], p[1] - focus[1]) > band.reach) continue;
          if (!near(area, p, 0) || !contains(area, p)) continue;
          if (plantRandom(gx, gy) > band.keep * PLANT_DENSITY) continue;
          if (band.tag !== 'b' && thick.some(other => near(other, p, 0) && contains(other, p))) continue;
          if (Math.hypot(p[0] - focus[0], p[1] - focus[1]) < band.min) continue;
          const bush = band.tag === 's' || plantRandom(gx, gy, 47) < (band.tag === 'b' ? 0.28 : 0.34);
          if (band.tag !== 'b' && edgeNear(area, p, band.inset)) continue;
          const radius = bush ? 1.6 : 2.4;
          if (obstacles.some(block => near(block, p, radius) && (contains(block, p) || edgeNear(block, p, radius)))) continue;
          if (onRoad(roads, p)) continue;
          seen.add(key);
          plants.push({ key, position: [input.origin[0] + p[0] / (M * cos), input.origin[1] + p[1] / M], x: p[0], z: -p[1], seed: plantRandom(gx, gy, 71), bush, variant: Math.floor(plantRandom(gx, gy, 97) * 3) });
        }
      }
    }
  }
  for (const line of roadsideLines) {
    const spacing = line.width >= 12 ? 13 : 16;
    let traveled = 0;
    for (let segment = 1; segment < line.points.length; segment++) {
      const a = line.points[segment - 1], b = line.points[segment];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const length = Math.hypot(dx, dy);
      if (length < 0.1) continue;
      const start = spacing - (traveled % spacing);
      for (let along = start; along < length; along += spacing) {
        if (++steps % 128 === 0) yield null;
        const t = along / length;
        const center: Position = [a[0] + dx * t, a[1] + dy * t];
        if (Math.hypot(center[0] - focus[0], center[1] - focus[1]) > 650 * reachScale) continue;
        const centerX = Math.round(center[0] / spacing), centerY = Math.round(center[1] / spacing);
        for (const side of [-1, 1]) {
          const offset = line.width + 3.5 + plantRandom(centerX, centerY, 19) * 1.8;
          const p: Position = [center[0] - dy / length * offset * side, center[1] + dx / length * offset * side];
          if (onRoad(roads, p, 1)) continue;
          const gx = Math.round(p[0] / 3), gy = Math.round(p[1] / 3);
          const key = `r:${gx}:${gy}`;
          if (seen.has(key)) continue;
          if (plantRandom(gx, gy, 113) >= PLANT_DENSITY) continue;
          const bush = plantRandom(gx, gy, 47) < 0.2;
          const radius = bush ? 2 : 3.5;
          if (obstacles.some(block => near(block, p, radius) && (contains(block, p) || edgeNear(block, p, radius)))) continue;
          seen.add(key);
          const seed = plantRandom(gx, gy, 71);
          plants.push({
            key,
            position: [input.origin[0] + p[0] / (M * cos), input.origin[1] + p[1] / M],
            x: p[0], z: -p[1],
            seed, bush,
            variant: Math.floor(plantRandom(gx, gy, 97) * 3),
          });
        }
      }
      traveled += length;
    }
  }
  return limitVegetation(plants, focus[0], focus[1], plantCap);
}

/** Outer contours of drive-blocking woods/forests, with gaps at roads. Parks stay unfenced. */
export function* planParkFences(input: VegetationInput): Generator<null, FenceEdge[]> {
  const cos = Math.cos(input.origin[1] * Math.PI / 180);
  const local = (p: Position): Position => [(p[0] - input.origin[0]) * M * cos, (p[1] - input.origin[1]) * M];
  const focus = local(input.focus);
  // Keep full reach even when plant density is scaled down while driving.
  const reach = input.fenceReach ?? FENCE_REACH;
  const edges: FenceEdge[] = [];
  let steps = 0;

  const roads: { a: Position; b: Position; width: number }[] = [];
  for (const feature of input.roads) {
    if (++steps % 64 === 0) yield null;
    if (feature.properties?.brunnel === 'tunnel') continue;
    const kind = String(feature.properties?.class ?? '');
    // Match ThicketCollision road widths so fence gaps align with drive-through cuts.
    const width = /path|foot|cycle|pedestrian|steps/.test(kind) ? 4 : /motorway|trunk|primary/.test(kind) ? 17 : /secondary|tertiary/.test(kind) ? 12 : 8;
    const lines = feature.geometry.type === 'LineString'
      ? [feature.geometry.coordinates as Position[]]
      : feature.geometry.type === 'MultiLineString'
        ? feature.geometry.coordinates as Position[][]
        : [];
    for (const line of lines) {
      const points = line.map(local);
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        if (Math.min(a[0], b[0]) > focus[0] + reach || Math.max(a[0], b[0]) < focus[0] - reach
          || Math.min(a[1], b[1]) > focus[1] + reach || Math.max(a[1], b[1]) < focus[1] - reach) continue;
        roads.push({ a, b, width });
      }
    }
  }

  // Same clearance pad as ThicketCollision.depth so posts don't claim open road cuts.
  const blocked = (p: Position) => onRoad(roads, p, 1.6);

  for (const feature of input.green) {
    if (++steps % 32 === 0) yield null;
    const kind = featureKind(feature);
    if (!isThicketKind(kind)) continue;
    const polys = feature.geometry.type === 'Polygon'
      ? [feature.geometry.coordinates as Position[][]]
      : feature.geometry.type === 'MultiPolygon'
        ? feature.geometry.coordinates as Position[][][]
        : [];
    for (const poly of polys) {
      const rings = poly
        .map((ring) => {
          const points = ring.map(local);
          if (points.length >= 2) {
            const first = points[0], last = points[points.length - 1];
            if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-4) points.pop();
          }
          return points;
        })
        .filter((ring) => ring.length >= 3);
      if (!rings.length) continue;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const point of rings[0]) {
        minX = Math.min(minX, point[0]); minY = Math.min(minY, point[1]);
        maxX = Math.max(maxX, point[0]); maxY = Math.max(maxY, point[1]);
      }
      if (maxX < focus[0] - reach || minX > focus[0] + reach || maxY < focus[1] - reach || minY > focus[1] + reach) continue;

      // Fence every ring: outer perimeter and holes (inner lakes / clearings).
      for (const ring of rings) {
        for (let i = 0; i < ring.length; i++) {
          if (++steps % 96 === 0) yield null;
          const a = ring[i];
          const b = ring[(i + 1) % ring.length];
          const dx = b[0] - a[0], dy = b[1] - a[1];
          const length = Math.hypot(dx, dy);
          if (length < 0.7) continue;
          const ux = dx / length, uy = dy / length;
          let runStart: Position | null = null;
          const flush = (from: Position, to: Position) => {
            if (Math.hypot(to[0] - from[0], to[1] - from[1]) < 0.55) return;
            if (Math.hypot((from[0] + to[0]) * 0.5 - focus[0], (from[1] + to[1]) * 0.5 - focus[1]) > reach) return;
            edges.push({ ax: from[0], az: -from[1], bx: to[0], bz: -to[1] });
          };
          const step = 1.6;
          for (let along = 0; along <= length + 1e-6; along += step) {
            const t = Math.min(1, along / length);
            const point: Position = [a[0] + ux * length * t, a[1] + uy * length * t];
            const open = !blocked(point);
            if (open && !runStart) runStart = point;
            if (!open && runStart) {
              flush(runStart, point);
              runStart = null;
            }
          }
          if (runStart) flush(runStart, b);
        }
      }
    }
  }
  // Nearest edges first so instance caps still mark the thickets you can hit.
  edges.sort((left, right) => {
    const leftEast = (left.ax + left.bx) * 0.5;
    const leftNorth = -(left.az + left.bz) * 0.5;
    const rightEast = (right.ax + right.bx) * 0.5;
    const rightNorth = -(right.az + right.bz) * 0.5;
    return Math.hypot(leftEast - focus[0], leftNorth - focus[1]) - Math.hypot(rightEast - focus[0], rightNorth - focus[1]);
  });
  return edges;
}

// Woods/forests stay solid. Parks/gardens are open lawn — only planted trees stop the car.
export class ThicketCollision {
  origin: Position = [0, 0];
  solids: { rings: Polygon; bounds: number[] }[] = [];
  soft: Area[] = [];
  roads: { a: Position; b: Position; width: number }[] = [];
  local(p: Position): Position { return [(p[0] - this.origin[0]) * M * Math.cos(this.origin[1] * Math.PI / 180), (p[1] - this.origin[1]) * M]; }
  update(origin: Position, greens: MapFeature[], roads: MapFeature[]) {
    this.origin = [...origin];
    this.solids = [];
    this.soft = [];
    for (const feature of greens) {
      const kind = featureKind(feature);
      const solid = isThicketKind(kind);
      const soft = isSoftGreenKind(kind);
      if (!solid && !soft) continue;
      const polys = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates as Polygon] : feature.geometry.type === 'MultiPolygon' ? feature.geometry.coordinates as Polygon[] : [];
      for (const poly of polys) {
        const rings = poly.map(ring => ring.map(point => this.local(point))).filter(ring => ring.length >= 3);
        if (!rings.length) continue;
        const outer = rings[0];
        const bounds = [Math.min(...outer.map(p => p[0])), Math.min(...outer.map(p => p[1])), Math.max(...outer.map(p => p[0])), Math.max(...outer.map(p => p[1]))];
        if (bounds[2] < -900 || bounds[0] > 900 || bounds[3] < -900 || bounds[1] > 900) continue;
        if (solid) this.solids.push({ rings, bounds });
        else this.soft.push({ rings, bounds, kind });
      }
    }
    this.roads = [];
    for (const feature of roads) {
      if (feature.properties?.brunnel === 'tunnel') continue;
      const kind = String(feature.properties?.class ?? '');
      const width = /path|foot|cycle|pedestrian|steps/.test(kind) ? 4 : /motorway|trunk|primary/.test(kind) ? 17 : /secondary|tertiary/.test(kind) ? 12 : 8;
      const lines = feature.geometry.type === 'LineString' ? [feature.geometry.coordinates as Position[]] : feature.geometry.type === 'MultiLineString' ? feature.geometry.coordinates as Position[][] : [];
      for (const line of lines) for (let i = 1; i < line.length; i++) this.roads.push({ a: this.local(line[i - 1]), b: this.local(line[i]), width });
    }
  }
  blocked(from: Position, to: Position) {
    if (!this.solids.length && !this.soft.length) return false;
    const start = this.local(from), end = this.local(to);
    const count = Math.max(1, Math.ceil(Math.hypot(end[0] - start[0], end[1] - start[1]) / 0.45));
    const startDepth = this.depth(start);
    for (let step = 0; step <= count; step++) {
      const t = step / count;
      const point: Position = [start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t];
      const depth = this.depth(point);
      if (startDepth === 0 && depth > 0) return true;
      if (startDepth > 0 && depth > startDepth + 1e-4) return true;
    }
    return startDepth > 0 && this.depth(end) >= startDepth - 1e-4;
  }
  private depth(point: Position) {
    if (onRoad(this.roads, point, 1.6)) return 0;
    let deepest = 0;
    const radius = 1.15;
    for (const solid of this.solids) {
      const [x0, y0, x1, y1] = solid.bounds;
      if (point[0] + radius < x0 || point[0] - radius > x1 || point[1] + radius < y0 || point[1] - radius > y1) continue;
      deepest = Math.max(deepest, polygonPenetrationDepth(point, radius, solid.rings));
    }
    if (deepest === 0) deepest = this.treeDepth(point);
    return deepest;
  }
  /** Same plant grid as planVegetation dense band — open grass between trees stays free. */
  private treeDepth(point: Position) {
    let deepest = 0;
    const reach = TREE_SPACING + 2.6;
    for (const area of this.soft) {
      if (!near(area, point, reach)) continue;
      const gx0 = Math.floor((point[0] - reach) / TREE_SPACING);
      const gx1 = Math.ceil((point[0] + reach) / TREE_SPACING);
      const gy0 = Math.floor((point[1] - reach) / TREE_SPACING);
      const gy1 = Math.ceil((point[1] + reach) / TREE_SPACING);
      for (let gx = gx0; gx <= gx1; gx++) {
        for (let gy = gy0; gy <= gy1; gy++) {
          if (plantRandom(gx, gy) > TREE_KEEP * PLANT_DENSITY) continue;
          const plant: Position = [
            (gx + 0.18 + plantRandom(gx, gy, 11) * 0.64) * TREE_SPACING,
            (gy + 0.18 + plantRandom(gx, gy, 29) * 0.64) * TREE_SPACING,
          ];
          if (!contains(area, plant) || onRoad(this.roads, plant)) continue;
          const bush = plantRandom(gx, gy, 47) < 0.28;
          const hit = bush ? 1.35 : 1.85;
          const dist = Math.hypot(point[0] - plant[0], point[1] - plant[1]);
          if (dist < hit) deepest = Math.max(deepest, hit - dist);
        }
      }
    }
    return deepest;
  }
}
