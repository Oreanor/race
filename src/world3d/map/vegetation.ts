import * as THREE from 'three';
import type { InstanceSet, VegetationData } from '../tiles/vegetationTile';
import type { BaseUniforms } from './materials';
import { floraLit, simpleLit } from './simpleLit';
import { createPieceGeometries } from '@/game/buildings/BuildingGeometry';
import { createFarFloraModels, createFloraModels } from './floraModels';
import { FLORA_MODELS } from '../tiles/flora';

/** beyond this (m from the camera to the tile) trees switch to their far stand-ins */
export const FLORA_FAR = 450;
/** and beyond this, shrubs, grass and succulents are not drawn at all */
export const FLORA_SMALL_HIDE = 700;
const SMALL = new Set(FLORA_MODELS.map((id, i) => (/^(bush|grass|succulent)/.test(id) ? i : -1)).filter((i) => i >= 0));
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const pieces = createPieceGeometries();

// Draws the per-tile vegetation planned in the worker: one InstancedMesh per
// tree / shrub shape per tile (all in one material), plus fences, lamps and
// roof props. Ground height and fog in the shader.

type Kind = 'post' | 'rail' | 'chimney' | 'vent' | 'lamp' | 'plinth' | 'plinthLong' | 'figure' | 'rider'
  | 'fountain' | 'fountainWater' | 'shelter' | 'shelterGlass' | 'goal';

/** Merge simple pieces into one shape, no uvs. */
function shape(pieces: THREE.BufferGeometry[]) {
  const merged = mergeGeometries(pieces.map((g) => g.toNonIndexed()), false)!;
  merged.deleteAttribute('uv');
  merged.computeVertexNormals();
  return merged;
}

/** A stone pedestal: two steps, a shaft and a cornice; top at 2.7 m. */
function plinthGeometry() {
  return shape([
    new THREE.BoxGeometry(2.2, 0.22, 2.2).translate(0, 0.11, 0),
    new THREE.BoxGeometry(1.8, 0.22, 1.8).translate(0, 0.33, 0),
    new THREE.BoxGeometry(1.15, 1.95, 1.15).translate(0, 0.44 + 0.975, 0),
    new THREE.BoxGeometry(1.4, 0.18, 1.4).translate(0, 2.48, 0),
    new THREE.BoxGeometry(1.25, 0.12, 1.25).translate(0, 2.64, 0),
  ]);
}

/** The long pedestal under a horse (along +Z); top at 2.4 m. */
function plinthLongGeometry() {
  return shape([
    new THREE.BoxGeometry(2.5, 0.22, 4.2).translate(0, 0.11, 0),
    new THREE.BoxGeometry(2.1, 0.22, 3.8).translate(0, 0.33, 0),
    new THREE.BoxGeometry(1.5, 1.7, 3.1).translate(0, 0.44 + 0.85, 0),
    new THREE.BoxGeometry(1.75, 0.16, 3.4).translate(0, 2.22, 0),
    new THREE.BoxGeometry(1.6, 0.1, 3.25).translate(0, 2.35, 0),
  ]);
}

/** A standing figure in a long coat, one arm raised; 2.8 m, facing +Z. */
function figureGeometry() {
  const arm = (side: number, raised: boolean) => {
    const g = new THREE.CylinderGeometry(0.07, 0.08, 0.78, 6).translate(0, -0.36, 0);
    if (raised) g.rotateX(-2.35).rotateZ(side * 0.25);
    else g.rotateZ(side * 0.12);
    return g.translate(side * 0.36, 2.0, 0);
  };
  return shape([
    new THREE.CylinderGeometry(0.11, 0.12, 1.0, 6).translate(-0.13, 0.5, 0),
    new THREE.CylinderGeometry(0.11, 0.12, 1.0, 6).translate(0.13, 0.5, 0.05),
    // coat flaring to the knees, chest, shoulders
    new THREE.CylinderGeometry(0.3, 0.42, 0.75, 7).translate(0, 1.05, 0),
    new THREE.CylinderGeometry(0.33, 0.3, 0.7, 7).translate(0, 1.75, 0),
    new THREE.BoxGeometry(0.78, 0.14, 0.34).translate(0, 2.08, 0),
    arm(1, true), arm(-1, false),
    new THREE.CylinderGeometry(0.07, 0.08, 0.14, 6).translate(0, 2.2, 0),
    new THREE.SphereGeometry(0.17, 8, 6).translate(0, 2.42, 0.01),
    // a hat brim
    new THREE.CylinderGeometry(0.22, 0.22, 0.04, 8).translate(0, 2.56, 0),
  ]);
}

