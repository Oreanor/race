// Sun and moon positions and moon phase, after Vladimir Agafonkin's SunCalc
// (BSD-2), trimmed to what the lighting needs. Angles in radians.
// azimuth: from north, clockwise (east = +π/2). altitude: above the horizon.

const rad = Math.PI / 180;
const dayMs = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;
const e = rad * 23.4397; // obliquity of the Earth

const toJulian = (date: Date) => date.valueOf() / dayMs - 0.5 + J1970;
const toDays = (date: Date) => toJulian(date) - J2000;

const rightAscension = (l: number, b: number) => Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
const declination = (l: number, b: number) => Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
const siderealTime = (d: number, lw: number) => rad * (280.16 + 360.9856235 * d) - lw;

// SunCalc azimuth is measured from south; convert to "from north, clockwise"
const azimuthFromNorth = (H: number, phi: number, dec: number) =>
  Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)) + Math.PI;
const altitudeOf = (H: number, phi: number, dec: number) =>
  Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));

function sunCoords(d: number) {
  const M = rad * (357.5291 + 0.98560028 * d);
  const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + rad * 102.9372 + Math.PI;
  return { dec: declination(L, 0), ra: rightAscension(L, 0) };
}

function moonCoords(d: number) {
  const L = rad * (218.316 + 13.176396 * d);
  const M = rad * (134.963 + 13.064993 * d);
  const F = rad * (93.272 + 13.22935 * d);
  const l = L + rad * 6.289 * Math.sin(M);
  const b = rad * 5.128 * Math.sin(F);
  const dt = 385001 - 20905 * Math.cos(M);
  return { ra: rightAscension(l, b), dec: declination(l, b), dist: dt };
}

export type SkyPosition = { azimuth: number; altitude: number };

export function sunPosition(date: Date, lat: number, lng: number): SkyPosition {
  const lw = rad * -lng, phi = rad * lat, d = toDays(date);
  const c = sunCoords(d);
  const H = siderealTime(d, lw) - c.ra;
  return { azimuth: azimuthFromNorth(H, phi, c.dec), altitude: altitudeOf(H, phi, c.dec) };
}

export function moonPosition(date: Date, lat: number, lng: number): SkyPosition {
  const lw = rad * -lng, phi = rad * lat, d = toDays(date);
  const c = moonCoords(d);
  const H = siderealTime(d, lw) - c.ra;
  let h = altitudeOf(H, phi, c.dec);
  h += rad * 0.017 / Math.tan(h + rad * 10.26 / (h + rad * 5.10)); // refraction
  return { azimuth: azimuthFromNorth(H, phi, c.dec), altitude: h };
}

/** fraction lit 0..1; phase 0 new → 0.25 first quarter → 0.5 full → 0.75 last quarter. */
export function moonIllumination(date: Date) {
  const d = toDays(date);
  const s = sunCoords(d);
  const m = moonCoords(d);
  const sdist = 149598000;
  const phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
  const inc = Math.atan2(sdist * Math.sin(phi), m.dist - sdist * Math.cos(phi));
  const angle = Math.atan2(Math.cos(s.dec) * Math.sin(s.ra - m.ra), Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra));
  return {
    fraction: (1 + Math.cos(inc)) / 2,
    phase: 0.5 + 0.5 * inc * (angle < 0 ? -1 : 1) / Math.PI,
  };
}

/** Unit vector in scene axes (x east, y up, z south) for a sky position. */
export function skyDirection(p: SkyPosition): [number, number, number] {
  const c = Math.cos(p.altitude);
  return [Math.sin(p.azimuth) * c, Math.sin(p.altitude), -Math.cos(p.azimuth) * c];
}
