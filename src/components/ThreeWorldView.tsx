'use client';
import { useEffect, useRef, useState } from 'react';
import { cars, cities, type City } from '@/config/vehicle.config';
import { ThreeWorld, defaultThreeWorldSettings, type ThreeWorldHud, type ThreeWorldSettings } from '@/world3d/ThreeWorld';
import type { BenchResult } from '@/world3d/perf/PerfMonitor';
import PerfOverlay from './PerfOverlay';
import ModeSwitch from './ModeSwitch';

function cityFromUrl(): City {
  const name = new URLSearchParams(window.location.search).get('city')?.toLowerCase();
  return cities.find((c) => c.name.toLowerCase() === name) ?? cities[0];
}

export default function ThreeWorldView() {
  const host = useRef<HTMLDivElement>(null);
  const world = useRef<ThreeWorld | null>(null);
  const [city, setCity] = useState<City>(cityFromUrl);
  const [car, setCar] = useState(0);
  const [settings, setSettings] = useState<ThreeWorldSettings>(defaultThreeWorldSettings);
  const [hud, setHud] = useState<ThreeWorldHud | null>(null);
  const [bench, setBench] = useState<BenchResult | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setHud(null);
    setBench(null);
    let instance: ThreeWorld | null = null;
    try {
      instance = new ThreeWorld(host.current!, city, cars[car], settings, setHud);
      world.current = instance;
    } catch (e) {
      console.error(e);
      setError('Не удалось запустить WebGL');
    }
    return () => { instance?.dispose(); world.current = null; };
    // the world is rebuilt per city; car and settings are applied live
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [city, settings.antialias]);

  useEffect(() => { world.current?.setCar(cars[car]); }, [car]);
  useEffect(() => { world.current?.applySettings(settings); }, [settings]);

  const runBench = () => {
    const result = world.current?.runBenchmark();
    if (result) setBench(result);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'KeyB' && !e.repeat && !(e.target instanceof HTMLSelectElement)) runBench();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const t = hud?.tiles;
  const update = (patch: Partial<ThreeWorldSettings>) => setSettings((s) => ({ ...s, ...patch }));

  return (
    <main className="game-shell three-world">
      <div ref={host} className="map" />
      <header className="game-header is-driving">
        <a className="brand" href="/" aria-label="City Rider"><span className="brand-icon">↗</span> city rider</a>
        <div className="header-right"><ModeSwitch current="three-world" /></div>
      </header>

      <section className="tw-panel" aria-label="Параметры three-world">
        <label>Город
          <select value={city.name} onChange={(e) => setCity(cities.find((c) => c.name === e.target.value) ?? cities[0])}>
            {cities.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          </select>
        </label>
        <label>Машина
          <select value={car} onChange={(e) => setCar(Number(e.target.value))}>
            {cars.map((c, i) => <option key={c.id} value={i}>{c.name}</option>)}
          </select>
        </label>
        <label>Окна
          <select value={settings.windowMode} onChange={(e) => update({ windowMode: e.target.value as ThreeWorldSettings['windowMode'] })}>
            <option value="texture">Текстура (1 вызов на чанк)</option>
            <option value="hybrid">Instancing вблизи + текстура</option>
            <option value="instanced">Instancing везде</option>
            <option value="none">Без окон</option>
          </select>
        </label>
        <label>Разрешение
          <select value={settings.pixelRatio} onChange={(e) => update({ pixelRatio: Number(e.target.value) })}>
            <option value={1}>1×</option>
            <option value={1.5}>до 1.5×</option>
            <option value={2}>до 2×</option>
          </select>
        </label>
        <label>Дальность
          <select value={settings.drawDistance} onChange={(e) => update({ drawDistance: Number(e.target.value) })}>
            <option value={900}>900 м</option>
            <option value={1300}>1300 м</option>
            <option value={1700}>1700 м</option>
          </select>
        </label>
        <label className="toggle">Сглаживание (MSAA)
          <input type="checkbox" checked={settings.antialias} onChange={(e) => update({ antialias: e.target.checked })} />
        </label>
      </section>

      <PerfOverlay
        mode="three-world"
        perf={hud?.perf ?? null}
        bench={bench}
        onBench={runBench}
        extra={t ? [
          ['Тайлы', `${t.tilesLoaded} · загрузка ${t.tilesInFlight}${t.tilesQueued ? ` · очередь ${t.tilesQueued}` : ''}`],
          ['Чанки', `${t.chunksVisible} / ${t.chunksLive}`],
          ['Здания', t.buildings.toLocaleString('ru')],
          ['В памяти', `${(t.residentTriangles / 1e6).toFixed(2)} M тр · ${t.residentMB.toFixed(0)} МБ`],
          ['Тайл: сеть/сборка', `${t.avgFetchMs.toFixed(0)} / ${t.avgBuildMs.toFixed(0)} мс${t.threaded ? '' : ' (main)'}`],
          ...(t.failures ? [['Ошибки', String(t.failures)] as [string, string]] : []),
        ] : undefined}
      />

      <div className="speed-hud" aria-label="Скорость">
        <strong>{String(Math.round(hud?.speedKmh ?? 0)).padStart(2, '0')}</strong>
        <span>КМ/Ч</span>
      </div>
      <div className="tw-status" aria-live="polite">{error || hud?.status || 'Загружаем тайлы…'}</div>
    </main>
  );
}
