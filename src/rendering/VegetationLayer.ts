import * as THREE from 'three';
import { MercatorCoordinate, type CustomLayerInterface, type Map as LibreMap } from 'maplibre-gl';
import { limitVegetation, PLANT_CAP, planParkFences, planVegetation, type FenceEdge, type Plant, type VegetationInput } from '@/game/Vegetation';
import type { Position } from '@/game/VehicleController';

const LIMIT = PLANT_CAP;
const FENCE_POST_H = 1.28;
const POST_CAP = 14000;
const RAIL_CAP = 26000;
type VegetationBatch = {
  leaves: THREE.InstancedMesh[];
  trunks: THREE.InstancedMesh;
  leafMaterial: THREE.MeshLambertMaterial;
  barkMaterial: THREE.MeshLambertMaterial;
};

export function vegetationLayer(origin: Position): CustomLayerInterface & { sync(input: Omit<VegetationInput, 'origin'>, terrain: boolean): void } {
  const scene = new THREE.Scene(), camera = new THREE.Camera();
  const foliage = [
    new THREE.IcosahedronGeometry(1, 1),
    new THREE.SphereGeometry(1, 8, 6),
    new THREE.ConeGeometry(1, 2, 7),
  ];
  const trunk = new THREE.CylinderGeometry(0.13, 0.23, 1, 6);
  const postGeometry = new THREE.BoxGeometry(0.09, 1, 0.09);
  const railGeometry = new THREE.BoxGeometry(1, 0.06, 0.05);

  scene.add(new THREE.HemisphereLight(0xf4faff, 0x8faac4, 1.15));
  const sun = new THREE.DirectionalLight(0xfffaf0, 0.65);
  sun.position.set(28, 72, 16);
  scene.add(sun);

  function batch(): VegetationBatch {
    const leafMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const barkMaterial = new THREE.MeshLambertMaterial({ color: 0x88654b });
    const leaves = foliage.map(geometry => new THREE.InstancedMesh(geometry, leafMaterial, LIMIT * 3));
    const trunks = new THREE.InstancedMesh(trunk, barkMaterial, LIMIT);
    for (const mesh of leaves) mesh.count = 0;
    trunks.count = 0;
    for (const mesh of leaves) mesh.frustumCulled = false;
    trunks.frustumCulled = false;
    return { leaves, trunks, leafMaterial, barkMaterial };
  }
  let shown = batch(), staging = batch();
  scene.add(...shown.leaves, shown.trunks);

  const fencePostMaterial = new THREE.MeshLambertMaterial({ color: '#4a4036' });
  const fenceRailMaterial = new THREE.MeshLambertMaterial({ color: '#5c5145' });
  const fencePosts = new THREE.InstancedMesh(postGeometry, fencePostMaterial, POST_CAP);
  const fenceRails = new THREE.InstancedMesh(railGeometry, fenceRailMaterial, RAIL_CAP);
  fencePosts.count = 0;
  fenceRails.count = 0;
  fencePosts.frustumCulled = false;
  fenceRails.frustumCulled = false;
  fencePosts.renderOrder = 4;
  fenceRails.renderOrder = 4;
  scene.add(fencePosts, fenceRails);

  let map: LibreMap, renderer: THREE.WebGLRenderer;
  let pending: { input: VegetationInput; terrain: boolean } | null = null;
  let work: Generator<null, void> | null = null;
  const object = new THREE.Object3D(), color = new THREE.Color();
  const greens = ['#619447', '#7da653', '#53875a', '#8eaf64', '#689f76', '#3d6b3a', '#4e7d42', '#2f5c34'];
  const place = MercatorCoordinate.fromLngLat(origin, 0), meters = place.meterInMercatorCoordinateUnits();
  const matrix = new THREE.Matrix4().makeTranslation(place.x, place.y, place.z)
    .scale(new THREE.Vector3(meters, -meters, meters)).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  const ground = new Map<string, number>();
  const retainedPlants = new Map<string, Plant>();
  const fenceGround = new Map<string, number>();

  function sampleElevation(lngLat: Position, terrain: boolean) {
    if (!terrain || !map) return 0;
    return map.queryTerrainElevation(lngLat) ?? 0;
  }

  function lngLatOf(x: number, z: number): Position {
    const cos = Math.cos(origin[1] * Math.PI / 180);
    return [origin[0] + x / (111319.49 * cos), origin[1] + (-z) / 111319.49];
  }

  function elevationAt(x: number, z: number, terrain: boolean) {
    const key = `${x.toFixed(1)},${z.toFixed(1)}`;
    let height = fenceGround.get(key);
    if (height == null) {
      height = sampleElevation(lngLatOf(x, z), terrain);
      fenceGround.set(key, height);
    }
    return height;
  }

  function placeFence(edges: FenceEdge[], terrain: boolean) {
    fencePosts.count = 0;
    fenceRails.count = 0;
    const postStep = 2.15;
    edgeLoop: for (const edge of edges) {
      if (fencePosts.count >= POST_CAP) break;
      const dx = edge.bx - edge.ax;
      const dz = edge.bz - edge.az;
      const length = Math.hypot(dx, dz);
      if (length < 0.5) continue;
      const yaw = Math.atan2(dx, dz) - Math.PI / 2;
      const count = Math.max(1, Math.ceil(length / postStep));
      let prevX = edge.ax;
      let prevZ = edge.az;
      let prevY = elevationAt(edge.ax, edge.az, terrain);
      for (let i = 0; i <= count; i++) {
        if (fencePosts.count >= POST_CAP) break edgeLoop;
        const t = i / count;
        const x = edge.ax + dx * t;
        const z = edge.az + dz * t;
        const y = elevationAt(x, z, terrain);
        object.position.set(x, y + FENCE_POST_H * 0.5, z);
        object.rotation.set(0, yaw, 0);
        object.scale.set(1, FENCE_POST_H, 1);
        object.updateMatrix();
        fencePosts.setMatrixAt(fencePosts.count++, object.matrix);
        if (i > 0) {
          const mx = (prevX + x) * 0.5;
          const mz = (prevZ + z) * 0.5;
          const my = (prevY + y) * 0.5;
          const railLen = Math.hypot(x - prevX, z - prevZ);
          if (railLen > 0.2 && fenceRails.count + 2 <= RAIL_CAP) {
            for (const lift of [0.38, 0.82]) {
              object.position.set(mx, my + lift, mz);
              object.rotation.set(0, yaw, 0);
              object.scale.set(railLen, 1, 1);
              object.updateMatrix();
              fenceRails.setMatrixAt(fenceRails.count++, object.matrix);
            }
          }
        }
        prevX = x;
        prevZ = z;
        prevY = y;
      }
    }
    fencePosts.instanceMatrix.needsUpdate = true;
    fenceRails.instanceMatrix.needsUpdate = true;
  }

  function* rebuild(job: NonNullable<typeof pending>): Generator<null, void> {
    const planned = yield* planVegetation(job.input);
    for (const plant of planned) {
      if (!retainedPlants.has(plant.key)) retainedPlants.set(plant.key, plant);
    }
    const focus = job.input.focus;
    const cos = Math.cos(origin[1] * Math.PI / 180);
    const east = (focus[0] - origin[0]) * 111319.49 * cos;
    const north = (focus[1] - origin[1]) * 111319.49;
    const activePlants: Plant[] = [];
    for (const [key, plant] of retainedPlants) {
      if (Math.hypot(plant.x - east, -plant.z - north) > 820) {
        retainedPlants.delete(key);
        ground.delete(key);
      } else activePlants.push(plant);
    }
    const plants = limitVegetation(activePlants, east, north, job.input.plantCap ?? PLANT_CAP);
    for (const mesh of staging.leaves) mesh.count = 0;
    staging.trunks.count = 0;
    let placed = 0;
    for (const plant of plants) {
      if (++placed % 64 === 0) yield null;
      let elevation = ground.get(plant.key);
      if (elevation == null) {
        const sampled = job.terrain ? map.queryTerrainElevation(plant.position) : 0;
        if (sampled == null) continue;
        elevation = sampled;
        ground.set(plant.key, elevation);
      }
      const s = 0.8 + plant.seed * 0.45;
      const tall = plant.seed > 0.7;
      const height = plant.bush ? 1.5 * s : (tall ? 7.2 : 5.6) * s;
      const radius = plant.bush ? 1.6 * s : (plant.variant === 1 ? 2.7 : 2.2) * s;
      object.rotation.set(0, plant.seed * Math.PI * 2, 0);
      if (!plant.bush) {
        object.position.set(plant.x, elevation + height * 0.3, plant.z);
        object.scale.set(s, height * 0.6, s);
        object.updateMatrix();
        staging.trunks.setMatrixAt(staging.trunks.count++, object.matrix);
      }
      const lobes = plant.bush ? 1 : plant.variant === 1 ? 2 : plant.variant === 2 ? 3 : 1;
      for (let lobe = 0; lobe < lobes; lobe++) {
        const angle = plant.seed * 6.28 + lobe * 2.5;
        const spread = lobe === 0 ? 0 : radius * 0.38;
        object.position.set(plant.x + Math.cos(angle) * spread, elevation + height * (plant.bush ? 0.75 : 0.7) + (lobe === 0 ? radius * 0.25 : 0), plant.z + Math.sin(angle) * spread);
        object.scale.set(radius * (lobe === 0 ? 1 : 0.82), plant.variant === 2 && !plant.bush ? height * 0.34 : radius * (tall && !plant.bush ? 1.4 : 0.92), radius * (lobe === 0 ? 0.95 : 0.82));
        object.updateMatrix();
        const species = plant.bush ? 0 : plant.variant;
        const leaves = staging.leaves[species];
        const index = leaves.count++;
        leaves.setMatrixAt(index, object.matrix);
        color.set(greens[Math.floor(plant.seed * greens.length)]).multiplyScalar(lobe === 0 ? 1.06 : 0.96);
        leaves.setColorAt(index, color);
      }
    }
    for (const mesh of staging.leaves) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    staging.trunks.instanceMatrix.needsUpdate = true;
    const old = shown;
    [shown, staging] = [staging, old];
    scene.remove(...old.leaves, old.trunks);
    shown.leafMaterial.opacity = 1;
    shown.barkMaterial.opacity = 1;
    scene.add(...shown.leaves, shown.trunks);

    const fenceEdges = yield* planParkFences(job.input);
    if (fenceGround.size > 12000) fenceGround.clear();
    placeFence(fenceEdges, job.terrain);
  }

  return {
    id: 'park-vegetation',
    type: 'custom',
    renderingMode: '3d',
    sync(input, terrain) {
      pending = { input: { ...input, origin }, terrain };
      map?.triggerRepaint();
    },
    onAdd(nextMap, gl) {
      map = nextMap;
      renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl as WebGL2RenderingContext });
      renderer.autoClear = false;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
    },
    render(_gl, args) {
      if (!work && pending) { work = rebuild(pending); pending = null; }
      const deadline = performance.now() + 2.4;
      while (work && performance.now() < deadline) { if (work.next().done) work = null; }
      if (work || pending) map.triggerRepaint();
      camera.projectionMatrix.fromArray(args.defaultProjectionData.mainMatrix).multiply(matrix);
      renderer.resetState();
      renderer.render(scene, camera);
      renderer.resetState();
    },
    onRemove() {
      pending = null;
      work = null;
      for (const group of [shown, staging]) {
        for (const mesh of group.leaves) mesh.dispose();
        group.trunks.dispose();
        group.leafMaterial.dispose();
        group.barkMaterial.dispose();
      }
      fencePosts.dispose();
      fenceRails.dispose();
      fencePostMaterial.dispose();
      fenceRailMaterial.dispose();
      postGeometry.dispose();
      railGeometry.dispose();
      for (const geometry of foliage) geometry.dispose();
      trunk.dispose();
      renderer?.dispose();
    },
  };
}
