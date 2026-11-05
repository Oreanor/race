export type Position = [number, number];
const radius = 6378137;
export function offsetPosition(origin: Position, east: number, north: number): Position { return [origin[0]+east/(radius*Math.cos(origin[1]*Math.PI/180))*180/Math.PI, origin[1]+north/radius*180/Math.PI]; }
export type VehicleBody = { position: Position; heading: number; speed: number; length: number };

export function resolveVehicleCollision(a: VehicleBody, b: VehicleBody, scale = 1) {
  const latitude = (a.position[1] + b.position[1]) * 0.5 * Math.PI / 180;
  const delta: [number, number] = [
    (b.position[0] - a.position[0]) * radius * Math.cos(latitude) * Math.PI / 180,
    (b.position[1] - a.position[1]) * radius * Math.PI / 180,
  ];
  const forwardA: [number, number] = [Math.sin(a.heading), Math.cos(a.heading)];
  const rightA: [number, number] = [Math.cos(a.heading), -Math.sin(a.heading)];
  const forwardB: [number, number] = [Math.sin(b.heading), Math.cos(b.heading)];
  const rightB: [number, number] = [Math.cos(b.heading), -Math.sin(b.heading)];
  const axes = [forwardA, rightA, forwardB, rightB];
  const halfLengthA = a.length * scale * 0.5;
  const halfLengthB = b.length * scale * 0.5;
  const halfWidthA = a.length * scale * 0.225;
  const halfWidthB = b.length * scale * 0.225;
  let minimumOverlap = Infinity;
  let collisionAxis: [number, number] | null = null;

  for (const axis of axes) {
    const projection = Math.abs(delta[0] * axis[0] + delta[1] * axis[1]);
    const extentA = halfLengthA * Math.abs(forwardA[0] * axis[0] + forwardA[1] * axis[1])
      + halfWidthA * Math.abs(rightA[0] * axis[0] + rightA[1] * axis[1]);
    const extentB = halfLengthB * Math.abs(forwardB[0] * axis[0] + forwardB[1] * axis[1])
      + halfWidthB * Math.abs(rightB[0] * axis[0] + rightB[1] * axis[1]);
    const overlap = extentA + extentB - projection;
    if (overlap <= 0) return null;
    if (overlap < minimumOverlap) {
      minimumOverlap = overlap;
      const direction = delta[0] * axis[0] + delta[1] * axis[1] < 0 ? -1 : 1;
      collisionAxis = [axis[0] * direction, axis[1] * direction];
    }
  }

  if (!collisionAxis) return null;
  const speedA = Math.abs(a.speed);
  const speedB = Math.abs(b.speed);
  const impulse = Math.min(1.5, Math.max(0.35, Math.abs(speedA - speedB) * 0.08));
  const separation = minimumOverlap + impulse;
  if (speedA > speedB + 0.1) {
    return { slower: 'b' as const, a: a.position, b: offsetPosition(b.position, collisionAxis[0] * separation, collisionAxis[1] * separation) };
  }
  if (speedB > speedA + 0.1) {
    return { slower: 'a' as const, a: offsetPosition(a.position, -collisionAxis[0] * separation, -collisionAxis[1] * separation), b: b.position };
  }
  return {
    slower: 'both' as const,
    a: offsetPosition(a.position, -collisionAxis[0] * separation * 0.5, -collisionAxis[1] * separation * 0.5),
    b: offsetPosition(b.position, collisionAxis[0] * separation * 0.5, collisionAxis[1] * separation * 0.5),
  };
}

/** Ground distance between two lng/lat points in meters (flat-earth, fine for a city). */
export function metersBetween(a: Position, b: Position) {
  const cos = Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  return Math.hypot((b[0] - a[0]) * 111319.49 * cos, (b[1] - a[1]) * 111319.49);
}

