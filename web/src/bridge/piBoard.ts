// The PI Manager's board (R108 slice 3), as a pure function of what was read.
//
// Several pilots' colonies in one list. Everything a player reads here is a
// sentence built from a server-stated fact; NOTHING HERE SIMULATES A COLONY
// (planets.ts), and nothing here fetches — the window hands this the readings it
// holds and renders what comes back.
//
// ---------------------------------------------------------------------------
// A MERGED VIEW IS NOT ONE MOMENT.
//
// Each pilot was read on its own, at its own instant. So every colony row
// carries the age of ITS pilot's reading, and the board says when the rows it
// merged were read far apart. Nothing here presents several readings as if they
// were one snapshot.
//
// ---------------------------------------------------------------------------
// FOUR OUTCOMES, PER PILOT.
//
// Being read, could not be read, has not built, and "the server reported no
// colony table" are four facts, and on a board spanning pilots each is said
// about the pilot it is true of. A failed read never erases the last good one:
// that reading stays, aged, beside the sentence saying the new one failed.

import type { Colony } from "../store/types.ts";
import type { PilotColonyReading } from "./piRoster.ts";
import type { PiRecipeBook } from "./piRecipes.ts";
import type { PiRunStage } from "./piRunProgress.ts";
import {
  attentionByColony,
  bySeverityThenTime,
  colonyAttentionWords,
  colonyLineWords,
  pinFill,
  type ColonyAttention,
  type ColonyFindingUrgency,
} from "./colonyAttention.ts";
import { colonyPlaceWords, formatDuration, serverNow, summarizeColony } from "./planets.ts";
import { extractorReroute } from "./colonyRoutes.ts";

/**
 * What the latest attempt to read a pilot did.
 *
 * - `none`        nobody has tried this session
 * - `reading`     a read is in flight
 * - `read`        the latest read answered for this pilot
 * - `failed`      the sign-in or the read itself failed
 * - `unanswered`  the read came back without this pilot (refused or failed)
 * - `no-account`  the hangar no longer knows which account this pilot is on
 */
export type PilotAttempt = "none" | "reading" | "read" | "failed" | "unanswered" | "no-account";

export interface PiBoardInput {
  /** The assigned pilots, in the player's order. */
  readonly members: readonly number[];
  /** Pilot names from the hangar. A pilot missing here is no longer in it. */
  readonly names: ReadonlyMap<number, string>;
  /** The last good reading per pilot — possibly from an earlier session. */
  readonly readings: ReadonlyMap<number, PilotColonyReading>;
  readonly attempts: ReadonlyMap<number, PilotAttempt>;
  /** The browser's clock now; each reading corrects it by its own offset. */
  readonly browserNowMs: number;
  /**
   * The recipe table, when it has been read: a starved factory is judged
   * against what its recipe needs. Without it, against what its routes bring.
   */
  readonly recipes?: PiRecipeBook | null;
  /** Pilots a server bot is flying now (GET /api/bots/active). */
  readonly activeBots?: ReadonlySet<number>;
  /** What the window's own starts did, per pilot. */
  readonly dispatch?: ReadonlyMap<number, PiDispatchState>;
}

/** A start from this window, as far as it has got. */
export type PiDispatchState =
  | { readonly kind: "starting" }
  // `exported` rides on a HAUL's start: what the customs-office hop sent up
  // before the lap began. Absent on a restart, which exports nothing.
  | {
      readonly kind: "started";
      readonly exported?: {
        readonly units: number;
        readonly colonies: number;
        readonly refusals: readonly string[];
        readonly atTheOffices?: true;
      };
      readonly stages?: readonly PiRunStage[];
    }
  | { readonly kind: "refused"; readonly sentence: string };

/**
 * The "restart extractors" offer on a pilot's row (slice 4).
 *
 * ⚠ SAID BEFORE THE BUTTON, NOT IN A DIALOG AFTER IT. `words` states what the
 * run will do — every ended extractor on ALL of the pilot's colonies, because
 * the macro cannot be aimed at one — and its limits, so the click is the
 * decision and nothing interrupts it.
 */
