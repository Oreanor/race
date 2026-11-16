import { roadStart } from '../roadStart.ts';
import { type MapFeature } from '../WaterCollisionController.ts';
import { t } from '@/i18n';
import { banksFromFeatures, busStopsFromFeatures, courtsFromFeatures, dealershipsFromFeatures, hospitalsFromFeatures, landmarksFromFeatures, policeFromFeatures, prisonsFromFeatures, repairShopsFromFeatures, stationsFromFeatures, type CivicKind, type Landmark, type Station } from '../poi.ts';
import { metersBetween } from '../meters.ts';
import { defaultMapLabelFilters, type MapLabelFilters, type MapLabelKind } from '../mapLabels.ts';
import { Heist } from '../crime/Heist.ts';
import { makeMapLabel, newMarker, type MapMarker } from '../hud/mapPins.ts';
import { hubsFromFeatures } from '../Travel.ts';
import type { GameEngine } from '../GameEngine.ts';

/** What this part reads and drives in the game. */
export type PlacesGame = Pick<GameEngine, 'collisions' | 'driving' | 'feed' | 'fuelLayer' | 'jobs' | 'map' | 'mapLabelsAt' | 'mapLabelsAtPos' | 'mapLoaded' | 'mapViewOpen' | 'settings' | 'travel' | 'vehicle'>;

/**
 * The places on the map from the real data: fuel stations, car services, dealerships, banks,
 * police, courts, prisons, hospitals, parking and landmarks — gathered as tiles load, with a
 * plaque each where the label filters allow.
 */
export class Places {
  constructor(private game: PlacesGame) {}

  landmarks = new Map<string, Landmark>();

  stations = new Map<string, Station>();

  repairShops = new Map<string, Station>();

  dealerships = new Map<string, Station>();

  /** banks from the POI layer; a robbed one stays shut a while (see Heist) */
  banks = new Map<string, Station>();

  /** parking lots from the POI layer */
  parkingLots = new Map<string, [number, number]>();

  /** Police stations, prisons, courts, hospitals — arrest drop-off points. */
  civics = new Map<string, Station & { kind: CivicKind }>();

  serviceMarkers = new Map<string, MapMarker>();

  /** which POI/hub plaques are drawn (chip bar on the map) */
  mapLabelFilters: MapLabelFilters = defaultMapLabelFilters();

  /** Show / hide map plaques by category (fuel, hotels, airports…). */
  setMapLabelFilters(filters: MapLabelFilters) {
    this.mapLabelFilters = { ...filters };
    this.labelServices();
    this.game.travel.refreshMarkers();
  }

  mapLabelOn(kind: MapLabelKind) {
    return this.mapLabelFilters[kind] !== false;
  }

