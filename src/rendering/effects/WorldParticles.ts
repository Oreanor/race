import * as THREE from 'three';
import type { Position } from '@/game/VehicleController';

// Small GPU particle system for weapon and explosion effects.
// Particles live in world meters (east, north, up) around a fixed anchor, so
// they stay where they were born while the car moves and turns. Every frame they
// are mapped into the vehicle layer's local frame and drawn as camera-facing (or
// velocity-stretched, or ground-flat) quads: two instanced draws in total.

const EARTH = 6378137;

function eastNorth(origin: Position, point: Position) {
  const lat = origin[1] * Math.PI / 180;
  return {
    east: (point[0] - origin[0]) * Math.PI / 180 * EARTH * Math.cos(lat),
    north: (point[1] - origin[1]) * Math.PI / 180 * EARTH,
  };
}

/** World offset relative to the car, meters. */
export type Enu = { e: number; n: number; u: number };

type Kind = 'flash' | 'flame' | 'spark' | 'fire' | 'smoke' | 'dust' | 'ring' | 'ember' | 'tracer' | 'tiresmoke' | 'grit' | 'water' | 'mist';

/** What the rear wheels are on: asphalt and pavements smoke, the rest throws dust and grit. */
export type Surface = 'paved' | 'dirt' | 'grass' | 'sand';

type Particle = {
  kind: Kind;
  // position and velocity in anchor meters
  e: number; n: number; u: number;
  ve: number; vn: number; vu: number;
  born: number; life: number;
  size0: number; size1: number;
  drag: number; gravity: number;
  stretch: number;
  seed: number;
  /** colour of dust, grit and tyre smoke (linear) */
  tint?: [number, number, number];
};

const SHAPE: Record<Kind, number> = { flash: 0, flame: 0, spark: 0, ember: 0, fire: 0, smoke: 2, dust: 2, ring: 1, tracer: 0, tiresmoke: 2, grit: 0, water: 3, mist: 2 };
const ADDITIVE: Record<Kind, boolean> = { flash: true, flame: true, spark: true, ember: true, fire: true, smoke: false, dust: false, ring: true, tracer: true, tiresmoke: false, grit: false, water: false, mist: false };

/** dust cloud, grit and tyre-smoke colours per surface (linear) */
const SURFACE_FX: Record<Surface, { dust: [number, number, number]; grit: [number, number, number] }> = {
  paved: { dust: [0.68, 0.68, 0.66], grit: [0.2, 0.2, 0.2] },
  dirt: { dust: [0.42, 0.33, 0.23], grit: [0.24, 0.17, 0.11] },
  grass: { dust: [0.36, 0.32, 0.22], grit: [0.12, 0.2, 0.06] },
  sand: { dust: [0.7, 0.6, 0.43], grit: [0.58, 0.48, 0.33] },
};

