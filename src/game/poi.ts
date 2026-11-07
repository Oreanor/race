import { metersBetween } from './meters.ts';
import type { Position } from './VehicleController.ts';

/**
 * OpenMapTiles `poi` layer → drive-to spots.
 * `position` is where to drive (often road-snapped later); `place` / `top` / `radius`
 * are the building (footprint radius in metres from middle to farthest corner).
 */
export type Station = {
  id: string;
  position: Position;
  place?: Position;
  top?: number;
  /** building footprint radius (m); with SERVICE_MARGIN this is the dialog reach */
  radius?: number;
};

/**
 * Fallback when no building footprint is known yet (open lot / tiles still loading).
 * Prefer `station.radius + SERVICE_MARGIN` once the house is resolved.
 */
export const STATION_REACH = 22;
export const SERVICE_MARGIN = 2.5;
export const SERVICE_REACH = {
  fuel: 24,
  repair: 18,
  dealer: 22,
  bank: 14,
  civic: 20,
} as const;

/** Drive pin, or the building middle when we have a footprint. */
export function servicePoint(station: Station, preferPlace = false): Position {
  if (preferPlace && station.place) return station.place;
  if (station.radius != null && station.place) return station.place;
  return station.position;
}

/** How close counts as “at” this station. */
export function serviceReach(station: Station, fallback = STATION_REACH) {
  return station.radius != null ? station.radius + SERVICE_MARGIN : fallback;
}

export type PoiFeature = {
  id?: string | number;
  geometry: { type: string; coordinates: unknown };
  properties?: Record<string, unknown> | null;
};

/** Real fuel stations from POI features (points or polygons), deduplicated across tiles. */
export function stationsFromFeatures(features: PoiFeature[]): Station[] {
  const out: Station[] = [];
  for (const feature of features) {
    const props = feature.properties ?? {};
    // class "fuel" also holds EV chargers (subclass charging_station): petrol only for now
    if (props.class !== 'fuel' || props.subclass === 'charging_station') continue;
    let position: Position | null = null;
    const g = feature.geometry;
    if (g.type === 'Point') position = g.coordinates as Position;
    else if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
      const ring = (g.type === 'Polygon' ? (g.coordinates as Position[][])[0] : (g.coordinates as Position[][][])[0]?.[0]) ?? [];
      if (ring.length) position = [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
    }
    if (!position) continue;
    // tiles repeat POIs near their edges: one station per ~25 m
    if (out.some((s) => metersBetween(s.position, position!) < 25)) continue;
    out.push({ id: `${position[0].toFixed(5)},${position[1].toFixed(5)}`, position });
  }
  return out;
}

/** Car repair shops (OpenMapTiles poi: class car, subclass car_repair). */
export function repairShopsFromFeatures(features: PoiFeature[]): Station[] {
  const shops = features.filter((f) => {
    const p = f.properties ?? {};
    return p.subclass === 'car_repair' || (p.class === 'car' && /repair|tyres?/.test(String(p.subclass ?? '')));
  }).map((f) => ({ ...f, properties: { ...(f.properties ?? {}), class: 'fuel', subclass: 'repair' } }));
  return stationsFromFeatures(shops).map((s) => ({ ...s, id: `repair:${s.id}` }));
}

/** Car dealerships (OpenMapTiles poi: class car, subclass car — not repair). */
export function dealershipsFromFeatures(features: PoiFeature[]): Station[] {
  const shops = features.filter((f) => {
    const p = f.properties ?? {};
    if (p.class !== 'car') return false;
    const sub = String(p.subclass ?? 'car');
    return sub === 'car' || sub === 'car_dealer' || sub === 'vehicle';
  }).map((f) => ({ ...f, properties: { ...(f.properties ?? {}), class: 'fuel', subclass: 'dealer' } }));
  return stationsFromFeatures(shops).map((s) => ({ ...s, id: `dealer:${s.id}` }));
}

/** Banks (OpenMapTiles poi: class / subclass bank; cash machines left out). */
export function banksFromFeatures(features: PoiFeature[]): Station[] {
  const banks = features.filter((f) => {
    const p = f.properties ?? {};
    return (p.class === 'bank' || p.subclass === 'bank') && p.subclass !== 'atm';
  }).map((f) => ({ ...f, properties: { ...(f.properties ?? {}), class: 'fuel', subclass: 'bank' } }));
  return stationsFromFeatures(banks).map((s) => ({ ...s, id: `bank:${s.id}` }));
}

/** Police / prison / court / hospital — where an arrest drops you. */
export type CivicKind = 'police' | 'prison' | 'court' | 'hospital';

