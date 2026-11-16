import { roadStart } from '../roadStart.ts';
import { type Position } from '../VehicleController.ts';
import { t } from '@/i18n';
import { metersBetween } from '../meters.ts';
import { newMarker, type MapMarker } from '../hud/mapPins.ts';
import type { GameEngine } from '../GameEngine.ts';

/** What this part reads and drives in the game. */
export type SpawnGame = Pick<GameEngine, 'accumulator' | 'altitude' | 'bearing' | 'cachedRoads' | 'cachedWater' | 'collisionDirty' | 'collisionTime' | 'collisions' | 'driving' | 'map' | 'mapLoaded' | 'mapShown' | 'renderVehicle' | 'setTargetVehicles' | 'settings' | 'showIntroMap' | 'vehicle' | 'water'>;

/**
 * Where the car starts: the player's own spot (clicked on the menu map) or a free road near the
 * city's start, clear of houses, water and other cars; and a free road nearby when we need one.
 */
export class Spawn {
  constructor(private game: SpawnGame) {}

  spawnResolved = false;

  spawnWaits = 0;

  spawnMarker: MapMarker | null = null;

  defaultSpawn: { position: [number, number]; heading: number } | null = null;

  customSpawn: { position: [number, number]; heading: number } | null = null;

  onSpawnSet: (position: [number, number] | null) => void = () => {};

  setSpawnFromClick(lngLat: { lng: number; lat: number }) {
    if (!this.game.mapLoaded) return;
    const origin: [number, number] = [lngLat.lng, lngLat.lat];
    const start = this.findFreeRoad(origin, 140)
      ?? roadStart(this.game.map, origin, () => false, 140);
    const position: [number, number] = start ? [...start.position] : origin;
    const heading = start ? start.heading : this.game.vehicle.heading;
    this.customSpawn = { position, heading };
    this.game.vehicle.position = [...position];
    this.game.vehicle.heading = heading;
    this.game.bearing = heading * 180 / Math.PI;
    this.game.renderVehicle.reset(this.game.vehicle);
    this.game.setTargetVehicles(position, heading);
    this.game.collisionDirty = true;
    if (this.game.settings.terrain) {
      const ground = this.game.map.groundAt(position);
      if (ground != null) this.game.altitude = ground;
    }
    this.placeSpawnMarker(position);
    this.onSpawnSet(position);
  }

  /** A free spot on a loaded road near us, for when no fitting place is loaded: no wait. */
  nearbyRoadSpot(): Position | null {
    return this.findFreeRoad(this.game.vehicle.position, 800)?.position ?? null;
  }

  placeSpawnMarker(position: [number, number] | null) {
    if (!position) {
      this.spawnMarker?.remove();
      this.spawnMarker = null;
      return;
    }
    if (!this.spawnMarker) {
      const el = document.createElement('div');
      el.className = 'spawn-marker';
      el.innerHTML = `<svg width="18" height="26" viewBox="0 0 28 40" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M14 0C6.268 0 0 6.268 0 14c0 9.8 14 26 14 26S28 23.8 28 14C28 6.268 21.732 0 14 0z" fill="#d8f06a" stroke="#1a2818" stroke-width="1.5"/></svg>`;
      this.spawnMarker = newMarker({ element: el, anchor: 'bottom' })
        .setLngLat(position)
        .addTo(this.game.map);
    } else {
      this.spawnMarker.setLngLat(position);
    }
    const element = this.spawnMarker.getElement();
    if (element) element.style.display = this.game.driving ? 'none' : '';
  }

  clearCustomSpawn() {
    this.customSpawn = null;
    if (this.defaultSpawn) {
      this.game.vehicle.position = [...this.defaultSpawn.position];
      this.game.vehicle.heading = this.defaultSpawn.heading;
      this.game.bearing = this.defaultSpawn.heading * 180 / Math.PI;
      this.game.renderVehicle.reset(this.game.vehicle);
      this.game.accumulator = 0;
      this.game.collisionDirty = true;
      this.game.collisionTime = 0;
      this.placeSpawnMarker(this.defaultSpawn.position);
      this.game.setTargetVehicles(this.defaultSpawn.position, this.defaultSpawn.heading);
      if (this.game.mapShown && !this.game.driving) this.game.showIntroMap();
    } else {
      this.placeSpawnMarker(null);
    }
    this.onSpawnSet(null);
  }

