// A PI run's progress as the board draws it: the haul as a row of stages, the
// restart as one live sentence, and how either ended.
//
// ⚠ THE STAGES ARE READ OFF THE DOCUMENT THAT WAS STARTED, never rebuilt from
// what is ticked now. The player can untick a colony while the lap flies; the
// stepper must still name the systems the run is actually visiting.
//
// ⚠ THE PUBLIC ROSTER CANNOT SAY HOW A RUN ENDED. A finished run drops off
// /api/bots/active, so "gone" is all the poll learns; how it went is the
// owner's read (app/piRunOutcome.ts), and until that answers the board says
// only that the run has ended.

import type { BotScript } from "../bots/botScript.ts";

/** One stop on the haul's route, and the program steps that make it up. */
export interface PiRunStage {
  readonly label: string;
  readonly stepIDs: readonly string[];
  /** The system a collecting stage visits, so a colony row can say where the run is with it. */
  readonly solarSystemID?: number;
}

/** The public roster's row for the pilot, as far as progress needs it. */
export interface PiRunBot {
  readonly status: string;
  readonly phase: string | null;
  readonly why: string | null;
  readonly stepPath: string | null;
}

/** How a run ended, from the owner's own list; null when it could not be read. */
export interface PiRunEnd {
  readonly status: string;
  readonly why: string | null;
}

/** What the window keeps per pilot while it watches a run it started. */
export interface PiRunWatch {
  readonly kind: "haul" | "restart";
  /** The haul's route; empty for a restart, which is one step. */
  readonly stages: readonly PiRunStage[];
  /** The colonies the haul was started for; empty for a restart. */
  readonly planetIDs: readonly number[];
  /** The browser's clock when this window started the run. */
  readonly startedAtMs: number;
  /** The furthest stage the roster has shown, or -1 before the first sighting. */
  readonly reached: number;
  /** True once the roster has listed the run at least once. */
  readonly seen: boolean;
  /** Set when the run left the roster: undefined while still looking, null when unreadable. */
  readonly ended?: PiRunEnd | null;
  /** True between the run leaving the roster and the owner's read answering. */
  readonly ending?: boolean;
}

export type PiStageState = "done" | "current" | "todo" | "stopped";

export interface PiRunView {
  readonly stages: readonly { readonly label: string; readonly state: PiStageState }[];
  readonly words: string;
  /** What the player does about a paused run whose reason is known (pauseHint); null otherwise. */
  readonly todo: string | null;
  readonly tone: "running" | "paused" | "done" | "stopped" | "ended";
  /** True once the run is over: the panel can be dismissed. */
  readonly over: boolean;
}

/**
 * The status a run that reached its program's end is left in (botHost.js
 * ENDED_STATUSES, bots/pilotRoster.ts runOutcomePhrase). "stopped" is a Stop
 * click or the run-time cap, "error" a problem.
 */
const FINISHED = "idle";

/**
 * The haul's route, grouped off its step ids (app/piDispatch.ts piHaulBotDoc):
 * launch, board (board-hauler + undock), one stage per system (fly-N +
 * collect-N + launches-N), unload (deliver + unload), home when a Deliver-to
 * station was picked; board-back rides on whichever stage is last.
 */
export function piHaulStages(doc: BotScript): PiRunStage[] {
  const stages: { key: string; label: string; stepIDs: string[]; solarSystemID?: number }[] = [];
  for (const step of doc.program) {
    const id = step.id;
    let key: string;
    let label: string;
    let solarSystemID: number | undefined;
    const system = /^(?:fly|collect|launches)-(\d+)$/.exec(id);
    if (id === "launch") {
      key = "launch";
      label = "Launch";
    } else if (id === "board-hauler" || id === "undock") {
      key = "board";
      label = "Board";
    } else if (system) {
      key = `system-${system[1]}`;
      label = systemName(step) ?? `System ${system[1]}`;
      solarSystemID = systemID(step) ?? undefined;
    } else if (id === "deliver" || id === "unload") {
      key = "unload";
      label = "Unload";
    } else if (id === "home") {
      key = "home";
      label = "Home";
    } else if (id === "board-back" && stages.length > 0) {
      // One tick long, so a 3 s poll would rarely see it as a stage of its own;
      // a run judged "stopped short" for missing it would be a false alarm.
      stages[stages.length - 1]!.stepIDs.push(id);
      continue;
    } else {
      key = id;
      label = id;
    }
    const last = stages[stages.length - 1];
    if (last && last.key === key) {
      last.stepIDs.push(id);
    } else {
      stages.push({ key, label, stepIDs: [id], ...(solarSystemID === undefined ? {} : { solarSystemID }) });
    }
  }
  return stages.map(({ label, stepIDs, solarSystemID }) =>
    solarSystemID === undefined ? { label, stepIDs } : { label, stepIDs, solarSystemID });
}

