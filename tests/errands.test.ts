import assert from 'node:assert/strict';
import test from 'node:test';
import { COLLECT_BOXES, COLLECT_RADIUS_M, deliveryReward, scatterBoxes } from '../src/game/Errands.ts';
import { metersBetween, offsetPosition, type Position } from '../src/game/VehicleController.ts';
import { PreparedTransfer } from '../src/game/PreparedTransfer.ts';
import { missionAreas, missionRoadSpot, nearestOfEachKind } from '../src/game/missionPopulation.ts';

const center: Position = [37.6175, 55.7558];

test('transfers keep position and payment unchanged until destination geometry is ready', () => {
  const transfer = new PreparedTransfer();
  let position: Position = [...center], money = 500, commits = 0;
  const destination = offsetPosition(center, 9000, 4000) as Position;
  const commit = () => { position = destination; money -= 100; commits++; };
  assert.equal(transfer.begin(destination, commit, 100), true);
  assert.equal(transfer.begin(center, commit, 200), false);
  for (let now = 1000; now < 60000; now += 1000) transfer.tick(now, false);
  assert.deepEqual(position, center);
  assert.equal(money, 500);
  transfer.tick(60101, false);
  assert.equal(transfer.state, 'failed');
  transfer.tick(61000, true);
  assert.equal(commits, 0, 'a timed-out transfer cannot commit in the background');
  transfer.retry(62000);
  transfer.tick(62001, true);
  transfer.tick(62002, true);
  assert.deepEqual(position, destination);
  assert.equal(money, 400);
  assert.equal(commits, 1);
  assert.equal(transfer.state, null);
});

test('cancelling a transfer cannot later move or charge the player', () => {
  const transfer = new PreparedTransfer();
  transfer.begin(center, () => assert.fail('cancelled transfer committed'), 0);
  transfer.cancel();
  transfer.tick(100, true);
  assert.equal(transfer.pending, null);
});

test('events cover sixteen areas of the visible map on real roads, with no stacked starts', () => {
  const sw = offsetPosition(center, -2000, -1600), ne = offsetPosition(center, 2000, 1600);
  const bounds = { west: sw[0], south: sw[1], east: ne[0], north: ne[1] };
  const areas = missionAreas(bounds);
  const features = areas.map(area => ({ properties: { class: 'minor' }, geometry: {
    type: 'LineString', coordinates: [offsetPosition(area.at, -100, 0), offsetPosition(area.at, 100, 0)],
  } }));
  const pins: Position[] = [];
  for (const area of areas) {
    const pin = missionRoadSpot(features, area.at, area.radius, p => pins.every(other => metersBetween(p, other) >= area.gap));
    assert.ok(pin);
    pins.push(pin);
    assert.ok(metersBetween(pin, area.at) < 1);
  }
  assert.equal(pins.length, 16);
  for (const a of pins) for (const b of pins) if (a !== b) assert.ok(metersBetween(a, b) > 700);
  assert.equal(missionRoadSpot([], center, 1000, () => true), null, 'unloaded roads are retried, not replaced by invented positions');
  assert.equal(missionRoadSpot(features, center, 10000, () => false), null, 'water or otherwise forbidden positions are rejected');
});

test('each event pointer switches to the nearest start of its type as the car moves', () => {
  const east = offsetPosition(center, 2000, 0) as Position;
  const events = [
    { kind: 'race', position: center, id: 'west-race' },
    { kind: 'race', position: east, id: 'east-race' },
    { kind: 'collect', position: east, id: 'boxes' },
  ];
  assert.deepEqual(nearestOfEachKind(events, center).map(m => m.id), ['west-race', 'boxes']);
  assert.deepEqual(nearestOfEachKind(events, east).map(m => m.id), ['east-race', 'boxes']);
});

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
