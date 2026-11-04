import * as THREE from 'three';

// Self-lit material for world props (trees, fences, stations, chimneys…).
// It ignores scene lights on purpose: the shared scene also holds the car's
// light rig, which is tuned for the GLB cars and would over-light props.
// Supports instancing, per-instance colour, per-instance ground (DEM × terrain
// exaggeration) and the world fog measured from the camera in scene space.

export type SimpleLitUniforms = {
  uSun: { value: THREE.Vector3 };
  uSunColor: { value: THREE.Color };
  uAmbient: { value: THREE.Color };
  uNight: { value: number };
  uHeadPos: { value: THREE.Vector3 };
  uHeadDir: { value: THREE.Vector3 };
  uHeadSide: { value: THREE.Vector3 };
  uHeadOn: { value: number };
  uExag: { value: number };
  uCameraPos: { value: THREE.Vector3 };
  uFogColor: { value: THREE.Color };
  uFogNear: { value: number };
  uFogFar: { value: number };
};

const SUN = new THREE.Vector3(0.45, 0.8, 0.3).normalize();

/** Seconds, shared by every foliage material; the host advances it each frame. */
export const worldTime = { value: 0 };
/** Season weights (spring, summer, autumn, winter), blended by the host on a change. */
export const seasonWeights = { value: new THREE.Vector4(0, 1, 0, 0) };

/** Uniforms with fog effectively off, for hosts without a world (MapLibre mode). */
export function standaloneUniforms(): SimpleLitUniforms {
  return {
    uExag: { value: 0 },
    uSun: { value: SUN.clone() },
    uSunColor: { value: new THREE.Color(0.64, 0.62, 0.57) },
    uAmbient: { value: new THREE.Color(0.72, 0.73, 0.75) },
    uNight: { value: 0 },
    uHeadPos: { value: new THREE.Vector3() },
    uHeadDir: { value: new THREE.Vector3(0, 0, -1) },
    uHeadSide: { value: new THREE.Vector3(0.6, 0, 0) },
    uHeadOn: { value: 0 },
    uCameraPos: { value: new THREE.Vector3() },
    uFogColor: { value: new THREE.Color(1, 1, 1) },
    uFogNear: { value: 1e9 },
    uFogFar: { value: 2e9 },
  };
}

export function simpleLit(color: THREE.ColorRepresentation, uniforms: SimpleLitUniforms, options: { side?: THREE.Side; foliage?: boolean; shiny?: boolean; broadleaf?: boolean; branches?: boolean } = {}) {
  const defines: Record<string, string> = {};
  if (options.broadleaf) defines.BROADLEAF = '';
  if (options.branches) defines.BRANCHES = '';
  if (options.foliage) defines.FOLIAGE = '';
  if (options.shiny) defines.SHINY = '';
  return new THREE.ShaderMaterial({
    side: options.side ?? THREE.FrontSide,
    defines,
    uniforms: {
      ...uniforms,
      uColor: { value: new THREE.Color(color) }, // linear working colour
      uTime: worldTime,
      uSeason: seasonWeights,
    },
    vertexShader: /* glsl */ `
      uniform float uExag;
      uniform float uTime;
      uniform vec4 uSeason;
      attribute float iGround;
      varying float vHash;
      varying vec3 vNormal;
      varying vec3 vWorld;
      varying vec3 vTint;
      #ifdef FOLIAGE
        attribute float aShade;
        varying float vShade;
      #endif
      varying float vLocalY;
      void main() {
        vLocalY = position.y;
        vec3 local = position;
        vHash = 0.0;
        #ifdef USE_INSTANCING
          vHash = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
        #endif
        #ifdef BROADLEAF
          // winter: the crown shrinks away (each tree a little apart), leaving bare branches
          float leafy = clamp((1.0 - uSeason.w) * 1.6 - vHash * 0.6, 0.0, 1.0);
          local = mix(vec3(0.0, 0.45, 0.0), local, leafy);
        #endif
        #ifdef BRANCHES
          // bare branches only show while there is some winter
          if (uSeason.w < 0.01) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
        #endif
        vec4 p = vec4(local, 1.0);
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
      
      uniform vec3 uCameraPos;
      uniform vec3 uFogColor;
      uniform float uFogNear;
      uniform float uFogFar;
      varying vec3 vNormal;
      varying vec3 vWorld;
      varying vec3 vTint;
      varying float vHash;
      uniform vec4 uSeason;
      #ifdef FOLIAGE
        varying float vShade;
      #endif
      varying float vLocalY;
      void main() {
        vec3 n = normalize(vNormal);
        vec3 tint = vTint;
        #ifdef BROADLEAF
          // one colour per tree for the season (linear colours)
          float h = vHash;
          vec3 summer = tint.g < max(tint.r, tint.b) ? vec3(0.078, 0.21, 0.042) : tint;
          vec3 spring = h < 0.45 ? vec3(0.89, 0.39, 0.55) : h < 0.65 ? vec3(0.9, 0.86, 0.79) : vec3(0.27, 0.58, 0.14);
          vec3 autumn = h < 0.3 ? vec3(0.77, 0.45, 0.045) : h < 0.6 ? vec3(0.69, 0.18, 0.024) : h < 0.85 ? vec3(0.48, 0.056, 0.025) : vec3(0.39, 0.37, 0.07);
          tint = spring * uSeason.x + summer * uSeason.y + autumn * (uSeason.z + uSeason.w);
        #endif
        if (!gl_FrontFacing) n = -n;
        #ifdef FOLIAGE
          // soft foliage: wrapped light (no hard terminator), gentle top-to-bottom
          // shading, leaf-clump dapple and a bright rim like light through leaves
          float wrap = dot(n, uSun) * 0.5 + 0.5;
          vec3 light = uAmbient * (0.8 + 0.11 * n.y) + uSunColor * 0.68 * wrap * wrap + headlight(vWorld, n);
          vec3 color = uColor * tint * light;
          color *= mix(0.74, 1.08, vShade);
          float dapple = sin(vWorld.x * 2.1 + vWorld.y * 0.7) * sin(vWorld.z * 2.3 - vWorld.y * 1.3) * sin(vWorld.y * 2.7 + vWorld.x * 0.9);
          color *= 1.0 + 0.09 * dapple;
          vec3 toEye = normalize(uCameraPos - vWorld);
          float rim = pow(1.0 - max(dot(n, toEye), 0.0), 2.0);
          color += uColor * tint * vec3(0.18, 0.22, 0.1) * rim;
        #else
          vec3 light = uAmbient * (0.69 + 0.25 * n.y) + uSunColor * 0.68 * max(dot(n, uSun), 0.0) + headlight(vWorld, n);
          vec3 color = uColor * tint * light;
        #endif
        #ifdef SHINY
          // a little metal: soft sun highlight plus a cool sky sheen on top
          vec3 eye = normalize(uCameraPos - vWorld);
          float spec = pow(max(dot(n, normalize(uSun + eye)), 0.0), 28.0);
          color += uSunColor * 0.88 * spec + uAmbient * 0.07 * max(n.y, 0.0);
          // lamp heads glow at night
          color += vec3(1.0, 0.78, 0.45) * 2.2 * uNight * step(6.7, vLocalY);
        #endif
        float fog = smoothstep(uFogNear, uFogFar, distance(vWorld, uCameraPos));
        color = mix(color, pow(uFogColor, vec3(2.2)), fog);
        gl_FragColor = linearToOutputTexel(vec4(color, 1.0));
      }
    `,
  });
}
