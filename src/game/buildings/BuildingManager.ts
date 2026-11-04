import { BufferAttribute, BufferGeometry, Color, DirectionalLight, HemisphereLight, InstancedBufferAttribute, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, type DataTexture, type Scene } from 'three';
import { installFade } from '../../rendering/buildingFade.ts';
import { HOUSE_PALETTE } from './BuildingStyles.ts';
import { BuildingCache } from './BuildingCache.ts';
import { chooseLod } from './BuildingLOD.ts';
import { createPieceGeometries, writePointMatrix, type WallModel } from './BuildingGeometry.ts';
import { PIECES, ROOF_LIP, type MeshName } from './pieces.ts';
import { buildRoof, canPitch, simplifyRing, type RoofPoint } from './RoofGenerator.ts';
import { createRecipe, indexFor, type ArchitectureSetting, type BuildingDetail, type BuildingFacts, type BuildingRecipe } from './BuildingStyles.ts';

export type BuildingModel = BuildingFacts & {
  walls: WallModel[];
  footprint: RoofPoint[];
  crest: number;
  rectangular: boolean;
  block: number;
};

export type BuildingView = {
  detail: BuildingDetail;
  architecture: ArchitectureSetting;
  region: string;
  colors: readonly string[];
  originKey: string;
};

const LIMITS: Record<MeshName, number> = {
  window: 4500, glass: 4500, windowSimple: 4500, glassSimple: 4500,
  store: 900, storeGlass: 900, door: 800, doorPanel: 800, balcony: 1400,
  shutter: 2200, awning: 500, cornice: 2800, band: 2800, downspout: 700, chimney: 500, vent: 500,
};

type Recorded = BuildingModel & {
  sig: string;
  recipe: BuildingRecipe;
  lod?: 0 | 1 | 2;
  wantsRoof: boolean;
};

class Pool {
  mesh: InstancedMesh;
  count = 0;
  dirty = false;
  private owners: string[] = [];
  private byKey = new Map<string, number[]>();
  private blocks: InstancedBufferAttribute;

  constructor(scene: Scene, geometry: BufferGeometry, material: MeshLambertMaterial, max: number) {
    this.mesh = new InstancedMesh(geometry, material, max);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.blocks = new InstancedBufferAttribute(new Float32Array(max), 1);
    this.mesh.geometry.setAttribute('blockId', this.blocks);
    scene.add(this.mesh);
  }

  add(key: string, matrix: Matrix4, color: Color, block = 0) {
    if (this.count >= this.mesh.instanceMatrix.count) return false;
    const index = this.count++;
    this.mesh.setMatrixAt(index, matrix);
    this.mesh.setColorAt(index, color);
    this.blocks.setX(index, block);
    this.owners[index] = key;
    const list = this.byKey.get(key);
    if (list) list.push(index);
    else this.byKey.set(key, [index]);
    this.mesh.count = this.count;
    this.dirty = true;
    return true;
  }

  remove(key: string) {
    const list = this.byKey.get(key);
    if (!list?.length) return;
    for (const index of [...list].sort((a, b) => b - a)) this.removeAt(index);
    this.byKey.delete(key);
  }

  private removeAt(index: number) {
    const last = this.count - 1;
    if (index !== last) {
      this.mesh.getMatrixAt(last, scratchMatrix);
      this.mesh.setMatrixAt(index, scratchMatrix);
      this.mesh.getColorAt(last, scratchColor);
      this.mesh.setColorAt(index, scratchColor);
      this.blocks.setX(index, this.blocks.getX(last));
      const moved = this.owners[last];
      this.owners[index] = moved;
      const list = this.byKey.get(moved);
      if (list) {
        const found = list.indexOf(last);
        if (found >= 0) list[found] = index;
      }
    }
    this.owners.pop();
    this.count = last;
    this.mesh.count = this.count;
    this.dirty = true;
  }

  flush() {
    if (!this.dirty) return;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.blocks.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.dirty = false;
  }
}

const scratchMatrix = new Matrix4();
const scratchColor = new Color();
const paletteColor = new Map<string, Color>();

function paint(hex: string) {
  let color = paletteColor.get(hex);
  if (!color) {
    color = new Color(hex);
    paletteColor.set(hex, color);
  }
  return color;
}

