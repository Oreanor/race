import type { ThreeMap } from '@/world3d/map/ThreeMap';
import type { Position } from './VehicleController';

const METERS_PER_DEGREE = 111319.49;
const DRIVABLE_ROADS = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service']);

// Project the configured start onto a nearby drivable road once, never while driving.
export function roadStart(
  map: ThreeMap,
  source: string,
  origin: Position,
  blocked: (position: Position, heading: number) => boolean,
  maxDistance = 350,
) {
  const scaleX = METERS_PER_DEGREE * Math.cos(origin[1] * Math.PI / 180);
  const scaleY = METERS_PER_DEGREE;
  let best: { position: Position; heading: number; distance: number } | undefined;

  for (const feature of map.querySourceFeatures(source, { sourceLayer: 'transportation' })) {
    const roadClass = String(feature.properties?.class ?? '');
    if (!DRIVABLE_ROADS.has(roadClass)) continue;
    const lines = (feature.geometry.type === 'LineString'
      ? [feature.geometry.coordinates]
      : feature.geometry.type === 'MultiLineString'
        ? feature.geometry.coordinates
        : []) as Position[][];

    for (const line of lines) {
      for (let index = 1; index < line.length; index++) {
        const a = line[index - 1];
        const b = line[index];
        const ax = (a[0] - origin[0]) * scaleX;
        const ay = (a[1] - origin[1]) * scaleY;
        const dx = (b[0] - a[0]) * scaleX;
        const dy = (b[1] - a[1]) * scaleY;
        const along = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
        const x = ax + along * dx;
        const y = ay + along * dy;
        const distance = Math.hypot(x, y);
        if (distance > maxDistance || (best && distance >= best.distance)) continue;

        const position: Position = [origin[0] + x / scaleX, origin[1] + y / scaleY];
        const heading = Math.atan2(dx, dy);
        if (!blocked(position, heading)) best = { position, heading, distance };
      }
    }
  }
  return best;
}
