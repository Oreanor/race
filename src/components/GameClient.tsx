'use client';
import dynamic from 'next/dynamic';

// The game runs in the browser only (WebGL, workers).
const Root = dynamic(() => import('./Game'), { ssr: false });

export default function GameClient() {
  return <Root />;
}
