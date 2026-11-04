import tzlookup from '@photostructure/tz-lookup';

/** IANA time zone of a place on the map (Europe/Lisbon …); UTC if unknown. */
export function placeZone(lat: number, lng: number): string {
  try {
    return tzlookup(lat, lng);
  } catch {
    return 'UTC';
  }
}

type Wall = { year: number; month: number; day: number; hours: number; minutes: number };

function wallClock(date: Date, zone: string): Wall {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find(part => part.type === type)?.value ?? 0);
  return { year: get('year'), month: get('month'), day: get('day'), hours: get('hour'), minutes: get('minute') };
}

/** What the clocks show at this place at this moment, as "HH:MM". */
export function placeClock(date: Date, lat: number, lng: number): string {
  const w = wallClock(date, placeZone(lat, lng));
  return `${String(w.hours).padStart(2, '0')}:${String(w.minutes).padStart(2, '0')}`;
}

/** The moment of this place's current day when its clocks show hours:minutes. */
export function placeMoment(now: Date, lat: number, lng: number, hours: number, minutes: number): Date {
  const w = wallClock(now, placeZone(lat, lng));
  // the zone's offset right now (in whole minutes)
  const wallNow = Date.UTC(w.year, w.month - 1, w.day, w.hours, w.minutes);
  const offset = Math.round((wallNow - now.getTime()) / 60000) * 60000;
  return new Date(Date.UTC(w.year, w.month - 1, w.day, hours, minutes) - offset);
}