/** A round stone basin (6 m across, 0.7 m rim) with a column and a bowl in the middle. */
function fountainGeometry() {
  // the basin turned from its profile: outer wall, lip, inner wall, floor
  const basin = new THREE.LatheGeometry([
    new THREE.Vector2(3.1, 0), new THREE.Vector2(3.0, 0.7), new THREE.Vector2(2.75, 0.7),
    new THREE.Vector2(2.75, 0.25), new THREE.Vector2(0.01, 0.25),
  ], 24);
  return shape([
    basin,
    new THREE.CylinderGeometry(0.28, 0.4, 1.9, 8).translate(0, 0.95, 0),
    new THREE.CylinderGeometry(1.0, 0.35, 0.3, 12).translate(0, 1.95, 0),
    new THREE.CylinderGeometry(0.15, 0.2, 0.6, 8).translate(0, 2.35, 0),
    new THREE.SphereGeometry(0.22, 8, 6).translate(0, 2.75, 0),
  ]);
}

/** The water in a fountain: the pool and the upper bowl's surface. */
function fountainWaterGeometry() {
  return shape([
    new THREE.CircleGeometry(2.75, 24).rotateX(-Math.PI / 2).translate(0, 0.55, 0),
    new THREE.CircleGeometry(0.92, 12).rotateX(-Math.PI / 2).translate(0, 2.08, 0),
  ]);
}

/** A bus shelter, open toward +Z (the road): posts, roof, back frame, bench, the stop's sign. */
function shelterGeometry() {
  return shape([
    new THREE.BoxGeometry(0.08, 2.45, 0.08).translate(-1.6, 1.22, -0.6),
    new THREE.BoxGeometry(0.08, 2.45, 0.08).translate(1.6, 1.22, -0.6),
    new THREE.BoxGeometry(0.08, 2.45, 0.08).translate(-1.6, 1.22, 0.55),
    new THREE.BoxGeometry(0.08, 2.45, 0.08).translate(1.6, 1.22, 0.55),
    new THREE.BoxGeometry(3.5, 0.1, 1.55).translate(0, 2.5, -0.02),
    new THREE.BoxGeometry(3.2, 0.06, 0.06).translate(0, 0.12, -0.6),
    new THREE.BoxGeometry(2.4, 0.06, 0.38).translate(0, 0.48, -0.42),
    new THREE.BoxGeometry(0.06, 0.45, 0.06).translate(-1.1, 0.24, -0.42),
    new THREE.BoxGeometry(0.06, 0.45, 0.06).translate(1.1, 0.24, -0.42),
    // the sign on its pole, beside the shelter
    new THREE.CylinderGeometry(0.04, 0.04, 2.7, 6).translate(2.2, 1.35, 0.5),
    new THREE.BoxGeometry(0.5, 0.5, 0.05).translate(2.2, 2.55, 0.5),
  ]);
}

/** The shelter's glass: the back and one end. */
function shelterGlassGeometry() {
  return shape([
    new THREE.BoxGeometry(3.12, 2.1, 0.03).translate(0, 1.25, -0.6),
    new THREE.BoxGeometry(0.03, 2.1, 1.1).translate(-1.6, 1.25, -0.03),
  ]);
}

