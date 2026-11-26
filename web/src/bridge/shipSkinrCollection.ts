import type { ShipSkinrDesign } from "./shipSkinr.ts";
import type { ShipSkinrSequenceComponent } from "./shipSkinrSequencing.ts";

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
