import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planBridges } from '../src/world3d/tiles/worldTile.ts';

type Way = { lines: { x: number; y: number }[][]; bridge: boolean; level: number; foot: boolean };

const flat = {
  driveAt: () => 10,
  groundAt: () => 0,
  waterAt: () => null as number | null,
  toMerc: 1,
};

function midHeight(plan: ReturnType<typeof planBridges>, id: number) {
  const deck = plan.get(id)?.decks[0];
  assert.ok(deck && deck.h.length > 0, `deck ${id}`);
  return deck!.h[Math.floor(deck!.h.length / 2)];
}

test('orthogonal same-layer bridges stack; higher id goes over', () => {
  const ways = new Map<number, Way>([
    [1, { lines: [[{ x: 0, y: 50 }, { x: 100, y: 50 }]], bridge: true, level: 1, foot: false }],
    [2, { lines: [[{ x: 50, y: 0 }, { x: 50, y: 100 }]], bridge: true, level: 1, foot: false }],
  ]);
  const plan = planBridges(ways, 100, 100, flat);
  const low = midHeight(plan, 1);
  const high = midHeight(plan, 2);
  assert.ok(high - low >= 5, `expected ≥5 m stack, got ${high - low} (low=${low} high=${high})`);
});

test('tangential near-merge of same-layer bridges stays coplanar', () => {
  const ways = new Map<number, Way>([
    [1, { lines: [[{ x: 0, y: 48 }, { x: 100, y: 50 }]], bridge: true, level: 1, foot: false }],
    [2, { lines: [[{ x: 0, y: 52 }, { x: 100, y: 50 }]], bridge: true, level: 1, foot: false }],
  ]);
  const plan = planBridges(ways, 100, 100, flat);
  const a = midHeight(plan, 1);
  const b = midHeight(plan, 2);
  assert.ok(Math.abs(a - b) < 1.5, `tangential pair should stay level, Δ=${Math.abs(a - b)}`);
});

test('nearby elevated footbridge tips snap to one height', () => {
  // Left span clears a road (stays high at the gap); right stub has no cross and
  // would sit lower — OSM often splits a пешеходный переход this way.
  const ways = new Map<number, Way>([
    [1, { lines: [[{ x: 0, y: 50 }, { x: 58, y: 50 }]], bridge: true, level: 1, foot: true }],
    [2, { lines: [[{ x: 60, y: 50 }, { x: 100, y: 50 }]], bridge: true, level: 1, foot: true }],
    [3, { lines: [[{ x: 30, y: 0 }, { x: 30, y: 100 }]], bridge: false, level: 0, foot: false }],
  ]);
  const plan = planBridges(ways, 100, 100, flat);
  const left = plan.get(1)?.decks[0];
  const right = plan.get(2)?.decks[0];
  assert.ok(left && right, 'both foot decks present');
  const a = left!.h[left!.h.length - 1];
  const b = right!.h[0];
  assert.ok(Math.abs(a - b) < 0.4, `footbridge tips should meet, Δ=${Math.abs(a - b)} (${a} vs ${b})`);
  assert.ok(a > 12, `joined tips should stay elevated, got ${a}`);
});
