import { roadStart } from './roadStart';
import { VehiclePose } from './VehiclePose';
import { supportAltitude, type GroundSample } from './groundSupport';
import { BuildingCollisions } from './BuildingCollisions';
import { ThicketCollision } from './Vegetation';
import { WaterCollisionController, type MapFeature } from './WaterCollisionController';
import { mapConfig, cars as carsConfig, carPrice, tradeInPrice, type City, type Car, vehicleConfig } from '@/config/vehicle.config';
import { cameraConfig, zoomForDistance } from '@/config/camera.config';
import { VehicleController, offsetPosition, resolveVehicleCollision, type Position } from './VehicleController';
import { vehicleLayer, type VehicleSceneLayer } from '@/rendering/VehicleLayer';
import type { ArchitectureSetting, BuildingDetail } from './buildings/BuildingStyles';
import type { SkinId } from '@/world3d/buildings/skins';
import type { ChatLine, NetNotice } from '@/net/NetClient';
import { distanceToTile } from '@/world3d/tiles/tilePlan';
import { mercatorX, mercatorY } from '@/world3d/mercator';

/** tiles this close to the car feed gameplay (the world's feature radius, plus slack) */
const NEAR_TILE_METERS = 2600;
import { NetPlayers, type OnlinePlayer } from './net/NetPlayers';
import { SharedTraffic } from './net/SharedTraffic';
import { HealthMeters } from './hud/HealthMeters';
import { TestTargets } from './TestTargets';
import { PLAYER_HP } from '@/net/protocol';
import { MARKER_PIN_METERS, nameIndicator, placeIndicator } from './hud/indicators';
import { advanceTrafficBot, createTrafficBot, TrafficRoadNetwork, type TrafficBot } from './TrafficBots';
import { formatNumber, t } from '@/i18n';
import { ThreeMap, ThreeMarker } from '@/world3d/map/ThreeMap';
import { atStation, dealershipsFromFeatures, EVACUATION_COST, EVACUATION_RESERVE, FuelTank, FUEL_PRICE, metersBetween, nearestStation, repairShopsFromFeatures, REPAIR_PRICE, stationsFromFeatures, type Station } from './Fuel';
import { fuelStationsLayer } from '@/rendering/FuelStationsLayer';
import { trainsLayer } from '@/rendering/TrainsLayer';
import { RailNetwork, TrainTraffic } from './Trains';
import { hubAt, hubsFromFeatures, kilometres, nearestHub, ticketPrice, type Hub, type HubKind } from './Travel';
import { bearingTo, loadBounty, makeBounty, saveBounty, type Bounty } from './Bounty';

export type FuelHud = { level: number; tank: number; refuelling: boolean; station: number | null; money: number; hub: { kind: HubKind; distance: number } | null };
/** What a player takes along to another city (ticket, later: server handoff). */
export type PlayerCarry = { money: number; fuel: number };
export type TravelOffer = { kind: HubKind; from: [number, number]; money: number; target?: { name: string; country: string; coords: [number, number] } };
/** A wanted driver somewhere in the world, offered as a job. */
export type BountyOffer = { name: string; car: string; place: string; country: string; km: number; reward: number };
/** Arena/race finished — UI shows a result dialog. */
export type EventResult = { kind: 'arena' | 'race'; won: boolean; name?: string };
/** Arrived at a fuel station or a car service: what the dialog needs to show. */
export type ServiceOffer =
  | { kind: 'fuel'; level: number; tank: number; money: number; price: number }
  | { kind: 'repair'; hp: number; maxHp: number; money: number; price: number };
/** Car dealership lot: shelf prices and the trade-in for the car you drove in. */
export type DealerOffer = { money: number; currentId: string; tradeIn: number };
const NO_FUEL_KEYS = new Set(['KeyW', 'Space']);

type MapMarker = {
  setLngLat(position: [number, number]): MapMarker;
  addTo(map: ThreeMap): MapMarker;
  remove(): unknown;
  getElement(): HTMLElement;
};

export type Quality = 'low' | 'medium' | 'high';
/** One line of the "who is online" list. Distance in meters from our car. */
export type { OnlinePlayer };

/** Interface look only — not the sun in the world. */
export type Theme = 'light' | 'night';
export type Settings = {
  terrain: boolean;
  follow: boolean;
  sensitivity: number;
  quality: Quality;
  buildingDetail: BuildingDetail;
  architecture: ArchitectureSetting;
  /** architecture skin painted over any city (buildings/skins) */
  skin: SkinId;
  theme: Theme;
};

const DRIVER_NAMES = ['Ines', 'Tiago', 'Marta', 'Rui', 'Leonor', 'Duarte', 'Beatriz', 'Nuno', 'Sofia', 'Miguel', 'Rafael', 'Ana'];
const PICKUP_COLORS = ['#ff4f79', '#ffc837', '#45d8ef', '#a96aff', '#69e286', '#ff8745'];
const TRAFFIC_MARKER_COLORS = ['#ff3b30', '#00e5ff', '#ffe600'];
const METERS_PER_DEGREE = 111319.49;
const GRAVITY = 9.81;
/** key J: hold to grow, release to place. Grade is rise/run (30%). */
export const RAMP = {
  grade: 0.3,
  width: 3.2,
  minLength: 2.4,
  maxLength: 16,
  growPerSec: 7,
  /** base mesh size in VehicleLayer — keep in sync for scaling */
  mesh: { length: 3.2, width: 3.2, height: 1.0 },
};

export type HudParticipant = { id: string; name: string; color: string; hp: number; maxHp: number; money: number; wins: number };
type ActivePickup = { position: [number, number]; color: string; kind: 'ball' | 'coin' };



function randomDriverNames(count: number) {
  const names = [...DRIVER_NAMES];
  for (let index = names.length - 1; index > 0; index--) {
    const swap = Math.floor(Math.random() * (index + 1));
    [names[index], names[swap]] = [names[swap], names[index]];
  }
  return names.slice(0, count);
}

/** other players' name tags and roster lines (as their pointers on screen) */
const PLAYER_MARKER_COLOR = '#7cf0b0';


export class GameEngine {
  collisions = new BuildingCollisions();
  thicket = new ThicketCollision();
  water = new WaterCollisionController();
  collisionDirty = true;
  collisionTime = 0;
  spawnResolved = false;
  private spawnWaits = 0;
  /** the map's first frame is in: layers added, features can be read */
  private mapLoaded = false;
  map: ThreeMap;
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

  car: Car;
  combatLayer: VehicleSceneLayer | null = null;
  syncedAt: [number, number] | null = null;
  fps = 0;
  private fpsFrames = 0;
  private fpsStamp = 0;
  private worldWork: Generator<null, void> | null = null;
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
  /** vertical motion: the car flies off crests and ramps under gravity */
  private climb = 0;
  private airborne = false;
  private wasOnRamp = false;
  /** the ramp put down with J (one at a time; gone shortly after the jump) */
  private ramp: { start: [number, number]; heading: number; usedAt: number; length: number; height: number; width: number } | null = null;
  /** holding J: ramp preview grows until release */
  private rampCharge: { start: [number, number]; heading: number; ground: number; length: number } | null = null;
  private aimScreen: [number, number] | null = null;
  private trafficBots: TrafficBot[] = [];
  private trafficNetwork = new TrafficRoadNetwork();
  /** light traffic shared with the players around */
  private sharedTraffic!: SharedTraffic;
  private vehicleContactTimes = new Map<string, number>();
  private trafficMarkerLayer: HTMLElement | null = null;
  private trafficMarkers = new Map<string, { element: HTMLElement; arrow: HTMLElement; distance: HTMLElement }>();
  /** health bars over the cars on screen */
  private healthMeters!: HealthMeters;
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
  /** bounty hunt: the active job (kept across trips), the offer on screen, the fight */
  private bounty: Bounty | null = loadBounty();
  private bountyPending: Bounty | null = null;
  /** local pin where you drive to take a pending wanted job */
  private bountyPickup: [number, number] | null = null;
  private bountyOfferAt = performance.now() + 45000;
  private bountyRetryAt = 0;
  private bountyApproachCooldown = 0;
  private bountyOfferShown = false;
  private bountyFight = false;
  // ---- multiplayer: other players in the same world (net/NetPlayers)
  private players!: NetPlayers;
  private bountyIndicator: { element: HTMLElement; arrow: HTMLElement; title: HTMLElement; distance: HTMLElement } | null = null;
  private bountyMarker: MapMarker | null = null;
  onBountyOffer: (offer: BountyOffer | null) => void = () => {};
  /** trains and trams on the real tracks */
  private rails = new RailNetwork();
  private trainTraffic = new TrainTraffic(this.rails);
  private trainLayer: ReturnType<typeof trainsLayer> | null = null;
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
  onEventResult: (result: EventResult | null) => void = () => {};
  /** fuel gauge data, ~10 times a second */
  onFuel: (fuel: FuelHud) => void = () => {};
  /** multiplayer: who is online (twice a second), chat lines, the connection's state */
  onOnline: (players: OnlinePlayer[]) => void = () => {};
  onChat: (line: ChatLine) => void = () => {};
  onNetNotice: (notice: NetNotice) => void = () => {};
  /** the tank ran dry and the car stopped: show the tow-truck dialog */
  onFuelOut: (out: boolean) => void = () => {};
  fuel!: FuelTank;
  private stations = new Map<string, Station>();
  private fuelLayer: ReturnType<typeof fuelStationsLayer> | null = null;
  private fuelOut = false;
  private refuelling = false;
  /** ports, airports and railway stations: reaching one offers a ticket to any city */
  onTravelOffer: (offer: TravelOffer | null) => void = () => {};
  private hubs = new Map<string, Hub>();
  /** fuel station or car service dialogs (shown on arrival, re-armed after leaving) */
  onServiceOffer: (offer: ServiceOffer | null) => void = () => {};
  /** car dealership dialog (Tab when on the lot, or arriving slowly) */
  onDealerOffer: (offer: DealerOffer | null) => void = () => {};
  /** after a purchase: React keeps the menu car index in sync */
  onCarBought: (car: Car) => void = () => {};
  private repairShops = new Map<string, Station>();
  private dealerships = new Map<string, Station>();
  private serviceMarkers = new Map<string, MapMarker>();
  private offeredService: string | null = null;
  private serviceOpen: ServiceOffer['kind'] | null = null;
  private dealerOpen = false;
  /** key M: camera rises straight up for a ~2 × 2 km view from above (0 chase … 1 overview) */
  private overview = 0;
  private overviewTarget = 0;
  /** once overview is open: pan/zoom freely; blend back from here when closing */
  private overviewFree = false;
  private overviewLeave: { center: [number, number]; zoom: number } | null = null;
  /** the menu camera to return to after the view from above */
  private menuView: { center: [number, number]; zoom: number; pitch: number; bearing: number } | null = null;

