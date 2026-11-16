import { cars as carsConfig, carPrice, vehicleConfig, type Car } from '@/config/vehicle.config';
import type { GameAudio } from '@/audio/GameAudio';
import type { VehicleSceneLayer } from '@/rendering/VehicleLayer';
import type { ThreeMap } from '@/world3d/map/ThreeMap';
import { formatNumber, t } from '@/i18n';
import { BuildingCollisions } from '../BuildingCollisions.ts';
import type { WaterCollisionController } from '../WaterCollisionController.ts';
import type { FuelTank } from '../Fuel.ts';
import type { SharedTraffic } from '../net/SharedTraffic.ts';
import type { EventResult } from '../offers.ts';
import type { CivicKind, Station } from '../poi.ts';
import { createTrafficBot, type TrafficBot, type TrafficRoadNetwork } from '../TrafficBots.ts';
import { offsetPosition, type Position, type VehicleController } from '../VehicleController.ts';
import type { VehiclePose } from '../VehiclePose.ts';
import { metersBetween } from '../meters.ts';
import {
  ARREST_COSTS, ARREST_FINE, BANK_CRACK_MS, BLACK_MARKET_SHARE, POLICE_GIVE_UP_M, POLICE_GIVE_UP_MS,
} from '../tuning.ts';

// Crime: robbing a bank (shoot it open, grab the cash), hijacking a parked car, and the
// police chase that follows — get 2 km ahead of every car to keep the loot, or be arrested.

/** on the run: how often a patrol in the traffic may join the chase (ms) */
const POLICE_JOIN_MS = 20_000;
/** the odds of a patrol joining at each POLICE_JOIN_MS check */
const POLICE_JOIN_CHANCE = 0.25;
/** no patrol joins once the nearest police car is this far behind (m): we are getting away */
const POLICE_JOIN_NEAR_M = 350;
/** the patrol car's top speed (Fleetline, m/s): a stolen car slower than this draws one patrol car at a time */
const POLICE_CAR_SPEED = 150 / 3.6;

/** the car we took in a hijack, and ours waiting for us (with its fuel) */
export type StolenCar = { carId: string; previousId: string; owned: boolean; fuel: number };

/**
 * A chase in progress (mode 'arena' for the guns and contacts): cash picked up so far,
 * police to send (a downed car calls two more), a touch or a wrecked car = arrest.
 */
export type HeistState = { cash: number; reinforce: number; sent: number; caught: boolean; joined?: number; joinAt?: number; stolen?: StolenCar };

/**
 * The police drive their own cars honestly: that car's pickup and top speed, no rubber band
 * to ours; the boost like ours on the straights. They got the call and pull away from a standstill.
 */
export function policePace(bot: { car: Car }) {
  return { ...vehicleConfig, acceleration: bot.car.acceleration, maxSpeed: bot.car.maxSpeed };
}

/** What a chase needs from the game. */
export interface HeistHost {
  mode: 'roam' | 'arena' | 'race';
  readonly bountyFight: boolean;
  readonly driving: boolean;
  readonly paused: boolean;
  onMission(): boolean;
  readonly banks: Map<string, Station>;
  readonly vehicle: VehicleController;
  readonly renderVehicle: VehiclePose;
  bearing: number;
  accumulator: number;
  readonly car: Car;
  readonly fuel: FuelTank;
  readonly garage: Set<string>;
  setCar(car: Car): void;
  onCarBought(car: Car): void;
  readonly collisions: BuildingCollisions;
  readonly water: WaterCollisionController;
  readonly map: ThreeMap;
  readonly mapLoaded: boolean;
  readonly combatLayer: VehicleSceneLayer | null;
  readonly sharedTraffic: SharedTraffic;
  readonly trafficNetwork: TrafficRoadNetwork;
  trafficBots: TrafficBot[];
  readonly pickups: Map<string, { position: [number, number]; color: string; kind: 'coin' | 'cash'; drop?: { from: [number, number]; at: number; up?: number } }>;
  nextDropId(): number;
  refreshPickups(): void;
  /** mission bots came or went: their markers and the shooting layer's targets */
  botsChanged(): void;
  forgetContacts(): void;
  hideEventBeacons(): void;
  showEventBeacons(): void;
  clearEventBots(): void;
  eventCooldown: number;
  playerHp: number;
  readonly playerMaxHp: number;
  playerMoney: number;
  onEventResult(result: EventResult | null): void;
  readonly audio: GameAudio;
  nearestCivic(): { station: Station; kind: CivicKind; distance: number } | null;
  nearbyRoadSpot(): Position | null;
  placeCarAt(position: Position): void;
  say(text: string, toast?: boolean): void;
}

