import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveVehicleCollision, VehicleController } from '../src/game/VehicleController.ts';
import { VehiclePose } from '../src/game/VehiclePose.ts';

test('render motion is uniform across 60, 120 and 144 Hz frames', () => {
  for (const hz of [60, 120, 144]) {
    const vehicle = { position: [0, 0] as [number, number], heading: 0, throttle: 1 };
    const pose = new VehiclePose();
    pose.reset(vehicle);
    let accumulator = 0;
    let last = 0;
    for (let frame = 0; frame < hz * 2; frame++) {
      accumulator += 1 / hz;
      while (accumulator >= 1 / 60) {
        pose.capture(vehicle);
        vehicle.position[0] += 1 / 60;
        accumulator -= 1 / 60;
      }
      pose.update(vehicle, accumulator * 60);
      if (frame > 3) assert.ok(Math.abs(pose.position[0] - last - 1 / hz) < 1e-10);
      assert.ok(pose.position[0] <= vehicle.position[0]);
      last = pose.position[0];
    }
  }
});

test('render pose resets on teleport and takes the short turn across north', () => {
  const vehicle = { position: [1, 2] as [number, number], heading: 359 * Math.PI / 180, throttle: 0 };
  const pose = new VehiclePose();
  pose.reset(vehicle);
  vehicle.heading = Math.PI / 180;
  pose.update(vehicle, 0.5);
  assert.ok(Math.abs(pose.heading - 2 * Math.PI) < 1e-10);
  vehicle.position = [10, 20];
  pose.reset(vehicle);
  pose.update(vehicle, 0);
  assert.deepEqual(pose.position, [10, 20]);
});
import { cars, vehicleConfig } from '../src/config/vehicle.config.ts';
import { circleHitsPolygon, BuildingCollisions } from '../src/game/BuildingCollisions.ts';
const config={maxSpeed:25,reverseSpeed:25/3.6,acceleration:7,braking:12,drag:1.7,handbrake:22,wheelbase:2.6};
test('speed is limited and steering works while accelerating',()=>{const v=new VehicleController([0,40],0);for(let i=0;i<600;i++)v.step(1/60,new Set(['KeyW','KeyA']),config);assert.equal(v.speed,25);assert.ok(v.heading<0);assert.ok(v.distance>100);});
test('top speed scales with the car',()=>{const v=new VehicleController([0,40],0);for(let i=0;i<600;i++)v.step(1/60,new Set(['KeyW']),{...config,scale:10});assert.equal(v.speed,250);});
test('a faster vehicle pushes the slower vehicle out of its footprint', () => {
  const meters = 111319.49;
  const a = { position: [0, 0] as [number, number], heading: 0, speed: 20, length: 4.2 };
  const b = { position: [0, 3 / meters] as [number, number], heading: 0, speed: 5, length: 4.2 };
  const collision = resolveVehicleCollision(a, b);
  assert.ok(collision);
  assert.equal(collision.slower, 'b');
  assert.deepEqual(collision.a, a.position);
  assert.ok(collision.b[1] > b.position[1]);
  assert.ok((collision.b[1] - a.position[1]) * meters > 4.2);
});
test('parallel vehicles outside each other width do not collide', () => {
  const meters = 111319.49;
  const collision = resolveVehicleCollision(
    { position: [0, 0], heading: 0, speed: 20, length: 4.2 },
    { position: [2.2 / meters, 0], heading: 0, speed: 5, length: 4.2 },
  );
  assert.equal(collision, null);
});
test('reverse reaches reverse speed',()=>{const v=new VehicleController([0,40],0);for(let i=0;i<300;i++)v.step(1/60,new Set(['KeyS']),config);assert.equal(v.speed,-config.reverseSpeed);});
test('space holds a fifty percent faster cap',()=>{const v=new VehicleController([0,40],0);for(let i=0;i<800;i++)v.step(1/60,new Set(['KeyW']),config);assert.equal(v.speed,config.maxSpeed);for(let i=0;i<800;i++)v.step(1/60,new Set(['KeyW','Space']),config);assert.equal(v.speed,config.maxSpeed*1.5);v.step(1/60,new Set(['KeyW']),config);assert.equal(v.speed,config.maxSpeed);});
test('clutch holds the car and builds revs at a standstill',()=>{
  const v=new VehicleController([0,40],0);
  for(let i=0;i<120;i++)v.step(1/60,new Set(['KeyW','ShiftLeft']),config);
  assert.ok(Math.abs(v.speed)<0.1);
  assert.ok(v.revs>0.7);
});
test('releasing the clutch launches from held revs',()=>{
  const v=new VehicleController([0,40],0);
  for(let i=0;i<120;i++)v.step(1/60,new Set(['KeyW','ShiftLeft']),config);
  assert.ok(v.revs>0.5);
  v.step(1/60,new Set(['KeyW']),config);
  assert.ok(v.speed>4);
});
test('clutch while moving only allows braking',()=>{
  const v=new VehicleController([0,40],0);
  for(let i=0;i<180;i++)v.step(1/60,new Set(['KeyW']),config);
  const before=v.speed;
  for(let i=0;i<60;i++)v.step(1/60,new Set(['KeyW','ShiftLeft']),config);
  assert.ok(v.speed<before);
  const coasting=v.speed;
  for(let i=0;i<60;i++)v.step(1/60,new Set(['KeyS','ShiftLeft']),config);
  assert.ok(v.speed<coasting-2);
});
test('ferrari pulls hardest, ford stays fast, howler is slower but not flat',()=>{const pace=(car:typeof cars[number])=>{const v=new VehicleController([0,40],0);for(let i=0;i<60;i++)v.step(1/60,new Set(['KeyW']),{...vehicleConfig,acceleration:car.acceleration,maxSpeed:car.maxSpeed});return v.speed;};const [ferrari,ford,howler]=cars.map(pace);assert.ok(ferrari>ford&&ford>howler);assert.ok(ferrari>14);assert.ok(howler>8);assert.ok(ford>howler+1);});
test('wall contact and courtyard geometry',()=>{const p:[number,number][][]=[[[0,0],[10,0],[10,10],[0,10],[0,0]],[[3,3],[7,3],[7,7],[3,7],[3,3]]];assert.equal(circleHitsPolygon([-0.5,5],1,p),true);assert.equal(circleHitsPolygon([-2,5],1,p),false);assert.equal(circleHitsPolygon([5,5],1,p),false);assert.equal(circleHitsPolygon([1,1],.5,p),true);});
test('swept collision prevents tunneling in both directions',()=>{const c=new BuildingCollisions();c.update([0,0],[[[[.0001,-.0001],[.00012,-.0001],[.00012,.0001],[.0001,.0001],[.0001,-.0001]]]]);assert.equal(c.blocked([0,0],[.0002,0],Math.PI/2),true);assert.equal(c.blocked([.0002,0],[0,0],Math.PI/2),true);assert.equal(c.blocked([0,.001],[.0002,.001],0),false);});
test('a car overlapping a building can move out but not deeper into it',()=>{
  const collision=new BuildingCollisions();
  const meters=111319.49;
  const building: [number,number][][]=[[[10/meters,-10/meters],[40/meters,-10/meters],[40/meters,10/meters],[10/meters,10/meters],[10/meters,-10/meters]]];
  collision.update([0,0],[building]);
  assert.equal(collision.blocked([12/meters,0],[5/meters,0],Math.PI/2),false);
  assert.equal(collision.blocked([12/meters,0],[25/meters,0],Math.PI/2),true);
});
test('vehicle width keeps wheels clear of a wall while driving alongside it',()=>{
  const collision=new BuildingCollisions();
  const meters=111319.49;
  const wall: [number,number][][]=[[[1.1/meters,-5/meters],[3/meters,-5/meters],[3/meters,5/meters],[1.1/meters,5/meters],[1.1/meters,-5/meters]]];
  collision.update([0,0],[wall]);
  assert.equal(collision.blocked([0,0],[0,2/meters],0),true);
});
test('building collision footprint grows with the car scale',()=>{
  const collision=new BuildingCollisions();
  const meters=111319.49;
  const wall: [number,number][][]=[[[2.1/meters,-5/meters],[3/meters,-5/meters],[3/meters,5/meters],[2.1/meters,5/meters],[2.1/meters,-5/meters]]];
  collision.update([0,0],[wall]);
  assert.equal(collision.blocked([0,0],[0,2/meters],0),false);
  assert.equal(collision.blocked([0,0],[0,2/meters],0,2),true);
});

