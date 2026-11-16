import { ThreeMarker, type ThreeMap } from '@/world3d/map/ThreeMap';
import type { Position } from '../VehicleController.ts';
import { metersBetween } from '../meters.ts';
import { MISSION_COLORS } from '../tuning.ts';
import { formatRange } from './indicators.ts';

// The pins standing in the world (missions, goals, services, our own dot) and the
// arrows at the screen's edge that point to them when they are out of frame.

export type MapMarker = {
  setLngLat(position: [number, number]): MapMarker;
  /** stand at this height (m) instead of on the ground */
  setAltitude(altitude: number | null): MapMarker;
  addTo(map: ThreeMap): MapMarker;
  remove(): unknown;
  getElement(): HTMLElement;
};

export type MissionColor = keyof typeof MISSION_COLORS;

export function newMarker(options: { element: HTMLElement; anchor: 'bottom' | 'center' }): MapMarker {
  return new ThreeMarker(options) as unknown as MapMarker;
}

/**
 * Map label. With `tip` (default): text + range + same-size triangle as the offscreen arrow.
 * Without tip: plain plaque (travel hubs / services).
 */
export function makeMapLabel(
  className: string,
  text: string,
  label: string,
  colors?: { main: string; soft: string },
  tip = true,
) {
  const element = document.createElement('div');
  element.className = tip ? `map-pin ${className}` : className;
  element.setAttribute('aria-label', label);
  if (colors) {
    element.style.setProperty('--mission-color', colors.main);
    element.style.setProperty('--mission-soft', colors.soft);
    element.style.setProperty('--pin-color', colors.main);
    element.style.setProperty('--pin-soft', colors.soft);
  }
  const title = document.createElement('span');
  if (tip) title.className = 'map-pin-label';
  title.textContent = text;
  element.append(title);
  if (tip) {
    const distance = document.createElement('span');
    distance.className = 'map-pin-distance';
    distance.setAttribute('aria-hidden', 'true');
    element.append(distance);
    const arrow = document.createElement('span');
    arrow.className = 'map-pin-tip';
    arrow.setAttribute('aria-hidden', 'true');
    element.append(arrow);
  }
  return element;
}

/** The range under a pin's label, from `from`; blank when not shown (the M map: plaque only). */
export function setPinRange(marker: MapMarker | null | undefined, from: Position, target: [number, number] | null, show: boolean) {
  const el = marker?.getElement()?.querySelector('.map-pin-distance');
  if (!(el instanceof HTMLElement)) return;
  el.textContent = show && target ? formatRange(metersBetween(from, target)) : '';
}

export function paintMissionIndicator(element: HTMLElement, kind: MissionColor) {
  const colors = MISSION_COLORS[kind];
  element.style.setProperty('--mission-color', colors.main);
  element.style.setProperty('--mission-soft', colors.soft);
}

/** The arrow at the screen's edge toward an off-frame goal: title and range beside it. */
export function makeOffscreenIndicator(kind: 'focus' | 'finish', titleText: string) {
  const element = document.createElement('div');
  element.className = `mission-indicator ${kind === 'focus' ? 'mission-focus-indicator' : 'race-finish-indicator'}`;
  paintMissionIndicator(element, kind === 'finish' ? 'finish' : 'arena');
  const arrow = document.createElement('span');
  arrow.className = 'mission-indicator-arrow';
  const content = document.createElement('span');
  content.className = 'mission-indicator-content';
  const title = document.createElement('span');
  title.className = 'mission-reward';
  title.textContent = titleText;
  const distance = document.createElement('span');
  distance.className = 'mission-indicator-distance';
  content.append(title, distance);
  element.setAttribute('aria-label', titleText);
  element.append(arrow, content);
  return { element, arrow, title, distance };
}

/**
 * The one pin of a special car's job (fire, taxi, ambulance, bus tour, impound): where the
 * job is now and what it says; shown with a null spot, it comes down.
 */
export class JobPin {
  private marker: MapMarker | null = null;
  private at: [number, number] | null = null;

  constructor(private className: string, private color: MissionColor) {}

  show(map: ThreeMap, at: [number, number] | null, title: string) {
    this.at = at;
    if (!at) { this.remove(); return; }
    const colors = MISSION_COLORS[this.color];
    if (!this.marker) {
      this.marker = newMarker({ element: makeMapLabel(this.className, title, title, colors), anchor: 'bottom' }).setLngLat(at).addTo(map);
      return;
    }
    this.marker.setLngLat(at);
    const el = this.marker.getElement();
    const label = el?.querySelector('.map-pin-label');
    if (label) label.textContent = title;
    paintMissionIndicator(el, this.color);
  }

  /** the range under its label, from us */
  range(from: Position, show: boolean) {
    setPinRange(this.marker, from, this.at, show);
  }

  /** taken down (a new language, the drive over): the next show makes it again */
  remove() {
    this.marker?.remove();
    this.marker = null;
  }
}
