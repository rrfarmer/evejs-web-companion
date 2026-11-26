import { SvelteMap } from "svelte/reactivity";

const showCentsByCharacter = new SvelteMap<number, boolean>();
const centsKey = (characterID: number) => `evejs.play.${characterID}.walletShowCents`;

export function walletShowsCents(characterID: number | null | undefined): boolean {
  if (characterID == null) return false;
  const current = showCentsByCharacter.get(characterID);
  if (current !== undefined) return current;
  try { return globalThis.localStorage?.getItem(centsKey(characterID)) === "true"; }
  catch { return false; }
}

export function setWalletShowsCents(characterID: number, enabled: boolean): void {
  showCentsByCharacter.set(characterID, enabled);
  try { globalThis.localStorage?.setItem(centsKey(characterID), String(enabled)); }
  catch { /* Keep the live choice if storage is unavailable. */ }
}
