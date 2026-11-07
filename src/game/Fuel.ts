import type { Position } from './VehicleController.ts';

// Fuel tank + pump prices. POI stations / civics live in `./poi`.

export const FUEL_PRICE = 1; // coins per litre
export const EVACUATION_COST = 100; // coins
/** what the tow truck leaves in the tank, as a share of capacity, so nobody gets stuck broke */
const REFUEL_RATE = 12; // litres per second at the pump
const IDLE_BURN = 0.004; // litres per second with the engine running

/** coins per point of health at a car service */
export const REPAIR_PRICE = 0.5;

export type FuelSpec = {
  /** tank capacity, litres */
  tank: number;
  /** game-scaled consumption, litres per kilometre */
  perKm: number;
};

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

// Backward-compatible re-exports (GameEngine / layers used to import POIs from here).
export {
  STATION_REACH,
  stationsFromFeatures,
  repairShopsFromFeatures,
  dealershipsFromFeatures,
  banksFromFeatures,
  policeFromFeatures,
  prisonsFromFeatures,
  courtsFromFeatures,
  hospitalsFromFeatures,
  nearestStation,
  atStation,
  type Station,
  type CivicKind,
  type PoiFeature,
} from './poi.ts';

export { metersBetween } from './meters.ts';
