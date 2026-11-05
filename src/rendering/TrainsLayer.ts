import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { MapLayer, ThreeMap } from '@/world3d/map/ThreeMap';
import { mercatorPerMeter, mercatorX01, mercatorY01 } from '@/world3d/map/camera';
import { simpleLit, standaloneUniforms, type SimpleLitUniforms } from '@/world3d/map/simpleLit';
import type { CarPose } from '@/game/Trains';
import type { Position } from '@/game/VehicleController';

// Trains and trams in our one scene. Rail cars and trams are the GLB models
// (a locomotive with wagons, or a modern / vintage tram), one InstancedMesh
// per model part; until a model loads, cars fall back to instanced boxes.

const MAX = 80;
/** every rail car model is scaled to this height (they keep their proportions; lengths differ) */
const RAIL_CAR_HEIGHT = 4.3;

const MODELS = {
  lead: '/models/trains/train.glb',
  passenger: '/models/trains/wagon.glb',
  cargo: '/models/trains/wagon_cargo.glb',
  tank: '/models/trains/wagon_tank.glb',
  // the vintage set
  leadOld: '/models/trains/train_old.glb',
  passengerOld: '/models/trains/wagon_old.glb',
  cargoOld: '/models/trains/wagon_cargo_old.glb',
  // trams (one car = the whole vehicle)
  tram: '/models/trains/tram.glb',
  tramOld: '/models/trains/tram_old.glb',
};
type ModelName = keyof typeof MODELS;
/** models drawn facing the other way: turned so their front leads */
const BACKWARDS = new Set<ModelName>(['leadOld']);

type Part = { size: [number, number, number]; at: number; color: string; tint?: boolean };
// box stand-ins: width (m), height (m), length (fraction of the car); `at` = height of the centre
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

/** Stable 0..1 from a string. */
function hash(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

/**
 * Which model a rail / tram car shows. A consist is either modern or vintage
 * (about one in three). Trains are passenger or freight with a locomotive;
 * trams use the same car model for every unit in the consist.
 */
function modelFor(car: CarPose): ModelName {
  const vintage = hash(`${car.trainId}:age`) < 0.33;
  if (car.kind === 'tram') return vintage ? 'tramOld' : 'tram';
  const passenger = hash(car.trainId) < 0.5;
  if (car.index === 0) return vintage ? 'leadOld' : 'lead';
  if (vintage) return passenger ? 'passengerOld' : 'cargoOld';
  if (passenger) return 'passenger';
  return hash(`${car.trainId}:${car.index}`) < 0.5 ? 'cargo' : 'tank';
}

/** The world's haze on a model's own (textured) material. */
function hazed(material: THREE.Material, world: SimpleLitUniforms) {
  const m = material.clone();
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, { uCameraPos: world.uCameraPos, uFogColor: world.uFogColor, uFogNear: world.uFogNear, uFogFar: world.uFogFar });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHazeWorld;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 hazeAt = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          hazeAt = instanceMatrix * hazeAt;
        #endif
        vHazeWorld = (modelMatrix * hazeAt).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHazeWorld;\nuniform vec3 uCameraPos;\nuniform vec3 uFogColor;\nuniform float uFogNear;\nuniform float uFogFar;')
      .replace('#include <dithering_fragment>', `float haze = smoothstep(uFogNear, uFogFar, distance(vHazeWorld, uCameraPos));
        gl_FragColor.rgb = mix(gl_FragColor.rgb, uFogColor, haze);
        #include <dithering_fragment>`);
  };
  m.customProgramCacheKey = () => 'hazed';
  return m;
}

type ModelParts = { meshes: THREE.InstancedMesh[]; base: THREE.Matrix4[]; length: number };

