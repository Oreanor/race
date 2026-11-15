import { METERS_PER_DEGREE, metersBetween, type Position } from './VehicleController.ts';

export const RACE_CHECKPOINTS = 5;
export const RACE_MIN_METERS = 5000;
export const RACE_GATE_RADIUS = 22;

export type RaceCourse = {
  start: Position;
  checkpoints: Position[];
  finish: Position;
  /** Length along the connected roads, not distance to the finish. */
  meters: number;
  legs: Position[][];
};

export function raceCourse(start: Position, legs: Position[][]): RaceCourse | null {
  if (legs.length !== RACE_CHECKPOINTS + 1 || legs.some(leg => leg.length < 2)) return null;
  let meters = 0, direct = 0, from = start;
  for (const leg of legs) {
    meters += metersBetween(from, leg[0]);
    for (let i = 1; i < leg.length; i++) meters += metersBetween(leg[i - 1], leg[i]);
    direct += metersBetween(from, leg[leg.length - 1]);
    from = leg[leg.length - 1];
  }
  // Even taking shortcuts between the gates must cover at least five kilometres.
  if (meters < RACE_MIN_METERS || direct < RACE_MIN_METERS) return null;
  const first = legs[0][legs[0].length - 1];
  const sx = METERS_PER_DEGREE * Math.cos(start[1] * Math.PI / 180);
  const dx = (first[0] - start[0]) * sx, dy = (first[1] - start[1]) * METERS_PER_DEGREE;
  const deviation = Math.max(...legs.map(leg => {
    const p = leg[leg.length - 1];
    return Math.abs((p[0] - start[0]) * sx * dy - (p[1] - start[1]) * METERS_PER_DEGREE * dx) / Math.hypot(dx, dy);
  }));
  if (!(deviation >= 250)) return null;
  return {
    start: [...start], checkpoints: legs.slice(0, -1).map(leg => [...leg[leg.length - 1]]),
    finish: [...from], meters, legs,
  };
}

/** Each entrant has their own ordered gates; driving straight to the finish cannot win. */
export class RaceProgress {
  readonly gates: Position[];
  private entrants = new Map<string, { next: number; previous: Position }>();

  constructor(course: RaceCourse, entrants: { id: string; position: Position }[]) {
    this.gates = [...course.checkpoints, course.finish];
    for (const entrant of entrants) this.entrants.set(entrant.id, { next: 0, previous: [...entrant.position] });
  }

  passed(id: string) { return this.entrants.get(id)?.next ?? 0; }
  target(id: string): Position | null { return this.gates[this.passed(id)] ?? null; }
  finished(id: string) { return this.entrants.has(id) && this.passed(id) >= this.gates.length; }

  update(id: string, position: Position) {
    const entrant = this.entrants.get(id);
    if (!entrant) return false;
    const gate = this.gates[entrant.next];
    const previous = entrant.previous;
    entrant.previous = [...position];
    if (!gate) return false;
    const sx = METERS_PER_DEGREE * Math.cos(gate[1] * Math.PI / 180);
    const ax = (previous[0] - gate[0]) * sx, ay = (previous[1] - gate[1]) * METERS_PER_DEGREE;
    const dx = (position[0] - previous[0]) * sx, dy = (position[1] - previous[1]) * METERS_PER_DEGREE;
    // Sweep fast frames through the gate; a respawn/teleport is not a driven segment.
    const u = Math.hypot(dx, dy) > 200 ? 1 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
    if (Math.hypot(ax + dx * u, ay + dy * u) > RACE_GATE_RADIUS) return false;
    entrant.next++;
    return true;
  }
}
