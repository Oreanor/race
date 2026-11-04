import { TireTracks } from './TireTracks';
import { WorldParticles, type Enu } from './effects/WorldParticles';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { MapLayer, ThreeMap } from '@/world3d/map/ThreeMap';
import { mercatorPerMeter, mercatorX01, mercatorY01 } from '@/world3d/map/camera';
import type { Car } from '@/config/vehicle.config';
import { offsetPosition, type Position } from '@/game/VehicleController';
import type { Pose } from '@/game/VehiclePose';
import { healthColor } from '@/game/health';
import { t } from '@/i18n';

export type TargetVehicle = { id: string; driver: string; car: Car; position: Position; heading: number };
export type TargetHealth = { id: string; driver: string; color: string; hp: number; maxHp: number };
export type PickupVisual = { id: string; position: Position; color: string; kind?: 'ball' | 'coin' };
type DeathPhase = 'tumble' | 'burn' | 'wreck';
type CharMat = { material: THREE.MeshPhongMaterial; r: number; g: number; b: number };
type TargetState = TargetVehicle & {
  root: THREE.Group;
  healthBar: THREE.Group;
  healthFill: THREE.Mesh;
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
  setFiring: (firing: boolean) => void;
  flashPlayer: (duration: number) => void;
  setCar: (next: Car) => void;
  setTargets: (vehicles: TargetVehicle[]) => void;
  updateTargets: (vehicles: TargetVehicle[]) => void;
  flashTarget: (id: string, duration: number) => void;
  damageTarget: (id: string, amount: number) => boolean;
  aliveTargetCount: () => number;
  isTargetAlive: (id: string) => boolean;
  targetHealth: () => TargetHealth[];
  setPickups: (pickups: PickupVisual[]) => void;
  setMissionBeacons: (beacons: { id: string; kind: 'arena' | 'race'; position: Position }[]) => void;
  setRaceFinish: (goal: Position | null) => void;
  /** the J ramp: low edge at `position`, rising along `heading`; null takes it away */
  setRamp: (ramp: { position: Position; heading: number; ground: number; tilt: number } | null) => void;
};

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

