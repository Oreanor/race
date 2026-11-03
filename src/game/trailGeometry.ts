export type TrailPoint = { x: number; y: number };

// Shared vertices at each join: adjacent segments never paint over each other.
export function ribbonEdges(points: TrailPoint[], halfWidth: number) {
  return points.map((p,i) => {
    const before=points[Math.max(0,i-1)],after=points[Math.min(points.length-1,i+1)];
    const direction=(a:TrailPoint,b:TrailPoint)=>{const dx=b.x-a.x,dy=b.y-a.y,l=Math.hypot(dx,dy)||1;return {x:dx/l,y:dy/l};};
    const incoming=direction(before,p),outgoing=direction(p,after);
    const a=i===0?outgoing:incoming,b=i===points.length-1?incoming:outgoing;
    const nx=-a.y-b.y,ny=a.x+b.x,length=Math.hypot(nx,ny)||1;
    const normal={x:nx/length,y:ny/length};
    const dot=Math.abs(normal.x*(-b.y)+normal.y*b.x);
    const width=Math.min(halfWidth/Math.max(0.2,dot),halfWidth*1.6);
    return [{x:p.x+normal.x*width,y:p.y+normal.y*width},{x:p.x-normal.x*width,y:p.y-normal.y*width}];
  });
}