  getSpawnPosition(): [number, number] {
    return this.customSpawn ? [this.customSpawn.position[0], this.customSpawn.position[1]] : [this.game.vehicle.position[0], this.game.vehicle.position[1]];
  }

  getSpawnHeading(): number {
    return this.customSpawn ? this.customSpawn.heading : this.game.vehicle.heading;
  }

  /** True when a car pose sits in a building or in water. */
  spawnSpotTaken(position: Position, heading: number) {
    return this.game.collisions.blocked(position, position, heading)
      || this.game.water.resolve(position, position, heading, 1, false).stopped;
  }

  loadSpawnCollisions(at: Position, radius: number) {
    this.game.collisions.update(at, this.game.map.world.buildingsNear(at, radius, this.game.map.exaggeration));
    this.game.water.collect(at, this.game.cachedWater, this.game.cachedRoads);
  }

  /**
   * Nearest drivable road that is clear of buildings and water.
   * Re-checks with solids centered on the candidate so a far road isn't
   * accepted just because the origin radius missed its walls.
   */
  findFreeRoad(origin: Position, maxDistance = 350) {
    if (!this.game.mapLoaded) return null;
    this.loadSpawnCollisions(origin, maxDistance + 40);
    const denied: Position[] = [];
    const blocked = (position: Position, heading: number) => {
      if (denied.some((spot) => metersBetween(spot, position) < 5)) return true;
      return this.spawnSpotTaken(position, heading);
    };
    for (let attempt = 0; attempt < 10; attempt++) {
      const start = roadStart(this.game.map, origin, blocked, maxDistance);
      if (!start) return null;
      this.loadSpawnCollisions(start.position, 120);
      if (!this.spawnSpotTaken(start.position, start.heading)) return start;
      denied.push(start.position);
      this.loadSpawnCollisions(origin, maxDistance + 40);
    }
    return null;
  }

  placeDefaultOnRoad(start: { position: Position; heading: number }, retarget: boolean) {
    this.defaultSpawn = { position: [...start.position], heading: start.heading };
    this.game.vehicle.position = [...start.position];
    this.game.vehicle.heading = start.heading;
    this.game.bearing = start.heading * 180 / Math.PI;
    this.spawnResolved = true;
    if (retarget) this.game.setTargetVehicles(start.position, start.heading);
    this.game.renderVehicle.reset(this.game.vehicle);
    this.game.accumulator = 0;
    this.placeSpawnMarker(start.position);
    this.game.collisionDirty = true;
  }

  resolveSpawn() {
    if (this.spawnResolved) return;
    if (this.customSpawn) {
      if (!this.defaultSpawn) {
        this.defaultSpawn = { position: [...this.game.vehicle.position], heading: this.game.vehicle.heading };
      }
      this.game.vehicle.position = [...this.customSpawn.position];
      this.game.vehicle.heading = this.customSpawn.heading;
      this.game.bearing = this.customSpawn.heading * 180 / Math.PI;
      this.spawnResolved = true;
      this.game.setTargetVehicles(this.customSpawn.position, this.customSpawn.heading);
      this.game.renderVehicle.reset(this.game.vehicle);
      this.game.accumulator = 0;
      this.placeSpawnMarker(this.customSpawn.position);
      return;
    }
    const reach = this.spawnWaits > 8 ? 600 : this.spawnWaits > 4 ? 450 : 350;
    const start = this.findFreeRoad(this.game.vehicle.position, reach);
    if (start) {
      this.placeDefaultOnRoad(start, true);
      return;
    }
    this.spawnWaits++;
    // Keep waiting for roads/buildings — do not drop the car onto a plaza or rooftop.
    if (this.spawnWaits > 24) {
      const anyRoad = roadStart(this.game.map, this.game.vehicle.position, () => false, 800);
      if (anyRoad) this.placeDefaultOnRoad(anyRoad, true);
    }
  }

  /** If more buildings landed on the default pin, nudge it onto a clear road. */
  ensureDefaultSpawnClear() {
    if (!this.spawnResolved || this.customSpawn || this.game.driving || this.game.mapShown || !this.defaultSpawn) return;
    this.loadSpawnCollisions(this.defaultSpawn.position, 120);
    if (!this.spawnSpotTaken(this.defaultSpawn.position, this.defaultSpawn.heading)) return;
    const start = this.findFreeRoad(this.defaultSpawn.position, 140)
      ?? this.findFreeRoad(this.game.vehicle.position, 450);
    if (start) this.placeDefaultOnRoad(start, false);
  }
}
