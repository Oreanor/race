import * as THREE from 'three';
import { seasonWeights, snowCover, worldTime } from './simpleLit.ts';
import {
  COMMON,
  LAMP_FRAGMENT,
  LAMP_VERTEX,
  lampMapUniform,
} from './shaders/common.ts';
import { baseUniforms, type BaseUniforms } from './shaders/uniforms.ts';

export type { BaseUniforms } from './shaders/uniforms.ts';
export { baseUniforms } from './shaders/uniforms.ts';
export { MAX_FIRES, MAX_SHOTS } from './shaders/common.ts';
export { facadeMask, farBuildingMaterial } from './facadeMaterial.ts';

// Shaders of the base world (ground, roads, water). Facade lives in facadeMaterial.ts.

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
    // grass is never one flat green: drier and lusher patches, a finer mottle
    float tone = 0.86 + 0.2 * vnoise(vWorld.xz * 0.05) + 0.08 * vnoise(vWorld.xz * 0.4);
    vec3 albedo = mix(vColor * mix(1.0, tone, greenish), snow, uSeason.w * uSnow * greenish);
    // sky light plus sunlight on the slope (hillshade comes from the real sun)
    vec3 light = uAmbient * 0.9 + uSunColor * 0.55 * max(dot(n, uSun), 0.0) * cloudSun(vWorld) + (headlight(vWorld, n) + lampLight()) * 0.91;
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
 * Water: noise-driven ripples (no cos-grid), shore→deep colour, soft fresnel
 * sky, a broad sun path, and broken foam along the banks.
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
        vec2 p = vWorld.xz;
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
        vec3 light = (uAmbient * 0.9 + uSunColor * 0.55 * max(uSun.y, 0.0) * cloudSun(vWorld)) / 0.91 + headlight(vWorld, vec3(0.0, 1.0, 0.0)) + lampLight();
        // asphalt is worn unevenly: broad lighter and darker stretches, and darker patched spots
        float wear = 0.94 + 0.1 * vnoise(vWorld.xz * 0.08) + 0.04 * vnoise(vWorld.xz * 0.9);
        float mend = smoothstep(0.66, 0.74, vnoise(vWorld.xz * 0.21 + 13.0)) * 0.08;
        gl_FragColor = linearToOutputTexel(vec4(fogged(toLinear(vColor) * (wear - mend) * light, vWorld), 1.0));
      }
    `,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -10,
  });
}

