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

export const INVENTORY_POINTERS = {
  stackAll: "unique_UI_inventoryStackAll",
  viewMode: "unique_UI_inventoryListView",
} as const;

export const CONTRACT_POINTERS = {
  search: "unique_UI_availableContractsTab",
  options: "unique_UI_showHideContractOptions",
  availability: "unique_UI_contractAvailabilitySetting",
} as const;

export const CHAT_POINTERS = {
  local: "unique_UI_localChat",
  corp: "unique_UI_corpChannelWnd",
  corpSettings: "unique_UI_corpChatSettings",
  corpMotd: "unique_UI_corpChatReloadMotd",
  fleet: "unique_UI_fleetChat",
  fleetSettings: "unique_UI_fleetChatSettings",
  fleetMotd: "unique_UI_fleetChatReloadMotd",
  channels: "unique_UI_channelWindow",
  create: "unique_UI_createChatChannelBtn",
} as const;

export const CORPORATION_POINTERS = {
  corporation: "unique_UI_corpCorporationTab",
  admin: "unique_UI_corpAdminTab",
  alliance: "unique_UI_corpAlliancesTab",
  home: "unique_UI_corpHome",
  applications: "unique_UI_myApplications",
  bulletins: "unique_UI_corpBulletin",
  projects: "unique_UI_corpProjects",
  recruitSearch: "unique_UI_findNewCorp",
  freelance: "unique_UI_freelanceProjects",
  assets: "unique_UI_corpAssetsTab",
  recruitAds: "unique_UI_corpAds",
  brand: "unique_UI_brandMgmt",
} as const;

export const CHARACTER_SHEET_POINTERS = {
  expand: "unique_UI_expandCharacterSheet",
  character: "unique_UI_charactersheetCharacterTab",
  interactions: "unique_UI_charactersheetInteractionTab",
  pilotServices: "unique_UI_pilotServicesTab",
  personalization: "unique_UI_charactersheetPersonalizationTab",
  skins: "unique_UI_charactersheetSkinsTab",
  emblems: "unique_UI_charactersheetEmblemsTab",
  home: "unique_UI_homeTab",
  implants: "unique_UI_augmentationsTab",
  jumpClones: "unique_UI_jumpClonesTab",
  expert: "unique_UI_expertSystemsTab",
  decorations: "unique_UI_decorationsTab",
  titles: "unique_UI_titlesTab",
  standings: "unique_UI_standingsTabInCharactersheet",
  killRights: "unique_UI_killRightsTab",
  securityStatus: "unique_UI_securityStatusTab",
  combatLog: "unique_UI_combatLogTab",
  combatFilter: "unique_UI_showKillsLosses",
} as const;

export const FITTING_POINTERS = {
  equipment: "unique_UI_fittingEquipment",
  personalization: "unique_UI_fittingPersonalization",
  skins: "unique_UI_fittingSkins",
  simulate: "unique_UI_simulateShip",
  stats: "unique_UI_fittingStats",
  capacitor: "unique_UI_fittingCap",
  offense: "unique_UI_fittingOffense",
  defense: "unique_UI_fittingDefense",
  targeting: "unique_UI_fittingTargeting",
  navigation: "unique_UI_fittingNavigation",
  drones: "unique_UI_fittingDrones",
  fighters: "unique_UI_fittingFighters",
} as const;

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
