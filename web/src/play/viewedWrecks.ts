// wrecksvc.py: the wrecks the pilot has looked into (the char UI setting viewedWrecks, itemID -> when), kept 2 h 5 min;
// a wreck's contents read (ItemWreck.GetItems) marks it viewed with ui_sfx_open_wreck_play, the space menu marks it
// either way (Mark Wreck as Viewed / Not Viewed), and the overview draws a viewed one's icon dimmer
// (SpaceObjectIcon.UpdateSpaceObjectIconColor: SetBrightness 0.55).
import { playUiEvent } from "./uiAudio.ts";

const EXPIRE_MS = 1000 * (3600 * 2 + 60 * 5);
let characterID: number | null = null;
let viewed = new Map<number, number>();

const keyOf = (id: number) => `evejs.viewedWrecks.${id}`;

/** LoadViewedWrecks for the pilot at the helm: those still within their 2 h 5 min, the rest let go. */
export function viewedWrecksFor(id: number | null): void {
  if (id === characterID) return;
  characterID = id;
  viewed = new Map();
  if (id === null) return;
  try {
    const kept = JSON.parse(localStorage.getItem(keyOf(id)) ?? "{}") as Record<string, number>;
    const now = Date.now();
    for (const [itemID, at] of Object.entries(kept)) if (now - at < EXPIRE_MS) viewed.set(Number(itemID), at);
  } catch { /* none kept */ }
  persist();
}

function persist(): void {
  if (characterID === null) return;
  try { localStorage.setItem(keyOf(characterID), JSON.stringify(Object.fromEntries(viewed))); } catch { /* lasts the page */ }
}

export function isViewedWreck(itemID: number): boolean {
  return viewed.has(itemID);
}

/** MarkViewed(itemID, isViewed, playSound). */
export function markWreckViewed(itemID: number, isViewed: boolean, playSound = false): void {
  if (viewed.has(itemID) === isViewed) return;
  if (isViewed) viewed.set(itemID, Date.now()); else viewed.delete(itemID);
  persist();
  if (isViewed && playSound) void playUiEvent("ui_sfx_open_wreck_play");
}
