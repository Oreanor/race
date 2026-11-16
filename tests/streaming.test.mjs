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
const { Heist } = await import('../src/game/crime/Heist.ts');
const { PreparedTransfer } = await import('../src/game/PreparedTransfer.ts');
const { missionAreas } = await import('../src/game/missionPopulation.ts');
const { cameraTransition } = await import('../src/game/cameraTransition.ts');
const { raceCourse, RaceProgress } = await import('../src/game/RaceCourse.ts');

function testRaceCourse() {
  const start = [-8.42, 40.2];
  const points = [[0, 0], [900, 500], [0, 1000], [900, 1500], [0, 2000], [900, 2500], [0, 3000]]
    .map(([x, y]) => offsetPosition(start, x, y));
  return raceCourse(start, points.slice(1).map((p, i) => [points[i], p]));
}

test('race preparation charges only once after success; cancellation and unavailable courses cost nothing', async () => {
  const originalRaf = globalThis.requestAnimationFrame, frames = [];
  globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  const course = testRaceCourse(), launched = [], offers = [];
  let result = course, plans = 0;
  const engine = Object.assign(Object.create(GameEngine.prototype), {
    racePreparation: 0, racePreparing: false, eventOffer: 'race', disposed: false, driving: true,
    vehicle: { position: course.start, heading: 0 }, playerMoney: 5000,
    map: { groundAt: () => 10 }, say() {},
    trafficNetwork: { *planRace() { plans++; yield null; return result; } },
    onEventOffer: offer => offers.push(offer), startRace: plan => launched.push(plan),
  });
  const drain = async task => {
    while (frames.length) { frames.shift()(0); await Promise.resolve(); }
    await task;
  };
  try {
    const task = engine.prepareRace();
    engine.prepareRace(); // A double-click must not start a second plan or charge.
    assert.equal(engine.playerMoney, 5000);
    assert.equal(offers.at(-1).preparing, true);
    await drain(task);
    assert.equal(plans, 1);
    assert.equal(engine.playerMoney, 4000);
    assert.deepEqual(launched, [course]);
    engine.eventOffer = 'race';
    const cancelled = engine.prepareRace();
    engine.declineEvent();
    await drain(cancelled);
    assert.equal(engine.playerMoney, 4000);
    assert.equal(launched.length, 1);
    engine.eventOffer = 'race'; result = null;
    await drain(engine.prepareRace());
    assert.equal(engine.playerMoney, 4000);
    assert.equal(engine.racePreparing, false);
    assert.equal(launched.length, 1);
  } finally { globalThis.requestAnimationFrame = originalRaf; }
});

test('engine cannot award a race to a player or bot at the finish before their checkpoints', () => {
  const course = testRaceCourse(), winners = [];
  const engine = Object.assign(Object.create(GameEngine.prototype), {
    driving: true, mode: 'race', raceCourse: course, raceGoal: course.finish,
    raceProgress: new RaceProgress(course, [{ id: 'player', position: course.start }, { id: 'race-0', position: course.start }]),
    raceStartAt: 0, raceDeadline: performance.now() + 600000, raceWarned: false,
    vehicle: { position: course.finish },
    trafficBots: [{ id: 'race-0', driver: 'Rival', position: course.finish }],
    combatLayer: { isTargetAlive: () => true }, botDriver: { forget() {} }, crime: { heist: null },
    updateBounty() {}, updateFire() {}, updateImpound() {}, updateTaxi() {}, updateAmbulance() {}, updateBus() {},
    ensureRaceGoalMarker() {}, syncMissionVisuals() {}, say() {}, endRace: id => winners.push(id),
  });
  engine.updateEvents();
  assert.deepEqual(winners, []);
  for (const point of course.checkpoints) { engine.vehicle.position = point; engine.updateEvents(); }
  assert.deepEqual(winners, []);
  engine.vehicle.position = course.finish;
  engine.updateEvents();
  assert.deepEqual(winners, ['player']);
});

