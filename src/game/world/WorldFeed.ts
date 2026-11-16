import { roadStart } from '../roadStart.ts';
import { type MapFeature } from '../WaterCollisionController.ts';
import { cameraConfig, zoomForDistance } from '@/config/camera.config';
import { distanceToTile } from '@/world3d/tiles/tilePlan';
import { mercatorX, mercatorY } from '@/world3d/mercator';
import { t } from '@/i18n';
import { METERS_PER_DEGREE } from '../tuning.ts';
import type { GameEngine } from '../GameEngine.ts';

/** tiles this close to the car feed gameplay (the world's feature radius, plus slack) */
const NEAR_TILE_METERS = 2600;

/** What this part reads and drives in the game. */
export type WorldFeedGame = Pick<GameEngine, 'altitude' | 'bootAt' | 'bootChaseWarmed' | 'cachedLanduse' | 'cachedRoads' | 'cachedWater' | 'camera' | 'collectWorldSteps' | 'collisionDirty' | 'collisionTime' | 'distance' | 'driving' | 'featureReadFailures' | 'focusTime' | 'ground' | 'groundHits' | 'map' | 'mapLoaded' | 'mapShown' | 'overview' | 'places' | 'rails' | 'ready' | 'say' | 'setTargetVehicles' | 'settings' | 'spawn' | 'syncedAt' | 'tilesIngested' | 'trafficNetwork' | 'vehicle' | 'water'>;

/**
 * The world coming in: new tiles' roads, water, buildings and places taken into the game a
 * little each frame, the first settle before the drive, and the streaming burst at boot.
 */
export class WorldFeed {
  constructor(private game: WorldFeedGame) {}

  settleFrames = 0;

  worldWork: Generator<null, void> | null = null;

  /** tiles whose roads/water/poi are already in the gameplay caches / traffic graph */
  ingestedTiles = new Set<string>();

  /** near-car tiles that arrived since the last ingest pass */
  pendingIngest = new Set<string>();

  /** keep isotropic/fast uploads until this time (ms), then endStreamBurst */
  bootBurstUntil = 0;

  tickStreamBurst(now = performance.now()) {
    if (!this.bootBurstUntil || now < this.bootBurstUntil) return;
    this.bootBurstUntil = 0;
    this.game.map.endStreamBurst();
  }

  settleBoot() {
    if (this.game.mapShown || !this.game.ready) return;
    const waited = performance.now() - this.game.bootAt;
    if (!this.game.spawn.spawnResolved) {
      this.game.say(t('status.placing'));
      if (waited > 12000) {
        // Last resort: any nearby road segment, even if solids are still thin.
        const start = this.game.spawn.findFreeRoad(this.game.vehicle.position, 800)
          ?? roadStart(this.game.map, this.game.vehicle.position, () => false, 800);
        if (start) this.game.spawn.placeDefaultOnRoad(start, true);
        else {
          this.game.spawn.spawnResolved = true;
          this.game.spawn.defaultSpawn = { position: [...this.game.vehicle.position], heading: this.game.vehicle.heading };
          // the run's purse and garage too: without them the intro offers a car the engine
          // then will not start ("not enough money"), the page left waiting for nothing
          this.game.setTargetVehicles(this.game.spawn.defaultSpawn.position, this.game.spawn.defaultSpawn.heading);
          this.game.spawn.placeSpawnMarker(this.game.spawn.defaultSpawn.position);
        }
      }
      return;
    }
    if (this.game.settings.terrain) {
      if (!this.game.map.hasGround()) {
        this.game.say(t('status.terrain'));
        return;
      }
      const ground = this.game.map.groundAt(this.game.vehicle.position);
      if (ground == null) {
        this.game.groundHits = 0;
        this.game.say(t('status.terrain'));
        if (waited < 10000) return;
      } else {
        const stable = this.game.ground.lastGround != null && Math.abs(ground - this.game.ground.lastGround) < 0.35;
        this.game.groundHits = stable ? this.game.groundHits + 1 : 0;
        this.game.ground.lastGround = ground;
        this.game.altitude = ground;
        if (this.game.groundHits < 10 && waited < 10000) {
          this.game.say(t('status.terrain'));
          return;
        }
      }
    } else {
      this.game.altitude = 0;
    }
    // Chase zoom/pitch, centred on the car (still invisible): burst loads the full
    // loadRadius ring — looking left/right on start must not hitch on cold tiles.
    if (!this.game.bootChaseWarmed) {
      this.game.map.beginStreamBurst();
      const bearing = this.game.vehicle.heading * 180 / Math.PI;
      const zoom = zoomForDistance(this.game.distance, this.game.vehicle.position[1]);
      this.game.map.jumpTo({
        center: [...this.game.vehicle.position] as [number, number],
        zoom,
        pitch: cameraConfig.pitch,
        bearing,
        elevation: this.game.altitude,
      });
      this.game.bootChaseWarmed = true;
      this.settleFrames = 0;
      this.game.say(t('status.streets'));
      return;
    }
    // Full isotropic loadRadius ring must be fetched + uploaded before "ready"
    const ring = this.game.map.loadRadius;
    const warmCap = 55000;
    if (!this.game.map.areTilesLoaded(ring) && waited < warmCap) {
      this.game.say(t('status.streets'));
      return;
    }
    if (!this.game.map.areTilesLoadedAround(this.game.vehicle.position as [number, number], ring) && waited < warmCap) {
      this.game.say(t('status.streets'));
      return;
    }
    if (!this.game.syncedAt) {
      this.game.collisionDirty = true;
      this.game.say(t('status.block'));
      if (waited < 14000) return;
    }
    if (this.game.collisionDirty || this.worldWork) {
      this.game.say(t('status.blocks'));
      return;
    }
    if (this.settleFrames < 24) {
      this.settleFrames++;
      return;
    }
    this.game.camera.revealMap();
  }

