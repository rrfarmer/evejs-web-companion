import { formatTemplate, plainText } from "../bridge/clientWords.ts";
import { helpPointerLinksFromDrop, helpPointerUrl, parseHelpPointerUrl } from "../bridge/helpPointerLink.ts";
import { LINK_DRAG_TYPE } from "../bridge/skillPlanLink.ts";
import { clientTexture } from "../ui/skillGroupIcons.ts";
import { EVE_MENU, NEOCOM_DEFAULT } from "./neocom.ts";
import { CHARACTER_SHEET_POINTERS, CHAT_POINTERS, CONTRACT_POINTERS, CORPORATION_POINTERS, FITTING_POINTERS, FLEET_POINTERS, INDUSTRY_ACTIVITY_POINTERS, INDUSTRY_LOCATION_POINTERS, INDUSTRY_TAB_POINTERS, INVENTORY_POINTERS, LOBBY_POINTERS, MARKET_POINTERS, neocomPointerName, STATION_POINTERS, visiblePointerTarget, WALLET_POINTERS, type UiPointerTarget } from "./uiPointer.ts";

const industryParent = neocomPointerName("industry");
const contractsParent = neocomPointerName("contracts");
const corporationParent = neocomPointerName("corporation");
const fleetParent = neocomPointerName("fleet");
const characterSheetParent = neocomPointerName("charactersheet");
const menuOnlyPointers = new Set([industryParent, contractsParent, corporationParent, fleetParent]);
const extraNeocomPointers = new Set([...menuOnlyPointers, characterSheetParent]);
const extraNeocomEntries = EVE_MENU.flatMap(group => group.items)
  .flatMap(({ id, label, icon }) => id !== null && extraNeocomPointers.has(neocomPointerName(id)) ? [{ id, label, icon }] : []);
