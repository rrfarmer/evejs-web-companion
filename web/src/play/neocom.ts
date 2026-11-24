// The Neocom: the client's bar down the left edge, its default buttons in the client's order
// (neocomConst.RAWDATA_NEOCOMDEFAULT) with the client's own window icons, the EVE menu at the top and the
// EVE-time clock at the bottom. A button opens its window where the play page has one, and says so where not yet.

import { clientTexture } from "./window.ts";
import { shortcutOf } from "./shortcutKeys.ts";
import { hideLabelShortcutTooltip, showLabelShortcutTooltip, tooltipDue, showSkillTrainingTooltip, type SkillTrainingTip } from "./labelShortcutTooltip.ts";
import { playUiEvent } from "./uiAudio.ts";
import type { SkillsState } from "../store/types.ts";

/**
 * ButtonSkills' state: the level in training's progress (SkillController.GetTrainingProgressForCurrLevel - the points
 * made in the level over the level's points), or not training. null while the queue is not known.
 */
export type NeocomSkillState = { training: true; progress: number } | { training: false } | null;

/** The skill queue's head as ButtonSkills reads it (skillqueue.GetActiveSkillTypeID), at the browser time `now`. */
export function neocomSkillState(sk: SkillsState, now = Date.now()): NeocomSkillState {
  const q = sk.queue;
  if (!q) return null;
  const head = q.active ? q.entries[0] : undefined;
  if (!head || head.startTimeMs === null || head.endTimeMs === null) return { training: false };
  const at = now + sk.clockOffsetMs;
  if (at >= head.endTimeMs) return { training: true, progress: 1 };
  const row = sk.skills?.find((r) => r.typeID === head.typeID);
  const floor = head.toLevel > 1 ? (row?.levelSkillPoints[head.toLevel - 2] ?? 0) : 0;
  const ceiling = head.destinationSP;
  // the points made: from the level's start points at the queue's rate (time-scaled where no rate came)
  const span = head.endTimeMs - head.startTimeMs;
  const sp = head.skillPointsPerMinute > 0
    ? head.startSP + head.skillPointsPerMinute * Math.max(0, at - head.startTimeMs) / 60000
    : head.startSP + (ceiling - head.startSP) * (span > 0 ? Math.max(0, at - head.startTimeMs) / span : 0);
  const progress = ceiling > floor ? Math.max(0, Math.min(1, (Math.min(sp, ceiling) - floor) / (ceiling - floor))) : 0;
  return { training: true, progress };
}

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
  shipTree: { cmd: "CmdToggleShipTree", name: "Ship Tree", description: "Browse each faction's ships using the Ship Tree" },
  fitting: { cmd: "OpenFitting", name: "Fitting", description: "Fit your ship or structure with different equipment, or personalize its appearance" },
  map: { cmd: "CmdToggleMap", name: "Map", description: "View star and solar system maps in many information modes" },
  charactersheet: { cmd: "OpenCharactersheet", name: "Character Sheet", description: "Manage your Augmentations, Clones, Pilot's Services, Standings and more" },
  // ButtonChat.LoadTooltipPanel: AddCommandTooltip(OpenChannels) - UI/Neocom/ChatChannelsBtn, Tooltips/Neocom/ChatChannels_description (g241)
  log: { cmd: "OpenLog", name: "Log and Messages", description: "" },
  // ButtonReward (loginRewards): OpenLoginRewardWindow, Daily Login Campaigns (the live client, gridcheck g291 / g292)
  loginRewards: { cmd: "OpenLoginRewardWindow", name: "Daily Login Campaigns", description: "Log in daily during active campaigns to receive your rewards" },
  chat: { cmd: "OpenChannels", name: "Chat Channels", description: "Browse available chat channels or create your own channel" },
  // the EVE menu's Calendar (groupSocial): OpenCalendar, no description, no shortcut (the live client, g297)
  calendar: { cmd: "OpenCalendar", name: "Calendar", description: "" },
};
/** tooltipHandler: a panel after the generic delay, the renew time (a fifth) while one shows or just closed. */
function neocomTipOn(el: HTMLElement, id: string, blinkHint = ""): void {
  const t = NEOCOM_TOOLTIPS[id];
  if (!t) return;
  // BaseNeocomButton.LoadTooltipPanel: a blink hint (btnData.GetBlinkHint) under the command, AddLabelMedium width 200 in
  // THEME_ALERT
  const hint = blinkHint ? blinkHint.split("\n").map((text) => ({ text, color: "rgb(243, 144, 88)" })) : [];
  tooltipDue(el, () => {
    // ButtonReward.LoadTooltipPanel: its description AddLabelMedium (wrapWidth 200) in (0.6, 0.6, 0.6, 1), not the
    // command tooltip's secondary colour
    const desc = t.description ? [id === "loginRewards" ? { text: t.description, color: "rgb(153, 153, 153)" } : t.description] : [];
    if (t.cmd) showLabelShortcutTooltip(el, t.name, shortcutOf(t.cmd), [...desc, ...hint], "left");
    else showLabelShortcutTooltip(el, "", "", [t.name, ...hint], "left", true);
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
  // the Ship Tree ButtonWindow between Market and Fitting (CmdToggleShipTree, ISIS.png; the live client, gridcheck g267)
  { id: "shipTree", label: "Ship Tree", icon: icon("isis") },
  { id: "fitting", label: "Fitting", icon: icon("fitting") },
  { id: "map", label: "Map", icon: icon("map") },
  // ButtonChat's chatchannel.png, then the Log and Messages ButtonWindow (LoggerWindow, OpenLog, log.png) - the live
  // client, gridcheck g250 / g251
  { id: "chat", label: "Chat", icon: icon("chatchannel") },
  { id: "log", label: "Log and Messages", icon: icon("log") },
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
  /** ButtonCharacterIcon (charSheetBtn): the pilot's portrait filling a 48 x 48 button under the EVE button. */
  private readonly portrait = document.createElement("img");
  /** Each button's ButtonIndicator, by its id. */
  private readonly indicators = new Map<string, HTMLElement>();
  /** The buttons by id, for their blink. */
  private readonly buttons = new Map<string, HTMLElement>();
  private windowStates: ReadonlyMap<string, "open" | "active"> = new Map();
  /**
   * btnDataNode's blink: SetBlinkingOn - NUM_BLINKS 3 (each neocomSvc blink pulse, BLINK_INTERVAL 1 s, BlinkOnce: the
   * icon's glow 0 -> 2 and back, ANIM_WAVE), hasNewActivity for 8 s and the blink hint; hovering ends the blinks and the
   * new activity (SetBlinkingOff, SetHasNewActivityOff), leaving clears the hint (ClearBlinkHint). _UpdateHighlightState:
   * active > important (blinking / new activity / a hint) > open > normal; important is 2 x 16 THEME_ALERT.
   */
  private readonly blinks = new Map<string, { left: number; newUntil: number; hint: string }>();
  private pulseTimer: ReturnType<typeof setInterval> | null = null;
  /** The EVE menu's entries and the window ids under each (a group: its children). */
  private menuEntries: { el: HTMLElement; ids: string[]; sub: boolean }[] = [];
  /** The buttons CheckOverflow hid. */
  private overflowIDs: string[] = [];
  /**
   * HasUnseenItems (btnData.GetItemCount, e.g. BtnDataNodeAchievements: the unclaimed rewards): important for as long as
   * there are any, the hint (GetUnseenItemsHint) in the tooltip; OnBadgeCountChanged blinks the button as they come.
   */
  private readonly unseen = new Map<string, string>();
  private readonly counts = new Map<string, number>();
  /**
   * `count` (GetItemCount) where the button keeps one: btnDataNode.OnBadgeCountChanged blinks the button on each change
   * while there are unseen items, and ButtonIndicator.SetCounterValue shows the count's banner when it rises.
   */
  setUnseen(id: string, hint: string | null, count?: number): void {
    const had = this.unseen.has(id);
    if (hint) this.unseen.set(id, hint); else this.unseen.delete(id);
    // (the first count is the button's at its making: ButtonIndicator(value=...) shows no banner)
    const known = this.counts.has(id);
    const prev = this.counts.get(id) ?? 0;
    if (count !== undefined) this.counts.set(id, count);
    const changed = count !== undefined && count !== prev;
    if (hint && (!had || changed)) this.blink(id);
    if (count !== undefined && known && count > prev) this.showCount(id, count);
    this.paintIndicators();
  }
  /**
   * ButtonIndicator._ShowValueBanner: 3 s after the count rose, a tab with it (EveLabelMedium in TextColor.HIGHLIGHT,
   * left 4, label width + 8) slides out of the indicator's line over 0.3 s on buttonIndicatorBG (cornerSize 4) in
   * the state's background colour at 0.4 over black 0.3; 5 s later it slides back in over 0.6 s. The Neocom's list
   * clips, so the tab is the page body's, placed at the line.
   */
  private showCount(id: string, n: number): void {
    const text = n < 1000 ? String(n) : n < 1e6 ? `${Math.floor(n / 100) / 10}K` : `${Math.floor(n / 1e5) / 10}M`;
    setTimeout(() => {
      if ((this.counts.get(id) ?? 0) < n) return;
      const ind = this.indicators.get(id);
      if (!ind || !ind.isConnected || ind.dataset.state !== "important") return;
      const r = ind.getBoundingClientRect();
      if (!r.height) return;
      const tab = document.createElement("div");
      tab.className = "nc-count";
      tab.textContent = text;
      tab.style.left = `${r.right}px`;
      tab.style.top = `${r.top + r.height / 2 - 8}px`;
      document.body.appendChild(tab);
      requestAnimationFrame(() => requestAnimationFrame(() => tab.classList.add("on")));
      setTimeout(() => { tab.classList.remove("on"); tab.classList.add("off"); setTimeout(() => tab.remove(), 700); }, 5300);
    }, 3000);
  }
  /** neocomSvc.Blink(wndID, hint): the button for that window blinks. */
  blink(id: string, hint = ""): void {
    // GetBtnData looks through the Neocom's own roots first, the EVE menu's last (eveMenuBtnDataRoot): a window there
    // only (Calendar, in Social) blinks its node, and the EVE menu button pulses while any child blinks (IsBlinking:
    // _IsAnyChildBlinking; ProcessNeocomBlinkPulse -> BlinkOnce)
    if (!this.buttons.has(id) && !EVE_MENU.some((g) => g.items.some((i) => i.id === id))) return;
    const was = this.blinks.get(id);
    if (was && was.left > 0) return;
    this.blinks.set(id, { left: 3, newUntil: Date.now() + 8000, hint: hint || was?.hint || "" });
    this.paintIndicators();
    if (!this.pulseTimer) this.pulseTimer = setInterval(() => this.pulse(), 1000);
  }
  private pulse(): void {
    const now = Date.now();
    // OverflowButton.ProcessNeocomBlinkPulse: a hidden button blinking makes the overflow button BlinkOnce - its
    // DUSKY_ORANGE fill 0 -> 0.5 -> 0 over BLINK_INTERVAL
    const ov = this.root.querySelector<HTMLElement>(".nc-overflow");
    if (ov && !ov.hidden && this.overflowIDs.some((id) => (this.blinks.get(id)?.left ?? 0) > 0)) {
      ov.classList.remove("nc-ov-blink"); void ov.offsetWidth; ov.classList.add("nc-ov-blink");
    }
    for (const [id, b] of this.blinks) {
      if (b.left > 0) {
        const el = this.buttons.get(id) ?? this.root.querySelector<HTMLElement>(".eve");
        // PanelEntryBase.BlinkOnce: the entry's blinkSprite (panelEntryBG in COLORTYPE_UIHILIGHT) 0 -> 1.5 -> 0
        if (!this.buttons.has(id)) for (const m of this.menuEntries) if (m.ids.includes(id) && m.el.isConnected) { m.el.classList.remove("nc-pe-blink"); void m.el.offsetWidth; m.el.classList.add("nc-pe-blink"); }
        if (el) { el.classList.remove("nc-blink"); void el.offsetWidth; el.classList.add("nc-blink"); }
        b.left -= 1;
      }
      if (b.left <= 0 && now >= b.newUntil && !b.hint) this.blinks.delete(id);
    }
    this.paintIndicators();
    if (![...this.blinks.values()].some((b) => b.left > 0 || now < b.newUntil) && this.pulseTimer) { clearInterval(this.pulseTimer); this.pulseTimer = null; }
  }
  private important(id: string): boolean {
    if (this.unseen.has(id)) return true;
    const b = this.blinks.get(id);
    return !!b && (b.left > 0 || Date.now() < b.newUntil || !!b.hint);
  }
  private paintIndicators(): void {
    for (const [id, ind] of this.indicators) {
      const w = this.windowStates.get(id);
      const state = w === "active" ? "active" : this.important(id) ? "important" : (w ?? "");
      if (ind.dataset.state !== state) ind.dataset.state = state;
    }
    // the EVE menu's entries (PanelEntryBase.buttonIndicator, CENTERRIGHT): important while their node - or for a group
    // any child (HasAnyChildNewActivity) - blinks; only the nodes GetBtnData finds there (the windows the Neocom has
    // no button of its own for)
    for (const m of this.menuEntries) {
      const ind = m.el.querySelector<HTMLElement>(".nc-ind");
      const state = m.ids.some((id) => !this.buttons.has(id) && this.important(id)) ? "important" : "";
      if (ind && ind.dataset.state !== state) ind.dataset.state = state;
      // newActivityFill (DUSKY_ORANGE, padBottom 1): 0.4 while the node's own new activity lasts (a group has none)
      const own = m.sub && m.ids.length === 1 && !this.buttons.has(m.ids[0]!) ? this.blinks.get(m.ids[0]!) : undefined;
      m.el.classList.toggle("nc-pe-new", !!own && Date.now() < own.newUntil);
    }
  }
  /** ButtonSkills (skillsBtn): its gauges and its icon. */
  private readonly skills = document.createElement("button");
  private skillState: NeocomSkillState = null;
  private skillAnimating = false;
  private planRatio: number | null = null;
  /**
   * SkillGauge.PlayCompletionAnimation (OnSkillLevelsTrained): the skill ring and its checkmark - scaled to 0.7 and faded
   * out over 0.3 s; LEAFY_GREEN, full size again, the arc's start 1 -> 0 over 0.4 s and its end 1 -> 0 from 0.2 s over
   * 0.4 s (a sweep round and away); 0.3 s on the ring whole, scaled 0.7 -> 1 (ANIM_OVERSHOT, 0.4 s); the checkmark
   * (checkmark.png 42 x 37) masked and faded in over 0.3 s; 1 s held; all faded out over 0.3 s, the checkmark gone, the
   * ring CRYO_BLUE on its value again, faded in over 0.6 s.
   */
  playSkillCompletion(): void { this.playGaugeCompletion("skill"); }
  /** SkillPlanGauge._PlayCompletionAnimation (OnTrackedSkillPlanCompleted): 0.15 s, then BaseGauge's, in COPPER_OXIDE_GREEN, no checkmark. */
  playPlanCompletion(): void { setTimeout(() => this.playGaugeCompletion("plan"), 150); }
  private readonly gaugeAnimating = new Set<string>();
  private playGaugeCompletion(which: "skill" | "plan"): void {
    const ring = this.skills.querySelector<SVGCircleElement>(which === "skill" ? ".nc-sk-skill" : ".nc-sk-plan");
    if (!ring || this.gaugeAnimating.has(which)) return;
    this.gaugeAnimating.add(which);
    if (which === "skill") this.skillAnimating = true;
    const C = 2 * Math.PI * (which === "skill" ? 11 : 18);
    const withCheck = which === "skill";
    let check = this.skills.querySelector<HTMLImageElement>(".nc-sk-check");
    if (!check) {
      check = document.createElement("img");
      check.className = "nc-sk-check";
      check.alt = "";
      check.src = clientTexture("res:/UI/Texture/classes/Skills/checkmark.png");
      this.skills.append(check);
    }
    const ck = check;
    Object.assign(ring.style, { transformBox: "fill-box", transformOrigin: "center" });
    const arc = (start: number, end: number) => { ring.style.strokeDasharray = `${Math.max(0, end - start) * C} 1000`; ring.style.strokeDashoffset = `${-start * C}`; };
    const ease = "cubic-bezier(0.3333, 0, 0.6667, 1)";
    ring.animate([{ transform: "scale(1)", opacity: 1 }, { transform: "scale(0.7)", opacity: 0 }], { duration: 300, easing: ease, fill: "forwards" });
    setTimeout(() => {
      for (const a of ring.getAnimations()) a.cancel();
      ring.style.stroke = which === "skill" ? "rgb(141, 193, 105)" : "rgb(65, 89, 49)";
      ring.style.opacity = "1";
      arc(1, 1);
      const t0 = performance.now();
      const step = () => {
        const t = (performance.now() - t0) / 1000;
        const start = 1 - Math.min(1, t / 0.4), end = 1 - Math.min(1, Math.max(0, t - 0.2) / 0.4);
        arc(start, end);
        if (t < 0.6) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      setTimeout(() => {
        arc(0, 1);
        ring.animate([{ transform: "scale(0.7)" }, { transform: "scale(1)" }], { duration: 400, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" });
        setTimeout(() => {
          if (withCheck) ck.animate([{ opacity: 0, clipPath: "inset(0 100% 0 0)" }, { opacity: 1, clipPath: "inset(0 0 0 0)" }], { duration: 300, easing: ease, fill: "forwards" });
          setTimeout(() => {
            ring.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, easing: ease, fill: "forwards" });
            ck.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, easing: ease, fill: "forwards" });
            setTimeout(() => {
              for (const a of [...ring.getAnimations(), ...ck.getAnimations()]) a.cancel();
              ck.style.opacity = "0";
              ring.style.stroke = "";
              ring.style.strokeDashoffset = "";
              ring.style.opacity = "";
              this.gaugeAnimating.delete(which);
              if (which === "skill") this.skillAnimating = false;
              this.setSkills(this.skillState, this.planRatio);
              ring.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 600, easing: ease });
            }, 300);
          }, 1300);
        }, 400);
      }, 900);
    }, 300);
  }
  /** What the Skills tooltip shows of the skill in training, read as the tooltip opens. */
  skillTip: (() => Promise<SkillTrainingTip | null>) | null = null;
  /** The EVE menu's panels, on the page's body. */
  private menuParts: HTMLElement[] = [];
  /** Takes the EVE menu's panels off the page. */
  dispose(): void { for (const el of this.menuParts) el.remove(); if (this.pulseTimer) clearInterval(this.pulseTimer); }
  private indicator(id: string): HTMLElement {
    const ind = document.createElement("span");
    ind.className = "nc-ind";
    this.indicators.set(id, ind);
    return ind;
  }
  /** The portrait the character sheet button shows (photo.GetPortrait), or none while the pilot is not known. */
  /**
   * ButtonIndicator.SetHighlightState for the windows the buttons open: HighlightState.open (the window there, a
   * 2 x 8 SILVER_GREY bar) or active (the window in front, 2 x 16 THEME_ACCENT); none otherwise.
   */
  setWindowStates(states: ReadonlyMap<string, "open" | "active">): void {
    this.windowStates = states;
    // a window brought up ends its button's blink (the client's CheckContinueBlinking on opening it)
    for (const [id, st] of states) if (st === "active" && this.blinks.has(id)) this.blinks.delete(id);
    this.paintIndicators();
  }
  /**
   * ButtonSkills._UpdateGaugesAndIcon: in training, the black bgGauge (12 wide, 0.6) under a TUNGSTEN_GREY 0.1 skill
   * plan ring (no plan tracked: full) and the level's progress in CRYO_BLUE inside it, no icon; not training, the plan
   * ring full in THEME_ALERT at 0.6 round warningIcon.png (pauseIcon.png when every training slot is used - not read
   * here). Radii from the 48 button: 20 for the plan and bg rings, 13 for the skill ring (UpdateGaugeRadius); the
   * DonutSegment line lies inside its radius, starting at the top, clockwise.
   */
  setSkills(state: NeocomSkillState, planRatio: number | null = null): void {
    this.skillState = state;
    this.planRatio = planRatio;
    const el = this.skills;
    el.dataset.state = state === null ? "" : state.training ? "training" : "idle";
    const ring = el.querySelector<SVGCircleElement>(".nc-sk-skill");
    if (ring && !this.skillAnimating) ring.style.strokeDasharray = `${(state?.training ? state.progress : 0) * 2 * Math.PI * 11} 1000`;
    // _UpdateSkillPlanGauge: a skill in training and a plan tracked - the plan ring is GetProgressRatio of it in
    // TUNGSTEN_GREY (additive); otherwise full (TUNGSTEN_GREY 0.1 training, THEME_ALERT 0.6 idle)
    const plan = el.querySelector<SVGCircleElement>(".nc-sk-plan");
    const tracked = !!state?.training && planRatio !== null;
    el.dataset.plan = tracked ? "tracked" : "";
    if (plan && !this.gaugeAnimating.has("plan")) plan.style.strokeDasharray = tracked ? `${Math.max(0, Math.min(1, planRatio as number)) * 2 * Math.PI * 18} 1000` : "";
  }
  setPortrait(url: string | null): void {
    if (url) this.portrait.src = url; else this.portrait.removeAttribute("src");
    this.portrait.style.visibility = url ? "" : "hidden";
  }

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
      el.innerHTML = `<img src="${iconUrl}" alt=""><span></span><span class="nc-ind"></span>`;
      el.querySelector("span")!.textContent = label;
      return el;
    };
    for (const g of EVE_MENU) {
      const el = entry(g.label, g.icon, true);
      this.menuEntries.push({ el, ids: g.items.flatMap((i) => (i.id ? [i.id] : [])), sub: false });
      const show = () => {
        sub.replaceChildren();
        this.menuEntries = this.menuEntries.filter((m) => !m.sub);
        for (const item of g.items) {
          const c = entry(item.label, item.icon, false);
          if (item.id) {
            const id = item.id;
            this.menuEntries.push({ el: c, ids: [id], sub: true });
            // PanelEntryBase.OnMouseExit: SetHasNewActivityOff, ClearBlinkHint, SetBlinkingOff
            c.addEventListener("mouseleave", () => { neocomTipOff(); if (!this.buttons.has(id) && this.blinks.delete(id)) this.paintIndicators(); });
            // PanelEntryBase.LoadTooltipPanel: the command tooltip and the blink hint in THEME_ALERT
            c.addEventListener("mouseenter", () => neocomTipOn(c, id, this.buttons.has(id) ? "" : this.blinks.get(id)?.hint ?? ""));
          }
          if (item.id === null) { c.disabled = true; c.title = "Not in the play page yet"; }
          else c.addEventListener("click", () => { close(); open(item.id!); });
          sub.appendChild(c);
        }
        this.paintIndicators();
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
    // ButtonCharacterIcon: first under the EVE button (the live client, gridcheck g250: charSheetBtn at 48, its charPic
    // 48 x 48, OpenCharactersheet); ButtonSkills follows it
    const sheet = document.createElement("button");
    sheet.className = "nc-btn nc-portrait";
    sheet.setAttribute("aria-label", "Character Sheet");
    this.portrait.alt = "";
    this.portrait.style.visibility = "hidden";
    sheet.append(this.portrait, this.indicator("charactersheet"));
    sheet.addEventListener("click", () => { neocomTipOff(); open("charactersheet"); });
    sheet.addEventListener("mouseenter", () => neocomTipOn(sheet, "charactersheet"));
    sheet.addEventListener("mouseleave", neocomTipOff);
    list.appendChild(sheet);
    // ButtonSkills: under the portrait (the live client, gridcheck g265: skillsBtn at 96, 48 x 48, OpenSkillsWindow)
    const skills = this.skills;
    skills.className = "nc-btn nc-skills";
    skills.setAttribute("aria-label", "Skills");
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 48 48");
    svg.setAttribute("class", "nc-sk-gauges");
    for (const [cls, r, w] of [["nc-sk-bg", 14, 12], ["nc-sk-plan", 18, 4], ["nc-sk-skill", 11, 4]] as const) {
      const c = document.createElementNS(svgNS, "circle");
      c.setAttribute("class", cls);
      c.setAttribute("cx", "24"); c.setAttribute("cy", "24"); c.setAttribute("r", String(r));
      c.setAttribute("stroke-width", String(w));
      c.setAttribute("transform", "rotate(-90 24 24)");
      svg.append(c);
    }
    const warn = document.createElement("img");
    warn.className = "nc-sk-icon";
    warn.alt = "";
    warn.src = clientTexture("res:/UI/Texture/classes/Skills/warningIcon.png");
    skills.append(svg, warn, this.indicator("skills"));
    this.setSkills(null);
    skills.addEventListener("click", () => { neocomTipOff(); open("skills"); });
    // ButtonSkillsTooltipPanel (LoadStandardSpacingOld, cells 8 apart): AddLabelShortcut(Skills, OpenSkillsWindow), then
    // with no skill in training UI/Neocom/NoSkillHint in THEME_ALERT and NoSkillHintSubtext (the live client, gridcheck
    // g266: 282 x 102, the lines at 16 / 42 / 68). In training it goes on to the tracked plan's gauge, Skill in Training,
    // the skill bar with the time left and the skill's description - not on the page yet: the label row alone.
    skills.addEventListener("mouseenter", () => tooltipDue(skills, () => {
      // a skill in training: ButtonSkillsTooltipPanel's own rows (the page's data through skillTip)
      // (the queue not known yet, as right after the page loads: asked too, the label alone only where it has none)
      if ((this.skillState === null || this.skillState.training) && this.skillTip) {
        const ask = this.skillTip;
        void ask().then((t) => {
          if (!skills.matches(":hover")) return;
          if (t) showSkillTrainingTooltip(skills, "Skills", shortcutOf("OpenSkillsWindow"), t);
          else showPlain();
        }).catch(() => showPlain());
        return;
      }
      showPlain();
    }));
    const showPlain = () => {
      const idle = this.skillState !== null && !this.skillState.training;
      showLabelShortcutTooltip(skills, "Skills", shortcutOf("OpenSkillsWindow"), idle
        ? [{ text: "You have no skills in training!", color: "rgb(243, 144, 88)" }, "Click to find Skill Plans or Skills to train"] : [], "left", true);
    };
    skills.addEventListener("mouseleave", neocomTipOff);
    list.appendChild(skills);
    for (const b of NEOCOM_DEFAULT) {
      const el = document.createElement("button");
      el.className = "nc-btn";
      el.setAttribute("aria-label", b.label);
      el.innerHTML = `<img src="${b.icon}" alt="">`;
      el.append(this.indicator(b.id));
      this.buttons.set(b.id, el);
      el.addEventListener("click", () => { neocomTipOff(); open(b.id); });
      el.addEventListener("mouseenter", () => {
        const bl = this.blinks.get(b.id);
        // GetBlinkHint: the blink hint, then the unseen items' hint under it
        neocomTipOn(el, b.id, [bl?.hint ?? "", this.unseen.get(b.id) ?? ""].filter(Boolean).join("\n"));
        if (bl) { bl.left = 0; bl.newUntil = 0; this.paintIndicators(); }
      });
      el.addEventListener("mouseleave", () => {
        neocomTipOff();
        const bl = this.blinks.get(b.id);
        if (bl) { bl.hint = ""; if (!this.important(b.id)) this.blinks.delete(b.id); this.paintIndicators(); }
      });
      list.appendChild(el);
    }
    // fixedButtonCont (the live client, g291): over the clock, between two 1 px lines in white 0.2 - AURA guidance, Daily
    // Login Campaigns (gift.png) and the Aurum store; here the one the page has a window for. Under it the 30 high
    // ResourceLoadingIndicator's place.
    // NeocomContainer.CheckOverflow: the buttons whose foot passes the button container's height hidden, and then the
    // OverflowButton (20 high, padBottom 1, over the fixed buttons: caret_right 16 in SILVER_GREY, white under the
    // mouse) shown; a click (SOUND_BUTTON_CLICK) toggles PanelOverflow beside it - a PanelGroup of the hidden buttons
    const overflow = document.createElement("button");
    overflow.className = "nc-overflow";
    overflow.setAttribute("aria-label", "More");
    overflow.hidden = true;
    overflow.innerHTML = `<img src="${clientTexture("res:/UI/Texture/eveicon/system_icons/caret_right_16px.png")}" alt="">`;
    const panel = document.createElement("div");
    panel.className = "eve-menu-sub nc-overflow-panel";
    panel.hidden = true;
    document.body.appendChild(panel);
    this.menuParts.push(panel);
    const defaults = new Map(NEOCOM_DEFAULT.map((b) => [b.id, b]));
    const check = () => {
      const listEl = list as HTMLElement;
      const h = listEl.clientHeight;
      const hidden: string[] = [];
      for (const [id, el] of this.buttons) {
        if (!defaults.has(id) || el.parentElement !== listEl) continue;
        const out = el.offsetTop - listEl.offsetTop + el.offsetHeight > h + 0.5;
        el.style.visibility = out ? "hidden" : "";
        if (out) hidden.push(id);
      }
      overflow.hidden = hidden.length === 0;
      this.overflowIDs = hidden;
      if (!hidden.length) panel.hidden = true;
    };
    overflow.addEventListener("click", (e) => {
      e.stopPropagation();
      void playUiEvent("ui_button_soft4_play");
      if (!panel.hidden) { panel.hidden = true; return; }
      panel.replaceChildren();
      for (const id of this.overflowIDs) {
        const b = defaults.get(id)!;
        const c = document.createElement("button");
        c.className = "eve-menu-entry";
        c.innerHTML = `<img src="${b.icon}" alt=""><span></span>`;
        c.querySelector("span")!.textContent = b.label;
        c.addEventListener("click", () => { panel.hidden = true; open(id); });
        panel.appendChild(c);
      }
      const r = overflow.getBoundingClientRect();
      panel.style.left = `${r.right}px`;
      panel.hidden = false;
      panel.style.top = `${Math.max(0, r.bottom - panel.getBoundingClientRect().height)}px`;
    });
    document.addEventListener("click", () => { panel.hidden = true; });
    new ResizeObserver(check).observe(list as HTMLElement);
    requestAnimationFrame(check);
    const fixed = document.createElement("div");
    fixed.className = "nc-fixed";
    const rewards = document.createElement("button");
    rewards.className = "nc-btn";
    rewards.setAttribute("aria-label", "Daily Login Campaigns");
    rewards.innerHTML = `<img src="${icon("gift")}" alt="">`;
    rewards.append(this.indicator("loginRewards"));
    this.buttons.set("loginRewards", rewards);
    rewards.addEventListener("click", () => { neocomTipOff(); open("loginRewards"); });
    // ButtonReward.LoadTooltipPanel replaces the base one: its label and description only, no blink / unseen hint
    rewards.addEventListener("mouseenter", () => neocomTipOn(rewards, "loginRewards"));
    rewards.addEventListener("mouseleave", neocomTipOff);
    fixed.append(rewards);
    const loading = document.createElement("div");
    loading.className = "nc-loading";
    this.root.append(overflow, fixed, loading);
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
    // ClockButton (a WrapperButton): OnMouseEnter SOUND_BUTTON_HOVER and the hover fill (play.css)
    this.clock.addEventListener("mouseenter", () => { void playUiEvent("ui_button_soft1_play"); tooltipDue(this.clock, clockTip); });
    this.clock.addEventListener("mouseleave", neocomTipOff);
    // ClockButton.OnClick: PlaySound(SOUND_BUTTON_CLICK), then OpenCalendar
    this.clock.addEventListener("click", () => { neocomTipOff(); void playUiEvent("ui_button_soft4_play"); open("calendar"); });
    const tick = () => {
      const d = new Date();
      this.clock.textContent = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
    };
    tick();
    setInterval(tick, 10_000);
  }
}
