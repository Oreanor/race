import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildTile, clipRing, omitBorderWall } from '../src/world3d/tiles/buildTile.ts';
import { tileAt, tileCorner, tileSpan, mercatorX, mercatorY } from '../src/world3d/mercator.ts';
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

test('clipping keeps a ring inside the tile square', () => {
  const ring = clipRing([[-10, -10], [50, -10], [50, 50], [-10, 50]], 40);
  for (const [x, y] of ring) assert.ok(x >= 0 && x <= 40 && y >= 0 && y <= 40);
  assert.equal(ring.length, 4);
});

test('clip seams: min edges keep a sealing wall, max edges defer to the neighbour', () => {
  const e = 100;
  assert.equal(omitBorderWall([0, 10], [0, 40], e), false, 'west (x=0) kept');
  assert.equal(omitBorderWall([10, 0], [40, 0], e), false, 'north (y=0) kept');
  assert.equal(omitBorderWall([e, 10], [e, 40], e), true, 'east (x=extent) omitted');
  assert.equal(omitBorderWall([10, e], [40, e], e), true, 'south (y=extent) omitted');
  assert.equal(omitBorderWall([10, 20], [40, 20], e), false, 'interior kept');
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
  const data = buildTile(pbf, tile, { chunks: 4, windows: false, detailed: { region: 'Portugal' } });
  const f = data.footprints;
  const count = f.buildingStart.length - 1;
  assert.equal(count, data.stats.buildings);
  assert.equal(f.bounds.length, count * 4);
  assert.equal(f.roofs.length, count * 8);
  assert.equal(f.ringStart[f.ringStart.length - 1] * 2, f.coords.length);
  let pitched = 0;
  for (let b = 0; b < count; b++) {
    const r0 = f.buildingStart[b], r1 = f.buildingStart[b + 1];
    assert.ok(r1 > r0);
    for (let r = r0; r < r1; r++) assert.ok(f.ringStart[r + 1] - f.ringStart[r] >= 3);
    const o = b * 8;
    assert.ok(f.roofs[o + 1] >= f.roofs[o] - 1e-6); // peak ≥ eaves
    assert.ok(Math.abs(f.heights[b] - f.roofs[o + 1]) < 1e-4); // height stores the peak
    if (f.roofs[o + 6] > 0) pitched++;
  }
  assert.ok(pitched > 0, 'some houses carry a pitched roof profile');
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
    if (r.positions[a + 1] < 0) continue; // under a bridge deck: its underside faces down
    if (cross < 0) up++; else down++;
  }
  assert.equal(down, 0, `downward road triangles: ${down} of ${up + down}`);
  // roads follow the ground or sit just above nearby water; bridge decks stand a few meters over it
  assert.ok(r.ground.every((g) => g >= 47 && g <= 58), `road ground out of range`);
  assert.ok(data.buildings.chunks.every((c) => c.ground.every((g) => g === 50)));
  // vector ground: land use drawn as polygons, flat water at bank level, beds carved below
  const g = data.ground;
  assert.ok(g.layers.reduce((n, l) => n + l.index.length, 0) > 3000);
  // flat at the level; along the banks it may hug the ground a finger above it
  assert.ok(g.water.index.length > 100 && g.water.ground.every((h) => h >= 50 - 1e-3 && h < 50.06));
  assert.ok(g.water.shore && g.water.shore.length === g.water.ground.length);
  assert.ok(g.heights.some((h) => h < 49), 'water beds are carved');
  assert.ok(g.waterLevel.some((h) => Number.isFinite(h)), 'water surface levels recorded');
  assert.ok(data.bridges.length % 7 === 0);
});

test('bridge decks are only under the ribbon, not a parallel lower road', async () => {
  const { bridgeDeck } = await import('../src/world3d/tiles/worldTile.ts');
  // one span at height 70, half-width 5 — a car 8 m aside must stay on the ground
  const bridges = Float32Array.from([0, 0, 40, 0, 5, 70, 70]);
  assert.equal(bridgeDeck(bridges, 20, 0), 70);
  assert.equal(bridgeDeck(bridges, 20, 5.2), 70);
  assert.equal(bridgeDeck(bridges, 20, 8), null);
});

test('overpass: car under the deck stays on the ground; car on the deck stays up', async () => {
  const { pickDriveHeight } = await import('../src/world3d/tiles/worldTile.ts');
  assert.equal(pickDriveHeight(10, 20, 10.5), 10, 'underpass');
  assert.equal(pickDriveHeight(10, 20, 19), 20, 'on the bridge');
  assert.equal(pickDriveHeight(10, 20), 10, 'no altitude hint → ground');
  assert.equal(pickDriveHeight(10, 10.5, 10), 10.5, 'barely raised → one surface');
});

test('coplanar walls: the taller keeps the shared stretch, the rest of the lower one survives', async () => {
  const { cutCoveredWalls } = await import('../src/world3d/tiles/wallCut.ts');
  const tall = { ax: 0, az: 0, bx: 10, bz: 0, y0: 0, y1: 20, order: 0 };
  const low = { ax: 6, az: 0.01, bx: 16, bz: 0.01, y0: 0, y1: 9, order: 1 };   // overlaps 6..10
  const twin = { ax: 10, az: 0, bx: 0, bz: 0, y0: 0, y1: 20, order: 2 };       // exact duplicate, reversed
  const pieces = cutCoveredWalls([tall, low, twin]);
  const of = (w: object) => pieces.filter((p) => p.wall === w);
  assert.equal(of(tall).length, 1);
  assert.equal(of(twin).length, 0, 'duplicate removed');
  assert.equal(of(low).length, 1);
  assert.ok(Math.abs(of(low)[0].t0 - 0.4) < 1e-6 && of(low)[0].t1 === 1, 'only 10..16 of the low wall remains');
});

test('grid under a road is smoothed, slopes and tile borders are kept', async () => {
  const { flattenUnderRoads, roadMask } = await import('../src/world3d/tiles/groundVector.ts');
  const grid = 10, n = grid + 1, cs = 10;
  const H = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) H[j * n + i] = i * 0.5; // steady slope
  H[5 * n + 5] += 3; // DEM lump on the road
  const border = H[5 * n];
  const dry = new Uint8Array(n * n);
  flattenUnderRoads(H, grid, roadMask(grid, cs, [0, 50, 100, 50, 3]), dry, 6);
  assert.ok(Math.abs(H[5 * n + 5] - 2.5) < 0.6, `lump flattened, got ${H[5 * n + 5]}`);
  assert.ok(Math.abs(H[5 * n + 3] - 1.5) < 0.6, 'slope kept along the road');
  assert.equal(H[5 * n], border, 'tile border untouched');
  assert.equal(H[1 * n + 5], 2.5, 'far from the road untouched');
});
