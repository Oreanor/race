'use client';
import { useEffect, useMemo, useState } from 'react';
import { cities, type City } from '@/config/vehicle.config';
import { findPlaces } from '@/game/findPlaces';
import { kilometres, ticketPrice, type HubKind } from '@/game/Travel';
import type { TravelOffer } from '@/game/GameEngine';
import Dialog from './ui/Dialog';
import { formatNumber, t } from '@/i18n';
import { useLang } from '@/i18n/react';

const COPY: Record<HubKind, { title: 'travel.airport' | 'travel.port'; go: 'travel.fly' | 'travel.sail'; icon: string }> = {
  airport: { title: 'travel.airport', go: 'travel.fly', icon: '✈' },
  port: { title: 'travel.port', go: 'travel.sail', icon: '⚓' },
};

const key = (c: City) => `${c.name}|${c.coords[0].toFixed(3)}|${c.coords[1].toFixed(3)}`;

/** Ticket office: any city in the world, priced by distance and transport. */
export default function TravelDialog({ offer, current, onBuy, onStay }: {
  offer: TravelOffer;
  current: City;
  onBuy: (city: City) => void;
  onStay: () => void;
}) {
  useLang();
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<City[]>([]);
  const [looking, setLooking] = useState(false);
  const copy = COPY[offer.kind];

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setFound([]); setLooking(false); return; }
    setLooking(true);
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      findPlaces(q, ctrl.signal)
        .then((list) => { if (!ctrl.signal.aborted) setFound(list); })
        .catch(() => { if (!ctrl.signal.aborted) setFound([]); })
        .finally(() => { if (!ctrl.signal.aborted) setLooking(false); });
    }, 350);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [query]);

  const options = useMemo(() => {
    const list = query.trim().length >= 2 ? found : cities.filter((c) => key(c) !== key(current));
    return list.map((city) => ({
      city,
      km: Math.round(kilometres(offer.from, city.coords)),
      price: ticketPrice(offer.from, city.coords, offer.kind),
    })).filter((o) => o.km > 1);
  }, [found, query, offer, current]);

  return (
    <Dialog
      wide
      title={<>{copy.icon} {t(copy.title)}</>}
      actions={<button type="button" className="ui-btn is-ghost" onClick={onStay}>{t('travel.stay')}</button>}
    >
      <p className="ui-text">{t('travel.question')}{offer.kind === 'airport' ? ` ${t('travel.planeMore')}` : ''}</p>
      <div className="ui-row ui-wallet"><span>{t('travel.wallet')}</span><strong>{t('travel.coins', { n: formatNumber(offer.money) })}</strong></div>
      <input
        className="ui-input"
        placeholder={t('travel.search')}
        aria-label={t('travel.search')}
        value={query}
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="ui-list" role="list">
        {options.map(({ city, km, price }) => {
          const affordable = price <= offer.money;
          return (
            <button
              key={key(city)}
              type="button"
              role="listitem"
              className="ui-list-item"
              disabled={!affordable}
              onClick={() => onBuy(city)}
              title={affordable ? t(copy.go, { city: city.name }) : t('travel.short')}
            >
              <span className="ui-list-main"><b>{city.name}</b><small>{city.country} · {t('unit.km', { n: formatNumber(km) })}</small></span>
              <span className="ui-price">{formatNumber(price)}</span>
            </button>
          );
        })}
        {looking && <p className="ui-empty">{t('travel.searching')}</p>}
        {!looking && !options.length && <p className="ui-empty">{t('travel.none')}</p>}
      </div>
    </Dialog>
  );
}
