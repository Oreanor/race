import { BuildingCollisions } from './BuildingCollisions.ts';
import { offsetPosition, type Position } from './VehicleController.ts';
import { DROP_MS, type PickupVisual } from '@/rendering/VehicleLayer';
import { formatNumber, t } from '@/i18n';
import { metersBetween } from './meters.ts';
import { CASH_BUNDLE, ERRAND_BEACONS, COIN_RESPAWN_M, COIN_SPACING_M, METERS_PER_DEGREE } from './tuning.ts';
import type { GameEngine } from './GameEngine.ts';

/** coin grids on open fields: one candidate per this big square of the world (m) */
const FIELD_CELL_M = 1000;
/** …coins this far apart (m) */
const FIELD_STEP_M = 4;
/** …in these shapes (columns × rows): mostly a single trail of up to 10, now and then
 * a strip, 5 × 10 at most */
const FIELD_GRIDS: [number, number][] = [[1, 5], [1, 7], [1, 8], [1, 10], [1, 10], [1, 6], [2, 8], [3, 6], [4, 8], [5, 10]];

/** A coin or a bundle of cash on the ground; `drop`: still flying out from where it came. */
export type ActivePickup = { position: [number, number]; color: string; kind: 'coin' | 'cash'; drop?: { from: [number, number]; at: number; up?: number } };

/** What this part reads and drives in the game. */
export type CoinsGame = Pick<GameEngine, 'audio' | 'cachedWater' | 'car' | 'collectedFrom' | 'collisions' | 'combatLayer' | 'crime' | 'driving' | 'errand' | 'map' | 'mode' | 'pendingIngest' | 'playerMoney' | 'say' | 'trafficBots' | 'trafficNetwork' | 'vehicle' | 'water'>;

/**
 * Coins and cash lying about: along the roads and on open fields, out of wrecks, walls and
 * trains, bundles from a robbed bank; picked up by driving over them or shooting through them.
 */
export class Coins {
  constructor(private game: CoinsGame) {}

  /** coin grids on open fields, one candidate per km² cell: its coins, or null (no room there) */
  fieldCells = new Map<string, [number, number][] | null>();

  fieldAt = 0;

  urbanLevel = 0;

  urbanAt = 0;

  pickups = new Map<string, ActivePickup>();

  /**
   * Road coins taken: where (null: from the save, place unknown). They come back once we are
   * COIN_RESPAWN_M away — so driving the roads keeps paying, without farming a spot.
   */
  collectedPickups = new Map<string, Position | null>();

  pickupFocus: [number, number] | null = null;

  pickupNetworkRevision = -1;

  dropSerial = 0;

  wallCoinsAt = 0;

  trainCoinAt = 0;

  syncRoadPickups() {
    const position = this.game.vehicle.position;
    if (this.pickupNetworkRevision === this.game.trafficNetwork.revision
      && this.pickupFocus
      && metersBetween(this.pickupFocus, position) < 120) return;

    for (const [id, pickup] of this.pickups) {
      if (metersBetween(position, pickup.position) <= 800) continue;
      this.pickups.delete(id);
    }
    // taken coins come back once we are well away (saved ones: once we leave the start)
    const leftStart = !this.game.collectedFrom || metersBetween(position, this.game.collectedFrom) > COIN_RESPAWN_M;
    for (const [id, at] of this.collectedPickups) {
      if (at ? metersBetween(position, at) > COIN_RESPAWN_M : leftStart) this.collectedPickups.delete(id);
    }

    // spinning coins on the road — money only, no coloured score orbs
    for (const spot of this.game.trafficNetwork.pickupLocations(position, 650, 110, COIN_SPACING_M)) {
      const id = `coin:${spot.id}`;
      if (this.pickups.has(id) || this.collectedPickups.has(id)) continue;
      this.pickups.set(id, { position: spot.position, color: '#f2c230', kind: 'coin' });
    }
    this.pickupFocus = [...position];
    this.pickupNetworkRevision = this.game.trafficNetwork.revision;
    this.game.combatLayer?.setPickups(this.pickupVisuals());
  }

  pickupVisuals(): PickupVisual[] {
    const boxes = this.game.errand?.kind === 'collect' ? this.game.errand.boxes : [];
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

  /**
   * A shot takes the coins and cash it passes (within a metre). Road coins stay gone after a reload.
   */
  shotCollectCoins(from: Position, fromAlt: number, to: Position, toAlt: number) {
    const reach = 1;
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
      const ground = this.game.map.groundAt(pickup.position) ?? fromAlt;
      const du = ground + 1 - fromAlt;
      const t = Math.max(0, Math.min(len, dx * ux + dy * uy + du * uu));
      if (Math.hypot(ux * t - dx, uy * t - dy, uu * t - du) > reach) continue;
      this.pickups.delete(id);
      if (!pickup.drop) this.collectedPickups.set(id, [...pickup.position] as Position);
      this.game.audio.coin();
      this.game.combatLayer?.popPickup(id);
      if (pickup.kind === 'cash') {
        money += CASH_BUNDLE;
        if (this.game.crime.heist) this.game.crime.heist.cash += CASH_BUNDLE;
      } else money += 10;
    }
    if (!money) return;
    this.game.playerMoney += money;
    this.game.combatLayer?.setPickups(this.pickupVisuals());
  }

