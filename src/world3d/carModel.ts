import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Car } from '@/config/vehicle.config';

// Same normalisation as rendering/VehicleLayer.loadCar, without pulling
// maplibre-gl into the three-world bundle.
export async function loadCarModel(car: Car) {
  const gltf = await new GLTFLoader().loadAsync(car.path);
  const model = gltf.scene;
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const scale = car.length / Math.max(size.x, size.z);
  model.position.set(-center.x, -box.min.y, -center.z);
  const group = new THREE.Group();
  group.add(model);
  group.scale.setScalar(scale);
  const root = new THREE.Group();
  root.add(group);
  root.rotation.y = car.yaw;
  return root;
}

export function placeholderCar(color: string) {
  const root = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.7, 1.8), new THREE.MeshLambertMaterial({ color }));
  body.position.y = 0.7;
  root.add(body);
  return root;
}
