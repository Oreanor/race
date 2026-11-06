import { metersBetween, metersScale } from './meters.ts';
import type { MapFeature } from './WaterCollisionController.ts';

/** Named drivables — include minor so dense centres still get labels. */
const ROAD = /^(motorway|trunk|primary|secondary|tertiary|minor)$/;

function streetName(props: Record<string, unknown> | null | undefined) {
  const p = props ?? {};
  const raw = p.name ?? p.name_int ?? p['name:latin'] ?? p.name_en ?? p.ref;
  return String(raw ?? '').trim();
}

export type StreetLabel = {
  id: string;
  name: string;
  /** Midpoint of the labelled stretch. */
  position: [number, number];
  /** Radians, same as vehicle heading: 0 = north, π/2 = east. */
  heading: number;
};

type Piece = {
  name: string;
  length: number;
  position: [number, number];
  heading: number;
  rank: number;
};

function rankOf(cls: string) {
  if (cls === 'motorway' || cls === 'trunk') return 0;
  if (cls === 'primary') return 1;
  if (cls === 'secondary') return 2;
  if (cls === 'tertiary') return 3;
  return 4;
}

function lineCoords(feature: MapFeature): [number, number][][] {
  const g = feature.geometry;
  if (g.type === 'LineString') return [g.coordinates as [number, number][]];
  if (g.type === 'MultiLineString') return g.coordinates as [number, number][][];
  return [];
}

/** Length (m) and a point/heading at the middle of the line. */
function midAlong(line: [number, number][]): { length: number; position: [number, number]; heading: number } | null {
  if (line.length < 2) return null;
  const scale = metersScale(line[0][1]);
  let total = 0;
  const seg: number[] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const d = Math.hypot((line[i + 1][0] - line[i][0]) * scale.x, (line[i + 1][1] - line[i][1]) * scale.y);
    seg.push(d);
    total += d;
  }
  if (total < 1) return null;
  let along = total * 0.5;
  for (let i = 0; i < seg.length; i++) {
    if (along > seg[i] && i + 1 < seg.length) {
      along -= seg[i];
      continue;
    }
    const t = seg[i] > 0 ? along / seg[i] : 0;
    const a = line[i];
    const b = line[i + 1];
    const position: [number, number] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const heading = Math.atan2((b[0] - a[0]) * scale.x, (b[1] - a[1]) * scale.y);
    return { length: total, position, heading };
  }
  return null;
}

/**
 * Sparse labels for the biggest named streets near `here`.
 * Vector-tile name features are short clips — we sum length per name, then
 * place one label on the nearest clip of that street.
 */
export function streetLabelsNear(
  features: MapFeature[],
  here: [number, number],
  options: { reach?: number; minLength?: number; minApart?: number; limit?: number } = {},
): StreetLabel[] {
  const reach = options.reach ?? 2500;
  const minLength = options.minLength ?? 40;
  const minApart = options.minApart ?? 90;
  const limit = options.limit ?? 12;

  const pieces: Piece[] = [];
  for (const feature of features) {
    const p = feature.properties ?? {};
    const cls = String(p.class ?? '').replace(/_construction$/, '');
    if (!ROAD.test(cls)) continue;
    const name = streetName(p);
    if (!name || name.length < 2) continue;
    for (const line of lineCoords(feature)) {
      const mid = midAlong(line);
      if (!mid || mid.length < 8) continue;
      if (metersBetween(mid.position, here) > reach) continue;
      pieces.push({
        name,
        length: mid.length,
        position: mid.position,
        heading: mid.heading,
        rank: rankOf(cls),
      });
    }
  }

  type Acc = { name: string; rank: number; total: number; best: Piece };
  const byName = new Map<string, Acc>();
  for (const piece of pieces) {
    const prev = byName.get(piece.name);
    if (!prev) {
      byName.set(piece.name, { name: piece.name, rank: piece.rank, total: piece.length, best: piece });
      continue;
    }
    prev.total += piece.length;
    if (piece.rank < prev.rank) prev.rank = piece.rank;
    if (metersBetween(piece.position, here) < metersBetween(prev.best.position, here)) prev.best = piece;
  }

  const sorted = [...byName.values()]
    .filter((a) => a.total >= minLength)
    .sort((a, b) =>
      a.rank - b.rank
      || b.total - a.total
      || metersBetween(a.best.position, here) - metersBetween(b.best.position, here));

  const out: StreetLabel[] = [];
  for (const item of sorted) {
    const pos = item.best.position;
    if (out.some((other) => metersBetween(other.position, pos) < minApart)) continue;
    out.push({
      id: `${item.name}|${pos[0].toFixed(4)},${pos[1].toFixed(4)}`,
      name: item.name,
      position: pos,
      heading: item.best.heading,
    });
    if (out.length >= limit) break;
  }
  return out;
}
