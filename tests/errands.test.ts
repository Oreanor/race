import assert from 'node:assert/strict';
import test from 'node:test';
import { COLLECT_BOXES, COLLECT_RADIUS_M, deliveryReward, scatterBoxes } from '../src/game/Errands.ts';
import { metersBetween, offsetPosition, type Position } from '../src/game/VehicleController.ts';

const center: Position = [37.6175, 55.7558];

test('ten boxes within 2 km, apart from each other, with no roads at all', () => {
  const boxes = scatterBoxes(center, 12345, () => null);
  assert.equal(boxes.length, COLLECT_BOXES);
  for (const box of boxes) assert.ok(metersBetween(center, box.position) <= COLLECT_RADIUS_M);
  for (const a of boxes) for (const b of boxes) if (a !== b) assert.ok(metersBetween(a.position, b.position) >= 100);
});

test('boxes sit on the road nodes the graph gives', () => {
  let n = 0;
  const road = (min: number) => offsetPosition(center, Math.sin(n) * (min + 10), Math.cos(n++) * (min + 10)) as Position;
  const boxes = scatterBoxes(center, 7, road);
  assert.equal(boxes.length, COLLECT_BOXES);
  for (const box of boxes) assert.ok(metersBetween(center, box.position) <= COLLECT_RADIUS_M);
});

test('a longer delivery pays more', () => {
  assert.ok(deliveryReward(2500) > deliveryReward(1000));
  assert.equal(deliveryReward(1000) % 50, 0);
});
