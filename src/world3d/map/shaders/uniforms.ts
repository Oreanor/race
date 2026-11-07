import * as THREE from 'three';
import { tileSpan } from '../../mercator.ts';

import { MAX_FIRES, MAX_SHOTS } from './common.ts';

export type BaseUniforms = {
  uExag: { value: number };
  uCameraPos: { value: THREE.Vector3 };
  uSun: { value: THREE.Vector3 };
  /** sunlight (or moonlight) colour × intensity, linear */
  uSunColor: { value: THREE.Color };
  /** sky light colour × intensity, linear */
  uAmbient: { value: THREE.Color };
  /** 0 day … 1 night: lit windows */
  uNight: { value: number };
  /** player headlights: position and direction in scene space, on (0..1) at night */
  uHeadPos: { value: THREE.Vector3 };
  uHeadDir: { value: THREE.Vector3 };
  /** half the distance between the two lamps, to the right */
  uHeadSide: { value: THREE.Vector3 };
  uHeadOn: { value: number };
  /** the nearest lit street lamps (scene xyz of the head, w = intensity), their count and colour */
  /** street light at night: its colour (by skin), 0..1 how lit (night), the tile size the baked maps cover */
  uLampColor: { value: THREE.Color };
  uLampOn: { value: number };
  uTileSpan: { value: number };
  /** 0 lamps light a cone down (classic heads), 1 all around (glass posts) */
  uLampOmni: { value: number };
  uFogColor: { value: THREE.Color };
  uFogNear: { value: number };
  /** seconds, for things that drift (cloud shadows) */
  uClock: { value: number };
  /** 0 … 1: how much the clouds' shadows show (by day only) */
  uClouds: { value: number };
  uFogFar: { value: number };
  /** per-tile ease-in (set just before each mesh draws); 1 = fully present */
  uTileFade: { value: number };
  /** player car in scene space; buildings between it and the camera turn see-through */
  uCar: { value: THREE.Vector3 };
  uXray: { value: number };
  /** recent bullet hits on walls (scene xyz, w = crack seed): the pane they hit shows cracks */
  uShots: { value: THREE.Vector4[] };
  uShotCount: { value: number };
  /** burning façade windows (scene xyz): that pane glows with fire */
  uFires: { value: THREE.Vector4[] };
  uFireCount: { value: number };
  /** architecture skin (buildings/skins): 0 city, 1 modern, 2 futuristic, 3 victorian, 4 mixed (per building) */
  uSkin: { value: number };
  /** weighted palettes × 3 banks (modern/futuristic/victorian): rgb (linear) + cumulative weight 0..1 */
  uSkinWall: { value: THREE.Vector4[] };
  uSkinRoof: { value: THREE.Vector4[] };
  /** per bank: secondary, glass, frame, trim, accent, night glow (linear rgb), 4 each → 24 × 3 */
  uSkinColors: { value: THREE.Vector3[] };
  /** per bank: lit share at night, accent chance, feature chance, wall lightness range */
  uSkinOpt: { value: THREE.Vector4[] };
  /** per bank: roof lightness range */
  uSkinRoofRange: { value: THREE.Vector3 };
};


export function baseUniforms(fogColor: string): BaseUniforms {
  return {
    uExag: { value: 0 },
    uCameraPos: { value: new THREE.Vector3() },
    uSun: { value: new THREE.Vector3(0.45, 0.8, 0.3).normalize() },
    uSunColor: { value: new THREE.Color(0.64, 0.62, 0.57) },
    uAmbient: { value: new THREE.Color(0.72, 0.73, 0.75) },
    uNight: { value: 0 },
    uHeadPos: { value: new THREE.Vector3() },
    uHeadDir: { value: new THREE.Vector3(0, 0, -1) },
    uHeadSide: { value: new THREE.Vector3(0.6, 0, 0) },
    uHeadOn: { value: 0 },
    uLampColor: { value: new THREE.Color(1, 0.8, 0.52) },
    uLampOn: { value: 0 },
    uTileSpan: { value: tileSpan(14) },
    uLampOmni: { value: 0 },
    uFogColor: { value: new THREE.Color().setStyle(fogColor, THREE.NoColorSpace) },
    // Fog is fully opaque before the load radius: tiles always arrive unseen.
    uFogNear: { value: 1100 },
    uClock: { value: 0 },
    uClouds: { value: 0 },
    uFogFar: { value: 2000 },
    uTileFade: { value: 1 },
    uCar: { value: new THREE.Vector3() },
    uXray: { value: 0 },
    uShots: { value: Array.from({ length: MAX_SHOTS }, () => new THREE.Vector4()) },
    uShotCount: { value: 0 },
    uFires: { value: Array.from({ length: MAX_FIRES }, () => new THREE.Vector4()) },
    uFireCount: { value: 0 },
    uSkin: { value: 0 },
    uSkinWall: { value: Array.from({ length: 15 }, () => new THREE.Vector4()) },
    uSkinRoof: { value: Array.from({ length: 15 }, () => new THREE.Vector4()) },
    uSkinColors: { value: Array.from({ length: 72 }, () => new THREE.Vector3()) },
    uSkinOpt: { value: Array.from({ length: 3 }, () => new THREE.Vector4(0.38, 0, 0, 0)) },
    uSkinRoofRange: { value: new THREE.Vector3() },
  };
}

