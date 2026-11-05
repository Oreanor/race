// Street furniture from the map data, worked out per tile in the worker: statues
// on pedestals, fountains, bus shelters, and the white lines and goals of sports
// pitches. The data gives a kind, a name and a point (or a pitch's outline), not
// a shape: each kind is one simple generic model, turned to face the street.

import type { VectorTile } from '@mapbox/vector-tile';
import { roadSegments } from './groundVector.ts';

/** A piece of furniture: tile-local mercator x, z; yaw as the instances turn (local +Z → (sin, cos)); a stable seed. */
export type Spot = { x: number; z: number; yaw: number; seed: number };

export type Furniture = {
  monuments: Spot[];
  fountains: Spot[];
  shelters: Spot[];
  /** football goals: on the goal line, facing into the pitch; `scale` 1 = full size */
  goals: (Spot & { scale: number })[];
  /** pitch markings: x0, z0, x1, z1 (tile-local mercator), 5 floats a line */
  lines: number[];
};

const MONUMENT_SUBCLASS = /^(artwork|statue|monument|memorial|sculpture)$/;
const MONUMENT_NAME = /pelourinho|est[áa]tua|statue|monument|memorial|obelis|denkmal|памятник|монумент/i;
const FOUNTAIN_NAME = /\b(fonte|fontaine|fountain|fuente|fontana|brunnen|chafariz)\b|фонтан/i;

/** Everything of the tile, one list per kind. */
export function streetFurniture(vt: VectorTile, span: number, metersScale: number): Furniture {
  const toMerc = 1 / metersScale;
  const roads = roadSegments(vt, span, metersScale);
  const out: Furniture = { monuments: [], fountains: [], shelters: [], goals: [], lines: [] };
  const poi = vt.layers.poi;
  if (poi) {
    const k = span / poi.extent;
    const taken: Spot[] = [];
    const free = (x: number, z: number, meters: number) => !taken.some((s) => Math.hypot(s.x - x, s.z - z) < meters * toMerc);
    for (let i = 0; i < poi.length; i++) {
      const feature = poi.feature(i);
      if (feature.type !== 1) continue;
      const p = feature.properties;
      const sub = String(p.subclass ?? ''), cls = String(p.class ?? ''), name = String(p.name ?? '');
      const point = feature.loadGeometry()[0]?.[0];
      if (!point || point.x < 0 || point.y < 0 || point.x >= poi.extent || point.y >= poi.extent) continue;
      const x = point.x * k, z = point.y * k;
      const seed = ((point.x * 73856093) ^ (point.y * 19349663)) >>> 0;
      const street = nearestRoad(roads, x, z);
      if (cls === 'attraction' && FOUNTAIN_NAME.test(name)) {
        if (!free(x, z, 25)) continue;
        const spot = { x, z, yaw: street ? facing(street, x, z) : 0, seed };
        out.fountains.push(spot); taken.push(spot);
      } else if (MONUMENT_SUBCLASS.test(sub) || cls === 'monument' || (cls === 'attraction' && MONUMENT_NAME.test(name))) {
        if (!free(x, z, 30)) continue;
        // facing the street if there is one close by, else as the seed falls
        const yaw = street && street.distance < 40 * toMerc ? facing(street, x, z) : (seed % 360) * Math.PI / 180;
        const spot = { x, z, yaw, seed };
        out.monuments.push(spot); taken.push(spot);
      } else if (cls === 'bus' && sub === 'bus_stop') {
        // the shelter on the kerb, its open side to the road
        if (!street || street.distance > 30 * toMerc || !free(x, z, 12)) continue;
        const kerb = street.half + 2.1 * toMerc;
        const sx = street.px + street.nx * kerb, sz = street.pz + street.nz * kerb;
        const spot = { x: sx, z: sz, yaw: Math.atan2(-street.nx, -street.nz), seed };
        out.shelters.push(spot); taken.push(spot);
      }
    }
  }
  pitches(vt, span, metersScale, out);
  return out;
}

