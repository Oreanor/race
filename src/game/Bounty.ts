import type { Position } from './VehicleController.ts';
import { kilometres } from './Travel.ts';

// Wanted targets anywhere on the planet. A bounty names a city; the exact spot
// is picked on the roads there once the player arrives. The further the hunt,
// the bigger the reward (it always covers the tickets on the way).

export type WantedPlace = { name: string; country: string; coords: Position };
export type Bounty = {
  id: string;
  /** the wanted driver */
  name: string;
  /** car config id of the dangerous car */
  car: string;
  place: WantedPlace;
  reward: number;
  /** the exact road spot, known once the player is in that city */
  spot?: Position;
};

/** City centres around the world (on land, with streets around). */
export const WANTED_PLACES: WantedPlace[] = [
  { name: 'Lisbon', country: 'Portugal', coords: [-9.1393, 38.7223] },
  { name: 'Porto', country: 'Portugal', coords: [-8.6110, 41.1496] },
  { name: 'Madrid', country: 'Spain', coords: [-3.7038, 40.4168] },
  { name: 'Barcelona', country: 'Spain', coords: [2.1734, 41.3851] },
  { name: 'Seville', country: 'Spain', coords: [-5.9845, 37.3891] },
  { name: 'Marseille', country: 'France', coords: [5.3698, 43.2965] },
  { name: 'Lyon', country: 'France', coords: [4.8357, 45.7640] },
  { name: 'Paris', country: 'France', coords: [2.3522, 48.8566] },
  { name: 'Brussels', country: 'Belgium', coords: [4.3517, 50.8503] },
  { name: 'Amsterdam', country: 'Netherlands', coords: [4.9041, 52.3676] },
  { name: 'London', country: 'United Kingdom', coords: [-0.1276, 51.5072] },
  { name: 'Dublin', country: 'Ireland', coords: [-6.2603, 53.3498] },
  { name: 'Hamburg', country: 'Germany', coords: [9.9937, 53.5511] },
  { name: 'Berlin', country: 'Germany', coords: [13.4050, 52.5200] },
  { name: 'Munich', country: 'Germany', coords: [11.5820, 48.1351] },
  { name: 'Zurich', country: 'Switzerland', coords: [8.5417, 47.3769] },
  { name: 'Milan', country: 'Italy', coords: [9.1900, 45.4642] },
  { name: 'Rome', country: 'Italy', coords: [12.4964, 41.9028] },
  { name: 'Naples', country: 'Italy', coords: [14.2681, 40.8518] },
  { name: 'Vienna', country: 'Austria', coords: [16.3738, 48.2082] },
  { name: 'Prague', country: 'Czechia', coords: [14.4378, 50.0755] },
  { name: 'Warsaw', country: 'Poland', coords: [21.0122, 52.2297] },
  { name: 'Budapest', country: 'Hungary', coords: [19.0402, 47.4979] },
  { name: 'Athens', country: 'Greece', coords: [23.7275, 37.9838] },
  { name: 'Istanbul', country: 'Türkiye', coords: [28.9784, 41.0082] },
  { name: 'Copenhagen', country: 'Denmark', coords: [12.5683, 55.6761] },
  { name: 'Stockholm', country: 'Sweden', coords: [18.0686, 59.3293] },
  { name: 'Oslo', country: 'Norway', coords: [10.7522, 59.9139] },
  { name: 'Helsinki', country: 'Finland', coords: [24.9384, 60.1699] },
  { name: 'Riga', country: 'Latvia', coords: [24.1052, 56.9496] },
  { name: 'Moscow', country: 'Russia', coords: [37.6173, 55.7558] },
  { name: 'Saint Petersburg', country: 'Russia', coords: [30.3351, 59.9343] },
  { name: 'Casablanca', country: 'Morocco', coords: [-7.5898, 33.5731] },
  { name: 'Cairo', country: 'Egypt', coords: [31.2357, 30.0444] },
  { name: 'Dubai', country: 'United Arab Emirates', coords: [55.2708, 25.2048] },
  { name: 'Mumbai', country: 'India', coords: [72.8777, 19.0760] },
  { name: 'Bangkok', country: 'Thailand', coords: [100.5018, 13.7563] },
  { name: 'Singapore', country: 'Singapore', coords: [103.8198, 1.3521] },
  { name: 'Hong Kong', country: 'China', coords: [114.1694, 22.3193] },
  { name: 'Shanghai', country: 'China', coords: [121.4737, 31.2304] },
  { name: 'Seoul', country: 'South Korea', coords: [126.9780, 37.5665] },
  { name: 'Tokyo', country: 'Japan', coords: [139.6917, 35.6895] },
  { name: 'Osaka', country: 'Japan', coords: [135.5023, 34.6937] },
  { name: 'Sydney', country: 'Australia', coords: [151.2093, -33.8688] },
  { name: 'Melbourne', country: 'Australia', coords: [144.9631, -37.8136] },
  { name: 'Auckland', country: 'New Zealand', coords: [174.7633, -36.8485] },
  { name: 'Cape Town', country: 'South Africa', coords: [18.4241, -33.9249] },
  { name: 'Nairobi', country: 'Kenya', coords: [36.8219, -1.2921] },
  { name: 'Rio de Janeiro', country: 'Brazil', coords: [-43.1729, -22.9068] },
  { name: 'São Paulo', country: 'Brazil', coords: [-46.6333, -23.5505] },
  { name: 'Buenos Aires', country: 'Argentina', coords: [-58.3816, -34.6037] },
  { name: 'Santiago', country: 'Chile', coords: [-70.6693, -33.4489] },
  { name: 'Lima', country: 'Peru', coords: [-77.0428, -12.0464] },
  { name: 'Mexico City', country: 'Mexico', coords: [-99.1332, 19.4326] },
  { name: 'Miami', country: 'United States', coords: [-80.1918, 25.7617] },
  { name: 'New York', country: 'United States', coords: [-73.9857, 40.7484] },
  { name: 'Chicago', country: 'United States', coords: [-87.6298, 41.8781] },
  { name: 'Los Angeles', country: 'United States', coords: [-118.2437, 34.0522] },
  { name: 'San Francisco', country: 'United States', coords: [-122.4194, 37.7749] },
  { name: 'Seattle', country: 'United States', coords: [-122.3321, 47.6062] },
  { name: 'Toronto', country: 'Canada', coords: [-79.3832, 43.6532] },
  { name: 'Montreal', country: 'Canada', coords: [-73.5673, 45.5017] },
  { name: 'Vancouver', country: 'Canada', coords: [-123.1207, 49.2827] },
];

const NAMES = [
  'Viktor "Wolf" Kral', 'Dante Moreau', 'Lena Varga', 'Rico Salvatierra', 'Mads Holt', 'Yuri Sokol',
  'Ivo Brancusi', 'Nadia Rask', 'Teo Castellano', 'Sasha Grimm', 'Kenji Arata', 'Lola Vex',
];

/** the dangerous car the wanted drive */
export const WANTED_CAR = '03';

/** Reward: a base for the fight plus enough per km to pay the tickets and more. */
export function bountyReward(km: number) {
  return Math.round((800 + km * 2.2) / 50) * 50;
}

/** A new bounty somewhere away from the player (never right here). */
export function makeBounty(from: Position, seed = Math.random()): Bounty {
  const far = WANTED_PLACES.filter((place) => kilometres(from, place.coords) > 20);
  const pool = far.length ? far : WANTED_PLACES;
  const place = pool[Math.floor(seed * pool.length) % pool.length];
  const name = NAMES[Math.floor(seed * 7919) % NAMES.length];
  const km = kilometres(from, place.coords);
  return { id: `bounty-${Math.round(seed * 1e9)}`, name, car: WANTED_CAR, place, reward: bountyReward(km) };
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
