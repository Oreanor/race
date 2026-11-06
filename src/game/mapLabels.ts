/** POI / hub plaques the player can hide on the map. */
export const MAP_LABEL_KINDS = [
  'fuel',
  'repair',
  'dealer',
  'bank',
  'police',
  'prison',
  'court',
  'hospital',
  'hotel',
  'museum',
  'airport',
  'port',
  'station',
] as const;

export type MapLabelKind = (typeof MAP_LABEL_KINDS)[number];

export type MapLabelFilters = Record<MapLabelKind, boolean>;

/** Default: everyday stops — fuel, service, dealer, ports and stations. */
const DEFAULT_ON: ReadonlySet<MapLabelKind> = new Set(['fuel', 'repair', 'dealer', 'port', 'station']);
/** Always shown on the map (travel hubs); chip can still hide the rest. */
const ALWAYS_ON: ReadonlySet<MapLabelKind> = new Set(['port', 'station']);

export const defaultMapLabelFilters = (): MapLabelFilters =>
  Object.fromEntries(MAP_LABEL_KINDS.map((kind) => [kind, DEFAULT_ON.has(kind) || ALWAYS_ON.has(kind)])) as MapLabelFilters;

const STORE = 'cityRider.mapLabels';

/** Remembered chip toggles; unknown / broken entries fall back to on. */
export function loadMapLabelFilters(): MapLabelFilters {
  const out = defaultMapLabelFilters();
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? 'null') as Partial<Record<string, unknown>> | null;
    if (!raw || typeof raw !== 'object') return out;
    for (const kind of MAP_LABEL_KINDS) {
      if (typeof raw[kind] === 'boolean') out[kind] = raw[kind];
    }
  } catch { /* private mode */ }
  // Ports and stations stay available for travel — don't leave them stuck off from an old save.
  for (const kind of ALWAYS_ON) out[kind] = true;
  return out;
}

export function saveMapLabelFilters(filters: MapLabelFilters) {
  try { localStorage.setItem(STORE, JSON.stringify(filters)); } catch { /* private mode */ }
}

/** i18n key for a chip / map plaque title. */
export function mapLabelMessageKey(kind: MapLabelKind):
  | 'poi.fuel' | 'poi.service' | 'poi.dealer' | 'poi.bank'
  | 'poi.police' | 'poi.prison' | 'poi.court' | 'poi.hospital'
  | 'poi.hotel' | 'poi.museum'
  | 'hub.airport' | 'hub.port' | 'hub.station' {
  if (kind === 'airport' || kind === 'port' || kind === 'station') return `hub.${kind}`;
  if (kind === 'repair') return 'poi.service';
  return `poi.${kind}`;
}
