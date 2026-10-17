// C2 — draft validation for the editor. Distinct from the codec: the codec
// REFUSES an untrusted file whole; this LISTS a live draft's fixable problems,
// one plain sentence per place, so the editor can show "3 things to fix" under
// the right rows and disable Start until they are cleared. Never throws.
//
// It shares `MACRO_SPECS` with the codec, so "what a step needs" is defined once.

import {
  MAX_CONDITION_FRACTION,
  MAX_ORE_HOLD_FRACTION,
  MAX_REPEAT_TIMES,
  MIN_CONDITION_FRACTION,
  MIN_REPEAT_TIMES,
  conditionAllowedAt,
  type BotScript,
  type BranchBlock,
  type Condition,
  type ConditionSite,
  type InterruptRow,
  type LoopBlock,
  type MacroStep,
} from "./botScript.ts";
import { MACRO_SPECS } from "./macroSpecs.ts";
import { haulingLeg } from "../nav/corporateHauling.ts";

/**
 * One fixable — or merely worth-mentioning — problem, anchored to a row by its
 * id (or a script-level key).
 *
 * `severity` splits what the editor already reported one flat list of into two
 * tiers (decision, `bot-builder-interface.md` §5.4):
 * - `"blocking"` — the bot cannot run as written. Marks the row amber, disables
 *   Save. Every check this module reported before severities existed stays
 *   blocking; nothing that used to stop a player is quietly downgraded.
 * - `"advisory"` — worth saying, never fatal. A grey note on the row.
 */
export interface ScriptProblem {
  /** The step / loop / interrupt id, or "name" / "home" / "program" / "watches". */
  readonly path: string;
  readonly sentence: string;
  readonly severity: "blocking" | "advisory";
}

function blocking(path: string, sentence: string): ScriptProblem {
  return { path, sentence, severity: "blocking" };
}

function advisory(path: string, sentence: string): ScriptProblem {
  return { path, sentence, severity: "advisory" };
}

/** Plain words for each argument, for "This step needs …". */
const ARG_LABEL: Readonly<Record<string, string>> = {
  belt: "a belt to work",
  station: "a station to go to",
  equipment: "mining equipment to run",
  item: "an item to trade",
  quantity: "how many to buy",
  price: "a price per unit",
  who: "a pilot to invite",
  channel: "a channel to talk in",
  message: "a message to send",
  fleetName: "a fleet name to look for",
  destination: "somewhere to go",
  system: "a solar system to go to",
  fitting: "a fitting to switch to",
  bookmark: "a saved bookmark to warp to",
  folder: "a bookmark folder to use",
  alsoFolder: "another bookmark folder to use",
  fromFolder: "the bookmark folder of sites to salvage",
  doneFolder: "the bookmark folder to file finished sites in",
  from: "where to move items from",
  to: "where to move items to",
  items: "something to load",
  pickupStation: "a pickup station",
  deliveryStation: "a delivery station",
  pickupCorpDivision: "a pickup corporation division",
  deliveryCorpDivision: "a delivery corporation division",
  stationA: "station A",
  stationB: "station B",
  pickupDivisionA: "the pickup division at A",
  deliveryDivisionB: "the delivery division at B",
  support: "a support pilot to work with",
};

/** Every fixable problem in a draft, in reading order. Empty means ready to start. */
export function validateScript(script: BotScript): readonly ScriptProblem[] {
  const problems: ScriptProblem[] = [];

  if (script.name.trim().length === 0) {
    problems.push(blocking("name", "Give your bot a name."));
  }
  const someWatchDocks = script.interrupts.some(
    (row) => row.respond === "dock-and-pause" || row.respond === "dock-and-repair",
  );
  if (
    someWatchDocks &&
    script.home.id === null &&
    script.home.starting !== true &&
    script.home.slot === undefined
  ) {
    problems.push(blocking("home", "Pick where the bot docks when a watch tells it to."));
  }
  if (script.home.entity === "structure" && script.interrupts.some((row) => row.respond === "dock-and-repair")) {
    problems.push(blocking("home", "Repair watches require a verified NPC station repair path."));
  }
  if (script.program.length === 0) {
    problems.push(blocking("program", "Add at least one step for the bot to do."));
  }

  // NO BLANKET "this bot has no watches" ADVISORY. Watches are the right answer
  // for a bot that flies unattended, and the wrong answer for one that never
  // leaves the station: "Operations closeout" docks, unloads, repairs and tidies
  // once, and has nothing to watch FOR. Warning there fires on correct work, and
  // an advisory that cries wolf on a good bot is how a player learns to stop
  // reading advisories. The risk that is actually worth naming — repeating with
  // no way to stop — is caught per-loop below, where it can be stated precisely.
  const hasWatches = script.interrupts.length > 0;

  for (const node of script.program) {
    if (node.kind === "loop") {
      validateLoop(node, hasWatches, problems);
    } else if (node.kind === "branch") {
      validateBranch(node, problems);
    } else if (node.kind === "sub-bot") {
      if (
        (node.scriptID === null || node.scriptID.trim().length === 0) &&
        (node.name === null || node.name.trim().length === 0)
      ) {
        problems.push(blocking(node.id, "Pick which saved bot this step runs."));
      }
    } else {
      validateStep(node, problems);
    }
  }

  for (const row of script.interrupts) {
    validateInterrupt(row, problems);
  }

  return problems;
}