test('a car clears a building only above its roof skin', () => {
  const collision = new BuildingCollisions();
  const meters = 111319.49;
  // 20×20 m house centred east of the origin, ridge along north, 8 m eaves / 10 m peak
  const rings: [number, number][][] = [[
    [10 / meters, -10 / meters], [30 / meters, -10 / meters],
    [30 / meters, 10 / meters], [10 / meters, 10 / meters], [10 / meters, -10 / meters],
  ]];
  collision.update([0, 0], [{
    rings,
    crest: 0,
    roof: {
      eaves: 8, peak: 10, half: 10,
      ridgeA: { x: 20 / meters, z: -10 / meters },
      ridgeB: { x: 20 / meters, z: 10 / meters },
    },
  }]);
  // on the ground the house is a wall
  assert.equal(collision.blocked([0, 0], [20 / meters, 0], Math.PI / 2, 1, 0), true);
  // skim the eaves (stop just inside the west wall): the nose sits further in under a higher pitch
  assert.equal(collision.blocked([0, 0], [11 / meters, 0], Math.PI / 2, 1, 7.5), true);
  assert.equal(collision.blocked([0, 0], [11 / meters, 0], Math.PI / 2, 1, 8.5), false);
  // through the ridge below the peak: still hits
  assert.equal(collision.blocked([0, 0], [20 / meters, 0], Math.PI / 2, 1, 9.5), true);
  // above the peak: clears the whole house
  assert.equal(collision.blocked([0, 0], [20 / meters, 0], Math.PI / 2, 1, 10.2), false);
  // roof support follows the pitch
  const eave = collision.supportAt([11 / meters, 0]);
  const ridge = collision.supportAt([20 / meters, 0]);
  assert.ok(eave != null && ridge != null);
  assert.ok(eave! < 8.4 && ridge! > 9.6, `eave ${eave} ridge ${ridge}`);
});

