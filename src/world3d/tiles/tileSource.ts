// OpenFreeMap vector tiles: where to fetch them.

const TILEJSON = 'https://tiles.openfreemap.org/planet';
const FALLBACK_TEMPLATE = 'https://tiles.openfreemap.org/planet/{z}/{x}/{y}.pbf';

/** Resolves OpenFreeMap's current versioned tile URL template once. */
let templatePromise: Promise<string> | null = null;
export function tileTemplate(): Promise<string> {
  templatePromise ??= fetch(TILEJSON)
    .then((r) => r.json())
    .then((json: { tiles?: string[] }) => json.tiles?.[0] ?? FALLBACK_TEMPLATE)
    .catch(() => FALLBACK_TEMPLATE);
  return templatePromise;
}