  /** Real petrol stations from the POI layer; remembered as the player drives on. */
  collectStations(pois = this.game.feed.readSourceLayer('poi')) {
    this.collectHubs(pois);
    for (const feature of pois) {
      const p = feature.properties ?? {};
      if (p.class !== 'parking' && p.subclass !== 'parking') continue;
      const g = feature.geometry as { type: string; coordinates: unknown };
      const at = g.type === 'Point' ? g.coordinates as [number, number] : null;
      if (!at) continue;
      const key = `${at[0].toFixed(4)},${at[1].toFixed(4)}`;
      if (this.parkingLots.has(key) || [...this.parkingLots.values()].some((lot) => metersBetween(lot, at) < 40)) continue;
      this.parkingLots.set(key, [at[0], at[1]]);
    }
    for (const station of stationsFromFeatures(pois)) {
      if (this.stations.has(station.id)) continue;
      if ([...this.stations.values()].some(known => metersBetween(known.place ?? known.position, station.position) < 35)) continue;
      this.stations.set(station.id, this.placeService(station));
    }
    // keep the nearest few hundred; far ones come back when we drive there again
    if (this.stations.size > 300) {
      const keep = [...this.stations.values()].sort((a, b) => metersBetween(a.position, this.game.vehicle.position) - metersBetween(b.position, this.game.vehicle.position)).slice(0, 300);
      this.stations = new Map(keep.map(station => [station.id, station]));
    }
    for (const shop of repairShopsFromFeatures(pois)) {
      if (this.repairShops.has(shop.id)) continue;
      if ([...this.repairShops.values()].some(known => metersBetween(known.place ?? known.position, shop.position) < 35)) continue;
      this.repairShops.set(shop.id, this.placeService(shop));
    }
    for (const bank of banksFromFeatures(pois)) {
      if (this.banks.has(bank.id)) continue;
      if ([...this.banks.values()].some(known => metersBetween(known.place ?? known.position, bank.position) < 35)) continue;
      this.banks.set(bank.id, this.placeService(bank));
    }
    for (const shop of dealershipsFromFeatures(pois)) {
      if (this.dealerships.has(shop.id)) continue;
      if ([...this.dealerships.values()].some(known => metersBetween(known.place ?? known.position, shop.position) < 35)) continue;
      this.dealerships.set(shop.id, this.placeService(shop));
    }
    const addCivic = (kind: CivicKind, list: Station[]) => {
      for (const station of list) {
        if (this.civics.has(station.id)) continue;
        if ([...this.civics.values()].some(known => known.kind === kind && metersBetween(known.place ?? known.position, station.position) < 35)) continue;
        const placed = this.placeService(station);
        this.civics.set(station.id, { ...placed, kind });
      }
    };
    addCivic('police', policeFromFeatures(pois));
    addCivic('prison', prisonsFromFeatures(pois));
    addCivic('court', courtsFromFeatures(pois));
    addCivic('hospital', hospitalsFromFeatures(pois));
    for (const stop of busStopsFromFeatures(pois)) {
      if (this.game.jobs.busStops.has(stop.id)) continue;
      if ([...this.game.jobs.busStops.values()].some(known => metersBetween(known.place ?? known.position, stop.position) < 25)) continue;
      this.game.jobs.busStops.set(stop.id, this.placeService(stop));
    }
    if (this.game.jobs.busStops.size > 400) {
      const keep = [...this.game.jobs.busStops.values()].sort((a, b) => metersBetween(a.position, this.game.vehicle.position) - metersBetween(b.position, this.game.vehicle.position)).slice(0, 400);
      this.game.jobs.busStops = new Map(keep.map(stop => [stop.id, stop]));
    }
    for (const spot of landmarksFromFeatures(pois)) {
      if (this.landmarks.has(spot.id)) continue;
      if ([...this.landmarks.values()].some(known => known.kind === spot.kind && metersBetween(known.place ?? known.position, spot.position) < 40)) continue;
      const placed = this.placeService(spot);
      this.landmarks.set(spot.id, { ...placed, kind: spot.kind, name: spot.name });
    }
    if (this.landmarks.size > 250) {
      const keep = [...this.landmarks.values()].sort((a, b) => metersBetween(a.position, this.game.vehicle.position) - metersBetween(b.position, this.game.vehicle.position)).slice(0, 250);
      this.landmarks = new Map(keep.map(spot => [spot.id, spot]));
    }
  }

  paintFuelStations() {
    const visible = [...this.stations.values()].filter(station => metersBetween(station.position, this.game.vehicle.position) < 2500);
    this.game.fuelLayer?.setStations(visible, this.game.settings.terrain);
  }

