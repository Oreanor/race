'use client';
import { useSyncExternalStore } from 'react';
import { getLang, onLangChange, type Lang } from './index.ts';

/** Re-render a component when the language changes. Client components only. */
export function useLang(): Lang {
  return useSyncExternalStore(onLangChange, getLang, () => 'en');
}
