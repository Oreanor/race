import { metersBetween, offsetPosition, type Position } from './VehicleController.ts';

// Errands: two quiet missions beside the arena and the race.
//   delivery: at the marker somebody asks you to take a crate, a suitcase, a parcel
//             or a bag to an address across town; drive there, get paid.
//   collect:  ten boxes lie about within 2 km of the marker, each with its own
//             marker; pick them all up for the prize.
// No fee, no timer; a wreck on the way loses it (GameEngine.failMission).

export const DELIVERY_ITEMS = ['box', 'suitcase', 'parcel', 'bag'] as const;
export type DeliveryItem = typeof DELIVERY_ITEMS[number];

/** how close to the address counts as delivered (m) */
export const DELIVERY_REACH_M = 18;
/** how far the address may be (m) */
export const DELIVERY_MIN_M = 900;
export const DELIVERY_MAX_M = 2600;
/** boxes to collect, and how far from the marker they may lie (m) */
export const COLLECT_BOXES = 10;
export const COLLECT_RADIUS_M = 2000;
/** a box at least this far from the others (m) */
const BOX_SPACING_M = 140;
/** drive this close to a box to pick it up (m) */
export const BOX_REACH_M = 6;
export const COLLECT_REWARD = 5000;

/** Pay for a delivery: more for a longer way, rounded to 50. */
export const deliveryReward = (meters: number) => Math.round((500 + meters * 0.9) / 50) * 50;

export type Errand =
  | { kind: 'delivery'; item: DeliveryItem; goal: Position; reward: number }
  | { kind: 'collect'; center: Position; boxes: { id: string; position: Position }[]; total: number; reward: number };

export const randomItem = (seed: number): DeliveryItem => DELIVERY_ITEMS[Math.abs(seed) % DELIVERY_ITEMS.length];

/**
 * Ten spots within the radius, apart from each other: road nodes where the road
 * graph has them (`road` picks one in a ring), a plain point otherwise.
 */
export function scatterBoxes(
  center: Position,
  seed: number,
  road: (min: number, max: number, seed: number) => Position | null,
): { id: string; position: Position }[] {
  const out: { id: string; position: Position }[] = [];
  const apart = (p: Position) => metersBetween(p, center) <= COLLECT_RADIUS_M && out.every((box) => metersBetween(box.position, p) >= BOX_SPACING_M);
  for (let attempt = 0; attempt < 120 && out.length < COLLECT_BOXES; attempt++) {
    // rings from near to far, so they spread over the whole area
    const ring = (attempt % 5) / 5;
    const min = 120 + ring * (COLLECT_RADIUS_M - 120), max = min + COLLECT_RADIUS_M / 5;
    const at = road(min, Math.min(max, COLLECT_RADIUS_M), seed + attempt * 7919);
    if (at && apart(at)) out.push({ id: `box-${out.length}`, position: [...at] as Position });
  }
  // the road graph ran out (a small town): fill in around the centre
  for (let attempt = 0; attempt < 200 && out.length < COLLECT_BOXES; attempt++) {
    const angle = ((seed + attempt * 2654435761) % 6283) / 1000;
    const r = 150 + (Math.abs(seed ^ (attempt * 40503)) % 1000) / 1000 * (COLLECT_RADIUS_M * 0.8 - 150);
    const at = offsetPosition(center, Math.sin(angle) * r, Math.cos(angle) * r) as Position;
    if (apart(at)) out.push({ id: `box-${out.length}`, position: at });
  }
  return out;
}
