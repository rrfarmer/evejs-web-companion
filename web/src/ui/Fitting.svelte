<script lang="ts">
  // The fitting window, modelled on EVE's own (goals R12 + R21): the active ship
  // inside a circular ring with its slots as SOCKETS on arcs around it, a slim
  // toolbar down the left, the ship's readings in a COLLAPSIBLE panel down the
  // right, and CPU / powergrid / bay / value read-outs along the bottom — the
  // same shape a capsuleer already knows. A list view stays behind the R8
  // breakpoint for a phone.
  //
  // A pure reader of the store's fitting + inventory + dogma slices. All bind /
  // ListByFlags / Add / SetModuleOnline logic lives on the BFF (which holds the
  // bound-object handles) and in app/flow.ts. Slots are addressed by FAMILY and
  // INDEX — no slot flagID, typeID or itemID is ever rendered.
  //
  // THE IRON RULE: every number here is one the SERVER produced (or pure
  // arithmetic over server numbers). A statistic we cannot honestly source
  // renders the word "Unavailable" with its reason on hover — never a 0 and
  // never an empty cell, because a wrong 0 in a fitting window is a claim we are
  // not entitled to make. Clicking a module shows its EFFECTIVE stats — skills,
  // hull bonuses and in-space effects already applied — taken straight from the
  // server's post-dogma map and never recomputed in the browser.
  import { onMount } from "svelte";
  import { portal } from "./portal.ts";
  import {
    SLOT_FAMILY_LABELS,
    SLOT_FAMILY_ORDER,
    chargeLooksCompatible,
    isChargeRow,
    isFittableRow,
    slotFlagOf,
    slotsOfFamily,
  } from "../bridge/fitting.ts";
  import { CLIENT_GAUGES, CLIENT_GAUGE_LINE, clientGaugePath, type ClientGauge } from "./fittingGeometry.ts";
  import { CLIENT_BASE, CLIENT_GROUP_FLAGS, CLIENT_SLOT_HEIGHT, CLIENT_SLOT_WIDTH, OUTER_RADIUS_PERCENT, clientSlotPlacement, countByFamily, placeFamily } from "./fittingGeometry.ts";
  import { getContext } from "svelte";
  import { CHARGEABLE_GROUP_IDS } from "../bridge/fitModule.ts";
  import { abbreviate } from "./fittingIcons.ts";
  import { HANGAR_NAME, moveQuantityFor, rowsIn } from "./inventoryModel.ts";
  import type { InventoryPlace } from "../store/types.ts";
  // R78 — drag and drop. The RULES (what may be dropped where, and why not) live
  // in a pure module, because a target that decides inside `dragover` can only be
  // checked by dragging onto it — and `dragover` is also what tells the cursor
  // whether a drop is allowed, so a rule written there can promise a drop that
  // the drop handler then refuses.
  import {
    DRAG_MIME,
    carriesOurPayload,
    decodeDrag,
    dropOnPlaceVerdict,
    dropOnSocketVerdict,
    encodeDrag,
    type DragPayload,
  } from "./dragDrop.ts";
  import { startFittingDrag, startFittingSourceDrag } from "./fittingDrag.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { formatNumeric, type PyNumber } from "../bridge/pyNumbers.ts";
  import {
    COLOR_BY_LEVEL,
    FLAG_CPU_GAUGE,
    FLAG_POWERGRID_GAUGE,
    HEADER_BY_LEVEL,
    WARNING,
    WARNING_LEVEL_HIGH,
    WARNING_LEVEL_LOW,
    WARNING_LEVEL_MEDIUM,
    WARNING_LEVEL_SKILL,
    WARNINGS_BY_ID,
    type FitWarningRow,
  } from "../bridge/dogma/fittingWarnings.ts";
  import RequiredSkillRow from "./RequiredSkillRow.svelte";
  import SkillTrainingAction from "./SkillTrainingAction.svelte";
  import { applyPointsButton, trainingTimeText, TYPE_ALPHA_TRAINING_INJECTOR, TYPE_SKILL_INJECTOR } from "./skillAction.ts";
  import { createSkillPlanButton } from "./skillPlanTemplate.ts";
  import { openShipHold } from "./shipHold.ts";
  import { GROUPABLE_GROUP_IDS } from "../bridge/fitModule.ts";
  import { BAY_FLAGS } from "../bridge/inventoryWrites.ts";
  import { COMPARE_CATEGORIES } from "../bridge/dogmaAttributeGroups.ts";
  import type { TypeMetaFacts } from "../app/api.ts";
  import TypeIcon from "./TypeIcon.svelte";
  import LabelText from "./LabelText.svelte";
  import { BridgeCallError } from "../bridge/callMethod.ts";
  import { isSessionLost } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, SkillsRequiredRow, SkillTrainingRecord } from "../app/flow.ts";
  import type {
    FittingResource,
    FittingSlot,
    InventoryItemRow,
    SlotFamily,
  } from "../store/types.ts";
  import { resolvedName, nameKey, type NameRef } from "../store/names.ts";
  import { LAYERS, type LayerName, type Stat, unavailable } from "../bridge/shipStats.ts";
  import { moduleEffectiveStats, type ModuleStat } from "../bridge/moduleAttributes.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { INTERVAL_WORD_LABELS, SHORT_INTERVAL_WORD_LABELS, intervalWriters } from "../bridge/timeInterval.ts";
  import { DISTANCE_WORD_LABELS, distanceSay } from "../space/distanceWords.ts";
  import { fmtDist } from "../space/overview.ts";
  import { hullTree, NON_EMPIRE, type HullFacts, type ShipTraitBonus, type ShipTraits } from "../bridge/hullBrowser.ts";
  import { showInfo } from "./showInfo.ts";
  import type { JsonValue } from "../bridge/wire.ts";
  import { showMarketDetails } from "./marketDetails.ts";
  import { findInPersonalAssets } from "./assetsSearch.ts";
  import { findInContracts } from "./contractsSearch.ts";
  import { compareType, compareTypes } from "./typeCompare.ts";
  import { assetSearchTextForType } from "../bridge/assetSearch.ts";
  import { mailBodyLines } from "../bridge/mailMarkup.ts";

  let {
    store,
    flow,
    showInventory,
  }: {
    store: ClientStore;
    flow: AppFlow;
    /** Opens the Inventory & Ship panel (where the drone bay lives while docked). */
    showInventory?: () => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  const fitting = store.fitting;
  // svelte-ignore state_referenced_locally
  const inventory = store.inventory;
  // svelte-ignore state_referenced_locally
  const flightState = store.flight;
  // svelte-ignore state_referenced_locally
  const spaceState = store.space;
  // svelte-ignore state_referenced_locally
  const dogma = store.dogma;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const savedFittings = flow.savedFittings;
  // svelte-ignore state_referenced_locally
  const communityFittingsEnabled = flow.communityFittingsEnabled;
  // svelte-ignore state_referenced_locally
  const hullBrowser = flow.hullBrowser;
  // svelte-ignore state_referenced_locally
  const maxShipsToFit = flow.maxShipsToFit;
  // svelte-ignore state_referenced_locally
  const fittingsDeletable = flow.fittingsDeletable;
  /** GetDeletableNodes (fittingUtil.CanDeleteFit): the pilot's own, and the corporation's or the alliance's where it may. */
  const deletable = (source: string): boolean => source === "personal" || (source === "corporation" && $fittingsDeletable.corporation) || (source === "alliance" && $fittingsDeletable.alliance);
  // The browser's selection, as its scroll keeps one (scroll.SelectNode, 550 to 598): a click on a fitting selects it
  // alone; Ctrl, it added or taken out; Shift, the run of rows from the last clicked to it, alone (and the last
  // clicked kept), or with Ctrl added to what is selected. By the fittings' numbers, the run by the rows as shown.
  let selectedFittings = $state<readonly number[]>([]);
  let lastSelectedFitting: number | null = null;
  let browserSection = $state<HTMLElement | null>(null);
  /** The fittings' rows as the browser shows them now, in order (the scroll's nodes). */
  const shownFittingIDs = (): number[] => [...(browserSection?.querySelectorAll<HTMLElement>("[data-fitting-id]") ?? [])].map((row) => Number(row.dataset.fittingId));
  function selectFitting(fittingID: number, event: MouseEvent): void {
    const control = event.ctrlKey || event.metaKey;
    const shift = event.shiftKey;
    // fittingBrowser.OnFittingClicked: a click with neither Shift nor Ctrl simulates the fitting too.
    if (!control && !shift) simulateSaved(fittingID);
    const rows = shownFittingIDs();
    const from = lastSelectedFitting === null ? -1 : rows.indexOf(lastSelectedFitting);
    const to = rows.indexOf(fittingID);
    const run = from >= 0 && to >= 0 && from !== to ? rows.slice(Math.min(from, to), Math.max(from, to) + 1) : null;
    if (!control && !shift) selectedFittings = [fittingID];
    else if (control && !shift) {
      selectedFittings = selectedFittings.includes(fittingID) ? selectedFittings.filter((id) => id !== fittingID) : [...selectedFittings, fittingID];
    } else if (!control && shift) {
      if (run !== null) {
        selectedFittings = run;
        return;
      }
      selectedFittings = [fittingID];
    } else if (run !== null) selectedFittings = [...new Set([...selectedFittings, ...run])];
    lastSelectedFitting = fittingID;
  }
  // A fitting no longer kept goes from the selection.
  $effect(() => {
    const kept = new Set(($savedFittings ?? []).map((fitting) => fitting.fittingID));
    if (selectedFittings.some((id) => !kept.has(id))) selectedFittings = selectedFittings.filter((id) => kept.has(id));
  });
  /** GetDeletableNodes of the selection: those of it CanDeleteFit lets go. */
  const selectedDeletable = $derived(selectedFittings.filter((id) => {
    const fitting = ($savedFittings ?? []).find((each) => each.fittingID === id);
    return fitting !== undefined && deletable(fitting.source);
  }));
  /** inventorycommon/const.py categoryStructure. */
  const CATEGORY_STRUCTURE = 65;
  // svelte-ignore state_referenced_locally
  const station = store.station;

  let busy = $state(false);
  let importExportOpen = $state(false);
  let error = $state("");
  /** Which module the player picked to fit, and where it is coming from. */
  let pickedItemID = $state<number | null>(null);
  let pickedSource = $state<"hangar" | "cargo">("hangar");
  /** The rig awaiting an explicit "yes, destroy it" — never a one-click loss. */
  let confirmingRigID = $state<number | null>(null);

  // --- R21 the radial window ------------------------------------------------

  /**
   * Which layout the player is looking at. The default is decided on mount
   * from the viewport (list on a phone, radial above the R8 breakpoint) and
   * then REMEMBERED, so an explicit choice always beats the guess.
   *
   * It starts as "radial" rather than reading the viewport here because this
   * component also renders under the server generator (panelFirstMount), where
   * there is no `window` at all.
   */
  let view = $state<"radial" | "list">("radial");
  const VIEW_STORAGE_KEY = "evejs.fitting.view";

  /** Which socket the player has selected; its actions show beneath the ring. */
  let selected = $state<{ family: SlotFamily; index: number } | null>(null);

  function chooseView(next: "radial" | "list"): void {
    view = next;
    selected = null;
    try {
      globalThis.localStorage?.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // A browser with storage blocked still gets the toggle, just not the
      // memory of it. Never let that break the panel.
    }
  }

  /** The slots shown: the simulation's while the window simulates the ship, the ship's own otherwise. */
  const shownSlots = $derived.by(() => ($fitting.simulation ? $fitting.simulation.slots : $fitting.slots));

  /**
   * The play page's windows (PlayApp's "retailChrome" context): the client's own ring - fittingLayout.py's base, the
   * slots where SlotAdder puts them (fittingGeometry clientSlotPlacement), turned with the ring, a hull's missing flags
   * drawn faint (EntryAnimation's 0.05 for a disabled slot).
   */
  const retail = getContext("retailChrome") === true;
  /** The play page's ship view for the ring's middle (play/fittingScene.ts), where it gives one. */
  type ShipTurretFit = { typeID: number; slot: number; count: number; moduleID: number; online: boolean };
  const shipSceneOf = getContext<((host: HTMLElement) => { show(typeID: number | null): Promise<void>; setFit(fits: readonly ShipTurretFit[]): void; close(): void }) | undefined>("fittingShipScene");
  /** UpdateHardpoints (not while simulating): the high and medium slots' modules, slot = the place in the rack + 1. */
  const shipTurretFits = $derived.by<ShipTurretFit[]>(() => simulation ? [] : shownSlots
    .filter((s) => s.module && (s.family === "high" || s.family === "mid"))
    .map((s) => ({ typeID: s.module!.typeID, slot: s.index + 1, count: 1, moduleID: s.module!.itemID, online: s.module!.online })));
  function shipScene(host: HTMLElement, arg: { typeID: number | null; fits: ShipTurretFit[] }) {
    const view = shipSceneOf!(host);
    void view.show(arg.typeID);
    view.setFit(arg.fits);
    return {
      update: (next: { typeID: number | null; fits: ShipTurretFit[] }) => { void view.show(next.typeID); view.setFit(next.fits); },
      destroy: () => view.close(),
    };
  }
  /** The flags a group has that the hull lacks, as the client draws them (its empty slot icon, faint). */
  const absentPlaces = $derived.by(() => {
    if (!retail) return [];
    const out: { family: SlotFamily; index: number; x: number; y: number; angle: number }[] = [];
    for (const family of SLOT_FAMILY_ORDER) {
      const have = slotsOfFamily(shownSlots, family).length;
      // (every group's every flag, the subsystems' too on a hull without them: FittingController's slotsByGroups)
      for (let index = have; index < CLIENT_GROUP_FLAGS[family]; index++) {
        const p = clientSlotPlacement(family, index);
        out.push({ family, index, x: (p.x / CLIENT_BASE) * 100, y: (p.y / CLIENT_BASE) * 100, angle: p.angleDegrees });
      }
    }
    return out;
  });
  /**
   * slot.py UpdateFitting's charge indicator (81_64_2.png, a 44 x 7 piece of it at rectTop 10 x step, the slot's top
   * edge less 2): a loaded charge's step min(4, int(portion x 5)) of the module's capacity; a chargeable module with
   * none, step 0; others none. The portions, by module, as the page reads them (flow.chargePortionOf).
   */
  let chargePortions = $state<Record<string, number>>({});
  $effect(() => {
    if (!retail) return;
    for (const slot of shownSlots) {
      const module = slot.module, charge = module?.charge;
      if (!module || !charge) continue;
      const key = `${module.itemID}:${charge.typeID}:${charge.quantity}`;
      if (key in chargePortions) continue;
      void flow.chargePortionOf?.(module.typeID, charge.typeID, Math.max(1, charge.quantity)).then((portion) => {
        if (portion !== null) chargePortions = { ...chargePortions, [key]: portion };
      }).catch(() => {});
    }
  });
  function chargeStep(slot: FittingSlot): number | null {
    const module = slot.module;
    if (!module) return null;
    if (module.charge) {
      const portion = chargePortions[`${module.itemID}:${module.charge.typeID}:${module.charge.quantity}`];
      return portion === undefined ? null : Math.max(0, Math.min(4, Math.trunc(portion * 5)));
    }
    return CHARGEABLE_GROUP_IDS.has(module.groupID ?? -1) ? 0 : null;
  }
  /** fittingSlotController.UpdateStatusDisplay (a simulation only): the fill's texture by the module's kind and state. */
  function fillTexture(slot: FittingSlot): string | null {
    const state = simulatedState(slot), flagID = slotFlagOf(slot.family, slot.index);
    if (state === null || flagID === null || !simulation) return null;
    const name = (simulation.moduleKinds[flagID] ?? 1) === 1 ? (state === 3 ? "slotoverheated" : "slotactive") : "slotpassive";
    return `/client-res/ui/texture/classes/fitting/${name}.png`;
  }

  /** The empty slot's icon (slot.py: 81_64_7 high, _6 mid, _5 low, _8 rig; subsystems' by flag, turned 180°). */
  const EMPTY_SLOT_ICON: Record<SlotFamily, string> = { high: "81_64_7", mid: "81_64_6", low: "81_64_5", rig: "81_64_8", subsystem: "81_64_11" };
  const SUBSYSTEM_ICONS = ["81_64_11", "81_64_10", "81_64_12", "81_64_13"];
  function emptyIcon(family: SlotFamily, index: number): string {
    const name = family === "subsystem" ? SUBSYSTEM_ICONS[index] ?? EMPTY_SLOT_ICON.subsystem : EMPTY_SLOT_ICON[family];
    return `/client-res/ui/texture/icons/${name}.png`;
  }

  /** The sockets to draw, with each one's placement and what is in it. */
  const sockets = $derived.by(() => {
    const counts = countByFamily(shownSlots);
    const placed: {
      slot: FittingSlot;
      xPercent: number;
      yPercent: number;
      angle?: number;
    }[] = [];
    if (retail) {
      for (const family of SLOT_FAMILY_ORDER) {
        slotsOfFamily(shownSlots, family).forEach((slot, index) => {
          const p = clientSlotPlacement(family, index);
          placed.push({ slot, xPercent: (p.x / CLIENT_BASE) * 100, yPercent: (p.y / CLIENT_BASE) * 100, angle: p.angleDegrees });
        });
      }
      return placed;
    }
    for (const family of SLOT_FAMILY_ORDER) {
      const placements = placeFamily(family, counts[family], OUTER_RADIUS_PERCENT);
      const familySlots = slotsOfFamily(shownSlots, family);
      for (const placement of placements) {
        const slot = familySlots[placement.index];
        if (slot) {
          placed.push({
            slot,
            xPercent: placement.xPercent,
            yPercent: placement.yPercent,
          });
        }
      }
    }
    return placed;
  });

  /** A key per family for the legend: label, how many, how many filled; of the slots the ship has (not one gone). */
  const legend = $derived.by(() =>
    SLOT_FAMILY_ORDER.map((family) => {
      const familySlots = slotsOfFamily(shownSlots, family).filter((slot) => slot.present !== false);
      return {
        family,
        label: SLOT_FAMILY_LABELS[family],
        total: familySlots.length,
        filled: familySlots.filter((slot) => slot.module !== null).length,
      };
    }).filter((entry) => entry.total > 0),
  );

  const selectedSlot = $derived.by<FittingSlot | null>(() => {
    if (selected === null) {
      return null;
    }
    return (
      $fitting.slots.find(
        (slot) => slot.family === selected!.family && slot.index === selected!.index,
      ) ?? null
    );
  });

  function isSelected(slot: FittingSlot): boolean {
    return selected !== null && selected.family === slot.family && selected.index === slot.index;
  }

  /**
   * Clicking a socket. Holding a module and tapping an EMPTY socket fits it
   * straight in — that is the gesture the layout exists for. Anything else
   * selects the socket and shows its actions underneath.
   */
  function clickSocket(slot: FittingSlot): void {
    if (slot.module === null && pickedItemID !== null) {
      fitInto(slot);
      return;
    }
    selected = isSelected(slot) ? null : { family: slot.family, index: slot.index };
    confirmingRigID = null;
  }

  /** What an EMPTY socket shows: its number within its family. */
  function socketText(slot: FittingSlot): string {
    return String(slot.index + 1);
  }

  /** The full spoken/hover description of a socket — never an abbreviation. */
  function socketDescription(slot: FittingSlot): string {
    if (!slot.module) {
      return `${slotName(slot)}, empty`;
    }
    const name = moduleName(slot.module.typeID);
    if (slot.family === "rig" || slot.family === "subsystem") {
      return `${slotName(slot)}, ${name}`;
    }
    // What is loaded belongs in the socket's own description: the tile is a
    // picture of the MODULE, so this is the only place a player learns the gun
    // has ammunition in it without opening something else.
    const loaded = slot.module.charge
      ? `, loaded with ${chargeCount(slot.module.charge.quantity)} ${moduleName(slot.module.charge.typeID)}`
      : "";
    return `${slotName(slot)}, ${name}, ${slot.module.online ? "online" : "offline"}${loaded}`;
  }

  // The fitting window's browser of saved fittings (fittingScreen/browsers/fittingBrowser.py), as far as the page has
  // it: its tree of ship groups, races and hulls with the fittings under each hull (bridge/hullBrowser.ts), and of a
  // fitting's menu (GetFittingMenu) View Fitting, Fit to Active Ship, Buy All and Delete Fitting (for the pilot's own:
  // CanDeleteFit) and Open Multifit (the multifit window, ClientDialogs.svelte), its import and export menu's Import
  // from Clipboard and Export to Clipboard (not its Simulate from Clipboard, its files nor Copy All Skills), and the
  // tooltips of a fitting and of a hull (its traits with them), a hull's menu (Show Info, View Market Details, Find in
  // Contracts, Find Personal Assets and Compare), and the selection's Delete Fitting for several at once
  // (DeleteManyFittings). Its words are the install's; the page's own stand in. Not done: a hull's Simulate button, the
  // menu's Simulate Fitting, a fitting clicked (simulated), and an unsupported fitting shown whole to a game master. A
  // group's or a race's menu is the client's ShipParentGroup's: Compare, then Expand or Collapse. Delete Fitting is offered as GetDeletableNodes offers it (the
  // corporation's and the alliance's by role). The tree's open groups are kept while the window is.
  const FITTING_BROWSER_WORDS: Readonly<Record<string, string>> = {
    // The browser's own button (fittingWnd.py 100, BROWSE_FITTINGS).
    "UI/Fitting/FittingWindow/ShipAndFittings": "Ships and fittings",
    // A hull's traits in its tooltip (traits.TraitsContainer) and its menu (menusvc.GetMenuFromItemIDTypeID).
    "UI/ShipTree/SkillNameCaption": "With each level of {skillName}:",
    "UI/ShipTree/RoleBonus": "By its role:",
    "UI/ShipTree/MiscBonus": "Besides:",
    "UI/InfoWindow/TraitWithNumber": "{value}{unit} {bonusText}",
    "UI/InfoWindow/TraitWithoutNumber": "- {bonusText}",
    "UI/Commands/ShowInfo": "About it",
    "UI/Inventory/ItemActions/ViewTypesMarketDetails": "Its market",
    "UI/Inventory/ItemActions/FindPersonalAssets": "Where you have it",
    "UI/Inventory/ItemActions/FindInContracts": "Contracts of it",
    "UI/Compare/CompareButton": "Side by side",
    // A group's menu after its Compare (ListGroup.GetMenu, 299 to 304).
    "UI/Common/Expand": "Open it",
    "UI/Common/Collapse": "Close it",
    // The asset search's exact-type keyword (assetSearchUtil, KeywordTypeExact): a word the search reads, not shown.
    "UI/Inventory/AssetSearch/KeywordTypeExact": "typeExact",
    "UI/Fitting/FittingWindow/ViewFitting": "Look at it",
    // The fitting window's own button (hullAndHardwareTypeBrowser.py 577).
    "UI/Fitting/FittingWindow/SaveFitAs": "Save this ship's fitting",
    "UI/Fitting/FittingWindow/FitFittingToActiveShip": "Fit to this ship",
    "UI/Fitting/FittingWindow/FittingManagement/DeleteFitting": "Delete it",
    "UI/Fitting/FittingWindow/FittingManagement/OpenMultifit": "Fit several ships",
    // The browser's import and export menu (hullAndHardwareTypeBrowser.py 680 to 694).
    "UI/Fitting/FittingWindow/ImportAndExport": "Import and export",
    "UI/Fitting/FittingWindow/FittingManagement/ImportFromClipboard": "Read a fitting from the clipboard",
    "UI/Fitting/FittingWindow/FittingManagement/ImportFromClipboardHint": "",
    "UI/Fitting/FittingWindow/FittingManagement/ExportToClipboard": "Copy this ship's fitting as text",
    "UI/Fitting/FittingWindow/FittingManagement/ExportToClipboardHint": "",
    // Said by the import (flow.ts importFittingFromClipboard): asked here, where it is made.
    "UI/SkillQueue/CouldNotReadLines": "",
    "UI/Market/MarketQuote/BuyAll": "Shop for all of it",
    "UI/Common/NothingFound": "None found",
    // The browser's filter buttons' hints (hullAndHardwareTypeBrowser.py 406 to 413, LoadFilterBtnTooltipPanel).
    "UI/Fitting/FittingWindow/FilterPersonalFittings": "Your own fittings {numFittings}",
    "UI/Fitting/FittingWindow/FilterCorpFittings": "Your corporation's fittings {numFittings}",
    "UI/Fitting/FittingWindow/FilterCurrentHull": "Only for the ship you are in",
    "UI/Fitting/FittingWindow/FilterSkillsForFitting": "Only those you have the skills for",
    "UI/Fitting/FilterCommunityFittings": "Fittings shared with everyone",
    "UI/Fitting/FittingWindow/FilterAllianceFittings": "Your alliance's fittings {numFittings}",
    "UI/Fitting/AllianceFittingHint": "Your alliance's fitting",
    "UI/Fitting/FittingWindow/SavedAllianceFittings": "Your alliance's fittings",
    // A fitting's tooltip (entries/fitting.py FittingEntry.LoadTooltipPanel, 87 to 98) and a hull's
    // (fittingBrowser.py HullTypeListGroup.LoadTooltipPanel, 705 to 738).
    "UI/Fitting/FittingLastSavedHint": "Saved {timestamp}",
    "/Carbon/UI/Common/DateTime/SimpleDateUTC": "",
    "UI/Fitting/FittingWindow/SavedFittings": "Saved fittings",
    "UI/Fitting/FittingWindow/PersonalFittingsNum": "Your own: {numFittings}",
    "UI/Fitting/FittingWindow/PersonalFittingsNumShort": "Own: {numFittings}",
    "UI/Fitting/FittingWindow/CorpFittingsNum": "Your corporation's: {numFittings}",
    "UI/Fitting/FittingWindow/CorpFittingsNumShort": "Corporation: {numFittings}",
    "UI/Fitting/FittingWindow/CommunityFittingsNum": "Shared with everyone: {numFittings}",
    "UI/Fitting/FittingWindow/CommunityFittingsNumShort": "Shared: {numFittings}",
    "UI/Fitting/FittingWindow/AllianceFittingsNum": "Your alliance's: {numFittings}",
    "UI/Fitting/FittingWindow/AllianceFittingsNumShort": "Alliance: {numFittings}",
    "UI/Fitting/FittingWindow/NoFittingsSaved": "No fittings saved for it",
    // The tree's own groups (fittingBrowser.py 131 to 182, GetNameAndIconIDForRace).
    "UI/Fitting/FittingWindow/NonEmpireFaction": "Other factions",
    "UI/Fitting/FittingWindow/SpecialEditionShips": "Special ships",
    "UI/Fitting/FittingWindow/UnsupportedShip": "Hulls no longer had",
    "UI/Fitting/FittingWindow/UnknownShipType": "an unknown hull",
    // A fitting's owner mark (entries/fitting.py FittingEntry.Load, 58 to 70) and a hull's counts by owner
    // (fittingBrowser.py ShipTypeGroup, 630 to 650).
    "UI/Fitting/CorpFittingHint": "Your corporation's fitting",
    "UI/Fitting/CommunityFittingHint": "A fitting shared with everyone",
    "UI/Fitting/FittingWindow/SavedPersonalFittings": "Your own fittings",
    "UI/Fitting/FittingWindow/SavedCorpFittings": "Your corporation's fittings",
    "UI/Fitting/FittingWindow/SavedCommunityFittings": "Fittings shared with everyone",
    // Said as a fitting is loaded (flow.ts loadSavedFitting): asked here, where it is loaded from.
    "UI/Fitting/ShipHasRigsAlready": "",
    "UI/Fitting/FittingWindow/FittingManagement/BusyFittingWarning": "",
  };
  const fitWord = (label: string): string => {
    const template = $words.templates[label];
    return plainText(typeof template === "string" && template !== "" ? template : FITTING_BROWSER_WORDS[label] ?? "");
  };
  $effect(() => {
    if (!$fitting.activeShipID) return;
    flow.requestWords(Object.keys(FITTING_BROWSER_WORDS));
  });

  // The capacitor panel's words (capacitorPanel.py), the client's from the player's install; the page's own where it
  // has none.
  const CAPACITOR_WORDS: Readonly<Record<string, string>> = {
    "UI/Fitting/FittingWindow/Stable": "Stable",
    "UI/Fitting/FittingWindow/CapacitorNotStable": "Empty after {[timeinterval]time.shortForm, from=hour, to=second}",
    "UI/Fitting/FittingWindow/ModulesSustainable": "Your modules can run without stopping",
    "UI/Fitting/FittingWindow/ModulesNotSustainable": "Your modules drain the capacitor faster than it recharges",
    "UI/Fitting/FittingWindow/CapacitorDelta": "{[numeric]delta, decimalPlaces=1} GJ/s spare ({[numeric]percentage, decimalPlaces=1}%)",
    "UI/Fitting/FittingWindow/ExcessCapacitor": "Recharge left over",
    "UI/Fitting/FittingWindow/CapSustainableBy": "Settles at {[numeric]balance, decimalPlaces=1}% of its capacity",
    "UI/Fitting/FittingWindow/CapRunsOutBy": "Lasts {[timeinterval]ttl, from=hour, to=second}",
    "UI/Fitting/FittingWindow/CapacitorCapAndRechargeTime": "{capacitorCapacity} / {capacitorRechargeTime}",
    "UI/Fitting/FittingWindow/CapacityAndRechargeRate": "Capacity and recharge time",
    // (the price label's, priceLabel.py, asked with these)
    "UI/Fitting/FittingWindow/FmtMillionIskShort": "{[numeric]amount, decimalPlaces=2}M ISK",
    "UI/Fitting/FittingWindow/FmtBillionIskShort": "{[numeric]amount, decimalPlaces=2}B ISK",
    "UI/Fitting/FittingWindow/TotalEstimatedPrice": "Total estimated price",
    "UI/Generic/NotAvailableShort": "N/A",
  };
  /**
   * The play page's price label (fittingScreen/priceLabel.py LabelPriceLabelCont.UpdateLabel): every type fitted to
   * the ship (modules and their charges - the pilot left out), in its cargo and its drone bay, by quantity, times
   * typeHelpers.GetAveragePrice (the cfg's average prices, flow.cfgAveragePrices), summed; under a million
   * FmtISKAndRound, past a billion FmtBillionIskShort, else FmtMillionIskShort; nothing priced, NotAvailableShort.
   */
  let averagePrices = $state<ReadonlyMap<number, number | null> | null>(null);
  $effect(() => {
    if (!retail || averagePrices) return;
    void flow.cfgAveragePrices?.().then((prices) => { if (prices) averagePrices = prices; }).catch(() => {});
  });
  const fitPrice = $derived.by(() => {
    if (!retail) return null;
    const qty = new Map<number, number>();
    const add = (typeID: number, n: number) => qty.set(typeID, (qty.get(typeID) ?? 0) + Math.max(1, n));
    for (const slot of shownSlots) {
      if (!slot.module) continue;
      add(slot.module.typeID, 1);
      if (slot.module.charge) add(slot.module.charge.typeID, slot.module.charge.quantity);
    }
    if (simulation) {
      for (const c of simulation.cargo) add(c.typeID, c.quantity);
      for (const d of simulation.drones) add(d.typeID, d.total);
    } else {
      for (const row of $inventory.cargo.rows) add(row.typeID, row.quantity);
    }
    let total = 0;
    for (const [typeID, n] of qty) { const p = averagePrices?.get(typeID) ?? null; if (p) total += n * p; }
    if (!total) return capacitorWord("UI/Generic/NotAvailableShort");
    if (total < 1_000_000) return `${Math.round(total).toLocaleString()} ISK`;
    if (total > 1_000_000_000) return capacitorWord("UI/Fitting/FittingWindow/FmtBillionIskShort", { amount: total / 1_000_000_000 });
    return capacitorWord("UI/Fitting/FittingWindow/FmtMillionIskShort", { amount: total / 1_000_000 });
  });
  /**
   * The play page's capacitor menu (capacitorPanel.py): the power core - min(10, int(capacity / 50)) columns, each
   * max(12, min(16, int(192 / columns))) wide and 30 high in a 30 x 30 box at 5, 5, turned by column x 360 / columns,
   * three capacitorCell.png cells down from its top (8 - 2i wide, 4 high, at 4i), added on; ColorPowerCore: of the
   * cells, last column's first, the first int(loadBalance x cells) in BAD_COLOR x (1 - balance) + GOOD_COLOR x balance,
   * the rest EMPTY_COLOR - and the capacity and recharge line, and the delta line, 45 in.
   */
  const clientCapacitor = $derived.by(() => {
    if (!retail) return null;
    const cap = stats.capacitor;
    const capacity = cap.capacity.known ? cap.capacity.value : null;
    const columns = capacity === null ? 0 : Math.min(10, Math.trunc(capacity / 50));
    const width = Math.max(12, Math.min(16, columns ? Math.trunc(192 / columns) : 0));
    const total = columns * 3;
    const sim = cap.simulator ?? null;
    const visible = sim ? Math.max(0, Math.min(total, Math.trunc(sim.loadBalance * total))) : 0;
    const lb = sim?.loadBalance ?? 0;
    const lit = `rgb(${[70 / 256 * (1 - lb) + 240 / 256 * lb, 26 / 256 * (1 - lb) + 90 / 256 * lb, 13 / 256 * (1 - lb) + 50 / 256 * lb].map((c) => Math.round(Math.min(1, c) * 255)).join(", ")})`;
    const cells: { col: number; cell: number; color: string }[] = [];
    for (let col = 0; col < columns; col++) {
      for (let cell = 0; cell < 3; cell++) {
        // powerUnits.insert(0, cell): the last added comes first
        const order = total - 1 - (col * 3 + cell);
        cells.push({ col, cell, color: order < visible ? lit : "rgba(64, 64, 64, 0.75)" });
      }
    }
    const capText = capacity === null || !cap.rechargeSeconds.known ? "" : capacitorWord("UI/Fitting/FittingWindow/CapacitorCapAndRechargeTime", {
      capacitorCapacity: `${Math.trunc(capacity).toLocaleString()} GJ`, capacitorRechargeTime: asSeconds(cap.rechargeSeconds.value),
      startColorTag1: "", startColorTag2: "", endColorTag: "",
    });
    const deltaText = sim ? capacitorWord("UI/Fitting/FittingWindow/CapacitorDelta", { delta: sim.delta, percentage: sim.deltaPercentage }) : "";
    return { columns, width, step: columns ? 360 / columns : 0, cells, capText, deltaText, hint: sim ? capacitorBalance(sim) : "" };
  });
  $effect(() => {
    if (!$fitting.activeShipID) return;
    flow.requestWords([...Object.keys(CAPACITOR_WORDS), ...INTERVAL_WORD_LABELS, ...SHORT_INTERVAL_WORD_LABELS]);
  });
  /** A capacitor label filled: the client's template where the install has it, the page's own otherwise. */
  function capacitorWord(label: string, args: Record<string, string | number> = {}): string {
    const template = $words.templates[label];
    return plainText(formatTemplate(typeof template === "string" && template !== "" ? template : CAPACITOR_WORDS[label] ?? "", args, {
      nameOf: (kind, id) => String($names.resolved[nameKey(kind, id)] ?? id),
      ...intervalWriters($words.templates),
    }));
  }
  type CapacitorSimulation = NonNullable<typeof stats.capacitor.simulator>;
  /** capacitorPanel.SetHeaderText: Stable where it settles, else when it runs dry (its TTL, a whole number of ticks). */
  function capacitorHeadline(simulation: CapacitorSimulation): string {
    return simulation.loadBalance > 0
      ? capacitorWord("UI/Fitting/FittingWindow/Stable")
      : capacitorWord("UI/Fitting/FittingWindow/CapacitorNotStable", { time: Math.trunc(simulation.ttl ?? 0) });
  }
  // The targeting and navigation panels' words (targetingPanel.py, navigationPanel.py), the client's from the install;
  // the page's own where it has none.
  const SHIP_WORDS: Readonly<Record<string, string>> = {
    "UI/Fitting/FittingWindow/TargetingHeader": "{[numeric]maxRange, useGrouping} km",
    "UI/Fitting/FittingWindow/ScanResolution": "{[numeric]resolution} mm",
    "UI/Fitting/FittingWindow/MaxLockedTargets": "{[numeric]maxTargets} at once",
    "UI/Fitting/FittingWindow/TargetingRange": "{[numeric]range.distance, decimalPlaces=1}",
    "UI/Fitting/FittingWindow/SensorStrength": "{[numeric]points} {[numeric]points -> \"point\", \"points\"}",
    "UI/Fitting/FittingWindow/MassTonnes": "{[numeric]mass, useGrouping} tonnes",
    "UI/Fitting/FittingWindow/MassKg": "{[numeric]mass, useGrouping} kilograms",
    "UI/Fitting/FittingWindow/ColoredMaxVelocity": "{[numeric]maxVelocity, decimalPlaces=1} metres a second",
    "UI/Fitting/FittingWindow/InertiaModifier": "{[numeric]value, decimalPlaces=4} times",
    "UI/Fitting/FittingWindow/AlignTime": "{[numeric]value, decimalPlaces=2} seconds",
    "UI/Fitting/FittingWindow/WarpSpeed": "{distText} a second",
  };
  $effect(() => {
    if (!$fitting.activeShipID) return;
    flow.requestWords([...Object.keys(SHIP_WORDS), ...DISTANCE_WORD_LABELS]);
  });
  const say = $derived(distanceSay($words.templates));
  /** A targeting or navigation label filled: the client's template where the install has it, the page's own otherwise. */
  function shipWord(label: string, args: Record<string, string | number> = {}): string {
    const template = $words.templates[label];
    return plainText(formatTemplate(typeof template === "string" && template !== "" ? template : SHIP_WORDS[label] ?? "", args, {
      nameOf: (kind, id) => String($names.resolved[nameKey(kind, id)] ?? id),
      writeDistance: (metres, decimals) => fmtDist(metres, decimals, say),
    }));
  }
  /** const.AU, in metres. */
  const METRES_PER_AU = 149_597_870_700;
  /** The worded figure of a known statistic; "—" where it is not known. */
  function knownWord(stat: Stat, word: (value: number) => string): string {
    return stat.known ? word(stat.value) : "—";
  }

  // The defense panel's words (defensePanel.py), the client's from the install; the page's own where it has none.
  const DEFENSE_WORDS: Readonly<Record<string, string>> = {
    "UI/Fitting/FittingWindow/ColoredEffectiveHp": "{[numeric]effectiveHp, useGrouping} effective hit points",
    "UI/Fitting/FittingWindow/ColoredResistanceLabel": "{[numeric]number}%",
    "UI/Fitting/FittingWindow/ColoredHitpointsAndRechargeTime2": "{hp} hit points, back in {[numeric]rechargeTime, useGrouping} s",
    "UI/Fitting/FittingWindow/ColoredHp2": "{hp} hit points",
    "UI/Fitting/FittingWindow/ColoredPassiveRepairRate": "{[numeric]hpPerSec, decimalPlaces=1} hit points a second",
    "UI/Fitting/FittingWindow/NoModule": "None fitted",
    "UI/Fitting/FittingWindow/ArmorRepairRate": "Armor repaired",
    "UI/Fitting/FittingWindow/HullRepairRate": "Structure repaired",
    "UI/Fitting/FittingWindow/ShieldBoostRate": "Shield boosted",
    "UI/Fitting/FittingWindow/PassiveShieldRecharge": "Shield recharging by itself",
    "UI/Common/Shield": "Shield",
    "UI/Common/Armor": "Armor",
    "UI/Fitting/Structure": "Structure",
  };
  $effect(() => {
    if (!$fitting.activeShipID) return;
    flow.requestWords(Object.keys(DEFENSE_WORDS));
  });
  /** A defense label filled: the client's template where the install has it, the page's own otherwise. */
  function defenseWord(label: string, args: Record<string, string | number> = {}): string {
    const template = $words.templates[label];
    return plainText(formatTemplate(typeof template === "string" && template !== "" ? template : DEFENSE_WORDS[label] ?? "", args, {
      nameOf: (kind, id) => String($names.resolved[nameKey(kind, id)] ?? id),
    }).replace(/<br\s*\/?>/gi, " "));
  }
  type DefenseSimulation = NonNullable<typeof stats.defense>;
  /** defensePanel._GetFormattedValue: the hit points' whole part, grouped (a short form past a hundred million). */
  function hitPoints(value: number): string {
    const whole = Math.trunc(value);
    return whole > 100_000_000 ? `${Math.round(whole / 1_000_000).toLocaleString()}M` : whole.toLocaleString();
  }
  /** SetDefenseLayerText: the shield with its recharge time, the others alone. */
  function layerText(simulation: DefenseSimulation, layer: "shield" | "armor" | "structure"): string {
    const hp = hitPoints(simulation.layers[layer].hp);
    return layer === "shield"
      ? defenseWord("UI/Fitting/FittingWindow/ColoredHitpointsAndRechargeTime2", { hp, rechargeTime: simulation.shieldRechargeSeconds, startColorTag1: "", startColorTag2: "", endColorTag: "" })
      : defenseWord("UI/Fitting/FittingWindow/ColoredHp2", { hp });
  }
  /** UpdateBestRepair's choices: the passive recharge, and each kind of repairer's rate and count (or none). */
  function repairLines(simulation: DefenseSimulation): { readonly label: string; readonly text: string }[] {
    const rate = (repair: { readonly hpPerSec: number; readonly modules: number } | null): string =>
      repair === null
        ? defenseWord("UI/Fitting/FittingWindow/NoModule")
        : `${repair.hpPerSec ? defenseWord("UI/Fitting/FittingWindow/ColoredPassiveRepairRate", { hpPerSec: repair.hpPerSec }) : "0"} (${repair.modules})`;
    return [
      { label: defenseWord("UI/Fitting/FittingWindow/PassiveShieldRecharge"), text: defenseWord("UI/Fitting/FittingWindow/ColoredPassiveRepairRate", { hpPerSec: simulation.passiveShieldRecharge }) },
      { label: defenseWord("UI/Fitting/FittingWindow/ShieldBoostRate"), text: rate(simulation.repairs.shieldBoost) },
      { label: defenseWord("UI/Fitting/FittingWindow/ArmorRepairRate"), text: rate(simulation.repairs.armorRepair) },
      { label: defenseWord("UI/Fitting/FittingWindow/HullRepairRate"), text: rate(simulation.repairs.hullRepair) },
    ];
  }
  const DEFENSE_LAYERS = [
    { layer: "shield", label: "UI/Common/Shield" },
    { layer: "armor", label: "UI/Common/Armor" },
    { layer: "structure", label: "UI/Fitting/Structure" },
  ] as const;

  // The offense panel's words (offensePanel.py), the client's from the install; the page's own where it has none.
  const OFFENSE_WORDS: Readonly<Record<string, string>> = {
    "UI/Fitting/FittingWindow/DpsLabel": "{[numeric]dps, decimalPlaces=1} damage a second",
    "UI/Fitting/FittingWindow/DpsLabelWithRange": "{[numeric]dps, decimalPlaces=1} to {[numeric]maxDps, decimalPlaces=1} damage a second",
    "UI/Fitting/FittingWindow/TurretsDps": "Guns",
    "UI/Fitting/FittingWindow/MissilesDps": "Launchers",
    "UI/Fitting/FittingWindow/DotDps": "Damage over time",
    "UI/Fitting/FittingWindow/SmartbombsDps": "Area weapons",
    "UI/Fitting/FittingWindow/DronesDps": "Drones",
    "UI/Fitting/FittingWindow/NumDronesActive": "{[numeric]numDrones} active",
    "UI/Fitting/FittingWindow/ManageDrones": "Manage drones",
    "UI/Fitting/FittingWindow/WithReloadTimeText": "counting reloads",
    // The fighter panel (fighterPanel.py), a structure's in the drones' place.
    "UI/Common/Fighters": "Fighters",
    "UI/Fitting/FittingWindow/NumFullSquadrons": "{[numeric]numSquadrons} full squadrons",
    "UI/Fitting/FittingWindow/NumPartialSquadrons": "{[numeric]numSquadrons} squadrons short of full",
    "UI/Fitting/FittingWindow/FighterBay": "Fighter bay",
  };
  $effect(() => {
    if (!$fitting.activeShipID) return;
    flow.requestWords(Object.keys(OFFENSE_WORDS));
  });
  /** An offense label filled: the client's template where the install has it, the page's own otherwise. */
  function offenseWord(label: string, args: Record<string, string | number> = {}): string {
    const template = $words.templates[label];
    return plainText(formatTemplate(typeof template === "string" && template !== "" ? template : OFFENSE_WORDS[label] ?? "", args, {
      nameOf: (kind, id) => String($names.resolved[nameKey(kind, id)] ?? id),
    }));
  }
  /** offensePanel._GetDpsText: the damage a second (a range where a spool's top differs), and with reloading where that differs. */
  function dpsText(dps: number, withReload: number | null, maxDps: number | null = null, maxWithReload: number | null = null): { readonly text: string; readonly withReload: string | null } {
    const label = maxDps ? "UI/Fitting/FittingWindow/DpsLabelWithRange" : "UI/Fitting/FittingWindow/DpsLabel";
    const text = offenseWord(label, { dps, maxDps: maxDps ?? 0 });
    const reload = withReload && withReload !== dps ? `(${offenseWord(label, { dps: withReload, maxDps: maxWithReload ?? 0 })})` : null;
    return { text, withReload: reload };
  }
  type OffenseSimulation = NonNullable<typeof stats.firepower.simulator>;
  /** _UpdateOffenseStats: the total, with reloading beside it where that differs. */
  function offenseHeadline(simulation: OffenseSimulation): string {
    const total = offenseWord("UI/Fitting/FittingWindow/DpsLabel", { dps: simulation.totalDps });
    return simulation.totalDpsWithReload && simulation.totalDpsWithReload !== simulation.totalDps
      ? `${total} (${offenseWord("UI/Fitting/FittingWindow/DpsLabel", { dps: simulation.totalDpsWithReload })})`
      : total;
  }
  /** LoadDpsTooltipPanel's lines: each kind of weapon that does damage, with its damage a second. */
  function offenseLines(simulation: OffenseSimulation): { readonly label: string; readonly text: string; readonly withReload: string | null }[] {
    const lines: { label: string; text: string; withReload: string | null }[] = [];
    if (simulation.turretDps) lines.push({ label: offenseWord("UI/Fitting/FittingWindow/TurretsDps"), ...dpsText(simulation.turretDps, simulation.turretDpsWithReload, simulation.maxTurretDps, simulation.maxTurretDpsWithReload) });
    if (simulation.missileDps) lines.push({ label: offenseWord("UI/Fitting/FittingWindow/MissilesDps"), ...dpsText(simulation.missileDps, simulation.missileDpsWithReload) });
    if (simulation.dotDps) lines.push({ label: offenseWord("UI/Fitting/FittingWindow/DotDps"), ...dpsText(simulation.dotDps, null) });
    if (stats.drones?.dps) lines.push({ label: offenseWord("UI/Fitting/FittingWindow/DronesDps"), ...dpsText(stats.drones.dps, null) });
    if (simulation.aoeDps) lines.push({ label: offenseWord("UI/Fitting/FittingWindow/SmartbombsDps"), ...dpsText(simulation.aoeDps, null) });
    return lines;
  }

  /** capacitorPanel.ColorPowerCore's hint: the share it settles at, or how long it lasts. */
  function capacitorBalance(simulation: CapacitorSimulation): string {
    return simulation.loadBalance === 0
      ? capacitorWord("UI/Fitting/FittingWindow/CapRunsOutBy", { ttl: Math.trunc(simulation.ttl ?? 0) })
      : capacitorWord("UI/Fitting/FittingWindow/CapSustainableBy", { balance: simulation.loadBalance * 100 });
  }
  // The fittings read once the window has a ship (fittingSvc.PrimeFittings).
  let fittingsAsked = false;
  $effect(() => {
    if (!$fitting.activeShipID || fittingsAsked) return;
    fittingsAsked = true;
    void flow.loadSavedFittings().catch(() => {});
  });
  // The browser's filters (hullAndHardwareTypeBrowser.construct_fitting_filter_buttons, 405 to 414;
  // filterSettings.BrowserHullSettings): the pilot's own fittings, its corporation's, and only those for the ship it is
  // in, each off until set (with no owner set, every owner's are shown: GetFittingScrolllist, 74 to 79); and the search
  // (CharSettingString lastHullFilterString, the character's), which a fitting's name, its hull's name or the hull's
  // group's holds (FilterOutFittings, TextMatched, 265 to 320). The toggles are the account's (UserSettingBool), kept
  // here in this browser, as is the search for the character. The skills' filter lets through only the fittings the pilot has the skills for (FilterOutFittings,
  // 283 to 289; the flow's fittingsWithSkills, fittingSvc.HasSkillForFit). The community's filter is on until unset
  // (fittings_show_community, FILTER_DEFAULT_COMMUNITY_FITTING), and with the global config's community fittings off
  // (AreCommunityFittingsEnabled) its button is not shown nor its fittings read (GetFittingScrolllist, 66 to 80). With no
  // owner's filter set, every hull the market sells is listed that the search (its name or its group's), the
  // current-hull filter and the skills filter (godma.CheckSkillRequirementsForType: the flow's hullsWithSkills) let
  // through (GetAllShipGroupsAndShipsByGroupID, 359 to 383). The alliance's filter is off until set, and with the pilot in
  // no alliance its button is not shown nor its fittings read (fittings_show_alliance; GetFittingScrolllist, 70).
  const HULL_SETTINGS_KEPT = "evejs.BrowserHullSettings";
  const HULL_FILTER_KEPT = "evejs.lastHullFilterString";
  const keptHullSettings = ((): { personal: boolean; corp: boolean; alliance: boolean; community: boolean; currentShip: boolean; skills: boolean } => {
    try {
      const kept = JSON.parse(localStorage.getItem(HULL_SETTINGS_KEPT) ?? "null") as Record<string, unknown> | null;
      return { personal: kept?.personal === true, corp: kept?.corp === true, alliance: kept?.alliance === true, community: kept?.community !== false, currentShip: kept?.currentShip === true, skills: kept?.skills === true };
    } catch {
      return { personal: false, corp: false, alliance: false, community: true, currentShip: false, skills: false };
    }
  })();
  let allianceFilterSet = $state(keptHullSettings.alliance);
  /** session.allianceid, as the page has it: null for none. */
  const allianceID = $derived(((id) => (id !== null && id !== undefined && id > 0 ? id : null))($station.online?.allianceID));
  /** showAllianceFittings: the alliance's filter, where the pilot is in one. */
  const showAllianceFittings = $derived(allianceID !== null && allianceFilterSet);
  let communityFilterSet = $state(keptHullSettings.community);
  /** showCommunityFittings: the community's filter, where the global config has community fittings on. */
  const showCommunityFittings = $derived($communityFittingsEnabled && communityFilterSet);
  let onlyWithSkills = $state(keptHullSettings.skills);
  /** The fittings the pilot has the skills for, as the flow last answered; null while none is answered. */
  let fittingsWithSkills = $state<ReadonlySet<number> | null>(null);
  $effect(() => {
    if (!onlyWithSkills) return;
    const ids = ($savedFittings ?? []).map((saved) => saved.fittingID);
    void flow.fittingsWithSkills(ids).then((set) => { fittingsWithSkills = set; }).catch(() => {});
  });
  /** The market's hulls the pilot has the skills for, as the flow last answered; null while none is answered. */
  let hullsWithSkills = $state<ReadonlySet<number> | null>(null);
  $effect(() => {
    const data = $hullBrowser;
    if (!onlyWithSkills || ownerFilterIsSet || data === null || !data.available) return;
    void flow.hullsWithSkills(data.hullTypeIDs).then((set) => { hullsWithSkills = set; }).catch(() => {});
  });
  // The browser's hulls read once there are fittings to place (the client's own data), with each fitting's hull.
  $effect(() => {
    if ($savedFittings === null) return;
    void flow.loadHullBrowser([...new Set($savedFittings.map((saved) => saved.shipTypeID))]).catch(() => {});
  });
  let showPersonalFittings = $state(keptHullSettings.personal);
  let showCorpFittings = $state(keptHullSettings.corp);
  let onlyCurrentHull = $state(keptHullSettings.currentShip);
  const hullFilterKey = (): string | null => {
    const characterID = store.station.get().online?.characterID ?? null;
    return characterID === null ? null : `${HULL_FILTER_KEPT}.${characterID}`;
  };
  let hullFilterText = $state(((): string => {
    try {
      const key = hullFilterKey();
      return key === null ? "" : localStorage.getItem(key) ?? "";
    } catch {
      return "";
    }
  })());
  function keepHullSettings(): void {
    try {
      localStorage.setItem(HULL_SETTINGS_KEPT, JSON.stringify({ personal: showPersonalFittings, corp: showCorpFittings, alliance: allianceFilterSet, community: communityFilterSet, currentShip: onlyCurrentHull, skills: onlyWithSkills }));
      const key = hullFilterKey();
      if (key !== null) localStorage.setItem(key, hullFilterText);
    } catch {
      // Storage refused: the filters hold while the window is open.
    }
  }
  // The hulls' names and their groups' (every hull the market sells, where they are listed), for the tree and the
  // search; and the races' names (the messages their records name).
  $effect(() => {
    const listed = !ownerFilterIsSet && $hullBrowser?.available ? $hullBrowser.hullTypeIDs : [];
    const hulls = [...new Set([...($savedFittings ?? []).map((saved) => saved.shipTypeID), ...listed])];
    if (hulls.length > 0) flow.requestNames(hulls.flatMap((id) => [{ kind: "type" as const, id }, { kind: "typeGroup" as const, id }]));
  });
  $effect(() => {
    const races = Object.values($hullBrowser?.raceNameIDs ?? {}).flatMap((messageID) => (messageID === null ? [] : [`#${messageID}`]));
    if (races.length > 0) flow.requestWords(races);
  });
  /** A race's name (characterdata/races.py get_race_name), the non-empire factions' the browser's own label. */
  function raceName(raceID: number): string {
    if (raceID === NON_EMPIRE) return fitWord("UI/Fitting/FittingWindow/NonEmpireFaction");
    const messageID = $hullBrowser?.raceNameIDs[raceID] ?? null;
    const template = messageID === null ? undefined : $words.templates[`#${messageID}`];
    return typeof template === "string" && template !== "" ? plainText(template) : String(raceID);
  }
  // The tree's groups, races and hulls opened (the client's list groups' open state), while the window is open.
  let opened = $state<Record<string, boolean>>({});
  function toggled(id: string, event: Event): void {
    const open = (event.currentTarget as HTMLDetailsElement).open;
    if ((opened[id] === true) !== open) opened[id] = open;
  }
  /** A filter button's hint with the owner's count (LoadFilterBtnTooltipPanel: "(n/most)"). */
  function filterHint(label: string, count: number, most: number): string {
    const template = $words.templates[label];
    return plainText(formatTemplate(typeof template === "string" && template !== "" ? template : FITTING_BROWSER_WORDS[label] ?? "", { numFittings: `(${count}/${most})` }, { nameOf: (kind, id) => String($names.resolved[nameKey(kind, id)] ?? id) }));
  }
  const hullName = (typeID: number): string => String($names.resolved[nameKey("type", typeID)] ?? "");
  const hullGroupName = (typeID: number): string => String($names.resolved[nameKey("typeGroup", typeID)] ?? "");
  /** A label's words with its arguments, the page's own where the install's are not to hand. */
  function fitWords(label: string, args: Record<string, string | number>): string {
    const template = $words.templates[label];
    return plainText(formatTemplate(typeof template === "string" && template !== "" ? template : FITTING_BROWSER_WORDS[label] ?? "", args, { nameOf: (kind, id) => String($names.resolved[nameKey(kind, id)] ?? id) }));
  }
  /**
   * FittingEntry.LoadTooltipPanel (entries/fitting.py 87 to 98): the fitting's name, its hull's, its description where
   * it has one, and when it was saved (FittingLastSavedHint, FmtDate: SimpleDateUTC) where it says. As a hint's lines;
   * the description's markup as its text.
   */
  function fittingTooltip(saved: { readonly name: string; readonly shipTypeID: number; readonly description: string; readonly savedDate: bigint | null }): string {
    const lines = [plainText(saved.name), hullName(saved.shipTypeID)];
    if (saved.description) lines.push(plainText(saved.description));
    if (saved.savedDate) {
      const date = $words.templates["/Carbon/UI/Common/DateTime/SimpleDateUTC"];
      const timestamp = typeof date === "string" && date !== "" ? plainText(formatTemplate(date, { datetime: saved.savedDate.toString() }, { nameOf: () => "" })) : "";
      if (timestamp) lines.push(fitWords("UI/Fitting/FittingLastSavedHint", { timestamp }));
    }
    return lines.join("\n");
  }
  /**
   * HullTypeListGroup.LoadTooltipPanel (fittingBrowser.py 705 to 738): the hull's name; then each owner's count of its
   * fittings that has any, the community's only where community fittings are on and the alliance's only for a pilot
   * in one, in short words under "Saved Fittings" where two owners or more have any; NoFittingsSaved where none has.
   * Then the hull's traits, where it has any (HasTraits, TraitsContainer: traitLines).
   */
  // svelte-ignore state_referenced_locally
  const shipTraits = flow.shipTraits;
  /** A message of the client's by its number, made plain; none where the page has not got it. */
  const messageText = (messageID: number | null): string => {
    const template = messageID === null ? undefined : $words.templates[`#${messageID}`];
    return typeof template === "string" ? plainText(template) : "";
  };
  /**
   * TraitsContainer (traits.py 34 to 125) as lines of a hint: a caption for each skill the bonuses go with, by the
   * skill's number (SkillNameCaption), then for the role's (RoleBonus) and the others (MiscBonus); under each its bonuses
   * by importance (_GetBonusText: TraitWithNumber, the bonus rounded to a tenth and a whole one as such, with its unit's
   * name; TraitWithoutNumber where it has no number). The markup is made plain, its tab a space.
   */
  function traitLines(traits: ShipTraits): string[] {
    const traitWords = (label: string, args: Record<string, JsonValue>): string => {
      const template = $words.templates[label];
      const text = typeof template === "string" && template !== "" ? template : FITTING_BROWSER_WORDS[label] ?? "";
      return plainText(formatTemplate(text.split("<t>").join(" "), args, { nameOf: (kind, id) => String($names.resolved[nameKey(kind, id)] ?? id) }));
    };
    const bonusLine = (bonus: ShipTraitBonus): string => {
      const bonusText = messageText(bonus.nameID);
      if (bonus.bonus === null) return traitWords("UI/InfoWindow/TraitWithoutNumber", { color: "", bonusText });
      // round(bonus, 1), and an int where int(bonus) == bonus (Python 2 rounds a half away from nought): given as a long,
      // which the numeric tag writes as an int ("5", where the float would be "5.0").
      const value: JsonValue = Number.isInteger(bonus.bonus)
        ? { type: "long", value: String(bonus.bonus) }
        : (Math.sign(bonus.bonus) * Math.round(Math.abs(bonus.bonus) * 10)) / 10;
      const unit = messageText(bonus.unitID === null ? null : $shipTraits.unitNameIDs.get(bonus.unitID) ?? null);
      return traitWords("UI/InfoWindow/TraitWithNumber", { color: "", value, unit, bonusText });
    };
    const lines: string[] = [];
    const add = (caption: string, bonuses: readonly ShipTraitBonus[]): void => {
      lines.push(caption);
      for (const bonus of [...bonuses].sort((left, right) => left.importance - right.importance)) lines.push(`  ${bonusLine(bonus)}`);
    };
    for (const skill of [...traits.skills].sort((left, right) => left.skillTypeID - right.skillTypeID)) {
      add(traitWords("UI/ShipTree/SkillNameCaption", { skillName: hullName(skill.skillTypeID) }), skill.bonuses);
    }
    if (traits.role.length > 0) add(fitWord("UI/ShipTree/RoleBonus"), traits.role);
    if (traits.misc.length > 0) add(fitWord("UI/ShipTree/MiscBonus"), traits.misc);
    return lines;
  }
  // A hull's menu (HullTypeListGroup.GetMenu, 693 to 695: menusvc.GetMenuFromItemIDTypeID(None, typeID,
  // includeMarketDetails=True), 2281 to 2352) on its right click: Show Info, and View Market Details where the type has a
  // market group, and where it is published Find in Contracts (contracts.FindRelated: the contracts window's search for
  // the type, contractsSearch.ts) and Find Personal Assets (invItemFunctions.FindInPersonalAssets: the assets window's
  // search for the type's exact name, assetsSearch.ts); and Compare, the type's category being among compareCategories
  // (2347 to 2348: every hull's is; CompareType, the compare tool, typeCompare.ts). Not the page's: a GM's "GM / WM
  // Extras".
  // The same menu is a picker's entry's and a tube's squadron's (ItemPickerBase.GetMenu, SingleTube.GetSquadronMenu:
  // GetMenuFromItemIDTypeID(itemID, typeID, includeMarketDetails=True); the item only Show Info's, and the simulation's
  // items have no info of their own), its type's market group, publishing and category read as it opens (`facts`:
  // undefined for a hull, whose the browser holds; null until read).
  let hullMenu = $state<{ readonly typeID: number; readonly x: number; readonly y: number; readonly facts?: TypeMetaFacts | null } | null>(null);
  function openHullMenu(typeID: number, event: MouseEvent): void {
    event.preventDefault();
    nodeMenu = null;
    hullMenu = { typeID, x: event.clientX, y: event.clientY };
  }
  function openTypeMenu(typeID: number, event: MouseEvent): void {
    event.preventDefault();
    nodeMenu = null;
    hullMenu = { typeID, x: event.clientX, y: event.clientY, facts: null };
    void flow.typeFacts([typeID]).then((read) => {
      const facts = read?.get(typeID) ?? null;
      if (facts !== null && hullMenu?.typeID === typeID && hullMenu.facts === null) hullMenu = { ...hullMenu, facts };
    }).catch(() => {});
  }
  /** The menu's type's market group, publishing, whether it may be compared (compareCategories), and its name. */
  type TypeMenu = NonNullable<typeof hullMenu>;
  const menuMarketGroup = (menu: TypeMenu) => (menu.facts === undefined ? $hullBrowser?.types.get(menu.typeID)?.marketGroupID ?? null : menu.facts?.marketGroupID ?? null);
  const menuPublished = (menu: TypeMenu) => (menu.facts === undefined ? $hullBrowser?.types.get(menu.typeID)?.published === true : menu.facts?.published === true);
  const menuComparable = (menu: TypeMenu) => (menu.facts === undefined ? true : COMPARE_CATEGORIES.includes(menu.facts?.categoryID ?? -1));
  const menuTypeName = (menu: TypeMenu) => (menu.facts === undefined ? hullName(menu.typeID) : moduleName(menu.typeID));
  // A group's or a race's menu (ShipParentGroup.GetMenu, fittingBrowser.py 579 to 583): Compare, which compares the
  // node's hulls in the order it holds them (menusvc.CompareTypes(node.typeIDs): the compare tool opened, typeCompare.ts);
  // then the list group's own (ListGroup.GetMenu, 284 to 311): Expand or Collapse, the node being locked (no Change
  // Label, no Delete Folder) and kept from a window of its own (BlockOpenWindow). The Special Edition Ships group is
  // given its hulls as "typeIds" (fittingBrowser.py 138), so its typeIDs are None, and its Compare raises in CompareTypes
  // before anything opens: here it does nothing (typeIDs null).
  let nodeMenu = $state<{ readonly typeIDs: readonly number[] | null; readonly id: string; readonly x: number; readonly y: number } | null>(null);
  function openNodeMenu(typeIDs: readonly number[] | null, id: string, event: MouseEvent): void {
    event.preventDefault();
    hullMenu = null;
    nodeMenu = { typeIDs, id, x: event.clientX, y: event.clientY };
  }
  $effect(() => {
    if (hullMenu === null && nodeMenu === null) return;
    const close = (event: Event): void => {
      if (!(event.target instanceof Element && event.target.closest(".hull-menu"))) {
        hullMenu = null;
        nodeMenu = null;
      }
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        hullMenu = null;
        nodeMenu = null;
      }
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
  function hullTooltip(typeID: number): string {
    const count = fittingNumByTypeID.get(typeID) ?? { personal: 0, corporation: 0, community: 0, alliance: 0 };
    const owners = [count.personal, count.corporation, count.community, count.alliance].filter((each) => each > 0).length;
    const short = owners >= 2;
    const lines = [hullName(typeID)];
    if (short) lines.push(fitWord("UI/Fitting/FittingWindow/SavedFittings"));
    const numAndPaths: [number, string][] = [
      [count.personal, "UI/Fitting/FittingWindow/PersonalFittingsNum"],
      [count.corporation, "UI/Fitting/FittingWindow/CorpFittingsNum"],
      ...($communityFittingsEnabled ? [[count.community, "UI/Fitting/FittingWindow/CommunityFittingsNum"] as [number, string]] : []),
      ...(allianceID !== null ? [[count.alliance, "UI/Fitting/FittingWindow/AllianceFittingsNum"] as [number, string]] : []),
    ];
    for (const [numFittings, path] of numAndPaths) {
      if (numFittings) lines.push(fitWords(short ? `${path}Short` : path, { numFittings }));
    }
    if (!owners) lines.push(fitWord("UI/Fitting/FittingWindow/NoFittingsSaved"));
    // HasTraits: then its traits (TraitsContainer), asked as the hull is pointed at.
    const traits = $shipTraits.traits.get(typeID);
    if (traits) lines.push("", ...traitLines(traits));
    return lines.join("\n");
  }
  /** A hull's fittings of each owner, every one read (fittingBrowser.GetNumShipsByTypeID, 200 to 211). */
  const fittingNumByTypeID = $derived.by(() => {
    const counts = new Map<number, { personal: number; corporation: number; community: number; alliance: number }>();
    for (const saved of $savedFittings ?? []) {
      const count = counts.get(saved.shipTypeID) ?? { personal: 0, corporation: 0, community: 0, alliance: 0 };
      counts.set(saved.shipTypeID, { ...count, [saved.source]: count[saved.source] + 1 });
    }
    return counts;
  });
  /** ownerFilterIsSet: an owner's fittings asked for (GetFittingScrolllist, 74). */
  const ownerFilterIsSet = $derived(showPersonalFittings || showCorpFittings || showAllianceFittings || showCommunityFittings);
  /** The fittings the filters let through (FilterOutFittings, 265 to 296). */
  const shownFittings = $derived.by(() => {
    const shownOwner = { personal: showPersonalFittings, corporation: showCorpFittings, community: showCommunityFittings, alliance: showAllianceFittings };
    const text = hullFilterText.toLowerCase();
    const shown = ($savedFittings ?? []).filter((saved) => {
      if (ownerFilterIsSet && !shownOwner[saved.source]) return false;
      if (onlyWithSkills && fittingsWithSkills !== null && !fittingsWithSkills.has(saved.fittingID)) return false;
      if (onlyCurrentHull && activeShipTypeID !== null && saved.shipTypeID !== activeShipTypeID) return false;
      return !text || saved.name.toLowerCase().includes(text) || hullName(saved.shipTypeID).toLowerCase().includes(text) || hullGroupName(saved.shipTypeID).toLowerCase().includes(text);
    });
    return shown;
  });
  /**
   * The browser's tree (bridge/hullBrowser.ts): with no owner's filter set, the market's hulls the search (a hull's name
   * or its group's), the current-hull filter (none at all with no ship: GetAllShipGroupsAndShipsByGroupID, 368 to
   * 369) and the skills filter let through, besides the fittings'. Null where the client's data is not had.
   */
  const browserTree = $derived.by(() => {
    const data = $hullBrowser;
    if (data === null || !data.available) return null;
    const text = hullFilterText.toLowerCase();
    const marketHulls = ownerFilterIsSet ? [] : data.hullTypeIDs.filter((typeID) => {
      if (text && !hullName(typeID).toLowerCase().includes(text) && !hullGroupName(typeID).toLowerCase().includes(text)) return false;
      if (onlyCurrentHull && activeShipTypeID !== typeID) return false;
      return !(onlyWithSkills && hullsWithSkills !== null && !hullsWithSkills.has(typeID));
    });
    return hullTree({
      fittings: shownFittings,
      ownerFilterIsSet,
      marketHulls,
      allMarketHulls: data.hullTypeIDs,
      specialTypeIDs: data.specialTypeIDs,
      facts: (typeID): HullFacts | null | undefined => (data.types.has(typeID) ? data.types.get(typeID) : undefined),
      typeName: hullName,
      groupName: hullGroupName,
      raceName,
      currentShipTypeID: activeShipTypeID,
    });
  });

  /** "160" — a stack count, grouped. A singleton charge reports -1; call it 1. */
  function chargeCount(quantity: number): string {
    return (quantity > 0 ? quantity : 1).toLocaleString();
  }

  // R7c — resolve the ACTIVE SHIP's typeID, every fitted module's typeID and
  // every fittable inventory row's typeID to a display NAME. Fire-and-forget so
  // the panel renders immediately and swaps in names as they arrive.
  $effect(() => {
    const refs: NameRef[] = [];
    if (activeShipTypeID !== null) {
      refs.push({ kind: "type", id: activeShipTypeID });
      refs.push({ kind: "typeGroup", id: activeShipTypeID });
    }
    if ($fitting.activeShipID) {
      refs.push({ kind: "evelocation", id: $fitting.activeShipID });
    }
    if ($fitting.simulation) refs.push({ kind: "type", id: $fitting.simulation.shipTypeID });
    for (const slot of [...$fitting.slots, ...($fitting.simulation?.slots ?? [])]) {
      if (slot.module) {
        refs.push({ kind: "type", id: slot.module.typeID });
        // The loaded charge needs a name too, or the socket description would
        // have to fall back to a number (R7d).
        if (slot.module.charge) {
          refs.push({ kind: "type", id: slot.module.charge.typeID });
        }
      }
    }
    for (const row of fittableRows()) {
      refs.push({ kind: "type", id: row.row.typeID });
    }
    // The simulated drone bay's, cargo hold's and fighter bay's types and the tubes' squadrons, named in their pickers.
    for (const entry of [...($fitting.simulation?.drones ?? []), ...($fitting.simulation?.cargo ?? []), ...($fitting.simulation?.fighterBayTypes ?? [])]) {
      refs.push({ kind: "type", id: entry.typeID });
    }
    for (const tube of $fitting.simulation?.fighterTubes ?? []) {
      if (tube.squadron) refs.push({ kind: "type", id: tube.squadron.typeID });
    }
    if (refs.length > 0) {
      flow.requestNames(refs);
    }
  });

  /** Modules sitting in the hangar or the ship's cargo that could be fitted. */
  function fittableRows(): { row: InventoryItemRow; source: "hangar" | "cargo" }[] {
    const rows: { row: InventoryItemRow; source: "hangar" | "cargo" }[] = [];
    // In a simulation a charge, a drone and a fighter go into the ghost too (FitAmmoToLocation, TryFitModuleToOneSlot,
    // TryFit's fakeFighters).
    const takes = (categoryID: number | null): boolean =>
      isFittableRow(categoryID) || ($fitting.simulation !== null && $fitting.simulation !== undefined && (categoryID === 8 || categoryID === 18 || categoryID === 87));
    for (const row of $inventory.hangar.rows) {
      if (takes(row.categoryID)) {
        rows.push({ row, source: "hangar" });
      }
    }
    for (const row of $inventory.cargo.rows) {
      if (takes(row.categoryID)) {
        rows.push({ row, source: "cargo" });
      }
    }
    return rows;
  }

  const fittable = $derived.by(() => fittableRows());

  /**
   * Every CHARGE stack in the hangar or the ship's cargo — what "Load" can act
   * on. Not filtered by compatibility (see isChargeRow): the panel would have to
   * guess, and a wrong guess hides ammunition that would have worked.
   */
  const chargeRows = $derived.by(() => {
    const rows: { row: InventoryItemRow; source: "hangar" | "cargo" }[] = [];
    for (const row of $inventory.hangar.rows) {
      if (isChargeRow(row.categoryID)) {
        rows.push({ row, source: "hangar" });
      }
    }
    for (const row of $inventory.cargo.rows) {
      if (isChargeRow(row.categoryID)) {
        rows.push({ row, source: "cargo" });
      }
    }
    return rows;
  });

  /**
   * The charge list for the SELECTED module, likely-compatible first.
   *
   * ⚠ SORTED, NEVER FILTERED. The static tables cannot know every case and the
   * server is the authority on what loads, so hiding a charge that would have
   * worked is worse than showing one that will not. A charge we cannot judge
   * sorts between the two — ahead of a known mismatch, behind a known fit.
   */
  const sortedChargeRows = $derived.by(() => {
    const fitment = selectedSlot?.module
      ? $fitting.chargeFits[selectedSlot.module.typeID]
      : undefined;
    const rank = (row: InventoryItemRow): number => {
      const verdict = chargeLooksCompatible(fitment, row.groupID, chargeSizeOf(row));
      return verdict === true ? 0 : verdict === null ? 1 : 2;
    };
    return [...chargeRows].sort((left, right) => rank(left.row) - rank(right.row));
  });

  /**
   * A charge's own size. The inventory rows do not carry it, so this reads the
   * fitment table's entry for the charge TYPE when the BFF happened to include
   * one; otherwise null, which `chargeLooksCompatible` treats as "cannot say".
   */
  function chargeSizeOf(row: InventoryItemRow): number | null {
    return $fitting.chargeFits[row.typeID]?.size ?? null;
  }

  /** Whether this charge looks like it fits the selected module. */
  function chargeVerdict(row: InventoryItemRow): boolean | null {
    const fitment = selectedSlot?.module
      ? $fitting.chargeFits[selectedSlot.module.typeID]
      : undefined;
    return chargeLooksCompatible(fitment, row.groupID, chargeSizeOf(row));
  }

  function loadInto(moduleItemID: number, chargeItemID: number, source: "hangar" | "cargo"): void {
    void run(async () => {
      await flow.loadAmmo([moduleItemID], [chargeItemID], source);
      // The stack the charges came out of shrank, so the list has to re-read.
      await flow.loadInventory();
    });
  }

  function unloadFrom(moduleItemID: number, destination: "hangar" | "cargo"): void {
    void run(async () => {
      await flow.unloadAmmo([moduleItemID], destination);
      await flow.loadInventory();
    });
  }

  function moduleName(typeID: number): string {
    return resolvedName($names.resolved, "type", typeID);
  }

  const pickedName = $derived.by<string | null>(() => {
    if (pickedItemID === null) {
      return null;
    }
    const match = fittable.find((entry) => entry.row.itemID === pickedItemID);
    return match ? moduleName(match.row.typeID) : null;
  });

  /** The active ship's TYPE (what names it) — never its item ID. */
  const activeShipTypeID = $derived.by<number | null>(() => {
    const shipID = $fitting.activeShipID;
    if (shipID === null) {
      return null;
    }
    const row =
      $inventory.hangar.rows.find((entry) => entry.itemID === shipID) ??
      $inventory.cargo.rows.find((entry) => entry.itemID === shipID);
    if (row) return row.typeID;
    // in space the ship is in no hangar's rows: the flight's word of the ship flown, else the space snapshot's ship
    const status = $flightState.status;
    if (status && status.shipID === shipID && status.shipTypeID !== null) return status.shipTypeID;
    const ship = $spaceState.snapshot?.ship;
    return ship && ship.itemID === shipID ? ship.typeID : null;
  });

  const activeShipName = $derived.by<string>(() => {
    // The ship's own name, as the client's fitting window names it (cfg.evelocations); its type's where it has none.
    const shipID = $fitting.activeShipID;
    const own = shipID === null ? null : $names.resolved[nameKey("evelocation", shipID)];
    if (typeof own === "string" && own !== "") {
      return own;
    }
    if (activeShipTypeID === null) {
      return "your ship";
    }
    const typeName = $names.resolved[nameKey("type", activeShipTypeID)];
    return typeName ?? "your ship";
  });

  /** The hull's class ("Battlecruiser") — its type GROUP, resolved to a name. */
  const activeShipClass = $derived.by<string | null>(() => {
    if (activeShipTypeID === null) {
      return null;
    }
    return $names.resolved[nameKey("typeGroup", activeShipTypeID)] ?? null;
  });

  /** A slot's position in plain language: "High slot 3", never "flag 29". */
  function slotName(slot: FittingSlot): string {
    const family = SLOT_FAMILY_LABELS[slot.family];
    // "High slots" -> "High slot 3"; "Rigs" -> "Rig 1".
    const singular = family.endsWith("slots")
      ? family.replace(/slots$/, "slot")
      : family.replace(/s$/, "");
    return `${singular} ${slot.index + 1}`;
  }

  /**
   * fittingWnd.ConstructPowerAndCpuLabels / UpdateCPU / UpdatePower (the play page): what is left of the output over
   * the output, each FmtAmt(showFraction=1) - "left/output" - under its bold header, bottom right of the ring; over
   * the output, fading 0.25 -> 1 each half second.
   */
  function leftOverText(resource: FittingResource): string {
    if (!resource.known) return "—";
    const one = (v: number) => v.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    return `${one(resource.total - resource.used)}/${one(resource.total)}`;
  }
  function resourceText(resource: FittingResource, unit: string): string {
    if (!resource.known) {
      return "—";
    }
    return `${round(resource.used)} / ${round(resource.total)} ${unit}`;
  }

  function round(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }

  function percent(resource: FittingResource): number | null {
    if (!resource.known || resource.total <= 0) {
      return null;
    }
    return Math.max(0, Math.min(100, Math.round((resource.used / resource.total) * 100)));
  }

  // --- R21 formatting for the statistic panels ------------------------------
  //
  // Every one of these takes a number the SERVER produced (or pure arithmetic
  // over server numbers) and makes it readable. None of them invents a value.

  const NUMBER = new Intl.NumberFormat("en-GB");

  function whole(value: number): string {
    return NUMBER.format(Math.round(value));
  }

  function toFixed(value: number, digits: number): string {
    return NUMBER.format(Number(value.toFixed(digits)));
  }

  function asPercent(value: number): string {
    return `${(value * 100).toFixed(1)}%`;
  }

  /** Metres, shown as km once the number gets long — the way EVE reads them. */
  function asDistance(value: number): string {
    return value >= 1000 ? `${toFixed(value / 1000, 1)} km` : `${whole(value)} m`;
  }

  function asSeconds(value: number): string {
    return `${toFixed(value, 2)} s`;
  }

  function asVolume(value: number): string {
    return `${toFixed(value, 1)} m³`;
  }

  /** Seconds as a clock the way EVE writes a capacitor time: "2m 26s". */
  function asDuration(seconds: number): string {
    const total = Math.round(seconds);
    if (total < 60) {
      return `${total}s`;
    }
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  }

  const layerLabels: Readonly<Record<LayerName, string>> = {
    shield: "Shield",
    armor: "Armor",
    hull: "Structure",
  };

  /** The four damage types, in the order every EVE UI lists them. */
  const DAMAGE_TYPES = [
    { key: "em", label: "EM", cls: "dmg-em" },
    { key: "thermal", label: "Therm", cls: "dmg-therm" },
    { key: "kinetic", label: "Kin", cls: "dmg-kin" },
    { key: "explosive", label: "Exp", cls: "dmg-exp" },
  ] as const;

  // Simulate Fitting (ghostFittingSvc): while the window simulates the ship, its figures are the simulation's.
  const simulation = $derived.by(() => $fitting.simulation ?? null);
  const stats = $derived.by(() => (simulation ? simulation.stats : $fitting.stats));
  const resources = $derived.by(() => (simulation ? simulation.resources : $fitting.resources));

  // The simulation's words: the ghost ship icon's (ghostShipIcon.py, simulationModeTooltip.py) and a module's state's
  // (moduleStateUtil activationStateLabels), each the page's own where the install's are not to be had.
  const SIMULATION_WORDS: Record<string, string> = {
    "UI/Fitting/FittingWindow/CPUStatusHeader": "CPU",
    "UI/Fitting/FittingWindow/PowergridHeader": "Power Grid",
    "UI/Fitting/FittingWindow/Simulate": "Simulate",
    "UI/Fitting/FittingWindow/ExitSimulation": "Exit simulation",
    "UI/Fitting/FittingWindow/SimulateShipFitting": "Simulate this fitting",
    // The simulated cargo hold's picker (itemPickerMenu CargoItemPickerMenu: emptyLabelPath, RemoveAll, the entry's
    // count and its remove).
    "UI/Fitting/FittingWindow/NoCargoItemsSimulated": "Nothing in the simulated cargo hold. Pick up an item and put it here.",
    // Said by the flow as a type a fitting does not keep is put in the hold (FitAnItemToHold); asked here.
    "UI/Fitting/FittingWindow/ItemAddedNotInFitting": "",
    "UI/Fitting/FittingWindow/RemoveAll": "Take everything out",
    "UI/Generic/RemoveItem": "Take it out",
    "UI/Fitting/FittingWindow/ClickToEdit": "Change how many",
    // The window's warnings (fittingWarningConst headerByWarningLevel and warningsByWarningID's lines and hints, those
    // reckoned; the turret sizes' names, the charge size's sizeclass).
    "UI/Fitting/FittingWindow/Warnings/HeaderHigh": "Fitting problems",
    "UI/Fitting/FittingWindow/Warnings/HeaderMedium": "Fitting cautions",
    "UI/Fitting/FittingWindow/Warnings/HeaderLow": "Fitting notes",
    // The skill warning's tooltip (GetSkillTooltip, AddMissingSkillRequirements, RequiredSkillRow).
    "UI/Fitting/FittingWindow/Warnings/HeaderSkills": "Skills short",
    "UI/Skills/RequiredSkills": "Skills needed",
    "UI/Fitting/FittingWindow/Warnings/ShipAndFit": "The ship and its modules",
    "UI/Fitting/FittingWindow/Warnings/CargoHold": "In the cargo",
    "UI/InfoWindow/RequiredSkillNameAndLevel": "{[item]skill.name} {level}",
    "UI/SkillQueue/SkillBookMissing": "The book is not injected",
    "UI/SkillQueue/RareSkillBookMissing": "The book is not injected, and is not sold",
    "UI/InfoWindow/SkillNotTrainedToRequiredLevel": "Short of the level needed",
    // The tooltip's training time and action (AddTrainingTime, SkillActionContainer).
    "Tooltips/SkillPlanner/OmegaTrainingTime": "Time to train it (omega)",
    "Tooltips/SkillPlanner/TrainingTime": "Time to train it",
    "Tooltips/SkillPlanner/TrainingComplete": "Trained",
    "Tooltips/SkillPlanner/OmegaCloneStateRequiredForActivity": "Only an omega clone can {doActivity}",
    "Tooltips/SkillPlanner/ActivityFlyFittedShip": "fly this ship as fitted",
    "UI/CloneState/Upgrade": "Upgrade",
    "UI/Skills/SkillPointsRequired": "Points it takes",
    "UI/Skills/TrainSkills": "Train them",
    "Tooltips/SkillPlanner/AddAllSkillsToQueueButton": "Put them all in the queue",
    "Tooltips/SkillPlanner/AddAllSkillsToQueueButtonFinished": "They are all in the queue",
    "UI/Skills/BuyAndTrain": "Buy them and train",
    "UI/Skills/ErrorRareRequirements": "A book this needs is not sold directly",
    "UI/SkillQueue/ApplySkillPoints": "Put free points into these",
    "UI/Market/MarketQuote/BuyType": "Shop for {[item]typeID.name}",
    // Its Create Skill Plan button (CreateSkillPlanButton), its plan named for the fit (GetSkillTooltip's skillPlanName).
    "Tooltips/SkillPlanner/SkillPlanButtonTooltip": "Begin a skill plan of these",
    "UI/SkillPlan/MaximumSkillPlanReached": "You have {numPlans} plans, as many as may be had.",
    "Tooltips/SkillPlanner/SkillPlanNameStringWithType": "A plan for {typeName}",
    "UI/SkillPlan/DefaultCreateFitSkillPlanName": "A plan for this fit",
    "UI/Fitting/FittingWindow/Warnings/SubsystemShort": "Subsystem slots empty",
    "UI/Fitting/FittingWindow/Warnings/SubsystemHint": "A strategic cruiser needs a subsystem in each of its subsystem slots.",
    "UI/Fitting/FittingWindow/Warnings/ModulesInInvalidSlotsShort": "Modules in slots the hull lacks",
    "UI/Fitting/FittingWindow/Warnings/ModulesInInvalidSlotsHint": "These modules sit in slots this hull does not have, and do nothing there.",
    "UI/Fitting/FittingWindow/Warnings/CpuOverloadedShort": "Over the CPU",
    "UI/Fitting/FittingWindow/Warnings/CpuOverloadedHint": "The modules need more CPU than the ship has.",
    "UI/Fitting/FittingWindow/Warnings/PowergridOverloadedShort": "Over the power grid",
    "UI/Fitting/FittingWindow/Warnings/PowergridOverloadedHint": "The modules need more power grid than the ship has.",
    "UI/Fitting/FittingWindow/Warnings/CalibrationOverloadedShort": "Calibration overloaded",
    "UI/Fitting/FittingWindow/Warnings/CalibrationOverloadedHint": "The rigs need more calibration than the ship has.",
    "UI/Fitting/FittingWindow/Warnings/CargoOverloadedShort": "Cargo hold overfull",
    "UI/Fitting/FittingWindow/Warnings/CargoOverloadedHint": "The cargo hold holds more than its capacity.",
    "UI/Fitting/FittingWindow/Warnings/MixingTurretGroupsShort": "Turret kinds mixed",
    "UI/Fitting/FittingWindow/Warnings/MixingTurretGroupsHint": "Turrets of more than one kind are fitted.",
    "UI/Fitting/FittingWindow/Warnings/MixingLauncherGroupsShort": "Launcher kinds mixed",
    "UI/Fitting/FittingWindow/Warnings/MixingLauncherGroupsHint": "Launchers of more than one kind are fitted.",
    "UI/Fitting/FittingWindow/Warnings/MixingTurretSizesShort": "Turret sizes mixed",
    "UI/Fitting/FittingWindow/Warnings/MixingTurretSizesHint": "Turrets of more than one size are fitted.",
    "UI/Fitting/FittingWindow/Warnings/OfflineModulesShort": "Modules offline",
    "UI/Fitting/FittingWindow/Warnings/OfflineModulesHint": "These modules are fitted but not online.",
    "UI/Fitting/FittingWindow/Warnings/PolarizedWeaponsFittedShort": "A polarized weapon is fitted",
    "UI/Fitting/FittingWindow/Warnings/PolarizedWeaponsFittedHint": "A polarized weapon takes the ship's resistances away.",
    "UI/Fitting/FittingWindow/Warnings/ShipIsDualTankedShort": "Shield and armour tanked together",
    "UI/Fitting/FittingWindow/Warnings/ShipIsDualTankedHint": "Spreading the tank over shield and armour usually makes both weaker.",
    "UI/Fitting/FittingWindow/Warnings/ArmorTankingShieldShipShort": "Armour tank on a shield hull",
    "UI/Fitting/FittingWindow/Warnings/ArmorTankingShieldShipHint": "{[item]shipTypeID.name} is built for a shield tank; armour modules waste its bonuses.",
    "UI/Fitting/FittingWindow/Warnings/ShieldTankingArmorShipShort": "Shield tank on an armour hull",
    "UI/Fitting/FittingWindow/Warnings/ShieldTankingArmorShipHint": "{[item]shipTypeID.name} is built for an armour tank; shield modules waste its bonuses.",
    "UI/Fitting/FittingWindow/Warnings/UndersizedPropModShort": "Propulsion module too small",
    "UI/Fitting/FittingWindow/Warnings/UndersizedPropModHint": "This hull is too heavy for that propulsion module to move it well.",
    "UI/Fitting/FittingWindow/Warnings/InefficientPropModShort": "Propulsion module wasted",
    "UI/Fitting/FittingWindow/Warnings/InefficientPropModHint": "A freighter gains little from a propulsion module.",
    "UI/Fitting/FittingWindow/Warnings/BubbleImmunityDisabledShort": "Bubble immunity lost",
    "UI/Fitting/FittingWindow/Warnings/BubbleImmunityDisabledHint": "A fitted module takes away the hull's immunity to warp bubbles.",
    "UI/Fitting/FittingWindow/Warnings/NotProvidingBonusShort": "Modules with nothing to improve",
    "UI/Fitting/FittingWindow/Warnings/NotProvidingBonusHint": "These modules improve other equipment, and nothing fitted or carried is of the kind they improve.",
    "UI/Fitting/FittingWindow/Warnings/StackingPenaltyMedShort": "Penalized several times over",
    "UI/Fitting/FittingWindow/Warnings/StackingPenaltyMedHint": "More than three modules change the same thing, each a little less than the last.",
    "UI/Fitting/FittingWindow/Warnings/StackingPenaltyLowShort": "Penalized when stacked",
    "UI/Fitting/FittingWindow/Warnings/StackingPenaltyLowHint": "Three modules change the same thing, the third a little less than the others.",
    "UI/Fitting/FittingWindow/Warnings/StackingPenaltyTargetedLowShort": "Penalized when stacked on one target",
    "UI/Fitting/FittingWindow/Warnings/StackingPenaltyTargetedLowHint": "Several modules change the same thing on a target, each a little less than the last.",
    "UI/Fitting/FittingWindow/Warnings/ForEquipmentRequiringSkill": "(on modules needing {skillName})",
    "UI/Fitting/FittingWindow/Warnings/MissingChargesForRequiredShort": "Modules without their charges",
    "UI/Fitting/FittingWindow/Warnings/MissingChargesForRequiredHint": "These modules do nothing without charges, and the holds have too few to fill them.",
    "UI/Fitting/FittingWindow/Warnings/MissingChargesForOptionalShort": "Modules short of charges",
    "UI/Fitting/FittingWindow/Warnings/MissingChargesForOptionalHint": "These modules work better loaded, and the holds have too few charges to fill them.",
    "UI/InfoWindow/SmallSize": "Small",
    "UI/InfoWindow/MediumSize": "Medium",
    "UI/InfoWindow/LargeSize": "Large",
    "UI/InfoWindow/XLargeSize": "Extra large",
    // The holds' readouts (minihangar CargoSlots.SetStatusText: the capacity after the use, and the unit).
    "UI/Fitting/FittingWindow/CargoUsage": "/ {text}",
    "UI/Fitting/FittingWindow/CubicMeters": "m³",
    // The simulated fighter bay's picker (fighterPickerMenu FighterBayItemPickerMenu's emptyLabelPath; the tubes'
    // squadron containers: an empty tube's action and hint, a squadron's hint and its simulated state; the classes' and
    // the roles' hints, fighterConst HINTTEXT_BY_ROLE).
    "UI/Fitting/FittingWindow/NoFightersSimulated": "No fighters in the simulated fighter bay. Pick up fighters and put them here.",
    "UI/Inventory/Fighters/Open": "Open",
    "UI/Inventory/Fighters/EmptyLaunchTube": "An empty launch tube",
    "UI/Inventory/Fighters/SquadronHint": "{typeName}: {numFighters} in the squadron",
    "UI/Fitting/FittingWindow/FightersSimulated": "Simulated",
    "UI/Fighters/Class/Light": "Light fighters",
    "UI/Fighters/Class/Support": "Support fighters",
    "UI/Fighters/Class/Heavy": "Heavy fighters",
    "UI/Inventory/Fighters/RoleNoneHint": "",
    "UI/Inventory/Fighters/RoleAntiFighterHint": "Fights other fighters",
    "UI/Inventory/Fighters/RoleGeneralHint": "General attack",
    "UI/Inventory/Fighters/RoleEwarHint": "Electronic warfare",
    "UI/Inventory/Fighters/RoleTorpedoBomberHint": "Torpedoes against big targets",
    "UI/Inventory/Fighters/RoleAOEBomberHint": "Bombs that hit an area",
    // The fit-name label's tooltip (fittingWnd: SetTooltipHeaderAndDescription, ShipName_description).
    "Tooltips/FittingWindow/ShipName_description": "Click to see the fitting as it stands and save it; drag it into a chat to link it.",
    "Tooltips/FittingWindow/SimulateShipFittingDescription": "Try the ship's modules in every state without touching the ship itself.",
    "UI/Fitting/FittingWindow/ExitSimulationMode": "Leave the simulation",
    "Tooltips/FittingWindow/ExitSimulationModeDescription": "Show the ship as it really is again.",
    "UI/Fitting/FittingWindow/ModuleMode": "Module state",
    "UI/Fitting/FittingWindow/ModuleModeHint": "Click to go to the next state; shift-click to go back.",
    "UI/Fitting/FittingWindow/ModuleModeOffline": "Offline",
    "UI/Fitting/FittingWindow/ModuleModeOfflinePassive": "Offline",
    "UI/Fitting/FittingWindow/ModuleModeOfflineRig": "Offline",
    "UI/Fitting/FittingWindow/ModuleModeOfflineSubsystem": "Online",
    "UI/Fitting/FittingWindow/ModuleModeOnline": "Online",
    "UI/Fitting/FittingWindow/ModuleModeOnlinePassive": "Online",
    "UI/Fitting/FittingWindow/ModuleModeOnlineRig": "Online",
    "UI/Fitting/FittingWindow/ModuleModeActive": "Active",
    "UI/Fitting/FittingWindow/ModuleModeOverheated": "Overheated",
    // FeedbackLabelCont: why a module would not fit in the simulation.
    "UI/Fitting/FittingWindow/WarningNotForThisHullCategory": "That is not something this kind of hull takes.",
    "UI/Fitting/FittingWindow/WarningHullCantFitThisModule": "This hull cannot take that module.",
    "UI/Fitting/FittingWindow/WarningModuleTooBig": "That module is too big for this hull.",
    "UI/Fitting/FittingWindow/WarningNotEnoughLauncherSlots": "No launcher hardpoint is free.",
    "UI/Fitting/FittingWindow/WarningNotEnoughTurretSlotsFree": "No turret hardpoint is free.",
    "UI/Fitting/FittingWindow/WarningNotEnoughRigSlots": "No rig slot is free.",
    "UI/Fitting/FittingWindow/WarningRigNotRightSize": "That rig is not this hull's size.",
    "UI/Fitting/FittingWindow/WarningNotEnoughFreeSlots": "No slot of that kind is free.",
    "UI/Fitting/FittingWindow/WarningIncorrectSlotForModule": "That module does not go in that slot.",
    "UI/Fitting/FittingWindow/WarningModuleSlotInUse": "That slot is taken.",
    "UI/Fitting/FittingWindow/WarningMaxGroupFitted": "No more than {extraInfo} of that group may be fitted.",
    "UI/Fitting/FittingWindow/WarningMaxTypeFitted": "No more than {extraInfo} of that module may be fitted.",
    "UI/Fitting/FittingWindow/WarningModuleCouldntBeFitted": "The module could not be fitted.",
    "UI/Fitting/FittingWindow/ActiveDronesLimitWarning": "No more than {limit} drones may be active.",
    "UI/Fitting/FittingWindow/ActiveDroneBandwithWarning": "The ship has not the bandwidth for another drone.",
    "UI/Fitting/FittingWindow/SimulateFitting": "Try it out",
    "UI/Fitting/FittingWindow/SimulateShip": "Try this hull out",
    "UI/Fitting/FittingWindow/SimulatedShipName": "A simulated {[item]typeID.name}",
    "UI/Fitting/FittingWindow/LoadngOfShipCancelled": "The ship was not loaded.",
  };
  /** FeedbackLabelCont's errorDict and errorLabelPathDictWithVariables, by FIT_ERRORS key. */
  const FIT_ERROR_LABELS: Readonly<Record<number, string>> = {
    13: "WarningNotForThisHullCategory",
    1: "WarningHullCantFitThisModule",
    2: "WarningModuleTooBig",
    5: "WarningNotEnoughLauncherSlots",
    6: "WarningNotEnoughTurretSlotsFree",
    7: "WarningNotEnoughRigSlots",
    8: "WarningRigNotRightSize",
    9: "WarningNotEnoughFreeSlots",
    10: "WarningIncorrectSlotForModule",
    11: "WarningModuleSlotInUse",
    3: "WarningMaxGroupFitted",
    4: "WarningMaxTypeFitted",
  };
  /** The simulation's feedback line (FeedbackLabelCont.SetText): why the last module would not fit. */
  let fitFeedback = $state("");
  function showFitError(fitError: { readonly errorKey: number; readonly extraInfo: number | null } | null): void {
    if (!fitError) {
      fitFeedback = "";
      return;
    }
    const label = `UI/Fitting/FittingWindow/${FIT_ERROR_LABELS[fitError.errorKey] ?? "WarningModuleCouldntBeFitted"}`;
    const template = $words.templates[label];
    fitFeedback = plainText(formatTemplate(typeof template === "string" && template !== "" ? template : SIMULATION_WORDS[label] ?? "", { extraInfo: fitError.extraInfo ?? 0 }, {
      nameOf: (kind, id) => String($names.resolved[nameKey(kind, id)] ?? id),
    }));
  }
  /** The picked module's type, where one is picked. */
  function pickedTypeID(): number | null {
    return fittableRows().find((entry) => entry.row.itemID === pickedItemID)?.row.typeID ?? null;
  }
  /** The picked item's category, where one is picked. */
  function pickedCategoryID(): number | null {
    return fittableRows().find((entry) => entry.row.itemID === pickedItemID)?.row.categoryID ?? null;
  }
  /** A picked charge loaded into a simulated module (dropped on it: FitAmmoToLocation). */
  function loadSimulated(flagID: number): void {
    const typeID = pickedTypeID();
    if (typeID === null) return;
    pickedItemID = null;
    void run(async () => {
      // FitAmmoToLocation returns nothing where the module does not take the charge, and the window says nothing.
      await flow.loadSimulatedCharge(flagID, typeID);
      fitFeedback = "";
    });
  }
  /** The tracker's warning, said (SelectedDroneTracker: ActiveDronesLimitWarning, ActiveDroneBandwithWarning). */
  function droneWarning(refused: { readonly warning: "limit" | "bandwidth"; readonly limit: number } | null): string {
    if (refused === null) return "";
    const { warning, limit } = refused;
    const label = warning === "limit" ? "UI/Fitting/FittingWindow/ActiveDronesLimitWarning" : "UI/Fitting/FittingWindow/ActiveDroneBandwithWarning";
    const template = $words.templates[label];
    return plainText(formatTemplate(typeof template === "string" && template !== "" ? template : SIMULATION_WORDS[label] ?? "", { limit }, {
      nameOf: (kind, id) => String($names.resolved[nameKey(kind, id)] ?? id),
    }));
  }
  /** A simulated drone type's selected count changed (dronePickerMenu.ChangeActiveNum). */
  function setActiveDrones(typeID: number, wanted: number): void {
    fitFeedback = droneWarning(flow.setSimulatedActiveDrones(typeID, wanted));
  }
  /** A simulated drone type's count in the bay changed (dronePickerMenu.ChangeNumDrones). */
  function setDrones(typeID: number, wanted: number): void {
    fitFeedback = "";
    void run(() => flow.setSimulatedDrones(typeID, wanted));
  }
  /** A picked module fitted in the simulation, in the slot named or the first it fits. */
  function fitSimulated(flagID: number | null): void {
    const typeID = pickedTypeID();
    if (typeID === null) return;
    pickedItemID = null;
    void run(async () => showFitError(await flow.fitSimulatedModule(typeID, flagID)));
  }
  /** A simulated module right-clicked: unfitted (the ghost slot's Unfit). */
  function unfitSimulated(slot: FittingSlot, event: MouseEvent): void {
    const flagID = slotFlagOf(slot.family, slot.index);
    if (!simulation || !slot.module || flagID === null) return;
    event.preventDefault();
    simulationError = null;
    flow.unfitSimulatedModule(flagID);
  }
  $effect(() => {
    if (!$fitting.activeShipID) return;
    flow.requestWords(Object.keys(SIMULATION_WORDS));
  });
  /** A saved fitting simulated (SimulateFitting), from the browser. */
  function simulateSaved(fittingID: number): void {
    const saved = ($savedFittings ?? []).find((each) => each.fittingID === fittingID);
    if (!saved) return;
    simulationError = null;
    fitFeedback = "";
    void run(() => flow.simulateFitting({
      shipTypeID: saved.shipTypeID,
      fitData: saved.modules.map((item) => ({ typeID: item.typeID, flagID: item.flagID, quantity: item.quantity })),
      name: saved.name,
      fittingID: saved.fittingID,
      ownerID: saved.ownerID,
      browserClick: true,
    }));
  }
  /** A hull simulated alone (the hull browser's ShipFittingSimulationButton: SimulateFitting with no fitData). */
  function simulateHull(typeID: number): void {
    simulationError = null;
    fitFeedback = "";
    void run(() => flow.simulateFitting({ shipTypeID: typeID, fitData: [], name: null }));
  }
  /** The hull the ring shows: the simulated one while simulating, with its fitting's name or SimulatedShipName. */
  const ringTypeID = $derived.by(() => (simulation ? simulation.shipTypeID : activeShipTypeID));
  const ringName = $derived.by(() => {
    if (!simulation) return activeShipName;
    if (simulation.name) return simulation.name;
    if (simulation.shipID !== null) return activeShipName;
    return simulationWord("UI/Fitting/FittingWindow/SimulatedShipName", { typeID: simulation.shipTypeID });
  });
  /**
   * The fit-name label's name (fittingWnd.GetFitName and UpdateShipName): the ship's own while not simulating; while
   * simulating, GetShipName, the ring's name with "*" before it once the simulation has been changed.
   */
  const fitName = $derived.by(() => (simulation?.changed ? `*${ringName}` : ringName));
  // The window's warnings (fittingWnd.ConstructNameCaptionAndFittingWarnings: WarningIconCont), of the ship as it stands
  // or as it is simulated (the page's reckoning: bridge/dogma/fittingWarnings.ts evaluateFit).
  const fitWarnings = $derived.by(() => (simulation ? simulation.warnings : $fitting.warnings ?? []));
  /** WarningIconCont's red, yellow and white icons, each shown with how many warnings it has (__UpdateIcon_thread). */
  const warningIcons = $derived.by(() =>
    [WARNING_LEVEL_HIGH, WARNING_LEVEL_MEDIUM, WARNING_LEVEL_LOW]
      .map((level) => ({ level, count: fitWarnings.filter((warning) => warning.level === level).length }))
      .filter((icon) => icon.count > 0));
  /** WarningIcon's texture (warningGroup.png, tinted its level's colour) and a line's (WARNING_PATH). */
  const WARNING_GROUP_ICON = clientTexture("res:/UI/Texture/classes/Fitting/warningGroup.png");
  const WARNING_LINE_ICON = clientTexture("res:/UI/Texture/classes/agency/iconExclamation.png");
  /** The level whose tooltip is open (LoadWarningTooltipPanel), and the slots shown with a warning (ChangeFittingWarningDisplay). */
  let warningTooltipLevel = $state<number | null>(null);
  let warningSlots = $state<ReadonlyMap<number, number>>(new Map());
  /** EvaluateFitAndPopulateTooltip's warningSlotDict: the slots of the level's warnings, each at the level. */
  function levelSlots(level: number): Map<number, number> {
    const slots = new Map<number, number>();
    for (const warning of fitWarnings) if (warning.level === level) for (const flagID of warning.flags) slots.set(flagID, level);
    return slots;
  }
  function openWarningTooltip(level: number): void {
    skillTooltipOpen = false;
    warningTooltipLevel = level;
    warningSlots = levelSlots(level);
  }
  /** TooltipPanelBeingDestroyed: the tooltip closed, no slot shown with a warning. */
  function closeWarningTooltip(): void {
    warningTooltipLevel = null;
    skillTooltipOpen = false;
    warningSlots = new Map();
  }
  // The skill warning (SkillWarningIcon: warningSkills.png in the skill level's colour, with how many skills the ship
  // and what it holds miss), on the icons' row where fewer than three levels have warnings, else under them.
  const fitSkillWarning = $derived.by(() => (simulation ? simulation.skillWarning : $fitting.skillWarning ?? null));
  const SKILL_WARNING_ICON = clientTexture("res:/ui/Texture/classes/Fitting/warningSkills.png");
  let skillTooltipOpen = $state(false);
  /** The tooltip's rows as read when it opened, by skill and level; and its training time and action. */
  let skillRows = $state<ReadonlyMap<string, SkillsRequiredRow>>(new Map());
  let skillTraining = $state<SkillTrainingRecord | null>(null);
  /** The personal plans' count as the tooltip opened, for its Create Skill Plan button's limit. */
  let skillPlanCount = $state<number | null>(null);
  /**
   * LoadSkillTooltip: the tooltip open (GetSkillTooltip), its rows read as the pilot's skills and queue stand now, and
   * the slots and holds whose items miss skills shown at the skill level (GetSlotsMissingSkills).
   */
  function openSkillTooltip(): void {
    const warning = fitSkillWarning;
    if (!warning) return;
    warningTooltipLevel = null;
    skillTooltipOpen = true;
    warningSlots = new Map(warning.flags.map((flagID) => [flagID, WARNING_LEVEL_SKILL]));
    skillTraining = null;
    void flow.personalSkillPlanCount().then((count) => (skillPlanCount = count)).catch(() => {});
    void flow.fittingSkillTooltip(warning)
      .then(({ rows, training }) => {
        skillRows = new Map(rows.map((row) => [`${row.skill}:${row.level}`, row]));
        skillTraining = training;
      })
      .catch(() => {});
  }
  function closeSkillTooltip(): void {
    skillTooltipOpen = false;
    warningSlots = new Map();
  }
  /** The pickers' entries' and the tubes' warning mark (slotWarningIcon.png, tinted the level's colour). */
  const PICKER_WARNING_ICON = clientTexture("res:/UI/Texture/classes/Fitting/slotWarningIcon.png");
  /**
   * HiliteProblematicEntries and UpdateProblematicEntries: a picker's entry marked at the level its picker's flag is
   * shown with (the cargo hold's, the drone bay's, the fighter bay's): every entry at another level, at the skill
   * level only those whose types miss skills (GetMissingSkills_HighestLevelByTypeID).
   */
  function pickerWarningColor(flagID: number, typeID: number): string | null {
    const level = warningSlots.get(flagID);
    if (level === undefined) return null;
    if (level === WARNING_LEVEL_SKILL && !(fitSkillWarning?.typesMissing ?? []).includes(typeID)) return null;
    return COLOR_BY_LEVEL[level] ?? null;
  }
  /**
   * UpdateProblematicFigtersInTubes: a tube's squadron marked in the colour its tube's flag is shown with, only where
   * its fighters' type misses skills.
   */
  function tubeWarningColor(tubeFlagID: number, typeID: number): string | null {
    if (!(fitSkillWarning?.typesMissing ?? []).includes(typeID)) return null;
    const level = warningSlots.get(tubeFlagID);
    return level === undefined ? null : COLOR_BY_LEVEL[level] ?? null;
  }
  /** AddMissingSkillRequirements' rows: by the skills' names (SortListOfTuples). */
  function bySkillName(skills: readonly (readonly [number, number])[]): readonly (readonly [number, number])[] {
    return [...skills].sort(([left], [right]) => {
      const [a, b] = [moduleName(left), moduleName(right)];
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }
  /** OnMouseEnterContainer: a line's or a row's slots shown with its warning; OnMouseExitContainer: none. */
  function showWarningSlots(flags: readonly number[], level: number): void {
    warningSlots = new Map(flags.map((flagID) => [flagID, level]));
  }
  /** FilterResultsForWarningLevel: the open level's warnings, in the tooltip's order. */
  const tooltipWarnings = $derived.by(() => (warningTooltipLevel === null ? [] : fitWarnings.filter((warning) => warning.level === warningTooltipLevel)));
  /**
   * CargoFighterSlots.ChangeWarningDisplay: the fighter bay's readout framed at the highest level its bay's or its
   * tubes' flags are shown with (the drone bay's readout has no frame).
   */
  function fighterBayWarningColor(): string | null {
    let level: number | null = null;
    for (const flagID of [158, 159, 160, 161, 162, 163]) {
      const at = warningSlots.get(flagID);
      if (at !== undefined && (level === null || at > level)) level = at;
    }
    return level === null ? null : COLOR_BY_LEVEL[level] ?? null;
  }
  /** A warning's colour at a slot's flag, where it is shown with one. */
  function slotWarningColor(flagID: number | null): string | null {
    const level = flagID === null ? undefined : warningSlots.get(flagID);
    return level === undefined ? null : COLOR_BY_LEVEL[level] ?? null;
  }
  /** GetQuestionMarkHint: a warning's hint; the CPU's and the powergrid's with the skills that help named (__GetSkillText). */
  function warningHint(warningID: number): string {
    const hint = WARNINGS_BY_ID[warningID]?.hint;
    if (!hint) return "";
    // The tanking ones name the hull (GetByLabel(hintPath, shipTypeID=fittingController.GetTypeID())).
    if (warningID === WARNING.ARMOR_TANKED_SHIELD_SHIP || warningID === WARNING.SHIELD_TANKED_ARMOR_SHIP || warningID === WARNING.WRONG_TANKING) {
      return simulationWord(hint, { shipTypeID: simulation ? simulation.shipTypeID : activeShipTypeID ?? 0 });
    }
    if (warningID === WARNING.OVER_CPU_POWER || warningID === WARNING.OVER_CPU || warningID === WARNING.OVER_POWERGRID) {
      return simulationWord(hint, {
        cpuMgmtLink: moduleName(3426), weaponUpgradesLink: moduleName(3318), advancedWeaponUpgradesLink: moduleName(11207), powerGridMgmtLink: moduleName(3413),
      });
    }
    return simulationWord(hint);
  }
  /** The rows under a line: AddTurretOrLauncherGroups by the groups' names; the others as they come. */
  function warningRows(rows: readonly FitWarningRow[]): readonly FitWarningRow[] {
    if (rows.some((row) => row.kind === "attribute")) return attributeRows(rows);
    const groupName = (row: FitWarningRow) => (row.kind === "group" ? resolvedName($names.resolved, "group", row.groupID) : "");
    return [...rows].sort((left, right) => (left.kind === "group" && right.kind === "group" ? (groupName(left) < groupName(right) ? -1 : groupName(left) > groupName(right) ? 1 : 0) : 0));
  }
  // The penalized attributes' names and pictures (dogma_data.get_attribute_display_name, get_attribute_icon_id), read once.
  let warningAttributes = $state<ReadonlyMap<number, { readonly displayNameID: number | null; readonly iconFile: string | null }>>(new Map());
  $effect(() => {
    const wanted = [...new Set(fitWarnings.flatMap((warning) => warning.rows.flatMap((row) => (row.kind === "attribute" ? [row.attributeID] : []))))]
      .filter((attributeID) => !warningAttributes.has(attributeID))
      .slice(0, 32);
    if (wanted.length === 0) return;
    void flow.attributeDisplay(wanted).then((shown) => {
      const merged = new Map(warningAttributes);
      for (const attributeID of wanted) merged.set(attributeID, shown?.get(attributeID) ?? { displayNameID: null, iconFile: null });
      warningAttributes = merged;
      flow.requestWords([...merged.values()].flatMap((each) => (each.displayNameID === null ? [] : [`#${each.displayNameID}`])));
    });
  });
  /** An attribute's name as its message gives it. */
  function attributeName(attributeID: number): string {
    const messageID = warningAttributes.get(attributeID)?.displayNameID ?? null;
    const template = messageID === null ? undefined : $words.templates[`#${messageID}`];
    return typeof template === "string" ? plainText(formatTemplate(template, {}, { nameOf: (kind, id) => String($names.resolved[nameKey(kind, id)] ?? id) })) : "";
  }
  /**
   * AddAttributes' row, in the label's markup: the attribute's name, and for a skill's change ForEquipmentRequiringSkill
   * on the line under it.
   */
  function attributeRowText(row: Extract<FitWarningRow, { kind: "attribute" }>): string {
    const name = attributeName(row.attributeID);
    if (row.skillTypeID === null) return name;
    const label = "UI/Fitting/FittingWindow/Warnings/ForEquipmentRequiringSkill";
    const template = $words.templates[label];
    const skillLine = formatTemplate(typeof template === "string" && template !== "" ? template : SIMULATION_WORDS[label] ?? "", { skillName: moduleName(row.skillTypeID) }, {
      nameOf: (kind, id) => String($names.resolved[nameKey(kind, id)] ?? id),
    });
    return `${name}<br>${skillLine}`;
  }
  /**
   * AddAttributes: the penalized attributes by the modules making the change (those groups in the order met; the
   * client walks them in its dict's hash order), each
   * group's by their names; one already shown for the same modules under the same words not again.
   */
  function attributeRows(rows: readonly FitWarningRow[]): readonly FitWarningRow[] {
    const groups = new Map<string, Extract<FitWarningRow, { kind: "attribute" }>[]>();
    for (const row of rows) {
      if (row.kind !== "attribute") continue;
      const group = groups.get(row.modulesKey) ?? [];
      group.push(row);
      groups.set(row.modulesKey, group);
    }
    const shown: FitWarningRow[] = [];
    const added = new Map<string, Set<string>>();
    for (const [modulesKey, group] of groups) {
      const sorted = [...group].sort((left, right) => {
        const [a, b] = [attributeName(left.attributeID), attributeName(right.attributeID)];
        return a < b ? -1 : a > b ? 1 : 0;
      });
      for (const row of sorted) {
        const text = attributeRowText(row).toLowerCase();
        const seen = added.get(text) ?? new Set<string>();
        if (seen.has(modulesKey)) continue;
        seen.add(modulesKey);
        added.set(text, seen);
        shown.push(row);
      }
    }
    return shown;
  }
  const SIZE_LABELS: Readonly<Record<number, string>> = { 1: "UI/InfoWindow/SmallSize", 2: "UI/InfoWindow/MediumSize", 3: "UI/InfoWindow/LargeSize", 4: "UI/InfoWindow/XLargeSize" };
  $effect(() => {
    // The names the tooltip's rows and hints need: the groups', the modules', the skills' the hints name.
    const refs: { kind: "type" | "group"; id: number }[] = [3426, 3318, 11207, 3413].map((id) => ({ kind: "type", id }));
    // The hull a tanking hint names.
    const hullTypeID = simulation ? simulation.shipTypeID : activeShipTypeID;
    if (hullTypeID !== null) refs.push({ kind: "type", id: hullTypeID });
    for (const warning of fitWarnings) {
      for (const row of warning.rows) {
        if (row.kind === "module") refs.push({ kind: "type", id: row.typeID });
        else if (row.kind === "group" || row.kind === "subsystem") refs.push({ kind: "group", id: row.groupID });
        else if (row.kind === "attribute" && row.skillTypeID !== null) refs.push({ kind: "type", id: row.skillTypeID });
      }
    }
    // The skills the skill tooltip lists, and the injectors its apply-points button may name.
    for (const [skill] of [...(fitSkillWarning?.fit ?? []), ...(fitSkillWarning?.cargo ?? [])]) refs.push({ kind: "type", id: skill });
    if ((fitSkillWarning?.count ?? 0) > 0) refs.push({ kind: "type", id: TYPE_SKILL_INJECTOR }, { kind: "type", id: TYPE_ALPHA_TRAINING_INJECTOR });
    if (fitWarnings.length > 0 || (fitSkillWarning?.count ?? 0) > 0) flow.requestNames(refs);
  });
  /** The fit-name label's link icon (fittingWnd: res:/UI/Texture/classes/HyperNet/hyperlink_icon.png). */
  const HYPERLINK_ICON = clientTexture("res:/UI/Texture/classes/HyperNet/hyperlink_icon.png");
  /** A simulation word: the client's where the install has it, the page's own otherwise. */
  function simulationWord(label: string, args: Record<string, string | number> = {}): string {
    const template = $words.templates[label];
    return plainText(formatTemplate(typeof template === "string" && template !== "" ? template : SIMULATION_WORDS[label] ?? "", args, {
      nameOf: (kind, id) => String($names.resolved[nameKey(kind, id)] ?? id),
    }));
  }
  /** activationStateLabels: a module's state's label, by its state and its kind (PASSIVE 0, ACTIVATABLE 1, RIG 2, SUBSYSTEM 3). */
  const MODULE_MODE_LABELS: Readonly<Record<string, string>> = {
    "0:1": "ModuleModeOffline",
    "0:0": "ModuleModeOfflinePassive",
    "0:2": "ModuleModeOfflineRig",
    "1:3": "ModuleModeOfflineSubsystem",
    "1:1": "ModuleModeOnline",
    "1:0": "ModuleModeOnlinePassive",
    "1:2": "ModuleModeOnlineRig",
    "2:1": "ModuleModeActive",
    "2:0": "ModuleModeOnlinePassive",
    "3:1": "ModuleModeOverheated",
  };
  /** A simulated module's state (OFFLINE 0, ONLINE 1, ACTIVE 2, OVERHEATED 3), by its slot; null where there is none. */
  function simulatedState(slot: FittingSlot): number | null {
    const flagID = slotFlagOf(slot.family, slot.index);
    if (!simulation || !slot.module || flagID === null) return null;
    return simulation.moduleStates[flagID] ?? null;
  }
  /** GetTextForCurrentStateForDogmaItem: the simulated module's state, said. */
  function simulatedStateText(slot: FittingSlot): string | null {
    const flagID = slotFlagOf(slot.family, slot.index);
    const state = simulatedState(slot);
    if (!simulation || state === null || flagID === null) return null;
    const label = MODULE_MODE_LABELS[`${state}:${simulation.moduleKinds[flagID] ?? 1}`];
    return label ? simulationWord(`UI/Fitting/FittingWindow/${label}`) : null;
  }
  /** A simulated socket said: its slot, its module and the module's simulated state (not the ship's own online state). */
  function simulatedSocketDescription(slot: FittingSlot): string {
    if (!slot.module) return socketDescription(slot);
    const loaded = slot.module.charge ? `, loaded with ${chargeCount(slot.module.charge.quantity)} ${moduleName(slot.module.charge.typeID)}` : "";
    return `${slotName(slot)}, ${moduleName(slot.module.typeID)}, ${simulatedStateText(slot) ?? ""}${loaded}`;
  }
  /** The ghost ship icon's tooltip (LoadSimulationIconTooltip): its header and its description. */
  const simulateHint = $derived.by(() =>
    simulation
      ? `${simulationWord("UI/Fitting/FittingWindow/ExitSimulationMode")}: ${simulationWord("Tooltips/FittingWindow/ExitSimulationModeDescription")}`
      : `${simulationWord("UI/Fitting/FittingWindow/SimulateShipFitting")}: ${simulationWord("Tooltips/FittingWindow/SimulateShipFittingDescription")}`,
  );
  /** The ghost ship icon clicked (ToggleGhostFitting): into the simulation, or out of it. */
  function toggleSimulation(): void {
    simulationError = null;
    fitFeedback = "";
    void run(async () => {
      if (simulation) flow.exitSimulation();
      else await flow.simulateShip();
    });
  }
  /**
   * A simulated module clicked (OnClickSimulated): its next state, backwards with shift. Where it cannot be put in it,
   * the client's UserError is said: its dialog's title and body.
   */
  function clickSimulated(slot: FittingSlot, event: MouseEvent): void {
    const flagID = slotFlagOf(slot.family, slot.index);
    if (flagID === null) return;
    error = "";
    simulationError = null;
    // A picked drone goes into the drone bay; a picked charge onto a module is loaded into it.
    if (pickedItemID !== null && pickedCategoryID() === 18) {
      fitSimulated(null);
      return;
    }
    if (!slot.module) {
      if (pickedItemID !== null && pickedCategoryID() !== 8) fitSimulated(flagID);
      return;
    }
    if (pickedItemID !== null && pickedCategoryID() === 8) {
      loadSimulated(flagID);
      return;
    }
    // A picked module put on a module (FittingSlotController.OnDropData: Add): fitted there where it may be, a subsystem
    // in the place of the one in its slot, any other refused as the slot is in use.
    if (pickedItemID !== null) {
      fitSimulated(flagID);
      return;
    }
    try {
      flow.switchSimulatedModule(flagID, event.shiftKey);
    } catch (cause) {
      const key = cause instanceof Error ? cause.message : String(cause);
      const values = (cause as { values?: Readonly<Record<string, number>> }).values ?? {};
      simulationError = { key, typeID: slot.module.typeID, values };
      flow.requestWords([`dialog:${key}/title`, `dialog:${key}/body`]);
    }
  }
  /** The last UserError a simulated module's click met, and the module's type. */
  let simulationError = $state<{ readonly key: string; readonly typeID: number; readonly values: Readonly<Record<string, number>> } | null>(null);
  const simulationErrorText = $derived.by(() => {
    if (!simulationError) return "";
    const { key, typeID, values } = simulationError;
    const args = { modulename: typeID, moduleName: typeID, module: typeID, type: typeID, ...values };
    const fill = (part: "title" | "body"): string => {
      const template = $words.templates[`dialog:${key}/${part}`];
      return typeof template === "string" && template !== ""
        ? plainText(formatTemplate(template, args, { nameOf: (kind, id) => String($names.resolved[nameKey(kind, id)] ?? id) }))
        : "";
    };
    const title = fill("title");
    const body = fill("body");
    return title || body ? [title, body].filter(Boolean).join(": ") : key;
  });

  /** The resistance grid: one row per layer, four damage types across. */
  /**
   * The play page's defense menu as defensePanel.py lays it out: the best-repair cell (the passive shield recharge,
   * GetPassiveRechargeRate's int(2.5 x shield capacity / (recharge time in s))), the four resist icons, and a row a
   * layer - its icon, its hit points (SetDefenseLayerText, the shield's with its recharge time under a day), and a
   * gauge a damage type at 1 - its resonance with the resist written on it (ColoredResistanceLabel, 100 - int(x 100)).
   */
  const clientDefense = $derived.by(() => {
    if (!retail) return null;
    const d = stats.defense;
    const rows = DEFENSE_LAYERS.map((row) => {
      if (d) {
        return {
          layer: row.layer, label: defenseWord(row.label), text: layerText(d, row.layer),
          resist: Object.fromEntries(DAMAGE_TYPES.map((t) => [t.key, d.layers[row.layer].resistances[t.key] / 100])) as Record<string, number | null>,
        };
      }
      const tank = stats.tank[row.layer === "structure" ? "hull" : row.layer];
      const hp = tank.hp.known ? hitPoints(tank.hp.value) : null;
      const recharge = stats.shieldRechargeSeconds;
      const text = hp === null ? "" : row.layer === "shield" && recharge.known && recharge.value < 86400
        ? defenseWord("UI/Fitting/FittingWindow/ColoredHitpointsAndRechargeTime2", { hp, rechargeTime: Math.trunc(recharge.value), startColorTag1: "", startColorTag2: "", endColorTag: "" })
        : defenseWord("UI/Fitting/FittingWindow/ColoredHp2", { hp });
      return {
        layer: row.layer, label: defenseWord(row.label), text,
        resist: Object.fromEntries(DAMAGE_TYPES.map((t) => { const x = tank.resistances[t.key]; return [t.key, x.known ? x.value : null]; })) as Record<string, number | null>,
      };
    });
    const shield = stats.tank.shield.hp, recharge = stats.shieldRechargeSeconds;
    const passive = d ? d.passiveShieldRecharge : shield.known && recharge.known && recharge.value > 0 ? Math.trunc((2.5 * shield.value) / recharge.value) : null;
    return { rows, passive: passive === null ? "" : defenseWord("UI/Fitting/FittingWindow/ColoredPassiveRepairRate", { hpPerSec: passive }) };
  });
  /** targetingPanel's sensor icons (textureByAttributeID), by the strongest sensor's kind. */
  const SENSOR_ICON: Record<string, string> = { Gravimetric: "sensorstrengthcaldari", Radar: "sensorstrengthamarr", Magnetometric: "sensorstrengthgallente", Ladar: "sensorstrengthminmatar" };
  /**
   * The play page's targeting and navigation menus (targetingPanel.py, navigationPanel.py on attributePanel /
   * basePanel.GetValueParentGrid): two columns, a cell an attribute - its StatsIcons icon (20, 3 in), its value in the
   * panel's words 7 + 20 in - targeting [sensor strength, scan resolution], [signature radius, targets at once],
   * navigation [mass, inertia modifier], [warp speed, align time].
   */
  const clientTargeting = $derived.by(() => !retail ? null : [
    { icon: SENSOR_ICON[stats.targeting.sensorName ?? ""] ?? "sensorstrengthgallente", hint: stats.targeting.sensorName ? `${stats.targeting.sensorName} sensor strength` : "Sensor strength",
      text: knownWord(stats.targeting.sensorStrength, (v) => shipWord("UI/Fitting/FittingWindow/SensorStrength", { points: v })) },
    { icon: "scanresolution", hint: "Scan resolution", text: knownWord(stats.targeting.scanResolution, (v) => shipWord("UI/Fitting/FittingWindow/ScanResolution", { resolution: Math.trunc(v) })) },
    { icon: "signatureradius", hint: "Signature radius", text: knownWord(stats.navigation.signatureRadius, (v) => shipWord("UI/Fitting/FittingWindow/TargetingRange", { range: v })) },
    { icon: "maximumlockedtargets", hint: "Maximum locked targets", text: knownWord(stats.targeting.maxLockedTargets, (v) => shipWord("UI/Fitting/FittingWindow/MaxLockedTargets", { maxTargets: Math.ceil(v) })) },
  ]);
  const clientNavigation = $derived.by(() => !retail ? null : [
    { icon: "mass", hint: "Mass", text: knownWord(stats.navigation.mass, (v) => (v > 10000.0
      ? shipWord("UI/Fitting/FittingWindow/MassTonnes", { mass: v / 1000.0 }) : shipWord("UI/Fitting/FittingWindow/MassKg", { mass: v }))) },
    { icon: "inertiamodifier", hint: "Inertia modifier", text: knownWord(stats.navigation.inertiaModifier, (v) => shipWord("UI/Fitting/FittingWindow/InertiaModifier", { value: v })) },
    { icon: "warpspeed", hint: "Warp speed", text: knownWord(stats.navigation.warpSpeedAuPerSecond, (v) => shipWord("UI/Fitting/FittingWindow/WarpSpeed", { distText: fmtDist(v * METRES_PER_AU, 2, say) })) },
    { icon: "aligntime", hint: "Time to align", text: knownWord(stats.navigation.alignTimeSeconds, (v) => shipWord("UI/Fitting/FittingWindow/AlignTime", { value: v })) },
  ]);

  /**
   * The play page's offense and drone menus (offensePanel.py, dronePanel.py on basePanel's value grid): offense -
   * [total dps (DpsLabel, its with-reload figure after it in brackets where it differs), alpha strike (the damage
   * attribute's form of int(round(alpha)))], the header the total dps alone; drones - [bandwidth (FmtAmt of the used /
   * the ship's), control range], then the active count and Manage drones, the header the drones' dps.
   */
  const clientOffense = $derived.by(() => {
    if (!retail) return null;
    const sim = stats.firepower.simulator ?? null;
    const dps = (v: number) => offenseWord("UI/Fitting/FittingWindow/DpsLabel", { dps: v });
    const total = sim
      ? dps(sim.totalDps) + (sim.totalDpsWithReload && sim.totalDpsWithReload !== sim.totalDps ? ` (${dps(sim.totalDpsWithReload)})` : "")
      : knownWord(stats.firepower.dps, dps);
    const alpha = sim ? `${whole(Math.round(sim.alphaStrike))} HP` : knownWord(stats.firepower.volley, (v) => `${whole(Math.round(v))} HP`);
    return {
      header: sim ? dps(sim.totalDps) : knownWord(stats.firepower.dps, dps),
      cells: [{ icon: "turretdps", hint: "Damage per second", text: total }, { icon: "alphastrike", hint: "Alpha strike", text: alpha }],
    };
  });
  const clientDrones = $derived.by(() => {
    if (!retail) return null;
    const d = stats.drones ?? null;
    const shipBandwidth = knownWord(stats.bays.droneBandwidth, (v) => `${toFixed(v, 0)} Mbit/sec`);
    return {
      header: d ? offenseWord("UI/Fitting/FittingWindow/DpsLabel", { dps: d.dps }) : knownWord(stats.firepower.droneDps, (v) => offenseWord("UI/Fitting/FittingWindow/DpsLabel", { dps: v })),
      cells: [
        { icon: "bandwidth", hint: "Drone bandwidth", text: d ? `${Math.round(d.bandwidthUsed).toLocaleString()}/${shipBandwidth}` : shipBandwidth },
        { icon: "controlrange", hint: "Drone control range", text: knownWord(stats.bays.droneControlRange, (v) => `${whole(v)} m`) },
      ],
      active: d ? offenseWord("UI/Fitting/FittingWindow/NumDronesActive", { numDrones: d.activeDrones }) : "",
    };
  });

  /** defensePanel's resist icons and layer icons (StatsIcons), by damage type and layer. */
  const RESIST_ICON: Record<string, string> = { em: "emresistance", thermal: "thermalresistance", kinetic: "kineticresistance", explosive: "explosiveresistance" };
  const LAYER_ICON: Record<string, string> = { shield: "shieldhp", armor: "armorhp", structure: "structurehp" };
  /** SetDefenseLayerText's fit: the font made smaller (from 12) until the text is within 62 x 34. */
  function fitDefenseLabel(el: HTMLElement, _text: string) {
    const fit = () => {
      let size = 12;
      el.style.fontSize = `${size}px`;
      while (size > 6 && (el.scrollWidth > 62 || el.scrollHeight > 34)) el.style.fontSize = `${--size}px`;
    };
    fit();
    return { update: () => fit() };
  }

  const defenceRows = $derived.by(() =>
    LAYERS.map((layer) => ({
      layer,
      label: layerLabels[layer],
      tank: stats.tank[layer],
    })),
  );

  const damageProfileText = $derived.by(() => {
    const profile = stats.damageProfile;
    const parts = [profile.em, profile.thermal, profile.kinetic, profile.explosive].map((share) =>
      Math.round(share * 100),
    );
    return parts.join("/");
  });

  /** Grade a resistance by strength, so a strong tank reads green at a glance —
   * always alongside the number, so colour is reinforcement, never the signal. */
  function resistClass(stat: Stat): string {
    if (!stat.known) {
      return "";
    }
    if (stat.value >= 0.55) return "resist-hi";
    if (stat.value >= 0.35) return "resist-med";
    if (stat.value >= 0.15) return "resist-lo";
    return "resist-none";
  }

  // --- the bottom read-outs -------------------------------------------------

  // The simulated cargo hold (minihangar CargoCargoSlots, simulated): a click shows its items (the itemUtilMenu's
  // CargoItemPickerMenu); a picked item put on it is put in the hold (OnDropData: AddSimulatedCargo).
  let simCargoOpen = $state(false);
  function clickSimulatedCargo(): void {
    if (pickedItemID !== null) {
      const typeID = pickedTypeID();
      if (typeID === null) return;
      pickedItemID = null;
      void run(() => flow.addSimulatedCargo(typeID));
      return;
    }
    simCargoOpen = !simCargoOpen;
  }
  function setSimulatedCargo(typeID: number, wanted: number): void {
    if (!Number.isFinite(wanted)) return;
    void run(() => flow.setSimulatedCargo(typeID, wanted));
  }
  // The simulated fighter bay (minihangar CargoFighterSlots, simulated), in the drone bay's place where the hull has one
  // (ContructDroneAndFighterIcons: HasFighterBay): a click shows its picker (fittingWnd GetFighterMenu:
  // FighterBayItemPickerMenu); a picked item put on it, one of each fighter (AddSimulatedFighters: GetQtyByTypeIDs,
  // fighters only), goes to a tube or the bay (TryFitFightersToTubeOrBay).
  let simFightersOpen = $state(false);
  function clickSimulatedFighterBay(): void {
    if (pickedItemID !== null) {
      const typeID = pickedTypeID();
      const fighter = pickedCategoryID() === 87;
      pickedItemID = null;
      if (typeID !== null && fighter) void run(() => flow.addSimulatedFighters(typeID, 1));
      return;
    }
    simFightersOpen = !simFightersOpen;
  }
  /**
   * An item dragged out of the inventory onto a simulated hold (minihangar CargoSlots.OnDropData, its nodes): its row,
   * as the inventory holds it (the hangar, the cargo, a ship's bays or a container open), for its type, category and
   * stack. Any item: the hold's own rules then take what they take.
   */
  function droppedItem(event: DragEvent): { readonly typeID: number; readonly categoryID: number | null; readonly quantity: number } | null {
    const payload = decodeDrag(event.dataTransfer?.getData(DRAG_MIME) ?? null);
    if (payload?.kind !== "inventoryItem") return null;
    const rows = [
      ...$inventory.hangar.rows, ...$inventory.cargo.rows, ...($inventory.container?.rows ?? []),
      ...($inventory.openShip?.bays ?? []).flatMap((bay) => bay.items ?? []),
    ];
    const row = rows.find((each) => each.itemID === payload.itemID);
    return { typeID: payload.typeID, categoryID: row?.categoryID ?? null, quantity: row?.quantity ?? 1 };
  }
  /**
   * A hold's readout given items dragged out of the inventory, not simulating (CargoCargoSlots, CargoDroneSlots and
   * CargoFighterSlots OnDropData: invCtrl.ShipCargo, ShipDroneBay, ShipFighterBay(activeShip).OnDropData): the drag's
   * selection (its nodes) moved into that hold of the active ship, as the inventory moves them (a single stack held to
   * what fits; a drop on the place it is in refused and said).
   */
  function dropOnRealHold(event: DragEvent, to: InventoryPlace): void {
    const payload = decodeDrag(event.dataTransfer?.getData(DRAG_MIME) ?? null);
    if (payload === null) return;
    event.preventDefault();
    const verdict = dropOnPlaceVerdict(payload, to);
    if (verdict !== null) {
      error = verdict;
      return;
    }
    // One node off a slot of the ship, onto the cargo (CargoCargoSlots.OnDropData, 282 to 290): a module is
    // UnloadModuleToContainer to the cargo, a charge UnloadAmmoToContainer.
    if (payload.kind === "fittedModule") {
      void run(async () => {
        await flow.unloadModuleToCargo(payload.itemID);
        selected = null;
        await flow.loadInventory();
      });
      return;
    }
    if (payload.kind === "fittedCharge") {
      void run(async () => {
        await flow.unloadChargeToCargo(payload.flagID);
        await flow.loadInventory();
      });
      return;
    }
    const from = payload.from;
    const ticked = $inventory.selection.length > 0 ? [...$inventory.selection] : [payload.itemID];
    const selectedRows = rowsIn($inventory, from).filter((row) => ticked.includes(row.itemID));
    const quantity = moveQuantityFor({ inventory: $inventory, destination: to, selection: ticked, selectedRows, typedQuantity: null });
    if (quantity.kind === "refused") {
      error = quantity.message;
      return;
    }
    void run(() => flow.transferItems(ticked, from, to, quantity.quantity));
  }
  /**
   * The type a Shift-held drag of a module that groups is linking (OnStartSlotLinkingMode, baseFitting 147 to 155):
   * while it lasts every slot with a module of another type is faded to a tenth, and back at the drag's end
   * (OnResetSlotLinkingMode, slot.OnEndDrag).
   */
  let linkingTypeID = $state<number | null>(null);
  /**
   * A real slot dragged (fittingSlotController.GetDragData): the charge where one is loaded (its nodes, whatever is
   * held), else the module; with Shift held a module that groups is dragged as ever and starts the slot linking mode,
   * and one that does not is not dragged at all.
   */
  function startSlotDrag(event: DragEvent, slot: FittingSlot): void {
    const module = slot.module;
    const flagID = slotFlagOf(slot.family, slot.index);
    if (simulation || module === null || flagID === null || !event.dataTransfer) {
      event.preventDefault();
      return;
    }
    let payload: DragPayload;
    if (module.charge) {
      payload = { kind: "fittedCharge", moduleID: module.itemID, flagID, typeID: module.charge.typeID };
    } else if (event.shiftKey && !GROUPABLE_GROUP_IDS.has(module.groupID ?? -1)) {
      event.preventDefault();
      return;
    } else {
      payload = { kind: "fittedModule", itemID: module.itemID, typeID: module.typeID };
      if (event.shiftKey) linkingTypeID = module.typeID;
    }
    event.dataTransfer.setData(DRAG_MIME, encodeDrag(payload));
    event.dataTransfer.setData("text/plain", moduleName(payload.typeID));
    event.dataTransfer.effectAllowed = "move";
  }
  /** A simulated hold's readout taking an item dragged out of the inventory (its OnDropData). */
  function overSimulatedHold(event: DragEvent): void {
    if (carriesOurPayload(event.dataTransfer?.types as string[] | undefined)) event.preventDefault();
  }
  /** CargoCargoSlots.AddSimulatedCargo: one of each item dropped (GetQtyByTypeIDs), put in the hold (TryFitItemsToCargo). */
  function dropOnSimulatedCargo(event: DragEvent): void {
    const item = droppedItem(event);
    if (!item) return;
    event.preventDefault();
    void run(() => flow.addSimulatedCargo(item.typeID));
  }
  /** CargoDroneSlots.AddSimulatedDrones: one of each item dropped, a drone only (TryFitDronesToDroneBay). */
  function dropOnSimulatedDroneBay(event: DragEvent): void {
    const item = droppedItem(event);
    if (!item) return;
    event.preventDefault();
    void run(() => flow.addSimulatedDrones(item.typeID));
  }
  /** CargoFighterSlots.AddSimulatedFighters: one of each item dropped, a fighter only, to a tube or the bay. */
  function dropOnSimulatedFighterBay(event: DragEvent): void {
    const item = droppedItem(event);
    if (!item) return;
    event.preventDefault();
    if (item.categoryID === 87) void run(() => flow.addSimulatedFighters(item.typeID, 1));
  }
  /** The picked item's stack (a dropped item's stacksize). */
  function pickedQuantity(): number {
    return fittableRows().find((entry) => entry.row.itemID === pickedItemID)?.row.quantity ?? 1;
  }
  type SimulatedTubeEntry = NonNullable<typeof simulation>["fighterTubes"][number];
  /** A fighter dragged in the picker: a tube's squadron (GetSquadronDragData) or a bay's type (ItemPickerBase.GetDragData). */
  type FighterDrag = { readonly from: "tube"; readonly flagID: number; readonly typeID: number } | { readonly from: "bay"; readonly typeID: number };
  let fighterDrag: FighterDrag | null = null;
  function startFighterDrag(event: DragEvent, drag: FighterDrag): void {
    fighterDrag = drag;
    event.dataTransfer?.setData("application/x-evejs-simulated-fighter", String(drag.typeID));
  }
  /**
   * A tube given a fighter (SingleTube.OnDropDataOnTube): a picked one, a bay's type or a tube's squadron put on it, a full
   * squadron of its type (FitFighterToTube, GetMaxSquadronSize; a tube's squadron dropped stays in its own tube). A tube
   * past the ship's is disabled.
   */
  function clickSimulatedTube(tube: SimulatedTubeEntry): void {
    if (pickedItemID === null || !tube.present) return;
    const typeID = pickedTypeID();
    if (typeID === null || pickedCategoryID() !== 87) return;
    pickedItemID = null;
    void run(() => flow.fitSimulatedFighterToTube(typeID, tube.flagID));
  }
  function dropOnTube(event: DragEvent, tube: SimulatedTubeEntry): void {
    const drag = fighterDrag;
    fighterDrag = null;
    if (!drag || !tube.present) return;
    event.preventDefault();
    void run(() => flow.fitSimulatedFighterToTube(drag.typeID, tube.flagID));
  }
  /**
   * The fighter bay's list given fighters (OnDroppedInList): a tube's squadron dropped on it, out of its tube and into the
   * bay (_TryRemoveItemsFromTube, _TryAddToFighterBay); a picked stack put on it, as many as it holds, a fighter only.
   */
  function clickFighterBayList(): void {
    if (pickedItemID === null) return;
    const typeID = pickedTypeID();
    const qty = pickedQuantity();
    const fighter = pickedCategoryID() === 87;
    pickedItemID = null;
    if (typeID !== null && fighter) void run(() => flow.addSimulatedFighterBay(typeID, qty));
  }
  function dropOnFighterBayList(event: DragEvent): void {
    // An item dragged out of the inventory: _TryAddToFighterBay, as many as its stack, a fighter only.
    const item = droppedItem(event);
    if (item) {
      event.preventDefault();
      if (item.categoryID === 87) void run(() => flow.addSimulatedFighterBay(item.typeID, item.quantity));
      return;
    }
    const drag = fighterDrag;
    fighterDrag = null;
    if (drag?.from !== "tube") return;
    event.preventDefault();
    void run(() => flow.moveSimulatedSquadronToBay(drag.flagID));
  }
  function setSimulatedFighterBay(typeID: number, wanted: number): void {
    if (!Number.isFinite(wanted)) return;
    void run(() => flow.setSimulatedFighterBay(typeID, wanted));
  }
  /** The picker's fightersAllowedCont: the light, support and heavy squadrons (fighterInvCont SquadronTypeContainer). */
  const FIGHTER_CLASSES = [
    { kind: "light", label: "UI/Fighters/Class/Light", icon: clientTexture("res:/UI/Texture/classes/CarrierBay/iconFighterLight.png") },
    { kind: "support", label: "UI/Fighters/Class/Support", icon: clientTexture("res:/UI/Texture/classes/CarrierBay/iconFighterMedium.png") },
    { kind: "heavy", label: "UI/Fighters/Class/Heavy", icon: clientTexture("res:/UI/Texture/classes/CarrierBay/iconFighterHeavy.png") },
  ] as const;
  /** fighterConst TEXTURE_BY_ROLE and HINTTEXT_BY_ROLE: a squadron's role icon (none for ROLE_NONE) and its hint. */
  const FIGHTER_ROLES: Readonly<Record<number, { readonly icon: string | null; readonly hint: string }>> = {
    0: { icon: null, hint: "UI/Inventory/Fighters/RoleNoneHint" },
    1: { icon: clientTexture("res:/UI/Texture/classes/ShipUI/Fighters/roleIcon_Interceptor.png"), hint: "UI/Inventory/Fighters/RoleAntiFighterHint" },
    2: { icon: clientTexture("res:/UI/Texture/classes/ShipUI/Fighters/roleIcon_General.png"), hint: "UI/Inventory/Fighters/RoleGeneralHint" },
    3: { icon: clientTexture("res:/UI/Texture/classes/ShipUI/Fighters/roleIcon_Support.png"), hint: "UI/Inventory/Fighters/RoleEwarHint" },
    4: { icon: clientTexture("res:/UI/Texture/classes/ShipUI/Fighters/roleIcon_AntiCapital.png"), hint: "UI/Inventory/Fighters/RoleTorpedoBomberHint" },
    5: { icon: clientTexture("res:/UI/Texture/classes/ShipUI/Fighters/roleIcon_Bomber.png"), hint: "UI/Inventory/Fighters/RoleAOEBomberHint" },
  };
  /** GetSortedItemsInfo: the hold's types by their names. */
  function cargoByName(entries: readonly { readonly typeID: number; readonly quantity: number; readonly most: number }[]) {
    return [...entries].sort((a, b) => {
      const [left, right] = [moduleName(a.typeID), moduleName(b.typeID)];
      return left < right ? -1 : left > right ? 1 : 0;
    });
  }
  /** The active ship's own fighter bay (CargoFighterSlots, not simulated), where the hull has one. */
  const realBayReadout = $derived.by(() => {
    const bay = $fitting.bayReadout ?? null;
    return bay !== null && bay.shipID === $fitting.activeShipID ? bay : null;
  });
  /**
   * A hold's readout as minihangar CargoSlots._Update writes it (SetStatusText): its use, FmtAmt(used, showFraction=1);
   * then UI/Fitting/FittingWindow/CargoUsage of its capacity, FmtAmt(GetCapacityInfo's value, showFraction=1), with no
   * colour (no module previewed); then UI/Fitting/FittingWindow/CubicMeters. FmtAmt writes a float to one place and an
   * int whole (eveLocalization.FormatNumeric); GetStatsInfo's value is a float (round). A use unknown is a dash.
   */
  function holdReadout(used: PyNumber | null, capacity: number): string {
    const amount = (value: PyNumber): string => formatNumeric(value, { useGrouping: true, decimalPlaces: 1 });
    const usage = simulationWord("UI/Fitting/FittingWindow/CargoUsage", { color: "", text: amount(capacity) });
    return `${used === null ? "—" : amount(used)} ${usage} ${simulationWord("UI/Fitting/FittingWindow/CubicMeters")}`;
  }
  /** A figure as the server sent it: EveJS's marshal writes a whole number as an int (marshal.js), any other as a float. */
  function sentNumber(value: number | null | undefined): PyNumber | null {
    if (value === null || value === undefined || !Number.isFinite(value)) return null;
    return Number.isInteger(value) ? { int: value } : value;
  }
  /**
   * The ship's own cargo hold's readout (CargoCargoSlots): the use of its inventory (invCtrl.ShipCargo(shipID).GetCapacity,
   * the inventory slice's read) over GetCargoCapacity (the ship's figures; the inventory's capacity where they are not
   * read). A use not read yet is a dash.
   */
  const cargoBayText = $derived.by<string>(() => {
    const cap = $inventory.cargo.capacity;
    const capacity = stats.bays.cargoCapacity.known ? stats.bays.cargoCapacity.value : cap?.capacity ?? null;
    return capacity === null ? "Unavailable" : holdReadout(sentNumber(cap?.used), capacity);
  });
  // The simulated drone bay (minihangar CargoDroneSlots, simulated): a picked item put on it, a drone only, one of it
  // (AddSimulatedDrones); a click shows its drones (OpenFakeDroneBay: the drone picker, here the Drones section's).
  let dronesSection = $state<HTMLDetailsElement | null>(null);
  function clickSimulatedDroneBay(): void {
    if (pickedItemID !== null) {
      const typeID = pickedTypeID();
      const drone = pickedCategoryID() === 18;
      pickedItemID = null;
      if (typeID !== null && drone) void run(() => flow.addSimulatedDrones(typeID));
      return;
    }
    if (dronesSection) {
      dronesSection.open = true;
      dronesSection.scrollIntoView({ block: "nearest" });
    }
  }

  /**
   * A fit's total ISK value needs a market price for the hull and every fitted
   * module — prices this window does not read. Stated as unavailable rather than
   * guessed, exactly like every other unsourced number here.
   */
  const fitValue = unavailable(
    "a fit's total value needs a market price for the hull and every module, which this window does not read",
  );

  // --- R21 slice B — a clicked module's EFFECTIVE stats ---------------------
  //
  // The server's post-dogma attributes for one fitted module: its skills, hull
  // bonuses and in-space effects are ALREADY baked in before we see them (see
  // bridge/boundDogma.ts / moduleAttributes.ts). We only label and format; the
  // numbers are the server's. An itemID can exceed 2^53 on the wire, so the
  // lookup compares string forms rather than trusting `===` on two numbers.

  function moduleStatsFor(itemID: number): readonly ModuleStat[] {
    const snapshot = $dogma.allInfo;
    if (!snapshot) {
      return [];
    }
    const key = String(itemID);
    const item = snapshot.ships.find((entry) => String(entry.itemID) === key);
    return moduleEffectiveStats(item?.attributes);
  }

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) {
      return;
    }
    busy = true;
    error = "";
    try {
      await action();
    } catch (cause) {
      if (isSessionLost(cause)) {
        error = "The live session ended (idle timeout or another client took over).";
      } else {
        error =
          panelErrorWords(cause);
      }
    } finally {
      busy = false;
    }
  }

  async function refresh(): Promise<void> {
    // The hangar / cargo rows feed the "what can I fit" list, so the fitting
    // panel refreshes both reads together. loadFitting also pulls the dogma
    // snapshot for the module stats on the same beat.
    await flow.loadInventory();
    await flow.loadFitting();
  }

  // --- R78: dragging a module onto a socket ---------------------------------
  //
  // ⚠ AN ACCELERATOR, NOT A REPLACEMENT. Pick-then-Fit still works exactly as it
  // did: every button below is untouched, and a player who cannot drag loses
  // nothing. Dragging is simply what someone arriving from the retail client
  // reaches for first.

  /** The socket the pointer is over, so it can light up while dragging. */
  let dropSlot = $state<string | null>(null);
  /** Why the last attempted drop was refused, in the panel's own error line. */
  function slotKey(slot: FittingSlot): string {
    return `${slot.family}:${slot.index}`;
  }

  function startItemDrag(event: DragEvent, itemID: number, typeID: number, source: "hangar" | "cargo"): void {
    const payload: DragPayload = {
      kind: "inventoryItem",
      itemID,
      typeID,
      from: source === "hangar" ? { kind: "hangar" } : { kind: "cargo" },
    };
    event.dataTransfer?.setData(DRAG_MIME, encodeDrag(payload));
    // A plain-text copy so dragging into a text field or another app produces
    // something legible rather than nothing.
    event.dataTransfer?.setData("text/plain", moduleName(typeID));
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
    }
  }

  function overSocket(event: DragEvent, slot: FittingSlot): void {
    if (!carriesOurPayload(event.dataTransfer?.types as string[] | undefined)) {
      return;
    }
    // preventDefault is what MAKES an element a drop target; without it the
    // browser refuses the drop and shows the "no entry" cursor.
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    dropSlot = slotKey(slot);
  }

  function dropOnSocket(event: DragEvent, slot: FittingSlot): void {
    dropSlot = null;
    linkingTypeID = null;
    const payload = decodeDrag(event.dataTransfer?.getData(DRAG_MIME) ?? null);
    const verdict = dropOnSocketVerdict(payload, simulation !== null);
    event.preventDefault();
    if (verdict !== null) {
      // Refused, and SAID — the panel's existing error line, so a rejected drop
      // reads the same way a rejected click does.
      error = verdict;
      return;
    }
    // The real ship's slot (fittingScreen/fittingSlotController.OnDropData, Shift as it is at the drop): a module off
    // another slot is grouped with this one's with Shift held, else moved here; a charge, off another slot or out of
    // a hold, is loaded into the module here (FitCharges), and taken nowhere else.
    const flagID = slotFlagOf(slot.family, slot.index);
    const shift = event.shiftKey;
    if (!simulation && flagID !== null && payload !== null) {
      if (payload.kind === "fittedModule") {
        void run(async () => {
          await flow.dropFittedModuleOnSlot(payload.itemID, flagID, shift);
          await flow.loadInventory();
        });
        return;
      }
      if (payload.kind === "fittedCharge") {
        void run(async () => {
          await flow.dropFittedChargeOnSlot(payload.flagID, flagID, shift);
          await flow.loadInventory();
        });
        return;
      }
      const row = rowsIn($inventory, payload.from).find((each) => each.itemID === payload.itemID);
      // fittingUtil.IsCharge: the charge category (and the frequency crystals' number, as the client compares it).
      if (row && (row.categoryID === 8 || row.categoryID === 86)) {
        // Where it lies (DropLoadChargeToModule: chargeItems[0].locationID): the hangar, or the ship flown for its
        // cargo and every other hold of it, the charge's own flag kept for a split.
        const from = payload.from;
        const ofShipFlown = from.kind === "cargo" || (from.kind === "shipBay" && $inventory.openShip?.itemID === $inventory.activeShipID);
        if (from.kind !== "hangar" && !ofShipFlown) {
          error = "The page loads charges from the hangar or the holds of the ship you fly so far.";
          return;
        }
        const place = from.kind === "hangar" ? "hangar" : "cargo";
        // The hold's own flag, the place's (measured: the row's own flag gave a split into the cargo).
        const chargeFlag = from.kind === "hangar" ? 4 : from.kind === "cargo" ? 5 : BAY_FLAGS[from.bay] ?? row.flagID ?? 5;
        void run(async () => {
          await flow.dropChargeOnSlot({ itemID: row.itemID, typeID: row.typeID, quantity: row.quantity, from: place, flagID: chargeFlag }, flagID, shift);
          await flow.loadInventory();
        });
        return;
      }
    }
    // Narrowed by the verdict above: only an inventory item can reach here.
    const item = payload as Extract<DragPayload, { kind: "inventoryItem" }>;
    // ⚠ IT GOES THROUGH `fitInto`, NOT ITS OWN `flow.fitModule` CALL. A drop is
    // the same act as picking an item and pressing Fit, so it makes the drop the
    // current pick and then runs the existing handler. Writing the call again
    // here would be a second path to the same server call — which is precisely
    // what `fittingWindow.test.ts` counts call sites to prevent, and it caught
    // this on the first run.
    pickedItemID = item.itemID;
    pickedSource = item.from.kind === "cargo" ? "cargo" : "hangar";
    fitInto(slot);
  }

  function fitInto(slot: FittingSlot): void {
    const itemID = pickedItemID;
    if (itemID === null) {
      return;
    }
    if (simulation) {
      fitSimulated(slotFlagOf(slot.family, slot.index));
      return;
    }
    const source = pickedSource;
    void run(async () => {
      await flow.fitModule(itemID, source, { family: slot.family, index: slot.index });
      pickedItemID = null;
      await flow.loadInventory();
    });
  }

  function fitAnywhere(): void {
    const itemID = pickedItemID;
    if (itemID === null) {
      return;
    }
    if (simulation) {
      fitSimulated(null);
      return;
    }
    const source = pickedSource;
    void run(async () => {
      await flow.fitModule(itemID, source, "auto");
      pickedItemID = null;
      await flow.loadInventory();
    });
  }

  function pick(itemID: number, source: "hangar" | "cargo"): void {
    pickedItemID = pickedItemID === itemID ? null : itemID;
    pickedSource = source;
  }

  function unfit(itemID: number): void {
    void run(async () => {
      await flow.unfitModule(itemID);
      selected = null;
      await flow.loadInventory();
    });
  }

  function toggleOnline(itemID: number, online: boolean): void {
    void run(() => flow.setModuleOnline(itemID, online));
  }

  function destroyRig(itemID: number): void {
    confirmingRigID = null;
    void run(async () => {
      await flow.destroyRig(itemID);
      selected = null;
      await flow.loadInventory();
    });
  }

  onMount(() => {
    // The remembered choice wins; with none, the viewport decides. This is the
    // R8 contract — list on a phone, radial above the breakpoint — but the
    // player can always override it, in either direction.
    let remembered: string | null = null;
    try {
      remembered = globalThis.localStorage?.getItem(VIEW_STORAGE_KEY) ?? null;
    } catch {
      remembered = null;
    }
    if (remembered === "radial" || remembered === "list") {
      view = remembered;
    } else if (globalThis.matchMedia?.("(max-width: 640px)").matches) {
      view = "list";
    }
    void run(refresh);
  });
</script>

<!-- ============================ shared snippets ========================== -->

{#snippet statValue(stat: Stat, format: (value: number) => string)}
  {#if stat.known}
    {format(stat.value)}
  {:else}
    <span class="stat-unavailable" title={stat.why}>Unavailable</span>
  {/if}
{/snippet}

{#snippet statRow(label: string, stat: Stat, format: (value: number) => string)}
  <tr>
    <th scope="row">{label}</th>
    <td class="num">{@render statValue(stat, format)}</td>
  </tr>
{/snippet}

<!-- A fitted module's EFFECTIVE stats — with the pilot's skills and this hull,
     straight from the server. Reused by the ring detail and the list view. -->
{#snippet moduleStatsBlock(itemID: number)}
  {@const rows = moduleStatsFor(itemID)}
  <div class="module-stats">
    <p class="module-stats-title">Stats — with your skills and this hull</p>
    {#if rows.length > 0}
      <table class="guests module-stats-table">
        <tbody>
          {#each rows as row (row.id)}
            <tr>
              <th scope="row">{row.label}</th>
              <td class="num">{row.value}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {:else if !$dogma.loaded}
      <p class="note">Reading this module's effective stats…</p>
    {:else if $dogma.error}
      <p class="note">
        This module's effective stats could not be read: {$dogma.error}
      </p>
    {:else}
      <p class="note">This module reports no detailed stats.</p>
    {/if}
  </div>
{/snippet}

<!-- The right-hand statistics panel — EVE's collapsible sections, each a
     ▸/▾ header carrying its headline value. Everything is derived from the SAME
     ShipGetInfo attribute map the resource bars read; anything module-summed
     (offense, repairs, drone dps, cap stability) has no allowed read yet and
     says "Unavailable" rather than guessing. -->
{#snippet clientAttributeCells(cells: readonly { icon: string; hint: string; text: string }[])}
  {#each cells as cell (cell.icon)}
    <div class="fit-attr" title={cell.hint}>
      <img alt={cell.hint} src={`/client-res/ui/texture/classes/fitting/statsicons/${cell.icon}.png`} />
      <span>{cell.text}</span>
    </div>
  {/each}
{/snippet}

{#snippet statsPanel()}
  <!-- On the play page the client's (statsPanel.GetMenuData / expandablemenu.ExpandableMenu): only the capacitor's
       menu expanded at first (expandedByDefault), each header 20 high with its expander (ui_38_16_228 collapsed, _229
       expanded), its label 22 in, a white 0.05 fill, its header content shown expanded or not
       (hideHeaderContentOnMaximize False), 4 below each; the column PANEL_WIDTH_RIGHT 280 wide. -->
  <div class="fit-stats">
    <details class="fit-sec" open>
      <summary class="fit-sec-head">
        <span class="fit-sec-name">Capacitor</span>
        {#if stats.capacitor.simulator}
          <span
            class="fit-sec-headline"
            title={capacitorWord(stats.capacitor.simulator.loadBalance > 0
              ? "UI/Fitting/FittingWindow/ModulesSustainable"
              : "UI/Fitting/FittingWindow/ModulesNotSustainable")}
          >{capacitorHeadline(stats.capacitor.simulator)}</span>
        {:else}
          <span class="fit-sec-headline">
            {@render statValue(stats.capacitor.stability, (v) => (v > 0 ? "Stable" : "Unstable"))}
          </span>
        {/if}
      </summary>
      {#if clientCapacitor}
      <div class="fit-sec-body fit-cap" title={clientCapacitor.hint}>
        <div class="fit-cap-core" aria-hidden="true">
          {#each Array.from({ length: clientCapacitor.columns }, (_, i) => i) as col (col)}
            <div class="fit-cap-col" style={`width: ${clientCapacitor.width}px; transform: translate(-50%, -50%) rotate(${col * clientCapacitor.step}deg)`}>
              {#each clientCapacitor.cells.filter((c) => c.col === col) as c (c.cell)}
                <span class="fit-cap-cell" style={`top: ${c.cell * 4}px; width: ${8 - c.cell * 2}px; --cell: ${c.color}`}></span>
              {/each}
            </div>
          {/each}
        </div>
        <div class="fit-cap-text">
          <div title={capacitorWord("UI/Fitting/FittingWindow/CapacityAndRechargeRate")}>{clientCapacitor.capText}</div>
          {#if clientCapacitor.deltaText}<div title={capacitorWord("UI/Fitting/FittingWindow/ExcessCapacitor")}>{clientCapacitor.deltaText}</div>{/if}
        </div>
      </div>
      {:else}
      <div class="fit-sec-body">
        <table class="guests">
          <tbody>
            {@render statRow("Capacity", stats.capacitor.capacity, (v) => `${whole(v)} GJ`)}
            {@render statRow("Recharge time", stats.capacitor.rechargeSeconds, asSeconds)}
            {#if !stats.capacitor.simulator}
              {@render statRow("Net change per second", stats.capacitor.deltaPerSecond, whole)}
              {@render statRow("Lasts for", stats.capacitor.lastsForSeconds, asSeconds)}
            {/if}
          </tbody>
        </table>
        {#if stats.capacitor.simulator}
          <p class="fit-cap-delta" title={capacitorWord("UI/Fitting/FittingWindow/ExcessCapacitor")}>
            {capacitorWord("UI/Fitting/FittingWindow/CapacitorDelta", {
              delta: stats.capacitor.simulator.delta,
              percentage: stats.capacitor.simulator.deltaPercentage,
            })}
          </p>
          <p class="note fit-cap-balance">{capacitorBalance(stats.capacitor.simulator)}</p>
        {:else}
          <p class="note">
            Whether a fit runs its capacitor dry needs each module's drain, which
            this window cannot read yet — so it is left unsaid, not guessed.
          </p>
        {/if}
      </div>
      {/if}
    </details>

    <details class="fit-sec" open={!retail}>
      <summary class="fit-sec-head">
        <span class="fit-sec-name">Offense</span>
        {#if clientOffense}
          <span class="fit-sec-headline">{clientOffense.header}</span>
        {:else if stats.firepower.simulator}
          <span class="fit-sec-headline">{offenseHeadline(stats.firepower.simulator)}</span>
        {:else}
          <span class="fit-sec-headline">{@render statValue(stats.firepower.dps, (v) => `${whole(v)} dps`)}</span>
        {/if}
      </summary>
      {#if clientOffense}
      <div class="fit-sec-body fit-attr-grid">{@render clientAttributeCells(clientOffense.cells)}</div>
      {:else}
      <div class="fit-sec-body">
        {#if stats.firepower.simulator}
          <table class="guests">
            <tbody>
              {#each offenseLines(stats.firepower.simulator) as line (line.label)}
                <tr>
                  <th scope="row">{line.label}</th>
                  <td>
                    {line.text}
                    {#if line.withReload}<br /><span class="muted">{offenseWord("UI/Fitting/FittingWindow/WithReloadTimeText")} {line.withReload}</span>{/if}
                  </td>
                </tr>
              {/each}
              <!-- offensePanel: the alpha strike, a whole number of hit points (int(round(alpha))). -->
              <tr><th scope="row">Volley damage</th><td>{whole(Math.round(stats.firepower.simulator.alphaStrike))} HP</td></tr>
              {@render statRow("Mining yield", stats.mining.cubicMetresPerSecond, asVolume)}
            </tbody>
          </table>
        {:else}
          <table class="guests">
            <tbody>
              {@render statRow("Damage per second", stats.firepower.dps, whole)}
              {@render statRow("Drone damage per second", stats.firepower.droneDps, whole)}
              {@render statRow("Volley damage", stats.firepower.volley, whole)}
              {@render statRow("Mining yield", stats.mining.cubicMetresPerSecond, asVolume)}
            </tbody>
          </table>
          <p class="note">
            Damage summed across your guns, drones or miners needs each module's
            own stats — click a weapon below to read its effective figures.
          </p>
        {/if}
      </div>
      {/if}
    </details>

    <details class="fit-sec" open={!retail}>
      <summary class="fit-sec-head">
        <span class="fit-sec-name">Defense</span>
        {#if stats.defense}
          <span class="fit-sec-headline">{defenseWord("UI/Fitting/FittingWindow/ColoredEffectiveHp", { effectiveHp: Math.trunc(stats.defense.effectiveHp) })}</span>
        {:else}
          <span class="fit-sec-headline">{@render statValue(stats.totalEhp, (v) => `${whole(v)} ehp`)}</span>
        {/if}
      </summary>
      {#if clientDefense}
        <div class="fit-sec-body fit-def">
          <div class="fit-def-top">
            <div class="fit-def-best" title={defenseWord("UI/Fitting/FittingWindow/PassiveShieldRecharge")}>
              <img alt="" src="/client-res/ui/texture/classes/fitting/statsicons/passiveshieldrecharge.png" />
              <span>{clientDefense.passive}</span>
            </div>
            {#each DAMAGE_TYPES as dt, i (dt.key)}
              <img class="fit-def-res-icon" alt={dt.label} title={dt.label} style={`left: ${90 + Math.trunc(i * 45) + Math.trunc(45 / 2) - 12 - 6}px`}
                src={`/client-res/ui/texture/classes/fitting/statsicons/${RESIST_ICON[dt.key]}.png`} />
            {/each}
          </div>
          {#each clientDefense.rows as row (row.layer)}
            <div class="fit-def-row">
              <img alt={row.label} title={row.label} src={`/client-res/ui/texture/classes/fitting/statsicons/${LAYER_ICON[row.layer]}.png`} />
              <span class="fit-def-hp" use:fitDefenseLabel={row.text}>{row.text}</span>
              <div class="fit-def-gauges">
                {#each DAMAGE_TYPES as dt (dt.key)}
                  {@const r = row.resist[dt.key] ?? null}
                  <div class="fit-def-gauge dmg-{dt.key}" title={dt.label}>
                    <span class="fit-def-fill" style={`width: ${r === null ? 0 : Math.max(0, Math.min(1, r)) * 100}%`}></span>
                    <span class="fit-def-val">{r === null ? "" : defenseWord("UI/Fitting/FittingWindow/ColoredResistanceLabel", { number: Math.round(r * 100) })}</span>
                  </div>
                {/each}
              </div>
            </div>
          {/each}
        </div>
      {:else if stats.defense}
        <div class="fit-sec-body">
          <div class="table-wrap overflow-x-auto">
            <table class="guests defence-grid">
              <thead>
                <tr>
                  <th>Layer</th>
                  <th class="num">HP</th>
                  {#each DAMAGE_TYPES as dt (dt.key)}
                    <th class="num"><span class="dmg-chip {dt.cls}">{dt.label}</span></th>
                  {/each}
                </tr>
              </thead>
              <tbody>
                {#each DEFENSE_LAYERS as row (row.layer)}
                  <tr>
                    <td data-label="Layer"><span class="layer-{row.layer === 'structure' ? 'hull' : row.layer}">{defenseWord(row.label)}</span></td>
                    <td class="num" data-label="HP">{layerText(stats.defense, row.layer)}</td>
                    {#each DAMAGE_TYPES as dt (dt.key)}
                      <td class="num" data-label={dt.label}>
                        {defenseWord("UI/Fitting/FittingWindow/ColoredResistanceLabel", { number: stats.defense.layers[row.layer].resistances[dt.key] })}
                      </td>
                    {/each}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <table class="guests">
            <tbody>
              {#each repairLines(stats.defense) as line (line.label)}
                <tr><th scope="row">{line.label}</th><td>{line.text}</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
      <div class="fit-sec-body">
        <p class="note">
          Effective hit points are worked out against an even {damageProfileText}
          spread of the four damage types.
        </p>
        <div class="table-wrap overflow-x-auto">
          <table class="guests defence-grid">
            <thead>
              <tr>
                <th>Layer</th>
                <th class="num">HP</th>
                {#each DAMAGE_TYPES as dt (dt.key)}
                  <th class="num"><span class="dmg-chip {dt.cls}">{dt.label}</span></th>
                {/each}
                <th class="num">EHP</th>
              </tr>
            </thead>
            <tbody>
              {#each defenceRows as row (row.layer)}
                <tr>
                  <td data-label="Layer">
                    <span class="layer-{row.layer}">{row.label}</span>
                    {#if row.layer === "shield" && stats.shieldRechargeSeconds.known}
                      <span class="fit-subnote">↻ {asDuration(stats.shieldRechargeSeconds.value)}</span>
                    {/if}
                  </td>
                  <td class="num" data-label="HP">{@render statValue(row.tank.hp, whole)}</td>
                  <td class="num {resistClass(row.tank.resistances.em)}" data-label="EM">
                    {@render statValue(row.tank.resistances.em, asPercent)}
                  </td>
                  <td class="num {resistClass(row.tank.resistances.thermal)}" data-label="Thermal">
                    {@render statValue(row.tank.resistances.thermal, asPercent)}
                  </td>
                  <td class="num {resistClass(row.tank.resistances.kinetic)}" data-label="Kinetic">
                    {@render statValue(row.tank.resistances.kinetic, asPercent)}
                  </td>
                  <td class="num {resistClass(row.tank.resistances.explosive)}" data-label="Explosive">
                    {@render statValue(row.tank.resistances.explosive, asPercent)}
                  </td>
                  <td class="num" data-label="EHP">{@render statValue(row.tank.ehp, whole)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <table class="guests">
          <tbody>
            {@render statRow("Shield repaired per second", stats.repairs.shield, whole)}
            {@render statRow("Armor repaired per second", stats.repairs.armor, whole)}
            {@render statRow("Structure repaired per second", stats.repairs.hull, whole)}
          </tbody>
        </table>
        <p class="note">
          Active repair rates need each repairer's own numbers — click one below
          to read its effective boost or repair amount.
        </p>
      </div>
      {/if}
    </details>

    <details class="fit-sec" open={!retail}>
      <summary class="fit-sec-head">
        <span class="fit-sec-name">Targeting</span>
        {#if stats.defense || retail}
          <span class="fit-sec-headline">{knownWord(stats.targeting.maxTargetRange, (v) => shipWord("UI/Fitting/FittingWindow/TargetingHeader", { maxRange: v / 1000.0 }))}</span>
        {:else}
          <span class="fit-sec-headline">{@render statValue(stats.targeting.maxTargetRange, asDistance)}</span>
        {/if}
      </summary>
      {#if clientTargeting}
        <div class="fit-sec-body fit-attr-grid">{@render clientAttributeCells(clientTargeting)}</div>
      {:else if stats.defense}
        <!-- targetingPanel.UpdateTargetingPanel: the strongest sensor, the scan resolution's whole part, the targets
             rounded up, the signature radius as a distance. -->
        <div class="fit-sec-body">
          <table class="guests">
            <tbody>
              <tr>
                <th scope="row">{stats.targeting.sensorName ? `${stats.targeting.sensorName} sensor strength` : "Sensor strength"}</th>
                <td>{knownWord(stats.targeting.sensorStrength, (v) => shipWord("UI/Fitting/FittingWindow/SensorStrength", { points: v }))}</td>
              </tr>
              <tr><th scope="row">Scan resolution</th><td>{knownWord(stats.targeting.scanResolution, (v) => shipWord("UI/Fitting/FittingWindow/ScanResolution", { resolution: Math.trunc(v) }))}</td></tr>
              <tr><th scope="row">Signature radius</th><td>{knownWord(stats.navigation.signatureRadius, (v) => shipWord("UI/Fitting/FittingWindow/TargetingRange", { range: v }))}</td></tr>
              <tr><th scope="row">Targets at once</th><td>{knownWord(stats.targeting.maxLockedTargets, (v) => shipWord("UI/Fitting/FittingWindow/MaxLockedTargets", { maxTargets: Math.ceil(v) }))}</td></tr>
            </tbody>
          </table>
        </div>
      {:else}
      <div class="fit-sec-body">
        <table class="guests">
          <tbody>
            {@render statRow("Targeting range", stats.targeting.maxTargetRange, asDistance)}
            {@render statRow("Targets at once", stats.targeting.maxLockedTargets, whole)}
            {@render statRow("Scan resolution", stats.targeting.scanResolution, (v) => `${toFixed(v, 1)} mm`)}
            {@render statRow(
              stats.targeting.sensorName
                ? `${stats.targeting.sensorName} sensor strength`
                : "Sensor strength",
              stats.targeting.sensorStrength,
              (v) => toFixed(v, 1),
            )}
          </tbody>
        </table>
      </div>
      {/if}
    </details>

    <details class="fit-sec" open={!retail}>
      <summary class="fit-sec-head">
        <span class="fit-sec-name">Navigation</span>
        {#if stats.defense || retail}
          <span class="fit-sec-headline">{knownWord(stats.navigation.maxVelocity, (v) => shipWord("UI/Fitting/FittingWindow/ColoredMaxVelocity", { maxVelocity: v }))}</span>
        {:else}
          <span class="fit-sec-headline">{@render statValue(stats.navigation.maxVelocity, (v) => `${toFixed(v, 1)} m/s`)}</span>
        {/if}
      </summary>
      {#if clientNavigation}
        <div class="fit-sec-body fit-attr-grid">{@render clientAttributeCells(clientNavigation)}</div>
      {:else if stats.defense}
        <!-- navigationPanel.UpdateNavigationPanel: the mass in tonnes past ten thousand kilograms, the inertia modifier,
             the align time, the warp speed as a distance a second (base times multiplier times an AU). -->
        <div class="fit-sec-body">
          <table class="guests">
            <tbody>
              <tr>
                <th scope="row">Mass</th>
                <td>{knownWord(stats.navigation.mass, (v) => (v > 10000.0
                  ? shipWord("UI/Fitting/FittingWindow/MassTonnes", { mass: v / 1000.0 })
                  : shipWord("UI/Fitting/FittingWindow/MassKg", { mass: v })))}</td>
              </tr>
              <tr><th scope="row">Inertia modifier</th><td>{knownWord(stats.navigation.inertiaModifier, (v) => shipWord("UI/Fitting/FittingWindow/InertiaModifier", { value: v }))}</td></tr>
              <tr><th scope="row">Time to align</th><td>{knownWord(stats.navigation.alignTimeSeconds, (v) => shipWord("UI/Fitting/FittingWindow/AlignTime", { value: v }))}</td></tr>
              <tr><th scope="row">Warp speed</th><td>{knownWord(stats.navigation.warpSpeedAuPerSecond, (v) => shipWord("UI/Fitting/FittingWindow/WarpSpeed", { distText: fmtDist(v * METRES_PER_AU, 2, say) }))}</td></tr>
            </tbody>
          </table>
        </div>
      {:else}
      <div class="fit-sec-body">
        <table class="guests">
          <tbody>
            {@render statRow("Top speed", stats.navigation.maxVelocity, (v) => `${toFixed(v, 1)} m/s`)}
            {@render statRow("Time to align", stats.navigation.alignTimeSeconds, asSeconds)}
            {@render statRow("Warp speed", stats.navigation.warpSpeedAuPerSecond, (v) => `${toFixed(v, 2)} AU/s`)}
            {@render statRow("Signature radius", stats.navigation.signatureRadius, (v) => `${whole(v)} m`)}
            {@render statRow("Mass", stats.navigation.mass, (v) => `${whole(v)} kg`)}
          </tbody>
        </table>
      </div>
      {/if}
    </details>

    {#if simulation?.structure}
      <!-- A structure's fighter panel in the drones' place (statsPanel.GetMenuData: the drones' panel where the
           controller has one, else the fighters'; fighterPanel.UpdateFighterStats and SetFighterDpsText): the squadrons
           in the tubes' damage a second, how many are full and how many short of full. -->
      <details class="fit-sec" open={!retail}>
        <summary class="fit-sec-head">
          <span class="fit-sec-name">{offenseWord("UI/Common/Fighters")}</span>
          <span class="fit-sec-headline">{offenseWord("UI/Fitting/FittingWindow/DpsLabel", { dps: simulation.fighterDps })}</span>
        </summary>
        <div class="fit-sec-body">
          <p class="note">{offenseWord("UI/Fitting/FittingWindow/NumFullSquadrons", { numSquadrons: simulation.fighterSquadrons.full })}</p>
          <p class="note">{offenseWord("UI/Fitting/FittingWindow/NumPartialSquadrons", { numSquadrons: simulation.fighterSquadrons.partial })}</p>
        </div>
      </details>
    {:else}
    <details class="fit-sec" open={!retail} bind:this={dronesSection}>
      <summary class="fit-sec-head">
        <span class="fit-sec-name">Drones</span>
        {#if clientDrones}
          <span class="fit-sec-headline">{clientDrones.header}</span>
        {:else if stats.drones}
          <!-- dronePanel.SetDroneDpsText: the active drones' damage a second. -->
          <span class="fit-sec-headline">{offenseWord("UI/Fitting/FittingWindow/DpsLabel", { dps: stats.drones.dps })}</span>
        {:else}
          <span class="fit-sec-headline">{@render statValue(stats.firepower.droneDps, (v) => `${whole(v)} dps`)}</span>
        {/if}
      </summary>
      {#if clientDrones}
        <div class="fit-sec-body fit-attr-grid">
          {@render clientAttributeCells(clientDrones.cells)}
          <div class="fit-attr fit-attr-plain"><span>{clientDrones.active}</span></div>
          <div class="fit-attr fit-attr-plain">
            <button type="button" class="fit-ghost-button" disabled={!showInventory && !simulation} onclick={() => showInventory?.()}>{offenseWord("UI/Fitting/FittingWindow/ManageDrones")}</button>
          </div>
        </div>
      {/if}
      <div class="fit-sec-body" class:hidden-by-client={!!clientDrones}>
        <table class="guests">
          <tbody>
            {#if stats.drones}
              <!-- dronePanel.UpdateDroneStats: how many are active, the bandwidth they use of the ship's (FmtAmt of
                   the used, the ship's as its attribute is shown), the pilot's control range. -->
              <tr><th scope="row">Active drones</th><td>{offenseWord("UI/Fitting/FittingWindow/NumDronesActive", { numDrones: stats.drones.activeDrones })}</td></tr>
              <tr>
                <th scope="row">Bandwidth</th>
                <td>{Math.round(stats.drones.bandwidthUsed).toLocaleString()}/{knownWord(stats.bays.droneBandwidth, (v) => `${toFixed(v, 0)} Mbit/s`)}</td>
              </tr>
            {:else}
              {@render statRow("Bandwidth", stats.bays.droneBandwidth, (v) => `${toFixed(v, 0)} Mbit/s`)}
            {/if}
            {@render statRow("Control range", stats.bays.droneControlRange, asDistance)}
            {@render statRow("Drone bay", stats.bays.droneCapacity, asVolume)}
          </tbody>
        </table>
        {#if simulation}
          <!-- The simulated drone bay (dronePickerMenu): each type, how many of it are active of how many, and both
               changed a drone at a time. -->
          {#if simulation.drones.length === 0}
            <p class="note">No drones in the simulated drone bay. Pick up drones from the hangar to add them.</p>
          {:else}
            <ul class="fit-sim-drones">
              {#each simulation.drones as entry (entry.typeID)}
                {@const mark = pickerWarningColor(87, entry.typeID)}
                <li oncontextmenu={(event) => openTypeMenu(entry.typeID, event)}>
                  {#if mark}<span class="fit-picker-warning" style={`--warning-color: ${mark}; --warning-icon: url("${PICKER_WARNING_ICON}")`} aria-hidden="true"></span>{/if}
                  <span class="fit-sim-drone-name">{moduleName(entry.typeID)}</span>
                  <span class="fit-sim-drone-count">{entry.active} of {entry.total} active</span>
                  <span class="row-actions">
                    <button type="button" class="minor" disabled={busy || entry.active === 0} onclick={() => setActiveDrones(entry.typeID, entry.active - 1)}>Fewer active</button>
                    <button type="button" class="minor" disabled={busy || entry.active === entry.total} onclick={() => setActiveDrones(entry.typeID, entry.active + 1)}>More active</button>
                    <button type="button" class="minor" disabled={busy} onclick={() => setDrones(entry.typeID, entry.total - 1)}>One fewer</button>
                    <button type="button" class="minor" disabled={busy} onclick={() => setDrones(entry.typeID, entry.total + 1)}>One more</button>
                  </span>
                </li>
              {/each}
            </ul>
          {/if}
        {:else if showInventory}
          <p class="controls">
            <button type="button" class="minor" onclick={() => showInventory?.()}>
              Manage drones
            </button>
          </p>
        {/if}
        <p class="note">
          Drones are launched and flown from the Overview in space; the bay
          itself is on the Inventory &amp; Ship page.
        </p>
      </div>
    </details>
    {/if}
    {#if fitPrice !== null}
    <!-- LabelPriceLabelCont: TOBOTTOM 40 high in the stats panel, the price (EveLabelLarge) bottom right 30 in, the
         multibuy button (24) 4 in. -->
    <div class="fit-price" title={capacitorWord("UI/Fitting/FittingWindow/TotalEstimatedPrice")}>
      <span>{fitPrice}</span>
      <img alt="" src="/client-res/ui/texture/classes/multisell/multibuy.png" />
    </div>
  {/if}
  </div>
{/snippet}

<!-- The bottom read-out strip: CPU + powergrid bars, calibration, the bays and
     the fit's value. Every number is the server's; the ones with no allowed
     read say "Unavailable". -->
{#snippet fitFooter()}
  <div class="fit-footer">
    <div class="fit-bars">
      <div class="hud-gauge cpu" class:warning={slotWarningColor(FLAG_CPU_GAUGE) !== null} style={slotWarningColor(FLAG_CPU_GAUGE) ? `--slot-warning: ${slotWarningColor(FLAG_CPU_GAUGE)}` : undefined}>
        <div class="hud-head">
          <span class="hud-label">CPU</span>
          <span class="hud-value">{resourceText(resources.cpu, "tf")}</span>
        </div>
        <div
          class="hud-track"
          role="meter"
          aria-label="CPU"
          aria-valuenow={percent(resources.cpu) ?? 0}
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <span class="hud-fill" style={`width: ${percent(resources.cpu) ?? 0}%`}></span>
        </div>
      </div>
      <div class="hud-gauge powergrid" class:warning={slotWarningColor(FLAG_POWERGRID_GAUGE) !== null} style={slotWarningColor(FLAG_POWERGRID_GAUGE) ? `--slot-warning: ${slotWarningColor(FLAG_POWERGRID_GAUGE)}` : undefined}>
        <div class="hud-head">
          <span class="hud-label">Power grid</span>
          <span class="hud-value">{resourceText(resources.powergrid, "MW")}</span>
        </div>
        <div
          class="hud-track"
          role="meter"
          aria-label="Power grid"
          aria-valuenow={percent(resources.powergrid) ?? 0}
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <span class="hud-fill" style={`width: ${percent(resources.powergrid) ?? 0}%`}></span>
        </div>
      </div>
    </div>
    <dl class="fit-readouts">
      <div>
        <dt>Calibration</dt>
        <dd>{resourceText(resources.calibration, "")}</dd>
      </div>
      <div class:fit-readout-warning={slotWarningColor(5) !== null} style={slotWarningColor(5) ? `--slot-warning: ${slotWarningColor(5)}` : undefined}>
        <dt>Cargo hold</dt>
        {#if simulation}
          <!-- The simulated hold's use and capacity (GetSimulatedCapacity: the fitting location's GetCapacity). -->
          <dd><button type="button" class="minor fit-sim-cargo-open" aria-expanded={simCargoOpen} disabled={busy} onclick={clickSimulatedCargo}
            ondragover={overSimulatedHold} ondrop={dropOnSimulatedCargo}>
            {holdReadout(simulation.holdUse.cargo, stats.bays.cargoCapacity.known ? stats.bays.cargoCapacity.value : simulation.cargoCapacity.capacity)}</button></dd>
        {:else}
          <!-- OnHoldClicked: the ship's cargo hold in the inventory (OpenCargoHoldOfActiveShip); a drop from the inventory
               moved into it. -->
          <dd><button type="button" class="minor fit-hold-open" onclick={() => openShipHold("cargo")}
            ondragover={overSimulatedHold} ondrop={(event) => dropOnRealHold(event, { kind: "cargo" })}>{cargoBayText}</button></dd>
        {/if}
      </div>
      {#if simulation?.fighterBay}
        <!-- The simulated fighter bay (minihangar CargoFighterSlots) in the drone bay's place, where the hull has one
             (ContructDroneAndFighterIcons: HasFighterBay): its use and capacity (GetCapacity(flagFighterBay)); a click
             shows its picker, a picked fighter put on it goes to a tube or the bay. -->
        <div class:fit-readout-warning={fighterBayWarningColor() !== null} style={fighterBayWarningColor() ? `--slot-warning: ${fighterBayWarningColor()}` : undefined}>
          <dt>{offenseWord("UI/Fitting/FittingWindow/FighterBay")}</dt>
          <dd><button type="button" class="minor fit-sim-fighters-open" aria-expanded={simFightersOpen} disabled={busy} onclick={clickSimulatedFighterBay}
            ondragover={overSimulatedHold} ondrop={dropOnSimulatedFighterBay}>
            {holdReadout(simulation.holdUse.fighter, simulation.fighterBay.capacity)}</button></dd>
        </div>
      {:else if simulation}
        <!-- The simulated drone bay (minihangar CargoDroneSlots): its use (GetSimulatedCapacity: each drone's volume) over
             GetDroneCapacity; a picked drone put on it goes in the bay, a click shows its drones. -->
        <div>
          <dt>Drone bay</dt>
          <dd><button type="button" class="minor fit-sim-drones-open" disabled={busy} onclick={clickSimulatedDroneBay}
            ondragover={overSimulatedHold} ondrop={dropOnSimulatedDroneBay}>
            {holdReadout(simulation.holdUse.drone, stats.bays.droneCapacity.known ? stats.bays.droneCapacity.value : 0)}</button></dd>
        </div>
      {:else if realBayReadout}
        <!-- The ship's own fighter bay, or its drone bay where it has none (CargoFighterSlots, CargoDroneSlots): its
             inventory's use over GetFighterCapacity or GetDroneCapacity. -->
        {@const frame = realBayReadout.kind === "fighter" ? fighterBayWarningColor() : null}
        <div class:fit-readout-warning={frame !== null} style={frame ? `--slot-warning: ${frame}` : undefined}>
          <dt>{realBayReadout.kind === "fighter" ? offenseWord("UI/Fitting/FittingWindow/FighterBay") : "Drone bay"}</dt>
          <!-- OnHoldClicked: the bay in the inventory (OpenFighterBayOfActiveShip, OpenDroneBayOfActiveShip). -->
          <dd><button type="button" class="minor fit-hold-open" onclick={() => openShipHold(realBayReadout.kind)}
            ondragover={overSimulatedHold} ondrop={(event) => dropOnRealHold(event, { kind: "shipBay", bay: realBayReadout.kind })}>
            {holdReadout(sentNumber(realBayReadout.used), realBayReadout.capacity)}</button></dd>
        </div>
      {:else}
        <div>
          <dt>Drone bay</dt>
          <dd><button type="button" class="minor fit-hold-open" onclick={() => openShipHold("drone")}
            ondragover={overSimulatedHold} ondrop={(event) => dropOnRealHold(event, { kind: "shipBay", bay: "drone" })}>{@render statValue(stats.bays.droneCapacity, asVolume)}</button></dd>
        </div>
      {/if}
      <div class="fit-readout-value">
        <dt>Fit value</dt>
        <dd>{@render statValue(fitValue, whole)}</dd>
      </div>
    </dl>
    {#if simulation && simCargoOpen}
      <!-- CargoItemPickerMenu: each type by its name, how many (its count edited, from none to what the room left allows:
           UpdateNodes' intRange), taken out; Remove All. -->
      <div class="fit-sim-cargo">
        {#if simulation.cargo.length === 0}
          <p class="note">{simulationWord("UI/Fitting/FittingWindow/NoCargoItemsSimulated")}</p>
        {:else}
          <ul class="fit-sim-drones">
            {#each cargoByName(simulation.cargo) as entry (entry.typeID)}
              {@const mark = pickerWarningColor(5, entry.typeID)}
              <li oncontextmenu={(event) => openTypeMenu(entry.typeID, event)}>
                {#if mark}<span class="fit-picker-warning" style={`--warning-color: ${mark}; --warning-icon: url("${PICKER_WARNING_ICON}")`} aria-hidden="true"></span>{/if}
                <span class="fit-sim-drone-name">{moduleName(entry.typeID)}</span>
                <input class="fit-sim-cargo-count" type="number" min="0" max={entry.most} value={entry.quantity} disabled={busy}
                  title={simulationWord("UI/Fitting/FittingWindow/ClickToEdit")} aria-label={`${moduleName(entry.typeID)}: ${simulationWord("UI/Fitting/FittingWindow/ClickToEdit")}`}
                  onchange={(event) => setSimulatedCargo(entry.typeID, Number(event.currentTarget.value))} />
                <button type="button" class="minor" disabled={busy} title={simulationWord("UI/Generic/RemoveItem")} aria-label={simulationWord("UI/Generic/RemoveItem")}
                  onclick={() => setSimulatedCargo(entry.typeID, 0)}>✕</button>
              </li>
            {/each}
          </ul>
          <p class="controls">
            <button type="button" class="minor" disabled={busy} onclick={() => flow.emptySimulatedCargo()}>{simulationWord("UI/Fitting/FittingWindow/RemoveAll")}</button>
          </p>
        {/if}
      </div>
    {/if}
    {#if simulation?.fighterBay && simFightersOpen}
      <!-- FighterBayItemPickerMenu: each kind's squadrons allowed and had (fightersAllowedCont; a kind the ship takes none
           of not shown); the five tubes (SingleTube, one past the ship's disabled): the tube's number, its squadron (its
           icon, its role's, a dash for each it may hold, lit as many as it has; taken out, one fewer, one more) or Open,
           a fighter put in it a full squadron; the bay's types by name as the cargo's, double-clicked into the first empty
           tube; Remove All, where the bay or a tube holds any. -->
      <div class="fit-sim-fighters">
        <p class="fit-sim-squadron-slots">
          {#each FIGHTER_CLASSES as fighterKind (fighterKind.kind)}
            {#if simulation.squadronSlots[fighterKind.kind].total}
              <span class="fit-sim-squadron-slot" title={simulationWord(fighterKind.label)}>
                <img src={fighterKind.icon} alt={simulationWord(fighterKind.label)} width="16" height="16" />:{simulation.squadronSlots[fighterKind.kind].used}/{simulation.squadronSlots[fighterKind.kind].total}
              </span>
            {/if}
          {/each}
        </p>
        <ol class="fit-sim-tubes">
          {#each simulation.fighterTubes as tube (tube.flagID)}
            <li class="fit-sim-tube" class:disabled={!tube.present}>
              <button type="button" class="fit-sim-tube-slot" data-tube-flag={tube.flagID} disabled={busy || !tube.present}
                title={tube.squadron
                  ? simulationWord("UI/Inventory/Fighters/SquadronHint", { typeName: moduleName(tube.squadron.typeID), numFighters: tube.squadron.size })
                  : simulationWord("UI/Inventory/Fighters/EmptyLaunchTube")}
                draggable={tube.squadron !== null}
                ondragstart={(event) => { if (tube.squadron) startFighterDrag(event, { from: "tube", flagID: tube.flagID, typeID: tube.squadron.typeID }); }}
                ondragend={() => (fighterDrag = null)}
                ondragover={(event) => { if (fighterDrag) event.preventDefault(); }}
                ondrop={(event) => dropOnTube(event, tube)}
                oncontextmenu={(event) => (tube.squadron ? openTypeMenu(tube.squadron.typeID, event) : event.preventDefault())}
                onclick={() => clickSimulatedTube(tube)}>
                <span class="fit-sim-tube-number">{tube.number}</span>
                {#if tube.squadron}
                  {@const mark = tubeWarningColor(tube.flagID, tube.squadron.typeID)}
                  {#if mark}<span class="fit-picker-warning" style={`--warning-color: ${mark}; --warning-icon: url("${PICKER_WARNING_ICON}")`} aria-hidden="true"></span>{/if}
                  <TypeIcon typeID={tube.squadron.typeID} name={moduleName(tube.squadron.typeID)} size="md" />
                  {#if FIGHTER_ROLES[tube.squadron.role]?.icon}
                    <img class="fit-sim-tube-role" src={FIGHTER_ROLES[tube.squadron.role]?.icon} width="16" height="16"
                      alt={simulationWord(FIGHTER_ROLES[tube.squadron.role]?.hint ?? "")} title={simulationWord(FIGHTER_ROLES[tube.squadron.role]?.hint ?? "")} />
                  {/if}
                  <span class="fit-sim-tube-dashes" aria-hidden="true">
                    {#each Array.from({ length: tube.squadron.max }, (_, at) => at < (tube.squadron?.size ?? 0)) as lit, at (at)}
                      <span class={lit ? "lit" : ""}></span>
                    {/each}
                  </span>
                  <span class="fit-sim-tube-action">{simulationWord("UI/Fitting/FittingWindow/FightersSimulated")}</span>
                {:else}
                  <span class="fit-sim-tube-action">{tube.present ? simulationWord("UI/Inventory/Fighters/Open") : ""}</span>
                {/if}
              </button>
              {#if tube.squadron && tube.present}
                <span class="row-actions">
                  <button type="button" class="minor" disabled={busy} aria-label={simulationWord("UI/Generic/RemoveItem")} title={simulationWord("UI/Generic/RemoveItem")}
                    onclick={() => flow.removeSimulatedSquadron(tube.flagID)}>✕</button>
                  <button type="button" class="minor" disabled={busy} aria-label="One fewer"
                    onclick={() => tube.squadron && void run(() => flow.setSimulatedSquadronSize(tube.flagID, Math.max(0, (tube.squadron?.size ?? 0) - 1)))}>−</button>
                  <button type="button" class="minor" disabled={busy} aria-label="One more"
                    onclick={() => tube.squadron && void run(() => flow.setSimulatedSquadronSize(tube.flagID, (tube.squadron?.size ?? 0) + 1))}>+</button>
                </span>
              {/if}
            </li>
          {/each}
        </ol>
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
        <div class="fit-sim-fighter-bay" role="group" aria-label={offenseWord("UI/Fitting/FittingWindow/FighterBay")}
          ondragover={(event) => { if (fighterDrag?.from === "tube" || carriesOurPayload(event.dataTransfer?.types as string[] | undefined)) event.preventDefault(); }}
          ondrop={dropOnFighterBayList}
          onclick={clickFighterBayList}>
          {#if simulation.fighterBayTypes.length === 0}
            <p class="note">{simulationWord("UI/Fitting/FittingWindow/NoFightersSimulated")}</p>
          {:else}
            <ul class="fit-sim-drones">
              {#each cargoByName(simulation.fighterBayTypes) as entry (entry.typeID)}
                {@const mark = pickerWarningColor(158, entry.typeID)}
                <li oncontextmenu={(event) => openTypeMenu(entry.typeID, event)}>
                  {#if mark}<span class="fit-picker-warning" style={`--warning-color: ${mark}; --warning-icon: url("${PICKER_WARNING_ICON}")`} aria-hidden="true"></span>{/if}
                  <button type="button" class="fit-sim-drone-name fit-sim-fighter-name" draggable="true" disabled={busy}
                    ondragstart={(event) => startFighterDrag(event, { from: "bay", typeID: entry.typeID })}
                    ondragend={() => (fighterDrag = null)}
                    ondblclick={() => void run(() => flow.fitSimulatedFighterToEmptyTube(entry.typeID))}>{moduleName(entry.typeID)}</button>
                  <input class="fit-sim-cargo-count" type="number" min="0" max={entry.most} value={entry.quantity} disabled={busy}
                    title={simulationWord("UI/Fitting/FittingWindow/ClickToEdit")} aria-label={`${moduleName(entry.typeID)}: ${simulationWord("UI/Fitting/FittingWindow/ClickToEdit")}`}
                    onchange={(event) => setSimulatedFighterBay(entry.typeID, Number(event.currentTarget.value))} />
                  <button type="button" class="minor" disabled={busy} title={simulationWord("UI/Generic/RemoveItem")} aria-label={simulationWord("UI/Generic/RemoveItem")}
                    onclick={(event) => { event.stopPropagation(); flow.removeSimulatedFighterBayType(entry.typeID); }}>✕</button>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
        {#if simulation.fighterBayTypes.length > 0 || simulation.fighterTubes.some((tube) => tube.squadron !== null)}
          <p class="controls">
            <button type="button" class="minor" disabled={busy} onclick={() => flow.emptySimulatedFighterBay()}>{simulationWord("UI/Fitting/FittingWindow/RemoveAll")}</button>
          </p>
        {/if}
      </div>
    {/if}
  </div>
{/snippet}

<!-- ============================ the window ============================== -->

<section class="panel">
  <header class="panel-head">
    <h2 class="panel-title">Fitting</h2>
    <!-- ⚠ THE SHIP LEAVES THE TITLE RATHER THAN GOING WITH IT. It used to be a
         `<small>` inside the heading, and a host that already says FITTING
         clips the heading — which would have taken the name of the hull you are
         actually looking at with it. Which ship this is, is the one thing on
         this strip worth reading. -->
    <p class="stat-line">
      {activeShipName}{activeShipClass ? ` · ${activeShipClass}` : ""}
    </p>
    <p class="controls">
      <span class="fit-views">
        <button
          type="button"
          class={view === "radial" ? "active" : "minor"}
          aria-pressed={view === "radial"}
          onclick={() => chooseView("radial")}
        >
          Ship view
        </button>
        <button
          type="button"
          class={view === "list" ? "active" : "minor"}
          aria-pressed={view === "list"}
          onclick={() => chooseView("list")}
        >
          List view
        </button>
      </span>
      <button type="button" class="primary" disabled={busy} onclick={() => run(refresh)}>
        Refresh
      </button>
    </p>
  </header>
  {#if error}
    <p class="error">{error}</p>
  {/if}
  <!-- (A refusal the client's own dialog said is not said again here: ClientDialogs.svelte.) -->
  {#if $fitting.actionError && !$fitting.actionErrorSaid}
    <p class="error">Last change failed: {$fitting.actionError}</p>
  {/if}
  {#if simulationErrorText}
    <p class="error" role="alert">{simulationErrorText}</p>
  {/if}
  {#if simulation && fitFeedback}
    <p class="note fit-feedback" role="status">{fitFeedback}</p>
  {/if}
  {#if $fitting.resourcesError}
    <p class="error">The ship's readings could not be loaded: {$fitting.resourcesError}</p>
  {/if}
  {#if !$fitting.activeShipID}
    <p class="note">
      No active ship — board a ship on the Inventory &amp; Ship page to fit it.
    </p>
  {/if}
</section>

{#if $fitting.activeShipID}
  {#if $fitting.slotsError}
    <section>
      <p class="error">The ship's slots could not be loaded: {$fitting.slotsError}</p>
    </section>
  {/if}

  {#if view === "radial"}
    <!-- ===================== EVE's fitting stage ======================= -->
    <section class="panel fit-window">
      <div class="fit-stage">
        <!-- The slim left toolbar: Fitting (current) and Cargo. -->
        <nav class="fit-toolbar" aria-label="Fitting window views">
          <button type="button" class="fit-tool active" aria-pressed="true" title="Fitting"
            onclick={() => chooseView("radial")} aria-label="Fitting">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L3 17.8 6.2 21l6.3-6.3a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.2-2.2 2.6-2.4z" />
            </svg>
          </button>
          <button type="button" class="fit-tool" title="Cargo — open the Inventory & Ship page"
            aria-label="Cargo"
            disabled={!showInventory}
            onclick={() => showInventory?.()}>
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 8l9-5 9 5v8l-9 5-9-5V8z" /><path d="M3 8l9 5 9-5" /><path d="M12 13v8" />
            </svg>
          </button>
        </nav>

        <!-- The ring, its detail, and the bottom read-outs. -->
        <div class="fit-center">
          <div class="fit-topline">
            <TypeIcon typeID={activeShipTypeID} name={activeShipName} size="sm" />
            <!-- The fit-name label (fittingWnd fitNameParent, 415 to 425): its link icon and name, a click that saves the
                 fitting as it stands (OpenFittingForCurrentShip: DoSaveFitting), dragged the fitting the window shows
                 (GetFittingDragData), its tooltip the name and ShipName_description. -->
            <button type="button" class="fit-ship-name fit-name-link" draggable="true" disabled={busy}
              title={`${fitName}\n${simulationWord("Tooltips/FittingWindow/ShipName_description")}`}
              ondragstart={(event) => startFittingSourceDrag(event, "fittingWindow")}
              onclick={() => void flow.saveFitAs().catch(() => {})}><img src={HYPERLINK_ICON} alt="" width="16" height="16" />{fitName}</button>
            {#if warningIcons.length > 0 || (fitSkillWarning?.count ?? 0) > 0}
              <!-- WarningIconCont: the red, yellow and white icons, each with how many warnings it has; its tooltip
                   (LoadWarningTooltipPanel: EvaluateFitAndPopulateTooltip) the level's header and each warning's line
                   (its icon, its line, its hint behind "?") with its rows under it; a line or row pointed at shows its
                   slots with the warning (OnMouseEnterContainer), the tooltip open all of the level's. -->
              <div class="fit-warnings" role="group" aria-label="Fitting warnings" onmouseleave={closeWarningTooltip}>
                {#each warningIcons as icon (icon.level)}
                  <button type="button" class="fit-warning-icon" style={`--warning-color: ${COLOR_BY_LEVEL[icon.level]}; --warning-icon: url("${WARNING_GROUP_ICON}")`}
                    aria-expanded={warningTooltipLevel === icon.level}
                    aria-label={`${simulationWord(HEADER_BY_LEVEL[icon.level] ?? "")}: ${icon.count}`}
                    onmouseenter={() => openWarningTooltip(icon.level)}
                    onfocus={() => openWarningTooltip(icon.level)}
                    onclick={() => (warningTooltipLevel === icon.level ? closeWarningTooltip() : openWarningTooltip(icon.level))}>
                    <span class="fit-warning-glyph" aria-hidden="true"></span><span class="fit-warning-count">{icon.count}</span>
                  </button>
                {/each}
                {#if fitSkillWarning && fitSkillWarning.count > 0}
                  <!-- SkillWarningIcon: its tooltip (LoadSkillTooltip, GetSkillTooltip) the skills the ship and fit
                       miss under Skills Required (Ship and Fit where the cargo's miss some too), the cargo's under
                       Cargo Hold, each at the highest level needed with its mark and skill bar (RequiredSkillRow). -->
                  {#if warningIcons.length >= 3}<span class="fit-warning-break" aria-hidden="true"></span>{/if}
                  <button type="button" class="fit-warning-icon" style={`--warning-color: ${COLOR_BY_LEVEL[WARNING_LEVEL_SKILL]}; --warning-icon: url("${SKILL_WARNING_ICON}")`}
                    aria-expanded={skillTooltipOpen}
                    aria-label={`${simulationWord(HEADER_BY_LEVEL[WARNING_LEVEL_SKILL] ?? "")}: ${fitSkillWarning.count}`}
                    onmouseenter={openSkillTooltip}
                    onfocus={openSkillTooltip}
                    onclick={() => (skillTooltipOpen ? closeSkillTooltip() : openSkillTooltip())}>
                    <span class="fit-warning-glyph" aria-hidden="true"></span><span class="fit-warning-count">{fitSkillWarning.count}</span>
                  </button>
                {/if}
                {#if skillTooltipOpen && fitSkillWarning && (fitSkillWarning.fit.length > 0 || fitSkillWarning.cargo.length > 0)}
                  {@const skills = fitSkillWarning}
                  <div class="fit-warning-tooltip fit-skill-tooltip" role="tooltip">
                    {#if skills.fit.length > 0}
                      <h3 class="fit-skill-header">{simulationWord("UI/Skills/RequiredSkills")}</h3>
                      {#if skills.shipAndFitHeading}<h4 class="fit-skill-section">{simulationWord("UI/Fitting/FittingWindow/Warnings/ShipAndFit")}</h4>{/if}
                      <ul class="fit-skill-rows">
                        {#each bySkillName(skills.fit) as [skill, level] (skill)}
                          {@const row = skillRows.get(`${skill}:${level}`) ?? null}
                          <RequiredSkillRow {skill} {level} mark={row?.mark ?? null} boxes={row?.boxes ?? []} word={simulationWord} />
                        {/each}
                      </ul>
                    {/if}
                    {#if skills.cargo.length > 0}
                      <h4 class="fit-skill-section" class:cargo-alone={skills.fit.length === 0}>{simulationWord("UI/Fitting/FittingWindow/Warnings/CargoHold")}</h4>
                      <ul class="fit-skill-rows">
                        {#each bySkillName(skills.cargo) as [skill, level] (skill)}
                          {@const row = skillRows.get(`${skill}:${level}`) ?? null}
                          <RequiredSkillRow {skill} {level} mark={row?.mark ?? null} boxes={row?.boxes ?? []} word={simulationWord} />
                        {/each}
                      </ul>
                    {/if}
                    {#if skillTraining !== null}
                      <!-- AddTrainingTime (the fitted ship's activity) and AddSkillActionForList: the time to train the
                           list, the points, Train Skills or Buy and Train, shown however the clone stands. -->
                      {@const training = skillTraining}
                      <div class="fit-skill-training">
                        <SkillTrainingAction record={training} activity="Tooltips/SkillPlanner/ActivityFlyFittedShip" word={simulationWord}
                          timeText={(ticks) => trainingTimeText(ticks, $words.templates, simulationWord("Tooltips/SkillPlanner/TrainingComplete"))}
                          apply={applyPointsButton(training, simulationWord, () => void flow.applySkillPointsFor(training).catch(() => {}), closeSkillTooltip)}
                          onTrain={() => void flow.trainSkillsFor(training).catch(() => {})}
                          onBuy={() => void flow.buySkillsFor(training).catch(() => {})}
                          plan={createSkillPlanButton({
                            kind: "list",
                            requirements: skills.listed,
                            name: fitName ? simulationWord("Tooltips/SkillPlanner/SkillPlanNameStringWithType", { typeName: fitName }) : simulationWord("UI/SkillPlan/DefaultCreateFitSkillPlanName"),
                          }, skillPlanCount, simulationWord)} />
                      </div>
                    {/if}
                  </div>
                {/if}
                {#if warningTooltipLevel !== null && tooltipWarnings.length > 0}
                  {@const level = warningTooltipLevel}
                  <div class="fit-warning-tooltip" role="tooltip" style={`--warning-color: ${COLOR_BY_LEVEL[level]}`}>
                    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                    <h3 class="fit-warning-header" onmouseenter={() => (warningSlots = levelSlots(level))} onmouseleave={() => (warningSlots = new Map())}>
                      {simulationWord(HEADER_BY_LEVEL[level] ?? "")}</h3>
                    <ul class="fit-warning-lines">
                      {#each tooltipWarnings as warning (warning.warningID)}
                        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                        <li class="fit-warning-line" title={warningHint(warning.warningID)}
                          onmouseenter={() => showWarningSlots(warning.flags, warning.level)} onmouseleave={() => (warningSlots = new Map())}>
                          <span class="fit-warning-line-icon" style={`--warning-icon: url("${WARNING_LINE_ICON}")`} aria-hidden="true"></span>
                          <b>{simulationWord(WARNINGS_BY_ID[warning.warningID]?.short ?? "")}</b>
                          <span class="fit-warning-question" aria-hidden="true">?</span>
                        </li>
                        {#each warningRows(warning.rows) as row, at (at)}
                          {@const flags = row.kind === "module" || row.kind === "subsystem" ? [row.flagID] : row.flags}
                          {@const attributeIcon = row.kind === "attribute" ? warningAttributes.get(row.attributeID)?.iconFile ?? null : null}
                          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                          <li class="fit-warning-row" onmouseenter={() => (row.kind === "subsystem" ? undefined : showWarningSlots(flags, warning.level))}
                            onmouseleave={() => (row.kind === "subsystem" ? undefined : (warningSlots = new Map()))}>
                            {#if row.kind === "module"}
                              <TypeIcon typeID={row.typeID} name={moduleName(row.typeID)} size="sm" />
                              <span>{moduleName(row.typeID)}</span>
                            {:else if row.kind === "size"}
                              {#if row.icon}<img src={clientTexture(row.icon)} alt="" width="20" height="20" />{/if}
                              <span>{simulationWord(SIZE_LABELS[row.size] ?? "")}</span>
                            {:else if row.kind === "attribute"}
                              {#if attributeIcon}<img src={clientTexture(attributeIcon)} alt="" width="20" height="20" />{/if}
                              <div class="fit-warning-attribute"><LabelText markup={attributeRowText(row)} /></div>
                            {:else}
                              {#if row.icon}<img src={clientTexture(row.icon)} alt="" width="20" height="20" />{/if}
                              <span>{resolvedName($names.resolved, "group", row.groupID)}</span>
                            {/if}
                          </li>
                        {/each}
                      {/each}
                    </ul>
                  </div>
                {/if}
              </div>
            {/if}
            {#if activeShipClass}<span class="fit-ship-class">{activeShipClass}</span>{/if}
            <span class="fit-info" title={`${activeShipName}${activeShipClass ? ` · ${activeShipClass}` : ""}`}
              aria-label={`Ship: ${activeShipName}${activeShipClass ? `, ${activeShipClass}` : ""}`}>ⓘ</span>
          </div>

          <p class="note fit-hint">
            {#if pickedItemID}
              Choose an empty slot to fit {pickedName} there.
            {:else}
              Choose a slot to see what is in it and what you can do with it.
            {/if}
          </p>

          <div class="fit-ring-wrap overflow-x-auto">
            <div class="fit-ring" class:retail style={retail ? `--slot-w: ${(CLIENT_SLOT_WIDTH / CLIENT_BASE) * 100}%; --slot-h: ${(CLIENT_SLOT_HEIGHT / CLIENT_BASE) * 100}%` : ""}>
              {#if retail}
                {#if shipSceneOf}<div class="fit-ship-scene" use:shipScene={{ typeID: ringTypeID, fits: shipTurretFits }}></div>{/if}
                <!-- fittingLayout.py's base, bottom up: fittingbase (black 0.86), fittingbase_basecircle (the theme's UI
                     base colour), [fittingbase_dotproduct - a DOT-lit sprite - and the three gauges], fittingbase_overlay
                     (white 0.39) -->
                <div class="fit-base" aria-hidden="true" style="--tex: url('/client-res/ui/texture/classes/fitting/fittingbase.png'); --tint: rgba(0,0,0,0.86)"></div>
                <div class="fit-base" aria-hidden="true" style="--tex: url('/client-res/ui/texture/classes/fitting/fittingbase_basecircle.png'); --tint: #060a0c"></div>
                <!-- the CPU / power grid / calibration gauges (fittingLayout.py BaseFittingGauge: the load over the output,
                     at most 1, along the gauge's arc; over it the gauge fades 0.25 -> 1 every half second) -->
                <svg class="fit-gauges" viewBox="0 0 640 640" aria-hidden="true">
                  {#each ["calibration", "power", "cpu"] as const as gauge (gauge)}
                    {@const resource = gauge === "cpu" ? resources.cpu : gauge === "power" ? resources.powergrid : resources.calibration}
                    {@const load = resource.known && resource.total > 0 ? resource.used / resource.total : 0}
                    <path
                      class="fit-gauge"
                      class:over={load > 1}
                      data-gauge={gauge}
                      d={clientGaugePath(gauge as ClientGauge)}
                      pathLength="1"
                      stroke={CLIENT_GAUGES[gauge].color}
                      stroke-width={CLIENT_GAUGE_LINE}
                      stroke-dasharray={`${Math.min(1, Math.max(0, load))} 2`}
                    ><title>{`${gauge === "cpu" ? "CPU" : gauge === "power" ? "Power grid" : "Calibration"}: ${(load * 100).toFixed(2)}%`}</title></path>
                  {/each}
                </svg>
                <div class="fit-base" aria-hidden="true" style="--tex: url('/client-res/ui/texture/classes/fitting/fittingbase_overlay.png'); --tint: rgba(255,255,255,0.39)"></div>
                {#each absentPlaces as place (`${place.family}:${place.index}`)}
                  <div class="fit-socket-absent" aria-hidden="true" style={`left: ${place.x}%; top: ${place.y}%; --turn: ${place.angle}deg`}>
                    <img alt="" src={emptyIcon(place.family, place.index)} style={place.family === "subsystem" ? "transform: rotate(180deg)" : ""} />
                  </div>
                {/each}
              {:else}
                <div class="fit-ring-guide" aria-hidden="true"></div>
              {/if}
              <div class="fit-hull" class:has-scene={retail && !!shipSceneOf}>
                <TypeIcon typeID={ringTypeID} name={ringName} size="lg" />
                {#if simulation && simulation.shipID === null}
                  <span class="fit-hull-name">{ringName}</span>
                {/if}
                <!-- The ghost ship icon (ghostShipIcon.py): Simulate, or Exit Simulation while simulating; dragged, the
                     active ship's own fitting (GetDragData: GetFittingDictForActiveShip, named the ship's name). -->
                <button
                  type="button"
                  draggable="true"
                  ondragstart={(event) => startFittingSourceDrag(event, "activeShip")}
                  class="fit-simulate"
                  class:simulating={simulation !== null}
                  title={simulateHint}
                  aria-pressed={simulation !== null}
                  disabled={busy}
                  onclick={toggleSimulation}
                >
                  {simulation ? simulationWord("UI/Fitting/FittingWindow/ExitSimulation") : simulationWord("UI/Fitting/FittingWindow/Simulate")}
                </button>
              </div>

              {#each sockets as socket (`${socket.slot.family}:${socket.slot.index}`)}
                {@const slot = socket.slot}
                <button
                  type="button"
                  class="fit-socket family-{slot.family}"
                  class:empty={slot.module === null}
                  class:offline={slot.module !== null &&
                    !slot.module.online &&
                    slot.family !== "rig" &&
                    slot.family !== "subsystem"}
                  class:armed={isSelected(slot)}
                  class:sim-offline={simulatedState(slot) === 0}
                  class:sim-online={simulatedState(slot) === 1}
                  class:sim-active={simulatedState(slot) === 2}
                  class:sim-overheated={simulatedState(slot) === 3}
                  style={`left: ${socket.xPercent}%; top: ${socket.yPercent}%${socket.angle !== undefined ? `; --turn: ${socket.angle}deg` : ""}${slotWarningColor(slotFlagOf(slot.family, slot.index)) ? `; --slot-warning: ${slotWarningColor(slotFlagOf(slot.family, slot.index))}` : ""}`}
                  class:warning={slotWarningColor(slotFlagOf(slot.family, slot.index)) !== null}
                  title={simulation && slot.module ? `${slotName(slot)}, ${moduleName(slot.module.typeID)}. ${simulationWord("UI/Fitting/FittingWindow/ModuleMode")}: ${simulatedStateText(slot) ?? ""}. ${simulationWord("UI/Fitting/FittingWindow/ModuleModeHint")} Right-click takes it out.` : socketDescription(slot)}
                  aria-label={simulation ? simulatedSocketDescription(slot) : socketDescription(slot)}
                  aria-pressed={isSelected(slot)}
                  disabled={busy}
                  draggable={!simulation && slot.module !== null}
                  ondragstart={(event) => startSlotDrag(event, slot)}
                  ondragend={() => (linkingTypeID = null)}
                  class:link-faded={linkingTypeID !== null && slot.module !== null && slot.module.typeID !== linkingTypeID}
                  onclick={(event) => (simulation ? clickSimulated(slot, event) : clickSocket(slot))}
                  oncontextmenu={(event) => unfitSimulated(slot, event)}
                  ondragover={(event) => overSocket(event, slot)}
                  ondragleave={() => (dropSlot = null)}
                  ondrop={(event) => dropOnSocket(event, slot)}
                  class:drop-target={dropSlot === slotKey(slot)}
                >
                  {#if slot.module}
                    {@const moduleLabel = moduleName(slot.module.typeID)}
                    <TypeIcon
                      typeID={slot.module.typeID}
                      name={moduleLabel}
                      size="socket"
                      fallbackText={abbreviate(moduleLabel)}
                    />
                  {:else if retail}
                    <img class="fit-empty-icon" alt="" src={emptyIcon(slot.family, slot.index)} style={slot.family === "subsystem" ? "transform: rotate(180deg)" : ""} />
                  {:else}
                    <span class="fit-socket-text">{socketText(slot)}</span>
                  {/if}
                  {#if retail}
                    {@const fill = fillTexture(slot)}
                    {@const step = chargeStep(slot)}
                    {#if fill}<span class="fit-slot-fill" aria-hidden="true" style={`--tex: url('${fill}')`}></span>{/if}
                    {#if step !== null}<span class="fit-charge" aria-hidden="true"><img alt="" src="/client-res/ui/texture/icons/81_64_2.png" style={`top: ${(-10 * step / 7) * 100}%`} /></span>{/if}
                  {/if}
                </button>
              {/each}
            </div>
            {#if retail}
              <div class="fit-cpu-power" aria-label="CPU and power grid left">
                <b>{simulationWord("UI/Fitting/FittingWindow/CPUStatusHeader")}</b>
                <span class:over={resources.cpu.known && resources.cpu.used > resources.cpu.total}>{leftOverText(resources.cpu)}</span>
                <b class="gap">{simulationWord("UI/Fitting/FittingWindow/PowergridHeader")}</b>
                <span class:over={resources.powergrid.known && resources.powergrid.used > resources.powergrid.total}>{leftOverText(resources.powergrid)}</span>
              </div>
            {/if}
          </div>

          <ul class="fit-legend">
            {#each legend as entry (entry.family)}
              <li>
                <span class="badge">{entry.label}: {entry.filled} of {entry.total} filled</span>
              </li>
            {/each}
          </ul>

          {#if selectedSlot}
            <div class="fit-detail">
              <div class="fit-detail-head">
                <span class="fit-detail-slot">{slotName(selectedSlot)}</span>
                <span class="fit-detail-name">
                  {selectedSlot.module ? moduleName(selectedSlot.module.typeID) : "Empty"}
                </span>
                {#if selectedSlot.module && selectedSlot.family !== "rig" && selectedSlot.family !== "subsystem"}
                  <span class="badge {selectedSlot.module.online ? 'good' : 'warn'}">
                    {selectedSlot.module.online ? "Online" : "Offline"}
                  </span>
                {/if}
              </div>
              <div class="row-actions">
                {#if !selectedSlot.module}
                  <button
                    type="button"
                    disabled={busy || pickedItemID === null}
                    onclick={() => fitInto(selectedSlot!)}
                  >
                    Fit here
                  </button>
                  {#if pickedItemID === null}
                    <span class="note">Pick a module below first.</span>
                  {/if}
                {:else if selectedSlot.family === "rig"}
                  {#if confirmingRigID === selectedSlot.module.itemID}
                    <button
                      type="button"
                      class="danger"
                      disabled={busy}
                      onclick={() => destroyRig(selectedSlot!.module!.itemID)}
                    >
                      Yes, destroy it
                    </button>
                    <button
                      type="button"
                      class="minor"
                      disabled={busy}
                      onclick={() => (confirmingRigID = null)}
                    >
                      Keep it
                    </button>
                  {:else}
                    <button
                      type="button"
                      class="minor"
                      disabled={busy}
                      onclick={() => (confirmingRigID = selectedSlot!.module!.itemID)}
                    >
                      Destroy rig…
                    </button>
                  {/if}
                {:else if selectedSlot.family === "subsystem"}
                  <span class="note">Subsystems stay fitted.</span>
                {:else}
                  <button
                    type="button"
                    disabled={busy}
                    onclick={() =>
                      toggleOnline(selectedSlot!.module!.itemID, !selectedSlot!.module!.online)}
                  >
                    {selectedSlot.module.online ? "Take offline" : "Bring online"}
                  </button>
                  <button
                    type="button"
                    class="minor"
                    disabled={busy}
                    onclick={() => unfit(selectedSlot!.module!.itemID)}
                  >
                    Unfit
                  </button>
                {/if}
              </div>
              {#if selectedSlot.family === "rig" && confirmingRigID !== null}
                <p class="error">
                  Destroying a rig is permanent — it is not returned to your hangar.
                </p>
              {/if}
              {#if selectedSlot.module && selectedSlot.family !== "rig" && selectedSlot.family !== "subsystem"}
                <!--
                  AMMUNITION. Every charge in the chosen inventory is offered,
                  not a filtered "compatible" subset: which charges a module
                  accepts lives in dogma attributes the browser has no
                  allowlisted read for, so narrowing the list would mean hiding
                  ammunition that would have loaded. The SERVER refuses the wrong
                  ones, in its own words, and that refusal is what shows.
                -->
                <div class="fit-ammo">
                  <h4 class="fit-ammo-head">Ammunition</h4>
                  {#if selectedSlot.module.charge}
                    {@const loaded = selectedSlot.module.charge}
                    <p class="fit-ammo-loaded">
                      Loaded: <strong>{chargeCount(loaded.quantity)} {moduleName(loaded.typeID)}</strong>
                    </p>
                    <div class="row-actions">
                      <button
                        type="button"
                        class="minor"
                        disabled={busy}
                        onclick={() => unloadFrom(selectedSlot!.module!.itemID, "hangar")}
                      >Unload to hangar</button>
                      <button
                        type="button"
                        class="minor"
                        disabled={busy}
                        onclick={() => unloadFrom(selectedSlot!.module!.itemID, "cargo")}
                      >Unload to cargo</button>
                    </div>
                  {:else}
                    <p class="note">Nothing loaded.</p>
                  {/if}

                  {#if chargeRows.length === 0}
                    <p class="note">
                      No ammunition in your hangar or cargo to load.
                    </p>
                  {:else}
                    <ul class="fit-ammo-list">
                      {#each sortedChargeRows as entry (`${entry.source}:${entry.row.itemID}`)}
                        <li>
                          <button
                            type="button"
                            class="minor"
                            disabled={busy}
                            onclick={() =>
                              loadInto(selectedSlot!.module!.itemID, entry.row.itemID, entry.source)}
                          >
                            Load {moduleName(entry.row.typeID)}
                          </button>
                          <span class="muted">
                            {chargeCount(entry.row.quantity)} in {entry.source === "cargo" ? "cargo" : "the hangar"}
                            {#if chargeVerdict(entry.row) === false}
                              <!-- A HINT, not a block: the button stays live and
                                   the server has the last word. -->
                              — probably will not fit
                            {/if}
                          </span>
                        </li>
                      {/each}
                    </ul>
                  {/if}
                </div>
              {/if}
              {#if selectedSlot.module}
                {@render moduleStatsBlock(selectedSlot.module.itemID)}
              {/if}
            </div>
          {/if}

          {@render fitFooter()}
        </div>

        <!-- The right-hand collapsible stats panel. -->
        {@render statsPanel()}
      </div>
    </section>
  {:else}
    <!-- ===================== list view (narrow widths) ================= -->
    {#each SLOT_FAMILY_ORDER as family (family)}
      {@const slots = slotsOfFamily($fitting.slots, family as SlotFamily)}
      {#if slots.length > 0}
        <section>
          <h2>{SLOT_FAMILY_LABELS[family as SlotFamily]}</h2>
          {#if family === "rig"}
            <p class="note">
              Rigs cannot be taken off a ship. Removing one destroys it for good.
            </p>
          {/if}
          <div class="table-wrap overflow-x-auto">
            <table class="guests reflow">
              <thead>
                <tr><th>Slot</th><th>Fitted</th><th>State</th><th>Action</th></tr>
              </thead>
              <tbody>
                {#each slots as slot (`${slot.family}:${slot.index}`)}
                  <tr>
                    <td data-label="Slot">{slotName(slot)}</td>
                    <td data-label="Fitted">
                      {#if slot.module}
                        {moduleName(slot.module.typeID)}
                        <details class="module-stats-disclose">
                          <summary>Effective stats</summary>
                          {@render moduleStatsBlock(slot.module.itemID)}
                        </details>
                      {:else}
                        Empty
                      {/if}
                    </td>
                    <td data-label="State">
                      {#if !slot.module}
                        <span class="note">—</span>
                      {:else if family === "rig" || family === "subsystem"}
                        <span class="note">Always on</span>
                      {:else}
                        {slot.module.online ? "Online" : "Offline"}
                      {/if}
                    </td>
                    <td data-label="Action">
                      <div class="row-actions">
                        {#if !slot.module}
                          <button
                            type="button"
                            disabled={busy || pickedItemID === null}
                            onclick={() => fitInto(slot)}
                          >
                            Fit here
                          </button>
                        {:else if family === "rig"}
                          {#if confirmingRigID === slot.module.itemID}
                            <button
                              type="button"
                              class="danger"
                              disabled={busy}
                              onclick={() => destroyRig(slot.module!.itemID)}
                            >
                              Yes, destroy it
                            </button>
                            <button
                              type="button"
                              class="minor"
                              disabled={busy}
                              onclick={() => (confirmingRigID = null)}
                            >
                              Keep it
                            </button>
                          {:else}
                            <button
                              type="button"
                              class="minor"
                              disabled={busy}
                              onclick={() => (confirmingRigID = slot.module!.itemID)}
                            >
                              Destroy rig…
                            </button>
                          {/if}
                        {:else if family === "subsystem"}
                          <span class="note">Subsystems stay fitted</span>
                        {:else}
                          <button
                            type="button"
                            disabled={busy}
                            onclick={() => toggleOnline(slot.module!.itemID, !slot.module!.online)}
                          >
                            {slot.module.online ? "Take offline" : "Bring online"}
                          </button>
                          <button
                            type="button"
                            class="minor"
                            disabled={busy}
                            onclick={() => unfit(slot.module!.itemID)}
                          >
                            Unfit
                          </button>
                        {/if}
                      </div>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          {#if family === "rig" && confirmingRigID !== null && slots.some((s) => s.module?.itemID === confirmingRigID)}
            <p class="error">
              Destroying a rig is permanent — it is not returned to your hangar.
            </p>
          {/if}
        </section>
      {/if}
    {/each}

    <section class="panel">
      {@render fitFooter()}
    </section>
    <section class="panel">
      {@render statsPanel()}
    </section>
  {/if}

  <!-- ===================== saved fittings ============================= -->
  <section bind:this={browserSection}>
    {#if hullMenu !== null}
      {@const menuFor = hullMenu}
      <span class="hull-menu" role="menu" use:portal style:left={`${menuFor.x}px`} style:top={`${menuFor.y}px`}>
        <button type="button" role="menuitem" onclick={() => { const typeID = menuFor.typeID; hullMenu = null; showInfo({ kind: "type", typeID }); }}>{fitWord("UI/Commands/ShowInfo")}</button>
        {#if menuMarketGroup(menuFor) !== null}
          <button type="button" role="menuitem" onclick={() => { const typeID = menuFor.typeID; hullMenu = null; showMarketDetails(typeID); }}>{fitWord("UI/Inventory/ItemActions/ViewTypesMarketDetails")}</button>
        {/if}
        {#if menuPublished(menuFor)}
          <button type="button" role="menuitem" onclick={() => { const typeID = menuFor.typeID; hullMenu = null; findInContracts(typeID); }}>{fitWord("UI/Inventory/ItemActions/FindInContracts")}</button>
          <button type="button" role="menuitem" onclick={() => { const typeID = menuFor.typeID; hullMenu = null; findInPersonalAssets(assetSearchTextForType(fitWord("UI/Inventory/AssetSearch/KeywordTypeExact"), menuTypeName(menuFor))); }}>{fitWord("UI/Inventory/ItemActions/FindPersonalAssets")}</button>
        {/if}
        {#if menuComparable(menuFor)}
          <button type="button" role="menuitem" onclick={() => { const typeID = menuFor.typeID; hullMenu = null; compareType(typeID); }}>{fitWord("UI/Compare/CompareButton")}</button>
        {/if}
      </span>
    {/if}
    {#if nodeMenu !== null}
      {@const menuFor = nodeMenu}
      <span class="hull-menu" role="menu" use:portal style:left={`${menuFor.x}px`} style:top={`${menuFor.y}px`}>
        <button type="button" role="menuitem" onclick={() => { const typeIDs = menuFor.typeIDs; nodeMenu = null; if (typeIDs !== null) compareTypes(typeIDs); }}>{fitWord("UI/Compare/CompareButton")}</button>
        <hr />
        <button type="button" role="menuitem" onclick={() => { const id = menuFor.id; nodeMenu = null; opened[id] = opened[id] !== true; }}>{fitWord(opened[menuFor.id] === true ? "UI/Common/Collapse" : "UI/Common/Expand")}</button>
      </span>
    {/if}
    <h2>{fitWord("UI/Fitting/FittingWindow/ShipAndFittings")}</h2>
    <p class="controls">
      <button type="button" disabled={busy} onclick={() => void flow.saveFitAs().catch(() => {})}>{fitWord("UI/Fitting/FittingWindow/SaveFitAs")}</button>
      <!-- hullAndHardwareTypeBrowser.AddExportImportMenu (680 to 694): Import from Clipboard and Export to Clipboard. -->
      <span class="import-export">
        <button type="button" class="minor" aria-haspopup="menu" aria-expanded={importExportOpen} title={fitWord("UI/Fitting/FittingWindow/ImportAndExport")}
          onclick={() => (importExportOpen = !importExportOpen)}>⇅</button>
        {#if importExportOpen}
          <span class="import-export-menu" role="menu">
            <button type="button" role="menuitem" title={fitWord("UI/Fitting/FittingWindow/FittingManagement/ImportFromClipboardHint")}
              onclick={() => { importExportOpen = false; void navigator.clipboard.readText().catch(() => null).then((text) => flow.importFittingFromClipboard(text)).catch(() => {}); }}>
              {fitWord("UI/Fitting/FittingWindow/FittingManagement/ImportFromClipboard")}
            </button>
            <button type="button" role="menuitem" title={fitWord("UI/Fitting/FittingWindow/FittingManagement/ExportToClipboardHint")}
              onclick={() => { importExportOpen = false; void flow.currentFitText().then((text) => (text === null ? undefined : navigator.clipboard.writeText(text))).catch(() => {}); }}>
              {fitWord("UI/Fitting/FittingWindow/FittingManagement/ExportToClipboard")}
            </button>
          </span>
        {/if}
      </span>
    </p>
    <p class="controls">
      <button type="button" class={showPersonalFittings ? "active" : "minor"} aria-pressed={showPersonalFittings}
        title={filterHint("UI/Fitting/FittingWindow/FilterPersonalFittings", ($savedFittings ?? []).filter((saved) => saved.source === "personal").length, 500)}
        onclick={() => { showPersonalFittings = !showPersonalFittings; keepHullSettings(); }}>👤</button>
      <button type="button" class={showCorpFittings ? "active" : "minor"} aria-pressed={showCorpFittings}
        title={filterHint("UI/Fitting/FittingWindow/FilterCorpFittings", ($savedFittings ?? []).filter((saved) => saved.source === "corporation").length, 600)}
        onclick={() => { showCorpFittings = !showCorpFittings; keepHullSettings(); }}>🏢</button>
      {#if allianceID !== null}
        <button type="button" class={allianceFilterSet ? "active" : "minor"} aria-pressed={allianceFilterSet}
          title={filterHint("UI/Fitting/FittingWindow/FilterAllianceFittings", ($savedFittings ?? []).filter((saved) => saved.source === "alliance").length, 600)}
          onclick={() => { allianceFilterSet = !allianceFilterSet; keepHullSettings(); }}>🛡</button>
      {/if}
      {#if $communityFittingsEnabled}
        <button type="button" class={communityFilterSet ? "active" : "minor"} aria-pressed={communityFilterSet}
          title={fitWord("UI/Fitting/FilterCommunityFittings")}
          onclick={() => { communityFilterSet = !communityFilterSet; keepHullSettings(); }}>🌐</button>
      {/if}
      <button type="button" class={onlyCurrentHull ? "active" : "minor"} aria-pressed={onlyCurrentHull}
        title={fitWord("UI/Fitting/FittingWindow/FilterCurrentHull")}
        onclick={() => { onlyCurrentHull = !onlyCurrentHull; keepHullSettings(); }}>⛴</button>
      <button type="button" class={onlyWithSkills ? "active" : "minor"} aria-pressed={onlyWithSkills}
        title={fitWord("UI/Fitting/FittingWindow/FilterSkillsForFitting")}
        onclick={() => { onlyWithSkills = !onlyWithSkills; keepHullSettings(); }}>📘</button>
      <input type="search" bind:value={hullFilterText} oninput={keepHullSettings} aria-label="Search fittings" />
    </p>
    <!-- A fitting's name as the client's label draws it (FittingEntry, Generic's label: its markup read as the
         client's text reads it, bridge/mailMarkup.ts mailBodyLines): bold, italic, underlined or a link as its tags say,
         on one line. -->
    {#snippet markedText(text: string)}
      {#each mailBodyLines(text) as line, place (place)}{#if place > 0}{" "}{/if}{#each line as segment, at (at)}<span class="marked-run" class:bold={segment.bold} class:italic={segment.italic} class:underline={segment.underline || segment.link !== null}>{segment.text}</span>{/each}{/each}
    {/snippet}
    {#snippet fittingRow(saved: NonNullable<typeof $savedFittings>[number])}
        <!-- Draggable (FittingEntry.GetDragData): the skill plan editor takes a fitting dropped on its skills, and the
             chat's text takes it as a link. -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <p class="controls saved-fitting" class:selected={selectedFittings.includes(saved.fittingID)} data-fitting-id={saved.fittingID}
          draggable="true" ondragstart={(event) => startFittingDrag(event, {
            fittingID: saved.fittingID,
            shipTypeID: saved.shipTypeID,
            fitData: saved.modules.map((module) => [module.typeID, module.flagID, module.quantity] as const),
            name: saved.name,
          })}>
          {#if saved.source === "corporation"}
            <span title={fitWord("UI/Fitting/CorpFittingHint")}>🏢</span>
          {:else if saved.source === "community"}
            <span title={fitWord("UI/Fitting/CommunityFittingHint")}>🌐</span>
          {:else if saved.source === "alliance"}
            <span title={fitWord("UI/Fitting/AllianceFittingHint")}>🛡</span>
          {/if}
          <button type="button" class="fitting-name" title={fittingTooltip(saved)} aria-pressed={selectedFittings.includes(saved.fittingID)}
            onclick={(event) => selectFitting(saved.fittingID, event)}>{@render markedText(saved.name)}</button>
          {#if selectedFittings.length > 1 && selectedFittings.includes(saved.fittingID)}
            <!-- GetFittingMenu with more than one selected (506 to 528): Delete Fitting alone, for those of them
                 GetDeletableNodes lets go, in the browser's order. -->
            {#if selectedDeletable.length > 0}
              <button type="button" class="minor" onclick={() => void flow.deleteFittings(shownFittingIDs().filter((id) => selectedDeletable.includes(id))).catch(() => {})}>
                {fitWord("UI/Fitting/FittingWindow/FittingManagement/DeleteFitting")}
              </button>
            {/if}
          {:else}
          <button type="button" class="minor" onclick={() => void flow.viewFitting(saved.fittingID).catch(() => {})}>
            {fitWord("UI/Fitting/FittingWindow/ViewFitting")}
          </button>
          <!-- GetFittingMenu (512): Simulate Fitting, as a click on the fitting does. -->
          <button type="button" class="minor" disabled={busy} onclick={() => simulateSaved(saved.fittingID)}>
            {simulationWord("UI/Fitting/FittingWindow/SimulateFitting")}
          </button>
          <!-- GetFittingMenu (513 to 516): no Fit to Active Ship for a structure's fitting (categoryStructure); Open
               Multifit only where the config allows any (GetMaxShipsToFit) and the pilot is docked. -->
          {#if $hullBrowser?.types.get(saved.shipTypeID)?.categoryID !== CATEGORY_STRUCTURE}
            <button type="button" disabled={busy} onclick={() => void flow.fitFittingToActiveShip(saved.fittingID).catch(() => {})}>
              {fitWord("UI/Fitting/FittingWindow/FitFittingToActiveShip")}
            </button>
          {/if}
          <button type="button" class="minor" onclick={() => void flow.buyFit(saved.fittingID).catch(() => {})}>
            {fitWord("UI/Market/MarketQuote/BuyAll")}
          </button>
          {#if $maxShipsToFit > 0 && ($inventory.stationID ?? $inventory.structureID ?? null) !== null}
            <button type="button" class="minor" onclick={() => void flow.openMultiFit(saved.fittingID).catch(() => {})}>
              {fitWord("UI/Fitting/FittingWindow/FittingManagement/OpenMultifit")}
            </button>
          {/if}
          {#if deletable(saved.source)}
            <button type="button" class="minor" onclick={() => void flow.deleteFitting(saved.fittingID).catch(() => {})}>
              {fitWord("UI/Fitting/FittingWindow/FittingManagement/DeleteFitting")}
            </button>
          {/if}
          {/if}
        </p>
    {/snippet}
    {#snippet hullEntry(hull: NonNullable<typeof browserTree>["groups"][number]["races"][number]["hulls"][number])}
      {@const id = `h:${hull.typeID}`}
      {@const count = fittingNumByTypeID.get(hull.typeID)}
      <details class="browser-node" class:current-hull={hull.isCurrent} open={opened[id] === true} ontoggle={(event) => toggled(id, event)}>
        <summary title={hullTooltip(hull.typeID)} onpointerenter={() => void flow.requestShipTraits([hull.typeID]).catch(() => {})}
          oncontextmenu={(event) => openHullMenu(hull.typeID, event)}>
          <TypeIcon typeID={hull.typeID} name={hullName(hull.typeID)} size="sm" />
          <strong>{hullName(hull.typeID)}</strong>
          {#if count?.personal}<small class="note" title={fitWord("UI/Fitting/FittingWindow/SavedPersonalFittings")}>👤 {count.personal}</small>{/if}
          {#if count?.corporation}<small class="note" title={fitWord("UI/Fitting/FittingWindow/SavedCorpFittings")}>🏢 {count.corporation}</small>{/if}
          {#if count?.community && $communityFittingsEnabled}<small class="note" title={fitWord("UI/Fitting/FittingWindow/SavedCommunityFittings")}>🌐 {count.community}</small>{/if}
          <!-- HullTypeListGroup.Load (683 to 686) shows the alliance's count where the corporation has any fittings for
               the hull (allianceCont.display = bool(numCorp)), its number nought where the alliance has none. -->
          {#if count?.corporation}<small class="note" title={fitWord("UI/Fitting/FittingWindow/SavedAllianceFittings")}>🛡 {count.alliance}</small>{/if}
          <!-- HullTypeListGroup's ShipFittingSimulationButton (fittingBrowser 747 to 755): the hull simulated alone. -->
          <button type="button" class="minor fit-simulate-hull" title={simulationWord("UI/Fitting/FittingWindow/SimulateShip")}
            aria-label={`${simulationWord("UI/Fitting/FittingWindow/SimulateShip")}: ${hullName(hull.typeID)}`} disabled={busy}
            onclick={(event) => { event.preventDefault(); event.stopPropagation(); simulateHull(hull.typeID); }}>⧉</button>
        </summary>
        {#if opened[id] === true}
          {#each hull.fittings as saved (saved.fittingID)}
            {@render fittingRow(saved)}
          {/each}
        {/if}
      </details>
    {/snippet}
    {#snippet groupEntry(group: NonNullable<typeof browserTree>["groups"][number], prefix: string)}
      {@const id = `${prefix}g:${group.groupID}`}
      <details class="browser-node" class:holds-current={group.hasCurrent} open={opened[id] === true} ontoggle={(event) => toggled(id, event)}>
        <summary oncontextmenu={(event) => openNodeMenu(group.compareTypeIDs, id, event)}>{hullGroupName(group.namedBy)}</summary>
        {#if opened[id] === true}
          {#each group.races as race (race.raceID)}
            {@const raceID = `${id}_${race.raceID}`}
            <details class="browser-node" class:holds-current={race.hasCurrent} open={opened[raceID] === true} ontoggle={(event) => toggled(raceID, event)}>
              <summary oncontextmenu={(event) => openNodeMenu(race.compareTypeIDs, raceID, event)}>{raceName(race.raceID)}</summary>
              {#if opened[raceID] === true}
                {#each race.hulls as hull (hull.typeID)}
                  {@render hullEntry(hull)}
                {/each}
              {/if}
            </details>
          {/each}
        {/if}
      </details>
    {/snippet}
    {#if $savedFittings === null || $hullBrowser === null}
      <p class="note">…</p>
    {:else if browserTree === null}
      <!-- The client's data is not had here: the fittings let through, by name, each with its hull. -->
      {#if shownFittings.length === 0}
        <p class="note">{fitWord("UI/Common/NothingFound")}</p>
      {:else}
        {#each shownFittings as saved (saved.fittingID)}
          <small class="note">{hullName(saved.shipTypeID)}</small>
          {@render fittingRow(saved)}
        {/each}
      {/if}
    {:else if browserTree.nothingFound}
      <p class="note">{fitWord("UI/Common/NothingFound")}</p>
    {:else}
      <div class="browser-tree">
        {#each browserTree.groups as group (group.groupID)}
          {@render groupEntry(group, "")}
        {/each}
        {#if browserTree.special.length > 0}
          <details class="browser-node" class:holds-current={browserTree.specialHasCurrent} open={opened.special === true} ontoggle={(event) => toggled("special", event)}>
            <summary oncontextmenu={(event) => openNodeMenu(null, "special", event)}>{fitWord("UI/Fitting/FittingWindow/SpecialEditionShips")}</summary>
            {#if opened.special === true}
              {#each browserTree.special as group (group.groupID)}
                {@render groupEntry(group, "special")}
              {/each}
            {/if}
          </details>
        {/if}
        {#if browserTree.unsupported.length > 0}
          <details class="browser-node" open={opened.unsupported === true} ontoggle={(event) => toggled("unsupported", event)}>
            <summary>{fitWord("UI/Fitting/FittingWindow/UnsupportedShip")}</summary>
            {#if opened.unsupported === true}
              {#each browserTree.unsupported as saved (saved.fittingID)}
                <p class="controls saved-fitting">
                  <span>{@render markedText(`${saved.name} (${$hullBrowser?.types.get(saved.shipTypeID) ? hullName(saved.shipTypeID) : fitWord("UI/Fitting/FittingWindow/UnknownShipType")}) - unsupported`)}</span>
                  {#if deletable(saved.source)}
                    <button type="button" class="minor" onclick={() => void flow.deleteFitting(saved.fittingID).catch(() => {})}>
                      {fitWord("UI/Fitting/FittingWindow/FittingManagement/DeleteFitting")}
                    </button>
                  {/if}
                </p>
              {/each}
            {/if}
          </details>
        {/if}
      </div>
    {/if}
  </section>

  <!-- ===================== modules you can fit ======================== -->
  <section>
    <h2>
      Modules you can fit
      {#if pickedName}
        <small class="note">holding {pickedName}</small>
      {/if}
    </h2>
    {#if pickedItemID !== null}
      <p class="controls">
        <button type="button" disabled={busy} onclick={fitAnywhere}>
          Fit {pickedName} in the first free slot
        </button>
        <button type="button" class="minor" disabled={busy} onclick={() => (pickedItemID = null)}>
          Put it back down
        </button>
      </p>
    {:else}
      <p class="note">Pick a module below, then choose an empty slot to put it in.</p>
    {/if}
    {#if fittable.length === 0}
      <p class="note">
        {$inventory.loaded
          ? "No modules in your hangar or cargo hold to fit."
          : "Loading your hangar…"}
      </p>
    {:else}
      <div class="table-wrap overflow-x-auto">
        <table class="guests reflow">
          <thead>
            <tr><th>Module</th><th>Where it is</th><th>Action</th></tr>
          </thead>
          <tbody>
            {#each fittable as entry (entry.row.itemID)}
              <!-- Draggable onto a socket. The Fit button in the last cell is
                   unchanged and remains the keyboard path. -->
              <tr
                class={entry.row.itemID === pickedItemID ? "self" : ""}
                draggable="true"
                ondragstart={(event) =>
                  startItemDrag(event, entry.row.itemID, entry.row.typeID, entry.source)}
              >
                <td data-label="Module">{moduleName(entry.row.typeID)}</td>
                <td data-label="Where it is">
                  {entry.source === "hangar" ? HANGAR_NAME : "Cargo hold"}
                </td>
                <td data-label="Action">
                  <button
                    type="button"
                    disabled={busy}
                    onclick={() => pick(entry.row.itemID, entry.source)}
                  >
                    {entry.row.itemID === pickedItemID ? "Put down" : "Pick up"}
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
{/if}