function validateLoop(loop: LoopBlock, hasWatches: boolean, problems: ScriptProblem[]): void {
  if (loop.body.length === 0) {
    problems.push(blocking(loop.id, "This loop has no steps inside it."));
  }
  if (loop.repeat.kind === "times") {
    const count = loop.repeat.count;
    if (!Number.isInteger(count) || count < MIN_REPEAT_TIMES || count > MAX_REPEAT_TIMES) {
      problems.push(
        blocking(loop.id, `A loop can repeat between ${MIN_REPEAT_TIMES} and ${MAX_REPEAT_TIMES} times.`),
      );
    }
  }
  // Advisory: a loop that repeats forever with no `until` of its own relies
  // entirely on a watch to ever end. With no watch in the whole script either,
  // nothing will ever stop it.
  if (loop.repeat.kind === "forever" && loop.until === undefined && !hasWatches) {
    problems.push(advisory(loop.id, "This loop repeats forever and has no watch that can stop it."));
  }
  if (loop.until !== undefined) {
    validateCondition(loop.until, "until", loop.id, problems);
  }
  for (const element of loop.body) {
    // A loop body holds steps and branches; both get their own validation.
    if (element.kind === "branch") {
      validateBranch(element, problems);
    } else {
      validateStep(element, problems);
    }
  }
}

