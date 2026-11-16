import { roadStart } from './roadStart.ts';
import { cameraTransition, type CameraView } from './cameraTransition.ts';
import { PreparedTransfer } from './PreparedTransfer.ts';
import { missionAreas, missionRoadSpot, nearestOfEachKind } from './missionPopulation.ts';
import { VehiclePose } from './VehiclePose.ts';
import { leavesSupport, supportAltitude, type GroundSample } from './groundSupport.ts';
import { BuildingCollisions } from './BuildingCollisions.ts';
import { WaterCollisionController, type MapFeature } from './WaterCollisionController.ts';
import { mapConfig, cars as carsConfig, carPrice, GIFT_CARS, STARTING_CASH, type City, type Car, vehicleConfig } from '@/config/vehicle.config';
import { cameraConfig, lookAheadFor, zoomForDistance } from '@/config/camera.config';
import { VehicleController, bumpDamage, vehicleImpact, offsetPosition, resolveVehicleCollision, type Position } from './VehicleController.ts';
import { GameAudio } from '@/audio/GameAudio';
import { DROP_MS, vehicleLayer, type PickupVisual, type TargetVehicle, type VehicleSceneLayer } from '@/rendering/VehicleLayer';
import {
  completeFireCall,
  createFireCallState,
  onFireWindowOut as noteFireWindowOut,
  startFireCall,
  suspendFireCall,
  updateFireCall,
  type FireCallWorld,
} from './missions/fireCall.ts';
import { facadeMarker } from '@/rendering/BurningHouse';
import {
  acceptTaxiFare,
  createTaxiFareState,
  declineTaxiFare,
  suspendTaxiFare,
  updateTaxiFare,
  type TaxiFareWorld,
} from './missions/taxiFare.ts';
import {
  acceptAmbulanceCall,
  createAmbulanceCallState,
  declineAmbulanceCall,
  suspendAmbulanceCall,
  updateAmbulanceCall,
  type AmbulanceCallWorld,
  type AmbulanceSite,
} from './missions/ambulanceCall.ts';
import {
  createBusStopState,
  updateBusStops,
  type BusStopWorld,
} from './missions/busStop.ts';
import {
  acceptBusTour,
  createBusTourState,
  declineBusTour,
  suspendBusTour,
  updateBusTour,
  type BusTourWorld,
} from './missions/busTour.ts';
import type { ChatLine, NetNotice } from '@/net/NetClient';
import { distanceToTile } from '@/world3d/tiles/tilePlan';
import { mercatorX, mercatorY, tileCorner, tileSpan } from '@/world3d/mercator';

import { NetPlayers, PLAYER_MARKER_COLOR, type OnlinePlayer } from './net/NetPlayers.ts';
import { SharedTraffic } from './net/SharedTraffic.ts';
import { HealthMeters, type Meter } from './hud/HealthMeters.ts';
import { TestTargets } from './TestTargets.ts';
import { HIT_DAMAGE, PLAYER_HP } from '@/net/protocol';
  import { formatRange, MARKER_PIN_METERS, nameIndicator, placeIndicator } from './hud/indicators.ts';
import { createTrafficBot, TrafficRoadNetwork, type TrafficBot } from './TrafficBots.ts';
import { formatNumber, onLangChange, t } from '@/i18n';
import { ThreeMap } from '@/world3d/map/ThreeMap';
import { EVACUATION_COST, FuelTank } from './Fuel.ts';
import { atStation, banksFromFeatures, busStopsFromFeatures, courtsFromFeatures, dealershipsFromFeatures, hospitalsFromFeatures, landmarksFromFeatures, nearestStation, policeFromFeatures, prisonsFromFeatures, repairShopsFromFeatures, SERVICE_REACH, stationsFromFeatures, type CivicKind, type Landmark, type Station } from './poi.ts';
import { metersBetween, offsetMeters } from './meters.ts';
import { defaultMapLabelFilters, type MapLabelFilters, type MapLabelKind } from './mapLabels.ts';
import { fuelStationsLayer } from '@/rendering/FuelStationsLayer';
import { isVintageTrain, trainsLayer } from '@/rendering/TrainsLayer';
import { RailNetwork, TrainTraffic } from './Trains.ts';
import { canCable, Hauler, type HaulHost } from './Hauler.ts';
import { Heist, type HeistHost } from './crime/Heist.ts';
import { MissionBotDriver, type BotDriverHost } from './traffic/MissionBots.ts';
import { Shops, type ShopsHost } from './economy/Shops.ts';
import { Dealership, type DealershipHost } from './economy/Dealership.ts';
import { Ramp, type RampHost } from './Ramp.ts';
import { WorldFeed } from './world/WorldFeed.ts';
import { Ground } from './Ground.ts';
import { Spawn } from './world/Spawn.ts';
import { Combat } from './Combat.ts';
import { Places } from './world/Places.ts';
import { Missions } from './events/Missions.ts';
import { Coins } from './Coins.ts';
import { Jobs } from './jobs/Jobs.ts';
import { TravelDesk, type TravelHost } from './economy/TravelDesk.ts';
import { CustomPins, type CustomPinsHost } from './hud/CustomPins.ts';
import { Race, type RaceHost } from './events/Race.ts';
import { Wanted, type WantedHost } from './events/Wanted.ts';
import { Nitro } from './Nitro.ts';
import { JobPin, makeMapLabel, makeOffscreenIndicator, newMarker, paintMissionIndicator, setPinRange, type MapMarker } from './hud/mapPins.ts';
import { hubsFromFeatures, kilometres, nearestHub } from './Travel.ts';
import { bearingTo, BOUNTY_RANGE_KM, saveBounty } from './Bounty.ts';
import type { GameSave } from './save.ts';
import { BOX_REACH_M, COLLECT_BOXES, COLLECT_REWARD, deliveryReward, DELIVERY_MAX_M, DELIVERY_MIN_M, DELIVERY_REACH_M, randomItem, scatterBoxes, type DeliveryItem, type Errand } from './Errands.ts';
import type {
  EventOffer,
  EventResult,
  FuelHud,
  HudParticipant,
  MissionKind,
  PlayerCarry,
  RideOffer as RideOfferType,
  Settings,
} from './offers.ts';
import {
  ARENA_FEE,
  ARENA_PRIZE,
  RACE_FEE,
  RACE_PRIZE,
  randomDriverNames,
  CASH_BUNDLE,
  ERRAND_BEACONS,
  AMBULANCE_HOSPITAL_M,
  AMBULANCE_ID,
  ambulanceWreckId,
  isAmbulanceWreckId,
  BUS_ID,
  BATMOBILE_ID,
  FIRE_TRUCK_ID,
  TAXI_ID,
  carShootsGuns,
  GRAVITY,
  COIN_RESPAWN_M,
  COIN_SPACING_M,
  HAULER_ID,
  IMPOUND_ARRIVE_M,
  IMPOUND_REWARD,
  METERS_PER_DEGREE,
  MISSION_COLORS,
  MISSION_PICKUP_M,
  BOUNTY_CAR_IDS,
  POLICE_IDS,
  RAMP,
  TOW_CAR_ID,
  TRAFFIC_MARKER_COLORS,
  WRECK_COSTS,
} from './tuning.ts';

/** An angle in degrees as −180 … 180 (the same turn, the short way). */
const wrapDegrees = (deg: number) => ((deg + 180) % 360 + 360) % 360 - 180;
/** where the camera (zoom, tilt, turn) is kept between reloads */
const CAMERA_STORE = 'race.camera';
/** a tow, a ticket, a respawn: the ground this far (m) round the arrival must be in first */
const ARRIVAL_M = 400;
/** hit a wall faster than this (km/h) and coins jump out of it (3; 5 from 150, 10 from 200) */
const WALL_COIN_KMH = 100;
/** …when the wall takes at least this much of the speed (m/s, ~40 km/h): a hit, not a graze */
const WALL_COIN_HIT = 11;
/** never a race / arena rival: the police, the emergency and work vehicles, the robot, the monster truck */
const RIVAL_EXCLUDED = new Set(['09', '16', '21', '18', '19', '20', '14', '03']);
/** The camera as last left, within its limits; null if none was kept (or it is unreadable). */
function savedCamera(): { distance: number; pitch: number; orbit: number } | null {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(CAMERA_STORE);
    if (!raw) return null;
    const v = JSON.parse(raw) as { distance?: unknown; pitch?: unknown; orbit?: unknown };
    const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
    const distance = num(v.distance), pitch = num(v.pitch), orbit = num(v.orbit);
    if (distance == null || pitch == null) return null;
    return {
      distance: Math.max(cameraConfig.minDistance, Math.min(cameraConfig.maxDistance, distance)),
      pitch: Math.max(cameraConfig.minPitch, Math.min(cameraConfig.maxPitch, pitch)),
      orbit: wrapDegrees(orbit ?? 0),
    };
  } catch {
    return null;
  }
}
const NO_FUEL_KEYS = new Set(['KeyW', 'Space']);

/** One line of the "who is online" list. Distance in meters from our car. */
export type { OnlinePlayer };

/** `drop`: thrown out of a wreck — bounces from `from` and can be picked up once it lies still */

/** Everything the game's parts ask of it, in one. */
type GameContext = HaulHost & HeistHost & BotDriverHost & ShopsHost & DealershipHost & RampHost & TravelHost & CustomPinsHost & RaceHost & WantedHost;

