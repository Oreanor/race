import type { CivicKind } from './poi.ts';

export { METERS_PER_DEGREE } from './meters.ts';

/** race and arena: what you chip in to start, and what the winner takes */
export const RACE_FEE = 1000;
export const RACE_PRIZE = 4000;
export const ARENA_FEE = 2500;
export const ARENA_PRIZE = 10000;

/** the most the bank lends, and its interest (one-off, no term) */
export const LOAN_LIMIT = 10000;
export const LOAN_RATE = 0.1;

/** one bundle of banknotes from a robbed bank */
export const CASH_BUNDLE = 5000;

/** Base arrest bill by where you wake up (stolen cash is added on top). */
export const ARREST_COSTS: Record<CivicKind, number> = {
  police: 20000,
  prison: 25000,
  court: 22000,
  hospital: 18000,
};
/** Fallback if no civic POI is loaded yet */
export const ARREST_FINE = 20000;

/** Our car blown up outside a fight: the bill where we come to. */
export const WRECK_COSTS = { hospital: 1500, station: 1000, here: 1000 } as const;

/** shooting at a bank this long (ms, in one go) cracks it */
export const BANK_CRACK_MS = 3000;

/** police that far behind give up the chase (m) */
export const POLICE_GIVE_UP_M = 1500;
/** …and only after staying that far this long (ms) */
export const POLICE_GIVE_UP_MS = 10_000;

/** how close to a mission marker the offer opens (m) */
export const MISSION_PICKUP_M = 6;
/** missions on the map at once: one of each kind */
export const MISSION_COUNT = 4;

/** The Howler doesn't shoot: it throws a cable at a standing car and pulls it up onto its back. */
export const HAULER_ID = '03';
/** Fire Truck №5 — hose + fire calls */
export const FIRE_TRUCK_ID = '18';
/** Cadillac ambulance — crash / burned-house victims to hospital */
export const AMBULANCE_ID = '20';
/** Chevy Taxi — passenger fares */
export const TAXI_ID = '10';
/** Double Decker — stop board / alight coins */
export const BUS_ID = '19';
/** Fleetline Police + ГАЗ-24 Милиция */
export const POLICE_IDS = new Set(['09', '16']);
/** Batmobile — night crusader, same wanted hunts as police */
export const BATMOBILE_ID = '06';
/** Family Sedan (Simpsons pink) — machine-gun vacuum for road coins */
export const FAMILY_SEDAN_ID = '17';
/** Cars that get bounty / wanted missions */
export const BOUNTY_CAR_IDS = new Set([...POLICE_IDS, BATMOBILE_ID]);

/** Cars with no gun damage (cable / hose / ambulance) — arena fights are unavailable. */
export const UNARMED_IDS = new Set([HAULER_ID, FIRE_TRUCK_ID, AMBULANCE_ID]);
/** True when the car can shoot guns (arena / bounty combat). */
export const carShootsGuns = (id: string) => !UNARMED_IDS.has(id);


/** coins for each window put out on a fire call */
export const FIRE_WINDOW_COIN = 100;
/** how close to the fire marker the house lights up (m) */
export const FIRE_ARRIVE_M = 28;

/** Ambulance: coins per injured person delivered to a hospital */
export const AMBULANCE_VICTIM_COIN = 1000;
export const AMBULANCE_VICTIM_MIN = 1;
export const AMBULANCE_VICTIM_MAX = 3;
/** how close to the crash / burned house the pickup modal opens (m) */
export const AMBULANCE_ARRIVE_M = 22;
/** hospital drop-off reach (m) */
export const AMBULANCE_HOSPITAL_M = 28;
/** parked wreck props at an ambulance call (one or two cars) */
export const AMBULANCE_WRECK_ID = 'ambulance-wreck';
export const ambulanceWreckId = (index: number) => `${AMBULANCE_WRECK_ID}-${index}`;
export const isAmbulanceWreckId = (id: string) => id === AMBULANCE_WRECK_ID || id.startsWith(`${AMBULANCE_WRECK_ID}-`);

/** how close to the taxi pickup the fare starts (m) */
export const TAXI_ARRIVE_M = 14;
/** drop-off reach (m) */
export const TAXI_REACH_M = 18;
/** passenger drop-off distance band (m) */
export const TAXI_MIN_M = 900;
export const TAXI_MAX_M = 3200;
/** coins per kilometre of the fare (great-circle pickup → goal) */
export const TAXI_PER_KM = 100;
/** Pay for a taxi fare: 100 per km, rounded to the nearest coin. */
export const taxiFareReward = (meters: number) => Math.max(TAXI_PER_KM, Math.round((meters / 1000) * TAXI_PER_KM));

/** how close to an OSM bus stop the board/alight modal fires (m) */
export const BUS_STOP_REACH_M = 28;
/** coins at a stop: 10…100 in steps of 10 */
export const BUS_FARE_MIN = 10;
export const BUS_FARE_MAX = 100;
export const BUS_FARE_STEP = 10;
/** Random stop fare: `stepIndex` 0 → 10, …, 9 → 100. */
export const busFareCoins = (stepIndex: number) =>
  Math.min(BUS_FARE_MAX, BUS_FARE_MIN + Math.max(0, stepIndex) * BUS_FARE_STEP);

