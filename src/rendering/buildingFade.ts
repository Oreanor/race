import { DataTexture, NearestFilter, RedFormat, UnsignedByteType, type DataTexture as DataTextureType, type MeshLambertMaterial, type MeshBasicMaterial } from 'three';

type FadeMaterial = (MeshLambertMaterial | MeshBasicMaterial) & { defines?: Record<string, string> };
type FadeShader = { vertexShader: string; fragmentShader: string; uniforms: Record<string, { value: unknown }> };

export const FADE_SLOTS = 4096;
export const GHOST_OPACITY = 0.16;

export type FadeMap = {
  data: Uint8Array;
  current: Float32Array;
  texture: DataTextureType;
  dirty: boolean;
};

export function createFadeMap(): FadeMap {
  const data = new Uint8Array(FADE_SLOTS);
  const current = new Float32Array(FADE_SLOTS);
  data.fill(255);
  current.fill(1);
  const texture = new DataTexture(data, FADE_SLOTS, 1, RedFormat, UnsignedByteType);
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.needsUpdate = true;
  return { data, current, texture, dirty: false };
}

export function paintSlot(fade: FadeMap, slot: number, ghost: boolean) {
  if (slot <= 0 || slot >= FADE_SLOTS) return false;
  const target = ghost ? GHOST_OPACITY : 1;
  const now = fade.current[slot] ?? 1;
  const next = Math.abs(target - now) < 0.03 ? target : now + (target - now) * 0.28;
  if (next !== now) {
    fade.current[slot] = next;
    fade.data[slot] = Math.max(0, Math.min(255, Math.round(next * 255)));
    fade.dirty = true;
  }
  return next < 0.985;
}

export function resetFade(fade: FadeMap) {
  fade.data.fill(255);
  fade.current.fill(1);
  fade.dirty = true;
  fade.texture.needsUpdate = true;
  fade.dirty = false;
}

export function flushFade(fade: FadeMap) {
  if (!fade.dirty) return;
  fade.texture.needsUpdate = true;
  fade.dirty = false;
}

export function installFade(material: FadeMaterial, texture: DataTextureType, ghost: boolean) {
  material.defines = { ...(material.defines ?? {}), BLOCK_FADE: '' };
  if (ghost) material.defines.GHOST_PASS = '';
  material.customProgramCacheKey = () => (ghost ? 'building-ghost' : 'building-solid');
  material.onBeforeCompile = (shader) => {
    const compiled = shader as typeof shader & FadeShader;
    compiled.uniforms.blockMap = { value: texture };
    compiled.vertexShader = compiled.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float blockId;\nvarying float vBlock;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBlock = blockId;');
    compiled.fragmentShader = compiled.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D blockMap;\nvarying float vBlock;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float blockOpacity = texture2D(blockMap, vec2((vBlock + 0.5) / ${FADE_SLOTS}.0, 0.5)).r;
        #ifdef GHOST_PASS
          if (blockOpacity > 0.97) discard;
          diffuseColor.a *= blockOpacity;
        #else
          if (blockOpacity < 0.97) discard;
        #endif`);
  };
  if (ghost) {
    material.transparent = true;
    material.depthWrite = false;
  }
  material.needsUpdate = true;
}
