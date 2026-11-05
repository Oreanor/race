import { cars as carsConfig, type Car } from '@/config/vehicle.config';
import { t } from '@/i18n';
import { createNet, type ChatLine, type Net, type NetNotice, type RemotePlayer } from '@/net/NetClient';
import type { TrafficCar } from '@/net/protocol';
import type { VehicleSceneLayer } from '@/rendering/VehicleLayer';
import { bumpDamage, metersBetween, resolveVehicleCollision, type Position, type VehicleController } from '../VehicleController';
import { nameIndicator, placeIndicator, type IndicatorView } from '../hud/indicators';

/** other players' map marker and the name over their health bar */
export const PLAYER_MARKER_COLOR = '#7cf0b0';

// Other players in the shared world, from the game's side: report our car,
// draw everybody else (through the vehicle layer), point at them, bump into
// them, and feed the "who is online" list and the chat to the HUD.

/** One line of the "who is online" list. Distance in meters from our car. */
export type OnlinePlayer = { id: string; name: string; distance: number; busy: boolean };

/** What the multiplayer needs from the game, read fresh every frame. */
export type NetHost = {
  host: HTMLElement;
  view: IndicatorView;
  layer(): VehicleSceneLayer | null;
  vehicle: VehicleController;
  car(): Car;
  /** our altitude and the body's lean (radians) */
  altitude(): number;
  /** our health */
  hp(): number;
  /** we knocked into another player's car: our share of the damage */
  bumped(damage: number): void;
  lean(): { pitch: number; roll: number };
  driving(): boolean;
  /** the map view (M) is open: pins wherever the target is in frame */
  mapView(): boolean;
  /** on a mission: others see us parked where it began */
  busy(): boolean;
  /** may our car move here (no wall, no water in the way)? */
  canMove(from: Position, to: Position, heading: number): boolean;
  online(players: OnlinePlayer[]): void;
  chat(line: ChatLine): void;
  notice(notice: NetNotice): void;
  /** another player's bullet hit us; true when it blew us up */
  hitBy(name: string, damage: number): boolean;
  /** a line for the screen: who blew up whom */
  news(text: string): void;
  /** the traffic another player drives; a bullet hit one of ours */
  traffic(from: string, cars: TrafficCar[]): void;
  trafficHit(id: string): void;
  /** somebody hijacked a car we parked */
  trafficTaken(id: string): void;
};

const carOf = (id: string) => carsConfig.find((c) => c.id === id) ?? carsConfig[0];


export class NetPlayers {
  private net: Net | null = null;
  private layer: HTMLDivElement | null = null;
  private markers = new Map<string, ReturnType<typeof nameIndicator>>();
  /** where a mission began: others see us parked there until it is over */
  private anchor: { position: Position; heading: number; altitude: number } | null = null;
  private remotes: RemotePlayer[] = [];
  private listedAt = 0;
  private bumpedAt = new Map<string, number>();

  constructor(private game: NetHost) {}

  /** Join the shared world under this name (again: just a rename). */
  join(name: string) {
    if (this.net) { this.net.rename(name); return; }
    this.net = createNet(name, this.game.car().id);
    if (!this.net) return;
    this.net.onChat = (line) => this.game.chat(line);
    this.net.onNotice = (notice) => this.game.notice(notice);
    this.net.onHit = (from, name, damage) => {
      if (this.anchor) return; // parked on a mission: out of the fight
      if (this.game.hitBy(name, damage)) this.net?.down(from);
    };
    this.net.onTraffic = (from, cars) => this.game.traffic(from, cars);
    this.net.onTrafficHit = (id) => this.game.trafficHit(id);
    this.net.onTake = (id) => this.game.trafficTaken(id);
    this.net.onDown = (event) => {
      const text = event.me ? t('pvp.downMe', { by: event.byName })
        : event.mine ? t('pvp.downMine', { name: event.name })
          : t('pvp.down', { by: event.byName, name: event.name });
      this.game.news(text);
      this.game.chat({ id: '', name: '⚔', text, at: Date.now(), mine: false });
    };
  }

  say(text: string) { this.net?.say(text); }

  /** Our id on the server (null offline or not yet connected). */
  id() { return this.net?.id ?? null; }
  /** Everybody else, where they are now. */
  others(): readonly RemotePlayer[] { return this.remotes; }
  /** Send the traffic we drive; report a hit on somebody else's. */
  sendTraffic(cars: TrafficCar[]) { this.net?.traffic(cars); }
  hitTraffic(id: string) { this.net?.trafficHit(id); }
  takeTraffic(id: string) { this.net?.take(id); }

