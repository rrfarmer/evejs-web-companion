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

// FleetColorPickerCont.COLOR_LIST, in client order.
export const WATCHLIST_COLORS = [
  ["Gold", "100% 70% 0%"], ["Orange", "100% 35% 0%"], ["Red", "75% 0% 0%"],
  ["Green", "10% 60% 10%"], ["Teal", "0% 63% 57%"], ["Blue", "20% 50% 100%"],
  ["Dark blue", "0% 15% 60%"], ["Black", "0% 0% 0%"], ["Grey", "70% 70% 70%"],
] as const;

interface WatchlistColorSettings {
  readonly editing: boolean;
  readonly colors: Readonly<Record<number, number>>;
}

export function watchlistColorSettings(characterID: number): WatchlistColorSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(`evejs:watchlist:colors:${characterID}`) ?? "null");
    if (saved && typeof saved === "object") {
      const colors: Record<number, number> = {};
      for (const [key, index] of Object.entries(saved.colors ?? {})) {
        const id = Number(key);
        if (Number.isSafeInteger(id) && id > 0 && typeof index === "number" && Number.isInteger(index) && WATCHLIST_COLORS[index]) {
          colors[id] = index;
        }
      }
      return { editing: saved.editing === true, colors };
    }
  } catch { /* Use the default for absent or unreadable settings. */ }
  return { editing: false, colors: {} };
}

export function saveWatchlistColors(characterID: number, settings: WatchlistColorSettings): void {
  try { localStorage.setItem(`evejs:watchlist:colors:${characterID}`, JSON.stringify(settings)); }
  catch { /* The browser has disabled storage. */ }
}

export function colorWatchlistSelection(colors: Readonly<Record<number, number>>, selected: readonly number[], target: number, color: number | null) {
  const next = { ...colors };
  for (const id of selected.includes(target) ? selected : [target]) {
    if (color === null) delete next[id];
    else next[id] = color;
  }
  return next;
}
