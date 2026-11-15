import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
// Exercise the production streamer without WebGL or browser workers. Resolve
// the same aliases as Next, and compile TS parameter properties for Node.
registerHooks({ load(url, context, next) {
  if (url.startsWith(new URL('../src/', import.meta.url).href) && url.endsWith('.ts')) {
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText };
  }
  return next(url, context);
}, resolve(specifier, context, next) {
  if (specifier.startsWith('@/')) {
    const base = new URL('../src/' + specifier.slice(2), import.meta.url);
    for (const suffix of ['', '.ts', '.tsx', '/index.ts']) {
      const url = new URL(base.href + suffix);
      if (existsSync(url)) { try { return next(url.href, context); } catch {} }
    }
  }
  return next(specifier, context);
} });
const { WorldTiles, defaultWorldOptions } = await import('../src/world3d/map/WorldTiles.ts');
const { ThreeMap } = await import('../src/world3d/map/ThreeMap.ts');
const { tilesAround } = await import('../src/world3d/tiles/tilePlan.ts');
const { offsetPosition } = await import('../src/game/VehicleController.ts');
const { MapCamera } = await import('../src/world3d/map/camera.ts');
const { GameEngine } = await import('../src/game/GameEngine.ts');
const { PreparedTransfer } = await import('../src/game/PreparedTransfer.ts');
const { missionAreas } = await import('../src/game/missionPopulation.ts');

test('map streaming expands the driving ring, cancels distant work on close, and prioritises a transfer', () => {
  const focus = [-8.8, 40.15];
  const options = { ...defaultWorldOptions };
  const ring = tilesAround(focus, options.loadRadius, options.zoom);
  const world = Object.assign(Object.create(WorldTiles.prototype), {
    disposed: false, template: 'tiles', options,
    tiles: new Map(ring.map(t => [t.key, { waiting: [], fade: 1 }])),
    pending: new Map(), failures: new Map(), ringKeys: new Set(),
    softKeep: new Set(), softKeepUntil: 0, softKeepAt: null,
    streamPlan: null, mapLite: false, speed: 0, moveAt: 0, moveFrom: null,
    lastFadeMs: 0, serial: 0, requested: [], cancelled: [],
    request(key, tile) { this.requested.push(key); this.pending.set(key, { id: ++this.serial, key, tile }); },
    cancel(id) { this.cancelled.push(id); },
    unload(key) { this.tiles.delete(key); },
});
const sw = offsetPosition(focus, -8000, -6500), ne = offsetPosition(focus, 8000, 6500);
const screen = { west: sw[0], south: sw[1], east: ne[0], north: ne[1] };
world.update(focus, 0, false, screen, false, focus);
assert.ok(world.requested.length, 'opening map requests tiles beyond the already loaded driving ring');
assert.ok(world.streamPlan.wanted.length > ring.length * 2);
const outer = world.streamPlan.wanted.find(t => t.distance > 6000);
world.pending.set(outer.key, { id: 999, key: outer.key, tile: outer.tile });
world.update(focus, 0, false, undefined, false, focus);
assert.ok(world.cancelled.includes(999), 'closing the map cancels unfinished distant map work');
const destination = offsetPosition(focus, 18000, 0);
world.update(focus, 0, false, undefined, false, focus, { at: destination, radius: options.loadRadius });
assert.equal(world.streamPlan.wanted[0].key, tilesAround(destination, options.loadRadius, options.zoom)[0].key);
assert.equal(world.loadedAround(destination, options.loadRadius), false);

const camera = new MapCamera();
Object.assign(camera.state, { center: focus, zoom: 12, pitch: 0, bearing: 0, elevation: 100, width: 1920, height: 1000 });
camera.update();
const map = Object.assign(Object.create(ThreeMap.prototype), { camera, streamCalm: true, screenStream: true, lastScreenBounds: null });
assert.equal(map.streamingCalm(), false, 'a paused flat map cannot remain starved by the blend flag');
const bounds = map.visibleGroundBounds();
const span = (bounds.east - bounds.west) * 111319 * Math.cos(focus[1] * Math.PI / 180);
assert.ok(span > 12000, 'far map edges are not silently clipped at 12 km');
map.camera.state.pitch = 57;
map.streamDestination = { at: destination, radius: 2800 };
assert.equal(map.streamingCalm(), false, 'a transfer loads even if its original camera is paused mid-blend');
});

