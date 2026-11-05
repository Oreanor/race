export type Season = 'spring' | 'summer' | 'autumn' | 'winter';
export const SEASONS: Season[] = ['spring', 'summer', 'autumn', 'winter'];
/** Shift+T cycles seasons first; the place's current season is the last step. */
export type SeasonMode = 'real' | Season;
export const SEASON_MODES: SeasonMode[] = [...SEASONS, 'real'];

/**
 * The season at this latitude on this date (meteorological: whole months).
 * The south is half a year apart; the tropics stay green all year.
 */
export function seasonAt(date: Date, lat: number): Season {
  if (Math.abs(lat) < 23.44) return 'summer';
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  let day = Math.floor((date.getTime() - start) / 86400000); // 0 = 1 January
  if (lat < 0) day = (day + 183) % 365;
  if (day < 59) return 'winter'; // Jan, Feb
  if (day < 151) return 'spring'; // Mar – May
  if (day < 243) return 'summer'; // Jun – Aug
  if (day < 334) return 'autumn'; // Sep – Nov
  return 'winter';
}

/** Soft 0..1 ramp between two edges (same curve as GLSL smoothstep). */
function smoothstep(edge0: number, edge1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * How much winter snow the ground may show at this latitude (0..1).
 * Lying snow from ~42° N and ~42° S; fades in over a few degrees around that.
 */
export function snowCoverAt(lat: number): number {
  return smoothstep(42, 48, Math.abs(lat));
}
