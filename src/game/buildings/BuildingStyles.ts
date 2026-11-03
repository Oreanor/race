import type { Tone } from './pieces.ts';

export type StyleId = 'european' | 'portuguese' | 'modern' | 'brick' | 'commercial';
export type ArchitectureSetting = 'auto' | StyleId | 'mixed';
export type BuildingDetail = 'off' | 'low' | 'medium' | 'high';
export type RoofKind = 'flat' | 'gable' | 'hip' | 'tile';
export type WindowKind = 'eu' | 'narrow' | 'wide';

export type BuildingFacts = {
  id: number;
  key: string;
  height: number;
  base: number;
  levels?: number;
  kind?: string;
  roofShape?: string;
};

export type BuildingRecipe = {
  seed: number;
  style: StyleId;
  floors: number;
  floorHeight: number;
  window: WindowKind;
  roofKind: RoofKind;
  features: {
    balcony: boolean;
    shutter: boolean;
    awning: boolean;
    cornice: boolean;
    band: boolean;
    downspout: boolean;
    vent: boolean;
    chimney: boolean;
    storefront: boolean;
  };
  colors: Record<Tone | 'wall', string>;
  slot: number;
};

type FeatureChances = Record<keyof BuildingRecipe['features'], number>;

type StyleSpec = {
  floorHeight: number;
  window: WindowKind;
  sill: number;
  frame: string;
  glass: string;
  door: string;
  trim: string;
  roof: string;
  metal: string;
  accent: string;
  roofs: Record<RoofKind, number>;
  chance: FeatureChances;
};

const STYLES: Record<StyleId, StyleSpec> = {
  european: {
    floorHeight: 3.25, window: 'eu', sill: 0.58,
    frame: '#f4efe4', glass: '#314862', door: '#6d4034', trim: '#efe6d8', roof: '#c96648', metal: '#8a8680', accent: '#c46a4a',
    roofs: { flat: 0.22, gable: 0.46, hip: 0.22, tile: 0.1 },
    chance: { balcony: 0.36, shutter: 0.2, awning: 0.26, cornice: 0.9, band: 0.42, downspout: 0.55, vent: 0.12, chimney: 0.42, storefront: 0.1 },
  },
  portuguese: {
    floorHeight: 3.05, window: 'narrow', sill: 0.62,
    frame: '#fff6ea', glass: '#3c6474', door: '#7b4e30', trim: '#fff5e8', roof: '#db734b', metal: '#8d8680', accent: '#e0a15a',
    roofs: { flat: 0.12, gable: 0.28, hip: 0.18, tile: 0.42 },
    chance: { balcony: 0.44, shutter: 0.36, awning: 0.2, cornice: 0.66, band: 0.6, downspout: 0.4, vent: 0.08, chimney: 0.3, storefront: 0.14 },
  },
  modern: {
    floorHeight: 3.45, window: 'wide', sill: 0.4,
    frame: '#eef1f3', glass: '#276389', door: '#32373c', trim: '#d5dbe0', roof: '#8197a3', metal: '#9aa3ab', accent: '#d8dee4',
    roofs: { flat: 0.9, gable: 0.1, hip: 0, tile: 0 },
    chance: { balcony: 0.18, shutter: 0, awning: 0.16, cornice: 0.16, band: 0.1, downspout: 0.18, vent: 0.48, chimney: 0.02, storefront: 0.24 },
  },
  brick: {
    floorHeight: 3.2, window: 'eu', sill: 0.56,
    frame: '#f3e7d6', glass: '#2d3d4e', door: '#4e382e', trim: '#f6e9da', roof: '#b95748', metal: '#7e7872', accent: '#a36848',
    roofs: { flat: 0.3, gable: 0.5, hip: 0.14, tile: 0.06 },
    chance: { balcony: 0.12, shutter: 0.06, awning: 0.16, cornice: 0.88, band: 0.72, downspout: 0.6, vent: 0.16, chimney: 0.34, storefront: 0.08 },
  },
  commercial: {
    floorHeight: 3.6, window: 'wide', sill: 0.36,
    frame: '#f5f6f4', glass: '#286887', door: '#3c4450', trim: '#e3e6e4', roof: '#728d9a', metal: '#8e969c', accent: '#d07a48',
    roofs: { flat: 0.84, gable: 0.16, hip: 0, tile: 0 },
    chance: { balcony: 0.05, shutter: 0, awning: 0.74, cornice: 0.38, band: 0.14, downspout: 0.32, vent: 0.42, chimney: 0.02, storefront: 0.9 },
  },
};

