import { cameraConfig } from '@/config/camera.config';
import { t } from '@/i18n';
import type { GameEngine } from './GameEngine.ts';

/** An angle in degrees as −180 … 180 (the same turn, the short way). */
export const wrapDegrees = (deg: number) => ((deg + 180) % 360 + 360) % 360 - 180;
/** where the camera (zoom, tilt, turn) is kept between reloads */
export const CAMERA_STORE = 'race.camera';

/** What this part reads and drives in the game. */
export type CameraRigGame = Pick<GameEngine, 'altitude' | 'cameraSaved' | 'cameraSavedAt' | 'disposed' | 'distance' | 'dragging' | 'driving' | 'feed' | 'host' | 'keys' | 'lookDragging' | 'lookOrigin' | 'lookPointer' | 'map' | 'mapShown' | 'menuView' | 'northUp' | 'onBoot' | 'orbit' | 'overview' | 'overviewFree' | 'overviewLeave' | 'overviewTarget' | 'pitch' | 'places' | 'runReady' | 'say' | 'setMapViewUi' | 'setTargetVehicles' | 'settings' | 'stopGun' | 'vehicle'>;

/**
 * The camera's moves outside the chase itself: the M map from above (in, free pan and zoom,
 * back out), the arrow-key nudges, north up, resetting behind the car, and the menu view.
 */
export class CameraRig {
  constructor(private game: CameraRigGame) {}

  /** ~1.4 km across the screen height — 2 km of Manhattan rooftops murdered the GPU */
  overviewZoom(lat: number) {
    const height = this.game.map.getCanvas().clientHeight || 800;
    const mercPerMeter = 1 / (2 * Math.PI * 6371008.8 * Math.cos(lat * Math.PI / 180));
    return Math.log2((height / 1400) / mercPerMeter / 512);
  }

  setOverviewMapNav(on: boolean) {
    if (on) this.game.map.setInteractive({ pan: true, rotate: false });
    else if (this.game.driving) this.game.map.setInteractive({ pan: false, rotate: false });
    else if (!this.game.driving && this.game.mapShown) this.game.map.setInteractive({ pan: true, rotate: false });
  }

  toggleOverview() {
    if (this.game.overviewTarget) {
      // closing — remember where the player was looking
      const c = this.game.map.getCenter();
      this.game.overviewLeave = { center: [c.lng, c.lat], zoom: this.game.map.getZoom() };
      this.game.overviewTarget = 0;
      this.game.overviewFree = false;
      this.setOverviewMapNav(false);
      this.game.setMapViewUi(false);
      // calm through the descent — burst mid-blend was the 5–7 FPS stall
      this.game.map.setStreamCalm(true);
    } else {
      this.game.overviewLeave = null;
      this.game.overviewTarget = 1;
      this.game.overviewFree = false;
      this.game.stopGun();
      this.game.lookPointer = null;
      this.game.lookOrigin = null;
      this.game.lookDragging = false;
      this.game.dragging = false;
      this.game.setMapViewUi(true);
      this.game.map.setScreenStream(true);
      this.game.map.setStreamCalm(true);
    }
  }

  nudgeCamera(dt: number) {
    const yaw = Number(this.game.keys.has('ArrowRight')) - Number(this.game.keys.has('ArrowLeft'));
    if (yaw) this.game.orbit += yaw * dt * 75 * this.game.settings.sensitivity;
    const zoom = Number(this.game.keys.has('ArrowDown')) - Number(this.game.keys.has('ArrowUp'));
    if (!zoom) return;
    const next = this.game.distance * Math.exp(zoom * dt * 0.9 * this.game.settings.sensitivity);
    this.game.distance = Math.max(cameraConfig.minDistance, Math.min(cameraConfig.maxDistance, next));
  }

  /** Remember the camera (at most once a second, and only when it moved). */
  saveCamera(now: number) {
    if (now - this.game.cameraSavedAt < 1000) return;
    this.game.cameraSavedAt = now;
    const text = JSON.stringify({ distance: +this.game.distance.toFixed(2), pitch: +this.game.pitch.toFixed(2), orbit: +wrapDegrees(this.game.orbit).toFixed(2) });
    if (text === this.game.cameraSaved) return;
    this.game.cameraSaved = text;
    try { localStorage.setItem(CAMERA_STORE, text); } catch { /* private mode: this session only */ }
  }

  resetCamera() {
    this.game.orbit = 0;
    this.game.distance = cameraConfig.distance;
    this.game.pitch = cameraConfig.pitch;
  }

  /**
   * Turn the view to north up, smoothly. Driving, it stays so (the car turns under
   * it) until the player turns the view; on the menu and the map it simply turns.
   */
  faceNorth() {
    if (this.game.driving) {
      this.game.northUp = true;
      this.game.orbit = 0;
      return;
    }
    const from = this.game.map.getBearing();
    const start = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - start) / 650);
      const eased = t * t * (3 - 2 * t);
      this.game.map.jumpTo({ bearing: from * (1 - eased) });
      if (t < 1 && !this.game.disposed) requestAnimationFrame(step);
    };
    step();
  }

  /** Pitched chase-style framing (fly-in / resume), not the intro menu. */
  introView() {
    return {
      center: this.game.vehicle.position as [number, number],
      zoom: 16.8,
      pitch: 57,
      bearing: this.game.vehicle.heading * 180 / Math.PI - 25,
      elevation: this.game.altitude,
    };
  }

  /** Intro menu: top-down city map (same as M while driving) — pan/zoom, click to place spawn. */
  showIntroMap() {
    const center = this.game.vehicle.position as [number, number];
    this.game.overview = 1;
    this.game.overviewTarget = 1;
    this.game.overviewFree = true;
    this.game.overviewLeave = null;
    this.game.menuView = null;
    this.game.map.setScreenStream(true);
    this.game.map.setStreamCalm(false);
    this.game.map.jumpTo({
      center,
      zoom: this.overviewZoom(center[1]),
      pitch: 0,
      bearing: 0,
      elevation: this.game.altitude,
    });
    this.game.map.setInteractive({ pan: true, rotate: false });
    this.game.setMapViewUi(true);
    queueMicrotask(() => { if (!this.game.driving && this.game.overviewFree) this.game.places.refreshMapLabels(true); });
  }

  revealMap() {
    if (this.game.mapShown || this.game.disposed) return;
    // never an intro before the run's purse and garage are in (whatever way the spawn
    // was settled): the intro and the engine must agree on what we own
    if (!this.game.runReady) this.game.setTargetVehicles([...this.game.vehicle.position] as [number, number], this.game.vehicle.heading);
    this.game.mapShown = true;
    // The ring is prepared while hidden. Visible frames use the normal upload budget.
    this.game.map.endStreamBurst();
    this.game.feed.bootBurstUntil = 0;
    this.showIntroMap();
    this.game.host.style.transition = 'opacity .7s ease';
    this.game.host.style.opacity = '1';
    this.game.onBoot(true);
    this.game.say(t('status.ready'));
  }
}
