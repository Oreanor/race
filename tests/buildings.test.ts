import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecipe, HOUSE_PALETTE, indexFor, portuguesePastel } from '../src/game/buildings/BuildingStyles.ts';
import { chooseLod } from '../src/game/buildings/BuildingLOD.ts';
import { facadeBands, layoutFacade, pieceExtents } from '../src/game/buildings/FacadeGenerator.ts';
import { buildRoof, canPitch } from '../src/game/buildings/RoofGenerator.ts';
import { PIECES } from '../src/game/buildings/pieces.ts';
import { collapseCopies, footprintKey, keepVisibleParts, resolveWalls, retainNearParts } from '../src/game/buildings/wallOverlap.ts';
import { buildingBlocksView } from '../src/game/buildings/viewOcclusion.ts';
import { createFadeMap, paintSlot, resetFade } from '../src/rendering/buildingFade.ts';

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

test('lod stays put inside the hysteresis band', () => {
  assert.equal(chooseLod(100, undefined, 'high'), 0);
  assert.equal(chooseLod(130, 0, 'high'), 0);
  assert.equal(chooseLod(150, 0, 'high'), 1);
  assert.equal(chooseLod(110, 1, 'high'), 1);
  assert.equal(chooseLod(90, 1, 'high'), 0);
  assert.equal(chooseLod(40, undefined, 'low'), 1);
  assert.equal(chooseLod(400, 1, 'high'), 2);
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

test('the same footprint is drawn once, even if the ring starts elsewhere', () => {
  const ring: [number, number][] = [[-8.4, 40.2], [-8.4, 40.2001], [-8.3999, 40.2001]];
  const turned: [number, number][] = [ring[1], ring[2], ring[0]];
  assert.equal(footprintKey([ring]), footprintKey([turned]));
  const parts = [
    { rings: [ring], base: 0, height: 12 },
    { rings: [turned], base: 0, height: 12 },
    { rings: [ring], base: 0, height: 6 },
    { rings: [[[-8.5, 40.2], [-8.5, 40.2002], [-8.4998, 40.2002]]], base: 0, height: 9 },
  ];
  const kept = keepVisibleParts(parts);
  assert.equal(kept.length, 2);
  assert.equal(kept[0].height, 12);
  assert.equal(kept[1].height, 9);
});

test('tile copies of one house collapse instead of stacking windows', () => {
  const house: [number, number][] = [[-8.41, 40.2], [-8.41, 40.20025], [-8.4098, 40.20025], [-8.4098, 40.2]];
  const shifted = house.map(([lng, lat]) => [lng + 0.000012, lat + 0.000004] as [number, number]);
  const detailed: [number, number][] = [
    house[0], [(house[0][0] + house[1][0]) / 2, (house[0][1] + house[1][1]) / 2],
    house[1], [(house[1][0] + house[2][0]) / 2, (house[1][1] + house[2][1]) / 2],
    house[2], [(house[2][0] + house[3][0]) / 2, (house[2][1] + house[3][1]) / 2],
    house[3], [(house[3][0] + house[0][0]) / 2, (house[3][1] + house[0][1]) / 2],
  ];
  const neighbor = house.map(([lng, lat]) => [lng + 0.00028, lat] as [number, number]);
  const parts = [house, shifted, detailed, neighbor].map((ring, index) => ({ key: String(index), rings: [ring], base: 0, height: 12 }));
  const kept = collapseCopies(parts);
  assert.deepEqual(kept.map((part) => part.key), ['0', '3']);
});

test('a smaller outline inside a block is one building, a yard house stays', () => {
  const block: [number, number][] = [[-8.41, 40.2], [-8.41, 40.2003], [-8.4095, 40.2003], [-8.4095, 40.2]];
  const nested: [number, number][] = [[-8.40985, 40.20008], [-8.40985, 40.20018], [-8.40968, 40.20018], [-8.40968, 40.20008]];
  const yard: [number, number][] = [[-8.40982, 40.2001], [-8.40982, 40.20016], [-8.4097, 40.20016], [-8.4097, 40.2001]];
  const hole: [number, number][] = [[-8.4099, 40.20006], [-8.4099, 40.2002], [-8.40962, 40.2002], [-8.40962, 40.20006]];
  const beside: [number, number][] = [[-8.40942, 40.20008], [-8.40942, 40.20018], [-8.40928, 40.20018], [-8.40928, 40.20008]];
  const tower = { key: 'tower', rings: [nested], base: 0, height: 40 };
  const kept = collapseCopies([
    { key: 'block', rings: [block], base: 0, height: 14 },
    { key: 'nested', rings: [nested], base: 0, height: 11 },
    { key: 'beside', rings: [beside], base: 0, height: 10 },
  ]);
  assert.deepEqual(kept.map((part) => part.key), ['block', 'beside']);
  const withYard = collapseCopies([
    { key: 'block', rings: [block, hole], base: 0, height: 14 },
    { key: 'yard', rings: [yard], base: 0, height: 9 },
  ]);
  assert.deepEqual(withYard.map((part) => part.key), ['block', 'yard']);
  const withTower = collapseCopies([
    { key: 'block', rings: [block], base: 0, height: 12 },
    tower,
  ]);
  assert.deepEqual(withTower.map((part) => part.key), ['block', 'tower']);
});

test('a house missing from one map query stays while it is still nearby', () => {
  const near = retainNearParts([{ key: 'a' }], [{ key: 'a' }, { key: 'b' }, { key: 'c' }], (part) => part.key === 'c' ? 2000 : 10, 100);
  assert.deepEqual(near.map((part) => part.key), ['a', 'b']);
});

test('a shared wall is kept once and a taller neighbour covers the shorter face', () => {
  const faces = [
    { ax: 0, az: 0, bx: 10, bz: 0, y0a: 0, y0b: 0, y1: 9, name: 'a' },
    { ax: 10, az: 0, bx: 0, bz: 0, y0a: 0, y0b: 0, y1: 9, name: 'b' },
    { ax: 0, az: 0, bx: 0, bz: 8, y0a: 0, y0b: 0, y1: 6, name: 'short' },
    { ax: 0, az: 8, bx: 0, bz: 0, y0a: 0, y0b: 0, y1: 14, name: 'tall' },
    { ax: 3, az: 3, bx: 6, bz: 3, y0a: 0, y0b: 0, y1: 8, name: 'alone' },
  ];
  const kept = resolveWalls(faces);
  assert.deepEqual(kept.map((face) => face.name).sort(), ['a', 'alone', 'tall']);
});

test('closed tile copies deduplicate across starting vertices and winding', () => {
  const a = [0, 0], b = [0, 1], c = [1, 1], d = [1, 0];
  const rings = [[a, b, c, d, a], [c, d, a, b, c], [d, c, b, a, d]];
  assert.equal(footprintKey([rings[0]]), footprintKey([rings[1]]));
  assert.equal(footprintKey([rings[0]]), footprintKey([rings[2]]));
  assert.equal(keepVisibleParts(rings.map(ring => ({ rings: [ring], base: 0, height: 12 }))).length, 1);
  assert.equal(keepVisibleParts([
    { rings: [rings[0]], base: 0, height: 12 },
    { rings: [rings[1]], base: 0, height: 6 },
  ]).length, 1);
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

test('a house on the sightline fades and one beside the street stays solid', () => {
  const house = {
    footprint: [{ x: -4, z: -4 }, { x: 4, z: -4 }, { x: 4, z: 4 }, { x: -4, z: 4 }],
    base: 0,
    top: 12,
  };
  assert.equal(buildingBlocksView(house, 0, 18, 24, 0, 1.2, 0), true);
  assert.equal(buildingBlocksView(house, 0, 30, 24, 0, 28, 0), false);
  assert.equal(buildingBlocksView(house, 18, 10, 0, 28, 1.2, 0), false);
});

test('building fade tracks active slots without scanning the full texture', () => {
  const fade = createFadeMap();
  assert.equal(fade.activeSlots, 0);
  assert.equal(paintSlot(fade, 1, true), true);
  assert.equal(fade.activeSlots, 1);
  assert.equal(paintSlot(fade, 2, true), true);
  assert.equal(fade.activeSlots, 2);
  for (let i = 0; i < 60; i++) paintSlot(fade, 1, false);
  assert.equal(fade.activeSlots, 1);
  resetFade(fade);
  assert.equal(fade.activeSlots, 0);
});

test('shared-wall ownership does not depend on which cell is built first', () => {
  const a={ax:0,az:0,bx:10,bz:0,y0a:0,y0b:0,y1:9,owner:'a'};
  const b={...a,ax:10,bx:0,owner:'b'};
  assert.deepEqual(resolveWalls([a,b]).map(w=>w.owner),['a']);
  assert.deepEqual(resolveWalls([b,a]).map(w=>w.owner),['a']);
});

import { cellDistance, deferCellReplacement } from '../src/game/buildings/cellStreaming.ts';
test('streaming protects the whole nearby block but allows remote and explicit style updates',()=>{
  assert.equal(cellDistance(200,0,0,0,200),100);
  assert.equal(deferCellReplacement(100,true,true),true);
  assert.equal(deferCellReplacement(100,true,true,20),false);
  assert.equal(deferCellReplacement(300,true,true),false);
  assert.equal(deferCellReplacement(100,false,true),false);
  assert.equal(deferCellReplacement(100,true,false),false);
});
