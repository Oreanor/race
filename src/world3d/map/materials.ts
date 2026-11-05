import * as THREE from 'three';
import { tileSpan } from '../mercator';
import { portuguesePastel } from '@/game/buildings/BuildingStyles';
import { seasonWeights, snowCover, worldTime } from './simpleLit';

// Shaders of the base world (ground, roads, far buildings). The camera matrix is
// a full scene→clip matrix (MapLibre style), so distances for fog are measured
// against uCameraPos in scene space instead of view space.

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
  uFogFar: { value: number };
  /** player car in scene space; buildings between it and the camera turn see-through */
  uCar: { value: THREE.Vector3 };
  uXray: { value: number };
  /** recent bullet hits on walls (scene xyz, w = crack seed): the pane they hit shows cracks */
  uShots: { value: THREE.Vector4[] };
  uShotCount: { value: number };
  /** architecture skin (buildings/skins): 0 the city's own look, 1 modern, 2 futuristic, 3 victorian */
  uSkin: { value: number };
  /** weighted palettes: rgb (linear) + cumulative weight 0..1 */
  uSkinWall: { value: THREE.Vector4[] };
  uSkinRoof: { value: THREE.Vector4[] };
  /** secondary wall, glass, frame, trim, accent, night glow (linear rgb), 4 each */
  uSkinColors: { value: THREE.Vector3[] };
  /** lit share at night, accent chance, feature chance, wall lightness range */
  uSkinOpt: { value: THREE.Vector4 };
  uSkinRoofRange: { value: number };
};

/** bullet-hit windows the facade shader knows about at once */
export const MAX_SHOTS = 64;

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
    uFogFar: { value: 2000 },
    uCar: { value: new THREE.Vector3() },
    uXray: { value: 0 },
    uShots: { value: Array.from({ length: MAX_SHOTS }, () => new THREE.Vector4()) },
    uShotCount: { value: 0 },
    uSkin: { value: 0 },
    uSkinWall: { value: Array.from({ length: 5 }, () => new THREE.Vector4()) },
    uSkinRoof: { value: Array.from({ length: 5 }, () => new THREE.Vector4()) },
    uSkinColors: { value: Array.from({ length: 24 }, () => new THREE.Vector3()) },
    uSkinOpt: { value: new THREE.Vector4(0.38, 0, 0, 0) },
    uSkinRoofRange: { value: 0 },
  };
}

const COMMON = /* glsl */ `
uniform vec3 uSun;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform float uNight;
uniform vec3 uHeadPos;
uniform vec3 uHeadDir;
uniform vec3 uHeadSide;
uniform float uHeadOn;
vec3 headBeam(vec3 world, vec3 n, vec3 lamp) {
  vec3 d = world - lamp;
  float dist = length(d);
  if (dist > 55.0) return vec3(0.0);
  vec3 l = d / max(dist, 0.001);
  // a soft-edged cone, a bit wider across than up and down
  vec3 side = normalize(cross(uHeadDir, vec3(0.0, 1.0, 0.0)));
  float across = dot(l, side);
  float along = dot(l, uHeadDir);
  float cone = smoothstep(0.86, 0.97, along - across * across * 0.35);
  float fall = 1.0 / (1.0 + dist * dist * 0.008) * smoothstep(55.0, 18.0, dist);
  float facing = clamp(dot(n, -l) * 0.85 + 0.3, 0.0, 1.0);
  return vec3(1.0, 0.92, 0.78) * cone * fall * facing;
}
// the car's two headlights, warm, fading with distance
vec3 headlight(vec3 world, vec3 n) {
  if (uHeadOn < 0.01) return vec3(0.0);
  return (headBeam(world, n, uHeadPos + uHeadSide) + headBeam(world, n, uHeadPos - uHeadSide)) * 1.35 * uHeadOn;
}

uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform vec3 uCameraPos;
vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
vec3 fogged(vec3 color, vec3 world) {
  float f = smoothstep(uFogNear, uFogFar, distance(world, uCameraPos));
  return mix(color, toLinear(uFogColor), f);
}
`;

function hex(value: string) {
  return new THREE.Color().setStyle(value, THREE.NoColorSpace);
}

/**
 * Street light baked per tile (tiles/vegetationTile lampLight): the vertex passes
 * the tile-local position, the fragment reads the pool there. The map is set per
 * mesh just before it draws (WorldTiles.lampLit).
 */
const LAMP_VERTEX = /* glsl */ `
  uniform float uTileSpan;
  varying vec2 vLampUv;
`;
const LAMP_FRAGMENT = /* glsl */ `
  uniform sampler2D uLampMap;
  uniform vec3 uLampColor;
  uniform float uLampOn;
  varying vec2 vLampUv;
  vec3 lampLight() {
    if (uLampOn < 0.01) return vec3(0.0);
    return uLampColor * texture2D(uLampMap, vLampUv).r * uLampOn * 1.7;
  }
`;
/** a per-material slot for the tile's light map (filled before each mesh draws) */
const lampMapUniform = () => ({ uLampMap: { value: null as THREE.Texture | null } });

/** Terrain tile with its ground raster. One material per tile (own texture). */
const GROUND_VERTEX = /* glsl */ `
  uniform float uExag;
  attribute float aGround;
  attribute vec3 aColor;
  varying vec3 vColor;
  varying vec3 vWorld;
  ${LAMP_VERTEX}
  void main() {
    vColor = aColor;
    vLampUv = position.xz / uTileSpan;
    vec4 world = modelMatrix * vec4(position.x, position.y + aGround * uExag, position.z, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const GROUND_FRAGMENT = /* glsl */ `
  ${COMMON}
  ${LAMP_FRAGMENT}
  uniform vec4 uSeason;
  uniform float uSnow;
  varying vec3 vColor;
  varying vec3 vWorld;
  void main() {
    vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    if (n.y < 0.0) n = -n;
    // winter snow on grass / woods / parks only — roads and beige city stay clear;
    // uSnow is 0 equatorward of ~42° so mild winters stay green
    float greenish = smoothstep(0.02, 0.1, vColor.g - max(vColor.r, vColor.b))
      * smoothstep(0.4, 0.55, vColor.g);
    float mottled = 0.5 + 0.5 * sin(vWorld.x * 1.55) * sin(vWorld.z * 1.7);
    vec3 snow = vec3(0.91, 0.935, 0.96) * mix(0.93, 1.03, mottled);
    vec3 albedo = mix(vColor, snow, uSeason.w * uSnow * greenish);
    // sky light plus sunlight on the slope (hillshade comes from the real sun)
    vec3 light = uAmbient * 0.9 + uSunColor * 0.55 * max(dot(n, uSun), 0.0) + (headlight(vWorld, n) + lampLight()) * 0.91;
    gl_FragColor = linearToOutputTexel(vec4(fogged(toLinear(albedo) * light / 0.91, vWorld), 1.0));
  }
