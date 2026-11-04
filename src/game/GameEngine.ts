import { roadStart } from './roadStart';
import { VehiclePose } from './VehiclePose';
import { supportAltitude, type GroundSample } from './groundSupport';
import { vegetationLayer } from '@/rendering/VegetationLayer';
import { BuildingCollisions, type Polygon } from './BuildingCollisions';
import { ThicketCollision } from './Vegetation';
import { WaterCollisionController, type MapFeature } from './WaterCollisionController';
import * as maplibregl from 'maplibre-gl';
import type { Map as LibreMap } from 'maplibre-gl';
import { mapConfig, cars as carsConfig, type City, type Car, vehicleConfig } from '@/config/vehicle.config';
import { cameraConfig, zoomForDistance } from '@/config/camera.config';
import { HOUSE_PALETTE } from './buildings/BuildingStyles';
import { VehicleController, offsetPosition, resolveVehicleCollision } from './VehicleController';
import { vehicleLayer, type VehicleSceneLayer } from '@/rendering/VehicleLayer';
import { cityLayer, type BuildingPart } from '@/rendering/CityBuildings';
import type { ArchitectureSetting, BuildingDetail } from './buildings/BuildingStyles';
import { collapseCopies, footprintKey, keepVisibleParts, retainNearParts } from './buildings/wallOverlap';
import { advanceTrafficBot, createTrafficBot, TrafficRoadNetwork, type TrafficBot } from './TrafficBots';
import { healthColor } from './health';
import { formatNumber, t } from '@/i18n';
import { ThreeMap, ThreeMarker } from '@/world3d/map/ThreeMap';
import { atStation, EVACUATION_COST, EVACUATION_RESERVE, FuelTank, metersBetween, nearestStation, stationsFromFeatures, type Station } from './Fuel';
import { fuelStationsLayer } from '@/rendering/FuelStationsLayer';
import { hubAt, hubsFromFeatures, nearestHub, ticketPrice, type Hub, type HubKind } from './Travel';

export type FuelHud = { level: number; tank: number; refuelling: boolean; station: number | null; money: number; hub: { kind: HubKind; distance: number } | null };
/** What a player takes along to another city (ticket, later: server handoff). */
export type PlayerCarry = { money: number; fuel: number };
export type TravelOffer = { kind: HubKind; from: [number, number]; money: number };
const NO_FUEL_KEYS = new Set(['KeyW', 'Space']);

/** Which map/renderer runs under the game. 'three' is our own world; 'maplibre' is the legacy one kept for comparison. */
export type RendererKind = 'three' | 'maplibre';
type MapMarker = {
  setLngLat(position: [number, number]): MapMarker;
  addTo(map: LibreMap): MapMarker;
  remove(): unknown;
  getElement(): HTMLElement;
};

export type Quality = 'low' | 'medium' | 'high';
export type Settings = {
  terrain: boolean;
  follow: boolean;
  sensitivity: number;
  quality: Quality;
  buildingDetail: BuildingDetail;
  architecture: ArchitectureSetting;
};

function roadColor(id: string) {
  const pedestrian = /path|pedestrian|foot|cycle/.test(id);
  const casing = /casing/.test(id);
  if (pedestrian) return casing ? '#d5d0c6' : '#c4c1ba';
  if (/motorway|trunk|primary/.test(id)) return casing ? '#d2cec5' : '#9d9e99';
  if (/secondary|tertiary/.test(id)) return casing ? '#d6d2c9' : '#aaaba5';
  return casing ? '#dbd7ce' : '#b5b5af';
}

const LABEL_LAYER = /^(highway-name-|water_name_|waterway_line_label)/;
const DRIVER_NAMES = ['Ines', 'Tiago', 'Marta', 'Rui', 'Leonor', 'Duarte', 'Beatriz', 'Nuno', 'Sofia', 'Miguel', 'Rafael', 'Ana'];
const PICKUP_COLORS = ['#ff4f79', '#ffc837', '#45d8ef', '#a96aff', '#69e286', '#ff8745'];
const TRAFFIC_MARKER_COLORS = ['#ff3b30', '#00e5ff', '#ffe600'];
const TERRAIN_EXAGGERATION = 0.12;
const METERS_PER_DEGREE = 111319.49;

export type HudParticipant = { id: string; name: string; color: string; hp: number; maxHp: number; money: number; wins: number };
type ActivePickup = { position: [number, number]; color: string };

function distanceMeters(a: [number, number], b: [number, number]) {
  const cos = Math.cos(a[1] * Math.PI / 180);
  return Math.hypot((b[0] - a[0]) * METERS_PER_DEGREE * cos, (b[1] - a[1]) * METERS_PER_DEGREE);
}

function randomDriverNames(count: number) {
  const names = [...DRIVER_NAMES];
  for (let index = names.length - 1; index > 0; index--) {
    const swap = Math.floor(Math.random() * (index + 1));
    [names[index], names[swap]] = [names[swap], names[index]];
  }
  return names.slice(0, count);
}

function hideBasemapBuildings(map: LibreMap) {
  const layers = map.getStyle()?.layers;
  if (!layers) return;
  for (const layer of layers) {
    // Keep the flat `building` fill alive (opacity 0). If it is layout-hidden,
    // MapLibre drops that source-layer from tiles and the city never builds.
    if (layer.type !== 'fill-extrusion' && layer.id !== 'building-3d') continue;
    if (!map.getLayer(layer.id)) continue;
    if (map.getLayoutProperty(layer.id, 'visibility') !== 'none') map.setLayoutProperty(layer.id, 'visibility', 'none');
  }
  if (map.getLayer('building')) {
    if (map.getLayoutProperty('building', 'visibility') === 'none') map.setLayoutProperty('building', 'visibility', 'visible');
    if (map.getPaintProperty('building', 'fill-opacity') !== 0) map.setPaintProperty('building', 'fill-opacity', 0);
  }
}

function paintCity(map: LibreMap, layer: { id: string; type: string }) {
  const labeled = LABEL_LAYER.test(layer.id);
  if (layer.type === 'fill-extrusion') map.removeLayer(layer.id);
  else if (layer.type === 'symbol' && labeled) {
    map.setLayoutProperty(layer.id, 'visibility', 'visible');
    map.setLayoutProperty(layer.id, 'text-size', ['interpolate', ['linear'], ['zoom'], 15, 13, 18, 16, 20.4, 20]);
    map.setLayoutProperty(layer.id, 'text-pitch-alignment', 'viewport');
    if (/^highway-name-/.test(layer.id)) map.setLayoutProperty(layer.id, 'symbol-spacing', 640);
    map.setPaintProperty(layer.id, 'text-color', '#24312e');
    map.setPaintProperty(layer.id, 'text-halo-color', '#f7f4ea');
    map.setPaintProperty(layer.id, 'text-halo-width', 1.8);
  }
  else if (layer.type === 'symbol') map.setLayoutProperty(layer.id, 'visibility', 'none');
  else if (layer.id === 'building') { map.setLayoutProperty(layer.id, 'visibility', 'visible'); map.setPaintProperty(layer.id, 'fill-opacity', 0); }
  else if (layer.type === 'background') map.setPaintProperty(layer.id, 'background-color', '#dcdad3');
  else if (layer.type === 'fill' && /park|grass|wood|farmland|pitch|cemetery/.test(layer.id)) map.setPaintProperty(layer.id, 'fill-color', /wood/.test(layer.id) ? '#69a577' : '#b1d59b');
  else if (layer.type === 'fill' && /residential/.test(layer.id)) map.setPaintProperty(layer.id, 'fill-color', '#e5e2da');
  else if (layer.type === 'fill' && /school|hospital/.test(layer.id)) map.setPaintProperty(layer.id, 'fill-color', '#f8dfda');
  else if (layer.type === 'fill' && /water/.test(layer.id)) map.setPaintProperty(layer.id, 'fill-color', '#52b8ca');
  else if (layer.type === 'line' && /waterway/.test(layer.id)) map.setPaintProperty(layer.id, 'line-color', '#369fb7');
  else if (layer.type === 'line' && /^(road|bridge|tunnel)_/.test(layer.id) && !/rail|hatch|one_way/.test(layer.id)) {
    map.setPaintProperty(layer.id, 'line-color', roadColor(layer.id));
    map.setLayoutProperty(layer.id, 'line-join', 'round');
    map.setLayoutProperty(layer.id, 'line-cap', 'round');
    const pedestrian = /path|pedestrian|foot|cycle/.test(layer.id);
    const major = /motorway|trunk|primary/.test(layer.id);
    const link = /link|service|track/.test(layer.id);
    const isCasing = /casing/.test(layer.id);
    // Same body width for minor/secondary/street so a continuous road doesn't
    // step/zigzag where the class changes between tiles or segments.
    const rank = pedestrian ? 0.5 : major ? 1.45 : link ? 0.82 : 1;
    const pavement = pedestrian ? 2.1 : 5;
    const width = (factor: number) => {
      const fill = rank * pavement * factor;
      if (!isCasing) return fill;
      // Fixed curb in screen px — growing with zoom made chunky "teeth" on edges.
      return fill + (pedestrian ? 2.2 : 3.2);
    };
    map.setPaintProperty(layer.id, 'line-width', [
      'interpolate', ['linear'], ['zoom'],
      13, width(0.7),
      16, width(2.1),
      18, width(5.4),
      20, width(17),
      20.85, width(24),
    ]);
  }
}

export class GameEngine {
  collisions = new BuildingCollisions();
  thicket = new ThicketCollision();
  water = new WaterCollisionController();
  collisionDirty = true;
  collisionTime = 0;
  spawnResolved = false;
  private spawnWaits = 0;
  sourceId = '';
  map: LibreMap;
  vehicle: VehicleController;
  renderVehicle = new VehiclePose();
  keys = new Set<string>();
  settings: Settings;
  driving = false;
  paused = false;
  altitude = 0;
  modelPitch = 0;
  modelRoll = 0;
  frame = 0;
  disposed = false;
  ready = false;
  distance = cameraConfig.distance;
  orbit = 0;
  pitch = cameraConfig.pitch;
  bearing = 0;
  last = 0;
  accumulator = 0;
  hudTime = 0;
  dragging = false;
  private introCameraKey = '';
  private spawnMarker: MapMarker | null = null;
  private defaultSpawn: { position: [number, number]; heading: number } | null = null;
  private customSpawn: { position: [number, number]; heading: number } | null = null;
  onSpawnSet: (position: [number, number] | null) => void = () => {};
  private host: HTMLElement;
  private mapShown = false;
  private bootAt = 0;
  private groundHits = 0;
  private lastGround: number | null = null;
  private settleFrames = 0;
  private approach = 0;
  private approachFrom: { lng: number; lat: number; zoom: number; pitch: number; bearing: number } | null = null;
  onApproach: (active: boolean) => void = () => {};
  onBoot: (ready: boolean) => void = () => {};
  message = '';
  cleanups: (() => void)[] = [];

