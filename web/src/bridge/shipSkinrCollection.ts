import type { ShipSkinrDesign } from "./shipSkinr.ts";
import type { ShipSkinrSequenceComponent } from "./shipSkinrSequencing.ts";
import { shipSkinrRecord as record } from "./shipSkinrCoatings.ts";
import type { JsonValue } from "./wire.ts";

export const SHIP_COSMETIC_GATEWAY = "eve_public.cosmetic.ship.api.";

export interface ShipSkinrApplication {
  readonly hex: string;
  readonly layout: Record<string, JsonValue>;
}

export interface ShipSkinrAppliedState {
  readonly shipID: number;
  readonly characterID: number;
  readonly skin: ShipSkinrApplication | null;
}

export function decodeShipSkinrAppliedState(payload: JsonValue | null): ShipSkinrAppliedState | null {
  const state = record(record(payload ?? undefined)?.state);
  const shipID = Number(record(state?.ship)?.sequential);
  const characterID = Number(record(state?.character)?.sequential);
  if (!Number.isSafeInteger(shipID) || shipID < 1 || !Number.isSafeInteger(characterID) || characterID < 1) return null;
  const applied = record(record(state?.skin)?.thirdparty);
  const hex = record(applied?.identifier)?.hex;
  const layout = record(applied?.layout);
  return { shipID, characterID, skin: typeof hex === "string" && /^[a-f0-9]{64}$/.test(hex) && layout ? { hex, layout } : null };
}

export interface ShipSkinrOwnedSkin {
  readonly hex: string;
  readonly activated: boolean;
  readonly unactivated: number;
  readonly escrowed: number;
  readonly design: ShipSkinrDesign | null;
}

export interface ShipSkinrOwnedComponent extends ShipSkinrSequenceComponent {
  readonly finite: boolean;
  readonly infinite: boolean;
}