function lerp3(a: number[], b: number[], t: number) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Colour (linear, already intensity-scaled) and alpha of a particle at age t ∈ [0,1]. */
function shade(p: Particle, t: number): [number, number, number, number] {
  switch (p.kind) {
    case 'flash': return [4, 3.3, 2.2, (1 - t) * (1 - t)];
    case 'flame': {
      const c = lerp3([3.2, 2.2, 0.9], [2.4, 0.7, 0.12], t);
      return [c[0], c[1], c[2], 1 - t];
    }
    case 'spark':
    case 'ember': {
      // white-hot, cooling to orange and red
      const c = t < 0.35 ? lerp3([3, 2.7, 1.8], [2.6, 1.2, 0.25], t / 0.35) : lerp3([2.6, 1.2, 0.25], [1.1, 0.18, 0.04], (t - 0.35) / 0.65);
      return [c[0], c[1], c[2], 1 - t * t];
    }
    case 'fire': {
      const c = t < 0.2 ? lerp3([3.4, 3, 2.2], [3, 1.7, 0.45], t / 0.2)
        : t < 0.55 ? lerp3([3, 1.7, 0.45], [1.8, 0.45, 0.08], (t - 0.2) / 0.35)
          : lerp3([1.8, 0.45, 0.08], [0.25, 0.06, 0.02], (t - 0.55) / 0.45);
      return [c[0], c[1], c[2], (1 - t) * Math.min(1, t * 12)];
    }
    case 'smoke': {
      if (p.tint) {
        // thick black smoke over a fire, greying a little as it thins
        const c = lerp3(p.tint, [p.tint[0] * 2.2, p.tint[1] * 2.2, p.tint[2] * 2.2], t);
        return [c[0], c[1], c[2], 0.85 * Math.min(1, t * 5) * (1 - t)];
      }
      const c = lerp3([0.05, 0.045, 0.04], [0.22, 0.21, 0.2], t);
      return [c[0], c[1], c[2], 0.62 * Math.min(1, t * 6) * (1 - t)];
    }
    case 'dust': {
      const c = p.tint ?? [0.42, 0.38, 0.32];
      // billows in, then thins out slowly
      return [c[0], c[1], c[2], 0.55 * Math.min(1, t * 8) * (1 - t) * (1 - t)];
    }
    case 'tiresmoke': {
      const c = p.tint ?? [0.68, 0.68, 0.66];
      return [c[0], c[1], c[2], 0.42 * Math.min(1, t * 5) * Math.pow(1 - t, 1.6)];
    }
    case 'grit': {
      const c = p.tint ?? [0.3, 0.22, 0.15];
      return [c[0], c[1], c[2], 1 - t * t];
    }
    case 'ring': return [2.6, 1.5, 0.6, 0.85 * (1 - t) * (1 - t)];
    case 'tracer': return [3, 2.1, 0.8, 1 - t * 0.4];
    case 'water': {
      // bright milky spit, only a hint of cyan — readable against sky and walls
      const c = lerp3([0.92, 0.98, 1.05], [0.7, 0.86, 0.98], t);
      return [c[0], c[1], c[2], 0.88 * (1 - t * t)];
    }
    case 'mist': {
      const c = p.tint ?? [0.55, 0.72, 0.88];
      return [c[0], c[1], c[2], 0.4 * Math.min(1, t * 8) * (1 - t) * (1 - t)];
    }
  }
}

const VERTEX = /* glsl */ `
  attribute vec3 iPos;
  attribute vec3 iAxis;     // stretch direction (local), length = extra length
  attribute vec4 iColor;
  attribute vec3 iMeta;     // size, shape, seed
  uniform vec3 uEye;
  varying vec2 vUv;
  varying vec4 vColor;
  varying vec2 vMeta;       // shape, seed
  void main() {
    float size = iMeta.x;
    vec3 forward = normalize(uEye - iPos);
    vec3 side;
    vec3 up;
    vec2 corner = position.xy;
    if (iMeta.y > 0.5 && iMeta.y < 1.5) {
      // ground ring: flat, horizontal
      side = vec3(1.0, 0.0, 0.0);
      up = vec3(0.0, 0.0, 1.0);
    } else if (dot(iAxis, iAxis) > 1e-6) {
      // streak: long side along the motion as seen from the camera
      vec3 axis = iAxis - forward * dot(iAxis, forward);
      float len = length(axis);
      up = len > 1e-5 ? axis / len : vec3(0.0, 1.0, 0.0);
      side = normalize(cross(up, forward));
      corner.y = corner.y * (size + length(iAxis)) / size;
    } else {
      side = normalize(cross(vec3(0.0, 1.0, 0.0), forward));
      up = cross(forward, side);
      // random roll so puffs and flashes are not all the same
      float a = iMeta.z * 6.2831;
      vec2 r = vec2(cos(a), sin(a));
      vec3 s2 = side * r.x + up * r.y;
      up = up * r.x - side * r.y;
      side = s2;
    }
    vec3 p = iPos + (side * corner.x + up * corner.y) * size;
    vUv = position.xy * 2.0;
    vColor = iColor;
    vMeta = iMeta.yz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  uniform float uAdditive;
  varying vec2 vUv;
  varying vec4 vColor;
  varying vec2 vMeta;
  void main() {
    float r = length(vUv);
    float a;
    vec3 rgb = vColor.rgb;
    if (vMeta.x > 2.5) {
      // water spit: dense body, slight cool rim (not a blue ghost)
      float core = exp(-r * r * 3.2);
      float rim = smoothstep(0.22, 0.88, r) * smoothstep(1.05, 0.72, r);
      a = (0.92 * core + 0.4 * rim) * smoothstep(1.05, 0.68, r);
      rgb = mix(vColor.rgb, vec3(0.55, 0.78, 1.0), rim * 0.28);
    } else if (vMeta.x > 1.5) {
      // smoke / dust puff: soft lumpy blob
      float ang = atan(vUv.y, vUv.x);
      float lumps = 0.82 + 0.1 * sin(ang * 5.0 + vMeta.y * 40.0) + 0.08 * sin(ang * 9.0 - vMeta.y * 23.0);
      a = smoothstep(lumps, lumps * 0.35, r);
    } else if (vMeta.x > 0.5) {
      // shockwave ring
      a = smoothstep(0.62, 0.86, r) * smoothstep(1.0, 0.88, r);
    } else {
      // glow: hot core and soft halo
      a = exp(-r * r * 4.5) + 0.35 * exp(-r * r * 1.4);
      a *= smoothstep(1.0, 0.75, r);
    }
    a *= vColor.a;
    if (a < 0.004) discard;
    vec4 color = uAdditive > 0.5 ? vec4(rgb * a, 1.0) : vec4(rgb, a);
    gl_FragColor = linearToOutputTexel(color);
  }
`;

