import { clientTexture } from "../ui/skillGroupIcons.ts";

export interface UiPointerTarget {
  readonly name: string;
  readonly label: string;
  readonly icon: string;
  readonly parent?: string;
}

const stationServiceNames: Readonly<Record<string, string>> = {
  concord: "securityoffice", lpstore: "lpstore", insurance: "insurance",
  factionalwarfare: "navyoffices", Reprocess: "reprocessingPlant", repairshop: "repairshop",
  cloneBay: "medical", charcustomization: "charcustomization",
};

export function stationPointerName(icon: string): string | undefined {
  const name = stationServiceNames[icon];
  return name === undefined ? undefined : `unique_ui_stationSvc_${name}`;
}

export function neocomPointerName(id: string): string {
  const nativeID = id === "jobboard" ? "job_board" : id === "map" ? "map_beta" : id;
  return `neocom.${nativeID}`;
}

export const STATION_POINTERS: readonly UiPointerTarget[] = [
  ["concord", "Security Office"], ["lpstore", "Loyalty Point Store"], ["insurance", "Insurance"],
  ["factionalwarfare", "Militia Office"], ["Reprocess", "Reprocessing Plant"], ["repairshop", "Repair Shop"],
  ["cloneBay", "Clone Bay"], ["charcustomization", "Character Recustomization"],
].map(([icon, label]) => ({ name: stationPointerName(icon!)!, label: label!, icon: clientTexture(`res:/UI/Texture/WindowIcons/${icon}.png`) }));

// The Wallet entries and their parent chain from 3698585 uniqueNameConst and uniqueNameChains.
export const WALLET_POINTERS: readonly UiPointerTarget[] = [
  ["myWallet", "My Wallet"], ["plexWallet", "PLEX"], ["everMarks", "EverMarks"],
  ["walletTransactions", "Transactions"], ["walletMarketTransactions", "Market Transactions"],
].map(([id, label]) => ({
  name: `unique_UI_${id}`, label: `Wallet - ${label}`,
  icon: clientTexture("res:/UI/Texture/WindowIcons/wallet.png"),
  parent: id === "myWallet" ? neocomPointerName("wallet") : "unique_UI_myWallet",
}));

export function visiblePointerTarget(name: string): HTMLElement | null {
  const matches = document.querySelectorAll<HTMLElement>(`[data-ui-pointer="${CSS.escape(name)}"]`);
  for (const target of matches) {
    const rect = target.getBoundingClientRect();
    if (rect.width && rect.height && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth &&
      getComputedStyle(target).visibility === "visible") return target;
  }
  return null;
}
