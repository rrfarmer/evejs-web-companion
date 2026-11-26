// A link in a chat message or a mail's body, followed as the client's link registry follows it (evelink/client:
// registry.register, each scheme with its handler, hint and colour), for every text the client shows links in:
//
//   skillPlan        link.py handle_link: the Skills window opens on the plan (registered with no colour of its own:
//                    default_link_color_info); its hint UI/SkillPlan/SkillPlan
//   showinfo         handle_show_info_link: Show Info on the type, or on the pilot for a pilot's link
//                    (default_with_subtle_color_info); its hint UI/Commands/ShowInfo; a corporation's, an alliance's, a
//                    faction's or a place's link the page's window does not show yet, and it is not followed
//   http, https      handle_web_link: ExternalLinkWarning, then a tab of its own (external_link_color_info); its hint
//                    the url
//   fitting          shipfitting/client/link.py handle_fitting_link, given the link's text (accept_link_text): the
//                    fitting display window on the fitting the url holds, named the text (DisplayFittingFromString);
//                    registered with no colour of its own (default_link_color_info); its hint UI/Fitting/ShowFitting
//
// Any other link is not followed (shown underlined, its url its hint). The colours are styles.css's `.evelink`.

import type { AppFlow } from "../app/flow.ts";
import { LINK_DRAG_TYPE, parseSkillPlanUrl } from "../bridge/skillPlanLink.ts";
import { parseInventoryFilterLink } from "../bridge/inventoryFilters.ts";
import { parseOverviewPresetUrl } from "../bridge/overviewProfileLink.ts";
import { parseHelpPointerUrl } from "../bridge/helpPointerLink.ts";
import { linkScheme, parseShowInfoUrl } from "../bridge/showInfoLink.ts";
import { showInfo, subjectOfShowInfoLink } from "./showInfo.ts";
import { parseAccessGroupUrl, showAccessGroupInfo } from "./accessGroupInfo.ts";

/**
 * A link in a text dragged (carbonui label.GetDragData: a TextLink of its url and its text, the tags stripped), for a
 * text to take (eveEditPlainText.OnDropData: AddLink of the text and the url, flow.droppedLinkMarkup).
 */
export function startLinkDrag(event: DragEvent, url: string, text: string): void {
  event.dataTransfer?.setData(LINK_DRAG_TYPE, JSON.stringify({ url, text: text.replace(/<[^>]*>/g, "") }));
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
}

export interface ItemLink {
  readonly url: string;
  readonly text: string;
}

/** A selected list transfers one Show Info link per row, in display order. */
export function startItemLinksDrag(event: DragEvent, links: readonly ItemLink[]): void {
  if (links.length === 1) {
    startLinkDrag(event, links[0]!.url, links[0]!.text);
  } else if (links.length > 1 && event.dataTransfer) {
    event.dataTransfer.setData(LINK_DRAG_TYPE, JSON.stringify(links));
    event.dataTransfer.effectAllowed = "copy";
  }
}

export function itemLinksFromDrop(payload: unknown): ItemLink[] {
  if (!Array.isArray(payload)) return [];
  const links: ItemLink[] = [];
  for (const item of payload) {
    const { url, text } = item ?? {};
    if (typeof url !== "string" || !/^showinfo:\d+\/\/\d+$/.test(url) || typeof text !== "string") return [];
    const ids = parseShowInfoUrl(url);
    if (!ids || ids.typeID <= 0 || ids.itemID === null || ids.itemID <= 0) return [];
    links.push({ url, text });
  }
  return links;
}

/** The links' hints, the page's own words where the install's are not to hand. */
export const LINK_WORDS: Readonly<Record<string, string>> = {
  "UI/AclBookmarks/ShowAccessListInfo": "Show Access List Info",
  "UI/SkillPlan/SkillPlan": "Skill plan",
  "UI/Commands/ShowInfo": "Show information",
  "UI/Fitting/ShowFitting": "Look at the fitting",
  "UI/Inventory/Filters/SharedItemFilter": "Shared Item Filter",
  "UI/Overview/ProfileLinkHint": "Overview Profile",
  "UI/Help/HelpPointersTooltip": "Show User Interface Pointer",
};

export interface LinkFollower {
  /** Its registry's kind, for its colour (styles.css .evelink.skillPlan, .showInfo, .web, .fitting). */
  readonly kind: "skillPlan" | "showInfo" | "web" | "fitting" | "sharedSetting" | "helpPointer";
  readonly hint: string;
  readonly follow: () => void;
}

/**
 * How a link is followed, or null where the page does not follow it. openSkillPlanLink opens the Skills window on a
 * plan (none where the text's window cannot); word is the install's words for the hints (LINK_WORDS); text is the
 * link's own text, which a handler registered with accept_link_text is given (carbonui link.GetLinkText).
 */
export function linkFollowerOf(
  url: string,
  flow: Pick<AppFlow, "followWebLink" | "followFittingLink"> & Partial<Pick<AppFlow, "followOverviewPresetLink">>,
  openSkillPlanLink: ((url: string) => void) | null,
  word: (label: string) => string,
  text: string | null = null,
  openInventoryFilterLink: ((url: string) => void) | null = null,
): LinkFollower | null {
  const scheme = linkScheme(url);
  if (scheme === "helppointer") {
    const name = parseHelpPointerUrl(url);
    return name === null ? null : {
      kind: "helpPointer", hint: word("UI/Help/HelpPointersTooltip"),
      follow: () => window.dispatchEvent(new CustomEvent("eve-ui-pointer", { detail: { flow, name } })),
    };
  }
  if (scheme === "accessgroup") {
    const groupID = parseAccessGroupUrl(url);
    if (groupID === null) return null;
    return { kind: "showInfo", hint: word("UI/AclBookmarks/ShowAccessListInfo") || "Show Access List Info",
      follow: () => showAccessGroupInfo(flow, groupID) };
  }
  if (scheme === "fitting") {
    return { kind: "fitting", hint: word("UI/Fitting/ShowFitting"), follow: () => void flow.followFittingLink(url, text).catch(() => {}) };
  }
  if (scheme === "skillplan" && openSkillPlanLink !== null && parseSkillPlanUrl(url) !== null) {
    return { kind: "skillPlan", hint: word("UI/SkillPlan/SkillPlan"), follow: () => openSkillPlanLink(url) };
  }
  if (scheme === "sharedsetting" && openInventoryFilterLink !== null && parseInventoryFilterLink(url)) {
    return { kind: "sharedSetting", hint: word("UI/Inventory/Filters/SharedItemFilter"), follow: () => openInventoryFilterLink(url) };
  }
  // preset_link.register_link_handlers: hint ProfileLinkHint, settings_link_color_info, accept_link_text
  if (scheme === "overviewpreset" && flow.followOverviewPresetLink && parseOverviewPresetUrl(url)) {
    const follow = flow.followOverviewPresetLink;
    return { kind: "sharedSetting", hint: word("UI/Overview/ProfileLinkHint"), follow: () => void follow(url, text).catch(() => {}) };
  }
  if (scheme === "showinfo") {
    const subject = subjectOfShowInfoLink(url);
    return subject === null ? null : { kind: "showInfo", hint: word("UI/Commands/ShowInfo"), follow: () => showInfo(subject) };
  }
  if (scheme === "http" || scheme === "https") {
    return { kind: "web", hint: url, follow: () => void flow.followWebLink(url) };
  }
  return null;
}
