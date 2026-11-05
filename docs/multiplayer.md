# Multiplayer

Everybody drives in the same world: the world comes from the same map tiles for
every player, so only the players' cars travel over the network. No accounts: a
player types any name (or keeps the default one) and drives.

## Running it

```
npm run dev          # the game (Next.js) on :3000 — or: npm run build && npm start
npm run server       # the front door on :3001: the game + multiplayer at /mp
```

Open **http://localhost:3001**. Port 3001 serves everything: it passes the game
through from Next.js (hot reload included) and carries the multiplayer socket on
`/mp`, so one address is all a tunnel needs.

## Playing over the internet: a tunnel to port 3001

Any tunnel that passes websockets works, for example:

```
cloudflared tunnel --url http://localhost:3001     # gives https://<random>.trycloudflare.com
ngrok http 3001                                    # gives https://<random>.ngrok-free.app
```

Send the address to the others. The game connects to `wss://<that address>/mp` by itself.

- For playing through a tunnel, `npm run build && npm start` is much faster to load than
  `npm run dev`. The dev server accepts the usual tunnel domains (`next.config.ts`,
  `allowedDevOrigins`); add yours there if it is another one, then restart `npm run dev`.
- Opened straight from `http://<host>:3000` (no tunnel), the game looks for the relay at
  `ws://<host>:3001/mp`. `NEXT_PUBLIC_MP_URL` overrides the address.
- Environment: `MP_PORT` (default 3001), `MP_NEXT_PORT` / `MP_NEXT_HOST` (default 127.0.0.1:3000).

## What is shared

- name, car, position, altitude, heading, speed and the body's lean, 10 times a second;
  remote cars are played back ~0.16 s behind and glide between updates;
- chat: **Enter** opens the line, Enter sends, Escape closes; lines fade after 15 s;
- "on a mission": while busy, a player shows as parked at the marker where the mission
  began, labelled "on a mission"; mission bots are not shared;
- a player who closes the tab disappears at once; a silent one after 15 s.

Cars bump into each other: each client pushes only its own car away (the other side does
the same on its screen), so nobody's physics runs on the server.

At night other players' cars carry a soft beam of light ahead of them.

## Server protection

- protocol version in the hello (`NET_VERSION`): an outdated tab is told to reload;
- at most `MP_MAX_PLAYERS` (100) connections, 8 per address;
- 30 messages a second per client, past 120 the client is cut off; 2 KB per message;
- chat: one line per 0.7 s, 160 characters, plain text; renames once a second;
- pings every 10 s drop dead connections.

Through a tunnel, prefer `npm run build && npm start` to `npm run dev`: the dev server
exposes development endpoints and loads far slower.

## The public copy on Vercel follows the home server

The site on Vercel always works on its own (single player with bots). While the home
server is up, its front page sends players to it, so everybody plays together.

On Vercel (project settings → environment variables), then redeploy:

- `NEXT_PUBLIC_FOLLOW_TUNNEL=1` — the front page looks for the home server;
- `TUNNEL_SECRET=<any long random string>` — only the home server may change the address;
- storage: Vercel Marketplace → **Upstash Redis** (free), connected to the project; it
  sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`.

At home, a file `.env.tunnel` next to `package.json` (it is git-ignored):

```
MP_PUBLISH_URL=https://<your-site>.vercel.app
MP_TUNNEL_SECRET=<the same string as TUNNEL_SECRET>
```

Then `npm run build && npm start` (the game on :3000) and `npm run server:tunnel`: it starts
the front door on :3001, opens a fresh Cloudflare quick tunnel (`cloudflared` must be
installed; `CLOUDFLARED` may give its path), and tells the site the new address. Ctrl+C
takes the address back. The site checks `<tunnel>/health` before sending anyone there, so a
server that died without saying goodbye is simply skipped.

Settings show the server's state: online with the number of players, not running, or
online play off (`NEXT_PUBLIC_MP_URL=off`).

## Shooting each other, and shared traffic

- A bullet that hits another player's car goes to the server, which checks it (at most 25
  hits a second, the shooter within 250 m, nobody on a mission) and passes it to that
  player: their health drops by 15 of 1000; at zero their car blows up, stops and comes back
  with full health, and everybody reads "X blew up Y". The server believes a "down" only
  from a player who was hit by that shooter in the last 5 s.
- Light traffic (`src/game/net/SharedTraffic.ts`): among players within 1.5 km of each other,
  the one who joined first drives two cars going about their business 160–520 m around and
  sends them out like players. The others see them as targets; their hits go to that player,
  who keeps the cars' health. A wreck is replaced after 10 s. Playing alone, you drive your own.
