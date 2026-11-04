import type { Car } from '@/config/vehicle.config';
import type { MapFeature } from './WaterCollisionController';
import { VehicleController, type Position } from './VehicleController.ts';

const METERS_PER_DEGREE = 111319.49;
const ROAD_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service']);
const NODE_SNAP_METERS = 2.5;
const SAMPLE_METERS = 10;

type RoadNode = { id: string; position: Position; edges: Map<string, number> };
type QueueEntry = { id: string; distance: number };
export type RoadPickup = { id: string; position: Position };

function distanceMeters(a: Position, b: Position) {
  const cos = Math.cos(a[1] * Math.PI / 180);
  return Math.hypot((b[0] - a[0]) * METERS_PER_DEGREE * cos, (b[1] - a[1]) * METERS_PER_DEGREE);
}

function headingTo(a: Position, b: Position) {
  const cos = Math.cos(a[1] * Math.PI / 180);
  return Math.atan2((b[0] - a[0]) * METERS_PER_DEGREE * cos, (b[1] - a[1]) * METERS_PER_DEGREE);
}

function angleDifference(a: number, b: number) {
  return ((a - b + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
}

function linesOf(feature: MapFeature): Position[][] {
  const coordinates = feature.geometry.coordinates;
  if (feature.geometry.type === 'LineString') return [coordinates as Position[]];
  if (feature.geometry.type === 'MultiLineString') return coordinates as Position[][];
  return [];
}

function lineKey(line: Position[]) {
  const pointKey = (point: Position) => `${point[0].toFixed(5)},${point[1].toFixed(5)}`;
  const forward = line.map(pointKey).join(';');
  const reverse = [...line].reverse().map(pointKey).join(';');
  return forward < reverse ? forward : reverse;
}

class MinQueue {
  private items: QueueEntry[] = [];

  get size() { return this.items.length; }

  push(item: QueueEntry) {
    this.items.push(item);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent].distance <= item.distance) break;
      this.items[index] = this.items[parent];
      index = parent;
    }
    this.items[index] = item;
  }

  pop(): QueueEntry | undefined {
    const first = this.items[0];
    const last = this.items.pop();
    if (!last || !this.items.length) return first;
    let index = 0;
    while (index * 2 + 1 < this.items.length) {
      let child = index * 2 + 1;
      if (child + 1 < this.items.length && this.items[child + 1].distance < this.items[child].distance) child++;
      if (last.distance <= this.items[child].distance) break;
      this.items[index] = this.items[child];
      index = child;
    }
    this.items[index] = last;
    return first;
  }
}

export class TrafficRoadNetwork {
  private lines = new Map<string, Position[]>();
  private nodes = new Map<string, RoadNode>();
  private endpointIds = new Set<string>();
  private scaleX = METERS_PER_DEGREE;
  private pendingLines = new Map<string, Position[]>();
  revision = 0;

  addFeatures(features: Iterable<MapFeature>) {
    let changed = false;
    for (const feature of features) {
      if (!ROAD_CLASSES.has(String(feature.properties?.class ?? ''))) continue;
      for (const rawLine of linesOf(feature)) {
        const line = rawLine.filter(point => Number.isFinite(point[0]) && Number.isFinite(point[1]));
        if (line.length < 2) continue;
        const key = lineKey(line);
        if (this.lines.has(key)) continue;
        const copy = line.map(point => [point[0], point[1]] as Position);
        this.lines.set(key, copy);
        this.pendingLines.set(key, copy);
        changed = true;
      }
    }
    return changed;
  }

  flushRebuild() {
    if (!this.pendingLines.size) return false;
    if (!this.nodes.size && this.pendingLines.size === this.lines.size) {
      const firstLine = this.lines.values().next().value as Position[] | undefined;
      if (firstLine?.length) this.scaleX = METERS_PER_DEGREE * Math.cos(firstLine[0][1] * Math.PI / 180);
    }
    const freshEndpoints: RoadNode[] = [];
    for (const line of this.pendingLines.values()) {
      for (const endpoint of this.ingestLine(line)) freshEndpoints.push(endpoint);
    }
    this.pendingLines.clear();
    this.stitchEndpoints(freshEndpoints);
    this.revision++;
    return true;
  }

