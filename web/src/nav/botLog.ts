// The bot's flight recorder: what it decided, what it tried, and what came back.
//
// WHY THIS EXISTS. A bot that stops overnight leaves nothing behind. The Bot
// Manager row shows the CURRENT phase, the notice feed shows notices, and the
// server-bot ring keeps a status record per finished run — none of them says
// what the ship was doing when it went wrong. Caught the hard way, 2026-09-08:
// two fleeted miners were pulled home by a shield watch and the only way to
// reconstruct the minute before it was to inject a recorder into the page and
// hope a tab stayed open. Everything needed was computed each tick and thrown
// away.
//
// ⚠ NO MACRO KNOWS THIS FILE EXISTS, AND THAT IS THE DESIGN. Every action in
// this app is DATA returned by a pure decider and performed in exactly one
// place (`scriptRunner`'s `issue` seam). So the recorder writes at that seam and
// at `emit`, which means it covers every block, every watch, and every action
// anyone adds later — without them opting in, and with no way to forget.
//
// Four rules hold that together. Three are pinned by tests in botLog.test.ts:
//
//   1. AN ACTION IS DATA, NOT A CALL. `ScriptAction` is a closed union of plain
//      values, so a log line is `JSON.stringify(action)` and nothing else.
//   2. EVERY ACTION HAS A SENTENCE OR THE BUILD FAILS. `describeAction` below
//      is exhaustive with NO `default` — the same trick scriptText.ts uses for
//      macros and conditions. A new action variant cannot reach the runner
//      without a line for the log.
//   3. ONLY THE RUNNER PERFORMS. The deciders import nothing that can call the
//      world, so nothing can slip past the seam unlogged.
//   4. THE RECORDER NEVER BREAKS THE RUN. Every call into a sink is wrapped by
//      the runner: a sink that throws, hangs or fills a disk loses lines, never
//      a ship.
//
// ⚠ THIS IS A DIAGNOSTIC ARTIFACT, NOT PLAYER COPY. Unlike bots/scriptText.ts
// (the R9a register, where no numeric id may ever reach a player), these lines
// name ids on purpose: "lock 1002" is the thing an operator needs at 3am, and a
// log that says "locked something" is worth nothing. The file is local to the
// operator's own BFF and is not for the game UI.

import type { ScriptAction } from "./scriptDecide.ts";

/** What a line is about. */
export type BotLogKind =
  /** A run began (one per run, and what rotates the previous log out). */
  | "start"
  /** The tick's decision changed — a new phase, a new reason, a new step. */
  | "decide"
  /** About to perform an action. WRITTEN BEFORE THE CALL, deliberately. */
  | "issue"
  /** How that call came back: ok, or the server's refusal. */
  | "result"
  /** The run ended, and why. */
  | "end";

/**
 * One line. Structured rather than prose so a later reader can filter it, with
 * `why` carrying the runner's own sentence so a human can read it as it stands.
 */
export interface BotLogEntry {
  /** ISO-8601, so lines sort and a gap is visible. */
  readonly t: string;
  readonly kind: BotLogKind;
  /** The run this line belongs to — a fresh id per start. */
  readonly run: string;
  readonly characterID: number | null;
  /** Which step or watch row decided it, when there was one. */
  readonly stepPath?: string | null;
  readonly interruptID?: string | null;
  readonly phase?: string | null;
  readonly why?: string | null;
  readonly status?: string | null;
  /** The action itself, verbatim — plain data by rule 1. */
  readonly action?: ScriptAction;
  /** A one-line rendering of that action, by rule 2. */
  readonly says?: string;
  /** result lines: whether the call landed, and the server's words when not. */
  readonly ok?: boolean;
  readonly refusal?: string;
  /** start/end lines: the script and how it finished. */
  readonly script?: string;
  readonly reason?: string | null;
}

/**
 * Where lines go. Injected into the runner exactly like `observe` and `issue`,
 * so a tab, a server bot and a test each satisfy it their own way and the
 * runner keeps knowing nothing about storage.
 *
 * ⚠ EVERY METHOD IS FIRE-AND-FORGET. The runner does not await them and
 * swallows what they throw: a recorder that cannot write must never be able to
 * stop a ship. A sink that wants durability buffers and retries on its own.
 */
