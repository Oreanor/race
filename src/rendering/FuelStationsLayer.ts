import * as THREE from 'three';
import type { CustomLayerInterface, Map as LibreMap } from 'maplibre-gl';
import type { Station } from '@/game/Fuel';
import { mercatorPerMeter, mercatorX01, mercatorY01 } from '@/world3d/map/camera';
import { simpleLit, standaloneUniforms, type SimpleLitUniforms } from '@/world3d/map/simpleLit';

// Abstract fuel stations at real OSM locations: a canopy on posts, two pumps and
// a tall sign. Every part is one InstancedMesh, so any number of stations costs
// a fixed handful of draw calls. Works on both renderers (custom layer API).

type Part = { geometry: THREE.BufferGeometry; color: string; at: [number, number, number] };

const PARTS: Part[] = [
  { geometry: new THREE.BoxGeometry(11, 0.6, 7.5), color: '#f4f1e8', at: [0, 4.6, 0] }, // canopy
  { geometry: new THREE.BoxGeometry(11.1, 0.22, 7.6), color: '#2f9e6e', at: [0, 4.25, 0] }, // band under the canopy
  ...[[-4.6, -3], [4.6, -3], [-4.6, 3], [4.6, 3]].map(([x, z]): Part => ({ geometry: new THREE.BoxGeometry(0.35, 4.3, 0.35), color: '#d9d4c7', at: [x, 2.15, z] })),
  ...[-2.2, 2.2].map((x): Part => ({ geometry: new THREE.BoxGeometry(0.9, 1.7, 0.55), color: '#2f9e6e', at: [x, 0.85, 0] })), // pumps
  ...[-2.2, 2.2].map((x): Part => ({ geometry: new THREE.BoxGeometry(0.6, 0.45, 0.58), color: '#f8f4ea', at: [x, 1.3, 0] })), // pump screens
  { geometry: new THREE.BoxGeometry(0.3, 7, 0.3), color: '#8d918f', at: [7.5, 3.5, 4.5] }, // sign pole
  { geometry: new THREE.BoxGeometry(2.4, 2.4, 0.35), color: '#2f9e6e', at: [7.5, 7.6, 4.5] }, // sign board
  { geometry: new THREE.BoxGeometry(1.5, 1.5, 0.4), color: '#ffd447', at: [7.5, 7.6, 4.5] }, // sign drop
];

const MAX = 128;

export function fuelStationsLayer(map0: () => LibreMap | null = () => null): CustomLayerInterface & {
  setStations: (stations: Station[], terrain: boolean) => void;
  scene: THREE.Scene;
  placement: THREE.Matrix4;
  fuse: (world?: SimpleLitUniforms) => void;
} {
  let map: LibreMap | null = null;
  let renderer: THREE.WebGLRenderer | null = null;
  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  let fused = false;
  let uniforms = standaloneUniforms();
  const meshes = PARTS.map((part) => {
    const mesh = new THREE.InstancedMesh(part.geometry, simpleLit(part.color, uniforms, { side: THREE.DoubleSide }), MAX);
    mesh.count = 0;
    mesh.frustumCulled = false;
    scene.add(mesh);
    return mesh;
  });
  let origin: [number, number] | null = null;
  let stations: Station[] = [];
  let useTerrain = false;
  const place = new THREE.Matrix4();
  const object = new THREE.Object3D();

  function rebuild() {
    if (!stations.length) { for (const m of meshes) m.count = 0; return; }
    origin = stations[0].position;
    const perMeter = mercatorPerMeter(origin[1]);
    // scene: x east, y up, z south, meters around `origin` → mercator 0..1
    place.set(
      perMeter, 0, 0, mercatorX01(origin[0]),
      0, 0, perMeter, mercatorY01(origin[1]),
      0, perMeter, 0, 0,
      0, 0, 0, 1,
    );
    const count = Math.min(MAX, stations.length);
    meshes.forEach((mesh, p) => {
      const at = PARTS[p].at;
      for (let i = 0; i < count; i++) {
        const s = stations[i].position;
        const x = (mercatorX01(s[0]) - mercatorX01(origin![0])) / perMeter;
        const z = (mercatorY01(s[1]) - mercatorY01(origin![1])) / perMeter;
        const ground = useTerrain ? map?.queryTerrainElevation(s) ?? 0 : 0;
        // stable but varied orientation per station
        const yaw = (Math.abs(Math.sin(s[0] * 1e4 + s[1] * 7e3)) * Math.PI);
        object.position.set(x, ground, z);
        object.rotation.set(0, yaw, 0);
        object.updateMatrix();
        const local = new THREE.Matrix4().makeTranslation(at[0], at[1], at[2]);
        mesh.setMatrixAt(i, object.matrix.clone().multiply(local));
      }
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
    });
  }

  return {
    id: 'fuel-stations',
    type: 'custom',
    renderingMode: '3d',
    scene,
    placement: place,
    fuse(world) {
      fused = true;
      if (world) {
        uniforms = world;
        meshes.forEach((mesh, p) => {
          (mesh.material as THREE.Material).dispose();
          mesh.material = simpleLit(PARTS[p].color, uniforms, { side: THREE.DoubleSide });
        });
      }
    },
    setStations(next, terrain) {
      const same = next.length === stations.length && next.every((s, i) => s.id === stations[i].id) && terrain === useTerrain;
      if (same) return;
      stations = next.slice(0, MAX);
      useTerrain = terrain;
      rebuild();
      map?.triggerRepaint();
    },
    onAdd(nextMap, gl) {
      map = nextMap ?? map0();
      if (fused) return;
      renderer = new THREE.WebGLRenderer({ canvas: nextMap.getCanvas(), context: gl as WebGL2RenderingContext, antialias: true });
      renderer.autoClear = false;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
    },
    render(_gl, args) {
      if (fused || !renderer || !origin || !meshes[0].count) return;
      const main = (args as { defaultProjectionData: { mainMatrix: ArrayLike<number> } }).defaultProjectionData.mainMatrix;
      camera.projectionMatrix.fromArray(Array.from(main)).multiply(place);
      renderer.resetState();
      renderer.render(scene, camera);
      renderer.resetState();
    },
    onRemove() {
      for (const mesh of meshes) { mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); }
      renderer?.dispose();
    },
  };
}