/** A football goal (7.32 × 2.44 m) standing on the goal line, the net sloping back (−Z). */
function goalGeometry() {
  return shape([
    new THREE.CylinderGeometry(0.06, 0.06, 2.44, 6).translate(-3.66, 1.22, 0),
    new THREE.CylinderGeometry(0.06, 0.06, 2.44, 6).translate(3.66, 1.22, 0),
    new THREE.CylinderGeometry(0.06, 0.06, 7.44, 6).rotateZ(Math.PI / 2).translate(0, 2.44, 0),
    new THREE.CylinderGeometry(0.03, 0.03, 2.6, 4).rotateX(0.95).translate(-3.66, 1.25, -0.95),
    new THREE.CylinderGeometry(0.03, 0.03, 2.6, 4).rotateX(0.95).translate(3.66, 1.25, -0.95),
    new THREE.CylinderGeometry(0.03, 0.03, 7.32, 4).rotateZ(Math.PI / 2).translate(0, 0.03, -1.9),
  ]);
}

/** A rider on a standing horse, facing +Z; 3.2 m. */
function riderGeometry() {
  const leg = (x: number, z: number, lift = 0) => new THREE.CylinderGeometry(0.08, 0.1, 1.1, 6).translate(x, 0.55 + lift, z);
  const neck = new THREE.BoxGeometry(0.34, 0.9, 0.4).rotateX(0.6).translate(0, 1.85, 0.95);
  const head = new THREE.BoxGeometry(0.26, 0.3, 0.62).rotateX(0.35).translate(0, 2.2, 1.35);
  const tail = new THREE.BoxGeometry(0.12, 0.7, 0.12).rotateX(-0.35).translate(0, 1.3, -1.05);
  return shape([
    // the horse: body, chest, rump, legs (a fore leg raised), neck, head, tail
    new THREE.BoxGeometry(0.62, 0.62, 1.7).translate(0, 1.4, 0),
    new THREE.SphereGeometry(0.36, 8, 6).scale(1, 1.05, 1.1).translate(0, 1.42, 0.78),
    new THREE.SphereGeometry(0.37, 8, 6).scale(1, 1, 1.1).translate(0, 1.45, -0.78),
    leg(-0.2, 0.7), leg(0.2, 0.55, 0.35).rotateX(0) , leg(-0.2, -0.7), leg(0.2, -0.7),
    neck, head, tail,
    // the rider: legs astride, body, arms, head
    new THREE.BoxGeometry(0.72, 0.18, 0.34).translate(0, 1.82, 0.05),
    new THREE.CylinderGeometry(0.08, 0.09, 0.6, 6).translate(-0.36, 1.55, 0.1),
    new THREE.CylinderGeometry(0.08, 0.09, 0.6, 6).translate(0.36, 1.55, 0.1),
    new THREE.CylinderGeometry(0.22, 0.26, 0.72, 7).translate(0, 2.25, 0),
    new THREE.CylinderGeometry(0.06, 0.07, 0.62, 6).rotateX(-0.9).translate(0.28, 2.32, 0.28),
    new THREE.CylinderGeometry(0.06, 0.07, 0.62, 6).rotateX(-0.5).translate(-0.28, 2.25, 0.25),
    new THREE.SphereGeometry(0.15, 8, 6).translate(0, 2.8, 0.02),
    new THREE.CylinderGeometry(0.2, 0.2, 0.04, 8).translate(0, 2.93, 0),
  ]);
}

/** Mark every vertex: 0 metal post, 1 neon / lamp head (shader glow). */
function withGlow(geometry: THREE.BufferGeometry, glow: number) {
  const n = geometry.getAttribute('position').count;
  geometry.setAttribute('aGlow', new THREE.Float32BufferAttribute(new Float32Array(n).fill(glow), 1));
  return geometry;
}

/** Classic street lamp: pole, arm over the road (+X), warm head. Meters. */
function classicLampGeometry() {
  const pole = withGlow(new THREE.CylinderGeometry(0.07, 0.11, 7, 6).translate(0, 3.5, 0), 0);
  const base = withGlow(new THREE.CylinderGeometry(0.16, 0.18, 0.5, 6).translate(0, 0.25, 0), 0);
  const arm = withGlow(new THREE.BoxGeometry(1.5, 0.07, 0.07).translate(0.72, 6.95, 0), 0);
  const head = withGlow(new THREE.BoxGeometry(0.62, 0.16, 0.3).translate(1.42, 6.86, 0), 1);
  const merged = mergeGeometries([pole, base, arm, head].map((g) => g.toNonIndexed()), false)!;
  merged.deleteAttribute('uv');
  return merged;
}