export interface PiRestartOffer {
  readonly enabled: boolean;
  readonly label: string;
  readonly words: string;
}

export interface PiPilotRow {
  readonly characterID: number;
  readonly pilotName: string;
  /** The sentence about this pilot when there is one to say; null otherwise. */
  readonly noteWords: string | null;
  /** Read, and found with no colony: the one note a roster can fold away. */
  readonly notBuilt: boolean;
  readonly colonyCount: number;
  /** How old this pilot's reading is, or null when there is none. */
  readonly readAgeWords: string | null;
  readonly busy: boolean;
  /** Null when nothing on this pilot's colonies can be restarted. */
  readonly restart: PiRestartOffer | null;
  /** Said when a server bot is flying this pilot, which rules a start out. */
  readonly botWords: string | null;
  /** What this window's last start for the pilot did. */
  readonly dispatchWords: string | null;
}

export interface PiColonyRow {
  /** For a keyed each only — never printed. */
  readonly key: string;
  readonly characterID: number;
  /** The colony's identity, for the Haul button's step - never printed (R7d). */
  readonly planetID: number;
  readonly planetName: string | null;
  readonly solarSystemID: number;
  readonly solarSystemName: string | null;
  readonly pilotName: string;
  readonly placeWords: string;
  readonly stateWords: string;
  readonly needsYouNow: boolean;
  readonly readAgeWords: string;
  /** The planet's own type, for its icon only — never printed (R7d). */
  readonly planetTypeID: number;
  /** "Barren - CC 5": the kind of planet and the command center's level. */
  readonly kindWords: string;
  /** What its extractors pull, by name, each once. */
  readonly resources: readonly string[];
  /** "stopped" wants the player now, "soon" before long, "ok" nothing. */
  readonly tone: "stopped" | "soon" | "ok";
  /** The soonest extraction program, as a bar; null when none is running or ended. */
  readonly program: PiProgramBar | null;
  /** Under the program bar: what needs doing, else when the program ends. */
  readonly statusWords: string;
  /** The fullest hold, as a bar; null when no hold's fill can be stated. */
  readonly storage: PiFillBar | null;
}

/** How far through its program the extractor that ends first is. */
export interface PiProgramBar {
  /** 0 to 1; 1 once it has ended. */
  readonly fraction: number;
  readonly ended: boolean;
}

export interface PiFillBar {
  /** 0 to 1. */
  readonly fraction: number;
  /** "Storage 22% full", rounded down so it never claims more than there is. */
  readonly words: string;
  /** Near enough full to look at. */
  readonly high: boolean;
}

/** One pilot's colonies, under one line that says whose and how old. */
export interface PiColonyGroup {
  readonly characterID: number;
  readonly pilotName: string;
  /** "2 colonies, Alpha" — the count and the systems they are in. */
  readonly countWords: string;
  readonly readAgeWords: string;
  /** Worst first, as in `colonies`. */
  readonly rows: readonly PiColonyRow[];
}

/** The strip across the top of the colonies view. */
export interface PiColonySummary {
  readonly colonies: number;
  /** Colonies with a program running and none ended. */
  readonly extracting: number;
  /** Colonies that want the player now. */
  readonly needYouNow: number;
  /** "2d 22h" until the first running program ends; null when none runs. */
  readonly nextEndsWords: string | null;
}

export interface PiNeedsYou {
  /** For a keyed each only — never printed. */
  readonly key: string;
  readonly characterID: number;
  readonly pilotName: string;
  readonly placeWords: string;
  readonly words: string;
  readonly urgency: ColonyFindingUrgency;
  readonly readAgeWords: string;
}

