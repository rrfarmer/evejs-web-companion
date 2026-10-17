<script lang="ts">
  // REGION 3 of the Bot Builder — the inspector for whichever row is selected
  // (docs/bot-builder-interface.md §2). A plan row, or a watch row: a watch is
  // a sentence in its own region, so its threshold and response have nowhere
  // else to be edited, and giving the two their own inspectors would mean two
  // condition editors that could drift apart.
  //
  // ⚠ WHY THIS IS ITS OWN COMPONENT, AND NOT PART OF BotBuilder.svelte.
  // Svelte components are not type-checked by this project's build
  // (docs/svelte-typecheck-gap.md), so an SSR render is the only net a
  // template has — and the SSR harness cannot click. Inside the builder this
  // region is only reachable after a selection, so nothing would ever render
  // the widget switch below: the exact shape of the gap that made
  // `BotManagerPilotRow.svelte` a component of its own. Everything it draws
  // arrives as a prop, so `botInspector.test.ts` renders it directly, with no
  // test-only seam anywhere in it.
  //
  // It holds no state and no document. It reads a node and reports what the
  // player changed; `BotBuilder.svelte` owns the document and applies it.

  import {
    type Arg,
    type BranchBlock,
    type Condition,
    type ConditionKind,
    type InterruptResponse,
    type InterruptRow,
    type MacroID,
    type MacroStep,
    type SubBotNode,
    type WorldRef,
    MAX_ISK_ARG,
    MAX_TEXT_ARG_LEN,
    MAX_ITEM_LIST,
    type ItemMatchArg,
    MAX_ORE_LIST,
    ROCK_PICKS,
    TARGET_CLASS_ARGS,
    type TargetClassArg,
    type SquadRoleArg,
    MIN_ISK_ARG,
  } from "../bots/botScript.ts";
  import {
    MACRO_ARG_DESCRIPTORS,
    argBounds,
    clampConditionFraction,
    clampConditionIsk,
    conditionFractionCap,
    conditionPercent,
    freshCondition,
    type ArgDescriptor,
    CONDITION_FRACTION_BOUNDS,
    CONDITION_NOUN_LABEL,
    CONDITION_UNTIL_LABEL,
    textPlaceholder,
    itemListHint,
    PLACE_OPTIONS,
    RESPONSE_OPTIONS,
    UNTIL_CONDITION_KINDS,
    WATCH_CONDITION_KINDS,
  } from "../bots/editorOptions.ts";
  import { MACRO_CATALOG_LIST, macroEntry } from "../bots/macroCatalogView.ts";
  import { MAX_WORLD_NAME_LEN } from "../bots/scriptCodec.ts";
  import { conditionAdvice, interruptSentence, targetClassWord } from "../bots/scriptText.ts";
  import type { ScriptProblem } from "../bots/validateScript.ts";
  import type { AppFlow } from "../app/flow.ts";
  import StationPicker from "./StationPicker.svelte";
  import CorpHangarPicker from "./CorpHangarPicker.svelte";
  import FittingSelect from "./FittingSelect.svelte";
  import type { PickerFitting } from "../bots/fittingPicker.ts";

  /** What the inspector is looking at. A branch and a sub-bot get their own
   * small forms; a loop header is never selectable, so there is no case for it. */
  export type InspectorTarget =
    | { readonly kind: "step"; readonly step: MacroStep }
    | { readonly kind: "branch"; readonly branch: BranchBlock }
    | { readonly kind: "sub-bot"; readonly subBot: SubBotNode }
    | { readonly kind: "watch"; readonly watch: InterruptRow };

  let {
    target,
    flow,
    currentStation = null,
    equipment = [],
    items = [],
    pilots = [],
    agents = [],
    fittings = [],
    spots = [],
    folders = [],
    savedBots = [],
    oreFamilies = [],
    problems = [],
    onArg,
    onCondition,
    onRespond,
    onWatchFight,
    onAddToSide,
    onSubBot,
    onClose,
  }: {
    target: InspectorTarget;
    flow: Pick<AppFlow, "searchDestinations" | "loadCorpOffices">;
    currentStation?: { id: number; name: string } | null;
    equipment?: readonly { groupID: number; label: string }[];
    items?: readonly { typeID: number; groupID?: number | null; name: string }[];
    pilots?: readonly { characterID: number; characterName: string }[];
    agents?: readonly { agentID: number; name: string; stationName?: string | null; solarSystemName?: string | null }[];
    fittings?: readonly PickerFitting[];
    spots?: readonly { bookmarkID: number; name: string }[];
    folders?: readonly { folderID: number; name: string }[];
    savedBots?: readonly { scriptID: string; name: string }[];
    /** Every ore family the mine block can prioritise (Veldspar, Kernite, …).
     * A grade within a family (0-Grade, II-, III-, …) is the runtime's business
     * and is never listed here — see `OreFamilyArg` in botScript.ts. */
    oreFamilies?: readonly { groupID: number; name: string }[];
    problems?: readonly ScriptProblem[];
    /** One argument changed. `undefined` clears it back to the macro's default. */
    onArg: (key: string, value: Arg | undefined) => void;
    /** The condition changed — a step's "stop when", a branch's fork, or a
     * watch's check, according to `target.kind`. `undefined` only ever comes
     * from a step whose `until` is optional. */
    onCondition: (condition: Condition | undefined) => void;
    onRespond: (respond: InterruptResponse) => void;
    onWatchFight: (patch: { squad?: SquadRoleArg | null; targets?: readonly TargetClassArg[] | null }) => void;
    onAddToSide: (side: "then" | "else", macro: MacroID) => void;
    onSubBot: (scriptID: string) => void;
    onClose: () => void;
  } = $props();

  // ── Reading an argument back out for its widget ─────────────────────────────
  function argOf(step: MacroStep, key: string): Arg | undefined {
    return step.args[key];
  }
  /** The chosen corporation division, or null for the pilot's own hangar — which
   * is what an ABSENT argument means, and the only thing it can mean. */
  function corpDivisionValue(step: MacroStep, key: string): { division: number; name: string | null } | null {
    const arg = argOf(step, key);
    return arg !== undefined && arg.kind === "corpDivision"
      ? { division: arg.division, name: arg.name }
      : null;
  }
  function numberValue(step: MacroStep, key: string): number | string {
    const arg = argOf(step, key);
    if (arg === undefined) return "";
    // `distanceKm` shares the numeric shape on purpose (its value field is
    // `value`, like every other number), so it edits through the same box. The
    // UNIT is in the label, never in the value.
    return arg.kind === "count" || arg.kind === "isk" || arg.kind === "qty" || arg.kind === "distanceKm"
      ? arg.value
      : "";
  }
  function textValue(step: MacroStep, key: string): string {
    const arg = argOf(step, key);
    return arg !== undefined && arg.kind === "text" ? arg.text : "";
  }
  function itemTypeValue(step: MacroStep, key: string): string {
    const arg = argOf(step, key);
    return arg !== undefined && arg.kind === "itemType" && arg.typeID !== null ? String(arg.typeID) : "";
  }
  function placeValue(step: MacroStep, key: string): string {
    const arg = argOf(step, key);
    return arg !== undefined && arg.kind === "place" ? arg.place : "";
  }
  /** The world ref a station-, destination- or system-shaped argument points at. */
  function worldRefValue(step: MacroStep, key: string, kind: Arg["kind"]): WorldRef {
    const arg = argOf(step, key);
    if (arg !== undefined && (arg.kind === "station" || arg.kind === "destination" || arg.kind === "system")) {
      return arg.ref;
    }
    // The EMPTY ref has to carry the slot's own entity: a systems-only slot
    // handed an "unbound station" is a shape its codec refuses to save.
    return kind === "system"
      ? { entity: "system", id: null, name: null, systemName: null }
      : { entity: "station", id: null, name: null, systemName: null };
  }
  // ── Which belt ──────────────────────────────────────────────────────────────
  // A belt is TYPED, not picked from a list, and the reason is where bots get
  // written: a player configuring a mining bot is almost never sitting in the
  // system whose belts it will work, so any list the editor could offer — the
  // live grid, or the belts of wherever the pilot happens to be docked — is a
  // list of the wrong belts.
  //
  // Typing costs nothing extra in correctness, because the NAME was already the
  // handle. Belt entity ids are grid-local, so the runtime never matches on one:
  // it re-matches the name against whatever belts are on the grid it arrives at
  // (`beltTarget` in nav/scriptMacros.ts). The name a player types is exactly
  // what a picked belt would have stored.
  //
  // "site" is the third choice, and it is not a belt at all: it points the
  // block at the scanner's ore sites instead, and its whole reason to exist is
  // that "nearest" quietly toured the wrong grid the moment a mining site ran
  // dry (see `BeltArg` in botScript.ts). Nothing to type for it, same as
  // "nearest" — the scanner is read fresh each time the block needs a target.
  function beltMode(step: MacroStep, key: string): "nearest" | "named" | "site" | "ice-site" {
    const arg = argOf(step, key);
    if (arg === undefined || arg.kind !== "belt") {
      return "nearest";
    }
    if (arg.belt.mode === "chosen") {
      return "named";
    }
    if (arg.belt.mode === "site") {
      return "site";
    }
    if (arg.belt.mode === "ice-site") {
      return "ice-site";
    }
    return "nearest";
  }
  function beltName(step: MacroStep, key: string): string {
    const arg = argOf(step, key);
    return arg !== undefined && arg.kind === "belt" && arg.belt.mode === "chosen" ? (arg.belt.ref.name ?? "") : "";
  }
  function characterValue(step: MacroStep, key: string): string {
    const arg = argOf(step, key);
    return arg !== undefined && arg.kind === "character" && arg.charID !== null ? String(arg.charID) : "";
  }
  function equipmentValue(step: MacroStep, key: string): string {
    const arg = argOf(step, key);
    return arg !== undefined && arg.kind === "equipment" ? String(arg.equipment.groupID) : "";
  }
  function agentValue(step: MacroStep, key: string): string {
    const arg = argOf(step, key);
    return arg !== undefined && arg.kind === "agent" && arg.ref.id !== null ? String(arg.ref.id) : "";
  }
  function fittingValue(step: MacroStep, key: string): string {
    const arg = argOf(step, key);
    return arg !== undefined && arg.kind === "fitting" ? String(arg.fittingID) : "";
  }
  function bookmarkValue(step: MacroStep, key: string): string {
    const arg = argOf(step, key);
    return arg !== undefined && arg.kind === "bookmark" ? String(arg.bookmarkID) : "";
  }
  function corpValue(step: MacroStep, key: string): string {
    const arg = argOf(step, key);
    return arg !== undefined && arg.kind === "corp" ? (arg.name ?? "") : "";
  }
  function rockPickValue(step: MacroStep, key: string): string {
    const arg = argOf(step, key);
    return arg !== undefined && arg.kind === "rockPick" ? arg.pick : "nearest";
  }
  function squadRoleValue(step: MacroStep, key: string): string {
    const arg = argOf(step, key);
    return arg !== undefined && arg.kind === "squadRole" ? arg.role : "off";
  }
  function oreListValue(step: MacroStep, key: string): readonly { groupID: number; name: string }[] {
    const arg = argOf(step, key);
    return arg !== undefined && arg.kind === "oreList" ? arg.ores : [];
  }

  /** The bays a step has been told to leave alone. */
  function bayListValue(step: MacroStep, key: string): readonly string[] {
    const arg = argOf(step, key);
    return arg !== undefined && arg.kind === "bayList" ? arg.bays : [];
  }

  /**
   * The bays worth offering: the ones whose contents are arguable. A player does
   * not need to be told the drone bay is left alone — no block ever empties it.
   */
  const PROTECTABLE_BAYS: readonly { key: string; label: string }[] = [
    { key: "ammo", label: "Ammo hold" },
    { key: "fuel", label: "Fuel bay" },
    { key: "ore", label: "Ore hold" },
    { key: "gas", label: "Gas hold" },
    { key: "ice", label: "Ice hold" },
    { key: "mineral", label: "Mineral hold" },
    { key: "salvage", label: "Salvage hold" },
    { key: "planetary", label: "Planetary hold" },
    { key: "commandCenter", label: "Command centre hold" },
  ];

  function toggleBay(key: string, chosen: readonly string[], bayKey: string): void {
    const next = chosen.includes(bayKey)
      ? chosen.filter((entry) => entry !== bayKey)
      : [...chosen, bayKey];
    // An emptied list is DROPPED rather than saved empty, so a step nobody
    // touched exports exactly as it was imported.
    onArg(key, next.length === 0 ? undefined : { kind: "bayList", bays: next });
  }

  /** The items a step has been told to keep aboard. */
  function planetListWords(step: MacroStep, key: string): string {
    const arg = step.args[key];
    if (arg === undefined || arg.kind !== "planetList" || arg.planets.length === 0) {
      return "Every colony";
    }
    const named = arg.planets.map((planet) => planet.name ?? "a colony with no name");
    return `${named.join(", ")} (set by the Planetary Industry window)`;
  }

  function itemListValue(step: MacroStep, key: string): readonly ItemMatchArg[] {
    const arg = argOf(step, key);
    return arg !== undefined && arg.kind === "itemList" ? arg.items : [];
  }

  let keepQuery = $state("");

  function keepMatches(query: string): readonly { typeID: number; groupID?: number | null; name: string }[] {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return [];
    return items.filter((it) => it.name.toLowerCase().includes(q)).slice(0, 8);
  }

  function keepId(entry: ItemMatchArg): string {
    switch (entry.match) {
      case "type":
        return `type:${entry.typeID}`;
      case "group":
        return `group:${entry.groupID}`;
      case "name":
        // Two patterns differing only in case are the same rule (the matcher is
        // case-insensitive), so they must share an id or the list would take
        // both and the block would test the same thing twice.
        return `name:${entry.pattern.trim().toLowerCase()}`;
    }
  }

  function addKeep(key: string, chosen: readonly ItemMatchArg[], entry: ItemMatchArg): void {
    if (chosen.length >= MAX_ITEM_LIST || chosen.some((c) => keepId(c) === keepId(entry))) return;
    onArg(key, { kind: "itemList", items: [...chosen, entry] });
    keepQuery = "";
  }

  function removeKeep(key: string, chosen: readonly ItemMatchArg[], id: string): void {
    const items_ = chosen.filter((c) => keepId(c) !== id);
    // An emptied list is DROPPED, so an untouched step exports as it imported.
    onArg(key, items_.length === 0 ? undefined : { kind: "itemList", items: items_ });
  }

  // ── Turning what a widget reports back into an argument ─────────────────────
  /** Set (or clear, on an empty or unparseable input) a bounded number. */
  function setNumber(step: MacroStep, arg: ArgDescriptor, raw: string): void {
    const bounds = argBounds(step.macro, arg);
    const parsed = Number(raw);
    if (bounds === null || raw.trim() === "" || !Number.isSafeInteger(parsed)) {
      onArg(arg.key, undefined);
      return;
    }
    onArg(arg.key, { kind: arg.kind, value: Math.min(bounds.max, Math.max(bounds.min, parsed)) } as Arg);
  }
  /**
   * The belt name a player last typed, per step and per slot.
   *
   * ⚠ IT CANNOT LIVE IN THE DOCUMENT. "The nearest belt" is a belt argument
   * with NO ref on it at all, so the instant a player flips away from a name
   * there is nowhere in the script left to keep one — and writing the name into
   * the saved bot anyway would be recording a belt the bot is not going to use.
   * So it is throwaway editor state, like `oreQuery` and `keepQuery` above:
   * flipping to the nearest belt and back within a sitting keeps the name,
   * reloading the builder does not, and losing it costs a retype.
   *
   * Keyed by step AND slot, so a bot with two belt steps in it cannot have one
   * of them hand its name to the other.
   */
  let typedBeltNames = $state<Record<string, string>>({});
  function beltSlotKey(step: MacroStep, key: string): string {
    return `${step.id}::${key}`;
  }
  /** Switch between "the nearest belt", one the player names, and the
   * scanner's ore sites — keeping any name already typed so flipping back and
   * forth does not lose it. */
  function setBeltMode(step: MacroStep, key: string, mode: string): void {
    if (mode === "named") {
      setBeltName(key, typedBeltNames[beltSlotKey(step, key)] ?? "");
      return;
    }
    // Leaving "named" for "nearest" or "site" — catch the typed name on the
    // way out, the last moment it exists (see the comment on typedBeltNames).
    typedBeltNames[beltSlotKey(step, key)] = beltName(step, key);
    onArg(key, { kind: "belt", belt: { mode: mode === "site" || mode === "ice-site" ? mode : "nearest" } });
  }
  /**
   * The typed belt name.
   *
   * ⚠ NO ID AND NO SYSTEM NAME ARE STORED. A belt's id is grid-local, so one
   * read here would be meaningless on the grid the bot actually arrives at —
   * and the name a player types is already fully qualified ("<system> <planet>
   * - Asteroid Belt <n>"), so it names its own system. The validator asks for a
   * name that is not blank; nothing else here is in a position to know whether
   * a belt by that name exists, and pretending to check would be a worse lie
   * than the bot saying so when it gets there.
   */
  function setBeltName(key: string, value: string): void {
    const name = value.slice(0, MAX_WORLD_NAME_LEN);
    onArg(key, {
      kind: "belt",
      belt: { mode: "chosen", ref: { entity: "belt", id: null, name, systemName: null } },
    });
  }
  function setItemType(key: string, raw: string): void {
    if (raw === "") {
      onArg(key, undefined);
      return;
    }
    const match = items.find((it) => it.typeID === Number(raw));
    if (match === undefined) return;
    onArg(key, { kind: "itemType", typeID: match.typeID, name: match.name });
  }
  function setCharacter(key: string, raw: string): void {
    if (raw === "") {
      onArg(key, undefined);
      return;
    }
    const match = pilots.find((p) => p.characterID === Number(raw));
    if (match === undefined) return;
    onArg(key, { kind: "character", charID: match.characterID, name: match.characterName });
  }
  function setEquipment(key: string, raw: string): void {
    if (raw === "") {
      onArg(key, undefined);
      return;
    }
    const match = equipment.find((e) => e.groupID === Number(raw));
    if (match === undefined) return;
    onArg(key, { kind: "equipment", equipment: { groupID: match.groupID, label: match.label } });
  }
  function setAgent(key: string, raw: string): void {
    if (raw === "") {
      onArg(key, undefined);
      return;
    }
    const match = agents.find((a) => a.agentID === Number(raw));
    if (match === undefined) return;
    onArg(key, {
      kind: "agent",
      ref: { entity: "agent", id: match.agentID, name: match.name, systemName: match.solarSystemName ?? null },
    });
  }
  function setFitting(key: string, raw: string): void {
    const match = fittings.find((f) => f.fittingID === Number(raw));
    if (match === undefined) return;
    onArg(key, { kind: "fitting", fittingID: match.fittingID, name: match.name });
  }
  function setBookmark(key: string, raw: string): void {
    const match = spots.find((bm) => bm.bookmarkID === Number(raw));
    if (match === undefined) return;
    onArg(key, { kind: "bookmark", bookmarkID: match.bookmarkID, name: match.name });
  }
  function folderValue(step: MacroStep, key: string): string {
    const arg = argOf(step, key);
    return arg !== undefined && arg.kind === "bookmarkFolder" && arg.folderID !== null ? String(arg.folderID) : "";
  }
  function setFolder(key: string, raw: string): void {
    const match = folders.find((f) => f.folderID === Number(raw));
    if (match === undefined) return;
    onArg(key, { kind: "bookmarkFolder", folderID: match.folderID, name: match.name });
  }
  /**
   * The one argument picker that is a plain text field: no live corporation
   * search exists anywhere in this app (unlike stations, fittings, bookmarks
   * or pilots), and the NAME is all the agent finders filter on. An empty
   * field means "any corporation", the shipped default.
   */
  function setCorp(key: string, raw: string): void {
    const trimmed = raw.trim();
    onArg(key, trimmed.length === 0 ? undefined : { kind: "corp", id: null, name: trimmed });
  }
  function setRockPick(key: string, raw: string): void {
    // Back to the default: drop the argument rather than storing "nearest", so
    // an untouched step exports exactly as it was imported. Anything that is not
    // one of the picks the codec accepts is treated as that default too, rather
    // than stored and refused on the next import.
    const pick = ROCK_PICKS.find((candidate) => candidate === raw && candidate !== "nearest");
    onArg(key, pick === undefined ? undefined : { kind: "rockPick", pick });
  }
  // ── A fight-back WATCH fights like a block, so it edits like one ───────────
  function addWatchTarget(chosen: readonly TargetClassArg[], cls: TargetClassArg): void {
    if (chosen.includes(cls)) return;
    onWatchFight({ targets: [...chosen, cls] });
  }
  function removeWatchTarget(chosen: readonly TargetClassArg[], cls: TargetClassArg): void {
    onWatchFight({ targets: chosen.filter((c) => c !== cls) });
  }
  function moveWatchTarget(chosen: readonly TargetClassArg[], index: number, delta: -1 | 1): void {
    const target = index + delta;
    if (target < 0 || target >= chosen.length) return;
    const classes = [...chosen];
    [classes[index], classes[target]] = [classes[target], classes[index]];
    onWatchFight({ targets: classes });
  }
  function propModeValue(step: MacroStep, key: string): string {
    const arg = argOf(step, key);
    return arg !== undefined && arg.kind === "propMode" ? arg.mode : "auto";
  }
  function setPropMode(key: string, raw: string): void {
    // "auto" is the default, so it is DROPPED rather than stored — an untouched
    // step exports exactly as it was imported, same rule as the rock pick and
    // the squad role above.
    onArg(key, raw === "off" ? { kind: "propMode", mode: "off" } : undefined);
  }
  function setSquadRole(key: string, raw: string): void {
    // "off" is the default, so it is DROPPED rather than stored — an untouched
    // step exports exactly as it was imported, same rule as the rock pick.
    onArg(key, raw === "call" || raw === "follow" ? { kind: "squadRole", role: raw } : undefined);
  }
  function setWorldRef(arg: ArgDescriptor, ref: WorldRef): void {
    onArg(
      arg.key,
      arg.kind === "destination"
        ? { kind: "destination", ref }
        : arg.kind === "system"
          ? { kind: "system", ref }
          : { kind: "station", ref },
    );
  }

  // ── The ore priority list: search, add, reorder, remove ─────────────────────
  // Text typed into the search box, kept here rather than in `BotBuilder.svelte`
  // — it is throwaway UI state, gone the moment a family is picked, not part of
  // the saved document the way `ores` itself is.
  let oreQuery = $state("");
  /** Up to 8 families whose name contains the typed text, already-chosen ones
   * excluded, starts-with matches first. Nothing shown under two characters —
   * the same threshold `StationPicker.svelte` uses before it searches. */
  function oreMatches(
    query: string,
    chosen: readonly { groupID: number; name: string }[],
  ): readonly { groupID: number; name: string }[] {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const chosenIDs = new Set(chosen.map((o) => o.groupID));
    return oreFamilies
      .filter((f) => !chosenIDs.has(f.groupID) && f.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const aStarts = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bStarts = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        return aStarts !== bStarts ? aStarts - bStarts : a.name.localeCompare(b.name);
      })
      .slice(0, 8);
  }
  function addOre(key: string, chosen: readonly { groupID: number; name: string }[], family: { groupID: number; name: string }): void {
    if (chosen.length >= MAX_ORE_LIST || chosen.some((o) => o.groupID === family.groupID)) return;
    onArg(key, { kind: "oreList", ores: [...chosen, { groupID: family.groupID, name: family.name }] });
    oreQuery = "";
  }
  function removeOre(key: string, chosen: readonly { groupID: number; name: string }[], groupID: number): void {
    const ores = chosen.filter((o) => o.groupID !== groupID);
    // Back to the default: an emptied list is dropped rather than saved empty,
    // so an untouched — or fully cleared — step exports exactly as imported.
    onArg(key, ores.length === 0 ? undefined : { kind: "oreList", ores });
  }
  // ── Target priority: an ORDERED pick over a fixed four-word vocabulary, so
  // there is nothing to search — the classes not yet in the ladder are offered
  // as buttons, and the ones in it are ordered exactly like the ore list.
  function targetListValue(step: MacroStep, key: string): readonly TargetClassArg[] {
    const arg = step.args[key];
    return arg !== undefined && arg.kind === "targetList" ? arg.classes : [];
  }
  function addTargetClass(key: string, chosen: readonly TargetClassArg[], cls: TargetClassArg): void {
    if (chosen.includes(cls)) return;
    onArg(key, { kind: "targetList", classes: [...chosen, cls] });
  }
  function removeTargetClass(key: string, chosen: readonly TargetClassArg[], cls: TargetClassArg): void {
    const classes = chosen.filter((c) => c !== cls);
    // An emptied ladder is DROPPED rather than saved empty — the step goes back
    // to the shipped order, which is what clearing the picker asks for.
    onArg(key, classes.length === 0 ? undefined : { kind: "targetList", classes });
  }
  function moveTargetClass(key: string, chosen: readonly TargetClassArg[], index: number, delta: -1 | 1): void {
    const target = index + delta;
    if (target < 0 || target >= chosen.length) return;
    const classes = [...chosen];
    [classes[index], classes[target]] = [classes[target], classes[index]];
    onArg(key, { kind: "targetList", classes });
  }
  function moveOre(key: string, chosen: readonly { groupID: number; name: string }[], index: number, delta: -1 | 1): void {
    const target = index + delta;
    if (target < 0 || target >= chosen.length) return;
    const ores = [...chosen];
    [ores[index], ores[target]] = [ores[target], ores[index]];
    onArg(key, { kind: "oreList", ores });
  }

  // ── Which arguments are visible, and which sit behind "More options" ────────
  /**
   * Apple's action-summary rule, cited in the design doc: the required
   * arguments, plus any optional one the player has ALREADY set — a choice
   * already made must not hide itself behind a disclosure the next time the
   * step is opened.
   */
  function summaryArgs(step: MacroStep): readonly ArgDescriptor[] {
    return MACRO_ARG_DESCRIPTORS[step.macro].all.filter((arg) => arg.required || step.args[arg.key] !== undefined);
  }
  function moreArgs(step: MacroStep): readonly ArgDescriptor[] {
    return MACRO_ARG_DESCRIPTORS[step.macro].all.filter((arg) => !arg.required && step.args[arg.key] === undefined);
  }
  function offersUntil(step: MacroStep): boolean {
    return MACRO_ARG_DESCRIPTORS[step.macro].untilOffered || step.until !== undefined;
  }
  function untilRequired(step: MacroStep): boolean {
    return MACRO_ARG_DESCRIPTORS[step.macro].untilRequired;
  }

  // ── Condition edits, reported whole ─────────────────────────────────────────
  function conditionOf(): Condition | undefined {
    if (target.kind === "step") return target.step.until;
    if (target.kind === "branch") return target.branch.when;
    if (target.kind === "watch") return target.watch.when;
    return undefined;
  }
  function changeKind(raw: string): void {
    onCondition(raw === "" ? undefined : freshCondition(raw as ConditionKind, conditionOf()));
  }
  function changeFraction(percent: number): void {
    const current = conditionOf();
    if (current === undefined || !("fraction" in current)) return;
    onCondition({ ...current, fraction: clampConditionFraction(percent / 100, current.kind) });
  }
  function changeIsk(raw: number): void {
    const current = conditionOf();
    if (current === undefined || !("isk" in current)) return;
    onCondition({ ...current, isk: clampConditionIsk(raw) });
  }

  const heading = $derived(
    target.kind === "step"
      ? macroEntry(target.step.macro).name
      : target.kind === "branch"
        ? "A fork in the plan"
        : target.kind === "sub-bot"
          ? "Another saved bot"
          : `Watch — ${CONDITION_NOUN_LABEL[target.watch.when.kind]}`,
  );
