import type { City } from '../config/vehicle.config.ts';
import { getLang } from '../i18n/index.ts';

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
  /** what the place is: city, village, road, peak… */
  addresstype?: string;
  type?: string;
  address?: {
    city?: string;
    town?: string;
    village?: string;
    municipality?: string;
    county?: string;
    state?: string;
    region?: string;
    country?: string;
    country_code?: string;
  };
};

type Lang = 'en' | 'pt' | 'ru';
type Kind = 'city' | 'town' | 'village' | 'hamlet' | 'municipality' | 'district' | 'county' | 'region' | 'country' | 'road' | 'peak' | 'island' | 'airport' | 'place';
const KIND_OF: Record<string, Kind> = {
  city: 'city', town: 'town', village: 'village', hamlet: 'hamlet', isolated_dwelling: 'hamlet', locality: 'hamlet',
  municipality: 'municipality', suburb: 'district', quarter: 'district', neighbourhood: 'district', city_district: 'district', district: 'district', borough: 'district',
  county: 'county', state: 'region', region: 'region', province: 'region', state_district: 'region', country: 'country',
  road: 'road', peak: 'peak', island: 'island', islet: 'island', aerodrome: 'airport',
};
const KIND_NAME: Record<Lang, Record<Kind, string>> = {
  en: { city: 'City', town: 'Town', village: 'Village', hamlet: 'Hamlet', municipality: 'Municipality', district: 'District', county: 'County', region: 'Region', country: 'Country', road: 'Street', peak: 'Peak', island: 'Island', airport: 'Airport', place: 'Place' },
  pt: { city: 'Cidade', town: 'Vila', village: 'Aldeia', hamlet: 'Lugar', municipality: 'Município', district: 'Bairro', county: 'Distrito', region: 'Região', country: 'País', road: 'Rua', peak: 'Pico', island: 'Ilha', airport: 'Aeroporto', place: 'Local' },
  ru: { city: 'Город', town: 'Город', village: 'Деревня', hamlet: 'Посёлок', municipality: 'Муниципалитет', district: 'Район', county: 'Округ', region: 'Регион', country: 'Страна', road: 'Улица', peak: 'Вершина', island: 'Остров', airport: 'Аэропорт', place: 'Место' },
};

export function placesFromSearch(rows: PlaceHit[], lang: Lang = 'en'): City[] {
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
    // what it is and where: "Village · Lamego, Viseu"
    const kindKey = KIND_OF[row.addresstype ?? ''] ?? KIND_OF[row.type ?? ''];
    const kind = kindKey ? KIND_NAME[lang][kindKey] : '';
    const parents = [address.city, address.town, address.village, address.municipality, address.county, address.state ?? address.region]
      .filter((part): part is string => Boolean(part) && part !== name)
      .filter((part, index, list) => list.indexOf(part) === index)
      .slice(0, 2);
    const area = parents.length ? parents.join(', ') : address.country ?? '';
    const note = kind ? [kind, area].filter(Boolean).join(' · ') : [address.state, address.country].filter(Boolean).join(' · ');
    places.push({ name, country, coords: [lng, lat], heading: 0, road: '', note });
  }
  return places.slice(0, 6);
}

export async function findPlaces(query: string, signal: AbortSignal): Promise<City[]> {
  const response = await fetch(`/api/places?q=${encodeURIComponent(query)}&lang=${getLang()}`, { signal });
  if (!response.ok) throw new Error('search failed');
  const rows = await response.json() as City[];
  return Array.isArray(rows) ? rows.filter(place => place?.name && Array.isArray(place.coords) && place.coords.length === 2) : [];
}