export interface PiBoard {
  readonly pilots: readonly PiPilotRow[];
  /** Every colony of every pilot, worst first, quiet ones after. */
  readonly colonies: readonly PiColonyRow[];
  /** The same rows by pilot; the pilot with the worst colony first. */
  readonly groups: readonly PiColonyGroup[];
  readonly summary: PiColonySummary;
  /** Only what has something to say, worst first. Empty is the quiet answer. */
  readonly needsYou: readonly PiNeedsYou[];
  /** Said when the merged readings are far apart; null when they are not. */
  readonly staleWords: string | null;
  /** A sentence about the whole board, when one is true; null otherwise. */
  readonly emptyWords: string | null;
}

const NO_LONGER_IN_HANGAR = "A pilot no longer in the hangar";

/** Readings closer together than this are one moment for the player's purposes. */
const SAME_MOMENT_MS = 60_000;

function ageWords(reading: PilotColonyReading, browserNowMs: number): string {
  if (reading.readAtMs === null) {
    return "Read at an unknown time";
  }
  const nowMs = serverNow(reading.report.clockOffsetMs, browserNowMs);
  return `Read ${formatDuration(nowMs - reading.readAtMs)} ago`;
}

/**
 * Extractors the restart-extractors macro would actually restart: a program
 * whose resource is known and which has ended (or states no end). One with no
 * program at all is left alone by the macro — it reuses the last resource and
 * never guesses — so offering a run for it would start one that does nothing.
 */
function restartableExtractors(reading: PilotColonyReading, nowMs: number): { extractors: number; colonies: number } {
  let extractors = 0;
  let colonies = 0;
  for (const colony of reading.report.colonies) {
    const here = colony.pins.filter((pin) =>
      pin.kind === "extractor-control"
      && pin.program !== null
      && pin.program.resourceTypeID > 0
      && (pin.program.expiresAtMs === null || pin.program.expiresAtMs <= nowMs)).length;
    extractors += here;
    if (here > 0) colonies += 1;
  }
  return { extractors, colonies };
}

function dispatchFor(
  input: PiBoardInput,
  characterID: number,
  pilotName: string,
  attempt: PilotAttempt,
  reading: PilotColonyReading | null,
): Pick<PiPilotRow, "restart" | "botWords" | "dispatchWords"> {
  const flying = input.activeBots?.has(characterID) ?? false;
  const state = input.dispatch?.get(characterID) ?? null;
  const dispatchWords = state === null
    ? null
    : state.kind === "starting"
      ? "Starting the run on the server..."
      : state.kind === "started"
        ? "The run has started on the server. Refresh once it has finished to see the extractors running."
        : state.sentence;
  let restart: PiRestartOffer | null = null;
  if (reading !== null) {
    const nowMs = serverNow(reading.report.clockOffsetMs, input.browserNowMs);
    const { extractors, colonies } = restartableExtractors(reading, nowMs);
    // Routes still sized for an earlier program: the same run re-sizes them
    // (the retail client does it in the install edit; see colonyRoutes.ts).
    const reroutes = reading.report.colonies.reduce((total, colony) => total + colony.pins
      .filter((pin) => pin.kind === "extractor-control" && extractorReroute(colony, pin.pinID) !== null)
      .length, 0);
    if (extractors > 0 || reroutes > 0) {
      const where = colonies === 1 ? "1 colony" : `${colonies} colonies`;
      const ended = extractors === 0
        ? null
        : `${extractors === 1 ? "1 extractor has" : `${extractors} extractors have`} ended on ${where}.`;
      const short = reroutes === 0
        ? null
        : `${reroutes === 1 ? "1 extractor yields" : `${reroutes} extractors yield`} more than ${reroutes === 1 ? "its" : "their"} routes carry.`;
      restart = {
        // Not while a bot flies the pilot, while it is being read, or while a
        // start from here is in flight or has just gone out.
        enabled: !flying && attempt !== "reading" && state?.kind !== "starting" && state?.kind !== "started",
        label: extractors > 0 ? "Restart extractors" : "Fix extractor routes",
        // "an hour": PI_RESTART_RUNTIME_MINUTES in app/piDispatch.ts.
        words:
          `${[ended, short].filter((part) => part !== null).join(" ")} This starts a server run for ${pilotName} that restarts every ` +
          "ended extractor on all of its colonies, re-sizes the storage routes of any extractor that yields more than they carry, " +
          "then stops. It changes nothing else and runs for an hour at most.",
      };
    }
  }
  return {
    restart,
    botWords: flying ? "A server bot is flying this pilot now." : null,
    dispatchWords,
  };
}

