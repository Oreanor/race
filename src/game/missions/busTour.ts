import { formatNumber, t } from '@/i18n';
import { metersBetween, type Position } from '../VehicleController.ts';
import {
  BUS_GROUP_MAX,
  BUS_GROUP_MIN,
  BUS_PER_PERSON_KM,
  BUS_TOUR_ARRIVE_M,
  BUS_TOUR_MAX_M,
  BUS_TOUR_MIN_M,
  BUS_TOUR_REACH_M,
  busTourReward,
} from '../tuning.ts';
import type { RideOffer } from '../offers.ts';
import type { Landmark, LandmarkKind } from '../poi.ts';

export type BusTourPending = {
  goal: [number, number];
  kind: LandmarkKind;
  place: string;
  passengers: number;
  meters: number;
  reward: number;
};

export type BusTourState = {
  /** pin where the group waits */
  pickup: [number, number] | null;
  /** prepared fare waiting on the NPC modal */
  pending: BusTourPending | null;
  active: boolean;
  goal: [number, number] | null;
  kind: LandmarkKind | null;
  place: string;
  passengers: number;
  /** road distance used for the fare (pickup → drop-off) */
  meters: number;
  offerAt: number;
};

export function createBusTourState(offerDelayMs = 16000): BusTourState {
  return {
    pickup: null,
    pending: null,
    active: false,
    goal: null,
    kind: null,
    place: '',
    passengers: 0,
    meters: 0,
    offerAt: performance.now() + offerDelayMs,
  };
}

export type BusTourWorld = {
  position: Position;
  heading: number;
  mode: 'roam' | 'arena' | 'race';
  busy: boolean;
  bountyFight: boolean;
  errand: boolean;
  onMission: boolean;
  avoid: [number, number][];
  landmarks: readonly Landmark[];
  pickBeaconSpot: (here: [number, number], heading: number, seed: number, avoid: [number, number][]) => [number, number];
  syncMissionVisuals: (show?: boolean) => void;
  say: (text: string, toast?: boolean) => void;
  addMoney: (amount: number) => void;
  onOffer: (offer: RideOffer | null) => void;
  onResult: (cash: number, passengers: number, kind: LandmarkKind, place: string) => void;
};

function pickLandmark(from: Position, list: readonly Landmark[], seed: number): Landmark | null {
  const candidates = list
    .map((spot) => ({ spot, d: metersBetween(from, spot.place ?? spot.position) }))
    .filter((item) => item.d >= BUS_TOUR_MIN_M && item.d <= BUS_TOUR_MAX_M)
    .sort((a, b) => a.d - b.d);
  if (!candidates.length) return null;
  const pick = candidates[Math.abs(seed) % Math.min(candidates.length, 8)];
  return pick.spot;
}

function rideOf(pending: BusTourPending): RideOffer {
  const km = Math.round(pending.meters / 100) / 10;
  return {
    kind: 'bus',
    n: pending.passengers,
    place: pending.place,
    km,
    reward: pending.reward,
  };
}

/** Spawn / board the group; while active, check hotel/museum drop-off. */
export function updateBusTour(state: BusTourState, world: BusTourWorld) {
  const now = performance.now();
  const here = world.position;
  if (state.active && state.goal) {
    if (metersBetween(here, state.goal) <= BUS_TOUR_REACH_M) completeBusTour(state, world);
    return;
  }
  if (state.pending) return;
  if (state.pickup) {
    if (world.mode === 'roam' && !world.bountyFight && !world.errand && !world.busy
      && metersBetween(here, state.pickup) <= BUS_TOUR_ARRIVE_M) offerBusTour(state, world);
    return;
  }
  if (world.mode !== 'roam' || world.bountyFight || world.errand || world.onMission) return;
  if (world.busy || now < state.offerAt) return;
  if (!world.landmarks.length) {
    state.offerAt = now + 12000;
    return;
  }
  const seed = Math.round(here[0] * 1e5) ^ Math.round(here[1] * 1e5) ^ (now | 0);
  state.pickup = world.pickBeaconSpot(here as [number, number], world.heading, seed ^ 0xb051, world.avoid);
  world.syncMissionVisuals(true);
  world.say(t('mission.new', { label: t('bus.tour') }), true);
}

