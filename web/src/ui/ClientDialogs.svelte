<script lang="ts">
  // A refusal the server names a dialog for, put up as the retail client puts up a UserError
  // (eve_exception_handler.handle_exception: prompt_player_fsd_dialog(exc.msg, exc.dict); player_messaging/client/
  // dialog_handler.py, _handle_player_fsd_dialog). The dialog's type in the install says how:
  //   info, infomodal, warning, question, error, fatal, windowhelp   a box (_prompt_player): the dialog's title, or the
  //                                                                type's own word where it has none
  //                                                                (TITLE_BY_DIALOG_TYPE), its body, and OK;
  //   notify, hint, event                                          the passing strip (message_player, carbonui
  //                                                                QuickMessage): one, 300 wide at the top of the
  //                                                                middle, a newer one's text in its place, gone after
  //                                                                five seconds, not to be clicked;
  //   any other                                                    nothing (an empty type, audio).
  // Where the install has not the dialog, or the page has no install to read, the known fallback presentation, else
  // a box with the page's own words. Each
  // pilot of the tab is a client of its own: one not in front is told all the same, and what it is told says which
  // pilot it is for (the page's own words, as the fleet invitation's). What is to be put up is the flow's
  // (dialogsSaid); a box is taken down by its OK, the strip by its time.
  //
  // A box whose dialog the install lets be kept has the client's checkbox (messagebox.py prompt_player, 158 to 168:
  // Do Not Show Again under OK alone, Do Not Ask Again under a question); answered with it ticked, the answer is kept
  // where the dialog lets that answer be kept, and the dialog is not put up again (dialog_handler.py, 59 to 64 and
  // _persist_prompt_suppress_choice, 126 to 132; bridge/dialogSuppression.ts).
  //
  // Not done: the dialog's icon, its sound (audio.AudioMessage), its line in the client's log (logger.AddMessage), the
  // strip's place with the HUD at the top and its being dragged, and the box's holding the rest of the client still
  // (is_modal) for a pilot not in front.
  import { onDestroy, tick, untrack } from "svelte";
  import { DO_NOT_ASK_AGAIN_LABEL, DO_NOT_SHOW_AGAIN_LABEL, answerKept, suppressKey } from "../bridge/dialogSuppression.ts";

  function focusDefault(node: HTMLButtonElement, question: number | null) {
    if (question !== null) node.focus();
    return { update(next: number | null) { if (next !== null) node.focus(); } };
  }
  import type { Session } from "../app/sessions.ts";
  import type { MultiBuyAsk, MultiBuyRow, SaidDialog } from "../app/flow.ts";
  import type { QuestionWords } from "../store/types.ts";
  import { resolvedName, type NameKind } from "../store/names.ts";
  import { formatTemplate, plainText, templateNameRefs } from "../bridge/clientWords.ts";
  import { romanLevel } from "../bridge/skills.ts";
  import NamePopup from "./NamePopup.svelte";
  import { changeQuickbar } from "./marketQuickbar.ts";
  import { addFolder, addType } from "../bridge/marketQuickbar.ts";
  import {
    DIALOG_TYPE_TITLES, INFORMATION_TITLE, NUMERIC_WORD_LABELS, OWN_DIALOG_TITLES, iskWords, questionMarkup, questionText, wordsLabels, wordsNameRefs,
    type ClientWording,
  } from "../bridge/questions.ts";
  import { labelEscaped } from "../bridge/labelMarkup.ts";
  import LabelText from "./LabelText.svelte";
  import { linkFollowerOf } from "./linkFollowers.ts";
  import { SHORT_INTERVAL_WORD_LABELS, intervalWriters } from "../bridge/timeInterval.ts";
  import { orderDelta, priceDelta } from "../bridge/market.ts";
  import { showMarketDetails } from "./marketDetails.ts";
  import { SKILL_BOOK_NOT_YET, SKILL_TRAINING_COMPLETE, skillGroupIcon } from "./skillGroupIcons.ts";
  import TypeIcon from "./TypeIcon.svelte";
  import RequiredSkillRow from "./RequiredSkillRow.svelte";
  import SkillTrainingAction from "./SkillTrainingAction.svelte";
  import { applyPointsButton, trainingTimeText, TYPE_ALPHA_TRAINING_INJECTOR, TYPE_SKILL_INJECTOR } from "./skillAction.ts";
  import { createSkillPlanButton } from "./skillPlanTemplate.ts";
  import { ROLE_GML, ROLE_WORLDMOD, sessionHasRole } from "../bridge/gmWrites.ts";
  import { CONTENTS_LABELS, RACK_EFFECTS, type FittingContentsGroup } from "../bridge/fittingContents.ts";
  import type { ViewFittingTypeMark } from "../app/flow.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { showInfo } from "./showInfo.ts";
  import { findInPersonalAssets } from "./assetsSearch.ts";
  import { findInContracts } from "./contractsSearch.ts";
  import { compareType } from "./typeCompare.ts";
  import { assetSearchTextForType } from "../bridge/assetSearch.ts";
  import { COMPARE_CATEGORIES } from "../bridge/dogmaAttributeGroups.ts";
  import { openFittingWindow } from "./fittingWindowTarget.ts";
  import { portal } from "./portal.ts";
  import { startFittingDrag } from "./fittingDrag.ts";
  import OwnerPicture from "./OwnerPicture.svelte";
  import MoneyTransferWindow from "./MoneyTransferWindow.svelte";
  import { portraitUrl, portraitDefaultPath } from "./ownerImages.ts";

  let { session, inFront }: { session: Session; inFront: boolean } = $props();
  // svelte-ignore state_referenced_locally
  const words = session.store.words;
  // svelte-ignore state_referenced_locally
  const names = session.store.names;
  // svelte-ignore state_referenced_locally
  const station = session.store.station;
  // svelte-ignore state_referenced_locally
  const flow = session.flow;
  // svelte-ignore state_referenced_locally
  const said = flow.dialogsSaid;
  // svelte-ignore state_referenced_locally
  const asked = flow.quantityAsked;
  // svelte-ignore state_referenced_locally
  const skillsRequired = flow.skillsRequired;
  // svelte-ignore state_referenced_locally
  const shipNameAsked = flow.shipNameAsked;
  const inventoryPasswordAsked = flow.inventoryPasswordAsked;
  // svelte-ignore state_referenced_locally
  const skillBooksAsked = flow.skillBooksAsked;
  // svelte-ignore state_referenced_locally
  const buyAllAsked = flow.buyAllAsked;
  // svelte-ignore state_referenced_locally
  const viewFittingsAsked = flow.viewFittingsAsked;
  // The types' facts its entries' menus go by (a market group, published, the category), as the fitting browser holds them.
  const hullBrowser = flow.hullBrowser;
  // svelte-ignore state_referenced_locally
  const multiFitAsked = flow.multiFitAsked;
  // svelte-ignore state_referenced_locally
  const progressWnd = flow.progressWnd;
  // svelte-ignore state_referenced_locally
  const corporationCEOChoice = flow.corporationCEOChoice;
  // svelte-ignore state_referenced_locally
  const corporationWalletChoice = flow.corporationWalletChoice;
  const corporationAwardAsk = flow.corporationAwardAsk;
  const moneyTransfer = flow.moneyTransfer;
  // svelte-ignore state_referenced_locally
  const imageServer = flow.imageServer;
  $effect(() => { if ($corporationCEOChoice !== null) flow.loadImageServer(); });
  // svelte-ignore state_referenced_locally
  const useFittingNameForShips = flow.useFittingNameForShips;
  // svelte-ignore state_referenced_locally
  const inventory = session.store.inventory;
  // The client's multifit window (fitting/multiFitWnd.py MultiFitWnd): its caption, the hull's icon (the fitting shown
  // on a click), the ships' name (20 letters at most), the hull's name, the equipment's place (the item hangar or one of
  // the pilot's own containers, by name), the count (one to GetMaxShipsToFit), the warnings (ships or equipment missing,
  // with what is missing and Buy All; a strategic cruiser's fitting that will not go), the two counts (the hangar's
  // packaged ships, the rounds of the fitting the place holds) in red where short of the count, each with what it lacks
  // and Buy All, the refresh, the rigs box where the fitting has rigs, Fit Ships (as many as can be) and Close, and the
  // count of ships fitted while it fits. Closed when the pilot undocks (OnSessionChanged). Its words are the install's;
  // the page's own stand in. Not done: the QA tools' Create Missing and GM buttons, and dragging the fitting out.
  const MULTIFIT_WORDS: Readonly<Record<string, string>> = {
    "UI/Fitting/FittingWindow/FittingManagement/MultiFitHeader": "Fit several ships",
    "UI/Fitting/ShowFitting": "Look at the fitting",
    "UI/Common/ShipName": "The ships' name",
    "UI/Fitting/FittingWindow/FittingManagement/EquipmentLocation": "Equipment from",
    "UI/Fitting/FittingWindow/FittingManagement/EquipmentLocationHint": "Where the modules and charges are taken from",
    "UI/Inventory/ItemHangar": "Item hangar",
    "UI/Fitting/FittingWindow/FittingManagement/NumShipsToFit": "Ships to fit",
    "UI/Fitting/FittingWindow/FittingManagement/MissingShipEquipment": "Ships or equipment are missing",
    "UI/Fitting/FittingWindow/FittingManagement/InvalidT3Fit": "This fitting cannot be put on its hull",
    "UI/Fitting/FittingWindow/FittingManagement/RefreshInventoryStatusHint": "Count again",
    "UI/Fitting/FittingWindow/FittingManagement/PackagedShipsInHangar": "Packaged ships in the hangar",
    "UI/Fitting/FittingWindow/FittingManagement/PackagedShipsInHangarHint": "",
    "UI/Fitting/FittingWindow/FittingManagement/RoundsOfFittingsInLocation": "Fittings' worth in {locationName}",
    "UI/Fitting/FittingWindow/FittingManagement/FitRigs": "Fit the rigs",
    "UI/Fitting/FittingWindow/FittingManagement/FitRigsHint": "",
    "UI/Fitting/FittingWindow/FittingManagement/FitShips": "Fit {numToFit} ships",
    "UI/Common/Close": "Close",
    "UI/Fitting/FittingWindow/FittingManagement/MissingItems": "Missing to fit {numToFit} of {fittingName}:",
    "UI/Fitting/FittingWindow/FittingManagement/MissingShips": "Ships missing to fit {numToFit} of {fittingName}:",
    "UI/Fitting/FittingWindow/FittingManagement/MissingEquipment": "Equipment missing to fit {numToFit} of {fittingName}:",
    "UI/Fitting/FittingWindow/FittingManagement/MoreItemTypesMissing": "and {numMoreItems} more",
    "UI/Market/MarketQuote/BuyAll": "Shop for all of it",
    // Said as the ships are fitted (flow.ts fitMultiFit): asked here, where they are fitted from.
    "UI/Fitting/MissingItems": "",
    "UI/Fitting/FittingWindow/FittingManagement/BadFitFittingFailed": "",
    "UI/Fitting/FittingWindow/FittingManagement/BusyFittingWarning": "",
  };
  $effect(() => {
    const fit = $multiFitAsked;
    if (fit === null) return;
    flow.requestWords(Object.keys(MULTIFIT_WORDS));
    flow.requestNames([
      { kind: "type" as const, id: fit.fitting.shipTypeID },
      ...fit.containers.flatMap((container) => [{ kind: "evelocation" as const, id: container.itemID }, { kind: "type" as const, id: container.typeID }]),
      ...(fit.status === null ? [] : [...fit.status.missingShips, ...fit.status.missingEquipment].map((each) => ({ kind: "type" as const, id: each.typeID }))),
    ]);
  });
  // MultiFitWnd.OnSessionChanged: the window closed when the pilot is no longer docked.
  $effect(() => {
    const fit = $multiFitAsked;
    if (fit !== null && $inventory.loaded && ($inventory.stationID ?? $inventory.structureID ?? null) === null) void flow.answerMultiFit(fit.n, "close");
  });
  /** A label of the multifit window, as plain text, with its arguments. */
  function fitWord(label: string, args: Readonly<Record<string, string | number>> = {}): string {
    return plainText(formatTemplate(wordOf(label, MULTIFIT_WORDS[label] ?? ""), args, { nameOf }));
  }
  /** A container's name in the place's list (cfg.evelocations' name, else its type's). */
  function containerName(container: { readonly itemID: number; readonly typeID: number }): string {
    const own = resolvedName($names.resolved, "evelocation", container.itemID, "");
    return own !== "" ? own : nameOf("type", container.typeID);
  }
  /** LoadCounterTooltip (472 to 492): what is missing, each type and how many, by name, ten at most and how many more. */
  function missingLines(missing: readonly { readonly typeID: number; readonly qty: number }[]): string[] {
    const sorted = missing.slice().sort((left, right) => {
      const a = nameOf("type", left.typeID).toLowerCase();
      const b = nameOf("type", right.typeID).toLowerCase();
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const lines = sorted.slice(0, 10).map((each) => `${each.qty}x ${nameOf("type", each.typeID)}`);
    if (sorted.length > 10) lines.push(fitWord("UI/Fitting/FittingWindow/FittingManagement/MoreItemTypesMissing", { numMoreItems: sorted.length - 10 }));
    return lines;
  }
  // The client's fitting display window (fittingMgmtWindow.ViewFitting, its FittingMgmtContInStandalone): its caption
  // (UI/Fitting/ShipFitting and the ship's type), the ship's icon and the fitting's name with its owner's kind, the
  // ship's info icon (Show Info on the hull), two tabs, the contents by heading (each slot kind under its effect's name,
  // each type "Nx" and its name with its icon, its marks and its info icon, FittingModuleEntry) and the description,
  // and Fit (disabled for a structure's), Save, Buy and Simulate: the name (40 letters at most, the client's field) and
  // the description (500, maxLengthFittingDescription) edited and saved for the pilot's own fitting. Its words are the
  // install's; the page's own stand in. Its header's menu has Open Multifit, docked, and Export to Clipboard (the
  // fitting as the client's text, its names English). Save, for any fitting, has its menu: Save for Alliance (the
  // executor corporation's), for Corporation and for the pilot; a fitting of another owner's is saved as a copy; and,
  // for one with the fitting manager's role, its tooltip of the same three. Its settings have Use Fitting Name for Ship
  // (the ship named after a fitting loaded on it). Not the page's: the ship's preview (the ship icon's click,
  // preview.PreviewType), which has no 3D view here. A fitting read from a link cut short has the truncated label; the
  // ship icon dragged is the fitting shown (FittingDraggableIcon2).
  const VIEW_FITTING_WORDS: Readonly<Record<string, string>> = {
    "UI/Fitting/ShipFitting": "Fitting",
    // Its header's menu (ViewFitting._AddCustomMenuOptions, 414 to 419).
    "UI/Fitting/FittingWindow/FittingManagement/OpenMultifit": "Fit several ships",
    "UI/Fitting/FittingWindow/FittingManagement/ExportToClipboard": "Copy it as text",
    "UI/Fitting/FittingWindow/FittingManagement/ExportToClipboardHint": "",
    "UI/Fitting/FittingWindow/FittingManagement/Fittings": "Contents",
    "UI/Common/Description": "About it",
    "UI/Fitting/FittingWindow/FittingManagement/Fit": "Fit this ship",
    "UI/Common/Buttons/Save": "Keep the changes",
    // Save's menu (fittingMgmtCont._get_save_sub_menu_data, 123 to 131).
    "UI/Fitting/FittingWindow/SaveForAlliance": "Keep it for the alliance",
    "UI/Fitting/FittingWindow/SaveForCorp": "Keep it for the corporation",
    "UI/Fitting/FittingWindow/SaveForCharacter": "Keep it for yourself",
    // Its settings (fittingMgmtCont.AddFittingNameElements, SettingMenu, 65 to 74 and 152 to 155).
    "UI/Common/Settings": "Settings",
    "UI/Fitting/FittingWindow/FittingManagement/UseFittingNameForShip": "Name the ship after the fitting loaded",
    "UI/Fitting/FittingWindow/FittingManagement/FittingName": "Name",
    "UI/Market/MarketQuote/CommandBuy": "Purchase",
    "UI/Fitting/FittingWindow/FittingManagement/PersonalFitting": "Your own fitting",
    "UI/Fitting/FittingWindow/FittingManagement/CorporationFitting": "Your corporation's fitting",
    // TryAddSimulationBtn.
    "UI/Fitting/FittingWindow/Simulate": "Try it out",
    // The truncated label (AddFittingNameElements).
    "UI/Fitting/FittingWindow/FittingManagement/Truncated": "Cut short: not all of it came",
    // Each entry's marks (FittingModuleEntry.Startup and Load, fitting.py 104 to 160) and its info icon.
    "UI/Control/Entries/FittingModuleSkillMissing": "You lack a skill it needs",
    "UI/Control/Entries/FittingModuleSkillOK": "You have the skills it needs",
    "UI/Fitting/TypeIsObsolete": "This is no longer made",
    "UI/Fitting/FittingWindow/FittingManagement/AbyssalModuleWarning": "A mutated module: the one bought may not be this one",
    // Each entry's menu (Item.GetMenu: menusvc.GetMenuFromItemIDTypeID(None, typeID, includeMarketDetails=True)).
    "UI/Commands/ShowInfo": "About it",
    "UI/Inventory/ItemActions/ViewTypesMarketDetails": "Its market",
    "UI/Inventory/ItemActions/FindInContracts": "Contracts of it",
    "UI/Inventory/ItemActions/FindPersonalAssets": "Where you have it",
    "UI/Inventory/AssetSearch/KeywordTypeExact": "typeExact",
    "UI/Compare/CompareButton": "Side by side",
    [CONTENTS_LABELS.charges]: "Ammunition",
    [CONTENTS_LABELS.ice]: "Fuel",
    [CONTENTS_LABELS.drones]: "Drones",
    [CONTENTS_LABELS.fighters]: "Fighters",
    [CONTENTS_LABELS.implants]: "Implants and boosters",
    [CONTENTS_LABELS.modules]: "Modules in the hold",
    [CONTENTS_LABELS.filaments]: "Filaments",
    [CONTENTS_LABELS.otherInCargo]: "Other things in the hold",
    [CONTENTS_LABELS.other]: "Everything else",
  };
  // Each display window's own (one for each fitting DisplayFitting was asked for with Shift held, and the one it
  // reloads), by its number: its tab, its menus, Save's tooltip panel (fittingMgmtCont.LoadSaveBtnTooltipPanel, 157 to
  // 180: on the pointer over Save, for a pilot with the fitting manager's role only, the same three as the menu), the
  // name and the description as edited, and where it has been dragged to from the middle, where a window opens
  // (Window.default_left and default_top, '__center__'). What is edited is set afresh with each fitting loaded into it
  // (ReloadWnd), and only then: its contents arriving leave what is being typed.
  interface ViewFittingState {
    tab: "contents" | "description";
    menuOpen: boolean;
    settingsOpen: boolean;
    saveMenuOpen: boolean;
    saveForAlliance: boolean;
    savePanelOpen: boolean;
    name: string;
    description: string;
    loaded: number;
    dx: number;
    dy: number;
  }
  let viewStates = $state<Record<number, ViewFittingState>>({});
  $effect(() => {
    const views = $viewFittingsAsked;
    const held = untrack(() => viewStates);
    const next: Record<number, ViewFittingState> = {};
    let changed = Object.keys(held).length !== views.length;
    for (const view of views) {
      const kept = held[view.n];
      if (kept !== undefined && kept.loaded === view.loaded) {
        next[view.n] = kept;
        continue;
      }
      changed = true;
      next[view.n] = {
        tab: kept?.tab ?? "contents", menuOpen: false, settingsOpen: false, saveMenuOpen: false, saveForAlliance: kept?.saveForAlliance ?? false,
        savePanelOpen: false, name: view.fitting.name, description: view.fitting.description, loaded: view.loaded, dx: kept?.dx ?? 0, dy: kept?.dy ?? 0,
      };
    }
    if (changed) viewStates = next;
  });
  function viewFittingSaveHovered(state: ViewFittingState): void {
    if (!flow.hasFittingManagerRole()) return;
    state.savePanelOpen = true;
    void flow.saveForAllianceOffered().then((offered) => (state.saveForAlliance = offered)).catch(() => {});
  }
  /** A display window moved by its caption, as a window is (the caption's buttons are its own). */
  function dragViewFitting(event: PointerEvent, state: ViewFittingState): void {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest("button, input, textarea, [role=menu]"))) return;
    event.preventDefault();
    const fromX = event.clientX - state.dx;
    const fromY = event.clientY - state.dy;
    const move = (moved: PointerEvent): void => {
      state.dx = moved.clientX - fromX;
      state.dy = moved.clientY - fromY;
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  $effect(() => {
    const views = $viewFittingsAsked;
    if (views.length === 0) return;
    flow.requestWords([...Object.keys(VIEW_FITTING_WORDS), ...views.flatMap((view) => Object.values(view.effectNames).flatMap((messageID) => (messageID === null ? [] : [`#${messageID}`])))]);
    flow.requestNames([
      ...views.map((view) => ({ kind: "type" as const, id: view.fitting.shipTypeID })),
      // SaveForCharacter names the pilot as an owner (charID).
      ...($station.online ? [{ kind: "owner" as const, id: $station.online.characterID }] : []),
      ...views.flatMap((view) => (view.contents ?? []).flatMap((group) => group.entries.map((entry) => ({ kind: "type" as const, id: entry.typeID })))),
    ]);
    const types = views.flatMap((view) => (view.contents ?? []).flatMap((group) => group.entries.map((entry) => entry.typeID)));
    if (types.length > 0) void flow.loadHullBrowser(types).catch(() => {});
  });
  /** InfoIcon's picture (infoIcon.py default_texturePath). */
  const VIEW_FITTING_INFO_ICON = clientTexture("res:/ui/Texture/Icons/38_16_208.png");
  // FittingModuleEntry's marks: 'ui_38_16_193' and 'ui_38_16_194' (the skills had or not), and the warning
  // (res:/ui/texture/icons/44_32_7.png, tinted 1.0, 0.1, 0.1 at 0.8).
  const VIEW_FITTING_SKILL_OK = clientTexture("res:/ui/texture/icons/38_16_193.png");
  const VIEW_FITTING_SKILL_MISSING = clientTexture("res:/ui/texture/icons/38_16_194.png");
  const VIEW_FITTING_WARNING = clientTexture("res:/ui/texture/icons/44_32_7.png");
  /**
   * An entry's mark (FittingModuleEntry.Load, 121 to 160): an obsolete type's warning with its error frame; else the
   * skills' mark (HasSkill: a rig in its slot always has them, godma.CheckSkillRequirementsForType for any other), and a
   * type under Other Items (isValidGroup false) framed as an error, or a dynamic one framed in orange with the Abyssal
   * module's warning in the skills' mark's place. None while the marks are read.
   */
  function viewFittingEntryMark(header: FittingContentsGroup["header"], typeID: number, marks: Readonly<Record<number, ViewFittingTypeMark>> | null):
    { readonly icon: string | null; readonly tinted: boolean; readonly hint: string; readonly frame: "error" | "dynamic" | null } {
    const mark = marks?.[typeID] ?? null;
    if (mark === null) return { icon: null, tinted: false, hint: "", frame: null };
    if (mark.obsolete) return { icon: VIEW_FITTING_WARNING, tinted: true, hint: viewWord("UI/Fitting/TypeIsObsolete"), frame: "error" };
    const hasSkill = "effectID" in header && header.effectID === RACK_EFFECTS.rigSlots ? true : mark.skillsMet;
    const icon = hasSkill === null ? null : hasSkill ? VIEW_FITTING_SKILL_OK : VIEW_FITTING_SKILL_MISSING;
    const hint = hasSkill === null ? "" : viewWord(hasSkill ? "UI/Control/Entries/FittingModuleSkillOK" : "UI/Control/Entries/FittingModuleSkillMissing");
    if ("label" in header && header.label === CONTENTS_LABELS.other) return { icon, tinted: false, hint, frame: "error" };
    if (mark.dynamic) return { icon: VIEW_FITTING_WARNING, tinted: true, hint: viewWord("UI/Fitting/FittingWindow/FittingManagement/AbyssalModuleWarning"), frame: "dynamic" };
    return { icon, tinted: false, hint, frame: null };
  }
  // An entry's menu on its right click (Item.GetMenu, item.py 80 to 95: GetMenuFromItemIDTypeID(None, typeID,
  // includeMarketDetails=True), menusvc.py 2281 to 2352): Show Info; View Market Details where the type has a market
  // group; Find in Contracts and Find Personal Assets where it is published; Compare for a category in compareCategories.
  // Not the page's: a GM's "GM / WM Extras".
  let viewFittingEntryMenu = $state<{ readonly typeID: number; readonly x: number; readonly y: number } | null>(null);
  function openViewFittingEntryMenu(typeID: number, event: MouseEvent): void {
    event.preventDefault();
    viewFittingEntryMenu = { typeID, x: event.clientX, y: event.clientY };
  }
  $effect(() => {
    if (viewFittingEntryMenu === null) return;
    const close = (event: Event): void => {
      if (!(event.target instanceof Element && event.target.closest(".view-fitting-entry-menu"))) viewFittingEntryMenu = null;
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape") viewFittingEntryMenu = null;
    };
    const timer = setTimeout(() => {
      window.addEventListener("pointerdown", close);
      window.addEventListener("keydown", key);
    });
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", key);
    };
  });
  $effect(() => {
    if ($viewFittingsAsked.length === 0) viewFittingEntryMenu = null;
  });
  const viewWord = (label: string): string => plainText(wordOf(label, VIEW_FITTING_WORDS[label] ?? ""));
  /** A heading of the contents: a slot kind's effect's name (the client's message), or the kind's label. */
  // Buy and Fit's tooltip (buyMultiFromBase.AddBuyAndFitBtn, fittingInfoTooltip.LoadFittingInfoTooltip, 19 to 42): "Fit
  // to apply to current ship", the hull's name, the fitting's name where it has one, and its contents by heading as the
  // display window lists them. As a hint's lines.
  // Raw: the fitting is kept as the window has it, to be known again by identity (a deep state would proxy it).
  let buyAndFitInfo = $state.raw<{ readonly fitting: unknown; readonly contents: readonly FittingContentsGroup[]; readonly effectNames: Readonly<Record<number, number | null>> } | null>(null);
  $effect(() => {
    const fitting = $multiBuyAsked?.fitting ?? null;
    if (fitting === null || buyAndFitInfo?.fitting === fitting) return;
    flow.requestWords(["UI/Market/MarketQuote/FitToApplyToCurrentShip", ...Object.keys(VIEW_FITTING_WORDS)]);
    void flow.fittingInfo(fitting).then((info) => {
      buyAndFitInfo = { fitting, ...info };
      flow.requestWords(Object.values(info.effectNames).flatMap((messageID) => (messageID === null ? [] : [`#${messageID}`])));
      flow.requestNames([{ kind: "type" as const, id: fitting.shipTypeID }, ...info.contents.flatMap((group) => group.entries.map((entry) => ({ kind: "type" as const, id: entry.typeID })))]);
    }).catch(() => {});
  });
  function buyAndFitTooltip(fitting: NonNullable<NonNullable<typeof $multiBuyAsked>["fitting"]>): string {
    const lines = [plainText(wordOf("UI/Market/MarketQuote/FitToApplyToCurrentShip", "To be fitted to the ship you are in")), nameOf("type", fitting.shipTypeID)];
    if (fitting.name) lines.push(plainText(fitting.name));
    if (buyAndFitInfo !== null && buyAndFitInfo.fitting === fitting) {
      for (const group of buyAndFitInfo.contents) {
        lines.push(contentsHeading(group.header, buyAndFitInfo.effectNames));
        for (const entry of group.entries) lines.push(`  ${groupedNumber(entry.qty)}x ${nameOf("type", entry.typeID)}`);
      }
    }
    return lines.join("\n");
  }
  function contentsHeading(header: FittingContentsGroup["header"], effectNames: Readonly<Record<number, number | null>>): string {
    if ("label" in header) return viewWord(header.label);
    const messageID = effectNames[header.effectID];
    return messageID === null || messageID === undefined ? "" : plainText(wordOf(`#${messageID}`, ""));
  }
  // The client's Buy All box (fittingScreen/missingItemsPopup.py BuyAllMessageBox), put up when a fitting could not all
  // be loaded: its info icon and caption, the header, each type that failed with how many ("%sx %s", by name) and its
  // icon, and Buy All (the multibuy window with them, for the fitting) and Close. Its words are the install's; the
  // page's own stand in. Not done: GM: Give All, which a game master's role adds (the page does not hold the session's
  // role).
  const BUY_ALL_WORDS: Readonly<Record<string, string>> = {
    "UI/Common/Information": "Note",
    "UI/Fitting/MissingItemsHeader": "These could not be fitted, for want of them in the hangar:",
    "UI/Market/MarketQuote/BuyAll": "Shop for all of it",
    "/Carbon/UI/Common/Close": "Close",
  };
  $effect(() => {
    if ($buyAllAsked === null) return;
    flow.requestWords(Object.keys(BUY_ALL_WORDS));
    flow.requestNames($buyAllAsked.missing.map((entry) => ({ kind: "type" as const, id: entry.typeID })));
  });
  const buyAllWord = (label: string): string => plainText(wordOf(label, BUY_ALL_WORDS[label] ?? ""));
  // svelte-ignore state_referenced_locally
  const multiBuyAsked = flow.multiBuyAsked;
  // The client's multibuy window (eve/client/script/ui/shared/market/buyMultiFromBase.py, with its base and rows): its
  // title with how many rows, where it buys (the station list's current one), the number of orders, each type a row
  // with its icon and name, its quantity, the total where the orders are more than one, its best price at the station
  // and its total, "-" where the station's orders do not hold it; the window's total; Buy and Cancel, and Buy and Fit
  // first of them where it was opened for a fitting (AddBuyAndFitBtn). Its words are the install's; the page's own stand
  // in. Not done: dropping types in, and Buy and Fit's tooltip (LoadFittingInfoTooltip). The station list is the
  // client's (GetStations: the system's markets, bridge/multiBuyStations.ts), with its warning. Add Order to Quickbar (AddToQuickbar, 207 to 212): AddNewQuickbarFolder's name popup, then
  // a folder of that name at the quickbar's top and each row's type in it with its whole quantity (GetTotalQty: the
  // row's times the orders') as its extra text (ui/marketQuickbar.ts).
  const MULTIBUY_WORDS: Readonly<Record<string, string>> = {
    "UI/Inventory/ItemActions/MultiBuy": "Shopping list",
    "UI/Market/MarketQuote/CurrentStation": "Here: {stationName}",
    "UI/Market/MarketQuote/NumberOfOrders": "Times over",
    "UI/Market/MarketQuote/CommandBuy": "Purchase",
    "UI/Generic/Cancel": "Not now",
    "UI/Common/Quantity": "How many",
    "UI/Market/MarketQuote/NoStationSelected": "Nowhere to buy chosen",
    "UI/Market/MarketQuote/NotStationsAvailable": "No market in this system",
    "UI/Market/MarketQuote/StationWarning": "Not where you are docked",
    "UI/Common/Percentage": "{[numeric]percentage, decimalPlaces=1}%",
    "UI/Market/MarketQuote/MultiBuyAboveAverage": "Altogether these cost {percentage} above their average.",
    "UI/Market/MarketQuote/MultiBuyTypesAboveAverage": "These cost far above their average:",
    "UI/Market/MarketQuote/MultiBuyAboveAverageConfirmation": "Buy them all the same?",
    "UI/Generic/Warning": "Careful",
    "UI/Market/Marketbase/PricePerUnit": "Each",
    "UI/Market/MarketQuote/NoMatchForOrder": "None here for this many",
    "UI/Market/MarketQuote/FromNumberOfOrders": "across {numOrders} orders",
    "UI/Market/MarketQuote/RegionalAdverage": "The region's mean",
    "UI/Market/MarketQuote/BestInStation": "Cheapest here",
    "UI/Market/MarketQuote/BestInSystem": "Cheapest in the system",
    "UI/Market/MarketQuote/BestRegional": "Cheapest in the region",
    "UI/Market/MarketQuote/NumOrders": "Orders",
    "UI/Market/MarketQuote/PricePerOrder": "Each order",
    "UI/Market/MarketQuote/TypesAvailableAndTotalInOrder": "{numAvailable} of {numTypes} to be had",
    "UI/Market/MarketQuote/AboveRegionalAverageWithPercentage": "{percentage} over the region's mean",
    "UI/Market/MarketQuote/BelowRegionalAverageWithPercentage": "{percentage} under the region's mean",
    "UI/Common/Volume": "Space",
    "UI/Inventory/ContainerCapacity": "{[numeric]capacity, decimalPlaces=2} m³",
    "UI/Contracts/Util/AmountInMillions": "{[numeric]amount, decimalPlaces=2} million",
    "UI/Contracts/Util/AmountInBillions": "{[numeric]amount, decimalPlaces=2} billion",
    "UI/Contracts/Util/AmountInTrillions": "{[numeric]amount, decimalPlaces=2} trillion",
    "UI/Market/MarketQuote/ImportShoppingListOption": "Paste a shopping list",
    "UI/Market/MarketQuote/ImportShoppingListOptionHint": "One type to a line, with how many before or after its name.",
    "UI/Market/MarketQuote/CopyOrderToClipboard": "Copy the list",
    "UI/Market/MarketQuote/AddOrderToQuickbar": "Keep the list in the quickbar",
    "UI/Market/Marketbase/FolderName": "Folder",
    "UI/Market/Marketbase/TypeFolderName": "Its name",
    "UI/Common/PleaseTypeSomething": "Type something first.",
    "UI/Common/Buttons/OK": "OK",
    "UI/Common/Buttons/Cancel": "Cancel",
    "UI/Market/MarketQuote/TotalPrice": "Total",
    // The import's lines not read (ImportShoppingList, CustomInfo): asked here, said by the flow.
    "UI/SkillQueue/CouldNotReadLines": "These lines were not understood:",
    "UI/Market/MarketQuote/UseCorpAccount": "Pay from {accountName}",
    "UI/Corporations/Common/CorporateDivisionMasterWallet": "Master wallet",
    "UI/Corporations/Common/CorporateDivisionWalletSecond": "Wallet division 2",
    "UI/Corporations/Common/CorporateDivisionWalletThird": "Wallet division 3",
    "UI/Corporations/Common/CorporateDivisionWalletFourth": "Wallet division 4",
    "UI/Corporations/Common/CorporateDivisionWalletFifth": "Wallet division 5",
    "UI/Corporations/Common/CorporateDivisionWalletSixth": "Wallet division 6",
    "UI/Corporations/Common/CorporateDivisionWalletSeventh": "Wallet division 7",
    "UI/Market/MarketQuote/BuyAndFit": "Buy, then fit",
    // Said as the fitting is loaded again after Buy and Fit (flow.ts multiBuyTryFit): asked here.
    "UI/Market/MarketQuote/SomeItemsCouldNotBeFitted": "",
  };
  /** The words for each wallet division where the corporation named it none (bco_corporations.GetDivisionNames, 8 to 14). */
  const WALLET_DIVISION_WORDS = ["UI/Corporations/Common/CorporateDivisionMasterWallet", "UI/Corporations/Common/CorporateDivisionWalletSecond",
    "UI/Corporations/Common/CorporateDivisionWalletThird", "UI/Corporations/Common/CorporateDivisionWalletFourth", "UI/Corporations/Common/CorporateDivisionWalletFifth",
    "UI/Corporations/Common/CorporateDivisionWalletSixth", "UI/Corporations/Common/CorporateDivisionWalletSeventh"] as const;
  /** corporation.GetCorpAccountName: the division's name, the corporation's own or the client's word for it. */
  const corpAccountName = (account: { readonly division: number; readonly name: string | null }): string =>
    account.name ?? buyWord(WALLET_DIVISION_WORDS[account.division - 1] ?? WALLET_DIVISION_WORDS[0]);
  /** eveFormat.FmtAmt(amount, showFraction=2), as the export writes a price: grouped by thousands, two places. */
  const twoPlaces = (amount: number): string => new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
  /**
   * buyMultiFromBase._ExportShoppingList (168 to 205): a line for each row, its name (CleanText), its quantity times the
   * orders, its price and its total each to two places or "-" where it has none, tab between; then the total's line;
   * the lines joined by CR LF. The client in English writes the names in English (GetNameFunc).
   */
  function multiBuyExport(buy: MultiBuyAsk, total: number): string {
    const lines = buy.rows.map((row) => {
      const qty = row.qty * buy.multiplier;
      const priced = row.price !== null && row.price !== 0;
      return [
        nameOf("type", row.typeID).replace(/\*/g, ""),
        String(qty),
        priced ? twoPlaces(Math.round(row.price! * 100) / 100) : "-",
        priced ? twoPlaces(Math.round(qty * row.price! * 100) / 100) : "-",
      ].join("\t");
    });
    lines.push([buyWord("UI/Market/MarketQuote/TotalPrice"), "", "", twoPlaces(total)].join("\t"));
    return lines.join("\r\n");
  }
  /** The import button (_AddImportButton): the clipboard's text read, or null where the browser would not give it. */
  async function importFromClipboard(n: number): Promise<void> {
    const text = await navigator.clipboard.readText().catch(() => null);
    await flow.importMultiBuy(n, text);
  }
  /** The export menu's Copy Order to Clipboard (ExportShoppingListLocalized): the list put on the clipboard. */
  /** The station list's options (LoadStationOptions): where the pilot is docked, as Current Station, then the others. */
  function stationOptionsOf(buy: MultiBuyAsk): { readonly id: number; readonly name: string }[] {
    return [
      ...(buy.currentStationID === null ? [] : [{ id: buy.currentStationID, name: buyWord("UI/Market/MarketQuote/CurrentStation", { stationName: nameOf(buy.currentStationID >= 1_000_000_000_000 ? "structure" : "station", buy.currentStationID) }) }]),
      ...(buy.stationList ?? []),
    ];
  }
  let exportOpen = $state(false);
  /** The multibuy whose list is being kept in the quickbar (its number), its folder's name asked; null where none is. */
  let quickbarNaming = $state<number | null>(null);
  /** AddToQuickbar: the folder, then each row's type in it with its whole quantity. */
  function addOrderToQuickbar(name: string, buy: { readonly rows: readonly { readonly typeID: number; readonly qty: number }[]; readonly multiplier: number }): void {
    quickbarNaming = null;
    changeQuickbar((quickbar) => {
      const made = addFolder(quickbar, name, 0);
      return buy.rows.reduce((held, row) => addType(held, row.typeID, made.folder.id, row.qty * buy.multiplier), made.quickbar);
    });
  }
  /** A percentage as FmtAmt(percentage * 100, showFraction=1) writes it: to a tenth. */
  const tenths = (fraction: number): number => Math.round(fraction * 1000) / 10;
  /**
   * contractutils.FmtISKWithDescription(isk, justDesc=True), from a million up (the multibuy window shows it beside its
   * total and its price per order there): the amount in millions, billions or trillions, its hundredths cut off.
   */
  function iskDescription(amount: number): string {
    const steps: readonly (readonly [number, string])[] = [[1e12, "UI/Contracts/Util/AmountInTrillions"], [1e9, "UI/Contracts/Util/AmountInBillions"], [1e6, "UI/Contracts/Util/AmountInMillions"]];
    const step = steps.find(([size]) => Math.abs(amount) >= size);
    return step === undefined ? "" : buyWord(step[1], { amount: Math.trunc(amount / (step[0] / 100)) / 100 });
  }
  /**
   * The row's delta tooltip (buytItemEntry.LoadDeltaTooltip, 264 to 289): the price per unit and how many orders it
   * is of, or that none here hold the quantity; the regional average with the row's distance from it; the cheapest
   * single unit at the station, in its system and in the region ("-" where there is none). The global market's words
   * are for PLEX alone, under an experiment (market/util.py does_global_market_apply): the region's words here.
   */
  function rowTooltip(row: MultiBuyRow): string {
    const best = (price: number | null): string => (price === null ? "-" : isk(price));
    const delta = row.average !== null && row.average > 0 && row.price !== null ? buyWord("UI/Common/Percentage", { percentage: tenths(priceDelta(row.price, row.average)) }) : "";
    return [
      `${buyWord("UI/Market/Marketbase/PricePerUnit")}: ${best(row.price)}`,
      row.price === null ? buyWord("UI/Market/MarketQuote/NoMatchForOrder") : buyWord("UI/Market/MarketQuote/FromNumberOfOrders", { numOrders: row.numOrders ?? 0 }),
      "",
      `${buyWord("UI/Market/MarketQuote/RegionalAdverage")} ${delta}: ${row.average === null ? "-" : isk(row.average)}`,
      "",
      `${buyWord("UI/Market/MarketQuote/BestInStation")}: ${best(row.bestInStation)}`,
      `${buyWord("UI/Market/MarketQuote/BestInSystem")}: ${best(row.bestInSystem)}`,
      `${buyWord("UI/Market/MarketQuote/BestRegional")}: ${best(row.bestInRegion)}`,
    ].join("\n");
  }
  /**
   * The total's tooltip (buyMultiFromBase.LoadTotalTooltip, 461 to 487), none where nothing is priced: the number of
   * orders, the price of one order (and its description from a million), how many of the types are to be had, the
   * order's distance from the average (GetOrderDeltaText) and the packaged volume of what is to be had
   * (GetNumTypesAndNumAvailableTypesAndVolume). A volume with a type's not known is left out.
   */
  function totalTooltip(buy: MultiBuyAsk, total: number): string {
    if (!total || !buy.multiplier) return "";
    const priced = buy.rows.filter((row) => row.price !== null && row.price > 0);
    const perOrder = total / buy.multiplier;
    const lines = [
      `${buyWord("UI/Market/MarketQuote/NumOrders")}: ${groupedNumber(buy.multiplier)}`,
      `${buyWord("UI/Market/MarketQuote/PricePerOrder")}: ${isk(perOrder)}${perOrder >= 1e6 ? ` =${iskDescription(perOrder)}` : ""}`,
      buyWord("UI/Market/MarketQuote/TypesAvailableAndTotalInOrder", { numAvailable: priced.length, numTypes: buy.rows.length }),
    ];
    const valued = priced.filter((row) => row.average !== null && row.average > 0);
    const whole = valued.length === 0 ? 0 : orderDelta(valued.map((row) => ({ total: row.price! * row.qty * buy.multiplier, quantity: row.qty * buy.multiplier, average: row.average! })));
    if (whole !== 0) {
      const percentage = buyWord("UI/Common/Percentage", { percentage: tenths(Math.abs(whole)) });
      lines.push("", buyWord(whole < 0 ? "UI/Market/MarketQuote/BelowRegionalAverageWithPercentage" : "UI/Market/MarketQuote/AboveRegionalAverageWithPercentage", { percentage }));
    }
    const volume = priced.some((row) => row.packagedVolume === null) ? null : priced.reduce((sum, row) => sum + row.qty * buy.multiplier * row.packagedVolume!, 0);
    if (volume) lines.push("", `${buyWord("UI/Common/Volume")}: ${buyWord("UI/Inventory/ContainerCapacity", { capacity: volume })}`);
    return lines.join("\n");
  }
  /**
   * A row's distance from its average as the client's BuyDeltaContainer shows it (deltaContainer.py): an arrow up
   * above the average, down below it, level at it; the percentage beside it, to a tenth under a hundred in a hundred and
   * whole above, red above the average and green below for a buy.
   */
  function rowDelta(row: { readonly price: number | null; readonly average: number | null }): { readonly delta: number; readonly text: string } | null {
    if (row.average === null || !(row.average > 0)) return null;
    const delta = priceDelta(row.price, row.average);
    if (delta === 0) return { delta, text: "" };
    const percentage = Math.abs(delta) < 1.0 ? Math.round(delta * 1000) / 10 : Math.round(delta * 100);
    return { delta, text: buyWord("UI/Common/Percentage", { percentage }) };
  }
  $effect(() => {
    if ($multiBuyAsked === null) return;
    flow.requestWords([...Object.keys(MULTIBUY_WORDS), ...NUMERIC_WORD_LABELS]);
    const place = $multiBuyAsked.stationID;
    flow.requestNames([
      ...$multiBuyAsked.rows.map((row) => ({ kind: "type" as const, id: row.typeID })),
      // The import hint's two examples (const.typeVeldspar, const.typeTritanium).
      { kind: "type" as const, id: 1230 },
      { kind: "type" as const, id: 34 },
      ...(place === null ? [] : [{ kind: (place >= 1_000_000_000_000 ? "structure" : "station") as NameKind, id: place }]),
    ]);
  });
  /** A label of the multibuy window, as plain text, its ISK in the client's words. */
  function buyWord(label: string, args: Readonly<Record<string, string | number>> = {}): string {
    return plainText(formatTemplate(wordOf(label, MULTIBUY_WORDS[label] ?? ""), args, {
      nameOf,
      writeIsk: (amount, decimalPlaces) => iskWords(amount, decimalPlaces, $words.templates, nameOf),
    }));
  }
  /** eveFormat.FmtISK: the amount in the client's ISK words, two places. */
  const isk = (amount: number): string => iskWords(amount, 2, $words.templates, nameOf) ?? `${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)} ISK`;
  // svelte-ignore state_referenced_locally
  const applyPointsAsked = flow.applyPointsAsked;

  /** The client's words for its quantity question (uix.QtyPopup) and for the buttons, with the page's own. */
  const QUANTITY_WORDS: Readonly<Record<string, string>> = {
    "UI/Common/SetQuantity": "Set Quantity",
    "UI/Common/Buttons/OK": "OK",
    "UI/Common/Buttons/Cancel": "Cancel",
  };
  /** A question's two answers (uiconst.YESNO), in the client's words. */
  const ANSWER_WORDS: Readonly<Record<string, string>> = {
    "UI/Common/Buttons/Yes": "Yes",
    "UI/Common/Buttons/No": "No",
  };
  const wordOf = (label: string, own: string): string => {
    const template = $words.templates[label];
    return typeof template === "string" && template !== "" ? template : own;
  };
  const followerOf = (url: string, text: string) => linkFollowerOf(url, flow, null, label => wordOf(label, label), text);

  /** The types the client puts up as a box (_prompt_player), and as the passing strip (message_player). */
  const BOX_TYPES: ReadonlySet<string> = new Set(["info", "infomodal", "warning", "question", "error", "fatal", "windowhelp"]);
  const STRIP_TYPES: ReadonlySet<string> = new Set(["notify", "hint", "event"]);
  /** TITLE_BY_DIALOG_TYPE: the type's own word for a box whose dialog has no title; Information for any other. */
  const TYPE_TITLES = DIALOG_TYPE_TITLES;
  const INFORMATION = INFORMATION_TITLE;
  /** The page's own words for those, where the install's are not to hand. */
  const OWN_TITLES = OWN_DIALOG_TITLES;
  /** How long the strip stays (QuickMessage.ShowMsg: AutoTimer(5000, self.hide)). */
  const STRIP_MS = 5000;

  const client = $derived<ClientWording>({
    templates: $words.templates,
    playerID: $station.online?.characterID ?? null,
  });
  const pilotName = $derived($station.online?.characterName ?? null);

  const partOf = (one: SaidDialog, part: "title" | "body"): QuestionWords => ({ label: null, text: null, parameters: one.values, dialog: one.dialog, part });
  const typeKey = (one: SaidDialog): string => `dialog:${one.dialog}/type`;

  // The dialogs' texts, types and names from the install, asked once each; and the types' own words for a title.
  $effect(() => {
    const parts = $said.flatMap((one) => [partOf(one, "title"), partOf(one, "body")]);
    if (parts.length === 0) {
      return;
    }
    // (And the words a dialog's numeric distance and ISK are written in: questions.ts, writeDistance and writeIsk.)
    flow.requestWords([
      ...wordsLabels(parts), ...$said.map(typeKey), ...$said.map((one) => suppressKey(one.dialog)), ...Object.keys(OWN_TITLES), ...NUMERIC_WORD_LABELS,
      ...Object.keys(ANSWER_WORDS), DO_NOT_SHOW_AGAIN_LABEL, DO_NOT_ASK_AGAIN_LABEL,
    ]);
    const refs = wordsNameRefs(parts, client);
    if (refs.length > 0) {
      flow.requestNames(refs);
    }
  });

  function nameOf(kind: NameKind, id: number): string {
    return resolvedName($names.resolved, kind, id, `${kind} ${id}`);
  }

  /** How each is put up: not yet (its type not read), a box, the strip, or not at all. */
  type Shown = { readonly said: SaidDialog; readonly kind: "pending" | "box" | "strip" | "none"; readonly type: string | null };
  const shown = $derived<readonly Shown[]>($said.map((one) => {
    const key = typeKey(one);
    if (!(key in $words.templates) && one.fallbackType === undefined) {
      return { said: one, kind: "pending", type: null };
    }
    // A known notification must still be shown if the metadata request fails.
    // Any real local type, including an unsupported one, overrides the fallback.
    const type = $words.templates[key] ?? one.fallbackType ?? null;
    // A question waits on its answer: a box, whatever its type.
    if (one.answers === "yesno" || one.answers === "okcancel") return { said: one, kind: "box", type };
    if (type === null) return { said: one, kind: "box", type: null };
    return { said: one, kind: BOX_TYPES.has(type) ? "box" : STRIP_TYPES.has(type) ? "strip" : "none", type };
  }));

  // What the client shows nothing of is taken down at once; of the strip's, only the newest stays (ShowMsg puts a
  // newer text in the one strip).
  $effect(() => {
    const strips = shown.filter((one) => one.kind === "strip");
    for (const one of [...shown.filter((each) => each.kind === "none"), ...strips.slice(0, -1)]) {
      flow.dismissDialog(one.said.n);
    }
  });

  const box = $derived.by(() => {
    const first = shown.find((one) => one.kind === "box");
    if (first === undefined) {
      return null;
    }
    const own = questionText(partOf(first.said, "title"), nameOf, client);
    const typeTitle = first.type === null ? INFORMATION : TYPE_TITLES[first.type] ?? INFORMATION;
    const typeWords = $words.templates[typeTitle];
    const title = own || (typeof typeWords === "string" && typeWords !== "" ? typeWords : OWN_TITLES[typeTitle] ?? "Information");
    const body = first.type === null ? first.said.fallback : questionText(partOf(first.said, "body"), nameOf, client) || first.said.fallback;
    const suppress = $words.templates[suppressKey(first.said.dialog)];
    return { said: first.said, title, body, markup: bodyMarkup(first.said, first.type !== null), suppress: typeof suppress === "string" ? first.said.suppressAnswer ?? suppress : null };
  });
  // The box's checkbox, unticked for each box put up.
  let keepTicked = $state(false);
  let keepTickedFor: number | null = null;
  $effect(() => {
    const n = box === null ? null : box.said.n;
    if (n === keepTickedFor) return;
    keepTickedFor = n;
    keepTicked = false;
  });
  /** The box answered: OK, Yes or No; the answer kept where the checkbox is ticked and the dialog lets it be kept. */
  function answerBox(answer: "ok" | "yes" | "no"): void {
    const shownBox = box;
    if (shownBox === null) return;
    if (keepTicked && answerKept(shownBox.suppress, answer)) flow.keepDialogAnswer(shownBox.said.dialog, answer);
    if (answer === "ok" && shownBox.said.answers !== "okcancel") flow.dismissDialog(shownBox.said.n);
    else flow.answerDialog(shownBox.said.n, answer === "yes" || answer === "ok");
  }

  const strip = $derived.by(() => {
    const strips = shown.filter((one) => one.kind === "strip");
    const last = strips[strips.length - 1];
    return last === undefined ? null : { said: last.said, text: questionText(partOf(last.said, "body"), nameOf, client) || last.said.fallback, markup: bodyMarkup(last.said, true) };
  });

  /**
   * A dialog's body as the client's label is given it (messagebox.MessageBox.construct_message_body and
   * QuickMessage: carbonui.text.styles.TextBody): the client's text filled in with its markup kept; where the page
   * has none of the client's text, its own words, written so that the label reads them as they are.
   */
  function bodyMarkup(one: SaidDialog, typed: boolean): string {
    if (one.bodyMarkup !== undefined) return one.bodyMarkup;
    const marked = typed ? questionMarkup(partOf(one, "body"), nameOf, client) : null;
    return marked !== null && marked !== "" ? marked : labelEscaped(one.fallback);
  }

  // The strip's own time, from when its text is put in. Kept apart from the effect's runs: a run for any other change
  // of the store leaves the time as it is (the effect reads the whole store's words).
  let stripTimer: ReturnType<typeof setTimeout> | null = null;
  let stripTimed: number | null = null;
  $effect(() => {
    const n = strip === null ? null : strip.said.n;
    if (n === stripTimed) {
      return;
    }
    if (stripTimer !== null) {
      clearTimeout(stripTimer);
      stripTimer = null;
    }
    stripTimed = n;
    if (n !== null) {
      stripTimer = setTimeout(() => {
        stripTimer = null;
        flow.dismissDialog(n);
      }, STRIP_MS);
    }
  });
  onDestroy(() => {
    if (stripTimer !== null) {
      clearTimeout(stripTimer);
    }
  });

  // The quantity question (uix.QtyPopup): its words asked for, the number it begins at put in once for each question,
  // and the field taken to it with what is in it selected (setfocus, selectall).
  $effect(() => {
    const ask = $asked;
    if (ask === null) return;
    flow.requestWords([
      ...Object.keys(QUANTITY_WORDS),
      ...[ask.hintLabel, ask.captionLabel ?? null, ask.labelLabel ?? null].filter((label): label is string => label !== null),
    ]);
  });
  // The names its label speaks of (UseSkillPointsWindow's skill), as its words come.
  $effect(() => {
    const ask = $asked;
    if (ask === null || ask.labelLabel === undefined) return;
    const template = $words.templates[ask.labelLabel];
    const refs = typeof template === "string" ? templateNameRefs(template, ask.labelArgs ?? {}) : [];
    if (refs.length > 0) untrack(() => flow.requestNames(refs));
  });
  // (Text, not a number field: a number field's text cannot be selected, and the client's is selected to begin with.
  // Digits only, as the client's field takes them: intonly.)
  let typed = $state("");
  let typedFor: number | null = null;
  let field = $state<HTMLInputElement | null>(null);
  $effect(() => {
    const ask = $asked;
    if ((ask?.n ?? null) === typedFor) return;
    typedFor = ask?.n ?? null;
    typed = ask === null ? "" : String(ask.value);
    // Selected once its number is in it.
    void tick().then(() => field?.select());
  });
  // The client's skill requirement window (skillRequirementDialog.py): the type's icon and name, what it would be
  // used for, how many skills and levels are missing and how many books, each skill at its level with its mark and its
  // five boxes (skill_requirement.py RequiredSkillRow, the skill bar), the training time (AddTrainingTimeForType), the
  // points the levels cost and Train Skills (AddSkillAction, skillBtns.py), and its one button. Its words are the
  // install's; the page's own stand in where they are not to hand. Not done: Buy and train (its window,
  // MissingSkillbooksWnd), the points-applying and skill plan buttons, an alpha clone's Upgrade button, the rows'
  // menus, drags and info.
  const SKILL_WINDOW_WORDS: Readonly<Record<string, string>> = {
    "Tooltips/SkillPlanner/OmegaTrainingTime": "Time to train it (omega)",
    "Tooltips/SkillPlanner/TrainingTime": "Time to train it",
    "Tooltips/SkillPlanner/TrainingComplete": "Trained",
    "UI/Skills/SkillPointsRequired": "Points it takes",
    "UI/Skills/TrainSkills": "Train them",
    "Tooltips/SkillPlanner/AddAllSkillsToQueueButton": "Put them all in the queue",
    "Tooltips/SkillPlanner/AddAllSkillsToQueueButtonFinished": "They are all in the queue",
    "UI/SkillQueue/SkillBookMissing": "The book is not injected",
    "UI/SkillQueue/RareSkillBookMissing": "The book is not injected, and is not sold",
    "UI/InfoWindow/SkillNotTrainedToRequiredLevel": "Short of the level needed",
    "UI/Skills/BuyAndTrain": "Buy them and train",
    "UI/Skills/ErrorRareSkill": "This book is not sold directly",
    "UI/Skills/ErrorRareRequirements": "A book this needs is not sold directly",
    "UI/Generic/Information": "Information",
    "Tooltips/SkillPlanner/SkillsRequiredToPerformActivity": "Skills needed to {doActivity}",
    "Tooltips/SkillPlanner/ActivityFlyShip": "fly it",
    "Tooltips/SkillPlanner/OmegaCloneStateRequiredForActivity": "Only an omega clone can {doActivity}",
    "UI/CloneState/Upgrade": "Upgrade",
    "Tooltips/SkillPlanner/SkillsAndSkillLevels": "{numSkills} skills to train, {numLevels} levels in all",
    "Tooltips/SkillPlanner/MissingSkillBooks": "({numMissingBooks} not owned)",
    "UI/InfoWindow/RequiredSkillNameAndLevel": "{[item]skill.name} {level}",
    "Achievements/AuraText/laterButton": "Not now",
    "Tooltips/SkillPlanner/SkillPlanButtonTooltip": "Begin a skill plan of these",
    "UI/SkillPlan/MaximumSkillPlanReached": "You have {numPlans} plans, as many as may be had.",
  };
  // The personal plans' count as the window opened, for its Create Skill Plan button's limit.
  let windowPlanCount = $state<number | null>(null);
  $effect(() => {
    if ($skillsRequired === null) return;
    void flow.personalSkillPlanCount().then((count) => (windowPlanCount = count)).catch(() => {});
  });
  $effect(() => {
    const open = $skillsRequired;
    if (open === null) return;
    flow.requestWords([...Object.keys(SKILL_WINDOW_WORDS), ...SHORT_INTERVAL_WORD_LABELS]);
    flow.requestNames([{ kind: "type", id: open.typeID }, ...open.skills.map(([skill]) => ({ kind: "type" as const, id: skill }))]);
  });
  /**
   * A training time as the window writes it (FormatTimeIntervalShortWritten(time, showTo=TIME_CATEGORY_MINUTE)), in
   * the install's words; the page's own where they are not to hand. None is the window's Training Complete.
   */
  function trainingTime(ticks: number | null): string {
    return trainingTimeText(ticks, $words.templates, skillWord("Tooltips/SkillPlanner/TrainingComplete"));
  }
  // The client's books window (characterskills/client/UI/missingSkillbooksWnd.py), which Buy and train opens: its
  // title; the books sold, each by name, with what they cost and Buy and Inject; the books not sold, by name, under a
  // heading of their own; each heading's skill book and its hint; and its close. Its words are the install's; the
  // page's own stand in. Not done: Check on Market (the client's multibuy window) and the skill plan button.
  const SKILL_BOOK_WORDS: Readonly<Record<string, string>> = {
    "UI/SkillPlan/MissingSkillbooksWindow/ConfirmPurchaseTitle": "Buy skill books",
    "UI/SkillPlan/MissingSkillbooksWindow/AvailableForRemoteInjection": "Sold for injection at once",
    "UI/SkillPlan/MissingSkillbooksWindow/UnavailableForRemoteInjection": "Not sold for injection at once",
    "UI/SkillPlan/MissingSkillbooksWindow/PriceLabel": "Cost: {[numeric]cost.isk}",
    "UI/SkillPlan/MissingSkillbooksWindow/BuyAndInjectButton": "Buy and inject",
    "UI/SkillPlan/MissingSkillbooksWindow/BuyAndInjectTooltip": "Buy each book listed here and inject it now",
    "UI/SkillPlan/MissingSkillbooksWindow/RemoteInjectionTooltip": "Books bought this way are injected where the pilot is, with no book to carry.",
    "UI/SkillPlan/MissingSkillbooksWindow/CheckMarketButton": "Look on the market",
    "UI/SkillPlan/MissingSkillbooksWindow/CheckMarketTooltip": "Put these books in a market buy window",
  };
  $effect(() => {
    if ($skillBooksAsked === null) return;
    flow.requestWords([...Object.keys(SKILL_BOOK_WORDS), ...NUMERIC_WORD_LABELS]);
    flow.requestNames([...$skillBooksAsked.available, ...$skillBooksAsked.unavailable].map((id) => ({ kind: "type" as const, id })));
  });
  /** A label of the books window filled with `args`, as plain text, its ISK in the client's words. */
  function bookWord(label: string, args: Readonly<Record<string, string | number>> = {}): string {
    return plainText(formatTemplate(wordOf(label, SKILL_BOOK_WORDS[label] ?? ""), args, {
      nameOf,
      writeIsk: (amount, decimalPlaces) => iskWords(amount, decimalPlaces, $words.templates, nameOf),
    }));
  }
  // The skill requirement window's apply-points button (skillBtns.ApplySkillPointsButton) and the client's Apply Skill
  // Points window it opens where the pilot has free points (skilltrading/applySkillPointsWindow.py): its title and
  // words, each level a row with its gauges (trained, and with the points), the time saved and the percentages, and
  // Confirm and Cancel, then Close. Its words are the install's; the page's own stand in. Not done: the gauges'
  // animation, and the store an alpha clone's button opens with no free points (the page has none: the button is shown
  // and not live).
  const APPLY_WORDS: Readonly<Record<string, string>> = {
    "UI/SkillQueue/ApplySkillPoints": "Put free points into these",
    "UI/Market/MarketQuote/BuyType": "Shop for {[item]typeID.name}",
    "UI/SkillTrading/ApplySkillPointsWindowCaption": "Free skill points",
    "UI/SkillTrading/ApplySkillPointsDescription": "{[numeric]points, useGrouping, decimalPlaces=0} free points go to {amount} levels.",
    "UI/SkillTrading/ConfirmInjectionLabel": "Apply",
    "UI/SkillTrading/CancelInjectionLabel": "Not now",
    "UI/SkillTrading/CloseInjectionLabel": "Done",
    "UI/SkillTrading/EstimatedSkillTimeSaved": "About {[timeinterval]timeSaved.shortWrittenForm, from=\"day\", to=\"minute\"} less to train",
    "UI/SkillTrading/SkillProgressLabel": "{progress}% to {progressWithFreePoints}%",
  };
  $effect(() => {
    if ($skillsRequired === null && $applyPointsAsked === null) return;
    flow.requestWords([...Object.keys(APPLY_WORDS), ...SHORT_INTERVAL_WORD_LABELS]);
    if ($applyPointsAsked !== null) flow.requestNames($applyPointsAsked.entries.map((entry) => ({ kind: "type" as const, id: entry.skill })));
    else flow.requestNames([{ kind: "type", id: TYPE_SKILL_INJECTOR }, { kind: "type", id: TYPE_ALPHA_TRAINING_INJECTOR }]);
  });
  /** A label of the apply-points button or its window, filled with `args`, as plain text. */
  function applyWord(label: string, args: Readonly<Record<string, string | number>> = {}): string {
    return plainText(formatTemplate(wordOf(label, APPLY_WORDS[label] ?? ""), args, {
      nameOf,
      ...intervalWriters($words.templates),
    }));
  }
  /** round(x * 100, 1), as the window's percentages are. */
  const percent = (fraction: number): number => Math.round(fraction * 1000) / 10;
  /** eveformat.number: whole, grouped by thousands. */
  const groupedNumber = (value: number): string => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
  /** A label of the window filled with `args`, as plain text. */
  function skillWord(label: string, args: Readonly<Record<string, string | number>> = {}): string {
    return plainText(formatTemplate(wordOf(label, SKILL_WINDOW_WORDS[label] ?? ""), args, { nameOf }));
  }
  // The client's ship naming window (shipNameDialog.py): its title, the field (32 letters at most, counted) with the
  // ship's type and the pilot's name as its hint, the line asking why, Do Not Ask Again, Confirm and Later. Confirm
  // takes the field, or the hint where it is empty, on one line and trimmed. Its words are the install's; the page's
  // own stand in where they are not to hand. Not done: the why line's tooltip, the sounds.
  const SHIP_NAME_WORDS: Readonly<Record<string, string>> = {
    "UI/Ship/NameChange/WindowTitle": "Ship name",
    "UI/Ship/NameChange/InputFieldLabel": "Name",
    "UI/Ship/NameChange/InfoLabel": "A name of your own for this ship",
    "UI/Inflight/OwnerAndShip": "{[item]shipTypeID.rawName} of {[character]charID.name}",
    "UI/Common/Confirm": "OK",
    "UI/Common/Later": "Not now",
  };
  /** A word of the naming window: the install's, or the page's own. */
  const shipWord = (label: string): string => wordOf(label, SHIP_NAME_WORDS[label] ?? "");
  let shipNameTyped = $state("");
  let shipNameFor: number | null = null;
  let shipNameKeep = $state(false);
  $effect(() => {
    const ask = $shipNameAsked;
    if ((ask?.n ?? null) === shipNameFor) return;
    shipNameFor = ask?.n ?? null;
    shipNameTyped = ask?.currentName ?? "";
    shipNameKeep = false;
    if (ask === null) return;
    flow.requestWords([...Object.keys(SHIP_NAME_WORDS), DO_NOT_ASK_AGAIN_LABEL]);
    const pilot = $station.online?.characterID ?? null;
    flow.requestNames([{ kind: "type", id: ask.typeID }, ...(pilot === null ? [] : [{ kind: "owner" as const, id: pilot }])]);
  });
  const shipNameHint = $derived(
    $shipNameAsked === null
      ? ""
      : plainText(formatTemplate(shipWord("UI/Inflight/OwnerAndShip"), {
          shipTypeID: $shipNameAsked.typeID,
          charID: $station.online?.characterID ?? 0,
        }, { nameOf })),
  );
  function answerShipName(confirm: boolean): void {
    const ask = $shipNameAsked;
    if (ask === null) return;
    const name = confirm ? (shipNameTyped || shipNameHint).replace(/\n/g, " ").trim() : null;
    flow.answerShipName(ask.n, name, shipNameKeep);
  }
  const hintText = $derived($asked === null
    ? ""
    : $asked.hintLabel === null
      ? $asked.hint ?? ""
      : $asked.hintArgs === undefined
        ? wordOf($asked.hintLabel, $asked.hint ?? "")
        : plainText(formatTemplate(wordOf($asked.hintLabel, $asked.hint ?? ""), $asked.hintArgs, { nameOf })));
  /** QtyPopup's caption: the one asked, else SetQuantity. */
  const captionText = $derived($asked?.captionLabel === undefined
    ? wordOf("UI/Common/SetQuantity", "Set Quantity")
    : wordOf($asked.captionLabel, $asked.caption ?? ""));
  /** QtyPopup's label beside its field, where one is asked. */
  const labelText = $derived($asked === null || $asked.labelLabel === undefined
    ? $asked?.label ?? ""
    : plainText(formatTemplate(wordOf($asked.labelLabel, $asked.label ?? ""), $asked.labelArgs ?? {}, { nameOf })));
  function focusAll(node: HTMLInputElement): void {
    node.focus();
    node.select();
  }
  function answerQuantity(ok: boolean): void {
    const ask = $asked;
    if (ask === null) return;
    // A field left empty is no answer (the client's field is required).
    if (ok && (ask.digits ? typed.trim() === "" || !Number.isFinite(Number(typed)) : !/^\d+$/.test(typed))) return;
    flow.answerQuantity(ask.n, ok ? Number(typed) : null);
  }
  function filterQuantity(): void {
    const digits = $asked?.digits ?? 0;
    if (!digits) { typed = typed.replace(/\D+/g, ""); return; }
    // SingleLineEditFloat.ValidateNewText29-41 trims excess decimal text.
    typed = typed.replace(/[^-\de.]/g, "");
    const dot = typed.indexOf(".");
    if (dot >= 0) typed = typed.slice(0, dot + 1) + typed.slice(dot + 1).replace(/\./g, "").slice(0, digits);
  }
</script>

<svelte:window onkeydown={event => {
  if (event.key !== "Escape" || !inFront) return;
  if ($corporationWalletChoice !== null) { event.preventDefault(); flow.answerCorporationWallet($corporationWalletChoice.n, false); }
  else if ($corporationAwardAsk !== null) { event.preventDefault(); flow.answerCorporationAward($corporationAwardAsk.n, false); }
  else if ($corporationCEOChoice !== null) { event.preventDefault(); flow.answerCorporationCEO($corporationCEOChoice.n, false); }
}} />

{#if $moneyTransfer !== null}
  {#key $moneyTransfer.n}<MoneyTransferWindow store={session.store} {flow} request={$moneyTransfer} {inFront} />{/key}
{/if}

{#if $corporationAwardAsk !== null}
  {@const ask = $corporationAwardAsk}
  {@const caption = ask.stage === "medal" ? wordOf("UI/Corporations/Common/AwardCorpMemberDecoration", "Award Corporation Member Decoration") : wordOf("UI/Corporations/CorporationWindow/Members/AwardReasonTitle", "Award Reason")}
  <div class="client-dialog-shade" class:modal={inFront}>
    <div class="client-dialog" role="dialog" aria-modal={inFront} aria-label={caption} data-dialog={ask.stage === "medal" ? "AwardDecoration" : "AwardReason"} data-in-front={inFront}>
      {#if ask.stage === "medal"}
        <form class="quantity" onsubmit={event => { event.preventDefault(); flow.answerCorporationAward(ask.n, true); }}>
          <strong>{caption}</strong><p class="body">{ask.hint}</p>
          <span>{wordOf("UI/Inventory/InvItemNameShort", "Name")}</span>
          <div class="ceo-choices" role="listbox" aria-label={caption}>
            {#each ask.rows as row, index (index)}
              <button type="button" role="option" aria-selected={ask.selectedIndex === index} class:selected={ask.selectedIndex === index} onclick={() => flow.selectCorporationAward(ask.n, index)} ondblclick={() => { flow.selectCorporationAward(ask.n, index); flow.answerCorporationAward(ask.n, true); }}>{row.name}</button>
            {/each}
          </div>
          {#if ask.selectionError}<span class="ceo-choice-error" role="status">{ask.selectionError}</span>{/if}
          <span class="answers"><button type="submit">{wordOf("UI/Common/Buttons/OK", "OK")}</button><button type="button" onclick={() => flow.answerCorporationAward(ask.n, false)}>{wordOf("UI/Common/Buttons/Cancel", "Cancel")}</button></span>
        </form>
      {:else}
        {#key ask.n}
          <NamePopup {caption} label={wordOf("UI/Corporations/CorporationWindow/Members/PromptForReason", "Reason for awarding this decoration")} maxLength={200}
            refusal={wordOf("UI/Common/PleaseTypeSomething", "Please type something.")} okWord={wordOf("UI/Common/Buttons/OK", "OK")} cancelWord={wordOf("UI/Common/Buttons/Cancel", "Cancel")}
            onok={reason => flow.answerCorporationAward(ask.n, true, reason)} oncancel={() => flow.answerCorporationAward(ask.n, false)} />
        {/key}
        {#if ask.selectionError}<span class="ceo-choice-error" role="status">{ask.selectionError}</span>{/if}
      {/if}
    </div>
  </div>
{/if}

{#if $inventoryPasswordAsked !== null}
  {@const ask = $inventoryPasswordAsked}
  {@const caption = ask.type === 1 ? wordOf("UI/Inventory/ItemActions/AccessPasswordRequiredCaption", "Access Password Required") : wordOf("UI/Inventory/ItemActions/ConfigurationPasswordRequiredCaption", "Configuration Password Required")}
  <div class="client-dialog-shade" class:modal={inFront}>
    <div class="client-dialog" data-dialog="InventoryPassword" data-in-front={inFront}>
      {#key ask.n}
        <NamePopup {caption} label={ask.type === 1 ? wordOf("UI/Inventory/ItemActions/PleaseEnterAccessPassword", "Please enter access password") : wordOf("UI/Inventory/ItemActions/PleaseEnterConfigurationPassword", "Please enter configuration password")} password={true} maxLength={16}
          refusal={wordOf("UI/Common/PleaseTypeSomething", "Please type something.")} okWord={wordOf("UI/Common/Buttons/OK", "OK")} cancelWord={wordOf("UI/Common/Buttons/Cancel", "Cancel")}
          onok={text => flow.answerInventoryPassword(ask.n, text)} oncancel={() => flow.answerInventoryPassword(ask.n, null)} />
      {/key}
    </div>
  </div>
{/if}

{#if $corporationWalletChoice !== null}
  {@const choice = $corporationWalletChoice}
  <div class="client-dialog-shade" class:modal={inFront}>
    <div class="client-dialog ceo-choice" role="dialog" aria-modal={inFront} aria-label={wordOf("UI/Wallet/WalletWindow/SelectDivision", "Select Division")} data-dialog="SelectDivision" data-in-front={inFront}>
      <form class="quantity" onsubmit={event => { event.preventDefault(); flow.answerCorporationWallet(choice.n, true); }}>
        <strong>{wordOf("UI/Wallet/WalletWindow/SelectDivision", "Select Division")}</strong>
        <div class="ceo-choices" role="listbox" aria-label={wordOf("UI/Wallet/WalletWindow/SelectDivision", "Select Division")}>
          {#each choice.rows as row, index (row.accountKey)}
            <button type="button" role="option" aria-selected={choice.selectedIndex === index} class:selected={choice.selectedIndex === index} onclick={() => flow.selectCorporationWallet(choice.n, index)} ondblclick={() => { flow.selectCorporationWallet(choice.n, index); flow.answerCorporationWallet(choice.n, true); }}>{plainText(row.name)}</button>
          {:else}<p>{wordOf("/Carbon/UI/Controls/Common/NoItem", "No Item")}</p>{/each}
        </div>
        {#if choice.selectionError}<span class="ceo-choice-error" role="status">{plainText(choice.selectionError)}</span>{/if}
        <span class="answers"><button type="submit">{wordOf("UI/Common/Buttons/OK", "OK")}</button><button type="button" onclick={() => flow.answerCorporationWallet(choice.n, false)}>{wordOf("UI/Common/Buttons/Cancel", "Cancel")}</button></span>
      </form>
    </div>
  </div>
{/if}

{#if $corporationCEOChoice !== null}
  {@const choice = $corporationCEOChoice}
  <div class="client-dialog-shade" class:modal={inFront}>
    <div class="client-dialog ceo-choice" role="dialog" aria-modal={inFront} aria-label={wordOf("UI/Corporations/BaseCorporationUI/SelectReplacementCEO", "Select Replacement CEO")} data-dialog="SelectReplacementCEO" data-in-front={inFront}>
      <form class="quantity" onsubmit={event => { event.preventDefault(); flow.answerCorporationCEO(choice.n, true); }}>
        <strong>{wordOf("UI/Corporations/BaseCorporationUI/SelectReplacementCEO", "Select Replacement CEO")}</strong>
        <p class="body">{wordOf("UI/Corporations/BaseCorporationUI/SelectReplacementCEOText", "Select a corporation member to replace you as CEO.")}</p>
        <div class="ceo-choices" role="listbox" aria-label={wordOf("UI/Corporations/BaseCorporationUI/SelectReplacementCEO", "Select Replacement CEO")}>
          {#each choice.rows as row, index (index)}
            {@const portrait = portraitUrl($imageServer, row.characterID, 32)}
            <button type="button" role="option" aria-selected={choice.selectedIndex === index} class:selected={choice.selectedIndex === index} onclick={() => flow.selectCorporationCEO(choice.n, index)} ondblclick={() => { flow.selectCorporationCEO(choice.n, index); flow.answerCorporationCEO(choice.n, true); }}>
              <OwnerPicture name={row.name} urls={[...(portrait === null ? [] : [portrait]), clientTexture(portraitDefaultPath(32))]} size={32} />
              <span>{row.name}</span>
            </button>
          {/each}
        </div>
        {#if choice.selectionError}<span class="ceo-choice-error" role="status">{choice.selectionError}</span>{/if}
        <span class="answers">
          <button type="submit">{wordOf("UI/Common/Buttons/OK", "OK")}</button>
          <button type="button" onclick={() => flow.answerCorporationCEO(choice.n, false)}>{wordOf("UI/Common/Buttons/Cancel", "Cancel")}</button>
        </span>
      </form>
    </div>
  </div>
{/if}

{#if $asked !== null}
  <div class="client-dialog-shade" class:modal={inFront}>
    <div class="client-dialog" role="dialog" aria-label={captionText} data-dialog="setQuantityPopup" data-in-front={inFront}>
      <form
        class="quantity"
        onsubmit={(event) => {
          event.preventDefault();
          answerQuantity(true);
        }}
      >
        {#if !inFront && pilotName !== null}
          <span class="for-pilot">For {pilotName}</span>
        {/if}
        <strong>{captionText}</strong>
        {#if hintText !== ""}<p class="body">{hintText}</p>{/if}
        {#if labelText !== ""}<p class="body quantity-label">{labelText}</p>{/if}
        <input
          type="text"
          inputmode={$asked.digits ? "decimal" : "numeric"}
          aria-label={wordOf("UI/Common/SetQuantity", "Set Quantity")}
          bind:value={typed}
          oninput={filterQuantity}
          bind:this={field}
          use:focusAll
        />
        <span class="answers">
          <button type="submit">{wordOf("UI/Common/Buttons/OK", "OK")}</button>
          <button type="button" onclick={() => answerQuantity(false)}>{wordOf("UI/Common/Buttons/Cancel", "Cancel")}</button>
        </span>
      </form>
    </div>
  </div>
{/if}

{#if $applyPointsAsked !== null}
  {@const apply = $applyPointsAsked}
  <div class="client-dialog-shade" class:modal={inFront}>
    <div class="client-dialog apply-window" role="dialog" aria-label={applyWord("UI/SkillTrading/ApplySkillPointsWindowCaption")} data-dialog="ApplySkillPointsWindow" data-in-front={inFront}>
      {#if !inFront && pilotName !== null}
        <span class="for-pilot">For {pilotName}</span>
      {/if}
      <strong class="apply-head">{applyWord("UI/SkillTrading/ApplySkillPointsWindowCaption")}</strong>
      <p class="body apply-description">{applyWord("UI/SkillTrading/ApplySkillPointsDescription", { color: "#3ea8d9", points: apply.points, amount: apply.entries.length })}</p>
      <ul class="apply-rows">
        {#each apply.entries as entry (`${entry.skill}:${entry.level}`)}
          {@const groupIcon = skillGroupIcon(entry.groupID)}
          {@const complete = apply.finished && entry.progressWithFreePoints === 1}
          <li class="apply-row">
            <!-- ApplySkillPointsListEntry: the skill group's icon at the left (SetSkillGroupIcon), the book's mark at the
                 right, which turns to the level's completion, in green, once the points have made it (OnGaugeProgressSet). -->
            <span class="apply-icon">{#if groupIcon !== null}<img src={groupIcon} alt="" width="32" height="32" />{/if}</span>
            <span class="apply-middle">
            <span class="apply-gauge">
              <span class="apply-fill with-points" style:width={`${entry.progressWithFreePoints * 100}%`}></span>
              <span class="apply-fill trained" class:complete={apply.finished && entry.progressWithFreePoints === 1} style:width={`${entry.progress * 100}%`}></span>
              <span class="apply-name">{nameOf("type", entry.skill)} {romanLevel(entry.level)}</span>
            </span>
            <span class="apply-saved">
              <span class="dim">{entry.timeSavedTicks === null ? "" : applyWord("UI/SkillTrading/EstimatedSkillTimeSaved", { timeSaved: Math.max(0, Math.trunc(entry.timeSavedTicks)) })}</span>
              <span>{applyWord("UI/SkillTrading/SkillProgressLabel", { progress: percent(entry.progress), progressWithFreePoints: percent(entry.progressWithFreePoints) })}</span>
            </span>
            </span>
            {#if complete}
              <span class="apply-book complete" style:mask-image={`url(${SKILL_TRAINING_COMPLETE})`} style:-webkit-mask-image={`url(${SKILL_TRAINING_COMPLETE})`}></span>
            {:else}
              <img class="apply-book" src={SKILL_BOOK_NOT_YET} alt="" width="32" height="32" />
            {/if}
          </li>
        {/each}
      </ul>
      <span class="answers">
        {#if apply.finished}
          <button type="button" onclick={() => void flow.answerApplyPoints(apply.n, "close")}>{applyWord("UI/SkillTrading/CloseInjectionLabel")}</button>
        {:else}
          <button type="button" disabled={!apply.canConfirm} onclick={() => void flow.answerApplyPoints(apply.n, "confirm").catch(() => {})}>{applyWord("UI/SkillTrading/ConfirmInjectionLabel")}</button>
          <button type="button" onclick={() => void flow.answerApplyPoints(apply.n, "close")}>{applyWord("UI/SkillTrading/CancelInjectionLabel")}</button>
        {/if}
      </span>
    </div>
  </div>
{/if}

{#if $skillBooksAsked !== null}
  {@const books = $skillBooksAsked}
  <div class="client-dialog-shade" class:modal={inFront}>
    <div class="client-dialog" role="dialog" aria-label={bookWord("UI/SkillPlan/MissingSkillbooksWindow/ConfirmPurchaseTitle")} data-dialog="MissingSkillbooksWnd" data-in-front={inFront}>
      {#if !inFront && pilotName !== null}
        <span class="for-pilot">For {pilotName}</span>
      {/if}
      <span class="book-title">
        <strong>{bookWord("UI/SkillPlan/MissingSkillbooksWindow/ConfirmPurchaseTitle")}</strong>
        <button type="button" class="close" aria-label="Close" onclick={() => void flow.answerSkillBooks(books.n, "close")}>✕</button>
      </span>
      {#if books.available.length > 0}
        <section class="book-section">
          <span class="book-heading" title={bookWord("UI/SkillPlan/MissingSkillbooksWindow/RemoteInjectionTooltip")}>
            <span class="skill-mark book"></span>{bookWord("UI/SkillPlan/MissingSkillbooksWindow/AvailableForRemoteInjection")}
          </span>
          <ul class="book-list">
            {#each books.available as skill (skill)}<li>- {nameOf("type", skill)}</li>{/each}
          </ul>
          {#if books.cost !== null}
            <span>{bookWord("UI/SkillPlan/MissingSkillbooksWindow/PriceLabel", { cost: books.cost })}</span>
          {/if}
          <button
            type="button"
            title={bookWord("UI/SkillPlan/MissingSkillbooksWindow/BuyAndInjectTooltip")}
            onclick={() => void flow.answerSkillBooks(books.n, "buy").catch(() => {})}
          >{bookWord("UI/SkillPlan/MissingSkillbooksWindow/BuyAndInjectButton")}</button>
          {#if books.unavailable.length === 0}
            <button type="button" title={bookWord("UI/SkillPlan/MissingSkillbooksWindow/CheckMarketTooltip")} onclick={() => void flow.answerSkillBooks(books.n, "market-available").catch(() => {})}>
              {bookWord("UI/SkillPlan/MissingSkillbooksWindow/CheckMarketButton")}
            </button>
          {/if}
        </section>
      {/if}
      {#if books.available.length > 0 && books.unavailable.length > 0}<hr class="book-line" />{/if}
      {#if books.unavailable.length > 0}
        <section class="book-section">
          <span class="book-heading unavailable" title={bookWord("UI/SkillPlan/MissingSkillbooksWindow/RemoteInjectionTooltip")}>
            <span class="skill-mark book"></span>{bookWord("UI/SkillPlan/MissingSkillbooksWindow/UnavailableForRemoteInjection")}
          </span>
          <ul class="book-list">
            {#each books.unavailable as skill (skill)}<li>- {nameOf("type", skill)}</li>{/each}
          </ul>
          {#if books.available.length === 0}
            <button type="button" title={bookWord("UI/SkillPlan/MissingSkillbooksWindow/CheckMarketTooltip")} onclick={() => void flow.answerSkillBooks(books.n, "market-unavailable").catch(() => {})}>
              {bookWord("UI/SkillPlan/MissingSkillbooksWindow/CheckMarketButton")}
            </button>
          {/if}
        </section>
      {/if}
      {#if books.available.length > 0 && books.unavailable.length > 0}
        <button type="button" title={bookWord("UI/SkillPlan/MissingSkillbooksWindow/CheckMarketTooltip")} onclick={() => void flow.answerSkillBooks(books.n, "market-all").catch(() => {})}>
          {bookWord("UI/SkillPlan/MissingSkillbooksWindow/CheckMarketButton")}
        </button>
      {/if}
    </div>
  </div>
{/if}

{#if $multiBuyAsked !== null}
  {@const buy = $multiBuyAsked}
  {@const sum = buy.rows.reduce((total, row) => total + (row.price ?? 0) * row.qty * buy.multiplier, 0)}
  <div class="client-dialog-shade" class:modal={inFront}>
    <div class="client-dialog multibuy" class:disabled={buy.disabled} role="dialog" aria-label={buyWord("UI/Inventory/ItemActions/MultiBuy")} data-dialog="MultiBuy" data-in-front={inFront}>
      {#if !inFront && pilotName !== null}
        <span class="for-pilot">For {pilotName}</span>
      {/if}
      <span class="book-title">
        <strong>{buyWord("UI/Inventory/ItemActions/MultiBuy")} ({buy.rows.length})</strong>
        <button type="button" class="close" aria-label="Close" onclick={() => void flow.answerMultiBuy(buy.n, "cancel")}>✕</button>
      </span>
      <!-- The import button at the top left (_AddImportButton, its hint the option and how a line is read), and the export
           menu (GetExportMenu): Copy Order to Clipboard and Add Order to Quickbar. Not here: the English copy (only a
           client in another language has it). -->
      <span class="multibuy-tools">
        <button type="button" class="multibuy-import" disabled={buy.busy}
          title={`${buyWord("UI/Market/MarketQuote/ImportShoppingListOption")}\n\n${buyWord("UI/Market/MarketQuote/ImportShoppingListOptionHint", { type1: 1230, type2: 34 })}`}
          onclick={() => void importFromClipboard(buy.n).catch(() => {})}>⎘</button>
        <span class="multibuy-export">
          <button type="button" aria-haspopup="menu" aria-expanded={exportOpen} onclick={() => (exportOpen = !exportOpen)}>☰</button>
          {#if exportOpen}
            <span class="multibuy-menu" role="menu">
              <button type="button" role="menuitem" onclick={() => { exportOpen = false; void navigator.clipboard.writeText(multiBuyExport(buy, sum)).catch(() => {}); }}>{buyWord("UI/Market/MarketQuote/CopyOrderToClipboard")}</button>
              <button type="button" role="menuitem" onclick={() => { exportOpen = false; quickbarNaming = buy.n; }}>{buyWord("UI/Market/MarketQuote/AddOrderToQuickbar")}</button>
            </span>
          {/if}
        </span>
      </span>
      {#if quickbarNaming === buy.n}
        <NamePopup caption={buyWord("UI/Market/Marketbase/FolderName")} label={buyWord("UI/Market/Marketbase/TypeFolderName")} maxLength={20}
          refusal={buyWord("UI/Common/PleaseTypeSomething")} okWord={buyWord("UI/Common/Buttons/OK")} cancelWord={buyWord("UI/Common/Buttons/Cancel")}
          onok={(name) => addOrderToQuickbar(name, buy)} oncancel={() => (quickbarNaming = null)} />
      {/if}
      <span class="multibuy-place">
        <!-- The station list (stationCombo, LoadStationOptions and GetStations): where the pilot is docked first, as Current
             Station, then the system's other markets (the flow's stationList); "No stations available in solar system"
             where it has none (noChoiceLabel). A pick buys there and reads every row's price there (OnStationChanged). -->
        <select disabled={buy.busy || stationOptionsOf(buy).length === 0} value={buy.stationID === null ? "" : String(buy.stationID)}
          onchange={(event) => void flow.editMultiBuy(buy.n, { stationID: Number((event.currentTarget as HTMLSelectElement).value) }).catch(() => {})}>
          {#if stationOptionsOf(buy).length === 0}
            <option value="">{buy.stationList === null ? buyWord("UI/Market/MarketQuote/NoStationSelected") : buyWord("UI/Market/MarketQuote/NotStationsAvailable")}</option>
          {:else}
            {#each stationOptionsOf(buy) as option (option.id)}
              <option value={String(option.id)}>{option.name}</option>
            {/each}
          {/if}
        </select>
        <label class="multibuy-orders">
          <span>{buyWord("UI/Market/MarketQuote/NumberOfOrders")}</span>
          <input type="number" min="1" max="1000" value={buy.multiplier} disabled={buy.busy}
            onchange={(event) => void flow.editMultiBuy(buy.n, { multiplier: Number((event.currentTarget as HTMLInputElement).value) })} />
        </label>
      </span>
      <ul class="multibuy-rows">
        {#each buy.rows as row (row.typeID)}
          {@const shownDelta = row.loading ? null : rowDelta(row)}
          <li class="multibuy-row" class:none={!row.loading && row.price === null}>
            <TypeIcon typeID={row.typeID} name={nameOf("type", row.typeID)} size="sm" />
            <span class="multibuy-name">{nameOf("type", row.typeID)}</span>
            <span class="multibuy-qty">
              <input type="number" min="1" value={row.qty} title={buyWord("UI/Common/Quantity")} disabled={buy.busy}
                onchange={(event) => void flow.editMultiBuy(buy.n, { typeID: row.typeID, qty: Number((event.currentTarget as HTMLInputElement).value) })} />
              {#if buy.multiplier > 1}<span>= {groupedNumber(row.qty * buy.multiplier)}</span>{/if}
            </span>
            <span class="multibuy-price">{row.loading ? "…" : row.price === null ? "-" : isk(row.price)}</span>
            <span class="multibuy-total">{row.loading ? "…" : row.price === null ? "-" : isk(row.price * row.qty * buy.multiplier)}</span>
            <!-- BuyDeltaContainer: its tooltip is the row's (LoadDeltaTooltip), and a click opens the market on the type (OpenMarket). -->
            <button type="button" class="multibuy-delta" class:above={shownDelta !== null && shownDelta.delta > 0} class:below={shownDelta !== null && shownDelta.delta < 0}
              title={row.loading ? "" : rowTooltip(row)} onclick={() => showMarketDetails(row.typeID)}>
              {#if shownDelta !== null}{shownDelta.delta > 0 ? "▲" : shownDelta.delta < 0 ? "▼" : "="} {shownDelta.text}{/if}
            </button>
            <button type="button" class="close" aria-label="Remove" disabled={buy.busy} onclick={() => void flow.editMultiBuy(buy.n, { remove: row.typeID })}>✕</button>
          </li>
        {/each}
      </ul>
      <!-- UpdateNumbers: the total, its description beside it from a million; its tooltip on it and on its info mark, shown where there is a total. -->
      <!-- buySellMultiBase.DrawCheckBox: "use the corporation's account", for a pilot who may trade for it. -->
      {#if buy.corpAccount !== null}
        <label class="multibuy-corp">
          <input type="checkbox" checked={buy.useCorp} disabled={buy.busy || buy.disabled}
            onchange={(event) => void flow.editMultiBuy(buy.n, { useCorp: (event.currentTarget as HTMLInputElement).checked })} />
          {buyWord("UI/Market/MarketQuote/UseCorpAccount", { accountName: corpAccountName(buy.corpAccount) })}
        </label>
      {/if}
      <!-- ShowOrHideStationWarning (442 to 452): none chosen, or not where the pilot is docked. -->
      {#if buy.stationID === null}
        <span class="multibuy-warning">{buyWord("UI/Market/MarketQuote/NoStationSelected")}</span>
      {:else if buy.stationID !== buy.currentStationID}
        <span class="multibuy-warning">{buyWord("UI/Market/MarketQuote/StationWarning")}</span>
      {/if}
      <span class="multibuy-sum" title={totalTooltip(buy, sum)}>{isk(sum)}{sum >= 1e6 ? ` (${iskDescription(sum)})` : ""}{#if sum}<span class="multibuy-info" aria-hidden="true"> ⓘ</span>{/if}</span>
      <span class="answers">
        {#if buy.fitting !== null}
          <button type="button" disabled={buy.busy || buy.disabled || buy.rows.some((row) => row.loading)} title={buyAndFitTooltip(buy.fitting)}
            onclick={() => void flow.answerMultiBuy(buy.n, "buy-and-fit").catch(() => {})}>{buyWord("UI/Market/MarketQuote/BuyAndFit")}</button>
        {/if}
        <button type="button" disabled={buy.busy || buy.disabled || buy.rows.some((row) => row.loading)} onclick={() => void flow.answerMultiBuy(buy.n, "buy").catch(() => {})}>{buyWord("UI/Market/MarketQuote/CommandBuy")}</button>
        <button type="button" onclick={() => void flow.answerMultiBuy(buy.n, "cancel")}>{buyWord("UI/Generic/Cancel")}</button>
      </span>
    </div>
  </div>
{/if}

{#if $viewFittingsAsked.length > 0}
  <!-- The display windows, each opened in the middle and moved by its caption, the one last clicked or loaded in front. -->
  <div class="client-dialog-shade view-fitting-shade" class:modal={inFront}>
    {#each $viewFittingsAsked as view, order (view.n)}
    {@const st = viewStates[view.n]}
    {#if st !== undefined}
    <div class="client-dialog multibuy" role="dialog" tabindex="-1" aria-label={viewWord("UI/Fitting/ShipFitting")} data-dialog="ViewFitting" data-window-id={view.windowID} data-in-front={inFront}
      style:z-index={order + 1} style:transform={`translate(${st.dx}px, ${st.dy}px)`} onpointerdown={() => flow.raiseViewFitting(view.n)}>
      {#if !inFront && pilotName !== null}
        <span class="for-pilot">For {pilotName}</span>
      {/if}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <span class="book-title view-fitting-caption" onpointerdown={(event) => dragViewFitting(event, st)}>
        <strong>{viewWord("UI/Fitting/ShipFitting")}: {nameOf("type", view.fitting.shipTypeID)}</strong>
        <span class="multibuy-export">
          <button type="button" aria-haspopup="menu" aria-expanded={st.menuOpen} onclick={() => (st.menuOpen = !st.menuOpen)}>☰</button>
          {#if st.menuOpen}
            <span class="multibuy-menu" role="menu">
              {#if ($inventory.stationID ?? $inventory.structureID ?? null) !== null}
                <button type="button" role="menuitem" onclick={() => { st.menuOpen = false; void flow.answerViewFitting(view.n, "multifit").catch(() => {}); }}>{viewWord("UI/Fitting/FittingWindow/FittingManagement/OpenMultifit")}</button>
              {/if}
              <button type="button" role="menuitem" title={viewWord("UI/Fitting/FittingWindow/FittingManagement/ExportToClipboardHint")}
                onclick={() => { st.menuOpen = false; void flow.viewFittingText(view.n).then((text) => (text === null ? undefined : navigator.clipboard.writeText(text))).catch(() => {}); }}>{viewWord("UI/Fitting/FittingWindow/FittingManagement/ExportToClipboard")}</button>
            </span>
          {/if}
        </span>
        <button type="button" class="close" aria-label="Close" onclick={() => void flow.answerViewFitting(view.n, "close")}>✕</button>
      </span>
      <span class="multibuy-row view-fitting-name-row">
        <!-- The ship icon (FittingDraggableIcon2): dragged, the fitting shown (its GetDragData, a FittingEntry). Its click's
             preview (ClickDragIcon) is not the page's. -->
        <span class="view-fitting-ship" role="img" aria-label={nameOf("type", view.fitting.shipTypeID)} draggable="true"
          ondragstart={(event) => startFittingDrag(event, {
            fittingID: view.fitting.fittingID > 0 ? view.fitting.fittingID : null,
            shipTypeID: view.fitting.shipTypeID,
            fitData: view.fitting.modules.map((module) => [module.typeID, module.flagID, module.quantity] as const),
            name: view.fitting.name,
          })}><TypeIcon typeID={view.fitting.shipTypeID} name={nameOf("type", view.fitting.shipTypeID)} size="sm" /></span>
        <input class="multibuy-name" maxlength="40" bind:value={() => st.name, (value) => (st.name = value)} aria-label={viewWord("UI/Fitting/FittingWindow/FittingManagement/FittingName")}
          title={view.fitting.source === "personal" ? viewWord("UI/Fitting/FittingWindow/FittingManagement/PersonalFitting") : view.fitting.source === "corporation" ? viewWord("UI/Fitting/FittingWindow/FittingManagement/CorporationFitting") : undefined} />
        <!-- AddFittingNameElements' settings (UtilMenu, SettingMenu): Use Fitting Name for Ship; and its info icon, the
             hull's (LoadNewFitting: infoicon.SetTypeID(fitting.shipTypeID)). -->
        <span class="multibuy-export">
          <button type="button" class="minor" aria-haspopup="menu" aria-expanded={st.settingsOpen} title={viewWord("UI/Common/Settings")}
            onclick={() => (st.settingsOpen = !st.settingsOpen)}>⚙</button>
          {#if st.settingsOpen}
            <span class="multibuy-menu" role="menu">
              <label class="keep">
                <input type="checkbox" checked={$useFittingNameForShips} onchange={(event) => flow.setUseFittingNameForShips(event.currentTarget.checked)} />
                {viewWord("UI/Fitting/FittingWindow/FittingManagement/UseFittingNameForShip")}
              </label>
            </span>
          {/if}
        </span>
        <button type="button" class="fit-entry-info" title={viewWord("UI/Commands/ShowInfo")} aria-label={viewWord("UI/Commands/ShowInfo")}
          onclick={() => showInfo({ kind: "type", typeID: view.fitting.shipTypeID })}><img src={VIEW_FITTING_INFO_ICON} alt="" width="16" height="16" /></button>
      </span>
      {#if view.truncated}
        <!-- AddFittingNameElements' truncated label, shown for a fitting read from a link cut short (LoadNewFitting). -->
        <span class="view-fitting-truncated">{viewWord("UI/Fitting/FittingWindow/FittingManagement/Truncated")}</span>
      {/if}
      <span class="answers">
        <button type="button" class:active={st.tab === "contents"} onclick={() => (st.tab = "contents")}>{viewWord("UI/Fitting/FittingWindow/FittingManagement/Fittings")}</button>
        <button type="button" class:active={st.tab === "description"} onclick={() => (st.tab = "description")}>{viewWord("UI/Common/Description")}</button>
      </span>
      {#if st.tab === "contents"}
        {#if view.contents === null}
          <p>…</p>
        {:else}
          <ul class="multibuy-rows">
            {#each view.contents as group, at (at)}
              <li class="multibuy-row"><strong>{contentsHeading(group.header, view.effectNames)}</strong></li>
              {#each group.entries as entry (entry.typeID)}
                {@const mark = viewFittingEntryMark(group.header, entry.typeID, view.marks)}
                <li class="multibuy-row fit-entry" class:fit-entry-error={mark.frame === "error"} class:fit-entry-dynamic={mark.frame === "dynamic"}
                  oncontextmenu={(event) => openViewFittingEntryMenu(entry.typeID, event)}>
                  <TypeIcon typeID={entry.typeID} name={nameOf("type", entry.typeID)} size="sm" />
                  <span class="multibuy-name">{groupedNumber(entry.qty)}x {nameOf("type", entry.typeID)}</span>
                  {#if mark.icon !== null && mark.tinted}
                    <span class="fit-entry-mark tinted" role="img" title={mark.hint} aria-label={mark.hint}
                      style={`mask-image: url(${mark.icon}); -webkit-mask-image: url(${mark.icon})`}></span>
                  {:else if mark.icon !== null}
                    <img class="fit-entry-mark" src={mark.icon} alt={mark.hint} title={mark.hint} width="16" height="16" />
                  {/if}
                  <button type="button" class="fit-entry-info" title={viewWord("UI/Commands/ShowInfo")} aria-label={viewWord("UI/Commands/ShowInfo")}
                    onclick={() => showInfo({ kind: "type", typeID: entry.typeID })}><img src={VIEW_FITTING_INFO_ICON} alt="" width="16" height="16" /></button>
                </li>
              {/each}
            {/each}
          </ul>
        {/if}
      {:else}
        <textarea rows="6" maxlength="500" bind:value={() => st.description, (value) => (st.description = value)} aria-label={viewWord("UI/Common/Description")}></textarea>
      {/if}
      <span class="answers">
        <!-- LoadNewFitting (235 to 238): Fit disabled for a structure's fitting (categoryStructure). -->
        <button type="button" disabled={view.shipCategoryID === 65} onclick={() => void flow.answerViewFitting(view.n, "fit").catch(() => {})}>{viewWord("UI/Fitting/FittingWindow/FittingManagement/Fit")}</button>
        <!-- AddFitSaveBtns: Save, with its menu (_get_save_sub_menu_data): Save for Alliance where the pilot's corporation is
             its alliance's executor, Save for Corporation, and for the pilot. -->
        <span class="multibuy-export" role="group" onpointerleave={() => (st.savePanelOpen = false)}>
          <button type="button" onpointerenter={() => viewFittingSaveHovered(st)}
            onclick={() => void flow.saveViewFitting(view.n, st.name, st.description).catch(() => {})}>{viewWord("UI/Common/Buttons/Save")}</button>
          <button type="button" class="minor" aria-haspopup="menu" aria-expanded={st.saveMenuOpen}
            onclick={() => { st.saveMenuOpen = !st.saveMenuOpen; if (st.saveMenuOpen) void flow.saveForAllianceOffered().then((offered) => (st.saveForAlliance = offered)).catch(() => {}); }}>▾</button>
          {#if st.saveMenuOpen}
            <span class="multibuy-menu" role="menu">
              {#if st.saveForAlliance}
                <button type="button" role="menuitem" onclick={() => { st.saveMenuOpen = false; void flow.saveViewFitting(view.n, st.name, st.description, "alliance").catch(() => {}); }}>{viewWord("UI/Fitting/FittingWindow/SaveForAlliance")}</button>
              {/if}
              <button type="button" role="menuitem" onclick={() => { st.saveMenuOpen = false; void flow.saveViewFitting(view.n, st.name, st.description, "corporation").catch(() => {}); }}>{viewWord("UI/Fitting/FittingWindow/SaveForCorp")}</button>
              <button type="button" role="menuitem" onclick={() => { st.saveMenuOpen = false; void flow.saveViewFitting(view.n, st.name, st.description, "character").catch(() => {}); }}>{plainText(formatTemplate(wordOf("UI/Fitting/FittingWindow/SaveForCharacter", VIEW_FITTING_WORDS["UI/Fitting/FittingWindow/SaveForCharacter"] ?? ""), { charID: $station.online?.characterID ?? 0 }, { nameOf }))}</button>
            </span>
          {:else if st.savePanelOpen}
            <span class="multibuy-menu save-panel" role="group" data-panel="LoadSaveBtnTooltipPanel">
              {#if st.saveForAlliance}
                <button type="button" onclick={() => { st.savePanelOpen = false; void flow.saveViewFitting(view.n, st.name, st.description, "alliance").catch(() => {}); }}>{viewWord("UI/Fitting/FittingWindow/SaveForAlliance")}</button>
              {/if}
              <button type="button" onclick={() => { st.savePanelOpen = false; void flow.saveViewFitting(view.n, st.name, st.description, "corporation").catch(() => {}); }}>{viewWord("UI/Fitting/FittingWindow/SaveForCorp")}</button>
              <button type="button" onclick={() => { st.savePanelOpen = false; void flow.saveViewFitting(view.n, st.name, st.description, "character").catch(() => {}); }}>{plainText(formatTemplate(wordOf("UI/Fitting/FittingWindow/SaveForCharacter", VIEW_FITTING_WORDS["UI/Fitting/FittingWindow/SaveForCharacter"] ?? ""), { charID: $station.online?.characterID ?? 0 }, { nameOf }))}</button>
            </span>
          {/if}
        </span>
        <button type="button" onclick={() => void flow.answerViewFitting(view.n, "buy").catch(() => {})}>{viewWord("UI/Market/MarketQuote/CommandBuy")}</button>
        <!-- TryAddSimulationBtn: Simulate (SimulateFitting: the Fitting window raised or opened, then the fitting simulated). -->
        <button type="button" class="view-fitting-simulate" onclick={() => { openFittingWindow(); void flow.answerViewFitting(view.n, "simulate").catch(() => {}); }}>{viewWord("UI/Fitting/FittingWindow/Simulate")}</button>
      </span>
    </div>
    {/if}
    {/each}
  </div>
      {#if viewFittingEntryMenu !== null}
        {@const menuFor = viewFittingEntryMenu}
        {@const facts = $hullBrowser?.types.get(menuFor.typeID) ?? null}
        <span class="hull-menu view-fitting-entry-menu" role="menu" use:portal style:left={`${menuFor.x}px`} style:top={`${menuFor.y}px`}>
          <button type="button" role="menuitem" onclick={() => { const typeID = menuFor.typeID; viewFittingEntryMenu = null; showInfo({ kind: "type", typeID }); }}>{viewWord("UI/Commands/ShowInfo")}</button>
          {#if (facts?.marketGroupID ?? null) !== null}
            <button type="button" role="menuitem" onclick={() => { const typeID = menuFor.typeID; viewFittingEntryMenu = null; showMarketDetails(typeID); }}>{viewWord("UI/Inventory/ItemActions/ViewTypesMarketDetails")}</button>
          {/if}
          {#if facts?.published === true}
            <button type="button" role="menuitem" onclick={() => { const typeID = menuFor.typeID; viewFittingEntryMenu = null; findInContracts(typeID); }}>{viewWord("UI/Inventory/ItemActions/FindInContracts")}</button>
            <button type="button" role="menuitem" onclick={() => { const typeID = menuFor.typeID; viewFittingEntryMenu = null; findInPersonalAssets(assetSearchTextForType(viewWord("UI/Inventory/AssetSearch/KeywordTypeExact"), nameOf("type", typeID))); }}>{viewWord("UI/Inventory/ItemActions/FindPersonalAssets")}</button>
          {/if}
          {#if facts !== null && facts.categoryID !== null && COMPARE_CATEGORIES.includes(facts.categoryID)}
            <button type="button" role="menuitem" onclick={() => { const typeID = menuFor.typeID; viewFittingEntryMenu = null; compareType(typeID); }}>{viewWord("UI/Compare/CompareButton")}</button>
          {/if}
        </span>
      {/if}
{/if}

{#if $multiFitAsked !== null}
  {@const fit = $multiFitAsked}
  {@const status = fit.status}
  {@const args = { numToFit: fit.numToFit, fittingName: fit.fitting.name }}
  <div class="client-dialog-shade" class:modal={inFront}>
    <div class="client-dialog multifit" role="dialog" aria-label={fitWord("UI/Fitting/FittingWindow/FittingManagement/MultiFitHeader")} data-dialog="MultiFitWnd" data-in-front={inFront}>
      {#if !inFront && pilotName !== null}
        <span class="for-pilot">For {pilotName}</span>
      {/if}
      <span class="book-title">
        <strong>{fitWord("UI/Fitting/FittingWindow/FittingManagement/MultiFitHeader")}</strong>
        <button type="button" class="close" aria-label="Close" disabled={fit.isFitting} onclick={() => void flow.answerMultiFit(fit.n, "close")}>✕</button>
      </span>
      <div class="multifit-top" class:dimmed={fit.isFitting}>
        <!-- The hull's icon (multiFitWnd shipIcon): its click the fitting shown, dragged the fitting (GetFittingDragData). -->
        <button type="button" class="multifit-icon" title={fitWord("UI/Fitting/ShowFitting")} onclick={() => void flow.answerMultiFit(fit.n, "view").catch(() => {})}
          draggable="true" ondragstart={(event) => startFittingDrag(event, {
            fittingID: fit.fitting.fittingID > 0 ? fit.fitting.fittingID : null,
            shipTypeID: fit.fitting.shipTypeID,
            fitData: fit.fitting.modules.map((module) => [module.typeID, module.flagID, module.quantity] as const),
            name: fit.fitting.name,
          })}>
          <TypeIcon typeID={fit.fitting.shipTypeID} name={nameOf("type", fit.fitting.shipTypeID)} size="lg" />
        </button>
        <div class="multifit-fields">
          <input maxlength="20" value={fit.fitName} title={fitWord("UI/Common/ShipName")} aria-label={fitWord("UI/Common/ShipName")} disabled={fit.isFitting}
            oninput={(event) => void flow.editMultiFit(fit.n, { fitName: event.currentTarget.value })} />
          <span>{nameOf("type", fit.fitting.shipTypeID)}</span>
          <label title={fitWord("UI/Fitting/FittingWindow/FittingManagement/EquipmentLocationHint")}>
            <small>{fitWord("UI/Fitting/FittingWindow/FittingManagement/EquipmentLocation")}</small>
            <select disabled={fit.isFitting} value={fit.locationID === null ? "" : String(fit.locationID)}
              onchange={(event) => void flow.editMultiFit(fit.n, { locationID: event.currentTarget.value === "" ? null : Number(event.currentTarget.value) }).catch(() => {})}>
              <option value="">{fitWord("UI/Inventory/ItemHangar")}</option>
              {#each fit.containers.slice().sort((left, right) => { const a = containerName(left).toLowerCase(); const b = containerName(right).toLowerCase(); return a < b ? -1 : a > b ? 1 : 0; }) as container (container.itemID)}
                <option value={String(container.itemID)}>{containerName(container)}</option>
              {/each}
            </select>
          </label>
        </div>
      </div>
      <div class="multifit-grid" class:dimmed={fit.isFitting}>
        <label class="multifit-count">
          {fitWord("UI/Fitting/FittingWindow/FittingManagement/NumShipsToFit")}
          <input type="number" min="1" max={fit.maxShips} value={fit.numToFit} disabled={fit.isFitting}
            onchange={(event) => void flow.editMultiFit(fit.n, { numToFit: Number(event.currentTarget.value) }).catch(() => {})} />
        </label>
        {#if status !== null && (status.missingShips.length > 0 || status.missingEquipment.length > 0)}
          <p class="multifit-warning" title={[fitWord("UI/Fitting/FittingWindow/FittingManagement/MissingItems", args), ...missingLines([...status.missingShips, ...status.missingEquipment])].join("\n")}>
            {fitWord("UI/Fitting/FittingWindow/FittingManagement/MissingShipEquipment")}
            <button type="button" class="minor" onclick={() => void flow.answerMultiFit(fit.n, "buy-missing").catch(() => {})}>{fitWord("UI/Market/MarketQuote/BuyAll")}</button>
            {@render multiFitGmButtons(fit.n, "missing")}
          </p>
        {/if}
        {#if fit.invalidT3}
          <p class="multifit-warning">{fitWord("UI/Fitting/FittingWindow/FittingManagement/InvalidT3Fit")}</p>
        {/if}
        <div class="multifit-counters">
          <span class="multifit-counter" class:short={status !== null && status.packagedShips < fit.numToFit}
            title={status !== null && status.missingShips.length > 0 ? [fitWord("UI/Fitting/FittingWindow/FittingManagement/MissingShips", args), ...missingLines(status.missingShips)].join("\n") : undefined}>
            {status === null ? "…" : status.packagedShips}
          </span>
          <span title={fitWord("UI/Fitting/FittingWindow/FittingManagement/PackagedShipsInHangarHint")}>{fitWord("UI/Fitting/FittingWindow/FittingManagement/PackagedShipsInHangar")}</span>
          {#if status !== null && status.missingShips.length > 0}
            <span><button type="button" class="minor" onclick={() => void flow.answerMultiFit(fit.n, "buy-ships").catch(() => {})}>{fitWord("UI/Market/MarketQuote/BuyAll")}</button>
              {@render multiFitGmButtons(fit.n, "ships")}</span>
          {:else}<span></span>{/if}
          <span class="multifit-counter" class:short={status !== null && status.maxAvailableFitting !== null && status.maxAvailableFitting < fit.numToFit}
            title={status !== null && status.missingEquipment.length > 0 ? [fitWord("UI/Fitting/FittingWindow/FittingManagement/MissingEquipment", args), ...missingLines(status.missingEquipment)].join("\n") : undefined}>
            {status === null ? "…" : status.maxAvailableFitting === null ? "-" : status.maxAvailableFitting}
          </span>
          <span>{fitWord("UI/Fitting/FittingWindow/FittingManagement/RoundsOfFittingsInLocation", { locationName: fit.locationID === null ? fitWord("UI/Inventory/ItemHangar") : containerName(fit.containers.find((container) => container.itemID === fit.locationID) ?? { itemID: fit.locationID, typeID: 0 }) })}</span>
          {#if status !== null && status.missingEquipment.length > 0}
            <span><button type="button" class="minor" onclick={() => void flow.answerMultiFit(fit.n, "buy-equipment").catch(() => {})}>{fitWord("UI/Market/MarketQuote/BuyAll")}</button>
              {@render multiFitGmButtons(fit.n, "equipment")}</span>
          {:else}<span></span>{/if}
        </div>
        <button type="button" class="minor multifit-refresh" title={fitWord("UI/Fitting/FittingWindow/FittingManagement/RefreshInventoryStatusHint")} disabled={fit.isFitting}
          onclick={() => void flow.answerMultiFit(fit.n, "refresh").catch(() => {})}>⟳</button>
        {#if fit.rigsToFit}
          <label class="keep" title={fitWord("UI/Fitting/FittingWindow/FittingManagement/FitRigsHint")}>
            <input type="checkbox" checked={fit.fitRigs} disabled={fit.isFitting} onchange={(event) => void flow.editMultiFit(fit.n, { fitRigs: event.currentTarget.checked }).catch(() => {})} />
            {fitWord("UI/Fitting/FittingWindow/FittingManagement/FitRigs")}
          </label>
        {/if}
      </div>
      {#if fit.isFitting && status !== null}
        <p class="multifit-progress">{fit.progress} / {status.canFitNum}</p>
      {/if}
      <span class="answers">
        <button type="button" disabled={fit.isFitting || status === null || status.canFitNum < 1 || fit.invalidT3}
          onclick={() => void flow.answerMultiFit(fit.n, "fit").catch(() => {})}>{fitWord("UI/Fitting/FittingWindow/FittingManagement/FitShips", { numToFit: status?.canFitNum ?? 0 })}</button>
        <button type="button" disabled={fit.isFitting} onclick={() => void flow.answerMultiFit(fit.n, "close")}>{fitWord("UI/Common/Close")}</button>
      </span>
    </div>
  </div>
{/if}

{#if $buyAllAsked !== null}
  {@const box = $buyAllAsked}
  <div class="client-dialog-shade" class:modal={inFront}>
    <div class="client-dialog" role="dialog" aria-label={buyAllWord("UI/Common/Information")} data-dialog="BuyAllMessageBox" data-in-front={inFront}>
      {#if !inFront && pilotName !== null}
        <span class="for-pilot">For {pilotName}</span>
      {/if}
      <span class="book-title"><strong>ⓘ {buyAllWord("UI/Common/Information")}</strong></span>
      <p>{buyAllWord("UI/Fitting/MissingItemsHeader")}</p>
      <ul class="multibuy-rows">
        {#each box.missing.slice().sort((left, right) => nameOf("type", left.typeID).toLowerCase().localeCompare(nameOf("type", right.typeID).toLowerCase())) as entry (entry.typeID)}
          <li class="multibuy-row">
            <TypeIcon typeID={entry.typeID} name={nameOf("type", entry.typeID)} size="sm" />
            <span class="multibuy-name">{entry.qty}x {nameOf("type", entry.typeID)}</span>
          </li>
        {/each}
      </ul>
      <span class="answers">
        <button type="button" onclick={() => void flow.answerBuyAll(box.n, "buy").catch(() => {})}>{buyAllWord("UI/Market/MarketQuote/BuyAll")}</button>
        <button type="button" onclick={() => void flow.answerBuyAll(box.n, "close")}>{buyAllWord("/Carbon/UI/Common/Close")}</button>
        <!-- BuyAllMessageBox (52 to 53): GM: Give all, to a session with ROLE_GML; the client's own words, no label's. -->
        {#if sessionHasRole($station.online?.role, ROLE_GML)}
          <button type="button" onclick={() => void flow.answerBuyAll(box.n, "gm-give-all").catch(() => {})}>GM: Give all</button>
        {/if}
      </span>
    </div>
  </div>
{/if}

<!-- MultiFitWnd.AddBuyAllBtn (494 to 505): beside each Buy All, GM: Give all to a session with ROLE_WORLDMOD and GM: Load
     me all to one with ROLE_GML. -->
{#snippet multiFitGmButtons(n: number, which: "missing" | "ships" | "equipment")}
  {#if sessionHasRole($station.online?.role, ROLE_WORLDMOD)}
    <button type="button" class="minor" onclick={() => void flow.multiFitGm(n, which, "create").catch(() => {})}>GM: Give all</button>
  {/if}
  {#if sessionHasRole($station.online?.role, ROLE_GML)}
    <button type="button" class="minor" onclick={() => void flow.multiFitGm(n, which, "load me").catch(() => {})}>GM: Load me all</button>
  {/if}
{/snippet}

<!-- The loading service's progress window (loading.ProgressWnd): its title, its text and how far of how many, over all
     else while it is up. -->
{#if $progressWnd !== null}
  {@const shown = $progressWnd}
  <div class="client-dialog-shade modal">
    <div class="client-dialog progress-wnd" role="dialog" aria-label={shown.title} data-dialog="ProgressWnd">
      <span class="book-title"><strong>{shown.title}</strong></span>
      {#if shown.text !== ""}<p>{shown.text}</p>{/if}
      <progress max={shown.total} value={shown.portion}>{shown.portion} / {shown.total}</progress>
    </div>
  </div>
{/if}

{#if $shipNameAsked !== null}
  <div class="client-dialog-shade" class:modal={inFront}>
    <div class="client-dialog" role="dialog" aria-label={shipWord("UI/Ship/NameChange/WindowTitle")} data-dialog="ShipNameDialog" data-in-front={inFront}>
      <form
        class="quantity"
        onsubmit={(event) => {
          event.preventDefault();
          answerShipName(true);
        }}
      >
        {#if !inFront && pilotName !== null}
          <span class="for-pilot">For {pilotName}</span>
        {/if}
        <strong>{shipWord("UI/Ship/NameChange/WindowTitle")}</strong>
        <label class="ship-name-field">
          <span>{shipWord("UI/Ship/NameChange/InputFieldLabel")}</span>
          <input type="text" maxlength="32" placeholder={shipNameHint} bind:value={shipNameTyped} use:focusAll />
          <span class="ship-name-count">{shipNameTyped.length}/32</span>
        </label>
        <p class="body">{shipWord("UI/Ship/NameChange/InfoLabel")}</p>
        {#if $shipNameAsked.suppress}
          <label class="keep">
            <input type="checkbox" bind:checked={shipNameKeep} />
            {wordOf(DO_NOT_ASK_AGAIN_LABEL, "Do not ask me again")}
          </label>
        {/if}
        <span class="answers">
          <button type="submit">{shipWord("UI/Common/Confirm")}</button>
          <button type="button" onclick={() => answerShipName(false)}>{shipWord("UI/Common/Later")}</button>
        </span>
      </form>
    </div>
  </div>
{/if}

{#if $skillsRequired !== null}
  {@const open = $skillsRequired}
  <div class="client-dialog-shade" class:modal={inFront}>
    <div class="client-dialog" role="dialog" aria-label={skillWord("UI/Generic/Information")} data-dialog="SkillRequirementDialog" data-in-front={inFront}>
      {#if !inFront && pilotName !== null}
        <span class="for-pilot">For {pilotName}</span>
      {/if}
      <strong>{skillWord("UI/Generic/Information")}</strong>
      <span class="skill-head">
        <TypeIcon typeID={open.typeID} name={nameOf("type", open.typeID)} size="md" />
        <span class="skill-type">{nameOf("type", open.typeID)}</span>
      </span>
      <p class="body">{skillWord("Tooltips/SkillPlanner/SkillsRequiredToPerformActivity", { doActivity: skillWord("Tooltips/SkillPlanner/ActivityFlyShip") })}</p>
      <p class="body">
        {skillWord("Tooltips/SkillPlanner/SkillsAndSkillLevels", { numSkills: open.skills.length, numLevels: open.totalMissingLevels })}
        {#if open.missingBooks > 0}{" "}{skillWord("Tooltips/SkillPlanner/MissingSkillBooks", { numMissingBooks: open.missingBooks })}{/if}
      </p>
      <ul class="skill-rows">
        {#each open.skills as [skill, level] (skill)}
          {@const row = open.rows.find((one) => one.skill === skill) ?? null}
          <RequiredSkillRow {skill} {level} mark={row?.mark ?? null} boxes={row?.boxes ?? []} word={skillWord} />
        {/each}
      </ul>
      <!-- AddTrainingTimeForType and AddSkillAction (SkillTrainingAction): the time, the points and Train Skills or Buy
           and Train. -->
      <SkillTrainingAction record={open} activity="Tooltips/SkillPlanner/ActivityFlyShip"
        word={skillWord} timeText={trainingTime}
        apply={applyPointsButton(open, applyWord, () => void flow.applySkillPointsRequired().catch(() => {}), () => flow.dismissSkillsRequired())}
        onTrain={() => void flow.trainSkillsRequired().catch(() => {})} onBuy={() => void flow.buySkillsRequired().catch(() => {})}
        plan={((button) => ({ hint: button.hint, use: () => { flow.dismissSkillsRequired(); button.use(); } }))(createSkillPlanButton({ kind: "type", typeID: open.typeID }, windowPlanCount, skillWord))} />
      <span class="answers">
        <button type="button" onclick={() => flow.dismissSkillsRequired()}>{skillWord("Achievements/AuraText/laterButton")}</button>
      </span>
    </div>
  </div>
{/if}

{#if box !== null}
  <div class="client-dialog-shade" class:modal={inFront}>
    <div class="client-dialog" role="alertdialog" aria-label={box.title} data-dialog={box.said.dialog} data-in-front={inFront}>
      {#if !inFront && pilotName !== null}
        <span class="for-pilot">For {pilotName}</span>
      {/if}
      <strong>{box.title}</strong>
      <div class="body"><LabelText markup={box.markup} {followerOf} /></div>
      {#if box.suppress !== null}
        <label class="keep">
          <input type="checkbox" bind:checked={keepTicked} />
          {box.said.answers === "yesno" || box.said.answers === "okcancel" ? wordOf(DO_NOT_ASK_AGAIN_LABEL, "Do not ask me again") : wordOf(DO_NOT_SHOW_AGAIN_LABEL, "Do not show me this again")}
        </label>
      {/if}
      <span class="answers">
        {#if box.said.answers === "yesno"}
          <button type="button" onclick={() => answerBox("yes")}>{wordOf("UI/Common/Buttons/Yes", "Yes")}</button>
          <button type="button" use:focusDefault={inFront && box.said.defaultAnswer === "no" ? box.said.n : null} onclick={() => answerBox("no")}>{wordOf("UI/Common/Buttons/No", "No")}</button>
        {:else if box.said.answers === "okcancel"}
          <!-- uiconst.OKCANCEL: OK the question's yes, Cancel its no. -->
          <button type="button" onclick={() => answerBox("ok")}>{wordOf("UI/Common/Buttons/OK", "OK")}</button>
          <button type="button" onclick={() => answerBox("no")}>{wordOf("UI/Common/Buttons/Cancel", "Cancel")}</button>
        {:else}
          <button type="button" onclick={() => answerBox("ok")}>OK</button>
        {/if}
      </span>
    </div>
  </div>
{/if}
{#if strip !== null}
  <div class="client-strip" role="status" data-dialog={strip.said.dialog} data-in-front={inFront}>
    {#if !inFront && pilotName !== null}<span class="for-pilot">For {pilotName}</span>{/if}
    <span class="strip-text"><LabelText markup={strip.markup} /></span>
  </div>
{/if}

<style>
  .ceo-choices { display: flex; flex-direction: column; min-height: 8rem; max-height: 45vh; overflow: auto; }
  .ceo-choices button { display: flex; align-items: center; gap: 0.5rem; text-align: left; border-color: transparent; padding: 0.2rem; }
  .ceo-choices button.selected { background: #315a7d; border-color: #86b4d6; }
  .ceo-choice-error { color: #ff5050; font-size: 0.85rem; text-align: center; }
  .skill-type { font-size: 1.05rem; }
  .ship-name-field { display: flex; flex-direction: column; gap: 0.25rem; }
  .ship-name-count { align-self: flex-end; font-size: 0.8rem; opacity: 0.7; }
  .skill-rows { margin: 0; padding-left: 0; list-style: none; display: flex; flex-direction: column; gap: 0.35rem; }
  .skill-head { display: flex; align-items: center; gap: 0.75rem; }
  .skill-mark { width: 12px; height: 14px; flex: none; }
  .skill-mark.book { background: #e0a43c; border-radius: 1px 3px 3px 1px; }
  .dim { opacity: 0.7; }
  .book-title { display: flex; justify-content: space-between; align-items: center; }
  .book-title .close { padding: 0 0.4rem; border: none; background: none; }
  .book-section { display: flex; flex-direction: column; gap: 0.35rem; }
  .book-heading { display: flex; align-items: center; gap: 0.6rem; padding: 0.2rem 0.3rem; background: rgba(51, 51, 51, 0.5); font-size: 1.05rem; }
  .book-heading.unavailable { color: #ff4d4d; }
  .book-list { margin: 0; padding: 0; list-style: none; max-height: 100px; overflow-y: auto; }
  .multibuy { width: min(40rem, calc(100vw - 2rem)); }
  /* The multifit window (multiFitWnd.py): the counts red where short of the count (WARNING_COLOR), the main area faded
     while the ships are fitted (layoutGrid.opacity = 0.2). */
  .multifit { width: min(30rem, calc(100vw - 2rem)); }
  .multifit-top { display: flex; gap: 0.6rem; align-items: flex-start; }
  .multifit-icon { padding: 0; background: none; border: none; }
  .multifit-fields { display: flex; flex-direction: column; gap: 0.3rem; flex: 1; }
  .multifit-fields label { display: flex; align-items: center; gap: 0.4rem; }
  .multifit-grid { display: flex; flex-direction: column; gap: 0.4rem; }
  .multifit-count { display: flex; align-items: center; gap: 0.6rem; }
  .multifit-count input { width: 4rem; }
  .multifit-warning { margin: 0; color: #ff8080; text-align: center; }
  .multifit-counters { display: grid; grid-template-columns: 3rem 1fr auto; align-items: center; gap: 0.3rem 0.6rem; }
  .multifit-counter { text-align: right; font-size: 1.2rem; }
  .multifit-counter.short { color: rgba(255, 0, 0, 0.75); }
  .multifit-refresh { align-self: center; }
  .multifit-progress { margin: 0; text-align: center; font-size: 1.1rem; }
  .dimmed { opacity: 0.2; pointer-events: none; }
  .multibuy-place { display: flex; justify-content: space-between; align-items: flex-end; gap: 0.6rem; }
  .multibuy-orders { display: flex; flex-direction: column; align-items: flex-end; font-size: 0.85rem; }
  /* The client's station warning: large, bold, red (DrawStationWarning: COL_RED). */
  .multibuy-warning { color: #e05050; font-weight: 700; }
  .multibuy-orders input { width: 5rem; }
  .multibuy-rows { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 0.3rem; max-height: 50vh; overflow-y: auto; }
  .multibuy-row { display: grid; grid-template-columns: auto 1fr 7rem 8rem 8rem 5.5rem auto; align-items: center; gap: 0.5rem; }
  .multibuy-delta { text-align: right; font-size: 0.8rem; background: none; border: none; color: inherit; padding: 0; cursor: pointer; }
  .multibuy-info { font-weight: normal; color: var(--muted, #9aa); }
  .multibuy-tools { display: flex; justify-content: space-between; align-items: center; }
  /* ChangeOrderUIState(disable=True): the main area at half opacity until the orders made have run out. */
  .multibuy.disabled .multibuy-rows, .multibuy.disabled .multibuy-place, .multibuy.disabled .multibuy-sum { opacity: 0.5; }
  .multibuy-export { position: relative; }
  .multibuy-menu { position: absolute; right: 0; top: 100%; z-index: 2; display: flex; flex-direction: column; background: var(--panel, #1b2230); border: 1px solid rgba(255, 255, 255, 0.2); padding: 0.2rem; white-space: nowrap; }
  .multibuy-delta.above { color: #ff5050; }
  .multibuy-delta.below { color: #00ff00; }
  .multibuy-row.none { background: rgba(255, 80, 80, 0.12); }
  /* The fitting display window's name row and entries: the name, then the marks and the info icon at the right. */
  .view-fitting-name-row { grid-template-columns: auto 1fr auto auto; }
  /* The display windows over one another in the middle, each where it was dragged to. */
  .view-fitting-shade { display: grid; place-items: center; }
  .view-fitting-shade > .client-dialog { grid-area: 1 / 1; }
  .view-fitting-caption { cursor: move; user-select: none; }
  .view-fitting-ship { cursor: grab; line-height: 0; }
  .view-fitting-truncated { display: block; }
  .multibuy-row.fit-entry { display: flex; padding: 1px 2px; }
  .fit-entry .multibuy-name { flex: 1; min-width: 0; }
  /* FittingModuleEntry's ErrorFrame: red (1, 0, 0) for an obsolete type or one under Other Items, orange (1, 0.35, 0)
     for a dynamic one, at an opacity of 0.1 to 0.2. */
  .fit-entry.fit-entry-error { background: rgba(255, 0, 0, 0.15); box-shadow: inset 0 0 0 1px rgba(255, 0, 0, 0.2); }
  .fit-entry.fit-entry-dynamic { background: rgba(255, 89, 0, 0.15); box-shadow: inset 0 0 0 1px rgba(255, 89, 0, 0.2); }
  .fit-entry-mark { width: 16px; height: 16px; flex: none; }
  /* The warning tinted as the client tints it (SetRGBA(1.0, 0.1, 0.1, 0.8)). */
  .fit-entry-mark.tinted { display: inline-block; background: rgba(255, 26, 26, 0.8); mask-size: 16px 16px; -webkit-mask-size: 16px 16px;
    mask-repeat: no-repeat; -webkit-mask-repeat: no-repeat; }
  .fit-entry-info { flex: none; padding: 0; border: 0; background: none; cursor: pointer; line-height: 0; }
  .multibuy-qty { display: flex; flex-direction: column; }
  .multibuy-qty input { width: 6rem; }
  .multibuy-price, .multibuy-total { text-align: right; }
  .multibuy-sum { align-self: flex-end; font-weight: bold; color: #ff5050; }
  .apply-window { width: min(37.5rem, calc(100vw - 2rem)); }
  .apply-head { padding: 0.4rem 0.5rem; background: rgba(34, 34, 36, 0.7); }
  .apply-description { text-align: center; }
  .apply-rows { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 0.6rem; max-height: 50vh; overflow-y: auto; }
  .apply-row { display: grid; grid-template-columns: 32px 1fr 32px; align-items: start; gap: 0.5rem; }
  .apply-middle { display: flex; flex-direction: column; gap: 0.2rem; }
  .apply-icon, .apply-book { width: 32px; height: 32px; }
  /* skillBookIcon.SetRGBA(default_skillbook_green_color): the completion mark drawn in (0.239, 0.647, 0.278). */
  .apply-book.complete { background-color: rgb(61, 165, 71); mask-size: contain; -webkit-mask-size: contain; mask-repeat: no-repeat; -webkit-mask-repeat: no-repeat; }
  .apply-gauge { position: relative; height: 1.9rem; border: 1px solid rgba(255, 255, 255, 0.25); display: flex; align-items: center; justify-content: center; }
  .apply-fill { position: absolute; left: 0; top: 0; bottom: 0; }
  .apply-fill.with-points { background: rgba(54, 102, 140, 0.6); }
  .apply-fill.trained { background: rgba(62, 168, 217, 0.7); }
  .apply-fill.trained.complete { background: rgba(61, 165, 71, 0.7); }
  .apply-name { position: relative; }
  .apply-saved { display: flex; justify-content: space-between; font-size: 0.8rem; border: 1px solid rgba(255, 255, 255, 0.15); padding: 0.1rem 0.4rem; }
  .book-line { width: 100%; border: none; border-top: 1px solid rgba(240, 248, 255, 0.5); margin: 0.3rem 0; }
  .client-dialog-shade { position: fixed; inset: 0; z-index: 45; display: flex; align-items: center; justify-content: center;
    pointer-events: none; }
  .client-dialog-shade.modal { pointer-events: auto; background: rgba(0, 0, 0, 0.25); }
  .client-dialog { pointer-events: auto; display: flex; flex-direction: column; gap: 0.6rem; width: min(26rem, calc(100vw - 2rem));
    padding: 0.75rem 1rem; background: #14273a; color: #d6e6f7; border: 1px solid #3c6f9e; }
  .body { margin: 0; white-space: pre-line; }
  /* The client's label starts a new line at each line break in its text (trinity, Tr2LabelTextParser.cpp 360 to 375). */
  .strip-text { white-space: pre-line; }
  .answers { display: flex; justify-content: flex-end; gap: 0.4rem; }
  .keep { display: flex; align-items: center; gap: 0.4rem; font-size: 0.9rem; }
  .quantity { display: contents; }
  input { background: #0d1b29; color: inherit; border: 1px solid #3c6f9e; padding: 0.2rem 0.4rem; }
  button { border: 1px solid #5b93c7; background: #1b3956; color: inherit; padding: 0.2rem 1rem; cursor: pointer; }
  .for-pilot { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.8; }
  .client-strip { position: fixed; top: max(20vh, 175px); left: 50%; transform: translateX(-50%); width: 300px; z-index: 44;
    padding: 8px; box-sizing: border-box; text-align: center; pointer-events: none; background: rgba(10, 18, 28, 0.85);
    color: #d6e6f7; border: 1px solid rgba(91, 147, 199, 0.4); }
  .client-strip .for-pilot { display: block; }
</style>