function pilotNote(
  name: string,
  known: boolean,
  attempt: PilotAttempt,
  reading: PilotColonyReading | null,
): string | null {
  if (!known || attempt === "no-account") {
    return "This pilot is no longer in the hangar, so there is no account to read with.";
  }
  if (attempt === "failed" || attempt === "unanswered") {
    return `${name}'s colonies could not be read just now.`;
  }
  if (reading === null) {
    return attempt === "reading" ? `Looking at ${name}'s colonies...` : "Not looked at yet.";
  }
  if (!reading.report.coloniesReadable) {
    return `The server did not report colony information for ${name}. That is not the same as having none.`;
  }
  if (reading.report.colonies.length === 0) {
    return `${name} has not built on a planet yet.`;
  }
  return null;
}

interface Placed {
  readonly characterID: number;
  readonly pilotName: string;
  readonly memberIndex: number;
  readonly reading: PilotColonyReading;
  readonly colony: Colony;
  readonly attention: ColonyAttention | null;
  readonly nowMs: number;
}

/** Noisy before quiet; among noisy, the one colony list's own rule; then roster order. */
function byWorst(left: Placed, right: Placed): number {
  const a = left.attention;
  const b = right.attention;
  if ((a === null) !== (b === null)) {
    return a === null ? 1 : -1;
  }
  if (a !== null && b !== null) {
    if (a.needsYouNow !== b.needsYouNow) {
      return a.needsYouNow ? -1 : 1;
    }
    const worst = bySeverityThenTime(a.findings[0]!, b.findings[0]!);
    if (worst !== 0) {
      return worst;
    }
  }
  return left.memberIndex - right.memberIndex;
}

/** "Planet (Barren)" is how the type table names it; the player says "Barren". */
function kindWords(colony: Colony): string {
  const typeName = colony.planetTypeName?.match(/^Planet \((.+)\)$/)?.[1] ?? colony.planetTypeName;
  const level = `CC ${colony.commandCenterLevel}`;
  return typeName ? `${typeName} - ${level}` : level;
}

function resourcesOf(colony: Colony): string[] {
  const names = new Set<string>();
  for (const pin of colony.pins) {
    if (pin.program?.resourceTypeName) {
      names.add(pin.program.resourceTypeName);
    }
  }
  return [...names];
}

/**
 * The extractor that needs the player first: an ended one if there is one,
 * else the running one that ends soonest.
 */
function programBar(colony: Colony, nowMs: number): PiProgramBar | null {
  let soonest: { installedAtMs: number; expiresAtMs: number } | null = null;
  for (const pin of colony.pins) {
    const program = pin.program;
    if (!program || program.expiresAtMs === null) {
      continue;
    }
    if (program.expiresAtMs <= nowMs) {
      return { fraction: 1, ended: true };
    }
    if (soonest === null || program.expiresAtMs < soonest.expiresAtMs) {
      soonest = { installedAtMs: program.installedAtMs ?? program.expiresAtMs, expiresAtMs: program.expiresAtMs };
    }
  }
  if (soonest === null) {
    return null;
  }
  const length = soonest.expiresAtMs - soonest.installedAtMs;
  const fraction = length > 0 ? (nowMs - soonest.installedAtMs) / length : 0;
  return { fraction: Math.min(1, Math.max(0, fraction)), ended: false };
}

/** A hold counts as "high" from here; below it the bar is only information. */
const HIGH_FILL = 0.8;

