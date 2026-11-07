/**
 * OSM building:parts and tile clips paint different style seeds → pie-slice roofs.
 * Cluster parts that share a wall or sit close together, and prefer a seam key
 * so the neighbour tile (which only sees the cut half) still matches.
 */

export type StyleClusterPart = {
  id: string;
  height: number;
  area: number;
  ring: readonly { x: number; y: number }[];
  styleKey: string;
  /** bbox in tile px [x0,y0,x1,y1] — for proximity merge */
  box?: readonly [number, number, number, number];
};

export type StyleClusterOptions = {
  minEdgeM?: number;
  maxHeightDelta?: number;
  quant?: number;
  softQuant?: number;
  /** merge footprints whose bboxes are within this many meters; default 15 */
  proximityM?: number;
  pxToMeters: number;
};

type Node = {
  parent: string;
  area: number;
  styleKey: string;
  height: number;
  seam: boolean;
};

/** Seam keys: `0:0.0:s12,34` (cell). Interior: `0:0.0:c12,34`. */
export function isSeamStyleKey(styleKey: string) {
  const first = styleKey.indexOf(':');
  const second = styleKey.indexOf(':', first + 1);
  if (second < 0) return false;
  const id = styleKey.slice(second + 1);
  if (id.charAt(0) !== 's') return false;
  const c = id.charAt(1);
  return c === '-' || (c >= '0' && c <= '9');
}

function find(nodes: Map<string, Node>, id: string): string {
  let cur = id;
  while (nodes.get(cur)!.parent !== cur) cur = nodes.get(cur)!.parent;
  let walk = id;
  while (walk !== cur) {
    const n = nodes.get(walk)!;
    const next = n.parent;
    n.parent = cur;
    walk = next;
  }
  return cur;
}

function prefer(a: Node, b: Node): Node {
  if (a.seam !== b.seam) return a.seam ? a : b;
  if (a.area !== b.area) return a.area > b.area ? a : b;
  return a.styleKey <= b.styleKey ? a : b;
}

function unite(nodes: Map<string, Node>, a: string, b: string) {
  const ra = find(nodes, a);
  const rb = find(nodes, b);
  if (ra === rb) return;
  const na = nodes.get(ra)!;
  const nb = nodes.get(rb)!;
  const keep = prefer(na, nb);
  const drop = keep === na ? nb : na;
  drop.parent = keep === na ? ra : rb;
  const root = nodes.get(keep === na ? ra : rb)!;
  root.area = Math.max(na.area, nb.area);
  root.styleKey = keep.styleKey;
  root.seam = keep.seam;
  root.height = keep.height;
}

function ringEdges(
  ring: readonly { x: number; y: number }[],
  quant: number,
  softQuant: number,
  pxToMeters: number,
): { key: string; lenM: number }[] {
  const out: { key: string; lenM: number }[] = [];
  const n = ring.length;
  if (n < 2) return out;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenPx = Math.hypot(dx, dy);
    if (lenPx < 1e-6) continue;
    const lenM = lenPx * pxToMeters;

    const ax = Math.round(a.x / quant) * quant;
    const ay = Math.round(a.y / quant) * quant;
    const bx = Math.round(b.x / quant) * quant;
    const by = Math.round(b.y / quant) * quant;
    if (ax !== bx || ay !== by) {
      const aKey = `${ax},${ay}`;
      const bKey = `${bx},${by}`;
      out.push({ key: aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`, lenM });
    }

    const mx = Math.round(((a.x + b.x) * 0.5) / softQuant);
    const my = Math.round(((a.y + b.y) * 0.5) / softQuant);
    let ux = dx / lenPx;
    let uy = dy / lenPx;
    if (ux < 0 || (ux === 0 && uy < 0)) { ux = -ux; uy = -uy; }
    const oct = Math.round(Math.atan2(uy, ux) / (Math.PI / 4)) & 7;
    out.push({ key: `m${mx},${my}:${oct}`, lenM });
  }
  return out;
}

function bboxOf(ring: readonly { x: number; y: number }[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of ring) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return [x0, y0, x1, y1];
}

/** Gap between two AABBs in the same units as the box (0 if they overlap). */
function bboxGap(a: readonly number[], b: readonly number[]) {
  const dx = Math.max(0, Math.max(a[0] - b[2], b[0] - a[2]));
  const dy = Math.max(0, Math.max(a[1] - b[3], b[1] - a[3]));
  return Math.hypot(dx, dy);
}

export function clusterBuildingStyleKeys(
  parts: readonly StyleClusterPart[],
  options: StyleClusterOptions,
): Map<string, string> {
  const minEdgeM = options.minEdgeM ?? 1;
  const maxHeightDelta = options.maxHeightDelta ?? 25;
  const quant = options.quant ?? 1;
  const softQuant = options.softQuant ?? 4;
  const proximityM = options.proximityM ?? 15;
  const { pxToMeters } = options;
  const proximityPx = proximityM / Math.max(1e-9, pxToMeters);

  const nodes = new Map<string, Node>();
  const boxes = new Map<string, [number, number, number, number]>();
  for (const p of parts) {
    nodes.set(p.id, {
      parent: p.id,
      area: p.area,
      styleKey: p.styleKey,
      height: p.height,
      seam: isSeamStyleKey(p.styleKey),
    });
    boxes.set(p.id, p.box ? [p.box[0], p.box[1], p.box[2], p.box[3]] : bboxOf(p.ring));
  }

  const buckets = new Map<string, { id: string; lenM: number }[]>();
  for (const p of parts) {
    for (const e of ringEdges(p.ring, quant, softQuant, pxToMeters)) {
      if (e.lenM < minEdgeM) continue;
      const list = buckets.get(e.key);
      if (list) list.push({ id: p.id, lenM: e.lenM });
      else buckets.set(e.key, [{ id: p.id, lenM: e.lenM }]);
    }
  }

  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (a.id === b.id) continue;
        if (Math.abs(nodes.get(a.id)!.height - nodes.get(b.id)!.height) > maxHeightDelta) continue;
        unite(nodes, a.id, b.id);
      }
    }
  }

  // Proximity: parts of one complex often don't share exact verts in MVT
  const cell = Math.max(32, proximityPx * 2);
  const grid = new Map<string, string[]>();
  for (const p of parts) {
    const box = boxes.get(p.id)!;
    const gx0 = Math.floor(box[0] / cell);
    const gy0 = Math.floor(box[1] / cell);
    const gx1 = Math.floor(box[2] / cell);
    const gy1 = Math.floor(box[3] / cell);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gy = gy0; gy <= gy1; gy++) {
        const key = `${gx},${gy}`;
        const list = grid.get(key);
        if (list) list.push(p.id); else grid.set(key, [p.id]);
      }
    }
  }
  const seen = new Set<string>();
  for (const list of grid.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (a === b) continue;
        const pair = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (seen.has(pair)) continue;
        seen.add(pair);
        if (Math.abs(nodes.get(a)!.height - nodes.get(b)!.height) > maxHeightDelta) continue;
        if (bboxGap(boxes.get(a)!, boxes.get(b)!) > proximityPx) continue;
        unite(nodes, a, b);
      }
    }
  }

  const out = new Map<string, string>();
  for (const p of parts) {
    out.set(p.id, nodes.get(find(nodes, p.id))!.styleKey);
  }
  return out;
}

export function ringArea(ring: readonly { x: number; y: number }[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j].x * ring[i].y - ring[i].x * ring[j].y;
  }
  return Math.abs(a) * 0.5;
}
