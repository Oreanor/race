export type HealthColor = 'green' | 'yellow' | 'red';

export function healthColor(hp: number, maxHp: number): HealthColor {
  const fraction = maxHp > 0 ? hp / maxHp : 0;
  if (fraction > 0.66) return 'green';
  if (fraction > 0.33) return 'yellow';
  return 'red';
}
