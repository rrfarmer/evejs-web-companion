// The HUD's settings as the client keeps them in settings.user.ui (shipUI.GetHUDOptionMenu, 624 on, and what goes by
// them), kept in this browser under evejs.ui.<name> ("1" or "0"), each a signal the rack and the ship's readout follow.

import { createSignal, type ReadableSignal, type WritableSignal } from "./signals.ts";

/** Each setting's name in settings.user.ui, and its default as the client asks for it (Get(name, default)). */
export const HUD_SETTING_DEFAULTS = Object.freeze({
  /** shipUI 625, slotsContainer._FitSlot 522: modules with no activatable default effect drawn on the rack. */
  showPassiveModules: true,
  /** 628, slotsContainer.CheckButtonVisibility: the empty slots drawn. */
  showEmptySlots: false,
  /** 631, CheckShowReadoutCont: the shield, armor and structure readout shown. */
  showReadout: false,
  /** 634, UpdateReadouts: the readout as percentages (else as hit points left of the whole). */
  readoutType: true,
  /** 641, shipUI.ToggleHudButtons: the HUD's utility buttons shown (HudButtons). */
  hudButtonsExpanded: true,
  /** 644, shipmodulebutton.OnMouseEnter 1088: a module's tooltip shown. */
  showModuleTooltips: true,
  /** 657, shipmodulebutton.ToggleOverload 221 and GetMenu 467: the overload state locked. */
  lockOverload: false,
  /** 650, shipmodulebutton.GetDragData 980 and groupAllIcon.OnClick 29: the rack's modules locked in their places. */
  lockModules: false,
  /** 653, holdTrackerSettings.IsCargoHoldBlinkEnabled: the cargo button blinks as its tracked hold changes. */
  BlinkCargoHudIcon: true,
  /**
   * 657, eve/client/script/util/settings.py IsShipHudTopAligned (SETTING_SHIP_TOP_ALIGNED): the HUD at the top of the
   * view, its action indication under it (shipUI.UpdatePosition, _update_indicator_cont_top).
   */
  shipuialigntop: false,
  /**
   * hud/client/rollout.py new_hud_setting (hudConst.NEW_HUD_PREVIEW_SETTING): the 24.02 new HUD in place of the
   * classic ship UI. The client defaults it off; the operator asked for it as the default (2026-11-20).
   */
  shipHudNew_preview: true,
  /** hudConst.HIDE_EMPTY_SLOTS_SETTING (moduleTray.ShowsEmptySlots): the new HUD's empty slots hidden. */
  shipHudNew_hideEmptySlots: true,
  /** tactical.IsTacticalOverlayActive (settings.user.overview viewTactical, False): the tactical overlay shown. */
  viewTactical: false,
});

export type HudSettingName = keyof typeof HUD_SETTING_DEFAULTS;

const storageKey = (name: HudSettingName): string => `evejs.ui.${name}`;

function kept(name: HudSettingName): boolean {
  try {
    const value = globalThis.localStorage?.getItem(storageKey(name));
    if (value === "1") return true;
    if (value === "0") return false;
  } catch {
    // Storage refused: the default.
  }
  return HUD_SETTING_DEFAULTS[name];
}

const signals = new Map<HudSettingName, WritableSignal<boolean>>();

function signalOf(name: HudSettingName): WritableSignal<boolean> {
  let signal = signals.get(name);
  if (!signal) {
    signal = createSignal(kept(name));
    signals.set(name, signal);
  }
  return signal;
}

/** The setting as a signal, for a view to follow. */
export function hudSetting(name: HudSettingName): ReadableSignal<boolean> {
  return signalOf(name);
}

/** The setting now. */
export function hudSettingNow(name: HudSettingName): boolean {
  return signalOf(name).get();
}

/**
 * shipHud.GetSlotOrder (8 to 22): the HUD's 24 places in order, the high slots' flags 0 to 7, the medium's, the low's;
 * a place r * 8 + i is row r, column i (slotsContainer.InitDrawSlots).
 */
export const DEFAULT_SLOT_ORDER: readonly number[] = Object.freeze([
  27, 28, 29, 30, 31, 32, 33, 34,
  19, 20, 21, 22, 23, 24, 25, 26,
  11, 12, 13, 14, 15, 16, 17, 18,
]);

const SLOT_ORDER_KEY = "evejs.ui.slotOrder";

/** settings.user.ui slotOrder: each ship's order of the places, where its pilot changed it (slotsContainer.SwapSlots). */
const slotOrders = createSignal<Readonly<Record<string, readonly number[]>>>((() => {
  try {
    const kept = JSON.parse(globalThis.localStorage?.getItem(SLOT_ORDER_KEY) ?? "{}") as unknown;
    if (!kept || typeof kept !== "object" || Array.isArray(kept)) return {};
    const orders: Record<string, readonly number[]> = {};
    for (const [shipID, order] of Object.entries(kept)) {
      if (Array.isArray(order) && order.length === DEFAULT_SLOT_ORDER.length && order.every((flag) => DEFAULT_SLOT_ORDER.includes(flag))) orders[shipID] = order;
    }
    return orders;
  } catch {
    return {};
  }
})());

/** Every ship's order kept, for a view to follow. */
export const slotOrdersSignal: ReadableSignal<Readonly<Record<string, readonly number[]>>> = slotOrders;

/** GetSlotOrder: the ship's order where one is kept, else the default. */
export function slotOrderOf(shipID: number | null): readonly number[] {
  return (shipID !== null ? slotOrders.get()[String(shipID)] : undefined) ?? DEFAULT_SLOT_ORDER;
}

/** SwapSlots (104 to 106): the ship's order kept as it is now. */
export function setSlotOrder(shipID: number, order: readonly number[]): void {
  slotOrders.set({ ...slotOrders.get(), [String(shipID)]: [...order] });
  try {
    globalThis.localStorage?.setItem(SLOT_ORDER_KEY, JSON.stringify(slotOrders.get()));
  } catch {
    // Storage refused: the order lasts the page.
  }
}

/** settings.user.ui.Set(name, value): the setting kept, and every view told. */
export function setHudSetting(name: HudSettingName, value: boolean): void {
  signalOf(name).set(value);
  try {
    globalThis.localStorage?.setItem(storageKey(name), value ? "1" : "0");
  } catch {
    // Storage refused: the choice lasts the page.
  }
}
