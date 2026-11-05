import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { FLORA_MODELS, type FloraModel } from '../tiles/flora';

// The 16 base shapes of the vegetation catalog, built in code as clean low-poly
// meshes: a trunk with a few visible limbs (bark) and a crown of several
// uneven faceted masses (leaves). Meters, base at y = 0, up +Y. Each vertex
// carries `aPart` (0 bark, 1 leaf) and `aShade` (0 → 1 up the foliage) so one
// shader colours every species, drops the leaves in winter and sways the crowns.
// Species differ by colour and proportions per instance (tiles/flora).

type V = THREE.Vector3;
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const UP = v(0, 1, 0);

class Shape {
  private parts: { g: THREE.BufferGeometry; leaf: boolean }[] = [];
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0 || 1; }
  /** deterministic 0..1 */
  rnd() { this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0; return this.s / 4294967296; }
  /** deterministic -1..1 */
  j() { return this.rnd() * 2 - 1; }

  private add(g: THREE.BufferGeometry, leaf: boolean) {
    const flat = g.index ? g.toNonIndexed() : g;
    if (flat !== g) g.dispose();
    for (const name of Object.keys(flat.attributes)) if (name !== 'position' && name !== 'normal') flat.deleteAttribute(name);
    this.parts.push({ g: flat, leaf });
  }

  /** A tapered branch or trunk piece from a to b. */
  limb(a: V, b: V, r0: number, r1: number, sides = 5) {
    const length = a.distanceTo(b);
    if (length < 1e-4) return;
    const g = new THREE.CylinderGeometry(r1, r0, length, sides, 1, true);
    g.translate(0, length / 2, 0);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, b.clone().sub(a).normalize()));
    g.translate(a.x, a.y, a.z);
    this.add(g, false);
  }

  /** A trunk through several points, radius per point. */
  stem(points: V[], radii: number[], sides = 6) {
    for (let i = 0; i + 1 < points.length; i++) this.limb(points[i], points[i + 1], radii[i], radii[i + 1], sides);
  }

  /**
   * One faceted foliage mass: a lumpy icosahedron. Its normals lean toward
   * `centre` so the whole crown shades as one soft volume.
   */
  blob(c: V, rx: number, ry: number, rz: number, centre: V = c, lump = 0.22) {
    const g = new THREE.IcosahedronGeometry(1, 0);
    const pos = g.getAttribute('position');
    const normals = new Float32Array(pos.count * 3);
    const salt = this.rnd() * 1000;
    const d = new THREE.Vector3(), p = new THREE.Vector3(), n = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      d.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();
      // the same corner gets the same push in every face that shares it
      const h = Math.sin(Math.round(d.x * 1000) * 12.9898 + Math.round(d.y * 1000) * 78.233 + Math.round(d.z * 1000) * 37.719 + salt) * 43758.5453;
      const k = 1 + lump * ((h - Math.floor(h)) - 0.5) * 2;
      p.set(c.x + d.x * rx * k, c.y + d.y * ry * k, c.z + d.z * rz * k);
      pos.setXYZ(i, p.x, p.y, p.z);
      n.copy(p).sub(centre).normalize().multiplyScalar(0.45).addScaledVector(d, 0.55).normalize();
      normals.set([n.x, n.y, n.z], i * 3);
    }
    g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    this.add(g, true);
  }

  /** A conifer tier: a cone with a ragged, drooping rim. */
  tier(c: V, r: number, h: number, sides = 7) {
    const g = new THREE.ConeGeometry(r, h, sides, 1, false);
    const pos = g.getAttribute('position');
    const salt = this.rnd() * 1000;
    const tip = v(this.j() * r * 0.08, 0, this.j() * r * 0.08);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (y > h / 2 - 1e-4) { pos.setXYZ(i, x + tip.x, y, z + tip.z); continue; }
      const a = Math.atan2(z, x);
      const hsh = Math.sin(Math.round(a * 100) * 12.9898 + salt) * 43758.5453;
      const k = 1 + 0.16 * ((hsh - Math.floor(hsh)) - 0.5) * 2;
      // rim points sag a little, like heavy branch tips
      pos.setXYZ(i, x * k, y - (k - 0.84) * h * 0.18, z * k);
    }
    g.computeVertexNormals();
    g.translate(c.x, c.y + h / 2, c.z);
    this.add(g, true);
  }

  /** Free triangles, seen from both sides (fronds, blades, fins). */
  fins(tris: V[][], leaf: boolean) {
    const p: number[] = [], n: number[] = [];
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), f = new THREE.Vector3();
    for (const [a, b, c] of tris) {
      f.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a)).normalize();
      for (const q of [a, b, c]) { p.push(q.x, q.y, q.z); n.push(f.x, f.y, f.z); }
      for (const q of [a, c, b]) { p.push(q.x, q.y, q.z); n.push(-f.x, -f.y, -f.z); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3));
    this.add(g, leaf);
  }

  /** A palm frond: a folded leaf arching out and down from `base`. */
  frond(base: V, yaw: number, length: number, lift: number, droop: number, width: number) {
    const dir = v(Math.cos(yaw), 0, Math.sin(yaw));
    const side = v(-dir.z, 0, dir.x);
    const segs = 5;
    const spine: V[] = [], left: V[] = [], right: V[] = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const s = base.clone().addScaledVector(dir, length * t).addScaledVector(UP, length * (lift * t - droop * t * t));
      const w = width * Math.sin(Math.PI * Math.min(1, t * 1.15)) * (1 - t * 0.35);
      spine.push(s);
      left.push(s.clone().addScaledVector(side, w).addScaledVector(UP, -w * 0.35));
      right.push(s.clone().addScaledVector(side, -w).addScaledVector(UP, -w * 0.35));
    }
    const tris: V[][] = [];
    for (let i = 0; i < segs; i++) {
      tris.push([spine[i], left[i], spine[i + 1]], [left[i], left[i + 1], spine[i + 1]]);
      tris.push([spine[i], spine[i + 1], right[i]], [right[i], spine[i + 1], right[i + 1]]);
    }
    this.fins(tris, true);
  }

  /** Merge, tag bark / leaves and the foliage height gradient. */
  build(): THREE.BufferGeometry {
    const geometry = mergeGeometries(this.parts.map((p) => p.g), false)!;
    const count = geometry.getAttribute('position').count;
    const part = new Float32Array(count);
    let at = 0;
    for (const p of this.parts) {
      const n = p.g.getAttribute('position').count;
      if (p.leaf) part.fill(1, at, at + n);
      at += n;
      p.g.dispose();
    }
    const position = geometry.getAttribute('position');
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < count; i++) if (part[i]) { lo = Math.min(lo, position.getY(i)); hi = Math.max(hi, position.getY(i)); }
    const shade = new Float32Array(count);
    for (let i = 0; i < count; i++) shade[i] = part[i] ? (position.getY(i) - lo) / Math.max(1e-3, hi - lo) : 0;
    geometry.setAttribute('aPart', new THREE.BufferAttribute(part, 1));
    geometry.setAttribute('aShade', new THREE.BufferAttribute(shade, 1));
    geometry.computeBoundingSphere();
    return geometry;
  }
}

