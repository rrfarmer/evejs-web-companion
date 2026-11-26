import { SvelteMap } from "svelte/reactivity";

const defaults = {
  notifyAccountChange: false,
  notifyAccountChangeCorp: false,
  notifyShareChange: true,
  notifyShareChangeCorp: true,
  notifyBillChange: true,
  notifyPlexBalanceChange: true,
  walletShowCents: false,
  walletShowBalanceUpdates: true,
  walletShowLpUpdates: true,
  donateCorpLPIssuerPersonal: 0,
  iskNotifyThreshold: 0,
};
type WalletSettings = typeof defaults;
type Setting = keyof WalletSettings;
const walletSettings = new SvelteMap<number, Partial<WalletSettings>>();
const storageKey = (characterID: number, name: Setting) => `evejs.play.${characterID}.${name}`;

export function walletSetting<K extends Setting>(characterID: number | null | undefined, name: K): WalletSettings[K] {
  const fallback = defaults[name];
  if (characterID == null) return fallback;
  const current = walletSettings.get(characterID)?.[name];
  if (current !== undefined) return current;
  try {
    const raw = globalThis.localStorage?.getItem(storageKey(characterID, name));
    if (raw !== null && raw !== undefined) {
      const value: unknown = JSON.parse(raw);
      if (typeof value === typeof fallback && (typeof value !== "number" || (Number.isInteger(value) && value >= 0))) {
        return value as WalletSettings[K];
      }
    }
  } catch { /* Use the default when storage is unavailable or invalid. */ }
  return fallback;
}

export function setWalletSetting<K extends Setting>(characterID: number, name: K, value: WalletSettings[K]): void {
  walletSettings.set(characterID, { ...walletSettings.get(characterID), [name]: value });
  try { globalThis.localStorage?.setItem(storageKey(characterID, name), String(value)); }
  catch { /* Keep the live choice if storage is unavailable. */ }
}

export const walletShowsCents = (characterID: number | null | undefined) => walletSetting(characterID, "walletShowCents");
export const setWalletShowsCents = (characterID: number, enabled: boolean) => setWalletSetting(characterID, "walletShowCents", enabled);