  carScale = 1;
  car: Car;
  city: ReturnType<typeof cityLayer> | null = null;
  combatLayer: VehicleSceneLayer | null = null;
  vegetation: ReturnType<typeof vegetationLayer> | null = null;
  shownBuildings = new Set<string>();
  syncedAt: [number, number] | null = null;
  fps = 0;
  private fpsFrames = 0;
  private fpsStamp = 0;
  private worldFresh = false;
  private worldWork: Generator<null, void> | null = null;
  private greenedAt: [number, number] | null = null;
  private greenedTerrain: boolean | null = null;
  private remembered = new Map<string, { part: BuildingPart; measured: boolean }>();
  private retained = new Map<string, BuildingPart>();
  private featureReadFailures = new Set<string>();
  private cachedWater: MapFeature[] = [];
  private cachedRoads: MapFeature[] = [];
  private cachedLanduse: MapFeature[] = [];
  private cachedGreen: MapFeature[] = [];
  private tilesIngested = false;
  private focusTime = 0;
  private overlayTime = 0;
  private wheelSampleTime = 0;
  private wheelTargets = { altitude: 0, pitch: 0, roll: 0, ready: false };
  private region: string;
  private aimScreen: [number, number] | null = null;
  private trafficBots: TrafficBot[] = [];
  private trafficNetwork = new TrafficRoadNetwork();
  private vehicleContactTimes = new Map<string, number>();
  private trafficMarkerLayer: HTMLElement | null = null;
  private trafficMarkers = new Map<string, { element: HTMLElement; arrow: HTMLElement }>();
  private healthMarkerLayer: HTMLElement | null = null;
  private healthMarkers = new Map<string, { element: HTMLElement; fill: HTMLElement }>();
  private readonly cityName: string;
  private mode: 'roam' | 'arena' | 'race' = 'roam';
  private missions: { id: string; kind: 'arena' | 'race'; label: string; position: [number, number] }[] = [];
  private missionFocus = 0;
  private missionSeq = { arena: 0, race: 0 };
  private activeMissionId: string | null = null;
  private missionRespawnAt = 0;
  private lastCompletedKind: 'arena' | 'race' | null = null;
  private lastCompletedAt: [number, number] | null = null;
  private raceGoal: [number, number] | null = null;
  private eventOffer: 'arena' | 'race' | null = null;
  private eventCooldown = 0;
  private playerHp = 1000;
  private readonly playerMaxHp = 1000;
  private wins = new Map<string, number>();
  private missionMarkers = new Map<string, MapMarker>();
  private raceGoalMarker: MapMarker | null = null;
  private eventIndicatorLayer: HTMLElement | null = null;
  private focusIndicator: { element: HTMLElement; arrow: HTMLElement; title: HTMLElement; distance: HTMLElement } | null = null;
  private raceGoalIndicator: { element: HTMLElement; arrow: HTMLElement; distance: HTMLElement } | null = null;
  onEventOffer: (kind: 'arena' | 'race' | null) => void = () => {};
  /** fuel gauge data, ~10 times a second */
  onFuel: (fuel: FuelHud) => void = () => {};
  /** the tank ran dry and the car stopped: show the tow-truck dialog */
  onFuelOut: (out: boolean) => void = () => {};
  fuel!: FuelTank;
  private stations = new Map<string, Station>();
  private fuelLayer: ReturnType<typeof fuelStationsLayer> | null = null;
  private fuelOut = false;
  private refuelling = false;
  /** ports and airports: reaching one offers a ticket to any city */
  onTravelOffer: (offer: TravelOffer | null) => void = () => {};
  private hubs = new Map<string, Hub>();
  private hubMarkers = new Map<string, MapMarker>();
  private offeredHub: string | null = null;
  private travelOpen = false;
  private carry: PlayerCarry | null = null;
  get money() { return this.playerMoney; }
  private pickups = new Map<string, ActivePickup>();
  private collectedPickups = new Set<string>();
  private pickupFocus: [number, number] | null = null;
  private pickupNetworkRevision = -1;
  private playerMoney = 0;
  get booted() { return this.mapShown; }
  private aimingFire = false;
  readonly rendererKind: RendererKind;
  constructor(el: HTMLElement, city: City, car: Car, settings: Settings, private hud: (speed: number, distance: number, scale: number, fps: number, participants: HudParticipant[]) => void, private status: (s: string, toast?: boolean) => void, private aimHud: (x: number, y: number, visible: boolean, firing?: boolean) => void, renderer: RendererKind = 'three', carry: PlayerCarry | null = null) {
    this.rendererKind = renderer;
    this.fuel = new FuelTank(car.fuel);
    this.carry = carry;
    (window as unknown as { __cityRider?: GameEngine }).__cityRider = this; // console debugging
    this.host = el;
    el.style.opacity = '0';
    this.bootAt = performance.now();
    this.settings = settings;
    this.car = car;
    this.region = city.country;
    this.cityName = city.name;
    this.vehicle = new VehicleController(city.coords, city.heading);
    this.renderVehicle.reset(this.vehicle);
    this.bearing = city.heading;
    if (renderer === 'three') {
      // Our own world under the same API surface: no basemap restyling, no hidden
      // layers, one fixed DEM level, so buildings never need re-settling.
      this.map = new ThreeMap({
        container: el,
        center: city.coords,
        zoom: 16.8,
        pitch: 57,
        bearing: city.heading - 25,
        maxPitch: 80,
        dem: mapConfig.dem.tiles[0],
        region: city.country,
      }) as unknown as LibreMap;
    } else {
    maplibregl.setWorkerUrl('/vendor/maplibre-gl-worker.mjs');
    this.map = new maplibregl.Map({
      container: el,
      style: mapConfig.style,
      center: city.coords,
      zoom: 16.8,
      pitch: 57,
      bearing: city.heading - 25,
      interactive: false,
      maxPitch: 80,
      canvasContextAttributes: { antialias: true },
      attributionControl: { compact: true },
    });
    }
    this.map.on('styledata', () => hideBasemapBuildings(this.map));
    this.map.on('sourcedata', event => {
      if ((event.sourceId === this.sourceId || event.sourceId === 'elevation') && event.sourceDataType === 'content') {
        this.collisionDirty = true;
      }
    });
    this.map.on('error', () => this.say(t('status.mapError')));
    this.map.on('load', () => {
      if (this.disposed) return;
      this.decorate();
      this.map.addSource('elevation', { type: 'raster-dem', ...mapConfig.dem });
      // Keep map labels below custom 3D geometry so buildings can occlude them.
      // Our own world draws every building itself (one batched system, nothing
      // swaps in view). The detailed CityBuildings layer stays for MapLibre only.
      if (renderer === 'maplibre') {
        this.city = cityLayer(city.coords, parts => {
          this.collisions.update(this.vehicle.position, parts.map(part => part.rings));
        });
        this.map.addLayer(this.city);
      }
      // our world plants vegetation per tile in the worker (complete, never re-planted)
      if (renderer === 'maplibre') {
        this.vegetation = vegetationLayer(city.coords);
        this.map.addLayer(this.vegetation);
      }
      this.fuelLayer = fuelStationsLayer();
      this.map.addLayer(this.fuelLayer);
      this.combatLayer = vehicleLayer(
        car,
        this.renderVehicle,
        () => this.altitude,
        () => this.modelPitch,
        () => this.modelRoll,
        () => this.carScale,
        (text) => this.say(text),
        (cam, camAlt, ground, groundAlt, mark) => this.city
          ? this.city.shoot(cam, camAlt, ground, groundAlt, mark)
          : this.threeMap?.raycastBuildings(cam, camAlt, ground, groundAlt) ?? null,
        (point, altitude) => this.city?.markGround(point, altitude),
      );
      this.map.addLayer(this.combatLayer);
      this.applyLabelVisibility();
      this.applySettings(this.settings);
      this.ready = true;
      this.map.setCenterClampedToGround(false);
      this.collisionDirty = true;
      this.say(t('status.placing'));
      // Map click → set custom spawn
      this.map.on('click', (e) => {
        if (!this.driving && this.mapShown) this.setSpawnFromClick(e.lngLat);
      });
      this.map.on('move', () => {
        if (!this.driving && this.mapShown) this.collisionDirty = true;
      });
    });
    const listen = (target: EventTarget, event: string, fn: EventListener, options?: AddEventListenerOptions) => {
      target.addEventListener(event, fn, options);
      this.cleanups.push(() => target.removeEventListener(event, fn, options));
    };
    listen(window, 'keydown', ((e: KeyboardEvent) => {
      if (!this.driving || this.paused || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyR', 'KeyQ', 'KeyE', 'KeyL', 'Tab'].includes(e.code)) e.preventDefault();
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) this.keys.add(e.code);
      if (e.code === 'KeyR') this.resetCamera();
      if (e.code === 'KeyL' && !e.repeat) this.toggleLabels();
      if (e.code === 'KeyQ' && !e.repeat) this.resizeCar(1 / 1.4);
      if (e.code === 'KeyE' && !e.repeat) this.resizeCar(1.4);
      if (e.code === 'Tab' && !e.repeat) this.cycleMissionFocus();
    }) as EventListener);
    listen(window, 'keyup', ((e: KeyboardEvent) => { this.keys.delete(e.code); }) as EventListener);
    const clear = () => {
      this.keys.clear();
      this.vehicle.speed = 0;
      this.vehicle.throttle = 0;
      this.last = 0;
      this.accumulator = 0;
      this.renderVehicle.reset(this.vehicle);
      this.dragging = false;
      this.aimingFire = false;
      this.combatLayer?.setFiring(false);
    };
    listen(window, 'blur', clear);
    listen(document, 'visibilitychange', clear);
    listen(el, 'contextmenu', (e) => e.preventDefault());
    listen(el, 'pointerdown', ((e: PointerEvent) => {
      if (this.paused) return;
      if (e.button === 2 && this.driving) { this.dragging = true; el.setPointerCapture(e.pointerId); }
      if (e.button === 0 && this.driving && !this.approachFrom) {
        const bounds = el.getBoundingClientRect();
        this.aimScreen = [e.clientX - bounds.left, e.clientY - bounds.top];
        this.updateAim();
        this.aimingFire = true;
        this.aimHud(this.aimScreen[0], this.aimScreen[1], true, true);
        this.combatLayer?.setFiring(true);
      }
    }) as EventListener);
    listen(el, 'pointerup', () => { this.dragging = false; });
    listen(window, 'pointermove', ((e: PointerEvent) => {
      if (this.paused) return;
      if (this.driving && !this.approachFrom) {
        const bounds = this.host.getBoundingClientRect();
        const x = e.clientX - bounds.left;
        const y = e.clientY - bounds.top;
        this.aimScreen = [x, y];
        this.updateAim();
        this.aimHud(x, y, true, this.aimingFire);
      }
      if (this.dragging) {
        this.orbit += e.movementX * 0.22 * this.settings.sensitivity;
        this.pitch = Math.max(cameraConfig.minPitch, Math.min(cameraConfig.maxPitch, this.pitch - e.movementY * 0.12 * this.settings.sensitivity));
      }
    }) as EventListener);
    listen(el, 'pointerleave', () => {
      this.aimScreen = null;
      this.aimingFire = false;
      this.combatLayer?.setAim(null);
      this.aimHud(0, 0, false, false);
    });
    const stopFiring = () => {
      this.aimingFire = false;
      this.combatLayer?.setFiring(false);
      if (this.aimScreen) this.aimHud(this.aimScreen[0], this.aimScreen[1], true, false);
    };
    listen(window, 'pointerup', stopFiring);
    listen(window, 'pointercancel', stopFiring);
    listen(el, 'wheel', ((e: WheelEvent) => {
      if (!this.driving || this.paused) return;
      e.preventDefault();
      this.distance = Math.max(cameraConfig.minDistance, Math.min(cameraConfig.maxDistance, this.distance * Math.exp(e.deltaY * 0.001)));
    }) as EventListener, { passive: false });
    this.frame = requestAnimationFrame(this.tick);
  }

  /** Status line; `toast` marks event news worth a pop-up while driving. */
  say(text: string, toast = false) {
    if (this.message === text) return;
    this.message = text;
    this.status(text, toast);
  }

  private updateAim() {
    if (!this.aimScreen || !this.driving || this.approachFrom) {
      this.combatLayer?.setAim(null);
      return;
    }
    const target = this.map.unproject(this.aimScreen);
    this.combatLayer?.setAim({ ground: [target.lng, target.lat], screen: this.aimScreen });
  }

  decorate() {
    const style = this.map.getStyle();
    for (const layer of style.layers) paintCity(this.map, layer);
    hideBasemapBuildings(this.map);
    const source = Object.entries(style.sources).find(([, item]) => item.type === 'vector')?.[0];
    if (!source) return;
    this.sourceId = source;
  }

  labelsOn = true;

  applyLabelVisibility() {
    const visibility = this.labelsOn ? 'visible' : 'none';
    for (const layer of this.map.getStyle().layers) {
      if (LABEL_LAYER.test(layer.id) && this.map.getLayer(layer.id)) this.map.setLayoutProperty(layer.id, 'visibility', visibility);
    }
  }

  toggleLabels() {
    this.labelsOn = !this.labelsOn;
    this.applyLabelVisibility();
  }

  ensureHillshade() {
    if (this.map.getLayer('hillshade')) return;
    const before = this.map.getStyle().layers.find((layer) => layer.type === 'line' && /road|bridge/.test(layer.id))?.id;
    const layer = {
      id: 'hillshade',
      type: 'hillshade' as const,
      source: 'elevation',
      paint: {
        'hillshade-exaggeration': 0.22,
        'hillshade-shadow-color': '#66849b',
        'hillshade-highlight-color': '#fff7ec',
        'hillshade-accent-color': '#a8bfca',
        'hillshade-illumination-direction': 315,
      },
    };
    if (before) this.map.addLayer(layer, before);
    else this.map.addLayer(layer);
  }

