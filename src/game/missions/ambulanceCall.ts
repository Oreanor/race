import { formatNumber, t } from '@/i18n';
import { metersBetween, type Position } from '../VehicleController.ts';
import {
  AMBULANCE_ARRIVE_M,
  AMBULANCE_HOSPITAL_M,
  AMBULANCE_VICTIM_COIN,
  AMBULANCE_VICTIM_MAX,
  AMBULANCE_VICTIM_MIN,
} from '../tuning.ts';
import type { RideOffer } from '../offers.ts';

export type AmbulanceSite = 'crash' | 'burn';

export type AmbulancePending = {
  victims: number;
  reward: number;
  site: AmbulanceSite;
};

export type AmbulanceCallState = {
  /** pin at the crash / burned house */
  pickup: [number, number] | null;
  site: AmbulanceSite | null;
  /** wreck cars planted at a crash (1–2); burned-house calls stay 1× victims */
  cars: number;
  /** modal waiting: victims loaded confirmation */
  pending: AmbulancePending | null;
  /** driving to hospital with victims aboard */
  active: boolean;
  goal: [number, number] | null;
  victims: number;
  offerAt: number;
};

export function createAmbulanceCallState(offerDelayMs = 22000): AmbulanceCallState {
  return {
    pickup: null,
    site: null,
    cars: 1,
    pending: null,
    active: false,
    goal: null,
    victims: 0,
    offerAt: performance.now() + offerDelayMs,
  };
}

export type AmbulanceCallWorld = {
  position: Position;
  heading: number;
  mode: 'roam' | 'arena' | 'race';
  busy: boolean;
  bountyFight: boolean;
  errand: boolean;
  onMission: boolean;
  avoid: [number, number][];
  pickBeaconSpot: (here: [number, number], heading: number, seed: number, avoid: [number, number][]) => [number, number];
  /** nearest hospital to `from`, or null */
  nearestHospital: (from: Position) => Position | null;
  /**
   * Plant the call scene. `burn` = house fire only. `crash` = 1–2 wrecks (roadside /
   * into a house / pile-up). Clear with null. May fall back burn→crash if no façade.
   */
  setScene: (kind: AmbulanceSite | null, at: Position | null) => { site: AmbulanceSite; cars: number } | null;
  syncMissionVisuals: (show?: boolean) => void;
  say: (text: string, toast?: boolean) => void;
  addMoney: (amount: number) => void;
  onOffer: (offer: RideOffer | null) => void;
  onResult: (cash: number, victims: number) => void;
};

function offerOf(pending: AmbulancePending): RideOffer {
  return {
    kind: 'ambulance',
    n: pending.victims,
    place: pending.site,
    km: 0,
    reward: pending.reward,
  };
}

/** One car → 1…3 injured; two cars → roughly double. */
function pickVictims(seed: number, cars: number) {
  const scale = Math.max(1, cars);
  const min = AMBULANCE_VICTIM_MIN * scale;
  const max = AMBULANCE_VICTIM_MAX * scale;
  const span = max - min + 1;
  return min + (((seed >>> 0) * 2654435761) >>> 0) % span;
}

/** Spawn / arrive at the call; while active, check hospital drop-off. */
export function updateAmbulanceCall(state: AmbulanceCallState, world: AmbulanceCallWorld) {
  const now = performance.now();
  const here = world.position;
  if (state.active && state.goal) {
    if (metersBetween(here, state.goal) <= AMBULANCE_HOSPITAL_M) completeAmbulanceCall(state, world);
    return;
  }
  if (state.pending) return;
  if (state.pickup) {
    if (world.mode === 'roam' && !world.bountyFight && !world.errand && !world.busy
      && metersBetween(here, state.pickup) <= AMBULANCE_ARRIVE_M) offerAmbulancePickup(state, world);
    return;
  }
  if (world.mode !== 'roam' || world.bountyFight || world.errand || world.onMission) return;
  if (world.busy || now < state.offerAt) return;
  // No hospital within 10 km → no victim calls (don't plant a crash / burned house).
  if (!world.nearestHospital(here)) {
    state.offerAt = now + 20000;
    return;
  }
  const seed = Math.round(here[0] * 1e5) ^ Math.round(here[1] * 1e5) ^ (now | 0);
  const site: AmbulanceSite = (seed & 1) === 0 ? 'crash' : 'burn';
  const spot = world.pickBeaconSpot(here as [number, number], world.heading, seed ^ 0xa11e, world.avoid);
  const scene = world.setScene(site, spot);
  state.pickup = spot;
  state.site = scene?.site ?? site;
  state.cars = Math.max(1, scene?.cars ?? 1);
  world.syncMissionVisuals(true);
  world.say(t('mission.new', { label: t(state.site === 'burn' ? 'ambulance.goal.burn' : 'ambulance.goal.crash') }), true);
}

