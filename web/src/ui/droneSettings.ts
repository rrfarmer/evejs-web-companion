// droneSettings.py: the pilot's drone settings, kept per character (CharSettingBool 'droneAggression' and
// 'droneFocusFire', their defaults dogma's attribute defaults: droneIsAggressive 1275 is 1, droneFocusFire 1297 is 0,
// read through gridcheck), told to the server on a change and as the drones window opens (godma.ChangeDroneSettings).

import { createSignal } from "../store/signals.ts";

export interface DroneSettings { readonly aggressive: boolean; readonly focusFire: boolean }

const DEFAULTS: DroneSettings = { aggressive: true, focusFire: false };
const key = (characterID: number, name: string) => `evejs.char.${characterID}.${name}`;

function read(characterID: number): DroneSettings {
  const one = (name: string, fallback: boolean): boolean => {
    try {
      const v = globalThis.localStorage?.getItem(key(characterID, name));
      return v === "1" ? true : v === "0" ? false : fallback;
    } catch {
      return fallback;
    }
  };
  return { aggressive: one("droneAggression", DEFAULTS.aggressive), focusFire: one("droneFocusFire", DEFAULTS.focusFire) };
}

/** The settings of the character last asked for, as a signal for the windows to follow. */
export const droneSettings = createSignal<DroneSettings>(DEFAULTS);
let current: number | null = null;

/** The character's settings, loaded into the signal. */
export function droneSettingsFor(characterID: number): DroneSettings {
  if (current !== characterID) {
    current = characterID;
    droneSettings.set(read(characterID));
  }
  return droneSettings.get();
}

/** One setting changed for the character; answers the settings now (for the server). */
export function setDroneSetting(characterID: number, name: "aggressive" | "focusFire", value: boolean): DroneSettings {
  const next = { ...droneSettingsFor(characterID), [name]: value };
  try {
    globalThis.localStorage?.setItem(key(characterID, name === "aggressive" ? "droneAggression" : "droneFocusFire"), value ? "1" : "0");
  } catch {
    // storage refused: the choice lasts the page
  }
  droneSettings.set(next);
  return next;
}

/**
 * dronesWarpWarning.warp_warning_enabled_setting (CharSettingBool 'drone_warp_warning_enabled', True): the drones
 * window's warning on a warp begun with drones out, ticked in the window's menu (GetMenuMoreOptions).
 */
export const droneWarpWarning = createSignal<boolean>(true);
let warpWarningOf: number | null = null;
export function droneWarpWarningFor(characterID: number): boolean {
  if (warpWarningOf !== characterID) {
    warpWarningOf = characterID;
    let on = true;
    try { on = globalThis.localStorage?.getItem(key(characterID, "drone_warp_warning_enabled")) !== "0"; } catch { /* the default */ }
    droneWarpWarning.set(on);
  }
  return droneWarpWarning.get();
}
export function setDroneWarpWarning(characterID: number, on: boolean): void {
  warpWarningOf = characterID;
  try { globalThis.localStorage?.setItem(key(characterID, "drone_warp_warning_enabled"), on ? "1" : "0"); } catch { /* lasts the page */ }
  droneWarpWarning.set(on);
}

/**
 * droneSettings.drones_view_mode_setting (CharSettingEnum 'dronesViewMode', VIEW_MODE_ICONS 1, else VIEW_MODE_LIST 2):
 * the drones window's view (its menu's View Mode radios); in Icons a drone in space shows its type's 32 px icon after
 * its state and its entry is ICONSIZE + 8 high, in List it is ENTRY_HEIGHT 24 with no icon (DroneInSpaceEntry).
 */
export const droneViewIcons = createSignal<boolean>(true);
let viewModeOf: number | null = null;
export function droneViewModeFor(characterID: number): boolean {
  if (viewModeOf !== characterID) {
    viewModeOf = characterID;
    let icons = true;
    try { icons = globalThis.localStorage?.getItem(key(characterID, "dronesViewMode")) !== "2"; } catch { /* the default */ }
    droneViewIcons.set(icons);
  }
  return droneViewIcons.get();
}
export function setDroneViewMode(characterID: number, icons: boolean): void {
  viewModeOf = characterID;
  try { globalThis.localStorage?.setItem(key(characterID, "dronesViewMode"), icons ? "1" : "2"); } catch { /* lasts the page */ }
  droneViewIcons.set(icons);
}
