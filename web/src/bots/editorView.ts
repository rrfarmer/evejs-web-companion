// The rebuilt Bot Builder's pure view model — everything `BotBuilder.svelte`
// needs to draw the numbered-sentence-list-plus-inspector shape from
// docs/bot-builder-interface.md §2/§3, so the component holds no display
// logic of its own (the same split as `libraryView.ts` / `macroCatalogView.ts`
// / `editorOptions.ts`: a pure core a test can drive without a DOM, and a thin
// component that renders it).
//
// This module does NOT invent a second sentence vocabulary. Every row's text
// comes from `scriptText.ts` (the R9a register for a valid program) — R9a
// forbids a third wording for the same fact, and `scriptText.ts`'s exhaustive
// switches already fail to compile on a macro/condition the format grows
// without a sentence for it.
//
// It also does not build a general tree walker. The format caps nesting at
// loop→branch (`LoopBodyNode = MacroStep | BranchBlock`, and a `BranchBlock`'s
// own `then`/`else` are `MacroStep[]` — never another loop or branch), so the
// flattening and lookup functions below enumerate exactly the shapes the type
// system admits. A future nesting level the format does not yet allow would
// need new cases here anyway; better that show up as a compiler error on an
// exhaustive switch than as a silent depth limit nobody wrote down.

import {
  type BranchBlock,
  type LoopBlock,
  type LoopBodyNode,
  type MacroStep,
  type ProgramNode,
  type SubBotNode,
} from "./botScript.ts";
import { branchSentence, repeatSentence, stepSentence, subBotSentence } from "./scriptText.ts";
import {
  CATEGORY_LABEL,
  macroCatalogList,
  type BlockCategory,
  type MacroCatalogEntry,
} from "./macroCatalogView.ts";
import type { ScriptProblem } from "./validateScript.ts";

// ─── 1. Row flattening for display ──────────────────────────────────────────
//
// "The row IS the summary; nothing expands in place" (§2). One row per node
// the player can see, in reading order, each carrying enough to render itself
// without the component re-deriving depth or numbering from the tree shape.

/** What kind of program node a row renders — drives the row's icon/prefix. */
export type PlanRowKind = "step" | "loop" | "branch" | "sub-bot";

/**
 * One line of "THE PLAN". `number` is set only for a row that sits directly
 * in `script.program` — per the wireframe (§2), a branch's `then`/`else` rows
 * and a loop's body rows are indented and UNNUMBERED, because they are not a
 * step in the top-to-bottom count a player is following; they are what one
 * numbered row expands into. `branchSide` says which half of a branch a row
 * belongs to, so the component can print the "then"/"else" label — `null` for
 * every row that is not inside a branch, including the branch header itself.
 */
export interface PlanRow {
  readonly nodeId: string;
  readonly kind: PlanRowKind;
  readonly sentence: string;
  /** 0 for a top-level row; +1 for each step into a loop body or a branch side. */
  readonly depth: number;
  readonly branchSide: "then" | "else" | null;
  readonly number: number | null;
}

/**
 * Flatten a whole plan into its display rows. Only `script.program`'s own
 * entries are numbered, left to right, 1-based — matching the wireframe's
 * "1 / 2 / ▸3 / 4 / 5 / 6", where the branch's `then`/`else` lines under row 6
 * carry no number of their own.
 */
export function flattenProgram(program: readonly ProgramNode[]): readonly PlanRow[] {
  const rows: PlanRow[] = [];
  let number = 0;
  for (const node of program) {
    number += 1;
    pushTopLevelNode(rows, node, number);
  }
  return rows;
}

function pushTopLevelNode(rows: PlanRow[], node: ProgramNode, number: number): void {
  if (node.kind === "macro") {
    rows.push(stepRow(node, 0, null, number));
    return;
  }
  if (node.kind === "sub-bot") {
    rows.push(subBotRow(node, 0, null, number));
    return;
  }
  if (node.kind === "loop") {
    rows.push(loopHeaderRow(node, 0, null, number));
    for (const element of node.body) {
      pushLoopBodyNode(rows, element, 1);
    }
    return;
  }
  // The only remaining case is a top-level branch — `ProgramNode` admits no
  // fifth shape, so this exhaustive fall-through is safe without a `default`.
  rows.push(branchHeaderRow(node, 0, null, number));
  pushBranchSide(rows, node, "then", 1);
  pushBranchSide(rows, node, "else", 1);
}