export function indexFor(length: number, seed: number) {
  if (length <= 0) return 0;
  const index = Math.trunc(Number.isFinite(seed) ? seed : 0) % length;
  return index < 0 ? index + length : index;
}

export function hashSeed(input: string) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function unitRand(seed: number) {
  let a = seed >>> 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function mixHex(from: string, to: string, amount: number) {
  const parse = (hex: string) => {
    const value = Number.parseInt(hex.slice(1), 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  };
  const a = parse(from);
  const b = parse(to);
  return `#${a.map((channel, index) => Math.round(channel * (1 - amount) + b[index] * amount).toString(16).padStart(2, '0')).join('')}`;
}

export function shadeHex(hex: string, shade: number) {
  if (shade === 1) return hex;
  return mixHex(hex, shade > 1 ? '#ffffff' : '#345a82', 0.07);
}

function vary(hex: string, seed: number, amount: number) {
  const t = unitRand(seed);
  return mixHex(hex, t > 0.5 ? '#ffffff' : '#345a82', amount * (t > 0.5 ? (t - 0.5) * 2 : (0.5 - t) * 2));
}

function roofFor(wall: string, style: StyleId) {
  const value = Number.parseInt(wall.slice(1), 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  const luma = (red * 0.3 + green * 0.59 + blue * 0.11) / 255;
  const sink = luma > 0.72 ? 0.34 : luma < 0.28 ? 0.18 : 0.46;
  const ink = style === 'modern' || style === 'commercial' ? '#1a242c' : '#2a160f';
  return mixHex(mixHex(wall, ink, sink), '#fff6ea', 0.1);
}

const BRICK_ROOFS = ['#c4533a', '#d26648', '#b84432', '#e07852', '#a63e2c'];

function brickRoof(seed: number) {
  const base = BRICK_ROOFS[indexFor(BRICK_ROOFS.length, seed)];
  const t = unitRand(seed ^ 0x51);
  const toward = t > 0.5 ? '#f2a088' : '#8a3022';
  const amount = 0.16 * (t > 0.5 ? (t - 0.5) * 2 : (0.5 - t) * 2);
  return mixHex(base, toward, amount);
}

function regionWeights(region: string): [StyleId, number][] {
  const name = region.toLowerCase();
  if (name.includes('portugal')) return [['portuguese', 0.7], ['european', 0.14], ['brick', 0.08], ['modern', 0.05], ['commercial', 0.03]];
  if (name.includes('united states') || name.includes('america')) return [['modern', 0.38], ['brick', 0.32], ['commercial', 0.14], ['european', 0.13], ['portuguese', 0.03]];
  if (name.includes('japan')) return [['modern', 0.56], ['commercial', 0.16], ['brick', 0.12], ['european', 0.12], ['portuguese', 0.04]];
  if (name.includes('france') || name.includes('kingdom') || name.includes('spain') || name.includes('italy')) return [['european', 0.62], ['brick', 0.18], ['modern', 0.1], ['commercial', 0.06], ['portuguese', 0.04]];
  return [['european', 0.4], ['brick', 0.2], ['portuguese', 0.15], ['modern', 0.15], ['commercial', 0.1]];
}

export function chooseStyle(facts: BuildingFacts, setting: ArchitectureSetting, region: string): StyleId {
  if (setting !== 'auto' && setting !== 'mixed') return setting;
  const roll = unitRand(hashSeed(facts.key) ^ 0x51f0c3);
  const kind = (facts.kind ?? '').toLowerCase();
  if (/retail|commercial|shop|mall|supermarket/.test(kind)) return roll < 0.82 ? 'commercial' : 'modern';
  if (/industrial|warehouse/.test(kind)) return roll < 0.7 ? 'brick' : 'commercial';
  const clear = Math.max(0, facts.height - facts.base);
  if ((facts.levels ?? 0) >= 9 || clear >= 30) return roll < 0.75 ? 'modern' : 'brick';
  if (setting === 'mixed') {
    const all: StyleId[] = ['european', 'portuguese', 'modern', 'brick', 'commercial'];
    return all[Math.min(all.length - 1, Math.floor(roll * all.length))];
  }
  let cursor = roll;
  const weights = regionWeights(region);
  for (const [id, weight] of weights) {
    cursor -= weight;
    if (cursor <= 0) return id;
  }
  return weights[weights.length - 1][0];
}

function chooseRoof(style: StyleId, seed: number, roofShape: string, floors: number, height: number): RoofKind {
  const shape = roofShape.toLowerCase();
  if (/flat|skillion/.test(shape)) return 'flat';
  if (/hip/.test(shape)) return 'hip';
  if (/gabled|gable/.test(shape)) return 'gable';
  if (style === 'modern' || style === 'commercial' || floors >= 7 || height >= 26) return 'flat';
  const roll = unitRand(seed ^ 0x85ebca6b);
  let cursor = roll;
  for (const [kind, weight] of Object.entries(STYLES[style].roofs) as [RoofKind, number][]) {
    cursor -= weight;
    if (cursor <= 0) return kind;
  }
  return 'flat';
}

export function createRecipe(facts: BuildingFacts, palette: readonly string[], setting: ArchitectureSetting, region: string): BuildingRecipe {
  const seed = hashSeed(facts.key || String(facts.id));
  const styleId = chooseStyle(facts, setting, region);
  const style = STYLES[styleId];
  const clear = Math.max(2.4, facts.height - facts.base);
  let floors = facts.levels && facts.levels > 0 ? Math.round(facts.levels) : Math.max(1, Math.round(clear / style.floorHeight));
  while (floors > 1 && clear / floors < 2.35) floors--;
  floors = Math.max(1, Math.min(40, floors));
  const slot = (seed % Math.max(1, palette.length)) * 3 + (seed % 3);
  const wall = shadeHex(palette[seed % Math.max(1, palette.length)] ?? '#e7d7c3', seed % 3);
  const roll = (salt: number) => unitRand(seed ^ salt);
  const features = {
    balcony: roll(0x11) < style.chance.balcony && floors > 1,
    shutter: roll(0x22) < style.chance.shutter,
    awning: roll(0x33) < style.chance.awning,
    cornice: roll(0x44) < style.chance.cornice,
    band: roll(0x55) < style.chance.band,
    downspout: roll(0x66) < style.chance.downspout,
    vent: roll(0x77) < style.chance.vent,
    chimney: roll(0x88) < style.chance.chimney && floors < 8,
    storefront: roll(0x99) < style.chance.storefront,
  };
  const roofKind = chooseRoof(styleId, seed, facts.roofShape ?? '', floors, clear);
  return {
    seed,
    style: styleId,
    floors,
    floorHeight: style.floorHeight,
    window: style.window,
    roofKind,
    features,
    slot,
    colors: {
      wall,
      frame: vary(style.frame, seed ^ 1, 0.05),
      glass: vary(style.glass, seed ^ 2, 0.07),
      door: vary(style.door, seed ^ 3, 0.06),
      trim: vary(style.trim, seed ^ 4, 0.05),
      metal: style.metal,
      plinth: mixHex(wall, '#365879', 0.14),
      accent: vary(style.accent, seed ^ 5, 0.05),
      roof: roofKind === 'flat' ? roofFor(wall, styleId) : brickRoof(seed),
    },
  };
}

export function sillRatio(style: StyleId) {
  return STYLES[style].sill;
}