function validateStep(step: MacroStep, problems: ScriptProblem[]): void {
  const spec = MACRO_SPECS[step.macro];

  for (const argSpec of spec.args) {
    const arg = step.args[argSpec.key];
    if (arg === undefined) {
      if (argSpec.required) {
        const label = ARG_LABEL[argSpec.key] ?? "something it needs";
        problems.push(blocking(step.id, `This step needs ${label}.`));
      }
      continue;
    }
    // A station is unset only when it is neither pinned NOR a runtime binding
    // (the starting station, or a named board slot an earlier block fills in).
    if (arg.kind === "station" && arg.ref.id === null && arg.ref.starting !== true && arg.ref.slot === undefined) {
      problems.push(blocking(step.id, "Pick the station for this step."));
    }
    // A pinned belt is identified by its NAME, never its id: belt entity ids
    // are grid-local, so the runtime re-matches the name against the grid it
    // arrives on (see `beltTarget` in nav/scriptMacros.ts). A belt named by
    // hand therefore has no id at all, and demanding one — as this used to —
    // would block every belt a player typed.
    if (arg.kind === "belt" && arg.belt.mode === "chosen" && (arg.belt.ref.name ?? "").trim().length === 0) {
      problems.push(blocking(step.id, "Type the belt's name for this step, or choose the nearest one."));
    }
    // An agent slot the player ADDED but never filled. Leaving the slot out
    // entirely is fine — the step then uses the agent the find block remembered.
    if (arg.kind === "bookmark" && arg.bookmarkID === null && (arg.name === null || arg.name === "")) {
      problems.push(blocking(step.id, "Pick the saved spot for this step."));
    }
    if (arg.kind === "bookmarkFolder" && arg.folderID === null && (arg.name === null || arg.name.trim() === "")) {
      problems.push(blocking(step.id, "Pick the bookmark folder for this step."));
    }
    // A list the player ADDED but left empty. Only a REQUIRED one is a problem:
    // an empty "keep aboard" list means "keep nothing", which is the shipped
    // default, but an empty "what to load" list means a block that can only ever
    // load nothing.
    if (arg.kind === "itemList" && argSpec.required && arg.items.length === 0) {
      problems.push(
        blocking(step.id, "Pick what this step loads - an item, everything of its kind, or a name to match."),
      );
    }
    // A name pattern that is only whitespace matches nothing, so a step carrying
    // one would quietly do less than its sentence says.
    if (arg.kind === "itemList" && arg.items.some((item) => item.match === "name" && item.pattern.trim().length === 0)) {
      problems.push(blocking(step.id, "One of this step's name matches is blank - type what to match, or remove it."));
    }
    if (arg.kind === "itemType" && arg.typeID === null) {
      problems.push(blocking(step.id, "Pick the item for this step."));
    }
    if (arg.kind === "fitting" && arg.fittingID === null && (arg.name === null || arg.name === "")) {
      problems.push(blocking(step.id, "Pick the saved fitting for this step."));
    }
    if (arg.kind === "agent" && arg.ref.id === null) {
      problems.push(
        blocking(step.id, "Pick the agent for this step, or remove the pick to use the one your bot finds."),
      );
    }
    if (arg.kind === "character" && arg.charID === null) {
      // The invite's pilot is mandatory; a PvP `only` filter left unfilled just
      // needs the half-made pick resolved (pick someone, or clear it for "any").
      problems.push(
        blocking(
          step.id,
          argSpec.key === "only"
            ? "Pick the pilot to hunt, or clear the pick to go after any player."
            : "Pick the pilot to invite.",
        ),
      );
    }
    if (arg.kind === "text" && arg.text.trim().length === 0) {
      // The fleet-finder step's fleet name is its whole argument.
      problems.push(blocking(step.id, "Type the name of the fleet to look for in the fleet finder."));
    }
    if (arg.kind === "destination" && arg.ref.id === null) {
      problems.push(blocking(step.id, "Pick where this step sets the destination to."));
    }
    if (arg.kind === "system" && arg.ref.id === null) {
      problems.push(blocking(step.id, "Pick the solar system for this step."));
    }
  }

  if (step.macro === "find-distribution-agent") {
    const level = step.args["level"];
    if (level && (level.kind !== "count" || !Number.isSafeInteger(level.value) || level.value < 1 || level.value > 4)) {
      problems.push(blocking(step.id, "Choose a Distribution agent level from 1 to 4."));
    }
    const fallback = step.args["fallback"];
    if (fallback && (fallback.kind !== "toggle" || typeof fallback.enabled !== "boolean")) {
      problems.push(blocking(step.id, "Choose a valid lower-level fallback setting."));
    }
    const corporation = step.args["corporation"];
    if (corporation && (corporation.kind !== "corp" || !Number.isSafeInteger(corporation.id) || corporation.id === null || corporation.id <= 0)) {
      problems.push(blocking(step.id, "Choose the corporation or remove that filter."));
    }
  }

  if (step.macro === "haul-all" || step.macro === "route-hauler") {
    const returning = step.args["returnCargo"];
    if (!haulingLeg(step) || (returning?.kind === "toggle" && returning.enabled && !haulingLeg(step, true))) {
      problems.push(blocking(step.id, "Choose valid corporation divisions and resolve every explicit item filter before hauling."));
    }
    const bay = step.args["transportBay"];
    if (bay && (bay.kind !== "place" || !["cargo", "ore-hold"].includes(bay.place))) {
      problems.push(blocking(step.id, "A hauling hold restriction must be cargo or ore hold."));
    }
  }

  // The move block: moving a thing onto itself is a no-op the player did not mean.
  const fromArg = step.args["from"];
  const toArg = step.args["to"];
  if (
    fromArg !== undefined && toArg !== undefined &&
    fromArg.kind === "place" && toArg.kind === "place" &&
    fromArg.place === toArg.place
  ) {
    problems.push(blocking(step.id, "This step moves items to the same place they already are."));
  }

  if (spec.untilRequired && step.until === undefined) {
    problems.push(blocking(step.id, "This mining step needs something to stop it, like the ore hold being full."));
  }
  if (step.until !== undefined) {
    validateCondition(step.until, "until", step.id, problems);
  }
}

function validateBranch(branch: BranchBlock, problems: ScriptProblem[]): void {
  validateCondition(branch.when, "until", branch.id, problems);
  if (branch.then.length === 0 && branch.else.length === 0) {
    problems.push(blocking(branch.id, "This branch needs at least one step in one of its choices."));
  }
  for (const step of [...branch.then, ...branch.else]) {
    validateStep(step, problems);
  }
}

function validateInterrupt(row: InterruptRow, problems: ScriptProblem[]): void {
  validateCondition(row.when, "interrupt", row.id, problems);
}

function validateCondition(
  condition: Condition,
  site: ConditionSite,
  path: string,
  problems: ScriptProblem[],
): void {
  if (!conditionAllowedAt(condition.kind, site)) {
    problems.push(blocking(path, "This check only works out in space, so it can't be used to stop a step."));
    return;
  }
  if ("fraction" in condition) {
    const max = condition.kind === "ore-hold-at-least" ? MAX_ORE_HOLD_FRACTION : MAX_CONDITION_FRACTION;
    if (condition.fraction < MIN_CONDITION_FRACTION || condition.fraction > max) {
      problems.push(blocking(path, `That percentage must be between ${pct(MIN_CONDITION_FRACTION)} and ${pct(max)}.`));
    }
  }
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}