/** bus tour: pick up a group, drop at a named hotel/museum */
export const BUS_TOUR_ARRIVE_M = 16;
export const BUS_TOUR_REACH_M = 28;
/** destination band from pickup (m) — within ~10 km */
export const BUS_TOUR_MIN_M = 400;
export const BUS_TOUR_MAX_M = 10_000;
/** group size */
export const BUS_GROUP_MIN = 10;
export const BUS_GROUP_MAX = 50;
/** coins per passenger on a bus tour */
/** Fare per passenger per kilometre. */
export const BUS_PER_PERSON_KM = 10;
export const busTourReward = (passengers: number, meters: number) => {
  const km = Math.max(0.1, meters / 1000);
  return Math.round(Math.max(BUS_GROUP_MIN, passengers) * BUS_PER_PERSON_KM * km);
};

/** Howler tow job: arrive this close to pick up the car (m) */
export const IMPOUND_ARRIVE_M = 22;
/** premium for delivering the impound car to any police station */
export const IMPOUND_REWARD = 2000;
export const TOW_CAR_ID = 'tow-impound';

/** how far the cable reaches (m), how close to the aim a car must stand to be hooked, and when it snaps */
export const HAUL_REACH_M = 20;
export const HAUL_AIM_M = 3;
export const HAUL_SNAP_M = 30;
/** winch reels a hooked car in at this rate (m/s) when its speed against the rope is lower */
export const HAUL_WINCH_MS = 5.5;
/** at full stretch against the winch this long (ms), the hook lets go */
export const HAUL_TAUT_MS = 2000;
/** close enough: yank the car up onto the deck */
export const HAUL_LOAD_M = 4.5;
/**
 * The Howler's flatbed, as shares of its length (measured on the model): the bed's top is
 * 0.177 of the length up, its middle 0.23 of the length behind the truck's middle.
 */
export const HAUL_DECK_UP = 0.177;
export const HAUL_DECK_BACK = 0.23;
/** the load sits this much nose down on the bed (rad, ~3.5°): its tail clears the bed */
export const HAUL_TILT = 0.06;
export const HAUL_FLY_MS = 80;
export const HAUL_PULL_MS = 520;
export const HAUL_REEL_MS = 650;
export const HAUL_DROP_MS = 750;
/** coins on the hook fly to the car in this long (ms); a coin this close to the crosshair on screen (px) is hooked */
export const HAUL_COINS_MS = 350;
export const HAUL_COIN_PX = 40;
/** a miss: out to full length, a moment hanging there, wound back in (ms) */
export const HAUL_MISS_OUT_MS = 110;
export const HAUL_MISS_HOLD_MS = 300;
export const HAUL_MISS_BACK_MS = 220;

/** 3D markers of the errands: green for a delivery, cardboard brown for the boxes */
export const ERRAND_BEACONS = {
  delivery: { pole: '#2fae5a', glow: '#16703a', orb: '#7fe0a0' },
  collect: { pole: '#b8742a', glow: '#6e4212', orb: '#f0b878' },
  taxi: { pole: '#f2c230', glow: '#b8860b', orb: '#ffe56a' },
  bus: { pole: '#e85d2a', glow: '#9a3a12', orb: '#ffb08a' },
  ambulance: { pole: '#e11d48', glow: '#9f1239', orb: '#fb7185' },
} as const;

export const DRIVER_NAMES = [
  'Ines', 'Tiago', 'Marta', 'Rui', 'Leonor', 'Duarte', 'Beatriz', 'Nuno', 'Sofia', 'Miguel', 'Rafael', 'Ana',
];

export const TRAFFIC_MARKER_COLORS = ['#ff3b30', '#00e5ff', '#ffe600'];

/** Map pins + off-screen arrows: each kind its own hue (label and tip share `main`). */
export const MISSION_COLORS = {
  arena: { main: '#3d8bff', soft: '#8bbcff' },
  race: { main: '#ff7a1a', soft: '#ffb86b' },
  bounty: { main: '#ff3b4a', soft: '#ff8a96' },
  fire: { main: '#ff2bd6', soft: '#ff8ae8' },
  impound: { main: '#9b5cff', soft: '#c9a6ff' },
  taxi: { main: '#ffe014', soft: '#fff18a' },
  bus: { main: '#00c2d8', soft: '#7ae8f2' },
  ambulance: { main: '#e11d48', soft: '#fb7185' },
  finish: { main: '#e0b12a', soft: '#ffe56a' },
  delivery: { main: '#2fe36a', soft: '#8af0ad' },
  collect: { main: '#c44dff', soft: '#e0a0ff' },
} as const;

/** Custom M-map pins: colours not used by missions / traffic bots. Max 3 pins. */
export const CUSTOM_PIN_COLORS = [
  { main: '#a96aff', soft: '#c9a6ff', glow: '#6a3ab8' },
  { main: '#2ecf8f', soft: '#7aefc0', glow: '#1a8a5a' },
  { main: '#ff4f9a', soft: '#ff9ac4', glow: '#b02060' },
] as const;

export const GRAVITY = 9.81;

/** key J: hold to grow, release to place. Grade is rise/run (30%). */
export const RAMP = {
  grade: 0.3,
  width: 3.2,
  minLength: 2.4,
  maxLength: 16,
  growPerSec: 7,
  /** base mesh size in VehicleLayer — keep in sync for scaling */
  mesh: { length: 3.2, width: 3.2, height: 1.0 },
};

export function randomDriverNames(count: number) {
  const names = [...DRIVER_NAMES];
  for (let index = names.length - 1; index > 0; index--) {
    const swap = Math.floor(Math.random() * (index + 1));
    [names[index], names[swap]] = [names[swap], names[index]];
  }
  return names.slice(0, count);
}