export class VehicleController {
  position: Position; heading: number; speed=0; distance=0; throttle=0; slip=0;
  /** Engine revs 0..1 (idle ≈ 0.08, redline = 1). */
  revs = 0.08;
  private launch = 0;
  private clutchWas = false;
  constructor(position: Position, heading:number) { this.position=[...position]; this.heading=heading*Math.PI/180; }
  step(dt:number, keys:Set<string>, config:{maxSpeed:number; reverseSpeed:number; acceleration:number; braking:number; drag:number; handbrake:number; wheelbase:number; scale?:number}) {
    const scale=config.scale??1, maxSpeed=config.maxSpeed*scale, reverseSpeed=config.reverseSpeed*scale, acceleration=config.acceleration*scale, braking=config.braking*scale, drag=config.drag*scale;
    const gas=keys.has('KeyW'), brake=keys.has('KeyS');
    const clutch=keys.has('ShiftLeft')||keys.has('ShiftRight');
    const stationary=Math.abs(this.speed)<0.35;
    // Dump held revs into a launch when the clutch comes up at a standstill.
    if(this.clutchWas && !clutch && this.revs>0.15 && stationary){
      this.speed+=this.revs*maxSpeed*0.38;
      this.launch=this.revs;
    }
    this.clutchWas=clutch;

    if(clutch){
      // Disengaged: gas does not drive; only braking (and staging revs when still).
      if(stationary && gas){
        this.speed=0;
        this.revs=Math.min(1, this.revs+dt*0.95);
        this.throttle=0.2+this.revs*0.8;
      }else{
        this.revs=Math.max(0.08, this.revs-dt*2.4);
        this.throttle=0;
        if(brake){
          if(this.speed>0) this.speed=Math.max(0, this.speed-braking*dt);
          else if(this.speed<0) this.speed=Math.min(0, this.speed+braking*dt);
        }else{
          const loss=drag*1.25*dt;
          this.speed=Math.sign(this.speed)*Math.max(0, Math.abs(this.speed)-loss);
        }
      }
      this.speed=Math.max(-reverseSpeed, Math.min(maxSpeed, this.speed));
    }else{
      const boost=keys.has('Space') && !brake && this.speed>=0;
      const limit=maxSpeed*(boost?1.5:1);
      if(gas) this.speed+=(this.speed<0?braking:acceleration)*dt;
      if(brake) this.speed-=(this.speed>0?braking:acceleration)*dt;
      if(this.launch>0){
        this.speed+=this.launch*acceleration*3.8*dt;
        this.launch=Math.max(0, this.launch-dt*2.6);
      }
      if(!gas&&!brake&&this.launch<=0){ const loss=drag*dt; this.speed=Math.sign(this.speed)*Math.max(0,Math.abs(this.speed)-loss); }
      this.speed=Math.max(-reverseSpeed,Math.min(limit,this.speed));
      const drive=Math.abs(this.speed)/(maxSpeed*(boost?1.5:1));
      const wanted=gas?0.12+drive*0.78+(boost?0.08:0):0.08+drive*0.4;
      this.revs+=(wanted-this.revs)*(1-Math.exp(-dt*7));
      if(this.launch>0.05) this.revs=Math.max(this.revs, this.launch*0.85);
      this.throttle=(gas&&this.speed>0.35)||Math.abs(this.slip)>0.35?1:0;
    }

    const steer=Number(keys.has('KeyD'))-Number(keys.has('KeyA'));
    const pace=this.speed/scale;
    const grip=steer*this.speed/config.wheelbase*0.38/(1+Math.abs(pace)*0.09);
    this.heading+=grip*dt;
    const wantedSlip=steer*Math.min(0.42, Math.max(0, pace)*0.014);
    this.slip+=(wantedSlip-this.slip)*(1-Math.exp(-dt*7));
    if(Math.abs(this.speed)<0.4) this.slip=0;
    const travel=this.heading-this.slip;
    const move=this.speed*dt; this.distance+=Math.abs(move); this.position=offsetPosition(this.position,Math.sin(travel)*move,Math.cos(travel)*move);
  }
}
