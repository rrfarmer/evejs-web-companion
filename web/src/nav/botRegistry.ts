// EVERY BOT THIS CLIENT CAN RUN, declared once (goal R43).
//
// Two things live here and they exist for the same reason: both used to be
// hand-written per bot, at each call site, and both were already wrong.
//
// ── 1. WHO HOLDS THE SHIP ───────────────────────────────────────────────────
//
// Mutual exclusion between the browser decide-loops was two lines in flow.ts
// and they were asymmetric — `startMissionBot` stopped the mining bot, and
// `startMiningBot` stopped only the travel autopilot, never the mission bot. So
// starting the mining bot on a ship the mission bot was flying left BOTH loops
// ticking, each issuing movement and module calls against one ship, neither
// able to see the other.
//
// A third hand-written line would have fixed that instance and left the shape
// intact: a fourth bot needs three more lines and gets one of them wrong. So
// exclusion is structural instead. `BotID` is the one union, `createShipClaim`
// takes an EXHAUSTIVE `Record<BotID, () => void>` of stoppers, and claiming the
// ship for one bot walks every OTHER registered bot and stops it. Adding a bot
// means adding it to the union — at which point the compiler refuses to build
// until its stopper exists, and it inherits exclusion from every other bot
// without anyone remembering to write anything.
//
// ── 2. WHAT A BOT NEEDS BEFORE IT CAN START ────────────────────────────────
//
// Each bot DECLARES its requirements as pure functions over injected reads.
// Nothing here fetches; everything here is a plain node --test case. Three
// rules make the difference between a checklist and a guess:
//
//   • THREE ANSWERS, NOT TWO. met / not-met / cannot-tell. A read that failed
//     is not a read that said no.
//   • CANNOT-TELL DOES NOT PASS. If we could not check it, the bot does not
//     start and says which check it could not make. This is the same
//     pause-rather-than-guess rule both loops already follow; letting unknown
//     fall through to "fine" is how a bot starts against a ship nobody looked
//     at.
//   • EVERY VERDICT CARRIES A SENTENCE. The words live in bridge/refusals.ts
//     with every other "this will not happen" sentence in the app, so the R9a
//     sweep that pins them reaches these too.
//
// ⚠ FRESHNESS IS THE CALLER'S JOB, and it is the whole point. These functions
// are pure over whatever reads they are handed — so the PANEL evaluates them
// against the store, as a live advisory checklist, and `flow.ts` evaluates the
// SAME requirement objects against reads taken immediately before the first
// call. A stale "you have a mining module" is exactly the failure this is
// meant to prevent, and only the second evaluation is authoritative.

import {
  MINING_BOT_NEEDS_A_BELT,
  MINING_BOT_NEEDS_A_MINER,
  MINING_BOT_NEEDS_A_STATION,
  MINING_BOT_NEEDS_THE_MINER_ON,
  MINING_BOT_WILL_UNDOCK,
  MINING_BOT_WILL_UNLOAD_FIRST,
  MISSION_BOT_NEEDS_AGENT_STATION,
  MISSION_BOT_NEEDS_AN_AGENT,
  MISSION_BOT_WILL_FLY_TO_AGENT,
  UNCHECKABLE_HOLD,
  UNCHECKABLE_MINERS,
  UNCHECKABLE_WHERE_YOU_ARE,
} from "../bridge/refusals.ts";

// --- Which bots exist -------------------------------------------------------

/**
 * Every BOT the client can run — the catalogue the launcher and the Bot Manager
 * list, pick from and set up.
 *
 * ⚠ A PLUGIN'S LOOP IS NOT ONE OF THESE, and its absence is the point rather
 * than an omission. A bot is a script you set up against your own ship and
 * leave running: it picks its own work (a belt, an agent), it is offered in
 * the Manager's picker beside the saved scripts, and it can be handed to the
 * server as a saved run. A plugin's loop is its own system, set up and watched
 * in the plugin's own window. It still HOLDS A SHIP, which is
 * `ShipControllerID` below.
 */