type Street = { distance: number; half: number; px: number; pz: number; nx: number; nz: number };

/** The nearest road centre line: how far, its half width, the nearest point on it and the unit normal from it toward (x, z). */
function nearestRoad(segs: number[], x: number, z: number): Street | null {
  let best: Street | null = null;
  for (let s = 0; s < segs.length; s += 5) {
    const ax = segs[s], az = segs[s + 1], bx = segs[s + 2], bz = segs[s + 3];
    const dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz;
    if (len2 < 1e-12) continue;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2));
    const px = ax + dx * t, pz = az + dz * t;
    const distance = Math.hypot(x - px, z - pz);
    if (best && distance >= best.distance) continue;
    // the normal toward the point; a point on the line takes the left side
    const len = Math.sqrt(len2);
    let nx = -dz / len, nz = dx / len;
    if (distance > 1e-9 && (x - px) * nx + (z - pz) * nz < 0) { nx = -nx; nz = -nz; }
    best = { distance, half: segs[s + 4], px, pz, nx, nz };
  }
  return best;
}

/** Yaw that turns a model's +Z toward the street. */
function facing(street: Street, x: number, z: number) {
  const dx = street.px - x, dz = street.pz - z;
  return Math.hypot(dx, dz) > 1e-9 ? Math.atan2(dx, dz) : Math.atan2(-street.nx, -street.nz);
}

// ---- pitches -------------------------------------------------------------------

type Rect = { cx: number; cz: number; ux: number; uz: number; length: number; width: number };

/** The smallest rectangle around a ring, tried along each of its edges; `u` along the long side. */
function boundingRect(ring: [number, number][]): Rect | null {
  let best: (Rect & { area: number }) | null = null;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-9) continue;
    const ux = (bx - ax) / len, uz = (bz - az) / len;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, z] of ring) {
      const u = x * ux + z * uz, v = -x * uz + z * ux;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (best && area >= best.area) continue;
    const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
    const cx = cu * ux - cv * uz, cz = cu * uz + cv * ux;
    best = u1 - u0 >= v1 - v0
      ? { cx, cz, ux, uz, length: u1 - u0, width: v1 - v0, area }
      : { cx, cz, ux: -uz, uz: ux, length: v1 - v0, width: u1 - u0, area };
  }
  return best;
}

function inside(x: number, z: number, ring: [number, number][]) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}

/**
 * White lines on every pitch (and stadium) outline: football, tennis or a court
 * for the rest, by the sport of a pitch point inside it or else by its size;
 * goals on football pitches.
 */
function pitches(vt: VectorTile, span: number, metersScale: number, out: Furniture) {
  const layer = vt.layers.landuse;
  if (!layer) return;
  const k = span / layer.extent;
  const toMerc = 1 / metersScale;
  // the sports of the pitch points, to tell a tennis court from a football field
  const sports: { x: number; z: number; sport: string }[] = [];
  const poi = vt.layers.poi;
  if (poi) for (let i = 0; i < poi.length; i++) {
    const f = poi.feature(i);
    if (f.properties.class !== 'pitch' || f.type !== 1) continue;
    const pt = f.loadGeometry()[0]?.[0];
    if (pt) sports.push({ x: pt.x * span / poi.extent, z: pt.y * span / poi.extent, sport: String(f.properties.subclass ?? '') });
  }
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    const cls = feature.properties.class;
    if (feature.type !== 3 || (cls !== 'pitch' && cls !== 'stadium')) continue;
    const ring = feature.loadGeometry()[0]?.map((p) => [p.x * k, p.y * k] as [number, number]);
    if (!ring || ring.length < 4) continue;
    const rect = boundingRect(ring);
    if (!rect || rect.cx < 0 || rect.cz < 0 || rect.cx >= span || rect.cz >= span) continue; // the tile holding the middle draws it
    const L = rect.length / toMerc, W = rect.width / toMerc; // meters
    if (L < 12 || W < 6) continue;
    const sport = sports.find((s) => inside(s.x, s.z, ring))?.sport ?? '';
    const kind = /soccer|football|rugby/.test(sport) || (cls === 'stadium') || (!sport && L >= 60) ? 'football'
      : /tennis|padel/.test(sport) || (!sport && L < 40 && W < 22) ? 'tennis' : 'court';
    markings(rect, L, W, kind, toMerc, out);
  }
}