import { supportAltitude } from '../src/game/groundSupport.ts';
import { healthColor } from '../src/game/health.ts';
import { Euler, Vector3 } from 'three';
test('health colors switch at the two thirds and one third thresholds', () => {
  assert.equal(healthColor(661, 1000), 'green');
  assert.equal(healthColor(660, 1000), 'yellow');
  assert.equal(healthColor(331, 1000), 'yellow');
  assert.equal(healthColor(330, 1000), 'red');
  assert.equal(healthColor(0, 1000), 'red');
});

import { advanceTrafficBot, createTrafficBot, TrafficRoadNetwork } from '../src/game/TrafficBots.ts';

test('terrain support keeps wheels and belly above slopes even while tilt is catching up', () => {
  for (const pitch of [-0.3, 0, 0.3]) for (const roll of [-0.25, 0, 0.25]) {
    const samples = [
      {along:1.6,side:-0.85,height:12}, {along:1.6,side:0.85,height:11},
      {along:-1.6,side:-0.85,height:10}, {along:-1.6,side:0.85,height:9},
      {along:0,side:0,height:12.5},
    ];
    const altitude = supportAltitude(samples,pitch,roll);
    for (const sample of samples) {
      const point = new Vector3(-sample.side,0,-sample.along).applyEuler(new Euler(pitch,0,roll,'XYZ'));
      assert.ok(altitude+point.y >= sample.height-1e-9);
    }
  }
});

test('traffic bots follow connected road geometry using vehicle physics', () => {
  const network = new TrafficRoadNetwork();
  network.addFeatures([{
    geometry: {
      type: 'LineString',
      coordinates: [[0, 0], [0.0012, 0], [0.0012, 0.0045]],
    },
    properties: { class: 'secondary' },
  }]);
  const start = network.nearest([0, 0], new Set(), 0, 20);
  assert.ok(start);
  const route = network.route(start.id, Math.PI / 2, 0);
  assert.ok(route.length > 10);
  assert.ok(route.some(point => point[1] > 0.0001));

  const bot = createTrafficBot('bot-0', 'Ines', cars[1], network, [0, 0], Math.PI / 2, new Set());
  const initialPosition = [...bot.position] as [number, number];
  for (let frame = 0; frame < 120; frame++) {
    advanceTrafficBot(bot, 1 / 60, network, {
      ...vehicleConfig,
      acceleration: bot.car.acceleration,
      maxSpeed: bot.car.maxSpeed,
    });
  }
  const traveled = Math.hypot(
    (bot.position[0] - initialPosition[0]) * 111319.49 * Math.cos(initialPosition[1] * Math.PI / 180),
    (bot.position[1] - initialPosition[1]) * 111319.49,
  );
  assert.ok(bot.controller.distance > 0);
  assert.ok(traveled > 5 && traveled <= bot.controller.distance + 0.1);
  // the bot is placed away from the asked spot, on either leg: it drives along the road
  assert.ok(Math.min(Math.abs(bot.heading - Math.PI / 2), Math.abs(bot.heading)) < 0.2);
});