  /** Shooting a vintage train: a coin pops out where the bullet hit (four a second), endlessly. */
  trainCoin(point: [number, number], altitude: number) {
    const now = performance.now();
    if (now - this.trainCoinAt < 250) return; // four coins a second at most
    this.trainCoinAt = now;
    // it bounces out toward the shooter, away from the rails
    const me = this.game.vehicle.position;
    const kx = METERS_PER_DEGREE * Math.cos(point[1] * Math.PI / 180), ky = METERS_PER_DEGREE;
    const dx = (me[0] - point[0]) * kx, dy = (me[1] - point[1]) * ky, d = Math.hypot(dx, dy) || 1;
    const spread = (Math.random() - 0.5) * 1.2;
    const r = Math.min(d * 0.8, 2.2 + Math.random() * 1.8);
    const ux = dx / d, uy = dy / d;
    const rest = offsetPosition(point, (ux - uy * spread) * r, (uy + ux * spread) * r) as [number, number];
    // it leaves from where the bullet struck, up on the car's side
    const up = Math.max(0, altitude - (this.game.map.groundAt(point) ?? altitude));
    this.pickups.set(`drop:${this.dropSerial++}`, { position: rest, color: '#f2c230', kind: 'coin', drop: { from: [...point] as [number, number], at: now, up } });
    this.game.combatLayer?.setPickups(this.pickupVisuals());
  }

  /**
   * Coins jumping out of a wall we hit hard, the way bundles fly out of a bank's door:
   * from the wall at the bumper they bounce out 1.5–4.5 m, anywhere on our side of it.
   */
  wallCoins(at: [number, number], heading: number, count = 3) {
    const now = performance.now();
    const nose = this.game.car.length * 0.55;
    const wall = offsetPosition(at, Math.sin(heading) * nose, Math.cos(heading) * nose) as [number, number];
    for (let i = 0; i < count; i++) {
      // away from the wall: the half-circle behind the bumper
      const angle = heading + Math.PI + (Math.random() - 0.5) * Math.PI;
      let r = 1.5 + Math.random() * 3;
      let rest = offsetPosition(wall, Math.sin(angle) * r, Math.cos(angle) * r) as [number, number];
      while (r > 0.6 && this.game.collisions.sightBlocked(wall, rest)) {
        r *= 0.5;
        rest = offsetPosition(wall, Math.sin(angle) * r, Math.cos(angle) * r) as [number, number];
      }
      this.pickups.set(`drop:${this.dropSerial++}`, { position: rest, color: '#f2c230', kind: 'coin', drop: { from: wall, at: now } });
    }
    this.game.combatLayer?.setPickups(this.pickupVisuals());
  }