function systemRef(step: BotScript["program"][number]): { name?: unknown; id?: unknown } | null {
  if (step.kind !== "macro") return null;
  const arg = (step.args as Record<string, unknown>).system as
    | { kind?: string; ref?: { name?: unknown; id?: unknown } }
    | undefined;
  return arg?.ref ?? null;
}

function systemName(step: BotScript["program"][number]): string | null {
  const name = systemRef(step)?.name;
  return typeof name === "string" && name.length > 0 ? name : null;
}

function systemID(step: BotScript["program"][number]): number | null {
  const id = systemRef(step)?.id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function startWatch(
  kind: "haul" | "restart",
  startedAtMs: number,
  stages: readonly PiRunStage[] = [],
  planetIDs: readonly number[] = [],
): PiRunWatch {
  return { kind, stages, planetIDs, startedAtMs, reached: -1, seen: false };
}

/** Where a watched haul is with one colony; null when the colony is not in the run. */
export type PiColonyRunMark = "queued" | "collecting" | "collected" | "missed";

export function colonyRunMark(watch: PiRunWatch, planetID: number, solarSystemID: number): PiColonyRunMark | null {
  if (watch.kind !== "haul" || !watch.planetIDs.includes(planetID)) return null;
  const finished = watch.ended?.status === FINISHED;
  if (finished) return "collected";
  const stage = watch.stages.findIndex((candidate) => candidate.solarSystemID === solarSystemID);
  if (stage < 0) return null;
  if (stage < watch.reached) return "collected";
  const over = watch.ended !== undefined || watch.ending === true;
  if (over) return "missed";
  return stage === watch.reached ? "collecting" : "queued";
}

function stageOf(stages: readonly PiRunStage[], stepPath: string | null): number {
  if (stepPath === null) return -1;
  return stages.findIndex((stage) => stage.stepIDs.includes(stepPath));
}

/**
 * One roster poll. `bot` is the pilot's public row, or null when the pilot is
 * not listed. Returns the same object when nothing changed.
 */
export function watchPoll(watch: PiRunWatch, bot: PiRunBot | null): PiRunWatch {
  if (watch.ended !== undefined || watch.ending) return watch;
  if (bot === null) {
    // Never seen: the start had not reached the roster yet. Keep waiting; the
    // window stops watching a run whose start was refused.
    return watch.seen ? { ...watch, ending: true } : watch;
  }
  const reached = Math.max(watch.reached, stageOf(watch.stages, bot.stepPath));
  return watch.seen && reached === watch.reached ? watch : { ...watch, seen: true, reached };
}

/**
 * True when a poll moved the haul past a system it collects in: those
 * colonies' launchpads have just been emptied, so their storage as last read
 * is now wrong and worth reading again.
 */
export function leftCollectingStage(before: PiRunWatch, after: PiRunWatch): boolean {
  if (after.kind !== "haul" || after.reached <= before.reached) return false;
  for (let index = Math.max(0, before.reached); index < after.reached; index++) {
    if (after.stages[index]?.solarSystemID !== undefined) return true;
  }
  return false;
}

/** The owner's read answered (or failed, `null`): the run's ending is known. */
export function watchEnded(watch: PiRunWatch, end: PiRunEnd | null): PiRunWatch {
  return { ...watch, ending: false, ended: end };
}

const KIND_WORDS = { haul: "haul", restart: "restart" } as const;
const AGAIN_WORDS = { haul: "Haul again", restart: "restart the extractors again" } as const;

/** A paused run's reason the window knows the fix for: the cause, short, and what to do. */
export interface PiPauseHint {
  readonly says: string;
  readonly todo: string;
}

// ⚠ THE REASONS ARE THE MACROS' OWN WORDS (nav/scriptMacros.ts: collectCustoms,
// boardPlanetaryHauler, restartExtractors, launchCommodities, ...), matched
// exactly. Reword one there and it falls back to the bot's words here, which is
// still right; piRunProgress.test.ts pins that each one is still said there.
//
// ⚠ A PAUSED SERVER RUN NEVER CARRIES ON BY ITSELF. A blocked step pauses the
// runner and a server bot has no Resume (only Stop), so every fix ends with
// stopping the run and starting it again.
const PAUSE_HINTS: readonly {
  readonly match: string | RegExp;
  readonly hint: (said: string, again: string) => PiPauseHint;
}[] = [
  {
    match: "This pilot does not have enough ISK to pay the customs office's export tax. Add ISK to its wallet and start the haul again.",
    hint: (_said, again) => ({
      says: "The pilot has too little ISK to pay the customs office's export tax.",
      todo: `Stop the run, put ISK in the pilot's wallet, then ${again}.`,
    }),
  },
  {
    match: "No ship with a planetary commodities hold (an Epithal) is parked at this station.",
    hint: (_said, again) => ({
      says: "No ship with a planetary hold (an Epithal) is parked at the pilot's station.",
      todo: `Stop the run, park an Epithal (or another ship with a planetary hold) at that station, then ${again}.`,
    }),
  },
  {
    match: "The trip home failed and the ship docked elsewhere for safety. Dock at home before boarding the planetary hauler.",
    hint: (_said, again) => ({
      says: "The trip to the hauler failed, so the ship docked elsewhere for safety.",
      todo: `Stop the run, fly the pilot to the station where its Epithal is parked, then ${again}.`,
    }),
  },
  {
    // restartExtractors: "2 of 5 extractor restarts did not take - the server refused them. The bot log names the reason."
    match: /^(.+) The bot log names the reason\.$/,
    hint: (said, again) => ({
      says: said.replace(/ The bot log names the reason\.$/, ""),
      todo: `The Bot Manager's log for this run has the server's answer. Stop the run, then ${again} once that is sorted.`,
    }),
  },
  {
    // "The extractor restarts kept not taking, so the bot stopped." and its kin.
    match: /kept not taking, so the bot stopped\.$/,
    hint: (said, again) => ({
      says: said,
      todo: `The Bot Manager's log for this run has what the server answered. Stop the run, then ${again}.`,
    }),
  },
];

/** The fix for a paused run's reason, or null when the window does not know it. */
export function pauseHint(kind: PiRunWatch["kind"], said: string | null): PiPauseHint | null {
  if (said === null) return null;
  const found = PAUSE_HINTS.find(({ match }) => (typeof match === "string" ? match === said : match.test(said)));
  return found === undefined ? null : found.hint(said, AGAIN_WORDS[kind]);
}

/** What the board draws for a watched run. `bot` is the live row, or null. */
export function piRunView(watch: PiRunWatch, bot: PiRunBot | null): PiRunView {
  const what = KIND_WORDS[watch.kind];
  const last = watch.stages.length - 1;
  const stagesWith = (state: (index: number) => PiStageState) =>
    watch.stages.map((stage, index) => ({ label: stage.label, state: state(index) }));

  if (watch.ended !== undefined || watch.ending) {
    const end = watch.ended ?? null;
    // Judged by the server's status, never by the last stage the poll saw: a
    // quick final step can end between two polls.
    if (end !== null && end.status === FINISHED) {
      return {
        stages: stagesWith(() => "done"),
        words: `The ${what} finished. The colonies are read again.`,
        todo: null,
        tone: "done",
        over: true,
      };
    }
    if (end === null) {
      return {
        stages: stagesWith((index) => (index <= watch.reached ? "done" : "todo")),
        words: watch.ending
          ? `The ${what} has ended. Looking up how it went...`
          : `The ${what} has ended. The Bot Manager says how it went.`,
        todo: null,
        tone: "ended",
        over: !watch.ending,
      };
    }
    const at = watch.reached >= 0 && watch.reached <= last ? ` at ${watch.stages[watch.reached]!.label}` : "";
    return {
      stages: stagesWith((index) =>
        index < watch.reached ? "done" : index === watch.reached ? "stopped" : "todo"),
      words: `The ${what} stopped${at}${end.why ? `: ${end.why}` : "."}`,
      todo: null,
      tone: "stopped",
      over: true,
    };
  }

  const current = Math.max(0, watch.reached);
  const said = bot?.why ?? bot?.phase ?? null;
  const paused = bot?.status === "paused";
  // A known reason is said short, with what to do; any other in the bot's words.
  const hint = paused ? pauseHint(watch.kind, said) : null;
  return {
    stages: stagesWith((index) => (index < current ? "done" : index === current ? "current" : "todo")),
    words: paused
      ? `Paused${hint ? `: ${hint.says}` : said ? `: ${said}` : "."}`
      : said ?? (watch.seen ? "Running." : "Starting on the server..."),
    todo: hint?.todo ?? null,
    tone: paused ? "paused" : "running",
    over: false,
  };
}
