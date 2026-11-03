import type { City } from '@/config/vehicle.config';

const REGION: Record<string, string> = {
  pt: 'Portugal',
  us: 'United States',
  jp: 'Japan',
  fr: 'France',
  gb: 'United Kingdom',
  es: 'Spain',
  it: 'Italy',
};

export type PlaceHit = {
  lat?: string;
  lon?: string;
  name?: string;
  address?: {
    city?: string;
    town?: string;
    village?: string;
    municipality?: string;
    state?: string;
    country?: string;
    country_code?: string;
  };
};

export function placesFromSearch(rows: PlaceHit[]): City[] {
  const places: City[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const lat = Number(row.lat);
    const lng = Number(row.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const address = row.address ?? {};
    const name = row.name || address.city || address.town || address.village || address.municipality;
    if (!name) continue;
    const key = `${name.toLowerCase()}|${lng.toFixed(2)}|${lat.toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const code = (address.country_code || '').toLowerCase();
    const country = REGION[code] || address.country || '';
    const note = [address.state, address.country].filter(Boolean).join(' · ') || 'Точка на карте';
    places.push({ name, country, coords: [lng, lat], heading: 0, road: '', note });
  }
  return places.slice(0, 6);
}

export async function findPlaces(query: string, signal: AbortSignal): Promise<City[]> {
  const response = await fetch(`/api/places?q=${encodeURIComponent(query)}`, { signal });
  if (!response.ok) throw new Error('search failed');
  const rows = await response.json() as City[];
  return Array.isArray(rows) ? rows.filter(place => place?.name && Array.isArray(place.coords) && place.coords.length === 2) : [];
}
