import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placesFromSearch } from '../src/game/findPlaces.ts';
import { localityFromAddress } from '../src/game/placeLabel.ts';

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

test('search hits say what and where they are', () => {
  const [village] = placesFromSearch([{
    lat: '41.09', lon: '-7.8', name: 'Figueira', addresstype: 'village',
    address: { village: 'Figueira', city: 'Lamego', county: 'Viseu', country: 'Portugal', country_code: 'pt' },
  }], 'ru');
  assert.equal(village.note, 'Деревня · Lamego, Viseu, Portugal');
});

test('the HUD distinguishes a Newark neighbourhood from its city and state', () => {
  const place = localityFromAddress({ neighbourhood: 'Розвилл', city: 'Ньюарк', state: 'Нью-Джерси', country: 'Соединённые Штаты', country_code: 'us' }, 'ru')!;
  assert.equal(place.title, 'район Розвилл, г. Ньюарк');
  assert.equal(place.context, 'штат Нью-Джерси, США');
});

test('a town remains its own settlement rather than becoming a city district', () => {
  const place = localityFromAddress({ town: 'Харрисон', state: 'Нью-Джерси', country_code: 'us' }, 'ru')!;
  assert.equal(place.title, 'г. Харрисон');
  assert.equal(place.context, 'штат Нью-Джерси, США');
});

test('Manhattan retains both New York city and New York state', () => {
  const place = localityFromAddress({ suburb: 'Манхэттен', city: 'Нью-Йорк', state: 'Нью-Йорк', country_code: 'us' }, 'ru')!;
  assert.equal(place.title, 'район Манхэттен, г. Нью-Йорк');
  assert.equal(place.context, 'штат Нью-Йорк, США');
});

test('a rural hamlet keeps its type and receives the region and country', () => {
  const place = localityFromAddress({ hamlet: 'Lugar', state: 'Viseu', country: 'Portugal' }, 'pt')!;
  assert.equal(place.label, 'Lugar Lugar, Viseu, Portugal');
});

test('all useful administrative parents survive, without duplicating the city', () => {
  const place = localityFromAddress({ neighbourhood: 'Розвилл', city: 'Ньюарк', municipality: 'Ньюарк', county: 'Эссекс', state: 'Нью-Джерси', country_code: 'us' }, 'ru')!;
  assert.equal(place.context, 'штат Нью-Джерси, округ Эссекс, США');
});

test('a neighbourhood and a long parish name do not both expand the heading', () => {
  const place = localityFromAddress({ suburb: 'Santa Clara', city_district: 'Santa Clara e Castelo Viegas', city: 'Коимбра', state: 'Коимбра', country_code: 'pt' }, 'ru')!;
  assert.equal(place.title, 'район Santa Clara, г. Коимбра');
  assert.ok(!place.title.includes('Castelo Viegas'));
});
