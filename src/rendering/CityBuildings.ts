import { cellDistance, deferCellReplacement } from '@/game/buildings/cellStreaming';
import { BufferAttribute, BufferGeometry, Color, DoubleSide, Mesh, MeshBasicMaterial, MeshLambertMaterial, SRGBColorSpace, RepeatWrapping, LinearFilter, LinearMipmapLinearFilter, type Texture } from 'three';
import * as THREE from 'three';
import { MercatorCoordinate, type CustomLayerInterface, type Map as LibreMap } from 'maplibre-gl';
import { facadeTexture } from './facades';
import { facadeBands, layoutFacade } from '@/game/buildings/FacadeGenerator';
import { PIECES, ROOF_LIP } from '@/game/buildings/pieces';
import { BuildingManager, footprintCanPitch, type BuildingModel } from '@/game/buildings/BuildingManager';
import { resolveWalls } from '@/game/buildings/wallOverlap';
import { buildingBlocksView } from '@/game/buildings/viewOcclusion';
import type { ArchitectureSetting, BuildingDetail, BuildingRecipe } from '@/game/buildings/BuildingStyles';
import { hashSeed, HOUSE_PALETTE, indexFor, portuguesePastel } from '@/game/buildings/BuildingStyles';
import { createFadeMap, FADE_SLOTS, flushFade, installFade, paintSlot, resetFade } from './buildingFade';
import type { WallModel } from '@/game/buildings/BuildingGeometry';

const BAY = 8;
const METERS = 111319.49;

export type BuildingPart = {
  id: number;
  rings: [number, number][][];
  height: number;
  base: number;
  key: string;
  levels?: number;
  kind?: string;
  roofShape?: string;
};

type Local = { x: number; north: number; z: number };
type Bucket = { positions: number[]; normals: number[]; uvs: number[]; colors: number[]; blocks: number[] };

type Volume = {
  block: number;
  cell: string;
  footprint: { x: number; z: number }[];
  base: number;
  top: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

const CELL = 200;

function project(origin: [number, number], point: [number, number]): Local {
  const cos = Math.cos(origin[1] * Math.PI / 180);
  const x = (point[0] - origin[0]) * METERS * cos;
  const north = (point[1] - origin[1]) * METERS;
  return { x, north, z: -north };
}

function dedupe(ring: [number, number][]) {
  const points = ring.slice();
  const first = points[0];
  const last = points[points.length - 1];
  if (first && last && first[0] === last[0] && first[1] === last[1]) points.pop();
  return points;
}

function area(points: Local[]) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.north - b.x * a.north;
  }
  return sum / 2;
}

function blank(): Bucket {
  return { positions: [], normals: [], uvs: [], colors: [], blocks: [] };
}

