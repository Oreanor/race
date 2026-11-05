'use client';
import { useEffect, useState } from 'react';
import { t } from '@/i18n';
import { defaultServerUrl } from '@/net/NetClient';
import { serverHealth, tunnelAddress } from '@/net/homeServer';

type Status = { state: 'checking' } | { state: 'off' } | { state: 'down' } | { state: 'up'; players: number };

/** The multiplayer server's state: the registered tunnel first, then the relay's own address. */
async function check(): Promise<Status> {
  const ws = defaultServerUrl();
  if (!ws) return { state: 'off' };
  for (const base of [await tunnelAddress(), ws.replace(/^ws/, 'http').replace(/\/mp$/, '')]) {
    const health = base ? await serverHealth(base) : null;
    if (health) return { state: 'up', players: health.players };
  }
  return { state: 'down' };
}

/** "Server: online · 3 players" in the settings, checked when they open and every 10 s. */
export default function ServerStatus() {
  const [status, setStatus] = useState<Status>({ state: 'checking' });
  useEffect(() => {
    let alive = true;
    const run = () => check().then((s) => { if (alive) setStatus(s); });
    run();
    const timer = setInterval(run, 10_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  const text = status.state === 'up' ? t('server.up', { players: status.players })
    : status.state === 'down' ? t('server.down')
      : status.state === 'off' ? t('server.off') : t('server.checking');
  return (
    <div className="server-status">
      <span>{t('server.label')}</span>
      <span className={`server-status-value is-${status.state}`}><i />{text}</span>
    </div>
  );
}
