import { METERS_PER_DEGREE, metersBetween, type Position } from './VehicleController.ts';
import type { MapFeature } from './WaterCollisionController.ts';

export type MissionBounds = { west: number; south: number; east: number; north: number };

/** Sixteen evenly spaced search areas, covering the inspected map or driving area. */
export function missionAreas(bounds: MissionBounds) {
  const dx = (bounds.east - bounds.west) / 4, dy = (bounds.north - bounds.south) / 4;
  const width = dx * METERS_PER_DEGREE * Math.cos((bounds.north + bounds.south) * Math.PI / 360);
  const height = dy * METERS_PER_DEGREE;
  return Array.from({ length: 16 }, (_, i) => ({
    at: [bounds.west + (i % 4 + 0.5) * dx, bounds.south + (Math.floor(i / 4) + 0.5) * dy] as Position,
    radius: Math.hypot(width, height) * 0.65,
    gap: Math.max(75, Math.min(width, height) * 0.32),
  }));
}

const roads = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service', 'track']);

/** Project onto an actual loaded road, never onto an invented off-road ring. */
export function missionRoadSpot(features: Iterable<MapFeature>, at: Position, radius: number, allowed: (p: Position) => boolean) {
  const sx = METERS_PER_DEGREE * Math.cos(at[1] * Math.PI / 180), sy = METERS_PER_DEGREE;
  let best: Position | null = null, distance = radius * radius;
  for (const feature of features) {
    if (!roads.has(String(feature.properties?.class ?? '')) || feature.properties?.brunnel === 'tunnel') continue;
    const lines = feature.geometry.type === 'LineString' ? [feature.geometry.coordinates]
      : feature.geometry.type === 'MultiLineString' ? feature.geometry.coordinates : [];
    for (const line of lines as Position[][]) for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i];
      const ax = (a[0] - at[0]) * sx, ay = (a[1] - at[1]) * sy;
      const bx = (b[0] - at[0]) * sx, by = (b[1] - at[1]) * sy;
      if (Math.min(ax, bx) > radius || Math.max(ax, bx) < -radius || Math.min(ay, by) > radius || Math.max(ay, by) < -radius) continue;
      const dx = bx - ax, dy = by - ay;
      const u = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
      const x = ax + dx * u, y = ay + dy * u, d = x * x + y * y;
      if (d >= distance) continue;
      const p: Position = [at[0] + x / sx, at[1] + y / sy];
      if (!allowed(p)) continue;
      best = p; distance = d;
    }
  }
  return best;
}

export function nearestOfEachKind<T extends { kind: string; position: Position }>(items: readonly T[], at: Position): T[] {
  const nearest = new Map<string, { item: T; distance: number }>();
  for (const item of items) {
    const distance = metersBetween(at, item.position);
    if (distance < (nearest.get(item.kind)?.distance ?? Infinity)) nearest.set(item.kind, { item, distance });
  }
  return [...nearest.values()].map(n => n.item);
}