function storageBar(colony: Colony): PiFillBar | null {
  let fullest: number | null = null;
  for (const pin of colony.pins) {
    const fill = pinFill(pin);
    if (fill !== null && (fullest === null || fill > fullest)) {
      fullest = fill;
    }
  }
  if (fullest === null) {
    return null;
  }
  const fraction = Math.min(1, Math.max(0, fullest));
  return { fraction, words: `Storage ${Math.floor(fraction * 100)}% full`, high: fraction >= HIGH_FILL };
}

/** What wants the player, in the colony list's own words; else the countdown. */
function statusWords(entry: Placed): string {
  const findings = entry.attention?.findings ?? [];
  if (findings.length === 0) {
    const next = summarizeColony(entry.colony, entry.nowMs).nextExpiryMs;
    if (next !== null) {
      return `Ends in ${formatDuration(next - entry.nowMs)}`;
    }
  }
  return colonyLineWords(entry.colony, findings, entry.nowMs);
}

function countWords(colonies: readonly Colony[]): string {
  const count = colonies.length === 1 ? "1 colony" : `${colonies.length} colonies`;
  const systems = [...new Set(colonies.map((colony) => colony.solarSystemName).filter((name) => name !== null))];
  return systems.length > 0 ? `${count}, ${systems.join(", ")}` : count;
}

export function buildPiBoard(input: PiBoardInput): PiBoard {
  const pilots: PiPilotRow[] = [];
  const placed: Placed[] = [];

  input.members.forEach((characterID, memberIndex) => {
    const knownName = input.names.get(characterID);
    const pilotName = knownName ?? NO_LONGER_IN_HANGAR;
    const reading = input.readings.get(characterID) ?? null;
    const attempt = input.attempts.get(characterID) ?? "none";
    pilots.push({
      characterID,
      pilotName,
      noteWords: pilotNote(pilotName, knownName !== undefined, attempt, reading),
      notBuilt: knownName !== undefined
        && attempt !== "no-account" && attempt !== "failed" && attempt !== "unanswered"
        && reading !== null && reading.report.coloniesReadable && reading.report.colonies.length === 0,
      colonyCount: reading?.report.colonies.length ?? 0,
      readAgeWords: reading === null ? null : ageWords(reading, input.browserNowMs),
      busy: attempt === "reading",
      ...dispatchFor(input, characterID, pilotName, attempt, reading),
    });
    if (reading === null) {
      return;
    }
    const nowMs = serverNow(reading.report.clockOffsetMs, input.browserNowMs);
    const attention = new Map(
      attentionByColony(reading.report.colonies, nowMs, undefined, input.recipes ?? null).map((entry) => [entry.colony.planetID, entry]),
    );
    for (const colony of reading.report.colonies) {
      placed.push({
        characterID,
        pilotName,
        memberIndex,
        reading,
        colony,
        attention: attention.get(colony.planetID) ?? null,
        nowMs,
      });
    }
  });

  const ordered = [...placed].sort(byWorst);
  const colonies = ordered.map((entry): PiColonyRow => ({
    key: `${entry.characterID}:${entry.colony.planetID}`,
    characterID: entry.characterID,
    planetID: entry.colony.planetID,
    planetName: entry.colony.planetName,
    solarSystemID: entry.colony.solarSystemID,
    solarSystemName: entry.colony.solarSystemName,
    pilotName: entry.pilotName,
    placeWords: colonyPlaceWords(entry.colony),
    stateWords: colonyLineWords(entry.colony, entry.attention?.findings ?? [], entry.nowMs),
    needsYouNow: entry.attention?.needsYouNow ?? false,
    readAgeWords: ageWords(entry.reading, input.browserNowMs),
    planetTypeID: entry.colony.planetTypeID,
    kindWords: kindWords(entry.colony),
    resources: resourcesOf(entry.colony),
    tone: entry.attention === null ? "ok" : entry.attention.needsYouNow ? "stopped" : "soon",
    program: programBar(entry.colony, entry.nowMs),
    statusWords: statusWords(entry),
    storage: storageBar(entry.colony),
  }));

  // Groups in the order their worst colony comes, so trouble stays on top.
  const groups: PiColonyGroup[] = [];
  const byPilot = new Map<number, PiColonyRow[]>();
  for (const row of colonies) {
    let rows = byPilot.get(row.characterID);
    if (rows === undefined) {
      rows = [];
      byPilot.set(row.characterID, rows);
      const entry = placed.find((candidate) => candidate.characterID === row.characterID)!;
      groups.push({
        characterID: row.characterID,
        pilotName: row.pilotName,
        countWords: countWords(entry.reading.report.colonies),
        readAgeWords: row.readAgeWords,
        rows,
      });
    }
    rows.push(row);
  }

  let nextEndsMs: number | null = null;
  for (const entry of placed) {
    const next = summarizeColony(entry.colony, entry.nowMs).nextExpiryMs;
    if (next !== null && (nextEndsMs === null || next - entry.nowMs < nextEndsMs)) {
      nextEndsMs = next - entry.nowMs;
    }
  }
  const summary: PiColonySummary = {
    colonies: placed.length,
    extracting: placed.filter((entry) => {
      const colony = summarizeColony(entry.colony, entry.nowMs);
      return colony.runningProgramCount > 0 && colony.expiredProgramCount === 0;
    }).length,
    needYouNow: colonies.filter((row) => row.needsYouNow).length,
    nextEndsWords: nextEndsMs === null ? null : formatDuration(nextEndsMs),
  };
  const needsYou = ordered
    .filter((entry) => entry.attention !== null)
    .map((entry): PiNeedsYou => {
      const findings = entry.attention!.findings;
      return {
        key: `${entry.characterID}:${entry.colony.planetID}`,
        characterID: entry.characterID,
        pilotName: entry.pilotName,
        placeWords: colonyPlaceWords(entry.colony),
        words: colonyAttentionWords(findings) ?? findings[0]!.words,
        urgency: entry.attention!.needsYouNow ? "now" : "soon",
        readAgeWords: ageWords(entry.reading, input.browserNowMs),
      };
    });

  return {
    pilots,
    colonies,
    groups,
    summary,
    needsYou,
    staleWords: staleWords(input),
    emptyWords: emptyWords(input),
  };
}

