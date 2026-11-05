import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RailNetwork, TrainTraffic, trackKind } from '../src/game/Trains.ts';

const M = 111319.49;
// one 6 km line with a short spur, around (0, 0)
function line(from: number, to: number, step = 50) {
  const points: [number, number][] = [];
  for (let m = from; m <= to; m += step) points.push([m / M, 0]);
  return points;
}

test('only main lines carry trains', () => {
  assert.equal(trackKind({ class: 'rail', subclass: 'rail' }), 'rail');
  assert.equal(trackKind({ class: 'transit', subclass: 'tram' }), 'tram');
  assert.equal(trackKind({ class: 'rail', subclass: 'rail', service: 'yard' }), null);
  assert.equal(trackKind({ class: 'rail', subclass: 'rail', brunnel: 'tunnel' }), null);
});

test('trains on one track never run into each other', () => {
  const network = new RailNetwork();
  network.addFeatures([{ geometry: { type: 'LineString', coordinates: line(-3000, 3000) }, properties: { class: 'rail', subclass: 'rail' } }]);
  const traffic = new TrainTraffic(network, { rail: 3 }); // the game runs one; three to test the spacing
  const player: [number, number] = [0, 0.01]; // 1.1 km off the line: trains appear and go in the haze
  let closest = Infinity;
  for (let t = 0; t < 600; t += 0.1) {
    traffic.update(0.1, player, () => false);
    const poses = traffic.poses();
    for (const a of poses) for (const b of poses) {
      if (a.trainId === b.trainId) continue;
      const d = Math.hypot(a.front[0] - b.front[0], a.front[1] - b.front[1]) * M;
      closest = Math.min(closest, d);
    }
  }
  assert.ok(traffic.trains.length >= 2, 'several trains were running');
  assert.ok(closest > 10, `trains came ${closest.toFixed(1)} m close`);
});

test('trams spawn on tram tracks the same way trains do', () => {
  const network = new RailNetwork();
  network.addFeatures([{ geometry: { type: 'LineString', coordinates: line(-3000, 3000) }, properties: { class: 'transit', subclass: 'tram' } }]);
  const traffic = new TrainTraffic(network, { tram: 3, rail: 0 });
  const player: [number, number] = [0, 0.01];
  for (let t = 0; t < 600; t += 0.1) traffic.update(0.1, player, () => false);
  assert.ok(traffic.trains.some((train) => train.kind === 'tram'), 'trams were running');
  assert.ok(traffic.trains.every((train) => train.kind === 'tram'), 'only trams on tram tracks');
});

test('switches pick a random fork', () => {
  const network = new RailNetwork();
  // a Y at 0: east–west main line plus a branch north
  network.addFeatures([
    { geometry: { type: 'LineString', coordinates: line(-500, 500, 100) }, properties: { class: 'rail', subclass: 'rail' } },
    { geometry: { type: 'LineString', coordinates: [[0, 0], [0, 200 / M], [0, 400 / M]] }, properties: { class: 'rail', subclass: 'rail' } },
  ]);
  const at = `${Math.round(0 * 2e5)}:${Math.round(0 * 2e5)}`;
  const west = `${Math.round((-100 / M) * 2e5)}:${Math.round(0 * 2e5)}`;
  const seen = new Set<string | null>();
  for (let i = 0; i < 40; i++) seen.add(network.next(west, at));
  assert.ok(seen.size >= 2, `switch should fork randomly, got ${[...seen]}`);
});

test('dead ends reverse', () => {
  const stub = new RailNetwork();
  stub.addFeatures([{ geometry: { type: 'LineString', coordinates: line(1500, 2500, 50) }, properties: { class: 'rail', subclass: 'rail' } }]);
  const traffic = new TrainTraffic(stub, { rail: 1 });
  const player: [number, number] = [2000 / M, 0.02];
  let sawDeadEnd = false;
  let turnedBack = false;
  for (let t = 0; t < 400; t += 0.1) {
    traffic.update(0.1, player, () => false);
    for (const train of traffic.trains) {
      if (train.deadEnd) sawDeadEnd = true;
      if (sawDeadEnd && !train.deadEnd) turnedBack = true;
    }
  }
  assert.ok(sawDeadEnd, 'reached a dead end');
  assert.ok(turnedBack, 'turned back after the dead end');
});
