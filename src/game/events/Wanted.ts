import { cars as carsConfig, type City } from '@/config/vehicle.config';
import type { ThreeMap } from '@/world3d/map/ThreeMap';
import { formatNumber, t } from '@/i18n';
import { BOUNTY_RANGE_KM, loadBounty, makeBounty, saveBounty, type Bounty } from '../Bounty.ts';
import type { BountyOffer, EventResult } from '../offers.ts';
import { kilometres } from '../Travel.ts';
import { createTrafficBot, type TrafficBot, type TrafficRoadNetwork } from '../TrafficBots.ts';
import type { VehicleController } from '../VehicleController.ts';
import { MARKER_PIN_METERS } from '../hud/indicators.ts';
import { makeMapLabel, makeOffscreenIndicator, newMarker, paintMissionIndicator, type MapMarker } from '../hud/mapPins.ts';
import { metersBetween } from '../meters.ts';
import { MISSION_COLORS, MISSION_PICKUP_M } from '../tuning.ts';

type Indicator = { element: HTMLElement; arrow: HTMLElement; title: HTMLElement; distance: HTMLElement };

/** What the hunt for a wanted car needs from the game. */
export interface WantedHost {
  /** we drive a car that takes wanted jobs (the police, the Batmobile) */
  canHuntBounty(): boolean;
  mode: 'roam' | 'arena' | 'race';
  /** some dialog is up */
  dialogOpen(): boolean;
  /** a delivery / boxes errand is on */
  errandOn(): boolean;
  errandOrFire(): boolean;
  /** any job of our car is on (errand, fire, impound, a fare, a tour) */
  jobOn(): boolean;
  readonly driving: boolean;
  readonly vehicle: VehicleController;
  readonly map: ThreeMap;
  readonly city: City;
  readonly missions: { position: [number, number] }[];
  pickBeaconSpot(position: [number, number], heading: number, seed: number, avoid: [number, number][], band?: { min: number; max: number }): [number, number];
  readonly trafficNetwork: TrafficRoadNetwork;
  trafficBots: TrafficBot[];
  /** mission bots came or went: their markers and the shooting layer's targets */
  botsChanged(): void;
  forgetContacts(): void;
  playerHp: number;
  readonly playerMaxHp: number;
  playerMoney: number;
  addWin(id: string): void;
  focusGoals(): { id: string }[];
  missionFocus: number;
  hideEventBeacons(): void;
  showEventBeacons(): void;
  clearEventBots(): void;
  syncMissionVisuals(showWorld?: boolean): void;
  indicatorLayer(): HTMLElement;
  placeTargetIndicator(marker: Indicator, target: [number, number], pinMeters?: number): void;
  onEventResult(result: EventResult | null): void;
  say(text: string, toast?: boolean): void;
}

/**
 * A wanted car (for the police and the Batmobile): now and then a pin offers the job; take
 * it and the wanted car waits at its spot within 10 km — get close and it comes for us.
 * Wreck it for the reward; lose and it waits there for another go.
 */
export class Wanted {
  /** the job taken (kept across reloads) */
  bounty: Bounty | null = loadBounty();
  /** a job on offer at its pin, not taken yet */
  pending: Bounty | null = null;
  pickup: [number, number] | null = null;
  offerAt = performance.now() + 45000;
  private retryAt = 0;
  private approachCooldown = 0;
  offerShown = false;
  /** fighting the wanted car now */
  fight = false;
  private indicator: Indicator | null = null;
  marker: MapMarker | null = null;
  onOffer: (offer: BountyOffer | null) => void = () => {};

  constructor(private host: WantedHost) {}

