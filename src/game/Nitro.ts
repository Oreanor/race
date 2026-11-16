// The nitro, the same for everyone (us, racers, the police): a bar that burns while the
// boost is held and refills by itself when it is let go.

/** a full bar burns in this long (s) */
export const NITRO_BURN_S = 10;
/** an empty bar refills in this long (s) */
export const NITRO_REFILL_S = 20;

export class Nitro {
  /** 0…1 left in the bar */
  level = 1;
  /** burning this step */
  active = false;
  /** ran dry with the boost still held: it waits to be let go (else every refilled drop would flicker it on) */
  private spent = false;

  /** One step: `held` the boost is wanted; `can` it may burn at all (an empty tank: no). */
  tick(dt: number, held: boolean, can = true) {
    if (!held) this.spent = false;
    this.active = held && can && !this.spent && this.level > 0;
    if (this.active) {
      this.level = Math.max(0, this.level - dt / NITRO_BURN_S);
      if (this.level <= 0) { this.spent = true; this.active = false; }
    } else this.level = Math.min(1, this.level + dt / NITRO_REFILL_S);
    return this.active;
  }
}
