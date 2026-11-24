// The client's context menu (carbonui/control/contextMenu: ContextMenu, MenuEntryView), as a right-click opens it on
// something in space, a bracket or an overview row. Measured on the 3698585 client through gridcheck: an 8 px
// MenuUnderlay (the blurred scene tinted (0.024, 0.039, 0.047), framed by 1_16_193 at white 0.1); entries 22 px high,
// their 16 px icon at 4, their TextBody at 28 (14 px, white 0.75), a submenu's arrow (1_16_14) at the right; dividers
// 13 px with a white 0.1 line; Show Info's icon an info glyph on a FOCUS_BLUE disc. In the page's top layer.

import { clientTexture } from "../ui/skillGroupIcons.ts";

export interface ContextEntry {
  readonly label: string;
  /** The menu label's path (MenuLabel), which the Selected Item's buttons look for (_GetValidActionsByName). */
  readonly path?: string;
  /** A res: path, or null for none. */
  readonly icon?: string | null;
  /** Show Info's own icon (classes/Menu/Icons/info.png on circleBG in FOCUS_BLUE). */
  readonly info?: boolean;
  readonly run?: () => void;
  readonly sub?: readonly (ContextEntry | null)[];
  /** Why it cannot run, shown greyed with this hint (menuEntries.reasonsWhyNotAvailable). */
  readonly disabled?: string | null;
  /** A radio entry (MenuEntryDataRadioButton): true for the chosen one, false for the others. */
  readonly checked?: boolean;
  /** With `checked`, a checkbox (MenuEntryDataCheckbox) rather than a radio entry. */
  readonly checkbox?: boolean;
  /** The entry's hint, shown on hover. */
  readonly hint?: string | null;
  /** The label's colour (a <color> tag over the whole text: the home station's CRYO_BLUE, an unavailable gate's DANGER_RED). */
  readonly color?: string;
  /** A coloured part after the label (eveformat.solar_system_security_status: the security in its class's colour). */
  readonly suffix?: { readonly text: string; readonly color: string };
  /** A caption (MenuData.AddCaption): a heading among the entries, not to be clicked. */
  readonly caption?: boolean;
}

/**
 * actionConst.ICON_BY_ACTIONID (3698585): a menu entry's icon by its label path, as MenuEntryData.GetIcon gives it when the
 * entry names none (MENU_ICON_BLACKLIST - Look At, Reset Camera, Set as Camera Interest - left out; Show Info drawn by
 * its own look, info). The eveicon at 16, in its folder.
 */
