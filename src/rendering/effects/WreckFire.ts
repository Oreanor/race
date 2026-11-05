import * as THREE from 'three';

// Fire on a burning wreck, drawn by a shader rather than flung particles: a few
// upright strips standing on the body, each turned to the camera about the
// vertical, filled with value noise that streams upward and is cut by a flame
// mask (wide and hot at the foot, narrow and ragged at the tips). The flames stay
// rooted to the wreck and flicker in place; strength 1 → 0 lets them die down.

/** camera position in the vehicle layer's local frame (set every frame) */
export const fireEye = { value: new THREE.Vector3(0, 100, 0) };
const fireTime = { value: 0 };

const VERTEX = /* glsl */ `
  uniform vec3 uEye;
  attribute vec2 aSize;     // width, height (m)
  varying vec2 vUv;
  void main() {
    vUv = uv;
    // the strip's foot in the layer frame; it turns to the camera about the vertical only
    vec3 foot = (modelMatrix * vec4(position, 1.0)).xyz;
    vec3 toEye = uEye - foot;
    vec3 right = normalize(vec3(toEye.z, 0.0, -toEye.x) + vec3(1e-5, 0.0, 0.0));
    vec3 p = foot + right * (uv.x - 0.5) * aSize.x + vec3(0.0, uv.y * aSize.y, 0.0);
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uStrength;
  uniform float uSeed;
  varying vec2 vUv;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
    return v;
  }
  void main() {
    vec2 uv = vUv;
    // noise streaming upward, faster higher up, a little sway
    float t = uTime * 1.6 + uSeed * 10.0;
    vec2 q = vec2(uv.x * 3.2 + sin(t * 0.7 + uv.y * 2.0) * 0.15, uv.y * 2.4 - t * 1.8);
    float n = fbm(q + uSeed * 7.0);
    // flame mask: full across the foot, narrowing to the tips
    float x = abs(uv.x - 0.5) * 2.0;
    float width = mix(1.0, 0.15, pow(uv.y, 0.8));
    float mask = smoothstep(width, width * 0.35, x);
    float heat = mask * (1.25 - uv.y * 1.35) + (n - 0.5) * 1.1 * (0.4 + uv.y);
    heat *= uStrength;
    heat *= smoothstep(0.0, 0.08, uv.y); // soft where it meets the body
    if (heat < 0.18) discard;
    // red edges → orange → yellow-white core
    vec3 color = mix(vec3(0.9, 0.12, 0.02), vec3(1.6, 0.55, 0.08), smoothstep(0.18, 0.45, heat));
    color = mix(color, vec3(2.0, 1.6, 0.7), smoothstep(0.55, 0.95, heat));
    float alpha = smoothstep(0.18, 0.4, heat);
    gl_FragColor = vec4(color * alpha, 1.0);
  }
`;

export class WreckFire {
  readonly group = new THREE.Group();
  private material: THREE.ShaderMaterial;
  private geometry: THREE.BufferGeometry;

  /** `length`, `width`: the car's size (m), to spread the flames over the body */
  constructor(length: number, width = 1.8, seed = Math.random()) {
    // strips along the body: a big one in the middle, smaller ones fore and aft
    const strips = [
      { x: 0, z: 0, w: width * 1.15, h: 2.6 },
      { x: width * 0.25, z: length * 0.28, w: width * 0.9, h: 1.9 },
      { x: -width * 0.2, z: -length * 0.3, w: width * 0.85, h: 1.7 },
      { x: -width * 0.3, z: length * 0.05, w: width * 0.7, h: 1.4 },
    ];
    const position: number[] = [], uv: number[] = [], size: number[] = [], index: number[] = [];
    strips.forEach((s, i) => {
      // four corners sharing the foot point; the shader spreads them
      for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
        position.push(s.x, 0.25, s.z);
        uv.push(u, v);
        size.push(s.w, s.h);
      }
      const o = i * 4;
      index.push(o, o + 1, o + 2, o, o + 2, o + 3);
    });
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
    this.geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    this.geometry.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 2));
    this.geometry.setIndex(index);
    this.material = new THREE.ShaderMaterial({
      uniforms: { uEye: fireEye, uTime: fireTime, uStrength: { value: 1 }, uSeed: { value: seed } },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.frustumCulled = false; // the shader moves the corners
    mesh.renderOrder = 9;
    this.group.add(mesh);
  }

  /** 1 = blazing … 0 = out */
  set strength(value: number) { this.material.uniforms.uStrength.value = value; }

  static tick(now: number) { fireTime.value = now / 1000; }

  dispose() {
    this.group.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
