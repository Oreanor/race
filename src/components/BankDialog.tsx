'use client';
import type { BankOffer } from '@/game/GameEngine';
import { formatNumber, t } from '@/i18n';
import { useLang } from '@/i18n/react';
import Dialog from './ui/Dialog';

/** The bank (one network): borrow when nothing is owed, else only pay back. */
export default function BankDialog({ offer, onBorrow, onRepay, onLeave }: {
  offer: BankOffer; onBorrow: (amount: number) => void; onRepay: () => void; onLeave: () => void;
}) {
  useLang();
  const wallet = <div className="ui-row ui-wallet"><strong className="ui-coins"><i className="money-coin" aria-hidden="true" />{formatNumber(offer.money)}</strong></div>;
  const leave = <button type="button" className="ui-btn is-ghost" onClick={onLeave}>{t('dialog.leave')}</button>;
  const percent = Math.round(offer.rate * 100);

  if (offer.debt > 0) {
    const pay = Math.min(offer.money, offer.debt);
    return (
      <Dialog title={<>🏦 {t('bank.title')}</>} actions={<>
        <button type="button" className="ui-btn" autoFocus disabled={pay <= 0} onClick={onRepay}>
          {pay <= 0 ? t('dialog.broke') : pay >= offer.debt ? t('bank.repay', { sum: formatNumber(offer.debt) }) : t('bank.repayPart', { sum: formatNumber(pay) })}
        </button>
        {leave}
      </>}>
        <p className="ui-text">{t('bank.owe')}</p>
        <div className="ui-row"><span>{t('bank.debt')}</span><strong>{formatNumber(offer.debt)}</strong></div>
        {wallet}
      </Dialog>
    );
  }

  const amounts = [offer.limit / 4, offer.limit / 2, offer.limit];
  return (
    <Dialog title={<>🏦 {t('bank.title')}</>} actions={<>
      {amounts.map((amount, i) => (
        <button key={amount} type="button" className={i === amounts.length - 1 ? 'ui-btn' : 'ui-btn is-ghost'} autoFocus={i === amounts.length - 1} onClick={() => onBorrow(amount)}>
          {t('bank.borrow', { sum: formatNumber(amount), back: formatNumber(Math.round(amount * (1 + offer.rate))) })}
        </button>
      ))}
      {leave}
    </>}>
      <p className="ui-text">{t('bank.terms', { limit: formatNumber(offer.limit), percent })}</p>
      {wallet}
    </Dialog>
  );
}
