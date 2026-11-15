import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { driveTerrainHeight, planBridges } from '../src/world3d/tiles/worldTile.ts';
import { planRoadNetwork, ROAD_GRADE, ROAD_CLEARANCE, type RoadWay } from '../src/world3d/tiles/roadNetwork.ts';
import { buildRoadSurface, deckSections, deckSideOpening, surfaceHeight } from '../src/world3d/tiles/roadSurface.ts';

type Way = { lines: { x: number; y: number }[][]; bridge: boolean; level: number; foot: boolean };

const flat = {
  driveAt: () => 10,
  groundAt: () => 0,
  waterAt: () => null as number | null,
  toMerc: 1,
};

test('smoothed bank heights cannot support cars above open water', () => {
  assert.equal(driveTerrainHeight(-2.4, 15, 0), -0.12);
  assert.equal(driveTerrainHeight(10, 10, null), 10);
  assert.equal(driveTerrainHeight(5, 5, 0), 5, 'dry embankment stays solid');
});

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

test('border tip extension does not yank glancing ramps onto the edge', () => {
  // A ramp tip ~12 m inside, aimed diagonally at the left edge — the old
  // extendNearBorderTips pulled it to (0, …) and left a diagonal ear.
  const ways = new Map<number, Way>([
    [1, { lines: [[{ x: 12, y: 40 }, { x: 80, y: 55 }]], bridge: true, level: 1, foot: false }],
    [2, { lines: [[{ x: 40, y: 0 }, { x: 40, y: 100 }]], bridge: false, level: 0, foot: false }],
  ]);
  const plan = planBridges(ways, 100, 100, flat);
  const deck = plan.get(1)?.decks[0];
  assert.ok(deck, 'deck present');
  const [x, z] = deck!.pts[0];
  assert.ok(x > 8, `tip should stay near OSM end, got x=${x}`);
  assert.ok(Math.abs(z - 40) < 2, `tip should not slide sideways, got z=${z}`);
});

const line = (points: [number, number][], options: Partial<RoadWay> = {}): RoadWay => ({ lines: [points.map(([x, y]) => ({ x, y }))], bridge: true, level: 1, foot: false, ...options });

test('a clearance propagates through a long chain of split ways, independent of input order', () => {
  const entries: [number, RoadWay][] = [];
  for (let i = 0; i < 9; i++) entries.push([i, line([[20 + i * 10, 100], [30 + i * 10, 100]])]);
  entries.push([100, line([[25, 20], [25, 180]], { bridge: false, level: 0 })]);
  const a = planBridges(new Map(entries), 200, 200, flat);
  const b = planBridges(new Map([...entries].reverse()), 200, 200, flat);
  for (let i = 0; i < 9; i++) {
    const deck = a.get(i)!.decks[0];
    assert.deepEqual(deck.h, b.get(i)!.decks[0].h);
    for (let n = 1; n < deck.h.length; n++) assert.ok(Math.abs(deck.h[n] - deck.h[n - 1]) <= ROAD_GRADE * (deck.s[n] - deck.s[n - 1]) + 1e-6);
    if (i < 8) assert.equal(deck.h.at(-1), a.get(i + 1)!.decks[0].h[0], `join ${i}`);
  }
});

test('approach lift crosses several ground features and reaches the ground without a step', () => {
  const ways = new Map<number, RoadWay>([
    [1, line([[100, 100], [180, 100]])],
    [2, line([[40, 100], [100, 100]], { bridge: false, level: 0 })],
    [3, line([[0, 100], [40, 100]], { bridge: false, level: 0 })],
    [4, line([[105, 0], [105, 200]], { bridge: false, level: 0 })],
  ]);
  const plan = planBridges(ways, 200, 200, flat);
  const a = plan.get(1)!.decks[0], b = plan.get(2)!.decks.at(-1)!, c = plan.get(3)!.decks.at(-1)!;
  assert.equal(a.h[0], b.h.at(-1));
  assert.equal(b.h[0], c.h.at(-1));
  const first = plan.get(3)!.decks[0];
  assert.equal(first.h[0], 10, 'touchdown meets the ground');
  for (const p of plan.values()) for (const d of p.decks) for (let i = 1; i < d.h.length; i++) assert.ok(Math.abs(d.h[i] - d.h[i - 1]) <= ROAD_GRADE * (d.s[i] - d.s[i - 1]) + 1e-6);
});

test('an endpoint merging into a segment shares an inserted station and its height', () => {
  const plan = planBridges(new Map([
    [1, line([[0, 100], [200, 100]])],
    [2, line([[130, 60], [87, 100]])],
    [3, line([[50, 0], [50, 200]], { bridge: false, level: 0 })],
  ]), 200, 200, flat);
  const main = plan.get(1)!.decks[0], ramp = plan.get(2)!.decks[0];
  const n = main.pts.findIndex(([x, z]) => x === 87 && z === 100);
  assert.ok(n > 0, 'merge split is in the main road');
  assert.equal(main.h[n], ramp.h.at(-1));
});

test('a narrow link tapers into the wide deck and shares its cross section', () => {
  const plan = planBridges(new Map([
    [1, line([[0, 100], [100, 100]], { half: 4.6 })],
    [2, line([[100, 100], [180, 140]], { half: 3.2 })],
  ]), 200, 200, flat);
  const a = plan.get(1)!.decks[0], b = plan.get(2)!.decks[0];
  const sa = deckSections(a, 4.6, true).at(-1)!, sb = deckSections(b, 3.2, true)[0];
  assert.deepEqual(sa.left, sb.left); assert.deepEqual(sa.right, sb.right);
  assert.equal(b.half![0], 4.6); assert.ok(b.half![1] < 4.6 && b.half![1] > 3.2);
});

