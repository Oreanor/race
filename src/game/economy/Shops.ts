import type { VehicleController } from '../VehicleController.ts';
import type { FuelTank } from '../Fuel.ts';
import { FUEL_PRICE, REPAIR_PRICE } from '../Fuel.ts';
import type { BankOffer, ServiceOffer } from '../offers.ts';
import { LOAN_LIMIT, LOAN_RATE } from '../tuning.ts';

/** What the counters need from the game: the car, its tank and health, the purse. */
export interface ShopsHost {
  readonly vehicle: VehicleController;
  /** held keys: cleared when a dialog opens, so the car does not drive off behind it */
  readonly keys: Set<string>;
  readonly fuel: FuelTank;
  playerHp: number;
  readonly playerMaxHp: number;
  playerMoney: number;
}

/**
 * The fuel station, the car service and the bank: what each dialog offers, buying
 * fuel and repairs, and the one loan at a time (owed with its interest, no term).
 */
export class Shops {
  /** the fuel station's or the service's dialog, when open */
  serviceOpen: ServiceOffer['kind'] | null = null;
  /** the bank's dialog is open */
  bankOpen = false;
  /** owed to the bank */
  loanDebt = 0;
  /** fuel station or car service dialogs (shown on arrival, re-armed after leaving) */
  onServiceOffer: (offer: ServiceOffer | null) => void = () => {};
  onBankOffer: (offer: BankOffer | null) => void = () => {};

  constructor(private host: ShopsHost) {}

  private serviceState(kind: ServiceOffer['kind']): ServiceOffer {
    return kind === 'fuel'
      ? { kind, level: this.host.fuel.level, tank: this.host.fuel.spec.tank, money: Math.floor(this.host.playerMoney), price: FUEL_PRICE }
      : { kind, hp: this.host.playerHp, maxHp: this.host.playerMaxHp, money: Math.floor(this.host.playerMoney), price: REPAIR_PRICE };
  }

  openService(kind: ServiceOffer['kind']) {
    this.serviceOpen = kind;
    this.host.keys.clear();
    this.host.vehicle.speed = 0;
    this.onServiceOffer(this.serviceState(kind));
  }

  /** Buy `want` litres at the station (default: fill up), never past the tank or the purse. */
  buyFuel(want = Infinity) {
    if (this.serviceOpen !== 'fuel') return;
    const room = this.host.fuel.spec.tank - this.host.fuel.level;
    const litres = Math.max(0, Math.min(room, want, Math.floor(this.host.playerMoney / FUEL_PRICE)));
    this.host.fuel.level += litres;
    this.host.playerMoney -= litres * FUEL_PRICE;
    this.onServiceOffer(this.serviceState('fuel'));
  }

  /** Repair the car (as far as the coins allow) at the service. */
  repairCar() {
    if (this.serviceOpen !== 'repair') return;
    const missing = this.host.playerMaxHp - this.host.playerHp;
    const points = Math.max(0, Math.min(missing, Math.floor(this.host.playerMoney / REPAIR_PRICE)));
    this.host.playerHp += points;
    this.host.playerMoney -= Math.ceil(points * REPAIR_PRICE);
    this.onServiceOffer(this.serviceState('repair'));
  }

  leaveService() {
    this.serviceOpen = null;
    this.onServiceOffer(null);
  }

  private bankState(): BankOffer {
    return { money: Math.floor(this.host.playerMoney), debt: this.loanDebt, limit: LOAN_LIMIT, rate: LOAN_RATE };
  }

  openBank() {
    this.bankOpen = true;
    this.host.keys.clear();
    this.host.vehicle.speed = 0;
    this.onBankOffer(this.bankState());
  }

  /** Borrow up to LOAN_LIMIT; owe it plus LOAN_RATE. Only when nothing is owed yet. */
  borrow(amount: number) {
    if (!this.bankOpen || this.loanDebt > 0) return;
    const sum = Math.max(0, Math.min(LOAN_LIMIT, Math.round(amount)));
    if (!sum) return;
    this.host.playerMoney += sum;
    this.loanDebt = Math.round(sum * (1 + LOAN_RATE));
    this.onBankOffer(this.bankState());
  }

  /** Pay the loan back — all of it, or what the wallet holds. */
  repayLoan() {
    if (!this.bankOpen || this.loanDebt <= 0) return;
    const pay = Math.min(Math.floor(this.host.playerMoney), this.loanDebt);
    this.host.playerMoney -= pay;
    this.loanDebt -= pay;
    this.onBankOffer(this.bankState());
  }

  leaveBank() {
    this.bankOpen = false;
    this.onBankOffer(null);
  }
}
