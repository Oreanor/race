'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cars, cities, type City } from '@/config/vehicle.config';
import { findPlaces } from '@/game/findPlaces';
import { healthColor } from '@/game/health';
import { GameEngine, type FuelHud, type HudParticipant, type PlayerCarry, type Settings, type TravelOffer } from '@/game/GameEngine';
import { EVACUATION_COST } from '@/game/Fuel';
import CarPreview from './CarPreview';
import FuelGauge from './FuelGauge';
import TravelDialog from './TravelDialog';
import Dialog from './ui/Dialog';
import ModeSwitch, { currentMode, DEV_TOOLS } from './ModeSwitch';
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
      meter.setAttribute('aria-label', `${driver.name} здоровье`);
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
    nodes.money.setAttribute('aria-label', `${driver.money} монет`);
    nodes.winsValue.data = String(driver.wins);
    nodes.wins.setAttribute('aria-label', `${driver.wins} побед`);
    root.appendChild(nodes.entry);
  }
}

export default function Game() {
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
  const [status, setStatus] = useState('Загружаем город…');
  const [statusToast, setStatusToast] = useState('');
  const [spawnPin, setSpawnPin] = useState<[number, number] | null>(null);
  // ?perf=1 shows the same profiler as three-world, for side-by-side numbers
  const [perfOn] = useState(() => DEV_TOOLS && new URLSearchParams(window.location.search).has('perf'));
  const [renderMode] = useState(() => currentMode());
  const [perf, setPerf] = useState<PerfSnapshot | null>(null);
  const [bench, setBench] = useState<BenchResult | null>(null);
  const perfGl = useRef<WebGL2RenderingContext | null>(null);
  const fuelListener = useRef<((fuel: FuelHud) => void) | null>(null);
  const subscribeFuel = useCallback((fn: ((fuel: FuelHud) => void) | null) => { fuelListener.current = fn; }, []);
  const [fuelOut, setFuelOut] = useState(false);
  const [travelOffer, setTravelOffer] = useState<TravelOffer | null>(null);
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
    setStatus('Загружаем город…');
    setApproaching(false);
    setBooted(false);
    setSpawnPin(null);
    let game: GameEngine;
    let monitor: PerfMonitor | null = null;
    try {
      game = new GameEngine(
        host.current!,
        place,
        cars[car],
        settings,
        (s, _d, _k, frames, drivers) => {
          const shown = Math.round(Math.abs(s));
          if (speedRef.current) {
            speedRef.current.textContent = String(shown).padStart(2, '0');
          }
          if (fpsRef.current) fpsRef.current.textContent = (frames || '—') + ' FPS';
          if (drivingRef.current && rosterRef.current) syncRoster(rosterRef.current, rosterStoreRef.current, drivers);
        },
        (text) => {
          setStatus(text);
          if (!drivingRef.current || !(/Арена|Гонка|Победа|Поражение|финишировал|Цель ·|Новая миссия/i.test(text))) return;
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
        renderMode === 'maplibre' ? 'maplibre' : 'three',
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
      game.onSpawnSet = (pos) => setSpawnPin(pos);
      game.onEventOffer = (kind) => setEventOffer(kind);
      game.onFuel = (fuel) => fuelListener.current?.(fuel);
      game.onFuelOut = (out) => setFuelOut(out);
      engine.current = game;
      if (perfOn) {
        // getContext returns MapLibre's existing context; the monitor wraps its draw calls
        const canvas = host.current!.querySelector('canvas');
        const gl = canvas?.getContext('webgl2') ?? null;
        if (gl) {
          perfGl.current = gl;
          monitor = new PerfMonitor(gl, setPerf);
        }
      }
    } catch (error) {
      console.error('Failed to initialize the game engine', error);
      setStatus('Не удалось запустить WebGL. Попробуйте другой браузер.');
    }
    return () => { monitor?.dispose(); game?.dispose(); engine.current = null; };
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
    engine.current?.setPaused((settingsOpen || Boolean(eventOffer) || fuelOut || Boolean(travelOffer)) && driving);
  }, [settingsOpen, eventOffer, fuelOut, travelOffer, driving]);
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
      {perfOn && <PerfOverlay mode={renderMode === 'maplibre' ? 'MapLibre' : 'Three.js'} perf={perf} bench={bench} onBench={runBench} />}
      {!booted && (
        <div className="map-loader" aria-live="polite">
          <span className="live-dot" />
          <span>{status || 'Загружаем город…'}</span>
        </div>
      )}
      <header className={driving ? 'game-header is-driving' : 'game-header'}>
        <a className="brand" href="/" aria-label="City Rider">
          <span className="brand-icon">↗</span> city rider
        </a>
        <div className="header-right">
          <ModeSwitch current={renderMode} />
          <span className="fps" ref={fpsRef}>— FPS</span>
        </div>
      </header>

      {!driving ? (
        <>
          <section className="intro">
            <div className="trip-card">
              <div className="field-label">
                <span>01 / МЕСТО НАЗНАЧЕНИЯ</span><span>↗</span>
              </div>
              <div className="city-search">
                <label className="search">
                  <span>⌕</span>
                  <input
                    aria-label="Поиск города"
                    placeholder="Найти свой город"
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
                    {looking && <p className="empty">Ищем на карте…</p>}
                    {!looking && searchFailed && <p className="empty">Поиск недоступен · проверьте сеть</p>}
                    {!looking && !searchFailed && !found.length && <p className="empty">Город не найден</p>}
                  </div>
                )}
              </div>
              <div className="field-label car-label">
                <span>02 / ВАШ АВТОМОБИЛЬ</span>
              </div>
              <div className="cars">
                {cars.map((c, i) => (
                  <button key={c.id} className={'car-card ' + (car === i ? 'selected' : '')} onClick={() => setCar(i)} aria-pressed={car === i}>
                    <span className="car-number">{c.id}</span>
                    <CarPreview car={c} />
                    <span className="car-name">
                      <span className="car-title">{c.name}</span>
                      <span>{car === i ? '●' : '○'}</span>
                    </span>
                  </button>
                ))}
              </div>
              {booted && (
                <div className="spawn-hint">
                  {spawnPin
                    ? <>
                        <span className="spawn-hint-icon">📍</span>
                        <span>Место старта выбрано</span>
                        <button className="spawn-clear" onClick={() => { engine.current?.clearCustomSpawn(); }}>✕ Сбросить</button>
                      </>
                    : <>
                        <span className="spawn-hint-icon">🖱</span>
                        <span>Кликните на карте, чтобы выбрать место старта</span>
                      </>
                  }
                </div>
              )}
              <button
                className="drive"
                disabled={!booted}
                onClick={() => { setApproaching(true); setDriving(true); setSettingsOpen(false); }}
              >
                Поехали
              </button>
            </div>
          </section>
          <aside className="destination">
            <span className="eyebrow">ВАША СЛЕДУЮЩАЯ ОСТАНОВКА</span>
            <h2>{place.name}<span>↗</span></h2>
            <p>{place.note}</p>
            <div className="coordinates">
              {Math.abs(place.coords[1]).toFixed(4)}° {place.coords[1] < 0 ? 'S' : 'N'} &nbsp; {Math.abs(place.coords[0]).toFixed(4)}° {place.coords[0] < 0 ? 'W' : 'E'}
            </div>
          </aside>
          <footer>
            <span>МАЛЕНЬКАЯ МАШИНА. БОЛЬШОЙ МИР.</span>
            <span>Реальные улицы · Ваш маршрут</span>
          </footer>
        </>
      ) : !approaching ? (
        <>
          <div className="roster-hud" ref={rosterRef} aria-label="Участники гонки" />
          <FuelGauge subscribe={subscribeFuel} />
          <div className="speed-hud" aria-label="Скорость">
            <strong ref={speedRef}>00</strong>
            <span>КМ/Ч</span>
          </div>
          {statusToast && <div className="mission-toast" role="status">{statusToast}</div>}
        </>
      ) : null}

      {settingsOpen && (
        <Dialog
          title="Настройки"
          onBackdrop={closeSettings}
          actions={<>
            <button type="button" className="ui-btn" onClick={closeSettings}>{driving ? 'В игру' : 'Вернуться'}</button>
            <button type="button" className="ui-btn is-ghost" onClick={exitToMenu}>Выход</button>
          </>}
        >
          <div className="ui-form">
            <label>Детали зданий<select value={settings.buildingDetail} onChange={e => update({ buildingDetail: e.target.value as Settings['buildingDetail'] })}><option value="off">Выкл</option><option value="low">Низкая</option><option value="medium">Средняя</option><option value="high">Высокая</option></select></label>
            <label className="toggle">Камера следует за машиной<input type="checkbox" checked={settings.follow} onChange={e => update({ follow: e.target.checked })} /></label>
            <label className="toggle">Рельеф местности<input type="checkbox" checked={settings.terrain} onChange={e => update({ terrain: e.target.checked })} /></label>
            <label>Чувствительность камеры<input type="range" min="0.3" max="2" step="0.1" value={settings.sensitivity} onChange={e => update({ sensitivity: Number(e.target.value) })} /></label>
            <label>Качество<select value={settings.quality} onChange={e => update({ quality: e.target.value as Settings['quality'] })}><option value="low">Низкое</option><option value="medium">Среднее</option><option value="high">Высокое</option></select></label>
          </div>
        </Dialog>
      )}

      {fuelOut && driving && (
        <Dialog
          tone="alert"
          title="Топливо закончилось"
          actions={<button type="button" className="ui-btn" autoFocus onClick={() => engine.current?.evacuate()}>Вызвать эвакуатор · {EVACUATION_COST}</button>}
        >
          <p className="ui-text">Машина встала с пустым баком. Эвакуатор доставит вас на ближайшую АЗС за {EVACUATION_COST} монет.</p>
        </Dialog>
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
          title={eventOffer === 'arena' ? 'Арена' : 'Гонка'}
          actions={<>
            <button type="button" className="ui-btn" onClick={() => engine.current?.acceptEvent()}>Играть</button>
            <button type="button" className="ui-btn is-ghost" onClick={() => engine.current?.declineEvent()}>Не сейчас</button>
          </>}
        >
          <p className="ui-text">{eventOffer === 'arena'
            ? 'Три машины в радиусе километра. Победа +10 000, поражение −10 000.'
            : 'Три соперника рядом. Финиш примерно через 5 км. Победа +10 000.'}</p>
        </Dialog>
      )}
    </main>
  );
}