export function vehicleLayer(
  car: Car,
  vehicle: Pose,
  height: () => number,
  pitch: () => number,
  roll: () => number,
  status: (text: string) => void,
  resolveShot: (cam: Position, camAlt: number, ground: Position, groundAlt: number, mark?: boolean) => { point: Position; altitude: number } | null = () => null,
  markGround: (point: Position, altitude: number) => void = () => {},
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
  scene.add(new THREE.HemisphereLight(0xfff6ec, 0x8a8172, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.6);
  sun.position.set(6, 16, 8);
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0xfff8ee, 2.2);
  rim.position.set(-4, 12, -8);
  scene.add(rim);
  const haze = smokeTexture();
  const puffs = Array.from({ length: 20 }, () => {
    const mesh = puffMesh(haze);
    scene.add(mesh);
    return { mesh, place: [0, 0] as Position, east: 0, north: 0, up: 0, born: 0, life: 1, size: 0.4, active: false };
  });
  let cursor = 0;
  let lastSpawn = 0;
  let lastFrame = 0;
  const tireTracks = new TireTracks(scene);
  const targets = new Map<string, TargetState>();
  const pickups = new Map<string, { position: Position; mesh: THREE.Object3D; phase: number; coin: boolean; ground: number | null }>();
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
  function makeBeacon(pole: string, glow: string, orb: string, base: string) {
    const group = new THREE.Group();
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.28, 2.55, 12),
      new THREE.MeshStandardMaterial({ color: pole, emissive: glow, emissiveIntensity: 0.55, metalness: 0.25, roughness: 0.38 }),
    );
    shaft.position.y = 1.275;
    shaft.frustumCulled = false;
    const tip = new THREE.Mesh(
      new THREE.SphereGeometry(0.42, 16, 12),
      new THREE.MeshStandardMaterial({ color: orb, emissive: pole, emissiveIntensity: 0.85, metalness: 0.1, roughness: 0.28 }),
    );
    tip.position.y = 2.85;
    tip.frustumCulled = false;
    const footing = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.7, 0.18, 12),
      new THREE.MeshStandardMaterial({ color: base, metalness: 0.2, roughness: 0.5 }),
    );
    footing.position.y = 0.09;
    footing.frustumCulled = false;
    group.add(footing, shaft, tip);
    group.visible = false;
    group.frustumCulled = false;
    scene.add(group);
    return { group, tip };
  }
  const missionBeacons = new Map<string, { kind: 'arena' | 'race'; position: Position; visual: ReturnType<typeof makeBeacon> }>();
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
  // muzzle flash, impact sparks and explosions
  const fx = new WorldParticles(scene);
  const healthBackgroundGeometry = new THREE.PlaneGeometry(2.2, 0.24);
  const healthFillGeometry = new THREE.PlaneGeometry(1, 0.12);
  const healthBackgroundMaterial = new THREE.MeshBasicMaterial({
    color: '#17251c',
    transparent: true,
    opacity: 0.88,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
  });
  const healthFillMaterials = {
    green: new THREE.MeshBasicMaterial({ color: '#19ff62', depthWrite: false, depthTest: false, side: THREE.DoubleSide }),
    yellow: new THREE.MeshBasicMaterial({ color: '#ffe600', depthWrite: false, depthTest: false, side: THREE.DoubleSide }),
    red: new THREE.MeshBasicMaterial({ color: '#ff2b25', depthWrite: false, depthTest: false, side: THREE.DoubleSide }),
  };
  const explosionGeometry = new THREE.SphereGeometry(1, 10, 8);
  const targetMaxHp = 1000;
  const targetDamagePerShot = 15;
  let currentCar = car;
  let carLoadToken = 0;
  let aim: AimPoint | null = null;
  let firing = false;
  let lastShot = 0;
  let tracerUntil = 0;
  let flashUntil = 0;
  let impactUntil = 0;
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
      const coin = pickup.kind === 'coin';
      const mesh = coin ? makeCoin() : new THREE.Mesh(pickupGeometry, pickupMaterial(pickup.color));
      mesh.frustumCulled = false;
      mesh.renderOrder = 8;
      scene.add(mesh);
      pickups.set(pickup.id, {
        position: [...pickup.position],
        mesh,
        phase: Math.random() * Math.PI * 2,
        coin,
        ground: null,
      });
    }
  }

  function setMissionBeacons(beacons: { id: string; kind: 'arena' | 'race'; position: Position }[]) {
    const active = new Set(beacons.map(beacon => beacon.id));
    for (const [id, entry] of missionBeacons) {
      if (active.has(id)) continue;
      scene.remove(entry.visual.group);
      missionBeacons.delete(id);
    }
    for (const beacon of beacons) {
      let entry = missionBeacons.get(beacon.id);
      if (!entry) {
        const visual = beacon.kind === 'arena'
          ? makeBeacon('#2f7dff', '#1a4fb8', '#6eb6ff', '#1e3a66')
          : makeBeacon('#ff7a1a', '#b84a00', '#ffb86b', '#6a3110');
        entry = { kind: beacon.kind, position: [...beacon.position], visual };
        missionBeacons.set(beacon.id, entry);
      }
      entry.kind = beacon.kind;
      entry.position = [...beacon.position];
      entry.visual.group.visible = true;
    }
    map?.triggerRepaint();
  }

  // kicker ramp: a wedge rising along +z (the car's forward), grows in and shrinks away
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
  let ramp: { position: Position; heading: number; ground: number; tilt: number } | null = null;
  let rampShown = 0;
  let rampTarget = 0;
  function setRamp(next: typeof ramp) {
    if (next) {
      ramp = { ...next, position: [...next.position] as Position };
      rampShown = 0;
    }
    rampTarget = next ? 1 : 0;
    map?.triggerRepaint();
  }

  function setRaceFinish(goal: Position | null) {
    raceFinishGoal = goal ? [...goal] as Position : null;
    raceFinish.visible = Boolean(raceFinishGoal);
    map?.triggerRepaint();
  }


  function createHealthBar() {
    const bar = new THREE.Group();
    const background = new THREE.Mesh(healthBackgroundGeometry, healthBackgroundMaterial);
    background.renderOrder = 10;
    const fill = new THREE.Mesh(healthFillGeometry, healthFillMaterials.green);
    fill.position.set(0, 0, 0.015);
    fill.scale.x = 2;
    fill.renderOrder = 11;
    bar.add(background, fill);
    scene.add(bar);
    bar.visible = false;
    return { bar, fill };
  }

  function updateHealthFill(fill: THREE.Mesh, hp: number, maxHp: number) {
    const fraction = Math.max(0, Math.min(1, hp / maxHp));
    fill.scale.x = 2 * fraction;
    fill.position.x = -1 + fraction;
    fill.material = healthFillMaterials[healthColor(hp, maxHp)];
  }

  function updateHealthBar(target: TargetState) {
    updateHealthFill(target.healthFill, target.hp, targetMaxHp);
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

  function burstExplosion(target: TargetState, here: Position, _heading: number, now: number, size: number) {
    const o = eastNorth(here, target.position);
    const jitter = () => (Math.random() - 0.5) * 1.6;
    fx.altitude = height();
    fx.explosion(here, { e: o.east + jitter(), n: o.north + jitter(), u: 0.6 + Math.random() * 0.8 }, 0.75 * size, now, size > 1);
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
    target.deathPhase = 'tumble';
    target.root.visible = true;
    target.healthBar.visible = false;
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

  function setTargets(next: TargetVehicle[]) {
    for (const [id, target] of targets) {
      scene.remove(target.root);
      disposeObject(target.root);
      scene.remove(target.healthBar, target.explosion);
      target.explosion.material.dispose();
      targets.delete(id);
    }
    for (const spec of next) {
      const root = new THREE.Group();
      root.add(fallbackCar(spec.car.color));
      scene.add(root);
      const { bar: healthBar, fill: healthFill } = createHealthBar();
      const explosion = new THREE.Mesh(
        explosionGeometry,
        new THREE.MeshBasicMaterial({ color: '#ff722b', transparent: true, opacity: 0, depthWrite: false, depthTest: false }),
      );
      explosion.visible = false;
      explosion.renderOrder = 12;
      scene.add(explosion);
      const target: TargetState = {
        ...spec, root, healthBar, healthFill, explosion, hp: targetMaxHp,
        destroyed: false, deathPhase: null, explodedAt: 0, flashUntil: 0, flashing: false,
        spinX: 0, spinY: 0, spinZ: 0, velUp: 0, blastsLeft: 0, nextBlastAt: 0, charMats: [],
        wreckQuat: null, wreckBakeHeading: 0, wreckRestY: 0.45,
      };
      targets.set(spec.id, target);
      loadCar(spec.car).then(model => {
        if (disposed || targets.get(spec.id) !== target) { disposeObject(model); return; }
        polish(model);
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
    map?.triggerRepaint();
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
    const ground = map.getTerrain() ? map.queryTerrainElevation(point) : 0;
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
    const ground = map.queryTerrainElevation(center) ?? carAlt;
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
    if (!aim || !map || now - lastShot < 50) return;
    lastShot = now;
    const carAlt = height();
    const cam = cameraPose(here, carAlt);
    const groundAlt = map.queryTerrainElevation(aim.ground) ?? carAlt;
    const ground = eastNorth(here, aim.ground);
    const dx = ground.east - cam.east;
    const dy = (groundAlt - carAlt) - cam.up;
    const dz = ground.north - cam.north;
    const rayLen = Math.hypot(dx, dy, dz);
    if (rayLen < 1) return;
    const ux = dx / rayLen;
    const uy = dy / rayLen;
    const uz = dz / rayLen;

    let bestT = Math.min(rayLen * 1.02, 160);
    let hit: TargetState | null = null;
    let hitUp = cam.up + uy * bestT;
    const radius = 2.15;
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
      if (up < -0.4 || up > 2.6) continue;
      bestT = t;
      hit = target;
      hitUp = Math.max(0.35, Math.min(1.6, up));
    }

    const wall = resolveShot(cam.position, cam.altitude, aim.ground, groundAlt, false);
    let wallHit = false;
    let groundHit = false;
    if (wall) {
      const wallDelta = eastNorth(here, wall.point);
      const wallT = (wallDelta.east - cam.east) * ux + (wall.altitude - carAlt - cam.up) * uy + (wallDelta.north - cam.north) * uz;
      if (wallT > 1 && wallT < bestT) {
        hit = null;
        bestT = wallT;
        hitUp = wall.altitude - carAlt;
        wallHit = true;
        resolveShot(cam.position, cam.altitude, aim.ground, groundAlt, true);
      }
    }
    if (!hit && !wallHit) {
      bestT = Math.min(bestT, rayLen);
      hitUp = groundAlt - carAlt;
      groundHit = true;
      markGround(aim.ground, groundAlt);
    }

    const end = offsetPosition(here, cam.east + ux * bestT, cam.north + uz * bestT);
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
    // world-space (east, north, up) shot geometry for the effects
    const muzzleAt: Enu = { e: Math.sin(heading) * 1.9, n: Math.cos(heading) * 1.9, u: 0.85 };
    const endEn = eastNorth(here, end);
    const hitAt: Enu = { e: endEn.east, n: endEn.north, u: hitUp };
    const shotLen = Math.hypot(hitAt.e - muzzleAt.e, hitAt.n - muzzleAt.n, hitAt.u - muzzleAt.u) || 1;
    const shotDir: Enu = { e: (hitAt.e - muzzleAt.e) / shotLen, n: (hitAt.n - muzzleAt.n) / shotLen, u: (hitAt.u - muzzleAt.u) / shotLen };
    const bounce: Enu = { e: -shotDir.e, n: -shotDir.n, u: Math.max(0.35, -shotDir.u) };
    fx.altitude = carAlt;
    fx.muzzle(here, muzzleAt, shotDir, now);
    fx.tracer(here, muzzleAt, hitAt, now);
    tracer.visible = false; // the particle streak replaces the 1px line
    flashUntil = now + 75;
    if (hit) {
      hit.hp = Math.max(0, hit.hp - targetDamagePerShot);
      updateHealthBar(hit);
      if (hit.hp === 0) {
        destroyTarget(hit, now, here, heading);
      } else {
        hit.flashUntil = now + 130;
        fx.impact(here, hitAt, bounce, now, { scale: 1 });
        impactUntil = now + 90;
      }
    } else if (wallHit || groundHit) {
      const normal: Enu = groundHit ? { e: bounce.e * 0.4, n: bounce.n * 0.4, u: 1 } : bounce;
      fx.impact(here, hitAt, normal, now, { scale: groundHit ? 0.7 : 0.9, dust: true });
      impactUntil = now + 90;
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
    const back = -car.length * 0.56;
    const rise = 0.55;
    const x = side * (0.62 + Math.random() * 0.12);
    // nose-up lean lowers the tail pipe
    const y = rise * Math.cos(lean) + back * Math.sin(lean);
    const z = -rise * Math.sin(lean) + back * Math.cos(lean);
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
  function installCarModel(model: THREE.Group) {
    polish(model);
    for (const child of [...root.children]) {
      root.remove(child);
      disposeObject(child);
    }
    root.clear();
    root.add(model);
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
    setFiring(value) { firing = value; },
    flashPlayer(duration) { playerFlashUntil = Math.max(playerFlashUntil, performance.now() + duration); },
    setCar(next) {
      if (next.id === currentCar.id && next.path === currentCar.path) return;
      loadPlayerCar(next, false);
    },
    setTargets,
    updateTargets,
    flashTarget(id, duration) {
      const target = targets.get(id);
      if (target && !target.destroyed) target.flashUntil = Math.max(target.flashUntil, performance.now() + duration);
    },
    damageTarget(id, amount) {
      const target = targets.get(id);
      if (!target || target.destroyed || amount <= 0) return false;
      target.hp = Math.max(0, target.hp - amount);
      updateHealthBar(target);
      target.flashUntil = Math.max(target.flashUntil, performance.now() + 160);
      if (target.hp === 0) {
        const here = vehicle.position;
        destroyTarget(target, performance.now(), here, vehicle.heading);
      }
      return true;
    },
    aliveTargetCount: () => [...targets.values()].filter(target => !target.destroyed).length,
    isTargetAlive: id => {
      const target = targets.get(id);
      return Boolean(target && !target.destroyed);
    },
    targetHealth: () => [...targets.values()].map(target => ({
      id: target.id,
      driver: target.driver,
      color: target.car.color,
      hp: target.destroyed ? 0 : target.hp,
      maxHp: targetMaxHp,
    })),
    setPickups,
    setMissionBeacons,
    setRaceFinish,
    setRamp,
    scene,
    placement,
    fuse() { fused = true; },
    // the beams are lit by the world shaders; no lens discs (they never sit on every model's lamps)
    setHeadlights() {},
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
      if (vehicle.throttle && now - lastSpawn > 150) {
        lastSpawn = now;
        spawn(1, now);
        spawn(-1, now);
      }
      const heading = vehicle.heading;
      const here = vehicle.position;
      if (firing) fire(now, heading, here);
      const flashPlayer = now < playerFlashUntil;
      if (playerFlashing !== flashPlayer) {
        playerFlashing = flashPlayer;
        tintVehicle(root, flashPlayer);
      }
      const bearing = map.getBearing() * Math.PI / 180;
      const pitchAngle = map.getPitch() * Math.PI / 180;
      const cameraNormal = new THREE.Vector3(
        -Math.sin(bearing) * Math.cos(pitchAngle),
        Math.sin(pitchAngle),
        Math.cos(bearing) * Math.cos(pitchAngle),
      ).applyAxisAngle(new THREE.Vector3(0, 1, 0), heading - Math.PI);
      tracer.visible = tracer.visible && now < tracerUntil;
      for (const target of targets.values()) {
        const offset = scenePoint(here, target.position, heading, 0);
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
            const burn = Math.min(1, (age - tumbleMs) / 3500);
            const flicker = 0.25 + 0.55 * Math.abs(Math.sin(now * 0.018));
            target.root.position.copy(offset);
            target.root.position.y += target.wreckRestY;
            applyWreckPose(target, heading);
            applyChar(target, 0.35 + burn * 0.65, flicker * (1 - burn));
            if (burn >= 1) {
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
        target.root.rotation.y = heading - target.heading;
        target.healthBar.position.copy(offset);
        target.healthBar.position.y += 3.8;
        target.healthBar.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), cameraNormal);
        tintTarget(target, now < target.flashUntil);
      }
      for (const pickup of pickups.values()) {
        // stand on the ground under the pickup, not at the car's height
        if (pickup.ground == null) pickup.ground = map.getTerrain() ? map.queryTerrainElevation(pickup.position) : 0;
        const lift = (pickup.ground ?? height()) - height();
        if (pickup.coin) {
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
        rampMesh.scale.set(1, Math.max(0.001, rampShown), 1);
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
      tireTracks.update(here, heading, 1, car.length, height(), p => map.getTerrain() ? map.queryTerrainElevation(p) : 0);
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
      const perMeter = mercatorPerMeter(vehicle.position[1]);
      const place = { x: mercatorX01(vehicle.position[0]), y: mercatorY01(vehicle.position[1]), z: height() * perMeter };
      const meters = perMeter;
      root.rotation.order = 'XYZ';
      root.rotation.x = -pitch(); // pitch is nose-up positive; +x rotation here lowers the nose
      root.rotation.z = roll();
      const matrix = new THREE.Matrix4().makeTranslation(place.x, place.y, place.z).scale(new THREE.Vector3(meters, -meters, meters)).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)).multiply(new THREE.Matrix4().makeRotationY(-vehicle.heading + Math.PI));
      placement.copy(matrix);
      // camera position in this layer's local frame, for camera-facing particles
      const clipToLocal = new THREE.Matrix4().fromArray(Array.from(args.defaultProjectionData.mainMatrix)).multiply(matrix).invert();
      const eye = new THREE.Vector4(0, 0, -1, 1).applyMatrix4(clipToLocal);
      fx.altitude = height();
      fx.update(now, dt, here, heading, new THREE.Vector3(eye.x / eye.w, eye.y / eye.w, eye.z / eye.w));
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
