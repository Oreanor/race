// Road topology and vertical alignment. A junction is a shared variable, not two
// independently built deck tips. Solve the whole graph before cutting out a tile.

export type RoadPoint = [number, number];
export type RoadXY = { x: number; y: number };
export type RoadSurfaces = {
  driveAt: (x: number, z: number) => number;
  groundAt: (x: number, z: number) => number;
  waterAt: (x: number, z: number) => number | null;
  toMerc: number;
};
export type RoadWay = {
  lines: RoadXY[][];
  bridge: boolean;
  level: number;
  foot: boolean;
  rail?: boolean;
  /** Physical half width of the structure, in metres. */
  half?: number;
  /** Stable source identity; tile feature indexes are not identities. */
  source?: string;
};
export type RoadDeck = {
  pts: RoadPoint[];
  s: number[];
  h: number[];
  bed: number[];
  length: number;
  /** Shared cross-section normal (including miter scale), at every station. */
  frame?: RoadPoint[];
  /** Physical half widths, in tile-local mercator metres. */
  half?: number[];
  /** Shared graph stations, retained for real junction openings in parapets. */
  nodes?: number[];
};
export type PlannedRoad = { decks: RoadDeck[]; rest: RoadXY[][] };

export const ROAD_GRADE = 0.08;
export const ROAD_CLEARANCE = 5.5;
const STEP = 8;
const TANGENT_COS = 0.55;
const EPS = 1e-7;

type Route = { id: number; way: RoadWay; pts: RoadPoint[]; cuts: { t: number; node?: number }[][]; nodes: number[] };
type Segment = { route: Route; i: number; a: RoadPoint; b: RoadPoint };
type Contact = { a: Segment; ta: number; b: Segment; tb: number; join: boolean };
type Node = { p: RoadPoint; base: number; floor: number; h: number; half: number; edges: number[] };
type Edge = { a: number; b: number; length: number; bridge: boolean };
type Arc = { from: number; to: number; rise: number; length: number };

function project(p: RoadPoint, a: RoadPoint, b: RoadPoint) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  return Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (dx * dx + dz * dz || 1)));
}
function point(s: Segment, t: number): RoadPoint { return [s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t]; }
function distance(a: RoadPoint, b: RoadPoint) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
function align(a: Segment, b: Segment) {
  return Math.abs((a.b[0] - a.a[0]) * (b.b[0] - b.a[0]) + (a.b[1] - a.a[1]) * (b.b[1] - b.a[1])) / (distance(a.a, a.b) * distance(b.a, b.b) || 1);
}
function endpoint(s: Segment, t: number) { return (s.i === 0 && t < EPS) || (s.i === s.route.pts.length - 2 && t > 1 - EPS); }
function compatible(a: RoadWay, b: RoadWay) { return !!a.rail === !!b.rail && a.foot === b.foot; }

/** Candidate pairs only in occupied cells; city-sized tiles must not do N² scans. */
function segmentPairs(segments: Segment[], cell: number, visit: (a: Segment, b: Segment) => void) {
  const buckets = new Map<string, number[]>();
  segments.forEach((s, i) => {
    const seen = new Set<number>();
    for (let x = Math.floor(Math.min(s.a[0], s.b[0]) / cell); x <= Math.floor(Math.max(s.a[0], s.b[0]) / cell); x++) {
      for (let z = Math.floor(Math.min(s.a[1], s.b[1]) / cell); z <= Math.floor(Math.max(s.a[1], s.b[1]) / cell); z++) {
        const key = `${x},${z}`, bucket = buckets.get(key) ?? [];
        for (const j of bucket) if (!seen.has(j)) { seen.add(j); visit(segments[j], s); }
        bucket.push(i); buckets.set(key, bucket);
      }
    }
  });
}

