import { cars as carsConfig } from '@/config/vehicle.config';
import { type Position } from '../VehicleController.ts';
import { completeFireCall, createFireCallState, onFireWindowOut as noteFireWindowOut, startFireCall, suspendFireCall, updateFireCall, type FireCallWorld } from '../missions/fireCall.ts';
import { acceptTaxiFare, createTaxiFareState, declineTaxiFare, suspendTaxiFare, updateTaxiFare, type TaxiFareWorld } from '../missions/taxiFare.ts';
import { acceptAmbulanceCall, createAmbulanceCallState, declineAmbulanceCall, suspendAmbulanceCall, updateAmbulanceCall, type AmbulanceCallWorld } from '../missions/ambulanceCall.ts';
import { createBusStopState, updateBusStops, type BusStopWorld } from '../missions/busStop.ts';
import { acceptBusTour, createBusTourState, declineBusTour, suspendBusTour, updateBusTour, type BusTourWorld } from '../missions/busTour.ts';
import { createTrafficBot } from '../TrafficBots.ts';
import { formatNumber, t } from '@/i18n';
import { atStation, nearestStation, SERVICE_REACH, type Station } from '../poi.ts';
import { metersBetween } from '../meters.ts';
import { JobPin } from '../hud/mapPins.ts';
import type { RideOffer as RideOfferType } from '../offers.ts';
import { AMBULANCE_HOSPITAL_M, isAmbulanceWreckId, BUS_ID, FIRE_TRUCK_ID, HAULER_ID, IMPOUND_ARRIVE_M, IMPOUND_REWARD, POLICE_IDS, TOW_CAR_ID } from '../tuning.ts';
import type { GameEngine } from '../GameEngine.ts';

/** What this part reads and drives in the game. */
export type JobsGame = Pick<GameEngine, 'board' | 'civics' | 'combatLayer' | 'dialogOpen' | 'driving' | 'hauler' | 'isAmbulance' | 'isBus' | 'isFireTruck' | 'isHauler' | 'isTaxi' | 'landmarks' | 'map' | 'mode' | 'onEventResult' | 'pickBeaconSpot' | 'playerMoney' | 'say' | 'setAmbulanceScene' | 'targetVehicles' | 'trafficBots' | 'trafficNetwork' | 'vehicle' | 'wanted'>;

/**
 * The special cars' jobs: fire calls for the fire truck, fares for the taxi, crash and fire
 * victims for the ambulance, stops and tours for the bus, impound runs for the Howler —
 * their offers, their goals and their pins.
 */
export class Jobs {
  constructor(private game: JobsGame) {}

  /** fire call (fire truck only): marker → burning house → put out every window */
  fire = createFireCallState();

  /** taxi fare (Chevy Taxi): marker → told the address → drop-off pays 100/km */
  taxi = createTaxiFareState();

  /** ambulance: crash or burned house → hospital, 1000 per victim */
  ambulance = createAmbulanceCallState();

  /** city bus: approach OSM bus stops → board/alight modal + coins */
  bus = createBusStopState();

  busStops = new Map<string, Station>();

  /** bus tour: group → named hotel/museum */
  busTour = createBusTourState();

  /** Howler: marker → load a car → any police station for a premium */
  impoundPickup: [number, number] | null = null;

  impoundActive = false;

  impoundSpot: [number, number] | null = null;

  impoundOfferAt = performance.now() + 25000;

  impoundDeliveredAt = 0;

  /** the special cars' job pins on the map */
  jobPins = {
    fire: new JobPin('fire-map-marker', 'fire'),
    impound: new JobPin('impound-map-marker', 'impound'),
    taxi: new JobPin('taxi-map-marker', 'taxi'),
    ambulance: new JobPin('ambulance-map-marker', 'ambulance'),
    bus: new JobPin('bus-map-marker', 'bus'),
  };

  onRideOffer: (offer: RideOfferType | null) => void = () => {};

