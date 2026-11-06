'use client';
import { useState } from 'react';
import { cars, carPrice } from '@/config/vehicle.config';
import type { DealerOffer } from '@/game/offers';
import { t } from '@/i18n';
import { useLang } from '@/i18n/react';
import CarCarousel from './CarCarousel';
import Dialog from './ui/Dialog';
import { Price } from './Price';

/**
 * Car showroom: the same carousel as the menu, one model at a time with its numbers.
 * A new car costs its full price and joins the garage (nothing is sold back); a car
 * already in the garage is free to get into.
 */
export default function DealershipDialog({ offer, onBuy, onLeave }: {
  offer: DealerOffer;
  onBuy: (carId: string) => void;
  onLeave: () => void;
}) {
  useLang();
  // open on the car you came in
  const [index, setIndex] = useState(() => Math.max(0, cars.findIndex((car) => car.id === offer.currentId)));
  const car = cars[index];
  const price = carPrice(car);
  const current = car.id === offer.currentId;
  const owned = offer.owned.includes(car.id);
  const affordable = current || owned || price <= offer.money;
  // we only ever buy (nothing goes back to the shop): a car is its price, or ours already
  const status = current ? t('dealer.yours') : owned ? t('dealer.owned') : null;

  return (
    <Dialog
      title={<>🚗 {t('dealer.title')}</>}
      actions={<>
        <button type="button" className="ui-btn" disabled={current || !affordable} onClick={() => onBuy(car.id)}
          title={current ? t('dealer.yours') : affordable ? t('dealer.buy', { car: car.name }) : t('dialog.broke')}>
          {current ? t('dealer.yours') : owned ? t('dealer.drive', { car: car.name }) : t('dealer.buy', { car: car.name })}
        </button>
        <button type="button" className="ui-btn is-ghost" onClick={onLeave}>{t('dialog.leave')}</button>
      </>}
    >
      <div className="ui-row ui-wallet is-reward"><span>{t('dealer.garage', { n: offer.owned.length })}</span><Price value={offer.money} /></div>
      <CarCarousel index={index} onIndex={setIndex}>
        <div className="car-deal">
          <span>{t('dealer.price')}</span>
          {status ? <strong>{status}</strong> : <strong className={affordable ? undefined : 'is-broke'}><Price value={price} /></strong>}
        </div>
      </CarCarousel>
    </Dialog>
  );
}
