import { placesFromSearch, type PlaceHit } from '@/game/findPlaces';

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get('q')?.trim() ?? '';
  if (query.length < 2 || query.length > 80) return Response.json([]);
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '6');
  url.searchParams.set('addressdetails', '1');
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'CityRider/1.0 (personal driving game)',
        'Accept-Language': 'ru,en',
      },
      signal: request.signal,
    });
    if (!response.ok) return Response.json([]);
    const rows = await response.json() as PlaceHit[];
    return Response.json(placesFromSearch(Array.isArray(rows) ? rows : []));
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return Response.json([]);
  }
}
