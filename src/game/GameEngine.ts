import { roadStart } from './roadStart';
import { VehiclePose } from './VehiclePose';
import { supportAltitude, type GroundSample } from './groundSupport';
import { BuildingCollisions } from './BuildingCollisions';
import { WaterCollisionController, type MapFeature } from './WaterCollisionController';
import { mapConfig, cars as carsConfig, carPrice, STARTING_CASH, type City, type Car, vehicleConfig } from '@/config/vehicle.config';
import { cameraConfig, lookAheadFor, zoomForDistance } from '@/config/camera.config';
import { VehicleController, bumpDamage, offsetPosition, resolveVehicleCollision, type Position } from './VehicleController';
import { DROP_MS, vehicleLayer, type PickupVisual, type VehicleSceneLayer } from '@/rendering/VehicleLayer';
import type { ArchitectureSetting, BuildingDetail } from './buildings/BuildingStyles';
import type { SkinId } from '@/world3d/buildings/skins';
import type { ChatLine, NetNotice } from '@/net/NetClient';
import { distanceToTile } from '@/world3d/tiles/tilePlan';
import { mercatorX, mercatorY } from '@/world3d/mercator';

/** tiles this close to the car feed gameplay (the world's feature radius, plus slack) */
const NEAR_TILE_METERS = 2600;
import { NetPlayers, PLAYER_MARKER_COLOR, type OnlinePlayer } from './net/NetPlayers';
import { SharedTraffic } from './net/SharedTraffic';
import { HealthMeters, type Meter } from './hud/HealthMeters';
import { TestTargets } from './TestTargets';
import { HIT_DAMAGE, PLAYER_HP } from '@/net/protocol';
import { MARKER_PIN_METERS, nameIndicator, placeIndicator } from './hud/indicators';
import { advanceTrafficBot, createTrafficBot, TrafficRoadNetwork, type TrafficBot } from './TrafficBots';
import { formatNumber, onLangChange, t } from '@/i18n';
import { ThreeMap, ThreeMarker } from '@/world3d/map/ThreeMap';
import { atStation, banksFromFeatures, courtsFromFeatures, dealershipsFromFeatures, EVACUATION_COST, FuelTank, FUEL_PRICE, hospitalsFromFeatures, metersBetween, nearestStation, policeFromFeatures, prisonsFromFeatures, repairShopsFromFeatures, REPAIR_PRICE, stationsFromFeatures, type CivicKind, type Station } from './Fuel';
import { fuelStationsLayer } from '@/rendering/FuelStationsLayer';
import { isVintageTrain, trainsLayer } from '@/rendering/TrainsLayer';
import { RailNetwork, TrainTraffic } from './Trains';
import { hubAt, hubsFromFeatures, kilometres, nearestHub, ticketPrice, type Hub, type HubKind } from './Travel';
import { bearingTo, BOUNTY_RANGE_KM, loadBounty, makeBounty, saveBounty, type Bounty } from './Bounty';
import type { GameSave } from './save';
import { BOX_REACH_M, COLLECT_BOXES, COLLECT_REWARD, deliveryReward, DELIVERY_MAX_M, DELIVERY_MIN_M, DELIVERY_REACH_M, randomItem, scatterBoxes, type DeliveryItem, type Errand } from './Errands';

export type FuelHud = { level: number; tank: number; rpm: number; refuelling: boolean; station: number | null; money: number; hub: { kind: HubKind; distance: number } | null };
/** What a player takes along to another city (ticket) or restores on page reload. */
export type PlayerCarry = {
  money: number;
  fuel: number;
  /** page reload: keep the car where it was */
  at?: { position: [number, number]; heading: number; hp: number };
  /** road coins already collected (reload only) */
  collected?: string[];
  /** what we owe the bank (one network, one loan at a time) */
  loan?: number;
  /** ids of every car we own (the garage); C swaps between them on the road */
  garage?: string[];
};
/** At a bank, peacefully: borrow (when nothing is owed) or pay back. */
export type BankOffer = { money: number; debt: number; limit: number; rate: number };

/** the most the bank lends, and its interest (one-off, no term) */
export const LOAN_LIMIT = 10000;
export const LOAN_RATE = 0.1;
export type TravelOffer = { kind: HubKind; from: [number, number]; money: number; target?: { name: string; country: string; coords: [number, number] } };
/** A wanted driver somewhere in the world, offered as a job. */
export type BountyOffer = { name: string; car: string; place: string; country: string; km: number; reward: number };
/** Arena/race finished — UI shows a result dialog. */
export type MissionKind = 'arena' | 'race' | 'delivery' | 'collect';
export type EventResult = { kind: MissionKind | 'heist' | 'hijack'; won: boolean; name?: string; cash?: number };
/** What the marker's dialog offers; a delivery says what, how far and for how much. */
export type EventOffer = { kind: MissionKind; item?: DeliveryItem; km?: number; reward?: number; boxes?: number };
/** Arrived at a fuel station or a car service: what the dialog needs to show. */
export type ServiceOffer =
  | { kind: 'fuel'; level: number; tank: number; money: number; price: number }
  | { kind: 'repair'; hp: number; maxHp: number; money: number; price: number };
