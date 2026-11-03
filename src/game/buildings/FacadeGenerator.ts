import { PIECES, type Placement } from './pieces.ts';
import { sillRatio, type BuildingDetail, type BuildingRecipe } from './BuildingStyles.ts';

export type Band = { y0: number; y1: number; mode: 'solid' | 'windows' };

const FLOOR = 3.2;

// Vertical slots that always tile the wall. Window slots are whole floors;
// whatever is left above and below stays solid, so a row is never sliced by the roof.
export function facadeBands(length: number, y0a: number, y0b: number, yTop: number, floorHeight = FLOOR): Band[] {
  const yBase = Math.max(y0a, y0b);
  const yLow = Math.min(y0a, y0b);
  const bands: Band[] = [];
  if (yLow < yBase - 0.04) bands.push({ y0: yLow, y1: yBase, mode: 'solid' });
  const height = yTop - yBase;
  if (!(height > 0.35)) return bands;
  if (height < 2.2 || length < 1.55) {
    bands.push({ y0: yBase, y1: yTop, mode: 'solid' });
    return bands;
  }
  const plinth = Math.min(0.42, Math.max(0.16, height * 0.1));
  const cap = Math.min(0.5, Math.max(0.18, height * 0.09));
  const usable = Math.max(0.8, height - plinth - cap);
  let floors = Math.max(1, Math.round(usable / floorHeight));
  while (floors > 1 && usable / floors < 2.2) floors--;
  const floorH = usable / floors;
  const body0 = yBase + (height - usable) * (plinth / (plinth + cap));
  bands.push({ y0: yBase, y1: body0, mode: 'solid' });
  for (let floor = 0; floor < floors; floor++) {
    const y0 = body0 + floor * floorH;
    bands.push({ y0, y1: y0 + floorH, mode: 'windows' });
  }
  const body1 = body0 + floors * floorH;
  if (yTop - body1 > 0.001) bands.push({ y0: body1, y1: yTop, mode: 'solid' });
  return bands;
}

export type LayoutOptions = {
  lod: 0 | 1;
  detail: Exclude<BuildingDetail, 'off'>;
  door: boolean;
  front: boolean;
  downspout: boolean;
};

type Opening = { mesh: Placement['mesh']; glass: Placement['mesh']; w: number; h: number };

function openingFor(recipe: BuildingRecipe, simple: boolean, store: boolean): Opening {
  if (store && !simple) return { mesh: 'store', glass: 'storeGlass', w: PIECES.store.w, h: PIECES.store.h };
  if (simple) {
    const width = recipe.window === 'wide' ? 1.55 : recipe.window === 'narrow' ? 0.62 : 1;
    const height = recipe.window === 'wide' ? 0.9 : recipe.window === 'narrow' ? 1.06 : 1;
    return { mesh: 'windowSimple', glass: 'glassSimple', w: PIECES.window.w * width, h: PIECES.window.h * height };
  }
  if (recipe.window === 'narrow') return { mesh: 'window', glass: 'glass', w: PIECES.window.w * 0.62, h: PIECES.window.h * 1.06 };
  if (recipe.window === 'wide') return { mesh: 'window', glass: 'glass', w: PIECES.window.w * 1.55, h: PIECES.window.h * 0.9 };
  return { mesh: 'window', glass: 'glass', w: PIECES.window.w, h: PIECES.window.h };
}

function push(out: Placement[], mesh: Placement['mesh'], along: number, y: number, sx: number, sy: number, sz: number, tone: Placement['tone']) {
  const size = PIECES[mesh];
  const halfW = (size.w * sx) / 2;
  const halfH = (size.h * sy) / 2;
  if (!(halfW > 0) || !(halfH > 0)) return;
  out.push({ mesh, along, y, sx, sy, sz, tone });
}

