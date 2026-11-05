// The home server behind a tunnel (server/tunnel.ts announces it to /api/tunnel):
// where it is and whether it answers. Used by the front page (follow it there) and
// by the settings (show its state).

/** The tunnel's address the site knows of, or null (none, or not this kind of site). */
export async function tunnelAddress(): Promise<string | null> {
  if (process.env.NEXT_PUBLIC_FOLLOW_TUNNEL !== '1') return null;
  try {
    const { url } = await (await fetch('/api/tunnel', { cache: 'no-store', signal: AbortSignal.timeout(2500) })).json() as { url: string | null };
    return url;
  } catch {
    return null;
  }
}

/** A server's /health, or null when it does not answer. */
export async function serverHealth(base: string): Promise<{ players: number } | null> {
  try {
    const health = await (await fetch(`${base}/health`, { cache: 'no-store', signal: AbortSignal.timeout(3000) })).json() as { ok?: boolean; players?: number };
    return health.ok ? { players: health.players ?? 0 } : null;
  } catch {
    return null;
  }
}