export type BotID = "mining" | "mission";

export const BOT_IDS: readonly BotID[] = Object.freeze<BotID[]>(["mining", "mission"]);

/**
 * Every browser-side decide loop that can issue orders to one ship.
 *
 * `BotID` is the catalogue of the built-in bot launchers. The one member
 * beyond it is not a catalogue row and must never be treated as one:
 * player-authored scripts have no single row (there can be many saved ones).
 * Both kinds nevertheless issue orders to ONE hull, so both participate in the
 * same ownership claim — which is why exclusion is keyed by this union and not
 * by `BotID`.
 *
 * ⚠ A PLUGIN'S LOOP MUST STAY IN THE CLAIM TOO (see `PluginShipOwner`). Take it
 * out and a mining bot can be started on a ship a plugin is flying with neither
 * loop aware of the other:
 * two tickers issuing movement and module calls against one hull, which is the
 * exact bug `createShipClaim` was written to make structurally impossible.
 */
export type BuiltInShipController = BotID | "custom";

/** A plugin holding the ship (`flow.flying.holdShip`): "plugin:<plugin id>". */
export type PluginShipOwner = `plugin:${string}`;

export type ShipControllerID = BuiltInShipController | PluginShipOwner;

export const SHIP_CONTROLLER_IDS: readonly BuiltInShipController[] = Object.freeze<BuiltInShipController[]>([
  "mining",
  "mission",
  "custom",
]);

/**
 * The run states in which a bot is HOLDING THE SHIP.
 *
 * Paused counts. A paused loop has not let go — it is one press from issuing
 * orders again, and its plan still describes what the ship is doing. Treating
 * it as free is how you end up with a second bot started underneath it.
 */
export function holdsTheShip(status: string): boolean {
  return status === "running" || status === "paused";
}

/**
 * Claim the ship for one bot, stopping every other bot that holds it.
 *
 * The record is exhaustive over `BuiltInShipController` by type, and the loop
 * walks `SHIP_CONTROLLER_IDS` rather than naming peers — so this function never
 * changes when a controller is added, and the new one is stopped by every
 * existing one on the day it lands. A plugin's owner is in no list here, so its
 * claim stops all of them; the flow stops a plugin's hold when anything else claims.
 */
export function createShipClaim(
  stop: Readonly<Record<BuiltInShipController, () => void>>,
): (botID: ShipControllerID) => void {
  return (botID: ShipControllerID): void => {
    for (const other of SHIP_CONTROLLER_IDS) {
      if (other !== botID) {
        stop[other]();
      }
    }
  };
}

// --- What a bot needs -------------------------------------------------------

/** met / not-met / cannot-tell. The third is not a flavour of the second. */
export type RequirementVerdict = "met" | "not-met" | "cannot-tell";

/**
 * Does an unmet requirement STOP the start, or merely describe the first thing
 * the bot will do?
 *
 * ⚠ THE DISTINCTION IS NOT COSMETIC — getting it wrong makes the launcher
 * narrower than the bot. A `blocking` requirement is one the ladder CANNOT
 * resolve for itself: nothing in `miningBotLoop.ts` can fit a mining laser, and
 * no rung invents a belt the player never picked. An `advisory` one is a state
 * both loops already handle on their first rungs — a docked mining bot unloads
 * and undocks, a mission bot in space flies to the station it needs — so
 * refusing to start on it would refuse a start that works.
 */
export type RequirementSeverity = "blocking" | "advisory";

/**
 * Where the answer comes from.
 *
 * "ship" is a fact about the world that the client can read at any time — where
 * the ship is, what is fitted to it, how full its hold is. "plan" is something
 * the PLAYER supplies in the bot's own controls: which belt, which agent.
 *
 * ⚠ THE LAUNCHER NEEDS THIS TO AVOID LYING. Its live checklist is drawn before
 * the player has touched anything, so it can honestly report every "ship"
 * requirement and can report NO "plan" requirement — "you have not picked a
 * belt" is not news when the belt picker is the next thing on the page. Only the
 * authoritative preflight, which runs after the player has pressed Start and has
 * the request in hand, evaluates both.
 */