export function layoutFacade(length: number, y0a: number, y0b: number, yTop: number, recipe: BuildingRecipe, options: LayoutOptions): Placement[] {
  const out: Placement[] = [];
  const yBase = Math.max(y0a, y0b);
  const height = yTop - yBase;
  const rich = options.detail === 'high' && options.lod === 0;
  const mid = options.detail !== 'low' && options.lod === 0;
  const simple = options.lod === 1 || options.detail === 'low';
  const bands = facadeBands(length, y0a, y0b, yTop, recipe.floorHeight);
  const floors = bands.filter((band) => band.mode === 'windows');
  if (mid && recipe.features.cornice && length > 2.1 && height > 1.4) {
    const sy = 1;
    const sx = Math.max(0.4, length - 0.16);
    push(out, 'cornice', length / 2, yTop - (PIECES.cornice.h * sy) / 2 - 0.03, sx, sy, 1, 'trim');
  }
  if (!floors.length || length < 1.55) {
    if (options.downspout && rich && recipe.features.downspout && height > 2.4 && length > 1.2) addSpout(out, length, yBase, yTop);
    return clip(out, length, yBase, yTop);
  }

  const storey = floors[0];
  const store = Boolean(options.front && recipe.features.storefront && length > 5.5 && storey.y1 - storey.y0 > 2.45);
  const base = openingFor(recipe, simple, false);
  const ground = openingFor(recipe, simple, store);
  const columns = fitColumns(length, base.w, recipe.window === 'narrow' ? 0.34 : recipe.window === 'wide' ? 0.62 : 0.46);
  const groundColumns = store ? fitColumns(length, ground.w, 0.42) : columns;
  if (!columns) {
    if (options.downspout && rich && recipe.features.downspout) addSpout(out, length, yBase, yTop);
    return clip(out, length, yBase, yTop);
  }

  const plinth = bands.find((band) => band.mode === 'solid' && band.y0 === yBase);
  if (mid && plinth && plinth.y1 - plinth.y0 > 0.12 && length > 1.8) {
    const ph = plinth.y1 - plinth.y0;
    push(out, 'band', length / 2, (plinth.y0 + plinth.y1) / 2, Math.max(0.4, length - 0.08), ph / PIECES.band.h, 1.15, 'plinth');
  }

  floors.forEach((band, floor) => {
    const useStore = floor === 0 && store && groundColumns;
    const cols = useStore ? groundColumns : columns;
    const spec = useStore ? ground : base;
    if (!cols) return;
    const bandH = band.y1 - band.y0;
    const padTop = Math.max(0.1, bandH * 0.08);
    const padBottom = Math.max(0.16, bandH * sillRatio(recipe.style) * 0.42);
    const avail = bandH - padTop - padBottom;
    if (avail < 0.7) return;
    const winH = Math.min(spec.h, avail);
    const winW = Math.min(spec.w, cols.width);
    const sy = winH / PIECES[spec.mesh].h;
    const sx = winW / PIECES[spec.mesh].w;
    const y = band.y0 + padBottom + (avail - winH) * 0.42 + winH / 2;
    const doorSlot = options.door && floor === 0 ? Math.floor((cols.count - 1) / 2) : -1;
    const doorBottom = (plinth ? plinth.y1 : yBase) + 0.02;
    for (let i = 0; i < cols.count; i++) {
      const along = cols.margin + cols.width / 2 + i * (cols.width + cols.gap);
      if (i === doorSlot) {
        addDoor(out, along, doorBottom, band, cols.width, recipe, simple);
        continue;
      }
      push(out, spec.mesh, along, y, sx, sy, 1, 'frame');
      push(out, spec.glass, along, y, sx, sy, 1, 'glass');
      if (rich && recipe.features.shutter && cols.gap >= 0.28) addShutters(out, along, y, winW, winH, length);
      if (rich && recipe.features.balcony && floor > 0 && options.front && (i + floor) % 2 === 0) addBalcony(out, along, y, winW, winH, length, yBase);
    }
    if (rich && recipe.features.band && floor > 0 && length > 2.4) {
      push(out, 'band', length / 2, band.y0, Math.max(0.4, length * 0.92), 1, 1, 'trim');
    }
  });

  if (options.downspout && rich && recipe.features.downspout && height > 2.6) addSpout(out, length, yBase, yTop);
  return clip(out, length, yBase, yTop);
}

function fitColumns(length: number, windowW: number, minGap: number) {
  const margin0 = Math.min(0.46, Math.max(0.16, length * 0.045));
  const usable = length - margin0 * 2;
  if (usable < windowW * 0.64) return null;
  let count = Math.max(1, Math.floor((usable + minGap) / (windowW + minGap)));
  let width = windowW;
  while (count > 1 && count * width + (count - 1) * minGap > usable + 1e-4) count--;
  if (count * width + (count - 1) * minGap > usable) {
    width = (usable - (count - 1) * minGap) / count;
    if (width < windowW * 0.64) return null;
  }
  let gap = count > 1 ? minGap : 0;
  let row = count * width + (count - 1) * gap;
  const spare = usable - row;
  if (count > 1 && spare > 0) {
    gap += Math.min(spare, (count - 1) * minGap) / (count - 1);
    row = count * width + (count - 1) * gap;
  }
  const margin = (length - row) / 2;
  if (!(margin >= 0.08)) return null;
  return { count, width, gap, margin };
}

