import type { ArchitectureSetting, BuildingDetail } from './buildings/BuildingStyles';
import type { DeliveryItem } from './Errands';
import type { HubKind } from './Travel';
import type { SkinId } from '@/world3d/buildings/skins';

/** Fuel gauge + purse + nearest travel hub, pushed to the HUD. */
export type FuelHud = {
  level: number;
  tank: number;
  rpm: number;
  refuelling: boolean;
  station: number | null;
  money: number;
  hub: { kind: HubKind; distance: number } | null;
};

/** What a player takes along to another city (ticket) or restores on page reload. */
export type PlayerCarry = {
  money: number;
  fuel: number;
  /** page reload: keep the car where it was */
  at?: { position: [number, number]; heading: number; hp: number };
  /** road coins already collected (reload only) */
  collected?: string[];
  /** what we owe the bank (one network, one loan at a time) */
  loan?: number;
  /** ids of every car we own (the garage); C swaps between them on the road */
  garage?: string[];
};

/** At a bank, peacefully: borrow (when nothing is owed) or pay back. */
export type BankOffer = { money: number; debt: number; limit: number; rate: number };

export type TravelOffer = {
  kind: HubKind;
  from: [number, number];
  money: number;
  target?: { name: string; country: string; coords: [number, number] };
};

/** A wanted driver somewhere in the world, offered as a job. */
export type BountyOffer = {
  name: string;
  car: string;
  place: string;
  country: string;
  km: number;
  reward: number;
};

/** Taxi passenger or bus group at the door — confirm before the fare starts. */
export type RideOffer = {
  kind: 'taxi' | 'bus';
  /** bus: group size; taxi: 1 */
  n: number;
  /** bus: hotel/museum type label; taxi: unused */
  place: string;
  km: number;
  reward: number;
};

/** Arena/race finished — UI shows a result dialog. */
export type MissionKind = 'arena' | 'race' | 'delivery' | 'collect';

export type EventResult = {
  kind: MissionKind | 'heist' | 'hijack' | 'fire' | 'impound' | 'taxi' | 'bus' | 'bounty';
  won: boolean;
  name?: string;
  cash?: number;
};

/** What the marker's dialog offers; a delivery says what, how far and for how much. */
export type EventOffer = {
  kind: MissionKind;
  item?: DeliveryItem;
  km?: number;
  reward?: number;
  boxes?: number;
};

/** Arrived at a fuel station or a car service: what the dialog needs to show. */
export type ServiceOffer =
  | { kind: 'fuel'; level: number; tank: number; money: number; price: number }
  | { kind: 'repair'; hp: number; maxHp: number; money: number; price: number };

/** the showroom: our coins, the car we sit in and every car already in our garage */
export type DealerOffer = { money: number; currentId: string; owned: string[] };

export type Quality = 'low' | 'medium' | 'high';

/** Interface look only — not the sun in the world. */
export type Theme = 'light' | 'night';

export type Settings = {
  terrain: boolean;
  follow: boolean;
  /** Major street names drawn along the road (L). */
  streetNames: boolean;
  sensitivity: number;
  quality: Quality;
  buildingDetail: BuildingDetail;
  architecture: ArchitectureSetting;
  /** architecture skin painted over any city (buildings/skins) */
  skin: SkinId;
  theme: Theme;
};

export type HudParticipant = {
  id: string;
  name: string;
  color: string;
  hp: number;
  maxHp: number;
  money: number;
  wins: number;
};
