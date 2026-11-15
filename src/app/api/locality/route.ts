// The settlement a point lies in (city, town, village or hamlet), from OpenStreetMap
// (Nominatim reverse). The HUD shows it, so driving from Coimbra to Aveiro reads
// "Aveiro" once there, and the villages on the way by their own names.

type Address = Partial<Record<'hamlet' | 'isolated_dwelling' | 'village' | 'town' | 'city' | 'municipality' | 'suburb' | 'city_district' | 'quarter' | 'neighbourhood', string>>;

/** ~100 m cells: neighbours share an answer; Nominatim asks for few requests */
const cache = new Map<string, string | null>();
const CACHE_MAX = 5000;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const lat = Number(params.get('lat'));
  const lng = Number(params.get('lng'));
  const lang = /^(en|pt|ru)$/.test(params.get('lang') ?? '') ? params.get('lang')! : 'en';
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return Response.json(null);
  const key = `${lang}:${lat.toFixed(3)},${lng.toFixed(3)}`;
  if (cache.has(key)) return Response.json(cache.get(key));
  const url = new URL('https://nominatim.openstreetmap.org/reverse');
  url.searchParams.set('lat', lat.toFixed(5));
  url.searchParams.set('lon', lng.toFixed(5));
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('zoom', '14'); // down to villages and hamlets, not streets
  url.searchParams.set('addressdetails', '1');
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'CityRider/1.0 (personal driving game)', 'Accept-Language': `${lang},en` },
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(8000)]),
    });
    if (!response.ok) return Response.json(null);
    const row = await response.json() as { address?: Address };
    const a = row.address ?? {};
    // the smallest settlement wins: a village inside a big municipality is the village.
    // A "hamlet" inside a city or town is a quarter of it (Aveiro's Misericórdia, Newark's
    // Roseville): there the city is the answer. Out in the country it is the hamlet.
    const urban = !!(a.city || a.town || a.city_district || a.suburb || a.quarter || a.neighbourhood);
    const hamlet = urban ? undefined : a.hamlet || a.isolated_dwelling;
    const name = a.village || hamlet || a.town || a.city || a.municipality || null;
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(key, name);
    return Response.json(name);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError' && request.signal.aborted) throw error;
    return Response.json(null);
  }
}
