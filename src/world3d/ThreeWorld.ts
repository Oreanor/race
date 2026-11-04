import * as THREE from 'three';
import { vehicleConfig, type Car, type City } from '@/config/vehicle.config';
import { VehicleController, type Position } from '@/game/VehicleController';
import { VehiclePose } from '@/game/VehiclePose';
import { BuildingCollisions } from '@/game/BuildingCollisions';
import { LocalFrame, type LngLat } from './mercator';
import { ChaseCamera } from './ChaseCamera';
import { loadCarModel, placeholderCar } from './carModel';
import { buildingMaterial, facadeMask, groundMaterial, windowGeometry, windowMaterial, worldUniforms } from './buildings/materials';
import { TileManager, defaultTileOptions, type TileManagerStats, type WindowMode } from './tiles/TileManager';
import { PerfMonitor, benchmark, type BenchResult, type PerfSnapshot } from './perf/PerfMonitor';

export type ThreeWorldSettings = {
  windowMode: WindowMode;
  /** device pixel ratio cap */
  pixelRatio: number;
  antialias: boolean;
  drawDistance: number;
};

export const defaultThreeWorldSettings: ThreeWorldSettings = {
  windowMode: 'texture',
  pixelRatio: 1.5,
  antialias: true,
  drawDistance: 1700,
};

export type ThreeWorldHud = {
  speedKmh: number;
  position: LngLat;
  perf: PerfSnapshot;
  tiles: TileManagerStats;
  status: string;
  ready: boolean;
};

const SKY = '#cfe1ea';
const GROUND = '#dcdad3';
const DRIVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
const ARROWS: Record<string, string> = { ArrowUp: 'KeyW', ArrowDown: 'KeyS', ArrowLeft: 'KeyA', ArrowRight: 'KeyD' };
/** rebase the floating origin when the car is this far from it (m) */
const REBASE_DISTANCE = 2000;
const COLLISION_RADIUS = 220;

export class ThreeWorld {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly frame: LocalFrame;
  readonly chase: ChaseCamera;
  readonly tiles: TileManager;
  readonly perf: PerfMonitor;
  readonly vehicle: VehicleController;
  private pose = new VehiclePose();
  private collisions = new BuildingCollisions();
  private collisionRevision = -1;
  private collisionAt: Position = [0, 0];
  private collisionTime = 0;
  private car: Car;
  private carRoot = new THREE.Group();
  private carToken = 0;
  private ground: THREE.Mesh;
  private groundMat: THREE.ShaderMaterial;
  private keys = new Set<string>();
  private raf = 0;
  private last = 0;
  private accumulator = 0;
  private hudTime = 0;
  private spawned = false;
  private status = 'Загружаем тайлы…';
  private disposed = false;
  private dragging = false;
  private cleanups: (() => void)[] = [];
  private resizeObserver: ResizeObserver;
  private disposables: { dispose(): void }[] = [];
  private carScene = new THREE.Vector3();
  private settings: ThreeWorldSettings;

