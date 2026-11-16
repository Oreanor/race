import * as THREE from 'three';
import { seasonWeights, snowCover, worldTime } from './simpleLit.ts';
import {
  COMMON,
  LAMP_FRAGMENT,
  LAMP_VERTEX,
  lampMapUniform,
} from './shaders/common.ts';
import { baseUniforms, type BaseUniforms } from './shaders/uniforms.ts';
import { SLEEPER_PITCH, TRACK_HALF } from '../tiles/roadStyle.ts';

export type { BaseUniforms } from './shaders/uniforms.ts';
export { baseUniforms } from './shaders/uniforms.ts';
export { MAX_FIRES, MAX_SHOTS } from './shaders/common.ts';
export { facadeMask, farBuildingMaterial } from './facadeMaterial.ts';

// Shaders of the base world (ground, roads, water). Facade lives in facadeMaterial.ts.

/** one tiling repeat of the detail map (m) */
const DETAIL_REPEAT = 9;

/**
 * The ground's detail map, shared by the ground, land-use and road shaders: R grass,
 * G sand, B earth, A asphalt — each a grain centred on 0.5. The colour stays the
 * surface's own; only the pattern comes from here. `uDetailShift` keeps the pattern
 * fixed to the world when the scene origin moves (vWorld is around that origin).
 */
export const groundDetail = {
  uDetail: { value: new THREE.DataTexture(new Uint8Array([128, 128, 128, 128]), 1, 1) as THREE.Texture },
  uDetailOn: { value: 0 },
  uDetailShift: { value: new THREE.Vector2() },
  /** fixed pattern metres per scene metre (the scene's metre changes with the origin's latitude) */
  uDetailScale: { value: 1 },
  /**
   * The origin in fixed pattern metres, folded every 10 km, for the shaders' noise (grass
   * tone, asphalt wear, water chop): on raw scene positions it jumped at every rebase
   */
  uWorldShift: { value: new THREE.Vector2() },
};
/** metres per mercator unit the pattern is laid out in: the first origin's, kept for the session */
let detailMetersPer01 = 0;
groundDetail.uDetail.value.needsUpdate = true;

/**
 * Where the scene origin sits (mercator 0..1) and the scene's metres per mercator unit (call
 * on every rebase). The pattern is laid out in one fixed scale for the session: the scene's
 * metre follows the origin's latitude, and the origin's position in those metres (tens of
 * thousands of km) moved by tens of metres with every rebase — the grass pattern jumped.
 */
export function setGroundDetailOrigin(x01: number, y01: number, metersPer01: number) {
  if (!detailMetersPer01) detailMetersPer01 = metersPer01;
  const period = DETAIL_REPEAT * 64;
  const fold = (v: number) => ((v % period) + period) % period;
  groundDetail.uDetailShift.value.set(fold(x01 * detailMetersPer01), fold(y01 * detailMetersPer01));
  groundDetail.uDetailScale.value = detailMetersPer01 / metersPer01;
  const wide = (v: number) => ((v % WORLD_FOLD) + WORLD_FOLD) % WORLD_FOLD;
  groundDetail.uWorldShift.value.set(wide(x01 * detailMetersPer01), wide(y01 * detailMetersPer01));
}

/** how far (m) the world-anchored noise runs before it folds (a step there; float32 keeps cm detail) */
const WORLD_FOLD = 10000;

/** GLSL: a world-anchored ground position (east, south metres) for noise, steady across rebases. */
const ANCHOR = /* glsl */ `
  uniform vec2 uWorldShift;
  uniform float uDetailScale;
  vec2 anchored(vec2 xz) { return xz * uDetailScale + uWorldShift; }
`;

let groundTexture: THREE.Texture | null = null;
/** Put the ground texture on (public/textures/ground-realistic.png, scripts/ground-textures.py); loaded once. */
export function useGroundTexture(anisotropy = 4, onLoad?: () => void) {
  if (!groundTexture) {
    groundTexture = new THREE.TextureLoader().load('/textures/ground-realistic.png', () => onLoad?.());
    groundTexture.wrapS = groundTexture.wrapT = THREE.RepeatWrapping;
    groundTexture.colorSpace = THREE.NoColorSpace; // data, not colour
    groundTexture.anisotropy = anisotropy;
    groundTexture.premultiplyAlpha = false;
  }
  groundDetail.uDetail.value = groundTexture;
  groundDetail.uDetailOn.value = 1;
}

