// The Neocom: the client's bar down the left edge, its default buttons in the client's order
// (neocomConst.RAWDATA_NEOCOMDEFAULT) with the client's own window icons, the EVE menu at the top and the
// EVE-time clock at the bottom. A button opens its window where the play page has one, and says so where not yet.

import { clientTexture } from "./window.ts";
import { shortcutOf } from "./shortcutKeys.ts";
import { hideLabelShortcutTooltip, showLabelShortcutTooltip, tooltipDue } from "./labelShortcutTooltip.ts";

/**
 * BaseNeocomButton.LoadTooltipPanel: a button with a command (btnData.cmdName) AddCommandTooltip - the command's name
 * bold beside its shortcut, its detailed description under them (wrapWidth 200, secondary) -, one without it its
 * label (AddLabelMedium); GetTooltipPointer POINT_LEFT_2, the panel to the button's right. Read from the live client
 * (gridcheck: neocom mainBtnDataRoot / charSheetBtnDataRoot children, commandMap.GetCommandByName): name, description.
 */
const NEOCOM_TOOLTIPS: Readonly<Record<string, { cmd: string | null; name: string; description: string }>> = {
  achievements: { cmd: "OpenAchievementsWindow", name: "Achievements", description: "View your achievements, claim rewards, and discover what else there is to accomplish." },
  agency: { cmd: "OpenAgencyNew", name: "The Agency", description: "Find activities to suit your interests" },
  jobboard: { cmd: "OpenJobBoardWindow", name: "Opportunities", description: "Discover new opportunities and track your ongoing activities" },
  mail: { cmd: "OpenMail", name: "Mail", description: "Send and receive mail" },
  inventory: { cmd: "OpenInventory", name: "Inventory", description: "Access your cargo hold, hangars, and other local inventories" },
  assets: { cmd: "OpenAssets", name: "Personal Assets", description: "Locate your personal assets across New Eden" },
  wallet: { cmd: "OpenWallet", name: "Wallet", description: "" },
  market: { cmd: "OpenMarket", name: "Regional Market", description: "Visit the regional market to buy and sell assets" },
  fitting: { cmd: "OpenFitting", name: "Fitting", description: "Fit your ship or structure with different equipment, or personalize its appearance" },
  map: { cmd: "CmdToggleMap", name: "Map", description: "View star and solar system maps in many information modes" },
  charactersheet: { cmd: "OpenCharactersheet", name: "Character Sheet", description: "Manage your Augmentations, Clones, Pilot's Services, Standings and more" },
  // ButtonChat.LoadTooltipPanel: AddCommandTooltip(OpenChannels) - UI/Neocom/ChatChannelsBtn, Tooltips/Neocom/ChatChannels_description (g241)
  chat: { cmd: "OpenChannels", name: "Chat Channels", description: "Browse available chat channels or create your own channel" },
};
/** tooltipHandler: a panel after the generic delay, the renew time (a fifth) while one shows or just closed. */
function neocomTipOn(el: HTMLElement, id: string): void {
  const t = NEOCOM_TOOLTIPS[id];
  if (!t) return;
  tooltipDue(el, () => {
    if (t.cmd) showLabelShortcutTooltip(el, t.name, shortcutOf(t.cmd), t.description ? [t.description] : [], "left");
    else showLabelShortcutTooltip(el, "", "", [t.name], "left", true);
  });
}
function neocomTipOff(): void {
  hideLabelShortcutTooltip();
}

export interface NeocomButton { id: string; label: string; icon: string }

const icon = (name: string) => clientTexture(`res:/UI/Texture/WindowIcons/${name}.png`);

