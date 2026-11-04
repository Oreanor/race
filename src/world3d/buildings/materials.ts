import * as THREE from 'three';
import { portuguesePastel } from '@/game/buildings/BuildingStyles';

// Shared lighting + fog chunk. Colours arrive in sRGB and are lit in linear space.
const LIGHT = /* glsl */ `
uniform vec3 uSun;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
vec3 shade(vec3 albedo, vec3 n, float height) {
  float sun = max(dot(n, uSun), 0.0);
  float sky = 0.5 + 0.5 * n.y;
  // cheap ground contact darkening, reads like ambient occlusion
  float contact = mix(0.78, 1.0, clamp(height / 7.0, 0.0, 1.0));
  return albedo * (0.42 * sky + 0.30 + 0.62 * sun) * contact;
}
vec3 fog(vec3 color, float depth) {
  float f = smoothstep(uFogNear, uFogFar, depth);
  return mix(color, toLinear(uFogColor), f);
}
`;

function hex(value: string) {
  return new THREE.Color().setStyle(value, THREE.NoColorSpace);
}

/**
 * One facade bay (BAY m) by one floor. Channels are masks, not colours:
 * R = glass, G = frame. Colours are applied in the shader, so every wall colour
 * shares one texture and one material.
 */
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
  // plinth line along the bottom of every floor tile reads as a storey band
  ctx.fillStyle = '#000';
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.anisotropy = 8;
  return texture;
}

export type WorldUniforms = {
  uSun: { value: THREE.Vector3 };
  uFogColor: { value: THREE.Color };
  uFogNear: { value: number };
  uFogFar: { value: number };
};

export function worldUniforms(fogColor: string): WorldUniforms {
  return {
    uSun: { value: new THREE.Vector3(0.45, 0.78, 0.35).normalize() },
    uFogColor: { value: hex(fogColor) },
    uFogNear: { value: 900 },
    uFogFar: { value: 1700 },
  };
}

/** Walls + roofs of a whole chunk in one draw call. */
export function buildingMaterial(world: WorldUniforms, mask: THREE.Texture, windows: boolean) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...world,
      uMask: { value: mask },
      uWindows: { value: windows ? 1 : 0 },
      uGlass0: { value: hex(portuguesePastel.windowColors[0]) },
      uGlass1: { value: hex(portuguesePastel.windowColors[1]) },
      uFrame: { value: hex(portuguesePastel.frameColor) },
    },
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute vec3 aFacade;
      varying vec3 vColor;
      varying vec3 vFacade;
      varying vec3 vNormal;
      varying float vHeight;
      varying float vDepth;
      void main() {
        vColor = aColor;
        vFacade = aFacade;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vHeight = position.y;
        vec4 view = modelViewMatrix * vec4(position, 1.0);
        vDepth = -view.z;
        gl_Position = projectionMatrix * view;
      }
    `,
    fragmentShader: /* glsl */ `
      ${LIGHT}
      uniform sampler2D uMask;
      uniform float uWindows;
      uniform vec3 uGlass0;
      uniform vec3 uGlass1;
      uniform vec3 uFrame;
      varying vec3 vColor;
      varying vec3 vFacade;
      varying vec3 vNormal;
      varying float vHeight;
      varying float vDepth;
      void main() {
        vec3 albedo = toLinear(vColor);
        if (uWindows > 0.5) {
          vec2 m = texture2D(uMask, vFacade.xy).rg;
          vec3 glass = toLinear(mix(uGlass0, uGlass1, vFacade.z));
          albedo = mix(albedo, toLinear(uFrame), m.g);
          albedo = mix(albedo, glass * 0.85, m.r);
        }
        vec3 color = fog(shade(albedo, normalize(vNormal), vHeight), vDepth);
        gl_FragColor = linearToOutputTexel(vec4(color, 1.0));
      }
    `,
  });
}

/** Unit window: a frame quad and an inset glass quad, facing +Z. */
export function windowGeometry() {
  const positions = new Float32Array([
    // frame
    -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    // glass, slightly in front so it never fights the frame
    -0.4, -0.42, 0.02, 0.4, -0.42, 0.02, 0.4, 0.42, 0.02, -0.4, 0.42, 0.02,
  ]);
  const glass = new Float32Array([0, 0, 0, 0, 1, 1, 1, 1]);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aGlass', new THREE.BufferAttribute(glass, 1));
  geometry.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  return geometry;
}

/** Instanced windows: offsets + wall axis per instance, no per-window Mesh. */
export function windowMaterial(world: WorldUniforms) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...world,
      uGlass0: { value: hex(portuguesePastel.windowColors[0]) },
      uGlass1: { value: hex(portuguesePastel.windowColors[1]) },
      uFrame: { value: hex(portuguesePastel.frameColor) },
    },
    vertexShader: /* glsl */ `
      attribute float aGlass;
      attribute vec4 iOffset;
      attribute vec4 iAxis;
      varying float vGlass;
      varying float vVariant;
      varying vec3 vNormal;
      varying float vHeight;
      varying float vDepth;
      void main() {
        vec3 along = vec3(iAxis.x, 0.0, iAxis.y);
        vec3 out_ = normalize(vec3(iAxis.y, 0.0, -iAxis.x));
        vec3 local = iOffset.xyz + along * position.x + vec3(0.0, iAxis.z * position.y, 0.0) + out_ * position.z * 1.4;
        vGlass = aGlass;
        vVariant = iAxis.w;
        vNormal = normalize(mat3(modelMatrix) * out_);
        vHeight = local.y;
        vec4 view = modelViewMatrix * vec4(local, 1.0);
        vDepth = -view.z;
        gl_Position = projectionMatrix * view;
      }
    `,
    fragmentShader: /* glsl */ `
      ${LIGHT}
      uniform vec3 uGlass0;
      uniform vec3 uGlass1;
      uniform vec3 uFrame;
      varying float vGlass;
      varying float vVariant;
      varying vec3 vNormal;
      varying float vHeight;
      varying float vDepth;
      void main() {
        vec3 glass = toLinear(mix(uGlass0, uGlass1, vVariant)) * 0.85;
        vec3 albedo = mix(toLinear(uFrame), glass, step(0.5, vGlass));
        vec3 color = fog(shade(albedo, normalize(vNormal), 7.0), vDepth);
        gl_FragColor = linearToOutputTexel(vec4(color, 1.0));
      }
    `,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

/** Ground plane with a faint 50 m grid so speed reads without roads. */
export function groundMaterial(world: WorldUniforms, color: string) {
  return new THREE.ShaderMaterial({
    uniforms: { ...world, uColor: { value: hex(color) }, uGridOffset: { value: new THREE.Vector2() } },
    vertexShader: /* glsl */ `
      varying vec2 vWorld;
      varying float vDepth;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xz;
        vec4 view = viewMatrix * world;
        vDepth = -view.z;
        gl_Position = projectionMatrix * view;
      }
    `,
    fragmentShader: /* glsl */ `
      ${LIGHT}
      uniform vec3 uColor;
      uniform vec2 uGridOffset;
      varying vec2 vWorld;
      varying float vDepth;
      void main() {
        vec2 p = (vWorld + uGridOffset) / 50.0;
        vec2 g = abs(fract(p - 0.5) - 0.5) / fwidth(p);
        float line = 1.0 - min(min(g.x, g.y), 1.0);
        vec3 albedo = toLinear(uColor) * (1.0 - 0.08 * line);
        vec3 color = fog(shade(albedo, vec3(0.0, 1.0, 0.0), 10.0), vDepth);
        gl_FragColor = linearToOutputTexel(vec4(color, 1.0));
      }
    `,
  });
}
