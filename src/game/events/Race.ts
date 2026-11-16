import type { Car } from '@/config/vehicle.config';
import type { VehicleSceneLayer } from '@/rendering/VehicleLayer';
import type { ThreeMap } from '@/world3d/map/ThreeMap';
import { formatNumber, t } from '@/i18n';
import type { BuildingCollisions } from '../BuildingCollisions.ts';
import type { WaterCollisionController } from '../WaterCollisionController.ts';
import type { EventOffer, EventResult, MissionKind } from '../offers.ts';
import { RaceProgress, type RaceCourse } from '../RaceCourse.ts';
import { createTrafficBot, type TrafficBot, type TrafficRoadNetwork } from '../TrafficBots.ts';
import { offsetPosition, type Position, type VehicleController } from '../VehicleController.ts';
import type { VehiclePose } from '../VehiclePose.ts';
import { makeMapLabel, makeOffscreenIndicator, newMarker, type MapMarker } from '../hud/mapPins.ts';
import { metersBetween } from '../meters.ts';
import { MISSION_COLORS, RACE_FEE, RACE_PRIZE, randomDriverNames } from '../tuning.ts';

/** a race nobody finishes is called off after this long from the start (ms) */
const RACE_TIME_LIMIT_MS = 10 * 60_000;

/** What a race needs from the game. */
export interface RaceHost {
  mode: 'roam' | 'arena' | 'race';
  eventOffer: MissionKind | null;
  eventCooldown: number;
  playerMoney: number;
  readonly disposed: boolean;
  readonly driving: boolean;
  readonly vehicle: VehicleController;
  readonly renderVehicle: VehiclePose;
  readonly map: ThreeMap;
  readonly collisions: BuildingCollisions;
  readonly water: WaterCollisionController;
  readonly trafficNetwork: TrafficRoadNetwork;
  readonly combatLayer: VehicleSceneLayer | null;
  trafficBots: TrafficBot[];
  /** n rivals matched to our car */
  rivalCars(n: number): Car[];
  /** mission bots came or went: their markers and the shooting layer's targets */
  botsChanged(): void;
  forgetContacts(): void;
  /** a bot has a new goal: its look at the old one is stale */
  forgetBot(id: string): void;
  addWin(id: string): void;
  clearEventBots(): void;
  completeActiveMission(): void;
  hideEventBeacons(): void;
  showEventBeacons(): void;
  syncMissionVisuals(showWorld?: boolean): void;
  indicatorLayer(): HTMLElement;
  onEventOffer(offer: EventOffer | null): void;
  onEventResult(result: EventResult | null): void;
  say(text: string, toast?: boolean): void;
}

/**
 * A race: a winding ~5 km course planned on the loaded roads, three rivals on a grid
 * beside us, a 3‑2‑1, five checkpoints in order and then the flag; the first one there
 * takes the prize, and nobody there in ten minutes calls it off.
 */
export class Race {
  /** the course raced now, and where its flag is */
  course: RaceCourse | null = null;
  goal: [number, number] | null = null;
  /** everybody's checkpoints so far */
  progress: RaceProgress | null = null;
  /** the course is being planned (a few frames); a new token drops a stale plan */
  preparing = false;
  preparation = 0;
  /** everyone on the grid until this moment (3‑2‑1 countdown); 0 when no race is starting */
  startAt = 0;
  /** called off at this moment if nobody has reached the flag (0: no race) */
  deadline = 0;
  warned = false;
  private count = 0;
  goalMarker: MapMarker | null = null;
  readonly checkpointMarkers = new Map<number, MapMarker>();
  goalIndicator: { element: HTMLElement; arrow: HTMLElement; title: HTMLElement; distance: HTMLElement } | null = null;

  constructor(private host: RaceHost) {}

  /** A plan in the making is dropped (the offer declined, out of the car, the game closed). */
  cancelPreparation() {
    this.preparation++;
    this.preparing = false;
  }

  /** The race is over or dropped: the course, the progress, the gate pins go. */
  clear() {
    this.course = null;
    this.progress = null;
    for (const marker of this.checkpointMarkers.values()) marker.remove();
    this.checkpointMarkers.clear();
    this.startAt = 0;
  }

  /** No flag any more (left the car, a new spawn). */
  dropFinish() {
    this.goal = null;
    this.host.combatLayer?.setRaceFinish(null);
  }

  /** A new language (or a teardown): the pins come down; syncMarkers makes them again. */
  removeMarkers() {
    this.goalMarker?.remove();
    this.goalMarker = null;
    this.goalIndicator?.element.remove();
    this.goalIndicator = null;
    for (const marker of this.checkpointMarkers.values()) marker.remove();
    this.checkpointMarkers.clear();
  }