/** "Read at different times" — only when the readings shown really are apart. */
function staleWords(input: PiBoardInput): string | null {
  const ages: number[] = [];
  for (const characterID of input.members) {
    const reading = input.readings.get(characterID);
    if (!reading || reading.readAtMs === null) {
      continue;
    }
    ages.push(serverNow(reading.report.clockOffsetMs, input.browserNowMs) - reading.readAtMs);
  }
  if (ages.length < 2) {
    return null;
  }
  const oldest = Math.max(...ages);
  if (oldest - Math.min(...ages) < SAME_MOMENT_MS) {
    return null;
  }
  return `Read at different times; the oldest is ${formatDuration(oldest)} old.`;
}

function emptyWords(input: PiBoardInput): string | null {
  if (input.members.length === 0) {
    return "No pilots are on planetary industry yet. Add one below.";
  }
  // Only a positive statement about EVERY pilot: one we have not read, or whose
  // server reported no colony table, means we do not know that nobody built.
  const everyoneEmpty = input.members.every((characterID) => {
    const reading = input.readings.get(characterID);
    return reading !== undefined
      && reading.report.coloniesReadable
      && reading.report.colonies.length === 0;
  });
  return everyoneEmpty ? "None of your pilots has built on a planet yet." : null;
}

/**
 * One account's pilots on the roster. A pilot with colonies, or with anything
 * else to say, gets a row; one read and found with no colony is only a name.
 */
