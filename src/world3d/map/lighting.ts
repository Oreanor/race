import * as THREE from 'three';
import { moonIllumination, moonPosition, skyDirection, sunPosition, type SkyPosition } from '../astro';

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
};

type Key = { h: number; sun: [number, number, number]; amb: [number, number, number]; sky: string };

// sun altitude (degrees) → light. By day the sun is the strong key and the sky light a
// near-neutral, weaker fill: lit and shaded sides read apart without a blue cast; the
// horizon haze is a light grey-blue, so distant blocks don't turn bluish
const KEYS: Key[] = [
  { h: -18, sun: [0, 0, 0], amb: [0.1, 0.12, 0.2], sky: '#121827' },
  { h: -10, sun: [0, 0, 0], amb: [0.15, 0.17, 0.27], sky: '#1f2940' },
  { h: -4, sun: [0, 0, 0], amb: [0.3, 0.31, 0.43], sky: '#55628a' },
  { h: 0, sun: [0.58, 0.28, 0.14], amb: [0.45, 0.42, 0.5], sky: '#d99a86' },
  { h: 6, sun: [0.74, 0.5, 0.29], amb: [0.58, 0.56, 0.6], sky: '#efc9a8' },
  { h: 15, sun: [0.92, 0.78, 0.6], amb: [0.56, 0.56, 0.58], sky: '#dcdcd8' },
  { h: 30, sun: [0.9, 0.86, 0.76], amb: [0.58, 0.59, 0.61], sky: '#d3d7d8' },
  { h: 90, sun: [0.9, 0.87, 0.78], amb: [0.59, 0.6, 0.62], sky: '#d0d5d8' },
];

const tmpA = new THREE.Color(), tmpB = new THREE.Color();

function sample(h: number) {
  let i = 0;
  while (i < KEYS.length - 2 && h > KEYS[i + 1].h) i++;
  const a = KEYS[i], b = KEYS[i + 1];
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
  const s = sample(h);
  const sun = new THREE.Color(s.sun[0], s.sun[1], s.sun[2]);
  const ambient = new THREE.Color(s.amb[0], s.amb[1], s.amb[2]);
  const sky = s.sky.clone();
  let dir = new THREE.Vector3(...skyDirection(sunPos));
  const night = Math.min(1, Math.max(0, (-2 - h) / 8));
  if (h < -4) {
    // moonlight: cold, as strong as the lit fraction and the moon's height allow
    const up = Math.min(1, Math.max(0, moonPos.altitude * 180 / Math.PI / 25));
    const moon = fraction * up;
    sun.setRGB(0.2 * moon, 0.24 * moon, 0.34 * moon);
    ambient.r += 0.04 * moon; ambient.g += 0.05 * moon; ambient.b += 0.08 * moon;
    sky.lerp(new THREE.Color().setStyle('#2b3a5c', THREE.NoColorSpace), 0.25 * moon * night);
    if (moonPos.altitude > 0) dir = new THREE.Vector3(...skyDirection(moonPos));
  }
  if (dir.y < 0.05) { dir.y = 0.05; dir.normalize(); } // light never comes from below the ground
  const level = Math.min(1, (ambient.r + ambient.g + ambient.b) / 3 / 0.6); // full day = 1
  return { dir, sun, ambient, sky, night, sunPos, moonPos, moonPhase: phase, moonFraction: fraction, level };
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
  const target = mode === 'morning' ? 12 : 5;
  const step = mode === 'morning' ? -5 : 5;
  // walk from noon toward sunrise (morning) or sunset (evening) until the sun is this low
  for (let m = 0; Math.abs(m) <= 12 * 60; m += step) if (alt(m) <= target) return at(m);
  return at(mode === 'morning' ? -4 * 60 : 4 * 60); // polar day: just pick a hour
}
