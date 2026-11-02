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
  const stages: { key: string; label: string; stepIDs: string[] }[] = [];
  for (const step of doc.program) {
    const id = step.id;
    let key: string;
    let label: string;
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
      stages.push({ key, label, stepIDs: [id] });
    }
  }
  return stages.map(({ label, stepIDs }) => ({ label, stepIDs }));
}

function systemName(step: BotScript["program"][number]): string | null {
  if (step.kind !== "macro") return null;
  const arg = (step.args as Record<string, unknown>).system as
    | { kind?: string; ref?: { name?: unknown } }
    | undefined;
  const name = arg?.ref?.name;
  return typeof name === "string" && name.length > 0 ? name : null;
}

export function startWatch(kind: "haul" | "restart", stages: readonly PiRunStage[] = []): PiRunWatch {
  return { kind, stages, reached: -1, seen: false };
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

/** The owner's read answered (or failed, `null`): the run's ending is known. */
export function watchEnded(watch: PiRunWatch, end: PiRunEnd | null): PiRunWatch {
  return { ...watch, ending: false, ended: end };
}

const KIND_WORDS = { haul: "haul", restart: "restart" } as const;

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
        tone: "ended",
        over: !watch.ending,
      };
    }
    const at = watch.reached >= 0 && watch.reached <= last ? ` at ${watch.stages[watch.reached]!.label}` : "";
    return {
      stages: stagesWith((index) =>
        index < watch.reached ? "done" : index === watch.reached ? "stopped" : "todo"),
      words: `The ${what} stopped${at}${end.why ? `: ${end.why}` : "."}`,
      tone: "stopped",
      over: true,
    };
  }

  const current = Math.max(0, watch.reached);
  const said = bot?.why ?? bot?.phase ?? null;
  const paused = bot?.status === "paused";
  return {
    stages: stagesWith((index) => (index < current ? "done" : index === current ? "current" : "todo")),
    words: paused
      ? `Paused${said ? `: ${said}` : "."}`
      : said ?? (watch.seen ? "Running." : "Starting on the server..."),
    tone: paused ? "paused" : "running",
    over: false,
  };
}
