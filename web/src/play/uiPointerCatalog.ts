import { formatTemplate, plainText } from "../bridge/clientWords.ts";
import { helpPointerLinksFromDrop, helpPointerUrl, parseHelpPointerUrl } from "../bridge/helpPointerLink.ts";
import { LINK_DRAG_TYPE } from "../bridge/skillPlanLink.ts";
import { clientTexture } from "../ui/skillGroupIcons.ts";
import { EVE_MENU, NEOCOM_DEFAULT } from "./neocom.ts";
import { INDUSTRY_ACTIVITY_POINTERS, INDUSTRY_LOCATION_POINTERS, INDUSTRY_TAB_POINTERS, MARKET_POINTERS, neocomPointerName, STATION_POINTERS, visiblePointerTarget, WALLET_POINTERS, type UiPointerTarget } from "./uiPointer.ts";

const industryParent = neocomPointerName("industry");
const industryEntry = EVE_MENU.flatMap(group => group.items).find(item => item.id === "industry");
export const NEOCOM_POINTERS: readonly UiPointerTarget[] = [...NEOCOM_DEFAULT.map(item => ({
  name: neocomPointerName(item.id), label: item.label, icon: item.icon,
})), ...(industryEntry ? [{ name: industryParent, label: industryEntry.label, icon: industryEntry.icon }] : [])];
const tabIcon = clientTexture("res:/UI/Texture/Classes/HelpPointer/tabFlat.png");
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
  ...industryTabs,
  ...industryActivities,
  { name: INDUSTRY_LOCATION_POINTERS.input, label: "Industry - Input material location" },
  { name: INDUSTRY_LOCATION_POINTERS.output, label: "Industry - Output location" },
  { name: MARKET_POINTERS.details, label: "Market - Details", icon: tabIcon, parent: neocomPointerName("market") },
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
  if (target.name === industryParent) return document.querySelector<HTMLElement>(".fly-neocom .neocom .eve");
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
