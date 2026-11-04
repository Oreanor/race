import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planVegetation, PLANT_CAP, ThicketCollision, type VegetationInput } from '../src/game/Vegetation.ts';
import type { MapFeature } from '../src/game/WaterCollisionController.ts';
const M=111319.49;
const p=(x:number,y:number): [number,number]=>[x/M,y/M];
const ring=(x:number,y:number,w:number,h:number)=>[p(x,y),p(x+w,y),p(x+w,y+h),p(x,y+h),p(x,y)];
const feature=(rings: [number,number][][], kind='park'): MapFeature=>({geometry:{type:'Polygon',coordinates:rings},properties:{class:kind}});
function run(input: Partial<VegetationInput>={}) {
  const job=planVegetation({origin:[0,0],focus:[0,0],green:[feature([ring(-100,-100,200,200)])],obstacles:[],roads:[],...input});
  let result=job.next();while(!result.done)result=job.next();return result.value;
}
test('vegetation is stable across duplicate tiles, source order and camera movement',()=>{
  const a=feature([ring(-100,-100,200,200)]);
  const b=feature([ring(-40,-40,80,80)],'wood');
  const first=run({green:[a,b]});
  const again=run({green:[b,a,a],focus:p(5,5)});
  assert.ok(first.length>15);
  assert.deepEqual([...first].sort((a,b)=>a.key.localeCompare(b.key)),[...again].sort((a,b)=>a.key.localeCompare(b.key)));
});
test('plants respect polygon holes, water/buildings and road clearance',()=>{
  const plants=run({
    green:[feature([ring(-100,-100,200,200),ring(-30,-30,60,60)],'wood')],
    obstacles:[feature([ring(-100,40,200,60)],'water')],
    roads:[{geometry:{type:'LineString',coordinates:[p(-100,-55),p(100,-55)]},properties:{class:'primary'}}],
  });
  assert.ok(plants.length>0);
  for(const tree of plants){
    const x=tree.x,y=-tree.z;
    assert.ok(!(Math.abs(x)<30&&Math.abs(y)<30));
    assert.ok(y<40);
    assert.ok(Math.abs(y+55)>=17);
  }
});
test('sports fields stay empty and shrub zones contain only bushes',()=>{
  assert.equal(run({green:[feature([ring(-100,-100,200,200)],'pitch')]}).length,0);
  const shrubs=run({green:[feature([ring(-100,-100,200,200)],'shrubbery')]});
  assert.ok(shrubs.length>0);assert.ok(shrubs.every(p=>p.bush));
});
test('parks use individual trees and bushes rather than a solid mass',()=>{
  const wood=run({green:[feature([ring(-60,-60,120,120)],'wood')]});
  const park=run({green:[feature([ring(-60,-60,120,120)],'park')]});
  for (const plants of [wood, park]) {
    assert.ok(plants.length > 30);
    assert.ok(plants.every(plant => !('mass' in plant)));
    assert.ok(plants.some(plant => plant.bush));
    assert.ok(plants.some(plant => !plant.bush));
    assert.deepEqual(new Set(plants.filter(plant => !plant.bush).map(plant => plant.variant)).size, 3);
  }
});
test('a large forest is capped and remains individual plants',()=>{
  const plants=run({green:[feature([ring(-220,-220,440,440)],'wood')]});
  assert.ok(plants.length <= PLANT_CAP);
  assert.ok(plants.every(plant => !('mass' in plant)));
});
test('forests extend farther with a sparse outer ring and a lower plant budget',()=>{
  const plants=run({green:[feature([ring(-800,-800,1600,1600)],'wood')]});
  const distances=plants.map(plant=>Math.hypot(plant.x,plant.z));
  assert.ok(plants.length <= PLANT_CAP);
  assert.ok(distances.some(distance=>distance>600&&distance<=700));
});
test('roadside planting skips roads and obstacles',()=>{
  const plants=run({
    green:[],
    obstacles:[feature([ring(-10,-20,20,40)],'building')],
    roads:[{geometry:{type:'LineString',coordinates:[p(-110,-80),p(110,-80)]},properties:{class:'primary'}}],
  });
  assert.ok(plants.length > 5);
  assert.ok(plants.every(plant => Math.abs(-plant.z + 80) >= 17));
  assert.ok(plants.every(plant => !(Math.abs(plant.x) < 10 && Math.abs(-plant.z) < 20)));
});
test('boulevard rows place plants on both sides with even spacing and several tree types',()=>{
  const plants=run({
    green:[],
    roads:[{geometry:{type:'LineString',coordinates:[p(-100,0),p(100,0)]},properties:{class:'primary'}}],
  });
  const roadside = plants.filter(plant => plant.key.startsWith('r:'));
  assert.ok(roadside.length > 10);
  assert.ok(roadside.some(plant => -plant.z < 0));
  assert.ok(roadside.some(plant => -plant.z > 0));
  assert.ok(roadside.some(plant => plant.bush));
  assert.ok(roadside.some(plant => !plant.bush && plant.variant === 0));
  assert.ok(roadside.some(plant => !plant.bush && plant.variant === 1));
  assert.ok(roadside.some(plant => !plant.bush && plant.variant === 2));
});
test('roadside plant identity does not depend on road feature order',()=>{
  const first={geometry:{type:'LineString',coordinates:[p(-100,-30),p(100,-30)]},properties:{class:'primary'}};
  const second={geometry:{type:'LineString',coordinates:[p(-100,30),p(100,30)]},properties:{class:'primary'}};
  const forward=run({green:[],roads:[first,second]});
  const reversed=run({green:[],roads:[second,first]});
  assert.deepEqual(
    [...forward].filter(plant=>plant.key.startsWith('r:')).sort((a,b)=>a.key.localeCompare(b.key)),
    [...reversed].filter(plant=>plant.key.startsWith('r:')).sort((a,b)=>a.key.localeCompare(b.key)),
  );
});
test('open park lawn is driveable; only woods stay solid',()=>{
  const thicket=new ThicketCollision();
  const park=feature([ring(-80,-80,160,160)],'park');
  const road={geometry:{type:'LineString',coordinates:[p(-90,0),p(90,0)]},properties:{class:'primary'}};
  thicket.update([0,0],[park],[road]);
  assert.equal(thicket.blocked([0,0],[0,30/M]),false);
  assert.equal(thicket.blocked([0,0],[40/M,0]),false);
  thicket.update([0,0],[feature([ring(-80,-80,160,160)],'wood')],[road]);
  assert.equal(thicket.blocked([0,0],[0,30/M]),true);
  assert.equal(thicket.blocked([0,0],[40/M,0]),false);
  thicket.update([0,0],[feature([ring(-80,-80,160,160)],'grass')],[]);
  assert.equal(thicket.blocked([0,0],[0,30/M]),false);
});
test('a forest blocks the car footprint before its center crosses the boundary',()=>{
  const thicket=new ThicketCollision();
  thicket.update([0,0],[feature([ring(10,-20,60,40)],'wood')],[]);
  assert.equal(thicket.blocked(p(8.5,0),p(9.2,0)),true);
  assert.equal(thicket.blocked(p(8,0),p(8.5,0)),false);
});
test('a car inside a forest can head toward the edge but not deeper into it',()=>{
  const thicket=new ThicketCollision();
  thicket.update([0,0],[feature([ring(-80,-80,160,160)],'wood')],[]);
  assert.equal(thicket.blocked([0,30/M],[0,40/M]),false);
  assert.equal(thicket.blocked([0,30/M],[0,20/M]),true);
});
test('a park tree stops the car while empty grass beside it does not',()=>{
  const thicket=new ThicketCollision();
  thicket.update([0,0],[feature([ring(-80,-80,160,160)],'park')],[]);
  // Same hash grid as Vegetation dense band: tree at gx=1,gy=-1.
  const tree=p(10.645853500366211,-5.086665012836457);
  assert.equal(thicket.blocked(p(40,40),p(40.5,40)),false);
  assert.equal(thicket.blocked(p(10.645853500366211-2.5,-5.086665012836457),tree),true);
});
