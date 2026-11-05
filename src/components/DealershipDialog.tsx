'use client';
import { cars, carPrice } from '@/config/vehicle.config';
import type { DealerOffer } from '@/game/GameEngine';
import { formatNumber, t } from '@/i18n';
import { useLang } from '@/i18n/react';
import Dialog from './ui/Dialog';

/** Car showroom: every model on the lot, trade-in for half the shelf price of yours. */
export default function DealershipDialog({ offer, onBuy, onLeave }: {
  offer: DealerOffer;
  onBuy: (carId: string) => void;
  onLeave: () => void;
}) {
  useLang();
  const stock = [...cars]
    .map((car) => {
      const price = carPrice(car);
      const net = price - offer.tradeIn;
      return { car, price, net, current: car.id === offer.currentId };
    })
    .sort((a, b) => a.price - b.price);

  return (
    <Dialog
      wide
      title={<>🚗 {t('dealer.title')}</>}
      actions={<button type="button" className="ui-btn is-ghost" onClick={onLeave}>{t('dialog.leave')}</button>}
    >
      <p className="ui-text">{t('dealer.hint')}</p>
      <div className="ui-row ui-wallet"><span>{t('travel.wallet')}</span><strong>{t('travel.coins', { n: formatNumber(offer.money) })}</strong></div>
      <div className="ui-row"><span>{t('dealer.tradeIn')}</span><strong>{t('travel.coins', { n: formatNumber(offer.tradeIn) })}</strong></div>
      <div className="ui-list" role="list">
        {stock.map(({ car, price, net, current }) => {
          const affordable = current || net <= offer.money;
          const label = current ? t('dealer.yours')
            : net >= 0 ? t('dealer.pay', { cost: formatNumber(net) })
              : t('dealer.refund', { gain: formatNumber(-net) });
          return (
            <button
              key={car.id}
              type="button"
              role="listitem"
              className="ui-list-item"
              disabled={!affordable || current}
              onClick={() => onBuy(car.id)}
              title={current ? t('dealer.yours') : affordable ? t('dealer.buy', { car: car.name }) : t('dialog.broke')}
            >
              <span className="ui-list-main">
                <b>{car.name}</b>
                <small>{t('dealer.shelf', { price: formatNumber(price) })} · {label}</small>
              </span>
              <span className="ui-price">{current ? '—' : (net >= 0 ? formatNumber(net) : `+${formatNumber(-net)}`)}</span>
            </button>
          );
        })}
      </div>
    </Dialog>
  );
}
