// Trees and shrubs of the world, after docs/city_sim_vegetation_catalog.json:
// 16 base shapes, each with variants (species) that differ in colour, leaf
// habit and proportions, and climate presets that mix up to four tree species
// plus an understory. A place picks its preset from geography first
// (continent, coast), then latitude. Pure data + selection: the worker plants
// with it, the main thread draws the shapes (map/floraModels).

export const FLORA_MODELS = [
  'tree_round', 'tree_spreading', 'tree_columnar', 'tree_birch_airy', 'tree_spruce', 'tree_pine',
  'tree_pine_umbrella', 'tree_gnarled', 'tree_acacia', 'tree_palm', 'tree_tropical', 'tree_eucalyptus',
  'bush_round', 'bush_dry', 'grass_tuft', 'succulent',
] as const;
export type FloraModel = typeof FLORA_MODELS[number];

/** Height of each base shape as modelled (m), before instance scale. */
export const MODEL_HEIGHT: Record<FloraModel, number> = {
  tree_round: 9, tree_spreading: 10, tree_columnar: 13, tree_birch_airy: 12, tree_spruce: 15, tree_pine: 16,
  tree_pine_umbrella: 12, tree_gnarled: 6, tree_acacia: 8, tree_palm: 11, tree_tropical: 20, tree_eucalyptus: 17,
  bush_round: 1.5, bush_dry: 1.1, grass_tuft: 0.7, succulent: 1.1,
};

/** 0 evergreen, 1 deciduous (bare in winter), 2 semi / drought deciduous (thins out), 3 seasonal grass. */
export type Habit = 0 | 1 | 2 | 3;

export type Variant = {
  model: FloraModel;
  habit: Habit;
  /** summer foliage, autumn colour, bark (sRGB hex) */
  leaf: string;
  autumn: string;
  bark: string;
  /** proportions against the base shape: width, height */
  w: number;
  h: number;
};