  constructor(private host: HTMLElement, city: City, car: Car, settings: ThreeWorldSettings, private onHud: (hud: ThreeWorldHud) => void) {
    this.settings = { ...settings };
    this.car = car;
    this.frame = new LocalFrame(city.coords);
    this.vehicle = new VehicleController(city.coords, city.heading);
    this.pose.reset(this.vehicle);

    this.renderer = new THREE.WebGLRenderer({ antialias: settings.antialias, powerPreference: 'high-performance', stencil: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, settings.pixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.info.autoReset = true;
    this.renderer.domElement.className = 'three-world-canvas';
    host.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(SKY);
    this.chase = new ChaseCamera(1);

    const world = worldUniforms(SKY);
    world.uFogFar.value = settings.drawDistance;
    world.uFogNear.value = settings.drawDistance * 0.55;
    const mask = facadeMask();
    mask.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const textured = buildingMaterial(world, mask, true);
    const plain = buildingMaterial(world, mask, false);
    const windows = windowMaterial(world);
    const windowBase = windowGeometry();
    this.disposables.push(mask, textured, plain, windows, windowBase);
    this.tiles = new TileManager(this.scene, this.frame, { textured, plain, windows, windowBase }, { ...defaultTileOptions, drawDistance: settings.drawDistance });
    this.tiles.setWindowMode(settings.windowMode);

    this.groundMat = groundMaterial(world, GROUND);
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(8000, 8000).rotateX(-Math.PI / 2), this.groundMat);
    this.ground.frustumCulled = false;
    this.ground.renderOrder = -1;
    this.scene.add(this.ground);
    this.disposables.push(this.ground.geometry, this.groundMat);

    // lights only affect the GLB car (buildings use their own cheap shader)
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#b8b2a4', 1.6));
    const sun = new THREE.DirectionalLight('#fff4e0', 2.2);
    sun.position.set(30, 60, 20);
    this.scene.add(sun);

    this.scene.add(this.carRoot);
    this.setCar(car);

    this.perf = new PerfMonitor(this.renderer.getContext() as WebGL2RenderingContext);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.bindInput();
    this.raf = requestAnimationFrame(this.tick);
    (window as unknown as { __threeWorld?: ThreeWorld }).__threeWorld = this;
  }

  setCar(car: Car) {
    this.car = car;
    const token = ++this.carToken;
    this.carRoot.clear();
    this.carRoot.add(placeholderCar(car.color));
    loadCarModel(car).then((model) => {
      if (token !== this.carToken || this.disposed) return;
      this.carRoot.clear();
      this.carRoot.add(model);
    }).catch((error) => console.warn('[three-world] car model failed', error));
  }

  applySettings(next: ThreeWorldSettings) {
    this.settings = { ...next };
    this.tiles.setWindowMode(next.windowMode);
    this.tiles.options.drawDistance = next.drawDistance;
    const mats = [this.groundMat];
    for (const m of mats) {
      m.uniforms.uFogFar.value = next.drawDistance;
      m.uniforms.uFogNear.value = next.drawDistance * 0.55;
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, next.pixelRatio));
    this.resize();
  }

  /** Uncapped frame cost of the current view (see perf/PerfMonitor). */
  runBenchmark(frames = 90): BenchResult {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    return benchmark(gl, () => this.renderer.render(this.scene, this.chase.camera), frames);
  }