/** Close only facing ends of the same transport mode and level, before sampling. */
function connectEnds(routes: Route[], scale: number) {
  const ends = routes.flatMap(route => [0, route.pts.length - 1].map(i => {
    const p = route.pts[i], q = route.pts[i === 0 ? 1 : i - 1], len = distance(p, q) || 1;
    return { route, i, p, outward: [(p[0] - q[0]) / len, (p[1] - q[1]) / len] as RoadPoint };
  }));
  const cell = 10 * scale, buckets = new Map<string, typeof ends>();
  for (const end of ends) {
    const x = Math.floor(end.p[0] / cell), z = Math.floor(end.p[1] / cell);
    const key = `${x},${z}`, list = buckets.get(key) ?? [];
    list.push(end); buckets.set(key, list);
  }
  const used = new Set<typeof ends[number]>();
  // A tip which already meets a real vertex must never be matched across the
  // next short feature as well (that would move it away from its actual join).
  const owners = new Map<string, Set<Route>>();
  const keyOf = (p: RoadPoint) => `${Math.round(p[0] * 1e6)},${Math.round(p[1] * 1e6)}`;
  for (const route of routes) for (const p of route.pts) {
    const key = keyOf(p), list = owners.get(key) ?? new Set<Route>(); list.add(route); owners.set(key, list);
  }
  for (const end of ends) if ([...owners.get(keyOf(end.p)) ?? []].some(other => other !== end.route && compatible(other.way, end.route.way))) used.add(end);
  for (const a of ends) {
    if (used.has(a)) continue;
    let best: typeof a | undefined, gap = Infinity;
    const x = Math.floor(a.p[0] / cell), z = Math.floor(a.p[1] / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const b of buckets.get(`${x + dx},${z + dz}`) ?? []) {
      if (a.route === b.route || used.has(b) || !compatible(a.route.way, b.route.way)) continue;
      if (!a.route.way.bridge && !b.route.way.bridge) continue;
      const d = distance(a.p, b.p), maxGap = 10 * scale;
      if (d < EPS || d > maxGap || d >= gap) continue;
      const ux = (b.p[0] - a.p[0]) / d, uz = (b.p[1] - a.p[1]) / d;
      if (a.outward[0] * ux + a.outward[1] * uz < 0.85 || b.outward[0] * -ux + b.outward[1] * -uz < 0.85) continue;
      best = b; gap = d;
    }
    if (best) {
      const p: RoadPoint = [(a.p[0] + best.p[0]) / 2, (a.p[1] + best.p[1]) / 2];
      a.route.pts[a.i] = p; best.route.pts[best.i] = p;
      used.add(a); used.add(best);
    }
  }
}

// A max heap for the lower-bound solver. Most constraints are negative grade
// edges, so each station is normally visited only once.
class HeightQueue {
  // ids and heights in parallel typed arrays (an object per push was most of the solve on a
  // city window); the comparisons and moves are the same as before, so is the pop order
  private ids = new Int32Array(1024);
  private hs = new Float64Array(1024);
  size = 0;
  push(id: number, h: number) {
    if (this.size === this.ids.length) {
      const ids = new Int32Array(this.size * 2), hs = new Float64Array(this.size * 2);
      ids.set(this.ids); hs.set(this.hs); this.ids = ids; this.hs = hs;
    }
    const I = this.ids, H = this.hs;
    let i = this.size++;
    while (i > 0) { const p = (i - 1) >> 1; if (H[p] >= h) break; I[i] = I[p]; H[i] = H[p]; i = p; }
    I[i] = id; H[i] = h;
  }
  /** pops into `top` (id, h) */
  pop(top: { id: number; h: number }) {
    const I = this.ids, H = this.hs;
    top.id = I[0]; top.h = H[0];
    const n = --this.size, lastId = I[n], lastH = H[n];
    if (n) {
      let i = 0;
      while (i * 2 + 1 < n) {
        let c = i * 2 + 1;
        if (c + 1 < n && H[c + 1] > H[c]) c++;
        if (H[c] <= lastH) break;
        I[i] = I[c]; H[i] = H[c]; i = c;
      }
      I[i] = lastId; H[i] = lastH;
    }
    return top;
  }
}

/**
 * h[to] >= h[from] + rise, to convergence. A clearance constraint can expose
 * an impossibly short approach in source data. In that case relax the grade on
 * that cycle only; never repeatedly raise the whole interchange or erase clearance.
 */
