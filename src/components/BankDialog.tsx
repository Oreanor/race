'use client';
import type { BankOffer } from '@/game/offers';
import { t } from '@/i18n';
import { useLang } from '@/i18n/react';
import Dialog from './ui/Dialog';
import { Price, priced } from './Price';

/** The bank (one network): borrow when nothing is owed, else only pay back. */
export default function BankDialog({ offer, onBorrow, onRepay, onLeave }: {
  offer: BankOffer; onBorrow: (amount: number) => void; onRepay: () => void; onLeave: () => void;
}) {
  useLang();
  const wallet = <div className="ui-row ui-wallet"><Price value={offer.money} /></div>;
  const leave = <button type="button" className="ui-btn is-ghost" onClick={onLeave}>{t('dialog.leave')}</button>;
  const percent = Math.round(offer.rate * 100);

  if (offer.debt > 0) {
    const pay = Math.min(offer.money, offer.debt);
    return (
      <Dialog title={<>🏦 {t('bank.title')}</>} actions={<>
        <button type="button" className="ui-btn" autoFocus disabled={pay <= 0} onClick={onRepay}>
          {pay <= 0 ? t('dialog.broke') : pay >= offer.debt ? priced('bank.repay', { sum: offer.debt }) : priced('bank.repayPart', { sum: pay })}
        </button>
        {leave}
      </>}>
        <p className="ui-text">{t('bank.owe')}</p>
        <div className="ui-row"><span>{t('bank.debt')}</span><strong><Price value={offer.debt} /></strong></div>
        {wallet}
      </Dialog>
    );
  }

  const amounts = [offer.limit / 4, offer.limit / 2, offer.limit];
  return (
    <Dialog title={<>🏦 {t('bank.title')}</>} actions={<>
      {amounts.map((amount, i) => (
        <button key={amount} type="button" className={i === amounts.length - 1 ? 'ui-btn' : 'ui-btn is-ghost'} autoFocus={i === amounts.length - 1} onClick={() => onBorrow(amount)}>
          {priced('bank.borrow', { sum: amount, back: Math.round(amount * (1 + offer.rate)) })}
        </button>
      ))}
      {leave}
    </>}>
      <p className="ui-text">{priced('bank.terms', { limit: offer.limit }, { percent })}</p>
      {wallet}
    </Dialog>
  );
}
