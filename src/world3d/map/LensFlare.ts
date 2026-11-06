import type * as THREE from 'three';

// A lens flare from the sun, drawn as a few soft DOM circles over the canvas (no extra
// GL work): a glow round the sun, and ghosts strung along the line from the sun through
// the middle of the screen, as a camera lens throws them. It follows the sun's colour,
// is strongest low over the horizon, and fades out when a house hides the sun.

/** where along sun → centre each ghost sits (1 = the centre), its size (share of the screen) and strength */
const GHOSTS = [
  { k: 0.35, size: 0.05, alpha: 0.5, ring: false },
  { k: 0.72, size: 0.11, alpha: 0.3, ring: false },
  { k: 1.18, size: 0.035, alpha: 0.55, ring: false },
  { k: 1.5, size: 0.17, alpha: 0.26, ring: true },
  { k: 1.95, size: 0.075, alpha: 0.35, ring: false },
];
/** the sun may be this far past the screen's edge (share of the screen) and still flare into it */
const REACH = 0.9;

export class LensFlare {
  private root: HTMLDivElement;
  private glow: HTMLDivElement;
  private ghosts: HTMLDivElement[];
  /** how much of the sun shows (smoothed), and what the last look said */
  private seen = 0;
  private target = 0;
  private frame = 0;
  private tint = '';

  constructor(container: HTMLElement, before: Element | null) {
    const circle = () => {
      const el = document.createElement('div');
      Object.assign(el.style, { position: 'absolute', left: '0', top: '0', borderRadius: '50%', mixBlendMode: 'screen', willChange: 'transform, opacity' });
      return el;
    };
    this.root = document.createElement('div');
    Object.assign(this.root.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden', zIndex: '1', display: 'none' });
    this.glow = circle();
    this.ghosts = GHOSTS.map(() => circle());
    this.root.append(this.glow, ...this.ghosts);
    container.insertBefore(this.root, before);
  }

  /**
   * Once a frame. `sun`: the sun on screen (CSS px), or null when it is behind the camera or
   * down; `strength` 0…1; `color` the sunlight; `blocked` asks whether a house hides the
   * sun (asked every few frames only, it casts a ray).
   */
  update(sun: { x: number; y: number } | null, width: number, height: number, strength: number, color: THREE.Color, blocked: () => boolean) {
    if (!sun || strength <= 0.01 || !width || !height) {
      this.seen = 0;
      this.root.style.display = 'none';
      return;
    }
    if (this.frame++ % 6 === 0) this.target = blocked() ? 0 : 1;
    this.seen += (this.target - this.seen) * 0.18;
    // off the screen (a top-down camera rarely has the sun in view): it still glares in from
    // that edge, fading as it gets farther out
    const out = Math.max(0, -sun.x, sun.x - width, -sun.y, sun.y - height);
    const edge = Math.max(0, 1 - out / (Math.min(width, height) * REACH));
    const power = strength * this.seen * edge;
    if (power < 0.01) { this.root.style.display = 'none'; return; }
    this.root.style.display = '';

    const max = Math.max(color.r, color.g, color.b, 1e-3);
    const tint = `${Math.round(255 * color.r / max)},${Math.round(255 * color.g / max)},${Math.round(255 * color.b / max)}`;
    const span = Math.min(width, height);
    const place = (el: HTMLDivElement, x: number, y: number, size: number, alpha: number) => {
      el.style.width = el.style.height = `${size}px`;
      el.style.transform = `translate(${(x - size / 2).toFixed(1)}px,${(y - size / 2).toFixed(1)}px)`;
      el.style.opacity = alpha.toFixed(3);
    };
    if (tint !== this.tint) {
      this.tint = tint;
      this.glow.style.background = `radial-gradient(circle, rgba(255,255,255,0.95) 0%, rgba(${tint},0.55) 12%, rgba(${tint},0.18) 35%, rgba(${tint},0) 70%)`;
      GHOSTS.forEach((g, i) => {
        this.ghosts[i].style.background = g.ring
          ? `radial-gradient(circle, rgba(${tint},0) 55%, rgba(${tint},0.6) 68%, rgba(${tint},0) 78%)`
          : `radial-gradient(circle, rgba(${tint},0.7) 0%, rgba(${tint},0.35) 45%, rgba(${tint},0) 72%)`;
      });
    }
    // the glow sits on the sun, or on the screen's edge nearest it
    const gx = Math.min(width, Math.max(0, sun.x)), gy = Math.min(height, Math.max(0, sun.y));
    place(this.glow, gx, gy, span * (out > 0 ? 0.9 : 0.6), Math.min(1, power * (out > 0 ? 0.8 : 1.1)));
    const cx = width / 2, cy = height / 2;
    GHOSTS.forEach((g, i) => place(this.ghosts[i], sun.x + (cx - sun.x) * g.k, sun.y + (cy - sun.y) * g.k, span * g.size, g.alpha * power));
  }

  dispose() { this.root.remove(); }
}
