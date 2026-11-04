import { useSyncExternalStore } from 'react';
import { ENGLISH, LANGS, MESSAGES, type Lang, type MessageKey } from './messages';

// Tiny i18n: language from the saved choice, else from the browser
// (Portuguese and Russian by prefix), else English.

const STORAGE_KEY = 'cityRider.lang';
const listeners = new Set<() => void>();

function detect(): Lang {
  if (typeof window === 'undefined') return 'en';
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'pt' || saved === 'ru') return saved;
  } catch { /* storage blocked: fall through to the browser language */ }
  const wanted = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const tag of wanted) {
    const base = (tag ?? '').toLowerCase().split('-')[0];
    if (base === 'pt' || base === 'ru' || base === 'en') return base;
  }
  return 'en';
}

let current: Lang = detect();
if (typeof document !== 'undefined') document.documentElement.lang = current;

export function getLang() { return current; }

export function setLang(lang: Lang) {
  if (lang === current) return;
  current = lang;
  try { window.localStorage.setItem(STORAGE_KEY, lang); } catch { /* keep it for this session only */ }
  document.documentElement.lang = lang;
  for (const fn of listeners) fn();
}

/** Re-render a component when the language changes. */
export function useLang(): Lang {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    () => current,
    () => 'en',
  );
}

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  let text = MESSAGES[current][key] ?? ENGLISH[key] ?? key;
  if (params) for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value));
  return text;
}

/** Numbers in the current language's format (10 000 / 10,000). */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions) {
  return new Intl.NumberFormat(LANGS.find((l) => l.id === current)?.locale ?? 'en-GB', options).format(value);
}

/** "350 m" / "1.2 km" in the current language. */
export function formatDistance(meters: number) {
  return meters < 1000
    ? t('unit.m', { n: formatNumber(Math.round(meters / 10) * 10) })
    : t('unit.km', { n: formatNumber(meters / 1000, { maximumFractionDigits: 1, minimumFractionDigits: 1 }) });
}

export { LANGS, type Lang, type MessageKey };
