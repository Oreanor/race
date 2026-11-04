import * as THREE from 'three';
import type { MapLayer, ThreeMap } from '@/world3d/map/ThreeMap';
import { mercatorPerMeter, mercatorX01, mercatorY01 } from '@/world3d/map/camera';
import { simpleLit, standaloneUniforms, type SimpleLitUniforms } from '@/world3d/map/simpleLit';
import type { CarPose } from '@/game/Trains';
import type { Position } from '@/game/VehicleController';

// Trains and trams drawn in our one scene: a few instanced box parts per car
// (body, window band, roof, underframe). Placeholder shapes until the models come.

const MAX = 80;
type Part = { size: [number, number, number]; at: number; color: string; tint?: boolean };
// sizes as fractions of the car: width (m), height (m), length (fraction of the car); `at` = height of the centre
const PARTS: Part[] = [
  { size: [2.5, 0.5, 0.94], at: 0.55, color: '#2d3236' }, // underframe and bogies
  { size: [2.9, 2.4, 1], at: 2.0, color: '#ffffff', tint: true }, // body (per-car colour)
  { size: [2.94, 0.75, 0.9], at: 2.45, color: '#26323b' }, // window band
  { size: [2.6, 0.35, 0.96], at: 3.35, color: '#8f979c' }, // roof
];

const COLORS: Record<string, { lead: string; car: string }> = {
  rail: { lead: '#c8372d', car: '#d9dde0' },
  tram: { lead: '#f2c230', car: '#f2c230' },
};

export function trainsLayer(): MapLayer & {
  scene: THREE.Scene;
  placement: THREE.Matrix4;
  fuse: (world?: SimpleLitUniforms) => void;
  setCars: (cars: CarPose[], origin: Position, terrain: boolean) => void;
} {
  let map: ThreeMap | null = null;
  const scene = new THREE.Scene();
  let uniforms = standaloneUniforms();
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const meshes = PARTS.map((part) => {
    const mesh = new THREE.InstancedMesh(geometry, simpleLit(part.color, uniforms), MAX);
    mesh.count = 0;
    mesh.frustumCulled = false;
    if (part.tint) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    scene.add(mesh);
    return mesh;
  });
  const place = new THREE.Matrix4();
  const object = new THREE.Object3D();
  object.rotation.order = 'YXZ';
  const local = new THREE.Matrix4();
  const color = new THREE.Color();

  return {
    id: 'trains',
    type: 'custom',
    scene,
    placement: place,
    fuse(world) {
      if (!world) return;
      uniforms = world;
      meshes.forEach((mesh, p) => {
        (mesh.material as THREE.Material).dispose();
        mesh.material = simpleLit(PARTS[p].color, uniforms);
      });
    },
    setCars(cars, origin, terrain) {
      const perMeter = mercatorPerMeter(origin[1]);
      // scene: x east, y up, z south, meters around `origin` → mercator 0..1
      place.set(
        perMeter, 0, 0, mercatorX01(origin[0]),
        0, 0, perMeter, mercatorY01(origin[1]),
        0, perMeter, 0, 0,
        0, 0, 0, 1,
      );
      const local01 = (p: Position) => [(mercatorX01(p[0]) - mercatorX01(origin[0])) / perMeter, (mercatorY01(p[1]) - mercatorY01(origin[1])) / perMeter];
      const ground = (p: Position) => (terrain ? map?.queryTerrainElevation(p) ?? 0 : 0) + 0.1;
      const count = Math.min(MAX, cars.length);
      for (let i = 0; i < count; i++) {
        const car = cars[i];
        const [fx, fz] = local01(car.front);
        const [bx, bz] = local01(car.back);
        const fy = ground(car.front), by = ground(car.back);
        const length = Math.hypot(fx - bx, fz - bz) || 1;
        object.position.set((fx + bx) / 2, (fy + by) / 2, (fz + bz) / 2);
        // +z of the box points from the back to the front; tilt with the slope
        object.rotation.set(-Math.atan2(fy - by, length), Math.atan2(fx - bx, fz - bz), 0);
        object.updateMatrix();
        const palette = COLORS[car.kind] ?? COLORS.rail;
        meshes.forEach((mesh, p) => {
          const part = PARTS[p];
          local.makeTranslation(0, part.at, 0).scale(new THREE.Vector3(part.size[0], part.size[1], part.size[2] * length));
          mesh.setMatrixAt(i, object.matrix.clone().multiply(local));
          if (part.tint) mesh.setColorAt(i, color.set(car.index === 0 ? palette.lead : palette.car).convertSRGBToLinear());
        });
      }
      for (const mesh of meshes) {
        mesh.count = count;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    },
    onAdd(nextMap) {
      map = nextMap;
    },
    onRemove() {
      geometry.dispose();
      for (const mesh of meshes) (mesh.material as THREE.Material).dispose();
    },
  };
}