/** At the scene: show how many injured you load. */
function offerAmbulancePickup(state: AmbulanceCallState, world: AmbulanceCallWorld) {
  if (!state.pickup || state.active || state.pending) return;
  const hospital = world.nearestHospital(state.pickup);
  if (!hospital) {
    clearCall(state, world, 8000);
    world.say(t('ambulance.unavailable'), true);
    return;
  }
  const seed = Math.round(state.pickup[0] * 1e5) ^ Math.round(state.pickup[1] * 1e5) ^ (performance.now() | 0);
  const victims = pickVictims(seed, state.site === 'crash' ? state.cars : 1);
  state.pending = {
    victims,
    reward: victims * AMBULANCE_VICTIM_COIN,
    site: state.site ?? 'crash',
  };
  world.onOffer(offerOf(state.pending));
}

export function acceptAmbulanceCall(state: AmbulanceCallState, world: AmbulanceCallWorld) {
  if (!state.pending || state.active) return;
  const pending = state.pending;
  const from = state.pickup ?? world.position;
  const hospital = world.nearestHospital(from);
  if (!hospital) {
    declineAmbulanceCall(state, world);
    world.say(t('ambulance.unavailable'), true);
    return;
  }
  state.active = true;
  state.goal = [...hospital] as [number, number];
  state.victims = pending.victims;
  state.pending = null;
  state.pickup = null;
  state.site = null;
  state.cars = 1;
  world.setScene(null, null);
  world.onOffer(null);
  world.syncMissionVisuals(true);
  world.say(t('ambulance.start', {
    n: formatNumber(pending.victims),
    coin: formatNumber(AMBULANCE_VICTIM_COIN),
    reward: formatNumber(pending.reward),
  }), true);
}

export function declineAmbulanceCall(state: AmbulanceCallState, world: AmbulanceCallWorld) {
  if (!state.pending) return;
  state.pending = null;
  clearCall(state, world, 14000);
  world.onOffer(null);
  world.say(t('ambulance.declined'), true);
}

function completeAmbulanceCall(state: AmbulanceCallState, world: AmbulanceCallWorld) {
  if (!state.active) return;
  const victims = Math.max(1, state.victims);
  const payout = victims * AMBULANCE_VICTIM_COIN;
  state.active = false;
  state.goal = null;
  state.victims = 0;
  world.addMoney(payout);
  state.offerAt = performance.now() + 40000;
  world.syncMissionVisuals(true);
  world.say(t('ambulance.done', { n: formatNumber(victims), reward: formatNumber(payout) }), true);
  world.onResult(payout, victims);
}

/** Leave a call when swapping off the ambulance. */
export function suspendAmbulanceCall(state: AmbulanceCallState, world: AmbulanceCallWorld) {
  if (state.pending) {
    state.pending = null;
    world.onOffer(null);
  }
  if (state.active) {
    state.active = false;
    state.goal = null;
    state.victims = 0;
    state.offerAt = performance.now() + 12000;
    world.say(t('ambulance.aborted'), true);
  }
  clearCall(state, world, state.offerAt - performance.now());
}

function clearCall(state: AmbulanceCallState, world: AmbulanceCallWorld, retryMs: number) {
  state.pickup = null;
  state.site = null;
  state.cars = 1;
  world.setScene(null, null);
  state.offerAt = performance.now() + Math.max(0, retryMs);
  world.syncMissionVisuals(true);
}