  dropCoins(at: [number, number], count = 10) {
    const now = performance.now();
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.5;
      let r = (count > 1 ? 0.9 : 0.6) + Math.random() * 2.1;
      let rest = offsetPosition(at, Math.sin(angle) * r, Math.cos(angle) * r) as [number, number];
      // not into a house: pull it back toward the wreck
      while (r > 0.4 && this.game.collisions.sightBlocked(at, rest)) {
        r *= 0.5;
        rest = offsetPosition(at, Math.sin(angle) * r, Math.cos(angle) * r) as [number, number];
      }
      this.pickups.set(`drop:${this.dropSerial++}`, { position: rest, color: '#f2c230', kind: 'coin', drop: { from: [...at] as [number, number], at: now } });
    }
    this.game.combatLayer?.setPickups(this.pickupVisuals());
  }

  collectRoadPickups() {
    const collect = (position: [number, number], player = false) => {
      let money = 0;
      const now = performance.now();
      for (const [id, pickup] of this.pickups) {
        if (pickup.drop && now < pickup.drop.at + DROP_MS) continue; // still in the air
        if (pickup.kind === 'cash' && !player) continue;             // bank money is ours to grab
        if (metersBetween(position, pickup.position) > (pickup.kind === 'cash' ? 4.5 : 3.5)) continue;
        this.pickups.delete(id);
        if (!pickup.drop) this.collectedPickups.set(id, [...pickup.position] as Position); // gone until we drive away
        // the coin hops up and falls as it is taken; we hear our own pickups
        this.game.combatLayer?.popPickup(id);
        if (player) this.game.audio.coin();
        if (pickup.kind === 'cash') {
          money += CASH_BUNDLE;
          if (this.game.crime.heist) this.game.crime.heist.cash += CASH_BUNDLE;
          this.game.say(t('heist.cash', { n: formatNumber(CASH_BUNDLE) }), true);
        } else money += 10;
      }
      return money;
    };
    const playerMoney = collect(this.game.vehicle.position, true);
    this.game.playerMoney += playerMoney;
    let totalMoney = playerMoney;
    for (const bot of this.game.trafficBots) {
      const money = collect(bot.position);
      bot.money += money;
      totalMoney += money;
    }
    if (totalMoney) this.game.combatLayer?.setPickups(this.pickupVisuals());
  }

  /**
   * Coin grids on big open fields: every 1 km cell of the world has one candidate spot,
   * size and turn (the same for everybody); when we come within 700 m it is checked once —
   * no houses, water or roads over the grid and a margin round it — and if clear, its coins
   * are laid in rows 3 m apart. Taken coins come back like road coins (1.5 km away).
   */
  updateFieldCoins(now: number) {
    if (now - this.fieldAt < 1500 || !this.game.driving || this.game.mode !== 'roam') return;
    this.fieldAt = now;
    const here = this.game.vehicle.position as [number, number];
    const kx = 111_319.49 * Math.cos(here[1] * Math.PI / 180), ky = 111_319.49;
    const cx = Math.floor(here[0] * kx / FIELD_CELL_M), cy = Math.floor(here[1] * ky / FIELD_CELL_M);
    const hash = (a: number, b: number, salt: number) => {
      let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(salt, 83492791)) >>> 0;
      h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    };
    let added = false;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const gx = cx + dx, gy = cy + dy;
        const key = `${gx}:${gy}`;
        const center: [number, number] = [
          (gx + 0.15 + hash(gx, gy, 1) * 0.7) * FIELD_CELL_M / kx,
          (gy + 0.15 + hash(gx, gy, 2) * 0.7) * FIELD_CELL_M / ky,
        ];
        if (metersBetween(here, center) > 700) continue;
        let spots = this.fieldCells.get(key);
        if (spots === undefined) {
          // ground or water not in yet: look again later. A tile whose water is still
          // waiting to be read would pass the open sea off as a field.
          if (this.game.map.groundAt(center) == null || this.game.pendingIngest.size > 0 || !this.game.water.near(here, 200)) continue;
          const [cols, rows] = FIELD_GRIDS[Math.floor(hash(gx, gy, 3) * FIELD_GRIDS.length)];
          const turn = hash(gx, gy, 4) * Math.PI;
          spots = this.layFieldGrid(center, cols, rows, turn);
          this.fieldCells.set(key, spots);
        }
        if (!spots) continue;
        spots.forEach((at, i) => {
          const id = `field:${key}:${i}`;
          if (this.pickups.has(id) || this.collectedPickups.has(id) || metersBetween(here, at) > 800) return;
          // and each coin once more, against the water as it stands now: never on the sea
          if (this.game.water.inSea(at, this.game.cachedWater)) return;
          this.pickups.set(id, { position: at, color: '#f2c230', kind: 'coin' });
          added = true;
        });
      }
    }
    if (added) this.game.combatLayer?.setPickups(this.pickupVisuals());
  }

  /** The grid's coin spots if the field is clear (houses, water, roads), else null. */
  layFieldGrid(center: [number, number], cols: number, rows: number, turn: number): [number, number][] | null {
    const width = (cols - 1) * FIELD_STEP_M, depth = (rows - 1) * FIELD_STEP_M;
    const ux = [Math.cos(turn), -Math.sin(turn)], uy = [Math.sin(turn), Math.cos(turn)];
    const at = (u: number, v: number) => offsetPosition(center, ux[0] * u + uy[0] * v, ux[1] * u + uy[1] * v) as [number, number];
    // the area with a margin, sampled every ~6 m — against the houses round the grid itself
    // (our collision set only reaches 260 m round the car) and the water (900 m)
    const margin = 10;
    const none = new Set<string>();
    const houses = new BuildingCollisions();
    houses.update(center, this.game.map.world.buildingsNear(center, Math.hypot(width, depth) / 2 + margin + 20, this.game.map.exaggeration));
    for (let u = -width / 2 - margin; u <= width / 2 + margin; u += 6) {
      for (let v = -depth / 2 - margin; v <= depth / 2 + margin; v += 6) {
        const p = at(u, v);
        if (houses.blocked(p, p, turn) || this.game.water.covers(p, true)) return null;
      }
    }
    // no road through or right beside it (a field, not a car park or a junction)
    for (let u = -width / 2; u <= width / 2 + 0.1; u += 9) {
      for (let v = -depth / 2; v <= depth / 2 + 0.1; v += 9) {
        if (this.game.trafficNetwork.nearest(at(u, v), none, 0, 14)) return null;
      }
    }
    const out: [number, number][] = [];
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) out.push(at(-width / 2 + i * FIELD_STEP_M, -depth / 2 + j * FIELD_STEP_M));
    }
    return out;
  }
}
