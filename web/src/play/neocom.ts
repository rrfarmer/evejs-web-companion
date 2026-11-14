// The Neocom: the client's bar down the left edge, its default buttons in the client's order
// (neocomConst.RAWDATA_NEOCOMDEFAULT) with the client's own window icons, the EVE menu at the top and the
// EVE-time clock at the bottom. A button opens its window where the play page has one, and says so where not yet.

import { clientTexture } from "./window.ts";

export interface NeocomButton { id: string; label: string; icon: string }

const icon = (name: string) => clientTexture(`res:/UI/Texture/WindowIcons/${name}.png`);

// RAWDATA_NEOCOMDEFAULT, as far as the play page goes: Project Discovery and the like are left out until there is
// something behind them. The career program first (BTNTYPE_CAREER_PROGRAM, AIR_CAREER_PROGRAM_ID: CareerPortalWnd,
// airCareerProgram.png).
export const NEOCOM_DEFAULT: readonly NeocomButton[] = [
  { id: "careerportal", label: "AIR Career Program", icon: icon("airCareerProgram") },
  { id: "agency", label: "Agency", icon: icon("agentfinder") },
  { id: "jobboard", label: "Opportunities", icon: icon("opportunities") },
  { id: "mail", label: "EVE Mail", icon: icon("evemail") },
  { id: "inventory", label: "Inventory", icon: icon("items") },
  { id: "assets", label: "Assets", icon: icon("assets") },
  { id: "wallet", label: "Wallet", icon: icon("wallet") },
  { id: "market", label: "Regional Market", icon: icon("market") },
  { id: "fitting", label: "Fitting", icon: icon("fitting") },
  { id: "map", label: "Map", icon: icon("map") },
  { id: "charactersheet", label: "Character Sheet", icon: icon("charactersheet") },
  { id: "chat", label: "Chat", icon: icon("chatchannels") },
];

/**
 * The EVE menu (neocomRawData.GetEveMenuRawData, neocomConst's RAWDATA_EVEMENU_GROUP_*, btnDataRaw's labels and
 * icons): its groups in the client's order, each with the commands it holds; a command the play page has a window
 * for carries that window's id, the rest are listed and say they are not there yet. The groups that hold nothing
 * the page can show yet (Paragon services) are left out.
 */
export interface EveMenuGroup { label: string; icon: string; items: readonly { id: string | null; label: string; icon: string }[] }
export const EVE_MENU: readonly EveMenuGroup[] = [
  { label: "Activities", icon: icon("directoryActivities"), items: [
    { id: "jobboard", label: "Opportunities", icon: icon("opportunities") },
    { id: "agency", label: "Agency", icon: icon("theAgency") },
    { id: "map", label: "Map", icon: icon("map") },
  ] },
  { label: "Finance", icon: icon("directoryMarket"), items: [
    { id: "market", label: "Regional Market", icon: icon("market") },
    { id: "marketorders", label: "Market Orders", icon: icon("marketOrders") },
    { id: "wallet", label: "Wallet", icon: icon("wallet") },
    { id: "contracts", label: "Contracts", icon: icon("contracts") },
  ] },
  { label: "Industry", icon: icon("directoryIndustry"), items: [
    { id: "industry", label: "Industry", icon: icon("industry") },
    { id: "planets", label: "Planetary Colonies", icon: icon("planets") },
  ] },
  { label: "Inventory", icon: icon("directoryInventory"), items: [
    { id: "inventory", label: "Inventory", icon: icon("items") },
    { id: "assets", label: "Assets", icon: icon("assets") },
  ] },
  { label: "Personal", icon: icon("directoryPersonal"), items: [
    { id: "charactersheet", label: "Character Sheet", icon: icon("charactersheet") },
    { id: "locations", label: "Locations", icon: icon("locations") },
  ] },
  { label: "Ship", icon: icon("directoryShip"), items: [
    { id: "fitting", label: "Fitting", icon: icon("fitting") },
  ] },
  { label: "Social", icon: icon("directorySocial"), items: [
    { id: "contacts", label: "Contacts", icon: icon("peopleandplaces") },
    { id: "chat", label: "Channels", icon: icon("chatchannels") },
    { id: "fleet", label: "Fleet", icon: icon("fleet") },
    { id: "mail", label: "EVE Mail", icon: icon("evemail") },
    { id: "corporation", label: "Corporation", icon: icon("corporation") },
    { id: "calendar", label: "Calendar", icon: icon("calendar") },
  ] },
  { label: "Utilities", icon: icon("directoryUtilities"), items: [
    { id: "notepad", label: "Notepad", icon: icon("notepad") },
    { id: "compare", label: "Compare Tool", icon: icon("comparetool") },
    { id: "log", label: "Log", icon: icon("log") },
  ] },
];