/** A loop's body: a plain step, or a branch (the one nesting the format allows
 * a loop to carry). Never another loop — `LoopBodyNode` has no such case. */
function pushLoopBodyNode(rows: PlanRow[], node: LoopBodyNode, depth: number): void {
  if (node.kind === "macro") {
    rows.push(stepRow(node, depth, null, null));
    return;
  }
  rows.push(branchHeaderRow(node, depth, null, null));
  pushBranchSide(rows, node, "then", depth + 1);
  pushBranchSide(rows, node, "else", depth + 1);
}

/**
 * One side of a branch, as its rows. An empty side prints nothing here —
 * `branchSentence` already says "do nothing" on the header row for that case,
 * so an empty "then"/"else" would otherwise show a label with nothing under it.
 */
function pushBranchSide(rows: PlanRow[], branch: BranchBlock, side: "then" | "else", depth: number): void {
  const steps = side === "then" ? branch.then : branch.else;
  for (const step of steps) {
    rows.push(stepRow(step, depth, side, null));
  }
}

function stepRow(step: MacroStep, depth: number, branchSide: "then" | "else" | null, number: number | null): PlanRow {
  return { nodeId: step.id, kind: "step", sentence: stepSentence(step), depth, branchSide, number };
}

function subBotRow(node: SubBotNode, depth: number, branchSide: "then" | "else" | null, number: number | null): PlanRow {
  return { nodeId: node.id, kind: "sub-bot", sentence: subBotSentence(node), depth, branchSide, number };
}

function loopHeaderRow(loop: LoopBlock, depth: number, branchSide: "then" | "else" | null, number: number | null): PlanRow {
  return { nodeId: loop.id, kind: "loop", sentence: repeatSentence(loop.repeat), depth, branchSide, number };
}

function branchHeaderRow(
  branch: BranchBlock,
  depth: number,
  branchSide: "then" | "else" | null,
  number: number | null,
): PlanRow {
  return { nodeId: branch.id, kind: "branch", sentence: branchSentence(branch), depth, branchSide, number };
}

// ─── 2. Problem index ────────────────────────────────────────────────────────
//
// `ScriptProblem[]` grouped by the row it belongs to, so a row can ask "what
// is wrong with me" in O(1) rather than the component re-filtering 64 steps'
// worth of problems on every render. `hasBlocking` is exposed SEPARATELY from
// the grouped list — the design (§3 "Validate") is explicit that blocking
// problems disable Save and advisories never do, so collapsing the two counts
// into one would silently reintroduce the bug the severity split was added to
// fix (an advisory-only document must never disable Save).

export interface ProblemIndex {
  readonly byPath: ReadonlyMap<string, readonly ScriptProblem[]>;
  /** True when ANY problem in the document is blocking — the header badge and
   * the Save button both read this, never a raw problem count. */
  readonly hasBlocking: boolean;
}

/** Build the index once per validation pass; every row lookup after that is a map read. */
export function buildProblemIndex(problems: readonly ScriptProblem[]): ProblemIndex {
  const byPath = new Map<string, ScriptProblem[]>();
  let hasBlocking = false;
  for (const problem of problems) {
    const existing = byPath.get(problem.path);
    if (existing === undefined) {
      byPath.set(problem.path, [problem]);
    } else {
      existing.push(problem);
    }
    if (problem.severity === "blocking") {
      hasBlocking = true;
    }
  }
  return { byPath, hasBlocking };
}

/** The problems anchored to one row/path — empty, never undefined, when it has none. */
export function problemsForPath(index: ProblemIndex, path: string): readonly ScriptProblem[] {
  return index.byPath.get(path) ?? [];
}