/** A ring of `count` masses around a centre, each a little different. */
function ring(t: Shape, centre: V, count: number, radius: number, y: number, size: [number, number, number], normalsTo: V, jitter = 0.35) {
  const turn = t.rnd() * Math.PI * 2;
  for (let i = 0; i < count; i++) {
    const a = turn + (i / count) * Math.PI * 2 + t.j() * 0.3;
    const r = radius * (1 + t.j() * jitter * 0.5);
    const k = 1 + t.j() * jitter;
    t.blob(v(centre.x + Math.cos(a) * r, y + t.j() * size[1] * 0.35, centre.z + Math.sin(a) * r), size[0] * k, size[1] * k, size[2] * k, normalsTo);
  }
}

/** Limbs fanning out from a fork point to tips; returns the tips. */
function fan(t: Shape, from: V, count: number, reach: number, rise: number, r0: number, r1: number) {
  const tips: V[] = [];
  const turn = t.rnd() * Math.PI * 2;
  for (let i = 0; i < count; i++) {
    const a = turn + (i / count) * Math.PI * 2 + t.j() * 0.35;
    const tip = v(from.x + Math.cos(a) * reach * (1 + t.j() * 0.2), from.y + rise * (1 + t.j() * 0.2), from.z + Math.sin(a) * reach * (1 + t.j() * 0.2));
    // a slight elbow halfway, so limbs never look like straight sticks
    const mid = from.clone().lerp(tip, 0.5).add(v(t.j() * reach * 0.12, rise * 0.05, t.j() * reach * 0.12));
    t.limb(from, mid, r0, (r0 + r1) / 2, 5);
    t.limb(mid, tip, (r0 + r1) / 2, r1, 4);
    tips.push(tip);
  }
  return tips;
}

