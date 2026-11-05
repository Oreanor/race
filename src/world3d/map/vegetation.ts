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

type Kind = 'post' | 'rail' | 'chimney' | 'vent' | 'lamp';

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
    };
    const lambert = (color: string | number) => simpleLit(color, uniforms);
    this.materials = {
      post: lambert('#4a4036'), rail: lambert('#5c5145'),
      chimney: lambert(0xffffff), vent: lambert(0xffffff),
      lamp: simpleLit('#9aa1a8', uniforms, { shiny: true, glow: true }),
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
    for (const [kind, set] of [['post', data.posts], ['rail', data.rails], ['lamp', data.lamps]] as [Kind, InstanceSet][]) {
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
