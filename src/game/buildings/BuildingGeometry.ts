import { BoxGeometry, BufferGeometry, Matrix4, Quaternion, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PIECES, type MeshName, type Placement } from './pieces.ts';

export type WallModel = {
  ax: number;
  az: number;
  tx: number;
  tz: number;
  nx: number;
  nz: number;
  length: number;
  y0a: number;
  y0b: number;
  yTop: number;
  hole: boolean;
};

function box(w: number, h: number, d: number, x: number, y: number, z: number) {
  const geometry = new BoxGeometry(Math.max(0.02, w), Math.max(0.02, h), Math.max(0.02, d));
  geometry.translate(x, y, z);
  return geometry;
}

function merge(parts: BufferGeometry[]) {
  const geometry = mergeGeometries(parts, false) ?? new BufferGeometry();
  for (const part of parts) part.dispose();
  return geometry;
}

function windowFrame(w: number, h: number, d: number, mullion: boolean) {
  const t = Math.min(0.085, w * 0.1, h * 0.07);
  const parts = [
    box(t, h, d, -w / 2 + t / 2, 0, 0),
    box(t, h, d, w / 2 - t / 2, 0, 0),
    box(Math.max(0.04, w - t * 2), t, d, 0, h / 2 - t / 2, 0),
    box(Math.max(0.04, w - t * 2), t, d, 0, -h / 2 + t / 2, 0),
    box(w * 0.94, 0.05, d * 0.55, 0, -h / 2 + 0.045, d * 0.16),
  ];
  if (mullion && w > 0.55 && h > 0.75) {
    parts.push(box(t * 0.62, h - t * 2 - 0.04, d * 0.34, 0, 0.02, d * 0.24));
    parts.push(box(w - t * 2 - 0.04, t * 0.55, d * 0.34, 0, h * 0.04, d * 0.24));
  }
  return merge(parts);
}

function windowGlass(w: number, h: number, d: number) {
  const t = Math.min(0.085, w * 0.1, h * 0.07);
  return box(Math.max(0.08, w - t * 2 - 0.04), Math.max(0.08, h - t * 2 - 0.04), 0.028, 0, 0.01, -d * 0.12);
}

function doorFrame(w: number, h: number, d: number) {
  const t = 0.09;
  return merge([
    box(t, h, d, -w / 2 + t / 2, 0, 0),
    box(t, h, d, w / 2 - t / 2, 0, 0),
    box(Math.max(0.08, w - t * 2), t, d, 0, h / 2 - t / 2, 0),
  ]);
}

function doorPanel(w: number, h: number, d: number) {
  const t = 0.09;
  const pw = Math.max(0.2, w - t * 2 - 0.06);
  const ph = Math.max(0.4, h - t - 0.1);
  return merge([
    box(pw, ph, 0.045, 0, -0.03, d * 0.12),
    box(pw * 0.72, ph * 0.28, 0.03, 0, ph * 0.22, d * 0.2),
  ]);
}

function balcony(w: number, h: number, d: number) {
  return merge([
    box(w, 0.07, d * 0.92, 0, -h * 0.28, d * 0.46),
    box(w, 0.045, 0.04, 0, 0.08, d * 0.9),
    box(0.04, h * 0.72, d * 0.9, -w / 2 + 0.02, 0, d * 0.46),
    box(0.04, h * 0.72, d * 0.9, w / 2 - 0.02, 0, d * 0.46),
    box(0.045, h * 0.78, 0.045, -w / 2, 0.02, d * 0.9),
    box(0.045, h * 0.78, 0.045, 0, 0.02, d * 0.9),
    box(0.045, h * 0.78, 0.045, w / 2, 0.02, d * 0.9),
  ]);
}

export function createPieceGeometries(): Record<MeshName, BufferGeometry> {
  const window = PIECES.window;
  const simple = PIECES.windowSimple;
  const store = PIECES.store;
  const door = PIECES.door;
  const shutter = PIECES.shutter;
  const awning = PIECES.awning;
  const cornice = PIECES.cornice;
  const band = PIECES.band;
  const spout = PIECES.downspout;
  const chimney = PIECES.chimney;
  const vent = PIECES.vent;
  return {
    window: windowFrame(window.w, window.h, window.d, true),
    glass: windowGlass(window.w, window.h, window.d),
    windowSimple: windowFrame(simple.w, simple.h, simple.d, false),
    glassSimple: windowGlass(simple.w, simple.h, simple.d),
    store: windowFrame(store.w, store.h, store.d, true),
    storeGlass: windowGlass(store.w, store.h, store.d),
    door: doorFrame(door.w, door.h, door.d),
    doorPanel: doorPanel(door.w, door.h, door.d),
    balcony: balcony(PIECES.balcony.w, PIECES.balcony.h, PIECES.balcony.d),
    shutter: box(shutter.w, shutter.h, shutter.d, 0, 0, 0),
    awning: box(awning.w, awning.h, awning.d, 0, 0, awning.d / 2),
    cornice: box(cornice.w, cornice.h, cornice.d, 0, 0, cornice.d / 2),
    band: box(band.w, band.h, band.d, 0, 0, band.d / 2),
    downspout: box(spout.w, spout.h, spout.d, 0, 0, spout.d / 2),
    chimney: merge([
      box(chimney.w * 0.82, chimney.h * 0.78, chimney.d * 0.82, 0, -chimney.h * 0.06, 0),
      box(chimney.w, chimney.h * 0.16, chimney.d, 0, chimney.h * 0.36, 0),
    ]),
    vent: box(vent.w, vent.h, vent.d, 0, 0, 0),
  };
}

const axisX = new Vector3();
const axisY = new Vector3();
const axisZ = new Vector3();
const position = new Vector3();
const quaternion = new Quaternion();
const scale = new Vector3();

export function writeWallMatrix(wall: WallModel, piece: Placement, target: Matrix4) {
  const size = PIECES[piece.mesh];
  axisX.set(wall.tx * piece.sx, 0, wall.tz * piece.sx);
  axisY.set(0, piece.sy, 0);
  axisZ.set(wall.nx * piece.sz, 0, wall.nz * piece.sz);
  target.makeBasis(axisX, axisY, axisZ);
  const outward = size.anchor === 'center' ? size.d * piece.sz * 0.5 + 0.055 : 0.045;
  target.setPosition(
    wall.ax + wall.tx * piece.along + wall.nx * outward,
    piece.y,
    wall.az + wall.tz * piece.along + wall.nz * outward,
  );
  return target;
}

export function writePointMatrix(x: number, y: number, z: number, sx: number, sy: number, sz: number, target: Matrix4) {
  position.set(x, y, z);
  quaternion.identity();
  scale.set(sx, sy, sz);
  return target.compose(position, quaternion, scale);
}