  resizeCar(factor: number) {
    const previous = this.carScale;
    const next = previous * factor;
    this.carScale = Math.min(10, Math.max(1, next >= 9.5 ? 10 : next <= 1.08 ? 1 : next));
    this.vehicle.speed *= this.carScale / previous;
    this.hud(this.vehicle.speed * 3.6, this.vehicle.distance, this.carScale, this.fps, this.hudParticipants());
  }

  setCar(car: Car) {
    if (this.car.id === car.id && this.car.path === car.path) return;
    this.car = car;
    this.fuel.changeSpec(car.fuel);
    this.combatLayer?.setCar(car);
  }

  applySettings(settings: Settings) {
    const terrainChanged = settings.terrain !== this.settings.terrain;
    this.settings = settings;
    if (!this.map.getSource('elevation')) return;
    if (settings.terrain) {
      // our world shows real relief; MapLibre keeps its flattened look for comparison
      this.map.setTerrain({ source: 'elevation', exaggeration: this.rendererKind === 'three' ? 1 : TERRAIN_EXAGGERATION });
      this.ensureHillshade();
    } else {
      this.map.setTerrain(null);
      if (this.map.getLayer('hillshade')) this.map.removeLayer('hillshade');
    }
    hideBasemapBuildings(this.map);
    const ratio = settings.quality === 'low' ? 1 : settings.quality === 'medium' ? 1.25 : Math.min(window.devicePixelRatio || 1, 1.5);
    this.map.setPixelRatio(ratio);
    this.city?.configure({ detail: settings.buildingDetail, architecture: settings.architecture, region: this.region });
    if (terrainChanged) { this.collisionDirty = true; this.syncedAt = null; }
  }

  nudgeCamera(dt: number) {
    const yaw = Number(this.keys.has('ArrowRight')) - Number(this.keys.has('ArrowLeft'));
    if (yaw) this.orbit += yaw * dt * 75 * this.settings.sensitivity;
    const zoom = Number(this.keys.has('ArrowDown')) - Number(this.keys.has('ArrowUp'));
    if (!zoom) return;
    const next = this.distance * Math.exp(zoom * dt * 0.9 * this.settings.sensitivity);
    this.distance = Math.max(cameraConfig.minDistance, Math.min(cameraConfig.maxDistance, next));
  }

  resetCamera() {
    this.orbit = 0;
    this.distance = cameraConfig.distance;
    this.pitch = cameraConfig.pitch;
  }

  setSpawnFromClick(lngLat: { lng: number; lat: number }) {
    if (!this.sourceId) return;
    const origin: [number, number] = [lngLat.lng, lngLat.lat];
    const start = roadStart(this.map, this.sourceId, origin, (position, heading) => this.collisions.blocked(position, position, heading, this.carScale));
    const position: [number, number] = start ? start.position : origin;
    const heading = start ? start.heading : this.vehicle.heading;
    this.customSpawn = { position, heading };
    this.vehicle.position = [...position];
    this.vehicle.heading = heading;
    this.bearing = heading * 180 / Math.PI;
    this.renderVehicle.reset(this.vehicle);
    this.setTargetVehicles(position, heading);
    this.collisionDirty = true;
    if (this.settings.terrain) {
      const ground = this.map.queryTerrainElevation(position);
      if (ground != null) this.altitude = ground;
    }
    this.placeSpawnMarker(position);
    this.onSpawnSet(position);
  }

  private setTargetVehicles(position: [number, number], heading: number) {
    this.mode = 'roam';
    this.eventOffer = null;
    this.eventCooldown = 0;
    this.raceGoal = null;
    this.playerHp = this.playerMaxHp;
    this.wins.clear();
    this.clearEventBots();
    this.pickups.clear();
    this.combatLayer?.setPickups([]);
    this.collectedPickups.clear();
    this.pickupFocus = null;
    this.pickupNetworkRevision = -1;
    this.playerMoney = this.carry?.money ?? 0;
    this.fuel.level = this.fuel.spec.tank * (this.carry?.fuel ?? 1);
    this.carry = null;
    this.fuelOut = false;
    this.onFuelOut(false);
    const roads = this.map.querySourceFeatures(this.sourceId, { sourceLayer: 'transportation' }) as MapFeature[];
    this.trafficNetwork.addFeatures(roads);
    this.trafficNetwork.flushRebuild();
    this.vehicleContactTimes.clear();
    this.placeEventBeacons(position, heading);
    this.ensureTrafficMarkers();
    this.ensureHealthMarkers();
    this.combatLayer?.setTargets([]);
    this.combatLayer?.setRaceFinish(null);
    this.syncRoadPickups();
    this.onEventOffer(null);
  }

  private clearEventBots() {
    this.trafficBots = [];
    this.combatLayer?.setTargets([]);
    this.ensureTrafficMarkers();
    this.ensureHealthMarkers();
  }

  private pickBeaconSpot(
    position: [number, number],
    heading: number,
    seed: number,
    avoid: [number, number][],
    band: { min: number; max: number } = { min: 220, max: 1100 },
  ): [number, number] {
    for (let attempt = 0; attempt < 16; attempt++) {
      const min = band.min + (attempt % 4) * 40;
      const max = band.max + (attempt % 5) * 80;
      const node = this.trafficNetwork.randomAway(position, new Set(), min, max, seed + attempt * 97)
        ?? this.trafficNetwork.randomAway(position, new Set(), Math.max(120, min * 0.6), max * 1.25, seed + attempt * 97 + 13);
      if (!node) continue;
      const spot = [...node.position] as [number, number];
      if (avoid.some(other => distanceMeters(spot, other) < 280)) continue;
      return spot;
    }
    const ahead = this.trafficNetwork.destinationAhead(position, heading, seed);
    if (ahead && !avoid.some(other => distanceMeters(ahead as [number, number], other) < 220)) return [...ahead] as [number, number];
    const side = seed & 1 ? 1 : -1;
    return offsetPosition(position, Math.sin(heading + side) * (420 + (seed % 260)), Math.cos(heading + side) * (420 + (seed % 260))) as [number, number];
  }

  private nextMissionLabel(kind: 'arena' | 'race') {
    this.missionSeq[kind] += 1;
    return kind === 'arena' ? t('mission.arena', { n: this.missionSeq[kind] }) : t('mission.race', { n: this.missionSeq[kind] });
  }

  private createMission(
    kind: 'arena' | 'race',
    position: [number, number],
    heading: number,
    seed: number,
    band?: { min: number; max: number },
  ) {
    const avoid = [
      ...this.missions.map(mission => mission.position),
      ...(this.lastCompletedAt ? [this.lastCompletedAt] : []),
    ];
    const spot = this.pickBeaconSpot(position, heading, seed, avoid, band);
    const id = `${kind}-${this.missionSeq[kind] + 1}-${seed & 0xffff}`;
    const label = this.nextMissionLabel(kind);
    return { id, kind, label, position: spot };
  }

  private syncMissionVisuals(showWorld = this.mode === 'roam') {
    const visible = showWorld ? this.missions : [];
    this.combatLayer?.setMissionBeacons(visible.map(mission => ({
      id: mission.id,
      kind: mission.kind,
      position: mission.position,
    })));
    this.ensureEventMarkers();
  }

  private placeEventBeacons(position: [number, number], heading: number) {
    for (const marker of this.missionMarkers.values()) marker.remove();
    this.missionMarkers.clear();
    this.missions = [];
    this.missionSeq = { arena: 0, race: 0 };
    this.missionFocus = 0;
    this.activeMissionId = null;
    this.missionRespawnAt = 0;
    this.lastCompletedKind = null;
    this.lastCompletedAt = null;
    const seed = Math.round(position[0] * 1e5) ^ Math.round(position[1] * 1e5) ^ 42011;
    const kinds: Array<'arena' | 'race'> = ['race', 'race', 'arena'];
    for (let index = 0; index < 3; index++) {
      this.missions.push(this.createMission(kinds[index], position, heading, seed + index * 1301));
    }
    this.syncMissionVisuals(true);
  }

  private cycleMissionFocus() {
    if (!this.driving || this.mode !== 'roam' || this.missions.length < 2) return;
    this.missionFocus = (this.missionFocus + 1) % this.missions.length;
    const mission = this.missions[this.missionFocus];
    if (mission) this.say(t('mission.target', { label: mission.label }), true);
  }

  private completeActiveMission() {
    if (this.activeMissionId) {
      const index = this.missions.findIndex(mission => mission.id === this.activeMissionId);
      if (index >= 0) {
        const done = this.missions[index];
        this.lastCompletedKind = done.kind;
        this.lastCompletedAt = [...done.position] as [number, number];
        const marker = this.missionMarkers.get(done.id);
        marker?.remove();
        this.missionMarkers.delete(done.id);
        this.missions.splice(index, 1);
        if (this.missionFocus >= this.missions.length) this.missionFocus = Math.max(0, this.missions.length - 1);
      }
      this.activeMissionId = null;
    }
    this.missionRespawnAt = performance.now() + 30000;
    this.syncMissionVisuals(true);
  }

  private refillMissions() {
    if (this.mode !== 'roam' || this.missions.length >= 3) return;
    if (!this.missionRespawnAt || performance.now() < this.missionRespawnAt) return;
    const center = this.vehicle.position as [number, number];
    const heading = this.vehicle.heading;
    const seed = Math.round(center[0] * 1e5) ^ Math.round(center[1] * 1e5) ^ (performance.now() | 0);
    const races = this.missions.filter(mission => mission.kind === 'race').length;
    const arenas = this.missions.filter(mission => mission.kind === 'arena').length;
    // Prefer the other type than the one just finished, and keep a mix on the map.
    let kind: 'arena' | 'race' = this.lastCompletedKind === 'race' ? 'arena' : 'race';
    if (kind === 'race' && races >= 2) kind = 'arena';
    if (kind === 'arena' && arenas >= 2) kind = 'race';
    this.missions.push(this.createMission(kind, center, heading, seed ^ 0x9e37, { min: 450, max: 1400 }));
    this.missionRespawnAt = this.missions.length >= 3 ? 0 : performance.now() + 30000;
    this.syncMissionVisuals(true);
    const added = this.missions[this.missions.length - 1];
    this.say(t('mission.new', { label: added.label }), true);
  }

  private targetVehicles() {
    return this.trafficBots.map(({ id, driver, car, position, heading }) => ({
      id, driver, car, position, heading,
    }));
  }

  private resolveVehicleContacts(now: number) {
    const participants = [
      { id: 'player', controller: this.vehicle, car: this.car },
      ...this.trafficBots
        .filter(bot => !this.combatLayer || this.combatLayer.isTargetAlive(bot.id))
        .map(bot => ({ id: bot.id, controller: bot.controller, car: bot.car })),
    ];
    const applyPosition = (participant: typeof participants[number], next: [number, number]) => {
      const { controller } = participant;
      if (next === controller.position
        || this.collisions.blocked(controller.position, next, controller.heading, this.carScale)
        || this.thicket.blocked(controller.position, next)) return;
      const water = this.water.resolve(controller.position, next, controller.heading, this.carScale);
      if (!water.stopped) controller.position = water.position;
    };

    for (let first = 0; first < participants.length; first++) {
      const a = participants[first];
      for (let second = first + 1; second < participants.length; second++) {
        const b = participants[second];
        const collision = resolveVehicleCollision({
          position: a.controller.position,
          heading: a.controller.heading,
          speed: a.controller.speed,
          length: a.car.length,
        }, {
          position: b.controller.position,
          heading: b.controller.heading,
          speed: b.controller.speed,
          length: b.car.length,
        }, this.carScale);
        if (!collision) continue;

        applyPosition(a, collision.a);
        applyPosition(b, collision.b);
        const key = `${a.id}:${b.id}`;
        if (now - (this.vehicleContactTimes.get(key) ?? 0) < 280) continue;
        this.vehicleContactTimes.set(key, now);
        const flash = (participant: typeof a) => {
          if (participant.id === 'player') this.combatLayer?.flashPlayer(180);
          else this.combatLayer?.flashTarget(participant.id, 180);
        };
        if (collision.slower === 'a' || collision.slower === 'both') flash(a);
        if (collision.slower === 'b' || collision.slower === 'both') flash(b);
        const impact = Math.abs(a.controller.speed) + Math.abs(b.controller.speed);
        if (impact > 6) {
          const ramDamage = Math.min(55, 12 + impact * 2.2);
          const hunterHits = (attackerId: string, victimId: string) => {
            const hunter = this.trafficBots.find(bot => bot.id === attackerId);
            if (!hunter || hunter.mood !== 'hunt') return;
            if (victimId === 'player') this.damagePlayer(ramDamage);
            else this.combatLayer?.damageTarget(victimId, ramDamage);
          };
          hunterHits(a.id, b.id);
          hunterHits(b.id, a.id);
        }
      }
    }

    for (const bot of this.trafficBots) {
      bot.position = [...bot.controller.position];
      bot.heading = bot.controller.heading;
    }
  }

