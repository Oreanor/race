import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Low-poly tree crowns. Each crown is one merged, flat-shaded geometry, so a
// whole tree is still one instance (plus its trunk). Every shape is normalised
// to radius 1 and height 1 with its base at y = 0: the instance scale is simply
// (crown radius, crown height, crown radius). `aShade` runs 0 → 1 from the
// bottom to the top of the crown, for self-shading and wind sway.

type Blob = { at: [number, number, number]; r: number; squash?: number };

function cluster(blobs: Blob[]) {
  const parts = blobs.map(({ at, r, squash = 1 }) => {
    const g = new THREE.IcosahedronGeometry(r, 0);
    g.scale(1, squash, 1);
    g.translate(at[0], at[1], at[2]);
    return g;
  });
  return finish(parts);
}

function tiers(levels: { r: number; h: number; y: number }[], segments = 6) {
  const parts = levels.map(({ r, h, y }) => {
    const g = new THREE.ConeGeometry(r, h, segments, 1, false);
    g.translate(0, y + h / 2, 0);
    return g;
  });
  return finish(parts);
}

/** Merge, flat-shade, normalise to radius 1 / height 1 and add the height gradient. */
function finish(parts: THREE.BufferGeometry[]) {
  const merged = mergeGeometries(parts.map((p) => p.toNonIndexed()), false)!;
  for (const p of parts) p.dispose();
  merged.computeBoundingBox();
  const box = merged.boundingBox!;
  const radius = Math.max(-box.min.x, box.max.x, -box.min.z, box.max.z) || 1;
  const height = (box.max.y - box.min.y) || 1;
  merged.translate(0, -box.min.y, 0);
  merged.scale(1 / radius, 1 / height, 1 / radius);
  merged.computeVertexNormals();
  const position = merged.getAttribute('position');
  const shade = new Float32Array(position.count);
  for (let i = 0; i < position.count; i++) shade[i] = position.getY(i);
  merged.setAttribute('aShade', new THREE.BufferAttribute(shade, 1));
  merged.deleteAttribute('uv');
  return merged;
}

export type CrownShape = 'round' | 'umbrella' | 'conifer' | 'bush';

export function createCrowns(): Record<CrownShape, THREE.BufferGeometry> {
  return {
    // broadleaf: a few overlapping facets, ~80 triangles
    round: cluster([
      { at: [0, 0.6, 0], r: 0.62 },
      { at: [0.42, 0.48, 0.12], r: 0.45 },
      { at: [-0.36, 0.5, -0.2], r: 0.44 },
      { at: [0.06, 0.95, -0.18], r: 0.4 },
    ]),
    // Mediterranean stone pine: wide, flat, layered top, ~60 triangles
    umbrella: cluster([
      { at: [0, 0.3, 0], r: 0.85, squash: 0.36 },
      { at: [0.5, 0.36, 0.22], r: 0.55, squash: 0.4 },
      { at: [-0.46, 0.33, -0.26], r: 0.58, squash: 0.38 },
    ]),
    // conifer: three tiers, ~36 triangles
    conifer: tiers([
      { r: 1, h: 0.95, y: 0 },
      { r: 0.74, h: 0.85, y: 0.5 },
      { r: 0.46, h: 0.8, y: 1.0 },
    ]),
    // shrub: two soft lumps, ~40 triangles
    bush: cluster([
      { at: [0, 0.4, 0], r: 0.62, squash: 0.8 },
      { at: [0.38, 0.32, 0.18], r: 0.42, squash: 0.85 },
    ]),
  };
}