/** GLSL: the four grains at a world point, -0.5 … 0.5, faded out with distance (no shimmer far off). */
const DETAIL = /* glsl */ `
  uniform sampler2D uDetail;
  uniform float uDetailOn;
  uniform vec2 uDetailShift;
  ${ANCHOR}
  vec4 groundGrain(vec3 world) {
    if (uDetailOn < 0.5) return vec4(0.0);
    float near = 1.0 - smoothstep(140.0, 420.0, distance(world, uCameraPos));
    if (near <= 0.0) return vec4(0.0);
    return (texture2D(uDetail, (world.xz * uDetailScale + uDetailShift) / ${DETAIL_REPEAT.toFixed(1)}) - 0.5) * near;
  }
`;

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
  ${DETAIL}
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
    vec2 wa = anchored(vWorld.xz);
    float mottled = 0.5 + 0.5 * sin(wa.x * 1.55) * sin(wa.y * 1.7);
    vec3 snow = vec3(0.91, 0.935, 0.96) * mix(0.93, 1.03, mottled);
    // grass is never one flat green: drier and lusher patches, a finer mottle
    float tone = 0.86 + 0.2 * vnoise(wa * 0.05) + 0.08 * vnoise(wa * 0.4);
    // the texture's grain on grass, sand and earth only: warm (yellow-brown) ground is sand
    // when light, earth when dark; grey city ground and concrete keep their plain colour
    float warm = smoothstep(0.05, 0.08, vColor.g - vColor.b) * step(vColor.g, vColor.r + 0.02) * (1.0 - greenish);
    float lum = dot(vColor, vec3(0.2126, 0.7152, 0.0722));
    float sandy = warm * smoothstep(0.7, 0.74, lum);
    vec4 grain = groundGrain(vWorld);
    float detail = 1.0 + grain.r * greenish * (grain.r > 0.0 ? 0.3 : 0.6) + grain.g * sandy * 0.5 + grain.b * (warm - sandy) * 0.55;
    vec3 albedo = mix(vColor * mix(1.0, tone, greenish) * detail, snow, uSeason.w * uSnow * greenish);
    // sky light plus sunlight on the slope (hillshade comes from the real sun)
    vec3 light = uAmbient * 0.9 + uSunColor * 0.55 * max(dot(n, uSun), 0.0) * cloudSun(vWorld) + (headlight(vWorld, n) + lampLight()) * 0.91;
    gl_FragColor = linearToOutputTexel(vec4(fogged(toLinear(albedo) * light / 0.91, vWorld), 1.0));
  }
