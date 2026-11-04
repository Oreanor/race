// Removes wall pieces that lie on top of another wall. OSM data is full of
// these: neighbours sharing a wall, an outline and its building:parts, slightly
// different vertices on the same line. Two coplanar walls flicker (z-fighting),
// so on every shared stretch only one survives: the taller one (or the first).

export type CutWall = {
  ax: number; az: number; bx: number; bz: number;
  /** bottom and top of the wall, meters */
  y0: number; y1: number;
  /** tie-breaker: lower wins */
  order: number;
};

export type WallPiece<T> = { wall: T; t0: number; t1: number };

const CELL = 48;

/**
 * Splits walls into the pieces that are not covered by a higher-priority wall on
 * the same line. `tolerance` is how far apart (in the same units as x/z) two walls
 * may be and still count as the same plane.
 */
export function cutCoveredWalls<T extends CutWall>(walls: T[], tolerance = 0.06): WallPiece<T>[] {
  const grid = new Map<string, number[]>();
  const keyOf = (x: number, z: number) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
  walls.forEach((w, i) => {
    const cells = new Set<string>();
    const len = Math.hypot(w.bx - w.ax, w.bz - w.az);
    const steps = Math.max(1, Math.ceil(len / CELL));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      cells.add(keyOf(w.ax + (w.bx - w.ax) * t, w.az + (w.bz - w.az) * t));
    }
    for (const key of cells) {
      const list = grid.get(key);
      if (list) list.push(i); else grid.set(key, [i]);
    }
  });

  const beats = (a: T, b: T) => a.y1 > b.y1 + 0.05 || (Math.abs(a.y1 - b.y1) <= 0.05 && a.order < b.order);
  const out: WallPiece<T>[] = [];
  walls.forEach((w, i) => {
    const dx = w.bx - w.ax, dz = w.bz - w.az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return;
    const ux = dx / len, uz = dz / len;
    const covered: [number, number][] = [];
    const seen = new Set<number>();
    const steps = Math.max(1, Math.ceil(len / CELL));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      for (const j of grid.get(keyOf(w.ax + dx * t, w.az + dz * t)) ?? []) {
        if (j === i || seen.has(j)) continue;
        seen.add(j);
        const o = walls[j];
        if (!beats(o, w)) continue;
        // the other wall must cover this one's height and lie on the same line
        if (o.y0 > w.y0 + 0.08 || o.y1 < w.y1 - 0.08) continue;
        const da = (o.ax - w.ax) * uz - (o.az - w.az) * ux;
        const db = (o.bx - w.ax) * uz - (o.bz - w.az) * ux;
        if (Math.abs(da) > tolerance || Math.abs(db) > tolerance) continue;
        const pa = ((o.ax - w.ax) * ux + (o.az - w.az) * uz) / len;
        const pb = ((o.bx - w.ax) * ux + (o.bz - w.az) * uz) / len;
        const lo = Math.max(0, Math.min(pa, pb)), hi = Math.min(1, Math.max(pa, pb));
        if (hi - lo > 1e-4) covered.push([lo, hi]);
      }
    }
    covered.sort((a, b) => a[0] - b[0]);
    let cursor = 0;
    const minPiece = 0.05 / len; // drop slivers under 5 cm
    for (const [lo, hi] of covered) {
      if (lo > cursor + minPiece) out.push({ wall: w, t0: cursor, t1: lo });
      cursor = Math.max(cursor, hi);
    }
    if (cursor < 1 - minPiece) out.push({ wall: w, t0: cursor, t1: 1 });
  });
  return out;
}
