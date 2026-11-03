import type { BuildingDetail } from './BuildingStyles.ts';

export const lodConfig = {
  near: 120,
  far: 350,
  hysteresis: 18,
};

export function chooseLod(distance: number, previous: 0 | 1 | 2 | undefined, detail: BuildingDetail): 0 | 1 | 2 {
  if (detail === 'off') return 2;
  const { near, far, hysteresis } = lodConfig;
  let lod: 0 | 1 | 2;
  if (previous == null) lod = distance <= near ? 0 : distance <= far ? 1 : 2;
  else if (previous === 0) lod = distance > far + hysteresis ? 2 : distance > near + hysteresis ? 1 : 0;
  else if (previous === 1) lod = distance < near - hysteresis ? 0 : distance > far + hysteresis ? 2 : 1;
  else lod = distance < near - hysteresis ? 0 : distance < far - hysteresis ? 1 : 2;
  if (detail === 'low' && lod === 0) return 1;
  return lod;
}