test('traffic bots on a small network drive to its far end, never reversing on the way', () => {
  const network = new TrafficRoadNetwork();
  network.addFeatures([{
    geometry: { type: 'LineString', coordinates: [[0, 0], [0.001, 0]] },
    properties: { class: 'minor' },
  }]);
  const bot = createTrafficBot('bot-1', 'Tiago', cars[1], network, [0, 0], Math.PI / 2, new Set());
  const initialHeading = bot.heading;
  let reachedEnd = false;
  for (let frame = 0; frame < 600; frame++) {
    advanceTrafficBot(bot, 1 / 60, network, {
      ...vehicleConfig,
      acceleration: bot.car.acceleration,
      maxSpeed: bot.car.maxSpeed,
    });
    // no turning back before the end of the road (at a dead end it may come round)
    if (bot.position[0] >= 0.00095) reachedEnd = true;
    if (!reachedEnd) assert.ok(Math.cos(bot.heading - initialHeading) > 0.5);
    assert.ok(bot.controller.speed >= -0.01);
    assert.ok(bot.position[0] >= -0.0002 && bot.position[0] <= 0.0012); // room to come round at a dead end, no more
  }
  assert.ok(bot.controller.distance > 20);
});

test('mission destinations are selected ahead on the loaded road network', () => {
  const network = new TrafficRoadNetwork();
  network.addFeatures([{
    geometry: {
      type: 'LineString',
      coordinates: [[0, 0], [0.0012, 0], [0.0012, 0.0045]],
    },
    properties: { class: 'secondary' },
  }]);

  const destination = network.destinationAhead([0, 0], Math.PI / 2, 417);
  assert.ok(destination);
  assert.ok(destination[0] > 0.0001);
  const start = network.nearest([0, 0]);
  assert.ok(start);
  const route = network.route(start.id, Math.PI / 2, 0, destination);
  assert.ok(route.length > 1);
  assert.ok(Math.hypot(
    (route[route.length - 1][0] - destination[0]) * 111319.49,
    (route[route.length - 1][1] - destination[1]) * 111319.49,
  ) < 45); // routes come in ~2 km chunks that stop within 40 m of the goal
});

test('road pickups are spaced along loaded streets and remain inside the visible radius', () => {
  const network = new TrafficRoadNetwork();
  network.addFeatures([{
    geometry: { type: 'LineString', coordinates: [[0, 0], [0.003, 0]] },
    properties: { class: 'secondary' },
  }]);

  const pickups = network.pickupLocations([0, 0], 330);
  assert.equal(pickups.length, 4);
  assert.equal(new Set(pickups.map(pickup => pickup.id)).size, pickups.length);
  for (const pickup of pickups) {
    assert.equal(pickup.position[1], 0);
    assert.ok(pickup.position[0] * 111319.49 <= 330);
  }
  for (let index = 1; index < pickups.length; index++) {
    assert.ok(Math.abs((pickups[index].position[0] - pickups[index - 1].position[0]) * 111319.49 - 75) < 0.1);
  }
});

test('road pickups keep their minimum spacing across short road segments', () => {
  const network = new TrafficRoadNetwork();
  const features = Array.from({ length: 8 }, (_, index) => ({
    geometry: {
      type: 'LineString' as const,
      coordinates: [
        [index * 0.0004, 0],
        [(index + 1) * 0.0004, 0],
      ],
    },
    properties: { class: 'secondary' },
  }));
  network.addFeatures(features);

  const pickups = network.pickupLocations([0, 0], 350);
  assert.ok(pickups.length > 1);
  for (let index = 0; index < pickups.length; index++) {
    for (let other = index + 1; other < pickups.length; other++) {
      const distance = (pickups[other].position[0] - pickups[index].position[0]) * 111319.49;
      assert.ok(Math.abs(distance) >= 74.9);
    }
  }
});

test('road network ingests new streets without rebuilding the whole graph', () => {
  const network = new TrafficRoadNetwork();
  network.addFeatures([{
    geometry: { type: 'LineString', coordinates: [[0, 0], [0.0012, 0]] },
    properties: { class: 'secondary' },
  }]);
  assert.equal(network.flushRebuild(), true);
  assert.equal(network.flushRebuild(), false);
  const first = network.nearest([0, 0]);
  assert.ok(first);

  network.addFeatures([{
    geometry: { type: 'LineString', coordinates: [[0.0012, 0], [0.0012, 0.0015]] },
    properties: { class: 'secondary' },
  }]);
  assert.equal(network.flushRebuild(), true);
  const corner = network.nearest([0.0012, 0]);
  assert.ok(corner);
  const route = network.route(first!.id, Math.PI / 2, 0, [0.0012, 0.0015]);
  assert.ok(route.length > 1);
  assert.ok(route.some(point => point[1] > 0.0005));
});

import { zoomForDistance } from '../src/config/camera.config.ts';

test('chase zoom pulls back at Vorkuta so the car stays in front of the camera', () => {
  const mid = zoomForDistance(15, 40);
  const vorkuta = zoomForDistance(15, 67.5);
  assert.equal(zoomForDistance(15), mid);
  assert.ok(mid - vorkuta > 0.8 && mid - vorkuta < 1.3);
});