export interface BotLogSink {
  write(draft: BotLogDraft): void;
}

/**
 * What the RUNNER can say. It knows the run, the tick and the action; it does
 * not know which character it is flying (that is the app layer's business), so
 * the sink stamps `characterID` on the way out. Keeping the runner unable to
 * name the pilot is also what keeps it testable with a plain array.
 */
export type BotLogDraft = Omit<BotLogEntry, "characterID">;

/**
 * ONE LINE PER ACTION KIND — exhaustive, and deliberately without a `default`.
 *
 * ⚠ THE MISSING `default` IS THE RULE. Add a variant to `ScriptAction` without
 * adding it here and this function stops compiling, which is the only way to
 * guarantee a log that never says "did something". Ids ARE named here (see the
 * file header): this is the operator's artifact, not the player's.
 */
export function describeAction(action: ScriptAction): string {
  switch (action.kind) {
    case "maintainMiningSupport": return action.relocating ? "settle mining support for relocation" : "maintain mining support";
    case "stopMiningSupportOperation": return "request operation Stop after support loss";
    case "wait":
      return "wait";
    case "undock":
      return "undock";
    case "dock":
      return `dock at ${action.stationID}`;
    case "warp":
      return `warp to ${action.targetID}`;
    case "approach":
      return `approach ${action.targetID}`;
    case "gotoPoint":
      return `fly ship ${action.shipID} to (${action.position.x}, ${action.position.y}, ${action.position.z})`;
    case "stopShip":
      return "stop the ship";
    case "align":
      return `align to ${action.targetID}`;
    case "orbit":
      return `orbit ${action.targetID} at ${action.range}m`;
    case "keepAtRange":
      return `keep range off ${action.targetID} at ${action.range}m`;
    case "setFleetTargetTag":
      return `set fleet tag "${action.tag}" on ${action.targetID}`;
    case "jump":
      return `jump ${action.fromGateID} -> ${action.toGateID}`;
    case "lock":
      return `lock ${action.targetID}`;
    case "unlock":
      return `unlock ${action.targetID}`;
    case "activate":
      return action.targetID > 0
        ? `activate module ${action.moduleID} on ${action.targetID}`
        : `activate module ${action.moduleID} on self`;
    case "deactivate":
      return `deactivate module ${action.moduleID}`;
    case "loadCombatAmmo":
      return `load charge ${action.chargeItemID} into weapon ${action.moduleID}`;
    case "launchDrones":
      return `launch drones ${action.droneItemIDs.join(",")}`;
    case "engageDrones":
      return `drones ${action.droneIDs.join(",")} onto ${action.targetID}`;
    case "mineDrones":
      return `mining drones ${action.droneIDs.join(",")} onto ${action.targetID}`;
    case "recallDrones":
      return `recall drones ${action.droneIDs.join(",")}`;
    case "unloadOre":
      return action.division === undefined
        ? `unload ore ${action.itemIDs.join(",")}`
        : `unload ore ${action.itemIDs.join(",")} into corp division ${action.division}`;
    case "agentButton":
      return `agent ${action.agentID}: press "${action.label}" (${action.actionID})`;
    case "startRoute":
      return `set course to ${action.stationID}`;
    case "loadMissionCargo":
      return `load ${action.quantity} of type ${action.typeID}`;
    case "unloadMissionCargo":
      return `unload ${action.quantity} mission cargo from ${action.itemIDs.join(",")}`;
    case "unloadHolds":
      return `empty holds ${action.groups.map((g) => `${g.bay ?? "cargo"}:${g.itemIDs.length}`).join(" ")}${
        action.division === undefined ? "" : ` into corp division ${action.division}`}`;
    case "loadHolds":
      return `load holds ${action.groups
        .map((g) => `${g.bay ?? "cargo"}:${g.itemIDs.length}${g.qty === null ? "" : `x${g.qty}`}`)
        .join(" ")}`;
    case "salvageDrones":
      return `salvage drones ${action.droneIDs.join(",")} onto ${action.targetID === 0 ? "any wreck" : action.targetID}`;
    case "lootWreck":
      return `loot wreck ${action.wreckID}`;
    case "lootContainer":
      return `loot container ${action.containerID}`;
    case "collectLaunch":
      return `collect launch ${action.launchID} from container ${action.containerID}`;
    case "collectCustoms":
      return `empty customs office ${action.officeID}`;
    case "haulTransfer":
      return `move ${action.quantity} of ${action.itemID} into route division ${action.division}`;
    case "reprocessOre":
      return `reprocess ${action.itemIDs.join(",")}`;
    case "warpScan":
      return `warp to scan result ${action.target}`;
    case "warpBookmark":
      return `warp to bookmark ${action.bookmarkID}`;
    case "boardShip":
      return `board ship ${action.shipID}`;
    case "applyFitting":
      return `apply fitting ${action.fittingID}`;
    case "restartExtractor":
      return `restart extractor ${action.pinID} on planet ${action.planetID} for ${action.resourceTypeID}`;
    case "rerouteExtractor":
      return `reroute extractor ${action.pinID} on planet ${action.planetID}: remove ${action.removeRouteIDs.join(",")}, create ${action.create
        .map((route) => `${route.path.join(">")} ${route.typeID}x${route.quantity}`)
        .join("; ")}`;
    case "launchCommodities":
      return `launch ${Object.entries(action.commodities)
        .map(([typeID, quantity]) => `${typeID}x${quantity}`)
        .join(",")} from command centre ${action.commandPinID} on planet ${action.planetID}`;
    case "repairItems":
      return `repair ${action.itemIDs.join(",")}`;
    case "rememberBeltDry":
      return `note ${action.beltName} in ${action.systemName} dry${action.groupID === null ? "" : ` of group ${action.groupID}`}`;
    case "reserveMiningTarget":
      return `reserve operation target ${action.targetName} in ${action.systemName}`;
    case "bookmarkMiningSite":
      return `save logistics return point for ${action.targetKey}`;
    case "activateMiningTarget":
      return `activate operation target ${action.targetKey}`;
    case "depleteMiningTarget":
      return `mark operation target ${action.targetKey} depleted`;
    case "miningMemberReady":
      return "mark operation member ready";
    case "miningDrainComplete":
      return `finish logistics tail at ${action.targetKey}`;
    case "callPrimary":
      return action.targetID === null ? "clear the fleet's called primary" : `call ${action.targetID} as the fleet's primary`;
    case "moveItems":
      return `move ${action.itemIDs.join(",")} ${action.from} -> ${action.to}${action.qty === null ? "" : ` x${action.qty}`}`;
    case "placeBuyOrder":
      return `buy ${action.quantity} of type ${action.typeID} at ${action.price}`;
    case "placeSellOrder":
      return `sell item ${action.itemID} at ${action.price}`;
    case "jettison":
      return `jettison ${action.itemIDs.join(",")}`;
    case "compressOre":
      return `compress ${action.itemID} at ${action.facilityID}`;
    case "scannerLaunch":
      return "launch the scan probes";
    case "scannerAnalyze":
      return "run a scan analysis";
    case "scannerRecover":
      return "recover the scan probes";
    case "stackHangar":
      return "stack the hangar";
    case "startSystemRoute":
      return `set course to system ${action.systemID}`;
    case "createFleet":
      return "form a fleet";
    case "inviteToFleet":
      return `invite ${action.charID} to the fleet`;
    case "acceptFleetInvite":
      return action.fleetID === null
        ? "accept the fleet invitation"
        : `accept the invitation to fleet ${action.fleetID}`;
    case "applyToJoinFleet":
      return `apply to join advertised fleet ${action.fleetID}`;
    case "alert":
      return `tell the player: "${action.message}"`;
  }
}

/** A short id for one run — enough to group lines, never a secret. */
export function newRunID(nowMs: number, random: () => number = Math.random): string {
  return `${nowMs.toString(36)}-${Math.floor(random() * 1e6).toString(36)}`;
}
