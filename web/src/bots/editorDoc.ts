// The Bot Builder's DOCUMENT layer: a saved bot in, the editor's state out,
// and back again. These two functions decide what JSON a bot is saved as, so
// they are the last thing that should have lived inside a Svelte component —
// where nothing could test them, because Svelte components in this project are
// neither type-checked (docs/svelte-typecheck-gap.md) nor reachable outside an
// SSR render. `editorDoc.test.ts` now round-trips every bundled example and
// every starter seed through the pair and compares the encodings byte for byte.
//
// ⚠ THE PROPERTY THIS MODULE OWES: opening a bot and saving it without touching
// anything must produce the SAME document. The library is platform-wide and
// `rev`-checked, so a lossy round-trip is not a private annoyance — it rewrites
// a bot other accounts are running, silently, on a save the player thought was
// a no-op.

import {
  type BotScript,
  type BranchBlock,
  type InterruptRow,
  type LoopBlock,
  type LoopBodyNode,
  type MacroID,
  type MacroStep,
  type ProgramNode,
  type Repeat,
  type SubBotNode,
  type WorldRef,
  MAX_NOTES_LEN,
  startingStation,
} from "./botScript.ts";
import type { FlatProgramNode, IdGen } from "./scriptEdit.ts";

/** How the top-level repeat reads in the editor's own control. */
export type RepeatMode = "forever" | "times" | "once";

/**
 * Everything the editor holds about the bot being edited. The plan is ONE flat
 * list of what a loop body may hold (steps and branches) plus sub-bot nodes,
 * which are legal only at the top level — so the same list builds either a
 * looping bot or a run-once one, and `repeatMode` decides which.
 */
export interface EditorState {
  readonly name: string;
  readonly notes: string;
  readonly repeatMode: RepeatMode;
  readonly repeatCount: number;
  readonly home: WorldRef;
  readonly watches: readonly InterruptRow[];
  readonly steps: readonly FlatProgramNode[];
  /** Existing v1 prefix before the final main loop; finite programs stay finite. */
  readonly startup: readonly FlatProgramNode[];
  /**
   * A program the flat list cannot hold — several loops, or a loop beside loose
   * steps — kept VERBATIM so it still runs and still exports unchanged. When
   * this is set the editor renders read-only and `toScript` returns it
   * untouched. Its program is edited through import/export, never flattened.
   */
  readonly advancedProgram: readonly ProgramNode[] | null;
  /**
   * The outer loop's own id and `until`, carried across a round trip.
   *
   * ⚠ NOT COSMETIC, AND NOT ALWAYS "main-loop". The editor used to rebuild the
   * loop as `{ id: "main-loop" }` with no `until` no matter what it had opened,
   * so loading a bot whose loop was named anything else — or which stopped on a
   * condition of its own — and pressing Save rewrote the document. `null` means
   * "there was no loop to preserve", and a new bot gets the historic default.
   */
  readonly loopID: string | null;
  readonly loopUntil: LoopBlock["until"];
}

/** The id a bot that has never held a loop gets when it grows one. */
export const DEFAULT_LOOP_ID = "main-loop";

/** The plan a brand-new bot opens with. Player-facing content: if a test wants
 * different steps, the test is wrong. */
export function newEditorState(): EditorState {
  return {
    name: "My mining bot",
    notes: "",
    repeatMode: "times",
    repeatCount: 20,
    home: startingStation(),
    watches: [{ id: "w-shield", when: { kind: "shield-below", fraction: 0.3 }, respond: "dock-and-pause" }],
    steps: [
      { id: "s-undock", kind: "macro", macro: "undock", args: {} },
      {
        id: "s-mine",
        kind: "macro",
        macro: "mine-at-belt",
        args: { belt: { kind: "belt", belt: { mode: "nearest" } } },
        until: { kind: "ore-hold-at-least", fraction: 0.9 },
      },
      {
        id: "s-haul",
        kind: "macro",
        macro: "deliver-ore",
        args: { station: { kind: "station", ref: startingStation() } },
      },
    ],
    advancedProgram: null,
    startup: [],
    loopID: null,
    loopUntil: undefined,
  };
}

