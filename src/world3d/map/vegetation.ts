import * as THREE from 'three';
import type { InstanceSet, VegetationData } from '../tiles/vegetationTile';
import type { BaseUniforms } from './materials';
import { simpleLit } from './simpleLit';
import { createPieceGeometries } from '@/game/buildings/BuildingGeometry';

const pieces = createPieceGeometries();

// Draws the per-tile vegetation planned in the worker. Shared low-poly shapes,
// one InstancedMesh per shape per tile; ground height and fog in the shader.

type Kind = 'trunk' | 'leaf0' | 'leaf1' | 'leaf2' | 'post' | 'rail' | 'chimney' | 'vent';

export class VegetationRenderer {
  private geometries: Record<Kind, THREE.BufferGeometry>;
  private materials: Record<Kind, THREE.Material>;

  constructor(uniforms: BaseUniforms) {
    this.geometries = {
      trunk: new THREE.CylinderGeometry(0.13, 0.23, 1, 5),
      leaf0: new THREE.IcosahedronGeometry(1, 0),
      leaf1: new THREE.SphereGeometry(1, 7, 5),
      leaf2: new THREE.ConeGeometry(1, 2, 7),
      post: new THREE.BoxGeometry(0.09, 1, 0.09),
      rail: new THREE.BoxGeometry(1, 0.06, 0.05),
      // same shapes as the old detailed layer's roof props
      chimney: pieces.chimney,
      vent: pieces.vent,
    };
    const lambert = (color: string | number) => simpleLit(color, uniforms);
    const leaf = lambert(0xffffff);
    this.materials = {
      trunk: lambert(0x88654b), leaf0: leaf, leaf1: leaf, leaf2: leaf,
      post: lambert('#4a4036'), rail: lambert('#5c5145'),
      chimney: lambert(0xffffff), vent: lambert(0xffffff),
    };
  }

  /** Chimneys and vents of a tile (colours per instance). */
  buildAccents(accents: { chimney: InstanceSet; vent: InstanceSet }) {
    return this.instanced([['chimney', accents.chimney], ['vent', accents.vent]]);
  }

  /** Meshes for one tile, ready to add to the tile group. */
  build(data: VegetationData): THREE.InstancedMesh[] {
    return this.instanced([
      ['trunk', data.trunks], ['leaf0', data.leaves[0]], ['leaf1', data.leaves[1]], ['leaf2', data.leaves[2]],
      ['post', data.posts], ['rail', data.rails],
    ]);
  }

  private instanced(sets: [Kind, InstanceSet][]): THREE.InstancedMesh[] {
    const out: THREE.InstancedMesh[] = [];
    for (const [kind, set] of sets) {
      if (!set.count) continue;
      const base = this.geometries[kind];
      const geometry = new THREE.BufferGeometry();
      for (const name of Object.keys(base.attributes)) geometry.setAttribute(name, base.getAttribute(name));
      geometry.setIndex(base.getIndex());
      geometry.setAttribute('iGround', new THREE.InstancedBufferAttribute(set.ground, 1));
      const mesh = new THREE.InstancedMesh(geometry, this.materials[kind], set.count);
      mesh.instanceMatrix = new THREE.InstancedBufferAttribute(set.matrices, 16);
      if (set.colors) mesh.instanceColor = new THREE.InstancedBufferAttribute(set.colors, 3);
      mesh.count = set.count;
      mesh.matrixAutoUpdate = false;
      mesh.computeBoundingSphere();
      if (mesh.boundingSphere) mesh.boundingSphere.radius += 400; // ground lift with exaggeration
      out.push(mesh);
    }
    return out;
  }

  /** Free a tile's meshes but keep the shared shapes. */
  release(meshes: THREE.InstancedMesh[]) {
    for (const mesh of meshes) {
      const geometry = mesh.geometry;
      for (const name of Object.keys(geometry.attributes)) if (name !== 'iGround') geometry.deleteAttribute(name);
      geometry.setIndex(null);
      geometry.dispose();
      mesh.dispose();
    }
  }

  setSide(side: THREE.Side) {
    for (const m of Object.values(this.materials)) m.side = side;
  }

  dispose() {
    for (const g of Object.values(this.geometries)) g.dispose();
    for (const m of new Set(Object.values(this.materials))) m.dispose();
  }
}
