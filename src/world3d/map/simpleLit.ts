import * as THREE from 'three';

// Self-lit material for world props (trees, fences, stations, chimneys…).
// It ignores scene lights on purpose: the shared scene also holds the car's
// light rig, which is tuned for the GLB cars and would over-light props.
// Supports instancing, per-instance colour, per-instance ground (DEM × terrain
// exaggeration) and the world fog measured from the camera in scene space.

export type SimpleLitUniforms = {
  uExag: { value: number };
  uCameraPos: { value: THREE.Vector3 };
  uFogColor: { value: THREE.Color };
  uFogNear: { value: number };
  uFogFar: { value: number };
};

const SUN = new THREE.Vector3(0.45, 0.8, 0.3).normalize();

/** Seconds, shared by every foliage material; the host advances it each frame. */
export const worldTime = { value: 0 };

/** Uniforms with fog effectively off, for hosts without a world (MapLibre mode). */
export function standaloneUniforms(): SimpleLitUniforms {
  return {
    uExag: { value: 0 },
    uCameraPos: { value: new THREE.Vector3() },
    uFogColor: { value: new THREE.Color(1, 1, 1) },
    uFogNear: { value: 1e9 },
    uFogFar: { value: 2e9 },
  };
}

export function simpleLit(color: THREE.ColorRepresentation, uniforms: SimpleLitUniforms, options: { side?: THREE.Side; foliage?: boolean; shiny?: boolean } = {}) {
  const defines: Record<string, string> = {};
  if (options.foliage) defines.FOLIAGE = '';
  if (options.shiny) defines.SHINY = '';
  return new THREE.ShaderMaterial({
    side: options.side ?? THREE.FrontSide,
    defines,
    uniforms: {
      ...uniforms,
      uColor: { value: new THREE.Color(color) }, // linear working colour
      uSun: { value: SUN },
      uTime: worldTime,
    },
    vertexShader: /* glsl */ `
      uniform float uExag;
      uniform float uTime;
      attribute float iGround;
      varying vec3 vNormal;
      varying vec3 vWorld;
      varying vec3 vTint;
      #ifdef FOLIAGE
        attribute float aShade;
        varying float vShade;
      #endif
      void main() {
        vec4 p = vec4(position, 1.0);
        vec3 n = normal;
        #ifdef USE_INSTANCING
          p = instanceMatrix * p;
          // inverse-transpose for scaled instances (flat pine crowns are very non-uniform)
          mat3 im = mat3(instanceMatrix);
          n = im * (n / vec3(dot(im[0], im[0]), dot(im[1], im[1]), dot(im[2], im[2])));
        #endif
        #ifdef FOLIAGE
          vShade = aShade;
          #ifdef USE_INSTANCING
            // gentle wind: the crown top sways, the base stays put; phase from position
            vec2 phase = instanceMatrix[3].xz * 0.37;
            float amp = aShade * aShade * 0.05 * length(instanceMatrix[1].xyz);
            p.x += sin(uTime * 1.25 + phase.x) * amp;
            p.z += cos(uTime * 0.95 + phase.y) * amp * 0.7;
          #endif
        #endif
        #ifdef USE_INSTANCING_COLOR
          vTint = instanceColor;
        #else
          vTint = vec3(1.0);
        #endif
        vec4 world = modelMatrix * p;
        world.y += iGround * uExag;
        vWorld = world.xyz;
        vNormal = normalize(mat3(modelMatrix) * n);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform vec3 uSun;
      uniform vec3 uCameraPos;
      uniform vec3 uFogColor;
      uniform float uFogNear;
      uniform float uFogFar;
      varying vec3 vNormal;
      varying vec3 vWorld;
      varying vec3 vTint;
      #ifdef FOLIAGE
        varying float vShade;
      #endif
      void main() {
        vec3 n = normalize(vNormal);
        if (!gl_FrontFacing) n = -n;
        #ifdef FOLIAGE
          // soft foliage: wrapped light (no hard terminator), gentle top-to-bottom
          // shading, leaf-clump dapple and a bright rim like light through leaves
          float wrap = dot(n, uSun) * 0.5 + 0.5;
          float light = 0.58 + 0.42 * wrap * wrap + 0.08 * n.y;
          vec3 color = uColor * vTint * light;
          color *= mix(0.74, 1.08, vShade);
          float dapple = sin(vWorld.x * 2.1 + vWorld.y * 0.7) * sin(vWorld.z * 2.3 - vWorld.y * 1.3) * sin(vWorld.y * 2.7 + vWorld.x * 0.9);
          color *= 1.0 + 0.09 * dapple;
          vec3 toEye = normalize(uCameraPos - vWorld);
          float rim = pow(1.0 - max(dot(n, toEye), 0.0), 2.0);
          color += uColor * vTint * vec3(0.18, 0.22, 0.1) * rim;
        #else
          float light = 0.5 + 0.18 * n.y + 0.42 * max(dot(n, uSun), 0.0);
          vec3 color = uColor * vTint * light;
        #endif
        #ifdef SHINY
          // a little metal: soft sun highlight plus a cool sky sheen on top
          vec3 eye = normalize(uCameraPos - vWorld);
          float spec = pow(max(dot(n, normalize(uSun + eye)), 0.0), 28.0);
          color += vec3(0.55) * spec + vec3(0.05, 0.06, 0.07) * max(n.y, 0.0);
        #endif
        float fog = smoothstep(uFogNear, uFogFar, distance(vWorld, uCameraPos));
        color = mix(color, pow(uFogColor, vec3(2.2)), fog);
        gl_FragColor = linearToOutputTexel(vec4(color, 1.0));
      }
    `,
  });
}