/**
 * Futuristic lamp: a glass post about 3 m tall, glowing blue all over, on a short
 * steel foot; it lights the street all around (no arm, no head).
 */
function neonLampGeometry() {
  const foot = withGlow(new THREE.CylinderGeometry(0.2, 0.24, 0.18, 6).translate(0, 0.09, 0), 0);
  const glass = withGlow(new THREE.CylinderGeometry(0.13, 0.15, 2.9, 6).translate(0, 0.18 + 1.45, 0), 1);
  const cap = withGlow(new THREE.CylinderGeometry(0.17, 0.13, 0.08, 6).translate(0, 3.12, 0), 0);
  const merged = mergeGeometries([foot, glass, cap].map((g) => g.toNonIndexed()), false)!;
  merged.deleteAttribute('uv');
  return merged;
}

function applyLampShape(mesh: THREE.InstancedMesh, shape: THREE.BufferGeometry) {
  const geometry = mesh.geometry;
  for (const name of ['position', 'normal', 'aGlow']) {
    const attr = shape.getAttribute(name);
    if (attr) geometry.setAttribute(name, attr);
  }
  geometry.setIndex(shape.getIndex());
  geometry.computeBoundingSphere();
  if (geometry.boundingSphere) geometry.boundingSphere.radius += 400;
}

/** A lamp's cone of light, in the lamp's own meters: from the head down to the street. */
function beamGeometry() {
  const cone = new THREE.ConeGeometry(4.2, 6.85, 20, 1, true).translate(1.42, 6.86 - 3.425, 0);
  const position = cone.getAttribute('position');
  const glow = new Float32Array(position.count);
  for (let i = 0; i < position.count; i++) glow[i] = Math.max(0, position.getY(i) / 6.86); // 1 at the head, 0 on the ground
  cone.setAttribute('aGlow', new THREE.BufferAttribute(glow, 1));
  cone.deleteAttribute('uv');
  cone.deleteAttribute('normal');
  return cone;
}

