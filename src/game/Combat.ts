import { MARKER_PIN_METERS, nameIndicator } from './hud/indicators.ts';
import { type Car } from '@/config/vehicle.config';
import { VehicleController, bumpDamage, vehicleImpact, resolveVehicleCollision, type Position } from './VehicleController.ts';
import { PLAYER_MARKER_COLOR } from './net/NetPlayers.ts';
import { HealthMeters, type Meter } from './hud/HealthMeters.ts';
import { PLAYER_HP } from '@/net/protocol';
import { type TrafficBot } from './TrafficBots.ts';
import { formatNumber, t } from '@/i18n';
import { metersBetween } from './meters.ts';
import { Wanted } from './events/Wanted.ts';
import type { HudParticipant } from './offers.ts';
import { TRAFFIC_MARKER_COLORS, WRECK_COSTS } from './tuning.ts';
import type { GameEngine } from './GameEngine.ts';

/** What this part reads and drives in the game. */
export type CombatGame = Pick<GameEngine, 'altitude' | 'audio' | 'board' | 'car' | 'carShoots' | 'collisions' | 'combatLayer' | 'crime' | 'driving' | 'hauler' | 'hitNoticeAt' | 'host' | 'isPropBot' | 'map' | 'mapInspecting' | 'mapLoaded' | 'mode' | 'nearestRescue' | 'onBridgeDeck' | 'placeCarAt' | 'placeTargetIndicator' | 'playerHp' | 'playerMaxHp' | 'playerMoney' | 'playerName' | 'players' | 'renderVehicle' | 'say' | 'sharedTraffic' | 'spawn' | 'targetScratch' | 'testCars' | 'trafficBots' | 'vehicle' | 'wanted' | 'water'>;

/**
 * Cars against cars: who is a target, bumps and rams between them, the hunters' guns, damage
 * and wrecks, who has won what, and the name tags and health bars over the cars.
 */
export class Combat {
  constructor(private game: CombatGame) {}

  vehicleContactTimes = new Map<string, number>();

  trafficMarkerLayer: HTMLElement | null = null;

  trafficMarkers = new Map<string, { element: HTMLElement; arrow: HTMLElement; name: HTMLElement; distance: HTMLElement }>();

  /** health bars over the cars on screen */
  healthMeters!: HealthMeters;

  wins = new Map<string, number>();

  /** each hunting bot's gun: bursts while it has us in front of it */
  hunterGuns = new Map<string, { burstUntil: number; nextBurst: number; nextShot: number }>();

  /** Shared traffic and test cars: targets beside the missions', every frame. */
  syncExtraTargets(dt: number, now: number) {
    const layer = this.game.combatLayer;
    if (!layer) return;
    const tests = this.game.testCars.update(now, this.game.driving, this.game.vehicle, (id) => layer.isTargetAlive(id));
    layer.setExtraTargets([...this.game.sharedTraffic.update(dt, now), ...tests]);
  }

  targetVehicles() {
    // reuse objects — VehicleLayer only reads id/position/heading each frame
    const out = this.game.targetScratch;
    out.length = this.game.trafficBots.length;
    for (let i = 0; i < this.game.trafficBots.length; i++) {
      const bot = this.game.trafficBots[i];
      const row = out[i] ?? (out[i] = { id: '', driver: '', car: bot.car, position: bot.position, heading: 0 });
      row.id = bot.id;
      row.driver = bot.driver;
      row.car = bot.car;
      row.position = bot.position;
      row.heading = bot.heading;
    }
    return out;
  }

