import type { ReactNode } from 'react';
import { formatNumber, t, type MessageKey } from '@/i18n';

// Money looks the same everywhere: a coin, a little gap, the number in bold gold.
// One look, so a price reads as a price at a glance (wallet, shop, tickets, rewards).

export function Price({ value }: { value: number }) {
  return <span className="price"><i className="money-coin" aria-hidden="true" />{formatNumber(value)}</span>;
}

const MARK = '\u0001';

/**
 * A translated sentence with sums in it: `money` names the parameters that are money,
 * each drawn as a Price where the text puts it ("Pay {cost}" → "Pay ◉ 4 000").
 */
export function priced(key: MessageKey, money: Record<string, number>, params: Record<string, string | number> = {}): ReactNode {
  const names = Object.keys(money);
  const marks = Object.fromEntries(names.map((name, i) => [name, `${MARK}${i}${MARK}`]));
  const parts = t(key, { ...params, ...marks }).split(MARK);
  // the spaces round a price are kept (a flex row would drop a text's edge spaces: "Pay◉ 4 000")
  return parts.map((part, i) => (i % 2 ? <Price key={i} value={money[names[Number(part)]]} /> : part.replace(/^ /, ' ').replace(/ $/, ' ')));
}
