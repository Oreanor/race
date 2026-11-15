import { getLang } from '../i18n/index.ts';
import { eastNorth } from './meters.ts';

/** move this far before asking where we are again (m) */
const STEP_M = 250;
/** and not more often than this (ms) */
const EVERY_MS = 6000;

type Locality = { name: string; district: string | null };

/**
 * The settlement under the car, asked from /api/locality as it travels.
 * `name` is null until the first answer (or with no answer): show the city instead.
 * In the country `district` stays null; there the village is the answer.
 */
export class LocalityWatch {
  name: string | null = null;
  /** the district of it, when it has them */
  district: string | null = null;
  private askedFrom: [number, number] | null = null;
  private askedAt = 0;
  private busy: AbortController | null = null;
  private disposed = false;

  update(position: readonly [number, number]) {
    if (this.disposed || this.busy) return;
    const now = performance.now();
    if (now - this.askedAt < EVERY_MS && this.askedAt) return;
    if (this.askedFrom) {
      const { east, north } = eastNorth(this.askedFrom, position);
      if (Math.hypot(east, north) < STEP_M) return;
    }
    if (!Number.isFinite(position[0]) || !Number.isFinite(position[1]) || (position[0] === 0 && position[1] === 0)) return;
    const from: [number, number] = [position[0], position[1]];
    this.askedFrom = from;
    this.askedAt = now;
    const ctrl = new AbortController();
    this.busy = ctrl;
    fetch(`/api/locality?lat=${from[1].toFixed(5)}&lng=${from[0].toFixed(5)}&lang=${getLang()}`, { signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(10000)]) })
      .then((response) => response.ok ? response.json() as Promise<Locality | null> : null)
      .then((found) => {
        if (this.disposed || !found || typeof found.name !== 'string' || !found.name) return;
        this.name = found.name;
        this.district = typeof found.district === 'string' && found.district ? found.district : null;
      })
      .catch(() => { /* offline or no route (desktop build): keep what we have */ })
      .finally(() => { if (this.busy === ctrl) this.busy = null; });
  }

  dispose() {
    this.disposed = true;
    this.busy?.abort();
  }
}
