import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecipe, HOUSE_PALETTE, indexFor, portuguesePastel } from '../src/game/buildings/BuildingStyles.ts';
import { facadeBands, layoutFacade, pieceExtents } from '../src/game/buildings/FacadeGenerator.ts';
import { buildRoof, canPitch } from '../src/game/buildings/RoofGenerator.ts';
import { PIECES } from '../src/game/buildings/pieces.ts';
import { buildingStyleKey, primaryTileSeam } from '../src/game/buildings/wallOverlap.ts';
import { clusterBuildingStyleKeys, isSeamStyleKey } from '../src/game/buildings/buildingStyleCluster.ts';

const palette = ['#f0c43a', '#7a6fe0', '#4aa3e8', '#ef6f93', '#f08a3c', '#63c47a'];

function recipe(height: number, key = 'house-1') {
  return createRecipe({ id: 42, key, height, base: 0 }, palette, 'european', 'Portugal');
}

test('floor bands fill the wall and keep window rows whole', () => {
  for (const height of [5, 7.5, 10, 11.2, 18]) {
    const bands = facadeBands(13.7, 0, 0, height);
    const span = bands.reduce((sum, band) => sum + (band.y1 - band.y0), 0);
    assert.ok(Math.abs(span - height) < 1e-6, `bands cover ${height}`);
    const windows = bands.filter((band) => band.mode === 'windows');
    assert.ok(windows.length >= 1);
    const top = Math.max(...windows.map((band) => band.y1));
    assert.ok(top <= height - 0.15, `window rows end below the roof at height ${height}`);
    for (const band of windows) assert.ok(band.y1 - band.y0 >= 2.15);
  }
});

test('a sloping base does not pull windows below the higher corner', () => {
  const bands = facadeBands(12, 0, 3.2, 11);
  for (const band of bands.filter((item) => item.mode === 'windows')) assert.ok(band.y0 >= 3.2 - 1e-6);
});

test('windows and doors stay inside the facade', () => {
  const plan = recipe(11.2);
  const placed = layoutFacade(13.7, 0, 0, 11.2, plan, { lod: 0, detail: 'high', door: true, front: true, downspout: true });
  const windows = placed.filter((piece) => piece.mesh === 'window' || piece.mesh === 'glass');
  assert.ok(windows.length >= 4);
  const rows = new Set(windows.filter((piece) => piece.mesh === 'window').map((piece) => piece.y.toFixed(2)));
  assert.ok(rows.size >= 2);
  for (const piece of placed) {
    const box = pieceExtents(piece);
    assert.ok(box.x0 >= -0.05, piece.mesh);
    assert.ok(box.x1 <= 13.75, piece.mesh);
    assert.ok(box.y0 >= -0.05, `${piece.mesh} bottom ${box.y0}`);
    assert.ok(box.y1 <= 11.28, `${piece.mesh} top ${box.y1}`);
  }
  const tops = windows.filter((piece) => piece.mesh === 'window').map((piece) => pieceExtents(piece).y1);
  assert.ok(Math.max(...tops) <= 11.2 - 0.08);
});

test('short walls and odd heights do not emit a partial window', () => {
  const plan = recipe(9.1, 'short');
  assert.equal(layoutFacade(1.2, 0, 0, 9.1, plan, { lod: 0, detail: 'high', door: false, front: false, downspout: false }).some((piece) => piece.mesh === 'window'), false);
  const odd = layoutFacade(6.4, 0.4, 1.8, 9.1, plan, { lod: 0, detail: 'medium', door: true, front: true, downspout: false });
  for (const piece of odd) {
    const box = pieceExtents(piece);
    assert.ok(box.y0 >= 1.8 - 0.05);
    assert.ok(box.y1 <= 9.18);
    assert.ok(box.x0 >= -0.05 && box.x1 <= 6.45);
  }
});

test('buildings use the Portuguese Pastel palette on walls, roofs and windows', () => {
  let pitched = 0;
  const walls = new Set<string>();
  const roofs = new Set<string>();
  const windows = new Set<string>();
  for (let n = 0; n < 40; n++) {
    const made = createRecipe({ id: n, key: `house-${n}`, height: 12, base: 0 }, HOUSE_PALETTE, 'european', 'Portugal');
    assert.ok(HOUSE_PALETTE.includes(made.colors.wall as typeof HOUSE_PALETTE[number]));
    assert.ok(portuguesePastel.roofColors.includes(made.colors.roof as typeof portuguesePastel.roofColors[number]));
    assert.ok(portuguesePastel.windowColors.includes(made.colors.glass as typeof portuguesePastel.windowColors[number]));
    assert.equal(made.colors.frame, portuguesePastel.frameColor);
    walls.add(made.colors.wall);
    roofs.add(made.colors.roof);
    windows.add(made.colors.glass);
    if (made.roofKind !== 'flat') pitched++;
  }
  assert.ok(pitched > 20);
  assert.deepEqual([...walls].sort(), [...HOUSE_PALETTE].sort());
  assert.deepEqual([...roofs].sort(), [...portuguesePastel.roofColors].sort());
  assert.deepEqual([...windows].sort(), [...portuguesePastel.windowColors].sort());
});

