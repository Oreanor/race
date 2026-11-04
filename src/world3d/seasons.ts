export type Season = 'spring' | 'summer' | 'autumn' | 'winter';
export const SEASONS: Season[] = ['spring', 'summer', 'autumn', 'winter'];
/** Shift+T: the place's real season, then each season in turn. */
export type SeasonMode = 'real' | Season;
export const SEASON_MODES: SeasonMode[] = ['real', ...SEASONS];

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
