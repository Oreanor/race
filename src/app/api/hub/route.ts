// The airport, port or railway station nearest to a place, from OpenStreetMap
// (Nominatim search in a box around it). Travel lands there instead of in the
// city centre.

type HubKind = 'airport' | 'port' | 'station';
type Row = { category: string; type: string; name?: string; lat: string; lon: string; extratags?: Record<string, string> | null; class?: string };

const cache = new Map<string, [number, number] | null>();
const AIRPORT = /international|airport|aeroporto|aéroport|aeropuerto|flughafen|lotnisko|letiště|аэропорт|空港|机场|공항/i;
const NOT_AIRPORT = /base|military|militar|heliport|héliport|airfield|aérodrome|aeródromo|flugplatz|club|glid/i;
const STATION = /station|bahnhof|hauptbahnhof|gare|вокзал|estaci[oó]n|stazione|estação|駅/i;
const NOT_STATION = /bus|metro|subway|tram|underground|halt|stop|platform|entrance/i;

async function search(q: string, lat: number, lng: number, box: number, extratags: boolean, signal: AbortSignal) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', q);
  url.searchParams.set('viewbox', `${lng - box},${lat + box},${lng + box},${lat - box}`);
  url.searchParams.set('bounded', '1');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '40');
  if (extratags) url.searchParams.set('extratags', '1');
  const response = await fetch(url, { headers: { 'User-Agent': 'CityRider/1.0 (personal driving game)' }, signal });
  if (!response.ok) return [];
  const rows = await response.json() as Row[];
  return Array.isArray(rows) ? rows : [];
}

function nearest(rows: Row[], lat: number, lng: number) {
  let best: [number, number] | null = null;
  let bestD = Infinity;
  for (const row of rows) {
    const plat = Number(row.lat), plon = Number(row.lon);
    const d = (plat - lat) ** 2 + ((plon - lng) * Math.cos(lat * Math.PI / 180)) ** 2;
    if (d < bestD) { bestD = d; best = [plon, plat]; }
  }
  return best;
}

function parseKind(raw: string | null): HubKind {
  if (raw === 'port' || raw === 'station') return raw;
  return 'airport';
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const kind = parseKind(params.get('kind'));
  const lat = Number(params.get('lat'));
  const lng = Number(params.get('lng'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return Response.json(null);
  const key = `${kind}:${lat.toFixed(2)},${lng.toFixed(2)}`;
  if (cache.has(key)) return Response.json(cache.get(key));
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10000)]);
  try {
    let found: [number, number] | null = null;
    if (kind === 'airport') {
      const rows = (await search('airport', lat, lng, 1, true, signal)).filter((r) => r.category === 'aeroway' && r.type === 'aerodrome');
      // real airports first: an IATA code, or a name that says so (not an airbase or airfield)
      const real = rows.filter((r) => r.extratags?.iata || (AIRPORT.test(r.name ?? '') && !NOT_AIRPORT.test(r.name ?? '')));
      found = nearest(real.length ? real : rows, lat, lng);
    } else if (kind === 'station') {
      const rows = (await search('railway station', lat, lng, 0.9, false, signal))
        .filter((r) => (r.category === 'railway' || r.class === 'railway') && r.type === 'station');
      const named = rows.filter((r) => STATION.test(r.name ?? '') && !NOT_STATION.test(r.name ?? ''));
      found = nearest(named.length ? named : rows, lat, lng);
      if (!found) {
        const fallback = (await search('train station', lat, lng, 0.9, false, signal))
          .filter((r) => r.type === 'station' && !NOT_STATION.test(r.name ?? ''));
        found = nearest(fallback, lat, lng);
      }
    } else {
      const ferries = (await search('ferry terminal', lat, lng, 0.6, false, signal)).filter((r) => r.type === 'ferry_terminal');
      found = nearest(ferries, lat, lng);
      if (!found) {
        const ports = (await search('port', lat, lng, 0.8, false, signal)).filter((r) => /port|harbour|ferry/.test(r.type) || r.category === 'harbour');
        found = nearest(ports, lat, lng);
      }
    }
    cache.set(key, found);
    return Response.json(found);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError' && request.signal.aborted) throw error;
    return Response.json(null);
  }
}
