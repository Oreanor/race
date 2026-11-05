'use client';

import { useEffect, useRef, useState } from 'react';
import type { OnlinePlayer } from '@/game/GameEngine';
import type { ChatLine, NetNotice } from '@/net/NetClient';
import { CHAT_MAX } from '@/net/protocol';
import { formatNumber, t } from '@/i18n';

// Multiplayer HUD while driving: who else is online (with how far they are) and
// the chat. Enter opens the chat line, Enter sends, Escape closes it.

export type NetFeed = {
  online: (players: OnlinePlayer[]) => void;
  chat: (line: ChatLine) => void;
  notice: (notice: NetNotice) => void;
};

/** chat lines fade out after this long (the open chat shows them all) */
const LINE_MS = 15000;
const KEEP_LINES = 30;

function distance(meters: number) {
  return meters >= 1000
    ? t('unit.km', { n: formatNumber(meters >= 100000 ? Math.round(meters / 1000) : Math.round(meters / 100) / 10) })
    : t('unit.m', { n: formatNumber(Math.round(meters)) });
}

export function NetHud({ subscribe, send }: { subscribe: (feed: NetFeed | null) => void; send: (text: string) => void }) {
  const [players, setPlayers] = useState<OnlinePlayer[]>([]);
  const [lines, setLines] = useState<(ChatLine & { key: number })[]>([]);
  const [notice, setNotice] = useState<NetNotice | null>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [, setTick] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const counter = useRef(0);

  useEffect(() => {
    subscribe({
      online: setPlayers,
      chat: (line) => setLines((list) => [...list.slice(-(KEEP_LINES - 1)), { ...line, key: ++counter.current }]),
      notice: setNotice,
    });
    return () => subscribe(null);
  }, [subscribe]);

  // re-render now and then so old lines fade out
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (open || e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => { if (open) input.current?.focus(); }, [open]);

  const now = Date.now();
  const shown = open ? lines.slice(-10) : lines.filter((l) => now - l.at < LINE_MS).slice(-6);
  const status = notice === 'outdated' ? t('net.outdated') : notice === 'full' ? t('net.full') : notice === 'offline' ? t('net.offline') : null;

  return (
    <>
      {(players.length > 0 || status) && (
        <aside className="net-online" aria-label={t('net.list')}>
          <h3>{t('net.list')} · {players.length + 1}</h3>
          {status && <p className="net-online-status">{status}</p>}
          <ul>
            {players.slice(0, 8).map((p) => (
              <li key={p.id}>
                <span className="net-online-name">{p.name}{p.busy ? ` · ${t('net.busy')}` : ''}</span>
                <span className="net-online-distance">{distance(p.distance)}</span>
              </li>
            ))}
            {players.length > 8 && <li className="net-online-more">+{players.length - 8}</li>}
          </ul>
        </aside>
      )}
      <div className={open ? 'net-chat is-open' : 'net-chat'} aria-live="polite">
        {shown.map((l) => (
          <p key={l.key} className={l.mine ? 'is-mine' : ''} style={!open ? { opacity: Math.min(1, (LINE_MS - (now - l.at)) / 3000) } : undefined}>
            <b>{l.name}</b> {l.text}
          </p>
        ))}
        {open ? (
          <input
            ref={input}
            className="ui-input"
            maxLength={CHAT_MAX}
            value={text}
            placeholder={t('net.chatPlaceholder')}
            aria-label={t('net.chatPlaceholder')}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => setOpen(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const line = text.trim();
                if (line) send(line);
                setText('');
                setOpen(false);
                e.preventDefault();
              }
              if (e.key === 'Escape') {
                // close the chat, not open the settings
                e.stopPropagation();
                e.nativeEvent.stopImmediatePropagation();
                setText('');
                setOpen(false);
              }
            }}
          />
        ) : players.length > 0 && <p className="net-chat-hint">{t('net.chatHint')}</p>}
      </div>
    </>
  );
}
