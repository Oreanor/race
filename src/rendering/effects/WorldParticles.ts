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

type Kind = 'flash' | 'flame' | 'spark' | 'fire' | 'smoke' | 'dust' | 'ring' | 'ember' | 'tracer';

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
};

const SHAPE: Record<Kind, number> = { flash: 0, flame: 0, spark: 0, ember: 0, fire: 0, smoke: 2, dust: 2, ring: 1, tracer: 0 };
const ADDITIVE: Record<Kind, boolean> = { flash: true, flame: true, spark: true, ember: true, fire: true, smoke: false, dust: false, ring: true, tracer: true };

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
      const c = lerp3([0.05, 0.045, 0.04], [0.22, 0.21, 0.2], t);
      return [c[0], c[1], c[2], 0.62 * Math.min(1, t * 6) * (1 - t)];
    }
    case 'dust': {
      return [0.42, 0.38, 0.32, 0.5 * (1 - t)];
    }
    case 'ring': return [2.6, 1.5, 0.6, 0.85 * (1 - t) * (1 - t)];
    case 'tracer': return [3, 2.1, 0.8, 1 - t * 0.4];
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
    if (vMeta.x > 1.5) {
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
    vec4 color = uAdditive > 0.5 ? vec4(vColor.rgb * a, 1.0) : vec4(vColor.rgb, a);
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

  constructor(scene: THREE.Scene) {
    this.glow = new Batch(900, true, this.eye);
    this.soft = new Batch(260, false, this.eye);
    scene.add(this.soft.mesh, this.glow.mesh);
  }

  private add(here: Position, at: Enu, p: Omit<Particle, 'e' | 'n' | 'u' | 'born' | 'seed'> & { seed?: number }, now: number) {
    if (!this.anchor || this.particles.length === 0) this.anchor = [...here];
    const o = eastNorth(this.anchor, here);
    this.particles.push({ ...p, e: o.east + at.e, n: o.north + at.n, u: this.altitude + at.u, born: now, seed: p.seed ?? Math.random() });
    if (this.particles.length > 1100) this.particles.splice(0, this.particles.length - 1100);
  }

  /** Muzzle flash: a hot core, flame tongues along the shot, a couple of sparks. */
  muzzle(here: Position, at: Enu, dir: Enu, now: number) {
    this.add(here, at, { kind: 'flash', ve: 0, vn: 0, vu: 0, life: 55, size0: 0.55, size1: 0.8, drag: 0, gravity: 0, stretch: 0 }, now);
    for (let i = 0; i < 3; i++) {
      const speed = rand(7, 13);
      const spread = 0.18;
      this.add(here, at, {
        kind: 'flame', ve: (dir.e + rand(-spread, spread)) * speed, vn: (dir.n + rand(-spread, spread)) * speed, vu: (dir.u + rand(-spread, spread)) * speed,
        life: rand(45, 75), size0: 0.22, size1: 0.12, drag: 10, gravity: 0, stretch: 0.07,
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

  private spark(here: Position, at: Enu, dir: Enu, spread: number, speed: number, now: number, life = 380) {
    const ve = dir.e + rand(-spread, spread), vn = dir.n + rand(-spread, spread), vu = dir.u + rand(-spread * 0.5, spread);
    const l = Math.hypot(ve, vn, vu) || 1;
    this.add(here, at, {
      kind: 'spark', ve: ve / l * speed, vn: vn / l * speed, vu: vu / l * speed,
      life: rand(life * 0.6, life * 1.25), size0: rand(0.05, 0.08), size1: 0.03, drag: 1.6, gravity: 9.8, stretch: 0.035,
    }, now);
  }

  /** Bullet impact: a spray of sparks bouncing back from the surface, a flash, dust on walls and ground. */
  impact(here: Position, at: Enu, normal: Enu, now: number, options: { scale?: number; dust?: boolean } = {}) {
    const s = options.scale ?? 1;
    this.add(here, at, { kind: 'flash', ve: 0, vn: 0, vu: 0, life: 70, size0: 0.35 * s, size1: 0.6 * s, drag: 0, gravity: 0, stretch: 0 }, now);
    const count = Math.round(rand(7, 12) * s);
    for (let i = 0; i < count; i++) this.spark(here, at, normal, 0.85, rand(4, 11) * Math.sqrt(s), now);
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
      // world → local frame of the layer (same mapping as scenePoint)
      const e = p.e - o.east, n = p.n - o.north;
      const x = n * sin - e * cos, z = n * cos + e * sin;
      const size = p.size0 + (p.size1 - p.size0) * Math.sqrt(t);
      const c = shade(p, t);
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