export class Neocom {
  readonly root = document.createElement("nav");
  private readonly clock = document.createElement("div");
  /** The EVE menu's panels, on the page's body. */
  private menuParts: HTMLElement[] = [];
  /** Takes the EVE menu's panels off the page. */
  dispose(): void { for (const el of this.menuParts) el.remove(); }

  constructor(open: (id: string) => void) {
    this.root.className = "neocom";
    this.root.innerHTML = `<div class="eve" title="EVE Menu"></div><div class="nc-buttons"></div><div class="nc-fill"></div>`;
    const list = this.root.querySelector(".nc-buttons")!;
    // the EVE menu (PanelEveMenu): a panel the desktop's height beside the Neocom - its groups' entries (48 high,
    // the icon at 8, the label 12 after it in TUNGSTEN_GREY, a caret at the right), a group's commands in a panel
    // beside it (PanelGroup) while the group's entry is under the mouse; a click on a command opens it and closes
    // the menu, as does a click elsewhere or the EVE button again
    const menu = document.createElement("div");
    menu.className = "eve-menu";
    menu.hidden = true;
    const sub = document.createElement("div");
    sub.className = "eve-menu-sub";
    sub.hidden = true;
    // (the menu draws over the windows, as the client's panels do: it lives on the page's body, placed beside the
    // Neocom when it opens - the Neocom's own layer is under the windows')
    const close = () => { menu.hidden = true; sub.hidden = true; };
    const entry = (label: string, iconUrl: string, group: boolean) => {
      const el = document.createElement("button");
      el.className = "eve-menu-entry" + (group ? " group" : "");
      el.innerHTML = `<img src="${iconUrl}" alt=""><span></span>`;
      el.querySelector("span")!.textContent = label;
      return el;
    };
    for (const g of EVE_MENU) {
      const el = entry(g.label, g.icon, true);
      const show = () => {
        sub.replaceChildren();
        for (const item of g.items) {
          const c = entry(item.label, item.icon, false);
          if (item.id === null) { c.disabled = true; c.title = "Not in the play page yet"; }
          else c.addEventListener("click", () => { close(); open(item.id!); });
          sub.appendChild(c);
        }
        sub.style.top = `${el.getBoundingClientRect().top}px`;
        sub.style.left = `${menu.getBoundingClientRect().right}px`;
        sub.hidden = false;
      };
      el.addEventListener("mouseenter", show);
      el.addEventListener("click", show);
      menu.appendChild(el);
    }
    document.body.appendChild(menu);
    document.body.appendChild(sub);
    this.menuParts = [menu, sub];
    this.root.querySelector(".eve")!.addEventListener("click", (e) => {
      e.stopPropagation(); menu.hidden = !menu.hidden; sub.hidden = true;
      const r = this.root.getBoundingClientRect();
      menu.style.left = `${r.right}px`; menu.style.top = `${r.top}px`; menu.style.height = `${r.height}px`;
    });
    menu.addEventListener("click", (e) => e.stopPropagation());
    sub.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", close);
    for (const b of NEOCOM_DEFAULT) {
      const el = document.createElement("button");
      el.className = "nc-btn";
      el.title = b.label;
      el.innerHTML = `<img src="${b.icon}" alt="">`;
      el.addEventListener("click", () => open(b.id));
      list.appendChild(el);
    }
    this.clock.className = "nc-clock";
    this.root.appendChild(this.clock);
    const tick = () => {
      const d = new Date();
      this.clock.textContent = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
    };
    tick();
    setInterval(tick, 10_000);
  }
}
