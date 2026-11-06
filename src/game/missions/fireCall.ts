import { facadeMarker, pickBurningCount, pickBurningPanes, type FirePaneSpec } from '@/rendering/BurningHouse';
import { formatNumber, t } from '@/i18n';
import type { Position } from '../VehicleController';
import { FIRE_WINDOW_COIN } from '../tuning';

export type FireCallState = {
  pickup: [number, number] | null;
  active: boolean;
  spot: [number, number] | null;
  windowTotal: number;
  offerAt: number;
};

export function createFireCallState(offerDelayMs = 20000): FireCallState {
  return {
    pickup: null,
    active: false,
    spot: null,
    windowTotal: 0,
    offerAt: performance.now() + offerDelayMs,
  };
}

export type FireCallWorld = {
  position: Position;
  heading: number;
  mode: 'roam' | 'arena' | 'race';
  busy: boolean;
  bountyFight: boolean;
  errand: boolean;
  onMission: boolean;
  avoid: [number, number][];
  fireFacadesNear: (at: [number, number], radius: number) => { panes: { at: Position; altitude: number; oe: number; on: number }[] } | null;
  pickBeaconSpot: (here: [number, number], heading: number, seed: number, avoid: [number, number][]) => [number, number];
  setFireHouse: (site: { panes: FirePaneSpec[] } | null) => void;
  syncMissionVisuals: (show?: boolean) => void;
  say: (text: string, toast?: boolean) => void;
  addMoney: (amount: number) => void;
  onResult: (cash: number, windows: number) => void;
};

/** Spawn a burning house while in the fire truck (call every frame). Fire is lit as soon as the call appears. */
export function updateFireCall(state: FireCallState, world: FireCallWorld) {
  const now = performance.now();
  if (state.active || state.pickup) return;
  if (world.mode !== 'roam' || world.bountyFight || world.errand || world.onMission) return;
  if (world.busy || now < state.offerAt) return;
  const here = world.position;
  const seed = Math.round(here[0] * 1e5) ^ Math.round(here[1] * 1e5) ^ (now | 0);
  for (let attempt = 0; attempt < 8; attempt++) {
    const spot = world.pickBeaconSpot(here as [number, number], world.heading, seed ^ 0x51f3 ^ (attempt * 17), world.avoid);
    const facades = world.fireFacadesNear(spot, 70);
    if (!facades?.panes.length) continue;
    const specs: FirePaneSpec[] = facades.panes.map((p) => ({
      at: p.at as [number, number],
      altitude: p.altitude,
      oe: p.oe,
      on: p.on,
    }));
    const n = pickBurningCount(specs.length, seed ^ (attempt * 9137));
    const burning = pickBurningPanes(specs, n, seed ^ 0x9e3779b9 ^ (attempt * 17));
    if (!burning.length) continue;
    state.active = true;
    state.pickup = null;
    state.spot = facadeMarker(burning, spot) as [number, number];
    state.windowTotal = burning.length;
    world.setFireHouse({ panes: burning });
    world.syncMissionVisuals(true);
    world.say(t('fire.start', { n: state.windowTotal, coin: formatNumber(FIRE_WINDOW_COIN) }), true);
    return;
  }
  state.offerAt = now + 8000;
}

/** Kept for callers that still poke the call; fire now starts when the pin is offered. */
export function startFireCall(state: FireCallState, world: FireCallWorld) {
  if (state.active) return;
  if (state.pickup) {
    // legacy path: pin without flames — ignite now
    const site = state.pickup;
    const facades = world.fireFacadesNear(site, 80);
    if (!facades?.panes.length) {
      state.pickup = null;
      state.offerAt = performance.now() + 6000;
      world.syncMissionVisuals(true);
      return;
    }
    const specs: FirePaneSpec[] = facades.panes.map((p) => ({
      at: p.at as [number, number],
      altitude: p.altitude,
      oe: p.oe,
      on: p.on,
    }));
    const seed = Math.round(site[0] * 1e5) ^ Math.round(site[1] * 1e5) ^ (performance.now() | 0);
    const n = pickBurningCount(specs.length, seed);
    const burning = pickBurningPanes(specs, n, seed ^ 0x9e3779b9);
    state.active = true;
    state.spot = facadeMarker(burning, site) as [number, number];
    state.pickup = null;
    state.windowTotal = burning.length;
    world.setFireHouse({ panes: burning });
    world.syncMissionVisuals(true);
    world.say(t('fire.start', { n: state.windowTotal, coin: formatNumber(FIRE_WINDOW_COIN) }), true);
  }
}

export function onFireWindowOut(state: FireCallState, world: FireCallWorld, left: number) {
  if (!state.active) return;
  if (left === 0) {
    completeFireCall(state, world, state.windowTotal);
    return;
  }
  const done = state.windowTotal - left;
  if (done === 1 || done % 10 === 0) {
    world.say(t('fire.window', { done: formatNumber(done), left: formatNumber(left) }), true);
  }
}

export function completeFireCall(state: FireCallState, world: FireCallWorld, windows: number) {
  if (!state.active) return;
  const payout = windows * FIRE_WINDOW_COIN;
  state.active = false;
  state.spot = null;
  state.windowTotal = 0;
  world.setFireHouse(null);
  world.addMoney(payout);
  state.offerAt = performance.now() + 45000;
  world.syncMissionVisuals(true);
  world.onResult(payout, windows);
}

/** Leave a fire call when swapping off the truck (progress is lost). */
export function suspendFireCall(state: FireCallState, world: FireCallWorld) {
  if (state.active) {
    state.active = false;
    state.spot = null;
    state.windowTotal = 0;
    world.setFireHouse(null);
    state.offerAt = performance.now() + 12000;
    world.say(t('fire.aborted'), true);
  }
  state.pickup = null;
  world.syncMissionVisuals(true);
}