/**
 * Open a decoded document in the editor. Three shapes, and the third is the
 * reason the other two can stay simple:
 *
 *  1. exactly one top-level loop — the flat list IS its body, and the repeat
 *     control shows the loop's own repeat;
 *  2. no loop at all — a run-once list the editor holds directly;
 *  3. anything else (several loops, or a loop beside loose steps) — not a shape
 *     one list can hold, so it is preserved verbatim and shown read-only rather
 *     than silently flattened into a different bot.
 */
export function toEditorState(doc: BotScript): EditorState {
  const base = {
    name: doc.name,
    notes: doc.notes,
    home: doc.home,
    watches: [...doc.interrupts],
  };
  const last = doc.program.at(-1);
  if (last?.kind === "loop" && doc.program.slice(0, -1).every(node => node.kind !== "loop")) {
    return {
      ...base,
      repeatMode: last.repeat.kind === "forever" ? "forever" : "times",
      repeatCount: last.repeat.kind === "times" ? last.repeat.count : 20,
      steps: [...last.body],
      startup: doc.program.slice(0, -1) as FlatProgramNode[],
      advancedProgram: null,
      loopID: last.id,
      loopUntil: last.until,
    };
  }
  if (doc.program.every((node): node is FlatProgramNode => node.kind !== "loop")) {
    return {
      ...base,
      repeatMode: "once",
      repeatCount: 20,
      // No filter: `every` above has already narrowed the whole program to what
      // the flat list may hold, so a filter here would be a comparison the
      // compiler knows can never be true.
      steps: [...doc.program],
      startup: [],
      advancedProgram: null,
      loopID: null,
      loopUntil: undefined,
    };
  }
  return {
    ...base,
    repeatMode: "once",
    repeatCount: 20,
    // The flattened contents, so that ADDING a step turns this into a plain
    // flat bot rather than leaving the editor with nothing to show.
    steps: doc.program.flatMap((node): FlatProgramNode[] =>
      node.kind === "macro" || node.kind === "branch" || node.kind === "sub-bot" ? [node] : [...node.body],
    ),
    advancedProgram: doc.program,
    startup: [],
    loopID: null,
    loopUntil: undefined,
  };
}

/** True when the plan contains a sub-bot node, which forces a run-once bot. */
export function hasSubBot(steps: readonly FlatProgramNode[]): boolean {
  return steps.some((node) => node.kind === "sub-bot");
}

/**
 * Build the document the editor's state describes.
 *
 * ⚠ A sub-bot node is legal only at the TOP level (an included bot may carry
 * loops of its own), so a plan containing one always builds a run-once bot —
 * the repeat control says as much rather than silently disagreeing with this.
 */
export function toScript(state: EditorState): BotScript {
  return {
    format: "evejs-bot-script",
    version: 1,
    name: state.name,
    notes: state.notes.slice(0, MAX_NOTES_LEN),
    home: state.home,
    interrupts: [...state.watches],
    program: buildProgram(state),
  };
}

function buildProgram(state: EditorState): readonly ProgramNode[] {
  if (state.advancedProgram !== null) {
    return state.advancedProgram;
  }
  if (state.steps.length === 0 && state.startup.length === 0) return [];
  if (state.repeatMode === "once" || hasSubBot(state.steps)) {
    if (state.startup.length) throw new Error("Startup requires an explicit main loop; do not flatten it into a finite program.");
    return [...state.steps];
  }
  const loop: LoopBlock = {
    id: state.loopID ?? DEFAULT_LOOP_ID,
    kind: "loop",
    repeat: buildRepeat(state),
    body: state.steps.filter((node): node is LoopBodyNode => node.kind !== "sub-bot"),
  };
  // `until` is optional on a loop, and an explicit `undefined` key is not the
  // same document as an absent one once it reaches the encoder.
  return [...state.startup, state.loopUntil === undefined ? loop : { ...loop, until: state.loopUntil }];
}

function buildRepeat(state: EditorState): Repeat {
  return state.repeatMode === "forever" ? { kind: "forever" } : { kind: "times", count: state.repeatCount };
}

// ─── What a newly added node is born as ──────────────────────────────────────
//
// These decide the JSON a step carries the moment a player adds it, which makes
// them document logic and not presentation — the reason they live here rather
// than in the picker that calls them. `editorDoc.test.ts` pins the emitted
// arguments for ALL of `MACRO_IDS`, so a default cannot be dropped in a rewrite
// unnoticed: a step whose sentence claims a default it no longer carries is
// the worst shape this bug can take, and nothing else compares the two.
//
// The rule these follow: seed an argument only where a sensible default EXISTS
// and leaving it out would make the step's own sentence a lie or make the step
// unusable. Where there is no honest default — a station to fly to, an item to
// trade, a pilot to invite — the argument stays unset and the validator asks
// for it, which is the visible constraint CodeStruct's finding argues for.

