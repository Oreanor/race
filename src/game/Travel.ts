import type { Position } from './VehicleController.ts';

// Ports and airports at real OSM locations. Reach one, buy a ticket to any
// city in the world and arrive there instantly. Prices are the same rule
// everywhere: great-circle kilometres × the tariff of the transport.

export type HubKind = 'airport' | 'port';
export type Hub = { id: string; kind: HubKind; position: Position };

/** coins per kilometre: 1000 km by sea ≈ 1000 coins, flying costs more */
export const TARIFF: Record<HubKind, number> = { port: 1, airport: 1.5 };
/** how close to the hub point the car has to be, meters (airport labels sit in big areas; ports want the nose at the pier) */
export const HUB_REACH: Record<HubKind, number> = { airport: 350, port: 28 };
const MIN_FARE = 50;

const R = 6371.0088;

export function kilometres(a: Position, b: Position) {
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLng = (b[0] - a[0]) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function ticketPrice(from: Position, to: Position, kind: HubKind) {
  return Math.max(MIN_FARE, Math.round(kilometres(from, to) * TARIFF[kind]));
}

type Feature = { geometry: { type: string; coordinates: unknown }; properties?: Record<string, unknown> | null };

function pointOf(feature: Feature): Position | null {
  const g = feature.geometry;
  if (g.type === 'Point') return g.coordinates as Position;
  const ring = g.type === 'Polygon' ? (g.coordinates as Position[][])[0] : g.type === 'MultiPolygon' ? (g.coordinates as Position[][][])[0]?.[0] : null;
  if (!ring?.length) return null;
  return [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
}

/**
 * Airports from `aerodrome_label` (public ones: with an IATA code or a
 * public/international/regional class), ports from `poi` ferry terminals and harbours.
 */
export function hubsFromFeatures(aerodromes: Feature[], pois: Feature[]): Hub[] {
  const out: Hub[] = [];
  const add = (kind: HubKind, position: Position | null) => {
    if (!position) return;
    if (out.some((h) => h.kind === kind && kilometres(h.position, position) < (kind === 'airport' ? 1.5 : 0.3))) return;
    out.push({ id: `${kind}:${position[0].toFixed(4)},${position[1].toFixed(4)}`, kind, position });
  };
  for (const f of aerodromes) {
    const p = f.properties ?? {};
    const cls = String(p.class ?? '');
    if (p.iata || /international|public|regional/.test(cls)) add('airport', pointOf(f));
  }
  for (const f of pois) {
    const p = f.properties ?? {};
    const cls = String(p.class ?? ''), sub = String(p.subclass ?? '');
    if (sub === 'ferry_terminal' || cls === 'ferry_terminal' || cls === 'harbor' && /harbour|port/.test(sub)) add('port', pointOf(f));
  }
  return out;
}

export function nearestHub(position: Position, hubs: readonly Hub[]) {
  let best: Hub | null = null;
  let distance = Infinity;
  for (const hub of hubs) {
    const d = kilometres(position, hub.position) * 1000;
    if (d < distance) { distance = d; best = hub; }
  }
  return best ? { hub: best, distance } : null;
}

export function hubAt(position: Position, hubs: readonly Hub[]) {
  for (const hub of hubs) if (kilometres(position, hub.position) * 1000 <= HUB_REACH[hub.kind]) return hub;
  return null;
}
