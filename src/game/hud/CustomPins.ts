import type { ThreeMap } from '@/world3d/map/ThreeMap';
import { t } from '@/i18n';
import { CUSTOM_PIN_COLORS } from '../tuning.ts';
import { makeMapLabel, makeOffscreenIndicator, newMarker, type MapMarker } from './mapPins.ts';

export type CustomPin = {
  id: string;
  position: [number, number];
  color: (typeof CUSTOM_PIN_COLORS)[number];
  marker: MapMarker;
  indicator: { element: HTMLElement; arrow: HTMLElement; title: HTMLElement; distance: HTMLElement };
};

/** What the player's pins need from the game. */
export interface CustomPinsHost {
  readonly map: ThreeMap;
  /** the M map is open for looking about (pins take clicks and drags only then) */
  inspecting(): boolean;
  /** the layer the edge arrows live in */
  indicatorLayer(): HTMLElement;
  /** a pin came, moved or went: goals, beacons and arrows follow */
  changed(): void;
}

/**
 * The player's own pins on the M map (one per colour, up to three): a click puts one,
 * dragging moves it, a click on it takes it away. Each is followed like a mission goal.
 */
export class CustomPins {
  readonly list: CustomPin[] = [];
  private seq = 0;

  constructor(private host: CustomPinsHost) {}

  /** A new language: the pins say it again. */
  relabel() {
    const text = t('marker.pin');
    for (const pin of this.list) {
      const span = pin.marker.getElement()?.querySelector('.map-pin-label');
      if (span) span.textContent = text;
      pin.marker.getElement()?.setAttribute('aria-label', text);
    }
  }

  private nextColor() {
    const used = new Set(this.list.map(pin => pin.color.main));
    return CUSTOM_PIN_COLORS.find(color => !used.has(color.main)) ?? null;
  }

  place(position: [number, number]) {
    if (this.list.length >= CUSTOM_PIN_COLORS.length) return;
    const color = this.nextColor();
    if (!color) return;
    const id = `pin-${++this.seq}`;
    const label = t('marker.pin');
    const element = makeMapLabel('custom-map-marker', label, label, { main: color.main, soft: color.soft });
    element.style.pointerEvents = 'auto';
    const marker = newMarker({ element, anchor: 'bottom' }).setLngLat(position).addTo(this.host.map);
    const indicator = makeOffscreenIndicator('focus', label);
    indicator.element.classList.replace('mission-focus-indicator', 'custom-pin-indicator');
    indicator.element.style.setProperty('--pin-color', color.main);
    indicator.element.style.setProperty('--pin-soft', color.soft);
    indicator.element.style.setProperty('--mission-color', color.main);
    indicator.element.style.setProperty('--mission-soft', color.soft);
    this.host.indicatorLayer().appendChild(indicator.element);
    const pin = { id, position: [...position] as [number, number], color, marker, indicator };
    this.list.push(pin);
    this.bindDrag(pin, element);
    this.host.changed();
  }

  /** Drag moves the pin; a short click without drag removes it. */
  private bindDrag(
    pin: { id: string; position: [number, number]; marker: MapMarker },
    element: HTMLElement,
  ) {
    let drag: { pointerId: number; x: number; y: number; moved: boolean } | null = null;
    const pointOnMap = (e: PointerEvent): [number, number] => {
      const rect = this.host.map.getCanvas().getBoundingClientRect();
      const hit = this.host.map.unproject({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      return [hit.lng, hit.lat];
    };
    element.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.host.inspecting()) return;
      e.stopPropagation();
      e.preventDefault();
      drag = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
      element.classList.add('is-dragging');
      try { element.setPointerCapture(e.pointerId); } catch { /* older engines */ }
    });
    element.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) drag.moved = true;
      if (!drag.moved) return;
      const next = pointOnMap(e);
      pin.position[0] = next[0];
      pin.position[1] = next[1];
      pin.marker.setLngLat(next);
      this.host.changed();
    });
    const endDrag = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const moved = drag.moved;
      drag = null;
      element.classList.remove('is-dragging');
      try { element.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      if (!moved) this.remove(pin.id);
      else this.host.changed();
    };
    element.addEventListener('pointerup', endDrag);
    element.addEventListener('pointercancel', endDrag);
  }

  private remove(id: string) {
    const index = this.list.findIndex(pin => pin.id === id);
    if (index < 0) return;
    const [pin] = this.list.splice(index, 1);
    pin.marker.remove();
    pin.indicator.element.remove();
    this.host.changed();
  }

  clear() {
    if (!this.list.length) return;
    for (const pin of this.list) {
      pin.marker.remove();
      pin.indicator.element.remove();
    }
    this.list.length = 0;
    this.host.changed();
  }

  syncPointers() {
    const on = this.host.inspecting();
    for (const pin of this.list) {
      const el = pin.marker.getElement();
      if (el) el.style.pointerEvents = on ? 'auto' : 'none';
    }
  }
}