// id: model, habit, leaf, autumn, bark, width, height
const RAW: [string, FloraModel, Habit, string, string, string, number, number][] = [
  ['maple', 'tree_round', 1, '#5f8f3e', '#d9541e', '#5b4a3c', 1, 1],
  ['linden', 'tree_round', 1, '#6f9a45', '#d8b23a', '#5e5045', 1, 1.05],
  ['plane_tree', 'tree_round', 1, '#6c9443', '#c08a3a', '#9a907c', 1.1, 1.15],
  ['tropical_street_tree', 'tree_round', 0, '#3f7d36', '#3f7d36', '#5a4a3a', 1.1, 0.95],
  ['south_america_subtropical', 'tree_round', 0, '#3c7a3a', '#3c7a3a', '#5a4a3a', 1.1, 1.05],
  ['jacaranda', 'tree_round', 2, '#8c74c8', '#7a9a50', '#5a4a3c', 1.15, 0.85],
  ['oak', 'tree_spreading', 1, '#557f36', '#a8742e', '#54473b', 1, 1],
  ['beech', 'tree_spreading', 1, '#6b9840', '#b4602a', '#8a8a80', 0.9, 1.1],
  ['cork_oak', 'tree_spreading', 0, '#5a7444', '#5a7444', '#8a5a3a', 0.95, 0.85],
  ['live_oak', 'tree_spreading', 0, '#4d6e3a', '#4d6e3a', '#4a4038', 1.15, 0.85],
  ['southern_beech', 'tree_spreading', 1, '#6a8f3e', '#d0802c', '#5e5448', 0.85, 1.05],
  ['ficus', 'tree_spreading', 0, '#3d7432', '#3d7432', '#8a8378', 1.25, 1],
  ['southern_beech_evergreen', 'tree_spreading', 0, '#3f6634', '#3f6634', '#5e5448', 0.85, 1.05],
  ['nz_beech', 'tree_spreading', 0, '#45683a', '#45683a', '#5a5046', 0.85, 1],
  ['california_live_oak', 'tree_spreading', 0, '#55703f', '#55703f', '#5a4c40', 1.15, 0.8],
  ['nz_evergreen_broadleaf', 'tree_spreading', 0, '#3f7038', '#3f7038', '#5a4c40', 0.9, 0.9],
  ['lombardy_poplar', 'tree_columnar', 1, '#6c9a44', '#e0c040', '#6a6050', 1.25, 1.15],
  ['med_cypress', 'tree_columnar', 0, '#2f4f2c', '#2f4f2c', '#4a3a2e', 0.8, 1],
  ['birch', 'tree_birch_airy', 1, '#7aa64a', '#e8c447', '#e8e4dc', 1, 1],
  ['alder', 'tree_birch_airy', 1, '#557f3a', '#8a8a3a', '#5e5a52', 1, 0.95],
  ['willow', 'tree_birch_airy', 1, '#8aa858', '#c8b648', '#6a5c48', 1.3, 0.8],
  ['cottonwood', 'tree_birch_airy', 1, '#6e9a44', '#e6c43a', '#8a8070', 1.2, 1.15],
  ['spruce', 'tree_spruce', 0, '#2e5532', '#2e5532', '#4a3a2e', 1, 1],
  ['fir', 'tree_spruce', 0, '#2f5a3a', '#2f5a3a', '#5a4a40', 0.9, 1.05],
  ['larch', 'tree_spruce', 1, '#6e9a46', '#d8a838', '#5a4636', 0.95, 1],
  ['scots_pine', 'tree_pine', 0, '#44683a', '#44683a', '#b0663a', 1, 1],
  ['maritime_pine', 'tree_pine', 0, '#3f6334', '#3f6334', '#6a4a34', 1.05, 0.95],
  ['ponderosa_pine', 'tree_pine', 0, '#4a6c3a', '#4a6c3a', '#9a6a44', 1, 1.1],
  ['east_asian_pine', 'tree_pine', 0, '#3c6232', '#3c6232', '#6a4a3a', 1.2, 0.75],
  ['loblolly_pine', 'tree_pine', 0, '#4a6c38', '#4a6c38', '#7a5a40', 1, 1.05],
  ['jack_pine', 'tree_pine', 0, '#44663a', '#44663a', '#6a5040', 0.85, 0.8],
  ['nz_podocarp', 'tree_pine', 0, '#3a5e34', '#3a5e34', '#6a5040', 1.05, 1],
  ['stone_pine', 'tree_pine_umbrella', 0, '#4f6e38', '#4f6e38', '#7a5a44', 1, 1],
  ['olive', 'tree_gnarled', 0, '#8a9a6a', '#8a9a6a', '#6e665c', 1, 1],
  ['argan', 'tree_gnarled', 0, '#6a7a48', '#6a7a48', '#5e5246', 1.1, 0.9],
  ['mesquite', 'tree_gnarled', 1, '#7a8f4e', '#a8984e', '#4e4236', 1.15, 1],
  ['australian_mallee', 'tree_gnarled', 0, '#7a8a5e', '#7a8a5e', '#c0b4a0', 0.9, 1.2],
  ['tamarisk', 'tree_gnarled', 0, '#8aa080', '#8aa080', '#6a5a4a', 1, 0.9],
  ['cerrado_tree', 'tree_gnarled', 2, '#6e8a44', '#a89048', '#4a3e34', 1.1, 1],
  ['savanna_acacia', 'tree_acacia', 2, '#7a9447', '#a8a050', '#5a4a3a', 1, 1],
  ['thorn_tree', 'tree_acacia', 2, '#869a52', '#a89a58', '#5e4e40', 0.8, 0.8],
  ['australian_acacia', 'tree_acacia', 0, '#7a9058', '#7a9058', '#5a4a3e', 0.85, 0.9],
  ['date_palm', 'tree_palm', 0, '#6e8a48', '#6e8a48', '#8a7458', 1, 1.1],
  ['coconut_palm', 'tree_palm', 0, '#5e8e3a', '#5e8e3a', '#8a7a64', 1.05, 1.2],
  ['fan_palm', 'tree_palm', 0, '#5e8a44', '#5e8a44', '#7a6a58', 0.85, 0.85],
  ['oil_palm', 'tree_palm', 0, '#4e7a34', '#4e7a34', '#6a5a48', 1.15, 0.8],
  ['rainforest_canopy', 'tree_tropical', 0, '#3a7030', '#3a7030', '#8a8070', 1, 1],
  ['tropical_dry_tree', 'tree_tropical', 2, '#6a8a3e', '#a08a40', '#7a6a58', 0.9, 0.7],
  ['rainforest_ficus', 'tree_tropical', 0, '#356a2e', '#356a2e', '#9a9282', 1.15, 0.9],
  ['eucalyptus', 'tree_eucalyptus', 0, '#7f9468', '#7f9468', '#d8d0c0', 1, 1],
  ['boxwood', 'bush_round', 0, '#3f6e34', '#3f6e34', '#4a3e30', 1, 1],
  ['hazel_shrub', 'bush_round', 1, '#6a9040', '#c0a040', '#5a4a3a', 1.2, 1.3],
  ['rhododendron', 'bush_round', 0, '#3a6232', '#3a6232', '#4a3e30', 1.1, 1.1],
  ['tropical_shrub', 'bush_round', 0, '#3e7a34', '#3e7a34', '#4a3e30', 1.15, 1.1],
  ['tundra_dwarf_willow', 'bush_round', 1, '#7a9050', '#c09040', '#5a4a3a', 0.9, 0.45],
  ['rosemary', 'bush_dry', 0, '#6e7f5e', '#6e7f5e', '#5a4a3a', 0.9, 0.9],
  ['cistus', 'bush_dry', 0, '#7a8a5a', '#7a8a5a', '#5a4a3a', 1, 0.9],
  ['sagebrush', 'bush_dry', 0, '#9aa28a', '#9aa28a', '#6a5a4a', 1, 1],
  ['saltbush', 'bush_dry', 0, '#9aa08a', '#9aa08a', '#6a5a4a', 1.1, 0.9],
  ['desert_creosote', 'bush_dry', 0, '#6f7f42', '#6f7f42', '#5a4a3a', 1, 1.2],
  ['australian_heath', 'bush_dry', 0, '#7a8a58', '#7a8a58', '#5a4a3a', 0.9, 0.9],
  ['chaparral_shrub', 'bush_dry', 0, '#6a7a4a', '#6a7a4a', '#5a4a3a', 1.2, 1.2],
  ['temperate_grass', 'grass_tuft', 3, '#7aa04a', '#c8a858', '#7aa04a', 1, 1],
  ['savanna_grass', 'grass_tuft', 3, '#b8b060', '#d0b070', '#b8b060', 1.2, 1.4],
  ['tundra_sedge', 'grass_tuft', 3, '#8a9a5a', '#b89a5a', '#8a9a5a', 0.9, 0.8],
  ['tropical_fern', 'grass_tuft', 0, '#4a8a3a', '#4a8a3a', '#4a8a3a', 1.4, 1.3],
  ['agave', 'succulent', 0, '#7a9a8a', '#7a9a8a', '#7a9a8a', 1.1, 1],
  ['prickly_pear', 'succulent', 0, '#6a9a4a', '#6a9a4a', '#6a9a4a', 0.9, 1.2],
  ['aloe', 'succulent', 0, '#7a9a6a', '#7a9a6a', '#7a9a6a', 0.8, 0.8],
];