/** Lines of one pitch in its own meters (u along, v across), drawn into `out.lines`. */
function markings(rect: Rect, L: number, W: number, kind: 'football' | 'tennis' | 'court', toMerc: number, out: Furniture) {
  const { cx, cz, ux, uz } = rect;
  const vx = -uz, vz = ux;
  const at = (u: number, v: number): [number, number] => [cx + (ux * u + vx * v) * toMerc, cz + (uz * u + vz * v) * toMerc];
  const line = (u0: number, v0: number, u1: number, v1: number) => { const a = at(u0, v0), b = at(u1, v1); out.lines.push(a[0], a[1], b[0], b[1], 0); };
  const box = (u0: number, v0: number, u1: number, v1: number) => { line(u0, v0, u1, v0); line(u1, v0, u1, v1); line(u1, v1, u0, v1); line(u0, v1, u0, v0); };
  const circle = (u: number, v: number, r: number) => {
    const n = 24;
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2, b = (i + 1) / n * Math.PI * 2;
      line(u + Math.cos(a) * r, v + Math.sin(a) * r, u + Math.cos(b) * r, v + Math.sin(b) * r);
    }
  };
  // the playing area, inset from the outline
  const inset = kind === 'football' ? Math.min(3, L * 0.03) : Math.min(1.5, W * 0.08);
  const hl = L / 2 - inset, hw = W / 2 - inset;
  if (kind === 'tennis') {
    // a doubles court scaled to fit: 23.77 × 10.97, singles at 8.23, service at 6.4 from the net
    const s = Math.min(1, hl * 2 / 23.77, hw * 2 / 10.97);
    const l = 11.885 * s, w = 5.485 * s, ws = 4.115 * s, sv = 6.4 * s;
    box(-l, -w, l, w);
    line(-l, -ws, l, -ws); line(-l, ws, l, ws);
    line(-sv, -ws, -sv, ws); line(sv, -ws, sv, ws);
    line(-sv, 0, sv, 0);
    line(0, -w - 0.4 * s, 0, w + 0.4 * s); // the net
    return;
  }
  box(-hl, -hw, hl, hw);
  line(0, -hw, 0, hw);
  if (kind === 'football') {
    const s = Math.min(1, hw * 2 / 68);
    circle(0, 0, 9.15 * s);
    for (const end of [-1, 1]) {
      const pen = Math.min(16.5 * s, hl * 0.3), penW = Math.min(20.15 * s, hw * 0.6);
      const goalArea = Math.min(5.5 * s, pen * 0.35), goalW = Math.min(9.16 * s, penW * 0.5);
      box(end * hl, -penW, end * (hl - pen), penW);
      box(end * hl, -goalW, end * (hl - goalArea), goalW);
      const [gx, gz] = at(end * hl, 0);
      // the goal faces into the pitch: its +Z toward the middle
      out.goals.push({ x: gx, z: gz, yaw: Math.atan2(-end * ux, -end * uz), seed: 0, scale: Math.max(0.45, s) });
    }
  } else {
    // basketball and the rest: a centre circle and a key at each end
    const s = Math.min(1, hw * 2 / 15);
    circle(0, 0, 1.8 * s);
    for (const end of [-1, 1]) box(end * hl, -2.45 * s, end * (hl - 5.8 * s), 2.45 * s);
  }
}