`;

/** Terrain: vertex-coloured ground (bank colour next to water). */
export function groundMaterial(u: BaseUniforms) {
  return new THREE.ShaderMaterial({
    uniforms: { ...u, ...lampMapUniform(), uSeason: seasonWeights, uSnow: snowCover },
    vertexShader: GROUND_VERTEX, fragmentShader: GROUND_FRAGMENT,
  });
}

/**
 * Land-use polygons lying exactly on the terrain triangles; layer 0..2 are
 * stacked with growing polygon offsets (landuse < landcover < park).
 */
export function overlayMaterial(u: BaseUniforms, layer: number) {
  return new THREE.ShaderMaterial({
    uniforms: { ...u, ...lampMapUniform(), uSeason: seasonWeights, uSnow: snowCover },
    vertexShader: GROUND_VERTEX, fragmentShader: GROUND_FRAGMENT,
    // overlapping land-use polygons lie in the same plane: no depth writes, so they never
    // fight each other; the draw order (renderOrder per layer) decides which is on top
    depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });
}

/**
 * Water: shallow turquoise at the shore to deep blue, animated ripples, sky
 * reflection (fresnel), sun glint and a soft foam line along the banks.
 */
export function waterMaterial(u: BaseUniforms) {
  return new THREE.ShaderMaterial({
    uniforms: { ...u, uTime: worldTime },
    vertexShader: /* glsl */ `
      uniform float uExag;
      attribute float aGround;
      attribute float aShore;
      attribute vec3 aColor;
      varying float vShore;
      varying float vPool;
      varying vec3 vWorld;
      void main() {
        vShore = aShore;
        vPool = aColor.r * 255.0;
        vec4 world = modelMatrix * vec4(position.x, position.y + aGround * uExag, position.z, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      ${COMMON}
      uniform float uTime;
      varying float vShore;
      varying float vPool;
      varying vec3 vWorld;
      void main() {
        vec2 p = vWorld.xz;
        float t = uTime;
        // two crossing wave trains for the surface normal
        // gentle, irregular ripples; they fade with distance so they never turn into stripes
        float fade = 1.0 / (1.0 + distance(vWorld, uCameraPos) / 120.0);
        float dx = 0.022 * cos(p.x * 0.37 + p.y * 0.11 + t * 1.1) + 0.016 * cos((p.x + p.y) * 0.83 - t * 1.7) + 0.009 * cos(p.x * 2.1 + p.y * 1.3 + t * 2.4);
        float dz = 0.022 * cos(p.y * 0.41 - p.x * 0.13 - t * 0.9) + 0.016 * cos((p.y - p.x) * 0.77 + t * 1.5) + 0.009 * cos(p.y * 1.9 - p.x * 1.1 - t * 2.2);
        vec3 n = normalize(vec3(-dx * fade, 1.0, -dz * fade));
        vec3 toEye = normalize(uCameraPos - vWorld);
        float depth = smoothstep(0.0, 22.0, vShore);
        vec3 shallow = toLinear(vPool > 0.5 ? vec3(0.55, 0.86, 0.9) : vec3(0.36, 0.76, 0.8));
        vec3 deep = toLinear(vPool > 0.5 ? vec3(0.3, 0.7, 0.82) : vec3(0.13, 0.42, 0.58));
        vec3 base = mix(shallow, deep, depth) * (uAmbient * 0.95 + uSunColor * 0.35 * max(uSun.y, 0.0));
        float fresnel = pow(1.0 - max(dot(n, toEye), 0.0), 4.0);
        // reflected sky, a little bluer than the haze so water stays water at grazing angles
        vec3 sky = toLinear(uFogColor) * vec3(0.78, 0.9, 1.0) * (0.6 + 0.4 * uAmbient.g / 0.73);
        vec3 color = mix(base, sky, 0.06 + 0.38 * fresnel);
        float glint = pow(max(dot(reflect(-uSun, n), toEye), 0.0), 120.0);
        color += uSunColor * 2.4 * glint * step(0.0, uSun.y);
        // foam: a thin, broken, gently moving line right at the bank
        float wobble = 0.5 + 0.5 * sin(p.x * 1.7 + t * 1.3) * sin(p.y * 1.9 - t * 1.1);
        float foam = (1.0 - smoothstep(0.1, 0.45 + 0.45 * wobble, vShore)) * (vPool > 0.5 ? 0.2 : 0.45) * step(0.35, wobble);
        color = mix(color, toLinear(vec3(0.94, 0.97, 0.97)) * (uAmbient + uSunColor * 0.4), foam);
        gl_FragColor = linearToOutputTexel(vec4(fogged(color, vWorld), 1.0));
      }
    `,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
  });
}

export function roadMaterial(u: BaseUniforms) {
  return new THREE.ShaderMaterial({
    uniforms: { ...u, ...lampMapUniform() },
    vertexShader: /* glsl */ `
      uniform float uExag;
      attribute float aGround;
      attribute vec3 aColor;
      varying vec3 vColor;
      varying vec3 vWorld;
      ${LAMP_VERTEX}
      void main() {
        vColor = aColor;
        vLampUv = position.xz / uTileSpan;
        vec4 world = modelMatrix * vec4(position.x, position.y + aGround * uExag, position.z, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      ${COMMON}
      ${LAMP_FRAGMENT}
      varying vec3 vColor;
      varying vec3 vWorld;
      void main() {
        vec3 light = (uAmbient * 0.9 + uSunColor * 0.55 * max(uSun.y, 0.0)) / 0.91 + headlight(vWorld, vec3(0.0, 1.0, 0.0)) + lampLight();
        gl_FragColor = linearToOutputTexel(vec4(fogged(toLinear(vColor) * light, vWorld), 1.0));
      }
    `,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -10,
  });
}

/** Window mask, same layout as the detailed facade texture. */
export function facadeMask(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 160, 64);
  for (const x of [10, 48, 86, 124]) {
    ctx.fillStyle = '#00ff00';
    ctx.fillRect(x, 8, 30, 42);
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(x + 4, 12, 22, 34);
    ctx.fillStyle = '#00ff00';
    ctx.fillRect(x + 14, 12, 2, 34);
    ctx.fillRect(x + 4, 27, 22, 2);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.anisotropy = 8;
  return texture;
}

/**
 * All buildings: one draw call per chunk. Windows are drawn analytically from
 * each wall's grid (columns, rows, steps, pane size — the same layout the old
 * detailed layer painted), crisp up close and averaged far away, so the look is
 * continuous at every distance. Walls between the camera and the car dither away.
 */
export function farBuildingMaterial(u: BaseUniforms, mask: THREE.Texture) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...u,
      ...lampMapUniform(),
      uMask: { value: mask },
      uGlass0: { value: hex(portuguesePastel.windowColors[0]) },
      uGlass1: { value: hex(portuguesePastel.windowColors[1]) },
      uGlass2: { value: hex(portuguesePastel.windowColors[2]) },
      uGlass3: { value: hex(portuguesePastel.windowColors[3]) },
      uFrame: { value: hex(portuguesePastel.frameColor) },
    },
    vertexShader: /* glsl */ `
      uniform float uExag;
      attribute vec3 aColor;
      attribute vec3 aFacade;
      attribute float aGround;
      attribute vec4 aWin;
      attribute vec2 aWinSize;
      varying vec3 vColor;
      varying vec3 vFacade;
      varying vec3 vNormal;
      varying vec3 vWorld;
      varying float vHeight;
      varying vec4 vWin;
      varying vec2 vWinSize;
      ${LAMP_VERTEX}
      void main() {
        vColor = aColor;
        vFacade = aFacade;
        vLampUv = position.xz / uTileSpan;
        vWin = aWin;
        vWinSize = aWinSize;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vHeight = position.y;
        vec4 world = modelMatrix * vec4(position.x, position.y + aGround * uExag, position.z, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      ${COMMON}
      ${LAMP_FRAGMENT}
      uniform sampler2D uMask;
      uniform vec3 uGlass0;
      uniform vec3 uGlass1;
      uniform vec3 uGlass2;
      uniform vec3 uGlass3;
      uniform vec3 uFrame;
      uniform vec3 uCar;
      uniform float uXray;
      uniform vec4 uShots[${MAX_SHOTS}];
      uniform int uShotCount;
      uniform float uSkin;
      uniform vec4 uSkinWall[5];
      uniform vec4 uSkinRoof[5];
      uniform vec3 uSkinColors[24];
      uniform vec4 uSkinOpt;
      uniform float uSkinRoofRange;
      float seeded(vec3 c, float salt) { return fract(sin(dot(c, vec3(12.9898, 78.233, 37.719)) + salt) * 43758.5453); }
      vec3 pickWall(float r) { for (int i = 0; i < 5; i++) if (r <= uSkinWall[i].w) return uSkinWall[i].rgb; return uSkinWall[4].rgb; }
      vec3 pickRoof(float r) { for (int i = 0; i < 5; i++) if (r <= uSkinRoof[i].w) return uSkinRoof[i].rgb; return uSkinRoof[4].rgb; }
      // slots of uSkinColors: 0 secondary, 4 glass, 8 frame, 12 trim, 16 accent, 20 glow
      vec3 slot(int base, float r) { return uSkinColors[base + int(floor(r * 3.999))]; }
      // victorian palettes (sRGB), one of four by roll
      vec3 pick4(float r, vec3 a, vec3 b, vec3 c, vec3 d) { return toLinear(r < 0.25 ? a : r < 0.5 ? b : r < 0.75 ? c : d); }
      vec3 vicStucco(float r) { return pick4(r, vec3(0.91, 0.86, 0.77), vec3(0.85, 0.78, 0.66), vec3(0.81, 0.81, 0.78), vec3(0.91, 0.87, 0.66)); }
      vec3 vicBrick(float r) { return pick4(r, vec3(0.48, 0.33, 0.27), vec3(0.43, 0.38, 0.35), vec3(0.54, 0.31, 0.26), vec3(0.5, 0.38, 0.31)); }
      vec3 vicStone(float r) { return pick4(r, vec3(0.8, 0.72, 0.58), vec3(0.72, 0.68, 0.61), vec3(0.77, 0.76, 0.73), vec3(0.76, 0.7, 0.6)); }
      vec3 vicPaint(float r) { return pick4(r, vec3(0.62, 0.71, 0.77), vec3(0.65, 0.71, 0.6), vec3(0.66, 0.67, 0.66), vec3(0.82, 0.76, 0.64)); }
      // joint lines of a running-bond pattern of cell size (1 on a joint)
      float joints(vec2 m, vec2 size, vec2 width) {
        vec2 b = m / size;
        b.x += mod(floor(b.y), 2.0) * 0.5;
        vec2 q = abs(fract(b) - 0.5);
        return max(step(0.5 - width.y, q.y), step(0.5 - width.x, q.x));
      }
      varying vec3 vColor;
      varying vec3 vFacade;
      varying vec3 vNormal;
      varying vec3 vWorld;
      varying float vHeight;
      varying vec4 vWin;
      varying vec2 vWinSize;
      // 1 inside the centred rectangle of half-size h, antialiased by aa
      float box(vec2 p, vec2 h, vec2 aa) {
        vec2 q = smoothstep(h + aa, h - aa, abs(p));
        return q.x * q.y;
      }
      // ---- the city's own look (skin 0): one facade archetype per building, all from its seed.
      // Archetypes: 0 plain stucco (sparse windows), 1 Italian (framed, cornice), 2 Portuguese
      // (contrasting frames, now and then shutters), 3 southern urban (wide windows, marked
      // ground floor), 4 old European (tall windows, a belt course).
      // Window kinds: 0 plain, 1 tall and narrow, 2 framed, 3 shutters, 4 French (to the floor).
      struct CityWin { vec2 size; vec2 off; float open; float share; float kind; };
      float cityArch() { float r = seeded(vColor, 31.3); return r < 0.3 ? 0.0 : r < 0.5 ? 1.0 : r < 0.7 ? 2.0 : r < 0.85 ? 3.0 : 4.0; }
      CityWin cityWindow(vec2 cell, vec2 cellM, vec2 pane, float cols) {
        float arch = cityArch();
        float hr = seeded(vColor, 17.9), hk = seeded(vColor, 23.3);
        CityWin w;
        // kind: mostly the archetype's own, shutters and French windows only on a few houses
        float kind = arch == 1.0 ? 2.0 : arch == 4.0 ? 1.0 : 0.0;
        if (arch == 2.0) kind = hk < 0.3 ? 3.0 : 2.0;
        if (hk > 0.88 && arch != 0.0) kind = 4.0;
        // rhythm, symmetric about the middle of the wall: all bays, every other bay with
        // wider windows, pairs, or groups of three; the plain stucco houses never get all bays
        float c = min(cell.x, cols - 1.0 - cell.x);
        float rhythm = arch == 0.0 ? 1.0 + floor(hr * 2.999) : hr < 0.45 ? 0.0 : hr < 0.65 ? 1.0 : hr < 0.85 ? 2.0 : 3.0;
        if (cols < 3.0) rhythm = 0.0;
        float open = 1.0, share = 1.0, widen = 1.0;
        if (rhythm == 1.0) { open = 1.0 - mod(c, 2.0); share = 0.55; widen = 1.3; }
        else if (rhythm == 2.0) { open = step(0.5, abs(mod(c, 3.0) - 2.0)); share = 0.67; }
        else if (rhythm == 3.0) { open = mod(c, 4.0) == 3.0 ? 0.0 : 1.0; share = 0.75; }
        vec2 h = pane * 0.5 * vec2(widen, 1.0);
        if (kind == 1.0) h *= vec2(0.75, 1.15);
        if (arch == 3.0) h.x *= 1.25;
        h = min(h, cellM * vec2(0.42, 0.42));
        w.off = vec2(0.0);
        if (kind == 4.0 && cell.y > 0.0) {
          // French window: from just above the floor to the usual head height
          float top = h.y, bottom = -cellM.y * 0.5 + 0.12;
          h.y = (top - bottom) * 0.5;
          w.off.y = (top + bottom) * 0.5;
        }
        w.size = h; w.open = open; w.share = share; w.kind = kind;
        return w;
      }
      // ---- modern skin (1): one building type per house, each with its own window scheme.
      // Types: 0 residential, 1 office, 2 commercial, 3 apart-hotel, 4 public.
      // Schemes: 0 vertical, 1 horizontal, 2 pairs, 3 ribbon, 4 groups with blank wall.
      // Kinds: 0 window, 1 ribbon band, 2 loggia (dark recess), 3 shopfront.
      struct ModWin { vec2 size; vec2 off; float open; float share; float kind; };
      // modern glass: neutral graphite / warm greys / grey-olive / near black; blue on ~5% only
      vec3 modGlass(float r) {
        if (r < 0.05) return toLinear(vec3(0.37, 0.5, 0.6));
        float k = floor((r - 0.05) / 0.95 * 5.999);
        return toLinear(k < 1.0 ? vec3(0.271) : k < 2.0 ? vec3(0.408, 0.4, 0.384) : k < 3.0 ? vec3(0.537, 0.518, 0.482)
          : k < 4.0 ? vec3(0.702, 0.678, 0.635) : k < 5.0 ? vec3(0.467, 0.498, 0.463) : vec3(0.216, 0.216, 0.208));
      }
      // warm facades on ~28% of modern buildings: light ochre, sand, soft terracotta, muted peach
      vec3 modWarm(float r) { return toLinear(r < 0.25 ? vec3(0.886, 0.769, 0.557) : r < 0.5 ? vec3(0.863, 0.776, 0.627) : r < 0.75 ? vec3(0.827, 0.604, 0.494) : vec3(0.89, 0.725, 0.627)); }
      float modType() { float r = seeded(vColor, 51.7); return r < 0.4 ? 0.0 : r < 0.6 ? 1.0 : r < 0.75 ? 2.0 : r < 0.9 ? 3.0 : 4.0; }
      ModWin modernWindow(vec2 cell, vec2 cellM, vec2 pane, float cols) {
        float type = modType();
        float hs = seeded(vColor, 61.3), hl = seeded(vColor, 67.9);
        float scheme;
        // residential: single windows with wall between (tall, pairs, groups, a few wide);
        // offices: ribbons on about a third, and then not on every facade
        if (type == 0.0) scheme = hs < 0.4 ? 0.0 : hs < 0.7 ? 2.0 : hs < 0.9 ? 4.0 : 1.0;
        else if (type == 1.0) scheme = hs < 0.35 ? 3.0 : hs < 0.7 ? 1.0 : 2.0;
        else if (type == 2.0) scheme = hs < 0.6 ? 1.0 : 2.0;
        else if (type == 3.0) scheme = hs < 0.6 ? 0.0 : 2.0;
        else scheme = 4.0;
        if (scheme == 3.0 && (cols < 4.0 || seeded(vColor + vNormal * 0.37, 5.3) < 0.4)) scheme = 1.0;
        float c = min(cell.x, cols - 1.0 - cell.x);   // symmetric about the wall's middle
        ModWin w;
        w.off = vec2(0.0); w.open = 1.0; w.share = 1.0; w.kind = 0.0;
        vec2 h = pane * 0.5;
        if (scheme == 0.0) h *= vec2(type == 0.0 ? 0.62 : 0.72, 1.12);
        else if (scheme == 1.0) h *= vec2(1.45, 0.72);
        else if (scheme == 2.0) { w.open = step(0.5, abs(mod(c, 3.0) - 2.0)); w.share = 0.67; }
        else if (scheme == 3.0) { h = vec2(cellM.x * 0.5 + 0.02, pane.y * 0.4); w.kind = 1.0; }
        else { w.open = mod(c, 4.0) < 2.0 ? 1.0 : 0.0; w.share = 0.5; h *= vec2(1.2, 1.0); }
        if (scheme != 3.0) h.x = min(h.x, cellM.x * 0.45);
        h.y = min(h.y, cellM.y * 0.44);
        // short (side) walls: mostly blank, one window column in the middle
        if (cols <= 3.0 && hl < 0.6 && scheme != 3.0) { w.open *= step(abs(cell.x - (cols - 1.0) * 0.5), 0.1); w.share *= 0.4; }
        // a loggia instead of the window in some bays of a few residential houses
        if (type == 0.0 && hl > 0.7 && cell.y > 0.0 && scheme != 3.0 && mod(c, 3.0) == 1.0) {
          w.kind = 2.0; w.open = 1.0;
          h = vec2(cellM.x * 0.4, cellM.y * 0.38);
          w.off.y = -cellM.y * 0.06;
        }
        // shops: one big shopfront per bay on the ground floor
        if (cell.y == 0.0 && (type == 2.0 || (type == 1.0 && hl < 0.5))) {
          w.kind = 3.0; w.open = 1.0; w.share = 1.0;
          h = vec2(cellM.x * 0.44, cellM.y * 0.36);
          w.off.y = -cellM.y * 0.06;
        }
        w.size = h;
        return w;
      }
      // 4×4 ordered dither: screen-door transparency without sorting
      float bayer(vec2 p) {
        vec2 q = mod(floor(p), 4.0);
        int i = int(q.x + q.y * 4.0);
        float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
        return (m[i] + 0.5) / 16.0;
      }
      // Broken glass where a bullet hit this very pane: x = crack lines, y = the hole, z = 1 if hit.
      vec3 cracked(vec2 uv, vec2 cellM, vec2 pane, vec3 n) {
        if (uShotCount == 0) return vec3(0.0);
        vec3 t = normalize(cross(vec3(0.0, 1.0, 0.0), n));
        // which way uv.x runs along the wall, from the screen derivatives
        float s = dot(dFdx(vWorld), t) * dFdx(uv.x) + dot(dFdy(vWorld), t) * dFdy(uv.x);
        s = s < 0.0 ? -1.0 : 1.0;
        vec2 cell = floor(uv);
        vec2 p = (fract(uv) - 0.5) * cellM;
        float w = max(0.005, max(fwidth(p.x), fwidth(p.y)) * 0.8);
        vec3 result = vec3(0.0);
        for (int i = 0; i < ${MAX_SHOTS}; i++) {
          if (i >= uShotCount) break;
          vec3 d = uShots[i].xyz - vWorld;
          if (dot(d, d) > 9.0 || abs(dot(d, n)) > 0.35) continue;
          vec2 suv = uv + vec2(s * dot(d, t) / cellM.x, d.y / cellM.y);
          if (floor(suv) != cell) continue;
          vec2 sp = (fract(suv) - 0.5) * cellM;
          if (abs(sp.x) > pane.x || abs(sp.y) > pane.y) continue; // hit the wall, not the glass
          float seed = uShots[i].w;
          vec2 q = p - sp;
          float r = length(q);
          float a = atan(q.y, q.x) / 6.2832 + 0.5;
          // spokes: uneven star of radial cracks
          float spokes = 7.0 + floor(seed * 4.0);
          float f = fract(a * spokes + seed * 3.7 + 0.08 * sin(r * 40.0 + seed * 9.0));
          float spoke = (1.0 - smoothstep(w, w * 2.0, min(f, 1.0 - f) * 6.2832 / spokes * r)) * (1.0 - smoothstep(0.35, 0.9, r));
          // broken rings between the spokes
          float rr = r / (0.07 + seed * 0.04) + 0.35 * sin(a * 6.2832 * 3.0 + seed * 11.0);
          float ring = (1.0 - smoothstep(w, w * 2.0, abs(fract(rr) - 0.5) * (0.07 + seed * 0.04)))
            * step(0.45, fract(a * spokes * 0.5 + seed * 5.0)) * step(0.04, r) * (1.0 - smoothstep(0.25, 0.5, r));
          float hole = 1.0 - smoothstep(0.022, 0.03, r);
          result = max(result, vec3(max(spoke, ring), hole, 1.0));
        }
        return result;
      }
      void main() {
        if (uXray > 0.5) {
          vec3 target = uCar + vec3(0.0, 1.2, 0.0);
          vec3 seg = target - uCameraPos;
          float t = dot(vWorld - uCameraPos, seg) / max(dot(seg, seg), 1e-3);
          if (t > 0.0 && t < 1.0) {
            float d = length(vWorld - (uCameraPos + seg * t));
            // wide, soft falloff: walls fade gradually as the view line sweeps across them
            float radius = mix(1.5, 8.0, t);
            float keep = mix(0.3, 1.0, smoothstep(radius * 0.25, radius * 1.6, d));
            keep = mix(1.0, keep, smoothstep(0.02, 0.2, t) * (1.0 - smoothstep(0.85, 1.0, t)));
            if (bayer(gl_FragCoord.xy) > keep) discard;
          }
        }
        vec3 albedo = toLinear(vColor);
        float broken = 0.0;
        // ---- architecture skin: one wall and one roof tone per building, the style's patterns
        float skin = uSkin;
        float hb = seeded(vColor, 0.0), hb2 = seeded(vColor, 3.7), hb3 = seeded(vColor, 7.1);
        // victorian facade family: stucco 35%, muted brick 25%, stone 10%, painted 20%, brick + stucco 10%
        float fam = seeded(vColor, 21.7);
        float floorM = vWin.x > 0.5 ? vWin.w : 3.4;
        bool roofFace = normalize(vNormal).y > 0.35;
        vec3 skinGlass = vec3(0.0), skinFrame = vec3(0.0), skinTrim = vec3(0.0);
        // meters along the wall and up from its foot (window grid if any, else world)
        vec2 wallM = vWin.x > 0.5 ? vFacade.xy * vWin.zw : vec2(vWorld.x + vWorld.z, vHeight);
        if (skin > 0.5) {
          skinGlass = slot(4, fract(vFacade.z * 1.7 + hb2));
          skinFrame = slot(8, hb3);
          skinTrim = slot(12, hb2);
          if (roofFace) {
            albedo = pickRoof(hb) * (1.0 + (hb2 - 0.5) * 2.0 * uSkinRoofRange);
            if (skin > 2.5) {
              // victorian roofs: each district (~260 m) keeps one family of three tones, so
              // neighbours agree without matching; one roof in ten takes any of the eight
              float fd = seeded(vec3(floor(vWorld.xz / 260.0), 5.0), 2.9);
              vec3 ra = fd < 0.4 ? vec3(0.333, 0.353, 0.353) : fd < 0.75 ? vec3(0.639, 0.42, 0.337) : vec3(0.463, 0.42, 0.376);
              vec3 rb = fd < 0.4 ? vec3(0.271, 0.267, 0.255) : fd < 0.75 ? vec3(0.533, 0.31, 0.271) : vec3(0.455, 0.471, 0.427);
              vec3 rc = fd < 0.4 ? vec3(0.6, 0.576, 0.545) : fd < 0.75 ? vec3(0.463, 0.337, 0.278) : vec3(0.333, 0.353, 0.353);
              vec3 tone = hb < 0.5 ? ra : hb < 0.8 ? rb : rc;
              if (hb3 < 0.1) {
                float k = floor(hb2 * 7.999);
                tone = k < 1.0 ? vec3(0.333, 0.353, 0.353) : k < 2.0 ? vec3(0.271, 0.267, 0.255) : k < 3.0 ? vec3(0.463, 0.42, 0.376)
                  : k < 4.0 ? vec3(0.639, 0.42, 0.337) : k < 5.0 ? vec3(0.533, 0.31, 0.271) : k < 6.0 ? vec3(0.463, 0.337, 0.278)
                  : k < 7.0 ? vec3(0.455, 0.471, 0.427) : vec3(0.6, 0.576, 0.545);
              }
              albedo = toLinear(tone) * (1.0 + (hb2 - 0.5) * 2.0 * uSkinRoofRange);
              // slate: courses along the slope, faint, fading out with distance
              float rows = step(0.44, abs(fract(vWorld.y / 0.32) - 0.5));
              albedo *= 1.0 - 0.07 * rows * (1.0 - smoothstep(0.02, 0.06, fwidth(vWorld.y)));
            }

          } else {
            albedo = pickWall(hb) * (1.0 + (hb2 - 0.5) * 2.0 * uSkinOpt.w);
            if (skin < 1.5) {
              // modern: one large colour move per facade at most — a vertical section (one or
              // two wide strips), the top third in another shade, or a marked ground floor
              if (seeded(vColor, 88.8) < 0.28) albedo = modWarm(seeded(vColor, 91.1));
              if (vWin.x > 0.5) {
                float type = modType();
                float hv = seeded(vColor, 77.7);
                vec3 sec = slot(0, hb3);
                float fx = vFacade.x, fy = vFacade.y, cols = vWin.x;
                if (hv < 0.18 && cols >= 4.0) {
                  float inside = step(0.0, fx) * step(fx, cols);
                  float strip = hv < 0.1
                    ? step(abs(fx - cols * 0.5), 1.0)                                   // the middle two bays
                    : step(min(fx, cols - fx), 1.0) * inside;                          // both end bays
                  albedo = mix(albedo, sec, strip);
                } else if (hv < 0.32 && vWin.y >= 4.0) {
                  albedo = mix(albedo, sec, step(vWin.y * 0.67, fy));                  // the top third
                } else if (hv < 0.55 || type == 2.0) {
                  float detail = 1.0 - smoothstep(0.04, 0.12, fwidth(fy * vWin.w));
                  if (type == 2.0 || hv < 0.42) albedo = mix(albedo, toLinear(vec3(0.23, 0.24, 0.25)), step(abs(fy - 1.0) * vWin.w, 0.2) * detail);
                  else if (fy < 1.0) albedo *= 0.8;                                  // a darker ground floor
                }
              }
            } else if (skin > 2.5) {
              // victorian: five facade families; joints are large and faint, and fade out
              // before they get finer than a few pixels, so nothing shimmers at a distance
              float px = max(fwidth(wallM.x), fwidth(wallM.y));
              float brickDetail = 1.0 - smoothstep(0.012, 0.035, px);
              float stoneDetail = 1.0 - smoothstep(0.03, 0.09, px);
              vec2 cellB = floor(vec2(wallM.x / 0.5 + mod(floor(wallM.y / 0.2), 2.0) * 0.5, wallM.y / 0.2));
              float brickTone = 1.0 + 0.06 * (seeded(vec3(cellB, hb), 1.3) - 0.5) * brickDetail;
              vec3 brick = vicBrick(hb2) * brickTone * (1.0 - 0.08 * joints(wallM, vec2(0.5, 0.2), vec2(0.04, 0.08)) * brickDetail);
              vec3 stucco = vicStucco(hb2);
              if (fam < 0.35) albedo = stucco;
              else if (fam < 0.6) albedo = brick;
              else if (fam < 0.7) albedo = vicStone(hb2) * (1.0 - 0.05 * joints(wallM, vec2(1.2, 0.6), vec2(0.015, 0.03)) * stoneDetail);
              else if (fam < 0.9) albedo = vicPaint(hb2);
              // brick body over a stucco ground floor with rusticated grooves
              else albedo = wallM.y < floorM ? stucco * (1.0 - 0.06 * step(0.46, abs(fract(wallM.y / 0.45) - 0.5)) * stoneDetail) : brick;
              albedo *= 0.96 + 0.08 * hb3;
              // a stone plinth along the foot of the wall
              if (wallM.y < 0.6) albedo = toLinear(vec3(0.56, 0.54, 0.51)) * (0.95 + 0.1 * hb);
            }
          }
        }
        if (skin < 0.5 && !roofFace && vWin.x > 0.5) {
          // the city's own look: at most one division per facade, on about a third of the houses -
          // a cornice under the roof, a belt over the ground floor, a darker plinth band or a
          // marked ground floor; each archetype has its own
          float arch = cityArch();
          float hd = seeded(vColor, 41.9);
          float fy = vFacade.y;                       // floors from the window grid's foot
          float detail = 1.0 - smoothstep(0.04, 0.12, fwidth(fy * vWin.w));
          vec3 trim = toLinear(uFrame) * 0.97;
          if (hd < 0.34) {
            float pick = arch == 1.0 ? 0.0 : arch == 4.0 ? 1.0 : arch == 3.0 ? 3.0 : arch == 2.0 ? 2.0 : floor(hd * 11.99);
            if (pick == 0.0) {
              // a flat cornice just under the roof (above the top row of windows)
              float band = step(vWin.y + 0.02, fy) * step(fy, vWin.y + 0.2);
              albedo = mix(albedo, trim, band * mix(0.6, 1.0, detail));
            } else if (pick == 1.0) {
              // a belt course between the ground and first floor
              float band = step(abs(fy - 1.0) * vWin.w, 0.1);
              albedo = mix(albedo, trim, band * detail);
            } else if (pick == 2.0) {
              // a contrasting plinth band along the foot
              albedo = mix(albedo, albedo * vec3(0.72, 0.7, 0.68), step(fy * vWin.w, 0.85));
            } else {
              // the ground floor marked: a touch darker, with a line above it
              if (fy < 1.0) albedo *= 0.88;
              albedo = mix(albedo, trim, step(abs(fy - 1.0) * vWin.w, 0.08) * detail);
            }
          }
        }
        if (vWin.x > 0.5) {
          vec2 uv = vFacade.xy;
          if (uv.x >= 0.0 && uv.x < vWin.x && uv.y >= 0.0 && uv.y < vWin.y) {
            vec3 frame = skin > 0.5 ? skinFrame : toLinear(uFrame);
            float hg = seeded(vColor, 13.3);
            vec3 cityGlass = hg < 0.3 ? uGlass0 : hg < 0.6 ? uGlass1 : hg < 0.8 ? uGlass3 : uGlass2;
            vec3 glass = skin > 0.5 ? skinGlass * 0.85 : toLinear(cityGlass) * 0.85;
            if (skin > 0.5 && skin < 1.5) glass = modGlass(seeded(vColor, 13.3)) * 0.9;
            vec2 cellM = vWin.zw;                      // cell size in meters
            vec2 p = (fract(uv) - 0.5) * cellM;        // meters from the pane centre
            vec2 aa = max(fwidth(uv) * cellM, vec2(1e-4)) * 0.75;
            float f = box(p, vWinSize * 0.5, aa);
            float g = box(p, vWinSize * 0.46, aa);
            if (skin > 2.5) {
              // victorian: taller, narrower sash windows in white or cream surrounds,
              // a lintel above and a sill below, string courses on some houses, doors below
              vec2 ws = vWinSize * vec2(0.8, 1.06);
              f = box(p, ws * 0.5 + 0.04, aa);
              g = box(p, ws * 0.46, aa);
              float surround = box(p, ws * 0.5 + vec2(0.12, 0.12), aa);
              float lintel = box(p - vec2(0.0, ws.y * 0.5 + 0.13), vec2(ws.x * 0.5 + 0.18, 0.08), aa);
              float sill = box(p - vec2(0.0, -ws.y * 0.5 - 0.12), vec2(ws.x * 0.5 + 0.16, 0.05), aa);
              albedo = mix(albedo, skinTrim, max(surround, max(lintel, sill)));
              if (hb2 < uSkinOpt.z && fract(uv.y) < 0.05) albedo = skinTrim * 0.96;
              // sash bars: one upright and the meeting rail, gone before they shimmer
              float barDetail = 1.0 - smoothstep(0.012, 0.03, max(fwidth(p.x), fwidth(p.y)));
              float bars = max(step(abs(p.x), 0.03), step(abs(p.y + ws.y * 0.06), 0.035)) * barDetail;
              glass = mix(glass, frame, bars);
              // a door in some ground-floor bays: dark green, burgundy or navy
              if (floor(uv.y) == 0.0 && mod(floor(uv.x) + floor(hb * 7.0), 5.0) == 0.0) {
                vec2 door = vec2(min(0.6, cellM.x * 0.32), min(1.15, cellM.y * 0.4));
                float d = box(p - vec2(0.0, -cellM.y * 0.5 + door.y + 0.05), door, aa);
                float frameD = box(p - vec2(0.0, -cellM.y * 0.5 + door.y + 0.05), door + 0.1, aa);
                albedo = mix(albedo, skinTrim, frameD);
                albedo = mix(albedo, slot(16, fract(hb * 13.0)), d);
                f = 0.0; g = 0.0;
              }
            } else if (skin > 1.5) {
              // futuristic: ribbon glazing along each floor; thin teal stripes on some buildings
              if (hb2 < 0.6) albedo = mix(albedo, glass * 0.95, step(abs(p.y), vWinSize.y * 0.46));
              if (hb3 < uSkinOpt.y && fract(uv.y) < 0.035) albedo = slot(16, hb);
              f = box(p, vWinSize * 0.47, aa);
            } else if (skin > 0.5) {
              ModWin mw = modernWindow(floor(uv), cellM, vWinSize, vWin.x);
              vec2 q = p - mw.off;
              g = box(q, mw.size, aa) * mw.open;
              f = mw.kind == 0.0 ? box(q, mw.size + 0.04, aa) * mw.open : 0.0; // slim frames on plain windows
              if (mw.kind == 2.0) {
                // loggia: a dark recess with a light slab and a railing line at its foot
                vec3 recess = albedo * 0.3;
                float slab = step(q.y, -mw.size.y + 0.1);
                float rail = step(abs(q.y + mw.size.y - 1.0), 0.035);
                glass = mix(mix(recess, albedo * 0.9, slab), frame, rail);
              } else if (mw.kind == 3.0) {
                glass *= 0.62;                                   // shopfronts read darker
              }
              // a rare balcony on residential houses: a slab and a simple railing, middle bay only
              float hbal = seeded(vColor, 71.1);
              if (modType() == 0.0 && hbal < 0.1 && floor(uv.y) > 0.0 && mw.kind == 0.0 && mw.open > 0.5
                  && abs(floor(uv.x) - (vWin.x - 1.0) * 0.5) < 0.6) {
                vec2 bal = vec2(mw.size.x + 0.35, 0.07);
                float plate = box(q - vec2(0.0, -mw.size.y - 0.05), bal, aa);
                float railing = box(q - vec2(0.0, -mw.size.y + 0.9), vec2(bal.x, 0.03), aa)
                  + box(vec2(abs(q.x) - bal.x, q.y + mw.size.y - 0.45), vec2(0.03, 0.47), aa);
                albedo = mix(albedo, frame, max(plate, min(1.0, railing)));
                glass = mix(glass, frame, min(1.0, railing));
              }
            } else {
              // the city's own look: the building's archetype sets size, rhythm and kind
              CityWin cw = cityWindow(floor(uv), cellM, vWinSize, vWin.x);
              vec2 q = p - cw.off;
              g = box(q, cw.size, aa) * cw.open;
              float kind = cw.kind;
              float hk = seeded(vColor, 23.3);
              // frames: framed windows get a broad light or dark surround, the rest a slim one
              if (kind == 2.0) {
                f = box(q, cw.size + 0.11, aa) * cw.open;
                if (hk < 0.12) frame = albedo * 0.55;
              } else {
                f = box(q, cw.size + 0.045, aa) * cw.open;
              }
              if (kind == 3.0) {
                // shutters: two flat coloured leaves beside the pane
                vec3 leaf = toLinear(hk < 0.075 ? vec3(0.37, 0.48, 0.35) : hk < 0.15 ? vec3(0.31, 0.42, 0.49) : hk < 0.22 ? vec3(0.48, 0.34, 0.25) : vec3(0.55, 0.54, 0.37));
                float sw = cw.size.x * 0.55;
                float leaves = box(vec2(abs(q.x) - (cw.size.x + 0.06 + sw), q.y), vec2(sw, cw.size.y + 0.04), aa) * cw.open;
                albedo = mix(albedo, leaf, leaves);
              }
              if (kind == 4.0 && floor(uv.y) > 0.0) {
                // French window: a thin dark railing across its lower part
                float rail = step(abs(q.y + cw.size.y - 0.95), 0.035) + step(abs(q.y + cw.size.y - 0.08), 0.03);
                glass = mix(glass, toLinear(vec3(0.16, 0.17, 0.18)), min(1.0, rail));
              }
            }
            vec3 crack = cracked(uv, cellM, vWinSize * 0.46, normalize(vNormal));
            broken = crack.z * g;
            // shattered pane: darker glass, pale crack web, a black hole where the bullet went
            vec3 pane = mix(glass, glass * 0.55, crack.z);
            pane = mix(pane, toLinear(vec3(0.86, 0.9, 0.92)), crack.x * 0.85);
            pane = mix(pane, vec3(0.01), crack.y);
            vec3 sharp = mix(mix(albedo, frame, f), pane, g);
            // far away a cell covers few pixels: use its average colour (no moiré)
            float fa = clamp(vWinSize.x * vWinSize.y / (cellM.x * cellM.y), 0.0, 1.0);
            float ga = fa * 0.8464;
            if (skin < 0.5) {
              CityWin cwa = cityWindow(floor(uv), cellM, vWinSize, vWin.x);
              ga = clamp(4.0 * cwa.size.x * cwa.size.y / (cellM.x * cellM.y), 0.0, 1.0) * cwa.share;
              fa = min(1.0, ga * 1.25);
            } else if (skin < 1.5) {
              ModWin mwa = modernWindow(floor(uv), cellM, vWinSize, vWin.x);
              ga = clamp(4.0 * mwa.size.x * mwa.size.y / (cellM.x * cellM.y), 0.0, 1.0) * mwa.share;
              fa = min(1.0, ga * 1.1);
            }
            vec3 average = albedo * (1.0 - fa) + frame * (fa - ga) + glass * ga;
            float far = smoothstep(0.18, 0.45, max(fwidth(uv.x), fwidth(uv.y)));
            albedo = mix(sharp, average, far);
          }
        }
        // ---- futuristic: mirror towers, steel-and-glass stripes, white modules with ribbon windows
        float mirror = 0.0;          // how much of this pixel reflects the sky
        vec3 futureLit = vec3(0.0);  // its night light
        vec3 env_tint = vec3(1.0);   // gold glass warms what it reflects
        if (skin > 1.5 && skin < 2.5) {
          vec3 kept = albedo;
          float kind = seeded(vColor, 11.3);
          float floorH = vWin.x > 0.5 ? vWin.w : 3.4;
          vec2 fw = max(fwidth(wallM), vec2(1e-3));
          float fy = fract(wallM.y / floorH), floorIdx = floor(wallM.y / floorH);
          // far away the fine pattern turns into its average colour (no moiré)
          float far = smoothstep(0.12, 0.4, fw.y / floorH);
          vec3 cool = mix(uSkinColors[20], uSkinColors[21], hb2);
          if (roofFace) {
            if (hb3 < 0.04 && normalize(vNormal).y > 0.9) { // a rare roof garden, flat roofs only
              // roof garden: lawn with soft round shrubs
              vec2 q = vWorld.xz * 0.7; float shrub = smoothstep(0.42, 0.3, length(fract(q) - 0.5)) * step(0.55, seeded(vec3(floor(q), hb), 2.0));
              albedo = mix(toLinear(vec3(0.52, 0.68, 0.4)), toLinear(vec3(0.38, 0.54, 0.3)), shrub * (1.0 - far));
            } else if (hb2 < 0.62) albedo = toLinear(vec3(0.92, 0.94, 0.93)) * (0.98 + 0.05 * hb3); // bright roof; the rest keep a light slate tone
          } else if (kind < 0.34) {
            // mirror tower: reflective skin with thin steel lines; champagne glass stays warm, not muddy
            float room = 1.5 + floor(hb2 * 3.0) * 0.45;
            vec2 g = abs(vec2(fract(wallM.x / room), fy) - 0.5);
            float lines = max(step(0.47, g.x), step(0.45, g.y));
            bool gold = kind > 0.22;
            vec3 pane = gold
              ? mix(toLinear(vec3(0.82, 0.78, 0.7)), toLinear(vec3(0.74, 0.72, 0.68)), hb3) * 0.88
              : mix(slot(4, hb), toLinear(vec3(0.78, 0.88, 0.94)), hb3 * 0.55) * 0.9;
            vec3 steel = gold ? toLinear(vec3(0.92, 0.88, 0.8)) : toLinear(vec3(0.9, 0.93, 0.95));
            albedo = mix(mix(pane, steel, lines), mix(pane, steel, 0.16), far);
            mirror = 0.82 * mix(1.0 - lines, 0.78, far);
            float h = seeded(vec3(floor(wallM.x / room), floorIdx, hb), 4.0);
            futureLit = cool * step(0.78, h) * mix(1.0 - lines, 0.25, far);
            if (gold) env_tint = vec3(1.1, 1.02, 0.92);
          } else if (kind < 0.46) {
            // diagrid tower: bright lattice over sky glass
            float cell = 2.0 * floorH;
            vec2 q = vec2(wallM.x, wallM.y) / cell;
            float d1 = abs(fract(q.x + q.y) - 0.5), d2 = abs(fract(q.x - q.y) - 0.5);
            float lattice = max(step(0.45, d1), step(0.45, d2));
            float floors = step(0.47, abs(fy - 0.5));
            vec3 pane = slot(4, hb2) * 0.82;
            vec3 steel = toLinear(vec3(0.92, 0.94, 0.96));
            albedo = mix(mix(pane, steel, max(lattice, floors * 0.6)), mix(pane, steel, 0.28), far);
            mirror = mix((1.0 - lattice) * 0.78, 0.62, far);
            futureLit = cool * step(0.8, seeded(vec3(floor(wallM.x / 2.0), floorIdx, hb), 9.0)) * mix(1.0 - lattice, 0.2, far);
          } else if (kind < 0.62) {
            // steel and glass stripes: silver spandrel + bright glass ribbon
            float split = 0.3 + hb2 * 0.15;
            float band = step(split, fy);
            float mull = step(0.45, abs(fract(wallM.x / 1.3) - 0.5)) * band;
            vec3 steel = mix(toLinear(vec3(0.88, 0.9, 0.92)), toLinear(vec3(0.9, 0.88, 0.82)), step(0.5, hb3)) * (0.97 + 0.06 * hb3);
            vec3 pane = slot(4, hb2) * 0.9;
            vec3 sharp = mix(mix(steel, pane, band), steel * 0.92, mull);
            albedo = mix(sharp, mix(steel, pane, 1.0 - split), far);
            mirror = mix(band * (1.0 - mull) * 0.7 + (1.0 - band) * 0.28, 0.5, far);
            float h = seeded(vec3(floor(wallM.x / 2.6), floorIdx, hb), 5.0);
            futureLit = cool * step(0.78, h) * mix(band * (1.0 - mull), 0.2, far);
          } else if (kind < 0.76) {
            // white vertical fins: tall louvres, bright glass between them
            float pitch = 0.9 + hb2 * 0.6;
            float fin = step(0.3, abs(fract(wallM.x / pitch) - 0.5));
            float slab = step(0.46, abs(fy - 0.5));
            vec3 white = toLinear(vec3(0.97, 0.98, 0.97));
            vec3 pane = slot(4, hb) * 0.78;
            albedo = mix(mix(pane, white, max(fin, slab)), mix(pane, white, 0.55), far);
            mirror = mix((1.0 - max(fin, slab)) * 0.5, 0.22, far);
            futureLit = cool * step(0.65, seeded(vec3(floor(wallM.x / 3.0), floorIdx, hb), 10.0)) * mix(1.0 - max(fin, slab), 0.15, far);
          } else {
            // white modules: long ribbon windows on clean composites
            float stretch = 3.0 + floor(hb2 * 3.0);
            float open = step(0.38, seeded(vec3(floor(wallM.x / stretch), floorIdx, hb), 6.0));
            float win = open * step(0.36, fy) * step(fy, 0.84);
            vec3 white = toLinear(vec3(0.97, 0.98, 0.96)) * (0.98 + 0.04 * hb3);
            vec3 pane = slot(4, hb) * 0.8;
            albedo = mix(mix(white, pane, win), mix(white, pane, 0.28), far);
            mirror = mix(win * 0.55, 0.16, far);
            futureLit = cool * step(0.5, seeded(vec3(floor(wallM.x / stretch), floorIdx, hb), 8.0)) * mix(win, 0.14, far);
          }
          // a shot-out pane keeps its cracks
          albedo = mix(albedo, kept, broken);
          mirror *= 1.0 - broken;
        }
        vec3 n = normalize(vNormal);
        // comic-like light, but sunlit walls stand clearly apart from the shaded ones
        float d = max(dot(n, uSun), 0.0);
        vec3 light = n.y > 0.5
          ? (uAmbient + uSunColor * d) / 1.2
          : (uAmbient + uSunColor * 0.5 * d) / 0.84;
        // street light reaches the lower floors of the walls, not the roofs
        vec3 color = albedo * (light + headlight(vWorld, n) + lampLight() * (n.y > 0.5 ? 0.0 : 1.0 - smoothstep(1.5, 9.0, vHeight)));
        if (mirror > 0.0) {
          // glass and steel reflect the sky (and a dark street below the horizon), with a sun glint
          vec3 eye = normalize(vWorld - uCameraPos);
          vec3 r = reflect(eye, n);
          vec3 sky = toLinear(uFogColor);
          vec3 zenith = sky * vec3(0.62, 0.78, 1.05) * (0.65 + 0.4 * uAmbient.g / 0.73);
          vec3 env = r.y > 0.0 ? mix(sky * 1.18, zenith, pow(r.y, 0.55)) : mix(sky * 0.72, toLinear(vec3(0.42, 0.46, 0.5)), min(1.0, -r.y * 4.0));
          // soft bright bands in the glass, not dirty street strips
          env *= (0.88 + 0.16 * smoothstep(0.3, 0.7, fract(atan(r.z, r.x) * 2.2))) * env_tint;
          float fres = 0.35 + 0.55 * pow(1.0 - max(dot(-eye, n), 0.0), 3.0);
          color = mix(color, env, mirror * fres);
          color += uSunColor * 2.6 * pow(max(dot(r, uSun), 0.0), 140.0) * mirror;
        }
        color += futureLit * 1.1 * uNight;
        // at night a share of the windows is lit, each window its own warm tone
        if (uNight > 0.01 && vWin.x > 0.5 && !(skin > 1.5 && skin < 2.5 && !roofFace)) {
          vec2 uv = vFacade.xy;
          if (uv.x >= 0.0 && uv.x < vWin.x && uv.y >= 0.0 && uv.y < vWin.y) {
            vec2 cell = floor(uv);
            float h = fract(sin(dot(cell + vColor.rg * 37.0, vec2(12.9898, 78.233))) * 43758.5453);
            vec2 p = (fract(uv) - 0.5) * vWin.zw;
            vec2 aa = max(fwidth(uv) * vWin.zw, vec2(1e-4)) * 0.75;
            float g = box(p, vWinSize * 0.46, aa);
            float full = vWinSize.x * vWinSize.y / (vWin.z * vWin.w) * 0.85;
            if (skin < 0.5) {
              CityWin cw = cityWindow(cell, vWin.zw, vWinSize, vWin.x);
              g = box(p - cw.off, cw.size, aa) * cw.open;
              full = 4.0 * cw.size.x * cw.size.y / (vWin.z * vWin.w) * cw.share;
            } else if (skin < 1.5) {
              ModWin mw = modernWindow(cell, vWin.zw, vWinSize, vWin.x);
              g = box(p - mw.off, mw.size, aa) * mw.open * (mw.kind == 2.0 ? 0.0 : 1.0);
              full = 4.0 * mw.size.x * mw.size.y / (vWin.z * vWin.w) * mw.share;
            }
            float far = smoothstep(0.18, 0.45, max(fwidth(uv.x), fwidth(uv.y)));
            float share = mix(g, full, far);
            vec3 warm = mix(vec3(1.0, 0.72, 0.38), vec3(1.0, 0.86, 0.6), fract(h * 7.0));
            if (skin > 0.5) warm = mix(uSkinColors[20], uSkinColors[21], fract(h * 7.0));
            float litShare = skin > 0.5 ? uSkinOpt.x : 0.38;
            color += warm * 1.1 * share * step(1.0 - litShare, h) * uNight * (1.0 - broken);
          }
        }
        gl_FragColor = linearToOutputTexel(vec4(fogged(color, vWorld), 1.0));
      }
    `,
  });
}
