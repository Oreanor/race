export type SightVolume = {
  footprint: { x: number; z: number }[];
  base: number;
  top: number;
};

function inside(poly: { x: number; z: number }[], x: number, z: number) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (!a || !b) continue;
    const crosses = (a.z > z) !== (b.z > z);
    const xCross = ((b.x - a.x) * (z - a.z)) / ((b.z - a.z) || 1e-9) + a.x;
    if (crosses && x < xCross) hit = !hit;
  }
  return hit;
}

function nearEdge(poly: { x: number; z: number }[], x: number, z: number, margin: number) {
  const limit = margin * margin;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / length));
    const px = a.x + dx * t - x;
    const pz = a.z + dz * t - z;
    if (px * px + pz * pz <= limit) return true;
  }
  return false;
}

// The sightline runs from the camera to the car. A house blocks it when that
// segment passes through the volume, or grazes a wall close enough to hide the body.
export function buildingBlocksView(volume: SightVolume, ax: number, ay: number, az: number, bx: number, by: number, bz: number, margin = 1.7) {
  if (volume.footprint.length < 3) return false;
  const span = Math.hypot(bx - ax, bz - az);
  const steps = Math.max(1, Math.ceil(span / 2.2));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = ax + (bx - ax) * t;
    const y = ay + (by - ay) * t;
    const z = az + (bz - az) * t;
    if (y > volume.top || y < volume.base - 2) continue;
    if (inside(volume.footprint, x, z) || nearEdge(volume.footprint, x, z, margin)) return true;
  }
  return false;
}
