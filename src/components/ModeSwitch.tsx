'use client';

/**
 * three      — the game on our own Three.js world (default)
 * maplibre   — the same game on MapLibre, kept for comparison
 * three-world — renderer lab: buildings only, for raw performance tests
 */
export type RenderMode = 'three' | 'maplibre' | 'three-world';

/** Renderer comparison and the lab are development tools: production always runs our world. */
export const DEV_TOOLS = process.env.NODE_ENV !== 'production';

export function currentMode(): RenderMode {
  if (!DEV_TOOLS) return 'three';
  const mode = new URLSearchParams(window.location.search).get('mode');
  return mode === 'maplibre' || mode === 'three-world' ? mode : 'three';
}

/** Full reload keeps renderers isolated (separate GL contexts, no leaks). */
function hrefFor(mode: RenderMode) {
  const params = new URLSearchParams(window.location.search);
  if (mode === 'three') params.delete('mode');
  else params.set('mode', mode);
  const query = params.toString();
  return `${window.location.pathname}${query ? `?${query}` : ''}`;
}

const LABELS: Record<RenderMode, string> = { three: 'Three.js', maplibre: 'MapLibre', 'three-world': 'lab' };

export default function ModeSwitch({ current }: { current: RenderMode }) {
  if (!DEV_TOOLS) return null;
  return (
    <nav className="mode-switch" aria-label="Рендерер">
      {(Object.keys(LABELS) as RenderMode[]).map((mode) => (
        <a key={mode} href={hrefFor(mode)} aria-current={current === mode ? 'page' : undefined}>{LABELS[mode]}</a>
      ))}
    </nav>
  );
}
