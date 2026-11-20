import type { CorporationDecorationGraphic } from "./corporationDecorations.ts";

/** Subjects whose content the browser currently implements. */
export type InfoSubject =
  | { readonly kind: "type"; readonly typeID: number; readonly itemID?: number }
  | { readonly kind: "spaceObject"; readonly itemID: number; readonly typeID: number | null }
  | { readonly kind: "ship"; readonly itemID: number; readonly typeID: number }
  | { readonly kind: "module"; readonly itemID: number; readonly typeID: number }
  | { readonly kind: "medal"; readonly typeID: 29496; readonly itemID: number; readonly graphics: readonly CorporationDecorationGraphic[] }
  | { readonly kind: "rank"; readonly factionID: number; readonly rank: number; readonly name: string; readonly description: string }
  | { readonly kind: "character"; readonly characterID: number }
  | { readonly kind: "corporation"; readonly corporationID: number }
  | { readonly kind: "alliance"; readonly allianceID: number }
  | { readonly kind: "mapLocation"; readonly typeID: number; readonly itemID: number }
  | { readonly kind: "faction"; readonly factionID: number };

export interface InfoOpenOptions {
  readonly new?: boolean;
  readonly addNewWindow?: boolean;
  readonly shift?: boolean;
  readonly traversingHistory?: boolean;
  readonly modal?: boolean;
  readonly progressModal?: boolean;
}

export interface InfoIdentity {
  readonly typeID: number;
  readonly itemID: number | null;
  readonly content: "character" | "corporation" | "legacy" | "ship";
}