function civicFromFeatures(
  features: PoiFeature[],
  kind: CivicKind,
  match: (props: Record<string, unknown>) => boolean,
): Station[] {
  const matched = features
    .filter((f) => match(f.properties ?? {}))
    .map((f) => ({ ...f, properties: { ...(f.properties ?? {}), class: 'fuel', subclass: kind } }));
  return stationsFromFeatures(matched).map((s) => ({ ...s, id: `${kind}:${s.id}` }));
}

export function policeFromFeatures(features: PoiFeature[]): Station[] {
  return civicFromFeatures(features, 'police', (p) => p.class === 'police' || p.subclass === 'police');
}

export function prisonsFromFeatures(features: PoiFeature[]): Station[] {
  return civicFromFeatures(features, 'prison', (p) => p.class === 'prison' || p.subclass === 'prison');
}

export function courtsFromFeatures(features: PoiFeature[]): Station[] {
  return civicFromFeatures(features, 'court', (p) =>
    p.subclass === 'courthouse' || p.class === 'courthouse' || (p.class === 'town_hall' && p.subclass === 'courthouse'));
}

/** Hospitals (clinics count too — denser coverage for a nearby drop-off). */
export function hospitalsFromFeatures(features: PoiFeature[]): Station[] {
  return civicFromFeatures(features, 'hospital', (p) =>
    p.class === 'hospital' || p.subclass === 'hospital' || p.subclass === 'clinic');
}

/** Bus stops (OpenMapTiles poi: class bus, subclass bus_stop). */
export function busStopsFromFeatures(features: PoiFeature[]): Station[] {
  const stops = features
    .filter((f) => {
      const p = f.properties ?? {};
      return p.class === 'bus' && p.subclass === 'bus_stop';
    })
    .map((f) => ({ ...f, properties: { ...(f.properties ?? {}), class: 'fuel', subclass: 'bus_stop' } }));
  return stationsFromFeatures(stops).map((s) => ({ ...s, id: `bus:${s.id}` }));
}

/** Hotel or museum with a real OSM name — bus tour drop-offs. */
export type LandmarkKind = 'hotel' | 'museum';
export type Landmark = Station & { kind: LandmarkKind; name: string };

function poiPosition(feature: PoiFeature): Position | null {
  const g = feature.geometry;
  if (g.type === 'Point') return g.coordinates as Position;
  if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
    const ring = (g.type === 'Polygon' ? (g.coordinates as Position[][])[0] : (g.coordinates as Position[][][])[0]?.[0]) ?? [];
    if (!ring.length) return null;
    return [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
  }
  return null;
}

function poiName(props: Record<string, unknown>): string {
  const raw = props.name ?? props['name:en'] ?? props['name:ru'] ?? props['name:pt'];
  const name = String(raw ?? '').trim();
  return name;
}

/** Named hotels / museums from the POI layer (OpenMapTiles lodging + museum). */
export function landmarksFromFeatures(features: PoiFeature[]): Landmark[] {
  const out: Landmark[] = [];
  for (const feature of features) {
    const props = feature.properties ?? {};
    const cls = String(props.class ?? '');
    const sub = String(props.subclass ?? '');
    let kind: LandmarkKind | null = null;
    if (cls === 'lodging' || cls === 'hotel' || sub === 'hotel' || sub === 'motel' || sub === 'hostel') kind = 'hotel';
    else if (cls === 'museum' || sub === 'museum') kind = 'museum';
    if (!kind) continue;
    const name = poiName(props);
    if (!name) continue; // only places known by name in the data
    const position = poiPosition(feature);
    if (!position) continue;
    if (out.some((s) => s.kind === kind && metersBetween(s.position, position!) < 40)) continue;
    out.push({
      id: `${kind}:${position[0].toFixed(5)},${position[1].toFixed(5)}`,
      position,
      kind,
      name,
    });
  }
  return out;
}

export function nearestStation(position: Position, stations: readonly Station[], preferPlace = false) {
  let best: Station | null = null;
  let distance = Infinity;
  for (const station of stations) {
    const d = metersBetween(position, servicePoint(station, preferPlace));
    if (d < distance) { distance = d; best = station; }
  }
  return best ? { station: best, distance } : null;
}

export function atStation(
  position: Position,
  stations: readonly Station[],
  fallbackReach = STATION_REACH,
  preferPlace = false,
) {
  let best: Station | null = null;
  let bestDistance = Infinity;
  for (const station of stations) {
    const at = servicePoint(station, preferPlace || station.radius != null);
    const d = metersBetween(position, at);
    const reach = serviceReach(station, fallbackReach);
    if (d <= reach && d < bestDistance) {
      best = station;
      bestDistance = d;
    }
  }
  return best;
}
