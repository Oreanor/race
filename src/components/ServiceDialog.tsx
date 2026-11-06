'use client';
import type { ServiceOffer } from '@/game/GameEngine';
import { formatNumber, t } from '@/i18n';
import { useLang } from '@/i18n/react';
import Dialog from './ui/Dialog';
import { Price, priced } from './Price';

/** Fuel station or car service: what you can buy here with your coins. */
export default function ServiceDialog({ offer, onBuy, onLeave }: { offer: ServiceOffer; onBuy: () => void; onLeave: () => void }) {
  useLang();
  const wallet = <div className="ui-row ui-wallet"><Price value={offer.money} /></div>;
  const leave = <button type="button" className="ui-btn is-ghost" onClick={onLeave}>{t('dialog.leave')}</button>;

  if (offer.kind === 'fuel') {
    const room = Math.max(0, offer.tank - offer.level);
    const affordable = Math.min(room, Math.floor(offer.money / offer.price));
    const full = room < 0.5;
    const label = full ? t('fuelDlg.full')
      : affordable >= room - 0.01 ? priced('fuelDlg.fill', { cost: Math.ceil(room * offer.price) })
        : affordable > 0 ? priced('fuelDlg.partial', { cost: Math.floor(affordable) * offer.price }, { litres: formatNumber(Math.floor(affordable)) })
          : t('dialog.broke');
    return (
      <Dialog title={<>⛽ {t('fuelDlg.title')}</>} actions={<>
        <button type="button" className="ui-btn" autoFocus disabled={full || affordable <= 0} onClick={onBuy}>{label}</button>
        {leave}
      </>}>
        <div className="ui-meter" role="meter" aria-valuemin={0} aria-valuemax={offer.tank} aria-valuenow={offer.level}>
          <i style={{ width: `${Math.min(100, offer.level / offer.tank * 100)}%` }} />
        </div>
        <div className="ui-row"><span>{t('fuelDlg.tank')}</span><strong>{formatNumber(Math.floor(offer.level))} / {formatNumber(Math.round(offer.tank))} {t('unit.l')}</strong></div>
        <div className="ui-row"><span>{t('fuelDlg.price', { price: offer.price })}</span></div>
        {wallet}
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
      <button type="button" className="ui-btn" autoFocus disabled={fine || affordable <= 0} onClick={onBuy}>{label}</button>
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