  /** Spawn a local wanted pin now and then; take the job and hunt within 10 km. Police cars only. */
  update() {
    if (!this.host.canHuntBounty()) return;
    const now = performance.now();
    const here = this.host.vehicle.position;
    if (this.pending && !this.bounty) {
      if (this.host.mode !== 'roam' || this.fight || this.host.errandOrFire()) return;
      if (
        this.pickup
        && !this.offerShown
        && !this.host.dialogOpen()
        && now > this.approachCooldown
        && metersBetween(here, this.pickup) <= MISSION_PICKUP_M
      ) {
        this.offerShown = true;
        this.onOffer(this.offerOf(this.pending));
      }
      return;
    }
    if (!this.bounty) {
      const busy = this.host.mode !== 'roam' || this.pending || this.host.dialogOpen() || this.host.jobOn();
      if (busy || now < this.offerAt) return;
      const seed = Math.round(here[0] * 1e5) ^ Math.round(here[1] * 1e5) ^ (now | 0);
      const avoid = this.host.missions.map(mission => mission.position);
      this.pickup = this.host.pickBeaconSpot(
        here as [number, number],
        this.host.vehicle.heading,
        seed,
        avoid,
      );
      // Fight spot farther out, but never beyond 10 km.
      const huntSpot = this.host.pickBeaconSpot(
        here as [number, number],
        this.host.vehicle.heading,
        seed + 31,
        [...avoid, this.pickup],
        { min: 2500, max: BOUNTY_RANGE_KM * 1000 },
      );
      this.pending = makeBounty(
        here,
        huntSpot,
        { name: this.host.city.name, country: this.host.city.country, coords: this.host.city.coords },
        ((seed >>> 0) % 1_000_000) / 1_000_000,
      );
      this.offerShown = false;
      this.host.syncMissionVisuals(true);
      this.host.say(t('mission.new', { label: t('bounty.goal') }), true);
      return;
    }
    const bounty = this.bounty;
    if (this.fight || this.host.mode !== 'roam') return;
    // Old saves without a spot: pin one nearby once roads are loaded.
    if (!bounty.spot && kilometres(here, bounty.place.coords) <= BOUNTY_RANGE_KM) {
      const node = this.host.trafficNetwork.nearest(bounty.place.coords, new Set(), 0, BOUNTY_RANGE_KM * 1000);
      if (node) {
        bounty.spot = [...node.position] as [number, number];
        saveBounty(bounty);
        this.host.syncMissionVisuals(true);
      }
    }
    if (bounty.spot && now > this.retryAt && metersBetween(here, bounty.spot) < 650) this.startFight(bounty);
  }

  private offerOf(bounty: Bounty): BountyOffer {
    const target = bounty.spot ?? bounty.place.coords;
    return {
      name: bounty.name,
      car: carsConfig.find((car) => car.id === bounty.car)?.name ?? '',
      place: bounty.place.name,
      country: bounty.place.country,
      km: Math.max(1, Math.round(kilometres(this.host.vehicle.position, target))),
      reward: bounty.reward,
    };
  }

  accept() {
    if (!this.pending) return;
    this.bounty = this.pending;
    this.pending = null;
    this.pickup = null;
    this.offerShown = false;
    this.marker?.remove();
    this.marker = null;
    saveBounty(this.bounty);
    this.onOffer(null);
    this.host.syncMissionVisuals(true);
    const goals = this.host.focusGoals();
    const bountyIndex = goals.findIndex(goal => goal.id === 'role-bounty');
    if (bountyIndex >= 0) this.host.missionFocus = bountyIndex;
    const target = this.bounty.spot ?? this.bounty.place.coords;
    const km = Math.max(1, Math.round(kilometres(this.host.vehicle.position, target)));
    this.host.say(t('bounty.accepted', { place: this.bounty.place.name, km: formatNumber(km) }), true);
  }

  decline() {
    // leave the pin; approach again after a short cooldown
    this.offerShown = false;
    this.approachCooldown = performance.now() + 14000;
    this.onOffer(null);
  }