  private ensureBuilt() {
    if (this.pendingLines.size) this.flushRebuild();
  }

  nearest(position: Position, excluded: Set<string> = new Set(), separation = 0, maxDistance = 70) {
    this.ensureBuilt();
    let best: RoadNode | null = null;
    let bestDistance = maxDistance;
    for (const node of this.nodes.values()) {
      if (excluded.has(node.id) || distanceMeters(node.position, position) < separation) continue;
      const distance = distanceMeters(node.position, position);
      if (distance < bestDistance) {
        best = node;
        bestDistance = distance;
      }
    }
    return best;
  }

  /** Random road node in a distance band — for spreading bots across the city. */
  randomAway(position: Position, excluded: Set<string>, minDistance: number, maxDistance: number, seed: number) {
    this.ensureBuilt();
    const candidates: RoadNode[] = [];
    for (const node of this.nodes.values()) {
      if (excluded.has(node.id)) continue;
      const distance = distanceMeters(node.position, position);
      if (distance < minDistance || distance > maxDistance) continue;
      candidates.push(node);
    }
    if (!candidates.length) {
      for (const node of this.nodes.values()) {
        if (excluded.has(node.id)) continue;
        const distance = distanceMeters(node.position, position);
        if (distance < Math.min(90, minDistance * 0.4)) continue;
        candidates.push(node);
      }
    }
    if (!candidates.length) return null;
    return candidates[Math.abs(seed) % candidates.length];
  }