</script>

<!-- A condition is edited in three places — a watch, a step's "stop when" and a
     branch's fork — and the three must never drift apart in what they offer or
     in how a threshold reads, so they are ONE block driven by `target.kind`. -->
{#snippet conditionEditor(id: string, label: string, kinds: readonly ConditionKind[], labels: Readonly<Record<ConditionKind, string>>, noneLabel: string | null)}
  {@const condition = conditionOf()}
  <label class="inspector-field" for={`${id}-kind`}>
    <span class="inspector-label">{label}</span>
    <select id={`${id}-kind`} value={condition?.kind ?? ""} onchange={(e) => changeKind(e.currentTarget.value)}>
      {#if noneLabel !== null}
        <option value="">{noneLabel}</option>
      {/if}
      {#each kinds as kind (kind)}
        <option value={kind}>{labels[kind]}</option>
      {/each}
    </select>
  </label>
  {#if condition !== undefined && "fraction" in condition}
    <label class="inspector-field" for={`${id}-fraction`}>
      <span class="inspector-label">How far</span>
      <span class="inspector-unit">
        <input
          id={`${id}-fraction`}
          class="num-in"
          type="number"
          min={conditionPercent(CONDITION_FRACTION_BOUNDS.min)}
          max={conditionPercent(conditionFractionCap(condition.kind))}
          value={conditionPercent(condition.fraction)}
          oninput={(e) => changeFraction(Number(e.currentTarget.value))}
        />
        <span class="inspector-suffix">
          % — from {conditionPercent(CONDITION_FRACTION_BOUNDS.min)} to {conditionPercent(conditionFractionCap(condition.kind))}
        </span>
      </span>
    </label>
  {:else if condition !== undefined && "isk" in condition}
    <label class="inspector-field" for={`${id}-isk`}>
      <span class="inspector-label">How much</span>
      <span class="inspector-unit">
        <input
          id={`${id}-isk`}
          class="num-in wide"
          type="number"
          min={MIN_ISK_ARG}
          max={MAX_ISK_ARG}
          step="1000000"
          value={condition.isk}
          oninput={(e) => changeIsk(Number(e.currentTarget.value))}
        />
        <span class="inspector-suffix">ISK</span>
      </span>
    </label>
  {/if}
{/snippet}

<!-- One argument, drawn from its DESCRIPTOR rather than from a chain of
     `{#if step.macro === "..."}` branches. `ArgDescriptor.widget` comes from
     `ARG_KIND_WIDGET`, a `Record` over every `Arg["kind"]`, so a new argument
     kind is a compile error in `editorOptions.ts` before it can ever arrive
     here with no control to draw. That is the whole point of this switch: it
     is the last hand-written thing, and it is written once for all 50 macros. -->
{#snippet argField(step: MacroStep, arg: ArgDescriptor)}
  {@const fieldId = `arg-${step.id}-${arg.key}`}
  {@const bounds = argBounds(step.macro, arg)}
  {#if arg.widget === "corp-division-select"}
    {@const chosenDivision = corpDivisionValue(step, arg.key)}
    {@const stationArg = argOf(step, "station")}
    <div class="inspector-field">
      <span class="inspector-label">
        {arg.label}{#if !arg.required}<span class="inspector-optional"> - optional</span>{/if}
      </span>
      <CorpHangarPicker
        {flow}
        value={chosenDivision}
        station={stationArg !== undefined && stationArg.kind === "station" ? stationArg.ref : null}
        onPick={(picked) =>
          onArg(
            arg.key,
            picked === null
              ? undefined
              : { kind: "corpDivision", division: picked.division, name: picked.name },
          )}
      />
    </div>
  {:else if arg.widget === "station-picker" || arg.widget === "destination-picker" || arg.widget === "system-picker"}
    <div class="inspector-field">
      <span class="inspector-label">{arg.label}</span>
      <StationPicker
        {flow}
        value={worldRefValue(step, arg.key, arg.kind)}
        current={currentStation}
          scope={arg.widget === "destination-picker" ? "any" : arg.widget === "system-picker" ? "system" : arg.dockable ? "dockable" : "station"}
        onPick={(ref) => setWorldRef(arg, ref)}
      />
    </div>
  {:else if arg.widget === "item-list-picker"}
    {@const chosenKeep = itemListValue(step, arg.key)}
    {@const keepHits = keepMatches(keepQuery)}
    <div class="inspector-field">
      <span class="inspector-label">
        {arg.label}{#if !arg.required}<span class="inspector-optional"> - optional</span>{/if}
      </span>
      <span class="inspector-suffix">{itemListHint(arg.key)}</span>
      <input
        id={fieldId}
        type="text"
        placeholder="search what is here by name"
        value={keepQuery}
        oninput={(e) => (keepQuery = e.currentTarget.value)}
      />
      {#if keepQuery.trim().length > 0}
        <!--
          The WILDCARD entry, offered from what the player typed rather than
          from a row they clicked — because the whole point of a pattern is to
          catch the things that are NOT in this hangar right now (the next
          twenty command centres, bought after the bot was written).
        -->
        <button
          type="button"
          class="pick-row"
          onclick={() =>
            addKeep(arg.key, chosenKeep, {
              match: "name",
              pattern: keepQuery.trim(),
              name: `everything matching "${keepQuery.trim()}"`,
            })}
        >
          <span class="pick-main"><span class="pick-name">Everything matching "{keepQuery.trim()}"</span></span>
        </button>
      {/if}
      {#if keepHits.length > 0}
        <ul class="market-picker">
          {#each keepHits as hit (hit.typeID)}
            <li>
              <button
                type="button"
                class="pick-row"
                onclick={() => addKeep(arg.key, chosenKeep, { match: "type", typeID: hit.typeID, name: hit.name })}
              >
                <span class="pick-main"><span class="pick-name">{hit.name}</span></span>
              </button>
              {#if hit.groupID !== null && hit.groupID !== undefined}
                <button
                  type="button"
                  class="pick-row"
                  onclick={() =>
                    addKeep(arg.key, chosenKeep, {
                      match: "group",
                      groupID: hit.groupID as number,
                      name: `items like ${hit.name}`,
                    })}
                >
                  <span class="pick-main"><span class="pick-name">All like this</span></span>
                </button>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
      {#if items.length === 0}
        <span class="inspector-suffix">Nothing is in the hangar or cargo to pick from.</span>
      {/if}
      {#if chosenKeep.length > 0}
        <ul class="keep-list">
          {#each chosenKeep as entry (keepId(entry))}
            <li>
              <span>{entry.name}</span>
              <button type="button" onclick={() => removeKeep(arg.key, chosenKeep, keepId(entry))}>Remove</button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {:else if arg.widget === "bay-list-picker"}
    {@const chosenBays = bayListValue(step, arg.key)}
    <div class="inspector-field">
      <span class="inspector-label">
        {arg.label}{#if !arg.required}<span class="inspector-optional"> - optional</span>{/if}
      </span>
      <span class="inspector-suffix">
        A bay left alone is neither emptied here nor filled with loot.
      </span>
      <ul class="bay-list">
        {#each PROTECTABLE_BAYS as candidate (candidate.key)}
          <li>
            <label>
              <input
                type="checkbox"
                checked={chosenBays.includes(candidate.key)}
                onchange={() => toggleBay(arg.key, chosenBays, candidate.key)}
              />
              {candidate.label}
            </label>
          </li>
        {/each}
      </ul>
    </div>
  {:else if arg.widget === "ore-list-picker"}
    {@const chosen = oreListValue(step, arg.key)}
    {@const matches = oreMatches(oreQuery, chosen)}
    <div class="inspector-field">
      <span class="inspector-label">
        {arg.label}{#if !arg.required}<span class="inspector-optional"> — optional</span>{/if}
      </span>
      <input
        id={fieldId}
        type="text"
        placeholder="search ore by name…"
        value={oreQuery}
        oninput={(e) => (oreQuery = e.currentTarget.value)}
      />
      {#if matches.length > 0}
        <ul class="market-picker">
          {#each matches as family (family.groupID)}
            <li>
              <button type="button" class="pick-row" onclick={() => addOre(arg.key, chosen, family)}>
                <span class="pick-main"><span class="pick-name">{family.name}</span></span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
      {#if oreFamilies.length === 0}
        <span class="inspector-suffix">Ore names could not be loaded.</span>
      {/if}
      {#if chosen.length > 0}
        <ol class="ore-priority-list">
          {#each chosen as ore, index (ore.groupID)}
            <li>
              <span class="ore-priority-rank">{index + 1}.</span>
              <span class="ore-priority-name">{ore.name}</span>
              <button type="button" class="minor" disabled={index === 0} onclick={() => moveOre(arg.key, chosen, index, -1)}>
                Move up
              </button>
              <button
                type="button"
                class="minor"
                disabled={index === chosen.length - 1}
                onclick={() => moveOre(arg.key, chosen, index, 1)}
              >
                Move down
              </button>
              <button type="button" class="danger" onclick={() => removeOre(arg.key, chosen, ore.groupID)}>Remove</button>
            </li>
          {/each}
        </ol>
      {/if}
      <span class="inspector-suffix">
        First is mined first. Every grade of an ore counts; richer grades are mined before poorer ones.
        Leave this empty and the bot mines whatever is worth most per cubic metre on the belt — name an
        ore here only when you want that ore in particular.
      </span>
    </div>
  {:else if arg.widget === "target-list-picker"}
    {@const chosenTargets = targetListValue(step, arg.key)}
    {@const offered = TARGET_CLASS_ARGS.filter((cls) => !chosenTargets.includes(cls))}
    <div class="inspector-field">
      <span class="inspector-label">
        {arg.label}{#if !arg.required}<span class="inspector-optional"> — optional</span>{/if}
      </span>
      {#if offered.length > 0}
        <ul class="market-picker">
          {#each offered as cls (cls)}
            <li>
              <button type="button" class="pick-row" onclick={() => addTargetClass(arg.key, chosenTargets, cls)}>
                <span class="pick-main"><span class="pick-name">{targetClassWord(cls)}</span></span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
      {#if chosenTargets.length > 0}
        <ol class="ore-priority-list">
          {#each chosenTargets as cls, index (cls)}
            <li>
              <span class="ore-priority-rank">{index + 1}.</span>
              <span class="ore-priority-name">{targetClassWord(cls)}</span>
              <button
                type="button"
                class="minor"
                disabled={index === 0}
                onclick={() => moveTargetClass(arg.key, chosenTargets, index, -1)}
              >
                Move up
              </button>
              <button
                type="button"
                class="minor"
                disabled={index === chosenTargets.length - 1}
                onclick={() => moveTargetClass(arg.key, chosenTargets, index, 1)}
              >
                Move down
              </button>
              <button type="button" class="danger" onclick={() => removeTargetClass(arg.key, chosenTargets, cls)}>
                Remove
              </button>
            </li>
          {/each}
        </ol>
      {/if}
      <span class="inspector-suffix">
        First is shot first; the nearest one wins inside a group. Anything you leave out is still
        shot, just last. Left empty: tacklers, then jammers, then logistics, then everything else.
      </span>
    </div>
  {:else if arg.widget === "fitting-picker"}
    <!-- Not inside a <label>: a click on an option would also activate the
         labelled trigger and open the list again. -->
    {@const picked = fittingValue(step, arg.key)}
    <div class="inspector-field">
      <span class="inspector-label">
        {arg.label}{#if !arg.required}<span class="inspector-optional"> — optional</span>{/if}
      </span>
      <FittingSelect
        id={fieldId}
        {fittings}
        value={picked === "" ? null : Number(picked)}
        onPick={(fittingID) => setFitting(arg.key, String(fittingID))} />
    </div>
  {:else}
    <label class="inspector-field" for={fieldId}>
      <span class="inspector-label">
        {arg.label}{#if !arg.required}<span class="inspector-optional"> — optional</span>{/if}
      </span>
      {#if arg.widget === "belt-picker"}
        <select
          id={fieldId}
          value={beltMode(step, arg.key)}
          onchange={(e) => setBeltMode(step, arg.key, e.currentTarget.value)}
        >
          <option value="nearest">the nearest belt</option>
          <option value="site">the scanner's ore sites</option>
          {#if step.macro !== "fleet-mine"}<option value="ice-site">the scanner's ice sites</option>{/if}
          <option value="named">a belt I name</option>
        </select>
        {#if beltMode(step, arg.key) === "named"}
          <input
            id={`${fieldId}-name`}
            type="text"
            maxlength={MAX_WORLD_NAME_LEN}
            placeholder="Otanuomi VI - Asteroid Belt 1"
            aria-label="Belt name"
            value={beltName(step, arg.key)}
            oninput={(e) => setBeltName(arg.key, e.currentTarget.value)}
          />
          <span class="inspector-suffix">
            Type it exactly as the overview shows it — the bot looks for a belt of
            that name when it gets to the system, and stops if there is none.
          </span>
        {/if}
      {:else if arg.widget === "equipment-picker"}
        <select id={fieldId} value={equipmentValue(step, arg.key)} onchange={(e) => setEquipment(arg.key, e.currentTarget.value)}>
          <option value="">use everything fitted</option>
          {#each equipment as eq (eq.groupID)}<option value={String(eq.groupID)}>{eq.label}</option>{/each}
        </select>
      {:else if arg.widget === "agent-picker"}
        <select id={fieldId} value={agentValue(step, arg.key)} onchange={(e) => setAgent(arg.key, e.currentTarget.value)}>
          <option value="">use the agent your bot finds</option>
          {#each agents as agent (agent.agentID)}
            <option value={String(agent.agentID)}>{agent.name}{#if agent.stationName} · {agent.stationName}{/if}</option>
          {/each}
        </select>
        {#if agents.length === 0}
          <span class="inspector-suffix">No agents found yet — open the Agent Finder first to pick one by hand.</span>
        {/if}
      {:else if arg.widget === "bookmark-picker"}
        <select id={fieldId} value={bookmarkValue(step, arg.key)} onchange={(e) => setBookmark(arg.key, e.currentTarget.value)}>
          <option value="" disabled>pick a saved spot…</option>
          {#each spots as bm (bm.bookmarkID)}<option value={String(bm.bookmarkID)}>{bm.name}</option>{/each}
        </select>
      {:else if arg.widget === "folder-picker"}
        <select id={fieldId} value={folderValue(step, arg.key)} onchange={(e) => setFolder(arg.key, e.currentTarget.value)}>
          <option value="" disabled>pick a bookmark folder…</option>
          {#each folders as folder (folder.folderID)}<option value={String(folder.folderID)}>{folder.name}</option>{/each}
        </select>
      {:else if arg.widget === "item-type-picker"}
        <select id={fieldId} value={itemTypeValue(step, arg.key)} onchange={(e) => setItemType(arg.key, e.currentTarget.value)}>
          {#if arg.required}
            <option value="" disabled>pick an item…</option>
          {:else}
            <option value="">everything in the hold</option>
          {/if}
          {#each items as it (it.typeID)}<option value={String(it.typeID)}>{it.name}</option>{/each}
        </select>
      {:else if arg.widget === "place-select"}
        <select id={fieldId} value={placeValue(step, arg.key)} onchange={(e) => onArg(arg.key, { kind: "place", place: e.currentTarget.value as never })}>
          {#each PLACE_OPTIONS as place (place.value)}<option value={place.value}>{place.label}</option>{/each}
        </select>
      {:else if arg.widget === "character-picker"}
        <select id={fieldId} value={characterValue(step, arg.key)} onchange={(e) => setCharacter(arg.key, e.currentTarget.value)}>
          {#if arg.required}
            <option value="" disabled>pick a pilot…</option>
          {:else}
            <option value="">any player</option>
          {/if}
          {#each pilots as pilot (pilot.characterID)}
            <option value={String(pilot.characterID)}>{pilot.characterName}</option>
          {/each}
        </select>
        {#if pilots.length === 0}
          <span class="inspector-suffix">No known pilots yet — add one from the login screen.</span>
        {/if}
      {:else if arg.widget === "rock-pick-select"}
        <select id={fieldId} value={rockPickValue(step, arg.key)} onchange={(e) => setRockPick(arg.key, e.currentTarget.value)}>
          <option value="nearest">the nearest rock first</option>
          <option value="biggest">the biggest rock first</option>
          <option value="valuable">the most valuable ore first</option>
        </select>
      {:else if arg.widget === "squad-role-select"}
        <select id={fieldId} value={squadRoleValue(step, arg.key)} onchange={(e) => setSquadRole(arg.key, e.currentTarget.value)}>
          <option value="off">pick its own target</option>
          <option value="call">call the primary for the fleet</option>
          <option value="follow">shoot what the fleet calls</option>
        </select>
      {:else if arg.widget === "prop-mode-select"}
        <select id={fieldId} value={propModeValue(step, arg.key)} onchange={(e) => setPropMode(arg.key, e.currentTarget.value)}>
          <option value="auto">burn in to close the distance</option>
          <option value="off">never switch it on</option>
        </select>
      {:else if arg.widget === "toggle-select"}
        {@const setting = step.args[arg.key]}
        <select id={fieldId} value={setting?.kind === "toggle" && setting.enabled ? "enabled" : "disabled"} onchange={(e) => onArg(arg.key, { kind: "toggle", enabled: e.currentTarget.value === "enabled" })}>
          <option value="disabled">No</option>
          <option value="enabled">Yes</option>
        </select>
      {:else if arg.widget === "corp-picker"}
        <input
          id={fieldId}
          type="text"
          placeholder="any corporation"
          value={corpValue(step, arg.key)}
          oninput={(e) => setCorp(arg.key, e.currentTarget.value)}
        />
      {:else if arg.widget === "planet-list"}
        <!-- Written by the Planetary Industry window's Haul button, never typed:
             shown so the step says what it covers, not offered for editing. -->
        <span class="inspector-unit">{planetListWords(step, arg.key)}</span>
      {:else if arg.widget === "text-input"}
        <input
          id={fieldId}
          type="text"
          maxlength={MAX_TEXT_ARG_LEN}
          placeholder={textPlaceholder(arg.key)}
          value={textValue(step, arg.key)}
          oninput={(e) => onArg(arg.key, { kind: "text", text: e.currentTarget.value.slice(0, MAX_TEXT_ARG_LEN) })}
        />
      {:else}
        <!-- count / isk / qty. The range is SHOWN, not merely enforced: a bound
             a player cannot see is a rule they can only find by breaking it. -->
        <span class="inspector-unit">
          <input
            id={fieldId}
            class="num-in wide"
            type="number"
            min={bounds?.min}
            max={bounds?.max}
            value={numberValue(step, arg.key)}
            oninput={(e) => setNumber(step, arg, e.currentTarget.value)}
          />
          {#if bounds !== null}
            <span class="inspector-suffix">
              {bounds.min} to {bounds.max}{#if !arg.required} · leave it empty for the usual{/if}
            </span>
          {/if}
        </span>
      {/if}
    </label>
  {/if}
{/snippet}

<section class="panel builder-inspector">
  <header class="panel-head">
    <h2>{heading}</h2>
    <div class="controls">
      <button type="button" class="minor inspector-back" onclick={onClose}>Back to the plan</button>
    </div>
  </header>

  {#if target.kind === "step"}
    {@const step = target.step}
    <p class="note">{macroEntry(step.macro).does}</p>
    {#each summaryArgs(step) as arg (arg.key)}
      {@render argField(step, arg)}
    {/each}
    {#if offersUntil(step)}
      {@render conditionEditor(
        `until-${step.id}`,
        "Stop when",
        UNTIL_CONDITION_KINDS,
        CONDITION_UNTIL_LABEL,
        untilRequired(step) ? null : "when the step is done",
      )}
    {/if}
    {#if moreArgs(step).length > 0}
      <details class="more-options">
        <summary>More options</summary>
        {#each moreArgs(step) as arg (arg.key)}
          {@render argField(step, arg)}
        {/each}
      </details>
    {/if}
  {:else if target.kind === "branch"}
    {@const branch = target.branch}
    <p class="note">Runs one set of steps or the other, depending on a check made when the plan reaches it.</p>
    {@render conditionEditor(`branch-${branch.id}`, "If", UNTIL_CONDITION_KINDS, CONDITION_UNTIL_LABEL, null)}
    {#each ["then", "else"] as const as side (side)}
      <label class="inspector-field" for={`branch-${branch.id}-${side}`}>
        <span class="inspector-label">Add a step to “{side === "then" ? "then" : "otherwise"}”</span>
        <select
          id={`branch-${branch.id}-${side}`}
          value=""
          onchange={(e) => {
            onAddToSide(side, e.currentTarget.value as MacroID);
            e.currentTarget.value = "";
          }}
        >
          <option value="">pick a step…</option>
          {#each MACRO_CATALOG_LIST as entry (entry.id)}<option value={entry.id}>{entry.name}</option>{/each}
        </select>
      </label>
    {/each}
  {:else if target.kind === "sub-bot"}
    {@const subBot = target.subBot}
    <p class="note">
      Runs another saved bot from here, as that bot is saved right now. This is a live link, not a copy — and a
      bot that runs another bot cannot repeat as a whole.
    </p>
    <label class="inspector-field" for={`sub-${subBot.id}`}>
      <span class="inspector-label">Which bot</span>
      {#if savedBots.length === 0}
        <span class="inspector-suffix">No saved bots yet — save one first, then come back.</span>
      {:else}
        <select id={`sub-${subBot.id}`} value={subBot.scriptID ?? ""} onchange={(e) => onSubBot(e.currentTarget.value)}>
          <option value="" disabled>pick a saved bot…</option>
          {#each savedBots as meta (meta.scriptID)}<option value={meta.scriptID}>{meta.name}</option>{/each}
        </select>
      {/if}
    </label>
  {:else}
    {@const watch = target.watch}
    <p class="note">{interruptSentence(watch)}</p>
    {@render conditionEditor(`watch-${watch.id}`, "Watch for", WATCH_CONDITION_KINDS, CONDITION_NOUN_LABEL, null)}
    <!-- The one condition whose obvious response cannot work (a held ship cannot
         warp, so it cannot dock either) says so HERE, between the check and the
         response picker, rather than in a rule that refuses the pairing.
         `conditionAdvice` is null for every other kind, so no other watch grows
         a line. -->
    {#if conditionAdvice(watch.when.kind) !== null}
      <p class="note">{conditionAdvice(watch.when.kind)}</p>
    {/if}
    <label class="inspector-field" for={`watch-${watch.id}-respond`}>
      <span class="inspector-label">Then</span>
      <select
        id={`watch-${watch.id}-respond`}
        value={watch.respond}
        onchange={(e) => onRespond(e.currentTarget.value as InterruptResponse)}
      >
        {#each RESPONSE_OPTIONS as option (option.value)}<option value={option.value}>{option.label}</option>{/each}
      </select>
    </label>
    {#if watch.respond === "fight-back"}
      {@const chosenWatchTargets = watch.targets ?? []}
      {@const offeredWatch = TARGET_CLASS_ARGS.filter((cls) => !chosenWatchTargets.includes(cls))}
      <label class="inspector-field" for={`watch-${watch.id}-squad`}>
        <span class="inspector-label">
          With the fleet<span class="inspector-optional"> — optional</span>
        </span>
        <select
          id={`watch-${watch.id}-squad`}
          value={watch.squad ?? "off"}
          onchange={(e) => onWatchFight({ squad: e.currentTarget.value as SquadRoleArg })}
        >
          <option value="off">pick its own target</option>
          <option value="call">call the primary for the fleet</option>
          <option value="follow">shoot what the fleet calls</option>
        </select>
      </label>
      <div class="inspector-field">
        <span class="inspector-label">
          Shoot first<span class="inspector-optional"> — optional</span>
        </span>
        {#if offeredWatch.length > 0}
          <ul class="market-picker">
            {#each offeredWatch as cls (cls)}
              <li>
                <button type="button" class="pick-row" onclick={() => addWatchTarget(chosenWatchTargets, cls)}>
                  <span class="pick-main"><span class="pick-name">{targetClassWord(cls)}</span></span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
        {#if chosenWatchTargets.length > 0}
          <ol class="ore-priority-list">
            {#each chosenWatchTargets as cls, index (cls)}
              <li>
                <span class="ore-priority-rank">{index + 1}.</span>
                <span class="ore-priority-name">{targetClassWord(cls)}</span>
                <button
                  type="button"
                  class="minor"
                  disabled={index === 0}
                  onclick={() => moveWatchTarget(chosenWatchTargets, index, -1)}
                >
                  Move up
                </button>
                <button
                  type="button"
                  class="minor"
                  disabled={index === chosenWatchTargets.length - 1}
                  onclick={() => moveWatchTarget(chosenWatchTargets, index, 1)}
                >
                  Move down
                </button>
                <button type="button" class="danger" onclick={() => removeWatchTarget(chosenWatchTargets, cls)}>
                  Remove
                </button>
              </li>
            {/each}
          </ol>
        {/if}
        <span class="inspector-suffix">
          This is the watch that actually fights while the bot is busy mining or hauling, so the
          fleet settings live here too. Left alone: tacklers, then jammers, then logistics, then
          everything else, and no word to the fleet.
        </span>
      </div>
    {/if}
  {/if}

  {#each problems as problem (problem.sentence)}
    <p class={problem.severity === "blocking" ? "note error" : "note"}>{problem.sentence}</p>
  {/each}
</section>