  /** The wanted car shows up at its spot and comes for the player. */
  private startFight(bounty: Bounty) {
    const spot = bounty.spot!;
    const car = carsConfig.find((entry) => entry.id === bounty.car) ?? carsConfig[carsConfig.length - 1];
    const seed = Math.round(spot[0] * 1e5) ^ Math.round(spot[1] * 1e5);
    this.host.trafficBots = [createTrafficBot('wanted', bounty.name, car, this.host.trafficNetwork, spot, 0, new Set(), 'hunt', seed, { min: 0, max: 160 })];
    this.host.mode = 'arena';
    this.fight = true;
    this.host.playerHp = this.host.playerMaxHp;
    this.host.forgetContacts();
    this.host.hideEventBeacons();
    this.marker?.remove();
    this.marker = null;
    this.host.botsChanged();
    this.host.say(t('bounty.found', { name: bounty.name }), true);
  }

  end(won: boolean) {
    const bounty = this.bounty;
    this.host.mode = 'roam';
    this.fight = false;
    this.host.playerHp = this.host.playerMaxHp;
    this.host.clearEventBots();
    this.host.showEventBeacons();
    if (won && bounty) {
      this.host.playerMoney += bounty.reward;
      this.host.addWin('player');
      this.host.say(t('bounty.won', { name: bounty.name, reward: formatNumber(bounty.reward) }), true);
      this.host.onEventResult({ kind: 'bounty', won: true, cash: bounty.reward, name: bounty.name });
      this.bounty = null;
      saveBounty(null);
      this.offerAt = performance.now() + 60000;
    } else {
      this.host.say(t('bounty.escaped', { name: bounty?.name ?? '' }), true);
      this.host.onEventResult({ kind: 'bounty', won: false, name: bounty?.name ?? '' });
      this.retryAt = performance.now() + 20000;
    }
  }

  /** Map pin for the hunt; HUD arrow only while the fight is on (focus list covers the rest). */
  syncMarkers() {
    const pending = Boolean(this.pending && this.pickup && !this.bounty);
    const bounty = this.fight ? null : (this.bounty ?? this.pending);
    if (!this.host.canHuntBounty() || !bounty || !this.host.driving || this.host.errandOn() || (pending && !this.pickup)) {
      if (!this.fight && this.indicator) this.indicator.element.style.display = 'none';
      if (this.marker) { this.marker.remove(); this.marker = null; }
      if (!this.fight) return;
    }
    const title = this.fight
      ? t('bounty.marker', { name: (this.bounty ?? this.pending)?.name ?? '' })
      : pending
        ? t('bounty.goal')
        : t('bounty.marker', { name: bounty!.name });
    const pin = pending ? this.pickup : (bounty?.spot && !this.fight ? bounty.spot : null);
    if (pin) {
      if (!this.marker) {
        this.marker = newMarker({ element: makeMapLabel('bounty-map-marker', title, title, MISSION_COLORS.bounty), anchor: 'bottom' }).setLngLat(pin).addTo(this.host.map);
      } else {
        this.marker.setLngLat(pin);
        const el = this.marker.getElement();
        const label = el?.querySelector('.map-pin-label');
        if (label) label.textContent = title;
        el?.style.setProperty('--mission-color', MISSION_COLORS.bounty.main);
        el?.style.setProperty('--mission-soft', MISSION_COLORS.bounty.soft);
      }
    } else if (this.marker) {
      this.marker.remove();
      this.marker = null;
    }
    // chase arrow only during the fight — pickup/spot live in the focus cycle
    if (!this.fight) {
      if (this.indicator) this.indicator.element.style.display = 'none';
      return;
    }
    this.host.indicatorLayer();
    if (!this.indicator) {
      this.indicator = makeOffscreenIndicator('focus', '');
      this.indicator.element.classList.replace('mission-focus-indicator', 'bounty-indicator');
      paintMissionIndicator(this.indicator.element, 'bounty');
      this.host.indicatorLayer().appendChild(this.indicator.element);
    }
    const bot = this.host.trafficBots[0];
    const near = bot?.position ?? null;
    const target = near ?? this.bounty?.spot ?? this.bounty?.place.coords ?? null;
    if (!target) {
      this.indicator.element.style.display = 'none';
      return;
    }
    this.indicator.title.textContent = title;
    this.host.placeTargetIndicator(this.indicator, target, near ? MARKER_PIN_METERS : 0);
  }
}
