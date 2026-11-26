import { clientTexture } from "../ui/skillGroupIcons.ts";
import type { IndustryActivity } from "../store/types.ts";

export interface UiPointerTarget {
  readonly name: string;
  readonly label: string;
  readonly icon?: string;
  readonly parent?: string;
  readonly linkLabel?: string;
}

export const UI_POINTER_COMMAND = "CmdGetUiPointer";
export const UI_POINTER_DRAG_TYPE = "application/x-evejs-ui-pointer";

export const INDUSTRY_TAB_POINTERS = {
  blueprints: "unique_UI_industryBlueprintsTab",
  facilities: "unique_UI_industryFacilitiesTab",
  jobs: "unique_UI_industryJobsTab",
  research: "unique_UI_industryResearchTab",
} as const;

export const INDUSTRY_ACTIVITY_POINTERS = {
  manufacturing: "unique_UI_manufacturingBtn",
  copying: "unique_UI_industryCopyBtn",
  research_material: "unique_UI_materialEfficiencyBtn",
  research_time: "unique_UI_timeEfficiencyBtn",
  invention: "unique_UI_inventionBtn",
} as const satisfies Partial<Record<IndustryActivity, string>>;

export const INDUSTRY_LOCATION_POINTERS = {
  input: "unique_UI_industryInputLocation",
  output: "unique_UI_industryOutputLocation",
} as const;

export const MARKET_POINTERS = {
  browseSettings: "unique_UI_marketBrowseSettings",
  details: "unique_UI_marketDetailsTab",
  findInBrowse: "unique_UI_findTypeInBrowser",
  data: "unique_UI_marketDataTab",
  history: "unique_UI_marketPriceHistoryTab",
  duration: "unique_UI_orderDuration",
  sellers: {
    list: "unique_UI_sellersList",
    jumps: "unique_UI_marketSellersJumpsColumn",
    qty: "unique_UI_marketSellersQtyColumn",
    price: "unique_UI_marketSellersPriceColumn",
  },
  buyers: {
    list: "unique_UI_buyersList",
    jumps: "unique_UI_marketBuyersJumpsColumn",
    qty: "unique_UI_marketBuyersQtyColumn",
    price: "unique_UI_marketBuyersPriceColumn",
  },
} as const;

export function dragUiPointer(event: DragEvent, name: string) {
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = "copyMove";
  event.dataTransfer.setData(UI_POINTER_DRAG_TYPE, name);
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
].map(([icon, label]) => ({
  name: stationPointerName(icon!)!, label: label!, icon: clientTexture(`res:/UI/Texture/WindowIcons/${icon}.png`),
  linkLabel: icon === "repairshop" ? "Repairshop" : label,
}));

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