/** Additive, depth-tested, no depth writes; lit only at night, and not for the glass posts. */
function beamMaterial(uniforms: BaseUniforms) {
  return new THREE.ShaderMaterial({
    uniforms: { uExag: uniforms.uExag, uLampOn: uniforms.uLampOn, uLampColor: uniforms.uLampColor, uLampOmni: uniforms.uLampOmni },
    vertexShader: /* glsl */ `
      uniform float uExag;
      attribute float iGround;
      attribute float aGlow;
      varying float vGlow;
      void main() {
        vGlow = aGlow;
        vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
        world.y += iGround * uExag;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uLampOn;
      uniform vec3 uLampColor;
      uniform float uLampOmni;
      varying float vGlow;
      void main() {
        float a = vGlow * vGlow * uLampOn * (1.0 - uLampOmni) * 0.22;
        if (a < 0.002) discard;
        gl_FragColor = vec4(uLampColor * a, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

export class VegetationRenderer {
  private geometries: Record<Kind, THREE.BufferGeometry>;
  private materials: Record<Kind, THREE.Material>;
  private flora: THREE.BufferGeometry[];
  private floraFar: THREE.BufferGeometry[];
  private floraMat: THREE.ShaderMaterial;
  /** the soft cone of light under every classic lamp head, shown at night */
  private beam: THREE.BufferGeometry;
  private beamMat: THREE.ShaderMaterial;
  private classicLamp: THREE.BufferGeometry;
  private neonLamp: THREE.BufferGeometry;
  private lampMeshes = new Set<THREE.InstancedMesh>();
  private futuristic = false;

  constructor(uniforms: BaseUniforms) {
    this.classicLamp = classicLampGeometry();
    this.neonLamp = neonLampGeometry();
    this.geometries = {
      post: new THREE.BoxGeometry(0.09, 1, 0.09),
      rail: new THREE.BoxGeometry(1, 0.06, 0.05),
      // same shapes as the old detailed layer's roof props
      chimney: pieces.chimney,
      vent: pieces.vent,
      lamp: this.classicLamp,
      plinth: plinthGeometry(), plinthLong: plinthLongGeometry(), figure: figureGeometry(), rider: riderGeometry(),
      fountain: fountainGeometry(), fountainWater: fountainWaterGeometry(), shelter: shelterGeometry(), shelterGlass: shelterGlassGeometry(), goal: goalGeometry(),
    };
    const lambert = (color: string | number) => simpleLit(color, uniforms);
    this.materials = {
      post: lambert('#4a4036'), rail: lambert('#5c5145'),
      chimney: lambert(0xffffff), vent: lambert(0xffffff),
      lamp: simpleLit('#9aa1a8', uniforms, { shiny: true, glow: true }),
      // pale stone, dark bronze
      plinth: lambert('#c9c1b3'), plinthLong: lambert('#c9c1b3'),
      figure: simpleLit('#5a4a33', uniforms, { shiny: true }), rider: simpleLit('#5a4a33', uniforms, { shiny: true }),
      fountain: lambert('#cfc6b6'), fountainWater: simpleLit('#4f8fa8', uniforms, { shiny: true }),
      shelter: simpleLit('#59626b', uniforms, { shiny: true }), shelterGlass: simpleLit('#a9c4d2', uniforms, { shiny: true }),
      goal: lambert('#f2f2ee'),
    };
    this.flora = createFloraModels();
    this.floraFar = createFarFloraModels(this.flora);
    this.floraMat = floraLit(uniforms);
    this.beam = beamGeometry();
    this.beamMat = beamMaterial(uniforms);
  }

  /** Chimneys and vents of a tile (colours per instance). */
  buildAccents(accents: { chimney: InstanceSet; vent: InstanceSet }) {
    return [...this.instanced('chimney', this.geometries.chimney, this.materials.chimney, accents.chimney), ...this.instanced('vent', this.geometries.vent, this.materials.vent, accents.vent)];
  }

  /** Meshes for one tile, ready to add to the tile group. Flora meshes are named `flora<shape index>`. */
  build(data: VegetationData): THREE.InstancedMesh[] {
    const out: THREE.InstancedMesh[] = [];
    data.flora.forEach((set, i) => out.push(...this.instanced(`flora${i}`, this.flora[i], this.floraMat, set)));
    for (const [kind, set] of [['post', data.posts], ['rail', data.rails], ['lamp', data.lamps], ['plinth', data.plinths], ['plinthLong', data.plinthsLong], ['figure', data.figures], ['rider', data.riders],
      ['fountain', data.fountains], ['fountainWater', data.fountainWater], ['shelter', data.shelters], ['shelterGlass', data.shelterGlass], ['goal', data.goals]] as [Kind, InstanceSet][]) {
      out.push(...this.instanced(kind, this.geometries[kind], this.materials[kind], set));
    }
    // every lamp's cone of light, on its own copy of the matrices: a lamp knocked down puts it out
    out.push(...this.instanced('lampBeam', this.beam, this.beamMat, { ...data.lamps, matrices: data.lamps.matrices.slice() }).map((mesh) => { mesh.renderOrder = 6; return mesh; }));
    return out;
  }

  /**
   * Level of detail of one tile's trees, from the camera's distance to the tile (m):
   * full shapes near, far stand-ins beyond FLORA_FAR, small plants gone beyond
   * FLORA_SMALL_HIDE. Only the shape attributes are swapped; instances stay.
   */
  floraDetail(meshes: Iterable<THREE.InstancedMesh>, distance: number) {
    const level = distance < FLORA_FAR ? 0 : distance < FLORA_SMALL_HIDE ? 1 : 2;
    for (const mesh of meshes) {
      if (mesh.userData.floraLevel === level) continue;
      const index = Number(mesh.name.slice(5));
      const was = mesh.userData.floraLevel ?? 0;
      mesh.userData.floraLevel = level;
      mesh.visible = !(level === 2 && SMALL.has(index));
      if ((was === 0) === (level === 0)) continue; // same shape (far at 1 and 2)
      const shape = level === 0 ? this.flora[index] : this.floraFar[index];
      for (const name of ['position', 'normal', 'aPart', 'aShade']) mesh.geometry.setAttribute(name, shape.getAttribute(name));
      mesh.geometry.setIndex(shape.getIndex());
    }
  }

  /** Swap street lamps to neon tubes (futuristic skin) or back to classic heads. */
  setFuturistic(on: boolean) {
    if (this.futuristic === on) return;
    this.futuristic = on;
    const shape = on ? this.neonLamp : this.classicLamp;
    this.geometries.lamp = shape;
    const mat = this.materials.lamp as THREE.ShaderMaterial;
    mat.uniforms.uColor.value.set(on ? '#7a8894' : '#9aa1a8');
    for (const mesh of this.lampMeshes) applyLampShape(mesh, shape);
  }

  private instanced(name: string, base: THREE.BufferGeometry, material: THREE.Material, set: InstanceSet): THREE.InstancedMesh[] {
    if (!set.count) return [];
    const geometry = new THREE.BufferGeometry();
    for (const attr of Object.keys(base.attributes)) geometry.setAttribute(attr, base.getAttribute(attr));
    geometry.setIndex(base.getIndex());
    geometry.setAttribute('iGround', new THREE.InstancedBufferAttribute(set.ground, 1));
    if (set.bark) geometry.setAttribute('iBark', new THREE.InstancedBufferAttribute(set.bark, 3));
    if (set.traits) geometry.setAttribute('iTraits', new THREE.InstancedBufferAttribute(set.traits, 4));
    const mesh = new THREE.InstancedMesh(geometry, material, set.count);
    mesh.name = name; // gunfire and cars find a tree or lamp by its mesh name
    mesh.instanceMatrix = new THREE.InstancedBufferAttribute(set.matrices, 16);
    if (set.colors && set.colors.length) mesh.instanceColor = new THREE.InstancedBufferAttribute(set.colors, 3);
    mesh.count = set.count;
    mesh.matrixAutoUpdate = false;
    mesh.computeBoundingSphere();
    if (mesh.boundingSphere) mesh.boundingSphere.radius += 400; // ground lift with exaggeration
    if (name === 'lamp') {
      this.lampMeshes.add(mesh);
      // lit or knocked down, per lamp (WorldTiles.lampOut)
      geometry.setAttribute('iOn', new THREE.InstancedBufferAttribute(new Float32Array(set.count).fill(1), 1));
    }
    return [mesh];
  }

  /** Free a tile's meshes but keep the shared shapes. */
  release(meshes: THREE.InstancedMesh[]) {
    for (const mesh of meshes) {
      this.lampMeshes.delete(mesh);
      const geometry = mesh.geometry;
      // shared shape attributes stay; the per-tile instance attributes go with the geometry
      for (const name of Object.keys(geometry.attributes)) if (!(geometry.getAttribute(name) instanceof THREE.InstancedBufferAttribute)) geometry.deleteAttribute(name);
      geometry.setIndex(null);
      geometry.dispose();
      mesh.dispose();
    }
  }

  setSide(side: THREE.Side) {
    for (const m of Object.values(this.materials)) m.side = side;
    this.floraMat.side = side;
  }

  dispose() {
    this.classicLamp.dispose();
    this.neonLamp.dispose();
    for (const [kind, g] of Object.entries(this.geometries)) {
      if (kind === 'lamp') continue; // classic/neon already freed
      g.dispose();
    }
    for (const g of this.flora) g.dispose();
    for (const g of this.floraFar) g.dispose();
    for (const m of new Set(Object.values(this.materials))) m.dispose();
    this.floraMat.dispose();
    this.beam.dispose();
    this.beamMat.dispose();
    this.lampMeshes.clear();
  }
}