export const NEOCOM_POINTERS: readonly UiPointerTarget[] = [...NEOCOM_DEFAULT, ...extraNeocomEntries].map(item => ({
  name: neocomPointerName(item.id), label: item.label, icon: item.icon,
}));
const tabIcon = clientTexture("res:/UI/Texture/Classes/HelpPointer/tabFlat.png");
const buttonIcon = clientTexture("res:/UI/Texture/Classes/HelpPointer/buttonFlat.png");
const fleet = FLEET_POINTERS;
const fleetPointers: readonly UiPointerTarget[] = [
  { name: fleet.finder, label: "Find Fleets", icon: tabIcon, parent: fleetParent },
  { name: fleet.finderSettings, label: "Fleet Finder Settings", parent: fleet.finder },
  { name: fleet.roster, label: "My Fleet", icon: tabIcon, parent: fleetParent },
  { name: fleet.history, label: "Fleet History / Broadcasts", icon: tabIcon, parent: fleetParent },
  { name: fleet.historyFilter, label: "Fleet History Filter", parent: fleet.history },
  { name: fleet.respawn, label: "Active Recloners / Respawn", icon: tabIcon, parent: fleetParent },
  { name: fleet.settings, label: "Fleet Settings", parent: fleetParent,
    icon: clientTexture("res:/UI/Texture/eveicon/system_icons/more_vertical_16px.png") },
  { name: fleet.broadcastToggle, label: "Show/Hide fleet broadcasts", parent: fleetParent },
  { name: fleet.broadcastIcons, label: "Fleet Broadcasting Icons", parent: fleet.broadcastToggle },
  { name: fleet.broadcastScope, label: "Fleet Broadcast scope" },
  { name: fleet.needArmor, label: "Broadcast: Need Armor", parent: fleet.broadcastToggle,
    icon: clientTexture("res:/UI/Texture/classes/Fleet/Broadcast/32/needArmor.png") },
  { name: fleet.needShield, label: "Broadcast: Need Shield", parent: fleet.broadcastToggle,
    icon: clientTexture("res:/UI/Texture/classes/Fleet/Broadcast/32/needShield.png") },
];
const chat = CHAT_POINTERS;
const chatPointers: readonly UiPointerTarget[] = [
  { name: chat.local, label: "Local Chat Channel", icon: tabIcon },
  { name: chat.corp, label: "Corporation Chat Channel", icon: tabIcon },
  { name: chat.corpSettings, label: "Corporation Chat Settings", parent: chat.corp },
  { name: chat.corpMotd, label: "Reload Corporation Chat MOTD", parent: chat.corpSettings },
  { name: chat.fleet, label: "Fleet Chat Channel", icon: tabIcon },
  { name: chat.fleetSettings, label: "Fleet Chat Settings", parent: chat.fleet },
  { name: chat.fleetMotd, label: "Reload Fleet Chat MOTD", parent: chat.fleetSettings },
  { name: chat.channels, label: "Open Channel Window" },
  { name: chat.create, label: "Chat Channels - Create", parent: chat.channels,
    icon: clientTexture("res:/UI/Texture/Classes/HelpPointer/buttonFlat.png") },
];
const corp = CORPORATION_POINTERS;
const corporationPointers: readonly UiPointerTarget[] = [
  { name: corp.corporation, label: "Corporation Tab", icon: tabIcon, parent: corporationParent },
  { name: corp.alliance, label: "Alliances", icon: tabIcon, parent: corporationParent },
  { name: corp.admin, label: "Corporation Administration", icon: tabIcon, parent: corporationParent },
  { name: corp.home, label: "My Corporation", parent: corp.corporation },
  { name: corp.applications, label: "My Corp Applications", parent: corp.corporation },
  { name: corp.bulletins, label: "Corporation Bulletins", parent: corp.corporation },
  { name: corp.projects, label: "Corporation Projects", parent: corp.corporation },
  { name: corp.recruitSearch, label: "Find New Corporation", parent: corp.corporation },
  { name: corp.freelance, label: "Corporation - Freelance Jobs", parent: corp.corporation },
  { name: corp.assets, label: "Corporation - Assets", parent: corp.admin },
  { name: corp.recruitAds, label: "Corporation Ads", parent: corp.admin },
  { name: corp.brand, label: "Brand Management ", parent: corp.admin },
];
const sheet = CHARACTER_SHEET_POINTERS;
const characterSheetTabs: readonly UiPointerTarget[] = ([
  [sheet.character, "Character Sheet - Character", sheet.expand],
  [sheet.interactions, "Character Sheet - Interactions", sheet.expand],
  [sheet.pilotServices, "Pilot Services", sheet.expand],
  [sheet.personalization, "Character Sheet - Personalization", sheet.expand],
  [sheet.skins, "Character Sheet - SKINs", sheet.personalization],
  [sheet.emblems, "Character Sheet - Emblems", sheet.personalization],
  [sheet.home, "Home Station", sheet.character],
  [sheet.implants, "Augmentations", sheet.character],
  [sheet.jumpClones, "Jump Clones", sheet.character],
  [sheet.expert, "Expert Systems", sheet.character],
  [sheet.decorations, "Decorations", sheet.character],
  [sheet.titles, "Titles", sheet.decorations],
  [sheet.standings, "Standings", sheet.interactions],
  [sheet.killRights, "Kill Rights", sheet.interactions],
  [sheet.securityStatus, "Security Status", sheet.interactions],
  [sheet.combatLog, "Combat Log", sheet.interactions],
  [sheet.combatFilter, "Show Kills/Losses", sheet.combatLog],
] as const).map(([name, label, parent]) => ({ name, label, icon: tabIcon, parent }));
const fittingStats: readonly UiPointerTarget[] = ([
  [FITTING_POINTERS.capacitor, "Capacitor"],
  [FITTING_POINTERS.defense, "Defense"],
  [FITTING_POINTERS.drones, "Drones"],
  [FITTING_POINTERS.navigation, "Navigation"],
  [FITTING_POINTERS.offense, "Offense"],
  [FITTING_POINTERS.targeting, "Targeting"],
] as const).map(([name, label]) => ({ name, label: `Fitting - ${label} Panel`, parent: FITTING_POINTERS.stats }));
const industryTabs: readonly UiPointerTarget[] = ([
  [INDUSTRY_TAB_POINTERS.blueprints, "Blueprints"],
  [INDUSTRY_TAB_POINTERS.facilities, "Facilities"],
  [INDUSTRY_TAB_POINTERS.jobs, "Jobs"],
  [INDUSTRY_TAB_POINTERS.research, "Research"],
] as const).map(([name, label]) => ({ name, label: `Industry - ${label}`, icon: tabIcon, parent: industryParent }));
const industryActivities: readonly UiPointerTarget[] = ([
  [INDUSTRY_ACTIVITY_POINTERS.manufacturing, "Manufacturing", "manufacturing"],
  [INDUSTRY_ACTIVITY_POINTERS.copying, "Copying", "copying"],
  [INDUSTRY_ACTIVITY_POINTERS.research_material, "Material efficiency research", "researchMaterial"],
  [INDUSTRY_ACTIVITY_POINTERS.research_time, "Time efficiency research", "researchTime"],
  [INDUSTRY_ACTIVITY_POINTERS.invention, "Invention", "invention"],
] as const).map(([name, label, asset]) => ({
  name, label: `Industry - ${label}`, icon: clientTexture(`res:/UI/Texture/classes/Industry/activity/${asset}.png`), parent: industryParent,
}));
const marketQuotePointers = ([
  [MARKET_POINTERS.buyers, "Buyers", "Quantity column"],
  [MARKET_POINTERS.sellers, "Sellers", "Quantity"],
] as const).flatMap(([ids, side, quantity]) => [
  { name: ids.list, label: `Market - ${side}`, parent: MARKET_POINTERS.data },
  { name: ids.jumps, label: `Market - ${side} - Jumps column`, parent: ids.list },
  { name: ids.qty, label: `Market - ${side} - ${quantity}`, parent: ids.list },
  { name: ids.price, label: `Market - ${side} - Price column`, parent: ids.list },
]);
export const INTERFACE_POINTERS: readonly UiPointerTarget[] = [
  ...WALLET_POINTERS,
  { name: LOBBY_POINTERS.undock, label: "Undock Button", icon: buttonIcon },
  { name: LOBBY_POINTERS.corvette, label: "Board my Corvette", icon: buttonIcon },
  { name: LOBBY_POINTERS.services, label: "Station Services" },
  { name: LOBBY_POINTERS.agents, label: "Station Services - Agents", icon: tabIcon },
  { name: LOBBY_POINTERS.guests, label: "Station Services - Guests", icon: tabIcon },
  { name: LOBBY_POINTERS.offices, label: "Offices", icon: tabIcon },
  { name: LOBBY_POINTERS.hangars, label: "Station Services - Hangars", icon: tabIcon },
  { name: INVENTORY_POINTERS.stackAll, label: "Inventory Stack All", parent: neocomPointerName("inventory") },
  { name: INVENTORY_POINTERS.viewMode, label: "Change Inventory View",
    icon: clientTexture("res:/UI/Texture/eveicon/system_icons/grid_view_16px.png"), parent: neocomPointerName("inventory") },
  { name: CONTRACT_POINTERS.search, label: "Contract Search", icon: tabIcon, parent: contractsParent },
  { name: CONTRACT_POINTERS.options, label: "Show/Hide more contract search options", parent: CONTRACT_POINTERS.search },
  { name: CONTRACT_POINTERS.availability, label: "Contract Availability Setting", parent: CONTRACT_POINTERS.options },
  ...corporationPointers,
  ...chatPointers,
  ...fleetPointers,
  { name: sheet.expand, label: "Expand/Collapse Character Sheet", parent: characterSheetParent,
    icon: clientTexture("res:/UI/Texture/Shared/DarkStyle/forward.png") },
  ...characterSheetTabs,
  { name: FITTING_POINTERS.equipment, label: "Fitting Tab", icon: tabIcon, parent: neocomPointerName("fitting") },
  { name: FITTING_POINTERS.personalization, label: "Personalization", icon: tabIcon, parent: neocomPointerName("fitting") },
  { name: FITTING_POINTERS.skins, label: "SKINs Browser", icon: tabIcon, parent: FITTING_POINTERS.personalization },
  { name: FITTING_POINTERS.simulate, label: "Simulate Ship", parent: FITTING_POINTERS.equipment },
  { name: FITTING_POINTERS.stats, label: "Ship Attributes and Statistics",
    icon: clientTexture("res:/UI/Texture/classes/Fitting/filterIconResources.png"), parent: FITTING_POINTERS.equipment },
  ...fittingStats,
  { name: FITTING_POINTERS.fighters, label: "Fitting - Fighters Panel" },
  ...industryTabs,
  ...industryActivities,
  { name: INDUSTRY_LOCATION_POINTERS.input, label: "Industry - Input material location" },
  { name: INDUSTRY_LOCATION_POINTERS.output, label: "Industry - Output location" },
  { name: MARKET_POINTERS.details, label: "Market - Details", icon: tabIcon, parent: neocomPointerName("market") },
  { name: MARKET_POINTERS.browseSettings, label: "Market - Browse settings",
    icon: clientTexture("res:/UI/Texture/eveicon/system_icons/tune_16px.png"), parent: neocomPointerName("market") },
  { name: MARKET_POINTERS.findInBrowse, label: "Market - Find type in Browse",
    icon: clientTexture("res:/UI/Texture/classes/MapView/focusIcon.png"), parent: MARKET_POINTERS.details },
  { name: MARKET_POINTERS.data, label: "Market Data", icon: tabIcon, parent: MARKET_POINTERS.details },
  { name: MARKET_POINTERS.history, label: "Market - Price History", icon: tabIcon, parent: MARKET_POINTERS.details },
  { name: MARKET_POINTERS.duration, label: "Market - Sell Order Duration" },
  ...marketQuotePointers,
];
export const UI_POINTER_TARGETS = [...NEOCOM_POINTERS, ...INTERFACE_POINTERS, ...STATION_POINTERS];
export const UI_POINTER_BY_NAME = new Map(UI_POINTER_TARGETS.map(target => [target.name, target]));
export const STATION_POINTER_LINK_LABEL = "UI/Help/PointerWndStationServicesLongName";

