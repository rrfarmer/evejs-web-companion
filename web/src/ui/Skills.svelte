<script lang="ts">
  // Goal R28: the character sheet, and the queue of what to train next.
  //
  // Skills were the one major retail system with a complete server-side
  // implementation and no client surface at all: R9b deleted the legacy UI and
  // nothing replaced it. This is the replacement.
  //
  // THIS PANEL COMPUTES NO GAME MECHANIC. The SP required for each level, the
  // training rate, the prerequisite tree and the Omega/Alpha rules are all the
  // server's; they arrive already evaluated on the sheet. What happens here is
  // arrangement: skills into their groups, SP between two thresholds, and a bar
  // interpolated between two reads.
  //
  // THE CLOCK MOVES, AND IT IS NOT OURS. `nowMs` ticks once a second purely to
  // redraw; every value it feeds is derived from the SERVER's start/end instants
  // and its own SP-per-minute, offset by the difference between the two machines'
  // clocks measured at read time. Nothing is ever advanced past what the server
  // said, and when the current skill's finish time passes, the panel RE-READS
  // rather than declaring the skill trained on its own authority.
  import { onMount, untrack } from "svelte";
  import SkillRowMenu from "./SkillRowMenu.svelte";
  import { skillMenuEntries, type SkillMenuEntry } from "../bridge/skillMenu.ts";
  import type { SkillRowInfo } from "../bridge/skillPlans.ts";
  import { BridgeCallError } from "../bridge/callMethod.ts";
  import { isSessionLost } from "../app/flow.ts";
  // R27's shared item icon. This is the panel it was waiting for: the icon
  // cache covers every skill type, so here — uniquely — the pictures are the
  // normal case and the lettered tile is the exception.
  import TypeIcon from "./TypeIcon.svelte";
  // The client's Personal Plans, read on the public gateway.
  import PersonalSkillPlans from "./PersonalSkillPlans.svelte";
  import { showMarketDetails } from "./marketDetails.ts";
  import { endSkillDrag, skillDragged, startSkillDrag } from "./skillDrag.ts";
  import { DRAG_MIME, decodeDrag } from "./dragDrop.ts";
  import { formatTemplate } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import {
    formatDuration,
    formatSkillPoints,
    freeSkillPointsPlan,
    groupSkills,
    levelSquares,
    romanLevel,
    serverNow,
    skillProgress,
    trainingReadout,
  } from "../bridge/skills.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, SkillQueueDrop } from "../app/flow.ts";
  import type { SkillRow } from "../store/types.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { SKILLS_POINTERS } from "../play/uiPointer.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  const topPanelKey = "evejs.skillsTopPanel";
  let topPanel = $state<"plans" | "catalogue">("plans");
  onMount(() => {
    try {
      if (localStorage.getItem(topPanelKey) === "catalogue") topPanel = "catalogue";
    } catch { /* use the default panel */ }
  });
  function chooseTopPanel(panel: "plans" | "catalogue"): void {
    topPanel = panel;
    try { localStorage.setItem(topPanelKey, panel); } catch { /* keep the current selection */ }
  }

  // svelte-ignore state_referenced_locally
  const skills = store.skills;
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // A queued level a skill accelerator runs as it begins is marked (skillQueueSkillEntry.UpdateAcceleratedMarker): the
  // booster picture, its hint the install's words.
  const ACCELERATED_LABEL = "UI/SkillQueue/Skills/AcceleratedTraining";
  $effect(() => {
    flow.requestWords([ACCELERATED_LABEL]);
  });
  const acceleratedWord = $derived.by(() => {
    const template = $words.templates[ACCELERATED_LABEL];
    return plainText(typeof template === "string" && template !== "" ? template : "A booster speeds this");
  });

  let busy = $state(false);
  let error = $state("");
  let filter = $state("");
  /**
   * Groups the player has FOLDED AWAY.
   *
   * Deliberately the inverse of an "open" list: the sheet opens showing
   * everything, because "what do I know" is the question the panel exists to
   * answer and a wall of closed headers answers it with nothing. Folding is
   * there for the player who wants to get past Spaceship Command's ninety-one
   * rows, not a state they have to escape from first.
   */
  let collapsed = $state<string[]>([]);
  /** Redraw tick. Display only — never a source of truth about SP or time. */
  let nowMs = $state(Date.now());
  /** The finish instant we have already asked the server to confirm. */
  let confirmedFinishAt = $state<number | null>(null);

  const sheet = $derived($skills);
  const queue = $derived(sheet.queue);
  const allSkills = $derived(sheet.skills ?? []);
  const groups = $derived(groupSkills(allSkills));

  /** What the SERVER would call now, on this browser's clock. */
  const serverNowMs = $derived(serverNow(sheet.clockOffsetMs, nowMs));
  const training = $derived(trainingReadout(queue, serverNowMs));

  const byTypeID = $derived(new Map(allSkills.map((skill) => [skill.typeID, skill])));

  function skillName(typeID: number): string {
    return byTypeID.get(typeID)?.name ?? "—";
  }

  const needle = $derived(filter.trim().toLowerCase());
  const matchingGroups = $derived(
    needle === ""
      ? groups
      : groups
          .map((group) => ({
            ...group,
            skills: group.skills.filter(
              (skill) =>
                skill.name.toLowerCase().includes(needle) ||
                group.groupName.toLowerCase().includes(needle),
            ),
          }))
          .filter((group) => group.skills.length > 0),
  );

  /**
   * The level a "train the next one" button would ask for: one above whatever
   * the character has OR has already planned. Null when there is nothing left.
   *
   * This is arithmetic on two numbers the server gave us, not a judgement about
   * whether the level is trainable — prerequisites, Omega gating and the SP cap
   * are the server's to refuse, and it does, in words the player can act on.
   */
  function nextLevelFor(skill: SkillRow): number | null {
    const planned = (queue?.entries ?? []).reduce(
      (highest, entry) => (entry.typeID === skill.typeID ? Math.max(highest, entry.toLevel) : highest),
      skill.level,
    );
    return planned >= 5 ? null : planned + 1;
  }

  /** The queue as the wire wants it: position order, typeID and level only. */
  function currentEntries(): { typeID: number; toLevel: number }[] {
    return (queue?.entries ?? []).map((entry) => ({
      typeID: entry.typeID,
      toLevel: entry.toLevel,
    }));
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

  // Every edit below is the SAME call: save the whole list. That is how the
  // server models a queue, and inventing add/remove/move verbs on top of it
  // would only create three ways to disagree with it.
  async function addNextLevel(skill: SkillRow): Promise<void> {
    const level = nextLevelFor(skill);
    if (level === null) {
      return;
    }
    await run(() =>
      flow.saveSkillQueue(
        [...currentEntries(), { typeID: skill.typeID, toLevel: level }],
        `Added ${skill.name} ${romanLevel(level)} to the queue`,
        skill.name,
      ),
    );
  }

  /** Unallocated skill points the sheet says the character is holding. */
  const freeSkillPoints = $derived(sheet.freeSkillPoints ?? 0);

  async function applyFreePoints(skill: SkillRow, points: number): Promise<void> {
    if (points <= 0) {
      return;
    }
    await run(() => flow.applyFreeSkillPoints(skill.typeID, points));
  }

  async function removeAt(index: number): Promise<void> {
    const entries = currentEntries();
    const removed = entries[index];
    if (!removed) {
      return;
    }
    await run(() =>
      flow.saveSkillQueue(
        entries.filter((_, position) => position !== index),
        `Took ${skillName(removed.typeID)} off the queue`,
        skillName(removed.typeID),
      ),
    );
  }

  async function move(index: number, delta: number): Promise<void> {
    const entries = currentEntries();
    const target = index + delta;
    if (!entries[index] || !entries[target]) {
      return;
    }
    const reordered = [...entries];
    reordered[index] = entries[target]!;
    reordered[target] = entries[index]!;
    await run(() =>
      flow.saveSkillQueue(
        reordered,
        `Moved ${skillName(entries[index]!.typeID)} ${delta < 0 ? "up" : "down"}`,
        skillName(entries[index]!.typeID),
      ),
    );
  }

  // ---- Drops onto the queue (skillQueuePanelNew.DoDropData; SkillQueueSkillEntry OnDropData, OnDragEnter) --------
  //
  // A skill dragged here from a plan's contents (a SkillEntry), from the plan editor (a type's drag) or from the queue
  // itself (an entry: moved, or with Shift its next level added) is put in where it is dropped: above the entry it is
  // dropped on, or at the end (flow.skillQueueDrop, the client's AddSkillToQueue and MoveSkillToPosition). As it is
  // dragged over, the line where it would land (ShowPosIndicator, IsMoveAllowed): white where it may go there, red
  // where a skill may not, none for a type's drag. A skill not had opens the purchase overlay (SkillPurchaseOverlay).
  // A skill book dragged from an inventory (an InvItem) is injected, then its level I put in where it is dropped; as it
  // is dragged over, no line (IsMoveAllowed and IsSkillEntry both no).

  /** The flow's judge of the drag under way, read as it enters the queue. */
  let dropFacts = $state<Awaited<ReturnType<AppFlow["skillQueueDropFacts"]>>>(null);
  let dropFactsFor: string | null = null;
  /** The line: above an entry (its place) or at the end, its colour. */
  /** The line's colour: COLOR_TRAININGALLOWED, COLOR_TRAININGNOTALLOWED, or COLOR_MOVE_INDICATOR for several entries. */
  let dropLine = $state<{ readonly at: number | "end"; readonly color: "allowed" | "refused" | "move" } | null>(null);

  // ---- The queue's selection (its Scroll, multiSelect: SelectNode, GetSelectedNodes) ----------------------------------
  //
  // A click selects the entry alone; with Ctrl it is added or taken off; with Shift the entries from the last one
  // clicked to it are selected alone (with Ctrl and Shift, added). An entry dragged that is not selected is selected
  // first (GetSelectedNodes), and the drag carries every selected entry; several dragged show the move line
  // (IsMultiSkillEntryMove) and move together (_DoMoveManyEntries), selected again after. Delete takes the selected
  // out (the scroll's OnDelete: RemoveSkillFromQueue, DoRemove).
  let selectedKeys = $state<readonly string[]>([]);
  let lastSelected: number | null = null;
  const entryKey = (typeID: number, level: number): string => typeID + ":" + level;
  /** The selected entries, in the queue's order, with their places. */
  const selectedEntries = $derived((queue?.entries ?? [])
    .map((entry, idx) => ({ typeID: entry.typeID, level: entry.toLevel, idx }))
    .filter((entry) => selectedKeys.includes(entryKey(entry.typeID, entry.level))));

  /** Scroll.SelectNode, the scroll being multiSelect. */
  function selectEntry(idx: number, control: boolean, shift: boolean): void {
    const entries = queue?.entries ?? [];
    const entry = entries[idx];
    if (entry === undefined) return;
    const key = entryKey(entry.typeID, entry.toLevel);
    const keysFrom = (from: number, to: number): string[] =>
      entries.slice(Math.min(from, to), Math.max(from, to) + 1).map((each) => entryKey(each.typeID, each.toLevel));
    if (!control && !shift) {
      selectedKeys = [key];
    } else if (control && !shift) {
      selectedKeys = selectedKeys.includes(key) ? selectedKeys.filter((each) => each !== key) : [...selectedKeys, key];
    } else if (!control && shift) {
      if (lastSelected !== null && lastSelected !== idx) {
        // (The range's anchor stays where it was.)
        selectedKeys = keysFrom(lastSelected, idx);
        return;
      }
      selectedKeys = [key];
    } else if (lastSelected !== null && lastSelected !== idx) {
      selectedKeys = [...new Set([...selectedKeys, ...keysFrom(lastSelected, idx)])];
    }
    lastSelected = idx;
  }

  // ---- An entry's menu and hint (SkillQueueSkillEntry GetMenu, GetHint) ------------------------------------------------
  //
  // Its menu: the skill's (GetMenuForSkill, SkillRowMenu), then a line and Remove, which takes the selection out
  // (RemoveSkillFromQueue). Opening it selects the entry where it is not selected (GetSelectedNodes). Its hint: the
  // skill's description (evetypes.GetDescription), read for the queue's skills as the queue changes.
  let queueMenu = $state<{ readonly typeID: number; readonly entries: readonly SkillMenuEntry[]; readonly x: number; readonly y: number } | null>(null);
  async function openQueueMenu(event: MouseEvent, idx: number): Promise<void> {
    event.preventDefault();
    const entry = queue?.entries[idx];
    if (entry === undefined) return;
    if (!selectedKeys.includes(entryKey(entry.typeID, entry.toLevel))) selectEntry(idx, event.ctrlKey, event.shiftKey);
    const { clientX: x, clientY: y } = event;
    const info = (await flow.skillRowInfoFor([entry.typeID]))?.get(entry.typeID);
    if (info === undefined) return;
    queueMenu = { typeID: entry.typeID, entries: [...skillMenuEntries(entry.typeID, info.menu), { kind: "separator" }, { kind: "remove" }], x, y };
  }

  let queueInfos = $state<ReadonlyMap<number, SkillRowInfo>>(new Map());
  let queueInfosFor = "";
  $effect(() => {
    const skills = [...new Set((queue?.entries ?? []).map((entry) => entry.typeID))];
    const key = skills.join(",");
    untrack(() => {
      if (key === queueInfosFor || skills.length === 0) return;
      queueInfosFor = key;
      void flow.skillRowInfoFor(skills).then((read) => {
        if (read !== null && queueInfosFor === key) queueInfos = read;
      });
    });
  });
  /** GetHint: the description, as the install words it. */
  function queueHint(typeID: number): string | undefined {
    const descriptionID = queueInfos.get(typeID)?.descriptionID ?? null;
    const template = descriptionID === null ? undefined : $words.templates["#" + descriptionID];
    return typeof template === "string" ? plainText(formatTemplate(template, {}, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") })) : undefined;
  }

  /** DoRemove of the selection, bottom first. */
  async function removeSelected(): Promise<void> {
    const levels = [...selectedEntries].reverse().map(({ typeID, level }) => ({ typeID, level }));
    if (levels.length === 0) return;
    selectedKeys = [];
    lastSelected = null;
    await run(() => flow.removeQueuedLevels(levels));
  }

  function readDropFacts(): void {
    const drop = skillDragged();
    if (drop === null) return;
    const key = `${drop.kind}:${drop.typeID}`;
    if (dropFactsFor === key) return;
    dropFactsFor = key;
    dropFacts = null;
    void flow.skillQueueDropFacts([drop.typeID]).then((facts) => {
      if (dropFactsFor === key) dropFacts = facts;
    });
  }

  function lineFor(at: number | "end"): void {
    const drop = skillDragged();
    if (drop !== null && drop.kind === "queueEntry" && (drop.selection?.length ?? 0) > 1) {
      dropLine = { at, color: "move" };
      return;
    }
    if (drop === null || dropFacts === null) {
      dropLine = null;
      return;
    }
    if (dropFacts.allowed(drop, at === "end" ? null : at)) dropLine = { at, color: "allowed" };
    // COLOR_TRAININGNOTALLOWED for a skill entry (IsSkillEntry); a type's drag shows none.
    else dropLine = drop.kind === "type" ? null : { at, color: "refused" };
  }

  /** An inventory's item dragged over (its data unread until the drop). */
  const itemDragged = (event: DragEvent): boolean => skillDragged() === null && (event.dataTransfer?.types.includes(DRAG_MIME) ?? false);

  /** The inventory's item dropped, as the queue takes it; null where none was. */
  function itemDropped(event: DragEvent): SkillQueueDrop | null {
    const payload = decodeDrag(event.dataTransfer?.getData(DRAG_MIME) ?? null);
    return payload !== null && payload.kind === "inventoryItem" ? { kind: "invItem", itemID: payload.itemID, typeID: payload.typeID } : null;
  }

  function rowDragOver(event: DragEvent, index: number): void {
    if (itemDragged(event)) {
      event.preventDefault();
      event.stopPropagation();
      dropLine = null;
      return;
    }
    if (skillDragged() === null) return;
    event.preventDefault();
    event.stopPropagation();
    readDropFacts();
    lineFor(index);
  }

  function queueDragOver(event: DragEvent): void {
    if (itemDragged(event)) {
      event.preventDefault();
      dropLine = null;
      return;
    }
    if (skillDragged() === null) return;
    event.preventDefault();
    readDropFacts();
    lineFor("end");
  }

  function queueDragLeave(event: DragEvent): void {
    if (event.currentTarget instanceof Element && event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    dropLine = null;
  }

  /** DoDropData at the entry's place (an entry's OnDropData), or at the end. */
  async function queueDrop(event: DragEvent, place: number | null): Promise<void> {
    const drop = skillDragged() ?? itemDropped(event);
    if (drop === null) return;
    event.preventDefault();
    event.stopPropagation();
    const shift = event.shiftKey;
    dropLine = null;
    dropFactsFor = null;
    endSkillDrag();
    // The queue loaded again after it changes; several entries moved are selected again (ReselectDraggedNodes).
    const moved = drop.kind === "queueEntry" && !shift && (drop.selection?.length ?? 0) > 1
      ? drop.selection!.map((each) => entryKey(each.typeID, each.level))
      : [];
    selectedKeys = moved;
    if (moved.length === 0) lastSelected = null;
    try {
      const outcome = await flow.skillQueueDrop(drop, place, shift);
      if (outcome.missing !== null) void openPurchase(outcome.missing.typeID, outcome.missing.position);
    } catch (cause) {
      if (isSessionLost(cause)) throw cause;
    }
  }

  /**
   * A queue entry's drag (SkillQueueSkillEntry.GetDragData: GetSelectedNodes, the entry selected first where it is
   * not): the selected entries; the first of them leads (DoDropData's entries[0]).
   */
  function queueEntryDrag(event: DragEvent, idx: number): void {
    const entry = queue?.entries[idx];
    if (entry === undefined) return;
    if (!selectedKeys.includes(entryKey(entry.typeID, entry.toLevel))) selectEntry(idx, event.ctrlKey, event.shiftKey);
    const dragged = selectedEntries.length > 0 ? selectedEntries : [{ typeID: entry.typeID, level: entry.toLevel, idx }];
    const first = dragged[0]!;
    event.dataTransfer?.setData("application/x-evejs-queue-entry", JSON.stringify(dragged.map(({ typeID, level }) => ({ typeID, level }))));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    startSkillDrag({ kind: "queueEntry", typeID: first.typeID, level: first.level, ...(dragged.length > 1 ? { selection: dragged } : {}) });
  }

  // The purchase overlay (SkillPurchaseOverlay, show_skill_purchase_overlay): over the queue, its message (the price
  // where the book is sold directly, else that it is rare), Cancel, and Buy and train (its needs trained: bought, then
  // level I put in where it was dropped) or Buy Skill, or for a rare book View Market Details. Closed by any of them,
  // and by a change of the queue (OnSkillQueueChanged).
  let purchase = $state<{ readonly typeID: number; readonly position: number; readonly offer: { readonly sold: boolean; readonly price: number | null; readonly requirementsTrained: boolean } } | null>(null);
  let purchaseQueue: string | null = null;
  async function openPurchase(typeID: number, position: number): Promise<void> {
    if (purchase !== null) return;
    const offer = await flow.skillPurchaseOffer(typeID);
    if (offer === null) return;
    flow.requestWords(Object.keys(PURCHASE_WORDS));
    flow.requestNames([{ kind: "type", id: typeID }]);
    purchaseQueue = queueSignatureNow();
    purchase = { typeID, position, offer };
  }
  const PURCHASE_WORDS: Readonly<Record<string, string>> = {
    "UI/SkillQueue/ConfirmSkillPurchase": "{[item]skill.name} is not yours to train yet. Buy it for {[numeric]price, useGrouping, decimalPlaces=0} ISK?",
    "UI/SkillQueue/ErrorSkillIsRare": "{[item]skill.name} is not yours to train yet, and its book is not sold directly: look on the market.",
    "UI/Common/Cancel": "Cancel",
    "UI/Skills/BuyAndTrain": "Buy and train",
    "UI/Skills/BuySkill": "Buy",
    "UI/Inventory/ItemActions/ViewTypesMarketDetails": "Market details",
  };
  function purchaseWord(label: string, args: Readonly<Record<string, string | number>> = {}): string {
    const template = $words.templates[label];
    return plainText(formatTemplate(typeof template === "string" ? template : PURCHASE_WORDS[label] ?? "", args, {
      nameOf: (kind, id) => resolvedName($names.resolved, kind, id, ""),
    }));
  }
  function queueSignatureNow(): string {
    return (queue?.entries ?? []).map((entry) => `${entry.typeID}:${entry.toLevel}`).join(",");
  }
  // OnSkillQueueChanged: the overlay closed.
  $effect(() => {
    const signature = (queue?.entries ?? []).map((entry) => `${entry.typeID}:${entry.toLevel}`).join(",");
    if (purchaseQueue !== null && signature !== purchaseQueue) {
      purchase = null;
      purchaseQueue = null;
    }
  });
  async function purchaseAnswer(answer: "cancel" | "buy" | "market"): Promise<void> {
    const open = purchase;
    purchase = null;
    purchaseQueue = null;
    if (open === null || answer === "cancel") return;
    if (answer === "market") {
      showMarketDetails(open.typeID);
      return;
    }
    await run(() => flow.buySkillFromOverlay(open.typeID, open.offer.requirementsTrained ? open.position : null));
  }

  /** A queue with skills on it and none of them training: paused, as the retail client's queue can be. */
  const paused = $derived(queue !== null && !queue.active && queue.entries.length > 0);

  // The retail client's queue panel pauses by asking the server to stop the
  // skill in training (AbortTraining). The queue is kept, and what the server
  // then says of it is what is shown.
  async function pauseTraining(): Promise<void> {
    await run(() => flow.pauseSkillTraining());
  }

  // Its start button saves the queue as it stands, which sets it going.
  async function startTraining(): Promise<void> {
    await run(() => flow.saveSkillQueue(currentEntries(), "Started training", "your queue", true));
  }

  function finishText(endTimeMs: number | null): string {
    if (endTimeMs === null) {
      return "not known";
    }
    return `${formatDuration(Math.max(0, endTimeMs - serverNowMs))} from now`;
  }

  onMount(() => {
    void run(() => flow.loadSkills());
    // One second is the coarsest tick that still reads as a moving clock. The
    // interval only redraws; it never advances a number by itself.
    const handle = setInterval(() => {
      nowMs = Date.now();
    }, 1000);
    return () => clearInterval(handle);
  });

  // ⚠ THE SERVER FINISHES SKILLS, NOT US. When the current entry's end time
  // passes, this asks for a fresh sheet exactly once per finish instant instead
  // of promoting the skill locally. If the re-read disagrees with what the
  // countdown showed, the re-read is what the player sees.
  $effect(() => {
    const readout = training;
    if (readout === null || readout.remainingMs > 0 || busy) {
      return;
    }
    if (confirmedFinishAt === readout.finishAtMs) {
      return;
    }
    confirmedFinishAt = readout.finishAtMs;
    void run(() => flow.loadSkills());
  });
</script>

<section class="panel">
  <header class="panel-head">
    <h2 class="panel-title">Skills</h2>
    <span class="controls">
      <button type="button" disabled={busy} onclick={() => run(() => flow.loadSkills())}>
        Refresh
      </button>
    </span>
  </header>
  <!-- ⚠ THE DESCRIPTION WENT, THE CLOCK STAYED. "What you know, and what you
       are learning next" is the window's own title in a longer form; where the
       training actually runs is the thing a player would otherwise assume
       wrongly, and assume expensively. -->
  <p class="note">
    Training runs on the server's clock — it keeps going whether or not this
    page is open.
  </p>
  {#if error}
    <p class="error">{error}</p>
  {/if}
  {#if sheet.error}
    <p class="error">{sheet.error}</p>
  {/if}
  <!-- (A refusal the client's own dialog said is not said again here: ClientDialogs.svelte.) -->
  {#if sheet.actionError && !sheet.actionErrorSaid}
    <p class="error">{sheet.actionError}</p>
  {/if}
  {#if sheet.lastAction && !sheet.actionError}
    <p class="note">{sheet.lastAction}.</p>
  {/if}

  {#if sheet.loaded}
    <ul class="hold-strip">
      <li><span class="hold-name">Skill points</span>
        <span class="hold-fill">{formatSkillPoints(sheet.totalSkillPoints ?? 0)}</span></li>
      <li><span class="hold-name">Skills known</span>
        <span class="hold-fill">{allSkills.length}</span></li>
      <li><span class="hold-name">Groups</span>
        <span class="hold-fill">{groups.length}</span></li>
      {#if (sheet.freeSkillPoints ?? 0) > 0}
        <li><span class="hold-name">Unallocated</span>
          <span class="hold-fill">{formatSkillPoints(sheet.freeSkillPoints ?? 0)}</span></li>
      {/if}
    </ul>
  {/if}
</section>

<section>
  <h2>Training now</h2>
  {#if !sheet.loaded}
    <p class="note">Reading your skill sheet…</p>
  {:else if queue === null}
    <p class="error">
      Your training queue could not be read, so what you are learning is unknown.
    </p>
  {:else if paused}
    <p class="empty">
      Training is paused. Your queue is kept as it is: start it again when you are ready.
    </p>
  {:else if training === null}
    <p class="empty">
      Nothing is training. Pick a skill below and add it to the queue.
    </p>
  {:else}
    <div class="hud-gauge">
      <div class="hud-head">
        <span class="cell-item">
          <TypeIcon typeID={training.typeID} name={skillName(training.typeID)} size="md" />
          <span class="hud-label">{skillName(training.typeID)} {romanLevel(training.toLevel)}</span>
        </span>
        <span class="hud-value">{formatDuration(training.remainingMs)} left</span>
      </div>
      <div
        class="hud-track"
        role="meter"
        aria-label={`${skillName(training.typeID)} ${romanLevel(training.toLevel)} training progress`}
        aria-valuenow={Math.round(training.fraction * 100)}
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <span class="hud-fill" style={`width: ${training.fraction * 100}%`}></span>
      </div>
      <p class="note">
        {formatSkillPoints(training.skillPoints)} of
        {formatSkillPoints(training.destinationSP)} skill points,
        at {formatSkillPoints(training.skillPointsPerMinute)} a minute.
      </p>
    </div>
  {/if}
</section>

<section>
  <header class="panel-head">
    <h2>Up next</h2>
    <span class="controls">
      {#if paused}
        <button type="button" disabled={busy} onclick={startTraining}>Start training</button>
      {:else if (queue?.entries.length ?? 0) > 0}
        <button type="button" disabled={busy} onclick={pauseTraining}>Pause training</button>
      {/if}
    </span>
  </header>
  <!-- svelte-ignore a11y_no_static_element_interactions, a11y_no_noninteractive_tabindex -->
  <div class="queue-drop" data-ui-pointer={SKILLS_POINTERS.queue} tabindex="0" ondragover={queueDragOver} ondragleave={queueDragLeave} ondrop={(event) => void queueDrop(event, null)}
    onkeydown={(event) => { if (event.key === "Delete" && selectedEntries.length > 0) { event.preventDefault(); void removeSelected(); } }}>
  {#if purchase !== null}
    {@const open = purchase}
    <div class="queue-purchase" role="dialog" aria-label={resolvedName($names.resolved, "type", open.typeID, "")}>
      <div class="queue-purchase-box">
      <p>{open.offer.sold
        ? purchaseWord("UI/SkillQueue/ConfirmSkillPurchase", { skill: open.typeID, price: open.offer.price ?? 0 })
        : purchaseWord("UI/SkillQueue/ErrorSkillIsRare", { skill: open.typeID })}</p>
      <span class="queue-purchase-buttons">
        <button type="button" onclick={() => void purchaseAnswer("cancel")}>{purchaseWord("UI/Common/Cancel")}</button>
        {#if open.offer.sold}
          <button type="button" class="primary" disabled={busy} onclick={() => void purchaseAnswer("buy")}>{purchaseWord(open.offer.requirementsTrained ? "UI/Skills/BuyAndTrain" : "UI/Skills/BuySkill")}</button>
        {:else}
          <button type="button" onclick={() => void purchaseAnswer("market")}>{purchaseWord("UI/Inventory/ItemActions/ViewTypesMarketDetails")}</button>
        {/if}
      </span>
      </div>
    </div>
  {/if}
  {#if queue === null}
    <p class="error">The queue could not be read.</p>
  {:else if queue.entries.length === 0}
    <p class="empty" class:drop-end={dropLine !== null && dropLine.at === "end"} class:drop-refused={dropLine?.color === "refused"}>The queue is empty.</p>
  {:else}
    <p class="note">
      {queue.entries.length} of {queue.maxEntries} places used.
      {#if paused}
        Nothing on the queue is training while it is paused.
      {:else}
        Everything on the queue finishes {finishText(queue.reckonedEndMs ?? queue.endTimeMs)}.
      {/if}
    </p>
    <div class="table-wrap overflow-x-auto">
      <table class="guests reflow">
        <thead>
          <tr>
            <th>Skill</th>
            <th>To</th>
            <th class="num">Time</th>
            <th>Order</th>
          </tr>
        </thead>
        <tbody>
          {#each queue.entries as entry, index (`${entry.typeID}-${entry.toLevel}-${index}`)}
            {@const lineHere = dropLine !== null && (dropLine.at === index || (dropLine.at === "end" && index === queue.entries.length - 1))}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
            <tr draggable="true" ondragstart={(event) => queueEntryDrag(event, index)} ondragend={endSkillDrag}
              ondragover={(event) => rowDragOver(event, index)} ondrop={(event) => void queueDrop(event, index)}
              onclick={(event) => { if (!(event.target instanceof Element && event.target.closest("button"))) selectEntry(index, event.ctrlKey, event.shiftKey); }}
              oncontextmenu={(event) => void openQueueMenu(event, index)} title={queueHint(entry.typeID)}
              class:selected={selectedKeys.includes(entryKey(entry.typeID, entry.toLevel))}
              class:drop-above={lineHere && dropLine?.at !== "end"} class:drop-below={lineHere && dropLine?.at === "end"}
              class:drop-refused={lineHere && dropLine?.color === "refused"} class:drop-move={lineHere && dropLine?.color === "move"}>
              <td data-label="Skill">
                <span class="cell-item">
                  <TypeIcon typeID={entry.typeID} name={skillName(entry.typeID)} />
                  <span>{skillName(entry.typeID)}</span>
                </span>
              </td>
              <td data-label="To">{romanLevel(entry.toLevel)}</td>
              <!-- Each level's time as the client's queue shows it: the level in training counts down to its end, every other
                   its own length (GetAllTrainingLengths); and the booster's mark. Where it was not reckoned, its end. -->
              <td data-label="Time" class="num">
                {#if paused}
                  paused
                {:else if index === 0 && queue.active && entry.endTimeMs !== null}
                  {formatDuration(Math.max(0, entry.endTimeMs - serverNowMs))}
                {:else if entry.lengthMs !== null && entry.lengthMs !== undefined}
                  {formatDuration(entry.lengthMs)}
                {:else}
                  {finishText(entry.endTimeMs)}
                {/if}
                {#if entry.accelerated}
                  <img class="accelerated" src={clientTexture("res:/UI/Texture/Crimewatch/booster.png")} alt={acceleratedWord} title={acceleratedWord} width="16" height="16" />
                {/if}
              </td>
              <td data-label="Order">
                <span class="queue-controls">
                  <button
                    type="button"
                    disabled={busy || index === 0}
                    aria-label={`Move ${skillName(entry.typeID)} earlier`}
                    onclick={() => move(index, -1)}
                  >Up</button>
                  <button
                    type="button"
                    disabled={busy || index === queue.entries.length - 1}
                    aria-label={`Move ${skillName(entry.typeID)} later`}
                    onclick={() => move(index, 1)}
                  >Down</button>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Take ${skillName(entry.typeID)} off the queue`}
                    onclick={() => removeAt(index)}
                  >Remove</button>
                </span>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
  </div>
</section>

{#if queueMenu !== null}
  {@const menuFor = queueMenu}
  <SkillRowMenu {store} {flow} skill={menuFor.typeID} entries={menuFor.entries} x={menuFor.x} y={menuFor.y}
    onClose={() => { queueMenu = null; }} onRemove={() => void removeSelected()} />
{/if}

<div class="skill-top-tabs controls" role="tablist" aria-label="Skills">
  <button type="button" role="tab" data-ui-pointer={SKILLS_POINTERS.plans} aria-selected={topPanel === "plans"}
    onclick={() => chooseTopPanel("plans")}>Skill Plans</button>
  <button type="button" role="tab" data-ui-pointer={SKILLS_POINTERS.catalogue} aria-selected={topPanel === "catalogue"}
    onclick={() => chooseTopPanel("catalogue")}>Skill Catalogue</button>
</div>
<div role="tabpanel" aria-label="Skill Plans" hidden={topPanel !== "plans"}>
  <PersonalSkillPlans {store} {flow} showPlans={() => chooseTopPanel("plans")} />
</div>

<section role="tabpanel" aria-label="Skill Catalogue" hidden={topPanel !== "catalogue"}>
  <header class="panel-head">
    <h2>What you know</h2>
    <span class="controls">
      <label>
        Find a skill
        <input type="search" bind:value={filter} placeholder="Gunnery, Shields…" />
      </label>
    </span>
  </header>
  {#if !sheet.loaded}
    <p class="note">Reading your skill sheet…</p>
  {:else if sheet.skills === null}
    <p class="error">Your skills could not be read.</p>
  {:else if matchingGroups.length === 0}
    <p class="empty">No skill matches that.</p>
  {:else}
    {#each matchingGroups as group (group.groupName)}
      <h3>
        <button
          type="button"
          class="group-toggle"
          aria-expanded={!collapsed.includes(group.groupName)}
          onclick={() => (collapsed = collapsed.includes(group.groupName)
            ? collapsed.filter((name) => name !== group.groupName)
            : [...collapsed, group.groupName])}
        >
          {group.groupName}
        </button>
        <small class="note">
          {group.maxedCount} of {group.skills.length} at V ·
          {formatSkillPoints(group.totalSkillPoints)} skill points
        </small>
      </h3>
      {#if !collapsed.includes(group.groupName)}
        <div class="table-wrap overflow-x-auto">
          <table class="guests reflow">
            <thead>
              <tr>
                <th>Skill</th>
                <th>Level</th>
                <th class="num">Skill points</th>
                <th>Train</th>
              </tr>
            </thead>
            <tbody>
              {#each group.skills as skill (skill.typeID)}
                <tr>
                  <td data-label="Skill">
                    <span class="cell-item">
                      <TypeIcon typeID={skill.typeID} name={skill.name} />
                      <span>{skill.name}</span>
                    </span>
                  </td>
                  <td data-label="Level">
                    <span class="rank" role="img" aria-label={`Level ${romanLevel(skill.level) || "zero"}`}>
                      {#each levelSquares(skill, queue) as state}
                        <span class="rank-pip rank-{state}"></span>
                      {/each}
                    </span>
                  </td>
                  <td data-label="Skill points" class="num">
                    {formatSkillPoints(skill.skillPoints)}
                    {#if skillProgress(skill).nextLevelSkillPoints !== null}
                      <small class="note">
                        of {formatSkillPoints(skillProgress(skill).nextLevelSkillPoints ?? 0)}
                        for {romanLevel(skillProgress(skill).nextLevel ?? 0)}
                      </small>
                    {/if}
                  </td>
                  <td data-label="Train">
                    {#if nextLevelFor(skill) === null}
                      <span class="badge good">Finished</span>
                    {:else}
                      <button
                        type="button"
                        disabled={busy}
                        onclick={() => addNextLevel(skill)}
                      >Queue {romanLevel(nextLevelFor(skill) ?? 0)}</button>
                    {/if}
                    <!--
                      Unallocated SP had no way to be spent at all: the sheet
                      counted them and offered nothing. The button appears only
                      on rows where the server would accept them, and says the
                      AMOUNT — which is capped by what the level still needs and
                      by what is actually held, whichever is smaller.
                    -->
                    {#if freeSkillPoints > 0}
                      {@const plan = freeSkillPointsPlan(skill, freeSkillPoints)}
                      {#if plan.points > 0}
                        <button
                          type="button"
                          class="minor"
                          disabled={busy}
                          title={`Spend ${formatSkillPoints(plan.points)} of your unallocated skill points on ${skill.name}`}
                          onclick={() => applyFreePoints(skill, plan.points)}
                        >Apply {formatSkillPoints(plan.points)} SP</button>
                      {/if}
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    {/each}
  {/if}
</section>

<style>
  .skill-top-tabs { display: flex; padding-block: 0.5rem; gap: 0.25rem; }
  .skill-top-tabs [aria-selected="true"] { border-color: var(--accent, #6ab6db); }
</style>