  /** Our bullet hit another player's car (not one parked on a mission). True when it counts. */
  shot(id: string) {
    const remote = this.remotes.find((r) => r.id === id);
    if (!this.net || !remote || remote.busy || this.anchor) return false;
    this.net.hit(id);
    return true;
  }

  /** Report our car, draw the others and point at them; once a frame. */
  update() {
    const net = this.net;
    const { vehicle } = this.game;
    if (!net) return;
    const busy = this.game.busy();
    if (busy && !this.anchor) this.anchor = { position: [...vehicle.position], heading: vehicle.heading, altitude: this.game.altitude() };
    if (!busy) this.anchor = null;
    if (this.game.driving()) {
      const anchor = this.anchor;
      const lean = anchor ? { pitch: 0, roll: 0 } : this.game.lean();
      net.report(anchor?.position ?? [...vehicle.position], anchor?.altitude ?? this.game.altitude(), anchor?.heading ?? vehicle.heading,
        anchor ? 0 : vehicle.speed, lean.pitch, lean.roll, this.game.car().id, busy, this.game.hp());
    }
    const players = net.players();
    this.remotes = players;
    const now = performance.now();
    if (now - this.listedAt > 500) {
      this.listedAt = now;
      this.game.online(players
        .map((p) => ({ id: p.id, name: p.name, busy: p.busy, distance: metersBetween(vehicle.position, p.position) }))
        .sort((a, b) => a.distance - b.distance));
    }
    this.game.layer()?.setRemotes(players.map((p) => ({
      id: p.id, car: carOf(p.car), position: p.position, heading: p.heading, altitude: p.altitude, pitch: p.pitch, roll: p.roll, hp: p.hp,
    })));
    this.point(players);
  }

  /**
   * Bump into other players. Each client moves only its own car: we take the whole
   * separation and lose some pace; the other side does the same on its screen.
   */
  bump(now: number) {
    if (!this.remotes.length || this.anchor) return; // on a mission we are "parked" for the others
    const { vehicle } = this.game;
    const altitude = this.game.altitude();
    for (const remote of this.remotes) {
      if (remote.busy || Math.abs(remote.altitude - altitude) > 3) continue; // a bridge above, a road below
      const hit = resolveVehicleCollision(
        { position: vehicle.position, heading: vehicle.heading, speed: vehicle.speed, length: this.game.car().length },
        { position: remote.position, heading: remote.heading, speed: remote.speed, length: carOf(remote.car).length },
      );
      if (!hit) continue;
      // our share plus theirs: where they would have been pushed, we go the other way
      const next: Position = [hit.a[0] - (hit.b[0] - remote.position[0]), hit.a[1] - (hit.b[1] - remote.position[1])];
      if (this.game.canMove(vehicle.position, next, vehicle.heading)) vehicle.position = next;
      if (now - (this.bumpedAt.get(remote.id) ?? 0) < 280) continue;
      this.bumpedAt.set(remote.id, now);
      // both sides take the knock, each on their own screen
      this.game.bumped(bumpDamage(Math.abs(vehicle.speed) + Math.abs(remote.speed)));
      vehicle.speed *= 0.6;
    }
  }

  private point(players: RemotePlayer[]) {
    if (!this.layer) {
      this.layer = document.createElement('div');
      this.layer.className = 'traffic-indicators player-indicators';
      this.game.host.appendChild(this.layer);
    }
    const seen = new Set(players.map((p) => p.id));
    for (const [id, marker] of this.markers) if (!seen.has(id)) { marker.element.remove(); this.markers.delete(id); this.bumpedAt.delete(id); }
    const driving = this.game.driving();
    for (const player of players) {
      let marker = this.markers.get(player.id);
      if (!marker) {
        marker = nameIndicator('traffic-indicator player-indicator', PLAYER_MARKER_COLOR);
        this.layer.appendChild(marker.element);
        this.markers.set(player.id, marker);
      }
      if (!driving) { marker.element.style.display = 'none'; continue; }
      marker.name.textContent = player.busy ? `${player.name} · ${t('net.busy')}` : player.name;
      placeIndicator(this.game.view, marker, this.game.vehicle.position, player.position, undefined, this.game.mapView());
    }
  }

  dispose() {
    this.net?.close();
    this.net = null;
    this.layer?.remove();
    this.markers.clear();
  }
}
