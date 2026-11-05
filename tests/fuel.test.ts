import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { FuelTank, stationsFromFeatures, nearestStation, atStation, FUEL_PRICE } from '../src/game/Fuel.ts';

test('tank burns by distance, more with boost, never below zero', () => {
  const tank = new FuelTank({ tank: 40, perKm: 2 });
  tank.burn(1000, 0, false);
  assert.ok(Math.abs(tank.level - 38) < 1e-9);
  tank.burn(1000, 0, true);
  assert.ok(Math.abs(tank.level - 34.4) < 1e-9);
  tank.burn(1e6, 0, false);
  assert.equal(tank.level, 0);
  assert.ok(tank.empty);
});

test('refuelling costs one coin per litre and stops at the tank or the wallet', () => {
  const tank = new FuelTank({ tank: 40, perKm: 2 }, 0.5);
  const paid = tank.refuel(10, 5);
  assert.equal(paid.litres, 5);
  assert.equal(paid.cost, 5 * FUEL_PRICE);
  const full = tank.refuel(100, 1000);
  assert.equal(tank.level, 40);
  assert.equal(full.litres, 15);
});

test('changing car keeps the tank share', () => {
  const tank = new FuelTank({ tank: 40, perKm: 2 }, 0.25);
  tank.changeSpec({ tank: 80, perKm: 3 });
  assert.equal(tank.level, 20);
});

test('real Coimbra tile has fuel stations, deduplicated and searchable', () => {
  const vt = new VectorTile(new PbfReader(readFileSync(new URL('./fixtures/coimbra-14-7808-6190.pbf', import.meta.url))));
  const poi = vt.layers.poi;
  const features = Array.from({ length: poi.length }, (_, i) => poi.feature(i).toGeoJSON(7808, 6190, 14));
  const stations = stationsFromFeatures([...features, ...features] as never);
  assert.equal(stations.length, 4, 'four petrol stations in the tile, EV chargers excluded');
  const unique = stationsFromFeatures(features as never);
  assert.equal(stations.length, unique.length);
  const near = nearestStation([-8.42922, 40.20805], stations)!;
  assert.ok(near.distance > 0 && near.distance < 3000);
  assert.equal(atStation(near.station.position, stations)?.id, near.station.id);
  // street-side approach: still counts when a few dozen metres off the POI
  const beside: [number, number] = [near.station.position[0] + 0.00035, near.station.position[1]];
  assert.ok(atStation(beside, stations), 'reachable from the forecourt / street, not only on the shop point');
});
