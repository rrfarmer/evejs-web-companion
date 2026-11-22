// The client's Auto Target Back (systemmenu.py ConstructInflightMenuData: the Gameplay panel's Inflight combo,
// settings.user.ui 'autoTargetBack', 0 to 12 targets - _GetAutoTargetBackOptions, ZeroTargets for 0, Targets for the
// rest). targetMgr.OnTargetByOther reads it: a ship that locks this one is locked back while fewer than
// min(setting, the pilot's maxLockedTargets, the ship's) are locked or being locked, and fewer than the setting are
// being auto-targeted.
import { writable } from "svelte/store";

const KEY = "evejs.play.autoTargetBack";
export const AUTO_TARGET_BACK_MAX = 12;
export const AUTO_TARGET_BACK_WORDS: readonly string[] = [
  "UI/SystemMenu/GeneralSettings/Inflight/Header", "UI/SystemMenu/GeneralSettings/Inflight/AutoTargetBack",
  "UI/SystemMenu/GeneralSettings/Inflight/ZeroTargets", "UI/SystemMenu/GeneralSettings/Inflight/Targets",
];

function readSetting(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    return Number.isInteger(v) && v >= 0 && v <= AUTO_TARGET_BACK_MAX ? v : 0;
  } catch { return 0; }
}

export const autoTargetBack = writable<number>(readSetting());
autoTargetBack.subscribe((v) => { try { localStorage.setItem(KEY, String(v)); } catch { /* not kept */ } });
let now = 0;
autoTargetBack.subscribe((v) => { now = v; });
/** The setting as it is now. */
export function autoTargetBackNow(): number { return now; }
