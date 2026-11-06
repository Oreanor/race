import assert from 'node:assert/strict';
import test from 'node:test';
import { DEM_SIZE, padDem, sampleDem } from '../src/world3d/tiles/dem.ts';

// a hill sloping and curving across two tiles side by side (west and east)
const S = DEM_SIZE;
const terrain = (gx: number, gy: number) => 40 + gx * 0.9 + Math.sin(gx / 37) * 12 + gy * 0.3;
const tileDem = (tx: number) => {
  const out = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) out[y * S + x] = terrain(tx * S + x + 0.5, y + 0.5);
  return out;
};
const none = { w: null, e: null, n: null, s: null, nw: null, ne: null, sw: null, se: null };

test('two padded tiles put the very same height on their shared edge', () => {
  const west = tileDem(0), east = tileDem(1);
  const pw = padDem(west, { ...none, e: east }), pe = padDem(east, { ...none, w: west });
  for (const py of [0, 3.3, 128, 255.9, 256]) {
    const a = sampleDem(pw, S, py), b = sampleDem(pe, 0, py);
    assert.ok(Math.abs(a - b) < 1e-4, `at y ${py}: ${a} vs ${b}`);
  }
});

test('without a neighbour the edge is carried on along the slope', () => {
  const west = tileDem(0);
  const edge = sampleDem(padDem(west, none), S, 100);
  assert.ok(Math.abs(edge - terrain(S, 100)) < 0.2, `edge ${edge} vs ${terrain(S, 100)}`);
  // and a bare DEM still samples as before inside
  assert.ok(Math.abs(sampleDem(west, 100.5, 50.5) - terrain(100.5, 50.5)) < 1e-3);
});
