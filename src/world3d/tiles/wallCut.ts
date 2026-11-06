// Removes wall pieces that lie on top of another wall. OSM data is full of
// these: neighbours sharing a wall, an outline and its building:parts, slightly
// different vertices on the same line. Two coplanar walls flicker (z-fighting),
// so on every shared stretch only one survives: the taller one (or the first).
// A taller part standing on stilts (min_height) over a lower wall takes it from
// its base up: the lower wall keeps only the band beneath it.

export type CutWall = {
  ax: number; az: number; bx: number; bz: number;
  /** bottom and top of the wall, meters */
  y0: number; y1: number;
  /** tie-breaker: lower wins */
  order: number;
};

/** `top`: the piece ends here (same units as y) instead of at its wall's top — a raised part takes over above */
export type WallPiece<T> = { wall: T; t0: number; t1: number; top?: number };

const CELL = 48;
/** walls this far off parallel (sine of the angle, ~10°) still count as one: facets of one curve */
const MAX_SKEW = 0.17;

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
    // the walls that may cover this one: higher priority, covering its height, running along it
    const rivals: T[] = [];
    const seen = new Set<number>();
    const steps = Math.max(1, Math.ceil(len / CELL));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      for (const j of grid.get(keyOf(w.ax + dx * t, w.az + dz * t)) ?? []) {
        if (j === i || seen.has(j)) continue;
        seen.add(j);
        const o = walls[j];
        // it must reach this one's top; one starting higher takes the wall from its base up
        if (!beats(o, w) || o.y1 < w.y1 - 0.08 || o.y0 >= w.y1 - 0.08) continue;
        const ol = Math.hypot(o.bx - o.ax, o.bz - o.az);
        if (ol < 1e-6 || Math.abs(((o.bx - o.ax) * uz - (o.bz - o.az) * ux) / ol) > MAX_SKEW) continue;
        rivals.push(o);
      }
    }
    if (!rivals.length) { out.push({ wall: w, t0: 0, t1: 1 }); return; }
    // Walk along the wall: a stretch is covered where one of them runs within `tolerance`.
    // Point by point, so a curved facade cut into different facets by two outlines (a
    // building and its part) still finds its twin, facet against facet.
    const samples = Math.max(2, Math.min(400, Math.ceil(len / tolerance)));
    // per sample: how high this wall may still go (Infinity: all of it, -Infinity: none)
    const cap = new Float64Array(samples).fill(Infinity);
    for (let s = 0; s < samples; s++) {
      const px = w.ax + dx * (s + 0.5) / samples, pz = w.az + dz * (s + 0.5) / samples;
      for (const o of rivals) {
        const ox = o.bx - o.ax, oz = o.bz - o.az, ol2 = ox * ox + oz * oz;
        const t = ((px - o.ax) * ox + (pz - o.az) * oz) / ol2;
        if (t < -0.02 || t > 1.02) continue;
        const qx = o.ax + ox * t - px, qz = o.az + oz * t - pz;
        if (qx * qx + qz * qz > tolerance * tolerance) continue;
        if (o.y0 <= w.y0 + 0.08) { cap[s] = -Infinity; break; } // covered top to bottom
        cap[s] = Math.min(cap[s], o.y0);
      }
    }
    const minPiece = 0.05 / len; // drop slivers under 5 cm
    let from = 0;
    for (let s = 1; s <= samples; s++) {
      // a run of samples with the same cap (a few cm apart is the same) is one piece
      if (s < samples && (cap[s] === cap[from] || Math.abs(cap[s] - cap[from]) < 0.05)) continue;
      const t0 = from === 0 ? 0 : from / samples, t1 = s === samples ? 1 : s / samples;
      const top = cap[from];
      if (top !== -Infinity && t1 - t0 > minPiece) out.push(top === Infinity ? { wall: w, t0, t1 } : { wall: w, t0, t1, top });
      from = s;
    }
  });
  return out;
}
