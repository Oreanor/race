import type { Position } from './VehicleController';
type Point=[number,number];
export type Polygon=Point[][];
function inside(point:Point, ring:Point[]){let hit=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if(((a[1]>point[1])!==(b[1]>point[1]))&&(point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0]))hit=!hit;}return hit;}
function distanceSquared(p:Point,a:Point,b:Point){const dx=b[0]-a[0],dy=b[1]-a[1];const t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy||1)));return (p[0]-a[0]-t*dx)**2+(p[1]-a[1]-t*dy)**2;}
export function circleHitsPolygon(point:Point,radius:number,polygon:Polygon){if(inside(point,polygon[0])&&!polygon.slice(1).some(r=>inside(point,r)))return true;for(const ring of polygon)for(let i=0;i<ring.length;i++)if(distanceSquared(point,ring[i],ring[(i+1)%ring.length])<=radius*radius)return true;return false;}
export class BuildingCollisions {
 origin:Position=[0,0]; polygons:{rings:Polygon;bounds:number[]}[]=[];
 local(p:Position):Point{return [(p[0]-this.origin[0])*111319.49*Math.cos(this.origin[1]*Math.PI/180),(p[1]-this.origin[1])*111319.49];}
 update(origin:Position,polygons:Polygon[]){this.origin=[...origin];this.polygons=polygons.map(p=>{const rings=p.map(r=>r.map(v=>this.local(v)));const outer=rings[0];return{rings,bounds:[Math.min(...outer.map(p=>p[0])),Math.min(...outer.map(p=>p[1])),Math.max(...outer.map(p=>p[0])),Math.max(...outer.map(p=>p[1]))]};});}
 blocked(from:Position,to:Position,heading:number){const start=this.local(from),end=this.local(to);const count=Math.max(1,Math.ceil(Math.hypot(end[0]-start[0],end[1]-start[1])/0.4));for(let step=0;step<=count;step++){const center:Point=[start[0]+(end[0]-start[0])*step/count,start[1]+(end[1]-start[1])*step/count];for(const shift of [-1.1,0,1.1]){const p:Point=[center[0]+Math.sin(heading)*shift,center[1]+Math.cos(heading)*shift];for(const polygon of this.polygons){const [x0,y0,x1,y1]=polygon.bounds;if(p[0]+.95<x0||p[0]-.95>x1||p[1]+.95<y0||p[1]-.95>y1)continue;if(circleHitsPolygon(p,.95,polygon.rings))return true;}}}return false;}
}