`;

/** Terrain: vertex-coloured ground (bank colour next to water). */
export function groundMaterial(u: BaseUniforms) {
  return new THREE.ShaderMaterial({
    uniforms: { ...u, ...lampMapUniform(), uSeason: seasonWeights, uSnow: snowCover, ...groundDetail },
    vertexShader: GROUND_VERTEX, fragmentShader: GROUND_FRAGMENT,
  });
}

/**
 * Land-use polygons lying exactly on the terrain triangles; layer 0..2 are
 * stacked with growing polygon offsets (landuse < landcover < park).
 */
export function overlayMaterial(u: BaseUniforms, layer: number) {
  return new THREE.ShaderMaterial({
    uniforms: { ...u, ...lampMapUniform(), uSeason: seasonWeights, uSnow: snowCover, ...groundDetail },
    vertexShader: GROUND_VERTEX, fragmentShader: GROUND_FRAGMENT,
    // overlapping land-use polygons lie in the same plane: no depth writes, so they never
    // fight each other; the draw order (renderOrder per layer) decides which is on top
    depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });
}

/**
 * Water: noise-driven ripples (no cos-grid), shore→deep colour, soft fresnel
 * sky, a broad sun path, and broken foam along the banks.
 */
export function waterMaterial(u: BaseUniforms) {
  return new THREE.ShaderMaterial({
    uniforms: { ...u, uTime: worldTime, uWorldShift: groundDetail.uWorldShift, uDetailScale: groundDetail.uDetailScale },
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
      ${ANCHOR}

      // layered value noise — irregular chop, not a lattice of cosines
      float swell(vec2 p) {
        float h = 0.0;
        h += vnoise(p) * 0.55;
        h += vnoise(p * 2.17 + 3.1) * 0.28;
        h += vnoise(p * 4.61 - 1.7) * 0.12;
        h += vnoise(p * 9.3 + 8.4) * 0.05;
        return h;
      }

      void main() {
        vec2 p = anchored(vWorld.xz);
        float t = uTime;
        float dist = distance(vWorld, uCameraPos);
        // calm the chop far away so distant rivers don't shimmer into a mesh
        float near = smoothstep(420.0, 60.0, dist);

        // two drifting domains, slightly sheared so ripples never lock to the axes
        vec2 flowA = p * 0.055 + vec2(t * 0.035, t * 0.018);
        vec2 flowB = p * vec2(0.09, 0.07) + vec2(-t * 0.022, t * 0.031);
        flowA += (vec2(swell(flowB + 2.0), swell(flowB.yx - 1.3)) - 0.5) * 0.45;
        float h = swell(flowA) * 0.72 + swell(flowB * 1.35 + 5.0) * 0.28;

        // finite-difference normal from the height field
        float e = mix(1.8, 0.55, near);
        float hx = swell(flowA + vec2(e * 0.055, 0.0)) - swell(flowA - vec2(e * 0.055, 0.0));
        float hz = swell(flowA + vec2(0.0, e * 0.055)) - swell(flowA - vec2(0.0, e * 0.055));
        float chop = 0.55 * near;
        vec3 n = normalize(vec3(-hx * chop, 1.0, -hz * chop));

        vec3 toEye = normalize(uCameraPos - vWorld);
        float depth = smoothstep(0.0, 28.0, vShore);
        // soft mottling in the body of water (no grid)
        float body = 0.92 + 0.1 * vnoise(p * 0.02 + t * 0.01) + 0.04 * (h - 0.5);

        vec3 shallow = toLinear(vPool > 0.5 ? vec3(0.52, 0.84, 0.88) : vec3(0.34, 0.72, 0.76));
        vec3 deep = toLinear(vPool > 0.5 ? vec3(0.22, 0.58, 0.72) : vec3(0.08, 0.28, 0.42));
        // dusk-friendly: lean on ambient, keep a little sun on the surface
        float sunAmt = max(uSun.y, 0.0);
        vec3 lit = uAmbient * 1.05 + uSunColor * (0.22 + 0.28 * sunAmt) * cloudSun(vWorld);
        vec3 base = mix(shallow, deep, depth) * body * lit;

        float nde = max(dot(n, toEye), 0.0);
        float fresnel = pow(1.0 - nde, 3.2);
        vec3 sky = toLinear(uFogColor) * vec3(0.82, 0.9, 1.02) * (0.55 + 0.45 * uAmbient.g / 0.73);
        // wide soft sun path (low exponent) instead of a hard specular grid
        vec3 halfV = normalize(uSun + toEye);
        float sunPath = pow(max(dot(n, halfV), 0.0), 28.0) * sunAmt;
        sunPath *= smoothstep(0.15, 0.55, fresnel + 0.2);
        // a few sparse sparkles up close only
        float spark = smoothstep(0.82, 0.95, vnoise(p * 1.7 + t * 0.4)) * near * sunAmt * 0.35;

        vec3 color = mix(base, sky, 0.08 + 0.42 * fresnel);
        color += uSunColor * (1.1 * sunPath + spark);

        // foam: noisy broken lace along the bank — never sin(x)*sin(y)
        float edge = 1.0 - smoothstep(0.05, 1.15, vShore);
        float lace = vnoise(p * 0.55 + t * 0.12) * 0.55 + vnoise(p * 1.4 - t * 0.2) * 0.45;
        float foam = edge * smoothstep(0.35, 0.72, lace) * (vPool > 0.5 ? 0.25 : 0.55) * near;
        color = mix(color, toLinear(vec3(0.93, 0.97, 0.98)) * (uAmbient + uSunColor * 0.35), foam);

        gl_FragColor = linearToOutputTexel(vec4(fogged(color, vWorld), 1.0));
      }
    `,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
  });
}

let trackTexture: THREE.DataTexture | null = null;
/**
 * A railway track seen from above, drawn once in code: the pale shoulder, the ballast
 * (a little gravel in it), a sleeper and the two rails (dark foot, bright head) at
 * standard gauge. Across: s 0..1 is -TRACK_HALF..TRACK_HALF m; along: one sleeper pitch.
 */