  /** Once a frame in a race: the checkpoints passed, the flag, the clock. */
  judge() {
    if (!this.goal || !this.progress) return;
    // nobody gets there (lost, stuck, all wrecked): the race is called off
    const now = performance.now();
    if (this.startAt > now) return;
    if (this.deadline && now >= this.deadline) { this.end('', ''); return; }
    if (this.deadline && !this.warned && this.deadline - now <= 30_000) {
      this.warned = true;
      this.host.say(t('race.hurry'), true);
    }
    const progress = this.progress;
    if (progress.update('player', this.host.vehicle.position)) {
      if (progress.finished('player')) { this.end('player', t('you')); return; }
      this.host.say(t('race.checkpointPassed', { n: progress.passed('player'), total: this.course!.checkpoints.length }), true);
      this.syncMarkers();
      this.host.syncMissionVisuals(false);
    }
    for (const bot of this.host.trafficBots) {
      if (!this.host.combatLayer?.isTargetAlive(bot.id) || !progress.update(bot.id, bot.position)) continue;
      if (progress.finished(bot.id)) { this.end(bot.id, bot.driver); return; }
      bot.goal = progress.target(bot.id);
      bot.route = [];
      bot.routeIndex = 1;
      bot.repathAt = now + (Math.abs(bot.routeSeed) % 160);
      this.host.forgetBot(bot.id);
    }
  }

  /** Given up mid-race: whoever is ahead by checkpoints (then by distance to the next) wins. */
  forfeit() {
    // Ordered checkpoint progress determines the leader, not proximity to a
    // finish they may have driven past before completing the course.
    const progress = this.progress;
    const remaining = (bot: TrafficBot) => {
      const target = progress?.target(bot.id);
      return target ? metersBetween(bot.position, target) : 0;
    };
    const leader = [...this.host.trafficBots].sort((a, b) =>
      (progress?.passed(b.id) ?? 0) - (progress?.passed(a.id) ?? 0) || remaining(a) - remaining(b))[0];
    this.end(leader?.id ?? '', leader?.driver ?? '');
  }

  async prepare() {
    if (this.preparing) return;
    const token = ++this.preparation;
    this.preparing = true;
    this.host.onEventOffer({ kind: 'race', reward: RACE_PRIZE, preparing: true });
    const center: Position = [...this.host.vehicle.position];
    const seed = Math.round(center[0] * 1e5) ^ Math.round(center[1] * 1e5) ^ (performance.now() | 0);
    const plan = this.host.trafficNetwork.planRace(center, this.host.vehicle.heading, seed, p => this.host.map.groundAt(p) != null);
    let course: RaceCourse | null = null;
    while (token === this.preparation && !this.host.disposed && this.host.driving && this.host.eventOffer === 'race') {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      if (token !== this.preparation || this.host.disposed || !this.host.driving || this.host.eventOffer !== 'race') return;
      try {
        const step = plan.next();
        if (step.done) { course = step.value; break; }
      } catch (error) { console.warn('Race route unavailable', error); break; }
    }
    if (token !== this.preparation || this.host.disposed || !this.host.driving || this.host.eventOffer !== 'race') return;
    this.preparing = false;
    if (!course) {
      this.host.onEventOffer({ kind: 'race', reward: RACE_PRIZE });
      this.host.say(t('race.unavailable'), true);
      return;
    }
    if (this.host.playerMoney < RACE_FEE) {
      this.host.onEventOffer({ kind: 'race', reward: RACE_PRIZE });
      this.host.say(t('event.broke', { fee: formatNumber(RACE_FEE) }), true);
      return;
    }
    this.host.playerMoney -= RACE_FEE;
    this.host.eventOffer = null;
    this.host.onEventOffer(null);
    this.start(course);
  }

  start(course: RaceCourse) {
    const center = this.host.vehicle.position as [number, number];
    const heading = this.host.vehicle.heading;
    const seedBase = Math.round(center[0] * 1e5) ^ Math.round(center[1] * 1e5) ^ (performance.now() | 0);
    this.course = course;
    this.goal = [...course.finish];
    const usedStarts = new Set<string>();
    const driverNames = randomDriverNames(3);
    const rivals = this.host.rivalCars(3);
    this.host.trafficBots = Array.from({ length: 3 }, (_, index) => {
      const bot = createTrafficBot(
        `race-${index}`,
        driverNames[index],
        rivals[index],
        this.host.trafficNetwork,
        center,
        heading + (index - 1) * 0.55,
        usedStarts,
        'explore',
        seedBase ^ (index * 5443),
        { min: 18, max: 90 },
      );
      bot.goal = [...course.checkpoints[0]];
      bot.goalLocked = true;
      bot.route = [];
      bot.routeIndex = 1;
      bot.lastRouteRevision = -1;
      bot.repathAt = performance.now() + index * 160; // one Dijkstra per frame, not three
      return bot;
    });
    // a starting grid: beside us left and right, one behind, all facing our way
    const forward = [Math.sin(heading), Math.cos(heading)], right = [Math.cos(heading), -Math.sin(heading)];
    const at = (side: number, along: number) => offsetPosition(center, forward[0] * along + right[0] * side, forward[1] * along + right[1] * side);
    const free = (p: [number, number]) => !this.host.collisions.blocked(center, p, heading) && !this.host.water.covers(p, true);
    const slots: [number, number][] = [[3.4, 0], [-3.4, 0], [0, -7.5]];
    this.host.trafficBots.forEach((bot, index) => {
      let spot = at(...slots[index]);
      for (let k = 1; !free(spot) && k <= 4; k++) spot = at(0, -7.5 * (k + (index === 2 ? 1 : 0)) - index * 7.5);
      bot.controller.position = [...spot];
      bot.controller.heading = heading;
      bot.controller.speed = 0;
      bot.position = [...spot];
      bot.heading = heading;
    });
    this.host.vehicle.speed = 0;
    this.progress = new RaceProgress(course, [
      { id: 'player', position: center }, ...this.host.trafficBots.map(bot => ({ id: bot.id, position: bot.position })),
    ]);
    this.startAt = performance.now() + 3200;
    this.count = 0;
    this.deadline = this.startAt + RACE_TIME_LIMIT_MS;
    this.warned = false;
    this.host.mode = 'race';
    this.host.forgetContacts();
    this.host.hideEventBeacons();
    this.host.combatLayer?.setRaceFinish(this.goal);
    this.syncMarkers();
    this.host.botsChanged();
    this.host.renderVehicle.reset(this.host.vehicle);
    this.host.say(t('race.start', { km: formatNumber(Math.round(course.meters / 100) / 10) }), true);
  }

