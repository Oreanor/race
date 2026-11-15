import type { Lang } from '../i18n/index.ts';

export type PlaceAddress = Partial<Record<'hamlet' | 'isolated_dwelling' | 'village' | 'town' | 'city' | 'municipality' | 'county' | 'state_district' | 'suburb' | 'city_district' | 'borough' | 'quarter' | 'neighbourhood' | 'state' | 'province' | 'region' | 'country' | 'country_code', string>>;
export type LocalityLabel = { name: string; district: string | null; title: string; context: string; label: string };

const TYPES = {
  ru: { city: 'г.', village: 'деревня', hamlet: 'посёлок', municipality: 'муниципалитет', district: 'район', county: 'округ', state: 'штат' },
  en: { city: 'City', village: 'Village', hamlet: 'Hamlet', municipality: 'Municipality', district: 'District', county: 'County', state: 'State' },
  pt: { city: 'Cidade', village: 'Aldeia', hamlet: 'Lugar', municipality: 'Município', district: 'Bairro', county: 'Distrito', state: 'Estado' },
};

export function localityFromAddress(a: PlaceAddress, lang: Lang = 'en'): LocalityLabel | null {
  const types = TYPES[lang];
  const urban = !!(a.city || a.town || a.city_district || a.suburb || a.borough || a.quarter || a.neighbourhood);
  const hamlet = urban ? undefined : a.hamlet || a.isolated_dwelling;
  const name = a.village || hamlet || a.town || a.city || a.municipality;
  if (!name) return null;
  const settlementType = a.village ? types.village : hamlet ? types.hamlet : a.town || a.city ? types.city : types.municipality;
  // The city district / borough explains which city a neighbourhood belongs to.
  // Keep both when the reverse result supplies them (e.g. a Manhattan quarter).
  const parts = [a.neighbourhood, a.quarter, a.suburb, urban ? a.hamlet || a.isolated_dwelling : undefined, a.city_district, a.borough]
    .filter((p): p is string => !!p && p !== name)
    .filter((p, i, list) => list.indexOf(p) === i);
  const district = parts[0] ?? null;
  const state = a.state || a.province || a.region;
  const region = state ? a.country_code?.toLowerCase() === 'us' ? `${types.state} ${state}` : state : '';
  let country = a.country || '';
  if (a.country_code && /^[a-z]{2}$/i.test(a.country_code)) {
    try { country = new Intl.DisplayNames([lang, 'en'], { type: 'region' }).of(a.country_code.toUpperCase()) || country; } catch { /* keep the available source label */ }
  }
  if (a.country_code?.toLowerCase() === 'us') country = { ru: 'США', en: 'USA', pt: 'EUA' }[lang];
  const parentCity = a.city && a.city !== name ? `${types.city} ${a.city}` : '';
  const named = new Set([name, ...parts, a.city].filter(Boolean).map(p => p!.toLocaleLowerCase()));
  const administrative = ([['municipality', a.municipality], ['county', a.county], ['county', a.state_district]] as const)
    .flatMap(([kind, value]) => {
      if (!value || named.has(value.toLocaleLowerCase()) || value === state || value === country) return [];
      named.add(value.toLocaleLowerCase());
      // Geocoders sometimes include the type in the returned name already.
      return [/\b(county|municipality|distrito|município)\b|округ|муниципалитет/i.test(value) ? value : `${types[kind]} ${value}`];
    });
  const title = [district ? `${types.district} ${district}` : '', `${settlementType} ${name}`, parentCity]
    .filter(Boolean).filter((p, i, list) => list.indexOf(p) === i).join(', ');
  const context = [region, ...administrative, country].filter(Boolean).filter((p, i, list) => list.indexOf(p) === i).join(', ');
  return { name, district, title, context, label: [title, context].filter(Boolean).join(', ') };
}