/** A fresh step of this macro, with the starting arguments worth having. */
export function newStepFor(macro: MacroID, makeId: IdGen): MacroStep {
  const id = makeId();
  if (macro === "mine-at-belt") {
    return {
      id,
      kind: "macro",
      macro,
      args: { belt: { kind: "belt", belt: { mode: "nearest" } } },
      until: { kind: "ore-hold-at-least", fraction: 0.9 },
    };
  }
  if (macro === "travel-to-belt") {
    // "Nearest" like `mine-at-belt`, so the step is not born with a blocking
    // problem the instant it is added. (This is the one place the rebuilt
    // editor deliberately emits different JSON from the old one.)
    return { id, kind: "macro", macro, args: { belt: { kind: "belt", belt: { mode: "nearest" } } } };
  }
  if (macro === "deliver-ore" || macro === "travel-to-station") {
    return { id, kind: "macro", macro, args: { station: { kind: "station", ref: startingStation() } } };
  }
  if (macro === "move-items") {
    return {
      id,
      kind: "macro",
      macro,
      args: { from: { kind: "place", place: "hangar" }, to: { kind: "place", place: "cargo" } },
    };
  }
  if (macro === "buy-item") {
    // The item stays to pick; the quantity and price get starting values to edit.
    return {
      id,
      kind: "macro",
      macro,
      args: {
        item: { kind: "itemType", typeID: null, name: null },
        quantity: { kind: "qty", value: 100 },
        price: { kind: "isk", value: 1000 },
      },
    };
  }
  if (macro === "sell-item") {
    return {
      id,
      kind: "macro",
      macro,
      args: { item: { kind: "itemType", typeID: null, name: null }, price: { kind: "isk", value: 1000 } },
    };
  }
  if (macro === "invite-to-fleet" || macro === "orbit-fleet-mate" || macro === "follow-fleet-mate") {
    // All three name a pilot with the same "character" arg and no honest
    // default — there is no sensible "invite/orbit/follow nobody" — so it
    // stays unbound and the validator asks the player to pick one before the
    // bot can start.
    return { id, kind: "macro", macro, args: { who: { kind: "character", charID: null, name: null } } };
  }
  if (macro === "join-advertised-fleet") {
    // Empty on purpose: only the player knows what the fleet will be called, and
    // the validator asks for a name before the bot can start.
    return { id, kind: "macro", macro, args: { fleetName: { kind: "text", text: "" } } };
  }
  if (macro === "travel-to-system") {
    // Unbound for the same reason set-destination is: there is no sensible
    // default system, and the validator asks for one before the bot can start.
    return {
      id,
      kind: "macro",
      macro,
      args: { system: { kind: "system", ref: { entity: "system", id: null, name: null, systemName: null } } },
    };
  }
  if (macro === "set-destination") {
    // Unbound on purpose: there is no sensible default place to fly to, and the
    // validator asks for one before the bot can start.
    return {
      id,
      kind: "macro",
      macro,
      args: {
        destination: { kind: "destination", ref: { entity: "station", id: null, name: null, systemName: null } },
      },
    };
  }
  return { id, kind: "macro", macro, args: {} };
}

/**
 * A fresh fork: "if <check>, do these; otherwise do those." It starts with one
 * step on the THEN side so it is VALID the moment it appears — an empty branch
 * is a blocking problem, and a control that produces a broken node when you
 * press it teaches that the editor is unsafe to touch.
 */
export function newBranch(makeId: IdGen): BranchBlock {
  return {
    id: makeId(),
    kind: "branch",
    when: { kind: "shield-below", fraction: 0.5 },
    then: [{ id: makeId(), kind: "macro", macro: "repair-ship", args: {} }],
    else: [],
  };
}

/** A fresh "run another saved bot" node. Which bot is picked in the inspector;
 * unset, the validator asks for one. */
export function newSubBot(makeId: IdGen): SubBotNode {
  return { id: makeId(), kind: "sub-bot", scriptID: null, name: null };
}