export type RequirementSource = "ship" | "plan";

/**
 * One thing a bot needs before it can start.
 *
 * `title` is stated POSITIVELY ("Your ship is out at the belt") because it is
 * read as a checklist line whether or not it is met. `unmet` and `cannotTell`
 * are two different sentences because "you have no miner fitted" and "we could
 * not read your fit" send a player to completely different places.
 */
export interface BotRequirement<Reads> {
  readonly id: string;
  readonly title: string;
  readonly severity: RequirementSeverity;
  readonly source: RequirementSource;
  readonly check: (reads: Reads) => RequirementVerdict;
  readonly unmet: string;
  readonly cannotTell: string;
}

/** One evaluated requirement, ready to render. */
export interface RequirementRow {
  readonly id: string;
  readonly title: string;
  readonly severity: RequirementSeverity;
  readonly source: RequirementSource;
  readonly verdict: RequirementVerdict;
  /** The sentence for this verdict; null when it is met. */
  readonly reason: string | null;
}

export interface Preflight {
  readonly canStart: boolean;
  readonly rows: readonly RequirementRow[];
  /** Every reason the bot cannot start, in declaration order. */
  readonly blockers: readonly string[];
  /** The first blocker — what a single-line control wears. Null when clear. */
  readonly blockedBy: string | null;
}

/**
 * Evaluate a bot's requirements against one set of reads.
 *
 * ⚠ A CANNOT-TELL ON A BLOCKING REQUIREMENT IS A BLOCKER, and that is the rule
 * rather than an implementation detail. "The fitting read failed" is not "the
 * fitting read said no" — but it is equally not permission to start an
 * unattended loop against a ship nobody managed to look at. Unknown never falls
 * through to fine.
 */
export function evaluateRequirements<Reads>(
  requirements: readonly BotRequirement<Reads>[],
  reads: Reads,
): Preflight {
  const rows: RequirementRow[] = requirements.map((requirement) => {
    const verdict = requirement.check(reads);
    return {
      id: requirement.id,
      title: requirement.title,
      severity: requirement.severity,
      source: requirement.source,
      verdict,
      reason:
        verdict === "met"
          ? null
          : verdict === "cannot-tell"
            ? requirement.cannotTell
            : requirement.unmet,
    };
  });
  const blockers = rows
    .filter((row) => row.severity === "blocking" && row.verdict !== "met")
    .map((row) => row.reason as string);
  return {
    canStart: blockers.length === 0,
    rows,
    blockers,
    blockedBy: blockers[0] ?? null,
  };
}

/**
 * A boolean read that may not have been readable. Null is never "no".
 *
 * Exported because a requirement declaration does not have to live in this
 * file: a plugin's requirements live in the plugin, and they need the same
 * three-answer reading of a nullable read that every requirement here uses.
 * The MACHINERY is shared; the catalogue is not.
 */
export function fromNullableBoolean(value: boolean | null): RequirementVerdict {
  if (value === null) {
    return "cannot-tell";
  }
  return value ? "met" : "not-met";
}

// --- The mining bot ---------------------------------------------------------

/**
 * What the mining bot's start needs to know about the world.
 *
 * `null` means UNREADABLE throughout — a failed read, or a value the server did
 * not report. The two `Chosen` flags come from the player's own request and so
 * are always knowable, which is why they are plain booleans.
 */
