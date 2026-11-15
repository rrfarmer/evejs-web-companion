export const WATCHLIST_AUTO_OPEN = "UI/Fleet/FleetWindow/AutoOpenWatchlist";
const storageKey = (characterID: number) => `evejs:watchlist:auto-open:${characterID}`;

export function autoOpenWatchlist(characterID: number): boolean {
  try { return localStorage.getItem(storageKey(characterID)) !== "false"; }
  catch { return true; }
}

export function setAutoOpenWatchlist(characterID: number, enabled: boolean): void {
  try { localStorage.setItem(storageKey(characterID), String(enabled)); }
  catch { /* The browser has disabled storage. */ }
}
