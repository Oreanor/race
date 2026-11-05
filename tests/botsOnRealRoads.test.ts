import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { advanceTrafficBot, createTrafficBot, TrafficRoadNetwork } from '../src/game/TrafficBots.ts';
import { metersBetween } from '../src/game/VehicleController.ts';
import { cars, vehicleConfig } from '../src/config/vehicle.config.ts';
import type { MapFeature } from '../src/game/WaterCollisionController.ts';

// Behaviour, not mechanics: on the real streets of a city tile, a bot left to
// itself for a minute keeps driving and keeps to the roads.

const tile = { z: 14, x: 7808, y: 6190 };
const vt = new VectorTile(new PbfReader(readFileSync(new URL('./fixtures/coimbra-14-7808-6190.pbf', import.meta.url))));

function roads(): MapFeature[] {
  const layer = vt.layers.transportation;
  const out: MapFeature[] = [];
  for (let i = 0; i < layer.length; i++) out.push(layer.feature(i).toGeoJSON(tile.x, tile.y, tile.z) as unknown as MapFeature);
  return out;
}

test('a bot on real streets drives on for a minute and keeps to the roads', () => {
  const network = new TrafficRoadNetwork();
  network.addFeatures(roads());
  // the middle of the tile
  const centre: [number, number] = [(tile.x + 0.5) / 2 ** tile.z * 360 - 180, 0];
  const n = Math.PI - 2 * Math.PI * (tile.y + 0.5) / 2 ** tile.z;
  centre[1] = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  for (const seed of [1, 7, 42]) {
    const bot = createTrafficBot(`bot-${seed}`, 'Test', cars[1], network, centre, 0, new Set(), 'explore', seed);
    const config = { ...vehicleConfig, acceleration: bot.car.acceleration, maxSpeed: bot.car.maxSpeed };
    let offRoad = 0, samples = 0;
    let travelled = 0;
    let last = [...bot.position] as [number, number];
    for (let frame = 0; frame < 60 * 60; frame++) {
      advanceTrafficBot(bot, 1 / 60, network, config);
      if (frame % 30 === 0) {
        travelled += metersBetween(last, bot.position);
        last = [...bot.position] as [number, number];
        samples++;
        // close to the road graph (nodes are a few meters apart along every road)
        if (!network.nearest(bot.position, new Set(), 0, 25)) offRoad++;
      }
    }
    assert.ok(travelled > 300, `seed ${seed}: only ${travelled.toFixed(0)} m in a minute`);
    assert.ok(offRoad / samples < 0.05, `seed ${seed}: off the road ${offRoad} of ${samples} times`);
  }
});