  /** Spots along the roads every ~75 m; `start` shifts the row (coins sit halfway between balls). */
  pickupLocations(center: Position, radius = 650, limit = 80, start = 37.5): RoadPickup[] {
    const candidates = new Map<string, Position>();
    for (const line of this.lines.values()) {
      let traveled = 0;
      let nextPickup = start;
      for (let index = 1; index < line.length; index++) {
        const from = line[index - 1];
        const to = line[index];
        const length = distanceMeters(from, to);
        while (nextPickup <= traveled + length) {
          const fraction = length > 0 ? (nextPickup - traveled) / length : 0;
          const position: Position = [
            from[0] + (to[0] - from[0]) * fraction,
            from[1] + (to[1] - from[1]) * fraction,
          ];
          if (distanceMeters(center, position) <= radius) {
            const id = `${Math.round(position[0] * this.scaleX / 8)}:${Math.round(position[1] * METERS_PER_DEGREE / 8)}`;
            if (!candidates.has(id)) candidates.set(id, position);
          }
          nextPickup += 75;
        }
        traveled += length;
      }
    }
    const spacing = 75;
    const spacingSquared = spacing * spacing;
    const cos = Math.cos(center[1] * Math.PI / 180);
    const nearby = new Map<string, Position[]>();
    const selected: RoadPickup[] = [];
    const ordered = [...candidates]
      .map(([id, position]) => ({ id, position, distance: distanceMeters(center, position) }))
      .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));

    for (const candidate of ordered) {
      const x = (candidate.position[0] - center[0]) * METERS_PER_DEGREE * cos;
      const y = (candidate.position[1] - center[1]) * METERS_PER_DEGREE;
      const cellX = Math.floor(x / spacing);
      const cellY = Math.floor(y / spacing);
      let tooClose = false;
      for (let dx = -1; dx <= 1 && !tooClose; dx++) {
        for (let dy = -1; dy <= 1 && !tooClose; dy++) {
          for (const point of nearby.get(`${cellX + dx}:${cellY + dy}`) ?? []) {
            const pointX = (point[0] - center[0]) * METERS_PER_DEGREE * cos;
            const pointY = (point[1] - center[1]) * METERS_PER_DEGREE;
            if ((pointX - x) ** 2 + (pointY - y) ** 2 < spacingSquared * 0.998) {
              tooClose = true;
              break;
            }
          }
        }
      }
      if (tooClose) continue;
      const key = `${cellX}:${cellY}`;
      const points = nearby.get(key) ?? [];
      points.push(candidate.position);
      nearby.set(key, points);
      selected.push({ id: candidate.id, position: candidate.position });
      if (selected.length >= limit) break;
    }

    return selected;
  }

  destinationAhead(position: Position, heading: number, seed: number) {
    const start = this.nearest(position, new Set<string>(), 0, 500);
    if (!start) return null;
    const route = this.route(start.id, heading, seed);
    return route.length > 1 ? [...route[route.length - 1]] as Position : null;
  }

  route(startId: string, heading: number, seed: number, destination?: Position) {
    this.ensureBuilt();
    const start = this.nodes.get(startId);
    if (!start) return [];
    const distances = new Map<string, number>([[startId, 0]]);
    const previous = new Map<string, string>();
    const queue = new MinQueue();
    queue.push({ id: startId, distance: 0 });
    const candidates: string[] = [];

    while (queue.size) {
      const current = queue.pop();
      if (!current || current.distance !== distances.get(current.id)) continue;
      if (current.distance > (destination ? 14000 : 5200)) break;
      const node = this.nodes.get(current.id);
      if (!node) continue;
      if (destination) {
        if (current.id !== startId) candidates.push(current.id);
      } else if (current.id !== startId && current.distance >= 420 && current.distance <= 4800) {
        // Explore city-wide; allow some backtrack so bots don't only go straight ahead.
        const firstStep = this.firstStep(startId, current.id, previous);
        const next = firstStep ? this.nodes.get(firstStep) : undefined;
        if (!next || Math.cos(angleDifference(headingTo(start.position, next.position), heading)) > -0.55) {
          candidates.push(current.id);
        }
      }
      for (const [neighbor, cost] of node.edges) {
        const nextDistance = current.distance + cost;
        if (nextDistance >= (distances.get(neighbor) ?? Infinity)) continue;
        distances.set(neighbor, nextDistance);
        previous.set(neighbor, current.id);
        queue.push({ id: neighbor, distance: nextDistance });
      }
    }

    if (!candidates.length) return [];
    const target = destination
      ? candidates.reduce((best, id) => {
          const current = this.nodes.get(id)!;
          const prior = this.nodes.get(best)!;
          const currentDistance = distanceMeters(current.position, destination);
          const priorDistance = distanceMeters(prior.position, destination);
          const currentScore = currentDistance <= 40
            ? currentDistance + (distances.get(id) ?? 0) * 0.0001
            : currentDistance + (distances.get(id) ?? 0) * 0.08;
          const priorScore = priorDistance <= 40
            ? priorDistance + (distances.get(best) ?? 0) * 0.0001
            : priorDistance + (distances.get(best) ?? 0) * 0.08;
          return currentScore < priorScore ? id : best;
        })
      : candidates[Math.abs(seed) % candidates.length];
    const routeIds = [target];
    while (routeIds[routeIds.length - 1] !== startId) {
      const parent = previous.get(routeIds[routeIds.length - 1]);
      if (!parent) return [];
      routeIds.push(parent);
    }
    routeIds.reverse();
    return routeIds.map(id => this.nodes.get(id)!.position);
  }

  private firstStep(startId: string, targetId: string, previous: Map<string, string>) {
    let current = targetId;
    let parent = previous.get(current);
    while (parent && parent !== startId) {
      current = parent;
      parent = previous.get(current);
    }
    return parent === startId ? current : null;
  }

  private nodeId(position: Position) {
    const x = Math.round(position[0] * this.scaleX / NODE_SNAP_METERS);
    const y = Math.round(position[1] * METERS_PER_DEGREE / NODE_SNAP_METERS);
    return `${x}:${y}`;
  }

  private addNode(position: Position) {
    const id = this.nodeId(position);
    let node = this.nodes.get(id);
    if (!node) {
      node = { id, position: [...position], edges: new Map() };
      this.nodes.set(id, node);
    }
    return node;
  }

  private connect(a: RoadNode, b: RoadNode) {
    if (a.id === b.id) return;
    const distance = distanceMeters(a.position, b.position);
    if (distance < 0.1) return;
    a.edges.set(b.id, distance);
    b.edges.set(a.id, distance);
  }

  private ingestLine(line: Position[]) {
    const endpoints: RoadNode[] = [];
    let previous: RoadNode | null = null;
    for (let index = 1; index < line.length; index++) {
      const from = line[index - 1];
      const to = line[index];
      const length = distanceMeters(from, to);
      const steps = Math.max(1, Math.ceil(length / SAMPLE_METERS));
      for (let step = index === 1 ? 0 : 1; step <= steps; step++) {
        const fraction = step / steps;
        const position: Position = [from[0] + (to[0] - from[0]) * fraction, from[1] + (to[1] - from[1]) * fraction];
        const node = this.addNode(position);
        if (previous) this.connect(previous, node);
        previous = node;
        if ((index === 1 && step === 0) || (index === line.length - 1 && step === steps)) {
          this.endpointIds.add(node.id);
          endpoints.push(node);
        }
      }
    }
    return endpoints;
  }

  private stitchEndpoints(endpoints: RoadNode[]) {
    if (!endpoints.length) return;
    const cells = new Map<string, RoadNode[]>();
    const cellSize = 8;
    const cellFor = (position: Position) => [
      Math.floor(position[0] * this.scaleX / cellSize),
      Math.floor(position[1] * METERS_PER_DEGREE / cellSize),
    ];
    for (const node of this.nodes.values()) {
      const [x, y] = cellFor(node.position);
      const key = `${x}:${y}`;
      const cell = cells.get(key) ?? [];
      cell.push(node);
      cells.set(key, cell);
    }
    for (const endpoint of endpoints) {
      const [x, y] = cellFor(endpoint.position);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const nearby of cells.get(`${x + dx}:${y + dy}`) ?? []) {
          if (nearby.id === endpoint.id || endpoint.edges.has(nearby.id)) continue;
          if (distanceMeters(endpoint.position, nearby.position) <= 4.5) this.connect(endpoint, nearby);
        }
      }
    }
  }
}