export interface MiningBotReads {
  /** True when the ship is undocked. Null when the flight status did not read. */
  readonly inSpace: boolean | null;
  /**
   * How many mining modules are FITTED IN HIGH SLOTS — which is where every
   * mining module lives, so nothing else needs looking at. Null when the fit
   * could not be read, or when a high-slot module's name has not resolved: an
   * unnamed module could be a Strip Miner, and answering "you have none" on the
   * strength of a name nobody looked up would be a guess.
   */
  readonly minersFitted: number | null;
  /**
   * How many of those are POWERED UP. Null under exactly the same conditions.
   *
   * It is separate from `minersFitted` because "you have not got one" and "you
   * have one and it is switched off" are different problems with different
   * fixes, and one number cannot say which.
   */
  readonly minersOnline: number | null;
  readonly beltChosen: boolean;
  readonly stationChosen: boolean;
  /**
   * True when the hold the ore goes into has room left.
   *
   * ⚠ NOT A SECOND NOTION OF "FULL". This comes from the loop's OWN
   * `destinationHold` + `holdShouldHaul` — the same hold it watches (first
   * specialty hold, else cargo) and the same 0.9 headroom it hauls at. A
   * separately written "used < capacity" would call a hold at 95% roomy and
   * wave through a bot that mines nothing and turns straight round. Null when
   * the ship reported no capacity, which is unknown and never "room to spare".
   */
  readonly holdHasRoom: boolean | null;
}

export const MINING_BOT_REQUIREMENTS: readonly BotRequirement<MiningBotReads>[] = Object.freeze([
  {
    // ⚠ THE ONE THE OPERATOR ASKED FOR. A mining module is HIGH-SLOT ONLY, so
    // the check is a slot rule first — see space/rowActions.ts. Restricting to
    // high slots is what makes the low-slot Ice Harvester Upgrade and the Ice
    // Harvester rig irrelevant rather than something to remember to exclude.
    id: "mining-equipment",
    title: "Mining equipment is fitted",
    severity: "blocking",
    source: "ship",
    check: (reads) =>
      reads.minersFitted === null ? "cannot-tell" : reads.minersFitted > 0 ? "met" : "not-met",
    unmet: MINING_BOT_NEEDS_A_MINER,
    cannotTell: UNCHECKABLE_MINERS,
  },
  {
    // ⚠ EACH REQUIREMENT OWNS EXACTLY ONE FAILURE. A hull with nothing fitted
    // reads "met" here on purpose: there is no equipment to be switched off, the
    // requirement above already states that problem, and reporting it twice in
    // two different wordings would leave a player unsure which one to act on.
    id: "mining-equipment-on",
    title: "That mining equipment is switched on",
    severity: "blocking",
    source: "ship",
    check: (reads) => {
      if (reads.minersFitted === null || reads.minersOnline === null) {
        return "cannot-tell";
      }
      return reads.minersFitted === 0 || reads.minersOnline > 0 ? "met" : "not-met";
    },
    unmet: MINING_BOT_NEEDS_THE_MINER_ON,
    cannotTell: UNCHECKABLE_MINERS,
  },
  {
    id: "belt",
    title: "You have picked a belt for it to work",
    severity: "blocking",
    source: "plan",
    check: (reads) => (reads.beltChosen ? "met" : "not-met"),
    unmet: MINING_BOT_NEEDS_A_BELT,
    cannotTell: MINING_BOT_NEEDS_A_BELT,
  },
  {
    id: "station",
    title: "You have picked somewhere for it to take the ore",
    severity: "blocking",
    source: "plan",
    check: (reads) => (reads.stationChosen ? "met" : "not-met"),
    unmet: MINING_BOT_NEEDS_A_STATION,
    cannotTell: MINING_BOT_NEEDS_A_STATION,
  },
  {
    // ADVISORY: miningBotLoop.ts:422 — a docked ship unloads, confirms the hold
    // is empty and undocks. Blocking here would refuse a start that works.
    id: "in-space",
    title: "Your ship is out at the belt",
    severity: "advisory",
    source: "ship",
    check: (reads) => fromNullableBoolean(reads.inSpace),
    unmet: MINING_BOT_WILL_UNDOCK,
    cannotTell: UNCHECKABLE_WHERE_YOU_ARE,
  },
  {
    // ADVISORY: the same branch takes a full load in before mining anything new.
    id: "hold-room",
    title: "There is room in the hold for the ore",
    severity: "advisory",
    source: "ship",
    check: (reads) => fromNullableBoolean(reads.holdHasRoom),
    unmet: MINING_BOT_WILL_UNLOAD_FIRST,
    cannotTell: UNCHECKABLE_HOLD,
  },
]);

