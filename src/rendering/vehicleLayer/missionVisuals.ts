import * as THREE from 'three';
import type { MissionBeaconSpec } from './types.ts';

export function makeCoin() {
  const gold = new THREE.MeshStandardMaterial({ color: '#ffd54a', emissive: '#c88a10', emissiveIntensity: 0.45, metalness: 0.25, roughness: 0.3 });
  const deep = new THREE.MeshStandardMaterial({ color: '#f0b62a', emissive: '#a06c08', emissiveIntensity: 0.4, metalness: 0.2, roughness: 0.35 });
  const disc = new THREE.CylinderGeometry(0.5, 0.5, 0.09, 40).rotateX(Math.PI / 2);
  const rim = new THREE.TorusGeometry(0.46, 0.045, 8, 40);
  const star = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 0.12 : 0.27;
    const a = Math.PI / 2 + i * Math.PI / 5;
    if (i) star.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    else star.moveTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  const starGeometry = new THREE.ExtrudeGeometry(star, { depth: 0.13, bevelEnabled: false }).translate(0, 0, -0.065);
  const coin = new THREE.Group();
  coin.add(new THREE.Mesh(disc, deep));
  coin.add(new THREE.Mesh(rim, gold));
  coin.add(new THREE.Mesh(starGeometry, gold));
  coin.traverse((part) => { part.frustumCulled = false; part.renderOrder = 8; });
  return coin;
}

/** A cardboard box with a strip of tape over the top (the box hunt). */
export function makeBox() {
  const group = new THREE.Group();
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 0.9), new THREE.MeshLambertMaterial({ color: '#b8742a' }));
  const tape = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.72, 0.92), new THREE.MeshLambertMaterial({ color: '#e8d8a8' }));
  group.add(box, tape);
  return group;
}

/** A bundle of banknotes: a green brick with a paper band round its middle. */
export function makeCash() {
  const group = new THREE.Group();
  const notes = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.36, 0.55), new THREE.MeshLambertMaterial({ color: '#3f8f4e' }));
  const band = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.38, 0.57), new THREE.MeshLambertMaterial({ color: '#f1ead2' }));
  group.add(notes, band);
  return group;
}

export function colorsForBeacon(beacon: Pick<MissionBeaconSpec, 'kind' | 'colors'>) {
  if (beacon.colors) return beacon.colors;
  if (beacon.kind === 'arena') return { pole: '#2f7dff', glow: '#1a4fb8', orb: '#6eb6ff' };
  if (beacon.kind === 'bounty') return { pole: '#d63a2f', glow: '#8a1c14', orb: '#ff8a7a' };
  if (beacon.kind === 'fire') return { pole: '#e85d04', glow: '#9a3412', orb: '#fb923c' };
  if (beacon.kind === 'impound') return { pole: '#7c3aed', glow: '#5b21b6', orb: '#c4b5fd' };
  if (beacon.kind === 'taxi') return { pole: '#f2c230', glow: '#b8860b', orb: '#ffe56a' };
  if (beacon.kind === 'bus') return { pole: '#e85d2a', glow: '#9a3a12', orb: '#ffb08a' };
  if (beacon.kind === 'ambulance') return { pole: '#e11d48', glow: '#9f1239', orb: '#fb7185' };
  return { pole: '#ff7a1a', glow: '#b84a00', orb: '#ffb86b' };
}

/** Inverted map-pin beacon (caller adds to the scene). Soft / see-through so the street still reads. */
export function makeBeacon(pole: string, glow: string, orb: string) {
  const group = new THREE.Group();
  const profile = [
    new THREE.Vector2(0, 0),
    new THREE.Vector2(0.28, 0.55),
    new THREE.Vector2(0.72, 1.45),
    new THREE.Vector2(1.15, 2.35),
    new THREE.Vector2(1.35, 3.15),
    new THREE.Vector2(1.2, 3.95),
    new THREE.Vector2(0.7, 4.55),
    new THREE.Vector2(0, 4.85),
  ];
  const tip = new THREE.Mesh(
    new THREE.LatheGeometry(profile, 28),
    new THREE.MeshStandardMaterial({
      color: pole, emissive: glow, emissiveIntensity: 0.35, metalness: 0.12, roughness: 0.4,
      transparent: true, opacity: 0.38, depthWrite: false,
    }),
  );
  tip.frustumCulled = false;
  tip.renderOrder = 6;
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.55, 16, 12),
    new THREE.MeshStandardMaterial({
      color: orb, emissive: pole, emissiveIntensity: 0.55, metalness: 0.05, roughness: 0.28,
      transparent: true, opacity: 0.48, depthWrite: false,
    }),
  );
  core.position.y = 3.35;
  core.frustumCulled = false;
  core.renderOrder = 7;
  group.add(tip, core);
  group.visible = false;
  group.frustumCulled = false;
  return { group, tip: core };
}
