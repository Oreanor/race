'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cars, cities, type City } from '@/config/vehicle.config';
import { SKINS } from '@/world3d/buildings/skins';
import { NetHud, type NetFeed } from './NetHud';
import ServerStatus from './ServerStatus';
import { findPlaces } from '@/game/findPlaces';
import { healthColor } from '@/game/health';
import { GameEngine, type BountyOffer, type DealerOffer, type EventResult, type FuelHud, type HudParticipant, type PlayerCarry, type ServiceOffer, type Settings, type Theme, type TravelOffer } from '@/game/GameEngine';
import { EVACUATION_COST } from '@/game/Fuel';
import { formatNumber, getLang, LANGS, setLang, t, type Lang, type MessageKey } from '@/i18n';
import { useLang } from '@/i18n/react';

const LOCALES: Record<Lang, string> = { en: 'en-GB', pt: 'pt-PT', ru: 'ru-RU' };
let clockFormat: { key: string; time: Intl.DateTimeFormat; date: Intl.DateTimeFormat } | null = null;

/** "09:15 · Thu, 5 November" at a place, in the game's language. */
function localClock(at: Date, timeZone: string) {
  const locale = LOCALES[getLang()] ?? 'en-GB';
  const key = locale + '|' + timeZone;
  if (clockFormat?.key !== key) {
    clockFormat = {
      key,
      time: new Intl.DateTimeFormat(locale, { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
      date: new Intl.DateTimeFormat(locale, { timeZone, weekday: 'short', day: 'numeric', month: 'long' }),
    };
  }
  return clockFormat.time.format(at) + ' · ' + clockFormat.date.format(at);
}

/** A start place from the address, ?at=lng,lat&heading=deg (for checking a spot quickly). */
function placeFromAddress(): City | null {
  if (typeof location === 'undefined') return null;
  const params = new URLSearchParams(location.search);
  const at = (params.get('at') ?? '').split(',').map(Number);
  if (at.length !== 2 || !at.every(Number.isFinite) || Math.abs(at[0]) > 180 || Math.abs(at[1]) > 85) return null;
  const heading = Number(params.get('heading') ?? 0) || 0;
  const near = cities.reduce((best, c) => Math.hypot(c.coords[0] - at[0], c.coords[1] - at[1]) < Math.hypot(best.coords[0] - at[0], best.coords[1] - at[1]) ? c : best, cities[0]);
  return { ...near, coords: [at[0], at[1]] as [number, number], heading, road: '', note: '' };
}

/** Localised note of a city: built-in cities have translations, search results keep their own. */
function cityNote(city: City) {
  const key = `note.${city.name}` as MessageKey;
  const text = t(key);
  return text !== key ? text : city.note || t('place.pin');
}
import CarCarousel from './CarCarousel';
import FuelGauge from './FuelGauge';
import TravelDialog from './TravelDialog';
import ServiceDialog from './ServiceDialog';
import DealershipDialog from './DealershipDialog';
import Dialog from './ui/Dialog';
import PerfOverlay from './PerfOverlay';
import { PerfMonitor, benchmark, type BenchResult, type PerfSnapshot } from '@/world3d/perf/PerfMonitor';

type RosterNodes = {
  entry: HTMLDivElement;
  name: HTMLElement;
  meter: HTMLElement;
  fill: HTMLElement;
  hp: HTMLElement;
  money: HTMLElement;
  moneyValue: Text;
  wins: HTMLElement;
  winsValue: Text;
};

function syncRoster(root: HTMLElement, store: Map<string, RosterNodes>, drivers: HudParticipant[]) {
  const active = new Set(drivers.map(driver => driver.id));
  for (const [id, nodes] of store) {
    if (active.has(id)) continue;
    nodes.entry.remove();
    store.delete(id);
  }
  for (const driver of drivers) {
    let nodes = store.get(driver.id);
    if (!nodes) {
      const entry = document.createElement('div');
      entry.className = 'roster-entry';
      const heading = document.createElement('div');
      heading.className = 'roster-heading';
      const name = document.createElement('span');
      name.className = 'roster-name';
      name.textContent = driver.name;
      const hpGroup = document.createElement('span');
      hpGroup.className = 'roster-hp-group';
      const meter = document.createElement('span');
      meter.setAttribute('role', 'meter');
      meter.setAttribute('aria-label', t('roster.health', { name: driver.name }));
      meter.setAttribute('aria-valuemin', '0');
      const fill = document.createElement('i');
      meter.appendChild(fill);
      const hp = document.createElement('span');
      hp.className = 'roster-hp';
      hpGroup.append(meter, hp);
      const money = document.createElement('span');
      money.className = 'roster-money';
      const coin = document.createElement('span');
      coin.className = 'money-coin';
      coin.setAttribute('aria-hidden', 'true');
      const moneyValue = document.createTextNode('0');
      money.append(coin, moneyValue);
      const wins = document.createElement('span');
      wins.className = 'roster-wins';
      const cup = document.createElement('span');
      cup.className = 'wins-cup';
      cup.setAttribute('aria-hidden', 'true');
      const winsValue = document.createTextNode('0');
      wins.append(cup, winsValue);
      heading.append(name, hpGroup, money, wins);
      entry.appendChild(heading);
      root.appendChild(entry);
      nodes = { entry, name, meter, fill, hp, money, moneyValue, wins, winsValue };
      store.set(driver.id, nodes);
    }
    const dead = driver.id !== 'player' && driver.hp <= 0;
    nodes.entry.classList.toggle('is-dead', dead);
    nodes.name.style.color = dead ? '#8b9198' : driver.color;
    nodes.meter.className = `roster-health ${dead ? 'dead' : healthColor(driver.hp, driver.maxHp)}`;
    nodes.meter.setAttribute('aria-valuemax', String(driver.maxHp));
    nodes.meter.setAttribute('aria-valuenow', String(Math.ceil(driver.hp)));
    nodes.fill.style.width = `${Math.max(0, Math.min(100, driver.hp / driver.maxHp * 100))}%`;
    nodes.hp.textContent = String(Math.ceil(driver.hp));
    // other players: their money and wins are not ours to show
    nodes.money.style.visibility = Number.isFinite(driver.money) ? '' : 'hidden';
    nodes.wins.style.visibility = Number.isFinite(driver.wins) ? '' : 'hidden';
    nodes.moneyValue.data = String(driver.money);
    nodes.money.setAttribute('aria-label', t('roster.coins', { n: driver.money }));
    nodes.winsValue.data = String(driver.wins);
    nodes.wins.setAttribute('aria-label', t('roster.wins', { n: driver.wins }));
    root.appendChild(nodes.entry);
  }
}

export default function Game() {
  const lang = useLang();
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<GameEngine | null>(null);
  // the name other players see: typed in, or a default one, remembered between visits
  const [playerName, setPlayerName] = useState(() => {
    try { return localStorage.getItem('cityRider.name') ?? ''; } catch { return ''; }
  });
  const [defaultName] = useState(() => {
    // one number per browser, so the default name stays the same between visits
    let n = '';
    try { n = localStorage.getItem('cityRider.nameNumber') ?? ''; } catch { /* private mode */ }
    if (!/^\d{4}$/.test(n)) {
      n = String(1000 + Math.floor(Math.random() * 9000));
      try { localStorage.setItem('cityRider.nameNumber', n); } catch { /* private mode */ }
    }
    return t('net.defaultName', { n });
  });
  const shownName = playerName.trim() || defaultName;
  const nameRef = useRef(shownName);
  nameRef.current = shownName;
  const speedRef = useRef<HTMLElement>(null);
  const fpsRef = useRef<HTMLElement>(null);
  const clockRef = useRef<HTMLElement>(null);
  const compassRef = useRef<HTMLDivElement>(null);
  // compass: the rose turns against the camera so N always points north
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const bearing = engine.current?.map.getBearing();
      if (compassRef.current && bearing != null) compassRef.current.style.transform = `rotate(${-bearing}deg)`;
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, []);
  const aimRef = useRef<HTMLDivElement>(null);
  const rosterRef = useRef<HTMLDivElement>(null);
  const rosterStoreRef = useRef(new Map<string, RosterNodes>());
  const drivingRef = useRef(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ?at=lng,lat&heading=deg (testing): start right there instead of the first city
  const [place, setPlace] = useState<City>(() => placeFromAddress() ?? cities[0]);
  const [car, setCar] = useState(0);
  const [driving, setDriving] = useState(false);
  const [approaching, setApproaching] = useState(false);
  const [booted, setBooted] = useState(false);
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [found, setFound] = useState<City[]>([]);
  const [looking, setLooking] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [eventOffer, setEventOffer] = useState<'arena' | 'race' | null>(null);
  const [eventResult, setEventResult] = useState<EventResult | null>(null);
  const [status, setStatus] = useState(() => t('loading.city'));
  const [statusToast, setStatusToast] = useState('');
  const [spawnPin, setSpawnPin] = useState<[number, number] | null>(null);
  // performance stats: off by default, switched on in the settings (remembered)
  const [perfOn, setPerfOn] = useState(() => {
    try { return localStorage.getItem('cityRider.stats') === '1' || new URLSearchParams(window.location.search).has('perf'); } catch { return false; }
  });
  const toggleStats = (on: boolean) => {
    setPerfOn(on);
    try { localStorage.setItem('cityRider.stats', on ? '1' : '0'); } catch { /* private mode */ }
  };
  const [perf, setPerf] = useState<PerfSnapshot | null>(null);
  const [bench, setBench] = useState<BenchResult | null>(null);
  const perfGl = useRef<WebGL2RenderingContext | null>(null);
  const fuelListener = useRef<((fuel: FuelHud) => void) | null>(null);
  const subscribeFuel = useCallback((fn: ((fuel: FuelHud) => void) | null) => { fuelListener.current = fn; }, []);
  const netFeed = useRef<NetFeed | null>(null);
  const subscribeNet = useCallback((feed: NetFeed | null) => { netFeed.current = feed; }, []);
  const sendChat = useCallback((text: string) => engine.current?.chat(text), []);
  const [fuelOut, setFuelOut] = useState(false);
  const [travelOffer, setTravelOffer] = useState<TravelOffer | null>(null);
  const [serviceOffer, setServiceOffer] = useState<ServiceOffer | null>(null);
  const [dealerOffer, setDealerOffer] = useState<DealerOffer | null>(null);
  const [bountyOffer, setBountyOffer] = useState<BountyOffer | null>(null);
  // a bought ticket: what the player takes to the next city, and drive on arrival
  const carryRef = useRef<PlayerCarry | null>(null);
  const arriveRef = useRef(false);
  const [settings, setSettings] = useState<Settings>(() => {
    // like language: saved choice, else the browser's light/dark preference
    let theme: Theme = 'light';
    try {
      const saved = localStorage.getItem('cityRider.theme');
      if (saved === 'night' || saved === 'light') theme = saved;
      else if (window.matchMedia('(prefers-color-scheme: dark)').matches) theme = 'night';
    } catch { /* private mode */ }
    return {
      terrain: true,
      follow: true,
      sensitivity: 1,
      quality: 'high',
      buildingDetail: 'high',
      architecture: 'auto',
      skin: 'original',
      theme,
    };
  });

  // Recreate the engine only when the city changes. Car swaps reuse the live map.
  useEffect(() => {
    setStatus(t('loading.city'));
    setApproaching(false);
    setBooted(false);
    setSpawnPin(null);
    let game: GameEngine | undefined;
    let clockAt = 0;
    try {
      game = new GameEngine(
        host.current!,
        place,
        cars[car],
        settings,
        (s, _d, frames, drivers) => {
          const shown = Math.round(Math.abs(s));
          if (speedRef.current) {
            speedRef.current.textContent = String(shown).padStart(2, '0');
          }
          if (fpsRef.current) fpsRef.current.textContent = (frames || '—') + ' FPS';
          // local date and time where the car is, a few times a second at most
          const now = performance.now();
          if (clockRef.current && now - clockAt > 500 && game) {
            clockAt = now;
            const { at, timeZone } = game.map.localTime();
            clockRef.current.textContent = localClock(at, timeZone);
          }
          if (drivingRef.current && rosterRef.current) syncRoster(rosterRef.current, rosterStoreRef.current, drivers);
        },
        (text, toast) => {
          setStatus(text);
          // the engine marks event news (missions, wins, tow truck) as toast-worthy
          if (!drivingRef.current || !toast) return;
          setStatusToast(text);
          if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
          toastTimerRef.current = setTimeout(() => {
            setStatusToast('');
            toastTimerRef.current = null;
          }, 6000);
        },
        (x, y, visible, firing) => {
          const aim = aimRef.current;
          if (!aim) return;
          aim.style.left = `${x}px`;
          aim.style.top = `${y}px`;
          aim.style.display = visible ? 'block' : 'none';
          aim.classList.toggle('is-firing', Boolean(firing));
        },
        carryRef.current,
      );
      carryRef.current = null;
      game.onApproach = (active) => setApproaching(active);
      game.onBoot = (ready) => {
        setBooted(ready);
        if (ready && arriveRef.current) {
          arriveRef.current = false;
          setApproaching(true);
          setDriving(true);
        }
      };
      game.onTravelOffer = (offer) => setTravelOffer(offer);
      game.onServiceOffer = (offer) => setServiceOffer(offer);
      game.onDealerOffer = (offer) => setDealerOffer(offer);
      game.onCarBought = (bought) => {
        const index = cars.findIndex((entry) => entry.id === bought.id);
        if (index >= 0) setCar(index);
      };
      game.onBountyOffer = (offer) => setBountyOffer(offer);
      game.onSpawnSet = (pos) => setSpawnPin(pos);
      game.onEventOffer = (kind) => setEventOffer(kind);
      game.onEventResult = (result) => setEventResult(result);
      game.onFuel = (fuel) => fuelListener.current?.(fuel);
      game.onOnline = (players) => netFeed.current?.online(players);
      game.onChat = (line) => netFeed.current?.chat(line);
      game.onNetNotice = (notice) => netFeed.current?.notice(notice);
      game.onFuelOut = (out) => setFuelOut(out);
      engine.current = game;
      game.joinNetwork(nameRef.current);
    } catch (error) {
      console.error('Failed to initialize the game engine', error);
      setStatus(t('webgl.failed'));
    }
    return () => { game?.dispose(); engine.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place]);

  useEffect(() => {
    engine.current?.setCar(cars[car]);
  }, [car]);

  // City search
  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) { setFound([]); setLooking(false); setSearchFailed(false); return; }
    setLooking(true);
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      setSearchFailed(false);
      findPlaces(q, ctrl.signal)
        .then(list => { if (!ctrl.signal.aborted) setFound(list); })
        .catch(err => {
          if (ctrl.signal.aborted || (err instanceof Error && err.name === 'AbortError')) return;
          setFound([]); setSearchFailed(true);
        })
        .finally(() => { if (!ctrl.signal.aborted) setLooking(false); });
    }, 400);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [search]);

  useEffect(() => engine.current?.applySettings(settings), [settings]);
  useEffect(() => engine.current?.setDriving(driving), [driving]);
  useEffect(() => {
    engine.current?.setPaused((settingsOpen || Boolean(eventOffer) || Boolean(eventResult) || Boolean(bountyOffer) || fuelOut || Boolean(travelOffer) || Boolean(serviceOffer)) && driving);
  }, [settingsOpen, eventOffer, eventResult, bountyOffer, fuelOut, travelOffer, serviceOffer, driving]);
  useEffect(() => {
    drivingRef.current = driving;
    if (!driving) {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
      setStatusToast('');
      setEventOffer(null);
      setEventResult(null);
      rosterStoreRef.current.clear();
      if (rosterRef.current) rosterRef.current.replaceChildren();
    }
  }, [driving]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape') {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
          (e.target as HTMLElement).blur();
        }
        e.preventDefault();
        setSettingsOpen(open => !open);
        return;
      }
      if (e.code !== 'KeyW' || e.repeat) return;
      if (drivingRef.current || !booted) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      setApproaching(true);
      setDriving(true);
      setSettingsOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [booted]);
  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);

  // stats panel: wraps the world's GL context only while it is shown
  useEffect(() => {
    if (!perfOn || !booted) return;
    const gl = host.current?.querySelector('canvas')?.getContext('webgl2') ?? null;
    if (!gl) return;
    perfGl.current = gl;
    const monitor = new PerfMonitor(gl, setPerf);
    return () => { monitor.dispose(); perfGl.current = null; setPerf(null); setBench(null); };
  }, [perfOn, booted, place]);

  const runBench = () => {
    const gl = perfGl.current;
    const map = engine.current?.map;
    if (gl && map) setBench(benchmark(gl, () => map.redraw()));
  };
  useEffect(() => {
    if (!perfOn) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'KeyB' && !e.repeat && !(e.target instanceof HTMLInputElement)) runBench();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [perfOn]);

  const update = (patch: Partial<Settings>) => setSettings(s => {
    const next = { ...s, ...patch };
    if (patch.theme) {
      try { localStorage.setItem('cityRider.theme', patch.theme); } catch { /* private mode */ }
    }
    return next;
  });
  const closeSettings = () => setSettingsOpen(false);
  const exitToMenu = () => {
    setSettingsOpen(false);
    setDriving(false);
    setApproaching(false);
  };

  const query = search.trim().toLowerCase();
  const chosen = (c: City) => c.name === place.name && Math.abs(c.coords[0] - place.coords[0]) < 1e-4 && Math.abs(c.coords[1] - place.coords[1]) < 1e-4;
  const option = (c: City) => (
    <button
      key={c.name + '|' + c.coords[0].toFixed(3) + '|' + c.coords[1].toFixed(3)}
      className={'city-option ' + (chosen(c) ? 'selected' : '')}
      onClick={() => {
        setPlace(c);
        setSearch(c.name);
        setSearchOpen(false);
      }}
    >
      <span className="city-option-main">
        <span>{c.name}</span>
        {c.note && <em>{cityNote(c)}</em>}
      </span>
      <small>{c.country}</small>
      {chosen(c) && <b>↗</b>}
    </button>
  );

  return (
    <main className={`game-shell${driving ? ' is-driving' : ''}`} data-theme={settings.theme}>
      <div ref={host} className="map" />
      <div ref={aimRef} className="aim-reticle" aria-hidden="true"><span /></div>
      <div className="compass" role="button" tabIndex={-1} title={t('compass.north')} onDoubleClick={() => engine.current?.faceNorth()}>
        <div className="compass-rose" ref={compassRef}>
          <i className="compass-needle" />
          <b className="compass-n">N</b>
        </div>
      </div>
      {perfOn && <PerfOverlay mode={t('settings.stats')} perf={perf} bench={bench} onBench={runBench} />}
      {!booted && (
        <div className="map-loader" aria-live="polite">
          <span className="live-dot" />
          <span>{status || t('loading.city')}</span>
        </div>
      )}
      <header className={driving ? 'game-header is-driving' : 'game-header'}>
        <a className="brand" href="/" aria-label="City Rider">
          <span className="brand-icon">↗</span> city rider
        </a>
      </header>
      <span className="fps" ref={fpsRef} aria-live="off">— FPS</span>
      <span className="local-clock" ref={clockRef} aria-live="off" />

      {!driving ? (
        <>
          <section className="intro">
            <div className="trip-card">
              <h3 className="ui-section">{t('net.name')}</h3>
              <input
                className="ui-input"
                aria-label={t('net.name')}
                placeholder={defaultName}
                maxLength={24}
                value={playerName}
                onChange={e => {
                  const value = e.target.value;
                  setPlayerName(value);
                  try { localStorage.setItem('cityRider.name', value); } catch { /* private mode */ }
                  engine.current?.joinNetwork(value.trim() || defaultName);
                }}
              />
              <h3 className="ui-section">{t('intro.destination')}</h3>
              <div className="city-search">
                <label className="search">
                  <input
                    className="ui-input"
                    aria-label={t('search.label')}
                    placeholder={t('search.placeholder')}
                    value={search}
                    onFocus={() => setSearchOpen(search.trim().length >= 2)}
                    onChange={e => {
                      const value = e.target.value;
                      setSearch(value);
                      setSearchOpen(value.trim().length >= 2);
                    }}
                  />
                </label>
                {searchOpen && query.length >= 2 && (
                  <div className="city-list">
                    {found.map(option)}
                    {looking && <p className="empty">{t('search.looking')}</p>}
                    {!looking && searchFailed && <p className="empty">{t('search.failed')}</p>}
                    {!looking && !searchFailed && !found.length && <p className="empty">{t('search.none')}</p>}
                  </div>
                )}
              </div>
              <h3 className="ui-section">{t('intro.car')}</h3>
              <CarCarousel index={car} onIndex={setCar} />
              <button
                className="ui-btn drive"
                disabled={!booted}
                onClick={() => { setApproaching(true); setDriving(true); setSettingsOpen(false); }}
              >
                {t('drive')}
              </button>
            </div>
          </section>
          {booted && (
            <div className="map-hint" role="status">
              {spawnPin
                ? <>
                    <span>📍 {t('spawn.chosen')}</span>
                    <button type="button" className="map-hint-action" onClick={() => { engine.current?.clearCustomSpawn(); }}>{t('spawn.reset')}</button>
                  </>
                : <span>{t('spawn.hint')}</span>}
            </div>
          )}
          <aside className="destination">
            <span className="eyebrow">{t('next.stop')}</span>
            <h2>{place.name}<span>↗</span></h2>
            <p>{cityNote(place)}</p>
            <div className="coordinates">
              {Math.abs(place.coords[1]).toFixed(4)}° {place.coords[1] < 0 ? 'S' : 'N'} &nbsp; {Math.abs(place.coords[0]).toFixed(4)}° {place.coords[0] < 0 ? 'W' : 'E'}
            </div>
          </aside>
          <footer>
            <span>{t('tagline')}</span>
            <span>{t('tagline.sub')}</span>
          </footer>
        </>
      ) : !approaching ? (
        <>
          <div className="roster-hud" ref={rosterRef} aria-label={t('hud.racers')} />
          <FuelGauge subscribe={subscribeFuel} />
          <NetHud subscribe={subscribeNet} send={sendChat} />
          <div className="speed-hud" aria-label={t('hud.speed')}>
            <strong ref={speedRef}>00</strong>
            <span>{t('hud.kmh')}</span>
          </div>
          {statusToast && <div className="mission-toast" role="status">{statusToast}</div>}
        </>
      ) : null}

      {settingsOpen && (
        <Dialog
          title={t('settings.title')}
          onBackdrop={closeSettings}
          actions={<>
            <button type="button" className="ui-btn" onClick={closeSettings}>{driving ? t('settings.resume') : t('settings.back')}</button>
            <button type="button" className="ui-btn is-ghost" onClick={exitToMenu}>{t('settings.exit')}</button>
          </>}
        >
          <div className="ui-form">
            <label>{t('settings.language')}<select value={lang} onChange={e => setLang(e.target.value as Lang)}>{LANGS.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
            <div className="ui-theme-row">
              <span>{t('settings.theme')}</span>
              <div className="ui-theme" role="group" aria-label={t('settings.theme')}>
                <button type="button" className={`ui-theme-btn${settings.theme === 'light' ? ' is-on' : ''}`} aria-pressed={settings.theme === 'light'} aria-label={t('theme.light')} onClick={() => update({ theme: 'light' as Theme })}>
                  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="currentColor"/><path d="M12 2v2.5M12 19.5V22M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8 6 18M18 6l1.8-1.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none"/></svg>
                </button>
                <button type="button" className={`ui-theme-btn${settings.theme === 'night' ? ' is-on' : ''}`} aria-pressed={settings.theme === 'night'} aria-label={t('theme.night')} onClick={() => update({ theme: 'night' as Theme })}>
                  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M16.5 3.5a8.5 8.5 0 1 0 4 14.2A7 7 0 1 1 16.5 3.5Z" fill="currentColor"/></svg>
                </button>
              </div>
            </div>
            <label>{t('settings.skin')}<select value={settings.skin} onChange={e => update({ skin: e.target.value as Settings['skin'] })}>{SKINS.map(id => <option key={id} value={id}>{t(`skin.${id}`)}</option>)}</select></label>
            <label className="toggle">{t('settings.follow')}<input type="checkbox" checked={settings.follow} onChange={e => update({ follow: e.target.checked })} /></label>
            <label className="toggle">{t('settings.terrain')}<input type="checkbox" checked={settings.terrain} onChange={e => update({ terrain: e.target.checked })} /></label>
            <label>{t('settings.sensitivity')}<input type="range" min="0.3" max="2" step="0.1" value={settings.sensitivity} onChange={e => update({ sensitivity: Number(e.target.value) })} /></label>
            <label className="toggle">{t('settings.stats')}<input type="checkbox" checked={perfOn} onChange={e => toggleStats(e.target.checked)} /></label>
            <ServerStatus />
            <label>{t('settings.quality')}<select value={settings.quality} onChange={e => update({ quality: e.target.value as Settings['quality'] })}><option value="low">{t('quality.low')}</option><option value="medium">{t('quality.medium')}</option><option value="high">{t('quality.high')}</option></select></label>
          </div>
        </Dialog>
      )}

      {fuelOut && driving && (
        <Dialog
          tone="alert"
          title={t('fuel.out.title')}
          actions={<button type="button" className="ui-btn" autoFocus onClick={() => engine.current?.evacuate()}>{t('fuel.out.button', { cost: EVACUATION_COST })}</button>}
        >
          <p className="ui-text">{t('fuel.out.text', { cost: EVACUATION_COST })}</p>
        </Dialog>
      )}

      {serviceOffer && driving && !fuelOut && (
        <ServiceDialog
          offer={serviceOffer}
          onBuy={() => (serviceOffer.kind === 'fuel' ? engine.current?.buyFuel() : engine.current?.repairCar())}
          onLeave={() => engine.current?.leaveService()}
        />
      )}

      {dealerOffer && driving && !fuelOut && (
        <DealershipDialog
          offer={dealerOffer}
          onBuy={(carId) => engine.current?.buyDealerCar(carId)}
          onLeave={() => engine.current?.leaveDealer()}
        />
      )}

      {travelOffer && driving && !fuelOut && (
        <TravelDialog
          offer={travelOffer}
          current={place}
          onStay={() => engine.current?.declineTravel()}
          onBuy={(city) => {
            const kind = travelOffer.kind;
            const carry = engine.current?.buyTicket(city.coords);
            if (!carry) return;
            carryRef.current = carry;
            arriveRef.current = true;
            setTravelOffer(null);
            setDriving(false);
            setApproaching(false);
            setSearch(city.name);
            // land at the airport (or port) nearest to the chosen place
            fetch(`/api/hub?kind=${kind}&lat=${city.coords[1]}&lng=${city.coords[0]}`, { signal: AbortSignal.timeout(12000) })
              .then((response) => response.json() as Promise<[number, number] | null>)
              .catch(() => null)
              .then((hub) => setPlace(hub ? { ...city, coords: hub } : city));
          }}
        />
      )}

      {bountyOffer && driving && !settingsOpen && (
        <Dialog
          title={<>🎯 {t('bounty.title')}</>}
          actions={<>
            <button type="button" className="ui-btn" autoFocus onClick={() => engine.current?.acceptBounty()}>{t('bounty.take')}</button>
            <button type="button" className="ui-btn is-ghost" onClick={() => engine.current?.declineBounty()}>{t('bounty.later')}</button>
          </>}
        >
          <p className="ui-text">{t('bounty.text', { name: bountyOffer.name, car: bountyOffer.car, place: bountyOffer.place, country: bountyOffer.country, km: formatNumber(bountyOffer.km) })}</p>
          <div className="ui-row ui-wallet"><span>{t('bounty.reward')}</span><strong>{t('travel.coins', { n: formatNumber(bountyOffer.reward) })}</strong></div>
        </Dialog>
      )}

      {eventOffer && !settingsOpen && !eventResult && (
        <Dialog
          title={eventOffer === 'arena' ? t('event.arena') : t('event.race')}
          actions={<>
            <button type="button" className="ui-btn" onClick={() => engine.current?.acceptEvent()}>{t('event.play')}</button>
            <button type="button" className="ui-btn is-ghost" onClick={() => engine.current?.declineEvent()}>{t('event.later')}</button>
          </>}
        >
          <p className="ui-text">{eventOffer === 'arena' ? t('event.arena.text') : t('event.race.text')}</p>
        </Dialog>
      )}

      {eventResult && driving && !settingsOpen && (
        <Dialog
          title={eventResult.kind === 'arena' ? t('event.arena') : t('event.race')}
          tone={eventResult.won ? 'default' : 'alert'}
          onBackdrop={() => setEventResult(null)}
          actions={
            <button type="button" className="ui-btn" autoFocus onClick={() => setEventResult(null)}>{t('event.result.ok')}</button>
          }
        >
          <p className="ui-text">
            {eventResult.kind === 'arena'
              ? (eventResult.won ? t('arena.won') : t('arena.lost'))
              : (eventResult.won ? t('race.won') : t('race.lost', { name: eventResult.name ?? '' }))}
          </p>
        </Dialog>
      )}
    </main>
  );
}
