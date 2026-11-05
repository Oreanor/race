'use client';
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { serverHealth, tunnelAddress } from '@/net/homeServer';

// The game runs in the browser only (WebGL, workers).
const Root = dynamic(() => import('./Game'), { ssr: false });

/**
 * With NEXT_PUBLIC_FOLLOW_TUNNEL=1 (the copy on Vercel): when the home server is up
 * (its tunnel registered at /api/tunnel and answering /health), go there — everybody
 * plays together on it. Otherwise stay and play this copy.
 */
async function liveTunnel(): Promise<string | null> {
  const url = await tunnelAddress();
  if (!url || new URL(url).host === location.host) return null;
  return (await serverHealth(url)) ? url : null;
}

export default function GameClient() {
  const [stay, setStay] = useState(process.env.NEXT_PUBLIC_FOLLOW_TUNNEL !== '1');
  useEffect(() => {
    if (stay) return;
    let cancelled = false;
    liveTunnel().then((url) => {
      if (cancelled) return;
      if (url) location.replace(url + location.pathname + location.search);
      else setStay(true);
    });
    return () => { cancelled = true; };
  }, [stay]);
  return stay ? <Root /> : null;
}