export const VARIANTS: Record<string, Variant> = Object.fromEntries(
  RAW.map(([id, model, habit, leaf, autumn, bark, w, h]) => [id, { model, habit, leaf, autumn, bark, w, h }]),
);

export type Mix = [string, number][];
export type Preset = { trees: Mix; under: Mix; /** street trees, one species per street */ street: string[]; hedge: string };

const STREET_TEMPERATE = ['plane_tree', 'linden', 'maple', 'oak'];
const STREET_MED = ['plane_tree', 'jacaranda', 'stone_pine', 'med_cypress', 'fan_palm'];
const STREET_TROPICAL = ['ficus', 'coconut_palm', 'tropical_street_tree', 'rainforest_ficus'];
const STREET_DESERT = ['date_palm', 'fan_palm', 'eucalyptus', 'plane_tree'];

export const PRESETS: Record<string, Preset> = {
  equatorial_rainforest: { trees: [['rainforest_canopy', 45], ['rainforest_ficus', 25], ['coconut_palm', 15], ['oil_palm', 15]], under: [['tropical_shrub', 60], ['tropical_fern', 40]], street: STREET_TROPICAL, hedge: 'tropical_shrub' },
  tropical_savanna_africa: { trees: [['savanna_acacia', 65], ['thorn_tree', 20], ['tropical_dry_tree', 15]], under: [['savanna_grass', 75], ['saltbush', 25]], street: ['tropical_street_tree', 'savanna_acacia', 'fan_palm', 'ficus'], hedge: 'tropical_shrub' },
  tropical_savanna_americas: { trees: [['cerrado_tree', 45], ['tropical_dry_tree', 35], ['rainforest_ficus', 20]], under: [['savanna_grass', 70], ['tropical_shrub', 30]], street: STREET_TROPICAL, hedge: 'tropical_shrub' },
  tropical_savanna_australia: { trees: [['eucalyptus', 70], ['australian_acacia', 20], ['fan_palm', 10]], under: [['savanna_grass', 75], ['saltbush', 25]], street: ['eucalyptus', 'fan_palm', 'ficus', 'tropical_street_tree'], hedge: 'tropical_shrub' },
  hot_desert_africa_arabia: { trees: [['thorn_tree', 50], ['date_palm', 30], ['tamarisk', 20]], under: [['saltbush', 75], ['savanna_grass', 25]], street: STREET_DESERT, hedge: 'rosemary' },
  hot_desert_american: { trees: [['mesquite', 75], ['cottonwood', 15], ['fan_palm', 10]], under: [['agave', 30], ['prickly_pear', 30], ['desert_creosote', 40]], street: ['fan_palm', 'mesquite', 'date_palm', 'eucalyptus'], hedge: 'desert_creosote' },
  mediterranean_europe: { trees: [['olive', 30], ['stone_pine', 30], ['cork_oak', 25], ['med_cypress', 15]], under: [['rosemary', 60], ['cistus', 40]], street: STREET_MED, hedge: 'boxwood' },
  mediterranean_california: { trees: [['california_live_oak', 55], ['ponderosa_pine', 25], ['fan_palm', 20]], under: [['chaparral_shrub', 75], ['sagebrush', 25]], street: ['fan_palm', 'plane_tree', 'california_live_oak', 'jacaranda'], hedge: 'chaparral_shrub' },
  mediterranean_south_australia: { trees: [['eucalyptus', 75], ['australian_mallee', 25]], under: [['australian_heath', 70], ['saltbush', 30]], street: ['eucalyptus', 'plane_tree', 'jacaranda', 'fan_palm'], hedge: 'australian_heath' },
  humid_subtropical_east_asia: { trees: [['ficus', 25], ['oak', 25], ['east_asian_pine', 30], ['fan_palm', 20]], under: [['rhododendron', 60], ['tropical_shrub', 40]], street: ['maple', 'plane_tree', 'east_asian_pine', 'linden'], hedge: 'rhododendron' },
  humid_subtropical_southeast_us: { trees: [['live_oak', 35], ['oak', 25], ['maple', 15], ['loblolly_pine', 25]], under: [['boxwood', 45], ['rhododendron', 55]], street: ['live_oak', 'plane_tree', 'maple', 'fan_palm'], hedge: 'boxwood' },
  humid_subtropical_south_america: { trees: [['south_america_subtropical', 40], ['rainforest_ficus', 20], ['tropical_dry_tree', 25], ['eucalyptus', 15]], under: [['tropical_shrub', 70], ['temperate_grass', 30]], street: ['tropical_street_tree', 'jacaranda', 'plane_tree', 'ficus'], hedge: 'tropical_shrub' },
  temperate_oceanic_europe: { trees: [['oak', 30], ['beech', 30], ['linden', 20], ['birch', 20]], under: [['hazel_shrub', 60], ['temperate_grass', 40]], street: STREET_TEMPERATE, hedge: 'boxwood' },
  temperate_continental_eurasia: { trees: [['birch', 30], ['scots_pine', 25], ['oak', 25], ['spruce', 20]], under: [['hazel_shrub', 40], ['temperate_grass', 60]], street: ['linden', 'maple', 'birch', 'lombardy_poplar'], hedge: 'boxwood' },
  temperate_continental_n_america: { trees: [['maple', 35], ['oak', 30], ['birch', 20], ['spruce', 15]], under: [['hazel_shrub', 30], ['temperate_grass', 70]], street: ['maple', 'oak', 'linden', 'plane_tree'], hedge: 'boxwood' },
  continental_steppe_eurasia: { trees: [['lombardy_poplar', 45], ['willow', 30], ['scots_pine', 25]], under: [['temperate_grass', 70], ['saltbush', 30]], street: ['lombardy_poplar', 'linden', 'maple', 'willow'], hedge: 'boxwood' },
  continental_prairie_n_america: { trees: [['oak', 35], ['cottonwood', 45], ['willow', 20]], under: [['temperate_grass', 70], ['sagebrush', 30]], street: ['maple', 'oak', 'cottonwood', 'linden'], hedge: 'boxwood' },
  boreal_eurasia: { trees: [['spruce', 35], ['scots_pine', 25], ['larch', 25], ['birch', 15]], under: [['tundra_dwarf_willow', 30], ['tundra_sedge', 70]], street: ['birch', 'linden', 'spruce', 'scots_pine'], hedge: 'boxwood' },
  boreal_n_america: { trees: [['spruce', 50], ['fir', 25], ['birch', 15], ['jack_pine', 10]], under: [['tundra_dwarf_willow', 30], ['tundra_sedge', 70]], street: ['birch', 'maple', 'spruce', 'fir'], hedge: 'boxwood' },
  southern_temperate_chile_argentina: { trees: [['southern_beech', 40], ['southern_beech_evergreen', 60]], under: [['tropical_shrub', 35], ['temperate_grass', 65]], street: ['plane_tree', 'southern_beech', 'linden', 'lombardy_poplar'], hedge: 'boxwood' },
  southern_temperate_new_zealand: { trees: [['nz_beech', 45], ['nz_podocarp', 30], ['nz_evergreen_broadleaf', 25]], under: [['tropical_fern', 35], ['tropical_shrub', 65]], street: ['nz_evergreen_broadleaf', 'plane_tree', 'nz_beech', 'oak'], hedge: 'boxwood' },
  southern_temperate_tasmania: { trees: [['eucalyptus', 60], ['southern_beech_evergreen', 25], ['southern_beech', 15]], under: [['australian_heath', 45], ['tropical_fern', 55]], street: ['eucalyptus', 'plane_tree', 'oak', 'linden'], hedge: 'australian_heath' },
  tundra: { trees: [], under: [['tundra_dwarf_willow', 45], ['tundra_sedge', 55]], street: [], hedge: 'tundra_dwarf_willow' },
  polar_ice: { trees: [], under: [], street: [], hedge: '' },
};

