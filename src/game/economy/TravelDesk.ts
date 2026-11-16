import type { ThreeMap } from '@/world3d/map/ThreeMap';
import { t } from '@/i18n';
import type { VehicleController } from '../VehicleController.ts';
import type { PlayerCarry, TravelOffer } from '../offers.ts';
import { hubAt, ticketPrice, type Hub, type HubKind } from '../Travel.ts';
import { makeMapLabel, newMarker, type MapMarker } from '../hud/mapPins.ts';
import { metersBetween } from '../meters.ts';

/** What the ticket desk needs from the game. */
export interface TravelHost {
  /** the saved run (purse, garage) is in */
  readonly runReady: boolean;
  readonly driving: boolean;
  readonly mode: 'roam' | 'arena' | 'race';
  readonly fuelOut: boolean;
  readonly vehicle: VehicleController;
  readonly keys: Set<string>;
  readonly map: ThreeMap;
  mapViewOpen(): boolean;
  /** this kind of map plaque is switched on */
  labelOn(kind: HubKind): boolean;
  playerMoney: number;
  /** what we take along on a trip: the purse, the tank, the loan, the garage */
  carry(): PlayerCarry;
}

/**
 * Airports, ports and railway stations: their labels on the map, and arriving at one
 * offers a ticket to any city in the world (priced by distance and the way there).
 */
export class TravelDesk {
  readonly hubs = new Map<string, Hub>();
  private markers = new Map<string, MapMarker>();
  /** the hub whose ticket was last offered (leaving its area re-arms the offer) */
  private offeredHub: string | null = null;
  /** the ticket dialog is open */
  open = false;
  /** reaching a hub offers a ticket to any city */
  onOffer: (offer: TravelOffer | null) => void = () => {};

  constructor(private host: TravelHost) {}

  /** Hubs found in a newly loaded area. */
  collect(hubs: Iterable<Hub>) {
    for (const hub of hubs) if (!this.hubs.has(hub.id)) this.hubs.set(hub.id, hub);
    this.refreshMarkers();
  }

  /** Take every label down (the next refresh puts the near ones back). */
  clearMarkers() {
    for (const marker of this.markers.values()) marker.remove();
    this.markers.clear();
  }

  refreshMarkers() {
    if (!this.host.driving && !this.host.mapViewOpen()) {
      for (const [id, marker] of this.markers) {
        marker.remove();
        this.markers.delete(id);
      }
      return;
    }
    const c = this.host.mapViewOpen() ? this.host.map.getCenter() : null;
    const here: [number, number] = c ? [c.lng, c.lat] : [...this.host.vehicle.position];
    const hubReach = this.host.mapViewOpen() ? 14000 : 2500;
    const hubLabel: Record<HubKind, string> = { airport: t('hub.airport'), port: t('hub.port'), station: t('hub.station') };
    const hubColor: Record<HubKind, { main: string; soft: string }> = {
      airport: { main: '#9bb56a', soft: '#d4e878' },
      port: { main: '#2a7f9e', soft: '#6ab8d0' },
      station: { main: '#8a5a2b', soft: '#c49a60' },
    };
    for (const hub of this.hubs.values()) {
      // M map: wide; driving: nearby hubs only so the street stays readable
      const near = metersBetween(hub.position, here) < hubReach;
      const show = near && this.host.labelOn(hub.kind);
      const marker = this.markers.get(hub.id);
      if (show && !marker) {
        const text = hubLabel[hub.kind];
        this.markers.set(hub.id, newMarker({
          element: makeMapLabel(`hub-map-marker is-${hub.kind}`, text, text, hubColor[hub.kind]),
          anchor: 'bottom',
        }).setLngLat(hub.position).addTo(this.host.map));
      } else if (!show && marker) {
        marker.remove();
        this.markers.delete(hub.id);
      }
    }
  }

  /** Arriving at a hub offers a ticket once; leaving its area re-arms the offer. */
  update() {
    if (!this.host.runReady || this.host.mode !== 'roam' || this.open || this.host.fuelOut) return;
    const hub = hubAt(this.host.vehicle.position, [...this.hubs.values()]);
    if (!hub) { this.offeredHub = null; return; }
    if (hub.id === this.offeredHub || Math.abs(this.host.vehicle.speed) > 6) return;
    this.offeredHub = hub.id;
    this.open = true;
    this.host.keys.clear();
    this.host.vehicle.speed = 0;
    // Local hunts stay in-city — no ticket destination for the bounty.
    this.onOffer({ kind: hub.kind, from: [...this.host.vehicle.position], money: Math.floor(this.host.playerMoney) });
  }

  decline() {
    this.open = false;
    this.onOffer(null);
  }

  /** Pay for the trip. Returns what the player carries to the destination, or null when it is too expensive. */
  buyTicket(destination: [number, number]): PlayerCarry | null {
    const hub = this.offeredHub ? this.hubs.get(this.offeredHub) : null;
    if (!hub) return null;
    const price = ticketPrice(this.host.vehicle.position, destination, hub.kind);
    if (this.host.playerMoney < price) return null;
    this.host.playerMoney -= price;
    this.open = false;
    this.onOffer(null);
    return this.host.carry();
  }
}
