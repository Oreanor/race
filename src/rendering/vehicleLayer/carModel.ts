import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Car } from '@/config/vehicle.config';

/** Holds LMB for a water jet instead of bullets. */
export const WATER_TRUCK_ID = '18';

/**
 * Police lights on the roof: the Chevy (Fleetline Police) one red lamp in the middle, the
 * Volga (GAZ-24 militia) the red one plus a blue on each side. Red and blue take turns.
 */
const POLICE_LIGHTS: Record<string, ('red' | 'blue')[]> = {
  '09': ['red'],
  '16': ['blue', 'red', 'blue'],
  /** Gallardo patrol: single blue beacon */
  '21': ['blue'],
  /** Cadillac ambulance: one red flasher aft of the roof middle */
  '20': ['red'],
};
/**
 * A model with its own roof lamps: only the glow goes on, over those lamps — `forward`
 * of the car's middle (m) and `drop` below the model's top (m). Others get lamp boxes on top.
 * Positive `forward` is toward the nose; negative is toward the tail.
 */
const BEACON_FIT: Record<string, { forward: number; drop: number }> = {
  '09': { forward: 0.15, drop: 0.16 },
  '16': { forward: 0.35, drop: 0.2 },
  /** Gallardo: centered, shallow drop */
  '21': { forward: 0, drop: 0.2 },
  // past mid toward the tail — on the ambulance roof beacon
  '20': { forward: -0.7, drop: 0.14 },
};
const beaconMats = {
  red: new THREE.MeshBasicMaterial({ color: '#ff2a1f', transparent: true }),
  blue: new THREE.MeshBasicMaterial({ color: '#2f6dff', transparent: true }),
};
const beaconOffMats = {
  red: new THREE.MeshBasicMaterial({ color: '#5a1a16' }),
  blue: new THREE.MeshBasicMaterial({ color: '#1a2a52' }),
};
const haloTexture = (() => {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();
const haloMats = {
  red: new THREE.MeshBasicMaterial({ map: haloTexture, color: '#ff3b2e', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
  blue: new THREE.MeshBasicMaterial({ map: haloTexture, color: '#3d7bff', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
};
const haloGeometry = new THREE.PlaneGeometry(1, 1);
const haloEye = new THREE.Vector3();

function beaconLevel(color: 'red' | 'blue') {
  const t = performance.now() / 400;
  const phase = (t % 1) < 0.5;
  return (color === 'red') === phase ? 1 : 0.08;
}

const haloParent = new THREE.Quaternion(), haloAxes = new THREE.Matrix4(), haloPos = new THREE.Vector3();
const haloX = new THREE.Vector3(), haloY = new THREE.Vector3(), haloZ = new THREE.Vector3(), haloUp = new THREE.Vector3(0, 1, 0);

/** Turn every glow card in `scene` to face `eye` (scene-local). */
export function faceHalos(scene: THREE.Scene, eye: THREE.Vector3) {
  scene.traverse((halo) => {
    if (!halo.userData.halo || !halo.visible) return;
    haloParent.identity();
    const chain: THREE.Object3D[] = [];
    for (let o = halo.parent; o && o !== scene; o = o.parent) { o.updateMatrix(); chain.unshift(o); }
    haloPos.copy(halo.position);
    for (let i = chain.length - 1; i >= 0; i--) haloPos.applyMatrix4(chain[i].matrix);
    for (const o of chain) haloParent.multiply(o.quaternion);
    haloZ.subVectors(eye, haloPos).normalize();
    haloX.crossVectors(haloUp, haloZ);
    if (haloX.lengthSq() < 1e-8) haloX.set(1, 0, 0); else haloX.normalize();
    haloY.crossVectors(haloZ, haloX);
    haloAxes.makeBasis(haloX, haloY, haloZ);
    halo.quaternion.setFromRotationMatrix(haloAxes).premultiply(haloParent.invert());
  });
}

/** Show/hide police glow and swap lamp materials on a car root. */
export function applyBeaconPower(root: THREE.Object3D, on: boolean) {
  root.traverse((child) => {
    if (!child.userData.beacon) return;
    if (child.userData.halo) child.visible = on;
    else if (child instanceof THREE.Mesh && child.userData.color) {
      const color = child.userData.color as 'red' | 'blue';
      child.material = on ? beaconMats[color] : beaconOffMats[color];
    }
  });
}

function addBeacons(root: THREE.Group, car: Car, size: THREE.Vector3, scale: number) {
  const lights = POLICE_LIGHTS[car.id];
  if (!lights) return;
  const alongX = size.x >= size.z;
  const fit = BEACON_FIT[car.id];
  const top = fit ? size.y * scale - fit.drop : size.y * scale + 0.06;
  const along = fit ? -fit.forward : 0;
  const spread = Math.min(size.x, size.z) * scale * 0.26;
  lights.forEach((color, i) => {
    const offset = (i - (lights.length - 1) / 2) * spread;
    const at = new THREE.Vector3(alongX ? along : offset, top, alongX ? offset : along);
    if (!fit) {
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.14, 0.2), beaconMats[color]);
      lamp.position.copy(at);
      lamp.userData.beacon = true;
      lamp.userData.color = color;
      lamp.onBeforeRender = () => { beaconMats[color].opacity = 0.35 + 0.65 * beaconLevel(color); };
      root.add(lamp);
    }
    const halo = new THREE.Mesh(haloGeometry, haloMats[color]);
    halo.scale.setScalar(1.6);
    halo.userData.halo = true;
    halo.position.copy(at);
    halo.renderOrder = 9;
    halo.userData.beacon = true;
    halo.onBeforeRender = (_renderer, _scene, camera) => {
      haloMats[color].opacity = beaconLevel(color);
      if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
        halo.lookAt(camera.getWorldPosition(haloEye));
        halo.updateMatrixWorld();
      }
    };
    root.add(halo);
  });
}

export function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    if (child.userData.beacon) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose();
      material.dispose();
    }
  });
}

function glossy(material: THREE.Material) {
  const source = material as THREE.MeshStandardMaterial;
  const paint = new THREE.MeshPhongMaterial({
    map: source.map ?? null,
    color: source.color ?? new THREE.Color('#ffffff'),
    shininess: 62,
    specular: new THREE.Color('#d8dde8'),
    reflectivity: 0.28,
  });
  source.map = null;
  source.dispose();
  return paint;
}

function polish(object: THREE.Object3D) {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const current = Array.isArray(child.material) ? child.material : [child.material];
    const next = current.map(glossy);
    child.material = Array.isArray(child.material) ? next : next[0];
  });
}

export async function loadCar(car: Car) {
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
  polish(root);
  addBeacons(root, car, size, scale);
  root.userData.width = Math.min(size.x, size.z) * scale;
  return root;
}

export function fallbackCar(color: string) {
  const root = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.65, 4.2), new THREE.MeshStandardMaterial({ color }));
  body.position.y = 0.7;
  root.add(body);
  const top = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.65, 2), new THREE.MeshStandardMaterial({ color: '#5a7475' }));
  top.position.set(0, 1.3, -0.2);
  root.add(top);
  for (const x of [-0.9, 0.9]) for (const z of [-1.3, 1.3]) {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.25, 16), new THREE.MeshStandardMaterial({ color: '#232b2b', roughness: 0.85, metalness: 0 }));
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(x, 0.35, z);
    root.add(wheel);
  }
  polish(root);
  return root;
}
