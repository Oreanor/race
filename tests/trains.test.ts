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
  const traffic = new TrainTraffic(network);
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