test('transfer readiness waits for destination uploads and their GPU fence, independently of distant map meshes', () => {
  const destination = [-8.8, 40.15];
  const group = new THREE.Group(), mesh = new THREE.Mesh();
  group.add(mesh);
  let loaded = false;
  const map = Object.assign(Object.create(ThreeMap.prototype), {
    world: { loadedAround: () => loaded, groupsAround: () => [group] },
    gpuWarmLayers: new WeakMap(), gpuWarmSubmitted: [], gpuWarmQueue: [new THREE.Mesh()],
  });
  assert.equal(map.areTilesLoadedAround(destination, 2800), false);
  loaded = true;
  map.gpuWarmLayers.set(mesh, 1);
  assert.equal(map.areTilesLoadedAround(destination, 2800), false);
  map.gpuWarmLayers.delete(mesh);
  map.gpuWarmSubmitted.push(mesh);
  assert.equal(map.areTilesLoadedAround(destination, 2800), false);
  map.gpuWarmSubmitted = [];
  assert.equal(map.areTilesLoadedAround(destination, 2800), true);
});

test('a paused tow commits the loaded camera, car and payment together', () => {
  const origin = [-8.8, 40.15], destination = [-8.7, 40.15];
  let ready = false, center = origin, paid = false, streamAt = null;
  const engine = Object.assign(Object.create(GameEngine.prototype), {
    transfer: new PreparedTransfer(),
    vehicle: { position: origin, heading: 0, speed: 0, throttle: 0 },
    settings: { terrain: true }, keys: new Set(), renderVehicle: { reset() {} },
    wheelTargets: { ready: true }, paused: true,
    map: {
      loadRadius: 2800, areTilesLoadedAround: () => ready,
      setStreamDestination: p => { streamAt = p; }, features: () => [], groundAt: () => 20,
      setScreenStream() {}, setFocusCar() {}, jumpTo(view) { center = view.center; },
    },
    onTransfer() {}, stopGun() {}, setMapViewUi() {}, setOverviewMapNav() {},
    findFreeRoad: () => ({ position: destination, heading: 0 }),
  });
  engine.placeCarAt(destination, () => { paid = true; });
  assert.deepEqual(engine.vehicle.position, origin);
  assert.equal(paid, false);
  assert.deepEqual(streamAt, destination);
  engine.tickTransfer(performance.now());
  assert.deepEqual(center, origin);
  ready = true;
  engine.tickTransfer(performance.now());
  assert.deepEqual(engine.vehicle.position, destination);
  assert.ok(Math.abs(center[0] - destination[0]) < 0.001, 'camera follows the transfer in the same frame, even though simulation is paused');
  assert.equal(paid, true);
  assert.equal(streamAt, null);
});

test('police capture raises an arrest modal result instead of only a toast', () => {
  let result = null;
  const engine = Object.assign(Object.create(GameEngine.prototype), {
    heist: { cash: 123 }, pickups: new Map(), playerMoney: 10000, playerMaxHp: 1000,
    vehicle: { speed: 1, throttle: 1 }, renderVehicle: { reset() {} },
    clearEventBots() {}, showEventBeacons() {}, nearestCivic: () => null,
    audio: { explosion() {} }, onEventResult: r => { result = r; },
  });
  engine.arrest();
  assert.equal(result.kind, 'arrest');
  assert.equal(result.won, false);
  assert.ok(result.name.length > 0);
  assert.ok(result.cash >= 123);
});