  private resize() {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(width, height, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.chase.resize(width / height);
  }

  private bindInput() {
    const listen = (target: EventTarget, type: string, fn: EventListener, options?: AddEventListenerOptions) => {
      target.addEventListener(type, fn, options);
      this.cleanups.push(() => target.removeEventListener(type, fn, options));
    };
    const canvas = this.renderer.domElement;
    listen(window, 'keydown', ((e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (DRIVE_KEYS.includes(e.code)) {
        e.preventDefault();
        this.keys.add(ARROWS[e.code] ?? e.code);
      }
      if (e.code === 'KeyR') this.chase.reset();
    }) as EventListener);
    listen(window, 'keyup', ((e: KeyboardEvent) => { this.keys.delete(ARROWS[e.code] ?? e.code); }) as EventListener);
    listen(window, 'blur', () => this.keys.clear());
    listen(canvas, 'contextmenu', (e) => e.preventDefault());
    listen(canvas, 'pointerdown', ((e: PointerEvent) => {
      if (e.button === 2 || e.button === 0) { this.dragging = true; canvas.setPointerCapture(e.pointerId); }
    }) as EventListener);
    listen(window, 'pointerup', () => { this.dragging = false; });
    listen(window, 'pointermove', ((e: PointerEvent) => {
      if (this.dragging) this.chase.drag(e.movementX, e.movementY);
    }) as EventListener);
    listen(canvas, 'wheel', ((e: WheelEvent) => {
      e.preventDefault();
      this.chase.zoom(e.deltaY);
    }) as EventListener, { passive: false });
  }

  private refreshCollisions(now: number) {
    const moved = Math.hypot(
      (this.vehicle.position[0] - this.collisionAt[0]) * 111319.49 * Math.cos(this.vehicle.position[1] * Math.PI / 180),
      (this.vehicle.position[1] - this.collisionAt[1]) * 111319.49,
    );
    if (this.collisionRevision === this.tiles.revision && moved < 60) return;
    if (now - this.collisionTime < 200 && this.collisionRevision === this.tiles.revision) return;
    this.collisionRevision = this.tiles.revision;
    this.collisionAt = [...this.vehicle.position];
    this.collisionTime = now;
    this.collisions.update(this.vehicle.position, this.tiles.footprintsNear(this.vehicle.position, COLLISION_RADIUS));
  }

  /** Move the car off a building footprint once the start tile is in. */
  private trySpawn(now: number) {
    if (this.spawned || !this.tiles.readyAt(this.vehicle.position)) return;
    this.refreshCollisions(now);
    const start = this.vehicle.position;
    const free = (p: Position) => !this.collisions.blocked(p, p, this.vehicle.heading);
    let spot: Position | null = free(start) ? start : null;
    const cos = Math.cos(start[1] * Math.PI / 180);
    for (let radius = 4; !spot && radius <= 160; radius += 4) {
      for (let a = 0; a < 16 && !spot; a++) {
        const angle = a / 16 * Math.PI * 2;
        const p: Position = [start[0] + Math.sin(angle) * radius / (111319.49 * cos), start[1] + Math.cos(angle) * radius / 111319.49];
        if (free(p)) spot = p;
      }
    }
    this.vehicle.position = spot ?? start;
    this.pose.reset(this.vehicle);
    this.spawned = true;
    this.status = 'Поехали · WASD, Space ускорение, Shift ручник, ПКМ/ЛКМ камера, колесо зум';
    this.collisionRevision = -1;
  }

  private step(dt: number, now: number) {
    if (!this.spawned) return;
    this.accumulator += dt;
    while (this.accumulator >= 1 / 60) {
      this.accumulator -= 1 / 60;
      this.pose.capture(this.vehicle);
      const previous: Position = [...this.vehicle.position];
      const heading = this.vehicle.heading;
      this.vehicle.step(1 / 60, this.keys, { ...vehicleConfig, acceleration: this.car.acceleration, maxSpeed: this.car.maxSpeed });
      const hit = this.collisions.resolve(previous, this.vehicle.position, this.vehicle.heading);
      if (hit.stopped) {
        this.vehicle.position = hit.position;
        this.vehicle.heading = heading;
        this.vehicle.speed = 0;
      } else if (hit.slid) {
        this.vehicle.position = hit.position;
        this.vehicle.speed *= 0.82;
      }
    }
    this.pose.update(this.vehicle, this.accumulator * 60);
    this.refreshCollisions(now);
  }

  private rebaseIfFar() {
    const p = this.frame.fromLngLat(this.pose.position);
    if (Math.hypot(p.x, p.z) < REBASE_DISTANCE) return;
    const before = this.frame.fromLngLat(this.pose.position);
    this.frame.reset(this.pose.position);
    this.tiles.rebase();
    // car is now at the origin; shift the camera smoothing by the same amount
    this.chase.shift(-before.x, -before.z);
  }

  private tick = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.tick);
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.1) : 0;
    this.last = now;
    const cpuStart = performance.now();

    this.trySpawn(now);
    if (!document.hidden) this.step(dt, now);
    this.rebaseIfFar();

    const p = this.frame.fromLngLat(this.pose.position);
    this.carScene.set(p.x, 0, p.z);
    this.carRoot.position.copy(this.carScene);
    // heading is clockwise from north; three rotates counter-clockwise around +Y
    this.carRoot.rotation.y = -this.pose.heading + Math.PI;
    this.chase.update(dt, this.carScene, this.pose.heading, this.vehicle.speed);

    // stream ahead of the car so tiles arrive before they are visible
    const lead = Math.min(400, Math.abs(this.vehicle.speed) * 6) * Math.sign(this.vehicle.speed || 0);
    const cos = Math.cos(this.pose.position[1] * Math.PI / 180);
    const focus: LngLat = [
      this.pose.position[0] + Math.sin(this.pose.heading) * lead / (111319.49 * cos),
      this.pose.position[1] + Math.cos(this.pose.heading) * lead / 111319.49,
    ];
    this.tiles.update(focus, this.chase.camera.position);

    const cam = this.chase.camera.position;
    this.ground.position.set(Math.round(cam.x / 50) * 50, 0, Math.round(cam.z / 50) * 50);
    const s = this.frame.scale;
    this.groundMat.uniforms.uGridOffset.value.set((this.frame.originX * s) % 50, (-this.frame.originY * s) % 50);

    this.perf.beginGpu();
    this.renderer.render(this.scene, this.chase.camera);
    this.perf.endGpu();
    this.perf.reportCpu(performance.now() - cpuStart);

    if (now - this.hudTime > 250) {
      this.hudTime = now;
      this.onHud({
        speedKmh: Math.abs(this.vehicle.speed) * 3.6,
        position: [...this.pose.position],
        perf: this.perf.latest,
        tiles: this.tiles.stats(),
        status: this.status,
        ready: this.spawned,
      });
    }
  };

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    for (const fn of this.cleanups) fn();
    this.resizeObserver.disconnect();
    this.perf.dispose();
    this.tiles.dispose();
    for (const d of this.disposables) d.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    const w = window as unknown as { __threeWorld?: ThreeWorld };
    if (w.__threeWorld === this) delete w.__threeWorld;
  }
}
