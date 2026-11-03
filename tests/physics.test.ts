import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VehicleController } from '../src/game/VehicleController.ts';
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
test('reverse reaches reverse speed',()=>{const v=new VehicleController([0,40],0);for(let i=0;i<300;i++)v.step(1/60,new Set(['KeyS']),config);assert.equal(v.speed,-config.reverseSpeed);});
test('space holds a fifty percent faster cap',()=>{const v=new VehicleController([0,40],0);for(let i=0;i<800;i++)v.step(1/60,new Set(['KeyW']),config);assert.equal(v.speed,config.maxSpeed);for(let i=0;i<800;i++)v.step(1/60,new Set(['KeyW','Space']),config);assert.equal(v.speed,config.maxSpeed*1.5);v.step(1/60,new Set(['KeyW']),config);assert.equal(v.speed,config.maxSpeed);});
test('handbrake turns the nose while the car keeps sliding',()=>{
  const v=new VehicleController([0,40],0);
  for(let i=0;i<180;i++)v.step(1/60,new Set(['KeyW']),config);
  const carried=v.speed;
  const nose=v.heading;
  for(let i=0;i<40;i++)v.step(1/60,new Set(['KeyW','KeyA','ShiftLeft']),config);
  const plain=new VehicleController([0,40],0);
  for(let i=0;i<180;i++)plain.step(1/60,new Set(['KeyW']),config);
  for(let i=0;i<40;i++)plain.step(1/60,new Set(['KeyW','KeyA']),config);
  assert.ok(v.heading<nose-0.8);
  assert.ok(v.heading<plain.heading-0.4);
  assert.ok(v.speed>carried*0.55);
  assert.ok(Math.abs(v.slip)>0.4);
});
test('ferrari pulls hardest, ford stays fast, howler is slower but not flat',()=>{const pace=(car:typeof cars[number])=>{const v=new VehicleController([0,40],0);for(let i=0;i<60;i++)v.step(1/60,new Set(['KeyW']),{...vehicleConfig,acceleration:car.acceleration,maxSpeed:car.maxSpeed});return v.speed;};const [ferrari,ford,howler]=cars.map(pace);assert.ok(ferrari>ford&&ford>howler);assert.ok(ferrari>14);assert.ok(howler>8);assert.ok(ford>howler+1);});
test('wall contact and courtyard geometry',()=>{const p:[number,number][][]=[[[0,0],[10,0],[10,10],[0,10],[0,0]],[[3,3],[7,3],[7,7],[3,7],[3,3]]];assert.equal(circleHitsPolygon([-0.5,5],1,p),true);assert.equal(circleHitsPolygon([-2,5],1,p),false);assert.equal(circleHitsPolygon([5,5],1,p),false);assert.equal(circleHitsPolygon([1,1],.5,p),true);});
test('swept collision prevents tunneling in both directions',()=>{const c=new BuildingCollisions();c.update([0,0],[[[[.0001,-.0001],[.00012,-.0001],[.00012,.0001],[.0001,.0001],[.0001,-.0001]]]]);assert.equal(c.blocked([0,0],[.0002,0],Math.PI/2),true);assert.equal(c.blocked([.0002,0],[0,0],Math.PI/2),true);assert.equal(c.blocked([0,.001],[.0002,.001],0),false);});

import { supportAltitude } from '../src/game/groundSupport.ts';
import { Euler, Vector3 } from 'three';

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

import { zoomForDistance } from '../src/config/camera.config.ts';

test('chase zoom pulls back at Vorkuta so the car stays in front of the camera', () => {
  const mid = zoomForDistance(15, 40);
  const vorkuta = zoomForDistance(15, 67.5);
  assert.equal(zoomForDistance(15), mid);
  assert.ok(mid - vorkuta > 0.8 && mid - vorkuta < 1.3);
});
