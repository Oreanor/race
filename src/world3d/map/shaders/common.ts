import * as THREE from 'three';

/** bullet-hit windows the facade shader knows about at once */
export const MAX_SHOTS = 48;
/** burning windows the facade shader knows about at once (one fire call is enough) */
export const MAX_FIRES = 24;

export const COMMON = /* glsl */ `
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

uniform float uClock;
uniform float uClouds;
float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
// smooth value noise, 0..1
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), f.x), mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), f.x), f.y);
}
// the share of sunlight left under the clouds: big soft shadows drifting with the wind
float cloudSun(vec3 w) {
  if (uClouds < 0.01) return 1.0;
  vec2 p = w.xz / 260.0 + vec2(uClock * 0.012, uClock * 0.006);
  float c = vnoise(p) * 0.65 + vnoise(p * 2.3 + 7.1) * 0.35;
  return 1.0 - uClouds * 0.55 * smoothstep(0.5, 0.72, c);
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

export function hex(value: string) {
  return new THREE.Color().setStyle(value, THREE.NoColorSpace);
}

/**
 * Street light baked per tile (tiles/vegetationTile lampLight): the vertex passes
 * the tile-local position, the fragment reads the pool there. The map is set per
 * mesh just before it draws (WorldTiles.lampLit).
 */
export const LAMP_VERTEX = /* glsl */ `
  uniform float uTileSpan;
  varying vec2 vLampUv;
`;
export const LAMP_FRAGMENT = /* glsl */ `
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
export const lampMapUniform = () => ({ uLampMap: { value: null as THREE.Texture | null } });

