import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildTile, clipRing } from '../src/world3d/tiles/buildTile.ts';
import { LocalFrame, tileAt, tileCorner, tileSpan, mercatorX, mercatorY } from '../src/world3d/mercator.ts';
import { tilesAround } from '../src/world3d/tiles/tilePlan.ts';

const COIMBRA: [number, number] = [-8.42922, 40.20805];
const tile = { z: 14, x: 7808, y: 6190 };
const pbf = readFileSync(new URL('./fixtures/coimbra-14-7808-6190.pbf', import.meta.url));

test('Coimbra centre falls into the fixture tile', () => {
  assert.deepEqual(tileAt(COIMBRA[0], COIMBRA[1], 14), tile);
  const [cx, cy] = tileCorner(tile);
  const span = tileSpan(14);
  assert.ok(mercatorX(COIMBRA[0]) >= cx && mercatorX(COIMBRA[0]) <= cx + span);
  assert.ok(mercatorY(COIMBRA[1]) <= cy && mercatorY(COIMBRA[1]) >= cy - span);
});

test('local frame round-trips and measures true meters', () => {
  const frame = new LocalFrame(COIMBRA);
  const p = frame.fromLngLat([COIMBRA[0] + 0.001, COIMBRA[1] + 0.001]);
  const back = frame.toLngLat(p.x, p.z);
  assert.ok(Math.abs(back[0] - COIMBRA[0] - 0.001) < 1e-9);
  assert.ok(Math.abs(back[1] - COIMBRA[1] - 0.001) < 1e-9);
  // 0.001° of latitude ≈ 111.3 m, longitude ≈ 85.1 m at 40.2° N
  assert.ok(Math.abs(-p.z - 111.3) < 0.5, String(p.z));
  assert.ok(Math.abs(p.x - 85.06) < 0.5, String(p.x));
});

test('clipping keeps a ring inside the tile square', () => {
  const ring = clipRing([[-10, -10], [50, -10], [50, 50], [-10, 50]], 40);
  for (const [x, y] of ring) assert.ok(x >= 0 && x <= 40 && y >= 0 && y <= 40);
  assert.equal(ring.length, 4);
});

test('Coimbra tile decodes into batched chunks with real heights', () => {
  const data = buildTile(pbf, tile, { chunks: 4, windows: true });
  assert.ok(data.stats.buildings > 1000, `buildings ${data.stats.buildings}`);
  assert.ok(data.chunks.length > 0 && data.chunks.length <= 16);
  const span = tileSpan(14);
  let tallest = 0;
  for (const chunk of data.chunks) {
    assert.equal(chunk.positions.length % 3, 0);
    assert.equal(chunk.facade.length, chunk.positions.length);
    assert.equal(chunk.windows.axes.length, chunk.windows.count * 4);
    assert.equal(chunk.windows.offsets.length, chunk.windows.count * 4);
    const vertices = chunk.positions.length / 3;
    for (const i of chunk.index) assert.ok(i < vertices);
    for (let i = 0; i < chunk.positions.length; i += 3) {
      const x = chunk.positions[i], y = chunk.positions[i + 1], z = chunk.positions[i + 2];
      assert.ok(x >= -1e-3 && x <= span + 1e-3 && z >= -1e-3 && z <= span + 1e-3, 'vertex outside tile');
      assert.ok(Number.isFinite(y));
      tallest = Math.max(tallest, y);
    }
  }
  assert.ok(tallest > 20 && tallest < 200, `tallest ${tallest}`);
  assert.ok(data.stats.windows > 1000);
  assert.ok(Math.abs(data.metersScale - Math.cos(40.2 * Math.PI / 180)) < 0.01);
});

