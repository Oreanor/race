import * as THREE from 'three';
import { MercatorCoordinate, type CustomLayerInterface, type Map as LibreMap } from 'maplibre-gl';
import { PLANT_CAP, planVegetation, type VegetationInput } from '@/game/Vegetation';
import type { Position } from '@/game/VehicleController';

const LIMIT = PLANT_CAP;
export function vegetationLayer(origin: Position): CustomLayerInterface & { sync(input: Omit<VegetationInput, 'origin'>, terrain: boolean): void } {
  const scene = new THREE.Scene(), camera = new THREE.Camera();
  const foliage = new THREE.IcosahedronGeometry(1, 0);
  const trunk = new THREE.CylinderGeometry(0.13, 0.23, 1, 6);
  const leafMaterial = new THREE.MeshLambertMaterial({color:0xffffff});
  const barkMaterial = new THREE.MeshLambertMaterial({color:0x88654b});
  scene.add(new THREE.HemisphereLight(0xf4faff,0x8faac4,1.15));
  const sun = new THREE.DirectionalLight(0xfffaf0,0.65); sun.position.set(28,72,16); scene.add(sun);
  function batch() {
    const leaves = new THREE.InstancedMesh(foliage,leafMaterial,LIMIT*3);
    const trunks = new THREE.InstancedMesh(trunk,barkMaterial,LIMIT);
    leaves.count=0;trunks.count=0;
    // The combined map projection is supplied directly to the Three camera.
    leaves.frustumCulled=false;trunks.frustumCulled=false;
    return {leaves,trunks};
  }
  let shown=batch(), staging=batch();
  scene.add(shown.leaves,shown.trunks);
  let map: LibreMap, renderer: THREE.WebGLRenderer;
  let pending: {input: VegetationInput; terrain: boolean} | null=null;
  let work: Generator<null,void> | null=null;
  const object=new THREE.Object3D(), color=new THREE.Color();
  const greens=['#619447','#7da653','#53875a','#8eaf64','#689f76','#3d6b3a','#4e7d42','#2f5c34'];
  const place=MercatorCoordinate.fromLngLat(origin,0), meters=place.meterInMercatorCoordinateUnits();
  const matrix=new THREE.Matrix4().makeTranslation(place.x,place.y,place.z)
    .scale(new THREE.Vector3(meters,-meters,meters)).multiply(new THREE.Matrix4().makeRotationX(Math.PI/2));
  const ground = new Map<string, number>();
  function* rebuild(job: NonNullable<typeof pending>): Generator<null,void> {
    const plants=yield* planVegetation(job.input);
    staging.leaves.count=0;staging.trunks.count=0;
    let placed=0;
    for(const plant of plants) {
      if(++placed%6===0) yield null;
      let elevation=ground.get(plant.key);
      if(elevation==null) {
        const sampled=job.terrain?map.queryTerrainElevation(plant.position):0;
        // Wait for DEM coverage instead of placing trees below/above a hillside.
        if(sampled==null) continue;
        elevation=sampled;
        ground.set(plant.key, elevation);
      }
      const s=0.8+plant.seed*0.45;
      const tall=plant.seed>0.7;
      const height=plant.bush?(plant.mass?1.45:0.9)*s:(tall?7.2:5.6)*s;
      const radius=plant.bush?(plant.mass?1.85:1.2)*s:(plant.mass?(tall?2.15:2.55):2.05)*s;
      object.rotation.set(0,plant.seed*Math.PI*2,0);
      if(!plant.bush) {
        object.position.set(plant.x,elevation+height*0.3,plant.z);
        object.scale.set(s,height*0.6,s);object.updateMatrix();
        staging.trunks.setMatrixAt(staging.trunks.count++,object.matrix);
      }
      for(let lobe=0;lobe<3;lobe++) {
        const angle=plant.seed*6.28+lobe*2.094;
        const spread=lobe===0?0:radius*0.42;
        object.position.set(plant.x+Math.cos(angle)*spread,elevation+height*(plant.bush?0.75:0.7)+(lobe===0?radius*0.3:0),plant.z+Math.sin(angle)*spread);
        object.scale.set(radius*(lobe===0?1:0.78),radius*(tall&&!plant.bush?1.5:0.9),radius*(lobe===0?0.95:0.78));
        object.updateMatrix();
        const index=staging.leaves.count++;
        staging.leaves.setMatrixAt(index,object.matrix);
        color.set(greens[Math.floor(plant.seed*greens.length)]).multiplyScalar(lobe===0?1.06:0.96);
        staging.leaves.setColorAt(index,color);
      }
    }
    staging.leaves.instanceMatrix.needsUpdate=true;
    staging.trunks.instanceMatrix.needsUpdate=true;
    if(staging.leaves.instanceColor) staging.leaves.instanceColor.needsUpdate=true;
    // Keep the previous greenery visible until its complete replacement is ready.
    scene.remove(shown.leaves,shown.trunks);
    [shown,staging]=[staging,shown];
    scene.add(shown.leaves,shown.trunks);
  }
  return {
    id:'park-vegetation',type:'custom',renderingMode:'3d',
    sync(input,terrain) { pending={input:{...input,origin},terrain}; map?.triggerRepaint(); },
    onAdd(nextMap,gl) {
      map=nextMap;
      renderer=new THREE.WebGLRenderer({canvas:map.getCanvas(),context:gl as WebGL2RenderingContext});
      renderer.autoClear=false;renderer.outputColorSpace=THREE.SRGBColorSpace;
    },
    render(_gl,args) {
      if(!work&&pending) { work=rebuild(pending);pending=null; }
      const deadline=performance.now()+1.2;
      while(work&&performance.now()<deadline) {if(work.next().done)work=null;}
      if(work||pending)map.triggerRepaint();
      camera.projectionMatrix.fromArray(args.defaultProjectionData.mainMatrix).multiply(matrix);
      renderer.resetState();renderer.render(scene,camera);renderer.resetState();
    },
    onRemove() {
      pending=null;work=null;
      for(const group of [shown,staging]) { group.leaves.dispose();group.trunks.dispose(); }
      foliage.dispose();trunk.dispose();leafMaterial.dispose();barkMaterial.dispose();renderer?.dispose();
    },
  };
}