export function cityLayer(start: [number, number], onPublish?: (parts: BuildingPart[]) => void): CustomLayerInterface & {
  sync: (parts: BuildingPart[], terrain: boolean, focus: [number, number]) => void;
  follow: (focus: [number, number], carY: number | null, budget?: number, driving?: boolean) => void;
  configure: (options: { detail: BuildingDetail; architecture: ArchitectureSetting; region: string }) => void;
  shoot: (cam: [number, number], camAlt: number, ground: [number, number], groundAlt: number, mark?: boolean) => { point: [number, number]; altitude: number } | null;
  markGround: (point: [number, number], altitude: number) => void;
  cellCount: () => number;
  pendingCount: () => number;
  isSettled: () => boolean;
} {
  const origin: [number, number] = [start[0], start[1]];
  let built: BuildingPart[] = [];
  let builtTerrain = false;
  let builtContent = '';
  let lastFocus: [number, number] = [start[0], start[1]];
  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  const bulletHoleCapacity = 512;
  const bulletHoleGeometry = new THREE.CircleGeometry(0.07, 16);
  const bulletHoleMaterial = new MeshBasicMaterial({
    color: '#120f0d',
    side: DoubleSide,
    transparent: true,
    opacity: 0.96,
    depthTest: false,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -8,
    polygonOffsetUnits: -8,
  });
  const bulletHoleMesh = new THREE.InstancedMesh(bulletHoleGeometry, bulletHoleMaterial, bulletHoleCapacity);
  bulletHoleMesh.count = 0;
  bulletHoleMesh.frustumCulled = false;
  bulletHoleMesh.renderOrder = 20;
  const bulletHoleBlocks = new THREE.InstancedBufferAttribute(new Float32Array(bulletHoleCapacity), 1);
  bulletHoleMesh.geometry.setAttribute('blockId', bulletHoleBlocks);
  scene.add(bulletHoleMesh);
  const bulletHoles: { position: [number, number]; x: number; z: number; matrix: THREE.Matrix4; block: number }[] = [];
  const bulletHoleTransform = new THREE.Object3D();
  let lastBulletCull = 0;
  let cityQuietUntil = 0;
  const fade = createFadeMap();
  installFade(bulletHoleMaterial, fade.texture, false);
  const details = new BuildingManager(scene, fade.texture);
  function bumpCityQuiet(ms = 1600) {
    cityQuietUntil = Math.max(cityQuietUntil, performance.now() + ms);
  }
  const ghostMaterials = new Map<MeshBasicMaterial | MeshLambertMaterial, MeshBasicMaterial | MeshLambertMaterial>();
  let volumes: Volume[] = [];
  let stampBlock = 0;
  type Planned = { id: string; parts: BuildingPart[]; stamp: string; x: number; z: number };
  type BuiltCell = { parts: BuildingPart[]; stamp: string; meshes: Mesh[]; ghosts: Mesh[]; volumes: Volume[]; models: BuildingModel[]; x: number; z: number; shown: boolean; keys: Set<string>; ground: number; style: string };
  const cells = new Map<string, BuiltCell>();
  const patience = new Map<string, number>();
  let planned = new Map<string, Planned>();
  let queue: { id: string; dist: number }[] = [];
  let activeBuild: { id: string; stamp: string; dist: number; iterator: Generator<null, 'wait' | 'built' | 'same'> } | null = null;
  let groupsDirty = true;
  let lastSightlineUpdate = 0;
  const sightlineTargets = new Map<number, boolean>();
  let sightlineVolumes: Volume[] = [];
  let fadedCells = new Set<string>();
  const blockOf = new Map<string, number>();
  let blockCursor = 1;
  let renderer: THREE.WebGLRenderer;
  let map: LibreMap;
  let detail: BuildingDetail = 'high';
  let architecture: ArchitectureSetting = 'auto';
  let region = '';
  const wallTextures: Texture[] = [];
  const wallMaterials: MeshBasicMaterial[] = [];
  const roofMaterials: MeshBasicMaterial[] = [];
  const litWall = new MeshBasicMaterial({ vertexColors: true, side: DoubleSide });
  const litRoof = new MeshBasicMaterial({ vertexColors: true, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  const litWindows = new MeshLambertMaterial({ vertexColors: true, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -6 });
  const paint = new Color();
  const placeMatrix = new THREE.Matrix4();
  const scaleMatrix = new THREE.Matrix4();
  const tiltMatrix = new THREE.Matrix4().makeRotationX(Math.PI / 2);
  const viewMatrix = new THREE.Matrix4();

  function twin(material: MeshBasicMaterial | MeshLambertMaterial) {
    const existing = ghostMaterials.get(material);
    if (existing) return existing;
    const ghost = material.clone();
    installFade(material, fade.texture, false);
    installFade(ghost, fade.texture, true);
    ghostMaterials.set(material, ghost);
    return ghost;
  }

  function ensureMaterials() {
    if (wallMaterials.length) return;
    for (const color of HOUSE_PALETTE) {
      const texture = facadeTexture(color);
      wallTextures.push(texture);
      const wall = new MeshBasicMaterial({ map: texture, side: DoubleSide });
      wallMaterials.push(wall);
      twin(wall);
    }
    for (const color of portuguesePastel.roofColors) {
      const roof = new MeshBasicMaterial({ color: new Color(color), side: DoubleSide });
      roofMaterials.push(roof);
      twin(roof);
    }
    twin(litWall);
    twin(litRoof);
    twin(litWindows);
  }

  function configure(next: { detail: BuildingDetail; architecture: ArchitectureSetting; region: string }) {
    const changed = next.detail !== detail || next.architecture !== architecture || next.region !== region;
    detail = next.detail;
    architecture = next.architecture;
    region = next.region;
    ensureMaterials();
    details.configure({ detail, architecture, region, colors: HOUSE_PALETTE });
    if (!changed) {
      map?.triggerRepaint();
      return;
    }
    groupsDirty = true;
    for (const cell of cells.values()) cell.stamp = '';
    map?.triggerRepaint();
  }

  function addQuad(bucket: Bucket, a: Local, b: Local, y0a: number, y0b: number, y1a: number, y1b: number, nx: number, nz: number, u0: number, u1: number, v0: number, v1: number, color: Color | null) {
    const quad = [
      [a.x, y0a, a.z, u0, v0],
      [b.x, y0b, b.z, u1, v0],
      [b.x, y1b, b.z, u1, v1],
      [a.x, y1a, a.z, u0, v1],
    ];
    for (const index of [0, 1, 2, 0, 2, 3]) {
      const vertex = quad[index];
      bucket.positions.push(vertex[0], vertex[1], vertex[2]);
      bucket.normals.push(nx, 0, nz);
      bucket.blocks.push(stampBlock);
      if (!color) bucket.uvs.push(vertex[3], vertex[4]);
      else bucket.colors.push(color.r, color.g, color.b);
    }
  }

  function outward(a: Local, b: Local, hole: boolean) {
    const dx = b.x - a.x;
    const north = b.north - a.north;
    const length = Math.hypot(dx, north) || 1;
    const sign = hole ? -1 : 1;
    return { nx: sign * north / length, nz: sign * dx / length, length: Math.hypot(b.x - a.x, b.z - a.z) };
  }

  const GLASS: Record<string, 'window' | 'windowSimple' | 'store'> = {
    glass: 'window', glassSimple: 'windowSimple', storeGlass: 'store',
  };

  function paintWindows(bucket: Bucket, a: Local, b: Local, length: number, nx: number, nz: number, y0a: number, y0b: number, yTop: number, recipe: BuildingRecipe) {
    const tx = (b.x - a.x) / length;
    const tz = (b.z - a.z) / length;
    const frame = paint.set(recipe.colors.frame).clone();
    const glass = paint.set(recipe.colors.glass).clone();
    const panes = layoutFacade(length, y0a, y0b, yTop, recipe, { lod: 1, detail: 'medium', door: false, front: false, downspout: false });
    for (const pane of panes) {
      const frameMesh = GLASS[pane.mesh];
      if (!frameMesh) continue;
      const panePiece = PIECES[pane.mesh];
      const framePiece = PIECES[frameMesh];
      const layers: [number, number, Color][] = [
        [framePiece.w * pane.sx, framePiece.h * pane.sy, frame],
        [panePiece.w * pane.sx * 0.92, panePiece.h * pane.sy * 0.92, glass],
      ];
      layers.forEach(([w, h, color], layer) => {
        const lift = 0.04 + layer * 0.025;
        const ox = a.x + tx * pane.along + nx * lift;
        const oz = a.z + tz * pane.along + nz * lift;
        const left: Local = { x: ox - tx * w / 2, north: 0, z: oz - tz * w / 2 };
        const right: Local = { x: ox + tx * w / 2, north: 0, z: oz + tz * w / 2 };
        addQuad(bucket, left, right, pane.y - h / 2, pane.y - h / 2, pane.y + h / 2, pane.y + h / 2, nx, nz, 0, 1, 0, 1, color.clone());
      });
    }
  }

  function appendTextured(bucket: Bucket, a: Local, b: Local, y0a: number, y0b: number, yTop: number, nx: number, nz: number, length: number) {
    if (length < 0.25 || yTop - Math.min(y0a, y0b) < 0.4) return;
    const yBase = Math.max(y0a, y0b);
    if (y0a < yBase - 0.03 || y0b < yBase - 0.03) addQuad(bucket, a, b, y0a, y0b, yBase, yBase, nx, nz, 0.012, 0.012, 0.02, 0.02, null);
    const bays = length >= 3.4 ? Math.max(1, Math.round(length / BAY)) : 0;
    for (const band of facadeBands(length, yBase, yBase, yTop)) {
      const windows = band.mode === 'windows' && bays > 0;
      const u1 = windows ? bays : 0.012;
      const v1 = windows ? 1 : 0.02;
      addQuad(bucket, a, b, band.y0, band.y0, band.y1, band.y1, nx, nz, windows ? 0 : 0.012, u1, windows ? 0 : 0.02, v1, null);
    }
  }

  function dropCell(id: string) {
    const cell = cells.get(id);
    if (!cell) return;
    const geometries = new Set<BufferGeometry>();
    for (const mesh of [...cell.meshes, ...cell.ghosts]) {
      geometries.add(mesh.geometry);
      scene.remove(mesh);
    }
    for (const geometry of geometries) geometry.dispose();
    if (bulletHoles.length) {
      const kept = bulletHoles.filter((hole) => !holeOnCell(cell, hole.x, hole.z));
      if (kept.length !== bulletHoles.length) {
        bulletHoles.length = 0;
        bulletHoles.push(...kept);
        updateBulletHoleInstances();
      }
    }
    cells.delete(id);
  }

  function holeOnCell(cell: BuiltCell, x: number, z: number) {
    for (const volume of cell.volumes) {
      if (x >= volume.minX - 1 && x <= volume.maxX + 1 && z >= volume.minZ - 1 && z <= volume.maxZ + 1) return true;
    }
    return Math.hypot(x - cell.x, z - cell.z) < CELL * 0.55;
  }

  function insideFootprint(x: number, z: number, footprint: { x: number; z: number }[]) {
    let inside = false;
    for (let i = 0, j = footprint.length - 1; i < footprint.length; j = i++) {
      const a = footprint[i];
      const b = footprint[j];
      if (((a.z > z) !== (b.z > z)) && (x < (b.x - a.x) * (z - a.z) / ((b.z - a.z) || 1e-9) + a.x)) inside = !inside;
    }
    return inside;
  }

  function blockAt(x: number, z: number, y: number) {
    let best = 0;
    let bestDist = Infinity;
    for (const volume of volumes) {
      if (x < volume.minX - 1.5 || x > volume.maxX + 1.5 || z < volume.minZ - 1.5 || z > volume.maxZ + 1.5) continue;
      if (y < volume.base - 1.5 || y > volume.top + 2) continue;
      if (!insideFootprint(x, z, volume.footprint) && (
        x < volume.minX || x > volume.maxX || z < volume.minZ || z > volume.maxZ
      )) continue;
      const cx = (volume.minX + volume.maxX) * 0.5;
      const cz = (volume.minZ + volume.maxZ) * 0.5;
      const dist = Math.hypot(x - cx, z - cz);
      if (dist < bestDist) {
        bestDist = dist;
        best = volume.block;
      }
    }
    return best;
  }

  function blockFor(key: string) {
    const found = blockOf.get(key);
    if (found) return found;
    const block = blockCursor < FADE_SLOTS ? blockCursor++ : 0;
    blockOf.set(key, block);
    return block;
  }

  function contentKey(parts: BuildingPart[], terrain: boolean) {
    let hash = terrain ? 17 : 3;
    hash = Math.imul(hash, 33) ^ parts.length;
    for (const part of parts) {
      for (let i = 0; i < part.key.length; i++) hash = Math.imul(hash, 33) ^ part.key.charCodeAt(i);
    }
    return String(hash);
  }

  function sync(parts: BuildingPart[], terrain: boolean, focus: [number, number]) {
    lastFocus = focus;
    const nextContent = contentKey(parts, terrain);
    // Focus-only follows must not invalidate already-built cells.
    if (nextContent === builtContent && terrain === builtTerrain && built.length) return;
    built = parts;
    builtTerrain = terrain;
    builtContent = nextContent;
    groupsDirty = true;
  }

  let isDriving = false;
  function follow(focus: [number, number], carY: number | null, budget = 1, driving = false) {
    isDriving = driving || carY != null;
    lastFocus = focus;
    const local = project(origin, focus);
    if (bulletHoles.length && performance.now() - lastBulletCull >= 500) {
      lastBulletCull = performance.now();
      const retained = bulletHoles.filter(hole => Math.hypot(hole.x - local.x, hole.z - local.z) <= 180);
      if (retained.length !== bulletHoles.length) {
        bulletHoles.length = 0;
        bulletHoles.push(...retained);
        updateBulletHoleInstances();
      }
    }
    pump(budget);
    details.setStreaming(groupsDirty || queue.length > 0 || Boolean(activeBuild));
    details.update(local.x, local.z);
    if (carY == null) clearSight();
    else reveal(local.x, local.z, carY);
  }

  function updateBulletHoleInstances() {
    bulletHoles.forEach((hole, index) => {
      bulletHoleMesh.setMatrixAt(index, hole.matrix);
      bulletHoleBlocks.setX(index, hole.block);
    });
    bulletHoleMesh.count = bulletHoles.length;
    bulletHoleMesh.instanceMatrix.needsUpdate = true;
    bulletHoleBlocks.needsUpdate = true;
  }

  function pushBulletHole(matrix: THREE.Matrix4, point: [number, number], x: number, z: number, block: number) {
    if (bulletHoles.length >= bulletHoleCapacity) bulletHoles.shift();
    bulletHoles.push({ position: point, x, z, matrix: matrix.clone(), block });
    updateBulletHoleInstances();
  }

  function shoot(cam: [number, number], camAlt: number, groundAim: [number, number], groundAlt: number, mark = true): { point: [number, number]; altitude: number } | null {
    const startPoint = project(origin, cam);
    const endPoint = project(origin, groundAim);
    const dx = endPoint.x - startPoint.x;
    const dy = groundAlt - camAlt;
    const dz = endPoint.z - startPoint.z;
    const span = Math.hypot(dx, dy, dz);
    if (span < 0.5) return null;
    let nearest: { t: number; point: [number, number]; x: number; z: number; y: number; nx: number; nz: number } | null = null;
    for (const cell of cells.values()) {
      if (!cell.shown) continue;
      for (const part of cell.parts) {
        for (let ringIndex = 0; ringIndex < part.rings.length; ringIndex++) {
          const ring = dedupe(part.rings[ringIndex]);
          const hole = ringIndex > 0;
          for (let i = 0; i < ring.length; i++) {
            const a = project(origin, ring[i]);
            const b = project(origin, ring[(i + 1) % ring.length]);
            const sx = b.x - a.x;
            const sz = b.z - a.z;
            const denominator = dx * sz - dz * sx;
            if (Math.abs(denominator) < 1e-8) continue;
            const qx = a.x - startPoint.x;
            const qz = a.z - startPoint.z;
            const t = (qx * sz - qz * sx) / denominator;
            const u = (qx * dz - qz * dx) / denominator;
            if (t <= 0.01 || t > 1.05 || u < 0 || u > 1 || (nearest && t >= nearest.t)) continue;
            const hit: [number, number] = [cam[0] + (groundAim[0] - cam[0]) * t, cam[1] + (groundAim[1] - cam[1]) * t];
            const terrain = builtTerrain ? map.queryTerrainElevation(hit) ?? 0 : 0;
            const hitY = camAlt + dy * t;
            const floor = terrain + part.base;
            const roof = terrain + Math.max(part.base + 3, part.height);
            if (hitY < floor - 0.5 || hitY > roof + 0.8) continue;
            const edgeNormal = outward(a, b, hole);
            const facesShooter = dx * edgeNormal.nx + dz * edgeNormal.nz < 0;
            const normal = facesShooter
              ? edgeNormal
              : { ...edgeNormal, nx: -edgeNormal.nx, nz: -edgeNormal.nz };
            nearest = {
              t, point: hit, x: startPoint.x + dx * t, z: startPoint.z + dz * t, y: hitY,
              nx: normal.nx, nz: normal.nz,
            };
          }
        }
      }
    }
    if (!nearest) return null;
    const y = nearest.y;
    if (mark) {
      bulletHoleTransform.position.set(nearest.x + nearest.nx * 0.12, y, nearest.z + nearest.nz * 0.12);
      bulletHoleTransform.rotation.set(0, Math.atan2(nearest.nx, nearest.nz), 0);
      bulletHoleTransform.scale.setScalar(1);
      bulletHoleTransform.updateMatrix();
      pushBulletHole(
        bulletHoleTransform.matrix,
        nearest.point,
        nearest.x,
        nearest.z,
        blockAt(nearest.x + nearest.nx * 0.12, nearest.z + nearest.nz * 0.12, y),
      );
      map.triggerRepaint();
    }
    return { point: nearest.point, altitude: y };
  }

  function markGround(point: [number, number], altitude: number) {
    const local = project(origin, point);
    bulletHoleTransform.position.set(local.x, altitude + 0.04, local.z);
    bulletHoleTransform.rotation.set(-Math.PI / 2, 0, Math.random() * Math.PI * 2);
    bulletHoleTransform.scale.setScalar(0.9 + Math.random() * 0.25);
    bulletHoleTransform.updateMatrix();
    pushBulletHole(bulletHoleTransform.matrix, point, local.x, local.z, 0);
    map?.triggerRepaint();
  }

  function clearSight() {
    if (!fade.activeSlots) return;
    resetFade(fade);
    for (const id of fadedCells) {
      const cell = cells.get(id);
      if (cell) for (const mesh of cell.ghosts) mesh.visible = false;
    }
    fadedCells.clear();
    sightlineVolumes = [];
    details.setGhostPass(false);
  }

  function reveal(carX: number, carZ: number, carY: number) {
    if (!map || !volumes.length) return;
    const now = performance.now();
    if (now - lastSightlineUpdate >= 50) {
      const center = map.getCenter();
      const pitch = map.getPitch() * Math.PI / 180;
      const bearing = map.getBearing() * Math.PI / 180;
      const height = map.getCanvas().clientHeight || 1;
      const mercPerMeter = 1 / (2 * Math.PI * 6378137 * Math.cos(center.lat * Math.PI / 180));
      const pixelsPerMeter = mercPerMeter * 512 * 2 ** map.getZoom();
      const distance = (0.5 / Math.tan(0.6435011087932844 / 2) * height) / pixelsPerMeter;
      const horiz = Math.sin(pitch);
      const east = -Math.sin(bearing) * horiz * distance;
      const north = -Math.cos(bearing) * horiz * distance;
      const cos = Math.cos(center.lat * Math.PI / 180);
      const cam = project(origin, [center.lng + east / (METERS * cos), center.lat + north / METERS]);
      const ground = map.queryTerrainElevation(center) ?? Math.max(0, carY - 1.2);
      const camY = ground + Math.cos(pitch) * distance;
      const minX = Math.min(cam.x, carX) - 6;
      const maxX = Math.max(cam.x, carX) + 6;
      const minZ = Math.min(cam.z, carZ) - 6;
      const maxZ = Math.max(cam.z, carZ) + 6;
      sightlineTargets.clear();
      sightlineVolumes = [];
      for (const volume of volumes) {
        const hidden = !cells.get(volume.cell)?.shown;
        const outside = volume.maxX < minX || volume.minX > maxX || volume.maxZ < minZ || volume.minZ > maxZ;
        if (hidden || outside) {
          if ((fade.current[volume.block] ?? 1) < 0.99) {
            sightlineVolumes.push(volume);
            sightlineTargets.set(volume.block, false);
          }
          continue;
        }
        sightlineVolumes.push(volume);
        const loose = (fade.current[volume.block] ?? 1) < 0.9;
        sightlineTargets.set(volume.block, buildingBlocksView(volume, cam.x, camY, cam.z, carX, carY, carZ, loose ? 3 : 1.7));
      }
      lastSightlineUpdate = now;
    }
    const nextFadedCells = new Set<string>();
    for (const volume of sightlineVolumes) {
      if (paintSlot(fade, volume.block, sightlineTargets.get(volume.block) ?? false)) nextFadedCells.add(volume.cell);
    }
    flushFade(fade);
    for (const id of fadedCells) {
      if (nextFadedCells.has(id)) continue;
      const cell = cells.get(id);
      if (cell) for (const mesh of cell.ghosts) mesh.visible = false;
    }
    for (const id of nextFadedCells) {
      if (fadedCells.has(id)) continue;
      const cell = cells.get(id);
      if (cell) for (const mesh of cell.ghosts) mesh.visible = true;
    }
    fadedCells = nextFadedCells;
    details.setGhostPass(fadedCells.size > 0);
  }

  function sampleCell(group: { x: number; z: number }) {
    if (!builtTerrain || !map) return 0;
    const cos = Math.cos(origin[1] * Math.PI / 180);
    const exact = map.queryTerrainElevation([origin[0] + group.x / (METERS * cos), origin[1] + (-group.z) / METERS]);
    if (exact != null) return exact;
    return map.getCenterElevation();
  }

  function cellContentStamp(parts: BuildingPart[]) {
    let hash = (builtTerrain ? 17 : 3) ^ (detail === 'off' ? 1 : 2) ^ Math.round(origin[0] * 1e4) ^ Math.round(origin[1] * 1e4);
    for (let i = 0; i < architecture.length; i++) hash = Math.imul(hash, 33) ^ architecture.charCodeAt(i);
    const paletteColors = [...portuguesePastel.wallColors, ...portuguesePastel.roofColors, ...portuguesePastel.windowColors, portuguesePastel.frameColor];
    for (const color of paletteColors) for (let i = 0; i < color.length; i++) hash = Math.imul(hash, 33) ^ color.charCodeAt(i);
    const keys = parts.map((part) => part.key).sort();
    for (const key of keys) for (let i = 0; i < key.length; i++) hash = Math.imul(hash, 33) ^ key.charCodeAt(i);
    return String(hash);
  }

  function cellStamp(parts: BuildingPart[], sample: number) {
    const ground = sample <= -900 ? -999 : Math.round(sample / 4) * 4;
    return `${ground}|${cellContentStamp(parts)}`;
  }

  function publish() {
    const models: BuildingModel[] = [];
    volumes = [];
    for (const cell of cells.values()) {
      models.push(...cell.models);
      volumes.push(...cell.volumes);
    }
    sightlineTargets.clear();
    sightlineVolumes = [];
    lastSightlineUpdate = 0;
    onPublish?.([...cells.values()].flatMap(cell => cell.parts));
    details.setModels(models, `${origin[0].toFixed(5)},${origin[1].toFixed(5)}`);
  }

  function planCells() {
    groupsDirty = false;
    // A temporarily empty tile query is not a command to erase the city.
    if (!built.length) return;
    const next = new Map<string, Planned>();
    for (const part of built) {
      const ring = dedupe(part.rings[0] ?? []);
      if (ring.length < 3) continue;
      let sx = 0;
      let sz = 0;
      for (const point of ring) {
        const local = project(origin, point);
        sx += local.x;
        sz += local.z;
      }
      const gx = Math.floor(sx / ring.length / CELL);
      const gz = Math.floor(sz / ring.length / CELL);
      const id = `${gx}:${gz}`;
      let group = next.get(id);
      if (!group) {
        group = { id, parts: [], stamp: '', x: (gx + 0.5) * CELL, z: (gz + 0.5) * CELL };
        next.set(id, group);
      }
      group.parts.push(part);
    }
    for (const group of next.values()) group.stamp = cellStamp(group.parts, sampleCell(group) ?? -999);
    let dropped = false;
    const currentFocus = project(origin, lastFocus);
    for (const [id, cell] of cells) if (!next.has(id) && cellDistance(cell.x, cell.z, currentFocus.x, currentFocus.z, CELL) > (isDriving ? 1050 : 2200)) { dropCell(id); dropped = true; }
    planned = next;
    const focus = project(origin, lastFocus);
    queue = [];
    activeBuild = null;
    for (const group of planned.values()) {
      const existing = cells.get(group.id);
      if (existing?.stamp === group.stamp) continue;
      const sample = sampleCell(group) ?? -999;
      const groundQuant = sample <= -900 ? -999 : Math.round(sample / 4) * 4;
      // Same buildings + tiny DEM jitter: keep the drawn cell, only refresh the stamp.
      if (
        existing
        && existing.keys.size === group.parts.length
        && group.parts.every((part) => existing.keys.has(part.key))
        && Math.abs(existing.ground - groundQuant) < 8
        && existing.style === `${detail}|${architecture}|${builtTerrain ? 1 : 0}|${portuguesePastel.wallColors.join(',')}|${portuguesePastel.roofColors.join(',')}|${portuguesePastel.windowColors.join(',')}|${portuguesePastel.frameColor}`
      ) {
        existing.stamp = group.stamp;
        existing.ground = groundQuant;
        continue;
      }
      const dx = group.x - focus.x;
      const dz = group.z - focus.z;
      queue.push({ id: group.id, dist: dx * dx + dz * dz });
    }
    queue.sort((a, b) => a.dist - b.dist);
    if (dropped && !queue.length) publish();
  }

  function pump(budget: number) {
    if (groupsDirty) {
      planCells();
      activeBuild = null;
    }
    let left = budget;
    const deadline = performance.now() + 3;
    let builtOne = false;
    const waiting: { id: string; dist: number }[] = [];
    while ((left > 0 || activeBuild) && performance.now() < deadline) {
      if (activeBuild) {
        const group = planned.get(activeBuild.id);
        if (!group || group.stamp !== activeBuild.stamp) {
          activeBuild = null;
          continue;
        }
        const result = activeBuild.iterator.next();
        if (result.done) {
          const job = { id: activeBuild.id, dist: activeBuild.dist };
          activeBuild = null;
          if (result.value === 'wait') waiting.push(job);
          else if (result.value === 'built') {
            builtOne = true;
            left--;
          }
        }
        continue;
      }
      if (left <= 0 || !queue.length) break;
      const job = queue.shift();
      const group = job ? planned.get(job.id) : undefined;
      if (!job || !group || cells.get(group.id)?.stamp === group.stamp) continue;
      activeBuild = { id: group.id, stamp: group.stamp, dist: job.dist, iterator: buildCell(group) };
    }
    if (waiting.length) queue = queue.concat(waiting);
    if (builtOne) publish();
  }

  function nearbyParts(group: Planned) {
    const gx = Math.floor(group.x / CELL);
    const gz = Math.floor(group.z / CELL);
    const own = new Set(group.parts.map((part) => part.key));
    const extra: BuildingPart[] = [];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue;
      const neighbor = planned.get(`${gx + dx}:${gz + dz}`);
      if (!neighbor) continue;
      for (const part of neighbor.parts) if (!own.has(part.key)) extra.push(part);
    }
    return extra;
  }

  function* buildCell(group: Planned): Generator<null, 'wait' | 'built' | 'same'> {
    if (builtTerrain && !map.isSourceLoaded('elevation')) return 'wait';
    const sample = sampleCell(group);
    const existing = cells.get(group.id);
    const groundQuant = Math.round(sample / 4) * 4;
    const styleNow = `${detail}|${architecture}|${builtTerrain ? 1 : 0}|${portuguesePastel.wallColors.join(',')}|${portuguesePastel.roofColors.join(',')}|${portuguesePastel.windowColors.join(',')}|${portuguesePastel.frameColor}`;
    const incoming = new Set(group.parts.map((part) => part.key));
    const emitParts = existing ? group.parts.filter((part) => !existing.keys.has(part.key)) : group.parts;
    const missing = existing ? [...existing.keys].some((key) => !incoming.has(key)) : false;
    const sameStyle = existing?.style === styleNow;
    const focus = project(origin, lastFocus);
    const shift = existing ? Math.abs(existing.ground - groundQuant) : 0;
    const changed = emitParts.length > 0 || missing;
    if (existing && sameStyle && !emitParts.length && !missing) {
      const shiftNow = Math.abs(existing.ground - groundQuant);
      if (shiftNow < 8) {
        existing.stamp = group.stamp;
        return 'same';
      }
    }
    if (!changed && deferCellReplacement(cellDistance(group.x, group.z, focus.x, focus.z, CELL), Boolean(sameStyle), Boolean(existing), shift)) return 'same';
    // Intro splash: never rebuild an already-shown cell — shared-wall churn recolors roofs/walls in waves.
    if (existing && !isDriving) {
      existing.stamp = group.stamp;
      patience.delete(group.id);
      return 'same';
    }
    // Shared-wall ownership changes when neighbours arrive. Rebuild the whole
    // cell and swap it atomically; appending leaves obsolete walls/windows alive.
    const parts = group.parts;
    const terrain = builtTerrain;
    ensureMaterials();
    const detailOn = detail !== 'off';
    const wallBuckets = detailOn ? [blank()] : HOUSE_PALETTE.map(() => blank());
    const roofBuckets = detailOn ? [blank()] : portuguesePastel.roofColors.map(() => blank());
    const cache = new Map<string, number>();
    const cos = Math.cos(origin[1] * Math.PI / 180);
    const fallback = terrain && map ? map.queryTerrainElevation([origin[0] + group.x / (METERS * cos), origin[1] + (-group.z) / METERS]) ?? 0 : 0;
    const groundAt = (lng: number, lat: number) => {
      if (!terrain || !map) return 0;
      const key = `${lng.toFixed(4)},${lat.toFixed(4)}`;
      const cached = cache.get(key);
      if (cached != null) return cached;
      const height = map.queryTerrainElevation([lng, lat]) ?? fallback;
      cache.set(key, height);
      return height;
    };
    const models: BuildingModel[] = [];
    const windowBuckets = detailOn ? [blank()] : [];
    const faces: {
      a: Local; b: Local; ax: number; az: number; bx: number; bz: number;
      y0a: number; y0b: number; y1: number; nx: number; nz: number; length: number; hole: boolean;
      recipe: BuildingRecipe | null; wallColor: Color | null; roofColor: Color | null;
      wallTarget: Bucket; roofTarget: Bucket; windowTarget: Bucket | null; walls: WallModel[];
      block: number; emit: boolean; owner: string;
    }[] = [];
    const sink = blank();
    const own = new Set(parts.map((part) => part.key));

    let work = 0;
    for (const part of group.parts.concat(nearbyParts(group))) {
      if (++work % 8 === 0) yield null;
      const emit = own.has(part.key);
      const seed = hashSeed(part.key);
      const slot = indexFor(HOUSE_PALETTE.length, seed);
      const roofSlot = indexFor(portuguesePastel.roofColors.length, seed ^ 0x51f0c3);
      const recipe = emit && detailOn ? details.recipeFor(part) : null;
      const wallColor = recipe ? paint.set(recipe.colors.wall).clone() : null;
      const roofColor = recipe ? paint.set(recipe.colors.roof).clone() : null;
      const prepared = part.rings.map((ring) => {
        const geo = dedupe(ring);
        return { geo, local: geo.map((point) => project(origin, point)) };
      }).filter((ring) => ring.local.length >= 3);
      if (!prepared.length) continue;
      if (area(prepared[0].local) < 0) { prepared[0].local.reverse(); prepared[0].geo.reverse(); }
      for (let hole = 1; hole < prepared.length; hole++) if (area(prepared[hole].local) > 0) { prepared[hole].local.reverse(); prepared[hole].geo.reverse(); }
      const floors = Math.max(part.base + 3, part.height) - part.base;
      const footprintHeights = prepared.flatMap((ring) => ring.geo.map(([lng, lat]) => groundAt(lng, lat)));
      const crest = (footprintHeights.length ? Math.max(...footprintHeights) : 0) + part.base + floors;
      const walls: WallModel[] = [];
      const block = emit ? blockFor(part.key) : 0;
      stampBlock = block;
      const wallTarget = !emit ? sink : detailOn ? wallBuckets[0] : wallBuckets[slot];
      const roofTarget = !emit ? sink : detailOn ? roofBuckets[0] : roofBuckets[roofSlot];
      for (let index = 0; index < prepared.length; index++) {
        const ring = prepared[index];
        const hole = index > 0;
        const grounds = ring.geo.map(([lng, lat]) => groundAt(lng, lat) + part.base);
        for (let i = 0; i < ring.local.length; i++) {
          if (++work % 128 === 0) yield null;
          const next = (i + 1) % ring.local.length;
          const normal = outward(ring.local[i], ring.local[next], hole);
          if (normal.length < 0.2) continue;
          const a = ring.local[i];
          const b = ring.local[next];
          faces.push({
            a, b, ax: a.x, az: a.z, bx: b.x, bz: b.z, y0a: grounds[i], y0b: grounds[next], y1: crest,
            nx: normal.nx, nz: normal.nz, length: normal.length, hole, recipe, wallColor, roofColor,
            wallTarget, roofTarget, windowTarget: emit && detailOn ? windowBuckets[0] : null, walls, block, emit, owner: part.key,
          });
        }
      }
      if (!emit) continue;
      const contour = prepared[0].local.map((point) => new THREE.Vector2(point.x, point.north));
      const holes = prepared.slice(1).map((ring) => ring.local.map((point) => new THREE.Vector2(point.x, point.north)));
      let roofFaces: number[][] = [];
      try { roofFaces = THREE.ShapeUtils.triangulateShape(contour, holes); } catch { roofFaces = []; }
      const flat = contour.concat(...holes);
      for (const face of roofFaces) {
        if (++work % 128 === 0) yield null;
        for (const index of [face[0], face[2], face[1]]) {
          const point = flat[index];
          if (!point) continue;
          roofTarget.positions.push(point.x, crest + ROOF_LIP, -point.y);
          roofTarget.normals.push(0, 1, 0);
          roofTarget.blocks.push(stampBlock);
          if (roofColor) roofTarget.colors.push(roofColor.r, roofColor.g, roofColor.b);
        }
      }
      const footprint = prepared[0].local.map((point) => ({ x: point.x, z: point.z }));
      models.push({
        id: part.id, key: part.key, height: part.height, base: part.base, levels: part.levels, kind: part.kind, roofShape: part.roofShape,
        walls, footprint, crest, rectangular: footprintCanPitch(footprint), block,
      });
    }

    for (const face of resolveWalls(faces)) {
      if (++work % 64 === 0) yield null;
      if (!face.emit) continue;
      stampBlock = face.block;
      const lip = 0.08;
      const aLip: Local = { x: face.a.x + face.nx * lip, north: 0, z: face.a.z + face.nz * lip };
      const bLip: Local = { x: face.b.x + face.nx * lip, north: 0, z: face.b.z + face.nz * lip };
      if (detailOn && face.wallColor) {
        addQuad(face.wallTarget, face.a, face.b, face.y0a, face.y0b, face.y1, face.y1, face.nx, face.nz, 0, 1, 0, 1, face.wallColor);
        if (face.recipe && face.windowTarget) paintWindows(face.windowTarget, face.a, face.b, face.length, face.nx, face.nz, face.y0a, face.y0b, face.y1, face.recipe);
      } else appendTextured(face.wallTarget, face.a, face.b, face.y0a, face.y0b, face.y1, face.nx, face.nz, face.length);
      addQuad(face.roofTarget, aLip, bLip, face.y1, face.y1, face.y1 + ROOF_LIP, face.y1 + ROOF_LIP, face.nx, face.nz, 0, 1, 0, 1, detailOn ? face.roofColor : null);
      const tx = (face.b.x - face.a.x) / face.length;
      const tz = (face.b.z - face.a.z) / face.length;
      face.walls.push({
        ax: face.a.x, az: face.a.z, tx, tz, nx: face.nx, nz: face.nz, length: face.length,
        y0a: face.y0a, y0b: face.y0b, yTop: face.y1, hole: face.hole,
      });
    }

    const meshes: Mesh[] = [];
    const ghosts: Mesh[] = [];
    wallBuckets.forEach((bucket, index) => addMesh(bucket, detailOn ? litWall : wallMaterials[index], meshes, ghosts, !detailOn));
    roofBuckets.forEach((bucket, index) => addMesh(bucket, detailOn ? litRoof : roofMaterials[index], meshes, ghosts, false));
    windowBuckets.forEach((bucket) => addMesh(bucket, litWindows, meshes, ghosts, false));
    const builtVolumes = models.map((model) => {
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      let base = Infinity;
      for (const point of model.footprint) {
        minX = Math.min(minX, point.x);
        maxX = Math.max(maxX, point.x);
        minZ = Math.min(minZ, point.z);
        maxZ = Math.max(maxZ, point.z);
      }
      for (const wall of model.walls) base = Math.min(base, wall.y0a, wall.y0b);
      return { block: model.block, cell: group.id, footprint: model.footprint, base: Number.isFinite(base) ? base : 0, top: model.crest + 4.6, minX, maxX, minZ, maxZ };
    });
    patience.delete(group.id);
    dropCell(group.id);
    cells.set(group.id, { parts: group.parts, stamp: group.stamp, meshes, ghosts, volumes: builtVolumes, models, x: group.x, z: group.z, shown: true, keys: new Set(group.parts.map((part) => part.key)), ground: groundQuant, style: styleNow });
    bumpCityQuiet();
    map?.triggerRepaint();
    return 'built';
  }

  function addMesh(bucket: Bucket, material: MeshBasicMaterial | MeshLambertMaterial, list: Mesh[], ghosts: Mesh[], textured: boolean) {
    if (!bucket.positions.length) return;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(bucket.positions), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(bucket.normals), 3));
    if (textured) geometry.setAttribute('uv', new BufferAttribute(new Float32Array(bucket.uvs), 2));
    if (bucket.colors.length) geometry.setAttribute('color', new BufferAttribute(new Float32Array(bucket.colors), 3));
    geometry.setAttribute('blockId', new BufferAttribute(new Float32Array(bucket.blocks), 1));
    const mesh = new Mesh(geometry, material);
    // MapLibre supplies a combined map/terrain projection, not a conventional
    // Three camera. Keep CPU culling disabled, as in the car and vegetation
    // layers; the GPU still clips triangles against the actual projection.
    mesh.frustumCulled = false;
    scene.add(mesh);
    list.push(mesh);
    const ghostMaterial = ghostMaterials.get(material);
    if (ghostMaterial) {
      const ghost = new Mesh(geometry, ghostMaterial);
      ghost.frustumCulled = false;
      ghost.renderOrder = 3;
      ghost.visible = false;
      scene.add(ghost);
      ghosts.push(ghost);
    }
  }

  return {
    id: 'city-buildings-comic',
    type: 'custom',
    renderingMode: '3d',
    sync,
    follow,
    configure,
    shoot,
    markGround,
    cellCount: () => cells.size,
    pendingCount: () => queue.length + (groupsDirty ? 1 : 0) + (activeBuild ? 1 : 0),
    isSettled: () => (
      !groupsDirty
      && queue.length === 0
      && !activeBuild
      && performance.now() >= cityQuietUntil
      && details.isSettled()
    ),
    onAdd(nextMap, gl) {
      map = nextMap;
      ensureMaterials();
      renderer = new THREE.WebGLRenderer({ canvas: nextMap.getCanvas(), context: gl as WebGL2RenderingContext, antialias: true });
      renderer.autoClear = false;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.outputColorSpace = SRGBColorSpace;
      for (const texture of wallTextures) {
        texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
        texture.wrapS = RepeatWrapping;
        texture.wrapT = RepeatWrapping;
        texture.magFilter = LinearFilter;
        texture.minFilter = LinearMipmapLinearFilter;
      }
    },
    render(_gl, args) {
      const place = MercatorCoordinate.fromLngLat(origin, 0);
      const scale = place.meterInMercatorCoordinateUnits();
      placeMatrix.makeTranslation(place.x, place.y, place.z);
      scaleMatrix.makeScale(scale, -scale, scale);
      camera.projectionMatrix.fromArray(args.defaultProjectionData.mainMatrix).multiply(viewMatrix.copy(placeMatrix).multiply(scaleMatrix).multiply(tiltMatrix));
      renderer.resetState();
      renderer.render(scene, camera);
      renderer.resetState();
    },
    onRemove() {
      for (const id of [...cells.keys()]) dropCell(id);
      details.dispose();
      bulletHoleGeometry.dispose();
      bulletHoleMaterial.dispose();
      for (const material of [...wallMaterials, ...roofMaterials, litWall, litRoof, litWindows]) material.dispose();
      for (const material of ghostMaterials.values()) material.dispose();
      for (const texture of wallTextures) texture.dispose();
      renderer?.dispose();
    },
  };
}
