// A fresh Cloudflare quick tunnel to the front door, announced to the public site.
// cloudflared prints the new https://<random>.trycloudflare.com address on start;
// we pass it to <MP_PUBLISH_URL>/api/tunnel signed with MP_TUNNEL_SECRET, and take it
// back on exit. The site's front page then sends players here while we are up.
//
// Env: MP_TUNNEL=1 to start it; MP_PUBLISH_URL (e.g. https://city-rider.vercel.app);
// MP_TUNNEL_SECRET (the same value as TUNNEL_SECRET on the site); CLOUDFLARED (path
// to the binary, default "cloudflared" from PATH).

import { spawn } from 'node:child_process';

const ADDRESS = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

async function announce(url: string | null) {
  const site = process.env.MP_PUBLISH_URL, secret = process.env.MP_TUNNEL_SECRET;
  if (!site || !secret) {
    console.log('[tunnel] MP_PUBLISH_URL / MP_TUNNEL_SECRET not set: the site is not told about the tunnel');
    return;
  }
  try {
    const response = await fetch(new URL('/api/tunnel', site), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, secret }),
      signal: AbortSignal.timeout(10_000),
    });
    console.log(`[tunnel] ${url ? 'announced' : 'withdrawn'} at ${site}: ${response.status} ${response.ok ? '' : await response.text()}`);
  } catch (error) {
    console.log(`[tunnel] could not reach ${site}: ${String(error)}`);
  }
}

export function startTunnel(port: number) {
  const binary = process.env.CLOUDFLARED || 'cloudflared';
  const child = spawn(binary, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let url: string | null = null;
  const read = (chunk: Buffer) => {
    if (url) return;
    const found = String(chunk).match(ADDRESS);
    if (!found) return;
    url = found[0];
    console.log(`[tunnel] ${url}`);
    // the address resolves a few seconds after cloudflared prints it
    setTimeout(() => void announce(url), 4000);
  };
  child.stdout.on('data', read);
  child.stderr.on('data', read);
  child.on('error', (error) => console.log(`[tunnel] cannot start ${binary}: ${error.message}`));
  child.on('exit', (code) => console.log(`[tunnel] cloudflared exited (${code})`));

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    if (url) await announce(null);
    child.kill();
    process.exit(0);
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}
