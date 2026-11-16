import { cars as carsConfig, carPrice, type Car } from '@/config/vehicle.config';
import { t } from '@/i18n';
import type { VehicleController } from '../VehicleController.ts';
import type { DealerOffer } from '../offers.ts';
import { atStation, SERVICE_REACH, type Station } from '../poi.ts';

/** What the showroom needs from the game: where we are, the purse, the garage, getting in. */
export interface DealershipHost {
  /** the saved run (purse, garage) is in */
  readonly runReady: boolean;
  readonly driving: boolean;
  readonly paused: boolean;
  readonly mode: 'roam' | 'arena' | 'race';
  /** another counter's dialog (fuel, service, a ticket) or the empty-tank call is up */
  counterOpen(): boolean;
  readonly dealerships: Map<string, Station>;
  readonly vehicle: VehicleController;
  readonly keys: Set<string>;
  /** this lot has had its dialog this visit */
  offered(id: string): void;
  readonly car: Car;
  readonly garage: Set<string>;
  playerMoney: number;
  setCar(car: Car): void;
  onCarBought(car: Car): void;
  say(text: string, toast?: boolean): void;
}

/** The car dealership (buy a car, or get into one we own) and C: the next car of the garage. */
export class Dealership {
  /** the showroom's dialog is open */
  open = false;
  /** car dealership dialog (Tab when on the lot, or arriving slowly) */
  onOffer: (offer: DealerOffer | null) => void = () => {};

  constructor(private host: DealershipHost) {}

  /** Lot catalogue for the dealership dialog. */
  private state(): DealerOffer {
    return { money: Math.floor(this.host.playerMoney), currentId: this.host.car.id, owned: [...this.host.garage] };
  }

  /** Open the showroom when standing on a dealership lot (Tab, or slow arrival). */
  tryOpen() {
    if (!this.host.runReady) return false;
    if (!this.host.driving || this.host.mode !== 'roam' || this.open || this.host.counterOpen()) return false;
    const lot = atStation(this.host.vehicle.position, [...this.host.dealerships.values()], SERVICE_REACH.dealer);
    if (!lot) return false;
    this.host.offered(lot.id);
    this.open = true;
    this.host.keys.clear();
    this.host.vehicle.speed = 0;
    this.onOffer(this.state());
    return true;
  }

  leave() {
    this.open = false;
    this.onOffer(null);
  }

  /** Buy `carId` at its full price into the garage (nothing is sold back) and get in; one we own is free. */
  buy(carId: string) {
    if (!this.open) return;
    const next = carsConfig.find((c) => c.id === carId);
    if (!next || next.id === this.host.car.id) return;
    if (!this.host.garage.has(next.id)) {
      const price = carPrice(next);
      if (price > this.host.playerMoney) return;
      this.host.playerMoney -= price;
      this.host.garage.add(next.id);
    }
    this.host.setCar(next);
    this.host.onCarBought(next);
    this.onOffer(this.state());
  }

  /** C: get into the next car of the garage, right where we are (not during a race or a fight). */
  swapCar() {
    // a race or a fight is driven in the car it started in (the rivals were matched to it)
    if (this.host.driving && !this.host.paused && this.host.mode !== 'roam') { this.host.say(t('garage.locked'), true); return; }
    if (!this.host.driving || this.host.paused || this.host.mode !== 'roam' || this.host.garage.size < 2) {
      if (this.host.driving && this.host.garage.size < 2) this.host.say(t('garage.one'), true);
      return;
    }
    const owned = carsConfig.filter((car) => this.host.garage.has(car.id));
    const at = owned.findIndex((car) => car.id === this.host.car.id);
    const next = owned[(at + 1) % owned.length];
    if (!next || next.id === this.host.car.id) return;
    this.host.setCar(next);
    this.host.onCarBought(next);
    this.host.say(t('garage.swap', { car: next.name }), true);
  }
}
