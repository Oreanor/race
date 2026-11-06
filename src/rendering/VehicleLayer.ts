import { BurningHouse, type FirePaneSpec } from './BurningHouse';
import { TireTracks } from './TireTracks';
import { WorldParticles, type Enu, type Surface } from './effects/WorldParticles';
import { fireEye, WreckFire } from './effects/WreckFire';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { MapLayer, ThreeMap } from '@/world3d/map/ThreeMap';
import { mercatorPerMeter, mercatorX01, mercatorY01 } from '@/world3d/map/camera';
import type { Car } from '@/config/vehicle.config';
import { offsetPosition, type Position } from '@/game/VehicleController';
import type { Pose } from '@/game/VehiclePose';
import { t } from '@/i18n';

export type TargetVehicle = { id: string; driver: string; car: Car; position: Position; heading: number };
/** Another player's car (multiplayer): drawn only, never shot or hit here. Altitude in meters as drawn. */
export type RemoteCar = { id: string; car: Car; position: Position; heading: number; altitude: number; pitch: number; roll: number; hp?: number };
export type TargetHealth = { id: string; driver: string; color: string; hp: number; maxHp: number };
/** `drop`: a coin thrown out of a wreck — it flies from `from` to `position` from time `at`, bouncing */
export type PickupVisual = { id: string; position: Position; color: string; kind?: 'ball' | 'coin' | 'cash' | 'box'; drop?: { from: Position; at: number; up?: number } };

/** how long a coin from a wreck bounces and rolls before it lies still (ms) */
export const DROP_MS = 1300;
type DeathPhase = 'tumble' | 'burn' | 'wreck';
type CharMat = { material: THREE.MeshPhongMaterial; r: number; g: number; b: number };
type TargetState = TargetVehicle & {
  root: THREE.Group;
  /** soft shadow on the ground under it */
  shadow: THREE.Mesh;
  explosion: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  hp: number;
  destroyed: boolean;
  deathPhase: DeathPhase | null;
  explodedAt: number;
  flashUntil: number;
  flashing: boolean;
  spinX: number;
  spinY: number;
  spinZ: number;
  velUp: number;
  blastsLeft: number;
  nextBlastAt: number;
  charMats: CharMat[];
  /** Scene orientation of the wreck at landing; yaw is compensated when the player turns. */
  wreckQuat: THREE.Quaternion | null;
  wreckBakeHeading: number;
  wreckRestY: number;
  /** the ground under it (m), its own: a bot under a bridge stays under it */
  altitude: number | null;
};
export type AimPoint = { ground: Position; screen: [number, number] };
export type VehicleSceneLayer = MapLayer & {
  /** host-drawn mode: the host renders `scene` placed by `placement` (local → mercator) */
  scene: THREE.Scene;
  placement: THREE.Matrix4;
  fuse: () => void;
  /** headlamp glow, 0 off … 1 full (night) */
  setHeadlights: (on: number) => void;
  setAim: (aim: AimPoint | null) => void;
  /** what the cursor points at as the camera sees it: the first wall on its ray, else the ground */
  aimTarget: () => { position: Position; altitude: number; wall: boolean } | null;
  setFiring: (firing: boolean) => void;
  flashPlayer: (duration: number) => void;
  /** a hunting target fires at our car: muzzle flash, a tracer, and sparks on us or beside us */
  enemyShot: (fromId: string, hit: boolean) => void;
  /** our engine is on fire (a disabled car): smoke and sparks from the hood, call every frame */
  burnPlayer: () => void;
  setCar: (next: Car) => void;
  /** our police lights on (flashing) or off */
  setBeacons: (on: boolean) => void;
  setTargets: (vehicles: TargetVehicle[]) => void;
  /** targets beside the missions' (shared traffic, test cars): by id, never counted for a mission */
  setExtraTargets: (vehicles: TargetVehicle[]) => void;
  /** a target's health as its owner says (shared traffic); 0 blows it up */
  setTargetHp: (id: string, hp: number) => void;
  targetHp: (id: string) => number | null;
  /** the extra targets still standing, for the HUD's health meters */
  extraHealth: () => (TargetHealth & { position: Position })[];
  /** our bullet hit a target */
  onTargetHit: (id: string) => void;
  /** any target blew up (shot, rammed, or reported by its owner) */
  onTargetDestroyed: (id: string, position: Position) => void;
  /** our bullet hit a vintage train here */
  onTrainCoin: (point: Position, altitude: number) => void;
  /** other players, every frame; cars come and go with the list */
  setRemotes: (cars: RemoteCar[]) => void;
  /** our bullet hit another player's car */
  /** true when the hit counts (no damage, e.g. on a player busy on a mission: no red flash) */
  onRemoteHit: (id: string) => boolean;
  /** our own car blows up (another player got us): a burst on the spot */
  explodePlayer: () => void;
  updateTargets: (vehicles: TargetVehicle[]) => void;
  flashTarget: (id: string, duration: number) => void;
  damageTarget: (id: string, amount: number) => boolean;
  aliveTargetCount: () => number;
  isTargetAlive: (id: string) => boolean;
  targetHealth: () => TargetHealth[];
  setPickups: (pickups: PickupVisual[]) => void;
  /** move a pickup already shown (the hauler's cable reels it in) */
  movePickup: (id: string, position: Position) => void;
  setMissionBeacons: (beacons: {
    id: string;
    position: Position;
    kind?: 'arena' | 'race' | 'bounty' | 'fire' | 'impound';
    colors?: { pole: string; glow: string; orb: string };
  }[]) => void;
  setRaceFinish: (goal: Position | null) => void;
  /** fire call: ignite these existing-façade panes; null clears */
  setFireHouse: (site: { panes: FirePaneSpec[] } | null) => void;
  /** panes still burning (null if no house) */
  fireWindowsLeft: () => number | null;
  /** called when a burning pane is put out for the first time */
  onFireWindowOut: (left: number) => void;
  /** the hauler: a car of ours held at this pose (`up`: m above our car), drawn there and not on its own ground */
  setCarried: (pose: { id: string; position: Position; heading: number; up: number; pitch?: number } | null) => void;
  /** the hauler's cable from our car's middle to a point (`up`: m above our car); `wave`: 0 taut … 1 whipping; null hides it */
  setCable: (to: { position: Position; up: number; wave?: number } | null) => void;
  /** the J ramp: low edge at `position`, rising along `heading`; null takes it away */
  setRamp: (ramp: { position: Position; heading: number; ground: number; tilt: number; length: number; height: number; width: number } | null) => void;
};

export function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    if (child.userData.beacon) return; // police lamps share their materials
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

export function polish(object: THREE.Object3D) {
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
  // the body's width (its shorter side once scaled), for where its wheels leave their tracks
  root.userData.width = Math.min(size.x, size.z) * scale;
  return root;
}

/**
 * Police lights on the roof: the Chevy (Fleetline Police) one red lamp in the middle, the
 * Volga (GAZ-24 militia) the red one plus a blue on each side. Red and blue take turns.
 */
const POLICE_LIGHTS: Record<string, ('red' | 'blue')[]> = {
  '09': ['red'],
  '16': ['blue', 'red', 'blue'],
};
/** Holds LMB for a water jet instead of bullets. */
const WATER_TRUCK_ID = '18';
/**
 * A model with its own roof lamps: only the glow goes on, over those lamps — `forward`
 * of the car's middle (m) and `drop` below the model's top (m). Others get lamp boxes on top.
 */