const ICON_BY_ACTIONID: Readonly<Record<string, string>> = {
  "UI/Inflight/ApproachObject": "control_icons/approach",
  "UI/Inflight/AlignTo": "control_icons/align_to",
  "UI/Inflight/OrbitObject": "control_icons/orbit",
  "UI/Inflight/Submenus/KeepAtRange": "control_icons/keep_at_distance",
  "UI/Inflight/LockTarget": "control_icons/target",
  "UI/Inflight/UnlockTarget": "control_icons/target",
  "UI/Chat/StartConversation": "control_icons/start_conversation",
  "UI/Menusvc/OpenSovHubConfigWindow": "control_icons/settings_wheel",
  "UI/Commands/OpenCargo": "control_icons/open_cargo",
  "UI/PI/Common/AccessCustomOffice": "control_icons/open_cargo",
  "UI/OrbitalSkyhook/SkyhookWnd/AccessOrbitalSkyhookOffice": "control_icons/settings_wheel",
  "UI/Sovereignty/MercenaryDen/ConfigurationWindow/ConfigureMercenaryDen": "control_icons/settings_wheel",
  "UI/Sovereignty/SovHub/ReagentBay/DepositReagents": "control_icons/open_cargo",
  "UI/DustLink/OpenUpgradeHold": "control_icons/open_cargo",
  "UI/Inflight/SpaceComponents/ItemTrader/Access": "control_icons/open_cargo",
  "UI/Inflight/SpaceComponents/UnderConstruction/Access": "control_icons/open_cargo",
  "UI/PI/Common/ExitPlanetMode": "control_icons/exit_planet_view",
  "UI/Inflight/POS/AccessPOSRefinery": "control_icons/open_cargo",
  "UI/Inflight/POS/AccessPOSCompression": "control_icons/open_cargo",
  "UI/Inflight/POS/AccessPOSStrontiumBay": "control_icons/open_cargo",
  "UI/Inflight/POS/AccessPOSFuelBay": "control_icons/open_cargo",
  "UI/Inflight/POS/AccessPOSAmmo": "control_icons/open_cargo",
  "UI/Inflight/POS/AccessPOSCrystalStorage": "control_icons/open_cargo",
  "UI/Inflight/POS/AccessPOSStorage": "control_icons/open_cargo",
  "UI/Inflight/AccessHangarTransfer": "control_icons/open_cargo",
  "UI/Inflight/OpenMoonMaterialBay": "control_icons/retrieve",
  "UI/Inflight/POS/AccessPOSVessels": "control_icons/open_cargo",
  "UI/Commands/AccessBountyEscrow": "control_icons/open_cargo",
  "UI/Drones/EngageTarget": "control_icons/engage_target",
  "UI/Drones/MineWithDrone": "control_icons/engage_target",
  "UI/Drones/Salvage": "control_icons/salvage",
  "UI/Inflight/POS/AnchorObject": "control_icons/engage_target",
  "UI/Drones/ReturnDroneAndOrbit": "control_icons/return_and_orbit",
  "UI/Drones/ReturnDroneToBay": "control_icons/recall_drones",
  "UI/Drones/ScoopDroneToBay": "control_icons/recall_drones",
  "UI/Drones/LaunchDrones": "control_icons/launch_drones",
  "UI/Inflight/BoardShip": "control_icons/board",
  "UI/Inflight/BoardStructure": "control_icons/board",
  "UI/Inflight/DockInStation": "control_icons/dock",
  "UI/Inflight/Jump": "control_icons/jump_to",
  "UI/Inflight/JumpByShipcaster": "control_icons/jump_to",
  "UI/Inflight/JumpByShipcasterToSystem": "control_icons/jump_to",
  "UI/Inflight/JumpUsingBridge": "control_icons/jump_to",
  "UI/Inflight/EnterWormhole": "control_icons/jump_to",
  "UI/Inflight/ActivateGate": "control_icons/jump_to",
  "UI/Inflight/ActivateTraceGate": "control_icons/jump_to",
  "UI/Commands/ReadNews": "control_icons/view_billboard",
  "UI/Fleet/JumpThroughToSystem": "control_icons/jump_to",
  "UI/Fleet/JumpThrough": "control_icons/jump_to",
  "UI/PI/Common/ViewInPlanetMode": "control_icons/enter_planet_view",
  "UI/Inflight/WarpToMoonMiningPoint": "control_icons/warp_to_mining_point",
  "UI/Inflight/WarpToWithinDistance": "control_icons/warp_to",
  "UI/Inflight/Submenus/WarpToWithin": "control_icons/warp_to",
  "UI/Inventory/ItemActions/MakeShipActive": "control_icons/board",
  "UI/Chat/StartConversationAgent": "control_icons/start_conversation",
  "UI/Inflight/SetDestination": "system_icons/set_destination",
  "UI/Inventory/ItemActions/ViewTypesMarketDetails": "system_icons/market_details",
  "UI/Inflight/SpaceComponents/TowGameObjective/startTowing": "control_icons/tow",
  "UI/Inflight/SpaceComponents/TowGameObjective/stopTowing": "control_icons/tow",
  "UI/Inflight/OpenSelectedCargoContainer": "control_icons/open_cargo",
};
/** The icon a menu entry with this label path takes where it names none of its own. */
export function actionIcon(path: string | undefined): string | null {
  const n = path ? ICON_BY_ACTIONID[path] : undefined;
  return n ? `res:/UI/Texture/eveicon/${n}_16px.png` : null;
}

/**
 * menuUtil.menuGroupsFromCaption's DESTRUCTIVEGROUP and RAGEQUITGROUP entries (3698585): their group badge drawn in
 * the icon's place, ahead of any icon (MenuEntryView.CheckConstructIcon: HasGroupIcon first) - ICON_DATA_BY_MENUGROUPID:
 * exclamationMark.png over circleBG in WARNING_ORANGE, or over triangleBG in HOT_RED.
 */
