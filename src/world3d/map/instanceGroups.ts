import type { InstanceSet } from '../tiles/vegetationTile.ts';

/** Spatial batches preserve the original slot IDs used by destruction/gameplay. */
export function* instanceGroups(set: InstanceSet, metersScale: number, cellMeters = 256) {
  const cells = new Map<string, number[]>();
  const cell = cellMeters / metersScale;
  for (let i = 0; i < set.count; i++) {
    const key = `${Math.floor(set.matrices[i * 16 + 12] / cell)}:${Math.floor(set.matrices[i * 16 + 14] / cell)}`;
    let ids = cells.get(key);
    if (!ids) cells.set(key, ids = []);
    ids.push(i);
  }
  for (const ids of cells.values()) {
    // Bound dense groves too, even when every tree is in the same cell.
    for (let start = 0; start < ids.length; start += 256) {
      const slots = ids.slice(start, start + 256);
      const copy = (data: Float32Array | undefined, stride: number) => {
        if (!data) return undefined;
        const out = new Float32Array(slots.length * stride);
        slots.forEach((id, i) => out.set(data.subarray(id * stride, (id + 1) * stride), i * stride));
        return out;
      };
      const data: InstanceSet = { count: slots.length, matrices: copy(set.matrices, 16)!, ground: copy(set.ground, 1)!,
        colors: copy(set.colors, 3), bark: copy(set.bark, 3), traits: copy(set.traits, 4) };
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const id of slots) {
        const x = set.matrices[id * 16 + 12], z = set.matrices[id * 16 + 14];
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
      }
      yield { data, slots: new Map(slots.map((id, i) => [id, i])), bounds: [x0, z0, x1, z1] };
    }
  }
}
