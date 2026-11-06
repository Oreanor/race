import type { Position } from '@/game/VehicleController';
import { offsetPosition } from '@/game/VehicleController';

// Fire on existing map façades: no custom house mesh. Each pane is a real wall
// window (lng/lat + altitude + outward normal). Water near a pane puts it out.

const EARTH = 6378137;

export type FirePaneSpec = {
  at: Position;
  altitude: number;
  /** outward horizontal normal (east, north) */
  oe: number;
  on: number;
};

export type HouseFx = {
  e: number;
  n: number;
  u: number;
  oe: number;
  on: number;
  mode: 'smoke' | 'steam';
  strength: number;
};

type Pane = FirePaneSpec & { out: boolean; steamUntil: number };

function eastNorth(origin: Position, point: Position) {
  const lat = origin[1] * Math.PI / 180;
  return {
    east: (point[0] - origin[0]) * Math.PI / 180 * EARTH * Math.cos(lat),
    north: (point[1] - origin[1]) * Math.PI / 180 * EARTH,
  };
}

export class BurningHouse {
  placed = false;
  private panes: Pane[] = [];
  /** total panes when this call started (for payout) */
  total = 0;

  /** Start a fire on these façade windows (existing building). */
  ignite(panes: FirePaneSpec[]) {
    this.panes = panes.map((p) => ({ ...p, at: [...p.at] as Position, out: false, steamUntil: 0 }));
    this.total = this.panes.length;
    this.placed = this.panes.length > 0;
  }

  clear() {
    this.placed = false;
    this.panes = [];
    this.total = 0;
  }

  burningLeft() {
    let n = 0;
    for (const p of this.panes) if (!p.out) n += 1;
    return n;
  }

  extinguishedCount() {
    return this.total - this.burningLeft();
  }

  /** Burning pane markers for the façade shader (lng/lat + altitude). */
  fireMarkers(): { at: Position; altitude: number }[] {
    if (!this.placed) return [];
    return this.panes.filter((p) => !p.out).map((p) => ({ at: p.at, altitude: p.altitude }));
  }

  /**
   * Water sample at ENU (relative to the player). Puts out the nearest burning
   * pane within reach; that pane then steams briefly.
   */
  douseAt(
    here: Position,
    carAlt: number,
    sample: { e: number; n: number; u: number },
    now: number,
    reach = 1.35,
  ): { e: number; n: number; u: number; fresh: boolean; at: Position; altitude: number } | null {
    if (!this.placed) return null;
    let best: { pane: Pane; d: number; e: number; n: number; u: number } | null = null;
    for (const pane of this.panes) {
      const o = eastNorth(here, pane.at);
      const pe = o.east + pane.oe * 0.12;
      const pn = o.north + pane.on * 0.12;
      const pu = pane.altitude - carAlt;
      const d = Math.hypot(sample.e - pe, sample.n - pn, sample.u - pu);
      if (d > reach || (best && d >= best.d)) continue;
      // approach from outside: sample should sit on the street side of the pane
      const toward = (sample.e - pe) * pane.oe + (sample.n - pn) * pane.on;
      if (toward < -0.35) continue;
      best = { pane, d, e: pe, n: pn, u: pu };
    }
    if (!best) return null;
    const { pane } = best;
    let fresh = false;
    if (!pane.out) {
      pane.out = true;
      pane.steamUntil = now + 1800;
      fresh = true;
    } else if (pane.steamUntil > now) {
      pane.steamUntil = Math.max(pane.steamUntil, now + 600);
    }
    return {
      e: best.e,
      n: best.n,
      u: best.u,
      fresh,
      at: pane.at,
      altitude: pane.altitude,
    };
  }

  /** Sparse smoke / steam from burning or recently doused panes. */
  fxEmitters(here: Position, carAlt: number, now: number, out: HouseFx[] = []): HouseFx[] {
    out.length = 0;
    if (!this.placed) return out;
    let budget = 2;
    for (let t = 0; t < 10 && budget > 0; t++) {
      const pane = this.panes[(Math.random() * this.panes.length) | 0];
      if (!pane) break;
      const steaming = pane.steamUntil > now;
      const burning = !pane.out;
      if (!burning && !steaming) continue;
      if (burning && Math.random() > 0.4) continue;
      if (steaming && Math.random() > 0.55) continue;
      const o = eastNorth(here, pane.at);
      const e = o.east + pane.oe * 0.2;
      const n = o.north + pane.on * 0.2;
      const u = pane.altitude - carAlt + 0.1;
      if (burning) {
        out.push({ e, n, u, oe: pane.oe, on: pane.on, mode: 'smoke', strength: 1 });
      } else {
        const left = (pane.steamUntil - now) / 1800;
        out.push({ e, n, u, oe: pane.oe, on: pane.on, mode: 'steam', strength: Math.max(0.15, left) });
      }
      budget -= 1;
    }
    return out;
  }

  dispose() {
    this.clear();
  }
}

/** Pick how many panes burn: from 1 up to all candidates. */
export function pickBurningCount(available: number, seed: number) {
  if (available <= 1) return available;
  const r = ((seed >>> 0) * 2654435761) >>> 0;
  return 1 + (r % available);
}

/** Shuffle-copy then take the first `n` panes (deterministic from seed). */
export function pickBurningPanes(panes: FirePaneSpec[], n: number, seed: number): FirePaneSpec[] {
  const list = panes.map((p) => ({ ...p, at: [...p.at] as Position }));
  let s = seed >>> 0;
  for (let i = list.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    const tmp = list[i];
    list[i] = list[j];
    list[j] = tmp;
  }
  return list.slice(0, Math.max(1, Math.min(n, list.length)));
}

/** A pin a few metres out from the façade toward the street. */
export function facadeMarker(panes: FirePaneSpec[], fallback: Position): Position {
  if (!panes.length) return fallback;
  let e = 0, n = 0, oe = 0, on = 0;
  for (const p of panes) {
    e += p.at[0];
    n += p.at[1];
    oe += p.oe;
    on += p.on;
  }
  const mid: Position = [e / panes.length, n / panes.length];
  const len = Math.hypot(oe, on) || 1;
  return offsetPosition(mid, (oe / len) * 8, (on / len) * 8);
}
