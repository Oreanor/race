import * as THREE from 'three';
import { portuguesePastel } from '@/game/buildings/BuildingStyles';
import { worldTime } from './simpleLit';

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
  uHeadOn: { value: number };
  uFogColor: { value: THREE.Color };
  uFogNear: { value: number };
  uFogFar: { value: number };
  /** player car in scene space; buildings between it and the camera turn see-through */
  uCar: { value: THREE.Vector3 };
  uXray: { value: number };
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
    uHeadOn: { value: 0 },
    uFogColor: { value: new THREE.Color().setStyle(fogColor, THREE.NoColorSpace) },
    // Fog is fully opaque before the load radius: tiles always arrive unseen.
    uFogNear: { value: 1100 },
    uFogFar: { value: 2000 },
    uCar: { value: new THREE.Vector3() },
    uXray: { value: 0 },
  };
}

const COMMON = /* glsl */ `
uniform vec3 uSun;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform float uNight;
uniform vec3 uHeadPos;
uniform vec3 uHeadDir;
uniform float uHeadOn;
// the car's headlights: a warm cone in front of it, fading with distance
vec3 headlight(vec3 world, vec3 n) {
  if (uHeadOn < 0.01) return vec3(0.0);
  vec3 d = world - uHeadPos;
  float dist = length(d);
  if (dist > 60.0) return vec3(0.0);
  vec3 l = d / max(dist, 0.001);
  float cone = smoothstep(0.80, 0.94, dot(l, uHeadDir));
  float fall = 1.0 / (1.0 + dist * dist * 0.006) * smoothstep(60.0, 20.0, dist);
  float facing = clamp(dot(n, -l) * 0.8 + 0.35, 0.0, 1.0);
  return vec3(1.0, 0.9, 0.72) * 2.4 * cone * fall * facing * uHeadOn;
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

/** Terrain tile with its ground raster. One material per tile (own texture). */
const GROUND_VERTEX = /* glsl */ `
  uniform float uExag;
  attribute float aGround;
  attribute vec3 aColor;
  varying vec3 vColor;
  varying vec3 vWorld;
  void main() {
    vColor = aColor;
    vec4 world = modelMatrix * vec4(position.x, position.y + aGround * uExag, position.z, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const GROUND_FRAGMENT = /* glsl */ `
  ${COMMON}
  varying vec3 vColor;
  varying vec3 vWorld;
  void main() {
    vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    if (n.y < 0.0) n = -n;
    // sky light plus sunlight on the slope (hillshade comes from the real sun)
    vec3 light = uAmbient * 0.9 + uSunColor * 0.55 * max(dot(n, uSun), 0.0) + headlight(vWorld, n) * 0.91;
    gl_FragColor = linearToOutputTexel(vec4(fogged(toLinear(vColor) * light / 0.91, vWorld), 1.0));
  }
`;

/** Terrain: vertex-coloured ground (bank colour next to water). */
export function groundMaterial(u: BaseUniforms) {
  return new THREE.ShaderMaterial({ uniforms: { ...u }, vertexShader: GROUND_VERTEX, fragmentShader: GROUND_FRAGMENT });
}

/**
 * Land-use polygons lying exactly on the terrain triangles; layer 0..2 are
 * stacked with growing polygon offsets (landuse < landcover < park).
 */
export function overlayMaterial(u: BaseUniforms, layer: number) {
  return new THREE.ShaderMaterial({
    uniforms: { ...u }, vertexShader: GROUND_VERTEX, fragmentShader: GROUND_FRAGMENT,
    polygonOffset: true, polygonOffsetFactor: -1 - layer, polygonOffsetUnits: -2 - 2 * layer,
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
        // foam: a broken, gently moving line right at the bank
        float wobble = 0.5 + 0.5 * sin(p.x * 1.7 + t * 1.3) * sin(p.y * 1.9 - t * 1.1);
        float foam = (1.0 - smoothstep(0.3, 1.6 + wobble, vShore)) * (vPool > 0.5 ? 0.25 : 0.7);
        color = mix(color, toLinear(vec3(0.94, 0.97, 0.97)) * (uAmbient + uSunColor * 0.4), foam);
        gl_FragColor = linearToOutputTexel(vec4(fogged(color, vWorld), 1.0));
      }
    `,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
  });
}

export function roadMaterial(u: BaseUniforms) {
  return new THREE.ShaderMaterial({
    uniforms: { ...u },
    vertexShader: /* glsl */ `
      uniform float uExag;
      attribute float aGround;
      attribute vec3 aColor;
      varying vec3 vColor;
      varying vec3 vWorld;
      void main() {
        vColor = aColor;
        vec4 world = modelMatrix * vec4(position.x, position.y + aGround * uExag, position.z, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      ${COMMON}
      varying vec3 vColor;
      varying vec3 vWorld;
      void main() {
        vec3 light = (uAmbient * 0.9 + uSunColor * 0.55 * max(uSun.y, 0.0)) / 0.91 + headlight(vWorld, vec3(0.0, 1.0, 0.0));
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
      uMask: { value: mask },
      uGlass0: { value: hex(portuguesePastel.windowColors[0]) },
      uGlass1: { value: hex(portuguesePastel.windowColors[1]) },
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
      void main() {
        vColor = aColor;
        vFacade = aFacade;
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
      uniform sampler2D uMask;
      uniform vec3 uGlass0;
      uniform vec3 uGlass1;
      uniform vec3 uFrame;
      uniform vec3 uCar;
      uniform float uXray;
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
      // 4×4 ordered dither: screen-door transparency without sorting
      float bayer(vec2 p) {
        vec2 q = mod(floor(p), 4.0);
        int i = int(q.x + q.y * 4.0);
        float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
        return (m[i] + 0.5) / 16.0;
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
        if (vWin.x > 0.5) {
          vec2 uv = vFacade.xy;
          if (uv.x >= 0.0 && uv.x < vWin.x && uv.y >= 0.0 && uv.y < vWin.y) {
            vec3 frame = toLinear(uFrame);
            vec3 glass = toLinear(mix(uGlass0, uGlass1, vFacade.z)) * 0.85;
            vec2 cellM = vWin.zw;                      // cell size in meters
            vec2 p = (fract(uv) - 0.5) * cellM;        // meters from the pane centre
            vec2 aa = max(fwidth(uv) * cellM, vec2(1e-4)) * 0.75;
            float f = box(p, vWinSize * 0.5, aa);
            float g = box(p, vWinSize * 0.46, aa);
            vec3 sharp = mix(mix(albedo, frame, f), glass, g);
            // far away a cell covers few pixels: use its average colour (no moiré)
            float fa = clamp(vWinSize.x * vWinSize.y / (cellM.x * cellM.y), 0.0, 1.0);
            float ga = fa * 0.8464;
            vec3 average = albedo * (1.0 - fa) + frame * (fa - ga) + glass * ga;
            float far = smoothstep(0.18, 0.45, max(fwidth(uv.x), fwidth(uv.y)));
            albedo = mix(sharp, average, far);
          }
        }
        vec3 n = normalize(vNormal);
        // flat, comic-like light; by day it matches the old fixed look exactly
        float d = max(dot(n, uSun), 0.0);
        vec3 light = n.y > 0.5
          ? (uAmbient + uSunColor * d) / 1.2
          : (uAmbient + uSunColor * 0.22 * d) / 0.84;
        vec3 color = albedo * (light + headlight(vWorld, n));
        // at night a share of the windows is lit, each window its own warm tone
        if (uNight > 0.01 && vWin.x > 0.5) {
          vec2 uv = vFacade.xy;
          if (uv.x >= 0.0 && uv.x < vWin.x && uv.y >= 0.0 && uv.y < vWin.y) {
            vec2 cell = floor(uv);
            float h = fract(sin(dot(cell + vColor.rg * 37.0, vec2(12.9898, 78.233))) * 43758.5453);
            vec2 p = (fract(uv) - 0.5) * vWin.zw;
            vec2 aa = max(fwidth(uv) * vWin.zw, vec2(1e-4)) * 0.75;
            float g = box(p, vWinSize * 0.46, aa);
            float far = smoothstep(0.18, 0.45, max(fwidth(uv.x), fwidth(uv.y)));
            float share = mix(g, vWinSize.x * vWinSize.y / (vWin.z * vWin.w) * 0.85, far);
            vec3 warm = mix(vec3(1.0, 0.72, 0.38), vec3(1.0, 0.86, 0.6), fract(h * 7.0));
            color += warm * 1.1 * share * step(0.62, h) * uNight;
          }
        }
        gl_FragColor = linearToOutputTexel(vec4(fogged(color, vWorld), 1.0));
      }
    `,
  });
}
