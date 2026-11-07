import * as THREE from 'three';
import type { Lighting } from './lighting.ts';

// Sun and moon on the sky, at their real directions. Camera-facing quads far
// out, drawn before the world (no depth write) so buildings and hills cover them.

const DISTANCE = 1200;

function body(fragment: string, size: number, additive: boolean) {
  const material = new THREE.ShaderMaterial({
    uniforms: { uPhase: { value: 0.5 }, uWarm: { value: 0 }, uFade: { value: 1 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv * 2.0 - 1.0;
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: fragment,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return mesh;
}

const SUN = /* glsl */ `
  uniform float uWarm;
  uniform float uFade;
  varying vec2 vUv;
  void main() {
    float r = length(vUv);
    // kill glow before the billboard's square edge — otherwise additive bleed
    // draws as vertical/horizontal seams on the sky
    if (r > 0.98) discard;
    float disc = smoothstep(0.16, 0.14, r);
    float glow = exp(-r * r * 14.0) * 0.55 + exp(-r * 4.5) * 0.22;
    glow *= smoothstep(0.92, 0.55, r);
    vec3 hot = mix(vec3(1.0, 0.97, 0.88), vec3(1.0, 0.62, 0.32), uWarm);
    vec3 color = hot * (disc * 1.6 + glow);
    float a = clamp(disc + glow, 0.0, 1.0) * uFade;
    if (a < 0.004) discard;
    gl_FragColor = linearToOutputTexel(vec4(color * uFade, 1.0));
  }
`;

const MOON = /* glsl */ `
  uniform float uPhase;   // 0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter
  uniform float uFade;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv / 0.42;
    float r = length(p);
    if (r > 1.6) discard;
    float glow = exp(-r * r * 1.4) * 0.18;
    if (r > 1.0) {
      gl_FragColor = linearToOutputTexel(vec4(vec3(0.6, 0.66, 0.8) * glow, glow) * uFade);
      return;
    }
    vec3 n = vec3(p, sqrt(1.0 - r * r));
    float a = uPhase * 6.2831853;
    vec3 sunDir = vec3(sin(a), 0.0, -cos(a)); // waxing: lit from the right
    float lit = smoothstep(-0.04, 0.06, dot(n, sunDir));
    // a few soft maria so it reads as the moon
    float maria = 0.86 + 0.14 * sin(p.x * 7.0 + 1.3) * sin(p.y * 6.0 - 0.7);
    vec3 day = vec3(0.92, 0.92, 0.88) * maria;
    vec3 earthshine = vec3(0.07, 0.08, 0.11);
    vec3 color = mix(earthshine, day, lit);
    float edge = smoothstep(1.0, 0.97, r);
    gl_FragColor = linearToOutputTexel(vec4(color, edge) * uFade);
  }
`;

export class SkyBodies {
  readonly group = new THREE.Group();
  private sun = body(SUN, 520, true);
  private moon = body(MOON, 150, false);

  constructor() {
    this.group.add(this.sun, this.moon);
  }

  update(eye: THREE.Vector3, light: Lighting) {
    const place = (mesh: THREE.Mesh, dir: THREE.Vector3, altitude: number) => {
      mesh.visible = altitude > -0.02;
      mesh.position.copy(eye).addScaledVector(dir, DISTANCE);
      mesh.lookAt(eye);
      (mesh.material as THREE.ShaderMaterial).uniforms.uFade.value = Math.min(1, Math.max(0, (altitude + 0.02) / 0.06));
    };
    const toDir = (p: { azimuth: number; altitude: number }) => new THREE.Vector3(
      Math.sin(p.azimuth) * Math.cos(p.altitude), Math.sin(p.altitude), -Math.cos(p.azimuth) * Math.cos(p.altitude),
    );
    place(this.sun, toDir(light.sunPos), light.sunPos.altitude);
    (this.sun.material as THREE.ShaderMaterial).uniforms.uWarm.value = Math.min(1, Math.max(0, 1 - light.sunPos.altitude / 0.35));
    place(this.moon, toDir(light.moonPos), light.moonPos.altitude);
    // the moon is pale against a bright day sky
    (this.moon.material as THREE.ShaderMaterial).uniforms.uFade.value *= 0.35 + 0.65 * light.night;
    (this.moon.material as THREE.ShaderMaterial).uniforms.uPhase.value = light.moonPhase;
  }

  dispose() {
    for (const mesh of [this.sun, this.moon]) { mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); }
  }
}
