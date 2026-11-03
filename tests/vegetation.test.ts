import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planVegetation, ThicketCollision, type VegetationInput } from '../src/game/Vegetation.ts';
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
test('woods and parks are a mass while lawns stay a scatter',()=>{
  const wood=run({green:[feature([ring(-60,-60,120,120)],'wood')]}).length;
  const park=run({green:[feature([ring(-60,-60,120,120)],'park')]}).length;
  const grass=run({green:[feature([ring(-60,-60,120,120)],'grass')]}).length;
  assert.ok(wood>400&&park>400);
  assert.ok(grass>15&&grass<wood/3);
});
test('trees beside the car stay when a huge forest would otherwise overflow',()=>{
  const plants=run({green:[feature([ring(-220,-220,440,440)],'wood')]});
  const beside=plants.filter(p=>Math.hypot(p.x-120,p.z)<18);
  assert.ok(beside.length>6);
});
test('a park stops the car except on the road through it',()=>{
  const thicket=new ThicketCollision();
  const park=feature([ring(-80,-80,160,160)],'park');
  const road={geometry:{type:'LineString',coordinates:[p(-90,0),p(90,0)]},properties:{class:'primary'}};
  thicket.update([0,0],[park],[road]);
  assert.equal(thicket.blocked([0,0],[0,30/M]),true);
  assert.equal(thicket.blocked([0,0],[40/M,0]),false);
  thicket.update([0,0],[feature([ring(-80,-80,160,160)],'grass')],[]);
  assert.equal(thicket.blocked([0,0],[0,30/M]),false);
});
