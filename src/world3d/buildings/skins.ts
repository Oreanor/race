// Architecture skins (docs/city_architecture_skins_presets.json): the same
// buildings, repainted by the facade shader. Any skin fits any city and can be
// switched at any moment, no tile is rebuilt. Each building takes one wall tone
// and one roof tone from weighted palettes (seeded by the building), plus the
// style's windows, trims and patterns (map/materials farBuildingMaterial).

export type SkinId = 'original' | 'modern' | 'futuristic' | 'victorian';
export const SKINS: SkinId[] = ['original', 'modern', 'futuristic', 'victorian'];

export type Skin = {
  /** shader index: 1 modern, 2 futuristic, 3 victorian */
  index: number;
  wall: [string, number][];
  roof: [string, number][];
  secondary: string[];
  glass: string[];
  frame: string[];
  trim: string[];
  accent: string[];
  glow: string[];
  /** share of windows lit at night */
  lit: number;
  /** chance of the style's accent per building: wood panels / teal stripes / stone trim */
  accentChance: number;
  /** chance of the style's second feature: panel seams / solar roofs / floor bands */
  featureChance: number;
  /** per-building lightness spread of walls and roofs */
  wallRange: number;
  roofRange: number;
};

export const SKIN_DATA: Record<Exclude<SkinId, 'original'>, Skin> = {
  modern: {
    index: 1,
    // white, cream, beige / sand, light grey, warm concrete; sage comes in as a section colour
    wall: [['#F0EEE6', 22], ['#EDE3CF', 26], ['#DFCFB2', 22], ['#D6D4CE', 14], ['#C2B8A9', 16]],
    // warm roofs: terracotta, warm grey, light concrete, a little graphite and brown
    roof: [['#B5654A', 26], ['#8C857C', 24], ['#BDB6AA', 24], ['#45484C', 14], ['#6E5444', 12]],
    // large contrasting facade sections: graphite, warm dark grey, sand, warm concrete
    secondary: ['#4A4B4D', '#6E6A64', '#CDBEA2', '#B8B2A8'],
    // neutral glass (the shader picks it per building, blue on ~5% only)
    glass: ['#454545', '#686662', '#89847B', '#777F76'],
    frame: ['#333B42', '#657077', '#F0F0E8'],
    trim: ['#E7E7E1', '#BBC0BE', '#747D80'],
    accent: ['#AA8061', '#607F8A', '#BEB2A0'],
    glow: ['#F4D7AD', '#E8E7D9'],
    lit: 0.23, accentChance: 0.14, featureChance: 0.42, wallRange: 0.09, roofRange: 0.07,
  },
  futuristic: {
    index: 2,
    // bright neo-futurism: near-white composites, light steel, sky glass, clean cyan
    wall: [['#F7FCFD', 42], ['#EAF4F8', 30], ['#E0EEF4', 18], ['#D2E4EC', 10]],
    roof: [['#5A7588', 42], ['#7A93A4', 33], ['#A8BBC8', 25]],
    secondary: ['#A8BCC8', '#C2D4DE', '#B4C6D0', '#A8BCC8'],
    glass: ['#8FD0F8', '#B6E4FF', '#6EB8E8'],
    frame: ['#7A94A4', '#F4FBFC', '#7A94A4'],
    trim: ['#FFFFFF', '#D0E2EC', '#A8BCC8'],
    accent: ['#4DE8DC', '#7ECFFF', '#9AF0F4'],
    glow: ['#C4F0FF', '#F2FFFC'],
    lit: 0.2, accentChance: 0.42, featureChance: 0.55, wallRange: 0.04, roofRange: 0.04,
  },
  victorian: {
    index: 3,
    // the shader paints five facade families of its own (stucco, muted brick, stone,
    // painted, brick + stucco); this wall palette is only the fallback
    wall: [['#D9CBB2', 35], ['#7A5444', 25], ['#C9BBA0', 10], ['#A7B59A', 20], ['#8A5A48', 10]],
    // the shader picks victorian roofs by district (slate, warm graphite, grey-brown, faded
    // terracotta, brick red, brown tile, grey-olive, light stone); this list is the fallback
    roof: [['#555A5A', 30], ['#454441', 20], ['#A36B56', 20], ['#766B60', 15], ['#884F45', 15]],
    secondary: ['#8E8A82', '#A78062', '#E2CAA5', '#8E8A82'],
    glass: ['#56687A', '#4A5D68', '#5D6E68'],
    frame: ['#F2EEE4', '#EBE2CE', '#F2EEE4'],
    trim: ['#F2EEE4', '#E9DFC9', '#DED2B9'],
    // doors
    accent: ['#2F4A3A', '#5E2A2E', '#26364A'],
    glow: ['#E9BF82', '#FFD8A7'],
    lit: 0.21, accentChance: 0.83, featureChance: 0.45, wallRange: 0.06, roofRange: 0.06,
  },
};
