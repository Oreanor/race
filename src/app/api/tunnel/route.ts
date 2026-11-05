// Where the home server is right now. The multiplayer server (server/multiplayer.ts)
// opens a fresh tunnel on every start and reports its address here, signed with
// TUNNEL_SECRET; the front page asks for it and moves over when the server answers.
// Stored in Upstash Redis (Vercel Marketplace → Upstash: it sets KV_REST_API_URL and
// KV_REST_API_TOKEN). Without those, there is simply no tunnel.

const KEY = 'city-rider:tunnel';
/** only tunnel hosts: a leaked secret must not turn the site into a redirect to anywhere */
const TUNNEL = /^https:\/\/[a-z0-9-]+\.(trycloudflare\.com|ngrok-free\.app|ngrok\.app|ngrok\.io|loca\.lt)$/;

function store() {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

async function redis(command: (string | number)[]) {
  const kv = store();
  if (!kv) return null;
  const response = await fetch(kv.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${kv.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(command),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`store ${response.status}`);
  return (await response.json() as { result: unknown }).result;
}

export async function GET() {
  try {
    const url = await redis(['GET', KEY]);
    return Response.json({ url: typeof url === 'string' && TUNNEL.test(url) ? url : null }, { headers: { 'cache-control': 'no-store' } });
  } catch {
    return Response.json({ url: null }, { headers: { 'cache-control': 'no-store' } });
  }
}

export async function POST(request: Request) {
  const secret = process.env.TUNNEL_SECRET;
  let body: { url?: unknown; secret?: unknown };
  try { body = await request.json(); } catch { return new Response('bad json', { status: 400 }); }
  if (!secret || body.secret !== secret) return new Response('forbidden', { status: 403 });
  if (!store()) return new Response('no store configured', { status: 501 });
  if (body.url === null) {
    await redis(['DEL', KEY]);
    return Response.json({ ok: true });
  }
  if (typeof body.url !== 'string' || !TUNNEL.test(body.url)) return new Response('not a tunnel address', { status: 400 });
  // a day at most: a server that died without saying so is forgotten
  await redis(['SET', KEY, body.url, 'EX', 86400]);
  return Response.json({ ok: true });
}
