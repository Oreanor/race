import { formatNumber, t } from '@/i18n';
import { metersBetween, type Position } from '../VehicleController.ts';
import {
  BUS_FARE_MAX,
  BUS_FARE_MIN,
  BUS_FARE_STEP,
  BUS_STOP_REACH_M,
  busFareCoins,
} from '../tuning.ts';
import type { Station } from '../poi.ts';

export type BusStopAction = 'board' | 'alight';

export type BusStopState = {
  /** stop id currently inside reach (re-arms after leaving) */
  at: string | null;
};

export function createBusStopState(): BusStopState {
  return { at: null };
}

export type BusStopWorld = {
  position: Position;
  mode: 'roam' | 'arena' | 'race';
  busy: boolean;
  stops: readonly Station[];
  say: (text: string, toast?: boolean) => void;
  addMoney: (amount: number) => void;
  onResult: (cash: number, action: BusStopAction, passengers: number) => void;
};

/** Approaching an OSM bus stop: board or alight + coins (10…100 step 10). */
export function updateBusStops(state: BusStopState, world: BusStopWorld) {
  if (world.mode !== 'roam' || world.busy || !world.stops.length) {
    state.at = null;
    return;
  }
  const here = world.position;
  let near: Station | null = null;
  let best = BUS_STOP_REACH_M;
  for (const stop of world.stops) {
    const d = metersBetween(here, stop.place ?? stop.position);
    if (d <= best) {
      best = d;
      near = stop;
    }
  }
  if (!near) {
    state.at = null;
    return;
  }
  if (state.at === near.id) return;
  state.at = near.id;
  const steps = Math.round((BUS_FARE_MAX - BUS_FARE_MIN) / BUS_FARE_STEP);
  const passengers = 1 + Math.floor(Math.random() * (steps + 1)); // 1…10
  const coins = busFareCoins(passengers - 1); // 10…100
  const action: BusStopAction = Math.random() < 0.5 ? 'board' : 'alight';
  world.addMoney(coins);
  world.say(t(`bus.${action}`, { n: formatNumber(passengers), cash: formatNumber(coins) }), true);
  world.onResult(coins, action, passengers);
}