export function trainsLayer(): MapLayer & {
  scene: THREE.Scene;
  placement: THREE.Matrix4;
  fuse: (world?: SimpleLitUniforms) => void;
  setCars: (cars: CarPose[], origin: Position, terrain: boolean) => void;
  /** a rail car's length as drawn, once its model is in (null before) */
  carLength: (trainId: string, index: number, kind: string) => number | null;
} {
  let map: ThreeMap | null = null;
  /** last drawn height of every car end (trainId:index + f/b) */
  let heights = new Map<string, number>();
  const scene = new THREE.Scene();
  let uniforms = standaloneUniforms();
  const box = new THREE.BoxGeometry(1, 1, 1);
  const boxes = PARTS.map((part) => {
    const mesh = new THREE.InstancedMesh(box, simpleLit(part.color, uniforms), MAX);
    mesh.count = 0;
    mesh.frustumCulled = false;
    if (part.tint) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    scene.add(mesh);
    return mesh;
  });
  const models = new Map<ModelName, ModelParts>();
  let loading = false;

  /** Each model: its parts as instanced meshes, RAIL_CAR_HEIGHT tall, long side along +z, wheels at y = 0. */
  function loadModels() {
    if (loading) return;
    loading = true;
    const loader = new GLTFLoader();
    for (const [name, url] of Object.entries(MODELS) as [ModelName, string][]) {
      loader.loadAsync(url).then((gltf) => {
        const root = gltf.scene;
        root.updateMatrixWorld(true);
        const bounds = new THREE.Box3().setFromObject(root);
        const size = bounds.getSize(new THREE.Vector3());
        const center = bounds.getCenter(new THREE.Vector3());
        const scale = RAIL_CAR_HEIGHT / size.y;
        // long side → +z (the car's forward), centred, standing on y = 0
        const normalise = new THREE.Matrix4()
          .makeRotationY((size.x >= size.z ? -Math.PI / 2 : 0) + (BACKWARDS.has(name) ? Math.PI : 0))
          .multiply(new THREE.Matrix4().makeScale(scale, scale, scale))
          .multiply(new THREE.Matrix4().makeTranslation(-center.x, -bounds.min.y, -center.z));
        const parts: ModelParts = { meshes: [], base: [], length: Math.max(size.x, size.z) * scale };
        root.traverse((node) => {
          const mesh = node as THREE.Mesh;
          if (!mesh.isMesh) return;
          const instanced = new THREE.InstancedMesh(mesh.geometry, hazed(mesh.material as THREE.Material, uniforms), MAX);
          instanced.count = 0;
          instanced.frustumCulled = false;
          scene.add(instanced);
          parts.meshes.push(instanced);
          parts.base.push(normalise.clone().multiply(mesh.matrixWorld));
        });
        models.set(name, parts);
        map?.triggerRepaint();
      }).catch((error) => console.warn(`Train model ${url} did not load`, error));
    }
  }

  const place = new THREE.Matrix4();
  const object = new THREE.Object3D();
  object.rotation.order = 'YXZ';
  const local = new THREE.Matrix4();
  const color = new THREE.Color();
  const counts = new Map<ModelName, number>();

  return {
    id: 'trains',
    type: 'custom',
    scene,
    placement: place,
    fuse(world) {
      if (!world) return;
      uniforms = world;
      boxes.forEach((mesh, p) => {
        (mesh.material as THREE.Material).dispose();
        mesh.material = simpleLit(PARTS[p].color, uniforms);
      });
      loadModels();
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
      const toLocal = (p: Position) => [(mercatorX01(p[0]) - mercatorX01(origin[0])) / perMeter, (mercatorY01(p[1]) - mercatorY01(origin[1])) / perMeter];
      // each car end keeps its last height as a hint, like the player's car: on a
      // bridge it stays on the deck, under an overpass it stays on the ground
      const seen = new Map<string, number>();
      let ahead = '';
      const ground = (p: Position, key: string) => {
        // a car seen for the first time takes the hint from the car ahead
        const y = terrain ? map?.groundAt(p, heights.get(key) ?? heights.get(ahead) ?? null) ?? 0 : 0;
        seen.set(key, y);
        return y + 0.1;
      };
      counts.clear();
      let boxCount = 0;
      for (const car of cars) {
        const [fx, fz] = toLocal(car.front);
        const [bx, bz] = toLocal(car.back);
        const id = car.trainId + ':' + car.index;
        ahead = car.trainId + ':' + (car.index - 1) + 'b';
        const fy = ground(car.front, id + 'f');
        ahead = id + 'f';
        const by = ground(car.back, id + 'b');
        const length = Math.hypot(fx - bx, fz - bz) || 1;
        object.position.set((fx + bx) / 2, (fy + by) / 2, (fz + bz) / 2);
        // +z points from the back to the front; tilt with the slope
        object.rotation.set(-Math.atan2(fy - by, length), Math.atan2(fx - bx, fz - bz), 0);
        object.updateMatrix();
        const name = modelFor(car);
        const model = models.get(name);
        if (model) {
          const i = counts.get(name) ?? 0;
          if (i >= MAX) continue;
          counts.set(name, i + 1);
          model.meshes.forEach((mesh, p) => mesh.setMatrixAt(i, local.multiplyMatrices(object.matrix, model.base[p])));
          continue;
        }
        if (boxCount >= MAX) continue;
        const i = boxCount++;
        const palette = COLORS[car.kind] ?? COLORS.rail;
        boxes.forEach((mesh, p) => {
          const part = PARTS[p];
          local.makeTranslation(0, part.at, 0).scale(new THREE.Vector3(part.size[0], part.size[1], part.size[2] * length));
          mesh.setMatrixAt(i, object.matrix.clone().multiply(local));
          if (part.tint) mesh.setColorAt(i, color.set(car.index === 0 ? palette.lead : palette.car).convertSRGBToLinear());
        });
      }
      heights = seen;
      for (const mesh of boxes) {
        mesh.count = boxCount;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
      for (const [name, model] of models) {
        const count = counts.get(name) ?? 0;
        for (const mesh of model.meshes) {
          mesh.count = count;
          mesh.instanceMatrix.needsUpdate = true;
        }
      }
    },
    carLength(trainId, index, kind) {
      if (kind !== 'rail' && kind !== 'tram') return null;
      return models.get(modelFor({ trainId, index, kind, front: [0, 0], back: [0, 0] }))?.length ?? null;
    },
    onAdd(nextMap) {
      map = nextMap;
    },
    onRemove() {
      box.dispose();
      for (const mesh of boxes) (mesh.material as THREE.Material).dispose();
      for (const model of models.values()) for (const mesh of model.meshes) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
    },
  };
}
