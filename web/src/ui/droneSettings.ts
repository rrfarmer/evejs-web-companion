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
