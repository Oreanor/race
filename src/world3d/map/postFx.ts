import * as THREE from 'three';

// The last step of a frame, over everything drawn (the world and every layer on top):
// the picture is copied into a texture and comes back filmic —
//  · ACES tone mapping on linear colour: deeper shadows, highlights that roll off softly
//  · bloom: what is bright (lamps, lit windows, headlights, the sun's glare) is cut out,
//    blurred at quarter size and laid back over — strong at night, a touch by day
//  · a faint vignette.
// Edges are already smoothed by the canvas MSAA, so no FXAA pass.

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const BRIGHT = /* glsl */ `
uniform sampler2D uFrame;
uniform vec2 uTexel;
uniform float uThreshold;
varying vec2 vUv;
void main() {
  // four taps: a little box filter on the way down to quarter size
  vec3 c = texture2D(uFrame, vUv + uTexel * vec2(-1.0, -1.0)).rgb
         + texture2D(uFrame, vUv + uTexel * vec2( 1.0, -1.0)).rgb
         + texture2D(uFrame, vUv + uTexel * vec2(-1.0,  1.0)).rgb
         + texture2D(uFrame, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  c *= 0.25;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  gl_FragColor = vec4(c * smoothstep(uThreshold, uThreshold + 0.2, lum), 1.0);
}`;

const BLUR = /* glsl */ `
uniform sampler2D uSource;
uniform vec2 uStep;
varying vec2 vUv;
void main() {
  // 9-tap Gaussian along one axis
  vec3 c = texture2D(uSource, vUv).rgb * 0.2270270;
  c += (texture2D(uSource, vUv + uStep * 1.3846154).rgb + texture2D(uSource, vUv - uStep * 1.3846154).rgb) * 0.3162162;
  c += (texture2D(uSource, vUv + uStep * 3.2307692).rgb + texture2D(uSource, vUv - uStep * 3.2307692).rgb) * 0.0702703;
  gl_FragColor = vec4(c, 1.0);
}`;

const FINAL = /* glsl */ `
uniform sampler2D uFrame;
uniform sampler2D uBloom;
uniform float uExposure;
uniform float uBloomStrength;
uniform float uVignette;
varying vec2 vUv;
vec3 aces(vec3 x) {
  // Narkowicz's fit of the ACES filmic curve
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
void main() {
  vec3 c = texture2D(uFrame, vUv).rgb;
  vec3 lin = pow(c, vec3(2.2)) * uExposure;
  lin += pow(texture2D(uBloom, vUv).rgb, vec3(2.2)) * uBloomStrength;
  vec3 mapped = pow(aces(lin), vec3(1.0 / 2.2));
  float edge = smoothstep(0.55, 1.05, length(vUv - 0.5) * 1.414);
  mapped *= 1.0 - edge * uVignette;
  gl_FragColor = vec4(mapped, 1.0);
}`;

export class PostFx {
  enabled = true;
  private frame: THREE.FramebufferTexture | null = null;
  private bloomA: THREE.WebGLRenderTarget | null = null;
  private bloomB: THREE.WebGLRenderTarget | null = null;
  private readonly size = new THREE.Vector2();
  private readonly origin = new THREE.Vector2();
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh;
  private readonly bright = this.material(BRIGHT, { uFrame: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 0.8 } });
  private readonly blur = this.material(BLUR, { uSource: { value: null }, uStep: { value: new THREE.Vector2() } });
  private readonly final = this.material(FINAL, {
    uFrame: { value: null }, uBloom: { value: null },
    uExposure: { value: 0.92 }, uBloomStrength: { value: 0.3 }, uVignette: { value: 0.16 },
  });

  constructor() {
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.final);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  private material(fragmentShader: string, uniforms: Record<string, THREE.IUniform>) {
    return new THREE.ShaderMaterial({ vertexShader: VERTEX, fragmentShader, uniforms, depthTest: false, depthWrite: false, toneMapped: false });
  }

  private ensure(width: number, height: number) {
    if (this.frame && this.frame.image.width === width && this.frame.image.height === height) return;
    this.frame?.dispose();
    this.bloomA?.dispose();
    this.bloomB?.dispose();
    this.frame = new THREE.FramebufferTexture(width, height);
    this.frame.minFilter = THREE.LinearFilter;
    this.frame.magFilter = THREE.LinearFilter;
    const qw = Math.max(1, Math.floor(width / 4)), qh = Math.max(1, Math.floor(height / 4));
    const opts = { depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, type: THREE.HalfFloatType };
    this.bloomA = new THREE.WebGLRenderTarget(qw, qh, opts);
    this.bloomB = new THREE.WebGLRenderTarget(qw, qh, opts);
  }

  private pass(renderer: THREE.WebGLRenderer, material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) {
    this.quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }

  /** Over what is on the canvas now. `night` 0 … 1: more bloom after dark. */
  render(renderer: THREE.WebGLRenderer, night: number) {
    if (!this.enabled) return;
    renderer.getDrawingBufferSize(this.size);
    const width = Math.floor(this.size.x), height = Math.floor(this.size.y);
    if (width < 2 || height < 2) return;
    this.ensure(width, height);
    const frame = this.frame!, a = this.bloomA!, b = this.bloomB!;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(null);
    renderer.copyFramebufferToTexture(frame, this.origin);
    // bright parts, down to a quarter
    this.bright.uniforms.uFrame.value = frame;
    (this.bright.uniforms.uTexel.value as THREE.Vector2).set(1 / width, 1 / height);
    this.bright.uniforms.uThreshold.value = 0.82 - night * 0.22;
    this.pass(renderer, this.bright, a);
    // blur: across, then down
    this.blur.uniforms.uSource.value = a.texture;
    (this.blur.uniforms.uStep.value as THREE.Vector2).set(1 / a.width, 0);
    this.pass(renderer, this.blur, b);
    this.blur.uniforms.uSource.value = b.texture;
    (this.blur.uniforms.uStep.value as THREE.Vector2).set(0, 1 / a.height);
    this.pass(renderer, this.blur, a);
    // back onto the canvas, tone mapped with the glow
    this.final.uniforms.uFrame.value = frame;
    this.final.uniforms.uBloom.value = a.texture;
    this.final.uniforms.uBloomStrength.value = 0.22 + night * 0.55;
    this.pass(renderer, this.final, null);
    renderer.autoClear = autoClear;
  }

  dispose() {
    this.frame?.dispose();
    this.bloomA?.dispose();
    this.bloomB?.dispose();
    this.quad.geometry.dispose();
    for (const m of [this.bright, this.blur, this.final]) m.dispose();
  }
}
