'use client';
import { useState } from 'react';
import { cars, carPrice } from '@/config/vehicle.config';
import type { DealerOffer } from '@/game/GameEngine';
import { formatNumber, t } from '@/i18n';
import { useLang } from '@/i18n/react';
import CarCarousel from './CarCarousel';
import Dialog from './ui/Dialog';

/**
 * Car showroom: the same carousel as the menu, one model at a time with its
 * numbers, its price and what it costs after the trade-in (half the shelf price
 * of the car you came in).
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
  const net = price - offer.tradeIn;
  const current = car.id === offer.currentId;
  const affordable = current || net <= offer.money;
  const deal = current ? t('dealer.yours')
    : net >= 0 ? t('dealer.pay', { cost: formatNumber(net) })
      : t('dealer.refund', { gain: formatNumber(-net) });

  return (
    <Dialog
      title={<>🚗 {t('dealer.title')}</>}
      actions={<>
        <button type="button" className="ui-btn" disabled={current || !affordable} onClick={() => onBuy(car.id)}
          title={current ? t('dealer.yours') : affordable ? t('dealer.buy', { car: car.name }) : t('dialog.broke')}>
          {current ? t('dealer.yours') : t('dealer.buy', { car: car.name })}
        </button>
        <button type="button" className="ui-btn is-ghost" onClick={onLeave}>{t('dialog.leave')}</button>
      </>}
    >
      <div className="ui-row ui-wallet"><span>{t('travel.wallet')}</span><strong>{t('travel.coins', { n: formatNumber(offer.money) })}</strong></div>
      <CarCarousel index={index} onIndex={setIndex}>
        <div className="car-deal">
          <span>{t('dealer.shelf', { price: formatNumber(price) })}</span>
          <strong className={affordable ? '' : 'is-broke'}>{deal}</strong>
        </div>
      </CarCarousel>
      <p className="ui-text">{t('dealer.tradeIn')}: {t('travel.coins', { n: formatNumber(offer.tradeIn) })}</p>
    </Dialog>
  );
}