export type BotMood = 'explore' | 'hunt';
export type TrafficPeer = { id: string; position: Position; alive: boolean };

export type TrafficBot = {
  id: string;
  driver: string;
  car: Car;
  controller: VehicleController;
  position: Position;
  heading: number;
  route: Position[];
  routeIndex: number;
  routeSeed: number;
  lastRouteRevision: number;
  retryFrames: number;
  goal: Position | null;
  money: number;
  mood: BotMood;
  huntId: string | null;
  huntRange: number;
};

export function createTrafficBot(
  id: string,
  driver: string,
  car: Car,
  network: TrafficRoadNetwork,
  fallbackPosition: Position,
  fallbackHeading: number,
  unavailable: Set<string>,
  mood: BotMood = 'explore',
  spawnSeed = 0,
  band: { min: number; max: number } = { min: 200, max: 1600 },
): TrafficBot {
  const start = network.randomAway(fallbackPosition, unavailable, band.min, band.max, spawnSeed)
    ?? network.randomAway(fallbackPosition, unavailable, Math.max(60, band.min * 0.5), band.max * 1.2, spawnSeed + 17)
    ?? network.nearest(fallbackPosition, unavailable, 40, Math.max(400, band.max));
  const position = start ? [...start.position] as Position : [...fallbackPosition] as Position;
  const provisional: TrafficBot = {
    id, driver, car,
    controller: new VehicleController(position, fallbackHeading * 180 / Math.PI),
    position, heading: fallbackHeading,
    route: [] as Position[], routeIndex: 1, routeSeed: (id.charCodeAt(id.length - 1) || 0) + spawnSeed,
    lastRouteRevision: network.revision, retryFrames: 0, goal: null, money: 0,
    mood, huntId: null, huntRange: Infinity,
  };
  if (start) {
    unavailable.add(start.id);
    provisional.route = network.route(start.id, fallbackHeading, provisional.routeSeed);
    if (provisional.route.length > 1) {
      provisional.heading = headingTo(provisional.route[0], provisional.route[1]);
      provisional.controller.heading = provisional.heading;
      provisional.routeIndex = 1;
    }
  }
  return provisional;
}