test('paused map population follows the inspected area, keeps starts apart and preserves an active mission', () => {
  let focus = [-8.8, 40.15], active = false;
  const bounds = () => {
    const sw = offsetPosition(focus, -2000, -1600), ne = offsetPosition(focus, 2000, 1600);
    return { west: sw[0], south: sw[1], east: ne[0], north: ne[1] };
  };
  const features = () => missionAreas(bounds()).map(area => ({ properties: { class: 'minor' }, geometry: {
    type: 'LineString', coordinates: [offsetPosition(area.at, -100, 0), offsetPosition(area.at, 100, 0)],
  } }));
  const engine = Object.assign(Object.create(GameEngine.prototype), {
    mode: 'roam', driving: true, paused: true, vehicle: { position: focus },
    missions: [], missionSeq: { arena: 0, race: 0, delivery: 0, collect: 0 },
    missionPopulationAt: 0, missionPopulationKey: '', missionRespawnAt: 0,
    transfer: new PreparedTransfer(), onMission: () => active, carShoots: () => true,
    mapInspecting: () => true, syncMissionVisuals() {},
    map: {
      visibleGroundBounds: bounds, groundAt: () => 10, waterLevelAt: () => null,
      world: { tileKeys: () => tilesAround(focus, 6000, 14).map(t => t.key), featuresOf: features },
    },
  });
  engine.refillMissions();
  assert.equal(engine.missions.length, 16);
  assert.equal(new Set(engine.missions.map(m => m.kind)).size, 4);
  const originalIds = engine.missions.map(m => m.id);
  engine.missionPopulationAt = 0;
  engine.refillMissions();
  assert.deepEqual(engine.missions.map(m => m.id), originalIds, 'an unchanged map does not shuffle its starts');
  focus = offsetPosition(focus, 12000, 0);
  engine.vehicle.position = focus;
  engine.missionPopulationAt = 0;
  engine.refillMissions();
  assert.equal(engine.missions.length, 16);
  assert.ok(engine.missions.every(m => !originalIds.includes(m.id)));
  const movedIds = engine.missions.map(m => m.id);
  active = true;
  focus = offsetPosition(focus, 12000, 0);
  engine.missionPopulationAt = 0;
  engine.refillMissions();
  assert.deepEqual(engine.missions.map(m => m.id), movedIds);
});

test('cancelling distant tiles aborts unused network requests but preserves a neighbour shared with a driving tile', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = (url, { signal }) => new Promise((resolve, reject) => {
    const request = { url, signal, resolve };
    requests.push(request);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  try {
    const world = Object.assign(Object.create(WorldTiles.prototype), {
      bytes: new Map(), fetching: new Map(),
      jobs: new Map([[1, { worker: 0 }], [2, { worker: 0 }], [3, { worker: 0 }]]),
      workers: [{ postMessage() {} }], load: [3],
    });
    const a = world.fetchBytes('shared', 'vector', 1);
    const b = world.fetchBytes('shared', 'vector', 2);
    const far = world.fetchBytes('far', 'vector', 1);
    assert.equal(a, b);
    assert.equal(requests.length, 2);
    world.cancel(1);
    assert.equal(requests[0].signal.aborted, false, 'driving tile still needs the shared neighbour');
    assert.equal(requests[1].signal.aborted, true, 'unused far request releases network capacity');
    requests[0].resolve(new Response(new Uint8Array([1, 2, 3])));
    const result = await b;
    await assert.rejects(far);
    world.cancel(2);
    assert.equal(await world.fetchBytes('shared', 'vector', 3), result, 'completed bytes stay cached');
    assert.equal(requests.length, 2);
    const retry = world.fetchBytes('far', 'vector', 3);
    assert.equal(requests.length, 3, 'a cancelled fetch can be requested later');
    requests[2].resolve(new Response(new Uint8Array([4])));
    await retry;
  } finally { globalThis.fetch = originalFetch; }
});
