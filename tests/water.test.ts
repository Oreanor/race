import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WaterCollisionController } from '../src/game/WaterCollisionController.ts';
import type { Position } from '../src/game/VehicleController.ts';

const meters = 111319.49;
const at = (east: number, north: number): Position => [east / meters, north / meters];
const northOf = (position: Position) => position[1] * meters;
const eastOf = (position: Position) => position[0] * meters;

function shore() {
  const water = new WaterCollisionController();
  const ring = [[-40, 30], [40, 30], [40, 80], [-40, 80], [-40, 30]].map(([east, north]) => at(east, north));
  water.update([0, 0], [[ring]], []);
  return water;
}

test('the bank stops a move into the water', () => {
  const water = shore();
  const hit = water.resolve(at(0, 10), at(0, 50), 0, 1);
  assert.equal(hit.stopped, true);
  assert.ok(northOf(hit.position) < 29);
  assert.ok(northOf(hit.position) > 9);
});

test('movement along the bank and back onto land stays free', () => {
  const water = shore();
  const along = water.resolve(at(0, 29.2), at(12, 29.2), Math.PI / 2, 1);
  assert.equal(along.stopped, false);
  assert.ok(eastOf(along.position) > 10);
  assert.ok(northOf(along.position) < 30.2);
  const back = water.resolve(at(0, 29.4), at(0, 18), Math.PI, 1);
  assert.equal(back.stopped, false);
  assert.ok(northOf(back.position) < 22);
});

test('a car already in the water can back out but not go deeper', () => {
  const water = shore();
  const out = water.resolve(at(0, 31.2), at(0, 20), Math.PI, 1);
  assert.equal(out.stopped, false);
  assert.ok(northOf(out.position) < 22);
  const deeper = water.resolve(at(0, 31.2), at(0, 45), 0, 1);
  assert.equal(deeper.stopped, true);
  assert.ok(northOf(deeper.position) < 33);
});

test('a fast step cannot clear a narrow channel', () => {
  const water = new WaterCollisionController();
  const ring = [[-20, 30], [20, 30], [20, 34], [-20, 34], [-20, 30]].map(([east, north]) => at(east, north));
  water.update([0, 0], [[ring]], []);
  const hit = water.resolve(at(0, 10), at(0, 60), 0, 1);
  assert.equal(hit.stopped, true);
  assert.ok(northOf(hit.position) < 30);
});

test('a bridge deck crosses the channel and the side of the bridge does not', () => {
  const water = new WaterCollisionController();
  const ring = [[-30, 30], [30, 30], [30, 34], [-30, 34], [-30, 30]].map(([east, north]) => at(east, north));
  water.update([0, 0], [[ring]], [{ line: [at(-6, 32), at(6, 32)], half: 8 }]);
  const over = water.resolve(at(0, 10), at(0, 55), 0, 1);
  assert.equal(over.stopped, false);
  assert.ok(northOf(over.position) > 50);
  const aside = water.resolve(at(20, 10), at(20, 55), 0, 1);
  assert.equal(aside.stopped, true);
  assert.ok(northOf(aside.position) < 30);
});

test('water geometry stays cached near the car and expires farther away', () => {
  const water = shore();
  assert.equal(water.covers(at(100, 0)), true);
  assert.equal(water.covers(at(400, 0)), false);
});

test('small repeated inputs cannot creep into the bank and slow reverse remains free', () => {
  const water = shore();
  let position = at(0, 29.1); // Center is dry but the side of the body overlaps the bank.
  for (let i = 0; i < 180; i++) {
    position = water.resolve(position, at(eastOf(position) + 0.01, northOf(position) + 0.005), Math.PI / 2).position;
  }
  assert.ok(northOf(position) <= 29.10001);
  const back = water.resolve(at(0, 28), at(0, 27.999), 0);
  assert.equal(back.stopped, false);
  assert.ok(northOf(back.position) < 28);
});

test('shore clearance scales with the full car footprint', () => {
  for (const scale of [1, 3, 10]) {
    const hit = shore().resolve(at(0, -20), at(0, 50), 0, scale);
    assert.equal(hit.stopped, true);
    assert.ok(northOf(hit.position) + 2.6 * scale <= 30.001);
  }
});