export function steerTrafficBot(bot: TrafficBot, _network: TrafficRoadNetwork, peers: TrafficPeer[]) {
  const engage = bot.mood === 'hunt' ? 170 : 60;
  let prey: TrafficPeer | null = null;
  let best = engage;
  for (const peer of peers) {
    if (!peer.alive || peer.id === bot.id) continue;
    const distance = distanceMeters(bot.position, peer.position);
    if (distance < best) {
      prey = peer;
      best = distance;
    }
  }
  if (prey) {
    const moved = !bot.goal || distanceMeters(bot.goal, prey.position) > 35;
    bot.goal = [...prey.position] as Position;
    bot.huntId = prey.id;
    bot.huntRange = best;
    if (moved) {
      bot.route = [];
      bot.routeIndex = 1;
    }
  } else {
    bot.huntId = null;
    bot.huntRange = Infinity;
    // Drop explore destination only after finishing the route so mission goals can persist.
    if (bot.routeIndex >= bot.route.length) bot.goal = null;
  }
}

export function trafficBotKeys(bot: TrafficBot, network: TrafficRoadNetwork) {
  if (bot.lastRouteRevision !== network.revision || bot.route.length < 2 || bot.routeIndex >= bot.route.length) {
    if (bot.route.length < 2) {
      bot.retryFrames++;
      if (bot.retryFrames < 90 && bot.lastRouteRevision === network.revision) return new Set<string>();
    }
    bot.routeSeed = (bot.routeSeed * 48271 + 1) % 2147483647;
    const nearest = network.nearest(bot.position, new Set<string>(), 0, 45);
    bot.route = nearest ? network.route(nearest.id, bot.heading, bot.routeSeed, bot.goal ?? undefined) : [];
    bot.routeIndex = 1;
    bot.lastRouteRevision = network.revision;
    bot.retryFrames = 0;
    if (bot.route.length < 2) return new Set<string>();
  }

  while (bot.routeIndex < bot.route.length - 1 && distanceMeters(bot.position, bot.route[bot.routeIndex]) < 7) bot.routeIndex++;
  const keys = new Set<string>();
  // Wall/corner escape: keep reversing+turning for a bit so step() doesn't cancel it with KeyW.
  if (bot.retryFrames > 8) {
    const side = (bot.id.charCodeAt(bot.id.length - 1) + bot.retryFrames) % 2 ? 1 : -1;
    keys.add('KeyS');
    keys.add(side > 0 ? 'KeyD' : 'KeyA');
    return keys;
  }
  const target = bot.route[bot.routeIndex];
  const desiredHeading = headingTo(bot.position, target);
  const error = angleDifference(desiredHeading, bot.heading);
  let turnAngle = 0;
  if (bot.routeIndex + 1 < bot.route.length) {
    const nextHeading = headingTo(target, bot.route[bot.routeIndex + 1]);
    turnAngle = Math.abs(angleDifference(nextHeading, headingTo(bot.route[bot.routeIndex - 1] ?? bot.position, target)));
  }
  const hunting = Boolean(bot.huntId);
  const closing = hunting && bot.huntRange < 55;
  const targetSpeed = hunting
    ? (closing ? 12 : turnAngle > 0.5 ? 7 : 10)
    : (turnAngle > 0.45 ? 5 : 8.5);
  if (bot.controller.speed < targetSpeed) keys.add('KeyW');
  else if (bot.controller.speed > targetSpeed + 1.2) keys.add('KeyS');
  if (closing && bot.huntRange < 40) keys.add('Space');
  if (error > 0.05) keys.add('KeyD');
  else if (error < -0.05) keys.add('KeyA');
  return keys;
}

export function advanceTrafficBot(
  bot: TrafficBot,
  dt: number,
  network: TrafficRoadNetwork,
  config: Parameters<VehicleController['step']>[2],
  peers: TrafficPeer[] = [],
) {
  steerTrafficBot(bot, network, peers);
  bot.controller.step(dt, trafficBotKeys(bot, network), config);
  bot.position = [...bot.controller.position];
  bot.heading = bot.controller.heading;
}
