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