export class GameEngine {
  collisions = new BuildingCollisions();
  water = new WaterCollisionController();
  collisionDirty = true;
  collisionTime = 0;
  /** the map's first frame is in: layers added, features can be read */
  mapLoaded = false;
  map: ThreeMap;
  vehicle: VehicleController;
  renderVehicle = new VehiclePose();
  keys = new Set<string>();
  settings: Settings;
  driving = false;
  paused = false;
  transfer = new PreparedTransfer();
  onTransfer: (state: 'loading' | 'failed' | null) => void = () => {};
  altitude = 0;
  modelPitch = 0;
  modelRoll = 0;
  frame = 0;
  disposed = false;
  ready = false;
  // the camera as the player left it (zoom, tilt, turn round the car): kept across reloads
  distance = savedCamera()?.distance ?? cameraConfig.distance;
  orbit = savedCamera()?.orbit ?? 0;
  pitch = savedCamera()?.pitch ?? cameraConfig.pitch;
  private cameraSavedAt = 0;
  private cameraSaved = '';
  bearing = 0;
  last = 0;
  accumulator = 0;
  hudTime = 0;
  dragging = false;
  host: HTMLElement;
  mapShown = false;
  bootAt = 0;
  groundHits = 0;
  /** boot camera already parked on chase pose to finish GPU uploads before "ready" */
  bootChaseWarmed = false;
  /** Active animation time; pauses and hidden tabs do not advance it. */
  private approachElapsed = 0;
  /** Full intro→chase flight, including its gentle start and stop. */
  private approachMs = 2200;
  private approachFrom: CameraView | null = null;
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
  featureReadFailures = new Set<string>();
  cachedWater: MapFeature[] = [];
  cachedRoads: MapFeature[] = [];
  cachedLanduse: MapFeature[] = [];
  tilesIngested = false;
  /** last full features() scoop — rare prune, not every tile upload */
  private fullScoopAt = 0;
  focusTime = 0;
  private overlayTime = 0;
  wheelSampleTime = 0;
  private aimScreen: [number, number] | null = null;
  trafficBots: TrafficBot[] = [];
  /** reused by targetVehicles() so the chase tick doesn't allocate every frame */
  targetScratch: TargetVehicle[] = [];
  trafficNetwork = new TrafficRoadNetwork();
  /** light traffic shared with the players around */
  sharedTraffic!: SharedTraffic;
  mode: 'roam' | 'arena' | 'race' = 'roam';
  lastCompletedAt: [number, number] | null = null;
  eventOffer: MissionKind | null = null;
  /** bounty hunt: the active job (kept across trips), the offer on screen, the fight */
  /** local pin where you drive to take a pending wanted job */
  // ---- multiplayer: other players in the same world (net/NetPlayers)
  players!: NetPlayers;
  /** our police car's lights (F) */
  /** our police lights (F): off by default */
  private beaconsOn = false;
  /** all game sound (synthesised) */
  audio = new GameAudio();
  /** trains' lead cars last frame: for their speed (Doppler, clack rate) */
  private trainHeard = new Map<string, { at: number; front: [number, number] }>();
  /** The special cars' jobs: fire calls for the fire truck, fares for the taxi, crash and fire (see Jobs) */
  readonly jobs: Jobs = new Jobs(this);
  /** Coins and cash lying about: along the roads and on open fields, out of wrecks, walls and (see Coins) */
  readonly coins: Coins = new Coins(this);
  /** The mission board: the four kinds of start on the map (race, arena, delivery, boxes), their (see Missions) */
  readonly board: Missions = new Missions(this);
  /** The places on the map from the real data: fuel stations, car services, dealerships, banks (see Places) */
  readonly places: Places = new Places(this);
  /** Cars against cars: who is a target, bumps and rams between them, the hunters' guns, damage (see Combat) */
  readonly combat: Combat = new Combat(this);
  /** Where the car starts: the player's own spot (clicked on the menu map) or a free road near the (see Spawn) */
  readonly spawn: Spawn = new Spawn(this);
  /** Our car against the ground: the wheels planted on the terrain (height, pitch, roll), flying (see Ground) */
  readonly ground: Ground = new Ground(this);
  /** The world coming in: new tiles' roads, water, buildings and places taken into the game a (see WorldFeed) */
  readonly feed: WorldFeed = new WorldFeed(this);
  /** the game as its parts see it (see context) */
  private ctx = this.context();
  /** the nitro bar under the speedometer */
  private nitro = new Nitro();
  /** the wanted car: the offer, the hunt and the fight (see Wanted) */
  readonly wanted = new Wanted(this.ctx);
  /** the race on now, or being planned (see Race) */
  race = new Race(this.ctx);
  /** the player's own pins on the M map (see CustomPins) */
  pins = new CustomPins(this.ctx);
  /** ports, airports and railway stations: a ticket to any city (see TravelDesk) */
  readonly travel = new TravelDesk(this.ctx);
  /** J: the ramp we put down (see Ramp) */
  rampTool = new Ramp(this.ctx);
  /** the car dealership and the garage swap (see Dealership) */
  readonly dealer = new Dealership(this.ctx);
  /** the fuel station, the car service and the bank: their dialogs and the loan (see Shops) */
  readonly shops = new Shops(this.ctx);
  /** the mission bots at the wheel (see MissionBotDriver) */
  private botDriver = new MissionBotDriver(this.ctx);
  /** bank jobs, hijacks and the police after us (see Heist) */
  crime = new Heist(this.ctx);
  /** the Howler's and the Batmobile's cable (see Hauler) */
  hauler = new Hauler(this.ctx);
  /** us on the map (M): a dot with an arrow along our heading */
  private selfMarker: MapMarker | null = null;
  /** a new language: every map label and marker title says it again */
  private offLang = onLangChange(() => this.relabel());
  /** trains and trams on the real tracks */
  rails = new RailNetwork();
  trainTraffic = new TrainTraffic(this.rails);
  trainLayer: ReturnType<typeof trainsLayer> | null = null;
  eventCooldown = 0;
  playerHp = 1000;
  readonly playerMaxHp = 1000;
  eventIndicatorLayer: HTMLElement | null = null;
  onEventOffer: (offer: EventOffer | null) => void = () => {};
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
  fuelLayer: ReturnType<typeof fuelStationsLayer> | null = null;
  /** Category chips + world plaques: only while the M map is open. */
  onMapView: (open: boolean) => void = () => {};
  private mapViewUi = false;
  /** throttle M-map plaque rebuilds (were every frame → ~20 FPS) */
  mapLabelsAt = 0;
  mapLabelsAtPos: [number, number] | null = null;
  private fuelOut = false;
  private refuelling = false;
  /** after a purchase: React keeps the menu car index in sync */
  onCarBought: (car: Car) => void = () => {};
  private offeredService: string | null = null;
  /** cars we own: bought ones pile up here, none is sold back */
  private garage = new Set<string>();
  /** key M: camera rises straight up for a ~2 × 2 km view from above (0 chase … 1 overview) */
  overview = 0;
  private overviewTarget = 0;
  /** once overview is open: pan/zoom freely; blend back from here when closing */
  private overviewFree = false;
  /** keep stream calm after M lands so the first free frames don't upload towers */
  private mapCalmUntil = 0;
  private overviewLeave: { center: [number, number]; zoom: number } | null = null;
  /** the menu camera to return to after the view from above */
  private menuView: { center: [number, number]; zoom: number; pitch: number; bearing: number } | null = null;

  /** ~1.4 km across the screen height — 2 km of Manhattan rooftops murdered the GPU */
  private overviewZoom(lat: number) {
    const height = this.map.getCanvas().clientHeight || 800;
    const mercPerMeter = 1 / (2 * Math.PI * 6371008.8 * Math.cos(lat * Math.PI / 180));
    return Math.log2((height / 1400) / mercPerMeter / 512);
  }

  /** Driving map mode (M): inspect the city, no gun. */
  mapInspecting() {
    return this.driving && (this.overviewTarget > 0 || this.overview > 0.4);
  }

  private setOverviewMapNav(on: boolean) {
    if (on) this.map.setInteractive({ pan: true, rotate: false });
    else if (this.driving) this.map.setInteractive({ pan: false, rotate: false });
    else if (!this.driving && this.mapShown) this.map.setInteractive({ pan: true, rotate: false });
  }