  fireWorld(): FireCallWorld {
    const avoid = this.game.board.missions.map((mission) => mission.position);
    if (this.game.wanted.pickup) avoid.push(this.game.wanted.pickup);
    return {
      position: this.game.vehicle.position,
      heading: this.game.vehicle.heading,
      mode: this.game.mode,
      busy: Boolean(this.game.dialogOpen()),
      bountyFight: this.game.wanted.fight,
      errand: Boolean(this.game.board.errand),
      onMission: this.game.board.onMission(),
      avoid,
      fireFacadesNear: (at, radius) => this.game.map.fireFacadesNear(at, radius),
      pickBeaconSpot: (here, heading, seed, spots) => this.game.pickBeaconSpot(here, heading, seed, spots),
      setFireHouse: (site) => this.game.combatLayer?.setFireHouse(site),
      syncMissionVisuals: (show) => this.game.board.syncMissionVisuals(show),
      say: (text, toast) => this.game.say(text, toast),
      addMoney: (amount) => { this.game.playerMoney += amount; },
      onResult: (cash, windows) => this.game.onEventResult({ kind: 'fire', won: true, cash, name: String(windows) }),
    };
  }

  /** Fire truck: a house is already burning when the call appears — drive over and hose the windows. */
  updateFire() {
    if (!this.game.isFireTruck()) return;
    updateFireCall(this.fire, this.fireWorld());
  }

  startFire() {
    startFireCall(this.fire, this.fireWorld());
  }

  onFireWindowOut(left: number) {
    noteFireWindowOut(this.fire, this.fireWorld(), left);
  }

  completeFire(windows: number) {
    completeFireCall(this.fire, this.fireWorld(), windows);
  }

  /** Leave a fire call when swapping off the truck (progress is lost). */
  suspendFire() {
    suspendFireCall(this.fire, this.fireWorld());
  }

  taxiWorld(): TaxiFareWorld {
    const avoid = this.game.board.missions.map((mission) => mission.position);
    if (this.game.wanted.pickup) avoid.push(this.game.wanted.pickup);
    if (this.fire.pickup) avoid.push(this.fire.pickup);
    if (this.impoundPickup) avoid.push(this.impoundPickup);
    return {
      position: this.game.vehicle.position,
      heading: this.game.vehicle.heading,
      mode: this.game.mode,
      busy: Boolean(this.game.dialogOpen() || this.taxi.pending || this.busTour.pending),
      bountyFight: this.game.wanted.fight,
      errand: Boolean(this.game.board.errand),
      onMission: this.game.board.onMission(),
      avoid,
      pickBeaconSpot: (here, heading, seed, spots) => this.game.pickBeaconSpot(here, heading, seed, spots),
      pickDropoff: (from, minM, maxM, seed) =>
        this.game.trafficNetwork.randomAway(from, new Set(), minM, maxM, seed)?.position ?? null,
      syncMissionVisuals: (show) => this.game.board.syncMissionVisuals(show),
      say: (text, toast) => this.game.say(text, toast),
      addMoney: (amount) => { this.game.playerMoney += amount; },
      onOffer: (offer) => this.onRideOffer(offer),
      onResult: (cash, km) => this.game.onEventResult({ kind: 'taxi', won: true, cash, name: String(km) }),
    };
  }

  updateTaxi() {
    if (!this.game.isTaxi()) return;
    updateTaxiFare(this.taxi, this.taxiWorld());
  }

