import { t } from '@/i18n';
import { healthColor } from '../health';
import type { Position } from '../VehicleController';

// Health bars hovering over the cars on screen: us, mission bots, other players,
// shared traffic and test cars alike. One list a frame says who has one and where.

/** `color`: the name goes above the bar in this colour (the car's marker colour); none, no name */
export type Meter = { id: string; name: string; hp: number; maxHp: number; position: Position; color?: string };

const FILL = { green: '#25e35b', yellow: '#ffe000', red: '#ff3030' } as const;

export class HealthMeters {
  private layer: HTMLElement | null = null;
  private meters = new Map<string, { element: HTMLElement; fill: HTMLElement; label: HTMLElement }>();

  constructor(private host: HTMLElement) {}

  /**
   * Show a meter over everybody in `list` that projects inside the view;
   * `refill` updates the bars too (a few times a second is plenty).
   */
  update(list: Meter[], project: (p: Position) => { x: number; y: number }, width: number, height: number, refill: boolean) {
    this.hide();
    if (!width || !height) return;
    this.sync(list);
    for (const entry of list) {
      const meter = this.meters.get(entry.id);
      if (!meter) continue;
      const point = project(entry.position);
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > width || point.y < 0 || point.y > height) continue;
      if (refill) {
        const color = healthColor(entry.hp, entry.maxHp);
        meter.element.className = `overhead-health-meter ${color}`;
        meter.element.setAttribute('aria-valuenow', String(entry.hp));
        meter.element.setAttribute('aria-valuemax', String(entry.maxHp));
        meter.fill.style.width = `${Math.max(0, Math.min(1, entry.hp / entry.maxHp)) * 100}%`;
        meter.fill.style.backgroundColor = FILL[color];
      }
      meter.element.style.left = `${point.x}px`;
      meter.element.style.top = `${point.y - 52}px`;
      meter.element.style.display = 'block';
      if (entry.color) {
        if (meter.label.textContent !== entry.name) meter.label.textContent = entry.name;
        meter.label.style.color = entry.color;
        meter.label.style.left = `${point.x}px`;
        meter.label.style.top = `${point.y - 58}px`;
        meter.label.style.display = 'block';
      }
    }
  }

  hide() {
    for (const meter of this.meters.values()) { meter.element.style.display = 'none'; meter.label.style.display = 'none'; }
  }

  dispose() {
    this.layer?.remove();
    this.layer = null;
    this.meters.clear();
  }

  /** Meters for newcomers, none for those gone. */
  private sync(list: Meter[]) {
    if (!this.layer) {
      this.layer = document.createElement('div');
      this.layer.className = 'overhead-health-indicators';
      Object.assign(this.layer.style, { position: 'absolute', inset: '0', zIndex: '6', pointerEvents: 'none', overflow: 'hidden' });
      this.host.appendChild(this.layer);
    }
    const active = new Set(list.map((entry) => entry.id));
    for (const [id, meter] of this.meters) {
      if (active.has(id)) continue;
      meter.element.remove();
      meter.label.remove();
      this.meters.delete(id);
    }
    for (const entry of list) {
      if (this.meters.has(entry.id)) continue;
      const element = document.createElement('div');
      element.className = 'overhead-health-meter';
      element.setAttribute('role', 'meter');
      element.setAttribute('aria-label', t('health.label', { name: entry.name }));
      element.setAttribute('aria-valuemin', '0');
      Object.assign(element.style, {
        position: 'absolute', display: 'none', width: '48px', height: '7px', transform: 'translate(-50%, -50%)', overflow: 'hidden',
        border: '1px solid #f7f7ef', borderRadius: '4px', backgroundColor: '#1a2228d9', boxShadow: '0 1px 5px #000b',
      });
      const fill = document.createElement('span');
      Object.assign(fill.style, { display: 'block', height: '100%', transition: 'width .12s' });
      element.appendChild(fill);
      const label = document.createElement('div');
      label.className = 'overhead-health-name';
      Object.assign(label.style, {
        position: 'absolute', display: 'none', transform: 'translate(-50%, -100%)', whiteSpace: 'nowrap',
        font: '700 12px/1.1 system-ui, sans-serif', textShadow: '0 0 3px #000, 0 1px 2px #000',
      });
      this.layer.appendChild(label);
      this.layer.appendChild(element);
      this.meters.set(entry.id, { element, fill, label });
    }
  }
}
