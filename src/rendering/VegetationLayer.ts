import * as THREE from 'three';
import { MercatorCoordinate, type CustomLayerInterface, type Map as LibreMap } from 'maplibre-gl';
import { limitVegetation, PLANT_CAP, planVegetation, type Plant, type VegetationInput } from '@/game/Vegetation';
import type { Position } from '@/game/VehicleController';

const LIMIT = PLANT_CAP;
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
    const plants = limitVegetation(activePlants, east, north);
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
      for (const geometry of foliage) geometry.dispose();
      trunk.dispose();
      renderer?.dispose();
    },
  };
}