class Batch {
  readonly mesh: THREE.Mesh;
  private pos: Float32Array;
  private axis: Float32Array;
  private color: Float32Array;
  private meta: Float32Array;
  private geometry: THREE.InstancedBufferGeometry;
  count = 0;

  constructor(readonly capacity: number, additive: boolean, eye: { value: THREE.Vector3 }) {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.pos = new Float32Array(capacity * 3);
    this.axis = new Float32Array(capacity * 3);
    this.color = new Float32Array(capacity * 4);
    this.meta = new Float32Array(capacity * 3);
    g.setAttribute('iPos', new THREE.InstancedBufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('iAxis', new THREE.InstancedBufferAttribute(this.axis, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('iColor', new THREE.InstancedBufferAttribute(this.color, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('iMeta', new THREE.InstancedBufferAttribute(this.meta, 3).setUsage(THREE.DynamicDrawUsage));
    g.instanceCount = 0;
    this.geometry = g;
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: { uEye: eye, uAdditive: { value: additive ? 1 : 0 } },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 14 : 13;
  }

  begin() { this.count = 0; }

  push(x: number, y: number, z: number, ax: number, ay: number, az: number, c: [number, number, number, number], size: number, shape: number, seed: number) {
    if (this.count >= this.capacity) return;
    const i = this.count++;
    this.pos.set([x, y, z], i * 3);
    this.axis.set([ax, ay, az], i * 3);
    this.color.set(c, i * 4);
    this.meta.set([size, shape, seed], i * 3);
  }

  end() {
    this.geometry.instanceCount = this.count;
    for (const name of ['iPos', 'iAxis', 'iColor', 'iMeta']) {
      const attribute = this.geometry.getAttribute(name) as THREE.InstancedBufferAttribute;
      attribute.needsUpdate = true;
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, this.count * attribute.itemSize);
    }
    this.mesh.visible = this.count > 0;
  }

  dispose() {
    this.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class WorldParticles {
  private particles: Particle[] = [];
  private anchor: Position | null = null;
  private eye = { value: new THREE.Vector3() };
  private glow: Batch;
  private soft: Batch;
  /** car altitude (m) right now: spawn heights are relative to it, storage is absolute */
  altitude = 0;
  /** daylight on smoke and dust (they are not lit by the scene): 1 by day, dim at night */
  light = 1;

  constructor(scene: THREE.Scene) {
    this.glow = new Batch(1200, true, this.eye);
    this.soft = new Batch(1200, false, this.eye);
    scene.add(this.soft.mesh, this.glow.mesh);
  }

  private add(here: Position, at: Enu, p: Omit<Particle, 'e' | 'n' | 'u' | 'born' | 'seed'> & { seed?: number }, now: number) {
    if (!this.anchor || this.particles.length === 0) this.anchor = [...here];
    const o = eastNorth(this.anchor, here);
    this.particles.push({ ...p, e: o.east + at.e, n: o.north + at.n, u: this.altitude + at.u, born: now, seed: p.seed ?? Math.random() });
    if (this.particles.length > 2400) this.particles.splice(0, this.particles.length - 2400);
  }

  /** Muzzle flash: a hot core, flame tongues along the shot, a couple of sparks. */
  muzzle(here: Position, at: Enu, dir: Enu, now: number) {
    this.add(here, at, { kind: 'flash', ve: 0, vn: 0, vu: 0, life: 40, size0: 0.2, size1: 0.3, drag: 0, gravity: 0, stretch: 0 }, now);
    for (let i = 0; i < 3; i++) {
      const speed = rand(7, 13);
      const spread = 0.18;
      this.add(here, at, {
        kind: 'flame', ve: (dir.e + rand(-spread, spread)) * speed, vn: (dir.n + rand(-spread, spread)) * speed, vu: (dir.u + rand(-spread, spread)) * speed,
        life: rand(40, 65), size0: 0.15, size1: 0.07, drag: 10, gravity: 0, stretch: 0.07,
      }, now);
    }
    for (let i = 0; i < 2; i++) this.spark(here, at, dir, 0.45, rand(8, 14), now, 160);
  }

  /** A glowing bullet streak flying from the muzzle to the hit point. */
  tracer(here: Position, from: Enu, to: Enu, now: number) {
    const d = { e: to.e - from.e, n: to.n - from.n, u: to.u - from.u };
    const len = Math.hypot(d.e, d.n, d.u);
    if (len < 2) return;
    const life = Math.min(140, Math.max(40, len * 0.9)); // ~1 km/s
    const speed = len / (life / 1000);
    this.add(here, from, {
      kind: 'tracer', ve: d.e / len * speed, vn: d.n / len * speed, vu: d.u / len * speed,
      life, size0: 0.07, size1: 0.07, drag: 0, gravity: 0, stretch: 1.6 / speed,
    }, now);
  }

  private spark(here: Position, at: Enu, dir: Enu, spread: number, speed: number, now: number, life = 380, snap = false) {
    const ve = dir.e + rand(-spread, spread), vn = dir.n + rand(-spread, spread), vu = dir.u + rand(-spread * 0.5, spread);
    const l = Math.hypot(ve, vn, vu) || 1;
    this.add(here, at, {
      kind: 'spark', ve: ve / l * speed, vn: vn / l * speed, vu: vu / l * speed,
      life: rand(life * 0.6, life * 1.25), size0: rand(0.05, 0.08), size1: 0.03, drag: snap ? 3 : 1.6, gravity: 9.8, stretch: snap ? 0.022 : 0.035,
    }, now);
  }

  /**
   * Drifting, from both rear wheels: on asphalt thick tyre smoke that hangs in the
   * air behind the car; on dirt, grass and sand a low cloud of dust in the surface's
   * colour plus grit thrown back and out, falling fast. Stronger slip × speed → more.
   * `slip` is the signed drift angle (rad).
   */
  driftDust(here: Position, heading: number, slip: number, speed: number, carLength: number, now: number, surface: Surface = 'paved') {
    const intensity = Math.min(1, Math.abs(slip) / 1.1) * Math.min(1, Math.abs(speed) / 14);
    if (intensity < 0.06 || Math.abs(speed) < 2.5) return;
    const fwdE = Math.sin(heading), fwdN = Math.cos(heading);
    const rightE = Math.cos(heading), rightN = -Math.sin(heading);
    const out = Math.sign(slip) || 1; // the side the tail swings out to
    const colors = SURFACE_FX[surface];
    const back = -carLength * 0.36;
    for (const wheel of [-0.8, 0.8]) {
      const at: Enu = { e: fwdE * back + rightE * wheel, n: fwdN * back + rightN * wheel, u: 0.15 };
      if (surface === 'paved') {
        // tyre smoke: big, slow, lingering; drifts out with the tail and a little up
        if (Math.random() > 0.35 + intensity * 0.65) continue;
        this.add(here, at, {
          kind: 'tiresmoke', tint: colors.dust,
          ve: rightE * out * rand(0.6, 2.2) * intensity - fwdE * rand(0.5, 1.8) + rand(-0.4, 0.4),
          vn: rightN * out * rand(0.6, 2.2) * intensity - fwdN * rand(0.5, 1.8) + rand(-0.4, 0.4),
          vu: rand(0.25, 0.8),
          life: rand(1800, 2900), size0: 0.7, size1: 3.2 + intensity * 2.2,
          drag: 1.2, gravity: -0.12, stretch: 0,
        }, now);
        continue;
      }
      // a dust cloud, low and wide
      this.add(here, at, {
        kind: 'dust', tint: colors.dust,
        ve: rightE * out * rand(1, 3.2) * (0.5 + intensity) - fwdE * rand(0.5, 2) + rand(-0.4, 0.4),
        vn: rightN * out * rand(1, 3.2) * (0.5 + intensity) - fwdN * rand(0.5, 2) + rand(-0.4, 0.4),
        vu: rand(0.3, 1.1) * (0.5 + intensity),
        life: rand(1100, 1900), size0: 0.5, size1: 2.4 + intensity * 2,
        drag: 1.8, gravity: -0.18, stretch: 0,
      }, now);
      // grit: a few small heavy bits thrown back and out
      const bits = Math.round(1 + intensity * 4);
      for (let i = 0; i < bits; i++) {
        const kick = rand(3, 7) * (0.5 + intensity);
        this.add(here, at, {
          kind: 'grit', tint: colors.grit,
          ve: rightE * out * kick * rand(0.4, 1) - fwdE * kick * rand(0.3, 0.9) + rand(-0.6, 0.6),
          vn: rightN * out * kick * rand(0.4, 1) - fwdN * kick * rand(0.3, 0.9) + rand(-0.6, 0.6),
          vu: rand(1.5, 4.2),
          life: rand(450, 850), size0: rand(0.05, 0.11), size1: rand(0.04, 0.09),
          drag: 0.4, gravity: 9.8, stretch: 0,
        }, now);
      }
    }
  }

  /**
   * Fire hose: fixed muzzle speed, elevation from the player (mouse Y).
   * Lands where the lob falls — short/long = aim higher/lower or drive closer/farther.
   * Optional `clip` stops the jet early (train / façade) so spit does not pass through.
   * Returns flight time (ms) and the ENU point where the spit meets the ground (u ≈ groundRel).
   */
  hose(here: Position, from: Enu, dirE: number, dirN: number, elev: number, groundRel: number, now: number, clip?: Enu | null): { flightMs: number; land: Enu } {
    const g = 9.8;
    const speedUp = 3;
    const v0 = 26; // m/s real; particles run 3× faster on the same arc
    const hl = Math.hypot(dirE, dirN) || 1;
    const ue = dirE / hl, un = dirN / hl;
    const theta = Math.max(-0.08, Math.min(1.05, elev)); // ~−5° … 60°
    const cos = Math.cos(theta), sin = Math.sin(theta);
    const ve = ue * v0 * cos * speedUp;
    const vn = un * v0 * cos * speedUp;
    const vu = v0 * sin * speedUp;
    const particleG = g * speedUp * speedUp;
    // real-time to drop from muzzle height to groundRel
    const a = 0.5 * g;
    const b = -(v0 * sin);
    const c = from.u - groundRel;
    let tLand = 0;
    const disc = b * b - 4 * a * c;
    if (disc >= 0 && a > 1e-6) {
      const t1 = (-b - Math.sqrt(disc)) / (2 * a);
      const t2 = (-b + Math.sqrt(disc)) / (2 * a);
      tLand = Math.max(t1, t2);
    }
    if (!(tLand > 0.05)) tLand = Math.max(0.2, (2 * v0 * Math.max(0.05, sin)) / g);
    tLand = Math.min(tLand, 2.2);
    let land: Enu = {
      e: from.e + ue * v0 * cos * tLand,
      n: from.n + un * v0 * cos * tLand,
      u: groundRel,
    };
    if (clip) {
      const flat = v0 * Math.max(0.08, cos);
      const reach = Math.hypot(clip.e - from.e, clip.n - from.n);
      tLand = Math.min(tLand, Math.max(0.05, reach / flat));
      land = { e: clip.e, n: clip.n, u: clip.u };
    }
    const flightMs = Math.min(900, Math.max(80, (tLand / speedUp) * 1000));
    // dense rope of spit — many small stretched beads, staggered along the lob so gaps close
    const gobs = 11 + Math.floor(Math.random() * 4);
    for (let i = 0; i < gobs; i++) {
      const wobble = 0.022;
      const along = (i / gobs) * Math.min(0.09, tLand / speedUp); // seed a short lead along the jet
      const spawn: Enu = {
        e: from.e + ve * along,
        n: from.n + vn * along,
        u: from.u + vu * along - 0.5 * particleG * along * along,
      };
      this.add(here, spawn, {
        kind: 'water',
        ve: ve * (1 + rand(-wobble, wobble)) + rand(-0.12, 0.12) * speedUp,
        vn: vn * (1 + rand(-wobble, wobble)) + rand(-0.12, 0.12) * speedUp,
        vu: vu * (1 + rand(-wobble * 0.5, wobble)) + rand(-0.08, 0.12) * speedUp,
        life: flightMs * rand(1.0, 1.12), size0: rand(0.16, 0.28), size1: rand(0.12, 0.22),
        drag: 0.1, gravity: particleG, stretch: 0.042,
      }, now);
    }
    return { flightMs, land };
  }

  /** Sample points along the same lob as `hose` (real metres, for hit tests). */
  hoseArc(from: Enu, dirE: number, dirN: number, elev: number, groundRel: number, steps = 20): Enu[] {
    const g = 9.8, v0 = 26;
    const hl = Math.hypot(dirE, dirN) || 1;
    const ue = dirE / hl, un = dirN / hl;
    const cos = Math.cos(elev), sin = Math.sin(elev);
    const a = 0.5 * g, b = -(v0 * sin), c = from.u - groundRel;
    let tLand = 0.8;
    const disc = b * b - 4 * a * c;
    if (disc >= 0 && a > 1e-6) {
      const t1 = (-b - Math.sqrt(disc)) / (2 * a);
      const t2 = (-b + Math.sqrt(disc)) / (2 * a);
      tLand = Math.max(0.05, Math.max(t1, t2));
    }
    tLand = Math.min(tLand, 2.2);
    const out: Enu[] = [];
    for (let i = 1; i <= steps; i++) {
      const t = (tLand * i) / steps;
      out.push({
        e: from.e + ue * v0 * cos * t,
        n: from.n + un * v0 * cos * t,
        u: from.u + v0 * sin * t - 0.5 * g * t * t,
      });
    }
    return out;
  }

  /** Impact: same thick spit blobs as the hose, flung sideways off the surface. */
  splash(here: Position, at: Enu, normal: Enu, now: number, scale = 1) {
    const s = scale;
    const nl = Math.hypot(normal.e, normal.n, normal.u) || 1;
    const ne = normal.e / nl, nn = normal.n / nl, nu = normal.u / nl;
    const count = 8;
    for (let i = 0; i < count; i++) {
      const ve = ne * rand(0.15, 0.55) + rand(-1, 1);
      const vn = nn * rand(0.15, 0.55) + rand(-1, 1);
      const vu = nu * rand(0.2, 0.7) + rand(0.05, 0.85);
      const l = Math.hypot(ve, vn, vu) || 1;
      const speed = rand(6, 12) * Math.sqrt(s);
      this.add(here, at, {
        kind: 'water',
        ve: ve / l * speed, vn: vn / l * speed, vu: vu / l * speed,
        life: rand(280, 480), size0: rand(0.4, 0.68) * s, size1: rand(0.3, 0.48) * s,
        drag: 0.35, gravity: 9.8, stretch: 0.028,
      }, now);
    }
  }

  /** Bullet impact: a spray of sparks bouncing back from the surface, a flash, dust on walls and ground. */
  impact(here: Position, at: Enu, normal: Enu, now: number, options: { scale?: number; dust?: boolean } = {}) {
    const s = options.scale ?? 1;
    this.add(here, at, { kind: 'flash', ve: 0, vn: 0, vu: 0, life: 70, size0: 0.35 * s, size1: 0.6 * s, drag: 0, gravity: 0, stretch: 0 }, now);
    const count = Math.round(rand(7, 12) * s);
    // bullet sparks: fast, short, snapping off the hit
    for (let i = 0; i < count; i++) this.spark(here, at, normal, 0.85, rand(9, 20) * Math.sqrt(s), now, 250, true);
    if (options.dust) {
      for (let i = 0; i < 2; i++) {
        this.add(here, at, {
          kind: 'dust', ve: normal.e * rand(0.4, 1) + rand(-0.4, 0.4), vn: normal.n * rand(0.4, 1) + rand(-0.4, 0.4), vu: rand(0.3, 0.9),
          life: rand(450, 750), size0: 0.25, size1: 0.9, drag: 2.2, gravity: -0.3, stretch: 0,
        }, now);
      }
    }
  }

  /** Car explosion: fireball, flying embers, a ground shockwave and rising black smoke. */
  explosion(here: Position, at: Enu, size: number, now: number, major = true) {
    this.add(here, at, { kind: 'flash', ve: 0, vn: 0, vu: 0, life: 120, size0: 2.2 * size, size1: 3.6 * size, drag: 0, gravity: 0, stretch: 0 }, now);
    const balls = major ? 9 : 4;
    for (let i = 0; i < balls; i++) {
      const a = Math.random() * Math.PI * 2;
      const out = rand(1.2, 4.5) * size;
      this.add(here, { e: at.e + Math.cos(a) * 0.4 * size, n: at.n + Math.sin(a) * 0.4 * size, u: at.u + rand(0, 0.6) }, {
        kind: 'fire', ve: Math.cos(a) * out, vn: Math.sin(a) * out, vu: rand(1.5, 4.5) * size,
        life: rand(480, 900), size0: rand(0.9, 1.4) * size, size1: rand(2.4, 3.4) * size, drag: 3.2, gravity: -1.2, stretch: 0,
      }, now);
    }
    if (major) {
      for (let i = 0; i < 18; i++) {
        const a = Math.random() * Math.PI * 2;
        const speed = rand(6, 15);
        this.add(here, at, {
          kind: 'ember', ve: Math.cos(a) * speed * 0.7, vn: Math.sin(a) * speed * 0.7, vu: rand(3, 10),
          life: rand(700, 1300), size0: rand(0.07, 0.12), size1: 0.04, drag: 0.8, gravity: 9.8, stretch: 0.03,
        }, now);
      }
      this.add(here, { e: at.e, n: at.n, u: Math.max(0.05, at.u - 0.6) }, { kind: 'ring', ve: 0, vn: 0, vu: 0, life: 420, size0: 1.2 * size, size1: 9 * size, drag: 0, gravity: 0, stretch: 0 }, now);
    }
    const puffs = major ? 7 : 3;
    for (let i = 0; i < puffs; i++) {
      this.add(here, { e: at.e + rand(-0.8, 0.8), n: at.n + rand(-0.8, 0.8), u: at.u + rand(0.4, 1.2) }, {
        kind: 'smoke', ve: rand(-0.6, 0.6), vn: rand(-0.6, 0.6), vu: rand(1.2, 2.6),
        life: rand(2200, 3800), size0: rand(1.0, 1.6) * size, size1: rand(3.6, 5.2) * size, drag: 0.9, gravity: -0.4, stretch: 0,
      }, now + rand(80, 260));
    }
  }

  /**
   * A wreck on fire, one puff of it (call a few dozen times a second): now and
   * then a spark and a column of black smoke (the flames are WreckFire). strength goes 1 → 0 as the fire dies down.
   */
  burning(here: Position, at: Enu, strength: number, now: number) {
    if (strength <= 0.02) return;
    if (Math.random() < 0.08 * strength) {
      this.add(here, { e: at.e + rand(-0.8, 0.8), n: at.n + rand(-0.8, 0.8), u: at.u + 0.6 }, {
        kind: 'ember', ve: rand(-1.2, 1.2), vn: rand(-1.2, 1.2), vu: rand(2, 4.5),
        life: rand(600, 1100), size0: rand(0.04, 0.07), size1: 0.025, drag: 0.6, gravity: 2.5, stretch: 0.02,
      }, now);
    }
    // a column of thick black smoke: narrow puffs, close together, rising fast and
    // straight, widening only slowly as they climb
    for (let i = 0; i < 2; i++) {
      if (Math.random() > 0.55 + strength * 0.4) continue;
      this.add(here, { e: at.e + rand(-0.35, 0.35), n: at.n + rand(-0.35, 0.35), u: at.u + rand(0.9, 1.3) }, {
        kind: 'smoke', tint: [0.02, 0.018, 0.016], ve: rand(-0.15, 0.15), vn: rand(-0.15, 0.15), vu: rand(3.2, 4.4) * (0.6 + strength * 0.4),
        life: rand(3200, 4600), size0: rand(0.7, 1.0), size1: rand(2.0, 2.8), drag: 0.25, gravity: -0.5, stretch: 0,
      }, now);
    }
  }

  /** Black smoke pouring out of a burning window (slightly outward + up). Kept light for FPS. */
  windowSmoke(here: Position, at: Enu, outward: { e: number; n: number }, now: number) {
    this.add(here, { e: at.e + rand(-0.1, 0.1), n: at.n + rand(-0.1, 0.1), u: at.u + rand(0, 0.1) }, {
      kind: 'smoke', tint: [0.03, 0.028, 0.025],
      ve: outward.e * rand(0.3, 0.7) + rand(-0.15, 0.15),
      vn: outward.n * rand(0.3, 0.7) + rand(-0.15, 0.15),
      vu: rand(1.4, 2.4),
      life: rand(1400, 2200), size0: rand(0.3, 0.45), size1: rand(1.0, 1.5),
      drag: 0.3, gravity: -0.4, stretch: 0,
    }, now);
  }

  /** White steam after a pane is put out — one soft puff. */
  windowSteam(here: Position, at: Enu, outward: { e: number; n: number }, strength: number, now: number) {
    if (strength <= 0.05) return;
    const s = Math.max(0.15, Math.min(1, strength));
    this.add(here, { e: at.e + rand(-0.1, 0.1), n: at.n + rand(-0.1, 0.1), u: at.u + rand(0, 0.1) }, {
      kind: 'mist', tint: [0.92, 0.94, 0.96],
      ve: outward.e * rand(0.2, 0.55) * s + rand(-0.15, 0.15),
      vn: outward.n * rand(0.2, 0.55) * s + rand(-0.15, 0.15),
      vu: rand(0.9, 1.8) * s,
      life: rand(700, 1200) * (0.5 + 0.5 * s),
      size0: rand(0.35, 0.55) * s, size1: rand(1.0, 1.5) * s,
      drag: 0.4, gravity: -0.28, stretch: 0,
    }, now);
  }

  /**
   * Advance and draw. `heading` and `here` define the vehicle layer's local frame;
   * `eye` is the camera position in that frame.
   */
  update(now: number, dt: number, here: Position, heading: number, eye: THREE.Vector3) {
    this.eye.value.copy(eye);
    this.glow.begin();
    this.soft.begin();
    if (!this.particles.length || !this.anchor) { this.glow.end(); this.soft.end(); return; }
    const o = eastNorth(this.anchor, here);
    const sin = Math.sin(heading), cos = Math.cos(heading);
    const alive: Particle[] = [];
    for (const p of this.particles) {
      const age = now - p.born;
      if (age < 0) { alive.push(p); continue; } // delayed (smoke after the fireball)
      const t = age / p.life;
      if (t >= 1) continue;
      alive.push(p);
      // integrate (world meters)
      const k = Math.exp(-p.drag * dt);
      p.ve *= k; p.vn *= k; p.vu = p.vu * k - p.gravity * dt;
      p.e += p.ve * dt; p.n += p.vn * dt; p.u += p.vu * dt;
      const floor = this.altitude + 0.03;
      if (p.u < floor && (p.kind === 'spark' || p.kind === 'ember')) { p.u = floor; p.vu = Math.abs(p.vu) * 0.35; p.ve *= 0.6; p.vn *= 0.6; }
      // grit lands and skids to a stop
      if (p.u < floor && p.kind === 'grit') { p.u = floor; p.vu = 0; p.ve *= 0.5; p.vn *= 0.5; }
      // water droplets splash once on the ground, then flatten into a short-lived puddle bead
      if (p.u < floor && p.kind === 'water') { p.u = floor; p.vu = Math.abs(p.vu) * 0.25; p.ve *= 0.45; p.vn *= 0.45; p.life *= 0.85; }
      // world → local frame of the layer (same mapping as scenePoint)
      const e = p.e - o.east, n = p.n - o.north;
      const x = n * sin - e * cos, z = n * cos + e * sin;
      const size = p.size0 + (p.size1 - p.size0) * Math.sqrt(t);
      const c = shade(p, t);
      if (!ADDITIVE[p.kind]) { c[0] *= this.light; c[1] *= this.light; c[2] *= this.light; }
      let ax = 0, ay = 0, az = 0;
      if (p.stretch > 0) {
        ax = p.vn * sin - p.ve * cos; ay = p.vu; az = p.vn * cos + p.ve * sin;
        const s = p.stretch;
        ax *= s; ay *= s; az *= s;
      }
      const batch = ADDITIVE[p.kind] ? this.glow : this.soft;
      batch.push(x, p.u - this.altitude, z, ax, ay, az, c, size, SHAPE[p.kind], p.seed);
    }
    this.particles = alive;
    this.glow.end();
    this.soft.end();
  }

  dispose() {
    this.glow.dispose();
    this.soft.dispose();
  }
}