const DESTRUCTIVE_PATHS: ReadonlySet<string> = new Set(["UI/Inflight/AbandonAllCargo","UI/Inflight/AbandonAllWrecks","UI/Inflight/AbandonCargo","UI/Drones/AbandonDrone","UI/Inflight/AbandonWreack","UI/Inventory/Fighters/AbandonFighter","UI/Accessories/Calculator/Clear","UI/Inflight/Scanner/ClearAllIgnoredResults","UI/Map/Navigation/menuClearWaypoints","UI/Fitting/ClearGroup","UI/Inflight/Scanner/ClearIgnoredResult","UI/Inflight/Scanner/ClearResult","UI/Map/Navigation/menuClearRoute","/Carbon/UI/Common/Close","UI/Mail/EmptyTrash","UI/CharacterSelection/RemoveFromBiomass","UI/Generic/RemoveItem","UI/Notepad/RemoveNote","UI/Agents/Commands/RemoveOffer","UI/Inventory/ItemActions/Repackage","UI/Chat/ReportIskSpammer","UI/Corporations/Assets/TrashItemsAtLocation","UI/Chat/ChannelWindow/UnsubscribeFromList","UI/Inventory/ItemActions/Jettison","UI/Fleet/Ranks/Boss","UI/Inflight/JumpToFleetMember","UI/Fleet/ConduitJumpToFleetMember","UI/Inventory/ItemActions/LaunchShip","UI/Inventory/ItemActions/LaunchShipFromBay","UI/Inventory/ItemActions/LaunchForCorp","UI/Inventory/ItemActions/LaunchForSelf","UI/Commands/UndockFromStation","UI/Inventory/ItemActions/StripFitting","UI/InfoWindow/ReportBot","UI/Corporations/CorpApplications/WithdrawApplication","UI/CharacterSheet/CharacterSheetWindow/JumpCloneScroll/Destroy","UI/Chat/ClearAllContent","UI/Inflight/SafeLogoff","UI/Inflight/ModuleRacks/PutModuleOffline","UI/AclBookmarks/DeleteBookmarkFolder","UI/AclBookmarks/ForgetBookmarkFolder","UI/AclBookmarks/DeleteSubfolder","UI/Overview/DeleteTab","UI/Overview/DeletePreset","UI/Inflight/RemoveWaypoint","UI/Sovereignty/SovHub/TransitionToSovHub","UI/Fleet/KickFleetMember"]);
const RAGEQUIT_PATHS: ReadonlySet<string> = new Set(["UI/CharacterSelection/CompleteTermination","UI/Fleet/MakeFleetLeader","UI/PeopleAndPlaces/DeleteNotification","UI/Notepad/DeleteNote","UI/Chat/ChannelWindow/DeleteChannel","UI/Mail/Delete","/Carbon/UI/Controls/ScrollEntries/DeleteFolder","UI/Commands/DeleteGroup","UI/Chat/ChannelWindow/DeleteList","UI/Mail/DeleteMailingList","UI/Mail/Notifications/DeleteAll","UI/Common/Delete","UI/Contracts/ContractEntry/Delete","UI/Contracts/ContractEntry/DeleteMultipleContracts","UI/Contracts/ContractEntry/Dismiss","UI/Corporations/Common/ExpelCorpMember","UI/Inflight/PutStructureOffline","UI/Corporations/Common/QuitCorp","UI/Inflight/POS/RelinquishPOSControl","UI/Commands/Remove","UI/Fleet/FleetWindow/RemoveAdvert","UI/Inflight/MoonMining/Processes/RemoveConnection","UI/Inventory/ItemActions/RemoveTypeFromMarketQuickbar","UI/Fleet/RemovePilotFromWatchlist","UI/Inventory/ItemActions/Reprocess","UI/Corporations/Common/ResignAsCEO","UI/Inflight/SelfDestructShipOrPod","UI/Inflight/AbortSelfDestruct","UI/CharacterSelection/Terminate","UI/Mail/Trash","UI/Mail/TrashAll","UI/Inventory/ItemActions/TrashIt","UI/Inflight/UnanchorObject","UI/Inflight/POS/UnanchorStructure","UI/Control/Entries/ImplantUnplug","UI/Inflight/EjectFromShip","UI/Contracts/BreakContract","Remove from Selection","UI/Crimewatch/Duel/DuelMenuEntry","UI/StructureBrowser/DeleteProfile","UI/HelpPointers/Wnd/DeleteGroup","UI/CharacterSheet/CharacterSheetWindow/ExpertSystems/RemoveExpertSystem","UI/Commands/CmdUnlockTargetItems","UI/Fleet/Watchlist/ClearWatchList","/Carbon/UI/Controls/Common/ClearHistory","UI/Fitting/FittingWindow/FittingManagement/DeleteFitting","UI/Fleet/LeaveMyFleet","UI/Fleet/DisbandFleet","UI/Inflight/RemoveBookmark"]);
function groupBadge(path: string | undefined): { readonly bg: string; readonly color: string } | null {
  if (!path) return null;
  if (DESTRUCTIVE_PATHS.has(path)) return { bg: "res:/UI/Texture/classes/Menu/Icons/circleBG.png", color: "rgb(243, 144, 88)" };
  if (RAGEQUIT_PATHS.has(path)) return { bg: "res:/UI/Texture/classes/Menu/Icons/triangleBG.png", color: "rgb(255, 69, 75)" };
  return null;
}

