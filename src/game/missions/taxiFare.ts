import { formatNumber, t } from '@/i18n';
import { metersBetween, type Position } from '../VehicleController.ts';
import {
  TAXI_ARRIVE_M,
  TAXI_MAX_M,
  TAXI_MIN_M,
  TAXI_PER_KM,
  TAXI_REACH_M,
  taxiFareReward,
} from '../tuning.ts';
import type { RideOffer } from '../offers.ts';

export type TaxiFarePending = {
  goal: [number, number];
  meters: number;
  reward: number;
};

export type TaxiFareState = {
  /** pin where the passenger waits */
  pickup: [number, number] | null;
  /** prepared fare waiting on the NPC modal */
  pending: TaxiFarePending | null;
  /** fare under way: drop-off address */
  active: boolean;
  goal: [number, number] | null;
  /** great-circle metres pickup → goal (pay is based on this) */
  meters: number;
  offerAt: number;
};

export function createTaxiFareState(offerDelayMs = 18000): TaxiFareState {
  return {
    pickup: null,
    pending: null,
    active: false,
    goal: null,
    meters: 0,
    offerAt: performance.now() + offerDelayMs,
  };
}

export type TaxiFareWorld = {
  position: Position;
  heading: number;
  mode: 'roam' | 'arena' | 'race';
  busy: boolean;
  bountyFight: boolean;
  errand: boolean;
  onMission: boolean;
  avoid: [number, number][];
  pickBeaconSpot: (here: [number, number], heading: number, seed: number, avoid: [number, number][]) => [number, number];
  /** road spot between min..max metres from `from`, or null if the graph has nothing */
  pickDropoff: (from: Position, minM: number, maxM: number, seed: number) => Position | null;
  syncMissionVisuals: (show?: boolean) => void;
  say: (text: string, toast?: boolean) => void;
  addMoney: (amount: number) => void;
  onOffer: (offer: RideOffer | null) => void;
  onResult: (cash: number, km: number) => void;
};

function rideOf(pending: TaxiFarePending): RideOffer {
  return {
    kind: 'taxi',
    n: 1,
    place: '',
    km: Math.round(pending.meters / 100) / 10,
    reward: pending.reward,
  };
}

/** Spawn / arrive at the taxi pin; while active, check drop-off. */
export function updateTaxiFare(state: TaxiFareState, world: TaxiFareWorld) {
  const now = performance.now();
  const here = world.position;
  if (state.active && state.goal) {
    if (metersBetween(here, state.goal) <= TAXI_REACH_M) completeTaxiFare(state, world);
    return;
  }
  if (state.pending) return;
  if (state.pickup) {
    if (world.mode === 'roam' && !world.bountyFight && !world.errand && !world.busy
      && metersBetween(here, state.pickup) <= TAXI_ARRIVE_M) offerTaxiFare(state, world);
    return;
  }
  if (world.mode !== 'roam' || world.bountyFight || world.errand || world.onMission) return;
  if (world.busy || now < state.offerAt) return;
  const seed = Math.round(here[0] * 1e5) ^ Math.round(here[1] * 1e5) ^ (now | 0);
  state.pickup = world.pickBeaconSpot(here as [number, number], world.heading, seed ^ 0x7a21, world.avoid);
  world.syncMissionVisuals(true);
  world.say(t('mission.new', { label: t('taxi.goal') }), true);
}

/** Arrive at the passenger: show the NPC modal; accept starts the fare. */
function offerTaxiFare(state: TaxiFareState, world: TaxiFareWorld) {
  if (!state.pickup || state.active || state.pending) return;
  const from = state.pickup;
  const seed = Math.round(from[0] * 1e5) ^ Math.round(from[1] * 1e5) ^ (performance.now() | 0);
  const drop = world.pickDropoff(from, TAXI_MIN_M, TAXI_MAX_M, seed);
  if (!drop) {
    state.pickup = null;
    state.offerAt = performance.now() + 6000;
    world.syncMissionVisuals(true);
    world.say(t('taxi.unavailable'), true);
    return;
  }
  const meters = metersBetween(from, drop);
  if (meters < TAXI_MIN_M * 0.55) {
    state.pickup = null;
    state.offerAt = performance.now() + 6000;
    world.syncMissionVisuals(true);
    world.say(t('taxi.unavailable'), true);
    return;
  }
  state.pending = {
    goal: [...drop] as [number, number],
    meters,
    reward: taxiFareReward(meters),
  };
  world.onOffer(rideOf(state.pending));
}

export function acceptTaxiFare(state: TaxiFareState, world: TaxiFareWorld) {
  if (!state.pending || state.active) return;
  const pending = state.pending;
  state.active = true;
  state.goal = pending.goal;
  state.meters = pending.meters;
  state.pending = null;
  state.pickup = null;
  world.onOffer(null);
  world.syncMissionVisuals(true);
  world.say(t('taxi.start', {
    km: formatNumber(Math.round(pending.meters / 100) / 10),
    rate: formatNumber(TAXI_PER_KM),
    reward: formatNumber(pending.reward),
  }), true);
}

export function declineTaxiFare(state: TaxiFareState, world: TaxiFareWorld) {
  if (!state.pending) return;
  state.pending = null;
  state.pickup = null;
  state.offerAt = performance.now() + 12000;
  world.onOffer(null);
  world.syncMissionVisuals(true);
  world.say(t('taxi.declined'), true);
}

function completeTaxiFare(state: TaxiFareState, world: TaxiFareWorld) {
  if (!state.active || !state.goal) return;
  const meters = state.meters || metersBetween(world.position, state.goal);
  const payout = taxiFareReward(meters);
  const km = Math.round(meters / 100) / 10;
  state.active = false;
  state.goal = null;
  state.meters = 0;
  world.addMoney(payout);
  state.offerAt = performance.now() + 25000;
  world.syncMissionVisuals(true);
  world.say(t('taxi.done', { reward: formatNumber(payout) }), true);
  world.onResult(payout, km);
}

/** Leave a fare when swapping off the taxi (progress is lost). */
export function suspendTaxiFare(state: TaxiFareState, world: TaxiFareWorld) {
  if (state.pending) {
    state.pending = null;
    world.onOffer(null);
  }
  if (state.active) {
    state.active = false;
    state.goal = null;
    state.meters = 0;
    state.offerAt = performance.now() + 12000;
    world.say(t('taxi.aborted'), true);
  }
  state.pickup = null;
  world.syncMissionVisuals(true);
}
