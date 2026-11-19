import type { CorporationMiningLedgerEntry, MiningLedgerEntry } from "../bridge/miningLedger.ts";

export type LedgerRowMenu = {
  readonly anchor: HTMLElement;
  readonly x: number;
  readonly y: number;
} & ({ readonly kind: "personal"; readonly row: MiningLedgerEntry }
  | { readonly kind: "corporation"; readonly row: CorporationMiningLedgerEntry });

export function ledgerRowMenuPosition(event: MouseEvent | KeyboardEvent, anchor: HTMLElement) {
  event.preventDefault();
  event.stopPropagation();
  const rect = anchor.getBoundingClientRect();
  const pointer = "clientX" in event && event.type === "contextmenu" && (event.clientX !== 0 || event.clientY !== 0);
  return { anchor, x: pointer ? event.clientX : rect.left, y: pointer ? event.clientY : rect.bottom };
}
