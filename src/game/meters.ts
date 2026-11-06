/** Flat-earth city scale: metres per degree of latitude (WGS84 approx). */
export const METERS_PER_DEGREE = 111319.49;

/** Local metres-per-degree at `lat` (x = east/lng, y = north/lat). */
export function metersScale(lat: number) {
  return {
    x: METERS_PER_DEGREE * Math.cos(lat * Math.PI / 180),
    y: METERS_PER_DEGREE,
  };
}

/** East/north metres from `origin` lng/lat to `point`. */
export function eastNorth(origin: readonly [number, number], point: readonly [number, number]) {
  const { x, y } = metersScale(origin[1]);
  return {
    east: (point[0] - origin[0]) * x,
    north: (point[1] - origin[1]) * y,
  };
}

/** Lng/lat offset by east/north metres from `origin`. */
export function offsetMeters(
  origin: readonly [number, number],
  east: number,
  north: number,
): [number, number] {
  const { x, y } = metersScale(origin[1]);
  return [origin[0] + east / x, origin[1] + north / y];
}

/** Ground distance between two lng/lat points in metres. */
export function metersBetween(
  a: readonly [number, number],
  b: readonly [number, number],
) {
  const cos = Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  return Math.hypot((b[0] - a[0]) * METERS_PER_DEGREE * cos, (b[1] - a[1]) * METERS_PER_DEGREE);
}