  readSourceLayer(layer: string) {
    try {
      const features = this.game.map.features(layer) as MapFeature[];
      this.game.featureReadFailures.delete(layer);
      return features;
    } catch (error) {
      if (!this.game.featureReadFailures.has(layer)) {
        this.game.featureReadFailures.add(layer);
        console.error(`Failed to read map source layer "${layer}"`, error);
      }
      return [] as MapFeature[];
    }
  }

  /** Pull one resident tile into gameplay caches / traffic / rails / POIs. */
  absorbTile(key: string) {
    // features are ready at onTile; GPU waiting queue is unrelated
    if (this.ingestedTiles.has(key) || !this.game.map.world.hasTile(key)) return;
    const world = this.game.map.world;
    const water = world.featuresOf(key, 'water') as MapFeature[];
    const roads = world.featuresOf(key, 'transportation') as MapFeature[];
    const landuse = world.featuresOf(key, 'landuse') as MapFeature[];
    const poi = world.featuresOf(key, 'poi') as MapFeature[];
    if (water.length) this.game.cachedWater.push(...water);
    if (roads.length) {
      this.game.cachedRoads.push(...roads);
      this.game.rails.addFeatures(roads);
      this.game.trafficNetwork.addFeatures(roads);
    }
    if (landuse.length) this.game.cachedLanduse.push(...landuse);
    if (poi.length) this.game.places.collectStations(poi);
    this.ingestedTiles.add(key);
  }

  /** After a full scoop: mark every tile in feature range so we don't re-absorb it. */
  rememberIngested(focus: [number, number]) {
    this.ingestedTiles.clear();
    const mx = mercatorX(focus[0]), my = mercatorY(focus[1]);
    const scale = Math.cos(focus[1] * Math.PI / 180);
    const reach = this.game.map.world.options.featureRadius;
    for (const key of this.game.map.world.tileKeys()) {
      const [z, x, y] = key.split('/').map(Number);
      if (![z, x, y].every(Number.isFinite)) continue;
      if (distanceToTile(mx, my, { z, x, y }, scale) > reach) continue;
      this.ingestedTiles.add(key);
    }
  }

  /** Is this tile ("z/x/y") within reach of the gameplay data around the car? */
  nearCar(key: string) {
    const [z, x, y] = key.split('/').map(Number);
    if (![z, x, y].every(Number.isFinite)) return true;
    const [lng, lat] = this.game.vehicle.position;
    return distanceToTile(mercatorX(lng), mercatorY(lat), { z, x, y }, Math.cos(lat * Math.PI / 180)) <= NEAR_TILE_METERS;
  }

  pumpWorld(now: number) {
    const movedLimit = this.game.driving ? 90 : 40;
    const origin = this.game.syncedAt;
    const cos = Math.cos(this.game.vehicle.position[1] * Math.PI / 180);
    const center = this.game.map.getCenter();
    const checkPoint: [number, number] = this.game.driving ? this.game.vehicle.position : [center.lng, center.lat];
    const moved = origin ? Math.hypot((checkPoint[0] - origin[0]) * METERS_PER_DEGREE * cos, (checkPoint[1] - origin[1]) * METERS_PER_DEGREE) : Infinity;
    const needsCoverage = !this.game.water.near(this.game.vehicle.position);
    // Pending tile ingest is cheap — run soon. Full scoop stays rare/slow.
    const pending = this.pendingIngest.size > 0;
    const tileDebounce = pending
      ? (this.game.overview > 0.2 ? 700 : 350)
      : this.game.overview > 0.2 ? 2800
        : this.game.driving ? 1600
          : (this.game.mapShown ? 1800 : 250);
    const refreshTiles = (!this.game.tilesIngested || this.game.collisionDirty || pending) && now - this.game.collisionTime >= tileDebounce;
    const needFocus = needsCoverage || moved >= movedLimit;

    if (!this.worldWork && this.game.mapLoaded) {
      if (refreshTiles) {
        this.game.collisionTime = now;
        this.game.collisionDirty = false;
        this.game.focusTime = now;
        this.worldWork = this.game.collectWorldSteps(true);
      } else if (needFocus && now - this.game.focusTime >= 160) {
        this.game.focusTime = now;
        this.worldWork = this.game.collectWorldSteps(false);
      }
    }

    if (!this.worldWork) return;
    // background reading gets a slice of the frame; the map view (M) keeps it small
    const deadline = performance.now() + (this.game.driving || this.game.overview > 0 ? 2.2 : 8);
    while (this.worldWork && performance.now() < deadline) {
      if (this.worldWork.next().done) this.worldWork = null;
    }
  }
}
