import { missionAreas, missionRoadSpot, nearestOfEachKind } from '../missionPopulation.ts';
import { type MapFeature } from '../WaterCollisionController.ts';
import { offsetPosition, type Position } from '../VehicleController.ts';
import { mercatorX, mercatorY, tileCorner, tileSpan } from '@/world3d/mercator';
import { createTrafficBot } from '../TrafficBots.ts';
import { formatNumber, t } from '@/i18n';
import { metersBetween } from '../meters.ts';
import { makeMapLabel, makeOffscreenIndicator, newMarker, paintMissionIndicator, type MapMarker } from '../hud/mapPins.ts';
import { saveBounty } from '../Bounty.ts';
import { BOX_REACH_M, COLLECT_BOXES, COLLECT_REWARD, deliveryReward, DELIVERY_MAX_M, DELIVERY_MIN_M, DELIVERY_REACH_M, randomItem, scatterBoxes, type DeliveryItem, type Errand } from '../Errands.ts';
import type { EventOffer, EventResult, MissionKind } from '../offers.ts';
import { ARENA_FEE, ARENA_PRIZE, RACE_FEE, RACE_PRIZE, randomDriverNames, ERRAND_BEACONS, MISSION_COLORS, MISSION_PICKUP_M } from '../tuning.ts';
import type { GameEngine } from '../GameEngine.ts';

/** What this part reads and drives in the game. */
export type MissionsGame = Pick<GameEngine, 'addWin' | 'canHuntBounty' | 'carShoots' | 'clearEventBots' | 'coins' | 'combatLayer' | 'crime' | 'driving' | 'ensureTrafficMarkers' | 'eventCooldown' | 'eventIndicatorLayer' | 'eventOffer' | 'indicatorLayer' | 'isAmbulance' | 'isBus' | 'isFireTruck' | 'isHauler' | 'isTaxi' | 'jobs' | 'lastCompletedAt' | 'map' | 'mapInspecting' | 'mode' | 'onEventOffer' | 'onEventResult' | 'pins' | 'playerHp' | 'playerMaxHp' | 'playerMoney' | 'race' | 'rivalCars' | 'say' | 'setMapPinRange' | 'targetVehicles' | 'trafficBots' | 'trafficNetwork' | 'transfer' | 'updateOffscreenMarker' | 'vehicle' | 'vehicleContactTimes' | 'wanted'>;

/**
 * The mission board: the four kinds of start on the map (race, arena, delivery, boxes), their
 * offers, the arena fight, delivery and box errands, the goal in focus (Tab) and every pin and
 * edge arrow that points to them.
 */
export class Missions {
  constructor(private game: MissionsGame) {}

  /** `n`: the mission's number in its kind, for its label in any language */
  missions: { id: string; kind: MissionKind; label: string; n: number; position: [number, number] }[] = [];

  /** a delivery or box hunt under way */
  errand: Errand | null = null;

  /** a delivery prepared for the offer on screen */
  offeredDelivery: { item: DeliveryItem; goal: Position; reward: number } | null = null;

  errandMarkers = new Map<string, MapMarker>();

  /** one offscreen tip per errand pin (delivery goal or each box) — same look, no “nearest” special case */
  errandIndicators = new Map<string, { element: HTMLElement; arrow: HTMLElement; title: HTMLElement; distance: HTMLElement }>();

  missionFocus = 0;

  /** last Tab-cycle goal set; a newly added mission becomes the focused tip */
  focusGoalsLatch: string | null = null;

  missionSeq: Record<MissionKind, number> = { arena: 0, race: 0, delivery: 0, collect: 0 };

  activeMissionId: string | null = null;

  missionRespawnAt = 0;

  missionPopulationAt = 0;

  missionPopulationKey = '';

  missionMarkers = new Map<string, MapMarker>();

  focusIndicator: { element: HTMLElement; arrow: HTMLElement; title: HTMLElement; distance: HTMLElement } | null = null;

  missionTypeIndicators = new Map<MissionKind, NonNullable<Missions['focusIndicator']>>();

  /** Map mission kinds for the current car (no arena without guns). */
  missionKinds(): MissionKind[] {
    return this.game.carShoots()
      ? ['race', 'arena', 'delivery', 'collect']
      : ['race', 'delivery', 'collect'];
  }

