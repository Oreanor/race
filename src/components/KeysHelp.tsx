'use client';
import { useEffect } from 'react';
import { KeyMap } from './KeyMap';
import { t } from '@/i18n';
import { useLang } from '@/i18n/react';

/**
 * K (or the settings entry): the control map over anything. While it is open the
 * keyboard is its own — the listener sits on the capture phase, so Escape closes the
 * map without also opening the settings, and game keys don't act behind it.
 */
export default function KeysHelp({ onClose }: { onClose: () => void }) {
  useLang();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat && (e.code === 'KeyK' || e.code === 'Escape')) onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="ui-backdrop keymap-backdrop" role="presentation" onPointerDown={onClose}>
      <section className="ui-dialog keymap" role="dialog" aria-label={t('keys.title')} onPointerDown={(e) => e.stopPropagation()}>
        <h2 className="ui-title">{t('keys.title')}</h2>
        <KeyMap />
        <div className="ui-actions">
          <button type="button" className="ui-btn" onClick={onClose}>{t('keys.close')}</button>
        </div>
      </section>
    </div>
  );
}