function addDoor(out: Placement[], along: number, doorBottom: number, band: Band, slotW: number, recipe: BuildingRecipe, simple: boolean) {
  const nominal = PIECES.door;
  const doorW = Math.min(nominal.w, slotW * 0.98);
  const maxH = band.y1 - 0.08 - doorBottom;
  if (maxH < 1.55 || doorW < 0.7) {
    const mesh = simple ? 'windowSimple' : 'window';
    const glass = simple ? 'glassSimple' : 'glass';
    const availH = band.y1 - band.y0 - 0.36;
    const availW = slotW;
    const sx = Math.min(1, availW / PIECES[mesh].w);
    const sy = Math.min(1, availH / PIECES[mesh].h);
    push(out, mesh, along, (band.y0 + band.y1) / 2, sx, sy, 1, 'frame');
    push(out, glass, along, (band.y0 + band.y1) / 2, sx, sy, 1, 'glass');
    return;
  }
  const doorH = Math.min(nominal.h, maxH);
  const y = doorBottom + doorH / 2;
  push(out, 'door', along, y, doorW / nominal.w, doorH / nominal.h, 1, 'frame');
  push(out, 'doorPanel', along, y, doorW / nominal.w, doorH / nominal.h, 1, 'door');
  if (!simple && recipe.features.awning) {
    const aw = PIECES.awning;
    const awY = y + doorH / 2 + aw.h / 2 + 0.04;
    if (awY + aw.h / 2 <= band.y1 + 0.2) push(out, 'awning', along, awY, Math.min(1.15, (doorW * 1.2) / aw.w), 1, 1, 'accent');
  }
}

function addShutters(out: Placement[], along: number, y: number, winW: number, winH: number, length: number) {
  const shutter = PIECES.shutter;
  const sy = Math.min(1.15, winH / shutter.h);
  const offset = winW / 2 + shutter.w / 2 + 0.03;
  for (const side of [-1, 1]) {
    const x = along + side * offset;
    if (x - shutter.w / 2 < 0.06 || x + shutter.w / 2 > length - 0.06) continue;
    push(out, 'shutter', x, y, 1, sy, 1, 'accent');
  }
}

function addBalcony(out: Placement[], along: number, windowY: number, winW: number, winH: number, length: number, yBase: number) {
  const balcony = PIECES.balcony;
  const bw = Math.min(balcony.w, winW + 0.16);
  const sx = bw / balcony.w;
  const y = windowY - winH / 2 - balcony.h / 2 + 0.04;
  if (y - balcony.h / 2 < yBase + 0.05) return;
  if (along - bw / 2 < 0.1 || along + bw / 2 > length - 0.1) return;
  push(out, 'balcony', along, y, sx, 1, 1, 'trim');
}

function addSpout(out: Placement[], length: number, yBase: number, yTop: number) {
  const span = (yTop - yBase) * 0.9;
  if (span < 1.5 || length < 1.4) return;
  const along = Math.min(length - 0.24, 0.28);
  push(out, 'downspout', along, (yBase + yTop) / 2, 1, span / PIECES.downspout.h, 1, 'metal');
}

function clip(out: Placement[], length: number, yBase: number, yTop: number) {
  return out.filter((piece) => {
    const size = PIECES[piece.mesh];
    const halfW = (size.w * piece.sx) / 2;
    const halfH = (size.h * piece.sy) / 2;
    if (piece.along - halfW < -0.04 || piece.along + halfW > length + 0.04) return false;
    if (piece.y - halfH < yBase - 0.04 || piece.y + halfH > yTop + 0.08) return false;
    return true;
  });
}

export function pieceExtents(piece: Placement) {
  const size = PIECES[piece.mesh];
  return {
    x0: piece.along - (size.w * piece.sx) / 2,
    x1: piece.along + (size.w * piece.sx) / 2,
    y0: piece.y - (size.h * piece.sy) / 2,
    y1: piece.y + (size.h * piece.sy) / 2,
  };
}
