'use client';
import { useEffect, useRef, useState } from 'react';
import { cars, cities, type City } from '@/config/vehicle.config';
import { findPlaces } from '@/game/findPlaces';
import { GameEngine, type Settings } from '@/game/GameEngine';
import CarPreview from './CarPreview';

export default function Game() {
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<GameEngine | null>(null);
  const gearRef = useRef<HTMLElement>(null);
  const speedRef = useRef<HTMLElement>(null);
  const barRef = useRef<HTMLElement>(null);
  const distRef = useRef<HTMLElement>(null);
  const fpsRef = useRef<HTMLElement>(null);

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
  const [status, setStatus] = useState('Загружаем город…');
  const [spawnPin, setSpawnPin] = useState<[number, number] | null>(null);
  const [settings, setSettings] = useState<Settings>({
    terrain: true,
    follow: true,
    sensitivity: 1,
    quality: 'high',
    buildingDetail: 'high',
    architecture: 'auto',
  });

  // Create / recreate the engine when city or car changes
  useEffect(() => {
    setStatus('Загружаем город…');
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
        (s, d, k, frames) => {
          const shown = Math.round(Math.abs(s));
          if (gearRef.current) gearRef.current.textContent = s < 0 ? 'R / ЗАДНИЙ ХОД' : 'D / ВПЕРЁД';
          if (speedRef.current) {
            speedRef.current.textContent = String(shown).padStart(2, '0');
            speedRef.current.style.fontSize = shown >= 100 ? '58px' : '';
            speedRef.current.style.letterSpacing = shown >= 100 ? '-3px' : '';
          }
          if (barRef.current) barRef.current.style.width = Math.min(100, Math.abs(s) / (cars[car].maxSpeed * 3.6 * k) * 100) + '%';
          if (distRef.current) distRef.current.textContent = (d / 1000).toFixed(2) + ' км исследовано';
          if (fpsRef.current) fpsRef.current.textContent = (frames || '—') + ' FPS';
        },
        setStatus,
      );
      game.onApproach = (active) => setApproaching(active);
      game.onBoot = (ready) => setBooted(ready);
      game.onSpawnSet = (pos) => setSpawnPin(pos);
      engine.current = game;
    } catch (error) {
      console.error('Failed to initialize the game engine', error);
      setStatus('Не удалось запустить WebGL. Попробуйте другой браузер.');
    }
    return () => { game?.dispose(); engine.current = null; };
    // settings updates do not recreate the map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place, car]);

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

  const update = (patch: Partial<Settings>) => setSettings(s => ({ ...s, ...patch }));

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

  const handleReturnToStart = () => {
    const g = engine.current;
    if (!g) return;
    g.setDriving(false);
    const pos = g.getSpawnPosition();
    const hdg = g.getSpawnHeading();
    g.vehicle.position = [...pos];
    g.vehicle.heading = hdg;
    g.bearing = hdg * 180 / Math.PI;
    g.spawnResolved = true;
    g.collisionDirty = true;
    g.collisionTime = 0;
    g.resetCamera();
    g.setDriving(true, false);
  };

  return (
    <main>
      <div ref={host} className="map" />
      {!booted && (
        <div className="map-loader" aria-live="polite">
          <span className="live-dot" />
          <span>{status || 'Загружаем город…'}</span>
        </div>
      )}
      <header>
        <a className="brand" href="/" aria-label="City Rider">
          <span className="brand-icon">↗</span> city rider
          <span className="beta">PLAYGROUND / 01</span>
        </a>
        <div className="header-right">
          <span className="fps" ref={fpsRef}>— FPS</span>
          <button className="icon-button" onClick={() => setSettingsOpen(!settingsOpen)} aria-label="Настройки">⚙</button>
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
                Поехали <span>Drive ↗</span>
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
          <div className="location-panel">
            <span className="eyebrow">СВОБОДНАЯ ПОЕЗДКА</span>
            <h2>{place.name}</h2>
            <p>{place.country} · {cars[car].name}</p>
            <button onClick={() => { setDriving(false); setSettingsOpen(false); }}>← Город и машина</button>
            <button onClick={handleReturnToStart}>Вернуться на старт</button>
          </div>
          <div className="speedometer">
            <span className="eyebrow" ref={gearRef}>D / ВПЕРЁД</span>
            <strong ref={speedRef}>00</strong>
            <span>КМ/Ч</span>
            <div className="speed-bar"><i ref={barRef} style={{ width: '0%' }} /></div>
            <small ref={distRef}>0.00 км исследовано</small>
          </div>
          {status && status !== 'В пути' && (
            <div className="game-status"><span className="live-dot" />{status}</div>
          )}
        </>
      ) : null}

      {settingsOpen && (
        <section className="settings">
          <div className="field-label">НАСТРОЙКИ<button onClick={() => setSettingsOpen(false)} aria-label="Закрыть настройки">✕</button></div>
          <label>Детали зданий<select value={settings.buildingDetail} onChange={e => update({ buildingDetail: e.target.value as Settings['buildingDetail'] })}><option value="off">Выкл</option><option value="low">Низкая</option><option value="medium">Средняя</option><option value="high">Высокая</option></select></label>
          <label>Архитектура<select value={settings.architecture} onChange={e => update({ architecture: e.target.value as Settings['architecture'] })}><option value="auto">Авто</option><option value="european">Европейский</option><option value="portuguese">Португальский</option><option value="modern">Современный</option><option value="brick">Кирпич</option><option value="mixed">Смешанный</option></select></label>
          <label className="toggle">Камера следует за машиной<input type="checkbox" checked={settings.follow} onChange={e => update({ follow: e.target.checked })} /></label>
          <label className="toggle">Рельеф местности<input type="checkbox" checked={settings.terrain} onChange={e => update({ terrain: e.target.checked })} /></label>
          <label>Чувствительность камеры<input type="range" min="0.3" max="2" step="0.1" value={settings.sensitivity} onChange={e => update({ sensitivity: Number(e.target.value) })} /></label>
          <label>Качество<select value={settings.quality} onChange={e => update({ quality: e.target.value as Settings['quality'] })}><option value="low">Низкое</option><option value="medium">Среднее</option><option value="high">Высокое</option></select></label>
          <p>Столкновения со зданиями включены.<br />Для карты требуется интернет.</p>
        </section>
      )}
    </main>
  );
}