test('camera fly-in preserves both endpoints, settles softly, and rotates through the shortest arc', () => {
  const from = { center: [-8.8, 40.15], zoom: 15, pitch: 0, bearing: 350, elevation: 100 };
  const to = { center: [-8.7, 40.16], zoom: 20.55, pitch: 73, bearing: 10, elevation: 25 };
  assert.deepEqual(cameraTransition(from, to, 0), from);
  const end = cameraTransition(from, to, 1);
  assert.deepEqual({ ...end, bearing: end.bearing % 360 }, to);
  assert.equal(cameraTransition(from, to, 0.5).bearing, 360);
  assert.ok(Math.abs(cameraTransition(from, to, 0.001).zoom - from.zoom) < 0.000001);
  assert.ok(Math.abs(cameraTransition(from, to, 0.999).zoom - to.zoom) < 0.000001);
  let previous = from;
  for (let i = 1; i <= 140; i++) {
    const frame = cameraTransition(from, to, i / 140);
    assert.ok(frame.zoom >= previous.zoom && frame.pitch >= previous.pitch);
    assert.ok(frame.zoom - previous.zoom < 0.08, 'no skipped zoom at any frame');
    previous = frame;
  }
});

test('engine starts fly-in on the visible frame and resumes after pause without consuming the paused time', () => {
  const originalDocument = globalThis.document;
  globalThis.document = { hidden: false };
  const stopAfterView = new Error('frame captured');
  const source = { center: [-8.8, 40.15], zoom: 15, pitch: 0, bearing: 0, elevation: 70 };
  let captured;
  const engine = Object.assign(Object.create(GameEngine.prototype), {
    disposed: false, ready: true, last: 0, driving: true, paused: false,
    approachFrom: source, approachElapsed: 0, approachMs: 2200,
    vehicle: { position: [-8.8, 40.15], heading: 0 }, altitude: 25,
    renderVehicle: { position: [-8.8, 40.15], reset() {} },
    map: { setStreamCalm() {}, setScreenStream() {}, jumpTo(view) { captured = view; throw stopAfterView; } },
  });
  try {
    assert.throws(() => engine.updateApproach(0), e => e === stopAfterView);
    assert.deepEqual(captured, source, 'first rendered frame is the intro, not halfway along the flight');
    assert.throws(() => engine.updateApproach(0.016), e => e === stopAfterView);
    const elapsed = engine.approachElapsed;
    engine.paused = true;
    engine.updateApproach(8);
    assert.equal(engine.approachElapsed, elapsed);
    engine.paused = false;
    assert.throws(() => engine.updateApproach(0.016), e => e === stopAfterView);
    assert.equal(engine.approachElapsed, elapsed + 16);
    assert.ok(captured.zoom - source.zoom < 0.001);
    globalThis.document.hidden = true;
    engine.updateApproach(8);
    assert.equal(engine.approachElapsed, elapsed + 16);
    globalThis.document.hidden = false;
    const completed = [];
    engine.map.jumpTo = view => { captured = view; };
    engine.map.setFocusCar = () => {};
    engine.map.beginStreamBurst = () => {};
    engine.onApproach = active => completed.push(active);
    engine.approachElapsed = 2184;
    engine.updateApproach(0.016);
    assert.equal(engine.approachFrom, null);
    assert.deepEqual(completed, [false]);
    assert.equal(captured.pitch, 73);
    assert.equal(captured.elevation, 25);
    assert.ok(captured.zoom > 20);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test('map streaming expands the driving ring, cancels distant work on close, and prioritises a transfer', () => {
  const focus = [-8.8, 40.15];
  const options = { ...defaultWorldOptions };
  const ring = tilesAround(focus, options.loadRadius, options.zoom);
  const world = Object.assign(Object.create(WorldTiles.prototype), {
    disposed: false, template: 'tiles', options,
    tiles: new Map(ring.map(t => [t.key, { waiting: [], fade: 1 }])),
    pending: new Map(), jobs: new Map(), workers: [], failures: new Map(), ringKeys: new Set(),
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
  const crime = new Heist({
    mode: 'arena', pickups: new Map(), playerMoney: 10000, playerHp: 0, playerMaxHp: 1000, mapLoaded: false,
    vehicle: { speed: 1, throttle: 1 }, renderVehicle: { reset() {} }, combatLayer: null,
    clearEventBots() {}, showEventBeacons() {}, refreshPickups() {}, nearestCivic: () => null, nearbyRoadSpot: () => null,
    audio: { explosion() {} }, onEventResult: r => { result = r; },
  });
  crime.heist = { cash: 123 };
  crime.arrest();
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
