import { roadStart } from './roadStart.ts';
import { VehiclePose } from './VehiclePose.ts';
import { supportAltitude, type GroundSample } from './groundSupport.ts';
import { BuildingCollisions } from './BuildingCollisions.ts';
import { WaterCollisionController, type MapFeature } from './WaterCollisionController.ts';
import { mapConfig, cars as carsConfig, carPrice, GIFT_CARS, STARTING_CASH, type City, type Car, vehicleConfig } from '@/config/vehicle.config';
import { cameraConfig, lookAheadFor, zoomForDistance } from '@/config/camera.config';
import { VehicleController, bumpDamage, offsetPosition, resolveVehicleCollision, type Position } from './VehicleController.ts';
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
import { mercatorX, mercatorY } from '@/world3d/mercator';

/** tiles this close to the car feed gameplay (the world's feature radius, plus slack) */
const NEAR_TILE_METERS = 2600;
import { NetPlayers, PLAYER_MARKER_COLOR, type OnlinePlayer } from './net/NetPlayers.ts';
import { SharedTraffic } from './net/SharedTraffic.ts';
import { HealthMeters, type Meter } from './hud/HealthMeters.ts';
import { TestTargets } from './TestTargets.ts';
import { HIT_DAMAGE, PLAYER_HP } from '@/net/protocol';
  import { formatRange, MARKER_PIN_METERS, nameIndicator, placeIndicator } from './hud/indicators.ts';
import { advanceTrafficBot, createTrafficBot, TrafficRoadNetwork, type TrafficBot } from './TrafficBots.ts';
import { formatNumber, onLangChange, t } from '@/i18n';
import { ThreeMap, ThreeMarker } from '@/world3d/map/ThreeMap';
import { EVACUATION_COST, FuelTank, FUEL_PRICE, REPAIR_PRICE } from './Fuel.ts';
import { atStation, banksFromFeatures, busStopsFromFeatures, courtsFromFeatures, dealershipsFromFeatures, hospitalsFromFeatures, landmarksFromFeatures, nearestStation, policeFromFeatures, prisonsFromFeatures, repairShopsFromFeatures, SERVICE_REACH, stationsFromFeatures, type CivicKind, type Landmark, type Station } from './poi.ts';
import { metersBetween, offsetMeters } from './meters.ts';
import { defaultMapLabelFilters, type MapLabelFilters, type MapLabelKind } from './mapLabels.ts';
import { fuelStationsLayer } from '@/rendering/FuelStationsLayer';
import { isVintageTrain, trainsLayer } from '@/rendering/TrainsLayer';
import { RailNetwork, TrainTraffic } from './Trains.ts';
import { hubAt, hubsFromFeatures, kilometres, nearestHub, ticketPrice, type Hub, type HubKind } from './Travel.ts';
import { bearingTo, BOUNTY_RANGE_KM, loadBounty, makeBounty, saveBounty, type Bounty } from './Bounty.ts';
import type { GameSave } from './save.ts';
import { BOX_REACH_M, COLLECT_BOXES, COLLECT_REWARD, deliveryReward, DELIVERY_MAX_M, DELIVERY_MIN_M, DELIVERY_REACH_M, randomItem, scatterBoxes, type DeliveryItem, type Errand } from './Errands.ts';
import type {
  BankOffer,
  BountyOffer,
  DealerOffer,
  EventOffer,
  EventResult,
  FuelHud,
  HudParticipant,
  MissionKind,
  PlayerCarry,
  RideOffer as RideOfferType,
  ServiceOffer,
  Settings,
  TravelOffer,
} from './offers.ts';
import {
  ARENA_FEE,
  ARENA_PRIZE,
  ARREST_COSTS,
  ARREST_FINE,
  BANK_CRACK_MS,
  CASH_BUNDLE,
  CUSTOM_PIN_COLORS,
  ERRAND_BEACONS,
  AMBULANCE_HOSPITAL_M,
  AMBULANCE_ID,
  ambulanceWreckId,
  isAmbulanceWreckId,
  BUS_ID,
  BATMOBILE_ID,
  FIRE_TRUCK_ID,
  FAMILY_SEDAN_ID,
  TAXI_ID,
  carShootsGuns,
  GRAVITY,
  HAUL_AIM_M,
  HAUL_COIN_PX,
  HAUL_COINS_MS,
  HAUL_DECK_BACK,
  HAUL_DECK_UP,
  HAUL_DROP_MS,
  HAUL_FLY_MS,
  HAUL_LOAD_M,
  HAUL_MISS_BACK_MS,
  HAUL_MISS_HOLD_MS,
  HAUL_MISS_OUT_MS,
  HAUL_PULL_MS,
  HAUL_REACH_M,
  HAUL_REEL_MS,
  HAUL_SNAP_M,
  HAUL_TAUT_MS,
  HAUL_TILT,
  HAUL_WINCH_MS,
  HAULER_ID,
  IMPOUND_ARRIVE_M,
  IMPOUND_REWARD,
  LOAN_LIMIT,
  LOAN_RATE,
  METERS_PER_DEGREE,
  MISSION_COLORS,
  MISSION_PICKUP_M,
  POLICE_GIVE_UP_M,
  POLICE_GIVE_UP_MS,
  BOUNTY_CAR_IDS,
  POLICE_IDS,
  RACE_FEE,
  RACE_PRIZE,
  RAMP,
  TOW_CAR_ID,
  TRAFFIC_MARKER_COLORS,
  WRECK_COSTS,
  randomDriverNames,
} from './tuning.ts';

/** An angle in degrees as −180 … 180 (the same turn, the short way). */
const wrapDegrees = (deg: number) => ((deg + 180) % 360 + 360) % 360 - 180;
/** where the camera (zoom, tilt, turn) is kept between reloads */
const CAMERA_STORE = 'race.camera';
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

type MapMarker = {
  setLngLat(position: [number, number]): MapMarker;
  /** stand at this height (m) instead of on the ground */
  setAltitude(altitude: number | null): MapMarker;
  addTo(map: ThreeMap): MapMarker;
  remove(): unknown;
  getElement(): HTMLElement;
};

/** One line of the "who is online" list. Distance in meters from our car. */
export type { OnlinePlayer };

/** `drop`: thrown out of a wreck — bounces from `from` and can be picked up once it lies still */
type ActivePickup = { position: [number, number]; color: string; kind: 'coin' | 'cash'; drop?: { from: [number, number]; at: number; up?: number } };

