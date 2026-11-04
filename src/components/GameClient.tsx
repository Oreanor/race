'use client';
import dynamic from 'next/dynamic';

// Renderer is picked from the URL on the client: ?mode=three-world opens the
// experimental standalone Three.js world, anything else the MapLibre game.
const Root = dynamic(async () => {
  const { currentMode } = await import('./ModeSwitch');
  if (currentMode() === 'three-world') return (await import('./ThreeWorldView')).default;
  return (await import('./Game')).default;
}, { ssr: false });

export default function GameClient() {
  return <Root />;
}
