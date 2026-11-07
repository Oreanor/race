import { formatNumber, t } from '@/i18n';
import { bearingTo } from '../Bounty.ts';
import { metersBetween, type Position } from '../VehicleController.ts';

// Screen indicators for things in the world (bots, other players, mission goals):
// a pin over the target while it is near and in view, otherwise an arrow on the
// screen edge pointing at it by compass bearing (works far ahead or behind the camera).

export type Indicator = { element: HTMLElement; arrow: HTMLElement; distance: HTMLElement };

/** On-screen pin only when the target is close enough to see; else always an edge arrow. */
export const MARKER_PIN_METERS = 200;

/** "340 m", "1.2 km", "1 250 km". */
export function formatRange(meters: number) {
  if (meters >= 1000) return t('unit.km', { n: formatNumber(meters >= 100000 ? Math.round(meters / 1000) : Math.round(meters / 100) / 10) });
  return t('unit.m', { n: formatNumber(Math.round(meters)) });
}

/** What placing needs from the map. */
export type IndicatorView = {
  getCanvas(): HTMLCanvasElement;
  project(point: Position): { x: number; y: number };
  getBearing(): number;
};

/** A named indicator (bot, player): arrow, name, distance. */
export function nameIndicator(className: string, color: string) {
  const element = document.createElement('div');
  element.className = className;
  const arrow = document.createElement('span');
  arrow.className = 'traffic-indicator-arrow';
  const content = document.createElement('span');
  content.className = 'traffic-indicator-content';
  const name = document.createElement('span');
  name.className = 'traffic-indicator-name';
  const distance = document.createElement('span');
  distance.className = 'traffic-indicator-distance';
  content.append(name, distance);
  element.style.setProperty('--traffic-color', color);
  element.append(arrow, content);
  return { element, arrow, name, distance };
}

/**
 * Place `marker` for a target seen from `from`; hidden while the canvas has no size.
 * `onMap`: the map view (camera high above): pin anything in frame, and point
 * off-frame targets by where they project on screen, not by the car's compass.
 */
export function placeIndicator(view: IndicatorView, marker: Indicator, from: Position, target: Position, pinMeters = MARKER_PIN_METERS, onMap = false) {
  const canvas = view.getCanvas();
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) {
    marker.element.style.display = 'none';
    return;
  }
  const meters = metersBetween(from, target);
  // Map view: the MapLibre plaque is the label — no range text stacked on it.
  marker.distance.textContent = onMap ? '' : formatRange(meters);
  marker.element.classList.toggle('is-map', onMap);
  marker.element.style.display = 'flex';
  const point = view.project(target);
  const projected = Number.isFinite(point.x) && Number.isFinite(point.y);
  const sideMargin = Math.min(64, width * 0.1);
  const topMargin = Math.min(96, height * 0.15);
  const bottomMargin = Math.min(64, height * 0.11);
  const inFrame = projected && point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height;
  const inSafe = projected
    && point.x >= sideMargin && point.x <= width - sideMargin
    && point.y >= topMargin && point.y <= height - bottomMargin;
  // Mission HUD yields to the map pin as soon as the target is anywhere in the viewport.
  if (inFrame && (onMap || meters < pinMeters) && marker.element.classList.contains('mission-indicator')) {
    marker.element.classList.add('is-onscreen');
    marker.element.classList.remove('is-edge');
    marker.element.style.display = 'none';
    return;
  }
  if (inSafe && (onMap || meters < pinMeters)) {
    marker.element.classList.add('is-onscreen');
    marker.element.classList.remove('is-edge');
    marker.element.style.left = `${point.x}px`;
    marker.element.style.top = `${point.y}px`;
    marker.arrow.style.transform = '';
    return;
  }
  const cx = width / 2;
  const cy = height / 2;
  // on the map: straight from the screen centre toward the projected target;
  // driving: compass on the screen edge — clear even when project() fails behind the camera
  const angle = onMap && projected && meters < 20000 // far beyond the horizon a projection can flip
    ? Math.atan2(point.x - cx, cy - point.y)
    : (bearingTo(from, target) - view.getBearing()) * Math.PI / 180;
  const dx = Math.sin(angle);
  const dy = -Math.cos(angle);
  const xLimit = Math.max(1, cx - sideMargin);
  const yLimit = Math.max(1, cy - (dy < 0 ? topMargin : bottomMargin));
  const scale = Math.min(dx ? xLimit / Math.abs(dx) : Infinity, dy ? yLimit / Math.abs(dy) : Infinity);
  marker.element.classList.remove('is-onscreen');
  marker.element.classList.add('is-edge');
  marker.element.style.left = `${cx + dx * scale}px`;
  marker.element.style.top = `${cy + dy * scale}px`;
  marker.arrow.style.transform = `rotate(${angle * 180 / Math.PI}deg)`;
}