/** Arrive at the group: show the NPC modal; accept starts the tour. */
function offerBusTour(state: BusTourState, world: BusTourWorld) {
  if (!state.pickup || state.active || state.pending) return;
  const from = state.pickup;
  const seed = Math.round(from[0] * 1e5) ^ Math.round(from[1] * 1e5) ^ (performance.now() | 0);
  const dest = pickLandmark(from, world.landmarks, seed ^ 0x51a7);
  if (!dest) {
    state.pickup = null;
    state.offerAt = performance.now() + 8000;
    world.syncMissionVisuals(true);
    world.say(t('bus.unavailable'), true);
    return;
  }
  const passengers = BUS_GROUP_MIN + Math.floor(Math.random() * (BUS_GROUP_MAX - BUS_GROUP_MIN + 1));
  const meters = metersBetween(from, dest.place ?? dest.position);
  const place = t(`poi.${dest.kind}`);
  state.pending = {
    goal: [...(dest.place ?? dest.position)] as [number, number],
    kind: dest.kind,
    place,
    passengers,
    meters,
    reward: busTourReward(passengers, meters),
  };
  world.onOffer(rideOf(state.pending));
}

export function acceptBusTour(state: BusTourState, world: BusTourWorld) {
  if (!state.pending || state.active) return;
  const pending = state.pending;
  state.active = true;
  state.goal = pending.goal;
  state.kind = pending.kind;
  state.place = pending.place;
  state.passengers = pending.passengers;
  state.meters = pending.meters;
  state.pending = null;
  state.pickup = null;
  world.onOffer(null);
  world.syncMissionVisuals(true);
  world.say(t('bus.start', {
    n: formatNumber(pending.passengers),
    kind: pending.place,
    km: formatNumber(Math.round(pending.meters / 100) / 10),
    rate: formatNumber(BUS_PER_PERSON_KM),
    reward: formatNumber(pending.reward),
  }), true);
}

export function declineBusTour(state: BusTourState, world: BusTourWorld) {
  if (!state.pending) return;
  state.pending = null;
  state.pickup = null;
  state.offerAt = performance.now() + 14000;
  world.onOffer(null);
  world.syncMissionVisuals(true);
  world.say(t('bus.declined'), true);
}

function completeBusTour(state: BusTourState, world: BusTourWorld) {
  if (!state.active || !state.goal || !state.kind) return;
  const passengers = state.passengers;
  const place = state.place || t(`poi.${state.kind}`);
  const kind = state.kind;
  const payout = busTourReward(passengers, state.meters);
  state.active = false;
  state.goal = null;
  state.kind = null;
  state.place = '';
  state.passengers = 0;
  state.meters = 0;
  world.addMoney(payout);
  state.offerAt = performance.now() + 28000;
  world.syncMissionVisuals(true);
  world.say(t('bus.done', { n: formatNumber(passengers), place, reward: formatNumber(payout) }), true);
  world.onResult(payout, passengers, kind, place);
}

/** Leave a tour when swapping off the bus (progress is lost). */
export function suspendBusTour(state: BusTourState, world: BusTourWorld) {
  if (state.pending) {
    state.pending = null;
    world.onOffer(null);
  }
  if (state.active) {
    state.active = false;
    state.goal = null;
    state.kind = null;
    state.place = '';
    state.passengers = 0;
    state.meters = 0;
    state.offerAt = performance.now() + 14000;
    world.say(t('bus.aborted'), true);
  }
  state.pickup = null;
  world.syncMissionVisuals(true);
}