/** A bank job or a hijack, and the police after us. */
export class Heist {
  /** the chase on now, if any */
  heist: HeistState | null = null;
  /** a robbed bank stays shut until this time (ms) */
  readonly bankShut = new Map<string, number>();
  /** shots landing on a bank right now: which one and for how long */
  private bankShots: { id: string; ms: number; last: number } | null = null;
  /** when each police car fell that far behind (it gives up after POLICE_GIVE_UP_MS) */
  readonly policeFar = new Map<string, number>();
  /** the parked car we last told the player about (H to hijack) */
  private hijackHintFor: string | null = null;

  constructor(private host: HeistHost) {}

  /** A bullet hit a wall: on a bank's house, three seconds of fire crack it open. */
  bankShot(point: [number, number]) {
    if (this.host.mode !== 'roam' || this.host.bountyFight || !this.host.driving || this.host.onMission()) return;
    const now = performance.now();
    let bank: Station | null = null;
    for (const candidate of this.host.banks.values()) {
      if (metersBetween(point, candidate.place ?? candidate.position) > 22) continue;
      if (metersBetween(this.host.vehicle.position, candidate.place ?? candidate.position) > 36) continue;
      if ((this.bankShut.get(candidate.id) ?? 0) > now) { this.host.say(t('heist.shut')); return; }
      bank = candidate;
      break;
    }
    if (!bank) return;
    const shots = this.bankShots;
    if (!shots || shots.id !== bank.id || now - shots.last > 450) {
      this.bankShots = { id: bank.id, ms: 0, last: now };
      this.host.say(t('heist.cracking'), true);
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
      if (this.host.collisions.sightBlocked(bank.position, rest)) rest = [...bank.position] as [number, number];
      this.host.pickups.set(`cash:${this.host.nextDropId()}`, { position: rest, color: '#3f8f4e', kind: 'cash', drop: { from: [...from] as [number, number], at: now } });
    }
    this.host.refreshPickups();
    this.startChase();
    this.host.say(t('heist.alarm'), true);
  }

  /** Three police cars come for us (a bank job or a hijack); `stolen`: the car we took. */
  private startChase(stolen?: { carId: string; previousId: string; owned: boolean; fuel: number }) {
    this.host.trafficBots = [];
    this.heist = { cash: 0, reinforce: 0, sent: 0, caught: false, stolen };
    this.host.mode = 'arena';
    this.host.forgetContacts();
    this.host.hideEventBeacons();
    this.sendPolice(3);
  }

  /** H beside a parked car (ours or somebody else's): get in and drive off — the police come. */
  tryHijack() {
    if (!this.host.driving || this.host.paused || this.host.mode !== 'roam' || this.host.bountyFight) return;
    if (this.host.onMission()) { this.host.say(t('mission.busy'), true); return; }
    const near = this.host.sharedTraffic.parkedNear(this.host.vehicle.position, 4.5);
    if (!near) { this.host.say(t('hijack.none'), true); return; }
    if (Math.abs(this.host.vehicle.speed) > 2.5) { this.host.say(t('hijack.slow'), true); return; }
    this.host.sharedTraffic.takeParked(near.id);
    const previous = this.host.car;
    // our own tank waits with our car; the stolen one has whatever its owner left in it
    const ourFuel = this.host.fuel.level;
    // a stolen car never joins the garage: get away and it goes to the black market
    const owned = this.host.garage.has(near.car.id);
    this.host.setCar(near.car);
    this.host.onCarBought(near.car);
    this.host.fuel.level = this.host.fuel.spec.tank * (0.25 + Math.random() * 0.6);
    // we sit in it where it stood; our own car waits in the garage
    this.host.vehicle.position = [...near.position] as [number, number];
    this.host.vehicle.heading = near.heading;
    this.host.vehicle.speed = 0;
    this.host.vehicle.throttle = 0;
    this.host.bearing = this.host.vehicle.heading * 180 / Math.PI;
    this.host.renderVehicle.reset(this.host.vehicle);
    this.host.accumulator = 0;
    this.startChase({ carId: near.car.id, previousId: previous.id, owned, fuel: ourFuel });
    this.host.say(t('hijack.started', { car: near.car.name }), true);
  }

  /** A word when we stop beside a parked car. */
  hijackHint() {
    if (!this.host.driving || this.host.mode !== 'roam' || this.host.onMission() || Math.abs(this.host.vehicle.speed) > 2.5) return;
    const near = this.host.sharedTraffic.parkedNear(this.host.vehicle.position, 4.5);
    if (!near || near.id === this.hijackHintFor) return;
    this.hijackHintFor = near.id;
    this.host.say(t('hijack.hint', { car: near.car.name }), true);
  }

