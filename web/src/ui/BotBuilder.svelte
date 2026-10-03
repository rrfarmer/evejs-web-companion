<script lang="ts">
  // THE BOT BUILDER — three stacked regions: the watches that run all the time,
  // the numbered plan, and an inspector for whichever row is selected
  // (docs/bot-builder-interface.md §2/§3).
  //
  // THE ROW IS THE SUMMARY. Nothing expands in place: every row prints one
  // sentence from `scriptText.ts`, and every edit happens in the inspector
  // beside it. That is the shape change from the previous editor, which put an
  // inline widget strip inside each row and grew a hand-written
  // `{#if step.macro === "..."}` chain to draw them.
  //
  // WHAT THIS FILE IS NOT ALLOWED TO HOLD:
  //  • display logic — `bots/editorView.ts` flattens the plan into rows,
  //    indexes problems, filters the picker and resolves a selection;
  //  • sentences — `bots/scriptText.ts` is the one R9a register;
  //  • which widget an argument gets — `bots/editorOptions.ts` derives that
  //    from the format, and `BotInspector.svelte` draws it;
  //  • edit operations — `bots/scriptEdit.ts` owns the pure array transforms
  //    the row menus call.
  // Each of those has a `node --test` file that runs without a DOM, which
  // matters more here than usual: Svelte components are NOT type-checked by
  // this project's build (docs/svelte-typecheck-gap.md), so a mistake in a
  // template is only ever caught by an SSR render.
  //
  // Running a bot is not here and never will be: the builder edits, the Bot
  // Manager launches.

  import {
    type Arg,
    type BotScript,
    type Condition,
    type ConditionKind,
    type InterruptResponse,
    type InterruptRow,
    type SquadRoleArg,
    type TargetClassArg,
    type MacroID,
    type MacroStep,
    type ProgramNode,
    type WorldRef,
    MAX_INTERRUPTS,
    MAX_NAME_LEN,
    MAX_NOTES_LEN,
    MAX_REPEAT_TIMES,
    MIN_REPEAT_TIMES,
  } from "../bots/botScript.ts";
  import { CATEGORY_LABEL, categoriesInUse, type BlockCategory } from "../bots/macroCatalogView.ts";
  import {
    newBranch,
    newEditorState,
    newStepFor,
    newSubBot,
    toEditorState,
    toScript,
    hasSubBot as planHasSubBot,
    type EditorState,
    type RepeatMode,
  } from "../bots/editorDoc.ts";
  import {
    builderTarget,
    decideHandoff,
    isStillSaved,
    libraryChanged,
    noteLibraryChanged,
    waitingSentence,
    wantedLabel,
    type BuilderRequest,
  } from "../bots/builderTarget.ts";
  import {
    CONDITION_NOUN_LABEL,
    WATCH_CONDITION_KINDS,
    freshCondition,
  } from "../bots/editorOptions.ts";
  import {
    buildProblemIndex,
    filterMacroPicker,
    findSelectedNode,
    flattenProgram,
    pathHasBlockingProblem,
    problemsForPath,
  } from "../bots/editorView.ts";
  import {
    countingIdGen,
    duplicateNode,
    insertNode,
    insertSavedBotSteps,
    moveInterrupt,
    moveNode,
    removeInterrupt,
    removeNode,
    programIDs,
    type FlatProgramNode,
  } from "../bots/scriptEdit.ts";
  import { EXAMPLE_BOTS, type ExampleBot } from "../bots/exampleBots.ts";
  import { interruptSentence } from "../bots/scriptText.ts";
  import { validateScript } from "../bots/validateScript.ts";
  import { decodeScriptText, decodeScriptValue, encodeScriptDoc } from "../bots/scriptCodec.ts";
  import {
    createBotScript,
    getBotScript,
    listBotScripts,
    listBotCategories,
    type BotCategory,
    updateBotScript,
    type BotScriptSummary,
  } from "../app/api.ts";
  import BotInspector, { type InspectorTarget } from "./BotInspector.svelte";
  import StationPicker from "./StationPicker.svelte";
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { BuilderFlow } from "../bots/builderFlow.ts";
  import { nameKey } from "../store/names.ts";
  import { loadKnownCharacters } from "../app/knownCharacters.ts";

  let { store, flow }: { store: ClientStore; flow: BuilderFlow } = $props();

  // svelte-ignore state_referenced_locally
  const flight = store.flight;
  // svelte-ignore state_referenced_locally
  const inventory = store.inventory;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const fitting = store.fitting;
  // svelte-ignore state_referenced_locally
  const finder = store.finder;

  // ── The document being edited ───────────────────────────────────────────────
  // The list the player sees is what a LOOP BODY may hold (steps and branches),
  // plus sub-bot nodes, which are legal only at the top level — so one list
  // builds either a looping bot or a run-once one, and `repeatMode` decides.
  type EditorNode = FlatProgramNode;

  // The document itself lives in `editorDoc.ts`, not here: `toScript` and
  // `toEditorState` are what decide the JSON a bot is saved as, and inside a
  // component nothing could test them. These fields are that state, spread into
  // runes so the template can bind to them.
  const initial = newEditorState();
  let name = $state(initial.name);
  let notes = $state(initial.notes);
  let repeatMode = $state<RepeatMode>(initial.repeatMode);
  let repeatCount = $state(initial.repeatCount);
  let home = $state<WorldRef>(initial.home);
  let watches = $state<InterruptRow[]>([...initial.watches]);
  let steps = $state<EditorNode[]>([...initial.steps]);
  let startupCount = $state(0);

  // A program the one-list editor cannot hold — several loops, or a loop beside
  // loose steps — is kept VERBATIM here so it still runs and round-trips
  // unmangled, and the plan renders it read-only rather than silently dropping
  // the parts it cannot edit.
  let advancedProgram = $state<readonly ProgramNode[] | null>(initial.advancedProgram);
  // The outer loop's own id and stop condition, carried so that opening a bot
  // and saving it does not rename its loop or drop the only thing that could
  // stop it early. Neither has a control; both are part of the document.
  let loopID = $state<string | null>(initial.loopID);
  let loopUntil = $state<Condition | undefined>(initial.loopUntil);
  const readOnlyPlan = $derived(advancedProgram !== null);

  // Ids are handed out by a generator that reads the document first, so an id a
  // LOADED bot already carries is skipped rather than handed out twice (see
  // `countingIdGen`). `idsInUse` is that reading: every id the editor's own
  // lookups can land on - the plan (whichever of the two shapes is live), the
  // watches, and the loop wrapper - because they all share one namespace.
  const idsInUse = (): ReadonlySet<string> => {
    const used = programIDs(steps as readonly ProgramNode[]);
    if (advancedProgram !== null) {
      for (const id of programIDs(advancedProgram)) used.add(id);
    }
    for (const row of watches) used.add(row.id);
    if (loopID !== null) used.add(loopID);
    return used;
  };
  const makeId = countingIdGen(idsInUse);

  // ── What is selected, and what is open ──────────────────────────────────────
  // ONE selection drives the inspector, and it can be a plan row OR a watch
  // row: a watch is a sentence in its own region (§2 "Region 1"), so its
  // threshold and its response have nowhere else to be edited.
  type Selection = { readonly kind: "step"; readonly id: string } | { readonly kind: "watch"; readonly id: string };
  let selection = $state<Selection | null>(null);
  /** Which row's ⋮ menu is open — at most one, and never on first render. */
  let menuFor = $state<string | null>(null);
  let stepPickerOpen = $state(false);
  let watchPickerOpen = $state(false);
  let pickerQuery = $state("");
  let pickerCategory = $state<BlockCategory | null>(null);

  let importText = $state("");
  let importNote = $state<string | null>(null);
  let insertNote = $state<string | null>(null);
  let saveConflict = $state<string | null>(null);

  // The saved bots are still read here, but ONLY to fill the two pickers that
  // compose one bot out of another (the by-value step insert, and the sub-bot
  // node's chooser). The library itself — every saved bot, with Edit, Export
  // and Delete — belongs to the Bot Manager, which is the window that lists
  // them; a second list here with a Load button beside every row is what made
  // the Manager's own Edit button unable to open anything.
  let savedList = $state<BotScriptSummary[]>([]);
  /**
   * The library's categories, for the Category menu beside the name. A bot is
   * filed in one or none; null is Uncategorized. `savedCategoryID` is where
   * the server has it, so a changed menu reads as an unsaved change.
   */
  let categories = $state<BotCategory[]>([]);
  let categoryID = $state<string | null>(null);
  let savedCategoryID = $state<string | null>(null);
  let currentSavedId = $state<string | null>(null);
  let currentRev = $state(0);
  let libraryError = $state<string | null>(null);
  /**
   * The name of the saved bot being edited, or null when this draft has never
   * been saved.
   *
   * ⚠ IT FALLS BACK TO THE NAME FIELD, because the list is not what says a bot
   * is open — `currentSavedId` is. The library read can be in flight, can have
   * failed, and does not yet hold a row this pilot's other tab saved a second
   * ago; reading "New bot" off a missing row would say the flatly wrong thing
   * about a bot that Save is about to overwrite.
   */
  const openedName = $derived(
    currentSavedId === null ? null : (savedList.find((meta) => meta.scriptID === currentSavedId)?.name ?? name),
  );


  const pickerCategories = categoriesInUse();

  // ── Derived ─────────────────────────────────────────────────────────────────
  const stations = $derived.by<{ id: number; name: string }[]>(() => {
    const out: { id: number; name: string }[] = [];
    const st = $flight.status;
    if (st !== null && st.docked && st.stationID !== null) {
      out.push({ id: st.stationID, name: $flight.stationName ?? "This station" });
    }
    return out;
  });
  const currentStation = $derived<{ id: number; name: string } | null>(stations[0] ?? null);
  const someWatchDocks = $derived(
    watches.some((w) => w.respond === "dock-and-pause" || w.respond === "dock-and-repair"),
  );
  const hasSubBot = $derived(planHasSubBot(steps.slice(startupCount)));

  const builtDoc = $derived<BotScript>(buildScript());
  const problems = $derived(validateScript(builtDoc));
  const problemIndex = $derived(buildProblemIndex(problems));
  // The header badge counts what a player has to go and fix; Save reads
  // `hasBlocking`. An advisory is in neither — it never stops a save.
  const blockingCount = $derived(problems.filter((p) => p.severity === "blocking").length);

  // ── Has this draft been changed since it was last loaded or saved? ──────────
  //
  // ⚠ IT IS COMPARED, NOT FLAGGED. A boolean set by every edit path is a
  // boolean that one edit path forgets to set, and the cost of it being wrong
  // here is a player's unsaved bot silently replaced when the Bot Manager asks
  // for another one. The document already has one canonical text form
  // (`encodeScriptDoc` — the same form Export writes and a saved record holds),
  // so "changed" is that text differing from what was last loaded or saved,
  // which also makes a change typed and then undone by hand honestly not a
  // change.
  let baselineText = $state(encodeScriptDoc(buildScript()));
  // The category is saved with the bot, so a changed category is an unsaved
  // change like any other: Save completes it, and opening another bot waits.
  const dirty = $derived(encodeScriptDoc(builtDoc) !== baselineText || categoryID !== savedCategoryID);

  // The rows of "the plan". A preserved advanced program renders its real
  // structure — loop headers and branch sides — rather than a flattened guess.
  const planRows = $derived(flattenProgram(advancedProgram ?? (steps as readonly ProgramNode[])));

  /** What the inspector is looking at, or null when the region collapses. */
  const inspectorTarget = $derived.by<InspectorTarget | null>(() => {
    if (selection === null) {
      return null;
    }
    if (selection.kind === "watch") {
      const row = watches.find((w) => w.id === selection.id);
      return row === undefined ? null : { kind: "watch", watch: row };
    }
    const found = findSelectedNode(steps as readonly ProgramNode[], selection.id);
    if (found === null) {
      // A stale id — the row was deleted between the click and this render.
      return null;
    }
    const node = found.node;
    if (node.kind === "macro") return { kind: "step", step: node };
    if (node.kind === "branch") return { kind: "branch", branch: node };
    if (node.kind === "sub-bot") return { kind: "sub-bot", subBot: node };
    return null; // a loop header is never selectable
  });
  const selectedProblems = $derived(selection === null ? [] : problemsForPath(problemIndex, selection.id));
  const pickerResults = $derived(filterMacroPicker(pickerQuery, pickerCategory));

  /** The document as it would be saved right now — one call into the tested
   * pure builder, so what Save writes is what `editorDoc.test.ts` proves. */
  function buildScript(): BotScript {
    return toScript({
      name,
      notes,
      repeatMode,
      repeatCount,
      home,
      watches,
      steps: steps.slice(startupCount),
      startup: steps.slice(0, startupCount),
      advancedProgram,
      loopID,
      loopUntil,
    });
  }

  // ── Finding a row in the list ───────────────────────────────────────────────
  // The format's nesting is exactly two deep here (a branch's sides hold plain
  // steps and nothing else), so a row is either a top-level entry or one step
  // inside one side of one branch. Every row menu dispatches on this.
  type Spot =
    | { readonly scope: "top"; readonly index: number }
    | { readonly scope: "side"; readonly branchIndex: number; readonly side: "then" | "else"; readonly index: number };

  function locate(id: string): Spot | null {
    for (let i = 0; i < steps.length; i += 1) {
      const node = steps[i];
      if (node === undefined) continue;
      if (node.id === id) {
        return { scope: "top", index: i };
      }
      if (node.kind === "branch") {
        const then = node.then.findIndex((s) => s.id === id);
        if (then >= 0) return { scope: "side", branchIndex: i, side: "then", index: then };
        const other = node.else.findIndex((s) => s.id === id);
        if (other >= 0) return { scope: "side", branchIndex: i, side: "else", index: other };
      }
    }
    return null;
  }

  /** Replace one branch side's steps, leaving the rest of the list untouched. */
  function withSide(branchIndex: number, side: "then" | "else", next: readonly ProgramNode[]): void {
    const list = [...(next as readonly MacroStep[])];
    steps = steps.map((node, i) =>
      i === branchIndex && node.kind === "branch"
        ? side === "then"
          ? { ...node, then: list }
          : { ...node, else: list }
        : node,
    );
  }

  // ── The row menu (§3 "Reorder") ─────────────────────────────────────────────
  // Move up / down / to top / to bottom, Duplicate, Delete — the tested
  // Atlassian shape, and no drag anywhere (WCAG 2.2 SC 2.5.7 makes a drag-only
  // reorder a failure, and the one study with usability data found buttons
  // FASTER than dragging and needing no instruction). Every one of these is a
  // pure transform from `scriptEdit.ts`; "to top"/"to bottom" are a remove plus
  // an insert rather than a new operation, so there is still one idea of what
  // moving a node means.
  //
  // A branch's sides are `MacroStep[]`, and a `MacroStep` IS a `ProgramNode`,
  // so the same four operations serve both lists without a second copy of them.
  type Move = "up" | "down" | "top" | "bottom";

  function reorder(list: readonly ProgramNode[], index: number, move: Move): readonly ProgramNode[] {
    if (move === "up" || move === "down") {
      return moveNode(list, index, move === "up" ? -1 : 1);
    }
    const node = list[index];
    if (node === undefined) {
      return list;
    }
    const without = removeNode(list, index);
    return insertNode(without, node, move === "top" ? 0 : without.length);
  }

  function moveRow(id: string, move: Move): void {
    const spot = locate(id);
    if (spot === null) return;
    menuFor = null;
    if (spot.scope === "top") {
      const start = spot.index < startupCount ? 0 : startupCount;
      const end = spot.index < startupCount ? startupCount : steps.length;
      steps = [...steps.slice(0, start), ...reorder(steps.slice(start, end) as readonly ProgramNode[], spot.index - start, move),
        ...steps.slice(end)] as EditorNode[];
      return;
    }
    const branch = steps[spot.branchIndex];
    if (branch === undefined || branch.kind !== "branch") return;
    withSide(spot.branchIndex, spot.side, reorder(spot.side === "then" ? branch.then : branch.else, spot.index, move));
  }

  function duplicateRow(id: string): void {
    const spot = locate(id);
    if (spot === null) return;
    menuFor = null;
    if (spot.scope === "top") {
      steps = duplicateNode(steps as readonly ProgramNode[], spot.index, makeId) as EditorNode[];
      if (spot.index < startupCount) startupCount += 1;
      return;
    }
    const branch = steps[spot.branchIndex];
    if (branch === undefined || branch.kind !== "branch") return;
    withSide(
      spot.branchIndex,
      spot.side,
      duplicateNode(spot.side === "then" ? branch.then : branch.else, spot.index, makeId),
    );
  }

  function deleteRow(id: string): void {
    const spot = locate(id);
    if (spot === null) return;
    menuFor = null;
    if (selection !== null && selection.kind === "step" && selection.id === id) {
      selection = null;
    }
    if (spot.scope === "top") {
      steps = removeNode(steps as readonly ProgramNode[], spot.index) as EditorNode[];
      if (spot.index < startupCount) startupCount -= 1;
      return;
    }
    const branch = steps[spot.branchIndex];
    if (branch === undefined || branch.kind !== "branch") return;
    withSide(spot.branchIndex, spot.side, removeNode(spot.side === "then" ? branch.then : branch.else, spot.index));
  }

  function selectRow(id: string): void {
    menuFor = null;
    selection = selection !== null && selection.kind === "step" && selection.id === id ? null : { kind: "step", id };
  }

  function moveSection(id: string): void {
    const spot = locate(id);
    if (!spot || spot.scope !== "top" || repeatMode === "once" || hasSubBot || readOnlyPlan) return;
    const node = steps[spot.index];
    if (!node || node.kind === "sub-bot") return;
    const fromStartup = spot.index < startupCount;
    const remaining = steps.filter((_, index) => index !== spot.index);
    if (fromStartup) startupCount -= 1;
    remaining.splice(startupCount, 0, node);
    if (!fromStartup) startupCount += 1;
    steps = remaining; menuFor = null;
  }
  function selectWatch(id: string): void {
    menuFor = null;
    selection = selection !== null && selection.kind === "watch" && selection.id === id ? null : { kind: "watch", id };
  }
  function toggleMenu(id: string): void {
    menuFor = menuFor === id ? null : id;
  }

  // ── Adding to the plan ──────────────────────────────────────────────────────
  /** Append a node, select it, and open the inspector on it (§3 "Add a step"). */
  function appendNode(node: EditorNode): void {
    if (readOnlyPlan || (startupCount > 0 && node.kind === "sub-bot")) return;
    steps = insertNode(steps as readonly ProgramNode[], node) as EditorNode[];
    selection = { kind: "step", id: node.id };
  }

  function addStep(macro: MacroID): void {
    appendNode(newStepFor(macro, makeId));
    stepPickerOpen = false;
    pickerQuery = "";
  }
  function addBranch(): void {
    appendNode(newBranch(makeId));
  }
  function addSubBot(): void {
    appendNode(newSubBot(makeId));
  }

  // ── Watches ─────────────────────────────────────────────────────────────────
  function hasWatch(kind: ConditionKind): boolean {
    return watches.some((w) => w.when.kind === kind);
  }
  function addWatch(kind: ConditionKind): void {
    if (hasWatch(kind) || watches.length >= MAX_INTERRUPTS) return;
    // Sensible first responses: money, a full hold and an empty one are not
    // dangers, so they just stop; a pirate gets fought (drones out AND pointed
    // at it — "send out drones" leaves them to defend themselves, which reads to
    // players as the bot ignoring the pirate, so it is no longer the default);
    // being targeted is news rather than damage, so it tells you; anything about
    // health heads home.
    // ⚠ `tackled` DEFAULTS TO FIGHTING, AND ANYTHING ELSE WOULD BE A TRAP. It is
    // the one condition whose obvious first response is impossible: a held ship
    // cannot warp, so it cannot dock either, and the "dock-and-pause" fallback
    // below would hand every new tackle watch a row that can only ever fail.
    // Killing what is holding the ship is the only response that frees it.
    const respond: InterruptResponse =
      kind === "hostile-on-grid" || kind === "tackled"
        ? "fight-back"
        : kind === "targeted-by-player"
          ? "alert"
          : kind === "wallet-below" ||
              kind === "wallet-above" ||
              kind === "cargo-full" ||
              kind === "ore-hold-at-least" ||
              kind === "hold-empty"
            ? "pause"
            : "dock-and-pause";
    const row: InterruptRow = { id: makeId(), when: freshCondition(kind), respond };
    watches = [...watches, row];
    watchPickerOpen = false;
    selection = { kind: "watch", id: row.id };
  }
  function removeWatch(id: string): void {
    menuFor = null;
    if (selection !== null && selection.kind === "watch" && selection.id === id) {
      selection = null;
    }
    watches = [...removeInterrupt(watches, id)];
  }
  function moveWatch(id: string, delta: number): void {
    menuFor = null;
    watches = [...moveInterrupt(watches, id, delta)];
  }
  /**
   * Pair an existing watch with an "alert me" row for the SAME check — the
   * "tell me, and also do the thing" combination.
   *
   * ⚠ THE NEW ROW GOES ABOVE THE ONE IT PAIRS WITH, and that is not cosmetic.
   * Watches are first-match-wins: below, the dock row would fire first and the
   * alert would never speak. Above, the alert speaks once, marks itself spent,
   * and from then on the scan skips it and reaches the dock row underneath.
   */
  function addAlertFor(row: InterruptRow): void {
    menuFor = null;
    if (watches.length >= MAX_INTERRUPTS) return;
    const at = watches.findIndex((w) => w.id === row.id);
    if (at < 0) return;
    const alertRow: InterruptRow = { id: makeId(), when: row.when, respond: "alert" };
    watches = [...watches.slice(0, at), alertRow, ...watches.slice(at)];
  }
  /** True when this row already has an "alert me" twin (so we offer it once). */
  function hasAlertTwin(row: InterruptRow): boolean {
    return watches.some((w) => w.respond === "alert" && w.when.kind === row.when.kind);
  }

  // ── Applying what the inspector reports ─────────────────────────────────────
  // The inspector holds nothing: it reads a node and says what changed. These
  // four put that back into the document, addressed by the SELECTION rather
  // than by an index, so a step edits the same way wherever it sits — top
  // level, or inside one side of a branch.
  function updateStepById(id: string, fn: (step: MacroStep) => MacroStep): void {
    steps = steps.map((node) => {
      if (node.id === id) {
        return node.kind === "macro" ? fn(node) : node;
      }
      if (node.kind !== "branch") {
        return node;
      }
      return {
        ...node,
        then: node.then.map((s) => (s.id === id ? fn(s) : s)),
        else: node.else.map((s) => (s.id === id ? fn(s) : s)),
      };
    });
  }

  /** Set one argument, or drop it entirely when `value` is undefined — back to
   * the macro's own default. A default is never stored explicitly, so an
   * untouched step exports exactly as it was imported. */
  function applyArg(key: string, value: Arg | undefined): void {
    const target = inspectorTarget;
    if (target === null || target.kind !== "step") return;
    updateStepById(target.step.id, (s) => {
      if (value === undefined) {
        const { [key]: _dropped, ...rest } = s.args;
        return { ...s, args: rest };
      }
      return { ...s, args: { ...s.args, [key]: value } };
    });
  }

  function applyCondition(condition: Condition | undefined): void {
    const target = inspectorTarget;
    if (target === null) return;
    if (target.kind === "step") {
      updateStepById(target.step.id, (s) => {
        if (condition === undefined) {
          const { until: _dropped, ...rest } = s;
          return rest as MacroStep;
        }
        return { ...s, until: condition };
      });
      return;
    }
    if (condition === undefined) {
      // Only a step's `until` is ever optional; a branch and a watch always
      // have a condition, so there is nothing to clear.
      return;
    }
    if (target.kind === "branch") {
      const id = target.branch.id;
      steps = steps.map((node) => (node.id === id && node.kind === "branch" ? { ...node, when: condition } : node));
      return;
    }
    if (target.kind === "watch") {
      const id = target.watch.id;
      watches = watches.map((row) => (row.id === id ? { ...row, when: condition } : row));
    }
  }

  function applyRespond(respond: InterruptResponse): void {
    const target = inspectorTarget;
    if (target === null || target.kind !== "watch") return;
    const id = target.watch.id;
    watches = watches.map((row) => {
      if (row.id !== id) return row;
      // Only a fight-back row fights, so a response change drops the fighting
      // settings with it rather than leaving a setting nothing will ever read
      // (the codec would strip them on the next load anyway, with a warning).
      const { squad: _squad, targets: _targets, ...rest } = row;
      return respond === "fight-back" ? { ...row, respond } : { ...rest, respond };
    });
  }

  /** The fight-back watch's own combat settings — the same two a combat block has. */
  function applyWatchFight(patch: { squad?: SquadRoleArg | null; targets?: readonly TargetClassArg[] | null }): void {
    const target = inspectorTarget;
    if (target === null || target.kind !== "watch") return;
    const id = target.watch.id;
    watches = watches.map((row) => {
      if (row.id !== id) return row;
      const next: InterruptRow = { ...row };
      if (patch.squad !== undefined) {
        // "off" is the default, so it is dropped rather than stored — an
        // untouched watch exports exactly as it was imported.
        if (patch.squad === null || patch.squad === "off") delete (next as { squad?: unknown }).squad;
        else next.squad = patch.squad;
      }
      if (patch.targets !== undefined) {
        if (patch.targets === null || patch.targets.length === 0) delete (next as { targets?: unknown }).targets;
        else next.targets = [...patch.targets];
      }
      return next;
    });
  }

  function applyAddToSide(side: "then" | "else", macro: MacroID): void {
    const target = inspectorTarget;
    if (target === null || target.kind !== "branch") return;
    const spot = locate(target.branch.id);
    if (spot === null || spot.scope !== "top") return;
    const branch = steps[spot.index];
    if (branch === undefined || branch.kind !== "branch") return;
    const step = newStepFor(macro, makeId);
    withSide(spot.index, side, insertNode(side === "then" ? branch.then : branch.else, step));
    selection = { kind: "step", id: step.id };
  }

  function applySubBot(scriptID: string): void {
    const target = inspectorTarget;
    if (target === null || target.kind !== "sub-bot") return;
    const id = target.subBot.id;
    const chosen = savedList.find((bot) => bot.scriptID === scriptID) ?? null;
    steps = steps.map((node) =>
      node.id === id && node.kind === "sub-bot"
        ? { ...node, scriptID: chosen?.scriptID ?? null, name: chosen?.name ?? null }
        : node,
    );
  }

  // ── What the inspector's pickers can offer ──────────────────────────────────
  let savedFittings = $state<readonly { fittingID: number; name: string }[]>([]);
  let savedSpots = $state<readonly { bookmarkID: number; name: string }[]>([]);
  // The ore-family catalogue for the mine block's priority list — static
  // reference data, loaded once. An empty result (offline, or not shipped
  // yet) leaves the picker's own empty-state to say so.
  let oreFamilies = $state<readonly { groupID: number; name: string }[]>([]);
  // The known-pilots roster (multibox onboarding records it) — names and ids
  // only, from localStorage; no token, no live read.
  let knownPilots = $state<readonly { characterID: number; characterName: string }[]>([]);
  onMount(() => {
    knownPilots = loadKnownCharacters().map((k) => ({ characterID: k.characterID, characterName: k.characterName }));
    void flow
      .listSavedFittings()
      .then((rows) => {
        savedFittings = rows.map((f) => ({ fittingID: f.fittingID, name: f.name }));
      })
      .catch(() => {});
    void flow
      .listBookmarks()
      .then((rows) => {
        savedSpots = rows;
      })
      .catch(() => {});
    void flow
      .listOreFamilies()
      .then((rows) => {
        oreFamilies = rows;
      })
      .catch(() => {});
    void refreshSaved();
  });

  // Which fitted modules are the miners — from the ACTIVE ship's slots,
  // deduplicated by GROUP, because the format's equipment argument is a group
  // and not a single module. Left unset, the step runs every mining module
  // fitted, so an empty read is never a dead end.
  const fittedEquipment = $derived.by<readonly { groupID: number; label: string }[]>(() => {
    const seen = new Map<number, string>();
    for (const slot of $fitting.slots) {
      const module = slot.module;
      if (module !== null && module.groupID !== null && !seen.has(module.groupID)) {
        seen.set(module.groupID, $names.resolved[nameKey("type", module.typeID)] ?? "Fitted equipment");
      }
    }
    return [...seen.entries()].map(([groupID, label]) => ({ groupID, label }));
  });
  // Items offered = what is visible in the hangar/cargo right now, by NAME.
  // groupID rides along so a "keep everything like this" rule can be built: every
  // grade of a mining crystal shares a group, where a type list would need a
  // dozen entries and would silently miss the thirteenth.
  const knownItems = $derived.by<readonly { typeID: number; groupID: number | null; name: string }[]>(() => {
    const seen = new Map<number, { groupID: number | null; name: string }>();
    for (const row of [...$inventory.hangar.rows, ...$inventory.cargo.rows]) {
      if (row.typeID > 0 && !seen.has(row.typeID)) {
        const label = $names.resolved[nameKey("type", row.typeID)] ?? null;
        if (label !== null && label.length > 0) {
          seen.set(row.typeID, { groupID: row.groupID, name: label });
        }
      }
    }
    return [...seen.entries()]
      .map(([typeID, entry]) => ({ typeID, groupID: entry.groupID, name: entry.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  // ── Import / export ─────────────────────────────────────────────────────────
  function exportJson(): void {
    importText = encodeScriptDoc(builtDoc);
    importNote = "Copied this bot into the box below — copy it out to save or share.";
  }
  function importJson(): void {
    const result = decodeScriptText(importText);
    if (!result.ok) {
      importNote = result.refusal;
      return;
    }
    loadFrom(result.doc);
    currentSavedId = null; // an imported bot is a new, unsaved one
    currentRev = 0;
    importNote =
      result.warnings.length > 0
        ? `Loaded, with ${result.warnings.length} thing(s) tidied: ${result.warnings.join(" ")}`
        : "Loaded the bot from the box.";
  }
  function loadExample(example: ExampleBot): void {
    // Through the CODEC, exactly like an import — a bundled example must never
    // sidestep the gate a pasted file goes through.
    const result = decodeScriptValue(example.doc);
    if (!result.ok) {
      importNote = result.refusal;
      return;
    }
    loadFrom(result.doc);
    currentSavedId = null;
    currentRev = 0;
    importNote = `Loaded the "${example.label}" example — look it over, then save it.`;
  }
  /** Open a decoded document. Which of the three shapes it is — one loop, no
   * loop, or something the flat list cannot hold — is `toEditorState`'s call,
   * and it is tested there. */
  function loadFrom(doc: BotScript): void {
    applyState(toEditorState(doc));
  }
  /** Put an editor state on the bench — the one way anything gets opened. */
  function applyState(state: EditorState): void {
    name = state.name;
    notes = state.notes;
    home = state.home;
    watches = [...state.watches];
    steps = [...state.startup, ...state.steps];
    startupCount = state.startup.length;
    repeatMode = state.repeatMode;
    repeatCount = state.repeatCount;
    advancedProgram = state.advancedProgram;
    loopID = state.loopID;
    loopUntil = state.loopUntil;
    selection = null;
    menuFor = null;
    saveConflict = null;
    // Every opener starts Uncategorized; `loadSaved` then puts back where a
    // saved bot is filed.
    categoryID = null;
    savedCategoryID = null;
    // ⚠ THE ONE PLACE THE BASELINE IS SET ON THE WAY IN — every opener (a saved
    // bot, a pasted one, an example, the post-conflict reload) goes through
    // here, so none of them can leave the draft looking changed the moment it
    // appears. It is taken from `buildScript()` and not from `doc`, because a
    // document that round-trips through the editor's own state is the thing
    // later comparisons are against; encoding `doc` instead would make any
    // normalisation the editor applies read as an unsaved edit.
    baselineText = encodeScriptDoc(buildScript());
  }

  // ── The saved-bot library (platform-wide, on the web server) ────────────────
  // Saved-bot calls are made directly from this component, so carry the ACTIVE
  // flow's complete options — token, base URL and injected fetch — exactly like
  // calls made inside flow.ts.
  const botOpts = () => flow.requestOptions();
  // ⚠ AND BACK THE OTHER WAY. Deleting is the Manager's now and only the
  // Manager's, so a bot can leave the library while this window is open — and
  // the two pickers below would go on offering it, with "+ Saved bot" able to
  // point a sub-bot node at a script id nothing can resolve. Same seeded mark
  // as the Manager's watcher, for the same reason: a save here bumps the
  // counter itself and must not make this read the list twice.
  const libraryWrites = libraryChanged;
  let servedLibraryWrite = libraryChanged.get();
  $effect(() => {
    const count = $libraryWrites;
    if (count === servedLibraryWrite) return;
    servedLibraryWrite = count;
    void refreshSaved();
  });

  async function refreshSaved(): Promise<void> {
    try {
      const options = await botOpts();
      const [nextList, nextCategories] = await Promise.all([
        listBotScripts(options),
        listBotCategories(options),
      ]);
      savedList = nextList;
      categories = nextCategories;
      libraryError = null;
      noticeOpenBotIsGone();
      followFiling();
    } catch {
      savedList = [];
      libraryError = "Could not reach the saved bots — are you still logged in?";
    }
  }

  /**
   * The bot open here was deleted from the library — by the Bot Manager, which
   * is the only thing that can delete one now.
   *
   * ⚠ THE DRAFT IS KEPT, THE LINK IS DROPPED. The builder went on saying
   * `Editing "X"` about a row that no longer exists, and Save would have tried
   * to update a script id the server cannot find — an error, over work still on
   * screen, at the one moment the player wants it kept. It becomes an unsaved
   * bot instead, which is exactly what it now is: Save puts it back as a new
   * one. Nothing is loaded, cleared or reverted; only the id goes.
   *
   * ⚠ A FAILED READ MUST NEVER REACH HERE. `savedList` is emptied when the read
   * throws, and an empty list would then say every open bot had been deleted.
   * The caller only calls this on the success path, and this is the reason.
   */
  function noticeOpenBotIsGone(): void {
    if (isStillSaved(currentSavedId, savedList)) return;
    currentSavedId = null;
    currentRev = 0;
    importNote = `“${name}” was deleted from the library. What is on screen is still here — saving puts it back as a new bot.`;
  }
  /**
   * Keep the Category menu honest when the filing changed elsewhere: the Bot
   * Manager moved the open bot, or deleted its category (its bots become
   * Uncategorized). Only while the menu here is untouched: a category the
   * player picked and has not saved yet is theirs to keep until Save.
   */
  function followFiling(): void {
    if (categoryID !== savedCategoryID) {
      if (categoryID !== null && !categories.some((category) => category.categoryID === categoryID)) {
        categoryID = null;
      }
      return;
    }
    const meta = currentSavedId === null ? undefined : savedList.find((row) => row.scriptID === currentSavedId);
    let filed = meta === undefined ? categoryID : meta.categoryID;
    if (filed !== null && !categories.some((category) => category.categoryID === filed)) {
      filed = null;
    }
    categoryID = filed;
    savedCategoryID = filed;
  }
  async function saveBot(): Promise<void> {
    saveConflict = null;
    // ⚠ WHAT WAS SENT, CAPTURED BEFORE THE AWAIT. The baseline says "this text
    // is on the server now", and a player can type while the request is in
    // flight; taking the text afterwards would count those keystrokes as saved
    // and let a handoff discard them.
    const sent = encodeScriptDoc(builtDoc);
    const sentCategoryID = categoryID;
    try {
      if (currentSavedId !== null) {
        const { rev } = await updateBotScript(currentSavedId, builtDoc, currentRev, await botOpts(), sentCategoryID);
        currentRev = rev;
        importNote = `Saved changes to "${name}".`;
      } else {
        const { scriptID, rev } = await createBotScript(builtDoc, await botOpts(), sentCategoryID);
        currentSavedId = scriptID;
        currentRev = rev;
        importNote = `Saved "${name}".`;
      }
      baselineText = sent;
      savedCategoryID = sentCategoryID;
      // The Bot Manager's library is the list this bot just joined or changed,
      // and it does not poll — see builderTarget.ts.
      noteLibraryChanged();
      // Its own change: `refreshSaved()` is the very next line, and without
      // this the watcher below would read the same list a second time.
      servedLibraryWrite = libraryChanged.get();
      await refreshSaved();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save.";
      // A stale revision is refused by design (optimistic concurrency), and it
      // is the one save failure a player can actually resolve — so it gets the
      // two real choices rather than a sentence about a conflict.
      if (currentSavedId !== null && /save yours as a copy/i.test(message)) {
        saveConflict = message;
      } else {
        importNote = `Could not save: ${message}`;
      }
    }
  }
  /** The conflict's first choice: throw this draft away for the saved one. */
  async function reloadAfterConflict(): Promise<void> {
    if (currentSavedId === null) return;
    const id = currentSavedId;
    saveConflict = null;
    await loadSaved(id);
  }
  /** The conflict's second choice: keep this draft as a NEW saved bot, so the
   * other tab's version survives untouched. */
  async function saveAsCopy(): Promise<void> {
    saveConflict = null;
    currentSavedId = null;
    currentRev = 0;
    name = `${name} (copy)`;
    await saveBot();
  }
  async function loadSaved(id: string): Promise<void> {
    try {
      const record = await getBotScript(id, await botOpts());
      if (record === null) {
        importNote = "That saved bot could not be found.";
        return;
      }
      // DECODE ON READ. The server cannot run this codec (it is plain JS and
      // says so), so the browser is the only gate there is.
      const decoded = decodeScriptValue(record.doc);
      if (!decoded.ok) {
        importNote = decoded.refusal;
        return;
      }
      loadFrom(decoded.doc);
      currentSavedId = record.scriptID;
      currentRev = record.rev;
      categoryID = record.categoryID;
      savedCategoryID = record.categoryID;
      // It names the bot. The window this opens in is titled "Bot Builder" and
      // may have been showing a different bot a moment ago, so "Loaded a saved
      // bot" left the one question a player actually has — which one? —
      // unanswered on a screen that had just changed underneath them.
      importNote = `Editing “${decoded.doc.name}”.`;
    } catch {
      importNote = "Could not load that bot.";
    }
  }

  // ── The Bot Manager's Edit / New bot button ─────────────────────────────────
  //
  // The library, and every action on it, belongs to the Manager; this is the
  // end of the wire that carries WHICH bot (bots/builderTarget.ts). The
  // decision is pure and tested there — load it, ignore it (it is already the
  // one open), or wait because the draft here has unsaved changes that opening
  // it would destroy.
  //
  // ⚠ IT DEPENDS ON `dirty` ON PURPOSE, AND THAT IS THE WHOLE PROTOCOL. A
  // waiting request is not a dialog holding the app hostage: it stays pending
  // while the player deals with what is in the way, and because this effect
  // re-reads `dirty`, pressing Save — which makes the draft clean — completes
  // the handoff by itself, with no second button to find. Discard does the same
  // by other means. Nothing else in here is blocked in the meantime.
  const builderRequest = builderTarget.pending;
  /** The request being held off, so the panel can say so and offer the exits. */
  let waitingFor = $state<BuilderRequest | null>(null);
  const waitingText = $derived.by(() => {
    const request = waitingFor;
    if (request === null) return null;
    const wanted = savedList.find((meta) => meta.scriptID === request.scriptID)?.name ?? null;
    return waitingSentence(name, wantedLabel(request.scriptID, wanted));
  });
  $effect(() => {
    const request = $builderRequest;
    if (request === null) {
      waitingFor = null;
      return;
    }
    const decision = decideHandoff(request, { currentID: currentSavedId, dirty });
    if (decision.kind === "wait") {
      waitingFor = request;
      return;
    }
    // Taken off the queue BEFORE the read below, never after: an unserved
    // request is replayed on the next mount, and the mounts here are not rare
    // (putting the window away unmounts it).
    waitingFor = null;
    builderTarget.served(request.n);
    if (decision.kind === "ignore") {
      return;
    }
    if (decision.scriptID === null) {
      startNewBot();
    } else {
      void loadSaved(decision.scriptID);
    }
  });

  /** Clear the bench: a bot that does not exist yet — the same starting
   * document a freshly opened builder shows. */
  function startNewBot(): void {
    applyState(newEditorState());
    currentSavedId = null;
    currentRev = 0;
    importNote = "Started a new bot. Give it a name, build its plan, then Save.";
  }

  /**
   * Give up the unsaved changes and serve the waiting request.
   *
   * The only button in here that destroys work, so it says what is lost rather
   * than "OK" — and it is the second of two exits, beside a Save that is
   * always in reach in the strip above.
   */
  function discardAndOpen(): void {
    const request = waitingFor;
    if (request === null) return;
    waitingFor = null;
    builderTarget.served(request.n);
    if (request.scriptID === null) {
      startNewBot();
    } else {
      void loadSaved(request.scriptID);
    }
  }

  /** Stay where you are: the request is dropped and the draft is untouched. */
  function keepEditing(): void {
    const request = waitingFor;
    if (request === null) return;
    waitingFor = null;
    builderTarget.served(request.n);
  }
  /**
   * Copy another saved bot's steps onto the end of this one — a BY-VALUE
   * insert, not a live reference. Unlike "+ Saved bot" (which creates a
   * sub-bot node pointing at the other bot, is top-level only, and forces this
   * bot to run once), this appends independent copies: the repeat control keeps
   * working, and later edits to that saved bot never change this one.
   */
  async function insertSavedBot(meta: BotScriptSummary): Promise<void> {
    if (readOnlyPlan) return;
    try {
      const record = await getBotScript(meta.scriptID, await botOpts());
      if (record === null) {
        insertNote = "That saved bot could not be found.";
        return;
      }
      const decoded = decodeScriptValue(record.doc);
      if (!decoded.ok) {
        insertNote = decoded.refusal;
        return;
      }
      const result = insertSavedBotSteps(
        steps,
        decoded.doc,
        makeId,
        new Set(["main-loop", ...watches.map((row) => row.id)]),
      );
      if (startupCount > 0 && planHasSubBot(result.steps.slice(startupCount))) {
        insertNote = "These steps contain a saved-bot reference, which cannot go in Main while Startup is present. Inline that reference before copying.";
        return;
      }
      steps = result.steps as EditorNode[];
      insertNote =
        result.left.length > 0
          ? `Copied “${decoded.doc.name}”’s steps to the end of this bot. ${result.left.join(" ")}`
          : `Copied “${decoded.doc.name}”’s steps to the end of this bot. Later changes to that saved bot will not change this one.`;
    } catch {
      insertNote = "Could not load that saved bot.";
    }
  }
</script>

<!-- The per-row action menu (§3): move up / down / to top / to bottom,
     duplicate, delete. Buttons, never drag. -->
{#snippet rowMenu(id: string, label: string)}
  <div class="row-menu">
    <button
      type="button"
      class="minor row-menu-toggle"
      aria-expanded={menuFor === id}
      aria-label={`Actions for ${label}`}
      onclick={() => toggleMenu(id)}
    >
      ⋮
    </button>
    {#if menuFor === id}
      <div class="row-menu-items">
        <button type="button" class="minor" onclick={() => moveRow(id, "up")}>Move up</button>
        <button type="button" class="minor" onclick={() => moveRow(id, "down")}>Move down</button>
        <button type="button" class="minor" onclick={() => moveRow(id, "top")}>Move to top</button>
        <button type="button" class="minor" onclick={() => moveRow(id, "bottom")}>Move to bottom</button>
        <button type="button" class="minor" onclick={() => duplicateRow(id)}>Duplicate</button>
        {#if repeatMode !== "once" && !hasSubBot && locate(id)?.scope === "top" && steps.find(node => node.id === id)?.kind !== "sub-bot"}
          <button type="button" class="minor" onclick={() => moveSection(id)}>Move to {steps.findIndex(node => node.id === id) < startupCount ? "Main" : "Startup"}</button>
        {/if}
        <button type="button" class="danger" onclick={() => deleteRow(id)}>Delete</button>
      </div>
    {/if}
  </div>
{/snippet}

<!-- ─── Region 3: the inspector ──────────────────────────────────────────────
     Empty means GONE, not a hollow frame — and it is rendered by whichever
     region owns the selection rather than in one fixed spot, so a watch's
     settings appear under the WATCHES and a step's under the PLAN. Put in one
     place it read as belonging to the region it happened to sit below.
     At or below 640px it becomes a sheet over both (`.sheet-open` in
     styles.css): a real two-pane layout cannot honour "no sideways scrolling
     at 360px". -->
{#snippet inspector(target: InspectorTarget)}
  <BotInspector
    {target}
    {flow}
    {currentStation}
    equipment={fittedEquipment}
    items={knownItems}
    pilots={knownPilots}
    agents={$finder.agents}
    fittings={savedFittings}
    spots={savedSpots}
    oreFamilies={oreFamilies}
    savedBots={savedList}
    problems={selectedProblems}
    onArg={applyArg}
    onCondition={applyCondition}
    onRespond={applyRespond}
    onWatchFight={applyWatchFight}
    onAddToSide={applyAddToSide}
    onSubBot={applySubBot}
    onClose={() => (selection = null)}
  />
{/snippet}

{#snippet problemNotes(path: string)}
  {#each problemsForPath(problemIndex, path) as problem (problem.sentence)}
    <p class={problem.severity === "blocking" ? "note error" : "note"}>{problem.sentence}</p>
  {/each}
{/snippet}

<!-- ─── The window's strip, hoisted OUT of `.botbuilder` ──────────────────────
     ⚠ `.botbuilder` IS A CSS CONTAINER, NOT THE WINDOW BODY. The stylesheet's
     window rules (`.win-body > .panel > .panel-head`) only reach a panel that
     is a DIRECT CHILD of the window body, and `.botbuilder` used to sit
     between the two — so this head got none of that treatment: the status
     badge and Save floated at the top-right inside the first bordered block
     instead of sitting in a strip under the title bar. Only this section
     moves. `.botbuilder` keeps everything else, because it is also
     `container-name: botbuilder` in styles.css and the `@container botbuilder`
     query further down targets `.builder-plan`, `.builder-watches` and
     `.inspector-back` by name — none of which live in this head, so hoisting
     it changes nothing about where the two-pane collapse fires. -->
<section class="panel">
  <header class="panel-head">
    <h2 class="panel-title">Bot builder</h2>
    <!-- ⚠ WHICH BOT, IN THE STRIP. This window is opened from the Bot Manager's
         Edit button and its title bar says only "Bot Builder", so without this
         the one thing a player has just asserted — WHICH bot — is nowhere on
         screen except pre-filled in a text field that looks like any other.
         "New bot" is said out loud for the same reason: it is the difference
         between writing a new bot and overwriting a saved one, and Save cannot
         ask which was meant. -->
    <p class="stat-line">
      <span class="badge">{openedName === null ? "New bot" : `Editing “${openedName}”`}</span>
      {#if dirty}<span class="badge warn">Unsaved changes</span>{/if}
      {#if blockingCount === 0}
        <span class="badge good">Ready</span>
      {:else}
        <span class="badge warn">{blockingCount} thing{blockingCount === 1 ? "" : "s"} to fix</span>
      {/if}
    </p>
    <div class="controls">
      <button type="button" class="primary" disabled={problemIndex.hasBlocking} onclick={saveBot}>Save</button>
    </div>
  </header>
</section>

<div class="botbuilder" class:sheet-open={inspectorTarget !== null}>
  <!-- ─── The bot itself ───────────────────────────────────────────────────── -->
  <section class="panel">
    <header class="panel-head">
      <h2>This bot</h2>
    </header>

    <div class="controls identity-row">
      <label>
        Name
        <input id="bot-name" type="text" maxlength={MAX_NAME_LEN} bind:value={name} />
      </label>
      <!-- Where the Bot Manager lists it. Saved with the bot; categories are
           made and renamed on the Manager's rail. -->
      <label>
        Category
        <select id="bot-category" bind:value={categoryID}>
          <option value={null}>Uncategorized</option>
          {#each categories as category (category.categoryID)}
            <option value={category.categoryID}>{category.name}</option>
          {/each}
        </select>
      </label>
      <label>
        Notes
        <textarea
          id="bot-notes"
          rows="2"
          maxlength={MAX_NOTES_LEN}
          bind:value={notes}
          placeholder="What this bot is for (optional)"
        ></textarea>
      </label>
    </div>
    {@render problemNotes("name")}

    {#if someWatchDocks}
      <div class="controls">
        <label>
          Home station — where a watch docks
          <StationPicker {flow} value={home} current={currentStation} scope="dockable" onPick={(ref) => (home = ref)} />
        </label>
      </div>
      {@render problemNotes("home")}
    {/if}

    {#if saveConflict !== null}
      <!-- The optimistic-concurrency refusal, as the two choices it actually
           offers rather than as a sentence about a conflict. -->
      <div class="save-conflict">
        <p class="note error">{saveConflict}</p>
        <div class="controls">
          <button type="button" onclick={reloadAfterConflict}>Reload the saved one</button>
          <button type="button" class="primary" onclick={saveAsCopy}>Save mine as a copy</button>
        </div>
      </div>
    {/if}

    {#if waitingFor !== null}
      <!-- ⚠ A CONDITION AND A WAY OUT, NOT A MODAL. The Bot Manager asked for
           another bot while this one has unsaved changes. Nothing here is
           blocked: Save is in the strip above and finishes the handoff by
           itself the moment the draft is clean, and the two buttons are the
           other two answers. A dialog would have had to be answered before the
           player could even look at what they were about to lose. -->
      <div class="save-conflict">
        <p class="note error">{waitingText}</p>
        <div class="controls">
          <button type="button" onclick={keepEditing}>Keep editing this one</button>
          <button type="button" class="danger" onclick={discardAndOpen}>Discard my changes and open it</button>
        </div>
      </div>
    {/if}
    {#if importNote !== null}<p class="note">{importNote}</p>{/if}

    <div class="controls">
      <span class="example-label">Start from an example</span>
      {#each EXAMPLE_BOTS as example (example.key)}
        <button type="button" class="minor" title={example.blurb} onclick={() => loadExample(example)}>
          {example.label}
        </button>
      {/each}
    </div>
  </section>

  <!-- ─── Region 1: always watching ────────────────────────────────────────────
       Its own region, never step zero of the plan — Home Assistant and Kodu
       both separate always-on rules from the sequence, and so does the format:
       an interrupt row is not a program node. -->
  <section class="panel builder-watches">
    <header class="panel-head">
      <h2>Always watching</h2>
      <div class="controls">
        <span class="badge">{watches.length} of {MAX_INTERRUPTS}</span>
      </div>
    </header>
    <p class="note">Checked every moment, from the top down — the first watch that matches is the one that acts.</p>
    {@render problemNotes("watches")}

    {#if watches.length === 0}
      <p class="empty">No watches yet. Nothing will interrupt this bot once it starts.</p>
    {:else}
      <ul class="plan-list">
        {#each watches as row, i (row.id)}
          <li class="plan-row" class:selected={selection?.kind === "watch" && selection.id === row.id}>
            <span class="plan-mark" aria-hidden="true">!</span>
            <button type="button" class="plan-sentence" onclick={() => selectWatch(row.id)}>
              {interruptSentence(row)}
            </button>
            <div class="plan-ops">
              <div class="row-menu">
                <button
                  type="button"
                  class="minor row-menu-toggle"
                  aria-expanded={menuFor === row.id}
                  aria-label={`Actions for the watch: ${interruptSentence(row)}`}
                  onclick={() => toggleMenu(row.id)}
                >
                  ⋮
                </button>
                {#if menuFor === row.id}
                  <div class="row-menu-items">
                    <button type="button" class="minor" disabled={i === 0} onclick={() => moveWatch(row.id, -1)}>
                      Move up
                    </button>
                    <button
                      type="button"
                      class="minor"
                      disabled={i === watches.length - 1}
                      onclick={() => moveWatch(row.id, 1)}
                    >
                      Move down
                    </button>
                    {#if row.respond !== "alert" && !hasAlertTwin(row) && watches.length < MAX_INTERRUPTS}
                      <button type="button" class="minor" onclick={() => addAlertFor(row)}>Also let me know</button>
                    {/if}
                    <button type="button" class="danger" onclick={() => removeWatch(row.id)}>Delete</button>
                  </div>
                {/if}
              </div>
            </div>
            {@render problemNotes(row.id)}
          </li>
        {/each}
      </ul>
    {/if}

    <div class="plan-add">
      <button
        type="button"
        aria-expanded={watchPickerOpen}
        disabled={watches.length >= MAX_INTERRUPTS}
        onclick={() => (watchPickerOpen = !watchPickerOpen)}
      >
        + Watch
      </button>
      {#if watchPickerOpen}
        <div class="picker">
          <p class="note">One of each. A watch you already have is greyed out.</p>
          <div class="picker-results">
            {#each WATCH_CONDITION_KINDS as kind (kind)}
              <button type="button" class="picker-item" disabled={hasWatch(kind)} onclick={() => addWatch(kind)}>
                <span class="picker-item-name">{CONDITION_NOUN_LABEL[kind]}</span>
              </button>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  </section>

  {#if inspectorTarget !== null && inspectorTarget.kind === "watch"}
    {@render inspector(inspectorTarget)}
  {/if}

  <!-- ─── Region 2: the plan ───────────────────────────────────────────────────
       Numbered sentence rows. The row IS the summary; the top-level repeat sits
       in the region header because it wraps everything below it. -->
  <section class="panel builder-plan">
    <header class="panel-head">
      <h2>The plan</h2>
      <div class="controls">
        {#if hasSubBot}
          <span class="note">Runs through once — a bot that runs other bots cannot repeat as a whole.</span>
        {:else}
          <label>
            Repeat
            <select bind:value={repeatMode}>
              <option value="forever">forever</option>
              <option value="times">a set number of times</option>
              <option value="once" disabled={startupCount > 0}>just once</option>
            </select>
          </label>
          {#if repeatMode === "times"}
            <label>
              How many times
              <input
                class="num-in"
                type="number"
                min={MIN_REPEAT_TIMES}
                max={MAX_REPEAT_TIMES}
                bind:value={repeatCount}
              />
            </label>
          {/if}
        {/if}
      </div>
    </header>
    {@render problemNotes("program")}
    {@render problemNotes("main-loop")}
    {#if !readOnlyPlan && repeatMode !== "once"}
      <h3>Startup — once before Main</h3>
      <p class="note">{startupCount === 0 ? "Empty. Move a setup step here using its row menu." : "These steps run before the main loop."}
        Durable completion applies to server-hosted runs. Unsupported startup mutations block before dispatch.</p>
    {/if}

    {#if readOnlyPlan}
      <p class="note error">
        This bot repeats more than one group of steps, which this list cannot hold. It is kept exactly as
        written, so it still runs and still exports unchanged — the rows below are a read-only view. Edit it in
        the <strong>Import or export</strong> box to change its program.
      </p>
    {/if}

    {#if planRows.length === 0}
      <p class="empty">No steps yet. Add the first one below.</p>
    {:else}
      <ol class="plan-list">
        {#each planRows as row, i (row.nodeId)}
          {@const previous = planRows[i - 1]}
          {#if !readOnlyPlan && repeatMode !== "once" && row.nodeId === steps[startupCount]?.id}
            <li class="plan-side-label">Main — repeating work</li>
          {/if}
          {#if row.branchSide !== null && (previous?.branchSide ?? null) !== row.branchSide}
            <li class="plan-side-label" style={`--depth: ${row.depth}`}>
              {row.branchSide === "then" ? "then" : "otherwise"}
            </li>
          {/if}
          <li
            class="plan-row"
            style={`--depth: ${row.depth}`}
            class:selected={selection?.kind === "step" && selection.id === row.nodeId}
            class:blocking={pathHasBlockingProblem(problemIndex, row.nodeId)}
          >
            <span class="plan-number">
              {#if pathHasBlockingProblem(problemIndex, row.nodeId)}
                <span class="plan-warn" aria-label="needs something before this bot can start">⚠</span>
              {:else if row.number !== null}
                {row.number}
              {:else if row.kind === "branch"}
                <span aria-hidden="true">⑂</span>
              {/if}
            </span>
            {#if readOnlyPlan || row.kind === "loop"}
              <span class="plan-sentence plan-sentence-static">{row.sentence}</span>
            {:else}
              <button type="button" class="plan-sentence" onclick={() => selectRow(row.nodeId)}>{row.sentence}</button>
            {/if}
            {#if !readOnlyPlan && row.kind !== "loop"}
              <div class="plan-ops">
                {@render rowMenu(row.nodeId, row.sentence)}
              </div>
            {/if}
            {@render problemNotes(row.nodeId)}
          </li>
        {/each}
      </ol>
    {/if}

    <div class="plan-add" inert={readOnlyPlan}>
      <button type="button" aria-expanded={stepPickerOpen} onclick={() => (stepPickerOpen = !stepPickerOpen)}>
        + Step
      </button>
      <button type="button" onclick={addBranch}>+ Branch</button>
      <button type="button" disabled={startupCount > 0} onclick={addSubBot}>+ Saved bot</button>

      {#if stepPickerOpen}
        <!-- Browse AND search, not a smaller catalogue: Google's own answer to a
             large Blockly toolbox was a search plugin, and visible categories
             beat hidden navigation for discoverability. Both narrow the SAME
             list, so a query composes with a chip rather than replacing it. -->
        <div class="picker">
          <div class="controls">
            <label>
              Search steps
              <input type="search" placeholder="What do you want it to do?" bind:value={pickerQuery} />
            </label>
          </div>
          <div class="picker-chips" role="group" aria-label="Filter steps by category">
            <button type="button" class:active={pickerCategory === null} onclick={() => (pickerCategory = null)}>
              All
            </button>
            {#each pickerCategories as category (category)}
              <button
                type="button"
                class:active={pickerCategory === category}
                onclick={() => (pickerCategory = category)}
              >
                {CATEGORY_LABEL[category]}
              </button>
            {/each}
          </div>
          {#if pickerResults.length === 0}
            <p class="empty">Nothing matches. Try a different word, or pick All.</p>
          {:else}
            <div class="picker-results">
              {#each pickerResults as entry (entry.id)}
                <button type="button" class="picker-item" onclick={() => addStep(entry.id)}>
                  <span class="picker-item-name">{entry.name}</span>
                  <span class="picker-item-does">{entry.does}</span>
                  {#if entry.needs}<span class="picker-item-needs">Needs: {entry.needs}</span>{/if}
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </section>

  {#if inspectorTarget !== null && inspectorTarget.kind !== "watch"}
    {@render inspector(inspectorTarget)}
  {/if}

  <!-- ─── Reuse: copy another saved bot's steps in ─────────────────────────── -->
  <section class="panel">
    <header class="panel-head">
      <h2>Insert steps from a saved bot</h2>
    </header>
    <!-- ⚠ THE FIRST SENTENCE WENT, THE SECOND IS THE WHOLE POINT. "Copy a saved
         bot's steps onto the end of the plan you already have" is the heading
         above it in a longer form. What a player cannot see anywhere is that the
         copy is a SNAPSHOT and not a link — that is worth a line, and it is the
         line that survived. -->
    <p class="note">
      This copies the steps once — later changes to that saved bot will not
      change this one.
    </p>
    {#if libraryError !== null}
      <p class="note error">{libraryError}</p>
    {:else if savedList.length === 0}
      <p class="empty">No saved bots yet. Save one first, then come back here to copy its steps.</p>
    {:else}
      <div class="picker-results">
        {#each savedList as meta (meta.scriptID)}
          <button type="button" class="picker-item" onclick={() => insertSavedBot(meta)}>
            <span class="picker-item-name">{meta.name}</span>
            <span class="picker-item-does">Copy this bot's steps onto the end of the plan.</span>
          </button>
        {/each}
      </div>
    {/if}
    {#if insertNote !== null}<p class="note">{insertNote}</p>{/if}
  </section>

  <!-- ⚠ THE LIBRARY IS NOT HERE ANY MORE, AND ITS ABSENCE IS THE FEATURE. A
       "Saved bots" table with Load and Delete on every row used to sit at this
       point in the window — a second copy of the Bot Manager's own library,
       one window away from it. It was not a duplicate by accident: the
       Manager's Edit button could only open this window and not tell it which
       bot, so finding the bot again in THIS list was the only way to actually
       edit it. Now Edit brings the bot with it, and one window lists the bots
       while the other edits one. The two pickers above stay, because they are
       not the library: they compose one bot out of another, and neither can
       open, rename or delete anything. -->

  <!-- ─── Import / export ──────────────────────────────────────────────────── -->
  <section class="panel">
    <header class="panel-head">
      <h2>Import or export</h2>
    </header>
    <!-- ⚠ "Paste a bot and load it, or export this one to copy out" IS GONE. It
         is the heading, the textarea's own label and the two buttons, said a
         fourth time: this block is already a box labelled "The bot, as text"
         with "Load from box" and "Export to box" under it. A sentence that only
         reads out the controls beneath it is one a player has to look past every
         time they come here to do the thing it describes. -->
    <label class="io-label" for="bot-io">
      The bot, as text
      <textarea id="bot-io" class="io" rows="6" bind:value={importText} placeholder="Paste a bot here…"></textarea>
    </label>
    <div class="controls">
      <button type="button" class="minor" onclick={importJson}>Load from box</button>
      <button type="button" class="minor" onclick={exportJson}>Export to box</button>
    </div>
  </section>
</div>