test('unrelated bridges on the same tile edge retain their own elevations', () => {
  const plan = planBridges(new Map([
    [1, line([[0, 40], [150, 40]])],
    [2, line([[0, 140], [150, 140]])],
    [3, line([[20, 0], [20, 80]], { bridge: false, level: 0 })],
  ]), 200, 200, flat);
  assert.ok(plan.get(1)!.decks[0].h[0] > plan.get(2)!.decks[0].h[0] + 2);
});

test('OSM layer wins over a feature index when bridges cross', () => {
  const plan = planBridges(new Map([
    [99, line([[0, 100], [200, 100]], { level: 1 })],
    [1, line([[100, 0], [100, 200]], { level: 3 })],
  ]), 200, 200, flat);
  assert.ok(midHeight(plan, 1) - midHeight(plan, 99) >= ROAD_CLEARANCE - 1e-6);
});

test('a layer tag change along a continuous viaduct does not create a step', () => {
  const plan = planBridges(new Map([
    [1, line([[0, 100], [100, 100]], { level: 1 })],
    [2, line([[100, 100], [200, 100]], { level: 2 })],
    [3, line([[40, 0], [40, 200]], { bridge: false, level: 0 })],
  ]), 200, 200, flat);
  assert.equal(plan.get(1)!.decks[0].h.at(-1), plan.get(2)!.decks[0].h[0]);
});

test('surface queries interpolate the rendered triangles and select each storey', () => {
  const surface = buildRoadSurface(Float32Array.from([
    0, 10, 0, 20, 12, 0, 0, 10, 10,
    20, 12, 0, 20, 12, 10, 0, 10, 10,
    0, 20, 0, 20, 22, 0, 0, 20, 10,
    20, 22, 0, 20, 22, 10, 0, 20, 10,
  ]));
  assert.equal(surfaceHeight(surface, 10, 5, 11), 11);
  assert.equal(surfaceHeight(surface, 10, 5, 21), 21);
  assert.equal(surfaceHeight(surface, 10, 5), 21);
  assert.equal(surfaceHeight(surface, 10, 10.2), null, 'no imaginary widened pavement');
});

test('a short connected loop cannot make the height solver diverge', () => {
  const ways = new Map([
    [1, line([[30, 30], [70, 30], [70, 70], [30, 70], [30, 30]])],
    [2, line([[50, 30], [50, 70]], { bridge: false, level: 0 })],
  ]);
  const plan = planRoadNetwork(ways, 100, 100, flat);
  for (const p of plan.values()) for (const d of p.decks) assert.ok(d.h.every(h => Number.isFinite(h) && h < 100));
});

const realJunctions = JSON.parse(readFileSync(new URL('./fixtures/road-junctions.json', import.meta.url), 'utf8')) as {
  samples: { name: string; extent: number; span: number; toMerc: number; ways: [number, RoadWay][] }[];
};
for (const sample of realJunctions.samples) test(`${sample.name}: real interchange topology is finite and independent of feature order`, () => {
  const at = { ...flat, toMerc: sample.toMerc };
  const a = planRoadNetwork(new Map(sample.ways), sample.extent, sample.span, at);
  const b = planRoadNetwork(new Map([...sample.ways].reverse()), sample.extent, sample.span, at);
  let stations = 0;
  for (const [id, planned] of a) {
    assert.deepEqual(planned, b.get(id));
    for (const deck of planned.decks) {
      stations += deck.h.length;
      assert.ok(deck.h.every(h => Number.isFinite(h) && h >= 10 && h < 100));
      assert.ok(deck.half!.every(w => Number.isFinite(w) && w > 0));
      assert.ok(deck.frame!.every(([x, z]) => Math.hypot(x, z) >= 0.99 && Math.hypot(x, z) <= 2.001));
    }
  }
  assert.ok(stations > 100, 'fixture exercises the elevated network');
});

test('a deck clears a cross slope under its shoulder, not just under the axis', () => {
  const at = { ...flat, driveAt: (_x: number, z: number) => z > 102 ? 14 : 10 };
  const plan = planBridges(new Map([[1, line([[20, 100], [180, 100]], { half: 4.5 })]]), 200, 200, at);
  assert.ok(plan.get(1)!.decks[0].h.every(h => h >= 14));
});

test('a tiny source stub absorbed into a junction does not crash the tile builder', () => {
  const plan = planBridges(new Map([
    [1, line([[40, 50], [40.1, 50]])],
    [2, line([[40.05, 10], [40.05, 50]])],
  ]), 100, 100, flat);
  assert.ok(plan.get(2)!.decks[0].h.every(Number.isFinite));
});

test('parapets open onto a connected side road, not nearby spans or the air past a tip', () => {
  const base = { bed: [0, 0, 0], s: [0, 5, 10], length: 10 };
  const main = { ...base, pts: [[0, 0], [5, 0], [10, 0]] as [number, number][], h: [10, 10, 10], nodes: [1, 2, 3] };
  const branch = { ...base, pts: [[5, 0], [5, 8]] as [number, number][], h: [10, 10], nodes: [2, 4] };
  assert.equal(deckSideOpening(main, 1, 1, 2, branch, 1), true);
  assert.equal(deckSideOpening(main, 1, -1, 2, branch, 1), false, 'no hole on the side away from the junction');
  assert.equal(deckSideOpening(main, 1, 1, 2, { ...branch, nodes: [7, 8] }, 1), false, 'nearby unconnected deck');
  assert.equal(deckSideOpening(main, 1, 1, 2, { ...branch, h: [4, 4] }, 1), false, 'lower road');
});
