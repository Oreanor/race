import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { RaceProgress, raceCourse, type RaceCourse } from '../src/game/RaceCourse.ts';
import { TrafficRoadNetwork, createTrafficBot, steerTrafficBot } from '../src/game/TrafficBots.ts';
import { metersBetween, offsetPosition, type Position } from '../src/game/VehicleController.ts';
import { cars } from '../src/config/vehicle.config.ts';

const center: Position = [-8.42, 40.2];
const at = (x: number, y: number) => offsetPosition(center, x, y);
const zigzag = [at(0, 0), at(900, 500), at(0, 1000), at(900, 1500), at(0, 2000), at(900, 2500), at(0, 3000)];
const course = raceCourse(center, zigzag.slice(1).map((p, i) => [zigzag[i], p]))!;

function verify(plan: RaceCourse) {
  assert.equal(plan.checkpoints.length, 5);
  assert.equal(plan.legs.length, 6);
  assert.ok(plan.meters >= 5000);
  const gates = [plan.start, ...plan.checkpoints, plan.finish];
  let direct = 0;
  for (let i = 1; i < gates.length; i++) {
    direct += metersBetween(gates[i - 1], gates[i]);
    assert.deepEqual(plan.legs[i - 1].at(-1), gates[i]);
    assert.ok(metersBetween(plan.legs[i - 1][0], gates[i - 1]) < 120);
    for (let j = 0; j < i; j++) assert.ok(metersBetween(gates[j], gates[i]) > 250);
  }
  assert.ok(direct >= 5000, 'shortcut distance through all gates is also at least 5 km');
  assert.ok(raceCourse(plan.start, plan.legs), 'the plan passes the non-collinearity check');
}

test('five ordered checkpoints and a separate finish cannot be replaced by a straight sprint', () => {
  verify(course);
  const straight = Array.from({ length: 7 }, (_, i) => at(i * 1000, 0));
  assert.equal(raceCourse(center, straight.slice(1).map((p, i) => [straight[i], p])), null);
  assert.equal(raceCourse(center, [[center, at(1000, 0)]]), null);
});

test('each racer must pass all five checkpoints in order before the finish counts', () => {
  const progress = new RaceProgress(course, [{ id: 'player', position: center }, { id: 'bot', position: center }]);
  progress.update('player', course.finish);
  assert.equal(progress.passed('player'), 0);
  assert.equal(progress.finished('player'), false);
  for (let i = 0; i < 5; i++) {
    assert.equal(progress.update('player', course.checkpoints[i]), true);
    assert.equal(progress.passed('player'), i + 1);
    assert.equal(progress.finished('player'), false);
    assert.equal(progress.passed('bot'), 0);
  }
  assert.deepEqual(progress.target('player'), course.finish);
  assert.equal(progress.update('player', course.finish), true);
  assert.equal(progress.finished('player'), true);
  assert.equal(progress.finished('bot'), false);
});

test('a fast frame crosses a checkpoint even when neither frame endpoint is inside its radius', () => {
  const p = course.checkpoints[0];
  const progress = new RaceProgress(course, [{ id: 'player', position: offsetPosition(p, -50, 0) }]);
  assert.equal(progress.update('player', offsetPosition(p, 50, 0)), true);
  assert.equal(progress.passed('player'), 1);
  const teleport = new RaceProgress(course, [{ id: 'player', position: offsetPosition(p, -500, 0) }]);
  assert.equal(teleport.update('player', offsetPosition(p, 500, 0)), false);
});

function finishPlan(plan: Generator<null, RaceCourse | null>) {
  let step;
  do { step = plan.next(); } while (!step.done);
  return step.value;
}

test('city-road courses are connected, 5 km or longer, and bend through five checkpoints', () => {
  const network = new TrafficRoadNetwork();
  for (let v = -2400; v <= 2400; v += 300) {
    const horizontal: Position[] = [], vertical: Position[] = [];
    for (let u = -2400; u <= 2400; u += 300) { horizontal.push(at(u, v)); vertical.push(at(v, u)); }
    network.addFeatures([horizontal, vertical].map(coordinates => ({ properties: { class: 'minor' }, geometry: { type: 'LineString', coordinates } })));
  }
  for (const seed of [1, 2, 3, 4]) {
    const plan = finishPlan(network.planRace(center, 0, seed));
    assert.ok(plan, `seed ${seed} should find a winding course`);
    verify(plan);
  }
  assert.equal(finishPlan(network.planRace(center, 0, 1, () => false)), null, 'no invented gates in unloaded places');
  const straight = new TrafficRoadNetwork();
  straight.addFeatures([{ properties: { class: 'minor' }, geometry: { type: 'LineString', coordinates: [at(-6000, 0), at(6000, 0)] } }]);
  assert.equal(finishPlan(straight.planRace(center, Math.PI / 2, 1)), null);
});

test('a winding course can be built on the real Coimbra road graph', () => {
  const tile = new VectorTile(new PbfReader(readFileSync(new URL('./fixtures/coimbra-14-7808-6190.pbf', import.meta.url))));
  const network = new TrafficRoadNetwork();
  const roads = tile.layers.transportation;
  network.addFeatures(Array.from({ length: roads.length }, (_, i) => roads.feature(i).toGeoJSON(7808, 6190, 14)));
  const plan = [1, 3, 4].map(seed => finishPlan(network.planRace([-8.418, 40.209], 0, seed))).find(Boolean);
  assert.ok(plan);
  verify(plan);
});

test('race bots keep their required gate instead of switching to nearby cars or wandering 60 m before it', () => {
  const network = new TrafficRoadNetwork();
  network.addFeatures([{ properties: { class: 'minor' }, geometry: { type: 'LineString', coordinates: [center, at(1000, 0)] } }]);
  const bot = createTrafficBot('race-0', 'Racer', cars[0], network, center, Math.PI / 2, new Set(), 'explore', 1);
  bot.goal = offsetPosition(bot.position, 30, 0);
  const target = [...bot.goal];
  bot.goalLocked = true;
  steerTrafficBot(bot, network, [{ id: 'player', position: offsetPosition(bot.position, 5, 0), alive: true }]);
  assert.deepEqual(bot.goal, target);
  steerTrafficBot(bot, network, []);
  assert.deepEqual(bot.goal, target);
});