  private hudParticipants(): HudParticipant[] {
    const targetHealth = new Map((this.combatLayer?.targetHealth() ?? []).map(target => [target.id, target]));
    return [
      {
        id: 'player',
        name: t('you'),
        color: '#111111',
        hp: this.playerHp,
        maxHp: this.playerMaxHp,
        money: Math.floor(this.playerMoney),
        wins: this.wins.get('player') ?? 0,
      },
      ...this.trafficBots.map((bot, index) => {
        const target = targetHealth.get(bot.id);
        const dead = Boolean(target && target.hp <= 0);
        return {
          id: bot.id,
          name: bot.driver,
          color: dead ? '#8b9198' : TRAFFIC_MARKER_COLORS[index % TRAFFIC_MARKER_COLORS.length],
          hp: target?.hp ?? 1000,
          maxHp: target?.maxHp ?? 1000,
          money: bot.money,
          wins: this.wins.get(bot.id) ?? 0,
        };
      }),
    ];
  }

  private addWin(id: string) {
    this.wins.set(id, (this.wins.get(id) ?? 0) + 1);
  }

  private damagePlayer(amount: number) {
    if (this.mode !== 'arena' || amount <= 0 || this.playerHp <= 0) return;
    this.playerHp = Math.max(0, this.playerHp - amount);
    this.combatLayer?.flashPlayer(220);
  }

  acceptEvent() {
    if (this.mode !== 'roam' || !this.driving || !this.eventOffer) return;
    const kind = this.eventOffer;
    const nearby = this.missions.find(mission => mission.kind === kind && distanceMeters(this.vehicle.position, mission.position) <= 18)
      ?? this.missions.find(mission => mission.kind === kind)
      ?? null;
    this.activeMissionId = nearby?.id ?? null;
    this.eventOffer = null;
    this.onEventOffer(null);
    if (kind === 'arena') this.startArena();
    else this.startRace();
  }

  declineEvent() {
    this.eventOffer = null;
    this.activeMissionId = null;
    this.eventCooldown = performance.now() + 14000;
    this.onEventOffer(null);
  }

  private hideEventBeacons() {
    this.syncMissionVisuals(false);
    if (this.focusIndicator) this.focusIndicator.element.style.display = 'none';
  }

  private showEventBeacons() {
    this.syncMissionVisuals(true);
  }

  private startArena() {
    const center = this.vehicle.position as [number, number];
    const heading = this.vehicle.heading;
    const usedStarts = new Set<string>();
    const driverNames = randomDriverNames(3);
    const seedBase = Math.round(center[0] * 1e5) ^ Math.round(center[1] * 1e5) ^ (performance.now() | 0);
    this.trafficBots = Array.from({ length: 3 }, (_, index) => createTrafficBot(
      `arena-${index}`,
      driverNames[index],
      carsConfig[(index + 1) % carsConfig.length],
      this.trafficNetwork,
      center,
      heading + (index - 1) * 0.8,
      usedStarts,
      'hunt',
      seedBase ^ (index * 7919),
      { min: 80, max: 1000 },
    ));
    this.mode = 'arena';
    this.playerHp = this.playerMaxHp;
    this.vehicleContactTimes.clear();
    this.hideEventBeacons();
    this.ensureTrafficMarkers();
    this.ensureHealthMarkers();
    this.combatLayer?.setTargets(this.targetVehicles());
    this.say(t('arena.start'), true);
  }

  private startRace() {
    const center = this.vehicle.position as [number, number];
    const heading = this.vehicle.heading;
    const seedBase = Math.round(center[0] * 1e5) ^ Math.round(center[1] * 1e5) ^ (performance.now() | 0);
    const finishSpot = this.trafficNetwork.randomAway(center, new Set(), 4200, 5800, seedBase)
      ?? this.trafficNetwork.randomAway(center, new Set(), 2800, 6500, seedBase + 41);
    const finishAhead = finishSpot ? null : this.trafficNetwork.destinationAhead(center, heading, seedBase);
    if (!finishSpot && !finishAhead) {
      this.say(t('race.unavailable'), true);
      this.eventCooldown = performance.now() + 8000;
      return;
    }
    this.raceGoal = finishSpot
      ? [...finishSpot.position] as [number, number]
      : [...finishAhead!] as [number, number];
    const usedStarts = new Set<string>();
    const driverNames = randomDriverNames(3);
    this.trafficBots = Array.from({ length: 3 }, (_, index) => {
      const bot = createTrafficBot(
        `race-${index}`,
        driverNames[index],
        carsConfig[(index + 1) % carsConfig.length],
        this.trafficNetwork,
        center,
        heading + (index - 1) * 0.55,
        usedStarts,
        'explore',
        seedBase ^ (index * 5443),
        { min: 18, max: 90 },
      );
      bot.goal = [...this.raceGoal!];
      bot.route = [];
      bot.routeIndex = 1;
      bot.lastRouteRevision = -1;
      return bot;
    });
    this.mode = 'race';
    this.vehicleContactTimes.clear();
    this.hideEventBeacons();
    this.combatLayer?.setRaceFinish(this.raceGoal);
    this.ensureRaceGoalMarker();
    this.ensureTrafficMarkers();
    this.ensureHealthMarkers();
    this.combatLayer?.setTargets(this.targetVehicles());
    this.say(t('race.start'), true);
  }

  private endArena(won: boolean) {
    if (this.mode !== 'arena') return;
    this.mode = 'roam';
    this.eventCooldown = performance.now() + 8000;
    if (won) {
      this.playerMoney += 10000;
      this.addWin('player');
      this.say(t('arena.won'), true);
    } else {
      this.playerMoney = Math.max(0, this.playerMoney - 10000);
      this.say(t('arena.lost'), true);
    }
    this.playerHp = this.playerMaxHp;
    this.clearEventBots();
    this.completeActiveMission();
    this.showEventBeacons();
  }

  private endRace(winnerId: string, winnerName: string) {
    if (this.mode !== 'race') return;
    this.mode = 'roam';
    this.eventCooldown = performance.now() + 8000;
    if (winnerId === 'player') {
      this.playerMoney += 10000;
      this.addWin('player');
      this.say(t('race.won'), true);
    } else {
      const bot = this.trafficBots.find(entry => entry.id === winnerId);
      if (bot) bot.money += 10000;
      this.addWin(winnerId);
      this.say(t('race.lost', { name: winnerName }), true);
    }
    this.raceGoal = null;
    this.combatLayer?.setRaceFinish(null);
    if (this.raceGoalMarker) {
      const el = this.raceGoalMarker.getElement();
      if (el) el.style.display = 'none';
    }
    if (this.raceGoalIndicator) this.raceGoalIndicator.element.style.display = 'none';
    this.clearEventBots();
    this.completeActiveMission();
    this.showEventBeacons();
  }

  private ensureHealthMarkers() {
    if (!this.healthMarkerLayer) {
      this.healthMarkerLayer = document.createElement('div');
      this.healthMarkerLayer.className = 'overhead-health-indicators';
      this.healthMarkerLayer.style.position = 'absolute';
      this.healthMarkerLayer.style.inset = '0';
      this.healthMarkerLayer.style.zIndex = '6';
      this.healthMarkerLayer.style.pointerEvents = 'none';
      this.healthMarkerLayer.style.overflow = 'hidden';
      this.host.appendChild(this.healthMarkerLayer);
    }

    const participants = this.hudParticipants();
    const active = new Set(participants.map(participant => participant.id));
    for (const [id, marker] of this.healthMarkers) {
      if (active.has(id)) continue;
      marker.element.remove();
      this.healthMarkers.delete(id);
    }

    for (const participant of participants) {
      if (this.healthMarkers.has(participant.id)) continue;
      const element = document.createElement('div');
      element.className = 'overhead-health-meter';
      element.setAttribute('role', 'meter');
      element.setAttribute('aria-label', t('health.label', { name: participant.name }));
      element.style.position = 'absolute';
      element.style.display = 'none';
      element.style.width = '48px';
      element.style.height = '7px';
      element.style.transform = 'translate(-50%, -50%)';
      element.style.overflow = 'hidden';
      element.style.border = '1px solid #f7f7ef';
      element.style.borderRadius = '4px';
      element.style.backgroundColor = '#1a2228d9';
      element.style.boxShadow = '0 1px 5px #000b';
      const fill = document.createElement('span');
      fill.style.display = 'block';
      fill.style.height = '100%';
      fill.style.transition = 'width .12s';
      element.appendChild(fill);
      this.healthMarkerLayer.appendChild(element);
      this.healthMarkers.set(participant.id, { element, fill });
    }
  }

  private updateHealthMarkers(updateMeters = true) {
    for (const marker of this.healthMarkers.values()) marker.element.style.display = 'none';
    if (!this.driving) return;

    const canvas = this.map.getCanvas();
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;

    const participants = this.hudParticipants();
    for (const participant of participants) {
      const marker = this.healthMarkers.get(participant.id);
      if (!marker) continue;
      if (participant.id !== 'player' && !this.combatLayer?.isTargetAlive(participant.id)) continue;
      const position = participant.id === 'player'
        ? this.renderVehicle.position
        : this.trafficBots.find(bot => bot.id === participant.id)?.position;
      if (!position) continue;

      const point = this.map.project(position);
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)
        || point.x < 0 || point.x > width || point.y < 0 || point.y > height) continue;

