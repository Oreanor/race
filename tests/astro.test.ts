import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moonIllumination, sunPosition, skyDirection } from '../src/world3d/astro.ts';

const deg = 180 / Math.PI;

test('sun is high and south at solar noon in Coimbra in summer, below the horizon at midnight', () => {
  // 21 June 2026, ~13:35 UTC is solar noon at 8.43° W
  const noon = sunPosition(new Date(Date.UTC(2026, 5, 21, 12, 34)), 40.2, -8.43);
  assert.ok(noon.altitude * deg > 70 && noon.altitude * deg < 74, String(noon.altitude * deg));
  assert.ok(Math.abs(noon.azimuth * deg - 180) < 8, String(noon.azimuth * deg));
  const night = sunPosition(new Date(Date.UTC(2026, 5, 21, 0, 34)), 40.2, -8.43);
  assert.ok(night.altitude < 0);
  const [x, y, z] = skyDirection(noon);
  assert.ok(y > 0.9 && z > 0 && Math.abs(x) < 0.15, 'south is +z in scene space');
});

test('moon phase: full and new moons', () => {
  const full = moonIllumination(new Date(Date.UTC(2026, 0, 3, 10, 3))); // full moon 3 Jan 2026
  assert.ok(full.fraction > 0.98 && Math.abs(full.phase - 0.5) < 0.03, JSON.stringify(full));
  const fresh = moonIllumination(new Date(Date.UTC(2026, 0, 18, 19, 52))); // new moon 18 Jan 2026
  assert.ok(fresh.fraction < 0.02, JSON.stringify(fresh));
});

test('time of the place, not of the player', async () => {
  const { placeClock, placeMoment } = await import('../src/world3d/placeTime.ts');
  const noonUtc = new Date('2026-11-04T12:00:00Z');
  assert.equal(placeClock(noonUtc, 40.2, -8.42), '12:00'); // Coimbra, winter time
  assert.equal(placeClock(noonUtc, 55.75, 37.6), '15:00'); // Moscow
  assert.equal(placeMoment(noonUtc, 55.75, 37.6, 22, 30).toISOString(), '2026-11-04T19:30:00.000Z');
  assert.equal(placeClock(new Date('2026-07-01T12:00:00Z'), 40.2, -8.42), '13:00'); // summer time
});

test('season of the place: hemisphere and tropics', async () => {
  const { seasonAt } = await import('../src/world3d/seasons.ts');
  const nov = new Date('2026-11-04T12:00:00Z');
  assert.equal(seasonAt(nov, 40.2), 'autumn'); // Coimbra
  assert.equal(seasonAt(nov, -33.9), 'spring'); // Sydney
  assert.equal(seasonAt(nov, 1.3), 'summer'); // Singapore: always green
  assert.equal(seasonAt(new Date('2026-01-20T12:00:00Z'), 55.75), 'winter');
  assert.equal(seasonAt(new Date('2026-04-15T12:00:00Z'), 48.85), 'spring');
});