/** True when this one path carries a BLOCKING problem — the `⚠` on a single row. */
export function pathHasBlockingProblem(index: ProblemIndex, path: string): boolean {
  return problemsForPath(index, path).some((problem) => problem.severity === "blocking");
}

// ─── 3. Picker filtering ─────────────────────────────────────────────────────
//
// "[+ Step ▾] opens the picker: a search field, then category chips, then
// results... Categories stay visible; search filters across name, does, and
// needs" (§3). Browse and search compose rather than replace each other
// (§1's "Palette" note — Blockly shipped search rather than shrinking the
// toolbox), so a category filter and a query both narrow the SAME list.

/**
 * The catalogue entries matching `query` and, when given, `category`. Search
 * covers the macro's name, its `does` and `needs` text, and its category
 * label — all case-insensitively — so a player can find a block by what it's
 * called OR by what it does OR by the loop it belongs to. An empty (or
 * whitespace-only) query matches everything the category filter admits.
 */
export function filterMacroPicker(
  query: string,
  category: BlockCategory | null,
): readonly MacroCatalogEntry[] {
  const byCategory =
    category === null ? macroCatalogList() : macroCatalogList().filter((entry) => entry.category === category);
  const q = query.trim().toLowerCase();
  if (q.length === 0) {
    return byCategory;
  }
  return byCategory.filter((entry) => macroSearchText(entry).includes(q));
}

function macroSearchText(entry: MacroCatalogEntry): string {
  return [entry.name, entry.does, entry.needs ?? "", CATEGORY_LABEL[entry.category]].join(" ").toLowerCase();
}

// ─── 4. Selection resolution ─────────────────────────────────────────────────
//
// "Region 3 — Step inspector. Edits the selected row" (§2). Clicking a row
// gives the component a node id; this turns that id back into the node PLUS
// enough context (which branch side, whether it sits inside a loop) for the
// inspector to know what it is editing and for the row's `⋮` menu to know
// what it can do. Enumerates the same three legal nesting shapes as the
// flattener above — top level, loop body, either branch side — rather than
// walking a generic tree, for the same reason: a fourth shape is a type error
// before it is ever a runtime possibility.

/** What a resolved selection turns out to be, and where it lives. */
export interface SelectedNode {
  readonly node: ProgramNode | LoopBodyNode;
  /** Which side of a branch this node's OWN steps sit in — `null` for a
   * branch/loop header itself, or for a plain top-level step. */
  readonly branchSide: "then" | "else" | null;
  /** True when this node sits inside a loop's body (directly, or via one of
   * the loop's own branch's sides). */
  readonly inLoop: boolean;
}

/**
 * Find the node with this id anywhere the format allows one to sit: top
 * level, inside a loop's body, or inside either side of a branch (top-level
 * or nested one loop deep). Returns `null` rather than throwing when the id
 * is stale — a row can vanish between a click and a re-render (e.g. Delete),
 * and the inspector should just close, not crash.
 */
export function findSelectedNode(program: readonly ProgramNode[], id: string): SelectedNode | null {
  for (const node of program) {
    if (node.id === id) {
      return { node, branchSide: null, inLoop: false };
    }
    if (node.kind === "branch") {
      const found = findInBranchSides(node, id, false);
      if (found !== null) {
        return found;
      }
    }
    if (node.kind === "loop") {
      const found = findInLoopBody(node, id);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

function findInLoopBody(loop: LoopBlock, id: string): SelectedNode | null {
  for (const element of loop.body) {
    if (element.id === id) {
      return { node: element, branchSide: null, inLoop: true };
    }
    if (element.kind === "branch") {
      const found = findInBranchSides(element, id, true);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

function findInBranchSides(branch: BranchBlock, id: string, inLoop: boolean): SelectedNode | null {
  for (const step of branch.then) {
    if (step.id === id) {
      return { node: step, branchSide: "then", inLoop };
    }
  }
  for (const step of branch.else) {
    if (step.id === id) {
      return { node: step, branchSide: "else", inLoop };
    }
  }
  return null;
}