      if (updateMeters) {
        const color = healthColor(participant.hp, participant.maxHp);
        marker.element.className = `overhead-health-meter ${color}`;
        marker.element.setAttribute('aria-valuenow', String(participant.hp));
        marker.element.setAttribute('aria-valuemin', '0');
        marker.element.setAttribute('aria-valuemax', String(participant.maxHp));
        marker.fill.style.width = `${Math.max(0, Math.min(1, participant.hp / participant.maxHp)) * 100}%`;
        marker.fill.style.backgroundColor = color === 'green' ? '#25e35b' : color === 'yellow' ? '#ffe000' : '#ff3030';
      }
      marker.element.style.left = `${point.x}px`;
      marker.element.style.top = `${point.y - 52}px`;
      marker.element.style.display = 'block';
    }
  }

  private syncRoadPickups() {
    const position = this.vehicle.position;
    if (this.pickupNetworkRevision === this.trafficNetwork.revision
      && this.pickupFocus
      && distanceMeters(this.pickupFocus, position) < 120) return;

    for (const [id, pickup] of this.pickups) {
      if (distanceMeters(position, pickup.position) <= 800) continue;
      this.pickups.delete(id);
    }

    for (const pickup of this.trafficNetwork.pickupLocations(position)) {
      if (this.pickups.has(pickup.id) || this.collectedPickups.has(pickup.id)) continue;
      let hash = 0;
      for (const character of pickup.id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
      this.pickups.set(pickup.id, {
        position: pickup.position,
        color: PICKUP_COLORS[hash % PICKUP_COLORS.length],
      });
    }
    this.pickupFocus = [...position];
    this.pickupNetworkRevision = this.trafficNetwork.revision;
    this.combatLayer?.setPickups(this.pickupVisuals());
  }

  private pickupVisuals() {
    return [...this.pickups].map(([id, pickup]) => ({
      id,
      position: pickup.position,
      color: pickup.color,
    }));
  }

  private collectRoadPickups() {
    const collect = (position: [number, number]) => {
      let money = 0;
      for (const [id, pickup] of this.pickups) {
        if (distanceMeters(position, pickup.position) > 3.5) continue;
        this.pickups.delete(id);
        this.collectedPickups.add(id);
        money += 100;
      }
      return money;
    };
    const playerMoney = collect(this.vehicle.position);
    this.playerMoney += playerMoney;
    let totalMoney = playerMoney;
    for (const bot of this.trafficBots) {
      const money = collect(bot.position);
      bot.money += money;
      totalMoney += money;
    }
    if (totalMoney) this.combatLayer?.setPickups(this.pickupVisuals());
  }

  private ensureTrafficMarkers() {
    if (!this.trafficMarkerLayer) {
      this.trafficMarkerLayer = document.createElement('div');
      this.trafficMarkerLayer.className = 'traffic-indicators';
      this.host.appendChild(this.trafficMarkerLayer);
    }
    const markerLayer = this.trafficMarkerLayer;
    const active = new Set(this.trafficBots.map(bot => bot.id));
    for (const [id, marker] of this.trafficMarkers) {
      if (active.has(id)) continue;
      marker.element.remove();
      this.trafficMarkers.delete(id);
    }
    this.trafficBots.forEach((bot, index) => {
      if (this.trafficMarkers.has(bot.id)) return;
      const element = document.createElement('div');
      element.className = 'traffic-indicator';
      const arrow = document.createElement('span');
      arrow.className = 'traffic-indicator-arrow';
      const name = document.createElement('span');
      name.className = 'traffic-indicator-name';
      name.textContent = bot.driver;
      element.style.setProperty('--traffic-color', TRAFFIC_MARKER_COLORS[index % TRAFFIC_MARKER_COLORS.length]);
      element.append(arrow, name);
      markerLayer.appendChild(element);
      this.trafficMarkers.set(bot.id, { element, arrow });
    });
  }

  private updateTrafficMarkers() {
    for (const marker of this.trafficMarkers.values()) marker.element.style.display = 'none';
    if (!this.driving || !this.trafficBots.length) return;
    const canvas = this.map.getCanvas();
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    const centerX = width / 2;
    const centerY = height / 2;
    const margin = Math.min(78, Math.max(26, Math.min(width, height) * 0.16));
    this.trafficBots.forEach((bot, index) => {
      const marker = this.trafficMarkers.get(bot.id);
      if (!marker) return;
      const dead = !(this.combatLayer?.isTargetAlive(bot.id) ?? true);
      marker.element.style.setProperty(
        '--traffic-color',
        dead ? '#8b9198' : TRAFFIC_MARKER_COLORS[index % TRAFFIC_MARKER_COLORS.length],
      );
      marker.element.classList.toggle('is-dead', dead);
      const point = this.map.project(bot.position);
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
      if (point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height) return;
      const dx = point.x - centerX;
      const dy = point.y - centerY;
      const xLimit = Math.max(1, centerX - margin);
      const yLimit = Math.max(1, centerY - margin);
      const scale = Math.min(1, dx ? xLimit / Math.abs(dx) : Infinity, dy ? yLimit / Math.abs(dy) : Infinity);
      const x = centerX + dx * scale;
      const y = centerY + dy * scale;
      marker.element.style.display = 'flex';
      marker.element.style.left = `${x}px`;
      marker.element.style.top = `${y}px`;
      marker.arrow.style.transform = `rotate(${Math.atan2(dy, dx) * 180 / Math.PI + 90}deg)`;
    });
  }

  private updateEvents() {
    if (!this.driving) return;
    if (this.mode === 'arena') {
      if (this.playerHp <= 0) {
        this.endArena(false);
        return;
      }
      if (this.trafficBots.length && this.combatLayer && this.combatLayer.aliveTargetCount() === 0) {
        this.endArena(true);
      }
      return;
    }
    if (this.mode === 'race') {
      if (!this.raceGoal) return;
      if (distanceMeters(this.vehicle.position, this.raceGoal) <= 12) {
        this.endRace('player', t('you'));
        return;
      }
      const winner = this.trafficBots.find(bot =>
        this.combatLayer?.isTargetAlive(bot.id) && distanceMeters(bot.position, this.raceGoal!) <= 12,
      );
      if (winner) this.endRace(winner.id, winner.driver);
      return;
    }
    this.refillMissions();
    if (this.eventOffer || performance.now() < this.eventCooldown) return;
    const nearby = this.missions.find(mission => distanceMeters(this.vehicle.position, mission.position) <= 14);
    if (!nearby) return;
    this.eventOffer = nearby.kind;
    this.activeMissionId = nearby.id;
    this.onEventOffer(nearby.kind);
  }

  private makeMapLabel(className: string, text: string, label: string) {
    const element = document.createElement('div');
    element.className = className;
    element.setAttribute('aria-label', label);
    const title = document.createElement('span');
    title.textContent = text;
    element.append(title);
    return element;
  }

  private makeOffscreenIndicator(kind: 'focus' | 'finish', titleText: string) {
    const element = document.createElement('div');
    element.className = `mission-indicator ${kind === 'focus' ? 'mission-focus-indicator' : 'race-finish-indicator'}`;
    const arrow = document.createElement('span');
    arrow.className = 'mission-indicator-arrow';
    const content = document.createElement('span');
    content.className = 'mission-indicator-content';
    const title = document.createElement('span');
    title.className = 'mission-reward';
    title.textContent = titleText;
    const distance = document.createElement('span');
    distance.className = 'mission-indicator-distance';
    content.append(title, distance);
    element.setAttribute('aria-label', titleText);
    element.append(arrow, content);
    return { element, arrow, title, distance };
  }

  private ensureEventMarkers() {
    if (!this.eventIndicatorLayer) {
      this.eventIndicatorLayer = document.createElement('div');
      this.eventIndicatorLayer.className = 'mission-indicators';
      this.host.appendChild(this.eventIndicatorLayer);
    }
    const roaming = this.mode === 'roam' && this.driving;
    const active = new Set(this.missions.map(mission => mission.id));
    for (const [id, marker] of this.missionMarkers) {
      if (active.has(id)) continue;
      marker.remove();
      this.missionMarkers.delete(id);
    }
    for (const mission of this.missions) {
      let marker = this.missionMarkers.get(mission.id);
      if (!marker) {
        const className = mission.kind === 'arena' ? 'arena-map-marker' : 'race-map-marker';
        marker = this.marker({ element: this.makeMapLabel(className, mission.label, mission.label), anchor: 'bottom' })
          .setLngLat(mission.position)
          .addTo(this.map);
        this.missionMarkers.set(mission.id, marker);
      } else {
        marker.setLngLat(mission.position);
        const label = marker.getElement().querySelector('span');
        if (label) label.textContent = mission.label;
      }
      const el = marker.getElement();
      if (el) el.style.display = roaming ? '' : 'none';
    }
    if (!this.focusIndicator) {
      this.focusIndicator = this.makeOffscreenIndicator('focus', t('marker.target'));
      this.eventIndicatorLayer.appendChild(this.focusIndicator.element);
    }
  }

  private ensureRaceGoalMarker() {
    if (!this.raceGoal) {
      this.raceGoalMarker?.remove();
      this.raceGoalMarker = null;
      if (this.raceGoalIndicator) this.raceGoalIndicator.element.style.display = 'none';
      return;
    }
    if (!this.eventIndicatorLayer) {
      this.eventIndicatorLayer = document.createElement('div');
      this.eventIndicatorLayer.className = 'mission-indicators';
      this.host.appendChild(this.eventIndicatorLayer);
    }
    if (!this.raceGoalMarker) {
      this.raceGoalMarker = this.marker({ element: this.makeMapLabel('race-finish-marker', t('marker.finish'), t('marker.finishRace')), anchor: 'bottom' })
        .setLngLat(this.raceGoal)
        .addTo(this.map);
    } else this.raceGoalMarker.setLngLat(this.raceGoal);
    const el = this.raceGoalMarker.getElement();
    if (el) el.style.display = this.mode === 'race' ? '' : 'none';
    if (!this.raceGoalIndicator) {
      const made = this.makeOffscreenIndicator('finish', t('marker.finish'));
      this.raceGoalIndicator = { element: made.element, arrow: made.arrow, distance: made.distance };
      this.eventIndicatorLayer.appendChild(this.raceGoalIndicator.element);
    }
  }

  private updateOffscreenMarker(
    marker: { element: HTMLElement; arrow: HTMLElement; distance: HTMLElement; title?: HTMLElement } | null,
    target: [number, number] | null,
    visible: boolean,
    titleText?: string,
  ) {
    if (!marker) return;
    marker.element.style.display = 'none';
    if (!visible || !target) return;
    if (titleText && marker.title) marker.title.textContent = titleText;
    const canvas = this.map.getCanvas();
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    const point = this.map.project(target);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    const sideMargin = Math.min(90, width * 0.14);
    const topMargin = Math.min(132, height * 0.22);
    const bottomMargin = Math.min(86, height * 0.14);
    if (point.x >= sideMargin && point.x <= width - sideMargin
      && point.y >= topMargin && point.y <= height - bottomMargin) return;
    const centerX = width / 2;
    const centerY = height / 2;
    const dx = point.x - centerX;
    const dy = point.y - centerY;
    const xLimit = Math.max(1, centerX - sideMargin);
    const yLimit = Math.max(1, centerY - (dy < 0 ? topMargin : bottomMargin));
    const scale = Math.min(1, dx ? xLimit / Math.abs(dx) : Infinity, dy ? yLimit / Math.abs(dy) : Infinity);
    marker.element.style.display = 'flex';
    marker.element.style.left = `${centerX + dx * scale}px`;
    marker.element.style.top = `${centerY + dy * scale}px`;
    marker.arrow.style.transform = `rotate(${Math.atan2(dy, dx) * 180 / Math.PI + 90}deg)`;
    marker.distance.textContent = t('unit.m', { n: formatNumber(Math.round(distanceMeters(this.vehicle.position, target))) });
  }

  private updateEventMarkers() {
    const roaming = this.driving && this.mode === 'roam';
    if (this.missionFocus >= this.missions.length) this.missionFocus = Math.max(0, this.missions.length - 1);
    const focused = roaming ? this.missions[this.missionFocus] ?? null : null;
    this.updateOffscreenMarker(this.focusIndicator, focused?.position ?? null, Boolean(focused), focused?.label);
    this.updateOffscreenMarker(this.raceGoalIndicator, this.raceGoal, this.driving && this.mode === 'race');
  }

  private placeSpawnMarker(position: [number, number] | null) {
    if (!position) {
      this.spawnMarker?.remove();
      this.spawnMarker = null;
      return;
    }
    if (!this.spawnMarker) {
      const el = document.createElement('div');
      el.className = 'spawn-marker';
      el.innerHTML = `<svg width="30" height="42" viewBox="0 0 30 42" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M15 0C6.716 0 0 6.716 0 15c0 10.5 15 27 15 27S30 25.5 30 15C30 6.716 23.284 0 15 0z" fill="#263d38"/><circle cx="15" cy="15" r="6" fill="#e5f1a5"/></svg>`;
      this.spawnMarker = this.marker({ element: el, anchor: 'bottom' })
        .setLngLat(position)
        .addTo(this.map);
    } else {
      this.spawnMarker.setLngLat(position);
    }
    const element = this.spawnMarker.getElement();
    if (element) element.style.display = this.driving ? 'none' : '';
  }

  clearCustomSpawn() {
    this.customSpawn = null;
    if (this.defaultSpawn) {
      this.vehicle.position = [...this.defaultSpawn.position];
      this.vehicle.heading = this.defaultSpawn.heading;
      this.bearing = this.defaultSpawn.heading * 180 / Math.PI;
      this.renderVehicle.reset(this.vehicle);
      this.accumulator = 0;
      this.collisionDirty = true;
      this.collisionTime = 0;
      this.placeSpawnMarker(this.defaultSpawn.position);
      this.setTargetVehicles(this.defaultSpawn.position, this.defaultSpawn.heading);
      if (this.mapShown) this.map.jumpTo(this.introView());
    } else {
      this.placeSpawnMarker(null);
    }
    this.onSpawnSet(null);
  }

  getSpawnPosition(): [number, number] {
    return this.customSpawn ? [this.customSpawn.position[0], this.customSpawn.position[1]] : [this.vehicle.position[0], this.vehicle.position[1]];
  }

  getSpawnHeading(): number {
    return this.customSpawn ? this.customSpawn.heading : this.vehicle.heading;
  }

  /** Real petrol stations from the POI layer; remembered as the player drives on. */
  private collectStations() {
    const pois = this.readSourceLayer('poi');
    this.collectHubs(pois);
    for (const station of stationsFromFeatures(pois)) {
      if (![...this.stations.values()].some(known => metersBetween(known.position, station.position) < 25)) this.stations.set(station.id, station);
    }
    // keep the nearest few hundred; far ones come back when we drive there again
    if (this.stations.size > 300) {
      const keep = [...this.stations.values()].sort((a, b) => metersBetween(a.position, this.vehicle.position) - metersBetween(b.position, this.vehicle.position)).slice(0, 300);
      this.stations = new Map(keep.map(station => [station.id, station]));
    }
    const visible = [...this.stations.values()].filter(station => metersBetween(station.position, this.vehicle.position) < 2500);
    this.fuelLayer?.setStations(visible, this.settings.terrain);
  }

  /** Ports and airports from real data, with a map label each. */
  private collectHubs(pois: MapFeature[]) {
    for (const hub of hubsFromFeatures(this.readSourceLayer('aerodrome_label'), pois)) {
      if (!this.hubs.has(hub.id)) this.hubs.set(hub.id, hub);
    }
    const here = this.vehicle.position;
    for (const hub of this.hubs.values()) {
      const near = metersBetween(hub.position, here) < 6000;
      const marker = this.hubMarkers.get(hub.id);
      if (near && !marker) {
        const text = hub.kind === 'airport' ? t('hub.airport') : t('hub.port');
        this.hubMarkers.set(hub.id, this.marker({ element: this.makeMapLabel(`travel-hub-marker is-${hub.kind}`, text, text), anchor: 'bottom' }).setLngLat(hub.position).addTo(this.map));
      } else if (!near && marker) {
        marker.remove();
        this.hubMarkers.delete(hub.id);
      }
    }
  }

  /** Arriving at a hub offers a ticket once; leaving its area re-arms the offer. */
  private updateTravel() {
    if (this.mode !== 'roam' || this.travelOpen || this.fuelOut) return;
    const hub = hubAt(this.vehicle.position, [...this.hubs.values()]);
    if (!hub) { this.offeredHub = null; return; }
    if (hub.id === this.offeredHub || Math.abs(this.vehicle.speed) > 6) return;
    this.offeredHub = hub.id;
    this.travelOpen = true;
    this.keys.clear();
    this.vehicle.speed = 0;
    this.onTravelOffer({ kind: hub.kind, from: [...this.vehicle.position], money: Math.floor(this.playerMoney) });
  }

  declineTravel() {
    this.travelOpen = false;
    this.onTravelOffer(null);
  }

  /** Pay for the trip. Returns what the player carries to the destination, or null when it is too expensive. */
  buyTicket(destination: [number, number]): PlayerCarry | null {
    const hub = this.offeredHub ? this.hubs.get(this.offeredHub) : null;
    if (!hub) return null;
    const price = ticketPrice(this.vehicle.position, destination, hub.kind);
    if (this.playerMoney < price) return null;
    this.playerMoney -= price;
    this.travelOpen = false;
    this.onTravelOffer(null);
    return { money: this.playerMoney, fuel: this.fuel.ratio };
  }

  private updateFuel(dt: number) {
    const slow = Math.abs(this.vehicle.speed) < 1.5;
    const station = slow ? atStation(this.vehicle.position, [...this.stations.values()]) : null;
    const wasRefuelling = this.refuelling;
    this.refuelling = false;
    if (station && !this.fuelOut && this.fuel.level < this.fuel.spec.tank - 0.01) {
      const paid = this.fuel.refuel(dt, this.playerMoney);
      this.playerMoney -= paid.cost;
      this.refuelling = paid.litres > 0;
      if (this.refuelling) this.say(t('fuel.pumping'));
      else if (this.playerMoney < 1) this.say(t('fuel.broke'));
    } else if (wasRefuelling || this.message === t('fuel.pumping') || this.message === t('fuel.broke')) this.say('');
    if (this.fuel.empty && Math.abs(this.vehicle.speed) < 0.3 && !this.fuelOut && !station) {
      this.fuelOut = true;
      this.keys.clear();
      this.onFuelOut(true);
    }
  }

  /** Tow truck: to the nearest known station, for EVACUATION_COST coins. */
  evacuate() {
    if (!this.fuelOut) return;
    const near = nearestStation(this.vehicle.position, [...this.stations.values()]);
    if (near && this.sourceId) {
      const start = roadStart(this.map, this.sourceId, near.station.position, (position, heading) => this.collisions.blocked(position, position, heading, this.carScale));
      // the nearest road next to the pumps (the POI point itself may sit inside the shop)
      this.vehicle.position = start ? [...start.position] : [...near.station.position];
      if (start) this.vehicle.heading = start.heading;
    }
    this.playerMoney = Math.max(0, this.playerMoney - EVACUATION_COST);
    // a small reserve so a broke player is never stuck at the pump
    this.fuel.level = Math.max(this.fuel.level, this.fuel.spec.tank * EVACUATION_RESERVE);
    this.vehicle.speed = 0;
    this.vehicle.throttle = 0;
    this.bearing = this.vehicle.heading * 180 / Math.PI;
    this.renderVehicle.reset(this.vehicle);
    this.accumulator = 0;
    this.collisionDirty = true;
    this.syncedAt = null;
    this.fuelOut = false;
    this.onFuelOut(false);
    this.say(near ? t('tow.done') : t('tow.none'), true);
  }

  private marker(options: { element: HTMLElement; anchor: 'bottom' }): MapMarker {
    return (this.rendererKind === 'three' ? new ThreeMarker(options) : new maplibregl.Marker(options)) as unknown as MapMarker;
  }

  /** Our own world under the game, or null on MapLibre. */
  private get threeMap() {
    return this.rendererKind === 'three' ? this.map as unknown as ThreeMap : null;
  }

  buildingsNear(parts: BuildingPart[], focus: [number, number] = this.vehicle.position) {
    const show = (this.driving ? 900 : 1600) ** 2;
    const keep = (this.driving ? 1100 : 2000) ** 2;
    const maxBuildings = this.driving ? 650 : 2500;
    const cos = Math.cos(focus[1] * Math.PI / 180);
    const nearest = (part: BuildingPart) => {
      let best = Infinity;
      for (const point of part.rings[0] ?? []) {
        const east = (point[0] - focus[0]) * 111319.49 * cos;
        const north = (point[1] - focus[1]) * 111319.49;
        const distance = east * east + north * north;
        if (distance < best) best = distance;
      }
      return best;
    };
    const ranked = parts.map((part) => ({ part, distance: nearest(part) })).sort((a, b) => a.distance - b.distance);
    const next = new Set<string>();
    const visible: BuildingPart[] = [];
    for (const item of ranked) {
      if (visible.length >= maxBuildings) break;
      const retain = this.shownBuildings.has(item.part.key) ? item.distance < keep : item.distance < show;
      if (!retain) continue;
      next.add(item.part.key);
      visible.push(item.part);
    }
    this.shownBuildings = next;
    return visible;
  }

  introView() {
    return {
      center: this.vehicle.position as [number, number],
      zoom: 16.8,
      pitch: 57,
      bearing: this.vehicle.heading * 180 / Math.PI - 25,
      elevation: this.altitude,
    };
  }

  revealMap() {
    if (this.mapShown || this.disposed) return;
    this.mapShown = true;
    this.map.jumpTo(this.introView());
    this.introCameraKey = 'locked';
    this.host.style.transition = 'opacity .7s ease';
    this.host.style.opacity = '1';
    this.onBoot(true);
    this.say(t('status.ready'));
    // Enable map navigation for the intro screen (pan, zoom, right-drag rotate).
    this.map.dragPan.enable();
    this.map.scrollZoom.enable();
    this.map.dragRotate.enable();
    this.map.touchPitch.enable();
  }

  private settleBoot() {
    if (this.mapShown || !this.ready) return;
    const waited = performance.now() - this.bootAt;
    if (!this.spawnResolved) {
      this.say(t('status.placing'));
      if (waited > 12000) {
        this.spawnResolved = true;
        this.defaultSpawn = { position: [...this.vehicle.position], heading: this.vehicle.heading };
        this.placeSpawnMarker(this.defaultSpawn.position);
      }
      return;
    }
    if (this.settings.terrain) {
      if (!this.map.isSourceLoaded('elevation')) {
        this.say(t('status.terrain'));
        return;
      }
      const ground = this.map.queryTerrainElevation(this.vehicle.position);
      if (ground == null) {
        this.groundHits = 0;
        this.say(t('status.terrain'));
        if (waited < 10000) return;
      } else {
        const stable = this.lastGround != null && Math.abs(ground - this.lastGround) < 0.35;
        this.groundHits = stable ? this.groundHits + 1 : 0;
        this.lastGround = ground;
        this.altitude = ground;
        if (this.groundHits < 10 && waited < 10000) {
          this.say(t('status.terrain'));
          return;
        }
      }
    } else {
      this.altitude = 0;
    }
    if (!this.map.areTilesLoaded() && waited < 10000) {
      this.say(t('status.streets'));
      return;
    }
    if (!this.syncedAt) {
      this.collisionDirty = true;
      this.say(t('status.block'));
      if (waited < 14000) return;
    }
    const cells = this.city?.cellCount() ?? 0;
    if ((this.city?.pendingCount() ?? 0) > 0 || this.collisionDirty || this.worldWork) {
      this.say(t('status.blocks'));
      return;
    }
    if (this.city && cells < 1 && waited < 16000) {
      this.settleFrames++;
      this.say(t('status.block'));
      return;
    }
    if (this.city && !this.city.isSettled()) {
      this.settleFrames = 0;
      return;
    }
    if (this.settleFrames < 24) {
      this.settleFrames++;
      return;
    }
    this.revealMap();
  }

  setPaused(value: boolean) {
    this.paused = value;
    if (!value) return;
    this.keys.clear();
    this.dragging = false;
    this.aimingFire = false;
    this.combatLayer?.setFiring(false);
    this.aimHud(0, 0, false, false);
  }

  setDriving(value: boolean, approach = true) {
    const fromMenu = value && !this.driving && approach;
    this.driving = value;
    this.paused = false;
    if (!value) {
      this.eventOffer = null;
      this.onEventOffer(null);
      if (this.mode !== 'roam') {
        this.mode = 'roam';
        this.raceGoal = null;
        this.combatLayer?.setRaceFinish(null);
        this.clearEventBots();
        this.playerHp = this.playerMaxHp;
      }
    }
    this.keys.clear();
    this.vehicle.speed = 0;
    this.vehicle.throttle = 0;
    this.last = 0;
    this.accumulator = 0;
    this.renderVehicle.reset(this.vehicle);
    if (!value) {
      this.aimScreen = null;
      this.aimingFire = false;
      this.combatLayer?.setFiring(false);
      this.combatLayer?.setAim(null);
      this.aimHud(0, 0, false, false);
      if (this.spawnMarker) {
        const el = this.spawnMarker.getElement();
        if (el) el.style.display = '';
      }
      const moving = this.approachFrom != null;
      this.approach = 0;
      this.approachFrom = null;
      if (moving) this.onApproach(false);
      if (this.mapShown) {
        const view = this.introView();
        const center = this.map.getCenter();
        if (Math.abs(center.lng - view.center[0]) > 1e-8 || Math.abs(center.lat - view.center[1]) > 1e-8 || Math.abs(this.map.getCenterElevation() - view.elevation) > 0.25 || Math.abs(this.map.getZoom() - view.zoom) > 0.001) {
          this.map.jumpTo(view);
        }
        this.introCameraKey = 'locked';
        // Re-enable map navigation for intro
        this.map.dragPan.enable();
        this.map.scrollZoom.enable();
        this.map.dragRotate.enable();
        this.map.touchPitch.enable();
      }
      return;
    }
    if (this.spawnMarker) {
      const el = this.spawnMarker.getElement();
      if (el) el.style.display = 'none';
    }
    // Apply custom spawn before driving starts
    if (fromMenu && this.customSpawn) {
      this.vehicle.position = [...this.customSpawn.position];
      this.vehicle.heading = this.customSpawn.heading;
      this.bearing = this.customSpawn.heading * 180 / Math.PI;
      this.spawnResolved = true;
      this.renderVehicle.reset(this.vehicle);
      this.accumulator = 0;
    }
    // Disable map interactivity while driving
    this.map.dragPan.disable();
    this.map.scrollZoom.disable();
    this.map.dragRotate.disable();
    this.map.touchPitch.disable();
    if (!fromMenu) return;
    const center = this.map.getCenter();
    this.approachFrom = { lng: center.lng, lat: center.lat, zoom: this.map.getZoom(), pitch: this.map.getPitch(), bearing: this.map.getBearing() };
    this.approach = 1;
    this.onApproach(true);
  }

  noteFrame(now: number) {
    if (!this.fpsStamp) this.fpsStamp = now;
    this.fpsFrames++;
    const span = now - this.fpsStamp;
    if (span < 400) return;
    this.fps = Math.round(this.fpsFrames * 1000 / span);
    this.fpsFrames = 0;
    this.fpsStamp = now;
  }

  plantWheels(dt: number, now = performance.now()) {
    const settle = (current: number, target: number) => {
      const gap = target - current;
      const rate = 14 + Math.min(22, Math.abs(gap) * 8);
      return current + gap * (1 - Math.exp(-dt * rate));
    };
    if (!this.settings.terrain) {
      this.wheelTargets = { altitude: 0, pitch: 0, roll: 0, ready: true };
      this.altitude = settle(this.altitude, 0);
      this.modelPitch = settle(this.modelPitch, 0);
      this.modelRoll = settle(this.modelRoll, 0);
      return;
    }
    if (!this.wheelTargets.ready || now - this.wheelSampleTime >= 48) {
      this.wheelSampleTime = now;
      const heading = this.renderVehicle.heading;
      const forwardEast = Math.sin(heading);
      const forwardNorth = Math.cos(heading);
      const rightEast = Math.cos(heading);
      const rightNorth = -Math.sin(heading);
      const reach = this.car.length * 0.38 * this.carScale;
      const track = 0.85 * this.carScale;
      const sample = (along: number, side: number) => this.map.queryTerrainElevation(offsetPosition(this.renderVehicle.position, forwardEast * along + rightEast * side, forwardNorth * along + rightNorth * side));
      const frontLeft = sample(reach, -track);
      const frontRight = sample(reach, track);
      const rearLeft = sample(-reach, -track);
      const rearRight = sample(-reach, track);
      const known = [frontLeft, frontRight, rearLeft, rearRight].filter((value): value is number => value != null);
      if (known.length) {
        const pair = (a: number | null, b: number | null) => a != null && b != null ? (a + b) / 2 : a ?? b;
        const front = pair(frontLeft, frontRight);
        const rear = pair(rearLeft, rearRight);
        const left = pair(frontLeft, rearLeft);
        const right = pair(frontRight, rearRight);
        const clamp = (value: number) => Math.max(-0.42, Math.min(0.42, value));
        const pitch = front != null && rear != null ? clamp(Math.atan2(front - rear, reach * 2)) : this.modelPitch;
        const roll = left != null && right != null ? clamp(Math.atan2(left - right, track * 2)) : this.modelRoll;
        const supports: GroundSample[] = [];
        const add = (along: number, side: number, height: number | null) => {
          if (height != null) supports.push({ along, side, height });
        };
        add(reach, -track, frontLeft);
        add(reach, track, frontRight);
        add(-reach, -track, rearLeft);
        add(-reach, track, rearRight);
        // Include the belly and bumpers when crossing a crest or a sharp bank.
        add(0, 0, sample(0, 0));
        const bumper = this.car.length * 0.5 * this.carScale;
        add(bumper, 0, sample(bumper, 0));
        add(-bumper, 0, sample(-bumper, 0));
        this.wheelTargets = {
          altitude: supportAltitude(supports, pitch, roll),
          pitch,
          roll,
          ready: true,
        };
      }
    }
    if (!this.wheelTargets.ready) return;
    this.modelPitch = settle(this.modelPitch, this.wheelTargets.pitch);
    this.modelRoll = settle(this.modelRoll, this.wheelTargets.roll);
    this.altitude = Math.max(this.wheelTargets.altitude, settle(this.altitude, this.wheelTargets.altitude));
  }

  rememberPart(shape: [number, number][][], measuredHeight: number | null, base: number, id: number, levels: number | undefined, kind: string, roofShape: string) {
    const foot = footprintKey(shape);
    const prior = this.remembered.get(foot);
    if (prior && (prior.measured || measuredHeight == null)) return prior.part;
    const height = Math.max(3, Math.min(320, measuredHeight ?? 10));
    const part: BuildingPart = {
      id, rings: shape, height, base, levels, kind, roofShape,
      key: `${Math.round(height)}:${base.toFixed(1)}:${foot}`,
    };
    this.remembered.set(foot, { part, measured: measuredHeight != null });
    return part;
  }

  private readSourceLayer(layer: string) {
    try {
      const features = this.map.querySourceFeatures(this.sourceId, { sourceLayer: layer }) as MapFeature[];
      this.featureReadFailures.delete(layer);
      return features;
    } catch (error) {
      if (!this.featureReadFailures.has(layer)) {
        this.featureReadFailures.add(layer);
        console.error(`Failed to read map source layer "${layer}"`, error);
      }
      return [] as MapFeature[];
    }
  }

  private resolveSpawn() {
    if (this.spawnResolved) return;
    if (this.customSpawn) {
      if (!this.defaultSpawn) {
        this.defaultSpawn = { position: [...this.vehicle.position], heading: this.vehicle.heading };
      }
      this.vehicle.position = [...this.customSpawn.position];
      this.vehicle.heading = this.customSpawn.heading;
      this.bearing = this.customSpawn.heading * 180 / Math.PI;
      this.spawnResolved = true;
      this.setTargetVehicles(this.customSpawn.position, this.customSpawn.heading);
      this.renderVehicle.reset(this.vehicle);
      this.accumulator = 0;
      this.placeSpawnMarker(this.customSpawn.position);
      return;
    }
    const start = roadStart(this.map, this.sourceId, this.vehicle.position, (position, heading) => this.collisions.blocked(position, position, heading, this.carScale));
    if (start) {
      this.defaultSpawn = { position: [...start.position], heading: start.heading };
      this.vehicle.position = start.position;
      this.vehicle.heading = start.heading;
      this.bearing = start.heading * 180 / Math.PI;
      this.spawnResolved = true;
      this.setTargetVehicles(start.position, start.heading);
      this.renderVehicle.reset(this.vehicle);
      this.accumulator = 0;
      this.placeSpawnMarker(start.position);
    } else if (++this.spawnWaits > 12) {
      this.spawnResolved = true;
      this.defaultSpawn = { position: [...this.vehicle.position], heading: this.vehicle.heading };
      this.setTargetVehicles(this.defaultSpawn.position, this.defaultSpawn.heading);
      this.placeSpawnMarker(this.defaultSpawn.position);
    }
  }

  /**
   * Our world: buildings are already drawn from tiles and unique per tile, so no
   * re-reading, dedup or near-set here. Collisions come straight from footprints.
   */
  private *collectWorldThree(refreshTiles: boolean): Generator<null, void> {
    const world = this.threeMap!.world;
    if (refreshTiles) this.tilesIngested = true;
    this.collisions.update(this.vehicle.position, world.footprintsNear(this.vehicle.position, 260));
    yield null;
    // place the car on a road only once roads around it are actually in
    if (!this.spawnResolved && this.map.querySourceFeatures(this.sourceId, { sourceLayer: 'transportation' }).length) this.resolveSpawn();
    const center = this.map.getCenter();
    const focus: [number, number] = this.driving ? this.vehicle.position : [center.lng, center.lat];
    this.syncedAt = [focus[0], focus[1]];
    this.worldFresh = true;
    yield null;
    yield* this.collectGround(refreshTiles, focus, () => world.footprintsNear(focus, 700));
  }

  *collectWorldSteps(refreshTiles: boolean): Generator<null, void> {
    if (this.threeMap) {
      yield* this.collectWorldThree(refreshTiles);
      return;
    }
    let parts: BuildingPart[] = [...this.retained.values()];
    if (refreshTiles) {
      parts = [];
      let scanned = 0;
      for (const feature of this.map.querySourceFeatures(this.sourceId, { sourceLayer: 'building' })) {
        const geometry = feature.geometry;
        const shapes = geometry.type === 'Polygon' ? [geometry.coordinates as Polygon] : geometry.type === 'MultiPolygon' ? geometry.coordinates as Polygon[] : [];
        const props = feature.properties ?? {};
        const reported = Number(props.render_height ?? props.height);
        const measuredHeight = Number.isFinite(reported) && reported > 0 ? reported : null;
        const base = Math.max(0, Number(props.render_min_height ?? props.min_height ?? 0) || 0);
        const rawId = Number(feature.id ?? props.osm_id ?? 0) || 0;
        const levelsValue = Number(props.levels ?? props['building:levels'] ?? props.render_levels ?? 0);
        const levels = levelsValue >= 1 && levelsValue <= 80 ? Math.round(levelsValue) : undefined;
        const kind = String(props.class ?? props.building ?? props.type ?? '');
        const roofShape = String(props.roof_shape ?? props['roof:shape'] ?? '');
        for (const shape of shapes) {
          const anchor = shape[0]?.[0];
          if (!anchor) continue;
          parts.push(this.rememberPart(shape, measuredHeight, base, rawId || Math.round(anchor[0] * 1e5) ^ Math.round(anchor[1] * 1e5), levels, kind, roofShape));
        }
        if (++scanned % 80 === 0) yield null;
      }
      this.tilesIngested = true;
      yield null;
    }

    this.resolveSpawn();
    const center = this.map.getCenter();
    const focus: [number, number] = this.driving ? this.vehicle.position : [center.lng, center.lat];
    const cos = Math.cos(focus[1] * Math.PI / 180);
    const retainRadius = this.driving ? 1050 : 2200;
    const unique = collapseCopies(retainNearParts(keepVisibleParts(parts), this.retained.values(), (part) => {
      let best = Infinity;
      for (const point of part.rings[0] ?? []) {
        const east = (point[0] - focus[0]) * 111319.49 * cos;
        const north = (point[1] - focus[1]) * 111319.49;
        const distance = east * east + north * north;
        if (distance < best) best = distance;
      }
      return best;
    }, retainRadius ** 2));
    yield null;

    const visible = this.buildingsNear(unique, focus);
    if (visible.length) {
      this.retained = new Map(visible.map((part) => [part.key, part]));
      this.city?.sync(visible, this.settings.terrain, focus);
      this.syncedAt = [focus[0], focus[1]];
    }
    this.worldFresh = true;
    yield null;
    yield* this.collectGround(refreshTiles, focus, () => unique.map(part => part.rings));
  }

  /** Roads, water, green areas, stations and vegetation: shared by both renderers. */
  private *collectGround(refreshTiles: boolean, focus: [number, number], buildingRings: () => [number, number][][][]): Generator<null, void> {
    const cos = Math.cos(focus[1] * Math.PI / 180);
    if (refreshTiles) {
      this.cachedWater = this.readSourceLayer('water');
      yield null;
      this.cachedRoads = this.readSourceLayer('transportation');
      this.trafficNetwork.addFeatures(this.cachedRoads);
      yield null;
      this.trafficNetwork.flushRebuild();
      yield null;
      this.syncRoadPickups();
      this.cachedLanduse = this.readSourceLayer('landuse');
      this.collectStations();
      yield null;
      this.cachedGreen = [...this.readSourceLayer('landcover'), ...this.cachedLanduse, ...this.readSourceLayer('park')];
      yield null;
    } else if (this.trafficNetwork.flushRebuild()) {
      this.syncRoadPickups();
      yield null;
    }

    this.water.collect(this.vehicle.position, this.cachedWater, this.cachedRoads);
    this.thicket.update(this.vehicle.position, this.cachedGreen, this.cachedRoads);
    yield null;

    const greened = this.greenedAt;
    const movedGreen = greened ? Math.hypot((focus[0] - greened[0]) * 111319.49 * cos, (focus[1] - greened[1]) * 111319.49) : Infinity;
    const greenLimit = this.driving ? 140 : 55;
    if (movedGreen > greenLimit || this.greenedTerrain !== this.settings.terrain) {
      this.greenedAt = [focus[0], focus[1]];
      this.greenedTerrain = this.settings.terrain;
      const aheadMeters = this.driving ? 80 : 0;
      const headingRad = this.renderVehicle.heading;
      const greenFocus: [number, number] = aheadMeters > 0 ? offsetPosition(focus, Math.sin(headingRad) * aheadMeters, Math.cos(headingRad) * aheadMeters) : [...focus];
      const landObstacles = this.cachedLanduse.filter(feature => /^(pitch|playground|track|stadium|parking)$/.test(String(feature.properties?.class ?? '')));
      // While driving, skip per-building vegetation blockers — retained plants + water/roads are enough and much cheaper.
      const buildingObstacles = this.driving
        ? []
        : buildingRings().map(rings => ({ geometry: { type: 'Polygon' as const, coordinates: rings } }));
      this.vegetation?.sync({
        green: this.cachedGreen,
        obstacles: [...this.cachedWater, ...landObstacles, ...buildingObstacles],
        roads: this.cachedRoads,
        focus: greenFocus,
        plantCap: this.driving ? 900 : undefined,
        reachScale: this.driving ? 0.82 : 1,
      }, this.settings.terrain);
    }
  }

  private pumpWorld(now: number) {
    const movedLimit = this.driving ? 90 : 40;
    const origin = this.syncedAt;
    const cos = Math.cos(this.vehicle.position[1] * Math.PI / 180);
    const center = this.map.getCenter();
    const checkPoint: [number, number] = this.driving ? this.vehicle.position : [center.lng, center.lat];
    const moved = origin ? Math.hypot((checkPoint[0] - origin[0]) * 111319.49 * cos, (checkPoint[1] - origin[1]) * 111319.49) : Infinity;
    const needsCoverage = !this.water.covers(this.vehicle.position);
    const tileDebounce = this.driving ? 1200 : (this.mapShown ? 1800 : 250);
    const refreshTiles = (!this.tilesIngested || this.collisionDirty) && now - this.collisionTime >= tileDebounce;
    const needFocus = needsCoverage || moved >= movedLimit;

    if (!this.worldWork && this.sourceId) {
      if (refreshTiles) {
        this.collisionTime = now;
        this.collisionDirty = false;
        this.focusTime = now;
        this.worldWork = this.collectWorldSteps(true);
      } else if (needFocus && now - this.focusTime >= 160) {
        this.focusTime = now;
        this.worldWork = this.collectWorldSteps(false);
      }
    }

    if (!this.worldWork) return;
    const cityBusy = (this.city?.pendingCount() ?? 0) > 0;
    const deadline = performance.now() + (this.driving ? (cityBusy ? 1.5 : 2.2) : 8);
    while (this.worldWork && performance.now() < deadline) {
      if (this.worldWork.next().done) this.worldWork = null;
    }
  }

  tick = (now: number) => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.tick);
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.1) : 0;
    this.last = now;
    this.noteFrame(now);
    if (!this.ready) return;
    this.pumpWorld(now);
    if (this.driving && !this.paused && !document.hidden) {
      this.accumulator += dt;
      let blocked = false;
      let thicket = false;
      let shore = false;
      while (this.accumulator >= 1 / 60) {
        this.renderVehicle.capture(this.vehicle);
        const previous: [number, number] = [...this.vehicle.position];
        const oldHeading = this.vehicle.heading;
        // An empty tank: no throttle, no boost; the car rolls out.
        const driveKeys = this.fuel.empty ? new Set([...this.keys].filter(key => !NO_FUEL_KEYS.has(key))) : this.keys;
        const travelled = this.vehicle.distance;
        this.vehicle.step(1 / 60, driveKeys, { ...vehicleConfig, acceleration: this.car.acceleration, maxSpeed: this.car.maxSpeed, scale: this.carScale });
        // consumption follows the car's own distance (scale-independent)
        this.fuel.burn((this.vehicle.distance - travelled) / this.carScale, 1 / 60, driveKeys.has('Space'));
        {
          const building = this.collisions.resolve(previous, this.vehicle.position, this.vehicle.heading, this.carScale);
          if (building.stopped) {
            this.vehicle.position = building.position;
            this.vehicle.heading = oldHeading;
            this.vehicle.speed = 0;
            blocked = true;
          } else if (building.slid) {
            this.vehicle.position = building.position;
            this.vehicle.speed *= 0.82;
          } else if (this.thicket.blocked(previous, this.vehicle.position)) {
            this.vehicle.position = previous;
            this.vehicle.heading = oldHeading;
            this.vehicle.speed = 0;
            thicket = true;
          } else {
            const hit = this.water.resolve(previous, this.vehicle.position, this.vehicle.heading, this.carScale);
            this.vehicle.position = hit.position;
            if (hit.stopped) {
              this.vehicle.speed = 0;
              shore = true;
            }
          }
        }
        const peers = [
          { id: 'player', position: this.vehicle.position as [number, number], alive: true },
          ...this.trafficBots.map(bot => ({
            id: bot.id,
            position: bot.position,
            alive: !this.combatLayer || this.combatLayer.isTargetAlive(bot.id),
          })),
        ];
        for (const bot of this.trafficBots) {
          if (this.combatLayer && !this.combatLayer.isTargetAlive(bot.id)) continue;
          const previous: [number, number] = [...bot.position];
          const oldHeading = bot.heading;
          advanceTrafficBot(bot, 1 / 60, this.trafficNetwork, {
            ...vehicleConfig,
            acceleration: bot.car.acceleration,
            maxSpeed: bot.car.maxSpeed,
            scale: this.carScale,
          }, peers);
          const building = this.collisions.resolve(previous, bot.position, bot.heading, this.carScale);
          if (building.stopped || building.slid) {
            bot.controller.position = building.position;
            bot.retryFrames += building.stopped ? 6 : 2;
            const side = (bot.id.charCodeAt(bot.id.length - 1) + bot.retryFrames) % 2 ? 1 : -1;
            if (building.stopped) {
              // Back out of the corner instead of parking against the wall.
              bot.controller.heading = oldHeading + side * (0.55 + (bot.retryFrames % 7) * 0.05);
              bot.controller.speed = -2.6;
            } else {
              bot.controller.speed *= 0.75;
              if (Math.abs(bot.controller.speed) < 1.2) {
                bot.controller.heading = oldHeading + side * 0.35;
                bot.controller.speed = Math.max(bot.controller.speed, 1.5);
              }
            }
            if (bot.retryFrames > 18 && bot.routeIndex < bot.route.length - 1) {
              bot.routeIndex++;
              bot.retryFrames = 0;
            } else if (bot.retryFrames > 40) {
              bot.route = [];
              bot.routeIndex = 1;
              bot.routeSeed = (bot.routeSeed * 48271 + 1) % 2147483647;
              bot.retryFrames = 0;
              bot.controller.heading += side * 0.9;
            }
          } else if (this.thicket.blocked(previous, bot.position)) {
            bot.controller.position = previous;
            bot.controller.heading = oldHeading + ((bot.id.charCodeAt(0) % 2) ? 0.5 : -0.5);
            bot.controller.speed = -2.2;
            bot.retryFrames += 4;
          } else if (this.water.covers(previous)) {
            const hit = this.water.resolve(previous, bot.position, bot.heading, this.carScale);
            bot.controller.position = hit.position;
            if (hit.stopped) bot.controller.speed = 0;
            bot.retryFrames = Math.max(0, bot.retryFrames - 2);
          } else {
            bot.retryFrames = Math.max(0, bot.retryFrames - 3);
          }
          bot.position = [...bot.controller.position];
          bot.heading = bot.controller.heading;
        }
        this.resolveVehicleContacts(now);
        this.collectRoadPickups();
        this.accumulator -= 1 / 60;
      }
      if (this.trafficBots.length) this.combatLayer?.updateTargets(this.targetVehicles());
      this.updateFuel(dt);
      this.updateTravel();
      if (blocked) this.say(t('hint.building'));
      else if (thicket) this.say(t('hint.thicket'));
      else if (shore) this.say(t('hint.shore'));
      else if ([t('hint.building'), t('hint.thicket'), t('hint.shore')].includes(this.message)) this.say('');
      this.updateEvents();
      this.renderVehicle.update(this.vehicle, this.accumulator * 60);
      this.plantWheels(dt, now);
      this.nudgeCamera(dt);
      const targetBearing = (this.settings.follow ? this.renderVehicle.heading * 180 / Math.PI : this.bearing) + this.orbit;
      const delta = ((targetBearing - this.bearing + 540) % 360) - 180;
      if (this.settings.follow) this.bearing += delta * (1 - Math.exp(-dt * 5));
      else { this.bearing += this.orbit; this.orbit = 0; }
      const bearingRad = this.bearing * Math.PI / 180;
      const ahead = this.distance * cameraConfig.lookAheadFactor;
      const look = offsetPosition(this.renderVehicle.position, Math.sin(bearingRad) * ahead, Math.cos(bearingRad) * ahead);
      const zoom = zoomForDistance(this.distance, this.renderVehicle.position[1]);
      let center: [number, number] = look;
      let zoomNow = zoom;
      let pitchNow = this.pitch;
      let bearingNow = this.bearing;
      if (this.approachFrom) {
        this.approach = Math.max(0, this.approach - dt / 1.75);
        const t = 1 - this.approach;
        const eased = t * t * (3 - 2 * t);
        const from = this.approachFrom;
        const turn = ((this.bearing - from.bearing + 540) % 360) - 180;
        center = [from.lng + (look[0] - from.lng) * eased, from.lat + (look[1] - from.lat) * eased];
        zoomNow = from.zoom + (zoom - from.zoom) * eased;
        pitchNow = from.pitch + (this.pitch - from.pitch) * eased;
        bearingNow = from.bearing + turn * eased;
        if (this.approach === 0) {
          this.approachFrom = null;
          this.onApproach(false);
        }
      }
      this.map.jumpTo({ center, zoom: zoomNow, pitch: pitchNow, bearing: bearingNow, elevation: this.altitude });
      this.threeMap?.setFocusCar(this.renderVehicle.position, this.altitude);
      this.updateAim();
    } else if (!this.driving) {
      this.threeMap?.setFocusCar(null);
      this.renderVehicle.reset(this.vehicle);
      if (!this.mapShown) {
        if (this.settings.terrain) {
          const ground = this.map.queryTerrainElevation(this.vehicle.position);
          if (ground != null) this.altitude = ground;
        } else this.altitude = 0;
        const view = this.introView();
        const center = this.map.getCenter();
        if (Math.abs(center.lng - view.center[0]) > 1e-8 || Math.abs(center.lat - view.center[1]) > 1e-8 || Math.abs(this.map.getCenterElevation() - view.elevation) > 0.25 || Math.abs(this.map.getZoom() - view.zoom) > 0.001) this.map.jumpTo(view);
      }
    }
    this.updateHealthMarkers(now - this.overlayTime > 100);
    this.updateTrafficMarkers();
    this.updateEventMarkers();
    if (now - this.overlayTime > 100) this.overlayTime = now;
    if (now - this.hudTime > 100) {
      this.hudTime = now;
      this.hud(this.vehicle.speed * 3.6, this.vehicle.distance, this.carScale, this.fps, this.hudParticipants());
      const near = nearestStation(this.vehicle.position, [...this.stations.values()]);
      const hub = nearestHub(this.vehicle.position, [...this.hubs.values()]);
      this.onFuel({ level: this.fuel.level, tank: this.fuel.spec.tank, refuelling: this.refuelling, station: near ? near.distance : null, money: Math.floor(this.playerMoney), hub: hub ? { kind: hub.hub.kind, distance: hub.distance } : null });
    }
    const bootBudget = !this.mapShown && this.spawnResolved ? 24 : 20;
    // Keep a tiny city budget even while world work runs so geometry doesn't burst after a quiet stretch.
    // Intro after reveal: only trickle new cells — never a 10/frame storm that recolors pitched roofs.
    const budget = !this.spawnResolved ? 0 : this.driving ? 1 : (this.mapShown ? 2 : bootBudget);
    const mapCenter = this.map.getCenter();
    const cityFocus: [number, number] = this.driving ? this.renderVehicle.position : [mapCenter.lng, mapCenter.lat];
    this.city?.follow(cityFocus, this.driving ? this.altitude + 1.2 : null, budget, this.driving);
    this.worldFresh = false;
    if (!this.mapShown) this.settleBoot();
    this.map.triggerRepaint();
  };

  dispose() {
    this.disposed = true;
    this.worldWork = null;
    cancelAnimationFrame(this.frame);
    this.spawnMarker?.remove();
    for (const marker of this.missionMarkers.values()) marker.remove();
    this.missionMarkers.clear();
    this.raceGoalMarker?.remove();
    this.eventIndicatorLayer?.remove();
    for (const marker of this.hubMarkers.values()) marker.remove();
    this.hubMarkers.clear();
    this.pickups.clear();
    this.combatLayer?.setPickups([]);
    this.trafficMarkerLayer?.remove();
    this.trafficMarkers.clear();
    this.healthMarkerLayer?.remove();
    this.healthMarkers.clear();
    this.cleanups.forEach((fn) => fn());
    this.map.remove();
  }
}
