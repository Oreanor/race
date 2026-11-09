'use client';
import type { ReactNode } from 'react';
import type { Car } from '@/config/vehicle.config';
import { formatNumber, t } from '@/i18n';
import CarPreview from './CarPreview';

/**
 * One car at a time, turning in its preview, with arrows to flip through the
 * line-up, its name and its numbers. The menu picks a car with it, the
 * showroom sells one; `children` go under the numbers (a price, a button).
 * `cars` is the (possibly sorted) line-up to walk through; `index` addresses it.
 */
export default function CarCarousel({ index, onIndex, children, cars: items }: { index: number; onIndex: (index: number) => void; children?: ReactNode; cars: Car[] }) {
  const car = items[index];
  return (
    <div className="car-pick">
      <CarPreview car={car} />
      <button type="button" className="car-arrow is-prev" aria-label="←" onClick={() => onIndex((index + items.length - 1) % items.length)}>‹</button>
      <button type="button" className="car-arrow is-next" aria-label="→" onClick={() => onIndex((index + 1) % items.length)}>›</button>
      <div className="car-pick-name">
        <strong>{car.name}</strong>
        <span>{index + 1} / {items.length}</span>
      </div>
      <dl className="car-specs">
        <div><dt>{t('car.accel')}</dt><dd>{t('car.accelValue', { s: formatNumber(Math.round(100 / 3.6 / car.acceleration * 10) / 10) })}</dd></div>
        <div><dt>{t('car.top')}</dt><dd>{t('car.topValue', { n: formatNumber(Math.round(car.maxSpeed * 3.6)) })}</dd></div>
        <div><dt>{t('car.engine')}</dt><dd>{t('car.engineValue', { l: formatNumber(car.engine) })}</dd></div>
        <div><dt>{t('car.mass')}</dt><dd>{t('car.massValue', { n: formatNumber(car.mass) })}</dd></div>
      </dl>
      {children}
    </div>
  );
}