export class GameEngine {
  collisions = new BuildingCollisions();
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
  /** boot camera already parked on chase pose to finish GPU uploads before "ready" */
  private bootChaseWarmed = false;
  /** keep isotropic/fast uploads until this time (ms), then endStreamBurst */
  private bootBurstUntil = 0;
  /** wall-clock start of the fly-in — hitch spikes must not jerk the lerp via dt */
  private approachAt = 0;
  /** remaining intro→chase blend (ms); boot already parked mid-flight */
  private approachMs = 1400;
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
  private tilesIngested = false;
  /** tiles whose roads/water/poi are already in the gameplay caches / traffic graph */
  private ingestedTiles = new Set<string>();
  /** near-car tiles that arrived since the last ingest pass */
  private pendingIngest = new Set<string>();
  /** last full features() scoop — rare prune, not every tile upload */
  private fullScoopAt = 0;
  private focusTime = 0;
  private overlayTime = 0;
  private wheelSampleTime = 0;
  private wheelTargets = { altitude: 0, pitch: 0, roll: 0, ready: false };
  /** vertical motion: the car flies off crests and ramps under gravity */
  private climb = 0;
  private airborne = false;
  private wasOnRamp = false;
  /** fell in the river: splash → sink → respawn on the nearest shore road */
  private plunge: { at: number; waterAlt: number } | null = null;
  /** the ramp put down with J (one at a time; gone shortly after the jump) */
  private ramp: { start: [number, number]; heading: number; usedAt: number; length: number; height: number; width: number } | null = null;
  /** holding J: ramp preview grows until release */
  private rampCharge: { start: [number, number]; heading: number; ground: number; length: number } | null = null;
  private aimScreen: [number, number] | null = null;
  private trafficBots: TrafficBot[] = [];
  /** reused by targetVehicles() so the chase tick doesn't allocate every frame */
  private targetScratch: TargetVehicle[] = [];
  private trafficNetwork = new TrafficRoadNetwork();
  /** light traffic shared with the players around */
  private sharedTraffic!: SharedTraffic;
  private vehicleContactTimes = new Map<string, number>();
  private trafficMarkerLayer: HTMLElement | null = null;
  private trafficMarkers = new Map<string, { element: HTMLElement; arrow: HTMLElement; name: HTMLElement; distance: HTMLElement }>();
  /** health bars over the cars on screen */
  private healthMeters!: HealthMeters;
  private mode: 'roam' | 'arena' | 'race' = 'roam';
  /** `n`: the mission's number in its kind, for its label in any language */
  private missions: { id: string; kind: MissionKind; label: string; n: number; position: [number, number] }[] = [];
  /** a delivery or box hunt under way */
  private errand: Errand | null = null;
  /** a delivery prepared for the offer on screen */
  private offeredDelivery: { item: DeliveryItem; goal: Position; reward: number } | null = null;
  private errandMarkers = new Map<string, MapMarker>();
  /** one offscreen tip per errand pin (delivery goal or each box) — same look, no “nearest” special case */
  private errandIndicators = new Map<string, { element: HTMLElement; arrow: HTMLElement; title: HTMLElement; distance: HTMLElement }>();
  private missionFocus = 0;
  /** last Tab-cycle goal set; a newly added mission becomes the focused tip */
  private focusGoalsLatch: string | null = null;
  private missionSeq: Record<MissionKind, number> = { arena: 0, race: 0, delivery: 0, collect: 0 };
  private activeMissionId: string | null = null;
  private missionRespawnAt = 0;
  private lastCompletedKind: MissionKind | null = null;
  private lastCompletedAt: [number, number] | null = null;
  private raceGoal: [number, number] | null = null;
  private eventOffer: MissionKind | null = null;
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
  /** fire call (fire truck only): marker → burning house → put out every window */
  private fire = createFireCallState();
  private fireIndicator: { element: HTMLElement; arrow: HTMLElement; title: HTMLElement; distance: HTMLElement } | null = null;
  private fireMarker: MapMarker | null = null;
  /** taxi fare (Chevy Taxi): marker → told the address → drop-off pays 100/km */
  private taxi = createTaxiFareState();
  private taxiIndicator: { element: HTMLElement; arrow: HTMLElement; title: HTMLElement; distance: HTMLElement } | null = null;
  private taxiMarker: MapMarker | null = null;
  /** ambulance: crash or burned house → hospital, 1000 per victim */
  private ambulance = createAmbulanceCallState();
  private ambulanceIndicator: { element: HTMLElement; arrow: HTMLElement; title: HTMLElement; distance: HTMLElement } | null = null;
  private ambulanceMarker: MapMarker | null = null;
  /** city bus: approach OSM bus stops → board/alight modal + coins */
  private bus = createBusStopState();
  private busStops = new Map<string, Station>();
  /** bus tour: group → named hotel/museum */
  private busTour = createBusTourState();
  private landmarks = new Map<string, Landmark>();
  private busTourIndicator: { element: HTMLElement; arrow: HTMLElement; title: HTMLElement; distance: HTMLElement } | null = null;
  private busTourMarker: MapMarker | null = null;
  /** Howler: marker → load a car → any police station for a premium */
  private impoundPickup: [number, number] | null = null;
  private impoundActive = false;
  private impoundSpot: [number, number] | null = null;
  private impoundOfferAt = performance.now() + 25000;
  private impoundDeliveredAt = 0;
  private impoundIndicator: { element: HTMLElement; arrow: HTMLElement; title: HTMLElement; distance: HTMLElement } | null = null;
  private impoundMarker: MapMarker | null = null;
  /**
   * The hauler's cable. First click: it flies out (fly) and sticks to a car (hooked) or a
   * wall (anchored), or comes back empty (miss). Second click: the car is yanked up onto
   * our back (pull → carry), or we reel ourselves up to the wall and hang there (reel →
   * hang). Third click: the car slides off behind (drop), or we let go and fall.
   */
  private haul: {
    id: string; kind: 'bot' | 'shared' | 'wall' | 'train' | 'coins'; car: Car;
    phase: 'fly' | 'hooked' | 'anchored' | 'pull' | 'carry' | 'drop' | 'miss' | 'reel' | 'hang' | 'towed';
    at: number; from: Position; fromHeading: number; fromUp: number;
    /** wall: the hook (absolute height), and where we start reeling from */
    hookAlt?: number; self?: Position; selfAlt?: number;
    /** train: which one, the rope's length (m) and whether we reeled in already */
    trainId?: string; rope?: number; ropeFrom?: number; reeled?: boolean;
    /** coins: the ones on the hook and where each lay */
    coins?: { id: string; start: Position }[];
    /** hooked car fighting the winch: first moment the rope hit full stretch */
    tautAt?: number;
    /** last updateHaul time for hooked-car drag (ms) */
    dragAt?: number;
  } | null = null;
  /** our police car's lights (F) */
  private beaconsOn = true;
  /** towed by a train on the cable: the car's own driving is off, the rope pulls it */
  private towed = false;
  private towSpeed = 0;
  private towClock = 0;
  /** hanging on (or reeling up) the cable: our height, held; null on the ground or flying */
  private hangAltitude: number | null = null;
  /** us on the map (M): a dot with an arrow along our heading */
  private selfMarker: MapMarker | null = null;
  /** a new language: every map label and marker title says it again */
  private offLang = onLangChange(() => this.relabel());
  onBountyOffer: (offer: BountyOffer | null) => void = () => {};
  onRideOffer: (offer: RideOfferType | null) => void = () => {};
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
  /** Player pins on the M-map (up to 3), each tracked like a mission target. */
  private customPins: Array<{
    id: string;
    position: [number, number];
    color: (typeof CUSTOM_PIN_COLORS)[number];
    marker: MapMarker;
    indicator: { element: HTMLElement; arrow: HTMLElement; title: HTMLElement; distance: HTMLElement };
  }> = [];
  private customPinSeq = 0;
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
  private stations = new Map<string, Station>();
  private fuelLayer: ReturnType<typeof fuelStationsLayer> | null = null;
  /** Category chips + world plaques: only while the M map is open. */
  onMapView: (open: boolean) => void = () => {};
  private mapViewUi = false;
  /** throttle M-map plaque rebuilds (were every frame → ~20 FPS) */
  private mapLabelsAt = 0;
  private mapLabelsAtPos: [number, number] | null = null;
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
  /** banks from the POI layer; a robbed one stays shut until the time in `bankShut` */
  private banks = new Map<string, Station>();
  private bankShut = new Map<string, number>();
  /** shots landing on a bank right now: which one and for how long */
  private bankShots: { id: string; ms: number; last: number } | null = null;
  /**
   * A bank job in progress (mode 'arena' for the guns and contacts): cash picked up so far,
   * police to send (a downed car calls two more), a touch or a wrecked car = arrest.
   */
  private heist: { cash: number; reinforce: number; sent: number; caught: boolean; stolen?: { carId: string; previousId: string; owned: boolean } } | null = null;
  /** each chasing bot's last look at its target: is the way clear of houses (checked every 300 ms) */
  private botSight = new Map<string, { at: number; clear: boolean }>();
  /** when each police car fell that far behind (it gives up after POLICE_GIVE_UP_MS) */
  private policeFar = new Map<string, number>();
  /** parking lots from the POI layer */
  private parkingLots = new Map<string, [number, number]>();
  /** the parked car we last told the player about (H to hijack) */
  private hijackHintFor: string | null = null;
  /** Police stations, prisons, courts, hospitals — arrest drop-off points. */
  private civics = new Map<string, Station & { kind: CivicKind }>();
  private serviceMarkers = new Map<string, MapMarker>();
  /** which POI/hub plaques are drawn (chip bar on the map) */
  private mapLabelFilters: MapLabelFilters = defaultMapLabelFilters();
  private offeredService: string | null = null;
  /** cars we own: bought ones pile up here, none is sold back */
  private garage = new Set<string>();
  /** owed to the bank; the bank dialog is open */
  private loanDebt = 0;
  private bankOpen = false;
  onBankOffer: (offer: BankOffer | null) => void = () => {};
  private serviceOpen: ServiceOffer['kind'] | null = null;
  private dealerOpen = false;
  /** key M: camera rises straight up for a ~2 × 2 km view from above (0 chase … 1 overview) */
  private overview = 0;
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
  private mapInspecting() {
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
  private hubMarkers = new Map<string, MapMarker>();
  private offeredHub: string | null = null;
  private travelOpen = false;
  private carry: PlayerCarry | null = null;
  get money() { return this.playerMoney; }
  private pickups = new Map<string, ActivePickup>();
  private collectedPickups = new Set<string>();
  /** true once the run's purse/coins/hp are in place — before that a snapshot would wipe the save */
  private runReady = false;
  /** the run's purse/coins/hp have been applied (see runReady) */
  get runStarted() { return this.runReady; }
  private pickupFocus: [number, number] | null = null;
  private pickupNetworkRevision = -1;
  private playerMoney = 0;
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
    if (carry?.at) this.customSpawn = { position: [...carry.at.position], heading: carry.at.heading };
    // Drop leftover worldwide hunts — bounties are local (≤ 10 km) now.
    if (this.bounty) {
      const at = this.bounty.spot ?? this.bounty.place.coords;
      if (kilometres(city.coords, at) > BOUNTY_RANGE_KM) {
        this.bounty = null;
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
      canMove: (from, to, heading) => !this.collisions.blocked(from, to, heading, 1, this.altitude) && !this.water.resolve(from, to, heading, 1, this.onBridgeDeck(to, this.altitude)).stopped,
      online: (list) => this.onOnline(list),
      chat: (line) => this.onChat(line),
      notice: (notice) => this.onNetNotice(notice),
      hitBy: (name, damage) => this.hitByPlayer(name, damage),
      hp: () => this.playerHp,
      bumped: (damage) => this.damagePlayer(damage, 180),
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
      extras: () => this.heist ? this.trafficBots
        .filter((bot) => bot.id.startsWith('police') && this.combatLayer?.isTargetAlive(bot.id) !== false)
        .map((bot) => ({ id: bot.id, car: bot.car.id, p: bot.position, h: bot.heading, s: bot.controller.speed, hp: Math.round(this.combatLayer?.targetHp(bot.id) ?? 1000) })) : [],
      hitExtra: (id) => { this.combatLayer?.damageTarget(id, HIT_DAMAGE); },
      provoke: (id) => this.provoke(id),
      canPark: (at, heading) => !this.collisions.blocked(at, at, heading) && !this.water.covers(at, this.onBridgeDeck(at, this.altitude)),
      hitWalls: (from, to, heading) => this.collisions.resolve(from, to, heading),
      lots: () => [...this.parkingLots.values()].filter((lot) => metersBetween(lot, this.vehicle.position) < 600),
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
      if (typeof event.tile !== 'string' || !this.nearCar(event.tile)) return;
      // queue just this tile — full features() scoop on every upload was the hitch after M toggles
      if (!this.ingestedTiles.has(event.tile)) this.pendingIngest.add(event.tile);
      this.collisionDirty = true;
    });
    this.map.on('error', () => this.say(t('status.mapError')));
    // a felled tree now and then drops a coin
    this.map.on('topple', (event) => {
      const point = event.point as [number, number] | undefined;
      if (point && this.driving && Math.random() < 0.3) this.dropCoins(point, 1);
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
          if (mark && hit) this.bankShot(hit.point);
          return hit;
        },
        (point, altitude) => this.map.markGround(point, altitude),
        (from, fromAlt, to, toAlt) => this.trainShot(from, fromAlt, to, toAlt),
      );
      this.combatLayer.onRemoteHit = (id) => this.players.shot(id);
      this.combatLayer.onTargetHit = (id) => {
        this.provoke(id);
        this.sharedTraffic.ourHit(id);
      };
      this.combatLayer.onTrainCoin = (point, altitude) => this.trainCoin(point, altitude);
      this.combatLayer.onShotCoins = (from, fromAlt, to, toAlt) => this.shotCollectCoins(from, fromAlt, to, toAlt);
      this.combatLayer.onFireWindowOut = (left) => this.onFireWindowOut(left);
      this.combatLayer.onTargetDestroyed = (id, position) => {
        this.dropCoins(position);
        if (this.heist && id.startsWith('police')) {
          this.heist.reinforce += 2;
          this.say(t('heist.reinforce'), true);
        }
      };
      this.map.addLayer(this.combatLayer);
      this.applySettings(this.settings);
      this.ready = true;
      this.collisionDirty = true;
      this.say(t('status.placing'));
      // Map click → menu spawn, or (M overview) a custom tracked pin
      this.map.on('click', (e) => {
        const lngLat = e.lngLat as { lng: number; lat: number };
        if (!this.driving && this.mapShown) this.setSpawnFromClick(lngLat);
        else if (this.mapInspecting()) this.placeCustomPin([lngLat.lng, lngLat.lat]);
      });
    });
    const listen = (target: EventTarget, event: string, fn: EventListener, options?: AddEventListenerOptions) => {
      target.addEventListener(event, fn, options);
      this.cleanups.push(() => target.removeEventListener(event, fn, options));
    };
    listen(window, 'keydown', ((e: KeyboardEvent) => {
      // M-map only while driving — intro camera stays put
      if (e.code === 'KeyM' && !e.repeat && !this.driving) {
        e.preventDefault();
        return;
      }
      if (!this.driving || this.paused || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyR', 'Tab', 'KeyM', 'KeyJ', 'KeyE'].includes(e.code)) e.preventDefault();
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) this.keys.add(e.code);
      if (e.code === 'KeyR') this.resetCamera();
      if (e.code === 'Tab' && !e.repeat) {
        if (this.tryOpenDealer()) { /* showroom takes Tab on the lot */ }
        else this.cycleMissionFocus();
      }
      if (e.code === 'KeyJ' && !e.repeat) this.beginRampCharge();
      if (e.code === 'KeyC' && !e.repeat) this.swapCar();
      if (e.code === 'KeyH' && !e.repeat) this.tryHijack();
      if (e.code === 'KeyF' && !e.repeat) { this.beaconsOn = !this.beaconsOn; this.combatLayer?.setBeacons(this.beaconsOn); }
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
        // Batmobile: right click throws the Howler cable (LMB stays guns). Others: orbit.
        if (this.car.id === BATMOBILE_ID) {
          const bounds = el.getBoundingClientRect();
          const x = e.clientX - bounds.left;
          const y = e.clientY - bounds.top;
          this.aimScreen = [x, y];
          this.updateAim();
          this.haulClick();
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
      if (this.car.id === HAULER_ID) this.haulClick();
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

  private placeTargetIndicator(marker: { element: HTMLElement; arrow: HTMLElement; distance: HTMLElement }, target: [number, number], pinMeters = MARKER_PIN_METERS) {
    placeIndicator(this.map, marker, this.vehicle.position, target, pinMeters, this.mapInspecting());
  }

  setCar(car: Car) {
    if (this.car.id === car.id && this.car.path === car.path) return;
    if (this.haul && !this.canCable(car.id)) this.loseHaul();
    const prev = this.car.id;
    this.car = car;
    this.fuel.changeSpec(car.fuel);
    this.combatLayer?.setCar(car);
    this.onSpecialVehicleChange(prev, car.id);
  }

  /** Police cruisers and the Batmobile — wanted hunts. */
  private canHuntBounty(id = this.car.id) { return BOUNTY_CAR_IDS.has(id); }
  private isFireTruck(id = this.car.id) { return id === FIRE_TRUCK_ID; }
  private isHauler(id = this.car.id) { return id === HAULER_ID; }
  /** Howler + Batmobile: throw / yank / release the cable. */
  private canCable(id = this.car.id) { return id === HAULER_ID || id === BATMOBILE_ID; }
  private isTaxi(id = this.car.id) { return id === TAXI_ID; }
  private isAmbulance(id = this.car.id) { return id === AMBULANCE_ID; }
  /** Parked mission props (crash wreck / tow wait) — not racers, no roster / HP / chase arrow. */
  private isPropBot(id: string) { return isAmbulanceWreckId(id) || id === TOW_CAR_ID; }
  private isBus(id = this.car.id) { return id === BUS_ID; }
  private carShoots(id = this.car.id) { return carShootsGuns(id); }

  /** Map mission kinds for the current car (no arena without guns). */
  private missionKinds(): MissionKind[] {
    return this.carShoots()
      ? ['race', 'arena', 'delivery', 'collect']
      : ['race', 'delivery', 'collect'];
  }

  /** Drop arena pins / offers when switching into a cable/hose car. */
  private syncArenaAvailability(prev: string, next: string) {
    const wasArmed = this.carShoots(prev);
    const armed = this.carShoots(next);
    if (wasArmed === armed) return;
    if (!armed) {
      if (this.eventOffer === 'arena') {
        this.eventOffer = null;
        this.activeMissionId = null;
        this.onEventOffer(null);
      }
      for (const mission of this.missions.filter((m) => m.kind === 'arena')) {
        this.missionMarkers.get(mission.id)?.remove();
        this.missionMarkers.delete(mission.id);
      }
      this.missions = this.missions.filter((m) => m.kind !== 'arena');
      const n = this.focusGoals().length;
      if (this.missionFocus >= n) this.missionFocus = Math.max(0, n - 1);
      return;
    }
    if (!this.missions.some((m) => m.kind === 'arena')) {
      this.missionRespawnAt = Math.min(this.missionRespawnAt || Infinity, performance.now() + 2500);
    }
  }

  /** Role cars swap which special mission is on the map (police / fire / hauler / taxi). */
  private onSpecialVehicleChange(prev: string, next: string) {
    if (this.isFireTruck(prev) && !this.isFireTruck(next)) this.suspendFire();
    if (this.isHauler(prev) && !this.isHauler(next)) this.suspendImpound();
    if (this.isTaxi(prev) && !this.isTaxi(next)) this.suspendTaxi();
    if (this.isAmbulance(prev) && !this.isAmbulance(next)) this.suspendAmbulance();
    if (this.isBus(prev) && !this.isBus(next)) this.suspendBusTour();
    if (this.canHuntBounty(prev) && !this.canHuntBounty(next)) {
      // hide bounty offer UI; keep the saved hunt for when we're back in a cruiser
      if (this.bountyOfferShown) { this.bountyOfferShown = false; this.onBountyOffer(null); }
    }
    if (this.isFireTruck(next) && !this.fire.active && !this.fire.pickup) {
      this.fire.offerAt = Math.min(this.fire.offerAt, performance.now() + 4000);
    }
    if (this.isHauler(next) && !this.impoundActive && !this.impoundPickup) {
      this.impoundOfferAt = Math.min(this.impoundOfferAt, performance.now() + 4000);
    }
    if (this.isTaxi(next) && !this.taxi.active && !this.taxi.pickup) {
      this.taxi.offerAt = Math.min(this.taxi.offerAt, performance.now() + 4000);
    }
    if (this.isAmbulance(next) && !this.ambulance.active && !this.ambulance.pickup) {
      this.ambulance.offerAt = Math.min(this.ambulance.offerAt, performance.now() + 4000);
    }
    if (this.isBus(next) && !this.busTour.active && !this.busTour.pickup) {
      this.busTour.offerAt = Math.min(this.busTour.offerAt, performance.now() + 4000);
    }
    if (this.canHuntBounty(next) && !this.bounty && !this.bountyPending) {
      this.bountyOfferAt = Math.min(this.bountyOfferAt, performance.now() + 4000);
    }
    this.syncArenaAvailability(prev, next);
    this.syncMissionVisuals(true);
  }

  /** Lot catalogue for the dealership dialog. */
  private dealerState(): DealerOffer {
    return { money: Math.floor(this.playerMoney), currentId: this.car.id, owned: [...this.garage] };
  }

  /** Open the showroom when standing on a dealership lot (Tab, or slow arrival). */
  private tryOpenDealer() {
    if (!this.runReady) return false;
    if (!this.driving || this.mode !== 'roam' || this.dealerOpen || this.serviceOpen || this.travelOpen || this.fuelOut) return false;
    const lot = atStation(this.vehicle.position, [...this.dealerships.values()], SERVICE_REACH.dealer);
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

  /** Buy `carId` at its full price into the garage (nothing is sold back) and get in; one we own is free. */
  buyDealerCar(carId: string) {
    if (!this.dealerOpen) return;
    const next = carsConfig.find((c) => c.id === carId);
    if (!next || next.id === this.car.id) return;
    if (!this.garage.has(next.id)) {
      const price = carPrice(next);
      if (price > this.playerMoney) return;
      this.playerMoney -= price;
      this.garage.add(next.id);
    }
    this.setCar(next);
    this.onCarBought(next);
    this.onDealerOffer(this.dealerState());
  }

  /** C: get into the next car of the garage, right where we are (not during a race or a fight). */
  private swapCar() {
    if (!this.driving || this.paused || this.mode !== 'roam' || this.garage.size < 2) {
      if (this.driving && this.garage.size < 2) this.say(t('garage.one'), true);
      return;
    }
    const owned = carsConfig.filter((car) => this.garage.has(car.id));
    const at = owned.findIndex((car) => car.id === this.car.id);
    const next = owned[(at + 1) % owned.length];
    if (!next || next.id === this.car.id) return;
    this.setCar(next);
    this.onCarBought(next);
    this.say(t('garage.swap', { car: next.name }), true);
  }

  /** Show / hide map plaques by category (fuel, hotels, airports…). */
  setMapLabelFilters(filters: MapLabelFilters) {
    this.mapLabelFilters = { ...filters };
    this.labelServices();
    this.refreshHubMarkers();
  }

  private mapLabelOn(kind: MapLabelKind) {
    return this.mapLabelFilters[kind] !== false;
  }

  applySettings(settings: Settings) {
    const terrainChanged = settings.terrain !== this.settings.terrain;
    const skinChanged = settings.skin !== this.settings.skin;
    this.settings = settings;
    this.map.setSkin(settings.skin);
    // mid-fire skin swap: snap flames onto the new window grid, keep ~the same burn %
    if (skinChanged && this.fire.active) this.remeshFireForSkin();
    if (!this.mapLoaded) return;
    this.map.setRelief(settings.terrain);
    // fill-rate first: high ≤1.25, medium 1, low 0.85 (was 1 / 1.25 / ≤1.5)
    const dpr = window.devicePixelRatio || 1;
    const ratio = settings.quality === 'low' ? 0.85 : settings.quality === 'medium' ? 1 : Math.min(dpr, 1.25);
    this.map.setPixelRatio(ratio);
    if (terrainChanged) { this.collisionDirty = true; this.syncedAt = null; }
  }

  /** After a skin change, rebuild burning panes on the façade rhythm that style draws. */
  private remeshFireForSkin() {
    if (!this.fire.active || !this.fire.spot || !this.combatLayer) return;
    const facades = this.map.fireFacadesNear(this.fire.spot, 80);
    if (!facades?.panes.length) return;
    const specs = facades.panes.map((p) => ({
      at: p.at as [number, number],
      altitude: p.altitude,
      oe: p.oe,
      on: p.on,
    }));
    const seed = Math.round(this.fire.spot[0] * 1e5) ^ Math.round(this.fire.spot[1] * 1e5) ^ (performance.now() | 0);
    this.combatLayer.remeshFireHouse(specs, seed);
    const total = this.combatLayer.fireWindowsTotal();
    if (total != null) this.fire.windowTotal = total;
    const left = this.combatLayer.fireWindowsLeft();
    if (left === 0) {
      this.completeFire(this.fire.windowTotal);
      return;
    }
    this.fire.spot = facadeMarker(specs, this.fire.spot) as [number, number];
    this.syncMissionVisuals(true);
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

  setSpawnFromClick(lngLat: { lng: number; lat: number }) {
    if (!this.mapLoaded) return;
    const origin: [number, number] = [lngLat.lng, lngLat.lat];
    const start = this.findFreeRoad(origin, 140)
      ?? roadStart(this.map, origin, () => false, 140);
    const position: [number, number] = start ? [...start.position] : origin;
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
    this.wins.clear();
    this.clearEventBots();
    this.pickups.clear();
    this.combatLayer?.setPickups([]);
    this.pickupFocus = null;
    this.pickupNetworkRevision = -1;
    // Purse / garage / collected only once per run. Spawn click / road retarget used to
    // call this again with carry already spent → STARTING_CASH and wiped progress on save.
    if (!this.runReady) {
      const carry = this.carry;
      const resumeHp = carry?.at?.hp;
      this.playerHp = resumeHp != null ? Math.max(1, Math.min(this.playerMaxHp, resumeHp)) : this.playerMaxHp;
      this.collectedPickups = new Set(carry?.collected?.filter((id) => typeof id === 'string') ?? []);
      // Intro: empty garage + STARTING_CASH (prod). GIFT_CARS only in next.devs.
      // The menu car is bought when setDriving(true) — not on boot spawn.
      this.fuel.level = this.fuel.spec.tank * (carry?.fuel ?? 1);
      this.loanDebt = Math.max(0, Math.round(carry?.loan ?? 0));
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
    this.vehicleContactTimes.clear();
    this.placeEventBeacons(position, heading);
    this.ensureTrafficMarkers();
    this.combatLayer?.setTargets([]);
    this.combatLayer?.setRaceFinish(null);
    this.syncRoadPickups();
    this.onEventOffer(null);
  }

  /** Snapshot for localStorage so a refresh lands back mid-drive. */
  snapshot(place: { name: string; country: string; coords: [number, number] }): GameSave | null {
    if (!this.runReady) return null;
    const collected = [...this.collectedPickups];
    // keep the newest ids if the list grows huge (localStorage quota)
    if (collected.length > 4000) collected.splice(0, collected.length - 4000);
    return {
      money: Math.floor(this.playerMoney),
      fuel: this.fuel.ratio,
      hp: this.playerHp,
      carId: this.heist?.stolen?.previousId ?? this.car.id, // a stolen car is never kept
      position: [...this.vehicle.position] as [number, number],
      heading: this.vehicle.heading,
      place: { name: place.name, country: place.country, coords: [...place.coords] as [number, number] },
      collected,
      loan: this.loanDebt,
      garage: [...this.garage],
    };
  }

  /** Put the car back where a save left it (before setDriving from the menu). */
  resumeFrom(at: { position: [number, number]; heading: number }) {
    this.customSpawn = { position: [...at.position], heading: at.heading };
    this.vehicle.position = [...at.position];
    this.vehicle.heading = at.heading;
    this.bearing = at.heading * 180 / Math.PI;
    this.renderVehicle.reset(this.vehicle);
    // Spawn already applied money/hp/coins via carry — do not reset them again.
    // (a boot timeout can mark the spawn resolved while the saved purse is still pending)
    if (!this.spawnResolved || this.carry) {
      this.spawnResolved = true;
      this.setTargetVehicles(at.position, at.heading);
    }
  }

  /** Leave the road for the intro: drop missions, keep purse / garage / place. */
  leaveToMenu() {
    this.releaseHaul(null);
    if (this.errand) { this.clearErrand(); this.completeActiveMission(); }
    if (this.taxi.pending || this.taxi.active) this.suspendTaxi();
    if (this.busTour.pending || this.busTour.active) this.suspendBusTour();
    this.mode = 'roam';
    this.heist = null;
    this.raceGoal = null;
    this.combatLayer?.setRaceFinish(null);
    this.clearEventBots();
    this.eventOffer = null;
    this.onEventOffer(null);
    this.onEventResult(null);
    this.onRideOffer(null);
    this.bountyFight = false;
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
    this.customSpawn = null;
    this.defaultSpawn = null;
    this.spawnResolved = false;
    this.runReady = false;
    this.playerMoney = 0;
    this.carry = null;
    this.collectedPickups.clear();
    this.loanDebt = 0;
    this.garage.clear();
    this.pickups.clear();
    this.combatLayer?.setPickups([]);
    this.fuel.level = this.fuel.spec.tank;
    this.onSpawnSet(null);
  }

  private clearEventBots() {
    this.trafficBots = [];
    this.hunterGuns.clear();
    this.policeFar.clear();
    this.botSight.clear();
    this.raceStartAt = 0;
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
    // Empty network (boot edge): push along heading so the pin is not under the car.
    return offsetMeters(position, Math.sin(heading) * 420, Math.cos(heading) * 420);
  }

  private nextMissionLabel(kind: MissionKind) {
    this.missionSeq[kind] += 1;
    return t(`mission.${kind}`, { n: this.missionSeq[kind] });
  }

  private createMission(
    kind: MissionKind,
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
    return { id, kind, label, n: this.missionSeq[kind], position: spot };
  }

  private syncMissionVisuals(showWorld = this.mode === 'roam') {
    // on a mission the others are out of sight (and out of reach) until it is over
    const free = showWorld && !this.onMission();
    const visible = free ? this.missions : [];
    const beacons: {
      id: string;
      position: [number, number];
      kind?: 'arena' | 'race' | 'bounty' | 'fire' | 'impound' | 'taxi' | 'bus' | 'ambulance';
      colors?: { pole: string; glow: string; orb: string };
    }[] = visible.map(mission => ({
      id: mission.id,
      kind: mission.kind === 'arena' || mission.kind === 'race' ? mission.kind : undefined,
      colors: mission.kind === 'delivery' || mission.kind === 'collect' ? ERRAND_BEACONS[mission.kind] : undefined,
      position: mission.position,
    }));
    const errand = this.errand;
    if (errand?.kind === 'delivery') beacons.push({ id: 'errand-goal', position: errand.goal, colors: ERRAND_BEACONS.delivery });
    // collect boxes: map/HUD markers with range only — no giant world pins on every box
    if (showWorld && !this.bountyFight && !errand) {
      if (this.canHuntBounty() && this.bountyPending && this.bountyPickup && free) {
        beacons.push({ id: 'bounty-pickup', kind: 'bounty', position: this.bountyPickup });
      } else if (this.canHuntBounty() && this.bounty?.spot) {
        beacons.push({ id: 'bounty', kind: 'bounty', position: this.bounty.spot });
      }
      if (this.isFireTruck() && this.fire.active && this.fire.spot) {
        beacons.push({ id: 'fire', kind: 'fire', position: this.fire.spot });
      } else if (this.isFireTruck() && this.fire.pickup && free) {
        beacons.push({ id: 'fire-pickup', kind: 'fire', position: this.fire.pickup });
      }
      if (this.isHauler() && this.impoundActive) {
        const drop = this.impoundDropPin();
        if (drop) beacons.push({ id: 'impound-drop', kind: 'impound', position: drop });
        else if (this.impoundSpot) beacons.push({ id: 'impound', kind: 'impound', position: this.impoundSpot });
      } else if (this.isHauler() && this.impoundPickup && free) {
        beacons.push({ id: 'impound-pickup', kind: 'impound', position: this.impoundPickup });
      }
      if (this.isTaxi() && this.taxi.active && this.taxi.goal) {
        beacons.push({ id: 'taxi-goal', kind: 'taxi', position: this.taxi.goal, colors: ERRAND_BEACONS.taxi });
      } else if (this.isTaxi() && this.taxi.pickup && free) {
        beacons.push({ id: 'taxi-pickup', kind: 'taxi', position: this.taxi.pickup, colors: ERRAND_BEACONS.taxi });
      }
      if (this.isAmbulance() && this.ambulance.active && this.ambulance.goal) {
        beacons.push({ id: 'ambulance-goal', kind: 'ambulance', position: this.ambulance.goal, colors: ERRAND_BEACONS.ambulance });
      } else if (this.isAmbulance() && this.ambulance.pickup && free) {
        beacons.push({ id: 'ambulance-pickup', kind: 'ambulance', position: this.ambulance.pickup, colors: ERRAND_BEACONS.ambulance });
      }
      if (this.isBus() && this.busTour.active && this.busTour.goal) {
        beacons.push({ id: 'bus-goal', kind: 'bus', position: this.busTour.goal, colors: ERRAND_BEACONS.bus });
      } else if (this.isBus() && this.busTour.pickup && free) {
        beacons.push({ id: 'bus-pickup', kind: 'bus', position: this.busTour.pickup, colors: ERRAND_BEACONS.bus });
      }
    }
    if (this.driving) {
      for (const pin of this.customPins) {
        beacons.push({
          id: pin.id,
          position: pin.position,
          colors: { pole: pin.color.main, glow: pin.color.glow, orb: pin.color.soft },
        });
      }
    }
    this.combatLayer?.setMissionBeacons(beacons);
    this.ensureEventMarkers();
  }

  /**
   * Tab cycle: every job is a mission. World beacons always; role jobs
   * (bounty / fire / impound / taxi / bus) only while seated in that car.
   */
  private focusGoals(): Array<{
    id: string;
    color: keyof typeof MISSION_COLORS;
    label: string;
    position: [number, number] | null;
    role?: boolean;
  }> {
    const goals: Array<{
      id: string;
      color: keyof typeof MISSION_COLORS;
      label: string;
      position: [number, number] | null;
      role?: boolean;
    }> = [];
    if (!this.onMission()) {
      for (const mission of this.missions) {
        goals.push({
          id: mission.id,
          color: mission.kind,
          label: mission.label,
          position: mission.position,
        });
      }
    }
    if (this.bountyFight || this.errand) return goals;
    // role missions — current car only (garage ownership is not enough)
    if (this.canHuntBounty()) {
      if (this.bountyPending && this.bountyPickup && !this.onMission()) {
        goals.push({ id: 'role-bounty', color: 'bounty', label: t('bounty.goal'), position: this.bountyPickup, role: true });
      } else if (this.bounty) {
        goals.push({
          id: 'role-bounty',
          color: 'bounty',
          label: t('bounty.marker', { name: this.bounty.name }),
          position: this.bounty.spot ?? null,
          role: true,
        });
      }
    }
    if (this.isFireTruck()) {
      if (this.fire.active && this.fire.spot) {
        goals.push({ id: 'role-fire', color: 'fire', label: t('fire.goal'), position: this.fire.spot, role: true });
      } else if (this.fire.pickup && !this.onMission()) {
        goals.push({ id: 'role-fire', color: 'fire', label: t('fire.goal'), position: this.fire.pickup, role: true });
      }
    }
    if (this.isHauler()) {
      if (this.impoundActive) {
        const drop = this.impoundDropPin();
        goals.push({
          id: 'role-impound',
          color: 'impound',
          label: drop ? t('impound.drop') : t('impound.goal'),
          position: drop ?? this.impoundSpot,
          role: true,
        });
      } else if (this.impoundPickup && !this.onMission()) {
        goals.push({ id: 'role-impound', color: 'impound', label: t('impound.goal'), position: this.impoundPickup, role: true });
      }
    }
    if (this.isTaxi()) {
      if (this.taxi.active && this.taxi.goal) {
        goals.push({ id: 'role-taxi', color: 'taxi', label: t('taxi.drop'), position: this.taxi.goal, role: true });
      } else if (this.taxi.pickup && !this.onMission()) {
        goals.push({ id: 'role-taxi', color: 'taxi', label: t('taxi.goal'), position: this.taxi.pickup, role: true });
      }
    }
    if (this.isAmbulance()) {
      if (this.ambulance.active && this.ambulance.goal) {
        goals.push({ id: 'role-ambulance', color: 'ambulance', label: t('ambulance.drop'), position: this.ambulance.goal, role: true });
      } else if (this.ambulance.pickup && !this.onMission()) {
        const label = this.ambulance.site === 'burn' ? t('ambulance.goal.burn') : t('ambulance.goal.crash');
        goals.push({ id: 'role-ambulance', color: 'ambulance', label, position: this.ambulance.pickup, role: true });
      }
    }
    if (this.isBus()) {
      if (this.busTour.active && this.busTour.goal) {
        goals.push({
          id: 'role-bus',
          color: 'bus',
          label: this.busTour.place || t('bus.drop'),
          position: this.busTour.goal,
          role: true,
        });
      } else if (this.busTour.pickup && !this.onMission()) {
        goals.push({ id: 'role-bus', color: 'bus', label: t('bus.tour'), position: this.busTour.pickup, role: true });
      }
    }
    return goals;
  }

  private placeEventBeacons(position: [number, number], heading: number) {
    for (const marker of this.missionMarkers.values()) marker.remove();
    this.missionMarkers.clear();
    this.missions = [];
    this.missionSeq = { arena: 0, race: 0, delivery: 0, collect: 0 };
    this.clearErrand();
    this.missionFocus = 0;
    this.activeMissionId = null;
    this.missionRespawnAt = 0;
    this.lastCompletedKind = null;
    this.lastCompletedAt = null;
    const seed = Math.round(position[0] * 1e5) ^ Math.round(position[1] * 1e5) ^ 42011;
    const kinds = this.missionKinds();
    for (let index = 0; index < kinds.length; index++) {
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
        const n = this.focusGoals().length;
        if (this.missionFocus >= n) this.missionFocus = Math.max(0, n - 1);
      }
      this.activeMissionId = null;
    }
    this.missionRespawnAt = performance.now() + 30000;
    this.syncMissionVisuals(true);
  }

  private refillMissions() {
    const slots = this.missionKinds().length;
    if (this.mode !== 'roam' || this.missions.length >= slots) return;
    if (!this.missionRespawnAt || performance.now() < this.missionRespawnAt) return;
    const center = this.vehicle.position as [number, number];
    const heading = this.vehicle.heading;
    const seed = Math.round(center[0] * 1e5) ^ Math.round(center[1] * 1e5) ^ (performance.now() | 0);
    // one of each kind on the map: bring back a missing one, not the one just finished if another is missing too
    const kinds = this.missionKinds();
    const missing = kinds.filter(kind => !this.missions.some(mission => mission.kind === kind));
    const kind = missing.find(k => k !== this.lastCompletedKind) ?? missing[0] ?? kinds[Math.abs(seed) % kinds.length];
    this.missions.push(this.createMission(kind, center, heading, seed ^ 0x9e37, { min: 450, max: 1400 }));
    this.missionRespawnAt = this.missions.length >= slots ? 0 : performance.now() + 30000;
    this.syncMissionVisuals(true);
    const added = this.missions[this.missions.length - 1];
    this.say(t('mission.new', { label: added.label }), true);
  }

  /** parked cars to shoot at (?testcars=N) */
  private testCars = new TestTargets((from, at, heading) => {
    if (this.collisions.blocked(from, at, heading, 1, this.altitude) || this.water.resolve(from, at, heading, 1, this.onBridgeDeck(at, this.altitude)).stopped) return false;
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
    // reuse objects — VehicleLayer only reads id/position/heading each frame
    const out = this.targetScratch;
    out.length = this.trafficBots.length;
    for (let i = 0; i < this.trafficBots.length; i++) {
      const bot = this.trafficBots[i];
      const row = out[i] ?? (out[i] = { id: '', driver: '', car: bot.car, position: bot.position, heading: 0 });
      row.id = bot.id;
      row.driver = bot.driver;
      row.car = bot.car;
      row.position = bot.position;
      row.heading = bot.heading;
    }
    return out;
  }

  private resolveVehicleContacts(now: number) {
    // movers vs movers + movers vs parked — never parked×parked (O(n²) waste on kerb props)
    type Body = { id: string; controller: VehicleController; car: Car };
    const haulId = this.haul?.id;
    const movers: Body[] = [
      { id: 'player', controller: this.vehicle, car: this.car },
      ...this.sharedTraffic.drivenBodies(),
      ...this.trafficBots
        .filter(bot => !this.combatLayer || this.combatLayer.isTargetAlive(bot.id))
        .map(bot => ({ id: bot.id, controller: bot.controller, car: bot.car })),
    ].filter(participant => participant.id !== haulId);
    const parked: Body[] = this.sharedTraffic.parkedBodies().filter(p => p.id !== haulId);

    const applyPosition = (participant: Body, next: [number, number]) => {
      const { controller } = participant;
      if (next === controller.position
        || this.collisions.blocked(controller.position, next, controller.heading, 1, participant.id === 'player' ? this.altitude : -Infinity)) return;
      const alt = participant.id === 'player' ? this.altitude : (this.map.groundAt(controller.position) ?? this.altitude);
      const water = this.water.resolve(controller.position, next, controller.heading, 1, this.onBridgeDeck(controller.position, alt));
      if (!water.stopped) controller.position = water.position;
    };

    const pair = (a: Body, b: Body) => {
      // cheap reject before SAT — most parked cars are hundreds of metres away
      const reach = (a.car.length + b.car.length) * 0.85;
      if (metersBetween(a.controller.position, b.controller.position) > reach) return;
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
      if (!collision) return;

      applyPosition(a, collision.a);
      applyPosition(b, collision.b);
      if (this.heist && ((a.id === 'player' && b.id.startsWith('police')) || (b.id === 'player' && a.id.startsWith('police')))) {
        this.heist.caught = true;
      }
      const key = `${a.id}:${b.id}`;
      if (now - (this.vehicleContactTimes.get(key) ?? 0) < 280) return;
      this.vehicleContactTimes.set(key, now);
      // every knock that flashes a car red takes health off it: the slower side takes
      // the knock, a hunting bot ramming at speed hurts whoever it rams, and harder
      const impact = Math.abs(a.controller.speed) + Math.abs(b.controller.speed);
      const hunting = (id: string) => this.findBot(id)?.mood === 'hunt';
      const ramming = (id: string) => impact > 6 && hunting(id);
      const hurt = (victim: Body, attacker: Body, slower: boolean) => {
        const rammed = ramming(attacker.id);
        if (!slower && !rammed) return;
        const amount = rammed ? Math.max(bumpDamage(impact), Math.min(55, 12 + impact * 2.2)) : bumpDamage(impact);
        if (victim.id === 'player') this.damagePlayer(amount, 180);
        else {
          this.combatLayer?.damageTarget(victim.id, amount);
          // we hit them — they leave the route and come after us
          if (attacker.id === 'player') this.provoke(victim.id);
        }
      };
      hurt(a, b, collision.slower === 'a' || collision.slower === 'both');
      hurt(b, a, collision.slower === 'b' || collision.slower === 'both');
    };

    for (let i = 0; i < movers.length; i++) {
      for (let j = i + 1; j < movers.length; j++) pair(movers[i], movers[j]);
      for (const curb of parked) pair(movers[i], curb);
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
        name: this.playerName || t('you'),
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
      ...this.trafficBots
        // police chase / bounty bandit / parked mission props are not racers
        .filter((bot) => !bot.id.startsWith('police') && bot.id !== 'wanted' && !this.isPropBot(bot.id))
        .map((bot, index) => {
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
    this.wreck();
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

  /** each hunting bot's gun: bursts while it has us in front of it */
  private hunterGuns = new Map<string, { burstUntil: number; nextBurst: number; nextShot: number }>();
  /** race: everyone on the grid until this moment (3‑2‑1 countdown); 0 when no race is starting */
  private raceStartAt = 0;
  private raceCount = 0;

  /** Mission props (tow wreck, ambulance pileup) never chase or shoot. */
  private findBot(id: string): TrafficBot | undefined {
    if (this.isPropBot(id)) return undefined;
    return this.trafficBots.find((bot) => bot.id === id)
      ?? this.sharedTraffic.bots().find((bot) => bot.id === id);
  }

  /**
   * Shot or rammed: leave the civilian route and hunt the player. Armed cars
   * also open fire via `updateHunterGuns`.
   */
  private provoke(id: string) {
    const bot = this.findBot(id);
    if (!bot || bot.mood === 'hunt') return;
    bot.mood = 'hunt';
    bot.huntId = 'player';
    bot.huntRange = metersBetween(bot.position, this.vehicle.position);
    bot.goal = [...this.vehicle.position] as Position;
    bot.route = [];
    bot.routeIndex = 1;
    bot.repathAt = 0;
  }

  /**
   * Hunters (arena, police, bounty, and anyone we provoked) shoot back: short
   * bursts when we are within ~70 m, roughly ahead of them and not behind a
   * building. Close and slow is easy to hit; far and fast mostly misses.
   */
  private updateHunterGuns(now: number) {
    if (this.playerHp <= 0 || !this.combatLayer || !this.driving) return;
    const me = this.vehicle.position;
    const hunters = [
      ...this.trafficBots,
      ...this.sharedTraffic.bots(),
    ];
    for (const bot of hunters) {
      if (bot.mood !== 'hunt' || !this.carShoots(bot.car.id)) continue;
      if (!this.combatLayer.isTargetAlive(bot.id)) continue;
      const d = metersBetween(bot.position, me);
      if (d > 70 || d < 3) continue;
      const toMe = Math.atan2((me[0] - bot.position[0]) * Math.cos(me[1] * Math.PI / 180), me[1] - bot.position[1]);
      const off = Math.abs(((toMe - bot.heading) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
      if (off > 0.7) continue;
      let gun = this.hunterGuns.get(bot.id);
      if (!gun) { gun = { burstUntil: 0, nextBurst: now + 600 + Math.random() * 900, nextShot: 0 }; this.hunterGuns.set(bot.id, gun); }
      if (now >= gun.nextBurst && now >= gun.burstUntil) {
        // no shooting through houses: look once per burst, try again soon if a wall is in the way
        if (this.collisions.sightBlocked(bot.position, me)) { gun.nextBurst = now + 400; continue; }
        gun.burstUntil = now + 800 + Math.random() * 500;
        gun.nextBurst = gun.burstUntil + 1100 + Math.random() * 1000;
      }
      if (now >= gun.burstUntil || now < gun.nextShot) continue;
      gun.nextShot = now + 105;
      const wanted = bot.id === 'wanted';
      const police = bot.id.startsWith('police');
      const chance = Math.max(0.12, Math.min(0.85, 0.8 - d / 90)) / (1 + Math.abs(this.vehicle.speed) / 30) * (police ? 1.4 : 1);
      const hit = Math.random() < chance;
      this.combatLayer.enemyShot(bot.id, hit);
      if (hit) this.damagePlayer(wanted ? 11 : police ? 15 : 6);
    }
  }

  /**
   * Health off our car. In a fight (arena, bounty, chase) zero ends it there; anywhere
   * else at zero we blow up, stop dead and come back with full health.
   */
  private damagePlayer(amount: number, flash = 220) {
    if (!this.driving || amount <= 0 || this.playerHp <= 0) return;
    this.playerHp = Math.max(0, this.playerHp - amount);
    this.combatLayer?.flashPlayer(flash);
    // a bank job ends in an arrest (updateHeist), with its own place and bill
    if (this.playerHp > 0 || this.heist) return;
    this.wreck();
  }

  /**
   * Our car blew up: the mission we were on is lost, and we come to at the nearest
   * hospital or filling station, whichever is closer, with the bill for it.
   */
  private wreck() {
    this.combatLayer?.explodePlayer();
    this.releaseHaul(null);
    const failed = this.failMission();
    this.playerHp = this.playerMaxHp;
    const drop = this.nearestRescue();
    const kind = drop?.kind ?? 'here';
    const fine = WRECK_COSTS[kind];
    this.playerMoney = Math.max(0, this.playerMoney - fine);
    if (drop && this.mapLoaded) this.placeCarAt(drop.position);
    else { this.vehicle.speed = 0; this.vehicle.throttle = 0; }
    const bill = t(`wreck.${kind}`, { fine: formatNumber(fine) });
    this.say(failed ? `${t('mission.failed')} · ${bill}` : bill, true);
  }

  /** Lose whatever mission we are on (a wreck). True if there was one. */
  private failMission() {
    if (this.errand) {
      this.clearErrand();
      this.completeActiveMission();
      this.eventCooldown = performance.now() + 8000;
      return true;
    }
    if (this.bountyFight || this.bounty) {
      if (this.bountyFight) this.endBounty(false);
      // the job is off: a new one is offered in a while
      this.bounty = null;
      saveBounty(null);
      this.bountyOfferAt = performance.now() + 60000;
      return true;
    }
    if (this.mode === 'arena') { this.endArena(false); return true; }
    if (this.mode === 'race') {
      // the bot closest to the finish takes it
      const goal = this.raceGoal;
      const leader = [...this.trafficBots].sort((a, b) => (goal ? metersBetween(a.position, goal) - metersBetween(b.position, goal) : 0))[0];
      this.endRace(leader?.id ?? '', leader?.driver ?? '');
      return true;
    }
    if (this.taxi.active) {
      this.taxi.active = false;
      this.taxi.goal = null;
      this.taxi.meters = 0;
      this.taxi.offerAt = performance.now() + 20000;
      this.syncMissionVisuals(true);
      return true;
    }
    return false;
  }

  /** The closest hospital or filling station to us. */
  private nearestRescue(): { kind: 'hospital' | 'station'; position: Position } | null {
    const here = this.vehicle.position;
    let best: { kind: 'hospital' | 'station'; position: Position; distance: number } | null = null;
    const consider = (kind: 'hospital' | 'station', position: Position) => {
      const distance = metersBetween(here, position);
      if (!best || distance < best.distance) best = { kind, position, distance };
    };
    for (const civic of this.civics.values()) if (civic.kind === 'hospital') consider('hospital', civic.position);
    for (const station of this.stations.values()) consider('station', station.place ?? station.position);
    return best;
  }

  /** Our car, standing still on the road nearest `position` (or right on it). */
  private placeCarAt(position: Position) {
    const start = this.findFreeRoad(position, 120)
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
    this.airborne = false;
    this.climb = 0;
    this.plunge = null;
    if (this.settings.terrain) {
      const ground = this.map.groundAt(this.vehicle.position);
      if (ground != null) this.altitude = ground;
    }
  }

  /**
   * True when the car is riding an overpass deck (not the road / river under it).
   * Bridge water exemptions only apply up here — must be true as soon as XY is on
   * the deck ribbon at deck height, or the water edge walls off the on-ramp.
   */
  private onBridgeDeck(at: Position, altitude: number) {
    if (this.map.isDeckAt(at, altitude)) return true;
    // fallback: dual ground sample (older gap test) for odd cases
    const low = this.map.groundAt(at);
    if (low == null) return false;
    const high = this.map.groundAt(at, altitude);
    if (high == null) return false;
    const gap = high - low;
    return gap > 0.9 && altitude >= low + gap * 0.3 && Math.abs(altitude - high) < 2.5;
  }

  /** Splash, sink under the surface, then appear on the nearest dry road. */
  private beginPlunge(waterAlt: number) {
    if (this.plunge) return;
    this.plunge = { at: performance.now(), waterAlt };
    this.airborne = false;
    this.climb = 0;
    this.vehicle.speed = 0;
    this.vehicle.throttle = 0;
    this.combatLayer?.plungeSplash();
    this.say(t('hint.sank'), true);
  }

  private tickPlunge(now: number) {
    const plunge = this.plunge;
    if (!plunge) return false;
    const age = now - plunge.at;
    // nose down and drop below the surface
    const t = Math.min(1, age / 1600);
    this.altitude = plunge.waterAlt - t * 3.2;
    this.modelPitch = 0.55 * t;
    this.modelRoll = 0.22 * Math.sin(t * Math.PI) * (t > 0.15 ? 1 : 0);
    if (age < 1700) return true;
    // wide rivers: search farther than a normal wreck drop
    const start = this.findFreeRoad(this.vehicle.position, 280)
      ?? roadStart(this.map, this.vehicle.position, () => false, 280);
    if (start) this.placeCarAt(start.position);
    else this.placeCarAt(this.vehicle.position);
    this.modelPitch = 0;
    this.modelRoll = 0;
    return false;
  }

  acceptEvent() {
    if (this.mode !== 'roam' || !this.driving || !this.eventOffer) return;
    const kind = this.eventOffer;
    if (kind === 'arena' && !this.carShoots()) {
      this.declineEvent();
      return;
    }
    const nearby = this.missions.find(mission => mission.kind === kind && metersBetween(this.vehicle.position, mission.position) <= 18)
      ?? this.missions.find(mission => mission.kind === kind)
      ?? null;
    if (kind === 'delivery' || kind === 'collect') { this.startErrand(kind, nearby); return; }
    // everyone chips in to start; the winner takes the prize
    const fee = kind === 'arena' ? ARENA_FEE : RACE_FEE;
    if (this.playerMoney < fee) {
      this.say(t('event.broke', { fee: formatNumber(fee) }), true);
      return;
    }
    this.activeMissionId = nearby?.id ?? null;
    this.eventOffer = null;
    this.onEventOffer(null);
    this.playerMoney -= fee;
    if (kind === 'arena') this.startArena();
    else this.startRace();
  }

  declineEvent() {
    this.eventOffer = null;
    this.offeredDelivery = null;
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
    // a starting grid: beside us left and right, one behind, all facing our way
    const forward = [Math.sin(heading), Math.cos(heading)], right = [Math.cos(heading), -Math.sin(heading)];
    const at = (side: number, along: number) => offsetPosition(center, forward[0] * along + right[0] * side, forward[1] * along + right[1] * side);
    const free = (p: [number, number]) => !this.collisions.blocked(center, p, heading) && !this.water.covers(p, true);
    const slots: [number, number][] = [[3.4, 0], [-3.4, 0], [0, -7.5]];
    this.trafficBots.forEach((bot, index) => {
      let spot = at(...slots[index]);
      for (let k = 1; !free(spot) && k <= 4; k++) spot = at(0, -7.5 * (k + (index === 2 ? 1 : 0)) - index * 7.5);
      bot.controller.position = [...spot];
      bot.controller.heading = heading;
      bot.controller.speed = 0;
      bot.position = [...spot];
      bot.heading = heading;
    });
    this.vehicle.speed = 0;
    this.raceStartAt = performance.now() + 3200;
    this.raceCount = 0;
    this.mode = 'race';
    this.vehicleContactTimes.clear();
    this.hideEventBeacons();
    this.combatLayer?.setRaceFinish(this.raceGoal);
    this.ensureRaceGoalMarker();
    this.ensureTrafficMarkers();
    this.combatLayer?.setTargets(this.targetVehicles());
    this.renderVehicle.reset(this.vehicle);
    this.say(t('race.start'), true);
  }

  /** 3‑2‑1 on the grid; true while nobody may move yet. */
  private raceCountdown(now: number) {
    if (this.mode !== 'race' || !this.raceStartAt) return false;
    const left = this.raceStartAt - now;
    if (left <= 0) {
      this.raceStartAt = 0;
      this.say(t('race.go'), true);
      return false;
    }
    const n = Math.ceil(left / 1000);
    if (n !== this.raceCount && n <= 3) {
      this.raceCount = n;
      this.say(String(n), true);
    }
    return true;
  }

  private endArena(won: boolean) {
    if (this.mode !== 'arena') return;
    this.mode = 'roam';
    this.eventCooldown = performance.now() + 8000;
    // losing costs only the entry fee already paid
    if (won) {
      this.playerMoney += ARENA_PRIZE;
      this.addWin('player');
      this.say(t('arena.won'), true);
    } else {
      this.say(t('arena.lost'), true);
    }
    this.playerHp = this.playerMaxHp;
    this.clearEventBots();
    this.completeActiveMission();
    this.showEventBeacons();
    this.onEventResult({ kind: 'arena', won, cash: won ? ARENA_PRIZE : undefined });
  }

  private endRace(winnerId: string, winnerName: string) {
    if (this.mode !== 'race') return;
    this.mode = 'roam';
    this.eventCooldown = performance.now() + 8000;
    const won = winnerId === 'player';
    if (won) {
      this.playerMoney += RACE_PRIZE;
      this.addWin('player');
      this.say(t('race.won'), true);
    } else {
      const bot = this.trafficBots.find(entry => entry.id === winnerId);
      if (bot) bot.money += RACE_PRIZE;
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
    this.onEventResult({ kind: 'race', won, cash: won ? RACE_PRIZE : undefined, name: won ? undefined : winnerName });
  }

  /** Everybody with a health meter over the car: us, mission bots, other players, shared traffic and test cars. */
  private meterTargets(): Meter[] {
    const layer = this.combatLayer;
    const out: Meter[] = [{ id: 'player', name: t('you'), hp: this.playerHp, maxHp: this.playerMaxHp, position: this.renderVehicle.position }];
    // named cars carry their name above the bar, in their marker's colour
    for (const p of this.players.others()) out.push({ id: `net:${p.id}`, name: p.name, hp: p.hp, maxHp: PLAYER_HP, position: p.position, color: PLAYER_MARKER_COLOR });
    const health = new Map((layer?.targetHealth() ?? []).map((h) => [h.id, h]));
    this.trafficBots.forEach((bot, index) => {
      if (this.isPropBot(bot.id)) return;
      if (layer && !layer.isTargetAlive(bot.id)) return;
      const h = health.get(bot.id);
      out.push({ id: bot.id, name: bot.driver, hp: h?.hp ?? 1000, maxHp: h?.maxHp ?? 1000, position: bot.position, color: TRAFFIC_MARKER_COLORS[index % TRAFFIC_MARKER_COLORS.length] });
    });
    for (const e of layer?.extraHealth() ?? []) {
      if (e.id.includes(':k') && e.hp >= e.maxHp) continue; // a parked car shows no meter until it is hit
      out.push({ id: e.id, name: e.driver, hp: e.hp, maxHp: e.maxHp, position: e.position });
    }
    return out;
  }

  private updateHealthMarkers(refill = true) {
    // M map: no floating HP bars (they read as green stripes over every car / traffic).
    if (!this.driving || this.mapInspecting()) { this.healthMeters.hide(); return; }
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

    // spinning coins on the road — money only, no coloured score orbs
    for (const spot of this.trafficNetwork.pickupLocations(position)) {
      const id = `coin:${spot.id}`;
      if (this.pickups.has(id) || this.collectedPickups.has(id)) continue;
      this.pickups.set(id, { position: spot.position, color: '#f2c230', kind: 'coin' });
    }
    this.pickupFocus = [...position];
    this.pickupNetworkRevision = this.trafficNetwork.revision;
    this.combatLayer?.setPickups(this.pickupVisuals());
  }

  private pickupVisuals(): PickupVisual[] {
    const boxes = this.errand?.kind === 'collect' ? this.errand.boxes : [];
    return [
      ...[...this.pickups].map(([id, pickup]) => ({
        id,
        position: pickup.position,
        color: pickup.color,
        kind: pickup.kind,
        drop: pickup.drop,
      })),
      ...boxes.map((box) => ({ id: `errand-${box.id}`, position: box.position, color: ERRAND_BEACONS.collect.pole, kind: 'box' as const })),
    ];
  }

  private dropSerial = 0;
  private trainCoinAt = 0;

  /** Train cars near `around` as flat capsules in metres east/north of it, with their ground height. */
  private trainBoxes(around: [number, number], reach: number) {
    const kx = METERS_PER_DEGREE * Math.cos(around[1] * Math.PI / 180), ky = METERS_PER_DEGREE;
    const out: { ax: number; ay: number; bx: number; by: number; half: number; alt: number; vintage: boolean }[] = [];
    for (const car of this.trainTraffic.poses()) {
      const ax = (car.front[0] - around[0]) * kx, ay = (car.front[1] - around[1]) * ky;
      const bx = (car.back[0] - around[0]) * kx, by = (car.back[1] - around[1]) * ky;
      if (Math.min(Math.hypot(ax, ay), Math.hypot(bx, by)) > reach) continue;
      const alt = this.trainLayer?.carAltitude(car.trainId, car.index) ?? this.map.groundAt([(car.front[0] + car.back[0]) / 2, (car.front[1] + car.back[1]) / 2]) ?? this.altitude;
      out.push({ ax, ay, bx, by, half: car.kind === 'tram' ? 1.3 : 1.6, alt, vintage: isVintageTrain(car.trainId) });
    }
    return out;
  }

  /** First train car a shot meets (sampled every 0.5 m), for the gun. */
  private trainShot(from: [number, number], fromAlt: number, to: [number, number], toAlt: number) {
    const kx = METERS_PER_DEGREE * Math.cos(from[1] * Math.PI / 180), ky = METERS_PER_DEGREE;
    const ex = (to[0] - from[0]) * kx, ey = (to[1] - from[1]) * ky;
    const length = Math.hypot(ex, ey);
    if (length < 1) return null;
    const boxes = this.trainBoxes(from, length + 30);
    if (!boxes.length) return null;
    const steps = Math.ceil(length / 0.5);
    for (let s = 1; s <= steps; s++) {
      const f = s / steps, x = ex * f, y = ey * f, alt = fromAlt + (toAlt - fromAlt) * f;
      for (const box of boxes) {
        const dx = box.bx - box.ax, dy = box.by - box.ay, l2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((x - box.ax) * dx + (y - box.ay) * dy) / l2));
        if (Math.hypot(x - box.ax - dx * t, y - box.ay - dy * t) > box.half) continue;
        if (alt < box.alt - 0.3 || alt > box.alt + 4.2) continue;
        return { point: offsetPosition(from, x, y) as [number, number], altitude: alt, vintage: box.vintage };
      }
    }
    return null;
  }

  /**
   * Family Sedan machine gun: any coin / cash near the bullet path is vacuumed
   * into the purse (road coins stay gone after a reload).
   */
  private shotCollectCoins(from: Position, fromAlt: number, to: Position, toAlt: number) {
    if (this.car.id !== FAMILY_SEDAN_ID) return;
    const kx = METERS_PER_DEGREE * Math.cos(from[1] * Math.PI / 180), ky = METERS_PER_DEGREE;
    const ex = (to[0] - from[0]) * kx, ey = (to[1] - from[1]) * ky, eu = toAlt - fromAlt;
    const len = Math.hypot(ex, ey, eu);
    if (len < 0.5) return;
    const ux = ex / len, uy = ey / len, uu = eu / len;
    const now = performance.now();
    let money = 0;
    for (const [id, pickup] of this.pickups) {
      if (pickup.kind !== 'coin' && pickup.kind !== 'cash') continue;
      if (pickup.drop && now < pickup.drop.at + DROP_MS) continue;
      const dx = (pickup.position[0] - from[0]) * kx;
      const dy = (pickup.position[1] - from[1]) * ky;
      const ground = this.map.groundAt(pickup.position) ?? fromAlt;
      const du = ground + 1 - fromAlt;
      const t = Math.max(0, Math.min(len, dx * ux + dy * uy + du * uu));
      if (Math.hypot(ux * t - dx, uy * t - dy, uu * t - du) > 2.8) continue;
      this.pickups.delete(id);
      if (!pickup.drop) this.collectedPickups.add(id);
      if (pickup.kind === 'cash') {
        money += CASH_BUNDLE;
        if (this.heist) this.heist.cash += CASH_BUNDLE;
      } else money += 10;
    }
    if (!money) return;
    this.playerMoney += money;
    this.combatLayer?.setPickups(this.pickupVisuals());
  }

  /** Shooting a vintage train: a coin pops out where the bullet hit (four a second), endlessly. */
  private trainCoin(point: [number, number], altitude: number) {
    const now = performance.now();
    if (now - this.trainCoinAt < 250) return; // four coins a second at most
    this.trainCoinAt = now;
    // it bounces out toward the shooter, away from the rails
    const me = this.vehicle.position;
    const kx = METERS_PER_DEGREE * Math.cos(point[1] * Math.PI / 180), ky = METERS_PER_DEGREE;
    const dx = (me[0] - point[0]) * kx, dy = (me[1] - point[1]) * ky, d = Math.hypot(dx, dy) || 1;
    const spread = (Math.random() - 0.5) * 1.2;
    const r = Math.min(d * 0.8, 2.2 + Math.random() * 1.8);
    const ux = dx / d, uy = dy / d;
    const rest = offsetPosition(point, (ux - uy * spread) * r, (uy + ux * spread) * r) as [number, number];
    // it leaves from where the bullet struck, up on the car's side
    const up = Math.max(0, altitude - (this.map.groundAt(point) ?? altitude));
    this.pickups.set(`drop:${this.dropSerial++}`, { position: rest, color: '#f2c230', kind: 'coin', drop: { from: [...point] as [number, number], at: now, up } });
    this.combatLayer?.setPickups(this.pickupVisuals());
  }

  /** Trains don't give way: a car touching one is pushed back out beside it and loses its speed. */
  private trainBlock(controller: { position: [number, number] | Position; speed: number }, altitude: number) {
    const at = controller.position as [number, number];
    const boxes = this.trainBoxes(at, 40);
    if (!boxes.length) return false;
    let pushed = false;
    let px = 0, py = 0;
    for (const box of boxes) {
      if (Math.abs(box.alt - altitude) > 3) continue;
      const dx = box.bx - box.ax, dy = box.by - box.ay, l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((px - box.ax) * dx + (py - box.ay) * dy) / l2));
      const cx = box.ax + dx * t, cy = box.ay + dy * t;
      const ox = px - cx, oy = py - cy, dist = Math.hypot(ox, oy);
      const clear = box.half + 1.1;
      if (dist >= clear) continue;
      // out along the shortest way (sideways off the car); dead centre: off to its left
      const nx = dist > 1e-3 ? ox / dist : -dy / Math.sqrt(l2), ny = dist > 1e-3 ? oy / dist : dx / Math.sqrt(l2);
      px = cx + nx * clear;
      py = cy + ny * clear;
      pushed = true;
    }
    if (!pushed) return false;
    controller.position = offsetPosition(at, px, py) as [number, number];
    controller.speed *= -0.2;
    return true;
  }

  /** A bullet hit a wall: on a bank's house, three seconds of fire crack it open. */
  private bankShot(point: [number, number]) {
    if (this.mode !== 'roam' || this.bountyFight || !this.driving || this.onMission()) return;
    const now = performance.now();
    let bank: Station | null = null;
    for (const candidate of this.banks.values()) {
      if (metersBetween(point, candidate.place ?? candidate.position) > 22) continue;
      if (metersBetween(this.vehicle.position, candidate.place ?? candidate.position) > 36) continue;
      if ((this.bankShut.get(candidate.id) ?? 0) > now) { this.say(t('heist.shut')); return; }
      bank = candidate;
      break;
    }
    if (!bank) return;
    const shots = this.bankShots;
    if (!shots || shots.id !== bank.id || now - shots.last > 450) {
      this.bankShots = { id: bank.id, ms: 0, last: now };
      this.say(t('heist.cracking'), true);
      return;
    }
    shots.ms += now - shots.last;
    shots.last = now;
    if (shots.ms >= BANK_CRACK_MS) {
      this.bankShots = null;
      this.startHeist(bank);
    }
  }

  /** The bank gives: 3–5 bundles fly out of the door, and three police cars come from three sides. */
  private startHeist(bank: Station) {
    const now = performance.now();
    this.bankShut.set(bank.id, now + 15 * 60_000);
    const from = (bank.place ?? bank.position) as [number, number];
    const count = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const r = 1.5 + Math.random() * 3;
      let rest = offsetPosition(bank.position, Math.sin(angle) * r, Math.cos(angle) * r) as [number, number];
      if (this.collisions.sightBlocked(bank.position, rest)) rest = [...bank.position] as [number, number];
      this.pickups.set(`cash:${this.dropSerial++}`, { position: rest, color: '#3f8f4e', kind: 'cash', drop: { from: [...from] as [number, number], at: now } });
    }
    this.combatLayer?.setPickups(this.pickupVisuals());
    this.startChase();
    this.say(t('heist.alarm'), true);
  }

  /** Three police cars come for us (a bank job or a hijack); `stolen`: the car we took. */
  private startChase(stolen?: { carId: string; previousId: string; owned: boolean }) {
    this.trafficBots = [];
    this.heist = { cash: 0, reinforce: 0, sent: 0, caught: false, stolen };
    this.mode = 'arena';
    this.vehicleContactTimes.clear();
    this.hideEventBeacons();
    this.sendPolice(3);
  }

  /** H beside a parked car (ours or somebody else's): get in and drive off — the police come. */
  private tryHijack() {
    if (!this.driving || this.paused || this.mode !== 'roam' || this.bountyFight) return;
    if (this.onMission()) { this.say(t('mission.busy'), true); return; }
    const near = this.sharedTraffic.parkedNear(this.vehicle.position, 4.5);
    if (!near) { this.say(t('hijack.none'), true); return; }
    if (Math.abs(this.vehicle.speed) > 2.5) { this.say(t('hijack.slow'), true); return; }
    this.sharedTraffic.takeParked(near.id);
    const previous = this.car;
    // a stolen car never joins the garage: get away and it goes to the black market
    const owned = this.garage.has(near.car.id);
    this.setCar(near.car);
    this.onCarBought(near.car);
    // we sit in it where it stood; our own car waits in the garage
    this.vehicle.position = [...near.position] as [number, number];
    this.vehicle.heading = near.heading;
    this.vehicle.speed = 0;
    this.vehicle.throttle = 0;
    this.bearing = this.vehicle.heading * 180 / Math.PI;
    this.renderVehicle.reset(this.vehicle);
    this.accumulator = 0;
    this.startChase({ carId: near.car.id, previousId: previous.id, owned });
    this.say(t('hijack.started', { car: near.car.name }), true);
  }

  /** A word when we stop beside a parked car. */
  private hijackHint() {
    if (!this.driving || this.mode !== 'roam' || this.onMission() || Math.abs(this.vehicle.speed) > 2.5) return;
    const near = this.sharedTraffic.parkedNear(this.vehicle.position, 4.5);
    if (!near || near.id === this.hijackHintFor) return;
    this.hijackHintFor = near.id;
    this.say(t('hijack.hint', { car: near.car.name }), true);
  }

  /**
   * Where a bot may cut straight to, off the roads: a hunter (police, arena, the wanted car)
   * at its prey, a racer at the flag — when it is within 350 m and no house stands between.
   * At us it leads the shot a little (where we will be in half a second).
   */
  private botShortcut(bot: { id: string; mood: string; goal: Position | null; huntId: string | null; position: Position }, now: number): Position | null {
    const racing = this.mode === 'race' && Boolean(bot.goal);
    if (bot.mood !== 'hunt' && !racing) return null;
    let target = bot.goal;
    if (bot.mood === 'hunt' && bot.huntId === 'player') {
      const v = this.vehicle.speed * 0.5;
      target = offsetPosition(this.vehicle.position, Math.sin(this.vehicle.heading) * v, Math.cos(this.vehicle.heading) * v) as Position;
    }
    if (!target || metersBetween(bot.position, target) > 350) return null;
    let sight = this.botSight.get(bot.id);
    if (!sight || now - sight.at > 300) {
      sight = { at: now, clear: !this.collisions.sightBlocked(bot.position, target) && !this.water.covers(target, true) };
      this.botSight.set(bot.id, sight);
    }
    return sight.clear ? target : null;
  }

  /**
   * The police keep up: a little quicker than our car without the boost, and the farther
   * behind, the harder they push — from ~100 m up to our full boost and a bit over.
   */
  private policePace(bot: { position: [number, number] | Position; car: Car }) {
    const d = metersBetween(bot.position, this.vehicle.position);
    const ours = this.car.maxSpeed;
    const base = Math.max(bot.car.maxSpeed, ours * 1.05);
    const chase = Math.max(0, Math.min(1, (d - 100) / 350));
    return {
      ...vehicleConfig,
      acceleration: Math.max(bot.car.acceleration, this.car.acceleration) * (1.05 + 0.25 * chase),
      maxSpeed: base + (ours * 1.6 - base) * chase,
    };
  }

  /** Police cars ~200 m out on the roads, spread round us, coming in. */
  private sendPolice(count: number) {
    const heist = this.heist;
    if (!heist) return;
    const me = this.vehicle.position as [number, number];
    const used = new Set<string>();
    const base = Math.random() * Math.PI * 2;
    const police = carsConfig.filter((car) => car.id === '09' || car.id === '16');
    for (let k = 0; k < count && heist.sent < 14; k++) {
      const angle = base + (k / count) * Math.PI * 2;
      const around = offsetPosition(me, Math.sin(angle) * 200, Math.cos(angle) * 200) as [number, number];
      const car = police[(heist.sent + k) % police.length] ?? carsConfig[0];
      const bot = createTrafficBot(`police-${heist.sent}`, t('heist.police'), car, this.trafficNetwork, around, angle + Math.PI, used, 'hunt', (heist.sent + 1) * 7919, { min: 0, max: 70 });
      heist.sent++;
      this.trafficBots.push(bot);
    }
    this.ensureTrafficMarkers();
    this.combatLayer?.setTargets(this.targetVehicles());
  }

  /** The chase: police shoot to kill; a touch or a wrecked car is an arrest. 1 km ahead = freedom. */
  private updateHeist() {
    const heist = this.heist!;
    if (heist.reinforce > 0) {
      this.sendPolice(heist.reinforce);
      heist.reinforce = 0;
    }
    if (this.playerHp > 0 && this.playerHp <= this.playerMaxHp * 0.35) this.combatLayer?.burnPlayer();
    if (heist.caught || this.playerHp <= 0) {
      this.arrest();
      return;
    }
    // police left far behind give up
    const me = this.vehicle.position;
    const chasing = this.trafficBots.filter((bot) => this.combatLayer?.isTargetAlive(bot.id) !== false);
    const now = performance.now();
    for (const bot of chasing) {
      if (metersBetween(bot.position, me) > POLICE_GIVE_UP_M) { if (!this.policeFar.has(bot.id)) this.policeFar.set(bot.id, now); }
      else this.policeFar.delete(bot.id);
    }
    const behind = chasing.filter((bot) => now - (this.policeFar.get(bot.id) ?? now) > POLICE_GIVE_UP_MS);
    if (behind.length) {
      const gone = new Set(behind.map((bot) => bot.id));
      this.trafficBots = this.trafficBots.filter((bot) => !gone.has(bot.id));
      this.ensureTrafficMarkers();
      this.combatLayer?.setTargets(this.targetVehicles());
      if (this.trafficBots.some((bot) => this.combatLayer?.isTargetAlive(bot.id))) this.say(t('heist.lost'), true);
    }
    if (!this.trafficBots.some((bot) => this.combatLayer?.isTargetAlive(bot.id) !== false)) this.endHeist();
  }

  /** Got away: keep the cash. */
  private endHeist() {
    const cash = this.heist?.cash ?? 0;
    const stolen = this.heist?.stolen;
    this.heist = null;
    this.mode = 'roam';
    this.clearEventBots();
    this.showEventBeacons();
    this.eventCooldown = performance.now() + 8000;
    if (stolen) {
      // got away in a stolen car: the black market takes it for half its price; we're back in ours
      const sold = carsConfig.find((car) => car.id === stolen.carId);
      const price = sold ? Math.round(carPrice(sold) / 2) : 0;
      this.playerMoney += price;
      const previous = carsConfig.find((car) => car.id === stolen.previousId);
      if (previous) { this.setCar(previous); this.onCarBought(previous); }
      this.onEventResult({ kind: 'hijack', won: true, cash: price, name: sold?.name ?? '' });
    } else this.onEventResult({ kind: 'heist', won: true, cash });
  }

  /** Arrested: car blows up; wake at the nearest police / prison / court / hospital with a fat bill. */
  private arrest() {
    const heist = this.heist!;
    const stolen = heist.cash;
    // a hijacked car goes back to its owner; we are in our own again
    if (heist.stolen) {
      const previous = carsConfig.find((car) => car.id === heist.stolen!.previousId);
      if (previous) { this.setCar(previous); this.onCarBought(previous); }
    }
    this.heist = null;
    this.mode = 'roam';
    this.clearEventBots();
    this.showEventBeacons();
    this.eventCooldown = performance.now() + 8000;
    // the cash still lying about goes back to the bank
    for (const [id, pickup] of this.pickups) if (pickup.kind === 'cash') this.pickups.delete(id);
    this.combatLayer?.setPickups(this.pickupVisuals());
    this.combatLayer?.explodePlayer();
    const drop = this.nearestCivic();
    const kind = drop?.kind ?? null;
    const fine = (kind ? ARREST_COSTS[kind] : ARREST_FINE) + stolen;
    this.playerMoney = Math.max(0, this.playerMoney - fine);
    this.playerHp = this.playerMaxHp;
    if (drop && this.mapLoaded) this.placeCarAt(drop.station.position);
    else {
      this.vehicle.speed = 0;
      this.vehicle.throttle = 0;
      this.renderVehicle.reset(this.vehicle);
      this.accumulator = 0;
    }
    const messages = {
      police: 'heist.arrested.police',
      prison: 'heist.arrested.prison',
      court: 'heist.arrested.court',
      hospital: 'heist.arrested.hospital',
    } as const;
    this.say(t(kind ? messages[kind] : 'heist.arrested', { fine: formatNumber(fine) }), true);
  }

  /** Closest police station, prison, courthouse or hospital to the wreck. */
  private nearestCivic(): { station: Station; kind: CivicKind; distance: number } | null {
    let best: { station: Station; kind: CivicKind; distance: number } | null = null;
    for (const station of this.civics.values()) {
      const distance = metersBetween(this.vehicle.position, station.position);
      if (!best || distance < best.distance) best = { station, kind: station.kind, distance };
    }
    return best;
  }

  /** Coins fly out (ten from a wreck, one from a tree) and roll a couple of metres before they lie still. */
  private dropCoins(at: [number, number], count = 10) {
    const now = performance.now();
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.5;
      let r = (count > 1 ? 0.9 : 0.6) + Math.random() * 2.1;
      let rest = offsetPosition(at, Math.sin(angle) * r, Math.cos(angle) * r) as [number, number];
      // not into a house: pull it back toward the wreck
      while (r > 0.4 && this.collisions.sightBlocked(at, rest)) {
        r *= 0.5;
        rest = offsetPosition(at, Math.sin(angle) * r, Math.cos(angle) * r) as [number, number];
      }
      this.pickups.set(`drop:${this.dropSerial++}`, { position: rest, color: '#f2c230', kind: 'coin', drop: { from: [...at] as [number, number], at: now } });
    }
    this.combatLayer?.setPickups(this.pickupVisuals());
  }

  private collectRoadPickups() {
    const collect = (position: [number, number], player = false) => {
      let money = 0;
      const now = performance.now();
      for (const [id, pickup] of this.pickups) {
        if (pickup.drop && now < pickup.drop.at + DROP_MS) continue; // still in the air
        if (pickup.kind === 'cash' && !player) continue;             // bank money is ours to grab
        if (metersBetween(position, pickup.position) > (pickup.kind === 'cash' ? 4.5 : 3.5)) continue;
        this.pickups.delete(id);
        if (!pickup.drop) this.collectedPickups.add(id); // road coins stay gone after a reload
        if (pickup.kind === 'cash') {
          money += CASH_BUNDLE;
          if (this.heist) this.heist.cash += CASH_BUNDLE;
          this.say(t('heist.cash', { n: formatNumber(CASH_BUNDLE) }), true);
        } else money += 10;
      }
      return money;
    };
    const playerMoney = collect(this.vehicle.position, true);
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

  /** our name on the roster and in multiplayer */
  private playerName = '';

  /** Join the shared world under this name (again: just a rename). */
  joinNetwork(name: string) {
    this.playerName = name.trim();
    this.players.join(this.playerName);
  }

  private ensureTrafficMarkers() {
    if (!this.trafficMarkerLayer) {
      this.trafficMarkerLayer = document.createElement('div');
      this.trafficMarkerLayer.className = 'traffic-indicators';
      this.host.appendChild(this.trafficMarkerLayer);
    }
    const markerLayer = this.trafficMarkerLayer;
    const active = new Set(
      this.trafficBots.filter((bot) => bot.id !== 'wanted' && !this.isPropBot(bot.id)).map((bot) => bot.id),
    );
    for (const [id, marker] of this.trafficMarkers) {
      if (active.has(id)) continue;
      marker.element.remove();
      this.trafficMarkers.delete(id);
    }
    this.trafficBots.forEach((bot, index) => {
      // bounty bandit: chase arrow is bounty-indicator only (no second name tag)
      if (bot.id === 'wanted' || this.isPropBot(bot.id)) return;
      if (this.trafficMarkers.has(bot.id)) return;
      const marker = nameIndicator('traffic-indicator', TRAFFIC_MARKER_COLORS[index % TRAFFIC_MARKER_COLORS.length]);
      marker.name.textContent = bot.driver;
      markerLayer.appendChild(marker.element);
      this.trafficMarkers.set(bot.id, marker);
    });
  }

  private updateTrafficMarkers() {
    for (const marker of this.trafficMarkers.values()) marker.element.style.display = 'none';
    // Named mission bots (arena / race / …) — on the HUD and on the M map.
    // Wanted uses bounty-indicator; ambient shared traffic stays unmarked.
    if (!this.driving || !this.trafficBots.length) return;
    this.ensureTrafficMarkers();
    this.trafficBots.forEach((bot, index) => {
      if (bot.id === 'wanted' || this.isPropBot(bot.id)) return;
      const marker = this.trafficMarkers.get(bot.id);
      if (!marker) return;
      const dead = !(this.combatLayer?.isTargetAlive(bot.id) ?? true);
      marker.element.style.setProperty(
        '--traffic-color',
        dead ? '#8b9198' : TRAFFIC_MARKER_COLORS[index % TRAFFIC_MARKER_COLORS.length],
      );
      marker.element.classList.toggle('is-dead', dead);
      marker.name.textContent = bot.driver;
      this.placeTargetIndicator(marker, bot.position, MARKER_PIN_METERS);
    });
  }

  private updateEvents() {
    if (!this.driving) return;
    if (this.heist) { this.updateHeist(); return; }
    this.updateBounty();
    this.updateFire();
    this.updateImpound();
    this.updateTaxi();
    this.updateAmbulance();
    this.updateBus();
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
    if (this.errand) { this.updateErrand(); return; }
    this.refillMissions();
    // one mission at a time: none offered while another is on
    if (this.onMission() || this.eventOffer || performance.now() < this.eventCooldown) return;
    // the offer opens only right at the marker, not from the street beside it
    const nearby = this.missions.find(mission =>
      metersBetween(this.vehicle.position, mission.position) <= MISSION_PICKUP_M
      && (mission.kind !== 'arena' || this.carShoots()));
    if (!nearby) return;
    const offer = this.offerFor(nearby);
    if (!offer) {
      this.eventCooldown = performance.now() + 8000;
      this.say(t('delivery.unavailable'), true);
      return;
    }
    this.eventOffer = nearby.kind;
    this.activeMissionId = nearby.id;
    this.onEventOffer(offer);
  }

  /** On a mission of any kind (arena, race, chase, a hunt, an errand, a fire, an impound): nothing else is offered or shown. */
  private onMission() {
    return this.mode !== 'roam'
      || Boolean(this.heist)
      || this.bountyFight
      || (Boolean(this.bounty) && this.canHuntBounty())
      || Boolean(this.errand)
      || this.fire.active
      || this.impoundActive
      || this.taxi.active
      || this.ambulance.active
      || this.busTour.active;
  }

  /** What the marker's dialog says; a delivery picks its address and pay here. Null: no address to go to. */
  private offerFor(mission: { kind: MissionKind; position: [number, number] }): EventOffer | null {
    if (mission.kind === 'delivery') {
      const seed = (performance.now() | 0) ^ Math.round(mission.position[0] * 1e5);
      const node = this.trafficNetwork.randomAway(mission.position, new Set(), DELIVERY_MIN_M, DELIVERY_MAX_M, seed);
      const meters = node ? metersBetween(node.position, mission.position) : 0;
      if (!node || meters < DELIVERY_MIN_M * 0.6 || meters > DELIVERY_MAX_M * 1.3) return null;
      const item = randomItem(seed >> 3);
      const reward = deliveryReward(meters);
      this.offeredDelivery = { item, goal: [...node.position] as Position, reward };
      return { kind: 'delivery', item, km: Math.round(meters / 100) / 10, reward };
    }
    if (mission.kind === 'collect') return { kind: 'collect', boxes: COLLECT_BOXES, reward: COLLECT_REWARD };
    if (mission.kind === 'arena') return { kind: 'arena', reward: ARENA_PRIZE };
    if (mission.kind === 'race') return { kind: 'race', reward: RACE_PRIZE };
    return { kind: mission.kind };
  }

  /** Took the errand at its marker: the address, or ten boxes about the area. */
  private startErrand(kind: 'delivery' | 'collect', mission: { id: string; position: [number, number] } | null) {
    this.activeMissionId = mission?.id ?? null;
    this.eventOffer = null;
    this.onEventOffer(null);
    if (kind === 'delivery') {
      const offered = this.offeredDelivery;
      this.offeredDelivery = null;
      if (!offered) return;
      this.errand = { kind: 'delivery', ...offered };
      this.say(t('delivery.start', { item: t(`item.${offered.item}`) }), true);
    } else {
      const center = mission?.position ?? [...this.vehicle.position] as [number, number];
      const seed = Math.round(center[0] * 1e5) ^ Math.round(center[1] * 1e5) ^ (performance.now() | 0);
      const boxes = scatterBoxes(center, seed, (min, max, at) => this.trafficNetwork.randomAway(center, new Set(), min, max, at)?.position ?? null);
      this.errand = { kind: 'collect', center, boxes, total: boxes.length, reward: COLLECT_REWARD };
      this.say(t('collect.start', { n: boxes.length }), true);
    }
    this.syncMissionVisuals(true);
    this.syncErrandMarkers();
    this.combatLayer?.setPickups(this.pickupVisuals());
  }

  /** Every frame on an errand: arrived at the address, or drove over a box. */
  private updateErrand() {
    const errand = this.errand!;
    const here = this.vehicle.position;
    if (errand.kind === 'delivery') {
      if (metersBetween(here, errand.goal) > DELIVERY_REACH_M) return;
      const item = t(`item.${errand.item}`);
      this.finishErrand(errand.reward, t('delivery.done', { reward: formatNumber(errand.reward) }), { kind: 'delivery', won: true, cash: errand.reward, name: item });
      return;
    }
    const got = errand.boxes.filter(box => metersBetween(here, box.position) <= BOX_REACH_M);
    if (!got.length) return;
    errand.boxes = errand.boxes.filter(box => !got.includes(box));
    const n = errand.total - errand.boxes.length;
    if (!errand.boxes.length) {
      this.finishErrand(errand.reward, t('collect.done', { total: errand.total, reward: formatNumber(errand.reward) }), { kind: 'collect', won: true, cash: errand.reward });
      return;
    }
    this.say(t('collect.got', { n, total: errand.total }), true);
    this.syncMissionVisuals(true);
    this.syncErrandMarkers();
    this.combatLayer?.setPickups(this.pickupVisuals());
  }

  private finishErrand(reward: number, text: string, result: EventResult) {
    this.playerMoney += reward;
    this.addWin('player');
    this.clearErrand();
    this.completeActiveMission();
    this.eventCooldown = performance.now() + 8000;
    this.say(text, true);
    this.onEventResult(result);
  }

  /** No errand any more (done, lost, or a new drive): its markers and boxes go. */
  private clearErrand() {
    this.errand = null;
    this.offeredDelivery = null;
    this.syncErrandMarkers();
    this.combatLayer?.setPickups(this.pickupVisuals());
  }

  /** Map labels + matching offscreen tips: the address, or one identical tip per box. */
  private syncErrandMarkers() {
    const errand = this.errand;
    const wanted = new Map<string, { position: [number, number]; className: string; text: string; kind: 'delivery' | 'collect'; colors: { main: string; soft: string } }>();
    if (errand?.kind === 'delivery') {
      wanted.set('goal', { position: errand.goal, className: 'delivery-goal-marker', text: t('delivery.goal'), kind: 'delivery', colors: MISSION_COLORS.delivery });
    }
    if (errand?.kind === 'collect') {
      for (const box of errand.boxes) {
        wanted.set(box.id, { position: box.position, className: 'collect-box-marker', text: t('collect.box'), kind: 'collect', colors: MISSION_COLORS.collect });
      }
    }
    for (const [id, marker] of this.errandMarkers) {
      if (wanted.has(id)) continue;
      marker.remove();
      this.errandMarkers.delete(id);
    }
    for (const [id, tip] of this.errandIndicators) {
      if (wanted.has(id)) continue;
      tip.element.remove();
      this.errandIndicators.delete(id);
    }
    if (wanted.size && !this.eventIndicatorLayer) {
      this.eventIndicatorLayer = document.createElement('div');
      this.eventIndicatorLayer.className = 'mission-indicators';
      this.host.appendChild(this.eventIndicatorLayer);
    }
    for (const [id, spec] of wanted) {
      if (!this.errandMarkers.has(id)) {
        this.errandMarkers.set(id, this.marker({
          element: this.makeMapLabel(spec.className, spec.text, spec.text, spec.colors),
          anchor: 'bottom',
        }).setLngLat(spec.position).addTo(this.map));
      }
      if (!this.errandIndicators.has(id) && this.eventIndicatorLayer) {
        const tip = this.makeOffscreenIndicator('focus', spec.text);
        this.paintMissionIndicator(tip.element, spec.kind);
        this.eventIndicatorLayer.appendChild(tip.element);
        this.errandIndicators.set(id, tip);
      }
    }
  }

  /** Active errand pins with the same label (delivery address, or every box left). */
  private errandPins(): Array<{ id: string; position: [number, number]; label: string; kind: 'delivery' | 'collect' }> {
    const errand = this.errand;
    if (!errand) return [];
    if (errand.kind === 'delivery') return [{ id: 'goal', position: errand.goal, label: t('delivery.goal'), kind: 'delivery' }];
    return errand.boxes.map((box) => ({
      id: box.id,
      position: box.position as [number, number],
      label: t('collect.box'),
      kind: 'collect' as const,
    }));
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
      this.selfMarker = this.marker({ element, anchor: 'bottom' }).addTo(this.map);
    }
    const element = this.selfMarker.getElement();
    element.style.display = '';
    const label = element.querySelector('b');
    if (label) label.textContent = t('you');
    this.selfMarker.setLngLat(this.renderVehicle.position as [number, number]);
  }

  // ---- the hauler: a cable, a car on our back --------------------------------

  /** Cars the cable can take: our mission bots and the traffic and parked cars we keep. `speed` is signed (m/s). */
  private haulCandidates() {
    const layer = this.combatLayer;
    return [
      ...this.trafficBots
        .filter(bot => !layer || layer.isTargetAlive(bot.id))
        .map(bot => ({ id: bot.id, kind: 'bot' as const, car: bot.car, position: bot.position as Position, heading: bot.heading, speed: bot.controller.speed })),
      ...this.sharedTraffic.holdable().map(c => ({ ...c, kind: 'shared' as const })),
    ];
  }

  private haulTarget(id: string) {
    return this.haulCandidates().find((c) => c.id === id) ?? null;
  }

  /** Howler (LMB) / Batmobile (RMB): throw the cable; yank what it holds; let go. Works mid-jump too. */
  private haulClick() {
    if (!this.canCable()) return;
    const now = performance.now();
    const haul = this.haul;
    if (haul) {
      if (haul.phase === 'hooked') { haul.phase = 'pull'; haul.at = now; }
      else if (haul.phase === 'anchored') { haul.phase = 'reel'; haul.at = now; haul.self = [...this.vehicle.position] as Position; haul.selfAlt = this.altitude; haul.fromHeading = this.vehicle.heading; }
      else if (haul.phase === 'carry') { haul.phase = 'drop'; haul.at = now; }
      else if (haul.kind === 'train' && haul.phase === 'towed' && !haul.reeled) { haul.phase = 'reel'; haul.at = now; haul.ropeFrom = haul.rope; haul.reeled = true; }
      else if (haul.kind === 'train' && (haul.phase === 'towed' || haul.phase === 'reel')) this.releaseTrain();
      else if (haul.phase === 'hang' || haul.phase === 'reel') this.letGoWall();
      return; // flying out, or busy pulling
    }
    const here = this.vehicle.position;
    const heading = this.vehicle.heading;
    // the cable leaves from the middle of the car (its centre of mass)
    const nose = [...here] as Position;
    const noseAlt = this.altitude + 0.9;
    const target = this.combatLayer?.aimTarget() ?? null;
    const point: Position = target ? [...target.position] as Position : offsetPosition(here, Math.sin(heading) * HAUL_REACH_M, Math.cos(heading) * HAUL_REACH_M) as Position;
    const groundUp = (at: Position) => (this.map.groundAt(at) ?? this.altitude) - this.altitude;
    // a coin (or bundle of cash) right under the crosshair: the hook takes that one and
    // reels it in by itself
    if (this.aimScreen) {
      const [sx, sy] = this.aimScreen;
      let best: { id: string; at: Position; d: number } | null = null;
      for (const [id, p] of this.pickups) {
        if ((p.kind !== 'coin' && p.kind !== 'cash') || (p.drop && now < p.drop.at + DROP_MS)) continue;
        if (metersBetween(nose, p.position) > HAUL_REACH_M) continue;
        const q = this.map.project(p.position);
        // how many pixels a metre is there: the coin hovers ~0.6 m up (higher on screen), and
        // near ones get a catch zone as big as ~2.5 m round them
        const r = this.map.project(offsetPosition(p.position, 1, 0) as Position);
        const perMeter = Math.hypot(r.x - q.x, r.y - q.y);
        const d = Math.hypot(q.x - sx, q.y - perMeter * 0.5 - sy);
        if (d <= Math.max(HAUL_COIN_PX, perMeter * 2.5) && (!best || d < best.d)) best = { id, at: [...p.position] as Position, d };
      }
      if (best) {
        this.haul = { id: '', kind: 'coins', car: this.car, phase: 'fly', at: now, from: best.at, fromHeading: heading, fromUp: groundUp(best.at) + 0.6, coins: [{ id: best.id, start: best.at }] };
        return;
      }
    }
    // a car under the crosshair (on screen, as big as the car looks there), within the
    // cable's reach of us (to its near side)
    let best: ReturnType<GameEngine['haulCandidates']>[number] | null = null;
    let bestD = Infinity;
    for (const c of this.haulCandidates()) {
      if (metersBetween(nose, c.position) - c.car.length / 2 > HAUL_REACH_M) continue;
      if (this.aimScreen) {
        const q = this.map.project(c.position);
        const tip = this.map.project(offsetPosition(c.position, Math.sin(c.heading) * c.car.length / 2, Math.cos(c.heading) * c.car.length / 2) as Position);
        const reach = Math.max(14, Math.hypot(tip.x - q.x, tip.y - q.y) * 0.9 + 6);
        const d = Math.hypot(q.x - this.aimScreen[0], q.y - 10 - this.aimScreen[1]); // aim at the body, a little above its ground point
        if (d <= reach && d < bestD) { bestD = d; best = c; }
      } else {
        const d = metersBetween(point, c.position);
        if (d <= HAUL_AIM_M && d < bestD) { bestD = d; best = c; }
      }
    }
    if (best) {
      if (best.kind === 'shared') this.sharedTraffic.hold(best.id);
      this.haul = { id: best.id, kind: best.kind, car: best.car, phase: 'fly', at: now, from: [...best.position] as Position, fromHeading: best.heading, fromUp: groundUp(best.position) };
      return;
    }
    // a train car by the aim: the hook takes it, and the train takes us
    if (!best) {
      let hit: { trainId: string; at: Position; d: number } | null = null;
      const kx = METERS_PER_DEGREE * Math.cos(point[1] * Math.PI / 180), ky = METERS_PER_DEGREE;
      for (const car of this.trainTraffic.poses()) {
        const ax = (car.back[0] - point[0]) * kx, ay = (car.back[1] - point[1]) * ky;
        const bx = (car.front[0] - point[0]) * kx, by = (car.front[1] - point[1]) * ky;
        const dx = bx - ax, dy = by - ay;
        const tt = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
        const cx = ax + dx * tt, cy = ay + dy * tt, d = Math.hypot(cx, cy);
        const at: Position = [point[0] + cx / kx, point[1] + cy / ky];
        if (d < 3 && (!hit || d < hit.d) && metersBetween(nose, at) <= HAUL_REACH_M) hit = { trainId: car.trainId, at, d };
      }
      if (hit) {
        this.haul = { id: '', kind: 'train', car: this.car, phase: 'fly', at: now, from: hit.at, fromHeading: heading, fromUp: groundUp(hit.at) + 1.4, trainId: hit.trainId };
        return;
      }
    }
    // a wall within reach: the hook bites into it
    if (!best && target?.wall) {
      const reach = Math.hypot(metersBetween(nose, target.position), target.altitude - noseAlt);
      if (reach <= HAUL_REACH_M) {
        this.haul = { id: '', kind: 'wall', car: this.car, phase: 'fly', at: now, from: [...target.position] as Position, fromHeading: heading, fromUp: target.altitude - this.altitude, hookAlt: target.altitude };
        return;
      }
    }
    // nothing it can hold: out to its full length toward the aim (straight ahead if the aim
    // is on the car itself), a moment there, and back
    const far = metersBetween(nose, point);
    const end: Position = far > 1
      ? [nose[0] + (point[0] - nose[0]) * HAUL_REACH_M / far, nose[1] + (point[1] - nose[1]) * HAUL_REACH_M / far]
      : offsetPosition(nose, Math.sin(heading) * HAUL_REACH_M, Math.cos(heading) * HAUL_REACH_M) as Position;
    this.haul = { id: '', kind: 'wall', car: this.car, phase: 'miss', at: now, from: end, fromHeading: 0, fromUp: target?.wall ? Math.min(target.altitude - this.altitude, 4) : groundUp(end) + 0.4 };
  }

  /**
   * On a train's cable. The hook flies to the car we aimed at; then the rope runs from the
   * back of the last car, so the train drags us along behind it, straightened out on its
   * line; reeling in brings us up to a couple of metres behind it, never into it.
   */
  private updateTow(haul: NonNullable<GameEngine['haul']>, now: number, nose: Position) {
    const layer = this.combatLayer;
    const cars = this.trainTraffic.poses().filter(car => car.trainId === haul.trainId);
    if (!cars.length) { this.releaseTrain(); return; }
    const last = cars.reduce((a, b) => (b.index > a.index ? b : a));
    const kx = METERS_PER_DEGREE * Math.cos(last.back[1] * Math.PI / 180), ky = METERS_PER_DEGREE;
    const ex = (last.front[0] - last.back[0]) * kx, ny = (last.front[1] - last.back[1]) * ky;
    const len = Math.hypot(ex, ny) || 1;
    const ue = ex / len, un = ny / len; // the train's way, at its tail
    const tail: Position = [...last.back] as Position;
    const tailUp = (this.map.groundAt(tail) ?? this.altitude) - this.altitude + 1.1;
    const dt = this.towClock ? Math.min(0.1, (now - this.towClock) / 1000) : 0;
    this.towClock = now;
    if (haul.phase === 'fly') {
      const t = Math.min(1, (now - haul.at) / HAUL_FLY_MS);
      layer?.setCable({ position: [nose[0] + (haul.from[0] - nose[0]) * t, nose[1] + (haul.from[1] - nose[1]) * t], up: 0.9 + (haul.fromUp - 0.9) * t, wave: 1 });
      if (t < 1) return;
      haul.phase = 'towed';
      haul.at = now;
      haul.rope = Math.max(3, Math.min(HAUL_SNAP_M, metersBetween(this.vehicle.position, tail) - this.car.length / 2));
      haul.from = tail;
      this.towed = true;
      return;
    }
    if (haul.phase === 'reel') {
      const t = Math.min(1, (now - haul.at) / 1000);
      haul.rope = (haul.ropeFrom ?? 3) + (2.5 - (haul.ropeFrom ?? 3)) * t * t * (3 - 2 * t);
      if (t >= 1) haul.phase = 'towed';
    }
    // where the rope holds us: behind the tail, on the train's line, nose to it
    const back = (haul.rope ?? 3) + this.car.length / 2;
    const spot: Position = [tail[0] - ue * back / kx, tail[1] - un * back / ky];
    const k = dt ? 1 - Math.exp(-dt * 6) : 0;
    const before = this.vehicle.position;
    const next: Position = [before[0] + (spot[0] - before[0]) * k, before[1] + (spot[1] - before[1]) * k];
    const moved = metersBetween(before, next);
    this.vehicle.position = next;
    const want = Math.atan2(ue, un);
    let turn = (want - this.vehicle.heading) % (Math.PI * 2);
    if (turn > Math.PI) turn -= Math.PI * 2;
    if (turn < -Math.PI) turn += Math.PI * 2;
    this.vehicle.heading += turn * k;
    // as fast as we are dragged (the speedometer shows it; let go and we roll on with it)
    if (dt) this.towSpeed += (moved / dt - this.towSpeed) * Math.min(1, dt * 4);
    this.vehicle.speed = this.towSpeed;
    this.renderVehicle.reset(this.vehicle);
    layer?.setCable({ position: tail, up: tailUp, wave: 0 });
  }

  /** Off the train's cable: we roll on at the speed it dragged us. */
  private releaseTrain() {
    this.haul = null;
    this.towed = false;
    this.towClock = 0;
    this.combatLayer?.setCable(null);
    this.vehicle.speed = this.towSpeed;
    this.towSpeed = 0;
  }

  /** Off the wall: the cable goes, we fall. */
  private letGoWall() {
    this.haul = null;
    this.hangAltitude = null;
    this.combatLayer?.setCable(null);
    this.airborne = true;
    this.climb = 0;
  }

  /** Once a frame: fly the cable, hold or yank the car, carry it, reel us up a wall, let go. */
  private updateHaul(now: number) {
    const haul = this.haul;
    const layer = this.combatLayer;
    if (!haul) return;
    const here = this.renderVehicle.position as Position, heading = this.renderVehicle.heading;
    const ease = (k: number) => k * k * (3 - 2 * k);
    const along = (meters: number) => offsetPosition(here, Math.sin(heading) * meters, Math.cos(heading) * meters) as Position;
    const mix = (a: Position, b: Position, k: number): Position => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
    const turn = (a: number, b: number, k: number) => {
      let d = (b - a) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      return a + d * k;
    };
    const nose = along(0);
    const k = (ms: number) => Math.min(1, (now - haul.at) / ms);
    /** a fresh bite still quivers a moment, then the line is taut */
    const quiver = (since: number) => 0.35 * Math.exp(-(now - since) / 180);

    if (haul.phase === 'miss') {
      // shoots out, hangs there a moment (still quivering), then winds back in
      const ms = now - haul.at;
      const out = ms < HAUL_MISS_OUT_MS ? ms / HAUL_MISS_OUT_MS
        : ms < HAUL_MISS_OUT_MS + HAUL_MISS_HOLD_MS ? 1
        : Math.max(0, 1 - (ms - HAUL_MISS_OUT_MS - HAUL_MISS_HOLD_MS) / HAUL_MISS_BACK_MS);
      const wave = ms < HAUL_MISS_OUT_MS ? 1 : 0.5;
      layer?.setCable({ position: mix(nose, haul.from, out), up: 0.9 + (haul.fromUp - 0.9) * out, wave });
      if (ms >= HAUL_MISS_OUT_MS + HAUL_MISS_HOLD_MS + HAUL_MISS_BACK_MS) { layer?.setCable(null); this.haul = null; }
      return;
    }

    if (haul.kind === 'train') { this.updateTow(haul, now, nose); return; }
    if (haul.kind === 'coins') {
      // out to them, then straight back in with them hanging on (no click needed)
      if (haul.phase === 'fly') {
        const t = k(HAUL_FLY_MS);
        layer?.setCable({ position: mix(nose, haul.from, t), up: 0.9 + (haul.fromUp - 0.9) * t, wave: 1 });
        if (t >= 1) { haul.phase = 'pull'; haul.at = now; }
        return;
      }
      const t = ease(k(HAUL_COINS_MS));
      const here = this.vehicle.position as Position;
      for (const coin of haul.coins ?? []) {
        const pickup = this.pickups.get(coin.id);
        if (!pickup) continue;
        const at = mix(coin.start, here, t);
        pickup.position = at;
        layer?.movePickup(coin.id, at);
      }
      layer?.setCable(t < 0.95 ? { position: mix(haul.from, here, t), up: haul.fromUp + (0.9 - haul.fromUp) * t, wave: 0 } : null);
      // in reach of the car now: the next step picks them up as if we drove over them
      if (t >= 1) this.haul = null;
      return;
    }

    if (haul.kind === 'wall') {
      const hookUp = (haul.hookAlt ?? this.altitude) - this.altitude;
      if (haul.phase === 'fly') {
        const t = k(HAUL_FLY_MS);
        layer?.setCable({ position: mix(nose, haul.from, t), up: 0.9 + (hookUp - 0.9) * t, wave: 1 });
        if (t >= 1) { haul.phase = 'anchored'; haul.at = now; }
        return;
      }
      layer?.setCable({ position: haul.from, up: hookUp, wave: haul.phase === 'anchored' ? quiver(haul.at) : 0 });
      if (haul.phase === 'anchored') {
        if (metersBetween(this.vehicle.position, haul.from) > HAUL_SNAP_M) { this.haul = null; layer?.setCable(null); }
        return;
      }
      // reel: up to just under the hook, a step out from the wall, and hang there
      const self = haul.self ?? this.vehicle.position;
      const away = metersBetween(self, haul.from) || 1;
      const toWall = Math.atan2((haul.from[0] - self[0]) * Math.cos(self[1] * Math.PI / 180), haul.from[1] - self[1]);
      // whichever face of the car needs the least turn goes to the wall: nose, tail or a side;
      // it stands that face's half size (plus a little) off the hook
      const off = (a: number) => Math.abs(Math.atan2(Math.sin(a - haul.fromHeading), Math.cos(a - haul.fromHeading)));
      const faces = [
        { heading: toWall, gap: this.car.length / 2 + 0.5 },
        { heading: toWall + Math.PI, gap: this.car.length / 2 + 0.5 },
        { heading: toWall + Math.PI / 2, gap: 1.4 },
        { heading: toWall - Math.PI / 2, gap: 1.4 },
      ];
      const face = faces.reduce((a, b) => (off(b.heading) < off(a.heading) ? b : a));
      const out = Math.min(1, face.gap / away);
      const spot: Position = [haul.from[0] + (self[0] - haul.from[0]) * out, haul.from[1] + (self[1] - haul.from[1]) * out];
      const hangAlt = Math.max(this.map.groundAt(spot) ?? -Infinity, (haul.hookAlt ?? this.altitude) - 1.9);
      const t = haul.phase === 'reel' ? ease(k(HAUL_REEL_MS)) : 1;
      this.vehicle.position = mix(self, spot, t);
      this.vehicle.heading = turn(haul.fromHeading, face.heading, t);
      this.vehicle.speed = 0;
      this.hangAltitude = (haul.selfAlt ?? this.altitude) + (hangAlt - (haul.selfAlt ?? this.altitude)) * t;
      this.renderVehicle.reset(this.vehicle);
      if (haul.phase === 'reel' && t >= 1) haul.phase = 'hang';
      return;
    }

    // a car on the cable: shot to pieces or gone, it lets go
    if ((layer && !layer.isTargetAlive(haul.id)) || !this.haulCandidates().some(c => c.id === haul.id)) {
      this.releaseHaul(null);
      return;
    }
    const deck = along(-this.car.length * HAUL_DECK_BACK);
    const deckUp = this.car.length * HAUL_DECK_UP;
    const groundUp = (at: Position) => (this.map.groundAt(at) ?? this.altitude) - this.altitude;
    let position: Position, up: number, facing: number;
    let heldSpeed = 0;
    if (haul.phase === 'fly' || haul.phase === 'hooked') {
      // follow the live car while the hook flies / holds (moving targets included)
      const live = this.haulTarget(haul.id);
      if (live) {
        haul.from = [...live.position] as Position;
        haul.fromHeading = live.heading;
        haul.fromUp = groundUp(live.position);
        heldSpeed = live.speed;
      }
      position = haul.from; up = haul.fromUp; facing = haul.fromHeading;
      if (haul.phase === 'fly') {
        const t = k(HAUL_FLY_MS);
        layer?.setCable({ position: mix(nose, haul.from, t), up: 0.9 + (haul.fromUp + 0.8 - 0.9) * t, wave: 1 });
        if (t >= 1) { haul.phase = 'hooked'; haul.at = now; haul.tautAt = undefined; haul.dragAt = now; }
      } else {
        // hooked: winch vs car speed along the rope
        const dt = Math.min(0.05, (now - (haul.dragAt ?? now)) / 1000);
        haul.dragAt = now;
        const lat = nose[1] * Math.PI / 180;
        const kx = METERS_PER_DEGREE * Math.cos(lat), ky = METERS_PER_DEGREE;
        let de = (position[0] - nose[0]) * kx, dn = (position[1] - nose[1]) * ky;
        let dist = Math.hypot(de, dn) || 0.01;
        const ue = de / dist, un = dn / dist; // nose → car
        const carSpeed = live?.speed ?? 0;
        const carVe = Math.sin(facing) * carSpeed, carVn = Math.cos(facing) * carSpeed;
        const haulVe = Math.sin(heading) * this.vehicle.speed, haulVn = Math.cos(heading) * this.vehicle.speed;
        // +sep = car fleeing along the rope (against the winch)
        const sep = (carVe - haulVe) * ue + (carVn - haulVn) * un;
        heldSpeed = carSpeed;
        if (sep > HAUL_WINCH_MS) {
          // car wins: keep its motion, rope stretches toward max reach
          if (dt > 0) {
            position = offsetPosition(position, carVe * dt, carVn * dt) as Position;
            de = (position[0] - nose[0]) * kx; dn = (position[1] - nose[1]) * ky;
            dist = Math.hypot(de, dn) || 0.01;
          }
          if (dist >= HAUL_REACH_M) {
            const scale = HAUL_REACH_M / dist;
            position = [nose[0] + (position[0] - nose[0]) * scale, nose[1] + (position[1] - nose[1]) * scale] as Position;
            dist = HAUL_REACH_M;
            if (haul.tautAt == null) haul.tautAt = now;
            else if (now - haul.tautAt >= HAUL_TAUT_MS) {
              this.say(t('haul.snap'), true);
              this.releaseHaul({ position, heading: facing });
              return;
            }
          } else {
            haul.tautAt = undefined;
          }
        } else {
          // winch wins: reel the car in; clear stretch timer
          haul.tautAt = undefined;
          const close = (HAUL_WINCH_MS - Math.max(0, sep)) * dt;
          const newDist = Math.max(0.5, dist - close);
          position = [nose[0] + ue * newDist / kx, nose[1] + un * newDist / ky] as Position;
          dist = newDist;
          heldSpeed = carSpeed * Math.exp(-dt * 2.2);
          if (dist <= HAUL_LOAD_M) {
            haul.from = position;
            haul.fromHeading = facing;
            haul.fromUp = groundUp(position);
            haul.phase = 'pull';
            haul.at = now;
            heldSpeed = 0;
          }
        }
        up = groundUp(position);
        haul.from = position;
        haul.fromHeading = facing;
        haul.fromUp = up;
        const taut = haul.tautAt != null;
        layer?.setCable({
          position,
          up: up + 0.8,
          wave: taut ? 0.2 : quiver(haul.at),
        });
        // absolute fail-safe if somehow beyond snap range
        if (dist > HAUL_SNAP_M) {
          this.say(t('haul.snap'), true);
          this.releaseHaul({ position, heading: facing });
          return;
        }
      }
    } else if (haul.phase === 'pull') {
      // yanked: a quick high arc, landing square on the deck
      const t = ease(k(HAUL_PULL_MS));
      position = mix(haul.from, deck, t);
      up = haul.fromUp + (deckUp - haul.fromUp) * t + Math.sin(Math.PI * t) * 2.4;
      facing = turn(haul.fromHeading, heading, t);
      layer?.setCable(t < 0.9 ? { position, up: up + 0.8 } : null);
      if (t >= 1) haul.phase = 'carry';
    } else if (haul.phase === 'carry') {
      position = deck; up = deckUp; facing = heading;
    } else {
      // slides off backwards and drops onto the road behind us
      const t = k(HAUL_DROP_MS);
      const end = along(-(this.car.length / 2 + haul.car.length / 2 + 0.6));
      const endUp = (this.map.groundAt(end) ?? this.altitude) - this.altitude;
      position = mix(deck, end, ease(t));
      up = deckUp + (endUp - deckUp) * t * t;
      facing = heading;
      if (t >= 1) { this.releaseHaul({ position: end, heading }); return; }
    }
    this.placeHauled(haul, position, facing, heldSpeed);
    // on the bed: tilted a little nose down (its tail would sink into the bed's raised back) and with the truck
    const onBed = haul.phase === 'carry' ? 1 : haul.phase === 'pull' ? Math.min(1, (now - haul.at) / HAUL_PULL_MS) : haul.phase === 'drop' ? 1 - Math.min(1, (now - haul.at) / HAUL_DROP_MS) : 0;
    layer?.setCarried({ id: haul.id, position, heading: facing, up: up + 0.08 * onBed, pitch: (this.modelPitch - HAUL_TILT) * onBed });
  }

  /** The catch's place in the world (so it bumps, is shot at and is seen by others where it is). */
  private placeHauled(haul: NonNullable<GameEngine['haul']>, position: Position, heading: number, speed = 0) {
    if (haul.kind === 'wall') return;
    if (haul.kind === 'shared') { this.sharedTraffic.place(haul.id, position, heading, speed); return; }
    const bot = this.trafficBots.find(entry => entry.id === haul.id);
    if (!bot) return;
    bot.controller.position = [...position] as Position;
    bot.controller.heading = heading;
    bot.controller.speed = speed;
    bot.position = [...position] as Position;
    bot.heading = heading;
  }

  /** Let the catch go, standing at `at` (or where it is), finding its way again from there. */
  private releaseHaul(at: { position: Position; heading: number } | null) {
    const haul = this.haul;
    this.haul = null;
    this.combatLayer?.setCable(null);
    this.combatLayer?.setCarried(null);
    // off a wall: fall from where we hang; off a train: roll on
    if (this.hangAltitude != null) { this.hangAltitude = null; this.airborne = true; this.climb = 0; }
    if (this.towed) { this.towed = false; this.towClock = 0; this.towSpeed = 0; }
    if (!haul || !haul.id) return;
    if (at) this.placeHauled(haul, at.position, at.heading);
    if (haul.kind === 'shared') { this.sharedTraffic.hold(null); return; }
    const bot = this.trafficBots.find(entry => entry.id === haul.id);
    if (bot) { bot.route = []; bot.routeIndex = 1; bot.repathAt = 0; bot.lastRouteRevision = -1; }
  }

  /** Out of the Howler with a car on it: that car is gone with the truck. */
  private loseHaul() {
    const haul = this.haul;
    this.releaseHaul(null);
    if (!haul?.id) return;
    if (haul.kind === 'shared') this.sharedTraffic.drop(haul.id);
    else if (haul.kind === 'bot') {
      this.trafficBots = this.trafficBots.filter(bot => bot.id !== haul.id);
      this.combatLayer?.setTargets(this.targetVehicles());
    }
  }

  /** The language changed: labels made once (services, hubs, missions, pins, goals) are made again. */
  private relabel() {
    if (!this.ready) return;
    for (const marker of this.serviceMarkers.values()) marker.remove();
    this.serviceMarkers.clear();
    this.labelServices();
    for (const marker of this.hubMarkers.values()) marker.remove();
    this.hubMarkers.clear();
    this.collectHubs([]);
    for (const mission of this.missions) mission.label = t(`mission.${mission.kind}`, { n: mission.n });
    for (const marker of this.errandMarkers.values()) marker.remove();
    this.errandMarkers.clear();
    for (const tip of this.errandIndicators.values()) tip.element.remove();
    this.errandIndicators.clear();
    this.syncErrandMarkers();
    this.bountyMarker?.remove();
    this.bountyMarker = null;
    this.fireMarker?.remove();
    this.fireMarker = null;
    if (this.fireIndicator) this.fireIndicator.element.setAttribute('aria-label', t('fire.goal'));
    this.impoundMarker?.remove();
    this.impoundMarker = null;
    if (this.impoundIndicator) this.impoundIndicator.element.setAttribute('aria-label', t('impound.goal'));
    this.taxiMarker?.remove();
    this.taxiMarker = null;
    if (this.taxiIndicator) this.taxiIndicator.element.setAttribute('aria-label', t('taxi.goal'));
    this.busTourMarker?.remove();
    this.busTourMarker = null;
    if (this.busTourIndicator) this.busTourIndicator.element.setAttribute('aria-label', t('bus.tour'));
    this.raceGoalMarker?.remove();
    this.raceGoalMarker = null;
    this.raceGoalIndicator?.element.remove();
    this.raceGoalIndicator = null;
    this.ensureRaceGoalMarker();
    if (this.focusIndicator) this.focusIndicator.element.setAttribute('aria-label', t('marker.target'));
    this.selfMarker?.getElement().setAttribute('aria-label', t('you'));
    for (const pin of this.customPins) {
      const text = t('marker.pin');
      const span = pin.marker.getElement()?.querySelector('.map-pin-label');
      if (span) span.textContent = text;
      pin.marker.getElement()?.setAttribute('aria-label', text);
    }
    this.syncMissionVisuals();
    this.updateEventMarkers();
  }

  /**
   * Map label. With `tip` (default): text + range + same-size triangle as the offscreen arrow.
   * Without tip: plain plaque (travel hubs / services).
   */
  private makeMapLabel(
    className: string,
    text: string,
    label: string,
    colors?: { main: string; soft: string },
    tip = true,
  ) {
    const element = document.createElement('div');
    element.className = tip ? `map-pin ${className}` : className;
    element.setAttribute('aria-label', label);
    if (colors) {
      element.style.setProperty('--mission-color', colors.main);
      element.style.setProperty('--mission-soft', colors.soft);
      element.style.setProperty('--pin-color', colors.main);
      element.style.setProperty('--pin-soft', colors.soft);
    }
    const title = document.createElement('span');
    if (tip) title.className = 'map-pin-label';
    title.textContent = text;
    element.append(title);
    if (tip) {
      const distance = document.createElement('span');
      distance.className = 'map-pin-distance';
      distance.setAttribute('aria-hidden', 'true');
      element.append(distance);
      const arrow = document.createElement('span');
      arrow.className = 'map-pin-tip';
      arrow.setAttribute('aria-hidden', 'true');
      element.append(arrow);
    }
    return element;
  }

  /** Live range on a map pin while driving; blank on the M map (plaque only). */
  private setMapPinRange(marker: MapMarker | null | undefined, target: [number, number] | null, show: boolean) {
    const el = marker?.getElement()?.querySelector('.map-pin-distance');
    if (!(el instanceof HTMLElement)) return;
    if (!show || !target || this.mapInspecting()) {
      el.textContent = '';
      return;
    }
    el.textContent = formatRange(metersBetween(this.vehicle.position, target));
  }

  private mapLabelColors(kind: keyof typeof MISSION_COLORS) {
    return MISSION_COLORS[kind];
  }

  private paintMissionIndicator(element: HTMLElement, kind: keyof typeof MISSION_COLORS) {
    const colors = MISSION_COLORS[kind];
    element.style.setProperty('--mission-color', colors.main);
    element.style.setProperty('--mission-soft', colors.soft);
  }

  private makeOffscreenIndicator(kind: 'focus' | 'finish', titleText: string) {
    const element = document.createElement('div');
    element.className = `mission-indicator ${kind === 'focus' ? 'mission-focus-indicator' : 'race-finish-indicator'}`;
    this.paintMissionIndicator(element, kind === 'finish' ? 'finish' : 'arena');
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

  private nextCustomPinColor() {
    const used = new Set(this.customPins.map(pin => pin.color.main));
    return CUSTOM_PIN_COLORS.find(color => !used.has(color.main)) ?? null;
  }

  private placeCustomPin(position: [number, number]) {
    if (this.customPins.length >= CUSTOM_PIN_COLORS.length) return;
    const color = this.nextCustomPinColor();
    if (!color) return;
    if (!this.eventIndicatorLayer) {
      this.eventIndicatorLayer = document.createElement('div');
      this.eventIndicatorLayer.className = 'mission-indicators';
      this.host.appendChild(this.eventIndicatorLayer);
    }
    const id = `pin-${++this.customPinSeq}`;
    const label = t('marker.pin');
    const element = this.makeMapLabel('custom-map-marker', label, label, { main: color.main, soft: color.soft });
    element.style.pointerEvents = 'auto';
    const marker = this.marker({ element, anchor: 'bottom' }).setLngLat(position).addTo(this.map);
    const indicator = this.makeOffscreenIndicator('focus', label);
    indicator.element.classList.replace('mission-focus-indicator', 'custom-pin-indicator');
    indicator.element.style.setProperty('--pin-color', color.main);
    indicator.element.style.setProperty('--pin-soft', color.soft);
    indicator.element.style.setProperty('--mission-color', color.main);
    indicator.element.style.setProperty('--mission-soft', color.soft);
    this.eventIndicatorLayer.appendChild(indicator.element);
    const pin = { id, position: [...position] as [number, number], color, marker, indicator };
    this.customPins.push(pin);
    this.bindCustomPinDrag(pin, element);
    this.syncMissionVisuals();
  }

  /** Drag moves the pin; a short click without drag removes it. */
  private bindCustomPinDrag(
    pin: { id: string; position: [number, number]; marker: MapMarker },
    element: HTMLElement,
  ) {
    let drag: { pointerId: number; x: number; y: number; moved: boolean } | null = null;
    const pointOnMap = (e: PointerEvent): [number, number] => {
      const rect = this.map.getCanvas().getBoundingClientRect();
      const hit = this.map.unproject({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      return [hit.lng, hit.lat];
    };
    element.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.mapInspecting()) return;
      e.stopPropagation();
      e.preventDefault();
      drag = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
      element.classList.add('is-dragging');
      try { element.setPointerCapture(e.pointerId); } catch { /* older engines */ }
    });
    element.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) drag.moved = true;
      if (!drag.moved) return;
      const next = pointOnMap(e);
      pin.position[0] = next[0];
      pin.position[1] = next[1];
      pin.marker.setLngLat(next);
      this.syncMissionVisuals();
    });
    const endDrag = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const moved = drag.moved;
      drag = null;
      element.classList.remove('is-dragging');
      try { element.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      if (!moved) this.removeCustomPin(pin.id);
      else this.syncMissionVisuals();
    };
    element.addEventListener('pointerup', endDrag);
    element.addEventListener('pointercancel', endDrag);
  }

  private removeCustomPin(id: string) {
    const index = this.customPins.findIndex(pin => pin.id === id);
    if (index < 0) return;
    const [pin] = this.customPins.splice(index, 1);
    pin.marker.remove();
    pin.indicator.element.remove();
    this.syncMissionVisuals();
  }

  private clearCustomPins() {
    if (!this.customPins.length) return;
    for (const pin of this.customPins) {
      pin.marker.remove();
      pin.indicator.element.remove();
    }
    this.customPins = [];
    this.syncMissionVisuals();
  }

  private syncCustomPinPointers() {
    const on = this.mapInspecting();
    for (const pin of this.customPins) {
      const el = pin.marker.getElement();
      if (el) el.style.pointerEvents = on ? 'auto' : 'none';
    }
  }

  private ensureEventMarkers() {
    if (!this.eventIndicatorLayer) {
      this.eventIndicatorLayer = document.createElement('div');
      this.eventIndicatorLayer.className = 'mission-indicators';
      this.host.appendChild(this.eventIndicatorLayer);
    }
    // Pull any beacon that landed in the sea back onto a dry road.
    if (this.driving && this.cachedWater.length) {
      const here = this.vehicle.position as [number, number];
      for (const mission of this.missions) {
        if (!this.water.inSea(mission.position, this.cachedWater)) continue;
        const next = this.pickBeaconSpot(here, this.vehicle.heading, Math.round(mission.position[0] * 1e5), [
          ...this.missions.filter((m) => m.id !== mission.id).map((m) => m.position),
        ]);
        mission.position = next;
        this.missionMarkers.get(mission.id)?.remove();
        this.missionMarkers.delete(mission.id);
      }
    }
    const roaming = this.mode === 'roam' && this.driving && !this.onMission();
    const active = new Set(this.missions.map(mission => mission.id));
    for (const [id, marker] of this.missionMarkers) {
      if (active.has(id)) continue;
      marker.remove();
      this.missionMarkers.delete(id);
    }
    for (const mission of this.missions) {
      let marker = this.missionMarkers.get(mission.id);
      if (!marker) {
        const className = `${mission.kind}-map-marker`;
        const colors = this.mapLabelColors(mission.kind);
        marker = this.marker({ element: this.makeMapLabel(className, mission.label, mission.label, colors), anchor: 'bottom' })
          .setLngLat(mission.position)
          .addTo(this.map);
        this.missionMarkers.set(mission.id, marker);
      } else {
        marker.setLngLat(mission.position);
        const el = marker.getElement();
        const label = el?.querySelector('.map-pin-label');
        if (label) label.textContent = mission.label;
        const colors = this.mapLabelColors(mission.kind);
        el?.style.setProperty('--mission-color', colors.main);
        el?.style.setProperty('--mission-soft', colors.soft);
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
      this.raceGoalMarker = this.marker({
        element: this.makeMapLabel('race-finish-marker', t('marker.finish'), t('marker.finishRace'), MISSION_COLORS.finish),
        anchor: 'bottom',
      })
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
    // edge arrow only off-frame; in frame placeIndicator hides the HUD (map pin owns it)
    this.placeTargetIndicator(marker, target, Number.POSITIVE_INFINITY);
  }

  /** Spawn a local wanted pin now and then; take the job and hunt within 10 km. Police cars only. */
  private updateBounty() {
    if (!this.canHuntBounty()) return;
    const now = performance.now();
    const here = this.vehicle.position;
    if (this.bountyPending && !this.bounty) {
      if (this.mode !== 'roam' || this.bountyFight || this.errand || this.fire.active) return;
      if (
        this.bountyPickup
        && !this.bountyOfferShown
        && !this.eventOffer
        && !this.travelOpen
        && !this.serviceOpen
        && !this.dealerOpen
        && !this.fuelOut
        && now > this.bountyApproachCooldown
        && metersBetween(here, this.bountyPickup) <= MISSION_PICKUP_M
      ) {
        this.bountyOfferShown = true;
        this.onBountyOffer(this.bountyOfferOf(this.bountyPending));
      }
      return;
    }
    if (!this.bounty) {
      const busy = this.mode !== 'roam' || this.errand || this.bountyPending || this.eventOffer || this.travelOpen || this.serviceOpen || this.dealerOpen || this.fuelOut || this.fire.active || this.impoundActive || this.taxi.active || this.busTour.active;
      if (busy || now < this.bountyOfferAt) return;
      const seed = Math.round(here[0] * 1e5) ^ Math.round(here[1] * 1e5) ^ (now | 0);
      const avoid = this.missions.map(mission => mission.position);
      this.bountyPickup = this.pickBeaconSpot(
        here as [number, number],
        this.vehicle.heading,
        seed,
        avoid,
      );
      // Fight spot farther out, but never beyond 10 km.
      const huntSpot = this.pickBeaconSpot(
        here as [number, number],
        this.vehicle.heading,
        seed + 31,
        [...avoid, this.bountyPickup],
        { min: 2500, max: BOUNTY_RANGE_KM * 1000 },
      );
      this.bountyPending = makeBounty(
        here,
        huntSpot,
        { name: this.city.name, country: this.city.country, coords: this.city.coords },
        ((seed >>> 0) % 1_000_000) / 1_000_000,
      );
      this.bountyOfferShown = false;
      this.syncMissionVisuals(true);
      this.say(t('mission.new', { label: t('bounty.goal') }), true);
      return;
    }
    const bounty = this.bounty;
    if (this.bountyFight || this.mode !== 'roam') return;
    // Old saves without a spot: pin one nearby once roads are loaded.
    if (!bounty.spot && kilometres(here, bounty.place.coords) <= BOUNTY_RANGE_KM) {
      const node = this.trafficNetwork.nearest(bounty.place.coords, new Set(), 0, BOUNTY_RANGE_KM * 1000);
      if (node) {
        bounty.spot = [...node.position] as [number, number];
        saveBounty(bounty);
        this.syncMissionVisuals(true);
      }
    }
    if (bounty.spot && now > this.bountyRetryAt && metersBetween(here, bounty.spot) < 650) this.startBountyFight(bounty);
  }

  private bountyOfferOf(bounty: Bounty): BountyOffer {
    const target = bounty.spot ?? bounty.place.coords;
    return {
      name: bounty.name,
      car: carsConfig.find((car) => car.id === bounty.car)?.name ?? '',
      place: bounty.place.name,
      country: bounty.place.country,
      km: Math.max(1, Math.round(kilometres(this.vehicle.position, target))),
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
    const bountyIndex = goals.findIndex(goal => goal.id === 'role-bounty');
    if (bountyIndex >= 0) this.missionFocus = bountyIndex;
    const target = this.bounty.spot ?? this.bounty.place.coords;
    const km = Math.max(1, Math.round(kilometres(this.vehicle.position, target)));
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
      this.onEventResult({ kind: 'bounty', won: true, cash: bounty.reward, name: bounty.name });
      this.bounty = null;
      saveBounty(null);
      this.bountyOfferAt = performance.now() + 60000;
    } else {
      this.say(t('bounty.escaped', { name: bounty?.name ?? '' }), true);
      this.onEventResult({ kind: 'bounty', won: false, name: bounty?.name ?? '' });
      this.bountyRetryAt = performance.now() + 20000;
    }
  }

  private fireWorld(): FireCallWorld {
    const avoid = this.missions.map((mission) => mission.position);
    if (this.bountyPickup) avoid.push(this.bountyPickup);
    return {
      position: this.vehicle.position,
      heading: this.vehicle.heading,
      mode: this.mode,
      busy: Boolean(this.eventOffer || this.travelOpen || this.serviceOpen || this.dealerOpen || this.fuelOut),
      bountyFight: this.bountyFight,
      errand: Boolean(this.errand),
      onMission: this.onMission(),
      avoid,
      fireFacadesNear: (at, radius) => this.map.fireFacadesNear(at, radius),
      pickBeaconSpot: (here, heading, seed, spots) => this.pickBeaconSpot(here, heading, seed, spots),
      setFireHouse: (site) => this.combatLayer?.setFireHouse(site),
      syncMissionVisuals: (show) => this.syncMissionVisuals(show),
      say: (text, toast) => this.say(text, toast),
      addMoney: (amount) => { this.playerMoney += amount; },
      onResult: (cash, windows) => this.onEventResult({ kind: 'fire', won: true, cash, name: String(windows) }),
    };
  }

  /** Fire truck: a house is already burning when the call appears — drive over and hose the windows. */
  private updateFire() {
    if (!this.isFireTruck()) return;
    updateFireCall(this.fire, this.fireWorld());
  }

  private startFire() {
    startFireCall(this.fire, this.fireWorld());
  }

  private onFireWindowOut(left: number) {
    noteFireWindowOut(this.fire, this.fireWorld(), left);
  }

  private completeFire(windows: number) {
    completeFireCall(this.fire, this.fireWorld(), windows);
  }

  /** Leave a fire call when swapping off the truck (progress is lost). */
  private suspendFire() {
    suspendFireCall(this.fire, this.fireWorld());
  }

  private taxiWorld(): TaxiFareWorld {
    const avoid = this.missions.map((mission) => mission.position);
    if (this.bountyPickup) avoid.push(this.bountyPickup);
    if (this.fire.pickup) avoid.push(this.fire.pickup);
    if (this.impoundPickup) avoid.push(this.impoundPickup);
    return {
      position: this.vehicle.position,
      heading: this.vehicle.heading,
      mode: this.mode,
      busy: Boolean(this.eventOffer || this.travelOpen || this.serviceOpen || this.dealerOpen || this.fuelOut || this.taxi.pending || this.busTour.pending),
      bountyFight: this.bountyFight,
      errand: Boolean(this.errand),
      onMission: this.onMission(),
      avoid,
      pickBeaconSpot: (here, heading, seed, spots) => this.pickBeaconSpot(here, heading, seed, spots),
      pickDropoff: (from, minM, maxM, seed) =>
        this.trafficNetwork.randomAway(from, new Set(), minM, maxM, seed)?.position ?? null,
      syncMissionVisuals: (show) => this.syncMissionVisuals(show),
      say: (text, toast) => this.say(text, toast),
      addMoney: (amount) => { this.playerMoney += amount; },
      onOffer: (offer) => this.onRideOffer(offer),
      onResult: (cash, km) => this.onEventResult({ kind: 'taxi', won: true, cash, name: String(km) }),
    };
  }

  private updateTaxi() {
    if (!this.isTaxi()) return;
    updateTaxiFare(this.taxi, this.taxiWorld());
  }

  /** Leave a fare when swapping off the taxi (progress is lost). */
  private suspendTaxi() {
    suspendTaxiFare(this.taxi, this.taxiWorld());
  }

  acceptRide() {
    if (this.taxi.pending) acceptTaxiFare(this.taxi, this.taxiWorld());
    else if (this.ambulance.pending) acceptAmbulanceCall(this.ambulance, this.ambulanceWorld());
    else if (this.busTour.pending) acceptBusTour(this.busTour, this.busTourWorld());
  }

  declineRide() {
    if (this.taxi.pending) declineTaxiFare(this.taxi, this.taxiWorld());
    else if (this.ambulance.pending) declineAmbulanceCall(this.ambulance, this.ambulanceWorld());
    else if (this.busTour.pending) declineBusTour(this.busTour, this.busTourWorld());
  }

  private ambulanceWorld(): AmbulanceCallWorld {
    const avoid = this.missions.map((mission) => mission.position);
    if (this.bountyPickup) avoid.push(this.bountyPickup);
    if (this.fire.pickup) avoid.push(this.fire.pickup);
    if (this.impoundPickup) avoid.push(this.impoundPickup);
    if (this.taxi.pickup) avoid.push(this.taxi.pickup);
    return {
      position: this.vehicle.position,
      heading: this.vehicle.heading,
      mode: this.mode,
      busy: Boolean(this.eventOffer || this.travelOpen || this.serviceOpen || this.dealerOpen || this.fuelOut || this.taxi.pending || this.busTour.pending || this.ambulance.pending),
      bountyFight: this.bountyFight,
      errand: Boolean(this.errand),
      onMission: this.onMission(),
      avoid,
      pickBeaconSpot: (here, heading, seed, spots) => this.pickBeaconSpot(here, heading, seed, spots),
      nearestHospital: (from) => {
        // Victim calls need a hospital within 10 km. Prefer a 2–8 km drive when
        // one exists; otherwise the nearest inside 10 km (even if closer).
        const PREFER_MIN = 2000;
        const PREFER_MAX = 8000;
        const REACH = 10000;
        const list = [...this.civics.values()].filter((s) => s.kind === 'hospital');
        if (!list.length) return null;
        let band: Position | null = null;
        let bandD = Infinity;
        let near: Position | null = null;
        let nearD = Infinity;
        for (const s of list) {
          const at = (s.place ?? s.position) as Position;
          const d = metersBetween(from, at);
          if (d > REACH) continue;
          if (d < nearD) { nearD = d; near = at; }
          if (d >= PREFER_MIN && d <= PREFER_MAX && d < bandD) { bandD = d; band = at; }
        }
        return band ?? near;
      },
      setScene: (kind, at) => this.setAmbulanceScene(kind, at),
      syncMissionVisuals: (show) => this.syncMissionVisuals(show),
      say: (text, toast) => this.say(text, toast),
      addMoney: (amount) => { this.playerMoney += amount; },
      onOffer: (offer) => this.onRideOffer(offer),
      onResult: (cash, victims) => this.onEventResult({ kind: 'ambulance', won: true, cash, name: String(victims) }),
    };
  }

  /**
   * `burn` — house windows on fire only (separate call type).
   * `crash` — 1–2 wrecks: roadside (often overturned), or nosed into a house with the
   * car on fire (house itself is not burning). Clear with null.
   */
  private setAmbulanceScene(kind: AmbulanceSite | null, at: Position | null): { site: AmbulanceSite; cars: number } | null {
    this.trafficBots = this.trafficBots.filter((b) => !isAmbulanceWreckId(b.id));
    // clear smolder unless the fire truck owns a live call
    if (!this.fire.active) this.combatLayer?.setFireHouse(null);
    if (!kind || !at) {
      this.combatLayer?.setTargets(this.targetVehicles());
      return null;
    }
    if (kind === 'burn') {
      // cap pane scan — London blocks otherwise build thousands of windows in one hitch
      const facades = this.map.fireFacadesNear(at, 55, 24);
      if (facades?.panes.length && !this.fire.active) {
        const n = Math.min(facades.panes.length, 4 + (Math.abs(Math.round(at[0] * 1e4)) % 5));
        const panes = facades.panes.slice(0, n).map((p) => ({
          at: p.at as [number, number],
          altitude: p.altitude,
          oe: p.oe,
          on: p.on,
        }));
        this.combatLayer?.setFireHouse({ panes, available: Math.max(facades.panes.length, n) });
        this.combatLayer?.setTargets(this.targetVehicles());
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
    this.combatLayer?.setTargets(this.targetVehicles());
    for (const { bot, overturned, burning } of bots) {
      this.combatLayer?.plantPropWreck(bot.id, { overturned, burning });
    }
    return { site: 'crash', cars };
  }

  private updateAmbulance() {
    if (!this.isAmbulance()) return;
    // keep crash wrecks planted (same as the impound wait car)
    if (this.ambulance.pickup && this.ambulance.cars > 0) {
      for (const wreck of this.trafficBots) {
        if (!isAmbulanceWreckId(wreck.id)) continue;
        wreck.controller.speed = 0;
        wreck.route = [];
        wreck.goal = null;
        // leave each wreck on its own planted spot (controller.position)
        wreck.position = [...wreck.controller.position] as Position;
      }
    }
    // hospital drop only when nearly stopped
    if (this.ambulance.active && this.ambulance.goal
      && metersBetween(this.vehicle.position, this.ambulance.goal) <= AMBULANCE_HOSPITAL_M
      && Math.abs(this.vehicle.speed) > 7) return;
    updateAmbulanceCall(this.ambulance, this.ambulanceWorld());
  }

  private suspendAmbulance() {
    suspendAmbulanceCall(this.ambulance, this.ambulanceWorld());
  }

  private busWorld(): BusStopWorld {
    return {
      position: this.vehicle.position,
      mode: this.mode,
      busy: Boolean(this.eventOffer || this.travelOpen || this.serviceOpen || this.dealerOpen || this.fuelOut || this.busTour.active || this.busTour.pickup || this.busTour.pending || this.taxi.pending),
      stops: [...this.busStops.values()],
      say: (text, toast) => this.say(text, toast),
      addMoney: (amount) => { this.playerMoney += amount; },
      onResult: (cash, action, passengers) => this.onEventResult({ kind: 'bus', won: true, cash, name: `${action}:${passengers}` }),
    };
  }

  private busTourWorld(): BusTourWorld {
    const avoid = this.missions.map((mission) => mission.position);
    if (this.bountyPickup) avoid.push(this.bountyPickup);
    if (this.fire.pickup) avoid.push(this.fire.pickup);
    if (this.impoundPickup) avoid.push(this.impoundPickup);
    if (this.taxi.pickup) avoid.push(this.taxi.pickup);
    return {
      position: this.vehicle.position,
      heading: this.vehicle.heading,
      mode: this.mode,
      busy: Boolean(this.eventOffer || this.travelOpen || this.serviceOpen || this.dealerOpen || this.fuelOut || this.taxi.pending || this.busTour.pending),
      bountyFight: this.bountyFight,
      errand: Boolean(this.errand),
      onMission: this.onMission(),
      avoid,
      landmarks: [...this.landmarks.values()],
      pickBeaconSpot: (here, heading, seed, spots) => this.pickBeaconSpot(here, heading, seed, spots),
      syncMissionVisuals: (show) => this.syncMissionVisuals(show),
      say: (text, toast) => this.say(text, toast),
      addMoney: (amount) => { this.playerMoney += amount; },
      onOffer: (offer) => this.onRideOffer(offer),
      onResult: (cash, passengers, kind, place) =>
        this.onEventResult({ kind: 'bus', won: true, cash, name: `tour:${kind}:${passengers}:${place}` }),
    };
  }

  private updateBus() {
    if (!this.isBus()) {
      this.bus.at = null;
      return;
    }
    updateBusTour(this.busTour, this.busTourWorld());
    updateBusStops(this.bus, this.busWorld());
  }

  private suspendBusTour() {
    suspendBusTour(this.busTour, this.busTourWorld());
  }

  /** Nearest police station pin while hauling the impound car (any station counts). */
  private impoundDropPin(): [number, number] | null {
    if (!this.carryingImpound()) return null;
    const list = [...this.civics.values()].filter((s) => s.kind === 'police');
    const near = nearestStation(this.vehicle.position, list);
    return near ? [...near.station.position] as [number, number] : null;
  }

  private carryingImpound() {
    const haul = this.haul;
    // only the car on the bed counts — empty visits to police do nothing
    return Boolean(this.impoundActive && haul && haul.id === TOW_CAR_ID && haul.phase === 'carry');
  }

  /** Howler: marker → load the car → deliver to any police station for a premium. */
  private updateImpound() {
    if (!this.isHauler()) return;
    const now = performance.now();
    const here = this.vehicle.position;
    if (this.impoundActive) {
      // car wrecked / gone: cancel and try again later
      if (!this.trafficBots.some((b) => b.id === TOW_CAR_ID) && this.haul?.id !== TOW_CAR_ID) {
        this.failImpound();
        return;
      }
      // keep the waiting car planted until the hook takes it
      const bot = this.trafficBots.find((b) => b.id === TOW_CAR_ID);
      if (bot && this.haul?.id !== TOW_CAR_ID && this.impoundSpot) {
        bot.controller.speed = 0;
        bot.controller.position = [...this.impoundSpot] as Position;
        bot.position = [...this.impoundSpot] as Position;
      }
      // only when the car is on the bed (or hooked/pulling) — empty visits to police do nothing
      if (this.carryingImpound() && now > this.impoundDeliveredAt) {
        const police = atStation(here, [...this.civics.values()].filter((s) => s.kind === 'police'), SERVICE_REACH.civic);
        if (police && Math.abs(this.vehicle.speed) < 7) this.completeImpound();
      }
      return;
    }
    if (this.impoundPickup) {
      if (this.mode === 'roam' && !this.bountyFight && !this.errand && !this.fire.active
        && metersBetween(here, this.impoundPickup) <= IMPOUND_ARRIVE_M) this.startImpound();
      return;
    }
    if (this.mode !== 'roam' || this.bountyFight || this.errand || this.onMission()) return;
    const busy = this.eventOffer || this.travelOpen || this.serviceOpen || this.dealerOpen || this.fuelOut;
    if (busy || now < this.impoundOfferAt) return;
    const seed = Math.round(here[0] * 1e5) ^ Math.round(here[1] * 1e5) ^ (now | 0);
    const avoid = this.missions.map((mission) => mission.position);
    if (this.bountyPickup) avoid.push(this.bountyPickup);
    if (this.fire.pickup) avoid.push(this.fire.pickup);
    if (this.taxi.pickup) avoid.push(this.taxi.pickup);
    this.impoundPickup = this.pickBeaconSpot(here as [number, number], this.vehicle.heading, seed ^ 0x70a1, avoid);
    this.syncMissionVisuals(true);
    this.say(t('mission.new', { label: t('impound.goal') }), true);
  }

  private startImpound() {
    if (!this.impoundPickup || this.impoundActive) return;
    this.impoundActive = true;
    this.impoundSpot = this.impoundPickup;
    this.impoundPickup = null;
    const heading = this.vehicle.heading;
    const seed = Math.round(this.impoundSpot[0] * 1e5) ^ Math.round(this.impoundSpot[1] * 1e5);
    const choices = carsConfig.filter((car) => car.id !== HAULER_ID && car.id !== FIRE_TRUCK_ID && car.id !== BUS_ID && !POLICE_IDS.has(car.id));
    const car = choices[Math.abs(seed) % choices.length] ?? carsConfig[0];
    // plant a still car exactly on the pin (createTrafficBot would wander off)
    const bot = createTrafficBot(TOW_CAR_ID, t('impound.driver'), car, this.trafficNetwork, this.impoundSpot, heading, new Set(), 'explore', seed, { min: 0, max: 40 });
    bot.controller.position = [...this.impoundSpot] as Position;
    bot.controller.heading = heading;
    bot.controller.speed = 0;
    bot.position = [...this.impoundSpot] as Position;
    bot.heading = heading;
    bot.route = [];
    bot.goal = null;
    this.trafficBots = [...this.trafficBots.filter((b) => b.id !== TOW_CAR_ID), bot];
    this.combatLayer?.setTargets(this.targetVehicles());
    this.syncMissionVisuals(true);
    this.say(t('impound.start', { car: car.name, reward: formatNumber(IMPOUND_REWARD) }), true);
  }

  private completeImpound() {
    if (!this.impoundActive) return;
    this.impoundActive = false;
    this.impoundSpot = null;
    this.impoundDeliveredAt = performance.now() + 2000;
    // take the car off the bed and scrap it at the station
    if (this.haul?.id === TOW_CAR_ID) this.loseHaul();
    else {
      this.trafficBots = this.trafficBots.filter((b) => b.id !== TOW_CAR_ID);
      this.combatLayer?.setTargets(this.targetVehicles());
    }
    this.playerMoney += IMPOUND_REWARD;
    this.impoundOfferAt = performance.now() + 50000;
    this.syncMissionVisuals(true);
    this.onEventResult({ kind: 'impound', won: true, cash: IMPOUND_REWARD });
  }

  private failImpound() {
    this.impoundActive = false;
    this.impoundSpot = null;
    this.trafficBots = this.trafficBots.filter((b) => b.id !== TOW_CAR_ID);
    this.combatLayer?.setTargets(this.targetVehicles());
    this.impoundOfferAt = performance.now() + 20000;
    this.syncMissionVisuals(true);
    this.say(t('impound.lost'), true);
  }

  private suspendImpound() {
    if (this.impoundActive) {
      if (this.haul?.id === TOW_CAR_ID) this.loseHaul();
      this.impoundActive = false;
      this.impoundSpot = null;
      this.trafficBots = this.trafficBots.filter((b) => b.id !== TOW_CAR_ID);
      this.combatLayer?.setTargets(this.targetVehicles());
      this.impoundOfferAt = performance.now() + 12000;
      this.say(t('impound.aborted'), true);
    }
    this.syncMissionVisuals(true);
  }

  /** Map pin for the hunt; HUD arrow only while the fight is on (focus list covers the rest). */
  private updateBountyMarkers() {
    const pending = Boolean(this.bountyPending && this.bountyPickup && !this.bounty);
    const bounty = this.bountyFight ? null : (this.bounty ?? this.bountyPending);
    if (!this.canHuntBounty() || !bounty || !this.driving || this.errand || (pending && !this.bountyPickup)) {
      if (!this.bountyFight && this.bountyIndicator) this.bountyIndicator.element.style.display = 'none';
      if (this.bountyMarker) { this.bountyMarker.remove(); this.bountyMarker = null; }
      if (!this.bountyFight) return;
    }
    const title = this.bountyFight
      ? t('bounty.marker', { name: (this.bounty ?? this.bountyPending)?.name ?? '' })
      : pending
        ? t('bounty.goal')
        : t('bounty.marker', { name: bounty!.name });
    const pin = pending ? this.bountyPickup : (bounty?.spot && !this.bountyFight ? bounty.spot : null);
    if (pin) {
      if (!this.bountyMarker) {
        this.bountyMarker = this.marker({ element: this.makeMapLabel('bounty-map-marker', title, title, MISSION_COLORS.bounty), anchor: 'bottom' }).setLngLat(pin).addTo(this.map);
      } else {
        this.bountyMarker.setLngLat(pin);
        const el = this.bountyMarker.getElement();
        const label = el?.querySelector('.map-pin-label');
        if (label) label.textContent = title;
        el?.style.setProperty('--mission-color', MISSION_COLORS.bounty.main);
        el?.style.setProperty('--mission-soft', MISSION_COLORS.bounty.soft);
      }
    } else if (this.bountyMarker) {
      this.bountyMarker.remove();
      this.bountyMarker = null;
    }
    // chase arrow only during the fight — pickup/spot live in the focus cycle
    if (!this.bountyFight) {
      if (this.bountyIndicator) this.bountyIndicator.element.style.display = 'none';
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
      this.paintMissionIndicator(this.bountyIndicator.element, 'bounty');
      this.eventIndicatorLayer.appendChild(this.bountyIndicator.element);
    }
    const bot = this.trafficBots[0];
    const near = bot?.position ?? null;
    const target = near ?? this.bounty?.spot ?? this.bounty?.place.coords ?? null;
    if (!target) {
      this.bountyIndicator.element.style.display = 'none';
      return;
    }
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

  /** Map label for the fire call; HUD tip comes from the focus cycle. */
  private updateFireMarkers() {
    if (this.fireIndicator) this.fireIndicator.element.style.display = 'none';
    const pin = this.fire.active ? this.fire.spot : this.fire.pickup;
    if (!this.isFireTruck() || !this.driving || !pin || this.errand || this.bountyFight) {
      if (this.fireMarker) { this.fireMarker.remove(); this.fireMarker = null; }
      return;
    }
    const title = this.fire.active ? t('fire.marker.active') : t('fire.marker');
    if (!this.fireMarker) {
      this.fireMarker = this.marker({ element: this.makeMapLabel('fire-map-marker', title, title, MISSION_COLORS.fire), anchor: 'bottom' }).setLngLat(pin).addTo(this.map);
    } else {
      this.fireMarker.setLngLat(pin);
      const el = this.fireMarker.getElement();
      const label = el?.querySelector('.map-pin-label');
      if (label) label.textContent = title;
      el?.style.setProperty('--mission-color', MISSION_COLORS.fire.main);
      el?.style.setProperty('--mission-soft', MISSION_COLORS.fire.soft);
    }
  }

  /** Map label for the Howler impound job; HUD tip comes from the focus cycle. */
  private updateImpoundMarkers() {
    if (this.impoundIndicator) this.impoundIndicator.element.style.display = 'none';
    const drop = this.impoundDropPin();
    const pin = this.impoundActive ? (drop ?? this.impoundSpot) : this.impoundPickup;
    if (!this.isHauler() || !this.driving || !pin || this.errand || this.bountyFight) {
      if (this.impoundMarker) { this.impoundMarker.remove(); this.impoundMarker = null; }
      return;
    }
    const title = drop ? t('impound.marker.drop') : this.impoundActive ? t('impound.marker.car') : t('impound.marker');
    if (!this.impoundMarker) {
      this.impoundMarker = this.marker({ element: this.makeMapLabel('impound-map-marker', title, title, MISSION_COLORS.impound), anchor: 'bottom' }).setLngLat(pin).addTo(this.map);
    } else {
      this.impoundMarker.setLngLat(pin);
      const el = this.impoundMarker.getElement();
      const label = el?.querySelector('.map-pin-label');
      if (label) label.textContent = title;
      el?.style.setProperty('--mission-color', MISSION_COLORS.impound.main);
      el?.style.setProperty('--mission-soft', MISSION_COLORS.impound.soft);
    }
  }

  /** Map label for the taxi fare; HUD tip comes from the focus cycle. */
  private updateTaxiMarkers() {
    if (this.taxiIndicator) this.taxiIndicator.element.style.display = 'none';
    const pin = this.taxi.active ? this.taxi.goal : this.taxi.pickup;
    if (!this.isTaxi() || !this.driving || !pin || this.errand || this.bountyFight) {
      if (this.taxiMarker) { this.taxiMarker.remove(); this.taxiMarker = null; }
      return;
    }
    const title = this.taxi.active ? t('taxi.marker.drop') : t('taxi.marker');
    if (!this.taxiMarker) {
      this.taxiMarker = this.marker({ element: this.makeMapLabel('taxi-map-marker', title, title, MISSION_COLORS.taxi), anchor: 'bottom' }).setLngLat(pin).addTo(this.map);
    } else {
      this.taxiMarker.setLngLat(pin);
      const el = this.taxiMarker.getElement();
      const label = el?.querySelector('.map-pin-label');
      if (label) label.textContent = title;
      el?.style.setProperty('--mission-color', MISSION_COLORS.taxi.main);
      el?.style.setProperty('--mission-soft', MISSION_COLORS.taxi.soft);
    }
  }

  /** Map label for the ambulance call; HUD tip comes from the focus cycle. */
  private updateAmbulanceMarkers() {
    if (this.ambulanceIndicator) this.ambulanceIndicator.element.style.display = 'none';
    const pin = this.ambulance.active ? this.ambulance.goal : this.ambulance.pickup;
    if (!this.isAmbulance() || !this.driving || !pin || this.errand || this.bountyFight) {
      if (this.ambulanceMarker) { this.ambulanceMarker.remove(); this.ambulanceMarker = null; }
      return;
    }
    const title = this.ambulance.active
      ? t('ambulance.marker.drop')
      : this.ambulance.site === 'burn' ? t('ambulance.marker.burn') : t('ambulance.marker.crash');
    if (!this.ambulanceMarker) {
      this.ambulanceMarker = this.marker({ element: this.makeMapLabel('ambulance-map-marker', title, title, MISSION_COLORS.ambulance), anchor: 'bottom' }).setLngLat(pin).addTo(this.map);
    } else {
      this.ambulanceMarker.setLngLat(pin);
      const el = this.ambulanceMarker.getElement();
      const label = el?.querySelector('.map-pin-label');
      if (label) label.textContent = title;
      el?.style.setProperty('--mission-color', MISSION_COLORS.ambulance.main);
      el?.style.setProperty('--mission-soft', MISSION_COLORS.ambulance.soft);
    }
  }

  /** Map label for the bus tour; HUD tip comes from the focus cycle. */
  private updateBusTourMarkers() {
    if (this.busTourIndicator) this.busTourIndicator.element.style.display = 'none';
    const pin = this.busTour.active ? this.busTour.goal : this.busTour.pickup;
    if (!this.isBus() || !this.driving || !pin || this.errand || this.bountyFight) {
      if (this.busTourMarker) { this.busTourMarker.remove(); this.busTourMarker = null; }
      return;
    }
    const title = this.busTour.active
      ? (this.busTour.place || t('bus.drop'))
      : t('bus.marker');
    if (!this.busTourMarker) {
      this.busTourMarker = this.marker({ element: this.makeMapLabel('bus-map-marker', title, title, MISSION_COLORS.bus), anchor: 'bottom' }).setLngLat(pin).addTo(this.map);
    } else {
      this.busTourMarker.setLngLat(pin);
      const el = this.busTourMarker.getElement();
      const label = el?.querySelector('.map-pin-label');
      if (label) label.textContent = title;
      el?.style.setProperty('--mission-color', MISSION_COLORS.bus.main);
      el?.style.setProperty('--mission-soft', MISSION_COLORS.bus.soft);
    }
  }

  private updateEventMarkers() {
    this.updateBountyMarkers();
    this.updateFireMarkers();
    this.updateImpoundMarkers();
    this.updateTaxiMarkers();
    this.updateAmbulanceMarkers();
    this.updateBusTourMarkers();
    const roaming = this.driving && this.mode === 'roam';
    const goals = this.focusGoals();
    // a new role mission on this car joins Tab and becomes the focused tip
    const roleGoal = goals.find((goal) => goal.role);
    const roleLatch = roleGoal
      ? `${roleGoal.id}:${roleGoal.position?.[0]?.toFixed(5) ?? ''},${roleGoal.position?.[1]?.toFixed(5) ?? ''}:${roleGoal.label}`
      : null;
    if (roleLatch && roleLatch !== this.focusGoalsLatch) {
      const index = goals.findIndex((goal) => goal.role);
      if (index >= 0) this.missionFocus = index;
    }
    this.focusGoalsLatch = roleLatch;
    if (this.missionFocus >= goals.length) this.missionFocus = Math.max(0, goals.length - 1);
    const focused = roaming ? goals[this.missionFocus] ?? null : null;
    if (!this.focusIndicator && roaming && focused) {
      this.focusIndicator = this.makeOffscreenIndicator('focus', t('marker.target'));
      if (!this.eventIndicatorLayer) {
        this.eventIndicatorLayer = document.createElement('div');
        this.eventIndicatorLayer.className = 'mission-indicators';
        this.host.appendChild(this.eventIndicatorLayer);
      }
      this.eventIndicatorLayer.appendChild(this.focusIndicator.element);
    }
    if (this.focusIndicator && focused) this.paintMissionIndicator(this.focusIndicator.element, focused.color);
    this.updateOffscreenMarker(
      this.focusIndicator,
      focused?.position ?? null,
      Boolean(roaming && focused?.position),
      focused?.label,
    );
    this.updateOffscreenMarker(this.raceGoalIndicator, this.raceGoal, this.driving && this.mode === 'race');
    const errandPins = this.errandPins();
    for (const pin of errandPins) {
      const tip = this.errandIndicators.get(pin.id);
      if (tip) this.paintMissionIndicator(tip.element, pin.kind);
      this.updateOffscreenMarker(tip ?? null, pin.position, this.driving, pin.label);
    }
    for (const [id, tip] of this.errandIndicators) {
      if (!errandPins.some((pin) => pin.id === id)) tip.element.style.display = 'none';
    }
    this.syncCustomPinPointers();
    for (const pin of this.customPins) {
      this.updateOffscreenMarker(pin.indicator, pin.position, this.driving, t('marker.pin'));
      this.setMapPinRange(pin.marker, pin.position, this.driving);
    }
    // map pins carry range while in view; edge HUD only when the goal is off-frame
    const pinRange = this.driving && !this.mapInspecting();
    for (const mission of this.missions) {
      this.setMapPinRange(this.missionMarkers.get(mission.id), mission.position, pinRange);
    }
    this.setMapPinRange(this.raceGoalMarker, this.raceGoal, pinRange && this.mode === 'race');
    this.setMapPinRange(this.bountyMarker, this.bountyPickup ?? this.bounty?.spot ?? null, pinRange && this.canHuntBounty());
    this.setMapPinRange(this.fireMarker, this.fire.active ? this.fire.spot : this.fire.pickup, pinRange && this.isFireTruck());
    this.setMapPinRange(
      this.impoundMarker,
      this.impoundActive ? (this.impoundDropPin() ?? this.impoundSpot) : this.impoundPickup,
      pinRange && this.isHauler(),
    );
    this.setMapPinRange(this.taxiMarker, this.taxi.active ? this.taxi.goal : this.taxi.pickup, pinRange && this.isTaxi());
    this.setMapPinRange(this.ambulanceMarker, this.ambulance.active ? this.ambulance.goal : this.ambulance.pickup, pinRange && this.isAmbulance());
    this.setMapPinRange(
      this.busTourMarker,
      this.busTour.active ? this.busTour.goal : this.busTour.pickup,
      pinRange && this.isBus(),
    );
    for (const pin of errandPins) {
      this.setMapPinRange(this.errandMarkers.get(pin.id), pin.position, pinRange);
    }
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
      el.innerHTML = `<svg width="18" height="26" viewBox="0 0 28 40" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M14 0C6.268 0 0 6.268 0 14c0 9.8 14 26 14 26S28 23.8 28 14C28 6.268 21.732 0 14 0z" fill="#d8f06a" stroke="#1a2818" stroke-width="1.5"/></svg>`;
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
      if (this.mapShown && !this.driving) this.showIntroMap();
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
    // the label over the house the shop is in; dialog reach = footprint radius + a few metres
    const house = this.map.houseAt(station.position);
    const place = house?.middle ?? station.position;
    return {
      id: station.id,
      position: start ? [...start.position] : station.position,
      place,
      top: house?.top,
      radius: house?.radius,
    };
  }

  /** Category chips + world plaques: only while the M map is open. */
  private mapViewOpen() {
    return this.overviewTarget > 0 || this.overview > 0.4;
  }

  private setMapViewUi(open: boolean) {
    if (this.mapViewUi === open) {
      this.refreshMapLabels(true);
      return;
    }
    this.mapViewUi = open;
    this.onMapView(open);
    // plaques stay in the 3D world while driving — only the chip strip is map-only
    this.refreshMapLabels(true);
  }

  /** Rebuild fuel/hub plaques; on the M map at most a few times a second (or after a pan). */
  private refreshMapLabels(force = false) {
    const now = performance.now();
    if (this.mapViewOpen()) {
      const c = this.map.getCenter();
      const here: [number, number] = [c.lng, c.lat];
      const moved = !this.mapLabelsAtPos || metersBetween(this.mapLabelsAtPos, here) > 150;
      if (!force && !moved && now - this.mapLabelsAt < 450) return;
      this.mapLabelsAt = now;
      this.mapLabelsAtPos = here;
    } else if (!force && now - this.mapLabelsAt < 450) {
      return;
    } else {
      this.mapLabelsAt = now;
      this.mapLabelsAtPos = null;
    }
    this.labelServices();
    this.refreshHubMarkers();
  }

  private clearMapLabelMarkers() {
    for (const [id, marker] of this.serviceMarkers) {
      marker.remove();
      this.serviceMarkers.delete(id);
    }
    for (const [id, marker] of this.hubMarkers) {
      marker.remove();
      this.hubMarkers.delete(id);
    }
  }

  /** Real petrol stations from the POI layer; remembered as the player drives on. */
  private collectStations(pois = this.readSourceLayer('poi')) {
    this.collectHubs(pois);
    for (const feature of pois) {
      const p = feature.properties ?? {};
      if (p.class !== 'parking' && p.subclass !== 'parking') continue;
      const g = feature.geometry as { type: string; coordinates: unknown };
      const at = g.type === 'Point' ? g.coordinates as [number, number] : null;
      if (!at) continue;
      const key = `${at[0].toFixed(4)},${at[1].toFixed(4)}`;
      if (this.parkingLots.has(key) || [...this.parkingLots.values()].some((lot) => metersBetween(lot, at) < 40)) continue;
      this.parkingLots.set(key, [at[0], at[1]]);
    }
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
    for (const bank of banksFromFeatures(pois)) {
      if (this.banks.has(bank.id)) continue;
      if ([...this.banks.values()].some(known => metersBetween(known.place ?? known.position, bank.position) < 35)) continue;
      this.banks.set(bank.id, this.placeService(bank));
    }
    for (const shop of dealershipsFromFeatures(pois)) {
      if (this.dealerships.has(shop.id)) continue;
      if ([...this.dealerships.values()].some(known => metersBetween(known.place ?? known.position, shop.position) < 35)) continue;
      this.dealerships.set(shop.id, this.placeService(shop));
    }
    const addCivic = (kind: CivicKind, list: Station[]) => {
      for (const station of list) {
        if (this.civics.has(station.id)) continue;
        if ([...this.civics.values()].some(known => known.kind === kind && metersBetween(known.place ?? known.position, station.position) < 35)) continue;
        const placed = this.placeService(station);
        this.civics.set(station.id, { ...placed, kind });
      }
    };
    addCivic('police', policeFromFeatures(pois));
    addCivic('prison', prisonsFromFeatures(pois));
    addCivic('court', courtsFromFeatures(pois));
    addCivic('hospital', hospitalsFromFeatures(pois));
    for (const stop of busStopsFromFeatures(pois)) {
      if (this.busStops.has(stop.id)) continue;
      if ([...this.busStops.values()].some(known => metersBetween(known.place ?? known.position, stop.position) < 25)) continue;
      this.busStops.set(stop.id, this.placeService(stop));
    }
    if (this.busStops.size > 400) {
      const keep = [...this.busStops.values()].sort((a, b) => metersBetween(a.position, this.vehicle.position) - metersBetween(b.position, this.vehicle.position)).slice(0, 400);
      this.busStops = new Map(keep.map(stop => [stop.id, stop]));
    }
    for (const spot of landmarksFromFeatures(pois)) {
      if (this.landmarks.has(spot.id)) continue;
      if ([...this.landmarks.values()].some(known => known.kind === spot.kind && metersBetween(known.place ?? known.position, spot.position) < 40)) continue;
      const placed = this.placeService(spot);
      this.landmarks.set(spot.id, { ...placed, kind: spot.kind, name: spot.name });
    }
    if (this.landmarks.size > 250) {
      const keep = [...this.landmarks.values()].sort((a, b) => metersBetween(a.position, this.vehicle.position) - metersBetween(b.position, this.vehicle.position)).slice(0, 250);
      this.landmarks = new Map(keep.map(spot => [spot.id, spot]));
    }
  }

  private paintFuelStations() {
    const visible = [...this.stations.values()].filter(station => metersBetween(station.position, this.vehicle.position) < 2500);
    this.fuelLayer?.setStations(visible, this.settings.terrain);
  }

  /** Map / world plaques for nearby fuel, service, banks… — on the M map and over houses while driving. */
  private labelServices() {
    if (!this.driving && !this.mapViewOpen()) {
      this.clearMapLabelMarkers();
      return;
    }
    // M map: around the view centre; driving: around the car so you can read the building
    const c = this.mapViewOpen() ? this.map.getCenter() : null;
    const here: [number, number] = c ? [c.lng, c.lat] : [...this.vehicle.position];
    const reach = this.mapViewOpen() ? 3000 : 1200;
    const cap = this.mapViewOpen() ? 10 : 6;
    type ServiceKind = 'fuel' | 'repair' | 'dealer' | 'bank' | CivicKind | 'hotel' | 'museum';
    const nearest = (list: Station[], limit = cap) => list
      .map(station => ({ station, d: metersBetween(station.position, here) }))
      .filter(item => item.d < reach)
      .sort((a, b) => a.d - b.d)
      .slice(0, limit)
      .map(item => item.station);
    const wanted = new Map<string, { station: Station; kind: ServiceKind; title?: string }>();
    const take = (kind: ServiceKind, list: Station[], limit = 10, title?: (s: Station) => string | undefined) => {
      if (!this.mapLabelOn(kind)) return;
      for (const station of nearest(list, limit)) {
        wanted.set(station.id, { station, kind, title: title?.(station) });
      }
    };
    take('fuel', [...this.stations.values()]);
    take('repair', [...this.repairShops.values()]);
    take('dealer', [...this.dealerships.values()]);
    take('bank', [...this.banks.values()]);
    for (const kind of ['police', 'prison', 'court', 'hospital'] as CivicKind[]) {
      take(kind, [...this.civics.values()].filter((station) => station.kind === kind), 8);
    }
    // type only — no brand / place names (not ads)
    for (const kind of ['hotel', 'museum'] as const) {
      take(kind, [...this.landmarks.values()].filter((spot) => spot.kind === kind), 8);
    }
    for (const [id, marker] of this.serviceMarkers) {
      if (wanted.has(id)) continue;
      marker.remove();
      this.serviceMarkers.delete(id);
    }
    const label: Record<ServiceKind, string> = {
      fuel: t('poi.fuel'), repair: t('poi.service'), dealer: t('poi.dealer'), bank: t('poi.bank'),
      police: t('poi.police'), prison: t('poi.prison'), court: t('poi.court'), hospital: t('poi.hospital'),
      hotel: t('poi.hotel'), museum: t('poi.museum'),
    };
    for (const [id, { station, kind, title }] of wanted) {
      // the houses come in after the roads: find the shop's house when they do
      if (station.top == null || station.radius == null) {
        const house = this.map.houseAt(station.place ?? station.position);
        if (house) {
          station.place = house.middle;
          station.top = house.top;
          station.radius = house.radius;
          this.serviceMarkers.get(id)?.setLngLat(house.middle).setAltitude(house.top);
        }
      }
      if (this.serviceMarkers.has(id)) continue;
      const text = title ?? label[kind];
      this.serviceMarkers.set(id, this.marker({ element: this.makeMapLabel(`travel-hub-marker is-${kind}`, text, text, undefined, false), anchor: 'bottom' }).setLngLat(station.place ?? station.position).setAltitude(station.top ?? null).addTo(this.map));
    }
  }

  /** Ports, airports and railway stations from real data, with a map label each. */
  private collectHubs(pois: MapFeature[]) {
    for (const hub of hubsFromFeatures(this.readSourceLayer('aerodrome_label'), pois)) {
      if (!this.hubs.has(hub.id)) this.hubs.set(hub.id, hub);
    }
    this.refreshHubMarkers();
  }

  private refreshHubMarkers() {
    if (!this.driving && !this.mapViewOpen()) {
      for (const [id, marker] of this.hubMarkers) {
        marker.remove();
        this.hubMarkers.delete(id);
      }
      return;
    }
    const c = this.mapViewOpen() ? this.map.getCenter() : null;
    const here: [number, number] = c ? [c.lng, c.lat] : [...this.vehicle.position];
    const hubReach = this.mapViewOpen() ? 14000 : 2500;
    const hubLabel: Record<HubKind, string> = { airport: t('hub.airport'), port: t('hub.port'), station: t('hub.station') };
    const hubColor: Record<HubKind, { main: string; soft: string }> = {
      airport: { main: '#9bb56a', soft: '#d4e878' },
      port: { main: '#2a7f9e', soft: '#6ab8d0' },
      station: { main: '#8a5a2b', soft: '#c49a60' },
    };
    for (const hub of this.hubs.values()) {
      // M map: wide; driving: nearby hubs only so the street stays readable
      const near = metersBetween(hub.position, here) < hubReach;
      const show = near && this.mapLabelOn(hub.kind);
      const marker = this.hubMarkers.get(hub.id);
      if (show && !marker) {
        const text = hubLabel[hub.kind];
        this.hubMarkers.set(hub.id, this.marker({
          element: this.makeMapLabel(`hub-map-marker is-${hub.kind}`, text, text, hubColor[hub.kind]),
          anchor: 'bottom',
        }).setLngLat(hub.position).addTo(this.map));
      } else if (!show && marker) {
        marker.remove();
        this.hubMarkers.delete(hub.id);
      }
    }
  }

  /** Arriving at a hub offers a ticket once; leaving its area re-arms the offer. */
  private updateTravel() {
    if (!this.runReady || this.mode !== 'roam' || this.travelOpen || this.fuelOut) return;
    const hub = hubAt(this.vehicle.position, [...this.hubs.values()]);
    if (!hub) { this.offeredHub = null; return; }
    if (hub.id === this.offeredHub || Math.abs(this.vehicle.speed) > 6) return;
    this.offeredHub = hub.id;
    this.travelOpen = true;
    this.keys.clear();
    this.vehicle.speed = 0;
    // Local hunts stay in-city — no ticket destination for the bounty.
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
    return { money: this.playerMoney, fuel: this.fuel.ratio, loan: this.loanDebt, garage: [...this.garage] };
  }

  private updateFuel(_dt: number) {
    const herePos = this.vehicle.position;
    const station = atStation(herePos, [...this.stations.values()], SERVICE_REACH.fuel);
    const shop = atStation(herePos, [...this.repairShops.values()], SERVICE_REACH.repair);
    const dealer = atStation(herePos, [...this.dealerships.values()], SERVICE_REACH.dealer);
    const now = performance.now();
    const bank = atStation(herePos, [...this.banks.values()].filter((b) => (this.bankShut.get(b.id) ?? 0) <= now), SERVICE_REACH.bank);
    this.refuelling = false;
    // arriving (slowly) at a station, service, showroom or bank opens its dialog once per visit
    const here = station ?? shop ?? dealer ?? bank;
    if (!here) this.offeredService = null;
    // not before the saved run (purse, garage, health) is in: a dialog would show it empty
    else if (this.runReady && here.id !== this.offeredService && Math.abs(this.vehicle.speed) < 7 && !this.serviceOpen && !this.dealerOpen && !this.bankOpen && !this.travelOpen && !this.fuelOut && this.mode === 'roam') {
      this.offeredService = here.id;
      if (dealer && here.id === dealer.id) this.tryOpenDealer();
      else if (bank && here.id === bank.id) this.openBank();
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

  private bankState(): BankOffer {
    return { money: Math.floor(this.playerMoney), debt: this.loanDebt, limit: LOAN_LIMIT, rate: LOAN_RATE };
  }

  private openBank() {
    this.bankOpen = true;
    this.keys.clear();
    this.vehicle.speed = 0;
    this.onBankOffer(this.bankState());
  }

  /** Borrow up to LOAN_LIMIT; owe it plus LOAN_RATE. Only when nothing is owed yet. */
  borrow(amount: number) {
    if (!this.bankOpen || this.loanDebt > 0) return;
    const sum = Math.max(0, Math.min(LOAN_LIMIT, Math.round(amount)));
    if (!sum) return;
    this.playerMoney += sum;
    this.loanDebt = Math.round(sum * (1 + LOAN_RATE));
    this.onBankOffer(this.bankState());
  }

  /** Pay the loan back — all of it, or what the wallet holds. */
  repayLoan() {
    if (!this.bankOpen || this.loanDebt <= 0) return;
    const pay = Math.min(Math.floor(this.playerMoney), this.loanDebt);
    this.playerMoney -= pay;
    this.loanDebt -= pay;
    this.onBankOffer(this.bankState());
  }

  leaveBank() {
    this.bankOpen = false;
    this.onBankOffer(null);
  }

  /** Tow truck (empty tank, or stuck — E): to the nearest known station, tank filled, for EVACUATION_COST coins. */
  evacuate() {
    if (!this.driving) return;
    const near = nearestStation(this.vehicle.position, [...this.stations.values()]);
    if (near && this.mapLoaded) {
      const start = roadStart(this.map, near.station.position, (position, heading) => this.collisions.blocked(position, position, heading));
      // the nearest road next to the pumps (the POI point itself may sit inside the shop)
      this.vehicle.position = start ? [...start.position] : [...near.station.position];
      if (start) this.vehicle.heading = start.heading;
    }
    this.playerMoney = Math.max(0, this.playerMoney - EVACUATION_COST);
    // the tow includes a full tank
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
  }

  private marker(options: { element: HTMLElement; anchor: 'bottom' | 'center' }): MapMarker {
    return new ThreeMarker(options) as unknown as MapMarker;
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
  private showIntroMap() {
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
    queueMicrotask(() => { if (!this.driving && this.overviewFree) this.refreshMapLabels(true); });
  }

  revealMap() {
    if (this.mapShown || this.disposed) return;
    this.mapShown = true;
    // Short burst after reveal, then drop — leaving it on forever tanks FPS after a few M toggles.
    this.map.beginStreamBurst();
    this.bootBurstUntil = performance.now() + 2500;
    this.showIntroMap();
    this.host.style.transition = 'opacity .7s ease';
    this.host.style.opacity = '1';
    this.onBoot(true);
    this.say(t('status.ready'));
  }

  private tickStreamBurst(now = performance.now()) {
    if (!this.bootBurstUntil || now < this.bootBurstUntil) return;
    this.bootBurstUntil = 0;
    this.map.endStreamBurst();
  }

  private settleBoot() {
    if (this.mapShown || !this.ready) return;
    const waited = performance.now() - this.bootAt;
    if (!this.spawnResolved) {
      this.say(t('status.placing'));
      if (waited > 12000) {
        // Last resort: any nearby road segment, even if solids are still thin.
        const start = this.findFreeRoad(this.vehicle.position, 800)
          ?? roadStart(this.map, this.vehicle.position, () => false, 800);
        if (start) this.placeDefaultOnRoad(start, true);
        else {
          this.spawnResolved = true;
          this.defaultSpawn = { position: [...this.vehicle.position], heading: this.vehicle.heading };
          this.placeSpawnMarker(this.defaultSpawn.position);
        }
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
    // Chase zoom/pitch, centred on the car (still invisible): burst loads the full
    // loadRadius ring — looking left/right on start must not hitch on cold tiles.
    if (!this.bootChaseWarmed) {
      this.map.beginStreamBurst();
      const bearing = this.vehicle.heading * 180 / Math.PI;
      const zoom = zoomForDistance(this.distance, this.vehicle.position[1]);
      this.map.jumpTo({
        center: [...this.vehicle.position] as [number, number],
        zoom,
        pitch: cameraConfig.pitch,
        bearing,
        elevation: this.altitude,
      });
      this.bootChaseWarmed = true;
      this.settleFrames = 0;
      this.say(t('status.streets'));
      return;
    }
    // Full isotropic loadRadius ring must be fetched + uploaded before "ready"
    const ring = this.map.loadRadius;
    const warmCap = 55000;
    if (!this.map.areTilesLoaded(ring) && waited < warmCap) {
      this.say(t('status.streets'));
      return;
    }
    if (!this.map.areTilesLoadedAround(this.vehicle.position as [number, number], ring) && waited < warmCap) {
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

  /** the camera is still flying in from the menu view (HUD waits for it) */
  get approaching() { return this.approachFrom != null; }

  setDriving(value: boolean, approach = true) {
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
      this.releaseHaul(null);
      // leaving the car drops an errand (its markers go with it)
      if (this.errand) { this.clearErrand(); this.completeActiveMission(); }
      if (this.mode !== 'roam') {
        this.mode = 'roam';
        this.heist = null;
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
      this.approachFrom = null;
      if (moving) this.onApproach(false);
      if (this.mapShown) this.showIntroMap();
      return;
    }
    if (this.spawnMarker) {
      const el = this.spawnMarker.getElement();
      if (el) el.style.display = 'none';
    }
    // Apply custom / save spawn before driving starts
    if (starting && this.customSpawn) {
      this.vehicle.position = [...this.customSpawn.position];
      this.vehicle.heading = this.customSpawn.heading;
      this.bearing = this.customSpawn.heading * 180 / Math.PI;
      this.spawnResolved = true;
      this.renderVehicle.reset(this.vehicle);
      this.accumulator = 0;
    }
    // First pull-out: buy the intro car if it isn't already in the garage
    if (starting && !this.garage.has(this.car.id)) {
      const price = carPrice(this.car);
      if (price > this.playerMoney) {
        this.driving = false;
        this.say(t('event.broke', { fee: formatNumber(price) }), true);
        return;
      }
      this.playerMoney -= price;
      this.garage.add(this.car.id);
    }
    // Disable map interactivity while driving
    this.map.setInteractive({ pan: false, rotate: false });
    if (starting && approach) {
      // boot already warmed the ring — starve uploads during the fly-in so it stays smooth.
      // start partway through: the long pull-in was the hitchy half in London/Manhattan.
      this.map.endStreamBurst();
      this.map.setStreamCalm(true);
      this.bootBurstUntil = 0;
      const center = this.map.getCenter();
      this.approachFrom = { lng: center.lng, lat: center.lat, zoom: this.map.getZoom(), pitch: this.map.getPitch(), bearing: this.map.getBearing() };
      this.approachAt = performance.now();
      this.onApproach(true);
      return;
    }
    // Save resume / arrive: sit in chase cam on the first frame (no intro fly-in)
    if (starting && this.mapShown) {
      this.map.setStreamCalm(false);
      this.map.beginStreamBurst();
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
      this.bootBurstUntil = performance.now() + 2500;
    }
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
        // pass altitude so overpass seams keep the deck (bare groundAt drops to the road below)
        const terrain = this.map.groundAt(at, this.altitude);
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
    let ground = this.wheelTargets.altitude + (lift ?? 0);
    const speed = Math.abs(this.vehicle.speed);
    // a deck seam can report the road/river under the bridge for one sample — don't dive
    if (!this.airborne && this.altitude - ground > 2.4 && Math.abs(this.climb) < 5) {
      const held = this.map.groundAt(this.vehicle.position, this.altitude);
      if (held != null && this.altitude - held < 1.6) ground = held;
      else if (this.onBridgeDeck(this.vehicle.position, this.altitude)) ground = this.altitude;
    }
    if (this.hangAltitude != null) {
      // on the cable: held up there, no gravity
      this.altitude = this.hangAltitude;
      this.airborne = false;
      this.climb = 0;
      this.modelPitch = settle(this.modelPitch, 0);
      this.modelRoll = settle(this.modelRoll, 0);
      return;
    }
    if (this.plunge) return;
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
        // landed in the river (not on a bridge deck) → splash and pull out on shore
        const elevated = this.onBridgeDeck(this.vehicle.position, this.altitude);
        if (this.water.covers(this.vehicle.position, elevated)) this.beginPlunge(ground);
      }
      return;
    }
    // the ground falls away faster than gravity can pull the car down: it flies
    const predicted = this.altitude + this.climb * dt - 0.5 * GRAVITY * dt * dt;
    if (speed > 5 && ground < predicted - 0.3 && this.altitude - ground < 2.4) {
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
      // a step in the surface (deck seam, curb) is not a launch: the car only gains as much
      // upward speed as a steep road could give it, else a 5 m seam threw it ~90 m up
      const measured = Math.min((this.altitude - before) / Math.max(dt, 1e-3), 1 + speed * 0.3);
      this.climb += (measured - this.climb) * (1 - Math.exp(-dt * 8));
      this.modelPitch = settle(this.modelPitch, this.wheelTargets.pitch);
    }
      this.modelRoll = settle(this.modelRoll, this.wheelTargets.roll);
    // Clutch staging: hold Shift+gas at a stop — the chassis shakes with the revs.
    if (speed < 0.5 && this.vehicle.revs > 0.15) {
      const shake = this.vehicle.revs;
      this.modelRoll += Math.sin(now * 0.055) * shake * 0.048;
      this.modelPitch += Math.cos(now * 0.073) * shake * 0.02;
    }
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

  /** True when a car pose sits in a building or in water. */
  private spawnSpotTaken(position: Position, heading: number) {
    return this.collisions.blocked(position, position, heading)
      || this.water.resolve(position, position, heading, 1, false).stopped;
  }

  private loadSpawnCollisions(at: Position, radius: number) {
    this.collisions.update(at, this.map.world.buildingsNear(at, radius, this.map.exaggeration));
    this.water.collect(at, this.cachedWater, this.cachedRoads);
  }

  /**
   * Nearest drivable road that is clear of buildings and water.
   * Re-checks with solids centered on the candidate so a far road isn't
   * accepted just because the origin radius missed its walls.
   */
  private findFreeRoad(origin: Position, maxDistance = 350) {
    if (!this.mapLoaded) return null;
    this.loadSpawnCollisions(origin, maxDistance + 40);
    const denied: Position[] = [];
    const blocked = (position: Position, heading: number) => {
      if (denied.some((spot) => metersBetween(spot, position) < 5)) return true;
      return this.spawnSpotTaken(position, heading);
    };
    for (let attempt = 0; attempt < 10; attempt++) {
      const start = roadStart(this.map, origin, blocked, maxDistance);
      if (!start) return null;
      this.loadSpawnCollisions(start.position, 120);
      if (!this.spawnSpotTaken(start.position, start.heading)) return start;
      denied.push(start.position);
      this.loadSpawnCollisions(origin, maxDistance + 40);
    }
    return null;
  }

  private placeDefaultOnRoad(start: { position: Position; heading: number }, retarget: boolean) {
    this.defaultSpawn = { position: [...start.position], heading: start.heading };
    this.vehicle.position = [...start.position];
    this.vehicle.heading = start.heading;
    this.bearing = start.heading * 180 / Math.PI;
    this.spawnResolved = true;
    if (retarget) this.setTargetVehicles(start.position, start.heading);
    this.renderVehicle.reset(this.vehicle);
    this.accumulator = 0;
    this.placeSpawnMarker(start.position);
    this.collisionDirty = true;
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
    const reach = this.spawnWaits > 8 ? 600 : this.spawnWaits > 4 ? 450 : 350;
    const start = this.findFreeRoad(this.vehicle.position, reach);
    if (start) {
      this.placeDefaultOnRoad(start, true);
      return;
    }
    this.spawnWaits++;
    // Keep waiting for roads/buildings — do not drop the car onto a plaza or rooftop.
    if (this.spawnWaits > 24) {
      const anyRoad = roadStart(this.map, this.vehicle.position, () => false, 800);
      if (anyRoad) this.placeDefaultOnRoad(anyRoad, true);
    }
  }

  /** If more buildings landed on the default pin, nudge it onto a clear road. */
  private ensureDefaultSpawnClear() {
    if (!this.spawnResolved || this.customSpawn || this.driving || this.mapShown || !this.defaultSpawn) return;
    this.loadSpawnCollisions(this.defaultSpawn.position, 120);
    if (!this.spawnSpotTaken(this.defaultSpawn.position, this.defaultSpawn.heading)) return;
    const start = this.findFreeRoad(this.defaultSpawn.position, 140)
      ?? this.findFreeRoad(this.vehicle.position, 450);
    if (start) this.placeDefaultOnRoad(start, false);
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
    if (!this.spawnResolved && this.map.features('transportation').length) this.resolveSpawn();
    else if (this.spawnResolved) this.ensureDefaultSpawnClear();
  }

  *collectWorldSteps(refreshTiles: boolean): Generator<null, void> {
    yield* this.collectWorldThree(refreshTiles);
  }

  /** Pull one resident tile into gameplay caches / traffic / rails / POIs. */
  private absorbTile(key: string) {
    // features are ready at onTile; GPU waiting queue is unrelated
    if (this.ingestedTiles.has(key) || !this.map.world.hasTile(key)) return;
    const world = this.map.world;
    const water = world.featuresOf(key, 'water') as MapFeature[];
    const roads = world.featuresOf(key, 'transportation') as MapFeature[];
    const landuse = world.featuresOf(key, 'landuse') as MapFeature[];
    const poi = world.featuresOf(key, 'poi') as MapFeature[];
    if (water.length) this.cachedWater.push(...water);
    if (roads.length) {
      this.cachedRoads.push(...roads);
      this.rails.addFeatures(roads);
      this.trafficNetwork.addFeatures(roads);
    }
    if (landuse.length) this.cachedLanduse.push(...landuse);
    if (poi.length) this.collectStations(poi);
    this.ingestedTiles.add(key);
  }

  /** After a full scoop: mark every tile in feature range so we don't re-absorb it. */
  private rememberIngested(focus: [number, number]) {
    this.ingestedTiles.clear();
    const mx = mercatorX(focus[0]), my = mercatorY(focus[1]);
    const scale = Math.cos(focus[1] * Math.PI / 180);
    const reach = this.map.world.options.featureRadius;
    for (const key of this.map.world.tileKeys()) {
      const [z, x, y] = key.split('/').map(Number);
      if (![z, x, y].every(Number.isFinite)) continue;
      if (distanceToTile(mx, my, { z, x, y }, scale) > reach) continue;
      this.ingestedTiles.add(key);
    }
  }

  /** Roads, water, green areas and stations for collisions and gameplay. */
  private *collectGround(refreshTiles: boolean, focus: [number, number]): Generator<null, void> {
    if (refreshTiles) {
      const now = performance.now();
      const batch = [...this.pendingIngest];
      this.pendingIngest.clear();
      // Full features() only on boot / rare prune / cache bloat — not on every dirty bit.
      const forceFull = !this.tilesIngested
        || now - this.fullScoopAt > 60000
        || this.cachedRoads.length > 8000
        || this.cachedWater.length > 4000;

      if (forceFull) {
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
        this.paintFuelStations();
        this.labelServices();
        this.refreshHubMarkers();
        this.fullScoopAt = now;
        this.rememberIngested(focus);
        yield null;
      } else if (batch.length) {
        let n = 0;
        for (const key of batch) {
          this.absorbTile(key);
          if (++n % 3 === 0) yield null;
        }
        this.rails.prune(focus, 6000);
        yield null;
        if (this.trafficNetwork.flushRebuild()) {
          this.syncRoadPickups();
          yield null;
        }
        this.paintFuelStations();
        this.labelServices();
        this.refreshHubMarkers();
        yield null;
      }
      // else: collisionDirty only (buildings) — collectWorldThree already refreshed solids
    } else if (this.trafficNetwork.flushRebuild()) {
      this.syncRoadPickups();
      yield null;
    }

    this.water.collect(this.vehicle.position, this.cachedWater, this.cachedRoads);
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
    const moved = origin ? Math.hypot((checkPoint[0] - origin[0]) * METERS_PER_DEGREE * cos, (checkPoint[1] - origin[1]) * METERS_PER_DEGREE) : Infinity;
    const needsCoverage = !this.water.near(this.vehicle.position);
    // Pending tile ingest is cheap — run soon. Full scoop stays rare/slow.
    const pending = this.pendingIngest.size > 0;
    const tileDebounce = pending
      ? (this.overview > 0.2 ? 700 : 350)
      : this.overview > 0.2 ? 2800
        : this.driving ? 1600
          : (this.mapShown ? 1800 : 250);
    const refreshTiles = (!this.tilesIngested || this.collisionDirty || pending) && now - this.collisionTime >= tileDebounce;
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
    // fly-in: no world scoops / traffic / physics — those were the 17 fps хрясть
    if (!this.approachFrom) this.pumpWorld(now);
    if (this.driving && !this.paused && !document.hidden && this.approachFrom) {
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
      const from = this.approachFrom;
      const startT = 0.45;
      const raw = Math.min(1, (now - this.approachAt) / this.approachMs);
      const t = startT + (1 - startT) * raw;
      const eased = t * t * (3 - 2 * t);
      const turn = ((this.bearing - from.bearing + 540) % 360) - 180;
      const center: [number, number] = [from.lng + (look[0] - from.lng) * eased, from.lat + (look[1] - from.lat) * eased];
      const zoomNow = from.zoom + (zoom - from.zoom) * eased;
      const pitchNow = from.pitch + (this.pitch - from.pitch) * eased;
      const bearingNow = from.bearing + turn * eased;
      this.map.setStreamCalm(true);
      this.map.setScreenStream(false);
      this.map.jumpTo({ center, zoom: zoomNow, pitch: pitchNow, bearing: bearingNow, elevation: this.altitude });
      this.map.setFocusCar(this.renderVehicle.position, this.altitude, this.renderVehicle.heading, this.modelPitch);
      if (raw >= 1) {
        this.approachFrom = null;
        this.onApproach(false);
        this.map.setStreamCalm(false);
        this.map.beginStreamBurst();
        this.bootBurstUntil = performance.now() + 2000;
      }
    } else if (this.driving && !this.paused && !document.hidden) {
      this.accumulator += dt;
      let blocked = false;
      let shore = false;
      this.tickPlunge(now);
      const gridded = this.raceCountdown(now);
      while (this.accumulator >= 1 / 60) {
        this.renderVehicle.capture(this.vehicle);
        const previous: [number, number] = [...this.vehicle.position];
        const oldHeading = this.vehicle.heading;
        // An empty tank: no throttle, no boost; the car rolls out.
        const held = this.keys;
        const driveKeys = this.fuel.empty ? new Set([...held].filter(key => !NO_FUEL_KEYS.has(key))) : held;
        const travelled = this.vehicle.distance;
        this.vehicle.step(1 / 60, driveKeys, { ...vehicleConfig, acceleration: this.car.acceleration, maxSpeed: this.car.maxSpeed });
        if (gridded || this.hangAltitude != null || this.towed || this.plunge) {
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
        if (!this.plunge && !gridded && Math.abs(this.vehicle.speed) > 1.5) {
          const ground = this.map.groundAt(intended, this.altitude) ?? this.altitude;
          const nearGround = !this.airborne || this.altitude - ground < 3.5;
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
        if (!this.plunge && !this.airborne) {
          const building = this.collisions.resolve(previous, this.vehicle.position, this.vehicle.heading, 1, this.altitude);
          if (building.stopped) {
            this.vehicle.position = building.position;
            this.vehicle.heading = oldHeading;
            this.vehicle.speed = 0;
            blocked = true;
          } else if (building.slid) {
            this.vehicle.position = building.position;
            // light skim only — heavy damping made corners feel sticky
            this.vehicle.speed *= 0.97;
          } else {
            // either end of the step on the deck → water must not wall or drown us
            const elevated = this.onBridgeDeck(this.vehicle.position, this.altitude)
              || this.onBridgeDeck(previous, this.altitude);
            const hit = this.water.resolve(previous, this.vehicle.position, this.vehicle.heading, 1, elevated);
            this.vehicle.position = hit.position;
            if (hit.stopped) {
              this.vehicle.speed = 0;
              shore = true;
            } else if (this.water.covers(this.vehicle.position, elevated)) {
              // under a bridge / already in the bath — splash and pull out on shore
              this.beginPlunge(this.altitude);
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
          if (gridded || bot.id === this.haul?.id) continue;
          // impound car waits still on the pin until hooked
          if (bot.id === TOW_CAR_ID && this.impoundActive && this.haul?.id !== TOW_CAR_ID) continue;
          // ambulance crash wreck stays planted — exploring would Dijkstra across London and hitch
          if (isAmbulanceWreckId(bot.id)) continue;
          if (this.combatLayer && !this.combatLayer.isTargetAlive(bot.id)) continue;
          const previous: [number, number] = [...bot.position];
          const oldHeading = bot.heading;
          const police = bot.id.startsWith('police');
          advanceTrafficBot(bot, 1 / 60, this.trafficNetwork, police ? this.policePace(bot) : {
            ...vehicleConfig,
            acceleration: bot.car.acceleration,
            maxSpeed: bot.car.maxSpeed,
          }, police ? peers.slice(0, 1) : peers, [], this.botShortcut(bot, now));
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
              bot.controller.speed *= 0.96;
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
          } else {
            const botAlt = this.map.groundAt(previous) ?? this.altitude;
            const elev = this.onBridgeDeck(previous, botAlt);
            if (this.water.covers(previous, elev)) {
              const hit = this.water.resolve(previous, bot.position, bot.heading, 1, elev);
              bot.controller.position = hit.position;
              if (hit.stopped) bot.controller.speed = 0;
              bot.retryFrames = Math.max(0, bot.retryFrames - 2);
            } else {
              bot.retryFrames = Math.max(0, bot.retryFrames - 3);
            }
          }
          bot.position = [...bot.controller.position];
          bot.heading = bot.controller.heading;
        }
        this.trainBlock(this.vehicle, this.altitude);
        for (const bot of this.trafficBots) {
          if (this.trainBlock(bot.controller, this.map.groundAt(bot.position) ?? this.altitude)) bot.position = [...bot.controller.position];
        }
        this.resolveVehicleContacts(now);
        this.players.bump(now);
        this.collectRoadPickups();
        this.accumulator -= 1 / 60;
      }
      if (this.trafficBots.length) this.combatLayer?.updateTargets(this.targetVehicles());
      this.updateHunterGuns(now);
      this.hijackHint();
      this.syncExtraTargets(dt, now);
      this.updateFuel(dt);
      this.updateTravel();
      if (blocked) this.say(t('hint.building'));
      else if (shore) this.say(t('hint.shore'));
      else if ([t('hint.building'), t('hint.shore')].includes(this.message)) this.say('');
      this.updateEvents();
      this.renderVehicle.update(this.vehicle, this.accumulator * 60);
      this.plantWheels(dt, now);
      this.updateHaul(now);
      this.updateRamp(now, dt);
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
      // hold calm a bit after the blend lands — first free frames were still uploading towers
      const mapBlending = this.overviewTarget > 0 ? this.overview < 0.98 : this.overview > 0.02;
      const mapHoldCalm = this.overviewFree && this.overviewTarget > 0 && performance.now() < this.mapCalmUntil;
      this.map.setStreamCalm(mapBlending || mapHoldCalm);
      if (this.overviewTarget > 0 && this.overview > 0.98) {
        if (!this.overviewFree) {
          this.overviewFree = true;
          this.mapCalmUntil = performance.now() + 1800;
          this.setOverviewMapNav(true);
          this.stopGun();
          // labels next tick — same frame as leaving calm was hitching the open
          queueMicrotask(() => { if (this.overviewFree) this.refreshMapLabels(true); });
        }
        const c = this.map.getCenter();
        center = [c.lng, c.lat];
        zoomNow = this.map.getZoom();
        pitchNow = 0;
        bearingNow = 0;
        this.refreshMapLabels();
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
        this.refreshMapLabels();
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
      this.updateTrains(dt);
      // players first: the bars must sit where their cars are drawn this frame, not the last one
      this.players.update();
      // Offscreen arrows must track every frame — 10 Hz made them stutter on turn
      this.updateHealthMarkers(now - this.overlayTime > 100);
      this.updateTrafficMarkers();
      this.updateEventMarkers();
      if (now - this.overlayTime > 100) {
        this.overlayTime = now;
        this.updateSelfMarker();
      }
    }
    if (now - this.hudTime > 100) {
      this.hudTime = now;
      if (!this.approachFrom) this.saveCamera(now);
      this.hud(this.vehicle.speed * 3.6, this.vehicle.distance, this.fps, this.hudParticipants());
      if (!this.approachFrom) {
        const near = nearestStation(this.vehicle.position, [...this.stations.values()]);
        const hub = nearestHub(this.vehicle.position, [...this.hubs.values()]);
        // only hint the hub when you're close enough that it matters (not from across town)
        const hubHint = hub?.hub.kind === 'airport' ? 800 : hub?.hub.kind === 'station' ? 220 : 120;
        const hubHud = hub && hub.distance < hubHint
          ? { kind: hub.hub.kind, distance: hub.distance }
          : null;
        this.onFuel({ level: this.fuel.level, tank: this.fuel.spec.tank, rpm: this.vehicle.revs, refuelling: this.refuelling, station: near ? near.distance : null, money: Math.floor(this.playerMoney), hub: hubHud });
      }
    }
    if (!this.mapShown) this.settleBoot();
    if (!this.approachFrom) this.tickStreamBurst(now);
    this.map.triggerRepaint();
  };

  dispose() {
    this.disposed = true;
    this.setMapViewUi(false);
    this.players.dispose();
    this.worldWork = null;
    cancelAnimationFrame(this.frame);
    this.spawnMarker?.remove();
    for (const marker of this.missionMarkers.values()) marker.remove();
    this.missionMarkers.clear();
    this.clearCustomPins();
    this.raceGoalMarker?.remove();
    this.bountyMarker?.remove();
    this.fireMarker?.remove();
    this.impoundMarker?.remove();
    this.taxiMarker?.remove();
    this.ambulanceMarker?.remove();
    this.busTourMarker?.remove();
    this.combatLayer?.setFireHouse(null);
    this.trafficBots = this.trafficBots.filter((b) => !isAmbulanceWreckId(b.id));
    this.eventIndicatorLayer?.remove();
    for (const marker of this.hubMarkers.values()) marker.remove();
    this.hubMarkers.clear();
    for (const marker of this.serviceMarkers.values()) marker.remove();
    this.serviceMarkers.clear();
    this.pickups.clear();
    this.combatLayer?.setPickups([]);
    this.trafficMarkerLayer?.remove();
    this.trafficMarkers.clear();
    this.offLang();
    this.selfMarker?.remove();
    this.healthMeters.dispose();
    this.cleanups.forEach((fn) => fn());
    this.map.remove();
  }
}
