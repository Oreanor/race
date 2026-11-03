export const ROOF_LIP = 0.42;

export type MeshName =
  | 'window' | 'glass' | 'windowSimple' | 'glassSimple'
  | 'store' | 'storeGlass'
  | 'door' | 'doorPanel'
  | 'balcony' | 'shutter' | 'awning' | 'cornice' | 'band' | 'downspout' | 'chimney' | 'vent';

export type PieceSize = { w: number; h: number; d: number; anchor: 'center' | 'back' };

export const PIECES: Record<MeshName, PieceSize> = {
  window: { w: 1.14, h: 1.56, d: 0.16, anchor: 'center' },
  glass: { w: 1.14, h: 1.56, d: 0.16, anchor: 'center' },
  windowSimple: { w: 1.14, h: 1.56, d: 0.07, anchor: 'center' },
  glassSimple: { w: 1.14, h: 1.56, d: 0.07, anchor: 'center' },
  store: { w: 2.2, h: 2.05, d: 0.12, anchor: 'center' },
  storeGlass: { w: 2.2, h: 2.05, d: 0.12, anchor: 'center' },
  door: { w: 1.12, h: 2.12, d: 0.14, anchor: 'center' },
  doorPanel: { w: 1.12, h: 2.12, d: 0.14, anchor: 'center' },
  balcony: { w: 1.28, h: 0.62, d: 0.7, anchor: 'back' },
  shutter: { w: 0.09, h: 1.4, d: 0.045, anchor: 'center' },
  awning: { w: 1.45, h: 0.07, d: 0.72, anchor: 'back' },
  cornice: { w: 1, h: 0.13, d: 0.2, anchor: 'back' },
  band: { w: 1, h: 0.08, d: 0.09, anchor: 'back' },
  downspout: { w: 0.07, h: 1, d: 0.07, anchor: 'back' },
  chimney: { w: 0.48, h: 0.95, d: 0.48, anchor: 'center' },
  vent: { w: 0.72, h: 0.32, d: 0.52, anchor: 'center' },
};

export type Tone = 'frame' | 'glass' | 'door' | 'trim' | 'metal' | 'plinth' | 'accent' | 'roof';

export type Placement = {
  mesh: MeshName;
  along: number;
  y: number;
  sx: number;
  sy: number;
  sz: number;
  tone: Tone;
};