const ROW = 22;
// the menu's art loaded with the page, so a first menu has its icons
for (const p of ["res:/UI/Texture/Icons/1_16_14.png", "res:/UI/Texture/classes/Menu/Icons/info.png", ...["approach", "orbit", "keep_at_distance", "warp_to", "align_to", "dock", "jump_to", "target", "enter_planet_view"].map((n) => `res:/UI/Texture/eveicon/control_icons/${n}_16px.png`), "res:/UI/Texture/eveicon/system_icons/set_destination_16px.png"]) {
  if (typeof Image !== "undefined") new Image().src = clientTexture(p);
}
const tex = (path: string) => clientTexture(path);

export class ContextMenu {
  private readonly panels: HTMLDivElement[] = [];
  private readonly onDown = (e: MouseEvent) => {
    if (!this.panels.some((p) => p.contains(e.target as Node))) this.close();
  };
  private readonly onKey = (e: KeyboardEvent) => { if (e.key === "Escape") this.close(); };

  get isOpen(): boolean { return this.panels.length > 0; }

  /** What the open menu says, entry by entry ("---" a divider), for checks. */
  get text(): string[] {
    return this.panels[0] ? [...this.panels[0].querySelectorAll<HTMLElement>("[data-entry], [data-divider]")].map((el) => (el.dataset.divider !== undefined ? "---" : el.dataset.entry ?? "")) : [];
  }

  open(x: number, y: number, entries: readonly (ContextEntry | null)[]): void {
    this.close();
    const panel = this.panel(entries, 0);
    this.place(panel, x, y);
    document.addEventListener("mousedown", this.onDown, true);
    document.addEventListener("keydown", this.onKey, true);
  }

  close(): void {
    for (const p of this.panels.splice(0)) p.remove();
    document.removeEventListener("mousedown", this.onDown, true);
    document.removeEventListener("keydown", this.onKey, true);
  }

  private closeFrom(depth: number): void {
    for (const p of this.panels.splice(depth)) p.remove();
  }

  /** MenuUtil's placing: at the cursor, kept on screen (flipped left or up where it would run off). */
  private place(panel: HTMLDivElement, x: number, y: number, flipFrom?: number): void {
    const w = panel.offsetWidth, h = panel.offsetHeight;
    let left = x, top = y;
    if (left + w > innerWidth) left = flipFrom !== undefined ? flipFrom - w : innerWidth - w;
    if (top + h > innerHeight) top = Math.max(0, innerHeight - h);
    panel.style.left = `${Math.max(0, Math.round(left))}px`;
    panel.style.top = `${Math.max(0, Math.round(top))}px`;
  }

