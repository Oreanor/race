import * as THREE from 'three';
import { moonIllumination, moonPosition, skyDirection, sunPosition, type SkyPosition } from '../astro.ts';

// Real light for a place and a moment: sun height drives the colour of the
// sunlight, the ambient sky light and the sky/fog colour; at night the moon
// (by phase and height) takes over and windows light up.

export type TimeMode = 'real' | 'morning' | 'day' | 'evening' | 'night';
/** T cycles presets first; local time is the last step. */
export const TIME_MODES: TimeMode[] = ['morning', 'day', 'evening', 'night', 'real'];

export type Lighting = {
  /** direction toward the main light (sun, or moon at night), scene axes */
  dir: THREE.Vector3;
  /** main light colour × intensity, linear */
  sun: THREE.Color;
  /** sky light colour × intensity, linear */
  ambient: THREE.Color;
  /** sky and fog colour, sRGB */
  sky: THREE.Color;
  /** 0 by day … 1 at night: window and lamp glow */
  night: number;
  sunPos: SkyPosition;
  moonPos: SkyPosition;
  moonPhase: number;
  moonFraction: number;
  /** overall brightness relative to daylight (for the car's lights) */
  level: number;
  /** 0 … 1: a low sun in the evening (warm grade) and in the morning (cool grade) */
  warm: number;
  cool: number;
};

type Key = { h: number; sun: [number, number, number]; amb: [number, number, number]; sky: string };

// Sun altitude (degrees) → light. By day the sun is the strong key and the sky light a
// near-neutral, weaker fill. A low sun is not the same morning and evening. Dawn is cool and clean: a rose-gold sun,
// a lilac-blue sky light, a pale rose haze. Sunset is hot and deep: an orange-red sun low
// over a rose-pink horizon, then violet dusk.
const DAWN: Key[] = [
  { h: -18, sun: [0, 0, 0], amb: [0.1, 0.12, 0.2], sky: '#121827' },
  { h: -10, sun: [0, 0, 0], amb: [0.15, 0.18, 0.3], sky: '#1d2a48' },
  { h: -4, sun: [0, 0, 0], amb: [0.3, 0.32, 0.48], sky: '#5a6a9e' },
  { h: 0, sun: [0.62, 0.38, 0.4], amb: [0.44, 0.44, 0.6], sky: '#d99fb2' },
  { h: 5, sun: [0.86, 0.64, 0.56], amb: [0.5, 0.54, 0.68], sky: '#e6cdd6' },
  { h: 12, sun: [0.92, 0.8, 0.68], amb: [0.54, 0.57, 0.64], sky: '#d6dbe2' },
  { h: 30, sun: [0.9, 0.86, 0.76], amb: [0.58, 0.59, 0.61], sky: '#d3d7d8' },
  { h: 90, sun: [0.9, 0.87, 0.78], amb: [0.59, 0.6, 0.62], sky: '#d0d5d8' },
];
const DUSK: Key[] = [
  { h: -18, sun: [0, 0, 0], amb: [0.1, 0.11, 0.2], sky: '#141629' },
  { h: -10, sun: [0, 0, 0], amb: [0.16, 0.14, 0.27], sky: '#2a2148' },
  { h: -4, sun: [0, 0, 0], amb: [0.32, 0.24, 0.4], sky: '#5a3a6e' },
  { h: 0, sun: [0.78, 0.3, 0.22], amb: [0.5, 0.33, 0.44], sky: '#d6607a' },
  { h: 3, sun: [0.95, 0.48, 0.34], amb: [0.56, 0.41, 0.48], sky: '#ea8d8e' },
  { h: 8, sun: [0.95, 0.64, 0.48], amb: [0.58, 0.51, 0.54], sky: '#efb6ad' },
  { h: 16, sun: [0.92, 0.78, 0.6], amb: [0.56, 0.56, 0.58], sky: '#dcd8d2' },
  { h: 30, sun: [0.9, 0.86, 0.76], amb: [0.58, 0.59, 0.61], sky: '#d3d7d8' },
  { h: 90, sun: [0.9, 0.87, 0.78], amb: [0.59, 0.6, 0.62], sky: '#d0d5d8' },
];

const tmpA = new THREE.Color(), tmpB = new THREE.Color();

function sample(h: number, keys: Key[]) {
  let i = 0;
  while (i < keys.length - 2 && h > keys[i + 1].h) i++;
  const a = keys[i], b = keys[i + 1];
  const t = Math.min(1, Math.max(0, (h - a.h) / (b.h - a.h)));
  const mix = (x: [number, number, number], y: [number, number, number]) => x.map((v, k) => v + (y[k] - v) * t) as [number, number, number];
  // sky colours stay in sRGB: the fog shader converts them itself
  tmpA.setStyle(a.sky, THREE.NoColorSpace); tmpB.setStyle(b.sky, THREE.NoColorSpace);
  const sky = tmpA.clone().lerp(tmpB, t);
  return { sun: mix(a.sun, b.sun), amb: mix(a.amb, b.amb), sky };
}

