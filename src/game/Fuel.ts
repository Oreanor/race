import type { Position } from './VehicleController.ts';

// Fuel: every car has its own tank and consumption, stations come from real
// OpenStreetMap POIs (OpenMapTiles `poi` layer, class "fuel").

export const FUEL_PRICE = 1; // coins per litre
export const EVACUATION_COST = 100; // coins
/** what the tow truck leaves in the tank, as a share of capacity, so nobody gets stuck broke */
export const EVACUATION_RESERVE = 0.1;
const REFUEL_RATE = 12; // litres per second at the pump
const STATION_REACH = 30; // meters from the station point (it may sit on the shop roof)
const IDLE_BURN = 0.004; // litres per second with the engine running

export type FuelSpec = {
  /** tank capacity, litres */
  tank: number;
  /** game-scaled consumption, litres per kilometre */
  perKm: number;
};

/** Abstract fuel station: real location, no brand or name on purpose. */
export type Station = { id: string; position: Position };

const METERS = 111319.49;

export function metersBetween(a: Position, b: Position) {
  const cos = Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  return Math.hypot((b[0] - a[0]) * METERS * cos, (b[1] - a[1]) * METERS);
}

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
