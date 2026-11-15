'use client';
import { useEffect, useState } from 'react';
import type { ServiceOffer } from '@/game/offers';
import { formatNumber, t } from '@/i18n';
import { useLang } from '@/i18n/react';
import Dialog from './ui/Dialog';
import { Price, priced } from './Price';

/** Fuel station or car service: what you can buy here with your coins. */
export default function ServiceDialog({ offer, onBuy, onLeave }: { offer: ServiceOffer; onBuy: (litres?: number) => void; onLeave: () => void }) {
  useLang();
  // fuel: litres on the slider — 1 … as much as fits in the tank and the purse
  const most = offer.kind === 'fuel'
    ? Math.max(0, Math.floor(Math.min(offer.tank - offer.level, offer.money / offer.price)))
    : 0;
  const [litres, setLitres] = useState(most);
  useEffect(() => { setLitres(most); }, [most]);
  const wallet = <div className="ui-row ui-wallet"><Price value={offer.money} /></div>;
  const leave = <button type="button" className="ui-btn is-ghost" onClick={onLeave}>{t('dialog.leave')}</button>;

  if (offer.kind === 'fuel') {
    // slider, its price, fill up, drive on — nothing else
    const amount = Math.min(Math.max(1, litres), Math.max(1, most));
    const none = most < 1;
    return (
      <Dialog title={<>⛽ {t('fuelDlg.title')}</>} actions={<>
        <button type="button" className="ui-btn" autoFocus disabled={none} onClick={() => onBuy(amount)}>{t('fuelDlg.go')}</button>
        {leave}
      </>}>
        <input
          className="ui-slider"
          type="range"
          min={1}
          max={Math.max(1, most)}
          step={1}
          value={amount}
          disabled={none}
          aria-label={t('fuelDlg.litres', { n: amount })}
          onChange={(e) => setLitres(Number(e.target.value))}
        />
        <div className="ui-row fuel-cost">{none ? <span>{offer.tank - offer.level < 0.5 ? t('fuelDlg.full') : t('dialog.broke')}</span> : <Price value={amount * offer.price} />}</div>
      </Dialog>
    );
  }

  const missing = Math.max(0, offer.maxHp - offer.hp);
  const affordable = Math.min(missing, Math.floor(offer.money / offer.price));
  const fine = missing < 1;
  const label = fine ? t('service.ok')
    : affordable >= missing ? priced('service.repair', { cost: Math.ceil(missing * offer.price) })
      : affordable > 0 ? priced('service.partial', { cost: Math.ceil(affordable * offer.price) }, { points: formatNumber(affordable) })
        : t('dialog.broke');
  return (
    <Dialog title={<>🔧 {t('service.title')}</>} actions={<>
      <button type="button" className="ui-btn" autoFocus disabled={fine || affordable <= 0} onClick={() => onBuy()}>{label}</button>
      {leave}
    </>}>
      <div className="ui-meter is-health" role="meter" aria-valuemin={0} aria-valuemax={offer.maxHp} aria-valuenow={offer.hp}>
        <i style={{ width: `${Math.min(100, offer.hp / offer.maxHp * 100)}%` }} />
      </div>
      <div className="ui-row"><span>{t('service.health')}</span><strong>{formatNumber(Math.ceil(offer.hp))} / {formatNumber(offer.maxHp)}</strong></div>
      <div className="ui-row"><span>{t('service.price', { price: offer.price })}</span></div>
      {wallet}
    </Dialog>
  );
}
