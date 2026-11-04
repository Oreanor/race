import * as THREE from 'three';
import { portuguesePastel } from '@/game/buildings/BuildingStyles';

// Shaders of the base world (ground, roads, far buildings). The camera matrix is
// a full scene→clip matrix (MapLibre style), so distances for fog are measured
// against uCameraPos in scene space instead of view space.

export type BaseUniforms = {
  uExag: { value: number };
  uCameraPos: { value: THREE.Vector3 };
  uSun: { value: THREE.Vector3 };
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
export function groundMaterial(u: BaseUniforms, raster: THREE.Texture) {
  return new THREE.ShaderMaterial({
    uniforms: { ...u, uMap: { value: raster } },
    vertexShader: /* glsl */ `
      uniform float uExag;
      attribute float aGround;
      varying vec2 vUv;
      varying vec3 vWorld;
      void main() {
        vUv = uv;
        vec4 world = modelMatrix * vec4(position.x, position.y + aGround * uExag, position.z, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      ${COMMON}
      uniform sampler2D uMap;
      varying vec2 vUv;
      varying vec3 vWorld;
      void main() {
        vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
        if (n.y < 0.0) n = -n;
        vec3 albedo = toLinear(texture2D(uMap, vUv).rgb);
        // soft hillshade: only the slope darkens, flat ground keeps its colour
        float shade = 0.82 + 0.18 * clamp(dot(n, uSun) / uSun.y, 0.0, 1.2);
        gl_FragColor = linearToOutputTexel(vec4(fogged(albedo * shade, vWorld), 1.0));
      }
    `,
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
        gl_FragColor = linearToOutputTexel(vec4(fogged(toLinear(vColor), vWorld), 1.0));
      }
    `,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
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
        // flat, comic-like light close to the MeshBasic look of the detailed layer
        float light = n.y > 0.5 ? 1.0 : 0.86 + 0.14 * max(dot(n, uSun), 0.0);
        gl_FragColor = linearToOutputTexel(vec4(fogged(albedo * light, vWorld), 1.0));
      }
    `,
  });
}
