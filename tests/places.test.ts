import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placesFromSearch } from '../src/game/findPlaces.ts';

test('a searched city becomes a drivable place', () => {
  const [kazan] = placesFromSearch([{
    lat: '55.7946485', lon: '49.1115022', name: 'Казань',
    address: { state: 'Татарстан', country: 'Россия', country_code: 'ru' },
  }]);
  assert.equal(kazan.name, 'Казань');
  assert.equal(kazan.country, 'Россия');
  assert.equal(kazan.coords[0], 49.1115022);
  assert.equal(kazan.coords[1], 55.7946485);
  assert.equal(kazan.note, 'Татарстан · Россия');
});

test('known countries keep the names the architecture already understands', () => {
  const [paris] = placesFromSearch([{
    lat: '48.85', lon: '2.35', name: 'Paris',
    address: { country: 'France', country_code: 'fr' },
  }]);
  assert.equal(paris.country, 'France');
});

test('duplicate hits collapse', () => {
  const rows = [
    { lat: '48.85', lon: '2.35', name: 'Paris', address: { country_code: 'fr' } },
    { lat: '48.851', lon: '2.351', name: 'Paris', address: { country_code: 'fr' } },
  ];
  assert.equal(placesFromSearch(rows).length, 1);
});