  private toggleOverview() {
    if (this.overviewTarget) {
      // closing — remember where the player was looking
      const c = this.map.getCenter();
      this.overviewLeave = { center: [c.lng, c.lat], zoom: this.map.getZoom() };
      this.overviewTarget = 0;
      this.overviewFree = false;
      this.setOverviewMapNav(false);
      this.setMapViewUi(false);
      // calm through the descent — burst mid-blend was the 5–7 FPS stall
      this.map.setStreamCalm(true);
    } else {
      this.overviewLeave = null;
      this.overviewTarget = 1;
      this.overviewFree = false;
      this.stopGun();
      this.lookPointer = null;
      this.lookOrigin = null;
      this.lookDragging = false;
      this.dragging = false;
      this.setMapViewUi(true);
      this.map.setScreenStream(true);
      this.map.setStreamCalm(true);
    }
  }
  private carry: PlayerCarry | null = null;
  get money() { return this.playerMoney; }
  /** where the run (re)started: saved coins without a place come back once we leave it */
  collectedFrom: Position | null = null;
  /** true once the run's purse/coins/hp are in place — before that a snapshot would wipe the save */
  private runReady = false;
  /** the run's purse/coins/hp have been applied (see runReady) */
  get runStarted() { return this.runReady; }
  playerMoney = 0;
  get booted() { return this.mapShown; }
  private aimingFire = false;
  /** LMB: drag to look around; hold still to aim/fire (no permanent reticle). */
  private lookPointer: number | null = null;
  private lookOrigin: { x: number; y: number } | null = null;
  private lookDragging = false;
  private city: City;
  constructor(el: HTMLElement, city: City, car: Car, settings: Settings, private hud: (speed: number, distance: number, fps: number, participants: HudParticipant[]) => void, private status: (s: string, toast?: boolean) => void, private aimHud: (x: number, y: number, visible: boolean, firing?: boolean) => void, carry: PlayerCarry | null = null) {
    this.city = city;
    this.fuel = new FuelTank(car.fuel);
    this.carry = carry;
    // Reload mid-drive: pin spawn so the first setTargetVehicles keeps money/hp/coins.
    if (carry?.at) this.spawn.customSpawn = { position: [...carry.at.position], heading: carry.at.heading };
    // Drop leftover worldwide hunts — bounties are local (≤ 10 km) now.
    if (this.wanted.bounty) {
      const at = this.wanted.bounty.spot ?? this.wanted.bounty.place.coords;
      if (kilometres(city.coords, at) > BOUNTY_RANGE_KM) {
        this.wanted.bounty = null;
        saveBounty(null);
      }
    }
    (window as unknown as { __cityRider?: GameEngine }).__cityRider = this; // console debugging
    this.host = el;
    el.style.opacity = '0';
    this.bootAt = performance.now();
    this.settings = settings;
    this.car = car;
    const startAt = carry?.at;
    this.vehicle = new VehicleController(startAt?.position ?? city.coords, startAt ? startAt.heading * 180 / Math.PI : city.heading);
    // S: stop first, a second press backs up
    this.vehicle.stopBeforeReverse = true;
    this.combat.healthMeters = new HealthMeters(el);
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
      busy: () => this.mode !== 'roam' || this.wanted.fight,
      canMove: (from, to, heading) => !this.collisions.blocked(from, to, heading, 1, this.altitude) && !this.water.resolve(from, to, heading, 1, this.ground.onBridgeDeck(to, this.altitude)).stopped,
      online: (list) => this.onOnline(list),
      chat: (line) => this.onChat(line),
      notice: (notice) => this.onNetNotice(notice),
      hitBy: (name, damage) => this.combat.hitByPlayer(name, damage),
      hp: () => this.playerHp,
      bumped: (damage) => this.combat.damagePlayer(damage, 180),
      news: (text) => this.say(text, true),
      traffic: (from, cars) => this.sharedTraffic.receive(from, cars),
      trafficHit: (id) => this.sharedTraffic.hitByOther(id),
      trafficTaken: (id) => this.sharedTraffic.takenByOther(id),
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
      // the police after us: everybody sees them, they chase only us
      extras: () => this.crime.heist ? this.trafficBots
        .filter((bot) => bot.id.startsWith('police') && this.combatLayer?.isTargetAlive(bot.id) !== false)
        .map((bot) => ({ id: bot.id, car: bot.car.id, p: bot.position, h: bot.heading, s: bot.controller.speed, hp: Math.round(this.combatLayer?.targetHp(bot.id) ?? 1000) })) : [],
      hitExtra: (id) => { this.combatLayer?.damageTarget(id, HIT_DAMAGE); },
      provoke: (id) => this.combat.provoke(id),
      canPark: (at, heading) => !this.collisions.blocked(at, at, heading) && !this.water.covers(at, this.ground.onBridgeDeck(at, this.altitude)),
      hitWalls: (from, to, heading) => this.collisions.resolve(from, to, heading),
      lots: () => [...this.places.parkingLots.values()].filter((lot) => metersBetween(lot, this.vehicle.position) < 600),
      take: (id) => this.players.takeTraffic(id),
    });
    this.renderVehicle.reset(this.vehicle);
    // Intro / reload: centre on the kept spot (or the city) so the map warms calmly there.
    const bootHeadingDeg = startAt ? startAt.heading * 180 / Math.PI : city.heading;
    this.bearing = bootHeadingDeg;
    this.map = new ThreeMap({
      container: el,
      center: startAt?.position ?? city.coords,
      zoom: 16.8,
      pitch: 57,
      bearing: bootHeadingDeg - 25,
      maxPitch: 80,
      dem: mapConfig.dem.tiles[0],
      region: city.country,
    });
    this.map.on('tile', event => {
      // gameplay data (roads, water, stations…) is read around the car: a tile arriving far
      // away (the map view streams many) is no reason to read it all again
      if (typeof event.tile !== 'string' || !this.feed.nearCar(event.tile)) return;
      // queue just this tile — full features() scoop on every upload was the hitch after M toggles
      if (!this.feed.ingestedTiles.has(event.tile)) this.feed.pendingIngest.add(event.tile);
      this.collisionDirty = true;
    });
    this.map.on('error', () => this.say(t('status.mapError')));
    // a felled tree now and then drops a coin
    this.map.on('topple', (event) => {
      const point = event.point as [number, number] | undefined;
      if (point && this.driving && Math.random() < 0.3) this.coins.dropCoins(point, 1);
    });
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
        (cam, camAlt, ground, groundAlt, mark) => {
          const hit = this.map.raycastBuildings(cam, camAlt, ground, groundAlt, mark);
          if (mark && hit) this.crime.bankShot(hit.point);
          return hit;
        },
        (point, altitude) => this.map.markGround(point, altitude),
        (from, fromAlt, to, toAlt) => this.ground.trainShot(from, fromAlt, to, toAlt),
      );
      this.combatLayer.onRemoteHit = (id) => this.players.shot(id);
      this.combatLayer.onTargetHit = (id) => {
        this.combat.provoke(id);
        this.sharedTraffic.ourHit(id);
      };
      this.combatLayer.onTrainCoin = (point, altitude) => this.coins.trainCoin(point, altitude);
      this.combatLayer.onShotCoins = (from, fromAlt, to, toAlt) => this.coins.shotCollectCoins(from, fromAlt, to, toAlt);
      this.combatLayer.onFireWindowOut = (left) => this.jobs.onFireWindowOut(left);
      this.combatLayer.onShot = (kind) => this.audio.shot(kind);
      this.combatLayer.onTargetDestroyed = (id, position, reward = true) => {
        this.audio.explosion(position);
        if (reward) this.coins.dropCoins(position);
        // a wrecked police car is simply out of the chase (no reinforcements out of nowhere)
      };
      this.map.addLayer(this.combatLayer);
      this.applySettings(this.settings);
      this.ready = true;
      this.collisionDirty = true;
      this.say(t('status.placing'));
      // Map click → menu spawn, or (M overview) a custom tracked pin
      this.map.on('click', (e) => {
        const lngLat = e.lngLat as { lng: number; lat: number };
        if (!this.driving && this.mapShown) this.spawn.setSpawnFromClick(lngLat);
        else if (this.mapInspecting()) this.pins.place([lngLat.lng, lngLat.lat]);
      });
    });
    const listen = (target: EventTarget, event: string, fn: EventListener, options?: AddEventListenerOptions) => {
      target.addEventListener(event, fn, options);
      this.cleanups.push(() => target.removeEventListener(event, fn, options));
    };
    // browsers keep audio locked until a key or a click
    listen(window, 'pointerdown', (() => this.audio.unlock()) as EventListener);
    listen(window, 'keydown', ((e: KeyboardEvent) => {
      this.audio.unlock();
      // typing in a field (the city search, the name, the chat): the keys are the text's
      const target = e.target as HTMLElement | null;
      if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) return;
      // M-map only while driving — intro camera stays put
      if (e.code === 'KeyM' && !e.repeat && !this.driving) {
        e.preventDefault();
        return;
      }
      if (!this.driving || this.paused) return;
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyR', 'Tab', 'KeyM', 'KeyJ', 'KeyE'].includes(e.code)) e.preventDefault();
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) this.keys.add(e.code);
      if (e.code === 'KeyR') this.resetCamera();
      if (e.code === 'Tab' && !e.repeat) {
        if (this.dealer.tryOpen()) { /* showroom takes Tab on the lot */ }
        else this.board.cycleMissionFocus();
      }
      if (e.code === 'KeyJ' && !e.repeat) this.rampTool.begin();
      if (e.code === 'KeyC' && !e.repeat) this.dealer.swapCar();
      if (e.code === 'KeyH' && !e.repeat) this.crime.tryHijack();
      if (e.code === 'KeyF' && !e.repeat) { this.beaconsOn = !this.beaconsOn; this.combatLayer?.setBeacons(this.beaconsOn); }
      if (e.code === 'KeyG' && !e.repeat) this.audio.hornOn(true);
      if (e.code === 'KeyM' && !e.repeat) this.toggleOverview();
    }) as EventListener);
    listen(window, 'keyup', ((e: KeyboardEvent) => {
      this.keys.delete(e.code);
      if (e.code === 'KeyG') this.audio.hornOn(false);
      if (e.code === 'KeyJ') this.rampTool.commit();
    }) as EventListener);
    const clear = () => {
      this.keys.clear();
      if (this.rampTool.charging) this.rampTool.commit();
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
        // Batmobile: right click throws the Howler cable (LMB stays guns). Others: orbit.
        if (this.car.id === BATMOBILE_ID) {
          const bounds = el.getBoundingClientRect();
          const x = e.clientX - bounds.left;
          const y = e.clientY - bounds.top;
          this.aimScreen = [x, y];
          this.updateAim();
          this.hauler.click();
          this.aimHud(x, y, true, false);
          return;
        }
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
      if (this.car.id === HAULER_ID) this.hauler.click();
      else this.combatLayer?.setFiring(true);
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
            if (this.car.id !== HAULER_ID) this.combatLayer?.setFiring(true);
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
    const pick = this.map.pickScreen(this.aimScreen[0], this.aimScreen[1]);
    this.combatLayer?.setAim({
      ground: pick.point,
      screen: this.aimScreen,
      altitude: pick.altitude,
      wall: pick.wall,
    });
  }

  placeTargetIndicator(marker: { element: HTMLElement; arrow: HTMLElement; distance: HTMLElement }, target: [number, number], pinMeters = MARKER_PIN_METERS) {
    placeIndicator(this.map, marker, this.vehicle.position, target, pinMeters, this.mapInspecting());
  }

  setCar(car: Car) {
    if (this.car.id === car.id && this.car.path === car.path) return;
    if (this.hauler.haul && !this.canCable(car.id)) this.hauler.lose();
    const prev = this.car.id;
    this.car = car;
    this.fuel.changeSpec(car.fuel);
    this.combatLayer?.setCar(car);
    this.onSpecialVehicleChange(prev, car.id);
  }

  /** Police cruisers and the Batmobile — wanted hunts. */
  canHuntBounty(id = this.car.id) { return BOUNTY_CAR_IDS.has(id); }
  isFireTruck(id = this.car.id) { return id === FIRE_TRUCK_ID; }
  isHauler(id = this.car.id) { return id === HAULER_ID; }
  /** Howler + Batmobile: throw / yank / release the cable. */
  private canCable(id = this.car.id) { return canCable(id); }

  /** The nitro bar, for the HUD. */
  nitroState(): Readonly<{ level: number; active: boolean }> {
    return this.nitro;
  }

  /** Space held: the nitro burns its bar; let go, it refills (see Nitro). */
  private tickNitro(dt: number) {
    this.nitro.tick(dt, this.keys.has('Space'), !this.fuel.empty);
  }

  /** The layer the edge arrows (off-frame goals) live in, made on first need. */
  indicatorLayer() {
    if (!this.eventIndicatorLayer) {
      this.eventIndicatorLayer = document.createElement('div');
      this.eventIndicatorLayer.className = 'mission-indicators';
      this.host.appendChild(this.eventIndicatorLayer);
    }
    return this.eventIndicatorLayer;
  }

  /**
   * The game as its parts see it: one object behind every part's narrow host interface
   * (the cable, the chase, the race, the counters…), reading and writing the engine live.
   */
  private context(): GameContext {
    const game = this;
    return {
      get vehicle() { return game.vehicle; },
      get renderVehicle() { return game.renderVehicle; },
      get car() { return game.car; },
      get altitude() { return game.altitude; },
      get modelPitch() { return game.modelPitch; },
      get map() { return game.map; },
      get combatLayer() { return game.combatLayer; },
      get aimScreen() { return game.aimScreen; },
      get pickups() { return game.coins.pickups; },
      get trainTraffic() { return game.trainTraffic; },
      get sharedTraffic() { return game.sharedTraffic; },
      get trafficBots() { return game.trafficBots; },
      set trafficBots(bots) { game.trafficBots = bots; },
      say: (text, toast) => game.say(text, toast),
      fall: () => { game.ground.airborne = true; game.ground.climb = 0; },
      refreshTargets: () => game.combatLayer?.setTargets(game.combat.targetVehicles()),
      get mode() { return game.mode; },
      set mode(mode) { game.mode = mode; },
      get bountyFight() { return game.wanted.fight; },
      get driving() { return game.driving; },
      get paused() { return game.paused; },
      onMission: () => game.board.onMission(),
      get banks() { return game.places.banks; },
      get bearing() { return game.bearing; },
      set bearing(bearing) { game.bearing = bearing; },
      get accumulator() { return game.accumulator; },
      set accumulator(value) { game.accumulator = value; },
      get fuel() { return game.fuel; },
      get garage() { return game.garage; },
      setCar: (car) => game.setCar(car),
      onCarBought: (car) => game.onCarBought(car),
      get collisions() { return game.collisions; },
      get water() { return game.water; },
      get mapLoaded() { return game.mapLoaded; },
      get trafficNetwork() { return game.trafficNetwork; },
      nextDropId: () => game.coins.dropSerial++,
      refreshPickups: () => game.combatLayer?.setPickups(game.coins.pickupVisuals()),
      botsChanged: () => { game.combat.ensureTrafficMarkers(); game.combatLayer?.setTargets(game.combat.targetVehicles()); },
      forgetContacts: () => game.combat.vehicleContactTimes.clear(),
      hideEventBeacons: () => game.board.hideEventBeacons(),
      showEventBeacons: () => game.board.showEventBeacons(),
      clearEventBots: () => game.clearEventBots(),
      get eventCooldown() { return game.eventCooldown; },
      set eventCooldown(at) { game.eventCooldown = at; },
      get playerHp() { return game.playerHp; },
      set playerHp(hp) { game.playerHp = hp; },
      get playerMaxHp() { return game.playerMaxHp; },
      get playerMoney() { return game.playerMoney; },
      set playerMoney(money) { game.playerMoney = money; },
      onEventResult: (result) => game.onEventResult(result),
      get audio() { return game.audio; },
      nearestCivic: () => game.nearestCivic(),
      nearbyRoadSpot: () => game.spawn.nearbyRoadSpot(),
      placeCarAt: (position) => game.placeCarAt(position),
      onBridgeDeck: (at, altitude) => game.ground.onBridgeDeck(at, altitude),
      get keys() { return game.keys; },
      get runReady() { return game.runReady; },
      counterOpen: () => Boolean(game.shops.serviceOpen || game.travel.open || game.fuelOut),
      get dealerships() { return game.places.dealerships; },
      offered: (id) => { game.offeredService = id; },
      get airborne() { return game.ground.airborne; },
      get fuelOut() { return game.fuelOut; },
      mapViewOpen: () => game.mapViewOpen(),
      labelOn: (kind) => game.places.mapLabelOn(kind),
      carry: () => ({ money: game.playerMoney, fuel: game.fuel.ratio, loan: game.shops.loanDebt, garage: [...game.garage] }),
      inspecting: () => game.mapInspecting(),
      indicatorLayer: () => game.indicatorLayer(),
      changed: () => game.board.syncMissionVisuals(),
      get eventOffer() { return game.eventOffer; },
      set eventOffer(kind) { game.eventOffer = kind; },
      get disposed() { return game.disposed; },
      rivalCars: (n) => game.rivalCars(n),
      forgetBot: (id) => game.botDriver.forget(id),
      addWin: (id) => game.combat.addWin(id),
      completeActiveMission: () => game.board.completeActiveMission(),
      syncMissionVisuals: (showWorld) => game.board.syncMissionVisuals(showWorld),
      onEventOffer: (offer) => game.onEventOffer(offer),
      canHuntBounty: () => game.canHuntBounty(),
      dialogOpen: () => game.dialogOpen(),
      errandOn: () => Boolean(game.board.errand),
      errandOrFire: () => Boolean(game.board.errand || game.jobs.fire.active),
      jobOn: () => Boolean(game.board.errand || game.jobs.fire.active || game.jobs.impoundActive || game.jobs.taxi.active || game.jobs.busTour.active),
      get city() { return game.city; },
      get missions() { return game.board.missions; },
      pickBeaconSpot: (here, heading, seed, avoid, band) => game.pickBeaconSpot(here, heading, seed, avoid, band),
      focusGoals: () => game.board.focusGoals(),
      set missionFocus(index: number) { game.board.missionFocus = index; },
      placeTargetIndicator: (marker, target, pinMeters) => game.placeTargetIndicator(marker, target, pinMeters),
    };
  }

  /** Some dialog is up (an event offer, a ticket, a counter, the showroom, an empty tank). */
  dialogOpen() {
    return Boolean(this.eventOffer || this.travel.open || this.shops.serviceOpen || this.dealer.open || this.fuelOut);
  }

  isTaxi(id = this.car.id) { return id === TAXI_ID; }
  isAmbulance(id = this.car.id) { return id === AMBULANCE_ID; }
  /** Parked mission props (crash wreck / tow wait) — not racers, no roster / HP / chase arrow. */
  isPropBot(id: string) { return isAmbulanceWreckId(id) || id === TOW_CAR_ID; }
  isBus(id = this.car.id) { return id === BUS_ID; }
  carShoots(id = this.car.id) { return carShootsGuns(id); }

  /** Role cars swap which special mission is on the map (police / fire / hauler / taxi). */
  private onSpecialVehicleChange(prev: string, next: string) {
    if (this.isFireTruck(prev) && !this.isFireTruck(next)) this.jobs.suspendFire();
    if (this.isHauler(prev) && !this.isHauler(next)) this.jobs.suspendImpound();
    if (this.isTaxi(prev) && !this.isTaxi(next)) this.jobs.suspendTaxi();
    if (this.isAmbulance(prev) && !this.isAmbulance(next)) this.jobs.suspendAmbulance();
    if (this.isBus(prev) && !this.isBus(next)) this.jobs.suspendBusTour();
    if (this.canHuntBounty(prev) && !this.canHuntBounty(next)) {
      // hide bounty offer UI; keep the saved hunt for when we're back in a cruiser
      if (this.wanted.offerShown) { this.wanted.offerShown = false; this.wanted.onOffer(null); }
    }
    if (this.isFireTruck(next) && !this.jobs.fire.active && !this.jobs.fire.pickup) {
      this.jobs.fire.offerAt = Math.min(this.jobs.fire.offerAt, performance.now() + 4000);
    }
    if (this.isHauler(next) && !this.jobs.impoundActive && !this.jobs.impoundPickup) {
      this.jobs.impoundOfferAt = Math.min(this.jobs.impoundOfferAt, performance.now() + 4000);
    }
    if (this.isTaxi(next) && !this.jobs.taxi.active && !this.jobs.taxi.pickup) {
      this.jobs.taxi.offerAt = Math.min(this.jobs.taxi.offerAt, performance.now() + 4000);
    }
    if (this.isAmbulance(next) && !this.jobs.ambulance.active && !this.jobs.ambulance.pickup) {
      this.jobs.ambulance.offerAt = Math.min(this.jobs.ambulance.offerAt, performance.now() + 4000);
    }
    if (this.isBus(next) && !this.jobs.busTour.active && !this.jobs.busTour.pickup) {
      this.jobs.busTour.offerAt = Math.min(this.jobs.busTour.offerAt, performance.now() + 4000);
    }
    if (this.canHuntBounty(next) && !this.wanted.bounty && !this.wanted.pending) {
      this.wanted.offerAt = Math.min(this.wanted.offerAt, performance.now() + 4000);
    }
    this.board.syncArenaAvailability(prev, next);
    this.board.syncMissionVisuals(true);
  }

  applySettings(settings: Settings) {
    const terrainChanged = settings.terrain !== this.settings.terrain;
    const skinChanged = settings.skin !== this.settings.skin;
    this.settings = settings;
    this.map.setSkin(settings.skin);
    this.audio.setVolume(settings.volume);
    // mid-fire skin swap: snap flames onto the new window grid, keep ~the same burn %
    if (skinChanged && this.jobs.fire.active) this.remeshFireForSkin();
    if (!this.mapLoaded) return;
    this.map.setRelief(settings.terrain);
    // fill-rate first: high ≤1.25, medium 1, low 0.85 (was 1 / 1.25 / ≤1.5)
    const dpr = window.devicePixelRatio || 1;
    const ratio = settings.quality === 'low' ? 0.85 : settings.quality === 'medium' ? 1 : Math.min(dpr, 1.25);
    this.map.setPixelRatio(ratio);
    // the filmic pass costs a copy and three small passes: off on low quality
    this.map.setPostFx(settings.quality !== 'low');
    this.map.useGroundTexture();
    if (terrainChanged) { this.collisionDirty = true; this.syncedAt = null; }
  }

  /** After a skin change, rebuild burning panes on the façade rhythm that style draws. */
  private remeshFireForSkin() {
    if (!this.jobs.fire.active || !this.jobs.fire.spot || !this.combatLayer) return;
    const facades = this.map.fireFacadesNear(this.jobs.fire.spot, 80);
    if (!facades?.panes.length) return;
    const specs = facades.panes.map((p) => ({
      at: p.at as [number, number],
      altitude: p.altitude,
      oe: p.oe,
      on: p.on,
    }));
    const seed = Math.round(this.jobs.fire.spot[0] * 1e5) ^ Math.round(this.jobs.fire.spot[1] * 1e5) ^ (performance.now() | 0);
    this.combatLayer.remeshFireHouse(specs, seed);
    const total = this.combatLayer.fireWindowsTotal();
    if (total != null) this.jobs.fire.windowTotal = total;
    const left = this.combatLayer.fireWindowsLeft();
    if (left === 0) {
      this.jobs.completeFire(this.jobs.fire.windowTotal);
      return;
    }
    this.jobs.fire.spot = facadeMarker(specs, this.jobs.fire.spot) as [number, number];
    this.board.syncMissionVisuals(true);
  }

  nudgeCamera(dt: number) {
    const yaw = Number(this.keys.has('ArrowRight')) - Number(this.keys.has('ArrowLeft'));
    if (yaw) this.orbit += yaw * dt * 75 * this.settings.sensitivity;
    const zoom = Number(this.keys.has('ArrowDown')) - Number(this.keys.has('ArrowUp'));
    if (!zoom) return;
    const next = this.distance * Math.exp(zoom * dt * 0.9 * this.settings.sensitivity);
    this.distance = Math.max(cameraConfig.minDistance, Math.min(cameraConfig.maxDistance, next));
  }

  /** Remember the camera (at most once a second, and only when it moved). */
  private saveCamera(now: number) {
    if (now - this.cameraSavedAt < 1000) return;
    this.cameraSavedAt = now;
    const text = JSON.stringify({ distance: +this.distance.toFixed(2), pitch: +this.pitch.toFixed(2), orbit: +wrapDegrees(this.orbit).toFixed(2) });
    if (text === this.cameraSaved) return;
    this.cameraSaved = text;
    try { localStorage.setItem(CAMERA_STORE, text); } catch { /* private mode: this session only */ }
  }

  resetCamera() {
    this.orbit = 0;
    this.distance = cameraConfig.distance;
    this.pitch = cameraConfig.pitch;
  }

  setTargetVehicles(position: [number, number], heading: number) {
    this.mode = 'roam';
    this.eventOffer = null;
    this.eventCooldown = 0;
    this.race.goal = null;
    this.combat.wins.clear();
    this.clearEventBots();
    this.coins.pickups.clear();
    this.combatLayer?.setPickups([]);
    this.coins.pickupFocus = null;
    this.coins.pickupNetworkRevision = -1;
    // Purse / garage / collected only once per run. Spawn click / road retarget used to
    // call this again with carry already spent → STARTING_CASH and wiped progress on save.
    if (!this.runReady) {
      const carry = this.carry;
      const resumeHp = carry?.at?.hp;
      this.playerHp = resumeHp != null ? Math.max(1, Math.min(this.playerMaxHp, resumeHp)) : this.playerMaxHp;
      this.coins.collectedPickups = new Map((carry?.collected?.filter((id) => typeof id === 'string') ?? []).map((id) => [id, null] as [string, Position | null]));
      this.collectedFrom = carry?.at?.position ? [...carry.at.position] as Position : null;
      // Intro: empty garage + STARTING_CASH (prod). GIFT_CARS only in next.devs.
      // The menu car is bought when setDriving(true) — not on boot spawn.
      this.fuel.level = this.fuel.spec.tank * (carry?.fuel ?? 1);
      this.shops.loanDebt = Math.max(0, Math.round(carry?.loan ?? 0));
      this.garage = new Set((carry?.garage ?? []).filter((id) => carsConfig.some((car) => car.id === id)));
      for (const id of GIFT_CARS) {
        if (carsConfig.some((car) => car.id === id)) this.garage.add(id);
      }
      if (carry?.at) this.garage.add(this.car.id);
      this.playerMoney = carry
        ? Math.max(0, Math.floor(carry.money))
        : STARTING_CASH;
      this.carry = null;
      this.runReady = true;
      this.fuelOut = false;
      this.onFuelOut(false);
    }
    const roads = this.map.features('transportation') as MapFeature[];
    this.trafficNetwork.addFeatures(roads);
    this.trafficNetwork.flushRebuild();
    this.combat.vehicleContactTimes.clear();
    this.board.placeEventBeacons();
    this.combat.ensureTrafficMarkers();
    this.combatLayer?.setTargets([]);
    this.combatLayer?.setRaceFinish(null);
    this.coins.syncRoadPickups();
    this.onEventOffer(null);
  }

  /** Snapshot for localStorage so a refresh lands back mid-drive. */
  snapshot(place: { name: string; country: string; coords: [number, number] }): GameSave | null {
    if (!this.runReady) return null;
    const collected = [...this.coins.collectedPickups.keys()];
    // keep the newest ids if the list grows huge (localStorage quota)
    if (collected.length > 4000) collected.splice(0, collected.length - 4000);
    return {
      money: Math.floor(this.playerMoney),
      fuel: this.fuel.ratio,
      hp: this.playerHp,
      carId: this.crime.heist?.stolen?.previousId ?? this.car.id, // a stolen car is never kept
      position: [...this.vehicle.position] as [number, number],
      heading: this.vehicle.heading,
      place: { name: place.name, country: place.country, coords: [...place.coords] as [number, number] },
      collected,
      loan: this.shops.loanDebt,
      garage: [...this.garage],
    };
  }

  /** Put the car back where a save left it (before setDriving from the menu). */
  resumeFrom(at: { position: [number, number]; heading: number }) {
    this.spawn.customSpawn = { position: [...at.position], heading: at.heading };
    this.vehicle.position = [...at.position];
    this.vehicle.heading = at.heading;
    this.bearing = at.heading * 180 / Math.PI;
    this.renderVehicle.reset(this.vehicle);
    // Spawn already applied money/hp/coins via carry — do not reset them again.
    // (a boot timeout can mark the spawn resolved while the saved purse is still pending)
    if (!this.spawn.spawnResolved || this.carry) {
      this.spawn.spawnResolved = true;
      this.setTargetVehicles(at.position, at.heading);
    }
  }

  /** Leave the road for the intro: drop missions, keep purse / garage / place. */
  leaveToMenu() {
    this.hauler.release(null);
    if (this.board.errand) { this.board.clearErrand(); this.board.completeActiveMission(); }
    if (this.jobs.taxi.pending || this.jobs.taxi.active) this.jobs.suspendTaxi();
    if (this.jobs.busTour.pending || this.jobs.busTour.active) this.jobs.suspendBusTour();
    this.mode = 'roam';
    this.crime.heist = null;
    this.race.dropFinish();
    this.clearEventBots();
    this.eventOffer = null;
    this.onEventOffer(null);
    this.onEventResult(null);
    this.jobs.onRideOffer(null);
    this.wanted.fight = false;
    this.fuelOut = false;
    this.onFuelOut(false);
    this.playerHp = this.playerMaxHp;
    this.keys.clear();
    this.vehicle.speed = 0;
    this.vehicle.throttle = 0;
  }

  /** Wipe the purse and garage (only for a hard reset — not the usual exit). */
  resetRun() {
    this.leaveToMenu();
    this.spawn.customSpawn = null;
    this.spawn.defaultSpawn = null;
    this.spawn.spawnResolved = false;
    this.runReady = false;
    this.playerMoney = 0;
    this.carry = null;
    this.coins.collectedPickups.clear();
    this.shops.loanDebt = 0;
    this.garage.clear();
    this.coins.pickups.clear();
    this.combatLayer?.setPickups([]);
    this.fuel.level = this.fuel.spec.tank;
    this.spawn.onSpawnSet(null);
  }

  clearEventBots() {
    this.race.clear();
    this.trafficBots = [];
    this.combat.hunterGuns.clear();
    this.crime.policeFar.clear();
    this.botDriver.forget();
    this.combatLayer?.setTargets([]);
    this.combat.ensureTrafficMarkers();
  }

  pickBeaconSpot(
    position: [number, number],
    heading: number,
    seed: number,
    avoid: [number, number][],
    band: { min: number; max: number } = { min: 220, max: 1100 },
  ): [number, number] {
    const dry = (spot: [number, number]) => !this.water.inSea(spot, this.cachedWater);
    const farEnough = (spot: [number, number], fromPlayer: number, fromOthers: number) =>
      metersBetween(spot, position) >= fromPlayer
      && !avoid.some(other => metersBetween(spot, other) < fromOthers);
    for (let attempt = 0; attempt < 36; attempt++) {
      const min = band.min + (attempt % 4) * 40;
      const max = band.max + (attempt % 5) * 80;
      const node = this.trafficNetwork.randomAway(position, new Set(), min, max, seed + attempt * 97)
        ?? this.trafficNetwork.randomAway(position, new Set(), Math.max(120, min * 0.6), max * 1.25, seed + attempt * 97 + 13);
      if (!node) continue;
      const spot = [...node.position] as [number, number];
      if (!dry(spot)) continue;
      // later missions have a fuller avoid list — ease spacing after many misses
      const gap = attempt < 20 ? 280 : attempt < 28 ? 160 : 90;
      if (!farEnough(spot, band.min * 0.75, gap)) continue;
      return spot;
    }
    const ahead = this.trafficNetwork.destinationAhead(position, heading, seed);
    if (ahead) {
      const spot = [...ahead] as [number, number];
      if (dry(spot) && farEnough(spot, 160, 90)) return spot;
    }
    // Last road fallback: any dry node away from the player — never pin a mission on spawn.
    for (let attempt = 0; attempt < 24; attempt++) {
      const node = this.trafficNetwork.randomAway(position, new Set(), 300, 2000, seed ^ (0x51f3 + attempt * 41));
      if (!node) continue;
      const spot = [...node.position] as [number, number];
      if (!dry(spot) || metersBetween(spot, position) < 200) continue;
      return spot;
    }
    // Few roads round here: a ring of spots 0.5–0.9 km out, the first dry one clear of the
    // other events (a single "420 m ahead" stacked every event on one spot)
    const turn = (Math.abs(seed) % 360) * Math.PI / 180;
    for (let n = 0; n < 24; n++) {
      const angle = heading + turn + n * (Math.PI * 2 / 12);
      const r = 500 + (n % 3) * 200;
      const spot = offsetMeters(position, Math.sin(angle) * r, Math.cos(angle) * r) as [number, number];
      if (dry(spot) && !avoid.some((other) => metersBetween(spot, other) < 150)) return spot;
    }
    return offsetMeters(position, Math.sin(heading + turn) * 420, Math.cos(heading + turn) * 420);
  }

  /** parked cars to shoot at (?testcars=N) */
  testCars = new TestTargets((from, at, heading) => {
    if (this.collisions.blocked(from, at, heading, 1, this.altitude) || this.water.resolve(from, at, heading, 1, this.ground.onBridgeDeck(at, this.altitude)).stopped) return false;
    // on the same surface as us (not the river beside a bridge, not a roof)
    const ground = this.map.groundAt(at, this.altitude);
    return ground != null && Math.abs(ground - this.altitude) <= 2;
  });

  hitNoticeAt = 0;

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

  /** Is the ground round this arrival point already loaded (no wait to land there)? */
  private arrivalReady(position: Position) {
    return this.map.areTilesLoadedAround(position as [number, number], ARRIVAL_M);
  }

  /**
   * The nearest of `places` whose ground is already loaded, so a tow, a rescue or an arrest
   * lands at once; null when none is (then the car goes to a free spot on a road nearby).
   */
  private nearestReady<T>(places: Iterable<T>, at: (place: T) => Position): T | null {
    const here = this.vehicle.position;
    let ready: T | null = null, readyD = Infinity;
    for (const place of places) {
      const d = metersBetween(here, at(place));
      if (d < readyD && this.arrivalReady(at(place))) { ready = place; readyD = d; }
    }
    return ready;
  }

  /** The closest hospital or filling station to us (of those already loaded, if any). */
  nearestRescue(): { kind: 'hospital' | 'station'; position: Position } | null {
    const places: { kind: 'hospital' | 'station'; position: Position }[] = [];
    const consider = (kind: 'hospital' | 'station', position: Position) => { places.push({ kind, position }); };
    for (const civic of this.places.civics.values()) if (civic.kind === 'hospital') consider('hospital', civic.position);
    for (const station of this.places.stations.values()) consider('station', station.place ?? station.position);
    return this.nearestReady(places, (p) => p.position);
  }

  /** Our car, standing still on the road nearest `position` (or right on it). */
  placeCarAt(position: Position, after?: () => void) {
    if (this.transfer.pending) return;
    const commit = () => { this.commitCarPlacement(position); after?.(); };
    // Only the ground under the arrival has to be in (its tile and the ones touching ARRIVAL_M
    // round it, built and uploaded): the rest streams in as on any drive. Waiting for the whole
    // 2.8 km ring took tens of seconds behind a "preparing" dialog.
    if (this.map.areTilesLoadedAround(position, ARRIVAL_M)) { commit(); return; }
    this.transfer.begin(position, commit, performance.now());
    this.vehicle.speed = 0;
    this.vehicle.throttle = 0;
    this.keys.clear();
    this.stopGun();
    this.map.setStreamDestination(position, ARRIVAL_M);
    this.onTransfer('loading');
  }

  retryTransfer() {
    this.transfer.retry(performance.now());
    if (this.transfer.pending) this.map.setStreamDestination(this.transfer.pending.at, ARRIVAL_M);
    this.onTransfer(this.transfer.state);
  }

  cancelTransfer() {
    this.transfer.cancel();
    this.map.setStreamDestination(null);
    this.onTransfer(null);
  }

  private tickTransfer(now: number) {
    const pending = this.transfer.pending;
    if (!pending || this.transfer.state !== 'loading') return;
    const before = this.transfer.state;
    this.transfer.tick(now, this.map.areTilesLoadedAround(pending.at, ARRIVAL_M));
    if (this.transfer.state !== before) {
      this.map.setStreamDestination(null);
      this.onTransfer(this.transfer.state);
    }
  }

  private commitCarPlacement(position: Position) {
    this.feed.worldWork = null;
    // Destination data may be far outside the old gameplay caches.
    this.cachedWater = this.map.features('water', position) as MapFeature[];
    this.cachedRoads = this.map.features('transportation', position) as MapFeature[];
    const start = this.spawn.findFreeRoad(position, 120)
      ?? roadStart(this.map, position, () => false, 120);
    this.vehicle.position = start ? [...start.position] : [...position];
    if (start) this.vehicle.heading = start.heading;
    this.vehicle.speed = 0;
    this.vehicle.throttle = 0;
    this.bearing = this.vehicle.heading * 180 / Math.PI;
    this.renderVehicle.reset(this.vehicle);
    this.accumulator = 0;
    this.collisionDirty = true;
    this.syncedAt = null;
    this.ground.airborne = false;
    this.ground.climb = 0;
    this.ground.plunge = null;
    this.ground.wheelTargets.ready = false;
    this.modelPitch = 0;
    this.modelRoll = 0;
    if (this.settings.terrain) {
      const ground = this.map.groundAt(this.vehicle.position);
      if (ground != null) this.altitude = ground;
    }
    // Commit the view in the same frame as the car. The UI is still paused
    // until React closes its modal; leaving the old camera here would let the
    // next streamer frame immediately evict the destination we just prepared.
    this.overview = 0;
    this.overviewTarget = 0;
    this.overviewFree = false;
    this.overviewLeave = null;
    this.map.setScreenStream(false);
    this.setMapViewUi(false);
    this.setOverviewMapNav(false);
    this.orbit = 0;
    this.distance = cameraConfig.distance;
    this.pitch = cameraConfig.pitch;
    const zoom = zoomForDistance(this.distance, this.vehicle.position[1]);
    const ahead = lookAheadFor(zoom, this.vehicle.position[1]);
    const center = offsetPosition(this.vehicle.position, Math.sin(this.vehicle.heading) * ahead, Math.cos(this.vehicle.heading) * ahead);
    this.map.jumpTo({ center, zoom, pitch: this.pitch, bearing: this.bearing, elevation: this.altitude });
    this.map.setFocusCar(this.vehicle.position, this.altitude, this.vehicle.heading, 0);
  }

  /**
   * Rivals for a race or the arena: `n` different cars priced close to ours — picked at random
   * from the nearest few by price (a ratio, so cheap and dear cars are matched alike).
   * Police, emergency and odd vehicles stay out.
   */
  rivalCars(n: number): Car[] {
    const ours = Math.max(1, carPrice(this.car));
    const pool = carsConfig
      .filter((car) => !RIVAL_EXCLUDED.has(car.id) && car.id !== this.car.id)
      .map((car) => ({ car, gap: Math.abs(Math.log(Math.max(1, carPrice(car)) / ours)) }))
      .sort((a, b) => a.gap - b.gap)
      .slice(0, Math.max(n, 6))
      .map((entry) => entry.car);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return Array.from({ length: n }, (_, i) => pool[i % pool.length] ?? carsConfig[0]);
  }

  /** Closest police station, prison, courthouse or hospital to the wreck. */
  /** The closest police station, court or prison (of those already loaded, if any). */
  private nearestCivic(): { station: Station; kind: CivicKind; distance: number } | null {
    const station = this.nearestReady(this.places.civics.values(), (s) => s.position);
    return station ? { station, kind: station.kind, distance: metersBetween(this.vehicle.position, station.position) } : null;
  }

  /** Coins fly out (ten from a wreck, one from a tree) and roll a couple of metres before they lie still. */

  /** Send a chat line to everybody. */
  chat(text: string) { this.players.say(text); }

  /** our name on the roster and in multiplayer */
  playerName = '';

  /** Join the shared world under this name (again: just a rename). */
  joinNetwork(name: string) {
    this.playerName = name.trim();
    this.players.join(this.playerName);
  }

  /** Where we are on the M map — same pin as the intro spawn marker. */
  private updateSelfMarker() {
    if (!this.mapInspecting()) {
      if (this.selfMarker) this.selfMarker.getElement().style.display = 'none';
      return;
    }
    if (!this.selfMarker) {
      const element = document.createElement('div');
      element.className = 'self-map-marker';
      element.setAttribute('aria-label', t('you'));
      element.innerHTML = `<b></b><svg width="18" height="26" viewBox="0 0 28 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M14 0C6.268 0 0 6.268 0 14c0 9.8 14 26 14 26S28 23.8 28 14C28 6.268 21.732 0 14 0z" fill="#d8f06a" stroke="#1a2818" stroke-width="1.5"/></svg>`;
      const label = element.querySelector('b');
      if (label) label.textContent = t('you');
      this.selfMarker = newMarker({ element, anchor: 'bottom' }).addTo(this.map);
    }
    const element = this.selfMarker.getElement();
    element.style.display = '';
    const label = element.querySelector('b');
    if (label) label.textContent = t('you');
    this.selfMarker.setLngLat(this.renderVehicle.position as [number, number]);
  }

  /** The language changed: labels made once (services, hubs, missions, pins, goals) are made again. */
  private relabel() {
    if (!this.ready) return;
    for (const marker of this.places.serviceMarkers.values()) marker.remove();
    this.places.serviceMarkers.clear();
    this.places.labelServices();
    this.travel.clearMarkers();
    this.travel.refreshMarkers();
    for (const mission of this.board.missions) mission.label = t(`mission.${mission.kind}`, { n: mission.n });
    for (const marker of this.board.errandMarkers.values()) marker.remove();
    this.board.errandMarkers.clear();
    for (const tip of this.board.errandIndicators.values()) tip.element.remove();
    this.board.errandIndicators.clear();
    this.board.syncErrandMarkers();
    this.wanted.marker?.remove();
    this.wanted.marker = null;
    for (const pin of Object.values(this.jobs.jobPins)) pin.remove();
    this.race.removeMarkers();
    this.race.syncMarkers();
    if (this.board.focusIndicator) this.board.focusIndicator.element.setAttribute('aria-label', t('marker.target'));
    this.selfMarker?.getElement().setAttribute('aria-label', t('you'));
    this.pins.relabel();
    this.board.syncMissionVisuals();
    this.board.updateEventMarkers();
  }

  /** Live range on a map pin while driving; blank on the M map (plaque only). */
  setMapPinRange(marker: MapMarker | null | undefined, target: [number, number] | null, show: boolean) {
    setPinRange(marker, this.vehicle.position, target, show && !this.mapInspecting());
  }

  updateOffscreenMarker(
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
    // edge arrow only off-frame; in frame placeIndicator hides the HUD (map pin owns it)
    this.placeTargetIndicator(marker, target, Number.POSITIVE_INFINITY);
  }

  /**
   * `burn` — house windows on fire only (separate call type).
   * `crash` — 1–2 wrecks: roadside (often overturned), or nosed into a house with the
   * car on fire (house itself is not burning). Clear with null.
   */
  setAmbulanceScene(kind: AmbulanceSite | null, at: Position | null): { site: AmbulanceSite; cars: number } | null {
    this.trafficBots = this.trafficBots.filter((b) => !isAmbulanceWreckId(b.id));
    // clear smolder unless the fire truck owns a live call
    if (!this.jobs.fire.active) this.combatLayer?.setFireHouse(null);
    if (!kind || !at) {
      this.combatLayer?.setTargets(this.combat.targetVehicles());
      return null;
    }
    if (kind === 'burn') {
      // cap pane scan — London blocks otherwise build thousands of windows in one hitch
      const facades = this.map.fireFacadesNear(at, 55, 24);
      if (facades?.panes.length && !this.jobs.fire.active) {
        const n = Math.min(facades.panes.length, 4 + (Math.abs(Math.round(at[0] * 1e4)) % 5));
        const panes = facades.panes.slice(0, n).map((p) => ({
          at: p.at as [number, number],
          altitude: p.altitude,
          oe: p.oe,
          on: p.on,
        }));
        this.combatLayer?.setFireHouse({ panes, available: Math.max(facades.panes.length, n) });
        this.combatLayer?.setTargets(this.combat.targetVehicles());
        return { site: 'burn', cars: 0 };
      }
      // no façade nearby — fall back to a roadside crash at the same pin
      return this.setAmbulanceScene('crash', at);
    }
    const seed = (Math.round(at[0] * 1e5) ^ Math.round(at[1] * 1e5) ^ (performance.now() | 0)) >>> 0;
    const roll = (salt: number) => ((Math.imul(seed ^ salt, 2654435761) >>> 0) / 4294967296);
    // ~30% two-car pile-up; singles are the common roadside call
    const cars = roll(0xc1) < 0.3 ? 2 : 1;
    const facades = this.map.fireFacadesNear(at, 55, 24);
    const canHouse = Boolean(facades?.panes.length);
    // single car nosed into a house (car burns — house does not)
    const intoHouse = cars === 1 && canHouse && roll(0xc2) < 0.4;
    const choices = carsConfig.filter((car) =>
      car.id !== HAULER_ID && car.id !== FIRE_TRUCK_ID && car.id !== BUS_ID && car.id !== AMBULANCE_ID && !POLICE_IDS.has(car.id));
    const baseHeading = this.vehicle.heading + ((seed & 1) ? Math.PI / 2 : -Math.PI / 2);
    const bots: { bot: TrafficBot; overturned: boolean; burning: boolean }[] = [];
    for (let i = 0; i < cars; i++) {
      const car = choices[Math.abs(seed + i * 97) % choices.length] ?? carsConfig[0];
      const heading = baseHeading + (i ? (roll(0xd0 + i) - 0.5) * 1.1 : 0);
      let pin: Position = [...at] as Position;
      if (i === 1) {
        const side = roll(0xe0) < 0.5 ? -1 : 1;
        const gap = 4.2 + roll(0xe1) * 2.2;
        pin = offsetPosition(at, Math.cos(baseHeading) * side * gap, -Math.sin(baseHeading) * side * gap);
      } else if (intoHouse && facades) {
        const pane = facades.panes[0];
        pin = offsetPosition(at, pane.oe * 2.4, pane.on * 2.4);
      }
      const id = ambulanceWreckId(i);
      const bot = createTrafficBot(id, t('ambulance.marker.crash'), car, this.trafficNetwork, pin, heading, new Set(), 'explore', seed + i, { min: 0, max: 40 });
      bot.controller.position = [...pin] as Position;
      bot.controller.heading = heading;
      bot.controller.speed = 0;
      bot.position = [...pin] as Position;
      bot.heading = heading;
      bot.route = [];
      bot.goal = null;
      bot.repathAt = Number.POSITIVE_INFINITY;
      // into house: car on fire, usually upright; roadside: often overturned, sometimes burning
      const overturned = intoHouse ? roll(0xf0 + i) < 0.25 : roll(0xf0 + i) < 0.7;
      const burning = intoHouse || roll(0xf8 + i) < 0.45;
      bots.push({ bot, overturned, burning });
    }
    this.trafficBots = [...this.trafficBots, ...bots.map((b) => b.bot)];
    this.combatLayer?.setTargets(this.combat.targetVehicles());
    for (const { bot, overturned, burning } of bots) {
      this.combatLayer?.plantPropWreck(bot.id, { overturned, burning });
    }
    return { site: 'crash', cars };
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

  /** Map label for the fire call; HUD tip comes from the focus cycle. */

  /** Category chips + world plaques: only while the M map is open. */
  mapViewOpen() {
    return this.overviewTarget > 0 || this.overview > 0.4;
  }

  private setMapViewUi(open: boolean) {
    if (this.mapViewUi === open) {
      this.places.refreshMapLabels(true);
      return;
    }
    this.mapViewUi = open;
    this.onMapView(open);
    // plaques stay in the 3D world while driving — only the chip strip is map-only
    this.places.refreshMapLabels(true);
  }

  private updateFuel(_dt: number) {
    const herePos = this.vehicle.position;
    const station = atStation(herePos, [...this.places.stations.values()], SERVICE_REACH.fuel);
    const shop = atStation(herePos, [...this.places.repairShops.values()], SERVICE_REACH.repair);
    const dealer = atStation(herePos, [...this.places.dealerships.values()], SERVICE_REACH.dealer);
    const now = performance.now();
    const bank = atStation(herePos, [...this.places.banks.values()].filter((b) => (this.crime.bankShut.get(b.id) ?? 0) <= now), SERVICE_REACH.bank);
    this.refuelling = false;
    // arriving (slowly) at a station, service, showroom or bank opens its dialog once per visit
    const here = station ?? shop ?? dealer ?? bank;
    if (!here) this.offeredService = null;
    // not before the saved run (purse, garage, health) is in: a dialog would show it empty
    else if (this.runReady && here.id !== this.offeredService && Math.abs(this.vehicle.speed) < 7 && !this.shops.serviceOpen && !this.dealer.open && !this.shops.bankOpen && !this.travel.open && !this.fuelOut && this.mode === 'roam') {
      this.offeredService = here.id;
      if (dealer && here.id === dealer.id) this.dealer.tryOpen();
      else if (bank && here.id === bank.id) this.shops.openBank();
      else this.shops.openService(station ? 'fuel' : 'repair');
    }
    if (this.fuel.empty && Math.abs(this.vehicle.speed) < 0.3 && !this.fuelOut && !station) {
      this.fuelOut = true;
      this.keys.clear();
      this.onFuelOut(true);
    }
  }

  /** Tow truck (empty tank, or stuck — E): to the nearest known station, tank filled, for EVACUATION_COST coins. */
  evacuate() {
    if (!this.driving || this.transfer.pending) return;
    // the nearest station whose ground is already loaded (the tow arrives at once)
    const nearStation = this.nearestReady(this.places.stations.values(), (s) => s.position);
    const near = nearStation ? { station: nearStation } : null;
    const finish = () => {
      this.playerMoney = Math.max(0, this.playerMoney - EVACUATION_COST);
      // The tow includes a full tank, charged only after arrival is ready.
      this.fuel.level = this.fuel.spec.tank;
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
    };
    // no station loaded: a free spot on a road nearby (the tank is filled all the same)
    const towSpot = near ? near.station.position : this.spawn.nearbyRoadSpot();
    if (towSpot && this.mapLoaded) this.placeCarAt(towSpot, finish);
    else finish();
  }

  /** Pitched chase-style framing (fly-in / resume), not the intro menu. */
  introView() {
    return {
      center: this.vehicle.position as [number, number],
      zoom: 16.8,
      pitch: 57,
      bearing: this.vehicle.heading * 180 / Math.PI - 25,
      elevation: this.altitude,
    };
  }

  /** Intro menu: top-down city map (same as M while driving) — pan/zoom, click to place spawn. */
  showIntroMap() {
    const center = this.vehicle.position as [number, number];
    this.overview = 1;
    this.overviewTarget = 1;
    this.overviewFree = true;
    this.overviewLeave = null;
    this.menuView = null;
    this.map.setScreenStream(true);
    this.map.setStreamCalm(false);
    this.map.jumpTo({
      center,
      zoom: this.overviewZoom(center[1]),
      pitch: 0,
      bearing: 0,
      elevation: this.altitude,
    });
    this.map.setInteractive({ pan: true, rotate: false });
    this.setMapViewUi(true);
    queueMicrotask(() => { if (!this.driving && this.overviewFree) this.places.refreshMapLabels(true); });
  }

  revealMap() {
    if (this.mapShown || this.disposed) return;
    // never an intro before the run's purse and garage are in (whatever way the spawn
    // was settled): the intro and the engine must agree on what we own
    if (!this.runReady) this.setTargetVehicles([...this.vehicle.position] as [number, number], this.vehicle.heading);
    this.mapShown = true;
    // The ring is prepared while hidden. Visible frames use the normal upload budget.
    this.map.endStreamBurst();
    this.feed.bootBurstUntil = 0;
    this.showIntroMap();
    this.host.style.transition = 'opacity .7s ease';
    this.host.style.opacity = '1';
    this.onBoot(true);
    this.say(t('status.ready'));
  }

  setPaused(value: boolean) {
    this.paused = value;
    if (!value) return;
    // Pause simulation, never the world streamer (including a paused map blend).
    this.map.setStreamCalm(false);
    this.keys.clear();
    this.dragging = false;
    this.aimingFire = false;
    this.combatLayer?.setFiring(false);
    this.aimHud(0, 0, false, false);
  }

  /** the camera is still flying in from the menu view (HUD waits for it) */
  get approaching() { return this.approachFrom != null; }

  /** Into the car (or out). False when it could not start (the car is not affordable). */
  setDriving(value: boolean, approach = true): boolean {
    if (!value) { this.cancelTransfer(); this.race.cancelPreparation(); }
    // the view from above belongs to one mode; switching modes lands back on the ground
    this.overview = 0;
    this.overviewTarget = 0;
    this.overviewFree = false;
    this.overviewLeave = null;
    this.map.setScreenStream(false);
    this.menuView = null;
    const starting = value && !this.driving;
    this.driving = value;
    // after driving flips: keep / drop world plaques with the new mode
    this.setMapViewUi(false);
    this.paused = false;
    if (!value) {
      this.eventOffer = null;
      this.onEventOffer(null);
      this.onEventResult(null);
      this.hauler.release(null);
      // leaving the car drops an errand (its markers go with it)
      if (this.board.errand) { this.board.clearErrand(); this.board.completeActiveMission(); }
      if (this.mode !== 'roam') {
        this.mode = 'roam';
        this.crime.heist = null;
        this.race.dropFinish();
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
      if (this.spawn.spawnMarker) {
        const el = this.spawn.spawnMarker.getElement();
        if (el) el.style.display = '';
      }
      const moving = this.approachFrom != null;
      this.approachFrom = null;
      if (moving) this.onApproach(false);
      if (this.mapShown) this.showIntroMap();
      return true;
    }
    if (this.spawn.spawnMarker) {
      const el = this.spawn.spawnMarker.getElement();
      if (el) el.style.display = 'none';
    }
    // Apply custom / save spawn before driving starts
    if (starting && this.spawn.customSpawn) {
      this.vehicle.position = [...this.spawn.customSpawn.position];
      this.vehicle.heading = this.spawn.customSpawn.heading;
      this.bearing = this.spawn.customSpawn.heading * 180 / Math.PI;
      this.spawn.spawnResolved = true;
      this.renderVehicle.reset(this.vehicle);
      this.accumulator = 0;
    }
    // First pull-out: buy the intro car if it isn't already in the garage
    if (starting && !this.garage.has(this.car.id)) {
      const price = carPrice(this.car);
      if (price > this.playerMoney) {
        this.driving = false;
        this.say(t('event.broke', { fee: formatNumber(price) }), true);
        return false;
      }
      this.playerMoney -= price;
      this.garage.add(this.car.id);
    }
    // Disable map interactivity while driving
    this.map.setInteractive({ pan: false, rotate: false });
    if (starting && approach) {
      // Boot already warmed the ring. Keep upload work out of the fly-in, but
      // animate from the actual visible view instead of skipping its first half.
      this.map.endStreamBurst();
      this.map.setStreamCalm(true);
      this.feed.bootBurstUntil = 0;
      const center = this.map.getCenter();
      this.approachFrom = { center: [center.lng, center.lat], zoom: this.map.getZoom(), pitch: this.map.getPitch(), bearing: this.map.getBearing(), elevation: this.map.getCenterElevation() };
      this.approachElapsed = 0;
      this.onApproach(true);
      return true;
    }
    // Save resume / arrive: sit in chase cam on the first frame (no intro fly-in)
    if (starting && this.mapShown) {
      this.map.setStreamCalm(false);
      this.map.endStreamBurst();
      this.orbit = 0;
      this.distance = cameraConfig.distance;
      this.pitch = cameraConfig.pitch;
      this.bearing = this.vehicle.heading * 180 / Math.PI;
      const bearingRad = this.bearing * Math.PI / 180;
      const zoom = zoomForDistance(this.distance, this.vehicle.position[1]);
      const ahead = lookAheadFor(zoom, this.vehicle.position[1]);
      const look = offsetPosition(this.vehicle.position, Math.sin(bearingRad) * ahead, Math.cos(bearingRad) * ahead);
      this.map.jumpTo({
        center: look as [number, number],
        zoom,
        pitch: this.pitch,
        bearing: this.bearing,
        elevation: this.altitude,
      });
      this.feed.bootBurstUntil = 0;
    }
    // no fly-in this time (already driving, or straight into the chase cam): the page must
    // not wait for one
    if (this.approachFrom == null) this.onApproach(false);
    return true;
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

  /**
   * Our world: buildings are already drawn from tiles and unique per tile, so no
   * re-reading, dedup or near-set here. Collisions come straight from footprints.
   */
  private *collectWorldThree(refreshTiles: boolean): Generator<null, void> {
    const world = this.map.world;
    if (refreshTiles) this.tilesIngested = true;
    this.collisions.update(this.vehicle.position, world.buildingsNear(this.vehicle.position, 260, this.map.exaggeration));
    yield null;
    const center = this.map.getCenter();
    const focus: [number, number] = this.driving ? this.vehicle.position : [center.lng, center.lat];
    this.syncedAt = [focus[0], focus[1]];
    yield null;
    yield* this.collectGround(refreshTiles, focus);
    // After water + roads are in: place / re-check the default car on a free street.
    if (!this.spawn.spawnResolved && this.map.features('transportation').length) this.spawn.resolveSpawn();
    else if (this.spawn.spawnResolved) this.spawn.ensureDefaultSpawnClear();
  }

  *collectWorldSteps(refreshTiles: boolean): Generator<null, void> {
    yield* this.collectWorldThree(refreshTiles);
  }

  /** Roads, water, green areas and stations for collisions and gameplay. */
  private *collectGround(refreshTiles: boolean, focus: [number, number]): Generator<null, void> {
    this.trafficNetwork.prune(focus, 6000);
    yield null;
    if (refreshTiles) {
      const now = performance.now();
      const batch = [...this.feed.pendingIngest];
      this.feed.pendingIngest.clear();
      // Full features() only on boot / rare prune / cache bloat — not on every dirty bit.
      const forceFull = !this.tilesIngested
        || now - this.fullScoopAt > 60000
        || this.cachedRoads.length > 8000
        || this.cachedWater.length > 4000;

      if (forceFull) {
        this.cachedWater = this.feed.readSourceLayer('water');
        yield null;
        this.cachedRoads = this.feed.readSourceLayer('transportation');
        this.rails.addFeatures(this.cachedRoads);
        this.rails.prune(focus, 6000);
        this.trafficNetwork.addFeatures(this.cachedRoads);
        yield null;
        this.trafficNetwork.flushRebuild();
        yield null;
        this.coins.syncRoadPickups();
        this.cachedLanduse = this.feed.readSourceLayer('landuse');
        this.places.collectStations();
        this.places.paintFuelStations();
        this.places.labelServices();
        this.travel.refreshMarkers();
        this.fullScoopAt = now;
        this.feed.rememberIngested(focus);
        yield null;
      } else if (batch.length) {
        let n = 0;
        for (const key of batch) {
          this.feed.absorbTile(key);
          if (++n % 3 === 0) yield null;
        }
        this.rails.prune(focus, 6000);
        yield null;
        if (this.trafficNetwork.flushRebuild()) {
          this.coins.syncRoadPickups();
          yield null;
        }
        this.places.paintFuelStations();
        this.places.labelServices();
        this.travel.refreshMarkers();
        yield null;
      }
      // else: collisionDirty only (buildings) — collectWorldThree already refreshed solids
    } else if (this.trafficNetwork.flushRebuild()) {
      this.coins.syncRoadPickups();
      yield null;
    }

    this.water.collect(this.vehicle.position, this.cachedWater, this.cachedRoads);
    yield null;

  }

  private updateApproach(dt: number) {
    if (!this.driving || this.paused || document.hidden || !this.approachFrom) return;
    this.accumulator = 0;
    this.renderVehicle.reset(this.vehicle);
    this.orbit = 0;
    this.distance = cameraConfig.distance;
    this.pitch = cameraConfig.pitch;
    this.bearing = this.vehicle.heading * 180 / Math.PI;
    const bearingRad = this.bearing * Math.PI / 180;
    const zoom = zoomForDistance(this.distance, this.renderVehicle.position[1]);
    const ahead = lookAheadFor(zoom, this.renderVehicle.position[1]);
    const look = offsetPosition(this.renderVehicle.position, Math.sin(bearingRad) * ahead, Math.cos(bearingRad) * ahead);
    // Advance only while this branch is active: settings, a hidden tab or a
    // suspended frame must not consume the animation and skip ahead on resume.
    this.approachElapsed = Math.min(this.approachMs, this.approachElapsed + dt * 1000);
    const raw = this.approachElapsed / this.approachMs;
    const view = cameraTransition(this.approachFrom, {
      center: look, zoom, pitch: this.pitch, bearing: this.bearing, elevation: this.altitude,
    }, raw);
    this.map.setStreamCalm(true);
    this.map.setScreenStream(false);
    this.map.jumpTo(view);
    this.map.setFocusCar(this.renderVehicle.position, this.altitude, this.renderVehicle.heading, this.modelPitch);
    if (raw >= 1) {
      this.approachFrom = null;
      this.onApproach(false);
      this.map.setStreamCalm(false);
      this.map.beginStreamBurst();
      this.feed.bootBurstUntil = performance.now() + 2000;
    }
  }

  tick = (now: number) => {
    if (this.disposed) return;
    const cpuStart = performance.now();
    try {
    this.frame = requestAnimationFrame(this.tick);
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.1) : 0;
    this.last = now;
    this.noteFrame(now);
    if (!this.ready) return;
    this.tickTransfer(now);
    // fly-in: no world scoops / traffic / physics — those were the 17 fps хрясть
    if (!this.approachFrom) this.feed.pumpWorld(now);
    if (this.driving && !this.paused && !document.hidden && this.approachFrom) {
      this.updateApproach(dt);
    } else if (this.driving && !this.paused && !this.transfer.pending && !document.hidden) {
      this.accumulator += dt;
      let blocked = false;
      let shore = false;
      this.ground.tickPlunge(now);
      const gridded = this.race.countdown(now);
      this.trafficNetwork.beginFrame();
      while (this.accumulator >= 1 / 60) {
        this.renderVehicle.capture(this.vehicle);
        const previous: [number, number] = [...this.vehicle.position];
        const oldHeading = this.vehicle.heading;
        // An empty tank: no throttle, no boost; the car rolls out.
        this.tickNitro(1 / 60);
        const held = this.nitro.active || !this.keys.has('Space') ? this.keys : new Set([...this.keys].filter(key => key !== 'Space'));
        const driveKeys = this.fuel.empty ? new Set([...held].filter(key => !NO_FUEL_KEYS.has(key))) : held;
        const travelled = this.vehicle.distance;
        this.vehicle.step(1 / 60, driveKeys, { ...vehicleConfig, acceleration: this.car.acceleration, maxSpeed: this.car.maxSpeed });
        if (gridded || this.hauler.hangAltitude != null || this.hauler.towed || this.ground.plunge) {
          // on the grid: revs may build (clutch launch), the car stays put; on the cable it hangs
          this.vehicle.position = previous;
          this.vehicle.heading = oldHeading;
          this.vehicle.speed = 0;
        }
        // consumption follows the car's own distance (scale-independent)
        this.fuel.burn((this.vehicle.distance - travelled), 1 / 60, driveKeys.has('Space'));
        // knock trees/lamps on the bumper sweep — before walls/water rewrite the segment.
        // At ~250 km/h the centre point tunnels past trunks / skips while airborne over bumps;
        // stretch nose→tail and keep testing while still near the ground.
        const intended: [number, number] = [...this.vehicle.position];
        if (!this.ground.plunge && !gridded && Math.abs(this.vehicle.speed) > 1.5) {
          const ground = this.map.groundAt(intended, this.altitude) ?? this.altitude;
          const nearGround = !this.ground.airborne || this.altitude - ground < 3.5;
          if (nearGround) {
            const len = this.car.length;
            const se = Math.sin(this.vehicle.heading), ne = Math.cos(this.vehicle.heading);
            const from = offsetPosition(previous, -se * len * 0.2, -ne * len * 0.2) as [number, number];
            const to = offsetPosition(intended, se * len * 0.55, ne * len * 0.55) as [number, number];
            const knocked = this.map.knockDown(from, to, this.altitude, 1.7, Math.abs(this.vehicle.speed));
            if (knocked.clearedSolid) {
              // shelter / dumpster footprint gone — refresh walls this frame so we don't stick
              this.collisions.update(
                this.vehicle.position,
                this.map.world.buildingsNear(this.vehicle.position, 260, this.map.exaggeration),
              );
            }
            if (knocked.slowKmh > 0 && this.car.id !== BATMOBILE_ID) {
              // tree/shelter −50, bollard/bin/dumpster −10 — Batmobile shrugs it off
              const hit = knocked.slowKmh / 3.6;
              this.vehicle.speed = Math.sign(this.vehicle.speed) * Math.max(0, Math.abs(this.vehicle.speed) - hit);
            }
          }
        }
        // airborne: let the car fly into the river; water only stops surface driving
        if (!this.ground.plunge && !this.ground.airborne) {
          const building = this.collisions.resolve(previous, this.vehicle.position, this.vehicle.heading, 1, this.altitude);
          // how hard the wall hit: the speed it took off our step (m/s); a head-on hit at speed
          // often comes back as a slide along the wall, so both cases are measured the same way
          const wanted = this.vehicle.position as [number, number];
          const wallHit = (building.stopped || building.slid) ? metersBetween(wanted, building.position as [number, number]) * 60 : 0;
          const fast = Math.abs(this.vehicle.speed) > WALL_COIN_KMH / 3.6;
          if (wallHit > 3) this.audio.crash(wallHit / 30);
          // faster than 100 km/h into a wall (not a graze): three coins jump out of it
          if (fast && wallHit > WALL_COIN_HIT && now - this.coins.wallCoinsAt > 1500) {
            this.coins.wallCoinsAt = now;
            // the faster, the more: 100 km/h → 3, 150 → 5, 200 → 10
            const kmh = Math.abs(this.vehicle.speed) * 3.6;
            this.coins.wallCoins(building.position as [number, number], oldHeading, kmh >= 200 ? 10 : kmh >= 150 ? 5 : 3);
          }
          if (building.stopped) {
            this.vehicle.position = building.position;
            this.vehicle.heading = oldHeading;
            this.vehicle.speed = 0;
            blocked = true;
          } else if (building.slid) {
            this.vehicle.position = building.position;
            // light skim only — heavy damping made corners feel sticky
            this.vehicle.speed *= 0.97;
          } else if (this.rampTool.lift(previous, 3) != null || this.rampTool.lift(this.vehicle.position as [number, number], 3) != null) {
            // on a ramp out over a river: no shore, no water under the wheels — up it and off
            // its lip into the air (from there the jump decides: the far bank, or a splash)
          } else {
            // either end of the step on the deck → water must not wall or drown us
            const elevated = this.ground.onBridgeDeck(this.vehicle.position, this.altitude)
              || this.ground.onBridgeDeck(previous, this.altitude);
            const hit = this.water.resolve(previous, this.vehicle.position, this.vehicle.heading, 1, elevated);
            this.vehicle.position = hit.position;
            if (hit.stopped) {
              this.vehicle.speed = 0;
              shore = true;
            } else if (this.water.covers(this.vehicle.position, elevated)) {
              // under a bridge / already in the bath — splash and pull out on shore
              this.ground.beginPlunge(this.altitude);
            }
          }
        }
        // impound car waits still on the pin until hooked; a crash wreck stays planted
        this.botDriver.step(now, (bot) => gridded || bot.id === this.hauler.haul?.id
          || (bot.id === TOW_CAR_ID && this.jobs.impoundActive && this.hauler.haul?.id !== TOW_CAR_ID)
          || isAmbulanceWreckId(bot.id));
        this.ground.trainBlock(this.vehicle, this.altitude);
        for (const bot of this.trafficBots) {
          if (this.ground.trainBlock(bot.controller, this.map.groundAt(bot.position) ?? this.altitude)) bot.position = [...bot.controller.position];
        }
        this.combat.resolveVehicleContacts(now);
        this.players.bump(now);
        this.coins.collectRoadPickups();
        this.accumulator -= 1 / 60;
      }
      if (this.trafficBots.length) this.combatLayer?.updateTargets(this.combat.targetVehicles());
      this.combat.updateHunterGuns(now);
      this.crime.hijackHint();
      this.combat.syncExtraTargets(dt, now);
      this.updateFuel(dt);
      this.travel.update();
      if (blocked) this.say(t('hint.building'));
      else if (shore) this.say(t('hint.shore'));
      else if ([t('hint.building'), t('hint.shore')].includes(this.message)) this.say('');
      this.board.updateEvents();
      this.renderVehicle.update(this.vehicle, this.accumulator * 60);
      this.ground.plantWheels(dt, now);
      this.hauler.update(now);
      this.rampTool.update(now, dt);
      this.nudgeCamera(dt);
      const chaseDistance = this.distance;
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
      const zoom = zoomForDistance(chaseDistance, this.renderVehicle.position[1]);
      const ahead = lookAheadFor(zoom, this.renderVehicle.position[1]);
      const look = offsetPosition(this.renderVehicle.position, Math.sin(bearingRad) * ahead, Math.cos(bearingRad) * ahead);
      let center: [number, number] = look;
      let zoomNow = zoom;
      let pitchNow = this.pitch;
      let bearingNow = this.bearing;
      // map view from above: blend in, then free pan/zoom; blend out from where you were looking
      const step = dt / 1.2;
      this.overview = this.overviewTarget > this.overview ? Math.min(this.overviewTarget, this.overview + step) : Math.max(this.overviewTarget, this.overview - step);
      // open/hold: screen rectangle. closing: only while still mostly top-down —
      // mid-pitch unproject would inflate bounds; softKeep covers the rest of the blend
      this.map.setScreenStream(this.overviewTarget > 0 || this.overview > 0.65);
      // calm only during the camera blend; once the map is open keep streaming so panned tiles can appear
      const mapBlending = this.overviewTarget > 0 ? this.overview < 0.98 : this.overview > 0.02;
      this.map.setStreamCalm(mapBlending);
      if (this.overviewTarget > 0 && this.overview > 0.98) {
        if (!this.overviewFree) {
          this.overviewFree = true;
          this.setOverviewMapNav(true);
          this.stopGun();
          // labels next tick — same frame as leaving calm was hitching the open
          queueMicrotask(() => { if (this.overviewFree) this.places.refreshMapLabels(true); });
        }
        const c = this.map.getCenter();
        center = [c.lng, c.lat];
        zoomNow = this.map.getZoom();
        pitchNow = 0;
        bearingNow = 0;
        this.places.refreshMapLabels();
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
        this.map.setScreenStream(false);
      }
      if (this.overview <= 0.4 && this.overviewTarget <= 0 && this.mapViewUi) this.setMapViewUi(false);
      this.map.jumpTo({ center, zoom: zoomNow, pitch: pitchNow, bearing: bearingNow, elevation: this.altitude });
      this.map.setFocusCar(this.renderVehicle.position, this.altitude, this.renderVehicle.heading, this.modelPitch);
      this.updateAim();
    } else if (!this.driving) {
      this.map.setFocusCar(null);
      // intro / menu: already top-down — keep labels fresh while panning
      if (this.mapShown && this.overviewTarget > 0) {
        this.map.setScreenStream(true);
        this.places.refreshMapLabels();
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
    if (!this.approachFrom) {
      // UI pause stops simulation but not map activity population/loading.
      if (this.driving) this.board.refillMissions();
      this.updateTrains(dt);
      // players first: the bars must sit where their cars are drawn this frame, not the last one
      this.players.update();
      // Offscreen arrows must track every frame — 10 Hz made them stutter on turn
      this.combat.updateHealthMarkers(now - this.overlayTime > 100);
      this.combat.updateTrafficMarkers();
      this.board.updateEventMarkers();
      if (now - this.overlayTime > 100) {
        this.overlayTime = now;
        this.updateSelfMarker();
      }
    }
    this.soundFrame(now);
    this.coins.updateFieldCoins(now);
    if (now - this.hudTime > 100) {
      this.hudTime = now;
      if (!this.approachFrom) this.saveCamera(now);
      this.hud(this.vehicle.speed * 3.6, this.vehicle.distance, this.fps, this.combat.hudParticipants());
      if (!this.approachFrom) {
        const near = nearestStation(this.vehicle.position, [...this.places.stations.values()]);
        const hub = nearestHub(this.vehicle.position, [...this.travel.hubs.values()]);
        // only hint the hub when you're close enough that it matters (not from across town)
        const hubHint = hub?.hub.kind === 'airport' ? 800 : hub?.hub.kind === 'station' ? 220 : 120;
        const hubHud = hub && hub.distance < hubHint
          ? { kind: hub.hub.kind, distance: hub.distance }
          : null;
        this.onFuel({ level: this.fuel.level, tank: this.fuel.spec.tank, rpm: this.vehicle.revs, refuelling: this.refuelling, station: near ? near.distance : null, money: Math.floor(this.playerMoney), hub: hubHud });
      }
    }
    if (!this.mapShown) this.feed.settleBoot();
    if (!this.approachFrom) this.feed.tickStreamBurst(now);
    this.map.triggerRepaint();
    } finally {
      if (this.map.perfMonitor) this.map.reportUpdateCpu(performance.now() - cpuStart);
    }
  };

  /** The scene as heard this frame: our car, the street, sirens, engines and trains around. */
  private soundFrame(now: number) {
    const velocityOf = (speed: number, heading: number): [number, number] => [Math.sin(heading) * speed, Math.cos(heading) * speed];
    if (now - this.coins.urbanAt > 2000) {
      this.coins.urbanAt = now;
      // houses in the collision reach around us: a crowded street hums, a field is quiet
      this.coins.urbanLevel = Math.min(1, this.collisions.polygons.length / 400);
    }
    const alive = (id: string) => this.combatLayer?.isTargetAlive(id) !== false;
    const police = this.crime.heist
      ? this.trafficBots.filter((bot) => bot.id.startsWith('police') && alive(bot.id))
        .map((bot) => ({ id: bot.id, position: bot.position as [number, number], velocity: velocityOf(bot.controller.speed, bot.controller.heading) }))
      : [];
    const engines = [
      ...this.trafficBots.filter((bot) => !bot.id.startsWith('police') && alive(bot.id)),
      ...this.sharedTraffic.drivenBodies().map((body) => ({ id: body.id, position: body.controller.position, controller: body.controller })),
    ].map((bot) => ({ id: bot.id, position: bot.position as [number, number], velocity: velocityOf(bot.controller.speed, bot.controller.heading) }));
    // trains: the lead car of each, its speed from the last frame
    const trains = [];
    const seen = new Set<string>();
    for (const car of this.trainTraffic.poses()) {
      if (car.index !== 0) continue;
      seen.add(car.trainId);
      const last = this.trainHeard.get(car.trainId);
      const dt = last ? (now - last.at) / 1000 : 0;
      const velocity: [number, number] = last && dt > 0
        ? [(car.front[0] - last.front[0]) * 111_319.49 * Math.cos(car.front[1] * Math.PI / 180) / dt, (car.front[1] - last.front[1]) * 111_319.49 / dt]
        : [0, 0];
      this.trainHeard.set(car.trainId, { at: now, front: [...car.front] as [number, number] });
      trains.push({ id: car.trainId, position: [...car.front] as [number, number], velocity, kind: car.kind, vintage: isVintageTrain(car.trainId) });
    }
    for (const id of this.trainHeard.keys()) if (!seen.has(id)) this.trainHeard.delete(id);
    // our own siren while our lights are on
    const ownSiren = !this.beaconsOn ? null
      : this.car.id === AMBULANCE_ID ? 'ambulance' as const
        : POLICE_IDS.has(this.car.id) || this.car.id === FIRE_TRUCK_ID ? 'police' as const : null;
    const travel = this.vehicle.heading - this.vehicle.slip;
    this.audio.frame({
      active: this.driving && !this.paused && !this.approachFrom && !this.ground.plunge,
      revs: this.vehicle.revs,
      speed: this.vehicle.speed,
      throttle: this.keys.has('KeyW'),
      boost: this.nitro.active && !this.fuel.empty,
      slip: this.vehicle.slip,
      litres: this.car.engine,
      position: this.vehicle.position as [number, number],
      heading: this.vehicle.heading,
      velocity: velocityOf(this.vehicle.speed, travel),
      ear: this.map.cameraRange(),
      night: this.map.nightLevel(),
      urban: this.coins.urbanLevel,
      police,
      ownSiren,
      engines,
      trains,
    });
  }

  dispose() {
    this.race.cancelPreparation();
    this.cancelTransfer();
    this.disposed = true;
    this.audio.dispose();
    this.setMapViewUi(false);
    this.players.dispose();
    this.feed.worldWork = null;
    cancelAnimationFrame(this.frame);
    this.spawn.spawnMarker?.remove();
    for (const marker of this.board.missionMarkers.values()) marker.remove();
    this.board.missionMarkers.clear();
    this.pins.clear();
    this.race.removeMarkers();
    this.wanted.marker?.remove();
    for (const pin of Object.values(this.jobs.jobPins)) pin.remove();
    this.combatLayer?.setFireHouse(null);
    this.trafficBots = this.trafficBots.filter((b) => !isAmbulanceWreckId(b.id));
    this.eventIndicatorLayer?.remove();
    this.travel.clearMarkers();
    for (const marker of this.places.serviceMarkers.values()) marker.remove();
    this.places.serviceMarkers.clear();
    this.coins.pickups.clear();
    this.combatLayer?.setPickups([]);
    this.combat.trafficMarkerLayer?.remove();
    this.combat.trafficMarkers.clear();
    this.offLang();
    this.selfMarker?.remove();
    this.combat.healthMeters.dispose();
    this.cleanups.forEach((fn) => fn());
    this.map.remove();
  }
}