/** Car dealership lot: shelf prices and the trade-in for the car you drove in. */
/** the showroom: our coins, the car we sit in and every car already in our garage */
export type DealerOffer = { money: number; currentId: string; owned: string[] };

/** race and arena: what you chip in to start, and what the winner takes */
export const RACE_FEE = 1000;
export const RACE_PRIZE = 4000;
export const ARENA_FEE = 2500;
export const ARENA_PRIZE = 10000;
/** how close to a mission marker the offer opens (m) */
const MISSION_PICKUP_M = 6;
/** The Howler doesn't shoot: it throws a cable at a standing car and pulls it up onto its back. */
const HAULER_ID = '03';
/** how far the cable reaches (m), how close to the aim a car must stand to be hooked, and when it snaps */
const HAUL_REACH_M = 12;
const HAUL_AIM_M = 3;
const HAUL_SNAP_M = 20;
/** faster than this (m/s) the hook slips off */
const HAUL_STILL = 1;
/**
 * The Howler's flatbed, as shares of its length (measured on the model): the bed's top is
 * 0.177 of the length up, its middle 0.23 of the length behind the truck's middle.
 */
const HAUL_DECK_UP = 0.177;
const HAUL_DECK_BACK = 0.23;
const HAUL_FLY_MS = 80, HAUL_PULL_MS = 520, HAUL_REEL_MS = 650, HAUL_DROP_MS = 750, HAUL_MISS_MS = 260;
/** missions on the map at once: one of each kind */
const MISSION_COUNT = 4;
/** 3D markers of the errands: green for a delivery, cardboard brown for the boxes */
const ERRAND_BEACONS = {
  delivery: { pole: '#2fae5a', glow: '#16703a', orb: '#7fe0a0' },
  collect: { pole: '#b8742a', glow: '#6e4212', orb: '#f0b878' },
} as const;
const NO_FUEL_KEYS = new Set(['KeyW', 'Space']);