export class BuildingManager {
  private pools: Record<MeshName, Pool>;
  private geometries: Record<MeshName, BufferGeometry>;
  private models = new Map<string, Recorded>();
  private dirty = new Set<string>();
  private cache = new BuildingCache<BuildingRecipe>();
  private view: BuildingView = { detail: 'high', architecture: 'auto', region: '', colors: HOUSE_PALETTE, originKey: '' };
  private focus = { x: 0, z: 0 };
  private roofsDirty = false;
  private roofQuietUntil = 0;
  private streaming = false;
  private roofsRevealed = false;
  private roofMesh: Mesh | null = null;
  private roofGhost: Mesh | null = null;
  private roofMaterial: MeshBasicMaterial;
  private roofGhostMaterial: MeshBasicMaterial;
  private primed = false;
  private scanX = Infinity;
  private scanZ = Infinity;
  private frameMaterial: MeshLambertMaterial;
  private glassMaterial: MeshLambertMaterial;

  constructor(private scene: Scene, fadeTexture: DataTexture) {
    this.frameMaterial = new MeshLambertMaterial({ color: 0xffffff, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
    this.glassMaterial = new MeshLambertMaterial({ color: 0xffffff, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 });
    this.roofMaterial = new MeshBasicMaterial({ vertexColors: true, side: 2, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 });
    this.roofGhostMaterial = this.roofMaterial.clone();
    installFade(this.frameMaterial, fadeTexture, false);
    installFade(this.glassMaterial, fadeTexture, false);
    installFade(this.roofMaterial, fadeTexture, false);
    installFade(this.roofGhostMaterial, fadeTexture, true);
    this.geometries = createPieceGeometries();
    this.pools = {} as Record<MeshName, Pool>;
    for (const name of Object.keys(this.geometries) as MeshName[]) {
      const material = name.toLowerCase().includes('glass') ? this.glassMaterial : this.frameMaterial;
      this.pools[name] = new Pool(scene, this.geometries[name], material, LIMITS[name]);
    }
    scene.add(new HemisphereLight(0xf4faff, 0x8faac4, 1.15));
    const sun = new DirectionalLight(0xfffaf0, 0.65);
    sun.position.set(28, 72, 16);
    scene.add(sun);
  }

  configure(view: Omit<BuildingView, 'originKey'>) {
    const next = `${view.detail}|${view.architecture}|${view.region}|${view.colors.join(',')}`;
    const prev = `${this.view.detail}|${this.view.architecture}|${this.view.region}|${this.view.colors.join(',')}`;
    this.view = { ...this.view, ...view };
    if (next === prev) return;
    this.cache.clear();
    this.primed = false;
    for (const model of this.models.values()) model.sig = '';
    this.clearRoof();
  }

  recipeFor(facts: BuildingFacts) {
    const key = `${facts.key}|${this.view.detail}|${this.view.architecture}|${this.view.region}|${this.view.colors.join(',')}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const recipe = createRecipe(facts, this.view.colors, this.view.architecture, this.view.region);
    this.cache.set(key, recipe);
    return recipe;
  }

  setGhostPass(visible: boolean) {
    if (this.roofGhost) this.roofGhost.visible = visible;
  }

  setStreaming(busy: boolean) {
    this.streaming = busy;
    if (busy) {
      // Only blank pitched roofs before the first settled reveal — never after, or the city flashes again.
      if (!this.roofsRevealed) this.hidePitchedRoofs();
      if (this.roofsDirty) this.roofQuietUntil = Math.max(this.roofQuietUntil, performance.now() + 1200);
    }
  }

  isSettled() {
    if (this.streaming || this.roofsDirty || this.dirty.size > 0 || performance.now() < this.roofQuietUntil) return false;
    let needsPitched = false;
    for (const model of this.models.values()) {
      if (!model.wantsRoof) continue;
      needsPitched = true;
      break;
    }
    if (needsPitched && !(this.roofMesh && this.roofMesh.visible)) return false;
    return true;
  }

  private hidePitchedRoofs() {
    if (this.roofMesh) this.roofMesh.visible = false;
    if (this.roofGhost) this.roofGhost.visible = false;
  }

  private markRoofsDirty() {
    this.roofsDirty = true;
    if (!this.roofsRevealed) this.hidePitchedRoofs();
    // Coalesce many cell publishes into one pitched-roof rebuild so intro doesn't flicker.
    this.roofQuietUntil = Math.max(this.roofQuietUntil, performance.now() + (this.streaming ? 1200 : 450));
  }

  setModels(models: BuildingModel[], originKey: string) {
    this.view.originKey = originKey;
    const seen = new Set<string>();
    let added = false;
    for (const model of models) {
      seen.add(model.key);
      const recipe = this.recipeFor(model);
      const sig = `${model.key}|${originKey}|${Math.round(model.crest * 2)}|${model.walls.length}|${recipe.style}|${recipe.roofKind}|${this.view.detail}`;
      const prev = this.models.get(model.key);
      if (prev && prev.sig === sig) continue;
      const pitched = this.view.detail !== 'off' && this.view.detail !== 'low' && model.rectangular && recipe.roofKind !== 'flat';
      if (prev) {
        for (const pool of Object.values(this.pools)) pool.remove(model.key);
        if (prev.wantsRoof !== pitched || Math.abs(prev.crest - model.crest) > 0.35) this.markRoofsDirty();
      } else {
        added = true;
        if (pitched) this.markRoofsDirty();
      }
      this.models.set(model.key, { ...model, sig, recipe, lod: prev?.lod, wantsRoof: pitched });
    }
    for (const key of [...this.models.keys()]) {
      if (seen.has(key)) continue;
      this.removeInstances(key);
      this.models.delete(key);
      this.dirty.delete(key);
    }
    if (added) { this.scanX = Infinity; this.scanZ = Infinity; }
  }

  update(x: number, z: number) {
    this.focus = { x, z };
    if (this.view.detail === 'off') {
      if (this.anyInstances()) this.clearInstances();
      this.clearRoof();
      return;
    }
    const dx = x - this.scanX;
    const dz = z - this.scanZ;
    if (dx * dx + dz * dz > 225) {
      this.scanX = x;
      this.scanZ = z;
      for (const model of this.models.values()) {
        const next = chooseLod(distance(model.footprint, this.focus), model.lod, this.view.detail);
        if (model.lod == null && next === 2) {
          model.lod = 2;
          continue;
        }
        if (next !== model.lod) {
          model.lod = next;
          this.dirty.add(model.key);
        }
      }
    }
    this.process();
  }

  dispose() {
    this.clearInstances();
    this.clearRoof();
    this.roofsRevealed = false;
    for (const pool of Object.values(this.pools)) this.scene.remove(pool.mesh);
    for (const geometry of Object.values(this.geometries)) geometry.dispose();
    this.frameMaterial.dispose();
    this.glassMaterial.dispose();
    this.roofMaterial.dispose();
    this.roofGhostMaterial.dispose();
    this.models.clear();
    this.cache.clear();
  }

  private anyInstances() {
    return Object.values(this.pools).some((pool) => pool.count > 0) || Boolean(this.roofMesh);
  }

  private clearInstances() {
    for (const key of [...this.models.keys()]) this.removeInstances(key);
  }

  private removeInstances(key: string) {
    for (const pool of Object.values(this.pools)) pool.remove(key);
    const model = this.models.get(key);
    if (model?.wantsRoof) this.markRoofsDirty();
    if (model) model.wantsRoof = false;
  }

  private process() {
    const started = performance.now();
    if (this.dirty.size) {
      const batch = [...this.dirty].map((key) => this.models.get(key)).filter((model): model is Recorded => Boolean(model));
      batch.sort((a, b) => distance(a.footprint, this.focus) - distance(b.footprint, this.focus));
      const budget = this.primed ? 7 : 16;
      const deadline = started + 2;
      for (let i = 0; i < batch.length && i < budget; i++) {
        this.rebuild(batch[i]);
        this.dirty.delete(batch[i].key);
        if (performance.now() >= deadline) break;
      }
      if (!this.dirty.size) this.primed = true;
    }
    for (const pool of Object.values(this.pools)) pool.flush();
    // Hold the global pitched-roof mesh while cells are still arriving, then rebuild once.
    if (
      this.roofsDirty
      && !this.dirty.size
      && !this.streaming
      && performance.now() >= this.roofQuietUntil
      && performance.now() - started < 2.5
    ) this.rebuildRoofs();
  }

  private rebuild(model: Recorded) {
    for (const pool of Object.values(this.pools)) pool.remove(model.key);
    const detail = this.view.detail === 'low' ? 'low' : this.view.detail;
    const pitched = this.view.detail !== 'off' && detail !== 'low' && model.rectangular && model.recipe.roofKind !== 'flat';
    if (model.wantsRoof !== pitched) {
      model.wantsRoof = pitched;
      this.markRoofsDirty();
    }
    if (pitched || detail !== 'high') return;
    if (model.recipe.features.chimney) this.addRoofAccent(model, false);
    if (model.recipe.features.vent) this.addVent(model, false);
  }

  private addRoofAccent(model: Recorded, pitched: { ridgeY: number; ridgeA: RoofPoint; ridgeB: RoofPoint } | false) {
    const spot = decorPoint(model.footprint, model.recipe.seed);
    const size = PIECES.chimney;
    const y = pitched ? pitched.ridgeY + size.h * 0.35 : model.crest + 0.42 + size.h * 0.42;
    const point = pitched ? mix(pitched.ridgeA, pitched.ridgeB, 0.22 + (model.recipe.seed % 40) / 100) : spot;
    writePointMatrix(point.x, y, point.z, 1, 1, 1, scratchMatrix);
    this.pools.chimney.add(model.key, scratchMatrix, paint(recipeMix(model.recipe.colors.roof, model.recipe.colors.trim)), model.block);
  }

  private addVent(model: Recorded, pitched: { ridgeY: number } | false) {
    const spot = decorPoint(model.footprint, model.recipe.seed ^ 91);
    const y = pitched ? pitched.ridgeY + 0.12 : model.crest + 0.42 + PIECES.vent.h * 0.5;
    writePointMatrix(spot.x, y, spot.z, 1, 1, 1, scratchMatrix);
    this.pools.vent.add(model.key, scratchMatrix, paint(model.recipe.colors.metal), model.block);
  }

  private rebuildRoofs() {
    this.roofsDirty = false;
    for (const model of this.models.values()) {
      if (!model.wantsRoof) continue;
      this.pools.chimney.remove(model.key);
      this.pools.vent.remove(model.key);
    }
    const pitched = [...this.models.values()].filter((model) => model.wantsRoof);
    if (!pitched.length) {
      this.clearRoof();
      return;
    }
    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const blocks: number[] = [];
    for (const model of pitched) {
      const kind = model.recipe.roofKind === 'hip' && this.view.detail !== 'high' ? 'gable' : model.recipe.roofKind;
      if (kind === 'flat') continue;
      const roof = buildRoof(model.footprint, model.crest + ROOF_LIP - 0.04, kind);
      if (!roof) continue;
      const color = paint(model.recipe.colors.roof);
      for (let i = 0; i < roof.positions.length; i += 3) {
        positions.push(roof.positions[i], roof.positions[i + 1], roof.positions[i + 2]);
        normals.push(roof.normals[i], roof.normals[i + 1], roof.normals[i + 2]);
        colors.push(color.r, color.g, color.b);
        blocks.push(model.block);
      }
      if (model.recipe.features.chimney && this.view.detail === 'high') this.addRoofAccent(model, roof);
      if (model.recipe.features.vent && this.view.detail === 'high') this.addVent(model, roof);
    }
    if (!positions.length) {
      this.clearRoof();
      return;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
    geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
    geometry.setAttribute('blockId', new BufferAttribute(new Float32Array(blocks), 1));
    const nextRoof = new Mesh(geometry, this.roofMaterial);
    nextRoof.frustumCulled = false;
    const nextGhost = new Mesh(geometry, this.roofGhostMaterial);
    nextGhost.frustumCulled = false;
    nextGhost.renderOrder = 3;
    nextGhost.visible = this.roofGhost?.visible ?? false;
    // Swap atomically so pitched roofs don't blink away for a frame.
    const previousRoof = this.roofMesh;
    const previousGhost = this.roofGhost;
    this.roofMesh = nextRoof;
    this.roofGhost = nextGhost;
    nextRoof.visible = true;
    this.roofsRevealed = true;
    this.scene.add(nextRoof);
    this.scene.add(nextGhost);
    if (previousGhost) this.scene.remove(previousGhost);
    if (previousRoof) {
      this.scene.remove(previousRoof);
      previousRoof.geometry.dispose();
    }
    for (const pool of [this.pools.chimney, this.pools.vent]) pool.flush();
  }

  private clearRoof() {
    if (this.roofGhost) {
      this.scene.remove(this.roofGhost);
      this.roofGhost = null;
    }
    if (!this.roofMesh) return;
    this.scene.remove(this.roofMesh);
    this.roofMesh.geometry.dispose();
    this.roofMesh = null;
    this.roofsRevealed = false;
  }
}

function distance(points: RoofPoint[], focus: { x: number; z: number }) {
  let best = Infinity;
  for (const point of points) {
    const dx = point.x - focus.x;
    const dz = point.z - focus.z;
    const value = dx * dx + dz * dz;
    if (value < best) best = value;
  }
  return Math.sqrt(best);
}

function decorPoint(points: RoofPoint[], seed: number) {
  const usable = points.filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.z));
  if (!usable.length) return { x: 0, z: 0 };
  let sx = 0;
  let sz = 0;
  for (const point of usable) {
    sx += point.x;
    sz += point.z;
  }
  const corner = usable[indexFor(usable.length, seed)] ?? usable[0];
  if (!corner) return { x: 0, z: 0 };
  const n = usable.length;
  return { x: sx / n * 0.55 + corner.x * 0.45, z: sz / n * 0.55 + corner.z * 0.45 };
}

function mix(a: RoofPoint, b: RoofPoint, t: number) {
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}

function recipeMix(from: string, to: string) {
  return from || to;
}

export function footprintCanPitch(points: RoofPoint[]) {
  return canPitch(simplifyRing(points));
}