  private panel(entries: readonly (ContextEntry | null)[], depth: number): HTMLDivElement {
    const panel = document.createElement("div");
    panel.className = "eve-context-menu";
    Object.assign(panel.style, {
      position: "fixed", zIndex: "100001", padding: "8px", minWidth: "160px", boxSizing: "border-box",
      background: "rgba(6,10,12,0.92)", backdropFilter: "blur(8px)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.1)",
      font: "14px 'EVE Sans Neue','Segoe UI',sans-serif", color: "rgba(255,255,255,0.75)", userSelect: "none", whiteSpace: "nowrap",
    } as Partial<CSSStyleDeclaration>);
    // dividers collapse: none leading, trailing or doubled (MenuList)
    const tidy: (ContextEntry | null)[] = [];
    for (const e of entries) {
      if (e === null && (tidy.length === 0 || tidy[tidy.length - 1] === null)) continue;
      tidy.push(e);
    }
    while (tidy.length && tidy[tidy.length - 1] === null) tidy.pop();
    // MenuData.HasIcons (any entry with an icon or a group badge): only then do the entries keep the icon's room - the
    // labels at PAD_LEFT 4 + the icon 16 + 8, else at PAD_LEFT 4 (the live client: an icon-less menu's labels at 12, g372)
    const hasIcons = tidy.some((e) => !!e && !e.caption && (!!e.info || !!e.icon || !!actionIcon(e.path) || !!groupBadge(e.path) || e.checked !== undefined));
    for (const entry of tidy) {
      if (entry === null) {
        const d = document.createElement("div");
        d.dataset.divider = "";
        Object.assign(d.style, { height: "13px", position: "relative" });
        const line = document.createElement("div");
        Object.assign(line.style, { position: "absolute", left: "0", right: "0", top: "6px", height: "1px", background: "rgba(255,255,255,0.1)" });
        d.append(line);
        panel.append(d);
        continue;
      }
      panel.append(this.row(entry, depth, hasIcons, panel.children.length === 0));
    }
    document.body.append(panel);
    this.panels[depth] = panel;
    return panel;
  }