  resolveVehicleContacts(now: number) {
    // movers vs movers + movers vs parked — never parked×parked (O(n²) waste on kerb props)
    type Body = { id: string; controller: VehicleController; car: Car };
    const haulId = this.game.hauler.haul?.id;
    const movers: Body[] = [
      { id: 'player', controller: this.game.vehicle, car: this.game.car },
      ...this.game.sharedTraffic.drivenBodies(),
      ...this.game.trafficBots
        .filter(bot => !this.game.combatLayer || this.game.combatLayer.isTargetAlive(bot.id))
        .map(bot => ({ id: bot.id, controller: bot.controller, car: bot.car })),
    ].filter(participant => participant.id !== haulId);
    const parked: Body[] = this.game.sharedTraffic.parkedBodies().filter(p => p.id !== haulId);

    const applyPosition = (participant: Body, next: [number, number]) => {
      const { controller } = participant;
      if (next === controller.position
        || this.game.collisions.blocked(controller.position, next, controller.heading, 1, participant.id === 'player' ? this.game.altitude : -Infinity)) return;
      const alt = participant.id === 'player' ? this.game.altitude : (this.game.map.groundAt(controller.position) ?? this.game.altitude);
      const water = this.game.water.resolve(controller.position, next, controller.heading, 1, this.game.onBridgeDeck(controller.position, alt));
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
      if (this.game.crime.heist && ((a.id === 'player' && b.id.startsWith('police')) || (b.id === 'player' && a.id.startsWith('police')))) {
        this.game.crime.heist.caught = true;
      }
      const key = `${a.id}:${b.id}`;
      if (now - (this.vehicleContactTimes.get(key) ?? 0) < 280) return;
      this.vehicleContactTimes.set(key, now);
      // every knock that flashes a car red takes health off it: the slower side takes
      // the knock, a hunting bot ramming at speed hurts whoever it rams, and harder
      const impact = vehicleImpact(a.controller, b.controller);
      if (impact < 1.5) return;
      if (a.id === 'player' || b.id === 'player') this.game.audio.crash(impact / 40);
      const hunting = (id: string) => this.findBot(id)?.mood === 'hunt';
      const ramming = (id: string) => impact > 6 && hunting(id);
      const hurt = (victim: Body, attacker: Body, slower: boolean) => {
        const rammed = ramming(attacker.id);
        if (!slower && !rammed) return;
        const amount = rammed ? Math.max(bumpDamage(impact), Math.min(55, 12 + impact * 2.2)) : bumpDamage(impact);
        if (victim.id === 'player') this.damagePlayer(amount, 180);
        else {
          this.game.combatLayer?.damageTarget(victim.id, amount, attacker.id === 'player');
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

    for (const bot of this.game.trafficBots) {
      bot.position = [...bot.controller.position];
      bot.heading = bot.controller.heading;
    }
  }

  hudParticipants(): HudParticipant[] {
    const targetHealth = new Map((this.game.combatLayer?.targetHealth() ?? []).map(target => [target.id, target]));
    return [
      {
        id: 'player',
        name: this.game.playerName || t('you'),
        color: '#111111',
        hp: this.game.playerHp,
        maxHp: this.game.playerMaxHp,
        money: Math.floor(this.game.playerMoney),
        wins: this.wins.get('player') ?? 0,
      },
      // other players: their health as they report it; money and wins are their own business
      ...this.game.players.others().map((p) => ({
        id: `net:${p.id}`,
        name: p.name,
        color: PLAYER_MARKER_COLOR,
        hp: p.hp,
        maxHp: PLAYER_HP,
        money: Number.NaN,
        wins: Number.NaN,
      })),
      ...this.game.trafficBots
        // police chase / bounty bandit / parked mission props are not racers
        .filter((bot) => !bot.id.startsWith('police') && bot.id !== 'wanted' && !this.game.isPropBot(bot.id))
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

  addWin(id: string) {
    this.wins.set(id, (this.wins.get(id) ?? 0) + 1);
  }

  /**
   * Another player's bullet. Only while roaming (a mission is our own fight); at
   * zero we blow up, stop dead and come back with full health. True when it got us.
   */
  hitByPlayer(name: string, damage: number): boolean {
    if (!this.game.driving || this.game.mode !== 'roam' || this.game.wanted.fight || this.game.playerHp <= 0) return false;
    this.game.playerHp = Math.max(0, this.game.playerHp - damage);
    this.game.combatLayer?.flashPlayer(160);
    const now = performance.now();
    if (now - this.game.hitNoticeAt > 3000) { this.game.hitNoticeAt = now; this.game.say(t('pvp.hit', { name })); }
    if (this.game.playerHp > 0) return false;
    this.wreck();
    return true;
  }

  /** Mission props (tow wreck, ambulance pileup) never chase or shoot. */
  findBot(id: string): TrafficBot | undefined {
    if (this.game.isPropBot(id)) return undefined;
    return this.game.trafficBots.find((bot) => bot.id === id)
      ?? this.game.sharedTraffic.bots().find((bot) => bot.id === id);
  }

  /**
   * Shot or rammed: leave the civilian route and hunt the player. Armed cars
   * also open fire via `updateHunterGuns`.
   */
  provoke(id: string) {
    const bot = this.findBot(id);
    if (!bot || bot.mood === 'hunt') return;
    bot.mood = 'hunt';
    bot.huntId = 'player';
    bot.huntRange = metersBetween(bot.position, this.game.vehicle.position);
    bot.goal = [...this.game.vehicle.position] as Position;
    bot.route = [];
    bot.routeIndex = 1;
    bot.repathAt = 0;
  }

  /**
   * Hunters (arena, police, bounty, and anyone we provoked) shoot back: short
   * bursts when we are within ~70 m, roughly ahead of them and not behind a
   * building. Close and slow is easy to hit; far and fast mostly misses.
   */
  updateHunterGuns(now: number) {
    if (this.game.playerHp <= 0 || !this.game.combatLayer || !this.game.driving) return;
    const me = this.game.vehicle.position;
    const hunters = [
      ...this.game.trafficBots,
      ...this.game.sharedTraffic.bots(),
    ];
    for (const bot of hunters) {
      if (bot.mood !== 'hunt' || !this.game.carShoots(bot.car.id)) continue;
      if (!this.game.combatLayer.isTargetAlive(bot.id)) continue;
      const d = metersBetween(bot.position, me);
      if (d > 70 || d < 3) continue;
      const toMe = Math.atan2((me[0] - bot.position[0]) * Math.cos(me[1] * Math.PI / 180), me[1] - bot.position[1]);
      const off = Math.abs(((toMe - bot.heading) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
      if (off > 0.7) continue;
      let gun = this.hunterGuns.get(bot.id);
      if (!gun) { gun = { burstUntil: 0, nextBurst: now + 600 + Math.random() * 900, nextShot: 0 }; this.hunterGuns.set(bot.id, gun); }
      if (now >= gun.nextBurst && now >= gun.burstUntil) {
        // no shooting through houses: look once per burst, try again soon if a wall is in the way
        if (this.game.collisions.sightBlocked(bot.position, me)) { gun.nextBurst = now + 400; continue; }
        gun.burstUntil = now + 800 + Math.random() * 500;
        gun.nextBurst = gun.burstUntil + 1100 + Math.random() * 1000;
      }
      if (now >= gun.burstUntil || now < gun.nextShot) continue;
      gun.nextShot = now + 105;
      const wanted = bot.id === 'wanted';
      const police = bot.id.startsWith('police');
      const chance = Math.max(0.12, Math.min(0.85, 0.8 - d / 90)) / (1 + Math.abs(this.game.vehicle.speed) / 30) * (police ? 1.4 : 1);
      const hit = Math.random() < chance;
      this.game.combatLayer.enemyShot(bot.id, hit);
      if (hit) this.damagePlayer(wanted ? 11 : police ? 15 : 6);
    }
  }

  /**
   * Health off our car. In a fight (arena, bounty, chase) zero ends it there; anywhere
   * else at zero we blow up, stop dead and come back with full health.
   */
  damagePlayer(amount: number, flash = 220) {
    if (!this.game.driving || amount <= 0 || this.game.playerHp <= 0) return;
    this.game.playerHp = Math.max(0, this.game.playerHp - amount);
    this.game.combatLayer?.flashPlayer(flash);
    // a bank job ends in an arrest (updateHeist), with its own place and bill
    if (this.game.playerHp > 0 || this.game.crime.heist) return;
    this.wreck();
  }

  /**
   * Our car blew up: the mission we were on is lost, and we come to at the nearest
   * hospital or filling station, whichever is closer, with the bill for it.
   */
  wreck() {
    this.game.combatLayer?.explodePlayer();
    this.game.audio.explosion(null);
    this.game.hauler.release(null);
    const failed = this.game.board.failMission();
    this.game.playerHp = this.game.playerMaxHp;
    const drop = this.game.nearestRescue();
    const kind = drop?.kind ?? 'here';
    const fine = WRECK_COSTS[kind];
    this.game.playerMoney = Math.max(0, this.game.playerMoney - fine);
    const wreckSpot = drop ? drop.position : this.game.spawn.nearbyRoadSpot();
    if (wreckSpot && this.game.mapLoaded) this.game.placeCarAt(wreckSpot);
    else { this.game.vehicle.speed = 0; this.game.vehicle.throttle = 0; }
    const bill = t(`wreck.${kind}`, { fine: formatNumber(fine) });
    this.game.say(failed ? `${t('mission.failed')} · ${bill}` : bill, true);
  }

  /** Everybody with a health meter over the car: us, mission bots, other players, shared traffic and test cars. */
  meterTargets(): Meter[] {
    const layer = this.game.combatLayer;
    const out: Meter[] = [{ id: 'player', name: t('you'), hp: this.game.playerHp, maxHp: this.game.playerMaxHp, position: this.game.renderVehicle.position }];
    // named cars carry their name above the bar, in their marker's colour
    for (const p of this.game.players.others()) out.push({ id: `net:${p.id}`, name: p.name, hp: p.hp, maxHp: PLAYER_HP, position: p.position, color: PLAYER_MARKER_COLOR });
    const health = new Map((layer?.targetHealth() ?? []).map((h) => [h.id, h]));
    this.game.trafficBots.forEach((bot, index) => {
      if (this.game.isPropBot(bot.id)) return;
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

  updateHealthMarkers(refill = true) {
    // M map: no floating HP bars (they read as green stripes over every car / traffic).
    if (!this.game.driving || this.game.mapInspecting()) { this.healthMeters.hide(); return; }
    const canvas = this.game.map.getCanvas();
    this.healthMeters.update(this.meterTargets(), (p) => this.game.map.project(p), canvas.clientWidth, canvas.clientHeight, refill);
  }

  ensureTrafficMarkers() {
    if (!this.trafficMarkerLayer) {
      this.trafficMarkerLayer = document.createElement('div');
      this.trafficMarkerLayer.className = 'traffic-indicators';
      this.game.host.appendChild(this.trafficMarkerLayer);
    }
    const markerLayer = this.trafficMarkerLayer;
    const active = new Set(
      this.game.trafficBots.filter((bot) => bot.id !== 'wanted' && !this.game.isPropBot(bot.id)).map((bot) => bot.id),
    );
    for (const [id, marker] of this.trafficMarkers) {
      if (active.has(id)) continue;
      marker.element.remove();
      this.trafficMarkers.delete(id);
    }
    this.game.trafficBots.forEach((bot, index) => {
      // bounty bandit: chase arrow is bounty-indicator only (no second name tag)
      if (bot.id === 'wanted' || this.game.isPropBot(bot.id)) return;
      if (this.trafficMarkers.has(bot.id)) return;
      const marker = nameIndicator('traffic-indicator', TRAFFIC_MARKER_COLORS[index % TRAFFIC_MARKER_COLORS.length]);
      marker.name.textContent = bot.driver;
      markerLayer.appendChild(marker.element);
      this.trafficMarkers.set(bot.id, marker);
    });
  }

  updateTrafficMarkers() {
    for (const marker of this.trafficMarkers.values()) marker.element.style.display = 'none';
    // Named mission bots (arena / race / …) — on the HUD and on the M map.
    // Wanted uses bounty-indicator; ambient shared traffic stays unmarked.
    if (!this.game.driving || !this.game.trafficBots.length) return;
    this.ensureTrafficMarkers();
    this.game.trafficBots.forEach((bot, index) => {
      if (bot.id === 'wanted' || this.game.isPropBot(bot.id)) return;
      const marker = this.trafficMarkers.get(bot.id);
      if (!marker) return;
      const dead = !(this.game.combatLayer?.isTargetAlive(bot.id) ?? true);
      marker.element.style.setProperty(
        '--traffic-color',
        dead ? '#8b9198' : TRAFFIC_MARKER_COLORS[index % TRAFFIC_MARKER_COLORS.length],
      );
      marker.element.classList.toggle('is-dead', dead);
      marker.name.textContent = bot.driver;
      this.game.placeTargetIndicator(marker, bot.position, MARKER_PIN_METERS);
    });
  }
}