const BUILD: Record<FloraModel, () => THREE.BufferGeometry> = {
  // maple, linden, plane: straight stem, rounded slightly lopsided crown
  tree_round() {
    const t = new Shape(11);
    t.stem([v(0, 0, 0), v(0.1, 1.7, 0.05), v(0.05, 3.3, -0.05)], [0.27, 0.21, 0.16]);
    fan(t, v(0.05, 3.0, -0.05), 3, 1.5, 2.0, 0.12, 0.04);
    t.limb(v(0.05, 3.3, -0.05), v(0.15, 6.6, 0.1), 0.12, 0.03);
    const c = v(0, 5.7, 0);
    t.blob(v(0, 5.8, 0), 2.5, 2.0, 2.4, c);
    t.blob(v(1.7, 5.2, 0.5), 1.6, 1.4, 1.6, c);
    t.blob(v(-1.6, 5.3, -0.6), 1.6, 1.45, 1.5, c);
    t.blob(v(0.4, 7.2, -0.4), 1.55, 1.3, 1.5, c);
    t.blob(v(-0.5, 4.6, 1.5), 1.3, 1.1, 1.3, c);
    return t.build();
  },
  // oak, beech, cork oak, ficus: thick forked trunk, low heavy limbs, wide crown
  tree_spreading() {
    const t = new Shape(23);
    t.stem([v(0, 0, 0), v(0.15, 1.3, 0), v(0, 2.4, 0.1)], [0.48, 0.42, 0.36], 7);
    const tips = fan(t, v(0, 2.3, 0.1), 4, 2.7, 2.4, 0.24, 0.09);
    const c = v(0, 6.2, 0);
    t.blob(v(0, 6.7, 0), 3.0, 1.9, 2.9, c);
    for (const tip of tips) t.blob(v(tip.x * 1.05, tip.y + 1.1 + t.j() * 0.4, tip.z * 1.05), 2.0 + t.j() * 0.3, 1.45, 1.9 + t.j() * 0.3, c);
    t.blob(v(0.7, 8.2, 0.4), 1.8, 1.25, 1.8, c);
    return t.build();
  },
  // Lombardy poplar, Mediterranean cypress: a tall narrow flame
  tree_columnar() {
    const t = new Shape(37);
    t.stem([v(0, 0, 0), v(0, 1.6, 0), v(0.05, 9.5, 0)], [0.22, 0.18, 0.05]);
    for (let i = 0; i < 4; i++) t.limb(v(0, 2.5 + i * 1.8, 0), v(Math.cos(i * 2.4) * 0.8, 4.2 + i * 1.9, Math.sin(i * 2.4) * 0.8), 0.06, 0.02, 4);
    const c = v(0, 7, 0);
    t.blob(v(0, 4.1, 0), 1.35, 3.0, 1.3, c, 0.16);
    t.blob(v(0.12, 7.2, 0.08), 1.2, 2.9, 1.15, c, 0.16);
    t.blob(v(-0.06, 10.1, -0.05), 0.9, 2.3, 0.88, c, 0.16);
    t.blob(v(0.05, 12.1, 0), 0.45, 0.95, 0.45, c, 0.12);
    return t.build();
  },
  // birch, alder, willow: slim leaning stem, airy crown with gaps
  tree_birch_airy() {
    const t = new Shape(41);
    const top = [v(0, 0, 0), v(0.18, 3.0, 0.05), v(0.38, 6.5, 0.1), v(0.42, 9.6, 0), v(0.3, 11.2, 0.1)];
    t.stem(top, [0.17, 0.13, 0.09, 0.05, 0.02]);
    const c = v(0.3, 7.6, 0);
    const spots: [number, number, number, number][] = [[1.15, 6.0, 0.45, 1.25], [-0.85, 7.2, -0.55, 1.3], [1.0, 9.0, -0.65, 1.15], [-0.35, 10.6, 0.5, 1.0], [0.15, 4.8, -1.05, 0.95]];
    for (const [x, y, z, r] of spots) {
      const from = top[Math.min(3, Math.max(1, Math.round(y / 3.2)))];
      t.limb(from, v(x * 0.9, y - 0.3, z * 0.9), 0.05, 0.015, 4);
      t.blob(v(x, y, z), r, r * 1.08, r * 0.95, c, 0.26);
    }
    return t.build();
  },
  // spruce, fir, larch: a ragged tiered cone, not a perfect pyramid
  tree_spruce() {
    const t = new Shape(53);
    t.stem([v(0, 0, 0), v(0, 1.4, 0), v(0, 13, 0)], [0.3, 0.26, 0.05]);
    const tiers = 6;
    for (let i = 0; i < tiers; i++) {
      const k = i / tiers;
      t.tier(v(t.j() * 0.12, 1.0 + i * 2.0, t.j() * 0.12), 3.0 * (1 - k * 0.82) * (1 + t.j() * 0.06), 3.4 - i * 0.22, 7);
    }
    t.tier(v(0, 12.6, 0), 0.5, 2.2, 5);
    return t.build();
  },
  // Scots, maritime, ponderosa pine: tall bare trunk, separate needle clouds up top
  tree_pine() {
    const t = new Shape(67);
    const stem = [v(0, 0, 0), v(0.22, 4, 0.1), v(0.1, 8, -0.2), v(0.42, 11.5, 0), v(0.32, 14.2, 0.2)];
    t.stem(stem, [0.36, 0.3, 0.24, 0.16, 0.07]);
    const c = v(0.3, 13, 0);
    const clouds: [number, number, number, number][] = [[2.3, 12.2, 0.7, 1.6], [-2.1, 11.5, -0.9, 1.7], [0.7, 13.3, -1.9, 1.5], [-0.6, 14.4, 1.1, 1.55], [1.3, 10.5, -0.5, 1.1]];
    for (const [x, y, z, r] of clouds) {
      t.limb(stem[y > 12.5 ? 4 : 3].clone().lerp(stem[2], 0.15), v(x * 0.85, y - 0.25, z * 0.85), 0.09, 0.03, 4);
      t.blob(v(x, y, z), r, r * 0.5, r * 0.9, c, 0.25);
    }
    t.blob(v(0.35, 15.2, 0.1), 1.05, 0.62, 1.0, c, 0.2);
    return t.build();
  },
  // stone pine: long leaning trunk, limbs fanning up under a broad uneven canopy
  tree_pine_umbrella() {
    const t = new Shape(79);
    t.stem([v(0, 0, 0), v(0.35, 2.8, 0.1), v(0.7, 5.6, 0), v(0.8, 6.4, 0.05)], [0.4, 0.34, 0.28, 0.25], 7);
    const fork = v(0.8, 6.3, 0.05);
    const tips = fan(t, fork, 5, 3.0, 2.6, 0.2, 0.07);
    for (const tip of tips) t.limb(tip, tip.clone().add(v(t.j() * 0.8, 0.9, t.j() * 0.8)), 0.07, 0.03, 4);
    const c = v(0.8, 9.6, 0.05);
    // the canopy is several overlapping flat cushions at slightly different heights
    t.blob(v(0.8, 10.0, 0.05), 3.6, 1.05, 3.4, c, 0.18);
    for (const tip of tips) t.blob(v(tip.x + (tip.x - fork.x) * 0.25, tip.y + 1.25 + t.j() * 0.3, tip.z + (tip.z - fork.z) * 0.25), 2.1 + t.j() * 0.35, 0.85 + t.j() * 0.15, 1.9 + t.j() * 0.3, c, 0.22);
    t.blob(v(1.6, 10.9, -0.8), 1.8, 0.7, 1.7, c, 0.2);
    t.blob(v(-0.3, 10.8, 1.0), 1.7, 0.65, 1.6, c, 0.2);
    return t.build();
  },
  // olive, argan, mesquite: short twisted trunk, wide fork, small grey-green tufts
  tree_gnarled() {
    const t = new Shape(83);
    t.stem([v(0, 0, 0), v(0.38, 0.9, 0.12), v(0.08, 1.7, -0.22), v(0.4, 2.3, 0)], [0.34, 0.29, 0.25, 0.21], 6);
    const tips = fan(t, v(0.4, 2.2, 0), 4, 1.8, 1.6, 0.16, 0.06);
    const c = v(0.4, 4.4, 0);
    for (const tip of tips) {
      t.blob(v(tip.x, tip.y + 0.5, tip.z), 1.25 + t.j() * 0.2, 0.85, 1.15 + t.j() * 0.2, c, 0.28);
      t.limb(tip, tip.clone().add(v(t.j() * 0.6, 0.6, t.j() * 0.6)), 0.05, 0.02, 4);
    }
    t.blob(v(0.5, 5.1, 0.3), 1.3, 0.8, 1.2, c, 0.28);
    t.blob(v(-0.3, 4.6, -0.2), 0.95, 0.65, 0.95, c, 0.28);
    return t.build();
  },
  // savanna acacia: zigzag limbs holding a flat table-top crown
  tree_acacia() {
    const t = new Shape(97);
    t.stem([v(0, 0, 0), v(0.15, 1.0, 0.05), v(0.2, 1.6, 0)], [0.24, 0.2, 0.18]);
    const fork = v(0.2, 1.55, 0);
    const turn = t.rnd() * Math.PI * 2;
    const c = v(0.2, 6.8, 0);
    t.blob(v(0.2, 7.05, 0), 4.0, 0.5, 3.8, c, 0.18);
    for (let i = 0; i < 4; i++) {
      const a = turn + i * Math.PI / 2 + t.j() * 0.3;
      const elbow = v(fork.x + Math.cos(a + 0.5) * 1.5, 3.6 + t.j() * 0.3, fork.z + Math.sin(a + 0.5) * 1.5);
      const tip = v(fork.x + Math.cos(a) * 2.7, 6.3 + t.j() * 0.2, fork.z + Math.sin(a) * 2.7);
      t.limb(fork, elbow, 0.14, 0.1, 5);
      t.limb(elbow, tip, 0.1, 0.05, 4);
      t.blob(v(tip.x * 1.05, tip.y + 0.45, tip.z * 1.05), 2.3 + t.j() * 0.3, 0.42, 2.1 + t.j() * 0.3, c, 0.2);
    }
    return t.build();
  },
  // date, coconut, fan palm: curved ringed trunk and arching fronds
  tree_palm() {
    const t = new Shape(101);
    const pts: V[] = [], radii: number[] = [];
    for (let i = 0; i <= 6; i++) {
      const k = i / 6;
      pts.push(v(0.9 * k * k, 10 * k, 0.15 * k));
      radii.push(i === 0 ? 0.42 : 0.3 - 0.12 * k);
    }
    t.stem(pts, radii, 6);
    const top = pts[6];
    t.blob(v(top.x, top.y + 0.1, top.z), 0.42, 0.55, 0.42, top, 0.1);
    const count = 10;
    const turn = t.rnd() * Math.PI * 2;
    for (let i = 0; i < count; i++) {
      const yaw = turn + (i / count) * Math.PI * 2 + t.j() * 0.2;
      // upper fronds rise, lower ones hang
      const up = i % 2 ? 0.55 : 0.25;
      t.frond(v(top.x, top.y + 0.25, top.z), yaw, 3.3 + t.j() * 0.4, up + t.j() * 0.1, 0.95 + t.j() * 0.15, 0.55);
    }
    return t.build();
  },
  // rainforest giant: straight tall trunk, buttress roots, layered crown
  tree_tropical() {
    const t = new Shape(113);
    t.stem([v(0, 0, 0), v(0, 6, 0), v(0.1, 13.5, 0)], [0.6, 0.45, 0.32], 7);
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + 0.4;
      const out = v(Math.cos(a) * 1.7, 0, Math.sin(a) * 1.7);
      t.fins([[v(0, 0, 0), out, v(0, 2.6, 0)]], false);
    }
    const tips = fan(t, v(0.1, 13, 0), 5, 3.4, 2.6, 0.22, 0.08);
    const c = v(0, 16.5, 0);
    t.blob(v(0, 16.8, 0), 3.6, 1.7, 3.5, c, 0.2);
    for (const tip of tips) t.blob(v(tip.x * 1.1, tip.y + 0.6, tip.z * 1.1), 2.3 + t.j() * 0.3, 1.2, 2.2 + t.j() * 0.3, c, 0.24);
    ring(t, v(0, 0, 0), 3, 1.6, 18.4, [2.1, 1.25, 2.0], c, 0.25);
    return t.build();
  },
  // eucalyptus: pale crooked trunk, tall wandering limbs, loose drooping crown
  tree_eucalyptus() {
    const t = new Shape(127);
    const stem = [v(0, 0, 0), v(0.32, 4, 0.1), v(0, 8, -0.3), v(0.5, 11, 0)];
    t.stem(stem, [0.36, 0.29, 0.21, 0.14]);
    const c = v(0.3, 14.5, 0);
    const crowns: [number, number, number, number, number][] = [[1.9, 13.8, 0.4, 1.3, 2.0], [-1.6, 14.6, -0.6, 1.4, 2.0], [0.3, 15.8, 1.3, 1.2, 1.6], [0.7, 15.2, -1.7, 1.1, 1.7], [-0.5, 12.4, 1.5, 1.0, 1.4]];
    for (const [x, y, z, r, h] of crowns) {
      const from = stem[y > 14 ? 3 : 2].clone().lerp(stem[3], 0.6);
      const elbow = from.clone().lerp(v(x, y - h * 0.6, z), 0.5).add(v(t.j() * 0.5, 0, t.j() * 0.5));
      t.limb(from, elbow, 0.1, 0.07, 4);
      t.limb(elbow, v(x, y - h * 0.5, z), 0.07, 0.03, 4);
      t.blob(v(x, y, z), r, h, r * 0.92, c, 0.3);
    }
    t.blob(v(0.4, 16.5, 0), 0.9, 0.9, 0.85, c, 0.25);
    return t.build();
  },
  // boxwood, hazel, rhododendron: a low rounded mound of a few lumps
  bush_round() {
    const t = new Shape(131);
    for (let i = 0; i < 3; i++) t.limb(v(0, 0, 0), v(Math.cos(i * 2.1) * 0.5, 0.9, Math.sin(i * 2.1) * 0.5), 0.05, 0.015, 4);
    const c = v(0, 0.6, 0);
    t.blob(v(0, 0.72, 0), 1.0, 0.75, 0.95, c, 0.2);
    t.blob(v(0.62, 0.55, 0.3), 0.7, 0.55, 0.7, c, 0.2);
    t.blob(v(-0.55, 0.52, -0.32), 0.72, 0.52, 0.7, c, 0.2);
    t.blob(v(0.1, 1.12, -0.2), 0.6, 0.42, 0.6, c, 0.2);
    return t.build();
  },
  // rosemary, sagebrush, saltbush: twiggy, open, small grey tufts
  bush_dry() {
    const t = new Shape(139);
    const c = v(0, 0.6, 0);
    const turn = t.rnd() * 6.28;
    for (let i = 0; i < 6; i++) {
      const a = turn + i * 1.05 + t.j() * 0.3, r = 0.55 + t.j() * 0.15, y = 0.65 + t.j() * 0.2;
      const tip = v(Math.cos(a) * r, y, Math.sin(a) * r);
      t.limb(v(0, 0, 0), tip, 0.035, 0.012, 3);
      t.blob(v(tip.x, tip.y + 0.12, tip.z), 0.36 + t.j() * 0.06, 0.26, 0.34, c, 0.3);
    }
    t.blob(v(0, 0.9, 0), 0.32, 0.22, 0.32, c, 0.3);
    return t.build();
  },
  // grass and sedge: a tuft of bent wedge blades
  grass_tuft() {
    const t = new Shape(149);
    const tris: V[][] = [];
    for (let i = 0; i < 14; i++) {
      const a = i * 2.399 + t.j() * 0.3, lean = 0.25 + t.rnd() * 0.5, len = 0.45 + t.rnd() * 0.3;
      const out = v(Math.cos(a), 0, Math.sin(a)), side = v(-out.z, 0, out.x);
      const b0 = out.clone().multiplyScalar(0.06).addScaledVector(side, 0.035), b1 = out.clone().multiplyScalar(0.06).addScaledVector(side, -0.035);
      const mid = out.clone().multiplyScalar(lean * len * 0.45).setY(len * 0.6);
      const tip = out.clone().multiplyScalar(lean * len * 1.2).setY(len * 0.95);
      tris.push([b0, b1, mid.clone().addScaledVector(side, 0.02)], [b1, mid.clone().addScaledVector(side, -0.02), mid.clone().addScaledVector(side, 0.02)], [mid.clone().addScaledVector(side, 0.02), mid.clone().addScaledVector(side, -0.02), tip]);
    }
    t.fins(tris, true);
    return t.build();
  },
  // agave, aloe, prickly pear: a rosette of thick pointed leaves
  succulent() {
    const t = new Shape(151);
    const tris: V[][] = [];
    for (let i = 0; i < 13; i++) {
      const inner = i >= 8;
      const a = i * 2.399, len = inner ? 0.75 : 1.0, rise = inner ? 0.85 : 0.45;
      const out = v(Math.cos(a), 0, Math.sin(a)), side = v(-out.z, 0, out.x);
      const base = v(0, 0.06, 0).addScaledVector(out, 0.08);
      const l = base.clone().addScaledVector(side, 0.11), r = base.clone().addScaledVector(side, -0.11), back = base.clone().addScaledVector(UP, 0.09).addScaledVector(out, -0.04);
      const tip = out.clone().multiplyScalar(len * (1 - rise * 0.5)).setY(0.06 + len * rise);
      // a closed three-sided leaf
      tris.push([l, r, tip], [r, back, tip], [back, l, tip]);
    }
    t.fins(tris, true);
    return t.build();
  },
};