export function computeLighting(date: Date, lat: number, lng: number): Lighting {
  const sunPos = sunPosition(date, lat, lng);
  const moonPos = moonPosition(date, lat, lng);
  const { fraction, phase } = moonIllumination(date);
  const h = sunPos.altitude * 180 / Math.PI;
  // morning has the dawn colours, afternoon and evening the sunset ones; the two hand over
  // gently (an hour each side of solar noon and midnight), never in a jump while you play
  const solar = ((date.getUTCHours() * 60 + date.getUTCMinutes() + lng * 4) % 1440 + 1440) % 1440;
  const ramp = (m: number) => Math.min(1, Math.max(0, (m + 60) / 120));
  /** 0 morning … 1 afternoon and evening; ½ right at solar noon and midnight */
  const eveningShare = solar < 360 ? 1 - ramp(solar) : solar < 1080 ? ramp(solar - 720) : 1 - ramp(solar - 1440);
  const dawnS = sample(h, DAWN), duskS = sample(h, DUSK);
  const mixK = (a: [number, number, number], b: [number, number, number]) => a.map((v, i) => v + (b[i] - v) * eveningShare) as [number, number, number];
  const s = { sun: mixK(dawnS.sun, duskS.sun), amb: mixK(dawnS.amb, duskS.amb), sky: dawnS.sky.clone().lerp(duskS.sky, eveningShare) };
  const sun = new THREE.Color(s.sun[0], s.sun[1], s.sun[2]);
  const ambient = new THREE.Color(s.amb[0], s.amb[1], s.amb[2]);
  const sky = s.sky.clone();
  let dir = new THREE.Vector3(...skyDirection(sunPos));
  const night = Math.min(1, Math.max(0, (-2 - h) / 8));
  if (h < -4) {
    // moonlight: cold, as strong as the lit fraction and the moon's height allow
    const up = Math.min(1, Math.max(0, moonPos.altitude * 180 / Math.PI / 25));
    // it comes up gradually as the dusk deepens (sun −4° … −10°), not all at once
    const moon = fraction * up * Math.min(1, (-4 - h) / 6);
    sun.setRGB(0.2 * moon, 0.24 * moon, 0.34 * moon);
    ambient.r += 0.04 * moon; ambient.g += 0.05 * moon; ambient.b += 0.08 * moon;
    sky.lerp(new THREE.Color().setStyle('#2b3a5c', THREE.NoColorSpace), 0.25 * moon * night);
    if (moonPos.altitude > 0) dir = new THREE.Vector3(...skyDirection(moonPos));
  }
  if (dir.y < 0.05) { dir.y = 0.05; dir.normalize(); } // light never comes from below the ground
  const level = Math.min(1, (ambient.r + ambient.g + ambient.b) / 3 / 0.6); // full day = 1
  // a low sun tints the whole picture: warm late in the day, fresh and cool early
  const low = Math.max(0, Math.min(1, 1 - h / 20)) * Math.max(0, Math.min(1, (h + 6) / 6));
  return { dir, sun, ambient, sky, night, sunPos, moonPos, moonPhase: phase, moonFraction: fraction, level, warm: low * eveningShare, cool: low * (1 - eveningShare) };
}

/** Time to show for a mode: the real moment, or a typical one of this day here. */
export function timeFor(mode: TimeMode, now: Date, lat: number, lng: number): Date {
  if (mode === 'real') return now;
  // scan this day (local solar day) in 5-minute steps
  const solarNoon = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12) - lng / 15 * 3600000;
  const at = (minutes: number) => new Date(solarNoon + minutes * 60000);
  const alt = (minutes: number) => sunPosition(at(minutes), lat, lng).altitude * 180 / Math.PI;
  if (mode === 'day') return at(0);
  if (mode === 'night') return at(12 * 60);
  // low enough to show it: a fresh early morning, the sun just going down
  const target = mode === 'morning' ? 5 : 2.5;
  const step = mode === 'morning' ? -5 : 5;
  // walk from noon toward sunrise (morning) or sunset (evening) until the sun is this low
  for (let m = 0; Math.abs(m) <= 12 * 60; m += step) if (alt(m) <= target) return at(m);
  return at(mode === 'morning' ? -4 * 60 : 4 * 60); // polar day: just pick a hour
}
