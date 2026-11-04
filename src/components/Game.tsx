'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cars, cities, type City } from '@/config/vehicle.config';
import { findPlaces } from '@/game/findPlaces';
import { healthColor } from '@/game/health';
import { GameEngine, type FuelHud, type HudParticipant, type PlayerCarry, type ServiceOffer, type Settings, type TravelOffer } from '@/game/GameEngine';
import { EVACUATION_COST } from '@/game/Fuel';
import { LANGS, setLang, t, type Lang, type MessageKey } from '@/i18n';
import { useLang } from '@/i18n/react';

/** Localised note of a city: built-in cities have translations, search results keep their own. */
function cityNote(city: City) {
  const key = `note.${city.name}` as MessageKey;
  const text = t(key);
  return text !== key ? text : city.note || t('place.pin');
}
import CarPreview from './CarPreview';
import FuelGauge from './FuelGauge';
import TravelDialog from './TravelDialog';
import ServiceDialog from './ServiceDialog';
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
  const speedRef = useRef<HTMLElement>(null);
  const fpsRef = useRef<HTMLElement>(null);
  const aimRef = useRef<HTMLDivElement>(null);
  const rosterRef = useRef<HTMLDivElement>(null);
  const rosterStoreRef = useRef(new Map<string, RosterNodes>());
  const drivingRef = useRef(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [place, setPlace] = useState<City>(cities[0]);
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
  const [fuelOut, setFuelOut] = useState(false);
  const [travelOffer, setTravelOffer] = useState<TravelOffer | null>(null);
  const [serviceOffer, setServiceOffer] = useState<ServiceOffer | null>(null);
  // a bought ticket: what the player takes to the next city, and drive on arrival
  const carryRef = useRef<PlayerCarry | null>(null);
  const arriveRef = useRef(false);
  const [settings, setSettings] = useState<Settings>({
    terrain: true,
    follow: true,
    sensitivity: 1,
    quality: 'high',
    buildingDetail: 'high',
    architecture: 'auto',
  });

  // Recreate the engine only when the city changes. Car swaps reuse the live map.
  useEffect(() => {
    setStatus(t('loading.city'));
    setApproaching(false);
    setBooted(false);
    setSpawnPin(null);
    let game: GameEngine;
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
      game.onSpawnSet = (pos) => setSpawnPin(pos);
      game.onEventOffer = (kind) => setEventOffer(kind);
      game.onFuel = (fuel) => fuelListener.current?.(fuel);
      game.onFuelOut = (out) => setFuelOut(out);
      engine.current = game;
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
    engine.current?.setPaused((settingsOpen || Boolean(eventOffer) || fuelOut || Boolean(travelOffer) || Boolean(serviceOffer)) && driving);
  }, [settingsOpen, eventOffer, fuelOut, travelOffer, serviceOffer, driving]);
  useEffect(() => {
    drivingRef.current = driving;
    if (!driving) {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
      setStatusToast('');
      setEventOffer(null);
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

  const update = (patch: Partial<Settings>) => setSettings(s => ({ ...s, ...patch }));
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
      <span>{c.name}</span>
      <small>{c.country}</small>
      {chosen(c) && <b>↗</b>}
    </button>
  );

  return (
    <main className={driving ? 'game-shell is-driving' : 'game-shell'}>
      <div ref={host} className="map" />
      <div ref={aimRef} className="aim-reticle" aria-hidden="true"><span /></div>
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
        <div className="header-right">
          <span className="fps" ref={fpsRef} hidden={!perfOn}>— FPS</span>
        </div>
      </header>

      {!driving ? (
        <>
          <section className="intro">
            <div className="trip-card">
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
              <div className="car-pick">
                <CarPreview car={cars[car]} />
                <button type="button" className="car-arrow is-prev" aria-label="←" onClick={() => setCar((car + cars.length - 1) % cars.length)}>‹</button>
                <button type="button" className="car-arrow is-next" aria-label="→" onClick={() => setCar((car + 1) % cars.length)}>›</button>
                <div className="car-pick-name">
                  <strong>{cars[car].name}</strong>
                  <span>{car + 1} / {cars.length}</span>
                </div>
              </div>
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
            <label>{t('settings.detail')}<select value={settings.buildingDetail} onChange={e => update({ buildingDetail: e.target.value as Settings['buildingDetail'] })}><option value="off">{t('level.off')}</option><option value="low">{t('level.low')}</option><option value="medium">{t('level.medium')}</option><option value="high">{t('level.high')}</option></select></label>
            <label className="toggle">{t('settings.follow')}<input type="checkbox" checked={settings.follow} onChange={e => update({ follow: e.target.checked })} /></label>
            <label className="toggle">{t('settings.terrain')}<input type="checkbox" checked={settings.terrain} onChange={e => update({ terrain: e.target.checked })} /></label>
            <label>{t('settings.sensitivity')}<input type="range" min="0.3" max="2" step="0.1" value={settings.sensitivity} onChange={e => update({ sensitivity: Number(e.target.value) })} /></label>
            <label className="toggle">{t('settings.stats')}<input type="checkbox" checked={perfOn} onChange={e => toggleStats(e.target.checked)} /></label>
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

      {travelOffer && driving && !fuelOut && (
        <TravelDialog
          offer={travelOffer}
          current={place}
          onStay={() => engine.current?.declineTravel()}
          onBuy={(city) => {
            const carry = engine.current?.buyTicket(city.coords);
            if (!carry) return;
            carryRef.current = carry;
            arriveRef.current = true;
            setTravelOffer(null);
            setDriving(false);
            setApproaching(false);
            setSearch(city.name);
            setPlace(city);
          }}
        />
      )}

      {eventOffer && !settingsOpen && (
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
    </main>
  );
}
