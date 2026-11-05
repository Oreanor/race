import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hubsFromFeatures, hubAt, kilometres, nearestHub, ticketPrice, TARIFF } from '../src/game/Travel.ts';

const lisbon: [number, number] = [-9.14517, 38.71923];
const newYork: [number, number] = [-73.98548, 40.75803];

test('price is kilometres times the tariff, flying costs more than train, train more than sailing', () => {
  const km = kilometres(lisbon, newYork);
  assert.ok(km > 5300 && km < 5500, String(km));
  assert.equal(ticketPrice(lisbon, newYork, 'port'), Math.round(km * TARIFF.port));
  assert.ok(ticketPrice(lisbon, newYork, 'station') > ticketPrice(lisbon, newYork, 'port'));
  assert.ok(ticketPrice(lisbon, newYork, 'airport') > ticketPrice(lisbon, newYork, 'station'));
  assert.equal(ticketPrice(lisbon, lisbon, 'port'), 50, 'minimum fare');
});

test('hubs: public airports, ferry terminals and railway stations; private strips, marinas, halts ignored; duplicates merged', () => {
  const point = (lng: number, lat: number, properties: Record<string, unknown>) => ({ geometry: { type: 'Point', coordinates: [lng, lat] }, properties });
  const hubs = hubsFromFeatures(
    [point(-9.1342, 38.7742, { class: 'international', iata: 'LIS' }), point(-9.1343, 38.7743, { class: 'international', iata: 'LIS' }), point(-9.0, 38.6, { class: 'private' })],
    [
      point(-9.1, 38.7, { class: 'ferry_terminal', subclass: 'ferry_terminal' }),
      point(-9.2, 38.69, { class: 'harbor', subclass: 'marina' }),
      point(-9.133, 38.714, { class: 'railway', subclass: 'station' }),
      point(-9.1331, 38.7141, { class: 'railway', subclass: 'station' }),
      point(-9.14, 38.72, { class: 'railway', subclass: 'halt' }),
      point(-9.15, 38.73, { class: 'railway', subclass: 'tram_stop' }),
      point(-9.16, 38.74, { class: 'aerialway', subclass: 'station' }),
    ],
  );
  assert.deepEqual(hubs.map((h) => h.kind).sort(), ['airport', 'port', 'station']);
  assert.equal(hubAt([-9.1345, 38.7744], hubs)?.kind, 'airport');
  assert.equal(hubAt([-9.2, 38.69], hubs), null);
  assert.equal(hubAt([-9.133, 38.714], hubs)?.kind, 'station');
  assert.equal(nearestHub([-9.1, 38.701], hubs)?.hub.kind, 'port');
});