const BEACON_FIT: Record<string, { forward: number; drop: number }> = {
  '09': { forward: 0.15, drop: 0.16 }, // Fleetline: its red lamp on the front of the roof
  '16': { forward: 0.35, drop: 0.2 }, // Volga: blue, red, blue over the windscreen
};
const beaconMats = {
  red: new THREE.MeshBasicMaterial({ color: '#ff2a1f', transparent: true }),
  blue: new THREE.MeshBasicMaterial({ color: '#2f6dff', transparent: true }),
};
/** a switched-off lamp: its colour, dull and still */
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
// The glow of a lamp: a flat card turned to the camera every frame (render() below).
// Not a Sprite: this layer's camera is all in one projection matrix, so a sprite would
// not know where the eye is and stand still, edge-on from the side, gone from behind.
const haloMats = {
  red: new THREE.MeshBasicMaterial({ map: haloTexture, color: '#ff3b2e', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
  blue: new THREE.MeshBasicMaterial({ map: haloTexture, color: '#3d7bff', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
};
const haloGeometry = new THREE.PlaneGeometry(1, 1);
const haloEye = new THREE.Vector3();
/** on/off of each colour now: red and blue alternate, ~2.5 flashes a second */
function beaconLevel(color: 'red' | 'blue') {
  const t = performance.now() / 400;
  const phase = (t % 1) < 0.5;
  return (color === 'red') === phase ? 1 : 0.08;
}
/**
 * Turn every glow card in `scene` to face `eye` (both in the scene's own frame). Built here
 * from the axes (to the eye, and upright) rather than with lookAt: the scene itself is
 * placed on the map through a mirrored matrix, and lookAt works in that world frame.
 */
const haloParent = new THREE.Quaternion(), haloAxes = new THREE.Matrix4(), haloPos = new THREE.Vector3();
const haloX = new THREE.Vector3(), haloY = new THREE.Vector3(), haloZ = new THREE.Vector3(), haloUp = new THREE.Vector3(0, 1, 0);
function faceHalos(scene: THREE.Scene, eye: THREE.Vector3) {
  scene.traverse((halo) => {
    if (!halo.userData.halo || !halo.visible) return;
    // its place and its parents' turn, from the scene down (no scene matrix in it)
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

function addBeacons(root: THREE.Group, car: Car, size: THREE.Vector3, scale: number) {
  const lights = POLICE_LIGHTS[car.id];
  if (!lights) return;
  // the model before the yaw: its long side along x or z; across it is the other one
  const alongX = size.x >= size.z;
  const fit = BEACON_FIT[car.id];
  const top = fit ? size.y * scale - fit.drop : size.y * scale + 0.06;
  // forward is −x of the model (its yaw turns −x to the car's nose)
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
      // a real camera (the car previews in the menu and the showroom): face it here; in the
      // game the layer's camera is only a projection, and render() turns the glows itself
      if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
        halo.lookAt(camera.getWorldPosition(haloEye));
        halo.updateMatrixWorld();
      }
    };
    root.add(halo);
  });
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

export function vehicleLayer(
  car: Car,
  vehicle: Pose,
  height: () => number,
  pitch: () => number,
  roll: () => number,
  status: (text: string) => void,
  resolveShot: (cam: Position, camAlt: number, ground: Position, groundAlt: number, mark?: boolean) => { point: Position; altitude: number } | null = () => null,
  markGround: (point: Position, altitude: number) => void = () => {},
  /** a train car along a shot (from → to): where, and whether it is a vintage one that pays out */
  resolveTrain: (from: Position, fromAlt: number, to: Position, toAlt: number) => { point: Position; altitude: number; vintage: boolean } | null = () => null,
): VehicleSceneLayer {
  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  let renderer: THREE.WebGLRenderer | null = null;
  let fused = false;
  const placement = new THREE.Matrix4();
  let disposed = false;
  let map: ThreeMap;
  const root = new THREE.Group();
  root.add(fallbackCar(car.color));
  scene.add(root);
  // Soft shadows under the cars: a dark rectangle with blurred edges lying on the ground,
  // one texture and one material for all (no shadow maps)
  // the texture: a rectangle filling all but a thin rim, its edge fading over that rim
  // (drawn pixel by pixel: canvas blur filters are not everywhere)
  const SHADOW_RIM = 0.07; // share of the texture each side that is the soft edge
  const shadowTexture = (() => {
    const w = 64, h = 128;
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const u = Math.min(x + 0.5, w - x - 0.5) / w, v = Math.min(y + 0.5, h - y - 0.5) / h;
      const edge = Math.min(u / SHADOW_RIM, v / (SHADOW_RIM * w / h), 1);
      const i = (y * w + x) * 4;
      // alphaMap reads the green channel: the same value in all four
      data[i] = data[i + 1] = data[i + 2] = data[i + 3] = Math.round(255 * edge * edge * (3 - 2 * edge));
    }
    const texture = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return texture;
  })();
  const shadowGeometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const shadowMaterial = new THREE.MeshBasicMaterial({
    alphaMap: shadowTexture, color: 0x000000, transparent: true, opacity: 0.42, depthWrite: false,
    // pull slightly toward the camera so a low plane doesn't z-fight the ground
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8,
  });
  /** the shadow's size for a car: its footprint plus a hand's width of soft edge round it */
  const shadowScale = (mesh: THREE.Object3D, length: number, width: number) => mesh.scale.set(width + 0.3, 1, length + 0.24);
  /** a shadow for a car `length` m long and `width` wide */
  const makeShadow = (length: number, width: number) => {
    const mesh = new THREE.Mesh(shadowGeometry, shadowMaterial.clone());
    shadowScale(mesh, length, width);
    mesh.renderOrder = 1;
    mesh.frustumCulled = false;
    scene.add(mesh);
    return mesh;
  };
  /** lay `shadow` on the ground at `ground` (m relative to our car), fading the higher the car is over it */
  const layShadow = (shadow: THREE.Mesh, x: number, ground: number, z: number, yaw: number, lift: number) => {
    // keep the plane near the dirt so it doesn't cut through big tyres (was 0.21)
    shadow.position.set(x, ground + 0.04, z);
    shadow.rotation.y = yaw;
    const fade = Math.max(0, 1 - Math.max(0, lift) / 6);
    (shadow.material as THREE.MeshBasicMaterial).opacity = 0.42 * fade;
    shadow.visible = fade > 0.02;
  };
  const playerShadow = makeShadow(car.length, car.length * 0.44);
  const burningHouse = new BurningHouse();
  scene.add(new THREE.HemisphereLight(0xfff6ec, 0x8a8172, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.6);
  sun.position.set(6, 16, 8);
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0xfff8ee, 2.2);
  rim.position.set(-4, 12, -8);
  scene.add(rim);
  const haze = smokeTexture();
  const puffs = Array.from({ length: 64 }, () => {
    const mesh = puffMesh(haze);
    scene.add(mesh);
    return { mesh, place: [0, 0] as Position, east: 0, north: 0, up: 0, rise: 0.7, born: 0, life: 1, size: 0.4, active: false };
  });
  let cursor = 0;
  let lastSpawn = 0;
  let lastDust = 0;
  let lastHouseFx = 0;
  let surface: Surface = 'paved';
  let surfaceAt = 0;
  let lastFrame = 0;
  const tireTracks = new TireTracks(scene);
  const targets = new Map<string, TargetState>();
  const pickups = new Map<string, { position: Position; mesh: THREE.Object3D; phase: number; coin: boolean; ground: number | null; drop?: { from: Position; at: number; up?: number } }>();
  const pickupGeometry = new THREE.SphereGeometry(0.38, 16, 12);
  // a gold coin 1 m across, standing on its edge: disc, raised rim, a star on both faces
  const coinParts = (() => {
    const gold = new THREE.MeshStandardMaterial({ color: '#ffd54a', emissive: '#c88a10', emissiveIntensity: 0.45, metalness: 0.25, roughness: 0.3 });
    const deep = new THREE.MeshStandardMaterial({ color: '#f0b62a', emissive: '#a06c08', emissiveIntensity: 0.4, metalness: 0.2, roughness: 0.35 });
    const disc = new THREE.CylinderGeometry(0.5, 0.5, 0.09, 40).rotateX(Math.PI / 2);
    const rim = new THREE.TorusGeometry(0.46, 0.045, 8, 40);
    const star = new THREE.Shape();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 0.12 : 0.27;
      const a = Math.PI / 2 + i * Math.PI / 5;
      if (i) star.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      else star.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    const starGeometry = new THREE.ExtrudeGeometry(star, { depth: 0.13, bevelEnabled: false }).translate(0, 0, -0.065);
    return { gold, deep, disc, rim, star: starGeometry };
  })();
  function makeCoin() {
    const coin = new THREE.Group();
    coin.add(new THREE.Mesh(coinParts.disc, coinParts.deep));
    coin.add(new THREE.Mesh(coinParts.rim, coinParts.gold));
    coin.add(new THREE.Mesh(coinParts.star, coinParts.gold));
    coin.traverse((part) => { part.frustumCulled = false; part.renderOrder = 8; });
    return coin;
  }
  const pickupMaterials = new Map<string, THREE.MeshStandardMaterial>();
  function makeBeacon(pole: string, glow: string, orb: string, _base: string) {
    const group = new THREE.Group();
    // inverted drop / map pin: tip on the ground, fat bulb up
    const profile = [
      new THREE.Vector2(0, 0),
      new THREE.Vector2(0.28, 0.55),
      new THREE.Vector2(0.72, 1.45),
      new THREE.Vector2(1.15, 2.35),
      new THREE.Vector2(1.35, 3.15),
      new THREE.Vector2(1.2, 3.95),
      new THREE.Vector2(0.7, 4.55),
      new THREE.Vector2(0, 4.85),
    ];
    const tip = new THREE.Mesh(
      new THREE.LatheGeometry(profile, 28),
      new THREE.MeshStandardMaterial({ color: pole, emissive: glow, emissiveIntensity: 0.7, metalness: 0.18, roughness: 0.32 }),
    );
    tip.frustumCulled = false;
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 16, 12),
      new THREE.MeshStandardMaterial({ color: orb, emissive: pole, emissiveIntensity: 1.05, metalness: 0.05, roughness: 0.22 }),
    );
    core.position.y = 3.35;
    core.frustumCulled = false;
    group.add(tip, core);
    group.visible = false;
    group.frustumCulled = false;
    scene.add(group);
    return { group, tip: core };
  }
  const missionBeacons = new Map<string, {
    kind?: 'arena' | 'race' | 'bounty' | 'fire' | 'impound';
    position: Position;
    visual: ReturnType<typeof makeBeacon>;
  }>();
  function colorsForBeacon(beacon: {
    kind?: 'arena' | 'race' | 'bounty' | 'fire' | 'impound';
    colors?: { pole: string; glow: string; orb: string };
  }) {
    if (beacon.colors) return beacon.colors;
    if (beacon.kind === 'arena') return { pole: '#2f7dff', glow: '#1a4fb8', orb: '#6eb6ff' };
    if (beacon.kind === 'bounty') return { pole: '#d63a2f', glow: '#8a1c14', orb: '#ff8a7a' };
    if (beacon.kind === 'fire') return { pole: '#e85d04', glow: '#9a3412', orb: '#fb923c' };
    if (beacon.kind === 'impound') return { pole: '#7c3aed', glow: '#5b21b6', orb: '#c4b5fd' };
    return { pole: '#ff7a1a', glow: '#b84a00', orb: '#ffb86b' };
  }
  let onFireWindowOut: (left: number) => void = () => {};
  const raceFinish = new THREE.Group();
  const finishPole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.1, 3.2, 8),
    new THREE.MeshStandardMaterial({ color: '#f4f6e9', metalness: 0.2, roughness: 0.45 }),
  );
  finishPole.position.y = 1.6;
  finishPole.frustumCulled = false;
  const finishFlag = new THREE.Mesh(
    new THREE.PlaneGeometry(1.4, 0.9),
    new THREE.MeshStandardMaterial({ color: '#ffd447', emissive: '#c9a227', emissiveIntensity: 0.35, side: THREE.DoubleSide }),
  );
  finishFlag.position.set(0.7, 2.7, 0);
  finishFlag.frustumCulled = false;
  raceFinish.add(finishPole, finishFlag);
  raceFinish.visible = false;
  raceFinish.frustumCulled = false;
  scene.add(raceFinish);
  let raceFinishGoal: Position | null = null;
  const tracerPositions = new Float32Array(12);
  const tracerGeometry = new THREE.BufferGeometry();
  tracerGeometry.setAttribute('position', new THREE.BufferAttribute(tracerPositions, 3).setUsage(THREE.DynamicDrawUsage));
  tracerGeometry.setDrawRange(0, 0);
  const tracerMaterial = new THREE.LineBasicMaterial({ color: 0xffd074, transparent: true, opacity: 1, depthWrite: false });
  const tracer = new THREE.LineSegments(tracerGeometry, tracerMaterial);
  tracer.frustumCulled = false;
  tracer.visible = false;
  scene.add(tracer);
  // the hauler's cable: a thin line like a web thread, from our car's middle to its hook;
  // it whips in a wave as it flies and goes straight once it bites
  const CABLE_POINTS = 28;
  const cablePositions = new Float32Array(CABLE_POINTS * 3);
  const cableGeometry = new THREE.BufferGeometry();
  cableGeometry.setAttribute('position', new THREE.BufferAttribute(cablePositions, 3).setUsage(THREE.DynamicDrawUsage));
  const cable = new THREE.Line(cableGeometry, new THREE.LineBasicMaterial({ color: '#000000' }));
  cable.frustumCulled = false;
  cable.visible = false;
  scene.add(cable);
  let cableTo: { position: Position; up: number; wave: number } | null = null;
  let carried: { id: string; position: Position; heading: number; up: number; pitch?: number } | null = null;
  // muzzle flash, impact sparks and explosions
  const fx = new WorldParticles(scene);
  const explosionGeometry = new THREE.SphereGeometry(1, 10, 8);
  const targetMaxHp = 1000;
  const targetDamagePerShot = 15;
  let currentCar = car;
  let carLoadToken = 0;
  let aim: AimPoint | null = null;
  let firing = false;
  let lastShot = 0;
  let tracerUntil = 0;
  let playerFlashUntil = 0;
  let playerFlashing = false;

  function pickupMaterial(color: string) {
    let material = pickupMaterials.get(color);
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.28,
        metalness: 0.05,
        roughness: 0.32,
      });
      pickupMaterials.set(color, material);
    }
    return material;
  }

  function setPickups(next: PickupVisual[]) {
    const active = new Set(next.map(pickup => pickup.id));
    for (const [id, pickup] of pickups) {
      if (active.has(id)) continue;
      scene.remove(pickup.mesh);
      pickups.delete(id);
    }
    for (const pickup of next) {
      if (pickups.has(pickup.id)) continue;
      // coins and cash bundles share the hover / bounce; balls are the old score orbs
      const coin = pickup.kind === 'coin' || pickup.kind === 'cash' || pickup.kind === 'box';
      const mesh = pickup.kind === 'cash' ? makeCash() : pickup.kind === 'box' ? makeBox() : coin ? makeCoin() : new THREE.Mesh(pickupGeometry, pickupMaterial(pickup.color));
      mesh.frustumCulled = false;
      mesh.renderOrder = 8;
      scene.add(mesh);
      pickups.set(pickup.id, {
        position: [...pickup.position],
        mesh,
        phase: Math.random() * Math.PI * 2,
        coin,
        ground: null,
        drop: pickup.drop ? { from: [...pickup.drop.from] as Position, at: pickup.drop.at, up: pickup.drop.up } : undefined,
      });
    }
  }

  /** A cardboard box with a strip of tape over the top (the box hunt). */
  function makeBox() {
    const group = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 0.9), new THREE.MeshLambertMaterial({ color: '#b8742a' }));
    const tape = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.72, 0.92), new THREE.MeshLambertMaterial({ color: '#e8d8a8' }));
    group.add(box, tape);
    return group;
  }

  /** A bundle of banknotes: a green brick with a paper band round its middle. */
  function makeCash() {
    const group = new THREE.Group();
    const notes = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.36, 0.55), new THREE.MeshLambertMaterial({ color: '#3f8f4e' }));
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.38, 0.57), new THREE.MeshLambertMaterial({ color: '#f1ead2' }));
    group.add(notes, band);
    return group;
  }

  function setMissionBeacons(beacons: {
    id: string;
    position: Position;
    kind?: 'arena' | 'race' | 'bounty' | 'fire' | 'impound';
    colors?: { pole: string; glow: string; orb: string };
  }[]) {
    const active = new Set(beacons.map(beacon => beacon.id));
    for (const [id, entry] of missionBeacons) {
      if (active.has(id)) continue;
      scene.remove(entry.visual.group);
      missionBeacons.delete(id);
    }
    for (const beacon of beacons) {
      let entry = missionBeacons.get(beacon.id);
      if (!entry) {
        const colors = colorsForBeacon(beacon);
        const visual = makeBeacon(colors.pole, colors.glow, colors.orb, colors.glow);
        entry = { kind: beacon.kind, position: [...beacon.position], visual };
        missionBeacons.set(beacon.id, entry);
      }
      entry.kind = beacon.kind;
      entry.position = [...beacon.position];
      entry.visual.group.visible = true;
    }
    map?.triggerRepaint();
  }

  // kicker ramp: unit wedge (scaled to charged length / 30% grade)
  const rampSize = { length: 3.2, width: 3.2, height: 1.0 };
  const rampMesh = (() => {
    const side = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(rampSize.length, 0), new THREE.Vector2(rampSize.length, rampSize.height)]);
    const geometry = new THREE.ExtrudeGeometry(side, { depth: rampSize.width, bevelEnabled: false })
      .rotateY(-Math.PI / 2)
      .translate(rampSize.width / 2, 0, 0);
    const mesh = new THREE.Mesh(geometry, [
      new THREE.MeshStandardMaterial({ color: '#d98a2b', roughness: 0.75 }), // sides
      new THREE.MeshStandardMaterial({ color: '#f2b544', roughness: 0.6 }), // deck
    ]);
    mesh.rotation.order = 'YXZ';
    mesh.visible = false;
    mesh.frustumCulled = false;
    scene.add(mesh);
    return mesh;
  })();
  let ramp: { position: Position; heading: number; ground: number; tilt: number; length: number; height: number; width: number } | null = null;
  let rampShown = 0;
  let rampTarget = 0;
  function setRamp(next: typeof ramp) {
    if (next) {
      const first = !ramp;
      ramp = { ...next, position: [...next.position] as Position };
      if (first) rampShown = 0;
    }
    rampTarget = next ? 1 : 0;
    map?.triggerRepaint();
  }

  function setRaceFinish(goal: Position | null) {
    raceFinishGoal = goal ? [...goal] as Position : null;
    raceFinish.visible = Boolean(raceFinishGoal);
    map?.triggerRepaint();
  }


  function captureCharMats(root: THREE.Group) {
    const mats: CharMat[] = [];
    root.traverse(child => {
      if (!(child instanceof THREE.Mesh)) return;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        if (!(material instanceof THREE.MeshPhongMaterial)) continue;
        mats.push({ material, r: material.color.r, g: material.color.g, b: material.color.b });
      }
    });
    return mats;
  }

  function applyChar(target: TargetState, amount: number, fire = 0) {
    const black = 0.08 + amount * 0.04;
    for (const entry of target.charMats) {
      entry.material.color.setRGB(
        entry.r * (1 - amount) + black * amount,
        entry.g * (1 - amount) + black * amount,
        entry.b * (1 - amount) + (black * 0.95) * amount,
      );
      entry.material.emissive.set(fire > 0.05 ? '#ff4a12' : '#000000');
      entry.material.emissiveIntensity = fire > 0.05 ? fire * 1.8 : 1;
    }
  }

  /**
   * A target's ground relative to our car (m). Each keeps its last height as the hint
   * (the same rule as the car and the trains): on a bridge it stays on the deck,
   * under it on the road below. A wreck stays where it fell.
   */
  function targetLift(target: TargetState) {
    if (!target.destroyed || target.altitude == null) {
      // first look: our own height as the hint (targets appear near us)
      const ground = map.groundAt(target.position, target.altitude ?? undefined);
      if (ground != null) target.altitude = ground;
    }
    return target.altitude == null ? 0 : target.altitude - height();
  }

  function burstExplosion(target: TargetState, here: Position, _heading: number, now: number, size: number) {
    const o = eastNorth(here, target.position);
    const jitter = () => (Math.random() - 0.5) * 1.6;
    fx.altitude = height();
    fx.explosion(here, { e: o.east + jitter(), n: o.north + jitter(), u: targetLift(target) + 0.6 + Math.random() * 0.8 }, 0.75 * size, now, size > 1);
  }

  /** when each burning wreck last put out a puff of smoke */
  const fireAt = new WeakMap<TargetState, number>();
  /** the flames on each burning wreck */
  const fires = new Map<TargetState, WreckFire>();
  function putOut(target: TargetState) {
    fires.get(target)?.dispose();
    fires.delete(target);
  }
  const wreckYawScratch = new THREE.Quaternion();
  const wreckEulerScratch = new THREE.Euler(0, 0, 0, 'XYZ');

  function bakeWreckPose(target: TargetState, playerHeading: number) {
    wreckEulerScratch.set(target.spinX, playerHeading - target.heading + target.spinY, target.spinZ, 'XYZ');
    target.wreckQuat = new THREE.Quaternion().setFromEuler(wreckEulerScratch);
    target.wreckBakeHeading = playerHeading;
    // Model origin sits near the wheels; a tipped/rolled car needs a higher rest height.
    const tip = Math.max(Math.abs(Math.sin(target.spinX)), Math.abs(Math.sin(target.spinZ)));
    const roof = Math.max(0, -Math.cos(target.spinX), -Math.cos(target.spinZ));
    target.wreckRestY = 0.45 + tip * 0.85 + roof * 0.55;
  }

  function applyWreckPose(target: TargetState, playerHeading: number) {
    if (!target.wreckQuat) return;
    wreckYawScratch.setFromAxisAngle(new THREE.Vector3(0, 1, 0), playerHeading - target.wreckBakeHeading);
    target.root.quaternion.copy(target.wreckQuat).premultiply(wreckYawScratch);
  }

  function destroyTarget(target: TargetState, now: number, here: Position, heading: number) {
    target.destroyed = true;
    // a wreck's police lights go out
    target.root.traverse((child) => { if (child.userData.beacon) child.visible = false; });
    targetDestroyedHandler(target.id, [...target.position] as Position);
    target.deathPhase = 'tumble';
    target.root.visible = true;
    target.explodedAt = now;
    // About one flip onto the side/roof — not a washing-machine spin.
    const flip = (Math.random() < 0.5 ? 1 : -1) * Math.PI * (0.85 + Math.random() * 0.3);
    if (Math.random() < 0.5) {
      target.spinX = flip;
      target.spinZ = (Math.random() * 2 - 1) * 0.45;
    } else {
      target.spinZ = flip;
      target.spinX = (Math.random() * 2 - 1) * 0.45;
    }
    target.spinY = (Math.random() * 2 - 1) * 0.55;
    target.velUp = 3.6 + Math.random() * 1.6;
    target.blastsLeft = 4 + Math.floor(Math.random() * 3);
    target.nextBlastAt = now;
    target.wreckQuat = null;
    target.wreckBakeHeading = heading;
    target.wreckRestY = 0.45;
    target.charMats = captureCharMats(target.root);
    tintTarget(target, false);
    burstExplosion(target, here, heading, now, 1.35);
    target.blastsLeft -= 1;
    target.nextBlastAt = now + 70 + Math.random() * 90;
  }

  // ---- other players ------------------------------------------------------
  const remotes = new Map<string, { spec: RemoteCar; root: THREE.Group; body: THREE.Group; beam: THREE.Mesh; shadow: THREE.Mesh; path: string; flashUntil: number; flashing: boolean }>();
  /** set by the game: our bullet hit another player's car */
  let remoteHitHandler: (id: string) => boolean = () => false;
  /** set by the game: our bullet hit a target */
  let targetHitHandler: (id: string) => void = () => {};
  let targetDestroyedHandler: (id: string, position: Position) => void = () => {};
  let hoodSmokeAt = 0;
  let trainCoinHandler: (point: Position, altitude: number) => void = () => {};
  /** 0 by day … 1 at night: other players' headlight beams */
  let night = 0;
  // one soft light cone for every other player's car: bright at the lamps, gone 18 m ahead
  const beamGeometry = (() => {
    const g = new THREE.ConeGeometry(3.4, 18, 18, 1, true);
    g.rotateX(-Math.PI / 2); // tip toward -z, opening toward +z (the car's forward)
    g.translate(0, 0, 9);
    g.rotateX(0.08); // aimed a little down the road
    const pos = g.getAttribute('position');
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const k = Math.max(0, 1 - pos.getZ(i) / 18);
      colors.set([1 * k, 0.93 * k, 0.78 * k], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return g;
  })();
  const beamMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  function setRemotes(next: RemoteCar[]) {
    const seen = new Set<string>();
    for (const spec of next) {
      seen.add(spec.id);
      let remote = remotes.get(spec.id);
      if (!remote || remote.path !== spec.car.path) {
        if (remote) { remote.root.remove(remote.beam); scene.remove(remote.root); disposeObject(remote.body); }
        const root = new THREE.Group();
        const body = new THREE.Group();
        body.add(fallbackCar(spec.car.color));
        root.add(body);
        const beam = new THREE.Mesh(beamGeometry, beamMaterial);
        beam.position.set(0, 0.7, spec.car.length * 0.5);
        beam.renderOrder = 8;
        root.add(beam);
        scene.add(root);
        if (remote) { scene.remove(remote.shadow); (remote.shadow.material as THREE.Material).dispose(); }
        remote = { spec, root, body, beam, shadow: makeShadow(spec.car.length, spec.car.length * 0.44), path: spec.car.path, flashUntil: 0, flashing: false };
        remotes.set(spec.id, remote);
        const mine = remote;
        loadCar(spec.car).then((model) => {
          if (disposed || remotes.get(spec.id) !== mine) { disposeObject(model); return; }
          disposeObject(mine.body);
          mine.body.clear();
          mine.body.add(model);
          if (typeof model.userData.width === 'number') shadowScale(mine.shadow, spec.car.length, model.userData.width);
          map?.triggerRepaint();
        }).catch((error: unknown) => console.error(`Failed to load player car ${spec.car.path}`, error));
      }
      remote.spec = spec;
    }
    for (const [id, remote] of remotes) {
      if (seen.has(id)) continue;
      remote.root.remove(remote.beam);
      scene.remove(remote.root);
      scene.remove(remote.shadow);
      (remote.shadow.material as THREE.Material).dispose();
      disposeObject(remote.body);
      remotes.delete(id);
    }
  }

  /**
   * Targets that live beside the missions' (shared traffic, test cars): they come
   * and go by id, and missions neither count nor clear them.
   */
  const extraIds = new Set<string>();

  function removeTarget(id: string) {
    const target = targets.get(id);
    if (!target) return;
    putOut(target);
    scene.remove(target.root);
    disposeObject(target.root);
    scene.remove(target.shadow);
    (target.shadow.material as THREE.Material).dispose();
    scene.remove(target.explosion);
    target.explosion.material.dispose();
    targets.delete(id);
  }

  /** The missions' targets, all replaced at once (the extra ones stay). */
  function setTargets(next: TargetVehicle[]) {
    for (const id of [...targets.keys()]) if (!extraIds.has(id)) removeTarget(id);
    for (const spec of next) addTarget(spec);
    map?.triggerRepaint();
  }

  /** The extra targets: new ids come in, missing ones go, the rest move on. */
  function setExtraTargets(next: TargetVehicle[]) {
    const keep = new Set(next.map((spec) => spec.id));
    for (const id of [...extraIds]) if (!keep.has(id)) { removeTarget(id); extraIds.delete(id); }
    for (const spec of next) {
      const target = targets.get(spec.id);
      if (target) {
        if (!target.destroyed) { target.position = [...spec.position]; target.heading = spec.heading; }
        continue;
      }
      extraIds.add(spec.id);
      addTarget(spec);
    }
  }

  function addTarget(spec: TargetVehicle) {
    {
      const root = new THREE.Group();
      root.add(fallbackCar(spec.car.color));
      scene.add(root);
      const explosion = new THREE.Mesh(
        explosionGeometry,
        new THREE.MeshBasicMaterial({ color: '#ff722b', transparent: true, opacity: 0, depthWrite: false, depthTest: false }),
      );
      explosion.visible = false;
      explosion.renderOrder = 12;
      scene.add(explosion);
      const target: TargetState = {
        ...spec, root, explosion, shadow: makeShadow(spec.car.length, spec.car.length * 0.44), hp: targetMaxHp,
        destroyed: false, deathPhase: null, explodedAt: 0, flashUntil: 0, flashing: false,
        spinX: 0, spinY: 0, spinZ: 0, velUp: 0, blastsLeft: 0, nextBlastAt: 0, charMats: [],
        wreckQuat: null, wreckBakeHeading: 0, wreckRestY: 0.45, altitude: null,
      };
      targets.set(spec.id, target);
      loadCar(spec.car).then(model => {
        if (disposed || targets.get(spec.id) !== target) { disposeObject(model); return; }
        if (typeof model.userData.width === 'number') shadowScale(target.shadow, spec.car.length, model.userData.width);
        disposeObject(root);
        root.clear();
        root.add(model);
        if (target.destroyed) {
          target.charMats = captureCharMats(root);
          if (target.deathPhase === 'wreck') applyChar(target, 1, 0);
          else if (target.deathPhase === 'burn') applyChar(target, 0.7, 0.4);
        }
        map.triggerRepaint();
      }).catch((error: unknown) => {
        if (disposed || targets.get(spec.id) !== target) return;
        console.error(`Failed to load target vehicle model ${spec.car.path}`, error);
      });
    }
  }

  function updateTargets(next: TargetVehicle[]) {
    for (const spec of next) {
      const target = targets.get(spec.id);
      if (!target || target.destroyed) continue;
      target.position = [...spec.position];
      target.heading = spec.heading;
    }
    map?.triggerRepaint();
  }

  /** Height of the ground at a point relative to the car's frame (0 where not known yet). */
  function groundLift(point: Position) {
    const ground = map.groundAt(point);
    return ground == null ? 0 : ground - height();
  }

  function scenePoint(here: Position, point: Position, heading: number, up: number) {
    const offset = eastNorth(here, point);
    return new THREE.Vector3(
      offset.north * Math.sin(heading) - offset.east * Math.cos(heading),
      up,
      offset.north * Math.cos(heading) + offset.east * Math.sin(heading),
    );
  }

  function cameraPose(here: Position, carAlt: number) {
    const center = map.getCenter();
    const pitchRad = map.getPitch() * Math.PI / 180;
    const bearingRad = map.getBearing() * Math.PI / 180;
    const heightPx = map.getCanvas().clientHeight || 1;
    const cos = Math.cos(center.lat * Math.PI / 180);
    const mercPerMeter = 1 / (2 * Math.PI * 6378137 * Math.max(0.05, cos));
    const pixelsPerMeter = mercPerMeter * 512 * 2 ** map.getZoom();
    const distance = (0.5 / Math.tan(0.6435011087932844 / 2) * heightPx) / Math.max(1e-6, pixelsPerMeter);
    const ground = map.groundAt(center) ?? carAlt;
    const camAlt = ground + Math.cos(pitchRad) * distance;
    const horiz = Math.sin(pitchRad) * distance;
    const camPos: Position = [
      center.lng - Math.sin(bearingRad) * horiz / (111319.49 * Math.max(0.05, cos)),
      center.lat - Math.cos(bearingRad) * horiz / 111319.49,
    ];
    const offset = eastNorth(here, camPos);
    return { position: camPos, altitude: camAlt, east: offset.east, north: offset.north, up: camAlt - carAlt };
  }

  function fire(now: number, heading: number, here: Position) {
    const water = currentCar.id === WATER_TRUCK_ID;
    if (!aim || !map || now - lastShot < (water ? 32 : 50)) return;
    lastShot = now;
    const carAlt = height();

    // Hose: mouse Y = launch elevation; azimuth toward the aim. No auto-hit —
    // short/long means aim higher/lower or drive closer/farther.
    if (water) {
      const gunFwd = currentCar.length * 0.28;
      const gunUp = 1.15;
      const p = pitch(), r = roll();
      const cp = Math.cos(p), sp = Math.sin(p), cr = Math.cos(r), sr = Math.sin(r);
      const f1 = gunFwd * cp - gunUp * sp, u1 = gunFwd * sp + gunUp * cp;
      const f2 = f1, u2 = u1 * cr, r2 = u1 * sr;
      const gunEast = Math.sin(heading) * f2 + Math.cos(heading) * r2;
      const gunNorth = Math.cos(heading) * f2 - Math.sin(heading) * r2;
      const muzzleAt: Enu = { e: gunEast, n: gunNorth, u: u2 };
      const ground = eastNorth(here, aim.ground);
      let dirE = ground.east - gunEast, dirN = ground.north - gunNorth;
      if (Math.hypot(dirE, dirN) < 0.5) {
        dirE = Math.sin(heading);
        dirN = Math.cos(heading);
      }
      const canvasH = map.getCanvas().clientHeight || 1;
      // top of screen → steep (~52°), bottom → flat (0°)
      const t = 1 - Math.max(0, Math.min(1, aim.screen[1] / canvasH));
      const elev = (t * 52) * Math.PI / 180;
      const landAlt = (map.groundAt(aim.ground) ?? carAlt) - carAlt;
      fx.altitude = carAlt;
      const { flightMs, land } = fx.hose(here, muzzleAt, dirE, dirN, elev, landAlt, now);
      // walk the lob: first burning façade pane near the jet wins, else ground splash
      let houseHit: { e: number; n: number; u: number; fresh: boolean; at: Position; altitude: number } | null = null;
      for (const pt of fx.hoseArc(muzzleAt, dirE, dirN, elev, landAlt, 28)) {
        const hit = burningHouse.douseAt(here, carAlt, pt, now, 1.85);
        if (hit) { houseHit = hit; break; }
      }
      const splashAt = houseHit ?? land;
      const splashNormal: Enu = houseHit
        ? { e: muzzleAt.e - splashAt.e, n: muzzleAt.n - splashAt.n, u: 0.35 }
        : { e: 0, n: 0, u: 1 };
      if (flightMs > 0) fx.splash(here, splashAt, splashNormal, now + flightMs, houseHit ? 1.05 : 0.85);
      if (houseHit?.fresh) {
        const de = splashAt.e - muzzleAt.e, dn = splashAt.n - muzzleAt.n;
        const hl = Math.hypot(de, dn) || 1;
        fx.windowSteam(here, splashAt, { e: de / hl, n: dn / hl }, 1, now + flightMs);
        // cracked / sooty glass on the real façade
        {
          const from = offsetPosition(here, splashAt.e - (de / hl) * 1.4, splashAt.n - (dn / hl) * 1.4);
          map?.raycastBuildings(from, carAlt + splashAt.u, houseHit.at, houseHit.altitude, true);
        }
        map?.setFirePanes(burningHouse.fireMarkers());
        onFireWindowOut(burningHouse.burningLeft());
      }
      return;
    }

    const groundAlt = map.groundAt(aim.ground) ?? carAlt;
    const ground = eastNorth(here, aim.ground);
    const radius = 2.15;
    /** first car (target or another player) an upright-cylinder test finds along a ray, before maxT */
    const firstCar = (oe: number, ou: number, on: number, ue: number, uu: number, un: number, maxT: number) => {
      let best: { t: number; up: number } | null = null;
      const test = (position: Position, rel: number) => {
        const delta = eastNorth(here, position);
        const ox = oe - delta.east, oz = on - delta.north;
        const a = ue * ue + un * un;
        if (a < 1e-8) return;
        const b = 2 * (ox * ue + oz * un), c = ox * ox + oz * oz - radius * radius;
        const disc = b * b - 4 * a * c;
        if (disc < 0) return;
        const t = (-b - Math.sqrt(disc)) / (2 * a);
        if (t < 1.2 || t > (best?.t ?? maxT)) return;
        const up = ou + uu * t;
        if (up < rel - 0.4 || up > rel + 2.6) return;
        best = { t, up: Math.max(rel + 0.35, Math.min(rel + 1.6, up)) };
      };
      for (const target of targets.values()) if (!target.destroyed) test(target.position, targetLift(target));
      for (const remote of remotes.values()) test(remote.spec.position, remote.spec.altitude - carAlt);
      return best as { t: number; up: number } | null;
    };

    // 1. What the cursor points at, as the camera sees it: the first wall or car on its
    //    ray, else the ground. Moving the mouse up a wall moves the aim up the wall.
    let aimE = ground.east, aimN = ground.north, aimU = groundAlt - carAlt, aimGround = true;
    {
      const view = cameraPose(here, carAlt);
      const vx = ground.east - view.east, vy = aimU - view.up, vz = ground.north - view.north;
      const vl = Math.hypot(vx, vy, vz);
      if (vl > 1) {
        let near = vl;
        const car = firstCar(view.east, view.up, view.north, vx / vl, vy / vl, vz / vl, vl);
        if (car) {
          near = car.t;
          aimE = view.east + vx / vl * car.t; aimN = view.north + vz / vl * car.t; aimU = car.up;
          aimGround = false;
        }
        const w = resolveShot(view.position, view.altitude, aim.ground, groundAlt, false);
        if (w) {
          const d = eastNorth(here, w.point);
          const wt = ((d.east - view.east) * vx + (w.altitude - carAlt - view.up) * vy + (d.north - view.north) * vz) / vl;
          if (wt > 1 && wt < near) { aimE = d.east; aimN = d.north; aimU = w.altitude - carAlt; aimGround = false; }
        }
      }
    }

    // 2. The bullet leaves the nose; the hose sits on the middle of the hood (body frame + lean).
    const gunFwd = water ? currentCar.length * 0.28 : 1.7;
    const gunUp = water ? 1.15 : 0.85;
    let gunEast: number, gunNorth: number, gunAlt = gunUp;
    if (water) {
      // stick to the hood when the truck pitches / rolls, so turns don't drift the spout
      const p = pitch(), r = roll();
      const cp = Math.cos(p), sp = Math.sin(p), cr = Math.cos(r), sr = Math.sin(r);
      const f1 = gunFwd * cp - gunUp * sp, u1 = gunFwd * sp + gunUp * cp;
      const f2 = f1, u2 = u1 * cr, r2 = u1 * sr;
      gunEast = Math.sin(heading) * f2 + Math.cos(heading) * r2;
      gunNorth = Math.cos(heading) * f2 - Math.sin(heading) * r2;
      gunAlt = u2;
    } else {
      gunEast = Math.sin(heading) * gunFwd;
      gunNorth = Math.cos(heading) * gunFwd;
    }

    // Spread: the farther the aim, the wider the bullets scatter round it. A car is ~2 m
    // across: up close every shot lands, at 80 m nearly all do, at 150 m about two in three.
    if (!water) {
      const d = Math.hypot(aimE - gunEast, aimN - gunNorth);
      const scatter = 0.1 + d * 0.008 + d * d * 0.00005;
      // two randoms averaged: most shots near the middle, a few wide
      const r = scatter * (Math.random() + Math.random());
      const angle = Math.random() * Math.PI * 2;
      const side = d > 1e-3 ? { e: -(aimN - gunNorth) / d, n: (aimE - gunEast) / d } : { e: 1, n: 0 };
      // on the ground the scatter lies flat on it (short and long), on a car or wall it goes up and down
      const across = Math.cos(angle) * r, other = Math.sin(angle) * r * 0.5;
      aimE += side.e * across;
      aimN += side.n * across;
      if (aimGround) { aimE += side.n * other; aimN -= side.e * other; } else aimU += other;
    }
    const groundMark = aimGround ? offsetPosition(here, aimE, aimN) as Position : aim.ground;
    const cam = { position: offsetPosition(here, gunEast, gunNorth) as Position, altitude: carAlt + gunAlt, east: gunEast, north: gunNorth, up: gunAlt };
    const dx = aimE - cam.east;
    const dy = aimU - cam.up;
    const dz = aimN - cam.north;
    const rayLen = Math.hypot(dx, dy, dz);
    if (rayLen < 1) return;
    const ux = dx / rayLen;
    const uy = dy / rayLen;
    const uz = dz / rayLen;
    // water hose: ~40 m; guns keep the long rifle reach
    const reach = water ? Math.min(rayLen * 1.02, 40) : aimGround ? Math.min(rayLen * 1.02, 160) : 160;
    const far = offsetPosition(here, cam.east + ux * reach, cam.north + uz * reach) as Position;
    const farAlt = carAlt + cam.up + uy * reach;

    let bestT = reach;
    let hit: TargetState | null = null;
    let hitUp = cam.up + uy * bestT;
    for (const target of targets.values()) {
      if (target.destroyed) continue;
      const delta = eastNorth(here, target.position);
      const ox = cam.east - delta.east;
      const oz = cam.north - delta.north;
      const a = ux * ux + uz * uz;
      if (a < 1e-8) continue;
      const b = 2 * (ox * ux + oz * uz);
      const c = ox * ox + oz * oz - radius * radius;
      const disc = b * b - 4 * a * c;
      if (disc < 0) continue;
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      if (t < 1.2 || t > bestT) continue;
      const up = cam.up + uy * t;
      const rel = targetLift(target);
      if (up < rel - 0.4 || up > rel + 2.6) continue;
      bestT = t;
      hit = target;
      hitUp = Math.max(rel + 0.35, Math.min(rel + 1.6, up));
    }

    // other players' cars: the same upright cylinder, at their own height
    let remoteHit: string | null = null;
    for (const remote of remotes.values()) {
      const delta = eastNorth(here, remote.spec.position);
      const ox = cam.east - delta.east;
      const oz = cam.north - delta.north;
      const a = ux * ux + uz * uz;
      if (a < 1e-8) continue;
      const b = 2 * (ox * ux + oz * uz);
      const c = ox * ox + oz * oz - radius * radius;
      const disc = b * b - 4 * a * c;
      if (disc < 0) continue;
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      if (t < 1.2 || t > bestT) continue;
      const rel = remote.spec.altitude - carAlt;
      const up = cam.up + uy * t;
      if (up < rel - 0.4 || up > rel + 2.6) continue;
      bestT = t;
      hit = null;
      remoteHit = remote.spec.id;
      hitUp = Math.max(rel + 0.35, Math.min(rel + 1.6, up));
    }

    const wall = resolveShot(cam.position, cam.altitude, far, farAlt, false);
    let wallHit = false;
    let groundHit = false;
    if (wall) {
      const wallDelta = eastNorth(here, wall.point);
      const wallT = (wallDelta.east - cam.east) * ux + (wall.altitude - carAlt - cam.up) * uy + (wallDelta.north - cam.north) * uz;
      if (wallT > 1 && wallT < bestT) {
        hit = null;
        remoteHit = null;
        bestT = wallT;
        hitUp = wall.altitude - carAlt;
        wallHit = true;
        // water leaves no bullet holes / doesn't topple props
        if (!water) resolveShot(cam.position, cam.altitude, far, farAlt, true);
      }
    }
    // trains: hard to the bullet, nothing to break; a vintage one coughs up a coin
    let trainHit: { vintage: boolean } | null = null;
    const train = resolveTrain(cam.position, cam.altitude, far, farAlt);
    if (train) {
      const td = eastNorth(here, train.point);
      const tt = (td.east - cam.east) * ux + (train.altitude - carAlt - cam.up) * uy + (td.north - cam.north) * uz;
      if (tt > 1 && tt < bestT) {
        hit = null; remoteHit = null; wallHit = false;
        bestT = tt;
        hitUp = train.altitude - carAlt;
        trainHit = { vintage: train.vintage };
        if (!water && train.vintage) trainCoinHandler(train.point, train.altitude);
      }
    }
    if (!hit && !wallHit && !remoteHit && !trainHit && aimGround) {
      bestT = Math.min(bestT, rayLen);
      hitUp = groundAlt - carAlt;
      groundHit = true;
      if (!water) markGround(groundMark, groundAlt);
    }

    const end = offsetPosition(here, cam.east + ux * bestT, cam.north + uz * bestT);
    // world-space (east, north, up) shot geometry for the effects
    const muzzleAt: Enu = water
      ? { e: gunEast, n: gunNorth, u: gunAlt }
      : { e: gunEast + Math.sin(heading) * 0.2, n: gunNorth + Math.cos(heading) * 0.2, u: gunUp };
    const endEn = eastNorth(here, end);
    const hitAt: Enu = { e: endEn.east, n: endEn.north, u: hitUp };
    const shotLen = Math.hypot(hitAt.e - muzzleAt.e, hitAt.n - muzzleAt.n, hitAt.u - muzzleAt.u) || 1;
    const shotDir: Enu = { e: (hitAt.e - muzzleAt.e) / shotLen, n: (hitAt.n - muzzleAt.n) / shotLen, u: (hitAt.u - muzzleAt.u) / shotLen };
    const bounce: Enu = { e: -shotDir.e, n: -shotDir.n, u: Math.max(0.35, -shotDir.u) };
    fx.altitude = carAlt;

    const muzzle = offsetPosition(here, Math.sin(heading) * 1.7, Math.cos(heading) * 1.7);
    const startPoint = scenePoint(here, muzzle, heading, 0.85);
    const endPoint = scenePoint(here, end, heading, hitUp);
    const bulletLength = Math.min(2.2, Math.max(0.65, bestT * 0.12));
    const dashCount = Math.random() < 0.55 ? 1 : 2;
    for (let dash = 0; dash < dashCount; dash++) {
      const along = Math.min(bestT * 0.72, 5 + dash * 6 + Math.random() * 2);
      const from = new THREE.Vector3(
        startPoint.x + (endPoint.x - startPoint.x) * (along / Math.max(bestT, 1)),
        startPoint.y + (endPoint.y - startPoint.y) * (along / Math.max(bestT, 1)),
        startPoint.z + (endPoint.z - startPoint.z) * (along / Math.max(bestT, 1)),
      );
      const to = new THREE.Vector3(
        startPoint.x + (endPoint.x - startPoint.x) * ((along + bulletLength) / Math.max(bestT, 1)),
        startPoint.y + (endPoint.y - startPoint.y) * ((along + bulletLength) / Math.max(bestT, 1)),
        startPoint.z + (endPoint.z - startPoint.z) * ((along + bulletLength) / Math.max(bestT, 1)),
      );
      tracerPositions.set([from.x, from.y, from.z, to.x, to.y, to.z], dash * 6);
    }
    (tracerGeometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    tracerGeometry.computeBoundingSphere();
    tracerGeometry.setDrawRange(0, dashCount * 2);
    tracer.visible = true;
    tracerUntil = now + 90;
    fx.muzzle(here, muzzleAt, shotDir, now);
    fx.tracer(here, muzzleAt, hitAt, now);
    tracer.visible = false; // the particle streak replaces the 1px line
    if (remoteHit) {
      fx.impact(here, hitAt, bounce, now, { scale: 1 });
      const struck = remotes.get(remoteHit);
      if (remoteHitHandler(remoteHit) && struck) struck.flashUntil = now + 130;
    } else if (hit) {
      targetHitHandler(hit.id);
      hit.hp = Math.max(0, hit.hp - targetDamagePerShot);
      if (hit.hp === 0) {
        destroyTarget(hit, now, here, heading);
      } else {
        hit.flashUntil = now + 130;
        fx.impact(here, hitAt, bounce, now, { scale: 1 });
      }
    } else if (trainHit) {
      // a vintage train gives a coin instead of a scar; a modern one just sparks
      if (!trainHit.vintage) fx.impact(here, hitAt, bounce, now, { scale: 0.8 });
    } else if (wallHit || groundHit) {
      const normal: Enu = groundHit ? { e: bounce.e * 0.4, n: bounce.n * 0.4, u: 1 } : bounce;
      fx.impact(here, hitAt, normal, now, { scale: groundHit ? 0.7 : 0.9, dust: true });
    }
  }

  function tintTarget(target: TargetState, active: boolean) {
    if (target.flashing === active) return;
    target.flashing = active;
    tintVehicle(target.root, active);
  }

  function tintVehicle(vehicleRoot: THREE.Group, active: boolean) {
    vehicleRoot.traverse(child => {
      if (!(child instanceof THREE.Mesh)) return;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        if (!(material instanceof THREE.MeshPhongMaterial)) continue;
        material.emissive.set(active ? '#ff160b' : '#000000');
        material.emissiveIntensity = active ? 2.2 : 1;
      }
    });
  }

  const spawn = (side: number, now: number) => {
    const lean = pitch();
    const howler = currentCar.id === '03';
    // Howler: twin stacks behind the cab, straight up; others: rear pipes
    const len = currentCar.length;
    const back = howler ? -len * 0.12 : -len * 0.56;
    const rise = howler ? 1.85 : 0.55;
    const x = side * (howler ? 0.38 + Math.random() * 0.06 : 0.62 + Math.random() * 0.12);
    // nose-up lean lowers the tail pipe / tips the stacks
    const y = rise * Math.cos(lean) + back * Math.sin(lean);
    const z = -rise * Math.sin(lean) + back * Math.cos(lean);
    const heading = vehicle.heading;
    const puff = puffs[cursor % puffs.length];
    cursor += 1;
    puff.active = true;
    puff.place = offsetPosition(vehicle.position, -x * Math.cos(heading) + z * Math.sin(heading), x * Math.sin(heading) + z * Math.cos(heading));
    if (howler) {
      // only rise — motion leaves the plume behind
      puff.east = (Math.random() - 0.5) * 0.08;
      puff.north = (Math.random() - 0.5) * 0.08;
      puff.rise = 3.2 + Math.random() * 1.2;
      puff.life = 1400 + Math.random() * 500;
      puff.size = 1.15 + Math.random() * 0.45;
    } else {
      const backPush = 0.7 + Math.random() * 0.5;
      puff.east = -Math.sin(heading) * backPush + (Math.random() - 0.5) * 0.1;
      puff.north = -Math.cos(heading) * backPush + (Math.random() - 0.5) * 0.1;
      puff.rise = 0.7;
      puff.life = 1100 + Math.random() * 400;
      puff.size = 0.9 + Math.random() * 0.35;
    }
    puff.up = y;
    puff.born = now;
    puff.mesh.visible = true;
  };
  /** our body's width (m): the tyre tracks sit under its wheels */
  let carWidth = 1.9;
  /** our police lights (F): the glow shown or hidden, the lamps lit or dull */
  let beaconsOn = true;
  function applyBeacons() {
    root.traverse((child) => {
      if (!child.userData.beacon) return;
      if (child.userData.halo) child.visible = beaconsOn;
      else if (child instanceof THREE.Mesh && child.userData.color) {
        const color = child.userData.color as 'red' | 'blue';
        child.material = beaconsOn ? beaconMats[color] : beaconOffMats[color];
      }
    });
    map?.triggerRepaint();
  }
  function installCarModel(model: THREE.Group) {
    for (const child of [...root.children]) {
      root.remove(child);
      disposeObject(child);
    }
    root.clear();
    root.add(model);
    applyBeacons();
    if (typeof model.userData.width === 'number') carWidth = model.userData.width;
    shadowScale(playerShadow, currentCar.length, carWidth);
    map?.triggerRepaint();
  }

  function loadPlayerCar(next: Car, announce: boolean) {
    currentCar = next;
    const token = ++carLoadToken;
    loadCar(next).then((model) => {
      if (disposed || token !== carLoadToken) { disposeObject(model); return; }
      installCarModel(model);
      if (announce) status(t('status.ready'));
    }).catch((error: unknown) => {
      if (disposed || token !== carLoadToken) return;
      console.error('Failed to load vehicle model', error);
      installCarModel(fallbackCar(next.color));
      if (announce) status(t('car.fallback'));
    });
  }

  return {
    id: 'vehicle',
    type: 'custom',
    setAim(next) { aim = next; },
    aimTarget() {
      if (!aim || !map) return null;
      const carAlt = height();
      const groundAlt = map.groundAt(aim.ground) ?? carAlt;
      const view = cameraPose(vehicle.position, carAlt);
      const wall = resolveShot(view.position, view.altitude, aim.ground, groundAlt, false);
      return wall ? { position: wall.point, altitude: wall.altitude, wall: true } : { position: [...aim.ground] as Position, altitude: groundAlt, wall: false };
    },
    setFiring(value) { firing = value; },
    flashPlayer(duration) { playerFlashUntil = Math.max(playerFlashUntil, performance.now() + duration); },
    burnPlayer() {
      const now = performance.now();
      if (now - hoodSmokeAt < 40 || !map) return;
      hoodSmokeAt = now;
      const h = vehicle.heading;
      fx.altitude = height();
      fx.burning(vehicle.position, { e: Math.sin(h) * 1.5, n: Math.cos(h) * 1.5, u: 0.95 }, 0.8, now);
    },
    enemyShot(fromId, hit) {
      const target = targets.get(fromId);
      if (!target || target.destroyed || !map) return;
      const now = performance.now();
      const here = vehicle.position;
      const o = eastNorth(here, target.position);
      const lift = targetLift(target);
      const muzzleAt: Enu = { e: o.east + Math.sin(target.heading) * 1.9, n: o.north + Math.cos(target.heading) * 1.9, u: lift + 0.9 };
      // on us: somewhere on the body; a miss lands a couple of metres to the side
      const spread = hit ? 0.6 : 2 + Math.random() * 2.5;
      const side = Math.random() < 0.5 ? -1 : 1;
      const dx = -muzzleAt.e, dn = -muzzleAt.n;
      const len = Math.hypot(dx, dn) || 1;
      const hitAt: Enu = {
        e: (Math.random() - 0.5) * 0.8 + (-dn / len) * spread * side * (hit ? 0.5 : 1),
        n: (Math.random() - 0.5) * 0.8 + (dx / len) * spread * side * (hit ? 0.5 : 1),
        u: hit ? 0.5 + Math.random() * 0.6 : 0.05,
      };
      const shotLen = Math.hypot(hitAt.e - muzzleAt.e, hitAt.n - muzzleAt.n, hitAt.u - muzzleAt.u) || 1;
      const dir: Enu = { e: (hitAt.e - muzzleAt.e) / shotLen, n: (hitAt.n - muzzleAt.n) / shotLen, u: (hitAt.u - muzzleAt.u) / shotLen };
      fx.altitude = height();
      fx.muzzle(here, muzzleAt, dir, now);
      fx.tracer(here, muzzleAt, hitAt, now);
      if (hit) fx.impact(here, hitAt, { e: -dir.e, n: -dir.n, u: Math.max(0.35, -dir.u) }, now, { scale: 0.9 });
      else fx.impact(here, hitAt, { e: 0, n: 0, u: 1 }, now, { scale: 0.6, dust: true });
    },
    get onRemoteHit() { return remoteHitHandler; },
    set onRemoteHit(handler: (id: string) => boolean) { remoteHitHandler = handler; },
    explodePlayer() {
      const here = vehicle.position;
      const now = performance.now();
      fx.altitude = height();
      fx.explosion(here, { e: 0, n: 0, u: 0.9 }, 1.1, now, true);
      fx.explosion(here, { e: 0.8, n: -0.6, u: 1.2 }, 0.8, now + 140, false);
      playerFlashUntil = Math.max(playerFlashUntil, now + 600);
    },
    setCar(next) {
      if (next.id === currentCar.id && next.path === currentCar.path) return;
      loadPlayerCar(next, false);
    },
    setTargets,
    setExtraTargets,
    setTargetHp(id, hp) {
      const target = targets.get(id);
      if (!target || target.destroyed) return;
      if (hp <= 0) { target.hp = 0; destroyTarget(target, performance.now(), vehicle.position, vehicle.heading); return; }
      if (Math.abs(target.hp - hp) < 1) return;
      target.hp = Math.min(targetMaxHp, hp);
    },
    extraHealth: () => [...extraIds].map((id) => targets.get(id)).filter((t): t is TargetState => Boolean(t && !t.destroyed))
      .map((t) => ({ id: t.id, driver: t.driver, color: t.car.color, hp: t.hp, maxHp: targetMaxHp, position: t.position })),
    targetHp: (id) => {
      const target = targets.get(id);
      return target ? (target.destroyed ? 0 : target.hp) : null;
    },
    get onTargetHit() { return targetHitHandler; },
    set onTargetHit(handler: (id: string) => void) { targetHitHandler = handler; },
    get onTrainCoin() { return trainCoinHandler; },
    set onTrainCoin(handler: (point: Position, altitude: number) => void) { trainCoinHandler = handler; },
    get onTargetDestroyed() { return targetDestroyedHandler; },
    set onTargetDestroyed(handler: (id: string, position: Position) => void) { targetDestroyedHandler = handler; },
    setRemotes,
    updateTargets,
    flashTarget(id, duration) {
      const target = targets.get(id);
      if (target && !target.destroyed) target.flashUntil = Math.max(target.flashUntil, performance.now() + duration);
    },
    damageTarget(id, amount) {
      const target = targets.get(id);
      if (!target || target.destroyed || amount <= 0) return false;
      target.hp = Math.max(0, target.hp - amount);
      target.flashUntil = Math.max(target.flashUntil, performance.now() + 160);
      if (target.hp === 0) {
        const here = vehicle.position;
        destroyTarget(target, performance.now(), here, vehicle.heading);
      }
      return true;
    },
    aliveTargetCount: () => [...targets.values()].filter(target => !target.destroyed && !extraIds.has(target.id)).length,
    isTargetAlive: id => {
      const target = targets.get(id);
      return Boolean(target && !target.destroyed);
    },
    targetHealth: () => [...targets.values()].filter(target => !extraIds.has(target.id)).map(target => ({
      id: target.id,
      driver: target.driver,
      color: target.car.color,
      hp: target.destroyed ? 0 : target.hp,
      maxHp: targetMaxHp,
    })),
    setPickups,
    movePickup(id, position) {
      const pickup = pickups.get(id);
      if (!pickup) return;
      pickup.position = [...position] as Position;
      pickup.ground = null;
      pickup.drop = undefined;
    },
    setMissionBeacons,
    setRaceFinish,
    setFireHouse(site) {
      if (!site) {
        burningHouse.clear();
        map?.setFirePanes([]);
        return;
      }
      burningHouse.ignite(site.panes);
      map?.setFirePanes(burningHouse.fireMarkers());
    },
    fireWindowsLeft() { return burningHouse.placed ? burningHouse.burningLeft() : null; },
    get onFireWindowOut() { return onFireWindowOut; },
    set onFireWindowOut(handler: (left: number) => void) { onFireWindowOut = handler; },
    setBeacons(on) { beaconsOn = on; applyBeacons(); },
    setCarried(pose) { carried = pose ? { ...pose, position: [...pose.position] as Position } : null; map?.triggerRepaint(); },
    setCable(to) { cableTo = to ? { position: [...to.position] as Position, up: to.up, wave: to.wave ?? 0 } : null; map?.triggerRepaint(); },
    setRamp,
    scene,
    placement,
    fuse() { fused = true; },
    // the beams are lit by the world shaders; no lens discs (they never sit on every model's lamps)
    setHeadlights(on) {
      night = on;
      fx.light = 1 - 0.75 * Math.min(1, on); // smoke and dust are not lit by the scene: dim them at night
    },
    onAdd(nextMap, gl) {
      map = nextMap;
      if (!fused) {
        renderer = new THREE.WebGLRenderer({ canvas: nextMap.getCanvas(), context: gl as WebGL2RenderingContext, antialias: true });
        renderer.autoClear = false;
      }
      loadPlayerCar(currentCar, true);
    },
    render(_gl, args) {
      const now = performance.now();
      const dt = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 0;
      lastFrame = now;
      const here = vehicle.position;
      const heading = vehicle.heading;
      const carAlt = height();
      fx.altitude = carAlt;
      // façade smoke is throttled — every window every frame was killing FPS
      if (burningHouse.placed && now - lastHouseFx > 90) {
        lastHouseFx = now;
        for (const puff of burningHouse.fxEmitters(here, carAlt, now)) {
          if (puff.mode === 'smoke') fx.windowSmoke(here, puff, { e: puff.oe, n: puff.on }, now);
          else fx.windowSteam(here, puff, { e: puff.oe, n: puff.on }, puff.strength, now);
        }
      }
      if (vehicle.throttle && now - lastSpawn > 45) {
        lastSpawn = now;
        spawn(1, now);
        spawn(-1, now);
      }
      const drift = vehicle.slip ?? 0, speed = vehicle.speed ?? 0;
      const slip = Math.abs(drift);
      if (slip > 0.28 && Math.abs(speed) > 3) {
        const dustGap = 45 - Math.min(25, slip * 20);
        if (now - lastDust > dustGap) {
          lastDust = now;
          // what the rear wheels are on, looked up a few times a second
          if (now - surfaceAt > 150) {
            surfaceAt = now;
            const rear = offsetPosition(here, -Math.sin(heading) * currentCar.length * 0.36, -Math.cos(heading) * currentCar.length * 0.36);
            surface = map?.surfaceAt(rear) ?? 'paved';
          }
          fx.altitude = height();
          fx.driftDust(here, heading, drift, speed, currentCar.length, now, surface);
        }
      }
      if (firing) fire(now, heading, here);
      const flashPlayer = now < playerFlashUntil;
      if (playerFlashing !== flashPlayer) {
        playerFlashing = flashPlayer;
        tintVehicle(root, flashPlayer);
      }
      tracer.visible = tracer.visible && now < tracerUntil;
      beamMaterial.opacity = 0.22 * night;
      for (const remote of remotes.values()) {
        const { spec, root: car, beam } = remote;
        // past the fog there is nothing to see
        const offset = scenePoint(here, spec.position, heading, spec.altitude - height());
        car.visible = Math.hypot(offset.x, offset.z) < 1600;
        car.position.copy(offset);
        {
          const ground = (map.groundAt(spec.position) ?? spec.altitude) - height();
          layShadow(remote.shadow, offset.x, ground, offset.z, heading - spec.heading, offset.y - ground);
          remote.shadow.visible &&= car.visible;
        }
        // hit: a red flash (their health is the overhead meter, as for bots)
        const flashing = now < remote.flashUntil;
        if (flashing !== remote.flashing) { remote.flashing = flashing; tintVehicle(remote.body, flashing); }
        // yaw, then the lean on slopes: pitch about the car's side, roll about its length
        car.rotation.order = 'YXZ';
        car.rotation.set(-spec.pitch, heading - spec.heading, spec.roll);
        beam.visible = night > 0.02;
      }
      // the cable: from our car's middle (its centre of mass) to the hook, in a travelling wave
      cable.visible = Boolean(cableTo);
      if (cableTo) {
        const from = scenePoint(here, here, heading, 0.9), to = scenePoint(here, cableTo.position, heading, cableTo.up);
        const span = to.clone().sub(from);
        const length = Math.max(0.01, span.length());
        // sideways and a little up, across the line
        const side = new THREE.Vector3(-span.z, 0, span.x).normalize();
        if (!Number.isFinite(side.x)) side.set(1, 0, 0);
        const amp = Math.min(0.45, length * 0.06) * cableTo.wave;
        for (let i = 0; i < CABLE_POINTS; i++) {
          const s = i / (CABLE_POINTS - 1);
          const swing = amp * Math.sin(s * Math.PI * 2.5 - now * 0.045) * Math.sin(Math.PI * s);
          cablePositions[i * 3] = from.x + span.x * s + side.x * swing;
          cablePositions[i * 3 + 1] = from.y + span.y * s + swing * 0.35;
          cablePositions[i * 3 + 2] = from.z + span.z * s + side.z * swing;
        }
        cableGeometry.attributes.position.needsUpdate = true;
      }
      for (const target of targets.values()) {
        // held by the hauler: where it is put, not on its own ground
        const held = carried && carried.id === target.id && !target.destroyed ? carried : null;
        const offset = held ? scenePoint(here, held.position, heading, held.up) : scenePoint(here, target.position, heading, targetLift(target));
        // a wreck or a car up on the hauler casts none on the road
        if (target.destroyed || held) target.shadow.visible = false;
        else layShadow(target.shadow, offset.x, offset.y, offset.z, heading - target.heading, 0);
        if (target.destroyed) {
          const age = now - target.explodedAt;
          const tumbleMs = 1100;
          if (target.blastsLeft > 0 && now >= target.nextBlastAt) {
            burstExplosion(target, here, heading, now, 0.75 + Math.random() * 0.55);
            target.blastsLeft -= 1;
            target.nextBlastAt = now + 60 + Math.random() * 110;
          }
          if (target.explosion.visible) {
            const blastAge = Math.max(0, now - (target.nextBlastAt - 120));
            const fade = Math.min(1, blastAge / 180);
            target.explosion.scale.setScalar(0.35 + fade * 2.4);
            target.explosion.material.opacity = Math.max(0, 1 - fade);
            if (fade >= 1 && target.blastsLeft <= 0) target.explosion.visible = false;
          }
          if (target.deathPhase === 'tumble') {
            const t = Math.min(1, age / tumbleMs);
            const tip = Math.max(Math.abs(Math.sin(target.spinX * t)), Math.abs(Math.sin(target.spinZ * t)));
            const rest = 0.45 + tip * 0.85;
            const arc = Math.max(rest, target.velUp * t - 7.2 * t * t + rest * t * t);
            target.root.visible = true;
            target.root.position.copy(offset);
            target.root.position.y += arc;
            target.root.rotation.set(target.spinX * t, heading - target.heading + target.spinY * t, target.spinZ * t);
            applyChar(target, t * 0.25, 0.55 * (1 - t));
            if (t >= 1) {
              bakeWreckPose(target, heading);
              target.deathPhase = 'burn';
              target.root.position.copy(offset);
              target.root.position.y += target.wreckRestY;
              applyWreckPose(target, heading);
            }
          } else if (target.deathPhase === 'burn') {
            // a couple of seconds of real fire on the wreck, then it smoulders out
            const burn = Math.min(1, (age - tumbleMs) / 2800);
            target.root.position.copy(offset);
            target.root.position.y += target.wreckRestY;
            applyWreckPose(target, heading);
            applyChar(target, 0.35 + burn * 0.65, 0);
            const strength = burn < 0.7 ? 1 : (1 - burn) / 0.3;
            // flames rooted on the wreck (a shader, they flicker in place)
            let fire = fires.get(target);
            if (!fire) {
              fire = new WreckFire(target.car.length);
              fires.set(target, fire);
              scene.add(fire.group);
            }
            fire.group.position.copy(target.root.position);
            fire.group.position.y -= target.wreckRestY * 0.6;
            fire.group.rotation.y = target.root.rotation.y;
            fire.strength = strength;
            // black smoke and a spark now and then, as particles
            if (now - (fireAt.get(target) ?? 0) > 35) {
              fireAt.set(target, now);
              const o = eastNorth(here, target.position);
              fx.altitude = height();
              fx.burning(here, { e: o.east, n: o.north, u: targetLift(target) + target.wreckRestY + 0.3 }, strength, now);
            }
            if (burn >= 1) {
              putOut(target);
              target.deathPhase = 'wreck';
              applyChar(target, 1, 0);
            }
          } else {
            target.root.position.copy(offset);
            target.root.position.y += target.wreckRestY;
            applyWreckPose(target, heading);
          }
          continue;
        }
        target.root.position.copy(offset);
        // a held car leans with the truck under it (pitch > 0: nose up)
        target.root.rotation.order = 'YXZ';
        target.root.rotation.set(held ? -(held.pitch ?? 0) : 0, heading - (held ? held.heading : target.heading), 0);
        tintTarget(target, now < target.flashUntil);
      }
      for (const pickup of pickups.values()) {
        // stand on the ground under the pickup, not at the car's height
        if (pickup.ground == null) pickup.ground = map.groundAt(pickup.position);
        const lift = (pickup.ground ?? height()) - height();
        if (pickup.coin && pickup.drop && now < pickup.drop.at + DROP_MS) {
          // thrown out of a wreck: rolls out a couple of metres, three bounces getting lower
          const t = Math.max(0, (now - pickup.drop.at) / DROP_MS);
          const roll = 1 - (1 - t) ** 3;
          const { from } = pickup.drop;
          const at: Position = [from[0] + (pickup.position[0] - from[0]) * roll, from[1] + (pickup.position[1] - from[1]) * roll];
          const hop = 1.5 * Math.abs(Math.sin(Math.PI * 3 * t)) * (1 - t) ** 1.6
            // thrown from up on a train car: falls from there first
            + Math.max(0, (pickup.drop.up ?? 0) - 0.62) * Math.max(0, 1 - t * 3) ** 2;
          pickup.mesh.position.copy(scenePoint(here, at, heading, lift + 0.62 + hop));
          pickup.mesh.rotation.y = now * 0.012 + pickup.phase;
        } else if (pickup.coin) {
          // 1 m coin hovering just above the road, turning about its upright axis
          pickup.mesh.position.copy(scenePoint(here, pickup.position, heading, lift + 0.62 + Math.sin(now * 0.0018 + pickup.phase) * 0.08));
          pickup.mesh.rotation.y = now * 0.0032 + pickup.phase;
        } else {
          pickup.mesh.position.copy(scenePoint(here, pickup.position, heading, lift + 0.42 + Math.sin(now * 0.002 + pickup.phase) * 0.07));
          pickup.mesh.rotation.y = now * 0.0007;
        }
      }
      if (ramp) {
        // grow in / shrink away over a quarter second instead of popping
        rampShown += Math.sign(rampTarget - rampShown) * Math.min(Math.abs(rampTarget - rampShown), 0.06);
        rampMesh.visible = rampShown > 0.001;
        const appear = Math.max(0.001, rampShown);
        rampMesh.scale.set(
          (ramp.width / rampSize.width) * appear,
          (ramp.height / rampSize.height) * appear,
          (ramp.length / rampSize.length) * appear,
        );
        rampMesh.position.copy(scenePoint(here, ramp.position, heading, ramp.ground - height()));
        rampMesh.rotation.set(-ramp.tilt, heading - ramp.heading, 0);
        if (!rampTarget && rampShown <= 0.001) ramp = null;
      } else rampMesh.visible = false;
      let beaconIndex = 0;
      for (const entry of missionBeacons.values()) {
        if (!entry.visual.group.visible) continue;
        const bob = Math.sin(now * 0.0022 + beaconIndex) * 0.08;
        // stand on the ground under the beacon, not at the car's height
        entry.visual.group.position.copy(scenePoint(here, entry.position, heading, groundLift(entry.position) + bob));
        entry.visual.group.rotation.set(0, heading - now * 0.0012, 0);
        entry.visual.tip.scale.setScalar(1 + Math.sin(now * 0.004 + beaconIndex) * 0.08);
        beaconIndex++;
      }
      if (raceFinishGoal && raceFinish.visible) {
        raceFinish.position.copy(scenePoint(here, raceFinishGoal, heading, groundLift(raceFinishGoal)));
        raceFinish.rotation.set(0, heading - now * 0.0008, 0);
        finishFlag.rotation.y = Math.sin(now * 0.003) * 0.15;
      }
      // wheels sit a little in from the body's sides
      tireTracks.update(here, heading, 1, currentCar.length, height(), p => map.groundAt(p), Math.max(0.55, carWidth / 2 - 0.2));
      for (const puff of puffs) {
        if (!puff.active) continue;
        const age = now - puff.born;
        if (age >= puff.life) {
          puff.active = false;
          puff.mesh.visible = false;
          continue;
        }
        puff.place = offsetPosition(puff.place, puff.east * dt, puff.north * dt);
        puff.up += dt * puff.rise;
        puff.east *= 1 - 0.4 * dt;
        puff.north *= 1 - 0.4 * dt;
        const offset = eastNorth(vehicle.position, puff.place);
        const fade = 1 - age / puff.life;
        puff.mesh.position.set(offset.north * Math.sin(heading) - offset.east * Math.cos(heading), puff.up, offset.north * Math.cos(heading) + offset.east * Math.sin(heading));
        puff.mesh.scale.setScalar(puff.size * (1 + (1 - fade) * 2.2));
        const material = (puff.mesh.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;
        material.opacity = 0.82 * fade;
      }
      const perMeter = mercatorPerMeter(vehicle.position[1]);
      const place = { x: mercatorX01(vehicle.position[0]), y: mercatorY01(vehicle.position[1]), z: height() * perMeter };
      const meters = perMeter;
      {
        // ours: on the ground under us, fading as we fly
        const ground = (map.groundAt(vehicle.position) ?? height()) - height();
        layShadow(playerShadow, 0, ground, 0, 0, -ground);
      }
      root.rotation.order = 'XYZ';
      root.rotation.x = -pitch(); // pitch is nose-up positive; +x rotation here lowers the nose
      root.rotation.z = roll();
      const matrix = new THREE.Matrix4().makeTranslation(place.x, place.y, place.z).scale(new THREE.Vector3(meters, -meters, meters)).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)).multiply(new THREE.Matrix4().makeRotationY(-vehicle.heading + Math.PI));
      placement.copy(matrix);
      // camera position in this layer's local frame, for camera-facing particles
      const clipToLocal = new THREE.Matrix4().fromArray(Array.from(args.defaultProjectionData.mainMatrix)).multiply(matrix).invert();
      const eye = new THREE.Vector4(0, 0, -1, 1).applyMatrix4(clipToLocal);
      {
        // every lamp's glow faces the camera itself (the point the projection sends to
        // infinity, w = 0), not the middle of the near plane: round from any side
        const lens = new THREE.Vector4(0, 0, 1, 0).applyMatrix4(clipToLocal);
        const at = Math.abs(lens.w) > 1e-9
          ? new THREE.Vector3(lens.x / lens.w, lens.y / lens.w, lens.z / lens.w)
          : new THREE.Vector3(eye.x / eye.w, eye.y / eye.w, eye.z / eye.w);
        faceHalos(scene, at);
      }
      fx.altitude = height();
      fx.update(now, dt, here, heading, new THREE.Vector3(eye.x / eye.w, eye.y / eye.w, eye.z / eye.w));
      fireEye.value.set(eye.x / eye.w, eye.y / eye.w, eye.z / eye.w);
      WreckFire.tick(now);
      if (fused || !renderer) return;
      camera.projectionMatrix.fromArray(Array.from(args.defaultProjectionData.mainMatrix)).multiply(matrix);
      renderer.resetState();
      renderer.render(scene, camera);
      renderer.resetState();
    },
    onRemove() {
      disposed = true;
      disposeObject(scene);
      tracerGeometry.dispose();
      tracerMaterial.dispose();
      fx.dispose();
      renderer?.dispose();
    },
  };
}
