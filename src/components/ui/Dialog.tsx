'use client';
import type { ReactNode } from 'react';

/**
 * The one dialog of the game: light card on a soft blurred backdrop.
 * Title, a short body, then actions. Every modal uses this.
 */
export default function Dialog({ title, tone = 'default', onBackdrop, children, actions, wide = false, label }: {
  title?: ReactNode;
  tone?: 'default' | 'alert';
  onBackdrop?: () => void;
  children?: ReactNode;
  actions?: ReactNode;
  wide?: boolean;
  label?: string;
}) {
  return (
    <div className="ui-backdrop" role="presentation" onClick={onBackdrop}>
      <section
        className={`ui-dialog${wide ? ' is-wide' : ''}${tone === 'alert' ? ' is-alert' : ''}`}
        role={tone === 'alert' ? 'alertdialog' : 'dialog'}
        aria-label={label ?? (typeof title === 'string' ? title : undefined)}
        onClick={(e) => e.stopPropagation()}
      >
        {title && <h2 className="ui-title">{title}</h2>}
        {children}
        {actions && <div className="ui-actions">{actions}</div>}
      </section>
    </div>
  );
}
