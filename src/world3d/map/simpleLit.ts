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

export function simpleLit(color: THREE.ColorRepresentation, uniforms: SimpleLitUniforms, options: { side?: THREE.Side } = {}) {
  return new THREE.ShaderMaterial({
    side: options.side ?? THREE.FrontSide,
    uniforms: {
      ...uniforms,
      uColor: { value: new THREE.Color(color) }, // linear working colour
      uSun: { value: SUN },
    },
    vertexShader: /* glsl */ `
      uniform float uExag;
      attribute float iGround;
      varying vec3 vNormal;
      varying vec3 vWorld;
      varying vec3 vTint;
      void main() {
        vec4 p = vec4(position, 1.0);
        vec3 n = normal;
        #ifdef USE_INSTANCING
          p = instanceMatrix * p;
          n = mat3(instanceMatrix) * n;
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
      void main() {
        vec3 n = normalize(vNormal);
        if (!gl_FrontFacing) n = -n;
        float light = 0.5 + 0.18 * n.y + 0.42 * max(dot(n, uSun), 0.0);
        vec3 color = uColor * vTint * light;
        float fog = smoothstep(uFogNear, uFogFar, distance(vWorld, uCameraPos));
        color = mix(color, pow(uFogColor, vec3(2.2)), fog);
        gl_FragColor = linearToOutputTexel(vec4(color, 1.0));
      }
    `,
  });
}
