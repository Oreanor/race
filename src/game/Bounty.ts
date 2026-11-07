import type { Position } from './VehicleController.ts';
import { kilometres } from './Travel.ts';

// Local wanted hunts: the target is always within BOUNTY_RANGE_KM of the player.
// The offer pin is nearby; the fight spot is farther out on the roads (still ≤ 10 km).

export type WantedPlace = { name: string; country: string; coords: Position };
export type Bounty = {
  id: string;
  /** the wanted driver */
  name: string;
  /** car config id of the dangerous car */
  car: string;
  place: WantedPlace;
  reward: number;
  /** exact road spot for the fight */
  spot?: Position;
};

/** Max distance from the player to a wanted target (km). */
export const BOUNTY_RANGE_KM = 10;

const NAMES = [
  'Viktor "Wolf" Kral', 'Dante Moreau', 'Lena Varga', 'Rico Salvatierra', 'Mads Holt', 'Yuri Sokol',
  'Ivo Brancusi', 'Nadia Rask', 'Teo Castellano', 'Sasha Grimm', 'Kenji Arata', 'Lola Vex',
];

/** the dangerous car the wanted drive */
const WANTED_CAR = '03';

/** Reward for a local hunt — a bit more when the spot is farther out. */
function bountyReward(km: number) {
  return Math.round((900 + km * 40) / 50) * 50;
}

/**
 * A new bounty at `spot` (must be within BOUNTY_RANGE_KM of `from`).
 * `area` is the player's current city for the offer text.
 */
export function makeBounty(from: Position, spot: Position, area: WantedPlace, seed = Math.random()): Bounty {
  const name = NAMES[Math.floor(seed * 7919) % NAMES.length];
  const km = Math.min(BOUNTY_RANGE_KM, kilometres(from, spot));
  return {
    id: `bounty-${Math.round(seed * 1e9)}`,
    name,
    car: WANTED_CAR,
    place: { name: area.name, country: area.country, coords: [...spot] as Position },
    reward: bountyReward(km),
    spot: [...spot] as Position,
  };
}

/** Compass bearing from a to b, degrees clockwise from north (great circle). */
export function bearingTo(a: Position, b: Position) {
  const toRad = Math.PI / 180;
  const φ1 = a[1] * toRad, φ2 = b[1] * toRad, Δλ = (b[0] - a[0]) * toRad;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) / toRad + 360) % 360;
}

const STORE = 'cityRider.bounty';

/** The active bounty survives trips (the game restarts in each city) and reloads. */
export function loadBounty(): Bounty | null {
  try {
    const raw = localStorage.getItem(STORE);
    return raw ? JSON.parse(raw) as Bounty : null;
  } catch {
    return null;
  }
}

export function saveBounty(bounty: Bounty | null) {
  try {
    if (bounty) localStorage.setItem(STORE, JSON.stringify(bounty));
    else localStorage.removeItem(STORE);
  } catch { /* private mode: the bounty lasts this session only */ }
}