  /** Map / world plaques for nearby fuel, service, banks… — on the M map and over houses while driving. */
  labelServices() {
    if (!this.game.driving && !this.game.mapViewOpen()) {
      this.clearMapLabelMarkers();
      return;
    }
    // M map: around the view centre; driving: around the car so you can read the building
    const c = this.game.mapViewOpen() ? this.game.map.getCenter() : null;
    const here: [number, number] = c ? [c.lng, c.lat] : [...this.game.vehicle.position];
    const reach = this.game.mapViewOpen() ? 3000 : 1200;
    const cap = this.game.mapViewOpen() ? 10 : 6;
    type ServiceKind = 'fuel' | 'repair' | 'dealer' | 'bank' | CivicKind | 'hotel' | 'museum';
    const nearest = (list: Station[], limit = cap) => list
      .map(station => ({ station, d: metersBetween(station.position, here) }))
      .filter(item => item.d < reach)
      .sort((a, b) => a.d - b.d)
      .slice(0, limit)
      .map(item => item.station);
    const wanted = new Map<string, { station: Station; kind: ServiceKind; title?: string }>();
    const take = (kind: ServiceKind, list: Station[], limit = 10, title?: (s: Station) => string | undefined) => {
      if (!this.mapLabelOn(kind)) return;
      for (const station of nearest(list, limit)) {
        wanted.set(station.id, { station, kind, title: title?.(station) });
      }
    };
    take('fuel', [...this.stations.values()]);
    take('repair', [...this.repairShops.values()]);
    take('dealer', [...this.dealerships.values()]);
    take('bank', [...this.banks.values()]);
    for (const kind of ['police', 'prison', 'court', 'hospital'] as CivicKind[]) {
      take(kind, [...this.civics.values()].filter((station) => station.kind === kind), 8);
    }
    // type only — no brand / place names (not ads)
    for (const kind of ['hotel', 'museum'] as const) {
      take(kind, [...this.landmarks.values()].filter((spot) => spot.kind === kind), 8);
    }
    for (const [id, marker] of this.serviceMarkers) {
      if (wanted.has(id)) continue;
      marker.remove();
      this.serviceMarkers.delete(id);
    }
    const label: Record<ServiceKind, string> = {
      fuel: t('poi.fuel'), repair: t('poi.service'), dealer: t('poi.dealer'), bank: t('poi.bank'),
      police: t('poi.police'), prison: t('poi.prison'), court: t('poi.court'), hospital: t('poi.hospital'),
      hotel: t('poi.hotel'), museum: t('poi.museum'),
    };
    for (const [id, { station, kind, title }] of wanted) {
      // the houses come in after the roads: find the shop's house when they do
      if (station.top == null || station.radius == null) {
        const house = this.game.map.houseAt(station.place ?? station.position);
        if (house) {
          station.place = house.middle;
          station.top = house.top;
          station.radius = house.radius;
          this.serviceMarkers.get(id)?.setLngLat(house.middle).setAltitude(house.top);
        }
      }
      if (this.serviceMarkers.has(id)) continue;
      const text = title ?? label[kind];
      this.serviceMarkers.set(id, newMarker({ element: makeMapLabel(`travel-hub-marker is-${kind}`, text, text, undefined, false), anchor: 'bottom' }).setLngLat(station.place ?? station.position).setAltitude(station.top ?? null).addTo(this.game.map));
    }
  }

  /**
   * OSM fuel/repair POIs often sit inside the shop building. Snap them to the
   * nearest free road so the canopy and the dialog are reachable from the street.
   */
  placeService(station: Station): Station {
    if (!this.game.mapLoaded) return station;
    const start = roadStart(
      this.game.map,
      station.position,
      (position, heading) => this.game.collisions.blocked(position, position, heading),
      60,
    );
    // the label over the house the shop is in; dialog reach = footprint radius + a few metres
    const house = this.game.map.houseAt(station.position);
    const place = house?.middle ?? station.position;
    return {
      id: station.id,
      position: start ? [...start.position] : station.position,
      place,
      top: house?.top,
      radius: house?.radius,
    };
  }

  /** Rebuild fuel/hub plaques; on the M map at most a few times a second (or after a pan). */
  refreshMapLabels(force = false) {
    const now = performance.now();
    if (this.game.mapViewOpen()) {
      const c = this.game.map.getCenter();
      const here: [number, number] = [c.lng, c.lat];
      const moved = !this.game.mapLabelsAtPos || metersBetween(this.game.mapLabelsAtPos, here) > 150;
      if (!force && !moved && now - this.game.mapLabelsAt < 450) return;
      this.game.mapLabelsAt = now;
      this.game.mapLabelsAtPos = here;
    } else if (!force && now - this.game.mapLabelsAt < 450) {
      return;
    } else {
      this.game.mapLabelsAt = now;
      this.game.mapLabelsAtPos = null;
    }
    this.labelServices();
    this.game.travel.refreshMarkers();
  }

  clearMapLabelMarkers() {
    for (const [id, marker] of this.serviceMarkers) {
      marker.remove();
      this.serviceMarkers.delete(id);
    }
    this.game.travel.clearMarkers();
  }

  /** Ports, airports and railway stations from real data, with a map label each. */
  collectHubs(pois: MapFeature[]) {
    this.game.travel.collect(hubsFromFeatures(this.game.feed.readSourceLayer('aerodrome_label'), pois));
  }
}
