// Removes wall pieces that lie on top of another wall. OSM data is full of
// these: neighbours sharing a wall, an outline and its building:parts, slightly
// different vertices on the same line. Two coplanar walls flicker (z-fighting),
// so on every shared stretch only one survives: the taller one (or the first).
// A taller part standing on stilts (min_height) over a lower wall takes it from
// its base up: the lower wall keeps only the band beneath it. Two walls back to back
// reaching the same height (neighbours under one roof line) are both inside: neither
// is drawn, so no roof lip runs across the joined roofs.

export type CutWall = {
  ax: number; az: number; bx: number; bz: number;
  /** bottom and top of the wall, meters */
  y0: number; y1: number;
  /** tie-breaker: lower wins */
  order: number;
  /** outward normal (optional): two walls back to back at one height are inside a block */
  nx?: number; nz?: number;
};

/** `top`: the piece ends here (same units as y) instead of at its wall's top — a raised part takes over above */
export type WallPiece<T> = { wall: T; t0: number; t1: number; top?: number };

const CELL = 48;
/** walls this far off parallel (sine of the angle, ~10°) still count as one: facets of one curve */
const MAX_SKEW = 0.17;
/** back-to-back walls both go only when this parallel (~3°) and this close (share of the tolerance) */
const TWIN_SKEW = 0.05;
const TWIN_GAP = 0.3;

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
    const rivals: { wall: T; twin: boolean }[] = [];
    const seen = new Set<number>();
    const steps = Math.max(1, Math.ceil(len / CELL));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      for (const j of grid.get(keyOf(w.ax + dx * t, w.az + dz * t)) ?? []) {
        if (j === i || seen.has(j)) continue;
        seen.add(j);
        const o = walls[j];
        // back to back with this one, as high and as low: both are inside the block
        const ol = Math.hypot(o.bx - o.ax, o.bz - o.az);
        const skew = ol < 1e-6 ? Infinity : Math.abs(((o.bx - o.ax) * uz - (o.bz - o.az) * ux) / ol);
        // back to back with this one, as high and as low, and truly one plane (a narrow wedge
        // between two houses is not: dropping both there would open a hole to the ground)
        const twin = w.nx != null && o.nx != null && w.nx * o.nx + (w.nz ?? 0) * (o.nz ?? 0) < -0.5
          && Math.abs(o.y1 - w.y1) <= 0.15 && Math.abs(o.y0 - w.y0) <= 0.08 && skew <= TWIN_SKEW;
        // it must reach this one's top; one starting higher takes the wall from its base up
        if (!twin && (!beats(o, w) || o.y1 < w.y1 - 0.08 || o.y0 >= w.y1 - 0.08)) continue;
        if (skew > MAX_SKEW) continue;
        rivals.push({ wall: o, twin });
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
      for (const { wall: o, twin } of rivals) {
        const ox = o.bx - o.ax, oz = o.bz - o.az, ol2 = ox * ox + oz * oz;
        const t = ((px - o.ax) * ox + (pz - o.az) * oz) / ol2;
        if (t < -0.02 || t > 1.02) continue;
        const qx = o.ax + ox * t - px, qz = o.az + oz * t - pz;
        // a twin (both walls go) only where they really touch
        const reach = twin && !beats(o, w) ? tolerance * TWIN_GAP : tolerance;
        if (qx * qx + qz * qz > reach * reach) continue;
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