const box = (lng: number, lat: number, w: number, e: number, s: number, n: number) => lng >= w && lng <= e && lat >= s && lat <= n;

/** Approximate polar circles: beyond these, only tundra shrubs (or ice). */
const POLAR = 66.5;

/**
 * Climate preset of a place. Geography wins over latitude: New Zealand is not
 * Chile, California is not the Sahara. Boxes are coarse on purpose (a game).
 */
export function selectPreset(lat: number, lng: number): string {
  const a = Math.abs(lat);
  // Past the polar circle first: Vorkuta, Murmansk, northern Alaska — no tall trees
  if (a > 75) return 'polar_ice';
  if (a > POLAR) return 'tundra';
  // Oceania
  if (box(lng, lat, 165, 179.9, -48, -33)) return 'southern_temperate_new_zealand';
  if (box(lng, lat, 143.5, 149, -44, -39.5)) return 'southern_temperate_tasmania';
  if (box(lng, lat, 112, 155, -40, -10)) {
    if (lat > -22) return 'tropical_savanna_australia';
    if (lng < 125 || lng < 141 && lat < -30) return 'mediterranean_south_australia';
    return 'mediterranean_south_australia'; // the east coast too: eucalyptus country
  }
  // South and Central America
  if (box(lng, lat, -82, -34, -56, 13)) {
    if (lat < -38 || lng < -70 && lat < -30) return 'southern_temperate_chile_argentina';
    if (lng < -70 && lat < -18) return 'hot_desert_american'; // Atacama coast
    if (lat < -23 || lat < -15 && lng > -48) return 'humid_subtropical_south_america'; // and the Atlantic Forest coast
    if (lat < -6 && lng > -60) return 'tropical_savanna_americas';
    return 'equatorial_rainforest';
  }
  // North America
  if (box(lng, lat, -170, -50, 13, 72)) {
    if (lat > 52) return 'boreal_n_america';
    if (lat < 22) return lat < 18 ? 'equatorial_rainforest' : 'tropical_savanna_americas';
    if (lng < -116 && lat < 42) return lat < 34 && lng > -118 ? 'hot_desert_american' : 'mediterranean_california';
    if (lng < -103 && lat < 38) return 'hot_desert_american';
    if (lng < -116) return 'temperate_continental_n_america'; // Pacific Northwest
    if (lng < -96) return 'continental_prairie_n_america';
    if (lat < 37) return 'humid_subtropical_southeast_us';
    return 'temperate_continental_n_america';
  }
  // Africa (north coast and Cape are Mediterranean)
  if (box(lng, lat, -18, 52, -35, 37.5)) {
    if (lat > 31) return 'mediterranean_europe';
    if (lat < -32 && lng < 27) return 'mediterranean_europe';
    if (lat > 15) return 'hot_desert_africa_arabia';
    if (lat > -6 && lat < 8 && lng < 31) return 'equatorial_rainforest';
    return 'tropical_savanna_africa';
  }
  // Arabia, Middle East, Iran
  if (box(lng, lat, 34, 62, 12, 33)) return lat > 31 && lng < 37 ? 'mediterranean_europe' : 'hot_desert_africa_arabia';
  // Europe (polar latitudes already returned tundra above)
  if (box(lng, lat, -25, 45, 34, 72)) {
    if (lat > 59) return lng > 20 || lat > 61 ? 'boreal_eurasia' : 'temperate_continental_eurasia';
    // Mediterranean belt: Iberia, south of France, Italy, the Balkans' coast, Greece, Turkey's coast
    if (lat < 44.5 && !(lng > 20 && lat > 42)) return 'mediterranean_europe';
    if (lng > 30 && lat < 52) return 'continental_steppe_eurasia';
    if (lng > 16) return 'temperate_continental_eurasia';
    return 'temperate_oceanic_europe';
  }
  // Asia
  if (lng > 45 && lng < 180) {
    if (lat > 55) return 'boreal_eurasia';
    if (lng > 100 && lat > 20 && lat < 43) return 'humid_subtropical_east_asia';
    if (lng > 125 && lat >= 43) return 'temperate_continental_eurasia'; // Hokkaido, Primorye
    if (lat > 45) return lng < 120 && lat < 52 ? 'continental_steppe_eurasia' : 'temperate_continental_eurasia';
    if (lat > 35) return 'continental_steppe_eurasia';
    if (lat > 24 && lng < 75) return 'hot_desert_africa_arabia';
    if (lat < 12 || lng > 92) return 'equatorial_rainforest';
    return 'tropical_savanna_africa'; // the Indian plains: dry tropical trees
  }
  // latitude fallback (catalog latitude_fallback, first choice)
  if (a < 12) return 'equatorial_rainforest';
  if (a < 25) return 'tropical_savanna_africa';
  if (a < 35) return 'mediterranean_europe';
  if (a < 45) return 'temperate_oceanic_europe';
  if (a < 60) return 'temperate_continental_eurasia';
  return 'boreal_eurasia';
}

/** Weighted pick, `roll` in [0, 1). */
export function pickMix(mix: Mix, roll: number): string | null {
  if (!mix.length) return null;
  const total = mix.reduce((s, [, w]) => s + w, 0);
  let cursor = roll * total;
  for (const [id, w] of mix) { cursor -= w; if (cursor < 0) return id; }
  return mix[mix.length - 1][0];
}