  /**
   * Free ground 100–200 m from us, roughly toward `angle`: no road needed (they cut across
   * yards and squares anyway), just not inside a house or in the water. The old road pick
   * (sampled randomAway) missed and fell back to any node, often ~1 km off.
   */
  private policeSpawn(me: [number, number], angle: number, taken: [number, number][], far = false): [number, number] | null {
    // the first call: 100–200 m, they pull away at once; reinforcements drive in from farther
    for (const r of far ? [550, 480, 620, 450, 650] : [150, 120, 180, 105, 195]) {
      for (const turn of [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05]) {
        const a = angle + turn;
        const spot = offsetPosition(me, Math.sin(a) * r, Math.cos(a) * r) as [number, number];
        // our collision set only reaches 260 m: farther, ask the houses round the spot itself
        let walls = this.host.collisions;
        if (far) {
          walls = new BuildingCollisions();
          walls.update(spot, this.host.map.world.buildingsNear(spot, 30, this.host.map.exaggeration));
        }
        if (walls.blocked(spot, spot, a + Math.PI) || this.host.water.covers(spot, true)) continue;
        if (taken.some((other) => metersBetween(other, spot) < 12)) continue;
        taken.push(spot);
        return spot;
      }
    }
    return null;
  }

  /** Police cars 100–200 m out (reinforcements: 450–650 m), spread round us, coming in. */
  private sendPolice(count: number, far = false) {
    const heist = this.heist;
    if (!heist) return;
    const me = this.host.vehicle.position as [number, number];
    const used = new Set<string>();
    const base = Math.random() * Math.PI * 2;
    const police = carsConfig.filter((car) => car.id === '09' || car.id === '16');
    const spots: [number, number][] = [];
    for (let k = 0; k < count && heist.sent < 14; k++) {
      const angle = base + (k / count) * Math.PI * 2;
      const spot = this.policeSpawn(me, angle, spots, far);
      const r = far ? 550 : 150;
      const around = spot ?? offsetPosition(me, Math.sin(angle) * r, Math.cos(angle) * r) as [number, number];
      const car = police[(heist.sent + k) % police.length] ?? carsConfig[0];
      const bot = createTrafficBot(`police-${heist.sent}`, t('heist.police'), car, this.host.trafficNetwork, around, angle + Math.PI, used, 'hunt', (heist.sent + 1) * 7919, { min: 0, max: 70 });
      if (spot) {
        // stand exactly there, facing us; the first path is found from here
        const heading = Math.atan2(
          (me[0] - spot[0]) * Math.cos(spot[1] * Math.PI / 180),
          me[1] - spot[1],
        );
        bot.controller.position = [...spot];
        bot.controller.heading = heading;
        bot.controller.speed = 0;
        bot.position = [...spot];
        bot.heading = heading;
        bot.route = [];
        bot.routeIndex = 1;
        bot.repathAt = 0;
      }
      heist.sent++;
      this.host.trafficBots.push(bot);
    }
    this.host.botsChanged();
  }

  /** The chase: police shoot to kill; a touch or a wrecked car is an arrest. 1 km ahead = freedom. */
  update() {
    const heist = this.heist!;
    if (heist.reinforce > 0) {
      // reinforcements drive in from farther, not out of thin air beside us
      this.sendPolice(heist.reinforce, true);
      heist.reinforce = 0;
    }
    // on the run, a patrol out in the traffic may spot us and join in: every 20 s one
    // chance in four (a slow stolen car is a long chase), 1–3 cars at a time, up to 6 after us at once (14 in a chase at most, see sendPolice)
    const nowJoin = performance.now();
    heist.joinAt ??= nowJoin + POLICE_JOIN_MS;
    if (nowJoin >= heist.joinAt) {
      heist.joinAt = nowJoin + POLICE_JOIN_MS;
      const hunters = this.host.trafficBots.filter((bot) => bot.id.startsWith('police') && this.host.combatLayer?.isTargetAlive(bot.id) !== false);
      const after = hunters.length;
      // pulling away from them (the nearest well behind): nobody new takes it up
      const nearest = Math.min(...hunters.map((bot) => metersBetween(this.host.vehicle.position, bot.position)));
      if (after > 0 && after < 6 && nearest < POLICE_JOIN_NEAR_M && Math.random() < POLICE_JOIN_CHANCE) {
        heist.joined = (heist.joined ?? 0) + 1;
        // a patrol is one to three cars at a time; one in a car slower than theirs
        const slow = this.host.car.maxSpeed < POLICE_CAR_SPEED;
        const patrol = slow ? 1 : 1 + Math.floor(Math.random() * 3);
        this.sendPolice(Math.min(patrol, 6 - after), true);
        this.host.say(t('heist.joined'), true);
      }
    }
    if (this.host.playerHp > 0 && this.host.playerHp <= this.host.playerMaxHp * 0.35) this.host.combatLayer?.burnPlayer();
    if (heist.caught || this.host.playerHp <= 0) {
      this.arrest();
      return;
    }
    // police left far behind give up
    const me = this.host.vehicle.position;
    const chasing = this.host.trafficBots.filter((bot) => this.host.combatLayer?.isTargetAlive(bot.id) !== false);
    const now = performance.now();
    for (const bot of chasing) {
      if (metersBetween(bot.position, me) > POLICE_GIVE_UP_M) { if (!this.policeFar.has(bot.id)) this.policeFar.set(bot.id, now); }
      else this.policeFar.delete(bot.id);
    }
    const behind = chasing.filter((bot) => now - (this.policeFar.get(bot.id) ?? now) > POLICE_GIVE_UP_MS);
    if (behind.length) {
      const gone = new Set(behind.map((bot) => bot.id));
      this.host.trafficBots = this.host.trafficBots.filter((bot) => !gone.has(bot.id));
      this.host.botsChanged();
      if (this.host.trafficBots.some((bot) => this.host.combatLayer?.isTargetAlive(bot.id))) this.host.say(t('heist.lost'), true);
    }
    if (!this.host.trafficBots.some((bot) => this.host.combatLayer?.isTargetAlive(bot.id) !== false)) this.endHeist();
  }

