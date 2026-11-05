'use client';
import { useEffect, useState } from 'react';
import type { FuelHud } from '@/game/GameEngine';
import { formatDistance, t } from '@/i18n';
import { useLang } from '@/i18n/react';

/**
 * Tachometer (needle = revs). The engine pushes ~10 updates a second through
 * `subscribe`, so the rest of the HUD does not re-render with it.
 */
export default function FuelGauge({ subscribe }: { subscribe: (fn: ((fuel: FuelHud) => void) | null) => void }) {
  useLang();
  const [fuel, setFuel] = useState<FuelHud | null>(null);
  useEffect(() => {
    subscribe(setFuel);
    return () => subscribe(null);
  }, [subscribe]);
  if (!fuel) return null;
  const rpm = Math.max(0, Math.min(1, fuel.rpm));
  const angle = -90 + rpm * 180;
  const redline = rpm > 0.85;
  const rpmRead = Math.round(rpm * 8000);
  const station = fuel.station == null ? null : formatDistance(fuel.station);
  return (
    <div className={`fuel-gauge${redline ? ' is-redline' : ''}${fuel.refuelling ? ' is-refuelling' : ''}`} role="meter" aria-label={t('rpm.label')} aria-valuemin={0} aria-valuemax={8000} aria-valuenow={rpmRead}>
      <svg viewBox="0 0 120 70" width="120" height="70" aria-hidden="true">
        <path d="M14 62 A46 46 0 0 1 106 62" className="fuel-arc" />
        <path d="M98.4 37.2 A46 46 0 0 1 106 62" className="fuel-arc-low" />
        {Array.from({ length: 5 }, (_, i) => {
          const a = Math.PI - (i / 4) * Math.PI;
          const x1 = 60 + Math.cos(a) * 46, y1 = 62 - Math.sin(a) * 46;
          const x2 = 60 + Math.cos(a) * (i % 2 ? 40 : 37), y2 = 62 - Math.sin(a) * (i % 2 ? 40 : 37);
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} className="fuel-tick" />;
        })}
        <text x="10" y="69" className="fuel-label">0</text>
        <text x="100" y="69" className="fuel-label">8</text>
        <g transform={`rotate(${angle.toFixed(1)} 60 62)`} className="fuel-needle">
          <line x1="60" y1="66" x2="60" y2="22" />
        </g>
        <circle cx="60" cy="62" r="4.5" className="fuel-hub" />
      </svg>
      <div className="fuel-readout">
        <strong>{rpmRead}<small> {t('rpm.unit')}</small></strong>
        <span>{fuel.refuelling ? t('fuel.refuelling') : station ? t('fuel.station', { d: station }) : `${Math.ceil(fuel.level)} / ${Math.round(fuel.tank)} ${t('unit.l')}`}</span>
        {fuel.hub && <span className="fuel-hub-line">{fuel.hub.kind === 'airport' ? '✈' : fuel.hub.kind === 'station' ? '🚂' : '⚓'} {formatDistance(fuel.hub.distance)}</span>}
      </div>
    </div>
  );
}
