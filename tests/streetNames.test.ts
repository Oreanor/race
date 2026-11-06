import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { streetLabelsNear } from '../src/game/streetNames.ts';
import type { MapFeature } from '../src/game/WaterCollisionController.ts';

test('street labels pick sparse major names from transportation_name', () => {
  const vt = new VectorTile(new PbfReader(readFileSync(new URL('./fixtures/coimbra-14-7808-6190.pbf', import.meta.url))));
  const layer = vt.layers.transportation_name;
  const features: MapFeature[] = [];
  for (let i = 0; i < layer.length; i++) {
    features.push(layer.feature(i).toGeoJSON(7808, 6190, 14) as unknown as MapFeature);
  }
  // tile centre-ish
  const here: [number, number] = [-8.429, 40.208];
  const labels = streetLabelsNear(features, here, { reach: 2500, limit: 12, minLength: 40 });
  assert.ok(labels.length > 0, 'expected some major street labels');
  assert.ok(labels.length <= 12);
  const names = new Set(labels.map((l) => l.name));
  assert.equal(names.size, labels.length, 'one label per name');
  for (const label of labels) {
    assert.ok(label.name.length >= 2);
    assert.ok(Number.isFinite(label.heading));
  }
});