  /** Drop arena pins / offers when switching into a cable/hose car. */
  syncArenaAvailability(prev: string, next: string) {
    const wasArmed = this.game.carShoots(prev);
    const armed = this.game.carShoots(next);
    if (wasArmed === armed) return;
    if (!armed) {
      if (this.game.eventOffer === 'arena') {
        this.game.eventOffer = null;
        this.activeMissionId = null;
        this.game.onEventOffer(null);
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

  nextMissionLabel(kind: MissionKind) {
    this.missionSeq[kind] += 1;
    return t(`mission.${kind}`, { n: this.missionSeq[kind] });
  }

  syncMissionVisuals(showWorld = this.game.mode === 'roam') {
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
    if (this.game.mode === 'race' && this.game.race.course && this.game.race.progress) {
      const passed = this.game.race.progress.passed('player');
      this.game.race.course.checkpoints.forEach((position, index) => {
        if (index < passed) return;
        beacons.push({ id: `race-checkpoint-${index}`, position,
          colors: index === passed
            ? { pole: '#e0b12a', glow: '#b88c12', orb: '#ffe56a' }
            : { pole: '#3d8bff', glow: '#2252b5', orb: '#8bbcff' },
        });
      });
    }
    if (errand?.kind === 'delivery') beacons.push({ id: 'errand-goal', position: errand.goal, colors: ERRAND_BEACONS.delivery });
    // collect boxes: map/HUD markers with range only — no giant world pins on every box
    if (showWorld && !this.game.wanted.fight && !errand) {
      if (this.game.canHuntBounty() && this.game.wanted.pending && this.game.wanted.pickup && free) {
        beacons.push({ id: 'bounty-pickup', kind: 'bounty', position: this.game.wanted.pickup });
      } else if (this.game.canHuntBounty() && this.game.wanted.bounty?.spot) {
        beacons.push({ id: 'bounty', kind: 'bounty', position: this.game.wanted.bounty.spot });
      }
      if (this.game.isFireTruck() && this.game.jobs.fire.active && this.game.jobs.fire.spot) {
        beacons.push({ id: 'fire', kind: 'fire', position: this.game.jobs.fire.spot });
      } else if (this.game.isFireTruck() && this.game.jobs.fire.pickup && free) {
        beacons.push({ id: 'fire-pickup', kind: 'fire', position: this.game.jobs.fire.pickup });
      }
      if (this.game.isHauler() && this.game.jobs.impoundActive) {
        const drop = this.game.jobs.impoundDropPin();
        if (drop) beacons.push({ id: 'impound-drop', kind: 'impound', position: drop });
        else if (this.game.jobs.impoundSpot) beacons.push({ id: 'impound', kind: 'impound', position: this.game.jobs.impoundSpot });
      } else if (this.game.isHauler() && this.game.jobs.impoundPickup && free) {
        beacons.push({ id: 'impound-pickup', kind: 'impound', position: this.game.jobs.impoundPickup });
      }
      if (this.game.isTaxi() && this.game.jobs.taxi.active && this.game.jobs.taxi.goal) {
        beacons.push({ id: 'taxi-goal', kind: 'taxi', position: this.game.jobs.taxi.goal, colors: ERRAND_BEACONS.taxi });
      } else if (this.game.isTaxi() && this.game.jobs.taxi.pickup && free) {
        beacons.push({ id: 'taxi-pickup', kind: 'taxi', position: this.game.jobs.taxi.pickup, colors: ERRAND_BEACONS.taxi });
      }
      if (this.game.isAmbulance() && this.game.jobs.ambulance.active && this.game.jobs.ambulance.goal) {
        beacons.push({ id: 'ambulance-goal', kind: 'ambulance', position: this.game.jobs.ambulance.goal, colors: ERRAND_BEACONS.ambulance });
      } else if (this.game.isAmbulance() && this.game.jobs.ambulance.pickup && free) {
        beacons.push({ id: 'ambulance-pickup', kind: 'ambulance', position: this.game.jobs.ambulance.pickup, colors: ERRAND_BEACONS.ambulance });
      }
      if (this.game.isBus() && this.game.jobs.busTour.active && this.game.jobs.busTour.goal) {
        beacons.push({ id: 'bus-goal', kind: 'bus', position: this.game.jobs.busTour.goal, colors: ERRAND_BEACONS.bus });
      } else if (this.game.isBus() && this.game.jobs.busTour.pickup && free) {
        beacons.push({ id: 'bus-pickup', kind: 'bus', position: this.game.jobs.busTour.pickup, colors: ERRAND_BEACONS.bus });
      }
    }
    if (this.game.driving) {
      for (const pin of this.game.pins.list) {
        beacons.push({
          id: pin.id,
          position: pin.position,
          colors: { pole: pin.color.main, glow: pin.color.glow, orb: pin.color.soft },
        });
      }
    }
    this.game.combatLayer?.setMissionBeacons(beacons);
    this.ensureEventMarkers();
  }

  /**
   * Tab cycle: every job is a mission. World beacons always; role jobs
   * (bounty / fire / impound / taxi / bus) only while seated in that car.
   */
  focusGoals(): Array<{
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
      for (const mission of nearestOfEachKind(this.missions, this.game.vehicle.position)) {
        goals.push({
          id: mission.id,
          color: mission.kind,
          label: mission.label,
          position: mission.position,
        });
      }
    }
    if (this.game.wanted.fight || this.errand) return goals;
    // role missions — current car only (garage ownership is not enough)
    if (this.game.canHuntBounty()) {
      if (this.game.wanted.pending && this.game.wanted.pickup && !this.onMission()) {
        goals.push({ id: 'role-bounty', color: 'bounty', label: t('bounty.goal'), position: this.game.wanted.pickup, role: true });
      } else if (this.game.wanted.bounty) {
        goals.push({
          id: 'role-bounty',
          color: 'bounty',
          label: t('bounty.marker', { name: this.game.wanted.bounty.name }),
          position: this.game.wanted.bounty.spot ?? null,
          role: true,
        });
      }
    }
    if (this.game.isFireTruck()) {
      if (this.game.jobs.fire.active && this.game.jobs.fire.spot) {
        goals.push({ id: 'role-fire', color: 'fire', label: t('fire.goal'), position: this.game.jobs.fire.spot, role: true });
      } else if (this.game.jobs.fire.pickup && !this.onMission()) {
        goals.push({ id: 'role-fire', color: 'fire', label: t('fire.goal'), position: this.game.jobs.fire.pickup, role: true });
      }
    }
    if (this.game.isHauler()) {
      if (this.game.jobs.impoundActive) {
        const drop = this.game.jobs.impoundDropPin();
        goals.push({
          id: 'role-impound',
          color: 'impound',
          label: drop ? t('impound.drop') : t('impound.goal'),
          position: drop ?? this.game.jobs.impoundSpot,
          role: true,
        });
      } else if (this.game.jobs.impoundPickup && !this.onMission()) {
        goals.push({ id: 'role-impound', color: 'impound', label: t('impound.goal'), position: this.game.jobs.impoundPickup, role: true });
      }
    }
    if (this.game.isTaxi()) {
      if (this.game.jobs.taxi.active && this.game.jobs.taxi.goal) {
        goals.push({ id: 'role-taxi', color: 'taxi', label: t('taxi.drop'), position: this.game.jobs.taxi.goal, role: true });
      } else if (this.game.jobs.taxi.pickup && !this.onMission()) {
        goals.push({ id: 'role-taxi', color: 'taxi', label: t('taxi.goal'), position: this.game.jobs.taxi.pickup, role: true });
      }
    }
    if (this.game.isAmbulance()) {
      if (this.game.jobs.ambulance.active && this.game.jobs.ambulance.goal) {
        goals.push({ id: 'role-ambulance', color: 'ambulance', label: t('ambulance.drop'), position: this.game.jobs.ambulance.goal, role: true });
      } else if (this.game.jobs.ambulance.pickup && !this.onMission()) {
        const label = this.game.jobs.ambulance.site === 'burn' ? t('ambulance.goal.burn') : t('ambulance.goal.crash');
        goals.push({ id: 'role-ambulance', color: 'ambulance', label, position: this.game.jobs.ambulance.pickup, role: true });
      }
    }
    if (this.game.isBus()) {
      if (this.game.jobs.busTour.active && this.game.jobs.busTour.goal) {
        goals.push({
          id: 'role-bus',
          color: 'bus',
          label: this.game.jobs.busTour.place || t('bus.drop'),
          position: this.game.jobs.busTour.goal,
          role: true,
        });
      } else if (this.game.jobs.busTour.pickup && !this.onMission()) {
        goals.push({ id: 'role-bus', color: 'bus', label: t('bus.tour'), position: this.game.jobs.busTour.pickup, role: true });
      }
    }
    return goals;
  }

  placeEventBeacons() {
    for (const marker of this.missionMarkers.values()) marker.remove();
    this.missionMarkers.clear();
    this.missions = [];
    this.missionSeq = { arena: 0, race: 0, delivery: 0, collect: 0 };
    this.clearErrand();
    this.missionFocus = 0;
    this.activeMissionId = null;
    this.missionRespawnAt = 0;
    this.game.lastCompletedAt = null;
    this.missionPopulationAt = 0;
    this.missionPopulationKey = '';
    this.refillMissions();
    this.syncMissionVisuals(true);
  }

  cycleMissionFocus() {
    if (!this.game.driving || this.game.mode !== 'roam') return;
    const goals = this.focusGoals();
    if (goals.length < 2) return;
    this.missionFocus = (this.missionFocus + 1) % goals.length;
    const goal = goals[this.missionFocus];
    if (goal) this.game.say(t('mission.target', { label: goal.label }), true);
  }

  completeActiveMission() {
    if (this.activeMissionId) {
      const index = this.missions.findIndex(mission => mission.id === this.activeMissionId);
      if (index >= 0) {
        const done = this.missions[index];
        this.game.lastCompletedAt = [...done.position] as [number, number];
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

  refillMissions() {
    const now = performance.now();
    if (now < this.missionPopulationAt || this.game.mode !== 'roam' || this.onMission() || this.game.eventOffer || this.game.transfer.pending) return;
    this.missionPopulationAt = now + 1500;
    const here = this.game.vehicle.position as [number, number];
    const westSouth = offsetPosition(here, -1800, -1400), eastNorth = offsetPosition(here, 1800, 1400);
    const bounds = (this.game.mapInspecting() ? this.game.map.visibleGroundBounds() : null)
      ?? { west: westSouth[0], south: westSouth[1], east: eastNorth[0], north: eastNorth[1] };
    const inside = (p: Position) => p[0] >= bounds.west && p[0] <= bounds.east && p[1] >= bounds.south && p[1] <= bounds.north;
    const tileKeys = this.game.map.world.tileKeys();
    const key = `${Object.values(bounds).map(v => v.toFixed(4))}:${tileKeys.join()}:${this.missionKinds()}:${now < this.missionRespawnAt}`;
    if (key === this.missionPopulationKey) return;
    this.missionPopulationKey = key;
    // Read the visible tiles directly. Gameplay's road graph intentionally only
    // ingests the car's neighbourhood, so it cannot populate a panned-away map.
    const roadTiles: { x: number; y: number; span: number; roads: MapFeature[] }[] = [];
    const west = mercatorX(bounds.west), east = mercatorX(bounds.east), south = mercatorY(bounds.south), north = mercatorY(bounds.north);
    for (const tile of tileKeys) {
      const [z, x, y] = tile.split('/').map(Number);
      const [cornerX, cornerY] = tileCorner({ z, x, y }), span = tileSpan(z);
      if (cornerX > east || cornerX + span < west || cornerY < south || cornerY - span > north) continue;
      roadTiles.push({ x: cornerX, y: cornerY, span, roads: this.game.map.world.featuresOf(tile, 'transportation') as MapFeature[] });
    }
    const kinds = this.missionKinds();
    const next: typeof this.missions = [];
    const available = this.missions.filter(m => inside(m.position));
    // Also keep nearest jobs around the car while inspecting somewhere else.
    const nearCar = nearestOfEachKind(this.missions, here).filter(m => metersBetween(m.position, here) < 2500);
    const separated = (p: Position, gap: number) => !next.some(m => metersBetween(m.position, p) < gap);
    const counts = (kind: MissionKind) => next.filter(m => m.kind === kind).length;
    for (const [i, area] of missionAreas(bounds).entries()) {
      const old = available.filter(m => kinds.includes(m.kind) && counts(m.kind) < Math.ceil(16 / kinds.length)
        && metersBetween(m.position, area.at) < area.radius && separated(m.position, area.gap))
        .sort((a, b) => metersBetween(a.position, area.at) - metersBetween(b.position, area.at))[0];
      if (old) { next.push(old); available.splice(available.indexOf(old), 1); continue; }
      const mx = mercatorX(area.at[0]), my = mercatorY(area.at[1]);
      const reach = area.radius / Math.cos(area.at[1] * Math.PI / 180);
      // Search only intersecting tiles; a zoomed-out city's full road set is
      // much too expensive to scan sixteen times in a simulation frame.
      const roads = roadTiles.filter(tile => tile.x <= mx + reach && tile.x + tile.span >= mx - reach
        && tile.y >= my - reach && tile.y - tile.span <= my + reach).flatMap(tile => tile.roads);
      const spot = missionRoadSpot(roads, area.at, area.radius, p => inside(p) && separated(p, area.gap)
        && metersBetween(p, here) > 80 && this.game.map.groundAt(p) != null
        && (this.game.map.waterLevelAt(p) == null || this.game.map.isDeckAt(p, this.game.map.groundAt(p)!))
        && !(this.game.lastCompletedAt && now < this.missionRespawnAt && metersBetween(p, this.game.lastCompletedAt) < 180));
      if (!spot) continue; // An unloaded area gets another try as its tiles arrive.
      const kind = [...kinds].sort((a, b) => counts(a) - counts(b) || ((kinds.indexOf(a) - i + 16) % kinds.length) - ((kinds.indexOf(b) - i + 16) % kinds.length))[0];
      const n = this.missionSeq[kind] + 1;
      next.push({ id: `${kind}-${n}`, kind, label: this.nextMissionLabel(kind), n, position: spot });
    }
    for (const mission of nearCar) if (!next.some(m => m.id === mission.id)) next.push(mission);
    if (next.map(m => m.id).join() !== this.missions.map(m => m.id).join()) {
      this.missions = next;
      this.syncMissionVisuals(true);
    }
  }

  /** Lose whatever mission we are on (a wreck). True if there was one. */
  failMission() {
    if (this.errand) {
      this.clearErrand();
      this.completeActiveMission();
      this.game.eventCooldown = performance.now() + 8000;
      return true;
    }
    if (this.game.wanted.fight || this.game.wanted.bounty) {
      if (this.game.wanted.fight) this.game.wanted.end(false);
      // the job is off: a new one is offered in a while
      this.game.wanted.bounty = null;
      saveBounty(null);
      this.game.wanted.offerAt = performance.now() + 60000;
      return true;
    }
    if (this.game.mode === 'arena') { this.endArena(false); return true; }
    if (this.game.mode === 'race') { this.game.race.forfeit(); return true; }
    if (this.game.jobs.taxi.active) {
      this.game.jobs.taxi.active = false;
      this.game.jobs.taxi.goal = null;
      this.game.jobs.taxi.meters = 0;
      this.game.jobs.taxi.offerAt = performance.now() + 20000;
      this.syncMissionVisuals(true);
      return true;
    }
    return false;
  }

  acceptEvent() {
    if (this.game.mode !== 'roam' || !this.game.driving || !this.game.eventOffer) return;
    const kind = this.game.eventOffer;
    if (kind === 'arena' && !this.game.carShoots()) {
      this.declineEvent();
      return;
    }
    const nearby = this.missions.find(mission => mission.kind === kind && metersBetween(this.game.vehicle.position, mission.position) <= 18)
      ?? this.missions.find(mission => mission.kind === kind)
      ?? null;
    if (kind === 'delivery' || kind === 'collect') { this.startErrand(kind, nearby); return; }
    // everyone chips in to start; the winner takes the prize
    const fee = kind === 'arena' ? ARENA_FEE : RACE_FEE;
    if (this.game.playerMoney < fee) {
      this.game.say(t('event.broke', { fee: formatNumber(fee) }), true);
      return;
    }
    if (kind === 'race') { this.activeMissionId = nearby?.id ?? null; void this.game.race.prepare(); return; }
    this.activeMissionId = nearby?.id ?? null;
    this.game.eventOffer = null;
    this.game.onEventOffer(null);
    this.game.playerMoney -= fee;
    this.startArena();
  }

  declineEvent() {
    this.game.race.cancelPreparation();
    this.game.eventOffer = null;
    this.offeredDelivery = null;
    this.activeMissionId = null;
    this.game.eventCooldown = performance.now() + 14000;
    this.game.onEventOffer(null);
  }

  hideEventBeacons() {
    this.syncMissionVisuals(false);
    if (this.focusIndicator) this.focusIndicator.element.style.display = 'none';
  }

  showEventBeacons() {
    this.syncMissionVisuals(true);
  }

  startArena() {
    const center = this.game.vehicle.position as [number, number];
    const heading = this.game.vehicle.heading;
    const usedStarts = new Set<string>();
    const driverNames = randomDriverNames(3);
    const seedBase = Math.round(center[0] * 1e5) ^ Math.round(center[1] * 1e5) ^ (performance.now() | 0);
    const rivals = this.game.rivalCars(3);
    this.game.trafficBots = Array.from({ length: 3 }, (_, index) => createTrafficBot(
      `arena-${index}`,
      driverNames[index],
      rivals[index],
      this.game.trafficNetwork,
      center,
      heading + (index - 1) * 0.8,
      usedStarts,
      'hunt',
      seedBase ^ (index * 7919),
      // Spread across neighbouring districts, then they hunt the player and each other.
      { min: 280, max: 1800 },
    ));
    for (let i = 0; i < this.game.trafficBots.length; i++) this.game.trafficBots[i].repathAt = performance.now() + i * 160;
    this.game.mode = 'arena';
    this.game.playerHp = this.game.playerMaxHp;
    this.game.vehicleContactTimes.clear();
    this.hideEventBeacons();
    this.game.ensureTrafficMarkers();
    this.game.combatLayer?.setTargets(this.game.targetVehicles());
    this.game.say(t('arena.start'), true);
  }

  endArena(won: boolean) {
    if (this.game.mode !== 'arena') return;
    this.game.mode = 'roam';
    this.game.eventCooldown = performance.now() + 8000;
    // losing costs only the entry fee already paid
    if (won) {
      this.game.playerMoney += ARENA_PRIZE;
      this.game.addWin('player');
      this.game.say(t('arena.won'), true);
    } else {
      this.game.say(t('arena.lost'), true);
    }
    this.game.playerHp = this.game.playerMaxHp;
    this.game.clearEventBots();
    this.completeActiveMission();
    this.showEventBeacons();
    this.game.onEventResult({ kind: 'arena', won, cash: won ? ARENA_PRIZE : undefined });
  }

  updateEvents() {
    if (!this.game.driving) return;
    if (this.game.crime.heist) { this.game.crime.update(); return; }
    this.game.wanted.update();
    this.game.jobs.updateFire();
    this.game.jobs.updateImpound();
    this.game.jobs.updateTaxi();
    this.game.jobs.updateAmbulance();
    this.game.jobs.updateBus();
    if (this.game.wanted.fight) {
      if (this.game.playerHp <= 0) this.game.wanted.end(false);
      else if (this.game.trafficBots.length && this.game.combatLayer && this.game.combatLayer.aliveTargetCount() === 0) this.game.wanted.end(true);
      return;
    }
    if (this.game.mode === 'arena') {
      if (this.game.playerHp <= 0) {
        this.endArena(false);
        return;
      }
      if (this.game.trafficBots.length && this.game.combatLayer && this.game.combatLayer.aliveTargetCount() === 0) {
        this.endArena(true);
      }
      return;
    }
    if (this.game.mode === 'race') { this.game.race.judge(); return; }
    if (this.errand) { this.updateErrand(); return; }
    this.refillMissions();
    // one mission at a time: none offered while another is on
    if (this.onMission() || this.game.eventOffer || performance.now() < this.game.eventCooldown) return;
    // the offer opens only right at the marker, not from the street beside it
    const nearby = this.missions.find(mission =>
      metersBetween(this.game.vehicle.position, mission.position) <= MISSION_PICKUP_M
      && (mission.kind !== 'arena' || this.game.carShoots()));
    if (!nearby) return;
    const offer = this.offerFor(nearby);
    if (!offer) {
      this.game.eventCooldown = performance.now() + 8000;
      this.game.say(t('delivery.unavailable'), true);
      return;
    }
    this.game.eventOffer = nearby.kind;
    this.activeMissionId = nearby.id;
    this.game.onEventOffer(offer);
  }

  /** On a mission of any kind (arena, race, chase, a hunt, an errand, a fire, an impound): nothing else is offered or shown. */
  onMission() {
    return this.game.mode !== 'roam'
      || Boolean(this.game.crime.heist)
      || this.game.wanted.fight
      || (Boolean(this.game.wanted.bounty) && this.game.canHuntBounty())
      || Boolean(this.errand)
      || this.game.jobs.fire.active
      || this.game.jobs.impoundActive
      || this.game.jobs.taxi.active
      || this.game.jobs.ambulance.active
      || this.game.jobs.busTour.active;
  }

  /** What the marker's dialog says; a delivery picks its address and pay here. Null: no address to go to. */
  offerFor(mission: { kind: MissionKind; position: [number, number] }): EventOffer | null {
    if (mission.kind === 'delivery') {
      const seed = (performance.now() | 0) ^ Math.round(mission.position[0] * 1e5);
      const node = this.game.trafficNetwork.randomAway(mission.position, new Set(), DELIVERY_MIN_M, DELIVERY_MAX_M, seed);
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
  startErrand(kind: 'delivery' | 'collect', mission: { id: string; position: [number, number] } | null) {
    this.activeMissionId = mission?.id ?? null;
    this.game.eventOffer = null;
    this.game.onEventOffer(null);
    if (kind === 'delivery') {
      const offered = this.offeredDelivery;
      this.offeredDelivery = null;
      if (!offered) return;
      this.errand = { kind: 'delivery', ...offered };
      this.game.say(t('delivery.start', { item: t(`item.${offered.item}`) }), true);
    } else {
      const center = mission?.position ?? [...this.game.vehicle.position] as [number, number];
      const seed = Math.round(center[0] * 1e5) ^ Math.round(center[1] * 1e5) ^ (performance.now() | 0);
      const boxes = scatterBoxes(center, seed, (min, max, at) => this.game.trafficNetwork.randomAway(center, new Set(), min, max, at)?.position ?? null);
      this.errand = { kind: 'collect', center, boxes, total: boxes.length, reward: COLLECT_REWARD };
      this.game.say(t('collect.start', { n: boxes.length }), true);
    }
    this.syncMissionVisuals(true);
    this.syncErrandMarkers();
    this.game.combatLayer?.setPickups(this.game.coins.pickupVisuals());
  }

  /** Every frame on an errand: arrived at the address, or drove over a box. */
  updateErrand() {
    const errand = this.errand!;
    const here = this.game.vehicle.position;
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
    this.game.say(t('collect.got', { n, total: errand.total }), true);
    this.syncMissionVisuals(true);
    this.syncErrandMarkers();
    this.game.combatLayer?.setPickups(this.game.coins.pickupVisuals());
  }

  finishErrand(reward: number, text: string, result: EventResult) {
    this.game.playerMoney += reward;
    this.game.addWin('player');
    this.clearErrand();
    this.completeActiveMission();
    this.game.eventCooldown = performance.now() + 8000;
    this.game.say(text, true);
    this.game.onEventResult(result);
  }

  /** No errand any more (done, lost, or a new drive): its markers and boxes go. */
  clearErrand() {
    this.errand = null;
    this.offeredDelivery = null;
    this.syncErrandMarkers();
    this.game.combatLayer?.setPickups(this.game.coins.pickupVisuals());
  }

  /** Map labels + matching offscreen tips: the address, or one identical tip per box. */
  syncErrandMarkers() {
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
    if (wanted.size) this.game.indicatorLayer();
    for (const [id, spec] of wanted) {
      if (!this.errandMarkers.has(id)) {
        this.errandMarkers.set(id, newMarker({
          element: makeMapLabel(spec.className, spec.text, spec.text, spec.colors),
          anchor: 'bottom',
        }).setLngLat(spec.position).addTo(this.game.map));
      }
      if (!this.errandIndicators.has(id) && this.game.eventIndicatorLayer) {
        const tip = makeOffscreenIndicator('focus', spec.text);
        paintMissionIndicator(tip.element, spec.kind);
        this.game.indicatorLayer().appendChild(tip.element);
        this.errandIndicators.set(id, tip);
      }
    }
  }

  /** Active errand pins with the same label (delivery address, or every box left). */
  errandPins(): Array<{ id: string; position: [number, number]; label: string; kind: 'delivery' | 'collect' }> {
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

  ensureEventMarkers() {
    this.game.indicatorLayer();
    const roaming = this.game.mode === 'roam' && this.game.driving && !this.onMission();
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
        const colors = MISSION_COLORS[mission.kind];
        marker = newMarker({ element: makeMapLabel(className, mission.label, mission.label, colors), anchor: 'bottom' })
          .setLngLat(mission.position)
          .addTo(this.game.map);
        this.missionMarkers.set(mission.id, marker);
      } else {
        marker.setLngLat(mission.position);
        const el = marker.getElement();
        const label = el?.querySelector('.map-pin-label');
        if (label) label.textContent = mission.label;
        const colors = MISSION_COLORS[mission.kind];
        el?.style.setProperty('--mission-color', colors.main);
        el?.style.setProperty('--mission-soft', colors.soft);
      }
      const el = marker.getElement();
      if (el) el.style.display = roaming ? '' : 'none';
    }
    if (!this.focusIndicator) {
      this.focusIndicator = makeOffscreenIndicator('focus', t('marker.target'));
      this.game.indicatorLayer().appendChild(this.focusIndicator.element);
    }
  }

  updateEventMarkers() {
    this.game.wanted.syncMarkers();
    this.game.jobs.updateFireMarkers();
    this.game.jobs.updateImpoundMarkers();
    this.game.jobs.updateTaxiMarkers();
    this.game.jobs.updateAmbulanceMarkers();
    this.game.jobs.updateBusTourMarkers();
    const roaming = this.game.driving && this.game.mode === 'roam';
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
    // One edge pointer per event type, always to its nearest available start.
    // All starts still have their own pins on the map.
    const nearest = nearestOfEachKind(this.missions, this.game.vehicle.position);
    for (const kind of this.missionKinds()) {
      const mission = nearest.find(m => m.kind === kind);
      let tip = this.missionTypeIndicators.get(kind);
      if (!tip && mission && this.game.eventIndicatorLayer) {
        tip = makeOffscreenIndicator('focus', mission.label);
        paintMissionIndicator(tip.element, kind);
        this.game.indicatorLayer().appendChild(tip.element);
        this.missionTypeIndicators.set(kind, tip);
      }
      this.game.updateOffscreenMarker(tip ?? null, mission?.position ?? null, roaming && !this.onMission(), mission?.label);
    }
    for (const [kind, tip] of this.missionTypeIndicators) if (!this.missionKinds().includes(kind)) tip.element.style.display = 'none';
    if (!this.focusIndicator && roaming && focused) {
      this.focusIndicator = makeOffscreenIndicator('focus', t('marker.target'));
      this.game.indicatorLayer();
      this.game.indicatorLayer().appendChild(this.focusIndicator.element);
    }
    if (this.focusIndicator && focused) paintMissionIndicator(this.focusIndicator.element, focused.color);
    this.game.updateOffscreenMarker(
      this.focusIndicator,
      focused?.position ?? null,
      Boolean(roaming && focused?.role && focused.position),
      focused?.label,
    );
    const nextRaceGate = this.game.race.progress?.target('player') ?? this.game.race.goal;
    const raceGateLabel = this.game.race.course && this.game.race.progress && this.game.race.progress.passed('player') < this.game.race.course.checkpoints.length
      ? t('race.checkpoint', { n: this.game.race.progress.passed('player') + 1, total: this.game.race.course.checkpoints.length }) : t('marker.finish');
    this.game.updateOffscreenMarker(this.game.race.goalIndicator, nextRaceGate, this.game.driving && this.game.mode === 'race', raceGateLabel);
    const errandPins = this.errandPins();
    for (const pin of errandPins) {
      const tip = this.errandIndicators.get(pin.id);
      if (tip) paintMissionIndicator(tip.element, pin.kind);
      this.game.updateOffscreenMarker(tip ?? null, pin.position, this.game.driving, pin.label);
    }
    for (const [id, tip] of this.errandIndicators) {
      if (!errandPins.some((pin) => pin.id === id)) tip.element.style.display = 'none';
    }
    this.game.pins.syncPointers();
    for (const pin of this.game.pins.list) {
      this.game.updateOffscreenMarker(pin.indicator, pin.position, this.game.driving, t('marker.pin'));
      this.game.setMapPinRange(pin.marker, pin.position, this.game.driving);
    }
    // map pins carry range while in view; edge HUD only when the goal is off-frame
    const pinRange = this.game.driving && !this.game.mapInspecting();
    // shown state follows the live mode every frame: the pins are laid out in the menu
    // (not driving yet) and nothing re-synced them when the drive began — so in view they were gone
    const pinsShown = roaming && !this.onMission();
    for (const mission of this.missions) {
      const marker = this.missionMarkers.get(mission.id);
      const el = marker?.getElement();
      if (el) {
        const display = pinsShown ? '' : 'none';
        if (el.style.display !== display) el.style.display = display;
      }
      this.game.setMapPinRange(marker, mission.position, pinRange);
    }
    this.game.setMapPinRange(this.game.race.goalMarker, this.game.race.goal, pinRange && this.game.mode === 'race' && (this.game.race.progress?.passed('player') ?? 0) >= (this.game.race.course?.checkpoints.length ?? 0));
    if (this.game.race.course) for (const [index, marker] of this.game.race.checkpointMarkers) {
      this.game.setMapPinRange(marker, this.game.race.course.checkpoints[index], pinRange && this.game.mode === 'race');
    }
    this.game.setMapPinRange(this.game.wanted.marker, this.game.wanted.pickup ?? this.game.wanted.bounty?.spot ?? null, pinRange && this.game.canHuntBounty());
    const jobRange = pinRange && !this.game.mapInspecting();
    this.game.jobs.jobPins.fire.range(this.game.vehicle.position, jobRange && this.game.isFireTruck());
    this.game.jobs.jobPins.impound.range(this.game.vehicle.position, jobRange && this.game.isHauler());
    this.game.jobs.jobPins.taxi.range(this.game.vehicle.position, jobRange && this.game.isTaxi());
    this.game.jobs.jobPins.ambulance.range(this.game.vehicle.position, jobRange && this.game.isAmbulance());
    this.game.jobs.jobPins.bus.range(this.game.vehicle.position, jobRange && this.game.isBus());
    for (const pin of errandPins) {
      this.game.setMapPinRange(this.errandMarkers.get(pin.id), pin.position, pinRange);
    }
  }
}
