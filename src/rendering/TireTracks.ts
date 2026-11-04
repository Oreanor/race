import * as THREE from 'three';
import { offsetPosition, type Position } from '@/game/VehicleController';
import { ribbonEdges } from '@/game/trailGeometry';

type Sample = { position: Position; elevation: number; stroke: number; width: number };
const M=111319.49;
function local(origin: Position,p: Position){return {x:(p[0]-origin[0])*M*Math.cos(origin[1]*Math.PI/180),y:(p[1]-origin[1])*M};}
export class TireTracks {
  private samples: Sample[][]=[[],[]];
  private last: Position|null=null;
  private direction: {x:number;y:number}|null=null;
  private stroke=0;
  private lastScale=1;
  private material=new THREE.MeshBasicMaterial({color:'#302e2a',vertexColors:true,transparent:true,depthWrite:false,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1});
  private meshes=[0,1].map(()=>{
    const geo=new THREE.BufferGeometry();
    geo.setAttribute('position',new THREE.BufferAttribute(new Float32Array(96*2*3),3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color',new THREE.BufferAttribute(new Float32Array(96*2*4),4).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(new THREE.BufferAttribute(new Uint16Array(95*6),1));geo.setDrawRange(0,0);
    const mesh=new THREE.Mesh(geo,this.material);mesh.frustumCulled=false;mesh.renderOrder=1;return mesh;
  });
  constructor(scene: THREE.Scene){for(const mesh of this.meshes)scene.add(mesh);}
  update(here: Position, heading:number, scale:number, carLength:number, carAltitude:number, ground:(p:Position)=>number|null) {
    const step=this.last?local(this.last,here):null;
    const distance=step?Math.hypot(step.x,step.y):0;
    if(!this.last || distance>6*scale || scale!==this.lastScale) {this.stroke++;this.last=[...here];this.direction=null;this.lastScale=scale;}
    else if(step&&distance>=0.35*scale){
      const direction={x:step.x/distance,y:step.y/distance};
      if(this.direction&&direction.x*this.direction.x+direction.y*this.direction.y<0.25)this.stroke++;
      this.direction=direction;this.last=[...here];
      for(let wheel=0;wheel<2;wheel++){
        const side=(wheel===0?-0.85:0.85)*scale,back=carLength*0.31*scale;
        const position=offsetPosition(here,-Math.sin(heading)*back+Math.cos(heading)*side,-Math.cos(heading)*back-Math.sin(heading)*side);
        const elevation=ground(position);
        if(elevation==null){this.stroke++;continue;}
        const list=this.samples[wheel];list.push({position,elevation,stroke:this.stroke,width:0.13*scale});
        if(list.length>96)list.shift();
      }
    }
    for(let wheel=0;wheel<2;wheel++){
      const list=this.samples[wheel];
      while(list.length&&Math.hypot(...Object.values(local(here,list[0].position)))>14*scale)list.shift();
      const mesh=this.meshes[wheel],geo=mesh.geometry,positions=geo.getAttribute('position') as THREE.BufferAttribute,colors=geo.getAttribute('color') as THREE.BufferAttribute,index=geo.index!;
      let count=0;
      for(let start=0;start<list.length;){
        let end=start+1;while(end<list.length&&list[end].stroke===list[start].stroke)end++;
        const centers=list.slice(start,end).map(s=>local(here,s.position));
        const edges=ribbonEdges(centers,list[start].width);
        for(let j=0;j<edges.length;j++){
          const sample=list[start+j],dist=Math.hypot(centers[j].x,centers[j].y);
          const fade=Math.max(0,Math.min(1,(14*scale-dist)/(8*scale)));
          for(let side=0;side<2;side++){
            const p=edges[j][side],v=(start+j)*2+side;
            positions.setXYZ(v,(p.y*Math.sin(heading)-p.x*Math.cos(heading))/scale,(sample.elevation+0.035-carAltitude)/scale,(p.y*Math.cos(heading)+p.x*Math.sin(heading))/scale);
            colors.setXYZW(v,1,1,1,0.27*fade);
          }
          if(j>0){const a=(start+j-1)*2,b=a+2;for(const v of [a,b,a+1,a+1,b,b+1])index.setX(count++,v);}
        }
        start=end;
      }
      geo.setDrawRange(0,count);positions.needsUpdate=true;colors.needsUpdate=true;index.needsUpdate=true;
    }
  }
}