test('the same building keeps its style after a reload', () => {
  const first = createRecipe({ id: 7, key: '7:10:1:2', height: 14, base: 0, kind: 'house' }, palette, 'auto', 'Portugal');
  const second = createRecipe({ id: 7, key: '7:10:1:2', height: 14, base: 0, kind: 'house' }, palette, 'auto', 'Portugal');
  assert.deepEqual(first, second);
  assert.equal(createRecipe({ id: 7, key: '7:10:1:2', height: 14, base: 0 }, palette, 'portuguese', 'Portugal').style, 'portuguese');
});

test('tile-split halves share a style key via the seam cell', () => {
  const leftSeam: [number, number][] = [[-8.41, 40.20], [-8.41, 40.2005], [-8.41, 40.201]];
  const rightSeam: [number, number][] = [[-8.41, 40.20], [-8.41, 40.201]];
  const left: [number, number][] = [[-8.412, 40.20], ...leftSeam, [-8.412, 40.201]];
  const right: [number, number][] = [...rightSeam, [-8.408, 40.201], [-8.408, 40.20]];
  assert.equal(buildingStyleKey(12, 0, left, leftSeam), buildingStyleKey(12, 0, right, rightSeam));
  // Far-apart interiors stay distinct cells
  const far: [number, number][] = [[-8.5, 40.5], [-8.49, 40.5], [-8.49, 40.51], [-8.5, 40.51]];
  assert.notEqual(buildingStyleKey(12, 0, left), buildingStyleKey(12, 0, far));
});

test('long tile cut agrees when each half samples a different stretch', () => {
  const southHeavy: [number, number][] = [[-8.41, 40.20], [-8.41, 40.2002], [-8.41, 40.2004], [-8.41, 40.201]];
  const northHeavy: [number, number][] = [[-8.41, 40.20], [-8.41, 40.2006], [-8.41, 40.2008], [-8.41, 40.201]];
  assert.equal(buildingStyleKey(20, 0, southHeavy, southHeavy), buildingStyleKey(20, 0, northHeavy, northHeavy));
});

test('abutting footprints share the largest part style key', () => {
  const a = {
    id: 'a', height: 12, area: 200,
    ring: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 20 }, { x: 0, y: 20 }],
    styleKey: '0:0.0:c1,1',
  };
  const b = {
    id: 'b', height: 14, area: 400,
    ring: [{ x: 10, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 20 }, { x: 10, y: 20 }],
    styleKey: '0:0.0:c2,2',
  };
  const map = clusterBuildingStyleKeys([a, b], { pxToMeters: 1 });
  assert.equal(map.get('a'), '0:0.0:c2,2');
  assert.equal(map.get('b'), '0:0.0:c2,2');
});

test('cluster keeps a seam key over a larger interior footprint', () => {
  const seamKey = '0:0.0:s10,20';
  assert.ok(isSeamStyleKey(seamKey));
  const seam = {
    id: 'seam', height: 12, area: 50,
    ring: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }],
    styleKey: seamKey,
  };
  const interior = {
    id: 'in', height: 12, area: 500,
    ring: [{ x: 10, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 5 }, { x: 10, y: 5 }],
    styleKey: '0:0.0:c99,99',
  };
  const map = clusterBuildingStyleKeys([seam, interior], { pxToMeters: 1 });
  assert.equal(map.get('seam'), seamKey);
  assert.equal(map.get('in'), seamKey);
});

test('near footprints without a shared edge still merge by proximity', () => {
  const a = {
    id: 'a', height: 10, area: 100,
    ring: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
    styleKey: '0:0.0:c1,1',
  };
  // 5 px gap, pxToMeters=1 → 5 m < 15 m proximity
  const b = {
    id: 'b', height: 11, area: 100,
    ring: [{ x: 15, y: 0 }, { x: 25, y: 0 }, { x: 25, y: 10 }, { x: 15, y: 10 }],
    styleKey: '0:0.0:c9,9',
  };
  const map = clusterBuildingStyleKeys([a, b], { pxToMeters: 1 });
  assert.equal(map.get('a'), map.get('b'));
});

