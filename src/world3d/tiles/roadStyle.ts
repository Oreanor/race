// Road widths and colours shared by the road meshes, the ground raster and the streetscape.

export type RoadStyle = { width: number; fill: string; casing: string; lift: number };

/**
 * Widths match what MapLibre drew at the chase zoom (paintCity: rank × pavement
 * × zoom factor, ≈ 25.6 px/m at zoom 20.55), so the city reads the same.
 */
export function roadStyle(cls: string, sub: string, ramp: boolean): RoadStyle | null {
  if (/^(rail|transit|ferry|aerialway|pier|bridge|bus_guideway|raceway)$/.test(cls)) return null;
  const pedestrian = cls === 'path' || /pedestrian|footway|cycleway|steps|path|platform/.test(sub);
  const major = /motorway|trunk|primary/.test(cls);
  const link = ramp || /service|track/.test(cls);
  const rank = pedestrian ? 0.5 : major ? 1.45 : link ? 0.82 : 1;
  const pavement = pedestrian ? 2.1 : 5;
  const width = rank * pavement * 0.84;
  const fill = pedestrian ? '#c4c1ba' : major ? '#9d9e99' : /secondary|tertiary/.test(cls) ? '#aaaba5' : '#b5b5af';
  const casing = pedestrian ? '#d5d0c6' : major ? '#d2cec5' : /secondary|tertiary/.test(cls) ? '#d6d2c9' : '#dbd7ce';
  // each kind of road on its own level, and no casing at the height of another road's fill:
  // where two meet, one lies clearly over the other instead of flickering through it
  const secondary = /secondary|tertiary/.test(cls);
  return { width, fill, casing, lift: pedestrian ? 0.04 : major ? 0.14 : secondary ? 0.115 : 0.09 };
}

export function isPedestrian(cls: string, sub: string) {
  return cls === 'path' || /pedestrian|footway|cycleway|steps|path|platform/.test(sub);
}