function solveHeights(nodes: Node[], arcs: Arc[]) {
  const outgoing: Arc[][] = nodes.map(() => []);
  for (const arc of arcs) outgoing[arc.from].push(arc);
  for (;;) {
    const q = new HeightQueue(), parent: (Arc | undefined)[] = nodes.map(() => undefined), updates = new Uint32Array(nodes.length);
    nodes.forEach((n, id) => { n.h = n.floor; q.push(id, n.h); });
    let cycle: Arc[] | undefined;
    const top = { id: 0, h: 0 };
    while (q.size && !cycle) {
      const { id, h } = q.pop(top);
      if (h < nodes[id].h - EPS) continue;
      for (const arc of outgoing[id]) {
        const next = nodes[arc.to], target = h + arc.rise;
        if (target <= next.h + EPS) continue;
        next.h = target; parent[arc.to] = arc; q.push(arc.to, target);
        if (++updates[arc.to] < 4) continue;
        const path: Arc[] = [], seen = new Map<number, number>();
        let v = arc.to;
        while (parent[v] && !seen.has(v)) { seen.set(v, path.length); path.push(parent[v]!); v = parent[v]!.from; }
        if (seen.has(v)) { cycle = path.slice(seen.get(v)!); break; }
      }
    }
    if (!cycle) return;
    const excess = cycle.reduce((sum, e) => sum + e.rise, 0);
    const length = cycle.reduce((sum, e) => sum + e.length, 0);
    if (length < EPS || excess <= 0) throw new Error('Contradictory road clearance topology');
    for (const e of cycle) if (e.length > 0) e.rise -= (excess + 0.01) * e.length / length;
  }
}

/** One network, one height at each junction, independent of feature iteration order. */
/**
 * `outputs` picks the routes whose plan is returned (by their points, in span units): the
 * solve takes the whole window, but a tile needs only its own roads and the neighbours'
 * decks at its edge — writing out every road of the 3 × 3 window was a sixth of a tile.
 */
