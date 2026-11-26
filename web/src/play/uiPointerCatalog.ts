import { formatTemplate, plainText } from "../bridge/clientWords.ts";
import { helpPointerLinksFromDrop, helpPointerUrl, parseHelpPointerUrl } from "../bridge/helpPointerLink.ts";
import { LINK_DRAG_TYPE } from "../bridge/skillPlanLink.ts";
import { NEOCOM_DEFAULT } from "./neocom.ts";
import { neocomPointerName, STATION_POINTERS, visiblePointerTarget, WALLET_POINTERS, type UiPointerTarget } from "./uiPointer.ts";

export const NEOCOM_POINTERS: readonly UiPointerTarget[] = NEOCOM_DEFAULT.map(item => ({
  name: neocomPointerName(item.id), label: item.label, icon: item.icon,
}));
export const UI_POINTER_TARGETS = [...NEOCOM_POINTERS, ...WALLET_POINTERS, ...STATION_POINTERS];
export const UI_POINTER_BY_NAME = new Map(UI_POINTER_TARGETS.map(target => [target.name, target]));
export const STATION_POINTER_LINK_LABEL = "UI/Help/PointerWndStationServicesLongName";

export function resolveUiPointer(target: UiPointerTarget): HTMLElement | null {
  const node = visiblePointerTarget(target.name);
  if (node || !target.parent) return node;
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
