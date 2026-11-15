import type { Position } from './VehicleController.ts';

/** A transfer commits only after the destination is ready; timeouts leave us in place. */
export class PreparedTransfer {
  pending: { at: Position; commit: () => void; started: number } | null = null;
  state: 'loading' | 'failed' | null = null;

  begin(at: Position, commit: () => void, now: number) {
    if (this.pending) return false;
    this.pending = { at: [...at], commit, started: now };
    this.state = 'loading';
    return true;
  }

  tick(now: number, ready: boolean) {
    if (!this.pending || this.state !== 'loading') return;
    if (ready) {
      const { commit } = this.pending;
      this.cancel();
      commit();
    } else if (now - this.pending.started > 60000) this.state = 'failed';
  }

  retry(now: number) {
    if (!this.pending) return;
    this.pending.started = now;
    this.state = 'loading';
  }

  cancel() { this.pending = null; this.state = null; }
}