function trackMap() {
  if (trackTexture) return trackTexture;
  const W = 128, H = 64, data = new Uint8Array(W * H * 4);
  const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const shoulder = hex('#8b847a'), ballast = hex('#6c665f'), sleeper = hex('#4a3d33'), foot = hex('#34373b'), head = hex('#b4bac0');
  let seed = 9;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const m = Math.abs((i + 0.5) / W * 2 - 1) * TRACK_HALF; // metres from the centre
    const along = (j + 0.5) / H * SLEEPER_PITCH;            // metres into the pitch
    let c = m > 1.2 ? shoulder : ballast;
    let shade = 1 + (rnd() - 0.5) * (m > 1.2 ? 0.08 : 0.22); // gravel
    if (m < 1.17 && along < 0.22) { c = sleeper; shade = 1 + (rnd() - 0.5) * 0.06; }
    const rail = Math.abs(m - 0.72);
    if (rail < 0.06) { c = foot; shade = 1; }
    if (rail < 0.025) { c = head; shade = 1; }
    const o = (j * W + i) * 4;
    for (let k = 0; k < 3; k++) data[o + k] = Math.max(0, Math.min(255, Math.round(c[k] * shade)));
    data[o + 3] = 255;
  }
  trackTexture = new THREE.DataTexture(data, W, H);
  trackTexture.wrapS = THREE.ClampToEdgeWrapping;
  trackTexture.wrapT = THREE.RepeatWrapping;
  trackTexture.magFilter = THREE.LinearFilter;
  trackTexture.minFilter = THREE.LinearMipmapLinearFilter;
  trackTexture.generateMipmaps = true;
  trackTexture.anisotropy = 4;
  trackTexture.colorSpace = THREE.NoColorSpace; // sRGB values, made linear in the shader like vColor
  trackTexture.needsUpdate = true;
  return trackTexture;
}

/**
 * Roads (vertex colours), or with `track` the railway bed: one textured strip instead of
 * a shoulder, a bed, a ribbon a sleeper and four for the rails: a few times fewer triangles.
 */
export function roadMaterial(u: BaseUniforms, track = false) {
  return new THREE.ShaderMaterial({
    uniforms: { ...u, ...lampMapUniform(), ...groundDetail, ...(track ? { uTrack: { value: trackMap() } } : {}) },
    defines: track ? { TRACK: 1 } : {},
    vertexShader: /* glsl */ `
      uniform float uExag;
      attribute float aGround;
      attribute vec3 aColor;
      varying vec3 vColor;
      varying vec3 vWorld;
      #ifdef TRACK
        varying vec2 vTrack;
      #endif
      ${LAMP_VERTEX}
      void main() {
        #ifdef TRACK
          vTrack = uv;
        #endif
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
      ${DETAIL}
      varying vec3 vColor;
      varying vec3 vWorld;
      #ifdef TRACK
        uniform sampler2D uTrack;
        varying vec2 vTrack;
      #endif
      void main() {
        vec3 light = (uAmbient * 0.9 + uSunColor * 0.55 * max(uSun.y, 0.0) * cloudSun(vWorld)) / 0.91 + headlight(vWorld, vec3(0.0, 1.0, 0.0)) + lampLight();
        #ifdef TRACK
          vec3 bed = texture2D(uTrack, vec2(vTrack.x * 0.5 + 0.5, vTrack.y)).rgb;
          gl_FragColor = linearToOutputTexel(vec4(fogged(toLinear(bed) * light, vWorld), 1.0));
          return;
        #endif
        // asphalt is worn unevenly: broad lighter and darker stretches, and darker patched spots
        vec2 wa = anchored(vWorld.xz);
        float wear = 0.94 + 0.1 * vnoise(wa * 0.08) + 0.04 * vnoise(wa * 0.9);
        float mend = smoothstep(0.66, 0.74, vnoise(wa * 0.21 + 13.0)) * 0.08;
        // asphalt grain on the carriageway (grey, not light): kerbs, pavements, paint and
        // concrete keep their plain colour
        float spread = max(vColor.r, max(vColor.g, vColor.b)) - min(vColor.r, min(vColor.g, vColor.b));
        float lum = dot(vColor, vec3(0.2126, 0.7152, 0.0722));
        float asphalt = (1.0 - smoothstep(0.05, 0.08, spread)) * (1.0 - smoothstep(0.7, 0.735, lum));
        // and grass on the lawn strips under hedges
        float green = smoothstep(0.02, 0.1, vColor.g - max(vColor.r, vColor.b));
        vec4 grain = groundGrain(vWorld);
        float detail = 1.0 + grain.a * asphalt * 0.7 + grain.r * green * 0.6;
        gl_FragColor = linearToOutputTexel(vec4(fogged(toLinear(vColor) * (wear - mend) * detail * light, vWorld), 1.0));
      }
    `,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -10,
  });
}