// RAWDATA_NEOCOMDEFAULT, as far as the play page goes: Project Discovery and the like are left out until there is
// something behind them. 24.02 puts Achievements first (BTNTYPE_ACHIEVEMENTS, type 25).
export const NEOCOM_DEFAULT: readonly NeocomButton[] = [
  { id: "achievements", label: "Achievements", icon: icon("achievements") },
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
 * for carries that window's id, the rest are listed and say they are not there yet.
 */
export interface EveMenuGroup { label: string; icon: string; items: readonly { id: string | null; label: string; icon: string }[] }
export const EVE_MENU: readonly EveMenuGroup[] = [
  { label: "Activities", icon: icon("directoryActivities"), items: [
    { id: "jobboard", label: "Opportunities", icon: icon("opportunities") },
    { id: "agency", label: "Agency", icon: icon("theAgency") },
    { id: "map", label: "Map", icon: icon("map") },
    { id: "theatersOfWar", label: "Theaters of War", icon: clientTexture("res:/UI/Texture/eveicon/product_icons/theaters_of_war_product_64px.png") },
  ] },
  { label: "Finance", icon: icon("directoryMarket"), items: [
    { id: "market", label: "Regional Market", icon: icon("market") },
    { id: "marketorders", label: "Market Orders", icon: icon("marketOrders") },
    { id: "wallet", label: "Wallet", icon: icon("wallet") },
    { id: "contracts", label: "Contracts", icon: icon("contracts") },
  ] },
  { label: "Industry", icon: icon("directoryIndustry"), items: [
    { id: "industry", label: "Industry", icon: icon("industry") },
    { id: "miningScan", label: "Mining Scan Results", icon: clientTexture("res:/ui/texture/eveicon/control_icons/mining_overlay_toggle_default_32px.png") },
    { id: "miningLedger", label: "Mining Ledger", icon: icon("industry") },
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
    { id: "shipTree", label: "Ship Tree", icon: icon("isis") },
  ] },
  { label: "Social", icon: icon("directorySocial"), items: [
    { id: "contacts", label: "Contacts", icon: icon("peopleandplaces") },
    { id: "chat", label: "Channels", icon: icon("chatchannels") },
    { id: "fleet", label: "Fleet", icon: icon("fleet") },
    { id: "mail", label: "EVE Mail", icon: icon("evemail") },
    { id: "corporation", label: "Corporation", icon: icon("corporation") },
    { id: "calendar", label: "Calendar", icon: icon("calendar") },
  ] },
  { label: "Paragon Services", icon: clientTexture("res:/UI/Texture/eveicon/feature_icons/paragon_folder_64px.png"), items: [
    { id: "achievements", label: "Achievements", icon: icon("achievements") },
  ] },
  { label: "Utilities", icon: icon("directoryUtilities"), items: [
    { id: "notepad", label: "Notepad", icon: icon("notepad") },
    { id: "compare", label: "Compare Tool", icon: icon("comparetool") },
    { id: "log", label: "Log", icon: icon("log") },
    { id: "structureBrowser", label: "Structure Browser", icon: icon("corporation") },
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
      el.setAttribute("aria-label", b.label);
      el.innerHTML = `<img src="${b.icon}" alt="">`;
      el.addEventListener("click", () => { neocomTipOff(); open(b.id); });
      el.addEventListener("mouseenter", () => neocomTipOn(el, b.id));
      el.addEventListener("mouseleave", neocomTipOff);
      list.appendChild(el);
    }
    this.clock.className = "nc-clock";
    this.root.appendChild(this.clock);
    // ClockButton.LoadTooltipPanel: AddCommandTooltip(OpenCalendar) - Calendar, no shortcut by default - then the EVE time
    // as FormatDateTime(dateFormat='full') in a plain AddLabelMedium (the live client, gridcheck g231: 144 x 76,
    // "2026.11.23 18:52" at 16,42)
    const clockTip = () => {
      const d = new Date();
      const two = (n: number) => String(n).padStart(2, "0");
      const when = `${d.getUTCFullYear()}.${two(d.getUTCMonth() + 1)}.${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
      showLabelShortcutTooltip(this.clock, "Calendar", shortcutOf("OpenCalendar"), [when], "left", true);
    };
    this.clock.addEventListener("mouseenter", () => tooltipDue(this.clock, clockTip));
    this.clock.addEventListener("mouseleave", neocomTipOff);
    const tick = () => {
      const d = new Date();
      this.clock.textContent = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
    };
    tick();
    setInterval(tick, 10_000);
  }
}