type MapMarker = {
  setLngLat(position: [number, number]): MapMarker;
  /** stand at this height (m) instead of on the ground */
  setAltitude(altitude: number | null): MapMarker;
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
const TRAFFIC_MARKER_COLORS = ['#ff3b30', '#00e5ff', '#ffe600'];
/** Map plaques + off-screen arrows share these (arena / race / bounty / race finish). */
const MISSION_COLORS = {
  arena: { main: '#2f7dff', soft: '#6eb6ff' },
  race: { main: '#ff7a1a', soft: '#ffb86b' },
  bounty: { main: '#d63a2f', soft: '#ff8a7a' },
  finish: { main: '#c9a227', soft: '#ffe56a' },
  delivery: { main: '#2fae5a', soft: '#7fe0a0' },
  collect: { main: '#b8742a', soft: '#f0b878' },
} as const;
/** Custom M-map pins: colours not used by missions / traffic bots. Max 3 pins. */
const CUSTOM_PIN_COLORS = [
  { main: '#a96aff', soft: '#c9a6ff', glow: '#6a3ab8' },
  { main: '#2ecf8f', soft: '#7aefc0', glow: '#1a8a5a' },
  { main: '#ff4f9a', soft: '#ff9ac4', glow: '#b02060' },
] as const;
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
/** `drop`: thrown out of a wreck — bounces from `from` and can be picked up once it lies still */
type ActivePickup = { position: [number, number]; color: string; kind: 'coin' | 'cash'; drop?: { from: [number, number]; at: number; up?: number } };

/** one bundle of banknotes from a robbed bank */
const CASH_BUNDLE = 5000;
/** Base arrest bill by where you wake up (stolen cash is added on top). */
const ARREST_COSTS: Record<CivicKind, number> = {
  police: 20000,
  prison: 25000,
  court: 22000,
  hospital: 18000,
};
/** Fallback if no civic POI is loaded yet */
const ARREST_FINE = 20000;
/** Our car blown up outside a fight: the bill where we come to (stretcher and repair, or tow and repair). */
const WRECK_COSTS = { hospital: 1500, station: 1000, here: 1000 } as const;
/** shooting at a bank this long (ms, in one go) cracks it */
const BANK_CRACK_MS = 3000;
/** police that far behind give up the chase (m) */
const POLICE_GIVE_UP_M = 1500;
/** …and only after staying that far this long (ms) */
const POLICE_GIVE_UP_MS = 10_000;

function randomDriverNames(count: number) {
  const names = [...DRIVER_NAMES];
  for (let index = names.length - 1; index > 0; index--) {
    const swap = Math.floor(Math.random() * (index + 1));
    [names[index], names[swap]] = [names[swap], names[index]];
  }
  return names.slice(0, count);
}

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
  /** `n`: the mission's number in its kind, for its label in any language */
  private missions: { id: string; kind: MissionKind; label: string; n: number; position: [number, number] }[] = [];
  /** a delivery or box hunt under way */
  private errand: Errand | null = null;
  /** a delivery prepared for the offer on screen */
  private offeredDelivery: { item: DeliveryItem; goal: Position; reward: number } | null = null;
  private errandMarkers = new Map<string, MapMarker>();
  private errandIndicator: { element: HTMLElement; arrow: HTMLElement; distance: HTMLElement; title?: HTMLElement } | null = null;
  private missionFocus = 0;
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
  /**
   * The hauler's cable. First click: it flies out (fly) and sticks to a car (hooked) or a
   * wall (anchored), or comes back empty (miss). Second click: the car is yanked up onto
   * our back (pull → carry), or we reel ourselves up to the wall and hang there (reel →
   * hang). Third click: the car slides off behind (drop), or we let go and fall.
   */
  private haul: {
    id: string; kind: 'bot' | 'shared' | 'wall'; car: Car;
    phase: 'fly' | 'hooked' | 'anchored' | 'pull' | 'carry' | 'drop' | 'miss' | 'reel' | 'hang';
    at: number; from: Position; fromHeading: number; fromUp: number;
    /** wall: the hook (absolute height), and where we start reeling from */
    hookAlt?: number; self?: Position; selfAlt?: number;
  } | null = null;
  /** hanging on (or reeling up) the cable: our height, held; null on the ground or flying */
  private hangAltitude: number | null = null;
  /** us on the map (M): a dot with an arrow along our heading */
  private selfMarker: MapMarker | null = null;
  /** a new language: every map label and marker title says it again */
  private offLang = onLangChange(() => this.relabel());
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
      canMove: (from, to, heading) => !this.collisions.blocked(from, to, heading, 1, this.altitude) && !this.water.resolve(from, to, heading).stopped,
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
      canPark: (at, heading) => !this.collisions.blocked(at, at, heading) && !this.water.covers(at),
      lots: () => [...this.parkingLots.values()].filter((lot) => metersBetween(lot, this.vehicle.position) < 600),
      take: (id) => this.players.takeTraffic(id),
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
      this.combatLayer.onTargetHit = (id) => this.sharedTraffic.ourHit(id);
      this.combatLayer.onTrainCoin = (point, altitude) => this.trainCoin(point, altitude);
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
    const target = this.map.unproject(this.aimScreen);
    this.combatLayer?.setAim({ ground: [target.lng, target.lat], screen: this.aimScreen });
  }

  private placeTargetIndicator(marker: { element: HTMLElement; arrow: HTMLElement; distance: HTMLElement }, target: [number, number], pinMeters = MARKER_PIN_METERS) {
    placeIndicator(this.map, marker, this.vehicle.position, target, pinMeters, this.mapInspecting());
  }

  setCar(car: Car) {
    if (this.car.id === car.id && this.car.path === car.path) return;
    if (this.haul && car.id !== HAULER_ID) this.loseHaul();
    this.car = car;
    this.fuel.changeSpec(car.fuel);
    this.combatLayer?.setCar(car);
  }

  /** Lot catalogue for the dealership dialog. */
  private dealerState(): DealerOffer {
    return { money: Math.floor(this.playerMoney), currentId: this.car.id, owned: [...this.garage] };
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
    const carry = this.carry;
    const resumeHp = carry?.at?.hp;
    this.playerHp = resumeHp != null ? Math.max(1, Math.min(this.playerMaxHp, resumeHp)) : this.playerMaxHp;
    this.wins.clear();
    this.clearEventBots();
    this.pickups.clear();
    this.combatLayer?.setPickups([]);
    this.collectedPickups = new Set(carry?.collected?.filter((id) => typeof id === 'string') ?? []);
    this.pickupFocus = null;
    this.pickupNetworkRevision = -1;
    // travel / reload keep the purse; a fresh start buys the intro car out of STARTING_CASH
    this.playerMoney = carry?.money ?? Math.max(0, STARTING_CASH - carPrice(this.car));
    this.fuel.level = this.fuel.spec.tank * (carry?.fuel ?? 1);
    this.loanDebt = Math.max(0, Math.round(carry?.loan ?? 0));
    this.garage = new Set((carry?.garage ?? []).filter((id) => carsConfig.some((car) => car.id === id)));
    this.garage.add(this.car.id);
    this.carry = null;
    this.runReady = true;
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

  /** Exit to menu: drop this run so the next drive is a fresh purchase. */
  resetRun() {
    this.customSpawn = null;
    this.defaultSpawn = null;
    this.spawnResolved = false;
    this.runReady = false;
    this.playerMoney = 0;
    this.playerHp = this.playerMaxHp;
    this.carry = null;
    this.collectedPickups.clear();
    this.loanDebt = 0;
    this.garage.clear();
    this.pickups.clear();
    this.combatLayer?.setPickups([]);
    this.fuel.level = this.fuel.spec.tank;
    this.fuelOut = false;
    this.onFuelOut(false);
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
      kind?: 'arena' | 'race' | 'bounty';
      colors?: { pole: string; glow: string; orb: string };
    }[] = visible.map(mission => ({
      id: mission.id,
      kind: mission.kind === 'arena' || mission.kind === 'race' ? mission.kind : undefined,
      colors: mission.kind === 'delivery' || mission.kind === 'collect' ? ERRAND_BEACONS[mission.kind] : undefined,
      position: mission.position,
    }));
    const errand = this.errand;
    if (errand?.kind === 'delivery') beacons.push({ id: 'errand-goal', position: errand.goal, colors: ERRAND_BEACONS.delivery });
    if (errand?.kind === 'collect') for (const box of errand.boxes) beacons.push({ id: `errand-${box.id}`, position: box.position, colors: ERRAND_BEACONS.collect });
    if (showWorld && !this.bountyFight && !errand) {
      if (this.bountyPending && this.bountyPickup && free) {
        beacons.push({ id: 'bounty-pickup', kind: 'bounty', position: this.bountyPickup });
      } else if (this.bounty?.spot) {
        beacons.push({ id: 'bounty', kind: 'bounty', position: this.bounty.spot });
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

  /** Arena/race missions plus the wanted job (pending pickup or accepted hunt). */
  private focusGoals() {
    const goals: Array<
      | { kind: 'mission'; id: string; missionKind: MissionKind; label: string; position: [number, number] }
      | { kind: 'bounty'; label: string; position: [number, number] | null }
    > = (this.onMission() ? [] : this.missions).map(mission => ({
      kind: 'mission' as const,
      id: mission.id,
      missionKind: mission.kind,
      label: mission.label,
      position: mission.position,
    }));
    if (this.bountyFight || this.errand) return goals;
    if (this.bountyPending && this.bountyPickup && !this.onMission()) {
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
    this.missionSeq = { arena: 0, race: 0, delivery: 0, collect: 0 };
    this.clearErrand();
    this.missionFocus = 0;
    this.activeMissionId = null;
    this.missionRespawnAt = 0;
    this.lastCompletedKind = null;
    this.lastCompletedAt = null;
    const seed = Math.round(position[0] * 1e5) ^ Math.round(position[1] * 1e5) ^ 42011;
    const kinds: MissionKind[] = ['race', 'arena', 'delivery', 'collect'];
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
        if (this.missionFocus >= this.missions.length) this.missionFocus = Math.max(0, this.missions.length - 1);
      }
      this.activeMissionId = null;
    }
    this.missionRespawnAt = performance.now() + 30000;
    this.syncMissionVisuals(true);
  }

  private refillMissions() {
    if (this.mode !== 'roam' || this.missions.length >= MISSION_COUNT) return;
    if (!this.missionRespawnAt || performance.now() < this.missionRespawnAt) return;
    const center = this.vehicle.position as [number, number];
    const heading = this.vehicle.heading;
    const seed = Math.round(center[0] * 1e5) ^ Math.round(center[1] * 1e5) ^ (performance.now() | 0);
    // one of each kind on the map: bring back a missing one, not the one just finished if another is missing too
    const kinds: MissionKind[] = ['race', 'arena', 'delivery', 'collect'];
    const missing = kinds.filter(kind => !this.missions.some(mission => mission.kind === kind));
    const kind = missing.find(k => k !== this.lastCompletedKind) ?? missing[0] ?? kinds[Math.abs(seed) % kinds.length];
    this.missions.push(this.createMission(kind, center, heading, seed ^ 0x9e37, { min: 450, max: 1400 }));
    this.missionRespawnAt = this.missions.length >= MISSION_COUNT ? 0 : performance.now() + 30000;
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
      ...this.sharedTraffic.bodies(),
      ...this.trafficBots
        .filter(bot => !this.combatLayer || this.combatLayer.isTargetAlive(bot.id))
        .map(bot => ({ id: bot.id, controller: bot.controller, car: bot.car })),
    ].filter(participant => participant.id !== this.haul?.id);
    const applyPosition = (participant: typeof participants[number], next: [number, number]) => {
      const { controller } = participant;
      if (next === controller.position
        || this.collisions.blocked(controller.position, next, controller.heading, 1, participant.id === 'player' ? this.altitude : -Infinity)) return;
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
        if (this.heist && ((a.id === 'player' && b.id.startsWith('police')) || (b.id === 'player' && a.id.startsWith('police')))) {
          this.heist.caught = true;
        }
        const key = `${a.id}:${b.id}`;
        if (now - (this.vehicleContactTimes.get(key) ?? 0) < 280) continue;
        this.vehicleContactTimes.set(key, now);
        // every knock that flashes a car red takes health off it: the slower side takes
        // the knock, a hunting bot ramming at speed hurts whoever it rams, and harder
        const impact = Math.abs(a.controller.speed) + Math.abs(b.controller.speed);
        const ramming = (id: string) => impact > 6 && this.trafficBots.some(bot => bot.id === id && bot.mood === 'hunt');
        const hurt = (victim: typeof a, attacker: typeof a, slower: boolean) => {
          const rammed = ramming(attacker.id);
          if (!slower && !rammed) return;
          const amount = rammed ? Math.max(bumpDamage(impact), Math.min(55, 12 + impact * 2.2)) : bumpDamage(impact);
          if (victim.id === 'player') this.damagePlayer(amount, 180);
          else this.combatLayer?.damageTarget(victim.id, amount);
        };
        hurt(a, b, collision.slower === 'a' || collision.slower === 'both');
        hurt(b, a, collision.slower === 'b' || collision.slower === 'both');
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

  /**
   * Hunters (arena bots and the wanted car) shoot back: short bursts when we are within
   * ~70 m, roughly ahead of them and not behind a building. Close and slow is easy to hit;
   * far and fast mostly misses. The wanted car hits harder.
   */
  private updateHunterGuns(now: number) {
    if (this.mode !== 'arena' || this.playerHp <= 0 || !this.combatLayer) return;
    const me = this.vehicle.position;
    for (const bot of this.trafficBots) {
      if (bot.mood !== 'hunt' || !this.combatLayer.isTargetAlive(bot.id)) continue;
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
    const start = roadStart(this.map, position, (p, heading) => this.collisions.blocked(p, p, heading));
    this.vehicle.position = start ? [...start.position] : [...position];
    if (start) this.vehicle.heading = start.heading;
    this.vehicle.speed = 0;
    this.vehicle.throttle = 0;
    this.bearing = this.vehicle.heading * 180 / Math.PI;
    this.renderVehicle.reset(this.vehicle);
    this.accumulator = 0;
    this.collisionDirty = true;
    this.syncedAt = null;
  }

  acceptEvent() {
    if (this.mode !== 'roam' || !this.driving || !this.eventOffer) return;
    const kind = this.eventOffer;
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
    const free = (p: [number, number]) => !this.collisions.blocked(center, p, heading) && !this.water.covers(p);
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
    this.onEventResult({ kind: 'arena', won });
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
    this.onEventResult({ kind: 'race', won, name: won ? undefined : winnerName });
  }

  /** Everybody with a health meter over the car: us, mission bots, other players, shared traffic and test cars. */
  private meterTargets(): Meter[] {
    const layer = this.combatLayer;
    const out: Meter[] = [{ id: 'player', name: t('you'), hp: this.playerHp, maxHp: this.playerMaxHp, position: this.renderVehicle.position }];
    // named cars carry their name above the bar, in their marker's colour
    for (const p of this.players.others()) out.push({ id: `net:${p.id}`, name: p.name, hp: p.hp, maxHp: PLAYER_HP, position: p.position, color: PLAYER_MARKER_COLOR });
    const health = new Map((layer?.targetHealth() ?? []).map((h) => [h.id, h]));
    this.trafficBots.forEach((bot, index) => {
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
    const kx = 111319.49 * Math.cos(around[1] * Math.PI / 180), ky = 111319.49;
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
    const kx = 111319.49 * Math.cos(from[1] * Math.PI / 180), ky = 111319.49;
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

  /** Shooting a vintage train: a coin pops out where the bullet hit (four a second), endlessly. */
  private trainCoin(point: [number, number], altitude: number) {
    const now = performance.now();
    if (now - this.trainCoinAt < 250) return; // four coins a second at most
    this.trainCoinAt = now;
    // it bounces out toward the shooter, away from the rails
    const me = this.vehicle.position;
    const kx = 111319.49 * Math.cos(point[1] * Math.PI / 180), ky = 111319.49;
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
      if (metersBetween(this.vehicle.position, candidate.position) > 80) continue;
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
      sight = { at: now, clear: !this.collisions.sightBlocked(bot.position, target) && !this.water.covers(target) };
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
    if (this.heist) { this.updateHeist(); return; }
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
    if (this.errand) { this.updateErrand(); return; }
    this.refillMissions();
    // one mission at a time: none offered while another is on
    if (this.onMission() || this.eventOffer || performance.now() < this.eventCooldown) return;
    // the offer opens only right at the marker, not from the street beside it
    const nearby = this.missions.find(mission => metersBetween(this.vehicle.position, mission.position) <= MISSION_PICKUP_M);
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

  /** On a mission of any kind (arena, race, chase, a hunt, an errand): nothing else is offered or shown. */
  private onMission() {
    return this.mode !== 'roam' || Boolean(this.heist) || this.bountyFight || Boolean(this.bounty) || Boolean(this.errand);
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
    if (this.errandIndicator) this.errandIndicator.element.style.display = 'none';
    this.combatLayer?.setPickups(this.pickupVisuals());
  }

  /** Map labels of the errand: the address, or a box over each box. */
  private syncErrandMarkers() {
    const errand = this.errand;
    const wanted = new Map<string, { position: [number, number]; className: string; text: string }>();
    if (errand?.kind === 'delivery') wanted.set('goal', { position: errand.goal, className: 'delivery-goal-marker', text: t('delivery.goal') });
    if (errand?.kind === 'collect') for (const box of errand.boxes) wanted.set(box.id, { position: box.position, className: 'collect-box-marker', text: t('collect.box') });
    for (const [id, marker] of this.errandMarkers) {
      if (wanted.has(id)) continue;
      marker.remove();
      this.errandMarkers.delete(id);
    }
    for (const [id, spec] of wanted) {
      if (this.errandMarkers.has(id)) continue;
      this.errandMarkers.set(id, this.marker({ element: this.makeMapLabel(spec.className, spec.text, spec.text), anchor: 'bottom' }).setLngLat(spec.position).addTo(this.map));
    }
  }

  /** Where the errand points now: the address, or the nearest box left. */
  private errandTarget(): { position: [number, number]; label: string; kind: 'delivery' | 'collect' } | null {
    const errand = this.errand;
    if (!errand) return null;
    if (errand.kind === 'delivery') return { position: errand.goal, label: t('delivery.goal'), kind: 'delivery' };
    const here = this.vehicle.position;
    let best: { position: Position; distance: number } | null = null;
    for (const box of errand.boxes) {
      const distance = metersBetween(here, box.position);
      if (!best || distance < best.distance) best = { position: box.position, distance };
    }
    const done = errand.total - errand.boxes.length;
    return best ? { position: best.position as [number, number], label: t('collect.goal', { n: done, total: errand.total }), kind: 'collect' } : null;
  }

  /** Where we are, on the map view: shown while looking at the map, pointing the way the car faces. */
  private updateSelfMarker() {
    if (!this.mapInspecting()) {
      if (this.selfMarker) this.selfMarker.getElement().style.display = 'none';
      return;
    }
    if (!this.selfMarker) {
      const element = document.createElement('div');
      element.className = 'self-map-marker';
      element.setAttribute('aria-label', t('you'));
      element.append(document.createElement('i'));
      this.selfMarker = this.marker({ element, anchor: 'center' }).addTo(this.map);
    }
    const element = this.selfMarker.getElement();
    element.style.display = '';
    this.selfMarker.setLngLat(this.renderVehicle.position as [number, number]);
    const arrow = element.firstElementChild as HTMLElement | null;
    if (arrow) arrow.style.transform = `rotate(${(this.renderVehicle.heading * 180 / Math.PI - this.map.getBearing()).toFixed(1)}deg)`;
  }

  // ---- the hauler: a cable, a car on our back --------------------------------

  /** Cars the cable can take: our mission bots and the traffic and parked cars we keep. */
  private haulCandidates() {
    const layer = this.combatLayer;
    return [
      ...this.trafficBots
        .filter(bot => !layer || layer.isTargetAlive(bot.id))
        .map(bot => ({ id: bot.id, kind: 'bot' as const, car: bot.car, position: bot.position, heading: bot.heading, speed: Math.abs(bot.controller.speed) })),
      ...this.sharedTraffic.holdable().map(c => ({ ...c, kind: 'shared' as const })),
    ];
  }

  /** A click in the Howler: throw the cable; yank what it holds; let go. Works mid-jump too. */
  private haulClick() {
    const now = performance.now();
    const haul = this.haul;
    if (haul) {
      if (haul.phase === 'hooked') { haul.phase = 'pull'; haul.at = now; }
      else if (haul.phase === 'anchored') { haul.phase = 'reel'; haul.at = now; haul.self = [...this.vehicle.position] as Position; haul.selfAlt = this.altitude; haul.fromHeading = this.vehicle.heading; }
      else if (haul.phase === 'carry') { haul.phase = 'drop'; haul.at = now; }
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
    // a car by the aim, within the cable's reach of our nose (to its near side)
    let best: ReturnType<GameEngine['haulCandidates']>[number] | null = null;
    let bestD = HAUL_AIM_M;
    for (const c of this.haulCandidates()) {
      const d = metersBetween(point, c.position);
      if (d < bestD && metersBetween(nose, c.position) - c.car.length / 2 <= HAUL_REACH_M) { bestD = d; best = c; }
    }
    if (best && best.speed <= HAUL_STILL) {
      if (best.kind === 'shared') this.sharedTraffic.hold(best.id);
      this.haul = { id: best.id, kind: best.kind, car: best.car, phase: 'fly', at: now, from: [...best.position] as Position, fromHeading: best.heading, fromUp: groundUp(best.position) };
      return;
    }
    if (best) this.say(t('haul.moving'));
    // a wall within reach: the hook bites into it
    if (!best && target?.wall) {
      const reach = Math.hypot(metersBetween(nose, target.position), target.altitude - noseAlt);
      if (reach <= HAUL_REACH_M) {
        this.haul = { id: '', kind: 'wall', car: this.car, phase: 'fly', at: now, from: [...target.position] as Position, fromHeading: heading, fromUp: target.altitude - this.altitude, hookAlt: target.altitude };
        return;
      }
    }
    // nothing it can hold: out to its full length and back
    const far = metersBetween(nose, point);
    const end = far > HAUL_REACH_M ? [nose[0] + (point[0] - nose[0]) * HAUL_REACH_M / far, nose[1] + (point[1] - nose[1]) * HAUL_REACH_M / far] as Position : point;
    this.haul = { id: '', kind: 'wall', car: this.car, phase: 'miss', at: now, from: end, fromHeading: 0, fromUp: target?.wall ? Math.min(target.altitude - this.altitude, 4) : groundUp(end) + 0.4 };
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
      const t = k(HAUL_MISS_MS), out = t < 0.5 ? t * 2 : (1 - t) * 2;
      layer?.setCable({ position: mix(nose, haul.from, out), up: 0.9 + (haul.fromUp - 0.9) * out, wave: 1 });
      if (t >= 1) { layer?.setCable(null); this.haul = null; }
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
    let position: Position, up: number, facing: number;
    if (haul.phase === 'fly' || haul.phase === 'hooked') {
      position = haul.from; up = haul.fromUp; facing = haul.fromHeading;
      const t = haul.phase === 'fly' ? k(HAUL_FLY_MS) : 1;
      layer?.setCable({ position: mix(nose, haul.from, t), up: 0.9 + (haul.fromUp + 0.8 - 0.9) * t, wave: haul.phase === 'fly' ? 1 : quiver(haul.at) });
      if (haul.phase === 'fly' && t >= 1) { haul.phase = 'hooked'; haul.at = now; }
      // drove off too far with it on the line: the cable snaps
      if (haul.phase === 'hooked' && metersBetween(this.vehicle.position, haul.from) > HAUL_SNAP_M) { this.releaseHaul(null); return; }
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
    this.placeHauled(haul, position, facing);
    layer?.setCarried({ id: haul.id, position, heading: facing, up });
  }

  /** The catch's place in the world (so it bumps, is shot at and is seen by others where it is). */
  private placeHauled(haul: NonNullable<GameEngine['haul']>, position: Position, heading: number) {
    if (haul.kind === 'wall') return;
    if (haul.kind === 'shared') { this.sharedTraffic.place(haul.id, position, heading); return; }
    const bot = this.trafficBots.find(entry => entry.id === haul.id);
    if (!bot) return;
    bot.controller.position = [...position] as Position;
    bot.controller.heading = heading;
    bot.controller.speed = 0;
    bot.position = [...position] as Position;
    bot.heading = heading;
  }

  /** Let the catch go, standing at `at` (or where it is), finding its way again from there. */
  private releaseHaul(at: { position: Position; heading: number } | null) {
    const haul = this.haul;
    this.haul = null;
    this.combatLayer?.setCable(null);
    this.combatLayer?.setCarried(null);
    // off a wall: fall from where we hang
    if (this.hangAltitude != null) { this.hangAltitude = null; this.airborne = true; this.climb = 0; }
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
    this.syncErrandMarkers();
    this.bountyMarker?.remove();
    this.bountyMarker = null;
    this.raceGoalMarker?.remove();
    this.raceGoalMarker = null;
    this.raceGoalIndicator?.element.remove();
    this.raceGoalIndicator = null;
    this.ensureRaceGoalMarker();
    if (this.focusIndicator) this.focusIndicator.element.setAttribute('aria-label', t('marker.target'));
    this.selfMarker?.getElement().setAttribute('aria-label', t('you'));
    for (const pin of this.customPins) {
      const text = t('marker.pin');
      const span = pin.marker.getElement()?.querySelector('span');
      if (span) span.textContent = text;
      pin.marker.getElement()?.setAttribute('aria-label', text);
    }
    this.syncMissionVisuals();
    this.updateEventMarkers();
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
    const element = this.makeMapLabel('custom-map-marker', label, label);
    element.style.setProperty('--pin-color', color.main);
    element.style.pointerEvents = 'auto';
    const marker = this.marker({ element, anchor: 'bottom' }).setLngLat(position).addTo(this.map);
    const indicator = this.makeOffscreenIndicator('focus', label);
    indicator.element.classList.replace('mission-focus-indicator', 'custom-pin-indicator');
    indicator.element.style.setProperty('--pin-color', color.main);
    indicator.element.style.setProperty('--pin-soft', color.soft);
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

  /** Spawn a local wanted pin now and then; take the job and hunt within 10 km. */
  private updateBounty() {
    const now = performance.now();
    const here = this.vehicle.position;
    if (this.bountyPending && !this.bounty) {
      if (this.mode !== 'roam' || this.bountyFight || this.errand) return;
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
      const busy = this.mode !== 'roam' || this.errand || this.bountyPending || this.eventOffer || this.travelOpen || this.serviceOpen || this.dealerOpen || this.fuelOut;
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
    const bountyIndex = goals.findIndex(goal => goal.kind === 'bounty');
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
    if (!bounty || !this.driving || this.errand || (pending && !this.bountyPickup)) {
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
      this.paintMissionIndicator(this.bountyIndicator.element, 'bounty');
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
    if (this.focusIndicator && mission) this.paintMissionIndicator(this.focusIndicator.element, mission.missionKind);
    this.updateOffscreenMarker(this.focusIndicator, mission?.position ?? null, Boolean(mission), mission?.label);
    this.updateOffscreenMarker(this.raceGoalIndicator, this.raceGoal, this.driving && this.mode === 'race');
    const errand = this.errandTarget();
    if (errand && !this.errandIndicator && this.eventIndicatorLayer) {
      this.errandIndicator = this.makeOffscreenIndicator('focus', errand.label);
      this.eventIndicatorLayer.appendChild(this.errandIndicator.element);
    }
    if (errand && this.errandIndicator) this.paintMissionIndicator(this.errandIndicator.element, errand.kind);
    this.updateOffscreenMarker(this.errandIndicator, errand?.position ?? null, this.driving && Boolean(errand), errand?.label);
    this.syncCustomPinPointers();
    for (const pin of this.customPins) {
      this.updateOffscreenMarker(pin.indicator, pin.position, this.driving, t('marker.pin'));
      // in view the pin's own plaque says it all: no second name and distance over it
      if (pin.indicator.element.classList.contains('is-onscreen')) pin.indicator.element.style.display = 'none';
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
    // the label over the house the shop is in (the nearest one will do); drive up on the road in front
    const house = this.map.houseAt(station.position);
    const place = house?.middle ?? station.position;
    return { id: station.id, position: start ? [...start.position] : station.position, place, top: house?.top };
  }

  /** Real petrol stations from the POI layer; remembered as the player drives on. */
  private collectStations() {
    const pois = this.readSourceLayer('poi');
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
    const visible = [...this.stations.values()].filter(station => metersBetween(station.position, this.vehicle.position) < 2500);
    this.fuelLayer?.setStations(visible, this.settings.terrain);
    this.labelServices();
  }

  /** Map labels for the nearest fuel stations, car services and dealerships. */
  private labelServices() {
    const here = this.vehicle.position;
    type ServiceKind = 'fuel' | 'repair' | 'dealer' | 'bank' | CivicKind;
    const nearest = (list: Station[], limit = 10) => list
      .map(station => ({ station, d: metersBetween(station.position, here) }))
      .filter(item => item.d < 3000)
      .sort((a, b) => a.d - b.d)
      .slice(0, limit)
      .map(item => item.station);
    const wanted = new Map<string, { station: Station; kind: ServiceKind }>();
    for (const station of nearest([...this.stations.values()])) wanted.set(station.id, { station, kind: 'fuel' });
    for (const shop of nearest([...this.repairShops.values()])) wanted.set(shop.id, { station: shop, kind: 'repair' });
    for (const shop of nearest([...this.dealerships.values()])) wanted.set(shop.id, { station: shop, kind: 'dealer' });
    for (const bank of nearest([...this.banks.values()])) wanted.set(bank.id, { station: bank, kind: 'bank' });
    for (const kind of ['police', 'prison', 'court', 'hospital'] as CivicKind[]) {
      const list = [...this.civics.values()].filter(station => station.kind === kind);
      for (const station of nearest(list, 8)) wanted.set(station.id, { station, kind });
    }
    for (const [id, marker] of this.serviceMarkers) {
      if (wanted.has(id)) continue;
      marker.remove();
      this.serviceMarkers.delete(id);
    }
    const label: Record<ServiceKind, string> = {
      fuel: t('poi.fuel'), repair: t('poi.service'), dealer: t('poi.dealer'), bank: t('poi.bank'),
      police: t('poi.police'), prison: t('poi.prison'), court: t('poi.court'), hospital: t('poi.hospital'),
    };
    for (const [id, { station, kind }] of wanted) {
      // the houses come in after the roads: find the shop's house when they do
      if (station.top == null) {
        const house = this.map.houseAt(station.place ?? station.position);
        if (house) {
          station.place = house.middle;
          station.top = house.top;
          this.serviceMarkers.get(id)?.setLngLat(house.middle).setAltitude(house.top);
        }
      }
      if (this.serviceMarkers.has(id)) continue;
      const text = label[kind];
      this.serviceMarkers.set(id, this.marker({ element: this.makeMapLabel(`travel-hub-marker is-${kind}`, text, text), anchor: 'bottom' }).setLngLat(station.place ?? station.position).setAltitude(station.top ?? null).addTo(this.map));
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
    const station = atStation(this.vehicle.position, [...this.stations.values()]);
    const shop = atStation(this.vehicle.position, [...this.repairShops.values()]);
    const dealer = atStation(this.vehicle.position, [...this.dealerships.values()]);
    const now = performance.now();
    const bank = atStation(this.vehicle.position, [...this.banks.values()].filter((b) => (this.bankShut.get(b.id) ?? 0) <= now));
    this.refuelling = false;
    // arriving (slowly) at a station, service, showroom or bank opens its dialog once per visit
    const here = station ?? shop ?? dealer ?? bank;
    if (!here) this.offeredService = null;
    else if (here.id !== this.offeredService && Math.abs(this.vehicle.speed) < 7 && !this.serviceOpen && !this.dealerOpen && !this.bankOpen && !this.travelOpen && !this.fuelOut && this.mode === 'roam') {
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

  /** the camera is still flying in from the menu view (HUD waits for it) */
  get approaching() { return this.approachFrom != null; }

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
    if (this.hangAltitude != null) {
      // on the cable: held up there, no gravity
      this.altitude = this.hangAltitude;
      this.airborne = false;
      this.climb = 0;
      this.modelPitch = settle(this.modelPitch, 0);
      this.modelRoll = settle(this.modelRoll, 0);
      return;
    }
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
      let shore = false;
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
        if (gridded || this.hangAltitude != null) {
          // on the grid: revs may build (clutch launch), the car stays put; on the cable it hangs
          this.vehicle.position = previous;
          this.vehicle.heading = oldHeading;
          this.vehicle.speed = 0;
        }
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
          if (gridded || bot.id === this.haul?.id) continue;
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
    // players first: the bars must sit where their cars are drawn this frame, not the last one
    this.players.update();
    this.updateHealthMarkers(now - this.overlayTime > 100);
    this.updateTrafficMarkers();
    this.updateEventMarkers();
    this.updateSelfMarker();
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
      this.onFuel({ level: this.fuel.level, tank: this.fuel.spec.tank, rpm: this.vehicle.revs, refuelling: this.refuelling, station: near ? near.distance : null, money: Math.floor(this.playerMoney), hub: hubHud });
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
    this.clearCustomPins();
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
    this.offLang();
    this.selfMarker?.remove();
    this.healthMeters.dispose();
    this.cleanups.forEach((fn) => fn());
    this.map.remove();
  }
}