test('seam style keys ignore height so tile halves match', () => {
  const cut: [number, number][] = [[-8.41, 40.20], [-8.41, 40.201]];
  assert.equal(buildingStyleKey(10, 0, cut, cut), buildingStyleKey(28, 2, cut, cut));
  assert.ok(isSeamStyleKey(buildingStyleKey(10, 0, cut, cut)));
});

test('thin edge sliver uses the primary cut, not every on-edge vertex', () => {
  // Left tile: a 2px-wide sliver against x=extent. Almost every vertex is "on edge"
  // if we take all four sides; primary seam must be the east cut only.
  const extent = 4096;
  const sliver = [
    { x: extent - 2, y: 100 },
    { x: extent, y: 100 },
    { x: extent, y: 200 },
    { x: extent - 2, y: 200 },
  ];
  const seam = primaryTileSeam(sliver, extent);
  assert.ok(seam.every((p) => p.x >= extent - 0.5));
  assert.equal(seam.length, 2);
  // Neighbour tile west edge at the same geographic cut → same style mid key
  const leftLng: [number, number][] = [[-8.41001, 40.2], [-8.41, 40.2], [-8.41, 40.201], [-8.41001, 40.201]];
  const rightLng: [number, number][] = [[-8.41, 40.2], [-8.4099, 40.2], [-8.4099, 40.201], [-8.41, 40.201]];
  const leftSeam: [number, number][] = [[-8.41, 40.2], [-8.41, 40.201]];
  const rightSeam: [number, number][] = [[-8.41, 40.2], [-8.41, 40.201]];
  assert.equal(buildingStyleKey(14, 0, leftLng, leftSeam), buildingStyleKey(14, 0, rightLng, rightSeam));
});

test('many Portuguese homes use double-width windows and keep them at low detail', () => {
  const recipes = Array.from({ length: 100 }, (_, id) =>
    createRecipe({ id, key: `portuguese-house-${id}`, height: 12, base: 0 }, HOUSE_PALETTE, 'portuguese', 'Portugal'),
  );
  const wide = recipes.filter((item) => item.window === 'wide');
  assert.ok(wide.length >= 25 && wide.length <= 50);

  const made = wide[0];
  assert.ok(made);
  const windows = layoutFacade(10, 0, 0, 12, made, {
    lod: 1, detail: 'high', door: false, front: false, downspout: false,
  }).filter((piece) => piece.mesh === 'windowSimple');
  assert.ok(windows.length > 0);
  assert.ok(windows.every((piece) => Math.abs(PIECES.window.w * piece.sx - PIECES.window.w * 1.55) < 1e-6));
});

test('only near-rectangular footprints get a pitched roof', () => {
  const box = [{ x: 0, z: 0 }, { x: 12, z: 0 }, { x: 12, z: 8 }, { x: 0, z: 8 }];
  assert.equal(canPitch(box), true);
  const roof = buildRoof(box, 10, 'gable');
  assert.ok(roof);
  assert.ok(roof.ridgeY > 10.7);
  for (let i = 1; i < roof.positions.length; i += 3) assert.ok(roof.positions[i] >= 10 - 1e-6);
  assert.equal(canPitch([{ x: 0, z: 0 }, { x: 8, z: 0 }, { x: 4, z: 6 }]), false);
  assert.equal(canPitch([{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 12, z: 4 }, { x: 8, z: 8 }, { x: 0, z: 6 }]), false);
});

import { roofClearanceAt } from '../src/game/buildings/RoofGenerator.ts';
test('roof clearance falls from the ridge to the eaves', () => {
  const roof = {
    eaves: 10, peak: 13, half: 4,
    ridgeA: { x: 0, z: -6 }, ridgeB: { x: 0, z: 6 },
  };
  assert.equal(roofClearanceAt(0, 0, roof), 13);
  assert.ok(Math.abs(roofClearanceAt(4, 0, roof) - 10) < 1e-6);
  assert.ok(roofClearanceAt(2, 0, roof) > 11 && roofClearanceAt(2, 0, roof) < 12);
  assert.equal(roofClearanceAt(0, 0, { eaves: 8, peak: 8, half: 0, ridgeA: null, ridgeB: null }), 8);
});

test('a negative vent seed still picks a real footprint corner', () => {
  const length = 4;
  const ventSeed = 2166136261 ^ 91;
  assert.ok(ventSeed < 0);
  for (const seed of [ventSeed, -1, -4, -91, 0, 2, 5]) {
    const index = indexFor(length, seed);
    assert.ok(index >= 0 && index < length, `seed ${seed} -> ${index}`);
  }
  assert.equal(indexFor(0, -3), 0);
});
