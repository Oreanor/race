export type Position = [number, number];
const radius = 6378137;
export function offsetPosition(origin: Position, east: number, north: number): Position { return [origin[0]+east/(radius*Math.cos(origin[1]*Math.PI/180))*180/Math.PI, origin[1]+north/radius*180/Math.PI]; }
export class VehicleController {
  position: Position; heading: number; speed=0; distance=0; throttle=0; slip=0;
  constructor(position: Position, heading:number) { this.position=[...position]; this.heading=heading*Math.PI/180; }
  step(dt:number, keys:Set<string>, config:{maxSpeed:number; reverseSpeed:number; acceleration:number; braking:number; drag:number; handbrake:number; wheelbase:number; scale?:number}) {
    const scale=config.scale??1, maxSpeed=config.maxSpeed*scale, reverseSpeed=config.reverseSpeed*scale, acceleration=config.acceleration*scale, braking=config.braking*scale, drag=config.drag*scale;
    const gas=keys.has('KeyW'), brake=keys.has('KeyS');
    const handbrake=(keys.has('ShiftLeft')||keys.has('ShiftRight')) && this.speed>2;
    const boost=keys.has('Space') && !brake && !handbrake && this.speed>=0;
    const limit=maxSpeed*(boost?1.5:1);
    if(gas) this.speed+= (this.speed<0?braking:acceleration)*dt;
    if(brake) this.speed-= (this.speed>0?braking:acceleration)*dt;
    if(handbrake) this.speed=Math.max(0, this.speed-(gas?config.handbrake*0.28:config.handbrake)*dt);
    if(!gas&&!brake&&!handbrake) { const loss=drag*dt; this.speed=Math.sign(this.speed)*Math.max(0,Math.abs(this.speed)-loss); }
    this.speed=Math.max(-reverseSpeed,Math.min(limit,this.speed));
    const steer=Number(keys.has('KeyD'))-Number(keys.has('KeyA'));
    const pace=this.speed/scale;
    const grip=steer*this.speed/config.wheelbase*0.38/(1+Math.abs(pace)*0.09);
    this.heading+=grip*(handbrake?2.8:1)*dt;
    const maxSlip=handbrake?1.35:0.42;
    const wanted=steer*Math.min(maxSlip, Math.max(0, pace)*(handbrake?0.05:0.014));
    this.slip+=(wanted-this.slip)*(1-Math.exp(-dt*(handbrake?2.2:7)));
    if(Math.abs(this.speed)<0.4) this.slip=0;
    this.throttle=(gas&&this.speed>0.35)||Math.abs(this.slip)>0.35?1:0;
    const travel=this.heading-this.slip;
    const move=this.speed*dt; this.distance+=Math.abs(move); this.position=offsetPosition(this.position,Math.sin(travel)*move,Math.cos(travel)*move);
  }
}