export function planRoadNetwork(ways: Map<number, RoadWay>, extent: number, span: number, at: RoadSurfaces, outputs?: (pts: RoadPoint[]) => boolean): Map<number, PlannedRoad> {
  const k = span / extent;
  const routes: Route[] = [];
  for (const [id, way] of ways) for (const line of way.lines) {
    const pts = line.map(p => [p.x * k, p.y * k] as RoadPoint).filter((p, i, ps) => !i || distance(p, ps[i - 1]) > EPS);
    if (pts.length >= 2) routes.push({ id, way, pts, cuts: [], nodes: [] });
  }
  // Stable geometry ordering also makes ambiguous same-layer crossings stable
  // when neighbouring tiles assign different local feature indexes.
  const routeKey = (r: Route) => r.way.source ?? r.pts.map(p => p.join(',')).sort().join(';');
  routes.sort((a, b) => a.way.level - b.way.level || routeKey(a).localeCompare(routeKey(b)) || a.id - b.id);
  const rank = new Map(routes.map((r, i) => [r, i]));
  connectEnds(routes, at.toMerc);
  const segments: Segment[] = [];
  for (const route of routes) for (let i = 0; i + 1 < route.pts.length; i++) {
    route.cuts.push([{ t: 0 }, { t: 1 }]);
    segments.push({ route, i, a: route.pts[i], b: route.pts[i + 1] });
  }
  const contacts: Contact[] = [];
  const addContact = (a: Segment, ta: number, b: Segment, tb: number, join: boolean) => {
    if (a.route === b.route && Math.abs(a.i - b.i) <= 1) return;
    if (join && !compatible(a.route.way, b.route.way)) return;
    a.route.cuts[a.i].push({ t: ta }); b.route.cuts[b.i].push({ t: tb });
    contacts.push({ a, ta, b, tb, join });
  };
  segmentPairs(segments, 64 * at.toMerc, (a, b) => {
    const aw = a.route.way, bw = b.route.way;
    if (!aw.bridge && !bw.bridge) return;
    const ax = a.b[0] - a.a[0], az = a.b[1] - a.a[1], bx = b.b[0] - b.a[0], bz = b.b[1] - b.a[1];
    const den = ax * bz - az * bx;
    if (Math.abs(den) > EPS) {
      const dx = b.a[0] - a.a[0], dz = b.a[1] - a.a[1];
      const ta = (dx * bz - dz * bx) / den, tb = (dx * az - dz * ax) / den;
      if (ta >= -EPS && ta <= 1 + EPS && tb >= -EPS && tb <= 1 + EPS) {
        const t = Math.max(0, Math.min(1, ta)), u = Math.max(0, Math.min(1, tb));
        const end = endpoint(a, t) || endpoint(b, u);
        const vertex = (t < EPS || t > 1 - EPS) && (u < EPS || u > 1 - EPS);
        const bothEnds = endpoint(a, t) && endpoint(b, u);
        const join = compatible(aw, bw) && ((aw.level === bw.level && (vertex || end || align(a, b) > TANGENT_COS)) || (end && aw.bridge !== bw.bridge) || bothEnds);
        addContact(a, t, b, u, join);
      }
    }
    // Collinear continuations, and T junctions whose split is absent from the
    // other polyline. Only endpoints may snap; parallel interior lanes stay apart.
    for (const [s, other] of [[a, b], [b, a]]) for (const t of [0, 1]) {
      if (!endpoint(s, t)) continue;
      const p = point(s, t), u = project(p, other.a, other.b), d = distance(p, point(other, u));
      if (d > 1.5 * at.toMerc || !compatible(s.route.way, other.route.way)) continue;
      if (s.route.way.level !== other.route.way.level && s.route.way.bridge === other.route.way.bridge && !endpoint(other, u)) continue;
      addContact(s, t, other, u, true);
    }
  });

  const nodes: Node[] = [], parent: number[] = [];
  // a bridge's deck stands clear of the water under it: a long span over a river by
  // ~2 m, a short one over a brook or a ditch by under a metre (2 m there left the deck
  // hanging over the banks like a platform)
  const waterClearance = (route: Route) => {
    let length = 0;
    for (let i = 1; i < route.pts.length; i++) length += distance(route.pts[i - 1], route.pts[i]);
    length /= at.toMerc;
    return length < 25 ? 0.8 : length < 60 ? 0.8 + (length - 25) / 35 * 1.4 : 2.2;
  };
  const makeNode = (p: RoadPoint, route: Route) => {
    const way = route.way;
    const id = nodes.length, base = at.driveAt(...p), bed = at.groundAt(...p), water = at.waterAt(...p);
    nodes.push({ p, base, floor: way.bridge && water != null && bed < water - 1 ? Math.max(base, water + waterClearance(route)) : base, h: base, half: (way.half ?? (way.foot ? 1 : way.rail ? 3.4 : 4.2)) * at.toMerc, edges: [] });
    parent.push(id); return id;
  };
  const root = (id: number): number => { let r = id; while (parent[r] !== r) r = parent[r]; while (parent[id] !== id) { const next = parent[id]; parent[id] = r; id = next; } return r; };
  const union = (a: number, b: number) => {
    a = root(a); b = root(b); if (a === b) return;
    parent[b] = a;
    nodes[a].base = Math.max(nodes[a].base, nodes[b].base);
    nodes[a].floor = Math.max(nodes[a].floor, nodes[b].floor);
    nodes[a].half = Math.max(nodes[a].half, nodes[b].half);
  };
  for (const route of routes) {
    for (let i = 0; i < route.cuts.length; i++) {
      const cuts = route.cuts[i], len = distance(route.pts[i], route.pts[i + 1]);
      const n = Math.max(1, Math.ceil(len / (STEP * at.toMerc)));
      for (let j = 1; j < n; j++) cuts.push({ t: j / n });
      cuts.sort((a, b) => a.t - b.t);
      let previous = -1, node = -1;
      for (const cut of cuts) {
        if (Math.abs(cut.t - previous) > EPS) {
          const p = point({ a: route.pts[i], b: route.pts[i + 1] } as Segment, cut.t);
          node = cut.t < EPS && i > 0 ? route.nodes[route.nodes.length - 1] : makeNode(p, route);
          if (cut.t > EPS || i === 0) route.nodes.push(node);
          previous = cut.t;
        }
        cut.node = node;
      }
    }
  }
  const contactNode = (s: Segment, t: number) => s.route.cuts[s.i].find(c => Math.abs(c.t - t) < EPS * 2)!.node!;
  for (const c of contacts) if (c.join) union(contactNode(c.a, c.ta), contactNode(c.b, c.tb));
  // Shared original vertices connect bridge approaches across arbitrary chains,
  // including ground segments that never geometrically cross a bridge themselves.
  const vertices = new Map<string, { node: number; route: Route; end: boolean }[]>();
  for (const r of routes) r.pts.forEach((p, i) => {
    const node = i === r.pts.length - 1 ? r.nodes[r.nodes.length - 1] : r.cuts[i][0].node!;
    const key = `${Math.round(p[0] * 1e6)},${Math.round(p[1] * 1e6)}`, list = vertices.get(key) ?? [];
    const end = i === 0 || i === r.pts.length - 1;
    for (const v of list) if (compatible(r.way, v.route.way) && (r.way.level === v.route.way.level || (end && v.end) || ((end || v.end) && r.way.bridge !== v.route.way.bridge))) union(node, v.node);
    list.push({ node, route: r, end }); vertices.set(key, list);
  });
  const edges: Edge[] = [], arcs: Arc[] = [];
  for (const route of routes) {
    route.nodes = route.nodes.map(root).filter((id, i, ids) => i === 0 || id !== ids[i - 1]);
    for (let i = 1; i < route.nodes.length; i++) {
      const a = route.nodes[i - 1], b = route.nodes[i]; if (a === b) continue;
      const length = distance(nodes[a].p, nodes[b].p) / at.toMerc;
      const id = edges.length; edges.push({ a, b, length, bridge: route.way.bridge }); nodes[a].edges.push(id); nodes[b].edges.push(id);
      for (const [from, to] of [[a, b], [b, a]]) arcs.push({ from, to, rise: -Math.max(ROAD_GRADE * length, route.way.bridge ? 0 : nodes[from].base - nodes[to].base), length });
    }
  }
  const clearances = new Set<string>();
  for (const c of contacts) {
    if (c.join || c.a.route.way.foot && c.b.route.way.foot) continue;
    let upper = c.a, tu = c.ta, lower = c.b, tl = c.tb;
    const aw = upper.route.way, bw = lower.route.way;
    if (aw.level < bw.level || (aw.level === bw.level && rank.get(upper.route)! < rank.get(lower.route)!)) { [upper, lower] = [lower, upper]; [tu, tl] = [tl, tu]; }
    if (!upper.route.way.bridge || lower.route.way.foot) continue;
    const from = root(contactNode(lower, tl)), to = root(contactNode(upper, tu));
    if (from === to) continue;
    const key = `${from},${to}`; if (clearances.has(key)) continue; clearances.add(key);
    arcs.push({ from, to, rise: ROAD_CLEARANCE, length: 0 });
  }
  // Normals shared across two-arm joins make the slab, asphalt and parapets meet
  // at the same cross section. A fork uses its individual arm's cross section.
  const frame = (id: number, prev: number | undefined, next: number | undefined): RoadPoint => {
    const n = nodes[id];
    const neighbours = [...new Set(n.edges.map(e => edges[e].a === id ? edges[e].b : edges[e].a))];
    const before = prev ?? (neighbours.length === 2 ? neighbours.find(v => v !== next) : undefined);
    const after = next ?? (neighbours.length === 2 ? neighbours.find(v => v !== prev) : undefined);
    const dir = (a: number, b: number): RoadPoint => { const p = nodes[a].p, q = nodes[b].p, d = distance(p, q) || 1; return [(q[0] - p[0]) / d, (q[1] - p[1]) / d]; };
    const u = before == null ? dir(id, after!) : dir(before, id), v = after == null ? u : dir(id, after);
    // Bounded miters avoid spikes at hairpins. Both adjacent quads still use
    // exactly this same section; there are no segment caps or flat join discs.
    const sumX = u[0] + v[0], sumZ = u[1] + v[1], len = Math.hypot(sumX, sumZ);
    if (len < EPS) return [-u[1], u[0]];
    const miter = Math.min(2, 2 / len);
    return [-sumZ / len * miter, sumX / len * miter];
  };
  const routeFrame = (ids: number[], i: number): RoadPoint => {
    const closed = ids.length > 2 && ids[0] === ids[ids.length - 1];
    const prev = i > 0 ? ids[i - 1] : closed ? ids[ids.length - 2] : undefined;
    const next = i + 1 < ids.length ? ids[i + 1] : closed ? ids[1] : undefined;
    return frame(ids[i], prev, next);
  };
  // Cross slopes matter too: checking the axis alone lets the ground cut
  // through a wide deck, which looks like holes inside an otherwise sound span.
  for (const route of routes) if (route.way.bridge && route.nodes.length >= 2) route.nodes.forEach((id, i, ids) => {
    const n = nodes[id], f = routeFrame(ids, i);
    for (const side of [-1, 1]) n.floor = Math.max(n.floor, at.driveAt(n.p[0] + f[0] * n.half * side, n.p[1] + f[1] * n.half * side));
  });
  solveHeights(nodes, arcs);
  const plan = new Map<number, PlannedRoad>();
  for (const r of routes) {
    if (outputs && !outputs(r.pts)) continue;
    const ids = r.nodes, pts = ids.map(id => nodes[id].p), s = [0];
    if (ids.length < 2) continue;
    for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + distance(pts[i - 1], pts[i]));
    const h = ids.map(id => nodes[id].h), bed = pts.map(p => at.groundAt(...p));
    const frames = ids.map((_, i) => routeFrame(ids, i));
    const native = (r.way.half ?? (r.way.foot ? 1 : r.way.rail ? 3.4 : 4.2)) * at.toMerc;
    // A width change tapers along the approach, rather than jumping at a split
    // feature. The station at a join takes the larger connected half width.
    const widths = ids.map(id => Math.max(native, nodes[id].half));
    const taper = 0.1;
    for (let i = 1; i < widths.length; i++) widths[i] = Math.max(widths[i], widths[i - 1] - taper * (s[i] - s[i - 1]));
    for (let i = widths.length - 2; i >= 0; i--) widths[i] = Math.max(widths[i], widths[i + 1] - taper * (s[i + 1] - s[i]));
    const planned = plan.get(r.id) ?? { decks: [], rest: [] };
    // Small changes from snapping a junction are pavement tolerances, not an
    // elevated structure. Otherwise a 4 cm correction made isolated flat slabs
    // on a sloping roundabout, with different edges from the draped carriageway.
    const elevated = r.way.bridge || h.some((height, i) => height - at.driveAt(...pts[i]) > 0.15);
    const lifted = (i: number) => elevated && (r.way.bridge || h[i - 1] - at.driveAt(...pts[i - 1]) > 0.03 || h[i] - at.driveAt(...pts[i]) > 0.03);
    let start = 0;
    for (let i = 1; i < pts.length; i++) {
      const up = lifted(i); if (i + 1 < pts.length && up === lifted(i + 1)) continue;
      if (up) {
        planned.decks.push({ pts: pts.slice(start, i + 1), s: s.slice(start, i + 1).map(v => v - s[start]), h: h.slice(start, i + 1), bed: bed.slice(start, i + 1), length: s[i] - s[start], frame: frames.slice(start, i + 1), half: widths.slice(start, i + 1), nodes: ids.slice(start, i + 1) });
      } else {
        // The graph needs dense stations for solving approaches; the unchanged
        // ground mesh does not. Keep real vertices and junctions, and remove
        // only the extra collinear samples introduced by the solver.
        const originals = new Set(r.pts.map(([x, z]) => `${Math.round(x * 1e6)},${Math.round(z * 1e6)}`));
        const run = pts.slice(start, i + 1).filter(([x, z], j, ps) => {
          if (j === 0 || j === ps.length - 1 || nodes[ids[start + j]].edges.length > 2 || originals.has(`${Math.round(x * 1e6)},${Math.round(z * 1e6)}`)) return true;
          const a = ps[j - 1], b = ps[j + 1];
          return Math.abs((x - a[0]) * (b[1] - z) - (z - a[1]) * (b[0] - x)) > 1e-7;
        });
        planned.rest.push(run.map(([x, z]) => ({ x: x / k, y: z / k })));
      }
      start = i;
    }
    plan.set(r.id, planned);
  }
  return plan;
}
