import assert from 'node:assert/strict';
import test from 'node:test';
import { cutCoveredWalls } from '../src/world3d/tiles/wallCut.ts';

test('coplanar walls: the taller keeps the shared stretch, the rest of the lower one survives', () => {
  const tall = { ax: 0, az: 0, bx: 10, bz: 0, y0: 0, y1: 20, order: 0 };
  const low = { ax: 6, az: 0.01, bx: 16, bz: 0.01, y0: 0, y1: 9, order: 1 };
  const twin = { ax: 10, az: 0, bx: 0, bz: 0, y0: 0, y1: 20, order: 2 };
  const pieces = cutCoveredWalls([tall, low, twin]);
  const of = (w: object) => pieces.filter((p) => p.wall === w);
  assert.equal(of(tall).length, 1);
  assert.equal(of(twin).length, 0);
  assert.equal(of(low).length, 1);
  assert.ok(Math.abs(of(low)[0].t0 - 0.4) < 1e-6 && of(low)[0].t1 === 1);
});

test('a neighbour 25 cm off and a hair skewed is the same wall', () => {
  const tall = { ax: 0, az: 0, bx: 40, bz: 0, y0: 0, y1: 18, order: 0 };
  // a long neighbour: 25 cm off where they meet, drifting to 75 cm at its far end
  const low = { ax: 30, az: 0.25, bx: 70, bz: 0.75, y0: 0, y1: 12, order: 1 };
  const pieces = cutCoveredWalls([tall, low], 0.4);
  const rest = pieces.filter((p) => p.wall === low);
  assert.equal(rest.length, 1);
  assert.ok(rest[0].t0 > 0.2, `the shared 10 m are gone, left from ${rest[0].t0}`);
});

test('walls a metre apart stay two walls', () => {
  const a = { ax: 0, az: 0, bx: 20, bz: 0, y0: 0, y1: 18, order: 0 };
  const b = { ax: 0, az: 1, bx: 20, bz: 1, y0: 0, y1: 12, order: 1 };
  assert.equal(cutCoveredWalls([a, b], 0.4).length, 2);
});