  /** 3‑2‑1 on the grid; true while nobody may move yet. */
  countdown(now: number) {
    if (this.host.mode !== 'race' || !this.startAt) return false;
    const left = this.startAt - now;
    if (left <= 0) {
      this.startAt = 0;
      this.host.say(t('race.go'), true);
      return false;
    }
    const n = Math.ceil(left / 1000);
    if (n !== this.count && n <= 3) {
      this.count = n;
      this.host.say(String(n), true);
    }
    return true;
  }

  end(winnerId: string, winnerName: string) {
    if (this.host.mode !== 'race') return;
    this.host.mode = 'roam';
    this.host.eventCooldown = performance.now() + 8000;
    const won = winnerId === 'player';
    this.deadline = 0;
    if (won) {
      this.host.playerMoney += RACE_PRIZE;
      this.host.addWin('player');
      this.host.say(t('race.won'), true);
    } else if (!winnerId) {
      // time ran out: nobody wins, the entry fee is gone
      this.host.say(t('race.timeout'), true);
    } else {
      const bot = this.host.trafficBots.find(entry => entry.id === winnerId);
      if (bot) bot.money += RACE_PRIZE;
      this.host.addWin(winnerId);
      this.host.say(t('race.lost', { name: winnerName }), true);
    }
    this.goal = null;
    this.host.combatLayer?.setRaceFinish(null);
    if (this.goalMarker) {
      const el = this.goalMarker.getElement();
      if (el) el.style.display = 'none';
    }
    if (this.goalIndicator) this.goalIndicator.element.style.display = 'none';
    this.host.clearEventBots();
    this.host.completeActiveMission();
    this.host.showEventBeacons();
    this.host.onEventResult({ kind: 'race', won, cash: won ? RACE_PRIZE : undefined, name: won ? undefined : winnerName });
  }

  syncMarkers() {
    if (!this.goal) {
      for (const marker of this.checkpointMarkers.values()) marker.remove();
      this.checkpointMarkers.clear();
      this.goalMarker?.remove();
      this.goalMarker = null;
      if (this.goalIndicator) this.goalIndicator.element.style.display = 'none';
      return;
    }
    this.host.indicatorLayer();
    if (!this.goalMarker) {
      this.goalMarker = newMarker({
        element: makeMapLabel('race-finish-marker', t('marker.finish'), t('marker.finishRace'), MISSION_COLORS.finish),
        anchor: 'bottom',
      })
        .setLngLat(this.goal)
        .addTo(this.host.map);
    } else this.goalMarker.setLngLat(this.goal);
    const passed = this.progress?.passed('player') ?? 0;
    const finishVisible = this.host.mode === 'race' && Boolean(this.course) && passed >= (this.course?.checkpoints.length ?? 0);
    const el = this.goalMarker.getElement();
    if (el) el.style.display = finishVisible ? '' : 'none';
    this.course?.checkpoints.forEach((position, index) => {
      const label = t('race.checkpoint', { n: index + 1, total: this.course!.checkpoints.length });
      let marker = this.checkpointMarkers.get(index);
      if (!marker) {
        marker = newMarker({ element: makeMapLabel('race-finish-marker', label, label,
          index === passed ? MISSION_COLORS.finish : MISSION_COLORS.arena), anchor: 'bottom' }).setLngLat(position).addTo(this.host.map);
        this.checkpointMarkers.set(index, marker);
      }
      const element = marker.getElement();
      if (element) {
        const colors = index === passed ? MISSION_COLORS.finish : MISSION_COLORS.arena;
        element.style.setProperty('--mission-color', colors.main);
        element.style.setProperty('--mission-soft', colors.soft);
        // only the gate being raced to — later gates (the last one read "5/5" from the start) stay hidden
        element.style.display = this.host.mode === 'race' && index === passed ? '' : 'none';
      }
    });
    if (!this.goalIndicator) {
      const made = makeOffscreenIndicator('finish', t('marker.finish'));
      this.goalIndicator = made;
      this.host.indicatorLayer().appendChild(this.goalIndicator.element);
    }
  }
}