export interface PiAccountGroup {
  /** Null for pilots no longer in the hangar, whose account is not known. */
  readonly accountName: string | null;
  readonly rows: readonly PiPilotRow[];
  readonly notBuilt: readonly PiPilotRow[];
  readonly colonyCount: number;
  /** Said once for the account when every pilot in it reads the same; else null. */
  readonly readAgeWords: string | null;
}

/** The roster by account, accounts by name and pilots in roster order. */
export function pilotsByAccount(
  pilots: readonly PiPilotRow[],
  accountOf: ReadonlyMap<number, string>,
): PiAccountGroup[] {
  const byAccount = new Map<string | null, PiPilotRow[]>();
  for (const pilot of pilots) {
    const accountName = accountOf.get(pilot.characterID) ?? null;
    byAccount.set(accountName, [...(byAccount.get(accountName) ?? []), pilot]);
  }
  return [...byAccount.entries()]
    .sort(([left], [right]) =>
      left === null ? 1 : right === null ? -1 : left.localeCompare(right))
    .map(([accountName, members]) => {
      const ages = new Set(members.map((pilot) => pilot.readAgeWords));
      const [onlyAge] = ages;
      return {
        accountName,
        rows: members.filter((pilot) => !pilot.notBuilt),
        notBuilt: members.filter((pilot) => pilot.notBuilt),
        colonyCount: members.reduce((total, pilot) => total + pilot.colonyCount, 0),
        readAgeWords: ages.size === 1 && onlyAge !== undefined ? onlyAge : null,
      };
    });
}

/**
 * The Haul offer on a pilot's line: what the run will do, said BEFORE the
 * button, the same rule as the restart offer. `ticked` is how many of this
 * pilot's colonies are ticked; `into` the picked division's words, or null
 * for the pilot's own hangar.
 */
export function piHaulWords(
  pilotName: string,
  ticked: number,
  into: string | null,
  deliverTo: string | null = null,
): { label: string; words: string } {
  const where = into === null ? "your own hangar" : `the corporation's ${into}`;
  const station = deliverTo === null
    ? "flies back"
    : `flies to ${deliverTo}`;
  const andBack = deliverTo === null ? "" : "flies back to where it started, ";
  if (ticked === 0) {
    return { label: "Haul", words: "Tick the colonies to haul." };
  }
  const colonies = ticked === 1 ? "1 colony" : `${ticked} colonies`;
  return {
    label: `Haul ${colonies}`,
    words:
      `This sends what the ticked colonies' launchpads hold up into their customs offices, then starts a server run for ${pilotName} ` +
      `that launches what their command centres hold, gets into a ship parked where the pilot is docked that has a planetary hold, ` +
      `empties those customs offices and collects the launches, ${station} and unloads into ${where}, ` +
      `then ${andBack}gets back into the ship it started in. The launch is taxed. It runs for two hours at most.`,
  };
}

/** What a Haul start from this window did, as one sentence. */
export function piHaulDispatchWords(state: PiDispatchState | null): string | null {
  if (state === null) return null;
  if (state.kind === "starting") return "Launching into the customs offices, then starting the haul...";
  if (state.kind !== "started") return state.sentence;
  const started = "The haul has started on the server. Its steps show in the Bot Manager.";
  const exported = state.exported ?? null;
  if (exported === null) return started;
  // The run sends the launchpads up itself, at each office: nothing went up yet,
  // and that is not "nothing was on them".
  if (exported.atTheOffices === true) {
    return "The haul has started on the server. It sends each colony's launchpads up at its customs office. Its steps show in the Bot Manager.";
  }
  // What went up is said first, because it is the half the Bot Manager cannot
  // show: the hop happens before the run exists.
  const launched = exported.units === 0
    ? "Nothing was on the launchpads, so nothing new went up."
    : `Launched ${exported.units} ${exported.units === 1 ? "unit" : "units"} from ` +
      `${exported.colonies === 1 ? "1 colony" : `${exported.colonies} colonies`} into their customs offices.`;
  // A colony the server refused is named in its own words; the rest still haul.
  return [launched, ...exported.refusals, started].join(" ");
}