  /** ~2 km across the screen height, straight down */
  private overviewZoom(lat: number) {
    const height = this.map.getCanvas().clientHeight || 800;
    const mercPerMeter = 1 / (2 * Math.PI * 6371008.8 * Math.cos(lat * Math.PI / 180));
    return Math.log2((height / 2000) / mercPerMeter / 512);
  }

  /** Driving map mode (M): inspect the city, no gun. */
  private mapInspecting() {
    return this.driving && (this.overviewTarget > 0 || this.overview > 0.4);
  }

  private setOverviewMapNav(on: boolean) {
    if (on) this.map.setInteractive({ pan: true, rotate: false });
    else if (this.driving) this.map.setInteractive({ pan: false, rotate: false });
  }

  private toggleOverview() {
    if (this.overviewTarget) {
      // closing — remember where the player was looking
      const c = this.map.getCenter();
      this.overviewLeave = { center: [c.lng, c.lat], zoom: this.map.getZoom() };
      this.overviewTarget = 0;
      this.overviewFree = false;
      this.setOverviewMapNav(false);
    } else {
      this.overviewLeave = null;
      this.overviewTarget = 1;
      this.overviewFree = false;
      this.stopGun();
      this.lookPointer = null;
      this.lookOrigin = null;
      this.lookDragging = false;
      this.dragging = false;
    }
  }
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
  /** LMB: drag to look around; hold still to aim/fire (no permanent reticle). */
  private lookPointer: number | null = null;
  private lookOrigin: { x: number; y: number } | null = null;
  private lookDragging = false;
  constructor(el: HTMLElement, city: City, car: Car, settings: Settings, private hud: (speed: number, distance: number, fps: number, participants: HudParticipant[]) => void, private status: (s: string, toast?: boolean) => void, private aimHud: (x: number, y: number, visible: boolean, firing?: boolean) => void, carry: PlayerCarry | null = null) {
    this.fuel = new FuelTank(car.fuel);
    this.carry = carry;
    (window as unknown as { __cityRider?: GameEngine }).__cityRider = this; // console debugging
    this.host = el;
    el.style.opacity = '0';
    this.bootAt = performance.now();
    this.settings = settings;
    this.car = car;
    this.vehicle = new VehicleController(city.coords, city.heading);
    this.healthMeters = new HealthMeters(el);
    const engine = this;
    this.players = new NetPlayers({
      host: el,
      view: { getCanvas: () => this.map.getCanvas(), project: (point) => this.map.project(point), getBearing: () => this.map.getBearing() },
      get vehicle() { return engine.vehicle; },
      layer: () => this.combatLayer ?? null,
      car: () => this.car,
      altitude: () => this.altitude,
      lean: () => ({ pitch: this.modelPitch, roll: this.modelRoll }),
      driving: () => this.driving,
      mapView: () => this.mapInspecting(),
      busy: () => this.mode !== 'roam' || this.bountyFight,
      canMove: (from, to, heading) => !this.collisions.blocked(from, to, heading, 1, this.altitude) && !this.water.resolve(from, to, heading).stopped,
      online: (list) => this.onOnline(list),
      chat: (line) => this.onChat(line),
      notice: (notice) => this.onNetNotice(notice),
      hitBy: (name, damage) => this.hitByPlayer(name, damage),
      hp: () => this.playerHp,
      news: (text) => this.say(text, true),
      traffic: (from, cars) => this.sharedTraffic.receive(from, cars),
      trafficHit: (id) => this.sharedTraffic.hitByOther(id),
    });
    this.sharedTraffic = new SharedTraffic({
      network: this.trafficNetwork,
      vehicle: { get position() { return engine.vehicle.position; }, get heading() { return engine.vehicle.heading; } },
      driving: () => this.driving && !this.paused,
      layer: () => this.combatLayer,
      myId: () => this.players.id(),
      others: () => this.players.others(),
      send: (cars) => this.players.sendTraffic(cars),
      hit: (id) => this.players.hitTraffic(id),
    });
    this.renderVehicle.reset(this.vehicle);
    this.bearing = city.heading;
    // our own Three.js world: one fixed DEM level, buildings never need re-settling
    this.map = new ThreeMap({
      container: el,
      center: city.coords,
      zoom: 16.8,
      pitch: 57,
      bearing: city.heading - 25,
      maxPitch: 80,
      dem: mapConfig.dem.tiles[0],
      region: city.country,
    });
    this.map.on('tile', event => {
      // gameplay data (roads, water, stations…) is read around the car: a tile arriving far
      // away (the map view streams many) is no reason to read it all again
      if (typeof event.tile === 'string' && !this.nearCar(event.tile)) return;
      this.collisionDirty = true;
    });
    this.map.on('error', () => this.say(t('status.mapError')));
    // key T cycles the time of day in our world; tell the player which one
    // Shift+T: the season (trees), also only for this player
    this.map.on('seasonmode', (event) => {
      const season = event.season as 'spring' | 'summer' | 'autumn' | 'winter';
      const name = t(`seasonName.${season}`);
      this.say(event.mode === 'real' ? t('season.real', { name }) : t('season.set', { name }), true);
    });
    this.map.on('timemode', (event) => {
      const mode = event.mode as 'real' | 'morning' | 'day' | 'evening' | 'night' | undefined;
      if (mode) this.say(t(`time.${mode}`, { clock: String(event.clock ?? '') }), true);
    });
    this.map.on('load', () => {
      if (this.disposed) return;
      this.mapLoaded = true;
      this.fuelLayer = fuelStationsLayer();
      this.map.addLayer(this.fuelLayer);
      this.trainLayer = trainsLayer();
      this.map.addLayer(this.trainLayer);
      const layer = this.trainLayer;
      this.trainTraffic.carLength = (trainId, index, kind) => layer.carLength(trainId, index, kind);
      this.combatLayer = vehicleLayer(
        car,
        this.renderVehicle,
        () => this.altitude,
        () => this.modelPitch,
        () => this.modelRoll,
        (text) => this.say(text),
        (cam, camAlt, ground, groundAlt, mark) => this.map.raycastBuildings(cam, camAlt, ground, groundAlt, mark),
        (point, altitude) => this.map.markGround(point, altitude),
      );
      this.combatLayer.onRemoteHit = (id) => this.players.shot(id);
      this.combatLayer.onTargetHit = (id) => this.sharedTraffic.ourHit(id);
      this.map.addLayer(this.combatLayer);
      this.applySettings(this.settings);
      this.ready = true;
      this.collisionDirty = true;
      this.say(t('status.placing'));
      // Map click → set custom spawn
      this.map.on('click', (e) => {
        if (!this.driving && this.mapShown) this.setSpawnFromClick(e.lngLat as { lng: number; lat: number });
      });
    });
    const listen = (target: EventTarget, event: string, fn: EventListener, options?: AddEventListenerOptions) => {
      target.addEventListener(event, fn, options);
      this.cleanups.push(() => target.removeEventListener(event, fn, options));
    };
    listen(window, 'keydown', ((e: KeyboardEvent) => {
      // M in the menu: rise above the map too (and come back)
      if (e.code === 'KeyM' && !e.repeat && !this.driving && this.mapShown
        && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement)) {
        if (!this.overviewTarget) {
          const c = this.map.getCenter();
          this.menuView = { center: [c.lng, c.lat], zoom: this.map.getZoom(), pitch: this.map.getPitch(), bearing: this.map.getBearing() };
        }
        this.overviewTarget = this.overviewTarget ? 0 : 1;
        e.preventDefault();
        return;
      }
      if (!this.driving || this.paused || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyR', 'Tab', 'KeyM', 'KeyJ'].includes(e.code)) e.preventDefault();
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) this.keys.add(e.code);
      if (e.code === 'KeyR') this.resetCamera();
      if (e.code === 'Tab' && !e.repeat) {
        if (this.tryOpenDealer()) { /* showroom takes Tab on the lot */ }
        else this.cycleMissionFocus();
      }
      if (e.code === 'KeyJ' && !e.repeat) this.beginRampCharge();
      if (e.code === 'KeyM' && !e.repeat) this.toggleOverview();
    }) as EventListener);
    listen(window, 'keyup', ((e: KeyboardEvent) => {
      this.keys.delete(e.code);
      if (e.code === 'KeyJ') this.commitRamp();
    }) as EventListener);
    const clear = () => {
      this.keys.clear();
      if (this.rampCharge) this.commitRamp();
      this.vehicle.speed = 0;
      this.vehicle.throttle = 0;
      this.last = 0;
      this.accumulator = 0;
      this.renderVehicle.reset(this.vehicle);
      this.dragging = false;
      this.lookPointer = null;
      this.lookOrigin = null;
      this.lookDragging = false;
      this.aimingFire = false;
      this.combatLayer?.setFiring(false);
      this.combatLayer?.setAim(null);
      this.aimHud(0, 0, false, false);
    };
    listen(window, 'blur', clear);
    listen(document, 'visibilitychange', clear);
    listen(el, 'contextmenu', (e) => e.preventDefault());
    listen(el, 'pointerdown', ((e: PointerEvent) => {
      if (this.paused) return;
      if (!this.driving || this.approachFrom) return;
      // M-map: leave the pointer to ThreeMap pan/zoom — no reticle, no orbit.
      if (this.mapInspecting()) return;
      if (e.button === 2) {
        this.dragging = true;
        el.setPointerCapture(e.pointerId);
        return;
      }
      if (e.button !== 0) return;
      const bounds = el.getBoundingClientRect();
      const x = e.clientX - bounds.left;
      const y = e.clientY - bounds.top;
      this.lookPointer = e.pointerId;
      // a mouse keeps firing wherever it moves (the right button looks around);
      // a finger that slides turns to looking around instead
      this.lookOrigin = e.pointerType === 'mouse' ? null : { x, y };
      this.lookDragging = false;
      // hold to shoot; if the pointer moves, we switch to looking around
      this.aimScreen = [x, y];
      this.updateAim();
      this.aimingFire = true;
      this.combatLayer?.setFiring(true);
      this.aimHud(x, y, true, true);
      el.setPointerCapture(e.pointerId);
    }) as EventListener);
    listen(el, 'pointerup', ((e: PointerEvent) => {
      if (e.button === 2) this.dragging = false;
      if (e.pointerId === this.lookPointer) this.endLookPointer(false);
    }) as EventListener);
    listen(window, 'pointermove', ((e: PointerEvent) => {
      if (this.paused || !this.driving || this.approachFrom || this.mapInspecting()) return;
      const bounds = this.host.getBoundingClientRect();
      const x = e.clientX - bounds.left;
      const y = e.clientY - bounds.top;
      if (this.lookPointer === e.pointerId) {
        const moved = this.lookOrigin ? Math.hypot(x - this.lookOrigin.x, y - this.lookOrigin.y) : 0;
        if (!this.lookDragging && moved > 7) {
          // drag = look around; cancel gun so the map is free to pan
          this.lookDragging = true;
          this.stopGun();
        }
        if (this.lookDragging) {
          this.orbit += e.movementX * 0.22 * this.settings.sensitivity;
          this.pitch = Math.max(cameraConfig.minPitch, Math.min(cameraConfig.maxPitch, this.pitch - e.movementY * 0.12 * this.settings.sensitivity));
        } else {
          // held still: aim and fire
          this.aimScreen = [x, y];
          this.updateAim();
          if (!this.aimingFire) {
            this.aimingFire = true;
            this.combatLayer?.setFiring(true);
          }
          this.aimHud(x, y, true, true);
        }
      }
      if (this.dragging) {
        this.orbit += e.movementX * 0.22 * this.settings.sensitivity;
        this.pitch = Math.max(cameraConfig.minPitch, Math.min(cameraConfig.maxPitch, this.pitch - e.movementY * 0.12 * this.settings.sensitivity));
      }
    }) as EventListener);
    listen(el, 'pointerleave', () => {
      if (this.lookPointer != null) return; // capture keeps look/fire going
      this.stopGun();
    });
    listen(window, 'pointercancel', ((e: PointerEvent) => {
      if (e.pointerId === this.lookPointer) this.endLookPointer(true);
      this.dragging = false;
    }) as EventListener);
    listen(el, 'wheel', ((e: WheelEvent) => {
      if (!this.driving || this.paused) return;
      // M-map: ThreeMap scrollZoom owns the wheel (pan/zoom the city).
      if (this.mapInspecting()) return;
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

  private stopGun() {
    this.aimScreen = null;
    this.aimingFire = false;
    this.combatLayer?.setFiring(false);
    this.combatLayer?.setAim(null);
    this.aimHud(0, 0, false, false);
  }

  private endLookPointer(_force: boolean) {
    this.lookPointer = null;
    this.lookOrigin = null;
    this.lookDragging = false;
    this.stopGun();
  }

  private updateAim() {
    if (!this.aimScreen || !this.driving || this.approachFrom || this.mapInspecting()) {
      this.combatLayer?.setAim(null);
      return;
    }
    const target = this.map.unproject(this.aimScreen);
    this.combatLayer?.setAim({ ground: [target.lng, target.lat], screen: this.aimScreen });
  }

  private placeTargetIndicator(marker: { element: HTMLElement; arrow: HTMLElement; distance: HTMLElement }, target: [number, number], pinMeters = MARKER_PIN_METERS) {
    placeIndicator(this.map, marker, this.vehicle.position, target, pinMeters, this.mapInspecting());
  }

  setCar(car: Car) {
    if (this.car.id === car.id && this.car.path === car.path) return;
    this.car = car;
    this.fuel.changeSpec(car.fuel);
    this.combatLayer?.setCar(car);
  }

  /** Lot catalogue for the dealership dialog. */
  private dealerState(): DealerOffer {
    return { money: Math.floor(this.playerMoney), currentId: this.car.id, tradeIn: tradeInPrice(this.car) };
  }

  /** Open the showroom when standing on a dealership lot (Tab, or slow arrival). */
  private tryOpenDealer() {
    if (!this.driving || this.mode !== 'roam' || this.dealerOpen || this.serviceOpen || this.travelOpen || this.fuelOut) return false;
    const lot = atStation(this.vehicle.position, [...this.dealerships.values()]);
    if (!lot) return false;
    this.offeredService = lot.id;
    this.dealerOpen = true;
    this.keys.clear();
    this.vehicle.speed = 0;
    this.onDealerOffer(this.dealerState());
    return true;
  }

  leaveDealer() {
    this.dealerOpen = false;
    this.onDealerOffer(null);
  }

  /** Buy `carId`: pay shelf price, get half the current car back as trade-in, swap immediately. */
  buyDealerCar(carId: string) {
    if (!this.dealerOpen) return;
    const next = carsConfig.find((c) => c.id === carId);
    if (!next || next.id === this.car.id) return;
    const net = carPrice(next) - tradeInPrice(this.car);
    if (net > this.playerMoney) return;
    this.playerMoney -= net;
    this.setCar(next);
    this.onCarBought(next);
    this.onDealerOffer(this.dealerState());
  }

  applySettings(settings: Settings) {
    const terrainChanged = settings.terrain !== this.settings.terrain;
    this.settings = settings;
    this.map.setSkin(settings.skin);
    if (!this.mapLoaded) return;
    this.map.setRelief(settings.terrain);
    const ratio = settings.quality === 'low' ? 1 : settings.quality === 'medium' ? 1.25 : Math.min(window.devicePixelRatio || 1, 1.5);
    this.map.setPixelRatio(ratio);
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
    if (!this.mapLoaded) return;
    const origin: [number, number] = [lngLat.lng, lngLat.lat];
    const start = roadStart(this.map, origin, (position, heading) => this.collisions.blocked(position, position, heading));
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
      const ground = this.map.groundAt(position);
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
    const roads = this.map.features('transportation') as MapFeature[];
    this.trafficNetwork.addFeatures(roads);
    this.trafficNetwork.flushRebuild();
    this.vehicleContactTimes.clear();
    this.placeEventBeacons(position, heading);
    this.ensureTrafficMarkers();
    this.combatLayer?.setTargets([]);
    this.combatLayer?.setRaceFinish(null);
    this.syncRoadPickups();
    this.onEventOffer(null);
  }

  private clearEventBots() {
    this.trafficBots = [];
    this.combatLayer?.setTargets([]);
    this.ensureTrafficMarkers();
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
      if (avoid.some(other => metersBetween(spot, other) < 280)) continue;
      return spot;
    }
    const ahead = this.trafficNetwork.destinationAhead(position, heading, seed);
    if (ahead && !avoid.some(other => metersBetween(ahead as [number, number], other) < 220)) return [...ahead] as [number, number];
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
    const beacons: { id: string; kind: 'arena' | 'race' | 'bounty'; position: [number, number] }[] = visible.map(mission => ({
      id: mission.id,
      kind: mission.kind,
      position: mission.position,
    }));
    if (showWorld && !this.bountyFight) {
      if (this.bountyPending && this.bountyPickup) {
        beacons.push({ id: 'bounty-pickup', kind: 'bounty', position: this.bountyPickup });
      } else if (this.bounty?.spot) {
        beacons.push({ id: 'bounty', kind: 'bounty', position: this.bounty.spot });
      }
    }
    this.combatLayer?.setMissionBeacons(beacons);
    this.ensureEventMarkers();
  }

  /** Arena/race missions plus the wanted job (pending pickup or accepted hunt). */
  private focusGoals() {
    const goals: Array<
      | { kind: 'mission'; id: string; label: string; position: [number, number] }
      | { kind: 'bounty'; label: string; position: [number, number] | null }
    > = this.missions.map(mission => ({
      kind: 'mission' as const,
      id: mission.id,
      label: mission.label,
      position: mission.position,
    }));
    if (this.bountyFight) return goals;
    if (this.bountyPending && this.bountyPickup) {
      goals.push({ kind: 'bounty', label: t('bounty.goal'), position: this.bountyPickup });
    } else if (this.bounty) {
      goals.push({
        kind: 'bounty',
        label: t('bounty.marker', { name: this.bounty.name }),
        position: this.bounty.spot ?? null,
      });
    }
    return goals;
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
    if (!this.driving || this.mode !== 'roam') return;
    const goals = this.focusGoals();
    if (goals.length < 2) return;
    this.missionFocus = (this.missionFocus + 1) % goals.length;
    const goal = goals[this.missionFocus];
    if (goal) this.say(t('mission.target', { label: goal.label }), true);
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

  /** parked cars to shoot at (?testcars=N) */
  private testCars = new TestTargets((from, at, heading) => {
    if (this.collisions.blocked(from, at, heading, 1, this.altitude) || this.water.resolve(from, at, heading).stopped) return false;
    // on the same surface as us (not the river beside a bridge, not a roof)
    const ground = this.map.groundAt(at, this.altitude);
    return ground != null && Math.abs(ground - this.altitude) <= 2;
  });

  /** Shared traffic and test cars: targets beside the missions', every frame. */
  private syncExtraTargets(dt: number, now: number) {
    const layer = this.combatLayer;
    if (!layer) return;
    const tests = this.testCars.update(now, this.driving, this.vehicle, (id) => layer.isTargetAlive(id));
    layer.setExtraTargets([...this.sharedTraffic.update(dt, now), ...tests]);
  }

  private targetVehicles() {
    return this.trafficBots.map(({ id, driver, car, position, heading }) => ({
      id, driver, car, position, heading,
    }));
  }

  private resolveVehicleContacts(now: number) {
    const participants = [
      { id: 'player', controller: this.vehicle, car: this.car },
      ...this.sharedTraffic.bots().map((bot) => ({ id: bot.id, controller: bot.controller, car: bot.car })),
      ...this.trafficBots
        .filter(bot => !this.combatLayer || this.combatLayer.isTargetAlive(bot.id))
        .map(bot => ({ id: bot.id, controller: bot.controller, car: bot.car })),
    ];
    const applyPosition = (participant: typeof participants[number], next: [number, number]) => {
      const { controller } = participant;
      if (next === controller.position
        || this.collisions.blocked(controller.position, next, controller.heading, 1, participant.id === 'player' ? this.altitude : -Infinity)
        || this.thicket.blocked(controller.position, next)) return;
      const water = this.water.resolve(controller.position, next, controller.heading);
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
        });
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
      // other players: their health as they report it; money and wins are their own business
      ...this.players.others().map((p) => ({
        id: `net:${p.id}`,
        name: p.name,
        color: PLAYER_MARKER_COLOR,
        hp: p.hp,
        maxHp: PLAYER_HP,
        money: Number.NaN,
        wins: Number.NaN,
      })),
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

  /**
   * Another player's bullet. Only while roaming (a mission is our own fight); at
   * zero we blow up, stop dead and come back with full health. True when it got us.
   */
  private hitByPlayer(name: string, damage: number): boolean {
    if (!this.driving || this.mode !== 'roam' || this.bountyFight || this.playerHp <= 0) return false;
    this.playerHp = Math.max(0, this.playerHp - damage);
    this.combatLayer?.flashPlayer(160);
    const now = performance.now();
    if (now - this.hitNoticeAt > 3000) { this.hitNoticeAt = now; this.say(t('pvp.hit', { name })); }
    if (this.playerHp > 0) return false;
    this.combatLayer?.explodePlayer();
    this.vehicle.speed = 0;
    this.playerHp = this.playerMaxHp;
    return true;
  }

  private hitNoticeAt = 0;

  /** the camera keeps north up (compass double-click) until the player turns it */
  private northUp = false;

  /**
   * Turn the view to north up, smoothly. Driving, it stays so (the car turns under
   * it) until the player turns the view; on the menu and the map it simply turns.
   */
  faceNorth() {
    if (this.driving) {
      this.northUp = true;
      this.orbit = 0;
      return;
    }
    const from = this.map.getBearing();
    const start = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - start) / 650);
      const eased = t * t * (3 - 2 * t);
      this.map.jumpTo({ bearing: from * (1 - eased) });
      if (t < 1 && !this.disposed) requestAnimationFrame(step);
    };
    step();
  }