test('walls face outward', () => {
  const data = buildTile(pbf, tile, { chunks: 1, windows: false });
  const c = data.chunks[0];
  let good = 0, bad = 0;
  for (let t = 0; t < c.index.length; t += 3) {
    const a = c.index[t] * 3, b = c.index[t + 1] * 3, d = c.index[t + 2] * 3;
    const ux = c.positions[b] - c.positions[a], uy = c.positions[b + 1] - c.positions[a + 1], uz = c.positions[b + 2] - c.positions[a + 2];
    const vx = c.positions[d] - c.positions[a], vy = c.positions[d + 1] - c.positions[a + 1], vz = c.positions[d + 2] - c.positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const dot = nx * c.normals[a] + ny * c.normals[a + 1] + nz * c.normals[a + 2];
    if (Math.hypot(nx, ny, nz) < 1e-9) continue;
    if (dot > 0) good++; else bad++;
  }
  assert.ok(bad / (good + bad) < 0.01, `bad ${bad} of ${good + bad}`);
});

test('tile plan orders tiles by distance and respects the radius', () => {
  const plan = tilesAround(COIMBRA, 1500, 14);
  assert.deepEqual(plan[0].tile, tile);
  for (let i = 1; i < plan.length; i++) assert.ok(plan[i].distance >= plan[i - 1].distance);
  assert.ok(plan.length >= 2 && plan.length <= 9, String(plan.length));
});

test('footprints index every building with closed ring ranges', () => {
  const data = buildTile(pbf, tile, { chunks: 4, windows: false });
  const f = data.footprints;
  const count = f.buildingStart.length - 1;
  assert.equal(count, data.stats.buildings);
  assert.equal(f.bounds.length, count * 4);
  assert.equal(f.ringStart[f.ringStart.length - 1] * 2, f.coords.length);
  for (let b = 0; b < count; b++) {
    const r0 = f.buildingStart[b], r1 = f.buildingStart[b + 1];
    assert.ok(r1 > r0);
    for (let r = r0; r < r1; r++) assert.ok(f.ringStart[r + 1] - f.ringStart[r] >= 3);
  }
});

test('world tile: terrain, roads facing up, gameplay features and raw data kept', async () => {
  const { buildWorldTile, GAMEPLAY_LAYERS } = await import('../src/world3d/tiles/worldTile.ts');
  const raw = pbf.buffer.slice(pbf.byteOffset, pbf.byteOffset + pbf.byteLength) as ArrayBuffer;
  const dem = new Float32Array(256 * 256).fill(50);
  const data = buildWorldTile(raw, tile, { dem, chunks: 4, inset: 0, grid: 32, region: 'Portugal' });
  // detailed look: window grids on walls, roof props exist
  let withWindows = 0;
  for (const c of data.buildings.chunks) {
    for (let i = 0; i < c.win.length; i += 4) if (c.win[i] > 0) withWindows++;
    assert.equal(c.win.length / 4, c.positions.length / 3);
    assert.equal(c.winSize.length / 2, c.positions.length / 3);
  }
  assert.ok(withWindows > 1000, `wall vertices with windows: ${withWindows}`);
  assert.ok(data.buildings.accents.chimney.count + data.buildings.accents.vent.count > 50);
  for (const name of GAMEPLAY_LAYERS) assert.ok(Array.isArray(data.features[name]), name);
  assert.ok(data.features.building.length > 0 && data.features.transportation.length > 100);
  assert.ok(data.layers.includes('poi') && data.layers.includes('housenumber'));
  assert.ok(data.raw.byteLength > 1000);
  const r = data.roads;
  assert.ok(r.index.length > 3000);
  let up = 0, down = 0;
  for (let t = 0; t < r.index.length; t += 3) {
    const a = r.index[t] * 3, b = r.index[t + 1] * 3, c = r.index[t + 2] * 3;
    const cross = (r.positions[b] - r.positions[a]) * (r.positions[c + 2] - r.positions[a + 2]) - (r.positions[b + 2] - r.positions[a + 2]) * (r.positions[c] - r.positions[a]);
    if (Math.abs(cross) < 1e-9) continue;
    if (cross < 0) up++; else down++;
  }
  assert.equal(down, 0, `downward road triangles: ${down} of ${up + down}`);
  assert.ok(r.ground.every((g) => g === 50));
  assert.ok(data.buildings.chunks.every((c) => c.ground.every((g) => g === 50)));
});