  /** Got away: keep the cash. */
  private endHeist() {
    const cash = this.heist?.cash ?? 0;
    const stolen = this.heist?.stolen;
    this.heist = null;
    this.host.mode = 'roam';
    this.host.clearEventBots();
    this.host.showEventBeacons();
    this.host.eventCooldown = performance.now() + 8000;
    if (stolen) {
      // got away in a stolen car: the fence pays half its price and we split it with the crew —
      // a quarter is ours; we're back in our own car
      const sold = carsConfig.find((car) => car.id === stolen.carId);
      const price = sold ? Math.round(carPrice(sold) * BLACK_MARKET_SHARE) : 0;
      this.host.playerMoney += price;
      const previous = carsConfig.find((car) => car.id === stolen.previousId);
      if (previous) { this.host.setCar(previous); this.host.onCarBought(previous); this.host.fuel.level = Math.min(this.host.fuel.spec.tank, stolen.fuel); }
      this.host.onEventResult({ kind: 'hijack', won: true, cash: price, name: sold?.name ?? '' });
    } else this.host.onEventResult({ kind: 'heist', won: true, cash });
  }

  /** Arrested: car blows up; wake at the nearest police / prison / court / hospital with a fat bill. */
  private arrest() {
    const heist = this.heist!;
    const stolen = heist.cash;
    // a hijacked car goes back to its owner; we are in our own again
    if (heist.stolen) {
      const previous = carsConfig.find((car) => car.id === heist.stolen!.previousId);
      // our own car, with our own fuel as we left it
      if (previous) { this.host.setCar(previous); this.host.onCarBought(previous); this.host.fuel.level = Math.min(this.host.fuel.spec.tank, heist.stolen.fuel); }
    }
    this.heist = null;
    this.host.mode = 'roam';
    this.host.clearEventBots();
    this.host.showEventBeacons();
    this.host.eventCooldown = performance.now() + 8000;
    // the cash still lying about goes back to the bank
    for (const [id, pickup] of this.host.pickups) if (pickup.kind === 'cash') this.host.pickups.delete(id);
    this.host.refreshPickups();
    this.host.combatLayer?.explodePlayer();
    this.host.audio.explosion(null);
    const drop = this.host.nearestCivic();
    const kind = drop?.kind ?? null;
    const fine = (kind ? ARREST_COSTS[kind] : ARREST_FINE) + stolen;
    this.host.playerMoney = Math.max(0, this.host.playerMoney - fine);
    this.host.playerHp = this.host.playerMaxHp;
    const arrestSpot = drop ? drop.station.position : this.host.nearbyRoadSpot();
    if (arrestSpot && this.host.mapLoaded) this.host.placeCarAt(arrestSpot);
    else {
      this.host.vehicle.speed = 0;
      this.host.vehicle.throttle = 0;
      this.host.renderVehicle.reset(this.host.vehicle);
      this.host.accumulator = 0;
    }
    const messages = {
      police: 'heist.arrested.police',
      prison: 'heist.arrested.prison',
      court: 'heist.arrested.court',
      hospital: 'heist.arrested.hospital',
    } as const;
    const message = t(kind ? messages[kind] : 'heist.arrested', { fine: formatNumber(fine) });
    this.host.onEventResult({ kind: 'arrest', won: false, cash: fine, name: message });
  }
}