export function resolveUiPointer(target: UiPointerTarget): HTMLElement | null {
  const node = visiblePointerTarget(target.name);
  if (node) return node;
  if (menuOnlyPointers.has(target.name)) return document.querySelector<HTMLElement>(".fly-neocom .neocom .eve");
  if (!target.parent) return null;
  const parent = UI_POINTER_BY_NAME.get(target.parent);
  return parent ? resolveUiPointer(parent) : null;
}

export function dragUiPointerLinks(event: DragEvent, names: readonly string[], stationTemplate?: string) {
  const links = names.flatMap(name => {
    const target = UI_POINTER_BY_NAME.get(name);
    if (!target) return [];
    const label = target.linkLabel ?? target.label;
    const text = STATION_POINTERS.includes(target)
      ? stationTemplate
        ? plainText(formatTemplate(stationTemplate, { serviceName: label }, { nameOf: () => "" }))
        : `Station Service: ${label}`
      : label;
    return [{ url: helpPointerUrl(name), text }];
  });
  if (!links.length || !event.dataTransfer) return;
  event.dataTransfer.effectAllowed = "copyMove";
  event.dataTransfer.setData(LINK_DRAG_TYPE, JSON.stringify(links.length === 1 ? links[0] : links));
}

export function droppedUiPointerLinks(data: DataTransfer): string[] {
  try {
    const links = helpPointerLinksFromDrop(JSON.parse(data.getData(LINK_DRAG_TYPE)));
    return links.flatMap(link => {
      const name = parseHelpPointerUrl(link.url);
      return name && UI_POINTER_BY_NAME.has(name) ? [name] : [];
    });
  } catch {
    return [];
  }
}