/** Geometry of every base shape, in FLORA_MODELS order. */
export function createFloraModels(): THREE.BufferGeometry[] {
  return FLORA_MODELS.map((id) => BUILD[id]());
}

/**
 * Far stand-ins for the shapes (about 28 triangles each): the trunk as a four-sided
 * post up to the crown, the crown as one faceted mass filling its bounds. From a
 * few hundred meters (or the map view) a tree reads by its silhouette and colour only.
 */
export function createFarFloraModels(near: THREE.BufferGeometry[]): THREE.BufferGeometry[] {
  return near.map((geometry, index) => {
    const position = geometry.getAttribute('position'), part = geometry.getAttribute('aPart');
    const leaf = new THREE.Box3(), bark = new THREE.Box3();
    const p = new THREE.Vector3();
    for (let i = 0; i < position.count; i++) {
      p.set(position.getX(i), position.getY(i), position.getZ(i));
      (part.getX(i) > 0.5 ? leaf : bark).expandByPoint(p);
    }
    const t = new Shape(1000 + index);
    if (!bark.isEmpty()) {
      const top = leaf.isEmpty() ? bark.max.y : Math.max(bark.min.y + 0.3, leaf.min.y + (leaf.max.y - leaf.min.y) * 0.3);
      const r = Math.min(0.5, Math.max(0.08, (bark.max.x - bark.min.x) * 0.12));
      t.limb(v(0, 0, 0), v(0, top, 0), r, r * 0.6, 4);
    }
    if (!leaf.isEmpty()) {
      const c = leaf.getCenter(new THREE.Vector3()), size = leaf.getSize(new THREE.Vector3());
      t.blob(c, size.x / 2, size.y / 2, size.z / 2, c, 0.12);
    }
    return t.build();
  });
}
