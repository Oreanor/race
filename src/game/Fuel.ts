import { type Position, metersBetween } from './VehicleController.ts';

// Fuel: every car has its own tank and consumption, stations come from real
// OpenStreetMap POIs (OpenMapTiles `poi` layer, class "fuel").

export const FUEL_PRICE = 1; // coins per litre
export const EVACUATION_COST = 100; // coins
/** what the tow truck leaves in the tank, as a share of capacity, so nobody gets stuck broke */
const REFUEL_RATE = 12; // litres per second at the pump
/** meters from the (road-snapped) pumps — OSM points often sit inside the shop */
export const STATION_REACH = 55;
const IDLE_BURN = 0.004; // litres per second with the engine running

export type FuelSpec = {
  /** tank capacity, litres */
  tank: number;
  /** game-scaled consumption, litres per kilometre */
  perKm: number;
};

/** Abstract fuel station: real location, no brand or name on purpose. */
/**
 * A station, service or showroom: `position` is where to drive to (on the road in
 * front of it), `place` the house it is in and `top` that house's top, where its
 * label stands.
 */
export type Station = { id: string; position: Position; place?: Position; top?: number };


export { metersBetween };

export class FuelTank {
  level: number;
  spec: FuelSpec;
  constructor(spec: FuelSpec, fill = 1) {
    this.spec = spec;
    this.level = spec.tank * Math.max(0, Math.min(1, fill));
  }

  get empty() { return this.level <= 1e-6; }
  get ratio() { return this.spec.tank > 0 ? this.level / this.spec.tank : 0; }

  /** Burn fuel for `meters` driven in `seconds`; boost (Space) costs more. */
  burn(meters: number, seconds: number, boost: boolean) {
    const used = Math.abs(meters) / 1000 * this.spec.perKm * (boost ? 1.8 : 1) + IDLE_BURN * seconds;
    this.level = Math.max(0, this.level - used);
  }

  /** Swap cars: keep the same share of the tank. */
  changeSpec(spec: FuelSpec) {
    const ratio = this.ratio;
    this.spec = spec;
    this.level = spec.tank * ratio;
  }

  /**
   * Pump for `seconds`, paying FUEL_PRICE per litre from `money`.
   * Returns litres added and coins spent.
   */
  refuel(seconds: number, money: number) {
    const room = this.spec.tank - this.level;
    const affordable = Math.max(0, money) / FUEL_PRICE;
    const litres = Math.max(0, Math.min(room, REFUEL_RATE * seconds, affordable));
    this.level += litres;
    return { litres, cost: litres * FUEL_PRICE };
  }
}

/** Real fuel stations from POI features (points or polygons), deduplicated across tiles. */
export function stationsFromFeatures(features: { id?: string | number; geometry: { type: string; coordinates: unknown }; properties?: Record<string, unknown> | null }[]): Station[] {
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

/** coins per point of health at a car service */
export const REPAIR_PRICE = 0.5;

/** Car repair shops from POI features (OpenMapTiles poi: class car, subclass car_repair). */
export function repairShopsFromFeatures(features: Parameters<typeof stationsFromFeatures>[0]): Station[] {
  const shops = features.filter((f) => {
    const p = f.properties ?? {};
    return p.subclass === 'car_repair' || (p.class === 'car' && /repair|tyres?/.test(String(p.subclass ?? '')));
  }).map((f) => ({ ...f, properties: { ...(f.properties ?? {}), class: 'fuel', subclass: 'repair' } }));
  return stationsFromFeatures(shops).map((s) => ({ ...s, id: `repair:${s.id}` }));
}

/** Car dealerships (OpenMapTiles poi: class car, subclass car — not repair). */
export function dealershipsFromFeatures(features: Parameters<typeof stationsFromFeatures>[0]): Station[] {
  const shops = features.filter((f) => {
    const p = f.properties ?? {};
    if (p.class !== 'car') return false;
    const sub = String(p.subclass ?? 'car');
    return sub === 'car' || sub === 'car_dealer' || sub === 'vehicle';
  }).map((f) => ({ ...f, properties: { ...(f.properties ?? {}), class: 'fuel', subclass: 'dealer' } }));
  return stationsFromFeatures(shops).map((s) => ({ ...s, id: `dealer:${s.id}` }));
}

/** Banks (OpenMapTiles poi: class / subclass bank; cash machines left out). */
export function banksFromFeatures(features: Parameters<typeof stationsFromFeatures>[0]): Station[] {
  const banks = features.filter((f) => {
    const p = f.properties ?? {};
    return (p.class === 'bank' || p.subclass === 'bank') && p.subclass !== 'atm';
  }).map((f) => ({ ...f, properties: { ...(f.properties ?? {}), class: 'fuel', subclass: 'bank' } }));
  return stationsFromFeatures(banks).map((s) => ({ ...s, id: `bank:${s.id}` }));
}

/** Police / prison / court / hospital — where an arrest drops you. */
export type CivicKind = 'police' | 'prison' | 'court' | 'hospital';

function civicFromFeatures(
  features: Parameters<typeof stationsFromFeatures>[0],
  kind: CivicKind,
  match: (props: Record<string, unknown>) => boolean,
): Station[] {
  const matched = features
    .filter((f) => match(f.properties ?? {}))
    .map((f) => ({ ...f, properties: { ...(f.properties ?? {}), class: 'fuel', subclass: kind } }));
  return stationsFromFeatures(matched).map((s) => ({ ...s, id: `${kind}:${s.id}` }));
}

export function policeFromFeatures(features: Parameters<typeof stationsFromFeatures>[0]): Station[] {
  return civicFromFeatures(features, 'police', (p) => p.class === 'police' || p.subclass === 'police');
}

export function prisonsFromFeatures(features: Parameters<typeof stationsFromFeatures>[0]): Station[] {
  return civicFromFeatures(features, 'prison', (p) => p.class === 'prison' || p.subclass === 'prison');
}

export function courtsFromFeatures(features: Parameters<typeof stationsFromFeatures>[0]): Station[] {
  return civicFromFeatures(features, 'court', (p) =>
    p.subclass === 'courthouse' || p.class === 'courthouse' || (p.class === 'town_hall' && p.subclass === 'courthouse'));
}

/** Hospitals (clinics count too — denser coverage for a nearby drop-off). */
export function hospitalsFromFeatures(features: Parameters<typeof stationsFromFeatures>[0]): Station[] {
  return civicFromFeatures(features, 'hospital', (p) =>
    p.class === 'hospital' || p.subclass === 'hospital' || p.subclass === 'clinic');
}

export function nearestStation(position: Position, stations: readonly Station[]) {
  let best: Station | null = null;
  let distance = Infinity;
  for (const station of stations) {
    const d = metersBetween(position, station.position);
    if (d < distance) { distance = d; best = station; }
  }
  return best ? { station: best, distance } : null;
}

export function atStation(position: Position, stations: readonly Station[]) {
  const near = nearestStation(position, stations);
  return near && near.distance <= STATION_REACH ? near.station : null;
}