// --- The mission bot --------------------------------------------------------

/**
 * What the mission bot's start needs to know.
 *
 * ⚠ THERE IS DELIBERATELY NO "you are standing at the agent's station"
 * REQUIREMENT. The R36 loop flies to the agent itself — `startTravel` hands the
 * agent's station to the shared autopilot before it asks for work — and
 * MissionBot.svelte offers agents found anywhere for exactly that reason.
 * Demanding physical presence would make the control NARROWER THAN THE BOT,
 * which is the bug that component's own comment records having fixed. What the
 * ladder actually needs is a chosen agent whose station is known, and that is
 * what is checked.
 */
export interface MissionBotReads {
  /** True when the ship is docked. Null when the flight status did not read. */
  readonly docked: boolean | null;
  readonly agentChosen: boolean;
  /** True when the chosen agent's own station is known to fly to. */
  readonly agentStationKnown: boolean;
}

export const MISSION_BOT_REQUIREMENTS: readonly BotRequirement<MissionBotReads>[] = Object.freeze([
  {
    id: "agent",
    title: "You have picked an agent for it to work for",
    severity: "blocking",
    source: "plan",
    check: (reads) => (reads.agentChosen ? "met" : "not-met"),
    unmet: MISSION_BOT_NEEDS_AN_AGENT,
    cannotTell: MISSION_BOT_NEEDS_AN_AGENT,
  },
  {
    id: "agent-station",
    title: "The station that agent works from is known",
    severity: "blocking",
    source: "plan",
    check: (reads) => (reads.agentStationKnown ? "met" : "not-met"),
    unmet: MISSION_BOT_NEEDS_AGENT_STATION,
    cannotTell: MISSION_BOT_NEEDS_AGENT_STATION,
  },
  {
    // ADVISORY: missionBotLoop.ts:552 — in space with no flight of its own
    // running, the ladder flies to the station the mission needs. This is the
    // operator's "has to be in station", declared and checked and shown, but
    // NOT used to refuse a start the bot handles.
    id: "docked",
    title: "Your ship is docked in a station",
    severity: "advisory",
    source: "ship",
    check: (reads) => fromNullableBoolean(reads.docked),
    unmet: MISSION_BOT_WILL_FLY_TO_AGENT,
    cannotTell: UNCHECKABLE_WHERE_YOU_ARE,
  },
]);

// --- The catalogue ----------------------------------------------------------

/** One bot, as the launcher lists it. */
export interface BotDescriptor {
  readonly id: BotID;
  /** The player's name for it — this is the only name the panel ever shows. */
  readonly name: string;
  /** One line: what it does, and what it costs you to leave it running. */
  readonly summary: string;
  /** The requirement titles, for the checklist. Evaluation needs the reads. */
  readonly requirementTitles: readonly string[];
}

export const BOTS: readonly BotDescriptor[] = Object.freeze([
  {
    id: "mining",
    name: "Mining bot",
    // ⚠ THE DRONES ARE NAMED HERE BECAUSE THEY ARE NAMED NOWHERE ELSE NOW.
    // MiningBot.svelte opened with a paragraph that said this again, in slightly
    // richer words, directly under the card that was already showing this line —
    // so the panel restated the card a player had just clicked. That paragraph
    // is gone, and the one fact it held that this line did not (that the bot
    // defends itself) moved here, to the single place the bot describes itself.
    summary:
      "Picks rocks, runs your mining equipment, sends the drones out if a pirate turns up, hauls a full hold back and unloads it, then goes again.",
    requirementTitles: MINING_BOT_REQUIREMENTS.map((row) => row.title),
  },
  {
    id: "mission",
    name: "Mission bot",
    summary:
      "Asks an agent for delivery work, turns down anything too far or too big, flies it there and hands it in.",
    requirementTitles: MISSION_BOT_REQUIREMENTS.map((row) => row.title),
  },
]);
