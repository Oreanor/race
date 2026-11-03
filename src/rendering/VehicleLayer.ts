import { TireTracks } from './TireTracks';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MercatorCoordinate, type CustomLayerInterface, type Map as LibreMap } from 'maplibre-gl';
import type { Car } from '@/config/vehicle.config';
import { offsetPosition, type Position } from '@/game/VehicleController';
import type { Pose } from '@/game/VehiclePose';

export function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
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
    shininess: 48,
    specular: new THREE.Color('#ffffff'),
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
  return root;
}

function fallbackCar(color: string) {
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

const earth = 6378137;

function eastNorth(origin: Position, point: Position) {
  const lat = origin[1] * Math.PI / 180;
  return {
    east: (point[0] - origin[0]) * Math.PI / 180 * earth * Math.cos(lat),
    north: (point[1] - origin[1]) * Math.PI / 180 * earth,
  };
}

function smokeTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const draw = canvas.getContext('2d')!;
  const glow = draw.createRadialGradient(32, 32, 2, 32, 32, 31);
  glow.addColorStop(0, 'rgba(255,255,255,0.9)');
  glow.addColorStop(0.4, 'rgba(236,236,232,0.45)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  draw.fillStyle = glow;
  draw.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function puffMesh(texture: THREE.Texture) {
  const material = new THREE.MeshBasicMaterial({ map: texture, color: '#8b887f', transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide, opacity: 0 });
  const flat = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  flat.rotation.x = -Math.PI / 2;
  const upright = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  const cross = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  cross.rotation.y = Math.PI / 2;
  const group = new THREE.Group();
  for (const mesh of [flat, upright, cross]) {
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    group.add(mesh);
  }
  group.visible = false;
  return group;
}

export function vehicleLayer(car: Car, vehicle: Pose, height: () => number, pitch: () => number, roll: () => number, scale: () => number, status: (text: string) => void): CustomLayerInterface {
  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  let renderer: THREE.WebGLRenderer;
  let disposed = false;
  let map: LibreMap;
  const root = new THREE.Group();
  root.add(fallbackCar(car.color));
  scene.add(root);
  scene.add(new THREE.HemisphereLight(0xfff6ec, 0x8a8172, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.6);
  sun.position.set(6, 16, 8);
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0xfff8ee, 2.2);
  rim.position.set(-4, 12, -8);
  scene.add(rim);
  const haze = smokeTexture();
  const puffs = Array.from({ length: 40 }, () => {
    const mesh = puffMesh(haze);
    scene.add(mesh);
    return { mesh, place: [0, 0] as Position, east: 0, north: 0, up: 0, born: 0, life: 1, size: 0.4, active: false };
  });
  let cursor = 0;
  let lastSpawn = 0;
  let lastFrame = 0;
  const tireTracks = new TireTracks(scene);
  const spawn = (side: number, now: number) => {
    const lean = pitch();
    const back = -car.length * 0.56;
    const rise = 0.55;
    const x = side * (0.62 + Math.random() * 0.12);
    const y = rise * Math.cos(lean) - back * Math.sin(lean);
    const z = rise * Math.sin(lean) + back * Math.cos(lean);
    const heading = vehicle.heading;
    const puff = puffs[cursor % puffs.length];
    cursor += 1;
    puff.active = true;
    puff.place = offsetPosition(vehicle.position, -x * Math.cos(heading) + z * Math.sin(heading), x * Math.sin(heading) + z * Math.cos(heading));
    puff.east = -Math.sin(heading) * (0.7 + Math.random() * 0.5);
    puff.north = -Math.cos(heading) * (0.7 + Math.random() * 0.5);
    puff.up = y;
    puff.born = now;
    puff.life = 1100 + Math.random() * 400;
    puff.size = 0.9 + Math.random() * 0.35;
    puff.mesh.visible = true;
  };
  return {
    id: 'vehicle',
    type: 'custom',
    renderingMode: '3d',
    onAdd(nextMap, gl) {
      map = nextMap;
      renderer = new THREE.WebGLRenderer({ canvas: nextMap.getCanvas(), context: gl as WebGL2RenderingContext, antialias: true });
      renderer.autoClear = false;
      loadCar(car).then((model) => {
        if (disposed) { disposeObject(model); return; }
        polish(model);
        disposeObject(root);
        root.clear();
        root.add(model);
        status('Машина готова');
        map.triggerRepaint();
      }).catch(() => status('Резервная модель · GLB недоступен'));
    },
    render(_gl, args) {
      const now = performance.now();
      const dt = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 0;
      lastFrame = now;
      if (vehicle.throttle && now - lastSpawn > 75) {
        lastSpawn = now;
        spawn(1, now);
        spawn(-1, now);
      }
      const heading = vehicle.heading;
      const here = vehicle.position;
      tireTracks.update(here, heading, scale(), car.length, height() + car.offset, p => map.getTerrain() ? map.queryTerrainElevation(p) : 0);
      for (const puff of puffs) {
        if (!puff.active) continue;
        const age = now - puff.born;
        if (age >= puff.life) {
          puff.active = false;
          puff.mesh.visible = false;
          continue;
        }
        puff.place = offsetPosition(puff.place, puff.east * dt, puff.north * dt);
        puff.up += dt * 0.7;
        const offset = eastNorth(vehicle.position, puff.place);
        const fade = 1 - age / puff.life;
        puff.mesh.position.set(offset.north * Math.sin(heading) - offset.east * Math.cos(heading), puff.up, offset.north * Math.cos(heading) + offset.east * Math.sin(heading));
        puff.mesh.scale.setScalar(puff.size * (1 + (1 - fade) * 2.2));
        const material = (puff.mesh.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;
        material.opacity = 0.82 * fade;
      }
      const place = MercatorCoordinate.fromLngLat(vehicle.position, height() + car.offset);
      const meters = place.meterInMercatorCoordinateUnits() * Math.min(10, Math.max(1, scale()));
      root.rotation.order = 'XYZ';
      root.rotation.x = pitch();
      root.rotation.z = roll();
      const matrix = new THREE.Matrix4().makeTranslation(place.x, place.y, place.z).scale(new THREE.Vector3(meters, -meters, meters)).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)).multiply(new THREE.Matrix4().makeRotationY(-vehicle.heading + Math.PI));
      camera.projectionMatrix.fromArray(args.defaultProjectionData.mainMatrix).multiply(matrix);
      renderer.resetState();
      renderer.render(scene, camera);
      renderer.resetState();
    },
    onRemove() {
      disposed = true;
      disposeObject(scene);
      renderer?.dispose();
    },
  };
}
