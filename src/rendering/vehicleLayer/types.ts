import type { FirePaneSpec } from '../BurningHouse.ts';
import type { MapLayer } from '@/world3d/map/ThreeMap';
import type { Car } from '@/config/vehicle.config';
import type { Position } from '@/game/VehicleController';

export type TargetVehicle = {
  id: string;
  driver: string;
  car: Car;
  position: Position;
  heading: number;
  /** mission prop already lying as a wreck (ambulance crash, etc.) */
  propWreck?: { overturned?: boolean; burning?: boolean };
};
/** Another player's car (multiplayer): drawn only, never shot or hit here. Altitude in meters as drawn. */
export type RemoteCar = { id: string; car: Car; position: Position; heading: number; altitude: number; pitch: number; roll: number; hp?: number };
export type TargetHealth = { id: string; driver: string; color: string; hp: number; maxHp: number };
/** `drop`: a coin thrown out of a wreck — it flies from `from` to `position` from time `at`, bouncing */
export type PickupVisual = { id: string; position: Position; color: string; kind?: 'ball' | 'coin' | 'cash' | 'box'; drop?: { from: Position; at: number; up?: number } };

/** how long a coin from a wreck bounces and rolls before it lies still (ms) */
export const DROP_MS = 1300;

/** `altitude` / `wall` from map.pickScreen — without them guns aim at the ground plane and hit façades low */
export type AimPoint = { ground: Position; screen: [number, number]; altitude?: number; wall?: boolean };

export type MissionBeaconSpec = {
  id: string;
  position: Position;
  kind?: 'arena' | 'race' | 'bounty' | 'fire' | 'impound' | 'taxi' | 'bus' | 'ambulance';
  colors?: { pole: string; glow: string; orb: string };
};

export type VehicleSceneLayer = MapLayer & {
  /** host-drawn mode: the host renders `scene` placed by `placement` (local → mercator) */
  scene: import('three').Scene;
  placement: import('three').Matrix4;
  fuse: () => void;
  /** headlamp glow, 0 off … 1 full (night) */
  setHeadlights: (on: number) => void;
  setAim: (aim: AimPoint | null) => void;
  /** what the cursor points at as the camera sees it: the first wall on its ray, else the ground */
  aimTarget: () => { position: Position; altitude: number; wall: boolean } | null;
  setFiring: (firing: boolean) => void;
  flashPlayer: (duration: number) => void;
  /** a hunting target fires at our car: muzzle flash, a tracer, and sparks on us or beside us */
  enemyShot: (fromId: string, hit: boolean) => void;
  /** our engine is on fire (a disabled car): smoke and sparks from the hood, call every frame */
  burnPlayer: () => void;
  setCar: (next: Car) => void;
  /** our police lights on (flashing) or off */
  setBeacons: (on: boolean) => void;
  setTargets: (vehicles: TargetVehicle[]) => void;
  /** targets beside the missions' (shared traffic, test cars): by id, never counted for a mission */
  setExtraTargets: (vehicles: TargetVehicle[]) => void;
  /**
   * Park a mission prop already as a wreck (no tumble/explosion).
   * `overturned` tips it on the side/roof; `burning` leaves hood fire for a bit.
   */
  plantPropWreck: (id: string, opts?: { overturned?: boolean; burning?: boolean }) => void;
  /** a target's health as its owner says (shared traffic); 0 blows it up */
  setTargetHp: (id: string, hp: number) => void;
  targetHp: (id: string) => number | null;
  /** the extra targets still standing, for the HUD's health meters */
  extraHealth: () => (TargetHealth & { position: Position })[];
  /** our bullet hit a target */
  onTargetHit: (id: string) => void;
  /** any target blew up (shot, rammed, or reported by its owner) */
  onTargetDestroyed: (id: string, position: Position) => void;
  /** our bullet hit a vintage train here */
  onTrainCoin: (point: Position, altitude: number) => void;
  /** Family Sedan: collect road coins along this shot (muzzle → impact) */
  onShotCoins: (from: Position, fromAlt: number, to: Position, toAlt: number) => void;
  /** other players, every frame; cars come and go with the list */
  setRemotes: (cars: RemoteCar[]) => void;
  /** true when the hit counts (no damage, e.g. on a player busy on a mission: no red flash) */
  onRemoteHit: (id: string) => boolean;
  /** our own car blows up (another player got us): a burst on the spot */
  explodePlayer: () => void;
  /** fell in the river: big splash at the car */
  plungeSplash: () => void;
  updateTargets: (vehicles: TargetVehicle[]) => void;
  flashTarget: (id: string, duration: number) => void;
  damageTarget: (id: string, amount: number) => boolean;
  aliveTargetCount: () => number;
  isTargetAlive: (id: string) => boolean;
  targetHealth: () => TargetHealth[];
  setPickups: (pickups: PickupVisual[]) => void;
  /** move a pickup already shown (the hauler's cable reels it in) */
  movePickup: (id: string, position: Position) => void;
  setMissionBeacons: (beacons: MissionBeaconSpec[]) => void;
  setRaceFinish: (goal: Position | null) => void;
  /** fire call: ignite these existing-façade panes; null clears */
  setFireHouse: (site: { panes: FirePaneSpec[]; available?: number } | null) => void;
  /** skin swap: move fire onto a new window grid, keeping burn coverage */
  remeshFireHouse: (candidates: FirePaneSpec[], seed: number) => void;
  /** panes still burning (null if no house) */
  fireWindowsLeft: () => number | null;
  /** panes that were lit when the call started / last remeshed (null if no house) */
  fireWindowsTotal: () => number | null;
  /** called when a burning pane is put out for the first time */
  onFireWindowOut: (left: number) => void;
  /** the hauler: a car of ours held at this pose (`up`: m above our car), drawn there and not on its own ground */
  setCarried: (pose: { id: string; position: Position; heading: number; up: number; pitch?: number } | null) => void;
  /** the hauler's cable from our car's middle to a point (`up`: m above our car); `wave`: 0 taut … 1 whipping; null hides it */
  setCable: (to: { position: Position; up: number; wave?: number } | null) => void;
  /** the J ramp: low edge at `position`, rising along `heading`; null takes it away */
  setRamp: (ramp: { position: Position; heading: number; ground: number; tilt: number; length: number; height: number; width: number } | null) => void;
};