  private row(entry: ContextEntry, depth: number, hasIcons = true, first = false): HTMLDivElement {
    const row = document.createElement("div");
    if (entry.caption) {
      row.dataset.caption = entry.label;
      row.textContent = entry.label;
      // MenuData.AddCaption's MenuEntryViewCaption (g373): a TextHeader 18 px in white 0.9 at PAD_LEFT 4; its text 23 below a
      // line before it, the entry after it 8 below (padTop 16, _GetHeight textheight + 8: 16 above / 8 below, g378)
      // (a first one: no padTop, _GetHeight textheight + 8 - a compact window's caption, its line, the first entry at 52, g377)
      Object.assign(row.style, { lineHeight: "23px", padding: first ? "0 0 8px 4px" : "16px 0 8px 4px", fontSize: "18px", color: "rgba(255,255,255,0.9)", cursor: "default", whiteSpace: "nowrap" });
      row.addEventListener("mouseenter", () => this.closeFrom(depth + 1));
      return row;
    }
    row.dataset.entry = entry.label;
    const disabled = !!entry.disabled;
    // (a check box or radio entry 24 high: MenuEntryViewCheckbox / MenuEntryViewRadioButton, g373)
    const rowH = entry.checked !== undefined ? 24 : ROW;
    Object.assign(row.style, { position: "relative", height: `${rowH}px`, lineHeight: `${rowH}px`,
      // MenuEntryView.GetRequiredWidth: the label from 28, 16 more for a submenu's arrow, and ContextMenu.UpdateSize's 8 after
      padding: `0 ${entry.sub ? 24 : 8}px 0 ${hasIcons ? 28 : 4}px`, cursor: disabled ? "default" : "pointer" });
    if (disabled) row.title = entry.disabled!;
    else if (entry.hint) row.title = entry.hint;
    const badge = entry.info ? null : groupBadge(entry.path);
    if (badge) {
      const holder = document.createElement("span");
      Object.assign(holder.style, { position: "absolute", left: "4px", top: "3px", width: "16px", height: "16px" });
      const bg = document.createElement("span");
      const mask = `url("${tex(badge.bg)}") center / 16px 16px no-repeat`;
      bg.setAttribute("style", `position:absolute;inset:0;background:${badge.color};mask:${mask};-webkit-mask:${mask};`);
      const i = document.createElement("img");
      i.src = tex("res:/UI/Texture/classes/Menu/Icons/exclamationMark.png");
      Object.assign(i.style, { position: "absolute", left: "0", top: "0", width: "16px", height: "16px" });
      holder.append(bg, i);
      row.append(holder);
    } else if (entry.info) {
      // SHOWINFOGROUP: info.png over circleBG (the texture, as the warning badges' backing) at full CRYO_BLUE (the 0.75
      // sprite is the glow pass, g333 / g411)
      const disc = document.createElement("span");
      Object.assign(disc.style, { position: "absolute", left: "4px", top: "3px", width: "16px", height: "16px" });
      const back = document.createElement("span");
      const m = `url("${tex("res:/UI/Texture/classes/Menu/Icons/circleBG.png")}") center / 16px 16px no-repeat`;
      back.setAttribute("style", `position:absolute;inset:0;background:rgb(88,167,191);mask:${m};-webkit-mask:${m};`);
      const i = document.createElement("img");
      i.src = tex("res:/UI/Texture/classes/Menu/Icons/info.png");
      Object.assign(i.style, { position: "absolute", left: "0", top: "0", width: "16px", height: "16px" });
      disc.append(back, i);
      row.append(disc);
    } else if (entry.checked !== undefined) {
      // the Checkbox / RadioButton controls (g374): their underlay (classes/checkbox/underlay.png, radio_underlay.png) white,
      // 16 px at the icon's place, 4 down; ticked, checked.png / radio_selected.png over it in CRYO_BLUE (0.35, 0.65, 0.75)
      const dot = document.createElement("span");
      Object.assign(dot.style, { position: "absolute", left: "4px", top: "4px", width: "16px", height: "16px" });
      const under = document.createElement("img");
      under.src = tex(entry.checkbox ? "res:/UI/Texture/classes/checkbox/underlay.png" : "res:/UI/Texture/classes/checkbox/radio_underlay.png");
      Object.assign(under.style, { position: "absolute", left: "0", top: "0", width: "16px", height: "16px" });
      dot.append(under);
      if (entry.checked) {
        const mark = document.createElement("span");
        const m = `url("${tex(entry.checkbox ? "res:/UI/Texture/classes/checkbox/checked.png" : "res:/UI/Texture/classes/checkbox/radio_selected.png")}") center / 16px 16px no-repeat`;
        mark.setAttribute("style", `position:absolute;inset:0;background:rgb(89,166,191);mask:${m};-webkit-mask:${m};`);
        dot.append(mark);
      }
      if (entry.checkbox) row.setAttribute("aria-checked", String(!!entry.checked));
      row.append(dot);
    } else if (entry.icon !== null && (entry.icon || actionIcon(entry.path))) {
      const i = document.createElement("img");
      i.src = tex(entry.icon || actionIcon(entry.path)!);
      Object.assign(i.style, { position: "absolute", left: "4px", top: "3px", width: "16px", height: "16px", opacity: "0.75" });
      row.append(i);
    }
    // BaseMenuEntryView / MenuEntryView.SetDisabled: the label grey (0.5, 0.5, 0.5) opaque, the icon (or group badge) at 0.5
    if (disabled) for (const c of [...row.children] as HTMLElement[]) c.style.opacity = "0.5";
    const label = document.createElement("span");
    label.textContent = entry.label;
    if (disabled) label.style.color = "rgb(128, 128, 128)";
    else if (entry.color) label.style.color = entry.color;
    if (entry.suffix) {
      const sfx = document.createElement("span");
      sfx.textContent = ` ${entry.suffix.text}`;
      sfx.style.color = entry.suffix.color;
      label.append(sfx);
    }
    row.append(label);
    if (entry.sub) {
      const arrow = document.createElement("img");
      arrow.src = tex("res:/UI/Texture/Icons/1_16_14.png");
      Object.assign(arrow.style, { position: "absolute", right: "0", top: "3px", width: "16px", height: "16px", opacity: "0.75" });
      row.append(arrow);
    }
    row.addEventListener("mouseenter", () => {
      // MenuEntryView.OnMouseEnter (g371): its MenuEntryUnderlay fill SMOKE_BLUE at 0.2, the label and icon to 0.9 (from 0.75)
      if (!disabled) {
        row.style.background = "rgba(48,86,101,0.2)";
        row.style.color = "rgba(255,255,255,0.9)";
        for (const i of row.querySelectorAll<HTMLImageElement>(":scope > img")) i.style.opacity = "0.9";
      }
      this.closeFrom(depth + 1);
      if (entry.sub && !disabled) {
        const r = row.getBoundingClientRect();
        const sub = this.panel(entry.sub, depth + 1);
        this.place(sub, r.right + 8, r.top - 8, r.left - 8);
      }
    });
    row.addEventListener("mouseleave", () => {
      row.style.background = "";
      row.style.color = "";
      for (const i of row.querySelectorAll<HTMLImageElement>(":scope > img")) i.style.opacity = "0.75";
    });
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      if (disabled || !entry.run) return;
      this.close();
      entry.run();
    });
    return row;
  }
}