  private damagePlayer(amount: number) {
    if (this.mode !== 'arena' || amount <= 0 || this.playerHp <= 0) return;
    this.playerHp = Math.max(0, this.playerHp - amount);
    this.combatLayer?.flashPlayer(220);
  }

  acceptEvent() {
    if (this.mode !== 'roam' || !this.driving || !this.eventOffer) return;
    const kind = this.eventOffer;
    const nearby = this.missions.find(mission => mission.kind === kind && metersBetween(this.vehicle.position, mission.position) <= 18)
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
      // Spread across neighbouring districts, then they hunt the player and each other.
      { min: 280, max: 1800 },
    ));
    for (let i = 0; i < this.trafficBots.length; i++) this.trafficBots[i].repathAt = performance.now() + i * 160;
    this.mode = 'arena';
    this.playerHp = this.playerMaxHp;
    this.vehicleContactTimes.clear();
    this.hideEventBeacons();
    this.ensureTrafficMarkers();
    this.combatLayer?.setTargets(this.targetVehicles());
    this.say(t('arena.start'), true);
  }

  private startRace() {
    const center = this.vehicle.position as [number, number];
    const heading = this.vehicle.heading;
    const seedBase = Math.round(center[0] * 1e5) ^ Math.round(center[1] * 1e5) ^ (performance.now() | 0);
    const finishSpot = this.trafficNetwork.randomAway(center, new Set(), 1800, 2200, seedBase)
      ?? this.trafficNetwork.randomAway(center, new Set(), 1400, 2600, seedBase + 41);
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
      bot.repathAt = performance.now() + index * 160; // one Dijkstra per frame, not three
      return bot;
    });
    this.mode = 'race';
    this.vehicleContactTimes.clear();
    this.hideEventBeacons();
    this.combatLayer?.setRaceFinish(this.raceGoal);
    this.ensureRaceGoalMarker();
    this.ensureTrafficMarkers();
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
    this.onEventResult({ kind: 'arena', won });
  }

  private endRace(winnerId: string, winnerName: string) {
    if (this.mode !== 'race') return;
    this.mode = 'roam';
    this.eventCooldown = performance.now() + 8000;
    const won = winnerId === 'player';
    if (won) {
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
    this.onEventResult({ kind: 'race', won, name: won ? undefined : winnerName });
  }

  /** Everybody with a health meter over the car: us, mission bots, other players, shared traffic and test cars. */
  private meterTargets(): { id: string; name: string; hp: number; maxHp: number; position: Position }[] {
    const layer = this.combatLayer;
    const out = [{ id: 'player', name: t('you'), hp: this.playerHp, maxHp: this.playerMaxHp, position: this.renderVehicle.position }];
    for (const p of this.players.others()) out.push({ id: `net:${p.id}`, name: p.name, hp: p.hp, maxHp: PLAYER_HP, position: p.position });
    const health = new Map((layer?.targetHealth() ?? []).map((h) => [h.id, h]));
    for (const bot of this.trafficBots) {
      if (layer && !layer.isTargetAlive(bot.id)) continue;
      const h = health.get(bot.id);
      out.push({ id: bot.id, name: bot.driver, hp: h?.hp ?? 1000, maxHp: h?.maxHp ?? 1000, position: bot.position });
    }
    for (const e of layer?.extraHealth() ?? []) out.push({ id: e.id, name: e.driver, hp: e.hp, maxHp: e.maxHp, position: e.position });
    return out;
  }

  private updateHealthMarkers(refill = true) {
    if (!this.driving) { this.healthMeters.hide(); return; }
    const canvas = this.map.getCanvas();
    this.healthMeters.update(this.meterTargets(), (p) => this.map.project(p), canvas.clientWidth, canvas.clientHeight, refill);
  }

  private syncRoadPickups() {
    const position = this.vehicle.position;
    if (this.pickupNetworkRevision === this.trafficNetwork.revision
      && this.pickupFocus
      && metersBetween(this.pickupFocus, position) < 120) return;

    for (const [id, pickup] of this.pickups) {
      if (metersBetween(position, pickup.position) <= 800) continue;
      this.pickups.delete(id);
    }

    for (const pickup of this.trafficNetwork.pickupLocations(position)) {
      if (this.pickups.has(pickup.id) || this.collectedPickups.has(pickup.id)) continue;
      let hash = 0;
      for (const character of pickup.id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
      this.pickups.set(pickup.id, {
        position: pickup.position,
        color: PICKUP_COLORS[hash % PICKUP_COLORS.length],
        kind: 'ball',
      });
    }
    // big spinning coins: as many as balls, halfway between them
    for (const spot of this.trafficNetwork.pickupLocations(position, 650, 80, 0)) {
      const id = `coin:${spot.id}`;
      if (this.pickups.has(id) || this.collectedPickups.has(id)) continue;
      this.pickups.set(id, { position: spot.position, color: '#f2c230', kind: 'coin' });
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
      kind: pickup.kind,
    }));
  }

  private collectRoadPickups() {
    const collect = (position: [number, number]) => {
      let money = 0;
      for (const [id, pickup] of this.pickups) {
        if (metersBetween(position, pickup.position) > 3.5) continue;
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

  /** Send a chat line to everybody. */
  chat(text: string) { this.players.say(text); }

  /** Join the shared world under this name (again: just a rename). */
  joinNetwork(name: string) { this.players.join(name); }

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
      const marker = nameIndicator('traffic-indicator', TRAFFIC_MARKER_COLORS[index % TRAFFIC_MARKER_COLORS.length]);
      marker.name.textContent = bot.driver;
      markerLayer.appendChild(marker.element);
      this.trafficMarkers.set(bot.id, marker);
    });
  }

  private updateTrafficMarkers() {
    for (const marker of this.trafficMarkers.values()) marker.element.style.display = 'none';
    if (!this.driving || !this.trafficBots.length) return;
    this.trafficBots.forEach((bot, index) => {
      const marker = this.trafficMarkers.get(bot.id);
      if (!marker) return;
      const dead = !(this.combatLayer?.isTargetAlive(bot.id) ?? true);
      marker.element.style.setProperty(
        '--traffic-color',
        dead ? '#8b9198' : TRAFFIC_MARKER_COLORS[index % TRAFFIC_MARKER_COLORS.length],
      );
      marker.element.classList.toggle('is-dead', dead);
      this.placeTargetIndicator(marker, bot.position, MARKER_PIN_METERS);
    });
  }

  private updateEvents() {
    if (!this.driving) return;
    this.updateBounty();
    if (this.bountyFight) {
      if (this.playerHp <= 0) this.endBounty(false);
      else if (this.trafficBots.length && this.combatLayer && this.combatLayer.aliveTargetCount() === 0) this.endBounty(true);
      return;
    }
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
      // Generous radius — flag is a point; cars need room to count as finished.
      if (metersBetween(this.vehicle.position, this.raceGoal) <= 28) {
        this.endRace('player', t('you'));
        return;
      }
      const winner = this.trafficBots.find(bot =>
        this.combatLayer?.isTargetAlive(bot.id) && metersBetween(bot.position, this.raceGoal!) <= 28,
      );
      if (winner) this.endRace(winner.id, winner.driver);
      return;
    }
    this.refillMissions();
    if (this.eventOffer || performance.now() < this.eventCooldown) return;
    const nearby = this.missions.find(mission => metersBetween(this.vehicle.position, mission.position) <= 14);
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
    if (!visible || !target) {
      marker.element.style.display = 'none';
      return;
    }
    if (titleText && marker.title) marker.title.textContent = titleText;
    // missions stay on the edge until close — no on-car pin
    this.placeTargetIndicator(marker, target, 0);
  }

  /** Spawn a local wanted pin now and then; take the job there, then hunt the city. */
  private updateBounty() {
    const now = performance.now();
    const here = this.vehicle.position;
    if (this.bountyPending && !this.bounty) {
      if (this.mode !== 'roam' || this.bountyFight) return;
      if (
        this.bountyPickup
        && !this.bountyOfferShown
        && !this.eventOffer
        && !this.travelOpen
        && !this.serviceOpen
        && !this.dealerOpen
        && !this.fuelOut
        && now > this.bountyApproachCooldown
        && metersBetween(here, this.bountyPickup) <= 14
      ) {
        this.bountyOfferShown = true;
        this.onBountyOffer(this.bountyOfferOf(this.bountyPending));
      }
      return;
    }
    if (!this.bounty) {
      const busy = this.mode !== 'roam' || this.bountyPending || this.eventOffer || this.travelOpen || this.serviceOpen || this.dealerOpen || this.fuelOut;
      if (busy || now < this.bountyOfferAt) return;
      this.bountyPending = makeBounty(here);
      const seed = Math.round(here[0] * 1e5) ^ Math.round(here[1] * 1e5) ^ (now | 0);
      this.bountyPickup = this.pickBeaconSpot(
        here as [number, number],
        this.vehicle.heading,
        seed,
        this.missions.map(mission => mission.position),
      );
      this.bountyOfferShown = false;
      this.syncMissionVisuals(true);
      this.say(t('mission.new', { label: t('bounty.goal') }), true);
      return;
    }
    const bounty = this.bounty;
    if (this.bountyFight || this.mode !== 'roam') return;
    // in the target's city: pin the exact spot on a road near its centre
    if (!bounty.spot && kilometres(here, bounty.place.coords) < 2.5) {
      const node = this.trafficNetwork.nearest(bounty.place.coords, new Set(), 0, 1500);
      if (node) {
        bounty.spot = [...node.position] as [number, number];
        saveBounty(bounty);
        this.syncMissionVisuals(true);
      }
    }
    if (bounty.spot && now > this.bountyRetryAt && metersBetween(here, bounty.spot) < 650) this.startBountyFight(bounty);
  }

  private bountyOfferOf(bounty: Bounty): BountyOffer {
    return {
      name: bounty.name,
      car: carsConfig.find((car) => car.id === bounty.car)?.name ?? '',
      place: bounty.place.name,
      country: bounty.place.country,
      km: Math.round(kilometres(this.vehicle.position, bounty.place.coords)),
      reward: bounty.reward,
    };
  }

  acceptBounty() {
    if (!this.bountyPending) return;
    this.bounty = this.bountyPending;
    this.bountyPending = null;
    this.bountyPickup = null;
    this.bountyOfferShown = false;
    this.bountyMarker?.remove();
    this.bountyMarker = null;
    saveBounty(this.bounty);
    this.onBountyOffer(null);
    this.syncMissionVisuals(true);
    const goals = this.focusGoals();
    const bountyIndex = goals.findIndex(goal => goal.kind === 'bounty');
    if (bountyIndex >= 0) this.missionFocus = bountyIndex;
    const km = Math.round(kilometres(this.vehicle.position, this.bounty.place.coords));
    this.say(t('bounty.accepted', { place: this.bounty.place.name, km: formatNumber(km) }), true);
  }

  declineBounty() {
    // leave the pin; approach again after a short cooldown
    this.bountyOfferShown = false;
    this.bountyApproachCooldown = performance.now() + 14000;
    this.onBountyOffer(null);
  }

  /** The wanted car shows up at its spot and comes for the player. */
  private startBountyFight(bounty: Bounty) {
    const spot = bounty.spot!;
    const car = carsConfig.find((entry) => entry.id === bounty.car) ?? carsConfig[carsConfig.length - 1];
    const seed = Math.round(spot[0] * 1e5) ^ Math.round(spot[1] * 1e5);
    this.trafficBots = [createTrafficBot('wanted', bounty.name, car, this.trafficNetwork, spot, 0, new Set(), 'hunt', seed, { min: 0, max: 160 })];
    this.mode = 'arena';
    this.bountyFight = true;
    this.playerHp = this.playerMaxHp;
    this.vehicleContactTimes.clear();
    this.hideEventBeacons();
    this.bountyMarker?.remove();
    this.bountyMarker = null;
    this.ensureTrafficMarkers();
    this.combatLayer?.setTargets(this.targetVehicles());
    this.say(t('bounty.found', { name: bounty.name }), true);
  }

  private endBounty(won: boolean) {
    const bounty = this.bounty;
    this.mode = 'roam';
    this.bountyFight = false;
    this.playerHp = this.playerMaxHp;
    this.clearEventBots();
    this.showEventBeacons();
    if (won && bounty) {
      this.playerMoney += bounty.reward;
      this.addWin('player');
      this.say(t('bounty.won', { name: bounty.name, reward: formatNumber(bounty.reward) }), true);
      this.bounty = null;
      saveBounty(null);
      this.bountyOfferAt = performance.now() + 60000;
    } else {
      this.say(t('bounty.escaped', { name: bounty?.name ?? '' }), true);
      this.bountyRetryAt = performance.now() + 20000;
    }
  }

  /** Where the hunt points: pickup pin, the wanted car, its spot, or (far away) its city. */
  private updateBountyMarkers() {
    const pending = Boolean(this.bountyPending && this.bountyPickup && !this.bounty);
    const bounty = this.bountyFight ? null : (this.bounty ?? this.bountyPending);
    if (!bounty || !this.driving || (pending && !this.bountyPickup)) {
      if (this.bountyIndicator) this.bountyIndicator.element.style.display = 'none';
      if (this.bountyMarker) { this.bountyMarker.remove(); this.bountyMarker = null; }
      return;
    }
    if (!this.eventIndicatorLayer) {
      this.eventIndicatorLayer = document.createElement('div');
      this.eventIndicatorLayer.className = 'mission-indicators';
      this.host.appendChild(this.eventIndicatorLayer);
    }
    if (!this.bountyIndicator) {
      this.bountyIndicator = this.makeOffscreenIndicator('focus', '');
      this.bountyIndicator.element.classList.replace('mission-focus-indicator', 'bounty-indicator');
      this.eventIndicatorLayer.appendChild(this.bountyIndicator.element);
    }
    const title = pending ? t('bounty.goal') : t('bounty.marker', { name: bounty.name });
    const pin = pending ? this.bountyPickup : (bounty.spot && !this.bountyFight ? bounty.spot : null);
    if (pin) {
      if (!this.bountyMarker) {
        this.bountyMarker = this.marker({ element: this.makeMapLabel('bounty-map-marker', title, title), anchor: 'bottom' }).setLngLat(pin).addTo(this.map);
      } else {
        this.bountyMarker.setLngLat(pin);
        const label = this.bountyMarker.getElement()?.querySelector('span');
        if (label) label.textContent = title;
      }
    } else if (this.bountyMarker) {
      this.bountyMarker.remove();
      this.bountyMarker = null;
    }
    const bot = this.bountyFight ? this.trafficBots[0] : null;
    const near = pending
      ? this.bountyPickup
      : bot
        ? bot.position
        : bounty.spot && metersBetween(this.vehicle.position, bounty.spot) < 2000
          ? bounty.spot
          : null;
    const target = near ?? bounty.spot ?? bounty.place.coords;
    this.bountyIndicator.title.textContent = title;
    this.placeTargetIndicator(this.bountyIndicator, target, near ? MARKER_PIN_METERS : 0);
  }

  /** Trains run in the menu and while driving; born and retired out of sight. */
  private updateTrains(dt: number) {
    if (!this.trainLayer || !this.mapShown) return;
    const center = this.map.getCenter();
    const here: [number, number] = this.driving ? this.vehicle.position : [center.lng, center.lat];
    const bearing = this.map.getBearing();
    // behind the camera = more than ~110° off where it looks
    const hidden = (p: [number, number]) => {
      const off = Math.abs(((bearingTo(here, p) - bearing + 540) % 360) - 180);
      return off > 110;
    };
    this.trainTraffic.update(dt, here, hidden);
    this.trainLayer.setCars(this.trainTraffic.poses(), here, this.settings.terrain);
  }

  private updateEventMarkers() {
    this.updateBountyMarkers();
    const roaming = this.driving && this.mode === 'roam';
    const goals = this.focusGoals();
    if (this.missionFocus >= goals.length) this.missionFocus = Math.max(0, goals.length - 1);
    const focused = roaming ? goals[this.missionFocus] ?? null : null;
    const mission = focused?.kind === 'mission' ? focused : null;
    this.updateOffscreenMarker(this.focusIndicator, mission?.position ?? null, Boolean(mission), mission?.label);
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

  /**
   * OSM fuel/repair POIs often sit inside the shop building. Snap them to the
   * nearest free road so the canopy and the dialog are reachable from the street.
   */
  private placeService(station: Station): Station {
    if (!this.mapLoaded) return station;
    const start = roadStart(
      this.map,
      station.position,
      (position, heading) => this.collisions.blocked(position, position, heading),
      60,
    );
    // drive up on the road in front; the label stays over the shop itself
    return start ? { id: station.id, position: [...start.position], place: station.position } : station;
  }

  /** Real petrol stations from the POI layer; remembered as the player drives on. */
  private collectStations() {
    const pois = this.readSourceLayer('poi');
    this.collectHubs(pois);
    for (const station of stationsFromFeatures(pois)) {
      if (this.stations.has(station.id)) continue;
      if ([...this.stations.values()].some(known => metersBetween(known.place ?? known.position, station.position) < 35)) continue;
      this.stations.set(station.id, this.placeService(station));
    }
    // keep the nearest few hundred; far ones come back when we drive there again
    if (this.stations.size > 300) {
      const keep = [...this.stations.values()].sort((a, b) => metersBetween(a.position, this.vehicle.position) - metersBetween(b.position, this.vehicle.position)).slice(0, 300);
      this.stations = new Map(keep.map(station => [station.id, station]));
    }
    for (const shop of repairShopsFromFeatures(pois)) {
      if (this.repairShops.has(shop.id)) continue;
      if ([...this.repairShops.values()].some(known => metersBetween(known.place ?? known.position, shop.position) < 35)) continue;
      this.repairShops.set(shop.id, this.placeService(shop));
    }
    for (const shop of dealershipsFromFeatures(pois)) {
      if (this.dealerships.has(shop.id)) continue;
      if ([...this.dealerships.values()].some(known => metersBetween(known.place ?? known.position, shop.position) < 35)) continue;
      this.dealerships.set(shop.id, this.placeService(shop));
    }
    const visible = [...this.stations.values()].filter(station => metersBetween(station.position, this.vehicle.position) < 2500);
    this.fuelLayer?.setStations(visible, this.settings.terrain);
    this.labelServices();
  }

  /** Map labels for the nearest fuel stations, car services and dealerships. */
  private labelServices() {
    const here = this.vehicle.position;
    const nearest = (list: Station[]) => list
      .map(station => ({ station, d: metersBetween(station.position, here) }))
      .filter(item => item.d < 3000)
      .sort((a, b) => a.d - b.d)
      .slice(0, 10)
      .map(item => item.station);
    const wanted = new Map<string, { station: Station; kind: 'fuel' | 'repair' | 'dealer' }>();
    for (const station of nearest([...this.stations.values()])) wanted.set(station.id, { station, kind: 'fuel' });
    for (const shop of nearest([...this.repairShops.values()])) wanted.set(shop.id, { station: shop, kind: 'repair' });
    for (const shop of nearest([...this.dealerships.values()])) wanted.set(shop.id, { station: shop, kind: 'dealer' });
    for (const [id, marker] of this.serviceMarkers) {
      if (wanted.has(id)) continue;
      marker.remove();
      this.serviceMarkers.delete(id);
    }
    const label: Record<'fuel' | 'repair' | 'dealer', string> = {
      fuel: t('poi.fuel'), repair: t('poi.service'), dealer: t('poi.dealer'),
    };
    for (const [id, { station, kind }] of wanted) {
      if (this.serviceMarkers.has(id)) continue;
      const text = label[kind];
      this.serviceMarkers.set(id, this.marker({ element: this.makeMapLabel(`travel-hub-marker is-${kind}`, text, text), anchor: 'bottom' }).setLngLat(station.place ?? station.position).addTo(this.map));
    }
  }

  /** Ports, airports and railway stations from real data, with a map label each. */
  private collectHubs(pois: MapFeature[]) {
    for (const hub of hubsFromFeatures(this.readSourceLayer('aerodrome_label'), pois)) {
      if (!this.hubs.has(hub.id)) this.hubs.set(hub.id, hub);
    }
    const here = this.vehicle.position;
    const hubLabel: Record<HubKind, string> = { airport: t('hub.airport'), port: t('hub.port'), station: t('hub.station') };
    for (const hub of this.hubs.values()) {
      const near = metersBetween(hub.position, here) < 6000;
      const marker = this.hubMarkers.get(hub.id);
      if (near && !marker) {
        const text = hubLabel[hub.kind];
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
    const target = this.bounty ? { name: this.bounty.place.name, country: this.bounty.place.country, coords: [...this.bounty.place.coords] as [number, number] } : undefined;
    this.onTravelOffer({ kind: hub.kind, from: [...this.vehicle.position], money: Math.floor(this.playerMoney), target });
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

  private updateFuel(_dt: number) {
    const station = atStation(this.vehicle.position, [...this.stations.values()]);
    const shop = atStation(this.vehicle.position, [...this.repairShops.values()]);
    const dealer = atStation(this.vehicle.position, [...this.dealerships.values()]);
    this.refuelling = false;
    // arriving (slowly) at a station, service or showroom opens its dialog once per visit
    const here = station ?? shop ?? dealer;
    if (!here) this.offeredService = null;
    else if (here.id !== this.offeredService && Math.abs(this.vehicle.speed) < 7 && !this.serviceOpen && !this.dealerOpen && !this.travelOpen && !this.fuelOut && this.mode === 'roam') {
      this.offeredService = here.id;
      if (dealer && here.id === dealer.id) this.tryOpenDealer();
      else this.openService(station ? 'fuel' : 'repair');
    }
    if (this.fuel.empty && Math.abs(this.vehicle.speed) < 0.3 && !this.fuelOut && !station) {
      this.fuelOut = true;
      this.keys.clear();
      this.onFuelOut(true);
    }
  }

  private serviceState(kind: ServiceOffer['kind']): ServiceOffer {
    return kind === 'fuel'
      ? { kind, level: this.fuel.level, tank: this.fuel.spec.tank, money: Math.floor(this.playerMoney), price: FUEL_PRICE }
      : { kind, hp: this.playerHp, maxHp: this.playerMaxHp, money: Math.floor(this.playerMoney), price: REPAIR_PRICE };
  }

  private openService(kind: ServiceOffer['kind']) {
    this.serviceOpen = kind;
    this.keys.clear();
    this.vehicle.speed = 0;
    this.onServiceOffer(this.serviceState(kind));
  }

  /** Fill the tank (or as much as the coins allow) at the station. */
  buyFuel() {
    if (this.serviceOpen !== 'fuel') return;
    const room = this.fuel.spec.tank - this.fuel.level;
    const litres = Math.max(0, Math.min(room, Math.floor(this.playerMoney / FUEL_PRICE)));
    this.fuel.level += litres;
    this.playerMoney -= litres * FUEL_PRICE;
    this.onServiceOffer(this.serviceState('fuel'));
  }

  /** Repair the car (as far as the coins allow) at the service. */
  repairCar() {
    if (this.serviceOpen !== 'repair') return;
    const missing = this.playerMaxHp - this.playerHp;
    const points = Math.max(0, Math.min(missing, Math.floor(this.playerMoney / REPAIR_PRICE)));
    this.playerHp += points;
    this.playerMoney -= Math.ceil(points * REPAIR_PRICE);
    this.onServiceOffer(this.serviceState('repair'));
  }

  leaveService() {
    this.serviceOpen = null;
    this.onServiceOffer(null);
  }

  /** Tow truck: to the nearest known station, for EVACUATION_COST coins. */
  evacuate() {
    if (!this.fuelOut) return;
    const near = nearestStation(this.vehicle.position, [...this.stations.values()]);
    if (near && this.mapLoaded) {
      const start = roadStart(this.map, near.station.position, (position, heading) => this.collisions.blocked(position, position, heading));
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
    return new ThreeMarker(options) as unknown as MapMarker;
  }

  /** Our own world under the game. */
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
    this.host.style.transition = 'opacity .7s ease';
    this.host.style.opacity = '1';
    this.onBoot(true);
    this.say(t('status.ready'));
    // Enable map navigation for the intro screen (pan, zoom, right-drag rotate).
    this.map.setInteractive({ pan: true, rotate: true });
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
      if (!this.map.hasGround()) {
        this.say(t('status.terrain'));
        return;
      }
      const ground = this.map.groundAt(this.vehicle.position);
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
    if (this.collisionDirty || this.worldWork) {
      this.say(t('status.blocks'));
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
    // the view from above belongs to one mode; switching modes lands back on the ground
    this.overview = 0;
    this.overviewTarget = 0;
    this.overviewFree = false;
    this.overviewLeave = null;
    this.menuView = null;
    const fromMenu = value && !this.driving && approach;
    this.driving = value;
    this.paused = false;
    if (!value) {
      this.eventOffer = null;
      this.onEventOffer(null);
      this.onEventResult(null);
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
        // Re-enable map navigation for intro
        this.map.setInteractive({ pan: true, rotate: true });
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
    this.map.setInteractive({ pan: false, rotate: false });
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

  private rampGroundAt(point: [number, number]) {
    return this.map.groundAt(point) ?? this.altitude;
  }

  private rampPose(length: number, start: [number, number], heading: number) {
    const end = offsetPosition(start, Math.sin(heading) * length, Math.cos(heading) * length) as [number, number];
    const ground = this.rampGroundAt(start);
    const tilt = Math.atan2(this.rampGroundAt(end) - ground, length);
    const height = length * RAMP.grade;
    return { ground, tilt, height, width: RAMP.width };
  }

  private showRampAt(start: [number, number], heading: number, length: number, usedAt = 0) {
    const { ground, tilt, height, width } = this.rampPose(length, start, heading);
    this.ramp = { start, heading, usedAt, length, height, width };
    this.combatLayer?.setRamp({ position: start, heading, ground, tilt, length, height, width });
  }

  /** Hold J: start a growing preview ahead of the nose. */
  beginRampCharge() {
    if (!this.driving || this.paused || this.airborne) return;
    const heading = this.vehicle.heading;
    const start = offsetPosition(
      this.vehicle.position,
      Math.sin(heading) * this.car.length * 1.5,
      Math.cos(heading) * this.car.length * 1.5,
    ) as [number, number];
    const length = RAMP.minLength;
    this.rampCharge = { start, heading, ground: this.rampGroundAt(start), length };
    this.showRampAt(start, heading, length);
  }

  /** Release J: lock the charged size in place (through anything). */
  commitRamp() {
    const charge = this.rampCharge;
    this.rampCharge = null;
    if (!charge || !this.driving) return;
    this.showRampAt(charge.start, charge.heading, charge.length);
  }

  /** Height of the ramp surface under this point (driving onto it head-on), or null. */
  private rampLift(position: [number, number]) {
    const ramp = this.ramp;
    if (!ramp || ramp.usedAt) return null;
    if (Math.cos(this.vehicle.heading - ramp.heading) < 0.5) return null;
    const east = (position[0] - ramp.start[0]) * METERS_PER_DEGREE * Math.cos(ramp.start[1] * Math.PI / 180);
    const north = (position[1] - ramp.start[1]) * METERS_PER_DEGREE;
    const along = east * Math.sin(ramp.heading) + north * Math.cos(ramp.heading);
    const side = east * Math.cos(ramp.heading) - north * Math.sin(ramp.heading);
    if (along < 0 || along > ramp.length || Math.abs(side) > ramp.width / 2 + 0.3) return null;
    return along / ramp.length * ramp.height;
  }

  /** Grow the preview while J is held; clear the ramp after a jump or when left behind. */
  private updateRamp(now: number, dt: number) {
    if (this.rampCharge && this.driving && !this.paused) {
      this.rampCharge.length = Math.min(RAMP.maxLength, this.rampCharge.length + RAMP.growPerSec * dt);
      this.showRampAt(this.rampCharge.start, this.rampCharge.heading, this.rampCharge.length);
      return;
    }
    const ramp = this.ramp;
    if (!ramp) return;
    const far = metersBetween(ramp.start, this.vehicle.position) > 300;
    if (far || (ramp.usedAt && now - ramp.usedAt > 900)) {
      this.ramp = null;
      this.combatLayer?.setRamp(null);
    }
  }

  plantWheels(dt: number, now = performance.now()) {
    const settle = (current: number, target: number) => {
      const gap = target - current;
      const rate = 14 + Math.min(22, Math.abs(gap) * 8);
      return current + gap * (1 - Math.exp(-dt * rate));
    };
    if (!this.wheelTargets.ready || now - this.wheelSampleTime >= 48) {
      this.wheelSampleTime = now;
      const heading = this.renderVehicle.heading;
      const forwardEast = Math.sin(heading);
      const forwardNorth = Math.cos(heading);
      const rightEast = Math.cos(heading);
      const rightNorth = -Math.sin(heading);
      const reach = this.car.length * 0.38;
      const track = 0.85;
      // terrain and roofs both support the car; clear a building only above its skin
      const sample = (along: number, side: number) => {
        const at = offsetPosition(this.renderVehicle.position, forwardEast * along + rightEast * side, forwardNorth * along + rightNorth * side);
        const terrain = this.map.groundAt(at);
        // a roof carries the car only if it came from above (a jump, a landing): one far above
        // its wheels is a wall it is touching — long cars' bumpers reach past the wall
        // test, and taking that roof as ground used to lift them onto houses like a ramp
        const top = this.collisions.supportAt(at);
        const roof = top != null && top <= this.altitude + 0.6 ? top : null;
        if (terrain == null && roof == null) return null;
        return Math.max(terrain ?? -Infinity, roof ?? -Infinity);
      };
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
        const bumper = this.car.length * 0.5;
        add(bumper, 0, sample(bumper, 0));
        add(-bumper, 0, sample(-bumper, 0));
        this.wheelTargets = {
          altitude: supportAltitude(supports, pitch, roll),
          pitch: this.settings.terrain ? pitch : 0,
          roll: this.settings.terrain ? roll : 0,
          ready: true,
        };
      }
    }
    if (!this.wheelTargets.ready) return;
    const clamp = (value: number) => Math.max(-0.5, Math.min(0.5, value));
    const lift = this.driving ? this.rampLift(this.renderVehicle.position) : null;
    const ground = this.wheelTargets.altitude + (lift ?? 0);
    const speed = Math.abs(this.vehicle.speed);
    if (this.airborne) {
      // flying: gravity only; the nose follows the flight path
      this.climb -= GRAVITY * dt;
      this.altitude += this.climb * dt;
      this.modelPitch = settle(this.modelPitch, clamp(Math.atan2(this.climb, Math.max(4, speed)) * 0.8));
      this.modelRoll = settle(this.modelRoll, 0);
      if (this.altitude <= ground) {
        this.altitude = ground;
        this.airborne = false;
        this.climb = 0;
      }
      return;
    }
    // the ground falls away faster than gravity can pull the car down: it flies
    const predicted = this.altitude + this.climb * dt - 0.5 * GRAVITY * dt * dt;
    if (speed > 5 && ground < predicted - 0.3) {
      this.airborne = true;
      this.altitude = predicted;
      this.climb -= GRAVITY * dt;
      if (this.wasOnRamp && this.ramp) this.ramp.usedAt = now;
      this.wasOnRamp = false;
      return;
    }
    const before = this.altitude;
    if (lift != null) {
      // on the ramp: straight up its slope
      this.altitude = ground;
      // up its slope — bigger ramps throw higher
      const ramp = this.ramp!;
      const kick = Math.sqrt(2 * GRAVITY * Math.max(0.8, ramp.height * 1.4));
      this.climb = Math.min(kick, this.vehicle.speed * Math.cos(this.vehicle.heading - ramp.heading) * RAMP.grade);
      this.modelPitch = settle(this.modelPitch, Math.atan2(ramp.height, ramp.length));
    } else {
      this.altitude = Math.max(ground, settle(this.altitude, ground));
      const measured = (this.altitude - before) / Math.max(dt, 1e-3);
      this.climb += (measured - this.climb) * (1 - Math.exp(-dt * 8));
      this.modelPitch = settle(this.modelPitch, this.wheelTargets.pitch);
    }
    this.modelRoll = settle(this.modelRoll, this.wheelTargets.roll);
    this.wasOnRamp = lift != null;
  }

  private readSourceLayer(layer: string) {
    try {
      const features = this.map.features(layer) as MapFeature[];
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
    const start = roadStart(this.map, this.vehicle.position, (position, heading) => this.collisions.blocked(position, position, heading));
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
    const world = this.map.world;
    if (refreshTiles) this.tilesIngested = true;
    this.collisions.update(this.vehicle.position, world.buildingsNear(this.vehicle.position, 260, this.map.exaggeration));
    yield null;
    // place the car on a road only once roads around it are actually in
    if (!this.spawnResolved && this.map.features('transportation').length) this.resolveSpawn();
    const center = this.map.getCenter();
    const focus: [number, number] = this.driving ? this.vehicle.position : [center.lng, center.lat];
    this.syncedAt = [focus[0], focus[1]];
    yield null;
    yield* this.collectGround(refreshTiles, focus);
  }

  *collectWorldSteps(refreshTiles: boolean): Generator<null, void> {
    yield* this.collectWorldThree(refreshTiles);
  }

  /** Roads, water, green areas and stations for collisions and gameplay. */
  private *collectGround(refreshTiles: boolean, focus: [number, number]): Generator<null, void> {
    if (refreshTiles) {
      this.cachedWater = this.readSourceLayer('water');
      yield null;
      this.cachedRoads = this.readSourceLayer('transportation');
      this.rails.addFeatures(this.cachedRoads);
      this.rails.prune(focus, 6000);
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

  }

  /** Is this tile ("z/x/y") within reach of the gameplay data around the car? */
  private nearCar(key: string) {
    const [z, x, y] = key.split('/').map(Number);
    if (![z, x, y].every(Number.isFinite)) return true;
    const [lng, lat] = this.vehicle.position;
    return distanceToTile(mercatorX(lng), mercatorY(lat), { z, x, y }, Math.cos(lat * Math.PI / 180)) <= NEAR_TILE_METERS;
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

    if (!this.worldWork && this.mapLoaded) {
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
    // background reading gets a slice of the frame; the map view (M) keeps it small
    const deadline = performance.now() + (this.driving || this.overview > 0 ? 2.2 : 8);
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
        this.vehicle.step(1 / 60, driveKeys, { ...vehicleConfig, acceleration: this.car.acceleration, maxSpeed: this.car.maxSpeed });
        // consumption follows the car's own distance (scale-independent)
        this.fuel.burn((this.vehicle.distance - travelled), 1 / 60, driveKeys.has('Space'));
        {
          const building = this.collisions.resolve(previous, this.vehicle.position, this.vehicle.heading, 1, this.altitude);
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
            const hit = this.water.resolve(previous, this.vehicle.position, this.vehicle.heading);
            this.vehicle.position = hit.position;
            if (hit.stopped) {
              this.vehicle.speed = 0;
              shore = true;
            } else if (Math.abs(this.vehicle.speed) > 1.5 && this.map.knockDown(previous, this.vehicle.position, this.altitude)) {
              // a tree or lamp post goes down under the bumper; the car loses some pace
              this.vehicle.speed *= 0.72;
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
          }, peers);
          const building = this.collisions.resolve(previous, bot.position, bot.heading);
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
            const hit = this.water.resolve(previous, bot.position, bot.heading);
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
        this.players.bump(now);
        this.collectRoadPickups();
        this.accumulator -= 1 / 60;
      }
      if (this.trafficBots.length) this.combatLayer?.updateTargets(this.targetVehicles());
      this.syncExtraTargets(dt, now);
      this.updateFuel(dt);
      this.updateTravel();
      if (blocked) this.say(t('hint.building'));
      else if (thicket) this.say(t('hint.thicket'));
      else if (shore) this.say(t('hint.shore'));
      else if ([t('hint.building'), t('hint.thicket'), t('hint.shore')].includes(this.message)) this.say('');
      this.updateEvents();
      this.renderVehicle.update(this.vehicle, this.accumulator * 60);
      this.plantWheels(dt, now);
      this.updateRamp(now, dt);
      this.nudgeCamera(dt);
      // north up (compass double-click) until the player turns the view themselves
      if (this.northUp && this.orbit !== 0) {
        this.northUp = false;
        if (this.settings.follow) this.orbit += this.bearing - this.renderVehicle.heading * 180 / Math.PI;
      }
      const targetBearing = this.northUp ? 0 : (this.settings.follow ? this.renderVehicle.heading * 180 / Math.PI : this.bearing) + this.orbit;
      const delta = ((targetBearing - this.bearing + 540) % 360) - 180;
      if (this.northUp || this.settings.follow) this.bearing += delta * (1 - Math.exp(-dt * 5));
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
      // map view from above: blend in, then free pan/zoom; blend out from where you were looking
      const step = dt / 1.2;
      this.overview = this.overviewTarget > this.overview ? Math.min(this.overviewTarget, this.overview + step) : Math.max(this.overviewTarget, this.overview - step);
      if (this.overviewTarget > 0 && this.overview > 0.98) {
        if (!this.overviewFree) {
          this.overviewFree = true;
          this.setOverviewMapNav(true);
          this.stopGun();
        }
        const c = this.map.getCenter();
        center = [c.lng, c.lat];
        zoomNow = this.map.getZoom();
        pitchNow = 0;
        bearingNow = 0;
      } else if (this.overview > 0) {
        const e = this.overview * this.overview * (3 - 2 * this.overview);
        const topZoom = this.overviewZoom(this.renderVehicle.position[1]);
        const here = this.renderVehicle.position;
        if (this.overviewTarget < 1 && this.overviewLeave) {
          // leaving: from the inspected spot back to chase
          center = [
            this.overviewLeave.center[0] * e + center[0] * (1 - e),
            this.overviewLeave.center[1] * e + center[1] * (1 - e),
          ];
          zoomNow = this.overviewLeave.zoom * e + zoomNow * (1 - e);
        } else {
          center = [center[0] + (here[0] - center[0]) * e, center[1] + (here[1] - center[1]) * e];
          zoomNow += (topZoom - zoomNow) * e;
        }
        pitchNow += (0 - pitchNow) * e;
        bearingNow -= (((bearingNow + 540) % 360) - 180) * e;
        if (this.overviewFree) {
          this.overviewFree = false;
          this.setOverviewMapNav(false);
        }
      } else if (this.overviewLeave) {
        this.overviewLeave = null;
      }
      this.map.jumpTo({ center, zoom: zoomNow, pitch: pitchNow, bearing: bearingNow, elevation: this.altitude });
      this.map.setFocusCar(this.renderVehicle.position, this.altitude, this.renderVehicle.heading, this.modelPitch);
      this.updateAim();
    } else if (!this.driving) {
      this.map.setFocusCar(null);
      // menu: view from above toggled with M
      if (this.menuView && (this.overview > 0 || this.overviewTarget > 0)) {
        const step = dt / 1.2;
        this.overview = this.overviewTarget > this.overview ? Math.min(1, this.overview + step) : Math.max(0, this.overview - step);
        const e = this.overview * this.overview * (3 - 2 * this.overview);
        const v = this.menuView;
        this.map.jumpTo({
          center: v.center,
          zoom: v.zoom + (this.overviewZoom(v.center[1]) - v.zoom) * e,
          pitch: v.pitch * (1 - e),
          bearing: v.bearing - (((v.bearing + 540) % 360) - 180) * e,
        });
        if (this.overview === 0) this.menuView = null;
      }
      this.renderVehicle.reset(this.vehicle);
      if (!this.mapShown) {
        if (this.settings.terrain) {
          const ground = this.map.groundAt(this.vehicle.position);
          if (ground != null) this.altitude = ground;
        } else this.altitude = 0;
        const view = this.introView();
        const center = this.map.getCenter();
        if (Math.abs(center.lng - view.center[0]) > 1e-8 || Math.abs(center.lat - view.center[1]) > 1e-8 || Math.abs(this.map.getCenterElevation() - view.elevation) > 0.25 || Math.abs(this.map.getZoom() - view.zoom) > 0.001) this.map.jumpTo(view);
      }
    }
    this.updateTrains(dt);
    this.updateHealthMarkers(now - this.overlayTime > 100);
    this.updateTrafficMarkers();
    this.players.update();
    this.updateEventMarkers();
    if (now - this.overlayTime > 100) this.overlayTime = now;
    if (now - this.hudTime > 100) {
      this.hudTime = now;
      this.hud(this.vehicle.speed * 3.6, this.vehicle.distance, this.fps, this.hudParticipants());
      const near = nearestStation(this.vehicle.position, [...this.stations.values()]);
      const hub = nearestHub(this.vehicle.position, [...this.hubs.values()]);
      // only hint the hub when you're close enough that it matters (not from across town)
      const hubHint = hub?.hub.kind === 'airport' ? 800 : hub?.hub.kind === 'station' ? 220 : 120;
      const hubHud = hub && hub.distance < hubHint
        ? { kind: hub.hub.kind, distance: hub.distance }
        : null;
      this.onFuel({ level: this.fuel.level, tank: this.fuel.spec.tank, refuelling: this.refuelling, station: near ? near.distance : null, money: Math.floor(this.playerMoney), hub: hubHud });
    }
    if (!this.mapShown) this.settleBoot();
    this.map.triggerRepaint();
  };

  dispose() {
    this.disposed = true;
    this.players.dispose();
    this.worldWork = null;
    cancelAnimationFrame(this.frame);
    this.spawnMarker?.remove();
    for (const marker of this.missionMarkers.values()) marker.remove();
    this.missionMarkers.clear();
    this.raceGoalMarker?.remove();
    this.bountyMarker?.remove();
    this.eventIndicatorLayer?.remove();
    for (const marker of this.hubMarkers.values()) marker.remove();
    this.hubMarkers.clear();
    for (const marker of this.serviceMarkers.values()) marker.remove();
    this.serviceMarkers.clear();
    this.pickups.clear();
    this.combatLayer?.setPickups([]);
    this.trafficMarkerLayer?.remove();
    this.trafficMarkers.clear();
    this.healthMeters.dispose();
    this.cleanups.forEach((fn) => fn());
    this.map.remove();
  }
}