  /** Leave a fare when swapping off the taxi (progress is lost). */
  suspendTaxi() {
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

  ambulanceWorld(): AmbulanceCallWorld {
    const avoid = this.game.board.missions.map((mission) => mission.position);
    if (this.game.wanted.pickup) avoid.push(this.game.wanted.pickup);
    if (this.fire.pickup) avoid.push(this.fire.pickup);
    if (this.impoundPickup) avoid.push(this.impoundPickup);
    if (this.taxi.pickup) avoid.push(this.taxi.pickup);
    return {
      position: this.game.vehicle.position,
      heading: this.game.vehicle.heading,
      mode: this.game.mode,
      busy: Boolean(this.game.dialogOpen() || this.taxi.pending || this.busTour.pending || this.ambulance.pending),
      bountyFight: this.game.wanted.fight,
      errand: Boolean(this.game.board.errand),
      onMission: this.game.board.onMission(),
      avoid,
      pickBeaconSpot: (here, heading, seed, spots) => this.game.pickBeaconSpot(here, heading, seed, spots),
      nearestHospital: (from) => {
        // Victim calls need a hospital within 10 km. Prefer a 2–8 km drive when
        // one exists; otherwise the nearest inside 10 km (even if closer).
        const PREFER_MIN = 2000;
        const PREFER_MAX = 8000;
        const REACH = 10000;
        const list = [...this.game.civics.values()].filter((s) => s.kind === 'hospital');
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
      setScene: (kind, at) => this.game.setAmbulanceScene(kind, at),
      syncMissionVisuals: (show) => this.game.board.syncMissionVisuals(show),
      say: (text, toast) => this.game.say(text, toast),
      addMoney: (amount) => { this.game.playerMoney += amount; },
      onOffer: (offer) => this.onRideOffer(offer),
      onResult: (cash, victims) => this.game.onEventResult({ kind: 'ambulance', won: true, cash, name: String(victims) }),
    };
  }

  updateAmbulance() {
    if (!this.game.isAmbulance()) return;
    // keep crash wrecks planted (same as the impound wait car)
    if (this.ambulance.pickup && this.ambulance.cars > 0) {
      for (const wreck of this.game.trafficBots) {
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
      && metersBetween(this.game.vehicle.position, this.ambulance.goal) <= AMBULANCE_HOSPITAL_M
      && Math.abs(this.game.vehicle.speed) > 7) return;
    updateAmbulanceCall(this.ambulance, this.ambulanceWorld());
  }

  suspendAmbulance() {
    suspendAmbulanceCall(this.ambulance, this.ambulanceWorld());
  }

  busWorld(): BusStopWorld {
    return {
      position: this.game.vehicle.position,
      mode: this.game.mode,
      busy: Boolean(this.game.dialogOpen() || this.busTour.active || this.busTour.pickup || this.busTour.pending || this.taxi.pending),
      stops: [...this.busStops.values()],
      say: (text, toast) => this.game.say(text, toast),
      addMoney: (amount) => { this.game.playerMoney += amount; },
      onResult: (cash, action, passengers) => this.game.onEventResult({ kind: 'bus', won: true, cash, name: `${action}:${passengers}` }),
    };
  }

  busTourWorld(): BusTourWorld {
    const avoid = this.game.board.missions.map((mission) => mission.position);
    if (this.game.wanted.pickup) avoid.push(this.game.wanted.pickup);
    if (this.fire.pickup) avoid.push(this.fire.pickup);
    if (this.impoundPickup) avoid.push(this.impoundPickup);
    if (this.taxi.pickup) avoid.push(this.taxi.pickup);
    return {
      position: this.game.vehicle.position,
      heading: this.game.vehicle.heading,
      mode: this.game.mode,
      busy: Boolean(this.game.dialogOpen() || this.taxi.pending || this.busTour.pending),
      bountyFight: this.game.wanted.fight,
      errand: Boolean(this.game.board.errand),
      onMission: this.game.board.onMission(),
      avoid,
      landmarks: [...this.game.landmarks.values()],
      pickBeaconSpot: (here, heading, seed, spots) => this.game.pickBeaconSpot(here, heading, seed, spots),
      syncMissionVisuals: (show) => this.game.board.syncMissionVisuals(show),
      say: (text, toast) => this.game.say(text, toast),
      addMoney: (amount) => { this.game.playerMoney += amount; },
      onOffer: (offer) => this.onRideOffer(offer),
      onResult: (cash, passengers, kind, place) =>
        this.game.onEventResult({ kind: 'bus', won: true, cash, name: `tour:${kind}:${passengers}:${place}` }),
    };
  }

  updateBus() {
    if (!this.game.isBus()) {
      this.bus.at = null;
      return;
    }
    updateBusTour(this.busTour, this.busTourWorld());
    updateBusStops(this.bus, this.busWorld());
  }

  suspendBusTour() {
    suspendBusTour(this.busTour, this.busTourWorld());
  }

  /** Nearest police station pin while hauling the impound car (any station counts). */
  impoundDropPin(): [number, number] | null {
    if (!this.carryingImpound()) return null;
    const list = [...this.game.civics.values()].filter((s) => s.kind === 'police');
    const near = nearestStation(this.game.vehicle.position, list);
    return near ? [...near.station.position] as [number, number] : null;
  }

  carryingImpound() {
    const haul = this.game.hauler.haul;
    // only the car on the bed counts — empty visits to police do nothing
    return Boolean(this.impoundActive && haul && haul.id === TOW_CAR_ID && haul.phase === 'carry');
  }

  /** Howler: marker → load the car → deliver to any police station for a premium. */
  updateImpound() {
    if (!this.game.isHauler()) return;
    const now = performance.now();
    const here = this.game.vehicle.position;
    if (this.impoundActive) {
      // car wrecked / gone: cancel and try again later
      if (!this.game.trafficBots.some((b) => b.id === TOW_CAR_ID) && this.game.hauler.haul?.id !== TOW_CAR_ID) {
        this.failImpound();
        return;
      }
      // keep the waiting car planted until the hook takes it
      const bot = this.game.trafficBots.find((b) => b.id === TOW_CAR_ID);
      if (bot && this.game.hauler.haul?.id !== TOW_CAR_ID && this.impoundSpot) {
        bot.controller.speed = 0;
        bot.controller.position = [...this.impoundSpot] as Position;
        bot.position = [...this.impoundSpot] as Position;
      }
      // only when the car is on the bed (or hooked/pulling) — empty visits to police do nothing
      if (this.carryingImpound() && now > this.impoundDeliveredAt) {
        const police = atStation(here, [...this.game.civics.values()].filter((s) => s.kind === 'police'), SERVICE_REACH.civic);
        if (police && Math.abs(this.game.vehicle.speed) < 7) this.completeImpound();
      }
      return;
    }
    if (this.impoundPickup) {
      if (this.game.mode === 'roam' && !this.game.wanted.fight && !this.game.board.errand && !this.fire.active
        && metersBetween(here, this.impoundPickup) <= IMPOUND_ARRIVE_M) this.startImpound();
      return;
    }
    if (this.game.mode !== 'roam' || this.game.wanted.fight || this.game.board.errand || this.game.board.onMission()) return;
    const busy = this.game.dialogOpen();
    if (busy || now < this.impoundOfferAt) return;
    const seed = Math.round(here[0] * 1e5) ^ Math.round(here[1] * 1e5) ^ (now | 0);
    const avoid = this.game.board.missions.map((mission) => mission.position);
    if (this.game.wanted.pickup) avoid.push(this.game.wanted.pickup);
    if (this.fire.pickup) avoid.push(this.fire.pickup);
    if (this.taxi.pickup) avoid.push(this.taxi.pickup);
    this.impoundPickup = this.game.pickBeaconSpot(here as [number, number], this.game.vehicle.heading, seed ^ 0x70a1, avoid);
    this.game.board.syncMissionVisuals(true);
    this.game.say(t('mission.new', { label: t('impound.goal') }), true);
  }

  startImpound() {
    if (!this.impoundPickup || this.impoundActive) return;
    this.impoundActive = true;
    this.impoundSpot = this.impoundPickup;
    this.impoundPickup = null;
    const heading = this.game.vehicle.heading;
    const seed = Math.round(this.impoundSpot[0] * 1e5) ^ Math.round(this.impoundSpot[1] * 1e5);
    const choices = carsConfig.filter((car) => car.id !== HAULER_ID && car.id !== FIRE_TRUCK_ID && car.id !== BUS_ID && !POLICE_IDS.has(car.id));
    const car = choices[Math.abs(seed) % choices.length] ?? carsConfig[0];
    // plant a still car exactly on the pin (createTrafficBot would wander off)
    const bot = createTrafficBot(TOW_CAR_ID, t('impound.driver'), car, this.game.trafficNetwork, this.impoundSpot, heading, new Set(), 'explore', seed, { min: 0, max: 40 });
    bot.controller.position = [...this.impoundSpot] as Position;
    bot.controller.heading = heading;
    bot.controller.speed = 0;
    bot.position = [...this.impoundSpot] as Position;
    bot.heading = heading;
    bot.route = [];
    bot.goal = null;
    this.game.trafficBots = [...this.game.trafficBots.filter((b) => b.id !== TOW_CAR_ID), bot];
    this.game.combatLayer?.setTargets(this.game.targetVehicles());
    this.game.board.syncMissionVisuals(true);
    this.game.say(t('impound.start', { car: car.name, reward: formatNumber(IMPOUND_REWARD) }), true);
  }

  completeImpound() {
    if (!this.impoundActive) return;
    this.impoundActive = false;
    this.impoundSpot = null;
    this.impoundDeliveredAt = performance.now() + 2000;
    // take the car off the bed and scrap it at the station
    if (this.game.hauler.haul?.id === TOW_CAR_ID) this.game.hauler.lose();
    else {
      this.game.trafficBots = this.game.trafficBots.filter((b) => b.id !== TOW_CAR_ID);
      this.game.combatLayer?.setTargets(this.game.targetVehicles());
    }
    this.game.playerMoney += IMPOUND_REWARD;
    this.impoundOfferAt = performance.now() + 50000;
    this.game.board.syncMissionVisuals(true);
    this.game.onEventResult({ kind: 'impound', won: true, cash: IMPOUND_REWARD });
  }

  failImpound() {
    this.impoundActive = false;
    this.impoundSpot = null;
    this.game.trafficBots = this.game.trafficBots.filter((b) => b.id !== TOW_CAR_ID);
    this.game.combatLayer?.setTargets(this.game.targetVehicles());
    this.impoundOfferAt = performance.now() + 20000;
    this.game.board.syncMissionVisuals(true);
    this.game.say(t('impound.lost'), true);
  }

  suspendImpound() {
    if (this.impoundActive) {
      if (this.game.hauler.haul?.id === TOW_CAR_ID) this.game.hauler.lose();
      this.impoundActive = false;
      this.impoundSpot = null;
      this.game.trafficBots = this.game.trafficBots.filter((b) => b.id !== TOW_CAR_ID);
      this.game.combatLayer?.setTargets(this.game.targetVehicles());
      this.impoundOfferAt = performance.now() + 12000;
      this.game.say(t('impound.aborted'), true);
    }
    this.game.board.syncMissionVisuals(true);
  }

  /** Whether a special car's job pin is up: in that car, driving, nothing bigger on. */
  jobPinShown(inCar: boolean) {
    return inCar && this.game.driving && !this.game.board.errand && !this.game.wanted.fight;
  }

  updateFireMarkers() {
    const pin = this.fire.active ? this.fire.spot : this.fire.pickup;
    this.jobPins.fire.show(this.game.map, this.jobPinShown(this.game.isFireTruck()) ? pin : null, this.fire.active ? t('fire.marker.active') : t('fire.marker'));
  }

  /** Map label for the Howler impound job; HUD tip comes from the focus cycle. */
  updateImpoundMarkers() {
    const drop = this.impoundDropPin();
    const pin = this.impoundActive ? (drop ?? this.impoundSpot) : this.impoundPickup;
    const title = drop ? t('impound.marker.drop') : this.impoundActive ? t('impound.marker.car') : t('impound.marker');
    this.jobPins.impound.show(this.game.map, this.jobPinShown(this.game.isHauler()) ? pin : null, title);
  }

  /** Map label for the taxi fare; HUD tip comes from the focus cycle. */
  updateTaxiMarkers() {
    const pin = this.taxi.active ? this.taxi.goal : this.taxi.pickup;
    this.jobPins.taxi.show(this.game.map, this.jobPinShown(this.game.isTaxi()) ? pin : null, this.taxi.active ? t('taxi.marker.drop') : t('taxi.marker'));
  }

  /** Map label for the ambulance call; HUD tip comes from the focus cycle. */
  updateAmbulanceMarkers() {
    const pin = this.ambulance.active ? this.ambulance.goal : this.ambulance.pickup;
    const title = this.ambulance.active
      ? t('ambulance.marker.drop')
      : this.ambulance.site === 'burn' ? t('ambulance.marker.burn') : t('ambulance.marker.crash');
    this.jobPins.ambulance.show(this.game.map, this.jobPinShown(this.game.isAmbulance()) ? pin : null, title);
  }

  /** Map label for the bus tour; HUD tip comes from the focus cycle. */
  updateBusTourMarkers() {
    const pin = this.busTour.active ? this.busTour.goal : this.busTour.pickup;
    this.jobPins.bus.show(this.game.map, this.jobPinShown(this.game.isBus()) ? pin : null, this.busTour.active ? (this.busTour.place || t('bus.drop')) : t('bus.marker'));
  }
}
