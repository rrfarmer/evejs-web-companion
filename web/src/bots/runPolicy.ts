// A saved bot is executable authority, not just editor data. This module is the
// single, exhaustive description of the player-impacting capabilities each
// macro may exercise and whether restarting the script at step one is safe.
//
// It is deliberately shared by the browser and the BFF bot host. A new MacroID
// cannot compile until its run policy is classified here.

import type {
  BotScript,
  InterruptResponse,
  MacroID,
  MacroStep,
  ProgramNode,
} from "./botScript.ts";

export type BotRiskClass =
  | "financial"
  | "inventory"
  | "combat"
  | "mission"
  | "fleet"
  | "social"
  | "colony"
  | "destructive";

export const BOT_RISK_CLASSES: readonly BotRiskClass[] = Object.freeze<BotRiskClass[]>([
  "financial",
  "inventory",
  "combat",
  "mission",
  "fleet",
  "social",
  "colony",
  "destructive",
]);

export const BOT_RISK_LABELS: Readonly<Record<BotRiskClass, string>> = Object.freeze({
  financial: "spend or commit ISK",
  inventory: "move, consume, or expose items",
  combat: "control weapons, drones, or combat modules",
  mission: "change mission state",
  fleet: "change or act through a fleet",
  social: "send messages to other players",
  colony: "change planetary colonies",
  destructive: "perform an action that can permanently lose assets",
});

export const DEFAULT_SERVER_BOT_RUNTIME_MINUTES = 12 * 60;
export const MAX_SERVER_BOT_RUNTIME_MINUTES = 72 * 60;

/**
 * Authority for one server-side launch. It is intentionally narrow: the exact
 * stored revision, exactly the risks found in that revision, and a hard time
 * limit. The BFF re-derives the policy and refuses broader, stale, or partial
 * grants; browser-supplied policy is never trusted as fact.
 */
export interface BotLaunchGrant {
  readonly scriptRev: number;
  readonly riskClasses: readonly BotRiskClass[];
  readonly maxRuntimeMinutes: number;
}

export type BotLaunchGrantVerdict =
  | { readonly ok: true; readonly grant: BotLaunchGrant }
  | {
      readonly ok: false;
      readonly code: "BOT_GRANT_REQUIRED" | "BOT_GRANT_STALE" | "BOT_GRANT_INVALID";
      readonly message: string;
    };

export interface MacroRunPolicy {
  readonly risks: readonly BotRiskClass[];
  /**
   * True only when re-entering this block after a process restart is guarded by
   * authoritative observed state. False means starting the script over could
   * repeat an externally visible or costly action.
   */
  readonly restartSafe: boolean;
}

const SAFE = Object.freeze<MacroRunPolicy>({ risks: [], restartSafe: true });

function policy(risks: readonly BotRiskClass[], restartSafe = true): MacroRunPolicy {
  return Object.freeze({ risks: Object.freeze([...risks]), restartSafe });
}

/** Exhaustive by construction: adding a macro requires an explicit policy. */
export const MACRO_RUN_POLICY: Readonly<Record<MacroID, MacroRunPolicy>> = Object.freeze({
  undock: SAFE,
  "travel-to-station": SAFE,
  "travel-to-system": SAFE,
  "travel-to-belt": SAFE,
  "mine-at-belt": SAFE,
  "fleet-mine": policy(["fleet", "combat"]),
  "join-support-fleet": policy(["fleet"]),
  "mining-support": policy(["fleet", "inventory", "combat"]),
  "deliver-ore": policy(["inventory"]),
  "defend-with-drones": policy(["combat"]),
  "find-distribution-agent": SAFE,
  "request-mission": policy(["mission"]),
  // This block may decline unsuitable offers. Replaying it can decline another
  // offer after the restart, so it requires a fresh manual start.
  "accept-mission": policy(["mission"], false),
  "load-mission-cargo": policy(["mission", "inventory"]),
  "travel-to-dropoff": policy(["mission"]),
  "turn-in-mission": policy(["mission"]),
  "return-to-agent": policy(["mission"]),
  wait: SAFE,
  "unload-cargo": policy(["inventory"]),
  // Restart-safe for the same reason unload-cargo is: every tick re-reads the
  // hangar and the holds and re-plans from what is actually there, so starting
  // the block over loads what still fits rather than replaying a move.
  "load-cargo": policy(["inventory"]),
  // A restarted process cannot infer which part of a mixed hold this run owns.
  "haul-all": policy(["inventory"], false),
  "route-hauler": policy(["inventory"], false),
  "salvage-wrecks": policy(["combat", "inventory"]),
  "loot-wrecks": policy(["inventory"]),
  "loot-containers": policy(["inventory"]),
  // Reprocessing consumes stacks and charges tax. Even though the block
  // confirms by re-read, a restart could consume newly arrived matching ore.
  "refine-ore": policy(["financial", "inventory"], false),
  "hardeners-on": policy(["combat"]),
  "fight-the-rats": policy(["combat"]),
  // The drone boat fights with the same authority the gun ladder does: drones
  // out, guns on, and — unlike that block — the ship itself moved and a prop mod
  // lit. Same class, and restart-safe for the same reason: every rung re-reads
  // the grid, so starting the block over re-derives the whole fight from what is
  // actually out there rather than replaying anything.
  "fight-with-drones": policy(["combat"]),
  "warp-to-anomaly": policy(["combat"]),
  // Flying to a rock field arms nothing — the ore block is as safe as any other
  // trip, which is exactly why it should not have been riding the combat one.
  "warp-to-ore-anomaly": SAFE,
  "refit-ship": policy(["inventory"]),
  "board-previous-ship": policy(["inventory"]),
  "board-planetary-hauler": policy(["inventory"]),
  "move-items": policy(["inventory"]),
  "warp-to-bookmark": SAFE,
  "use-bookmark-folders": SAFE,
  "salvage-bookmarked-sites": policy(["combat", "inventory"]),
  "find-combat-agent": SAFE,
  "fly-to-mission-site": policy(["mission", "combat"]),
  "restart-extractors": policy(["colony"]),
  // Same treatment as buy-item and repair-ship: the block spends money (the
  // server debits planetary export tax on every launch) as well as changing
  // a colony, so it carries both risk classes and cannot be replayed blind
  // after a process restart.
  "launch-commodities": policy(["colony", "financial"], false),
  // Restart-safe: every tick re-reads the launch list and only takes from a
  // container of the pilot's own. Deleting a launch record happens only after
  // a re-read shows that container empty, so a replay finds nothing to undo.
  "collect-launches": policy(["inventory", "colony"]),
  // Restart-safe for the same reason, and one fewer moving part: there is no
  // record to delete. Every tick re-reads each office and takes only from the
  // pilot's own depositor-scoped rows, so a replay finds nothing to undo.
  "collect-customs": policy(["inventory", "colony"]),
  "repair-ship": policy(["financial", "inventory"], false),
  "buy-item": policy(["financial"], false),
  "sell-item": policy(["financial", "inventory"], false),
  "remote-rep": policy(["fleet"]),
  "orbit-and-boost": policy(["fleet"]),
  "orbit-fleet-mate": policy(["fleet"]),
  "follow-fleet-mate": policy(["fleet"]),
  "fleet-tag-target": policy(["fleet"]),
  "create-fleet": policy(["fleet"]),
  "invite-to-fleet": policy(["fleet"], false),
  "join-fleet": policy(["fleet"]),
  "join-advertised-fleet": policy(["fleet"]),
  "set-destination": SAFE,
  "dock-at-nearest": SAFE,
  "remote-cap": policy(["fleet"]),
  "jettison-cargo": policy(["inventory", "destructive"], false),
  "jettison-ore": policy(["inventory", "destructive"], false),
  "tidy-hangar": policy(["inventory"]),
  "compress-ore": policy(["inventory", "fleet"]),
  // Launch/recover move probe charges between ship and space. Analyze itself is
  // harmless, but keeping the three-step sweep under one explicit authority is
  // easier for players to understand and review.
  "launch-scan-probes": policy(["inventory"]),
  "analyze-signatures": SAFE,
  "recover-scan-probes": policy(["inventory"]),
});

/**
 * Interrupt responses execute outside the program tree, but they carry the same
 * launch authority as a macro. Keep this table exhaustive so adding a response
 * cannot silently bypass the browser confirmation or the server-side grant.
 */
export const INTERRUPT_RUN_POLICY: Readonly<Record<InterruptResponse, MacroRunPolicy>> = Object.freeze({
  pause: SAFE,
  "dock-and-pause": SAFE,
  // Going home is safe; PAYING THE REPAIR SHOP is not — this response spends the
  // player's ISK without them in the loop, so it carries the Repair-ship block's
  // own authority, and for the same reason it is not restart-safe: a bot resumed
  // after a process restart must be started by hand before it can buy repairs.
  "dock-and-repair": policy(["financial", "inventory"], false),
  // An always-armed combat response can act before the resumed main program
  // reaches any checkpoint. Require a fresh player start after process restart.
  "launch-drones": policy(["combat"], false),
  // Fight-back hardens up and shoots, so it carries the ratting block's own
  // authority — plus "destructive", because unlike a bare drone launch it is the
  // bot choosing to open fire without the player in the loop. The hardeners it
  // runs (and switches back off when the grid clears) need nothing extra:
  // "combat" is the same authority the Hardeners-on block asks for.
  "fight-back": policy(["combat", "destructive"], false),
  repair: policy(["combat"], false),
  alert: SAFE,
});

export interface BotRunPolicy {
  readonly macroIDs: readonly MacroID[];
  readonly riskClasses: readonly BotRiskClass[];
  readonly restartSafe: boolean;
  readonly restartBlockers: readonly MacroID[];
  /** A sub-bot must be expanded and classified before authority is granted. */
  readonly containsSubBots: boolean;
}

/** Build the narrow grant the UI presents to the player for confirmation. */
export function createBotLaunchGrant(
  scriptRev: number,
  policy: BotRunPolicy,
  maxRuntimeMinutes = DEFAULT_SERVER_BOT_RUNTIME_MINUTES,
): BotLaunchGrant {
  return Object.freeze({
    scriptRev,
    riskClasses: Object.freeze([...policy.riskClasses]),
    maxRuntimeMinutes,
  });
}

/** Re-validate untrusted launch bytes against the server-derived script policy. */
export function validateBotLaunchGrant(
  value: unknown,
  scriptRev: number,
  policy: BotRunPolicy,
): BotLaunchGrantVerdict {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      code: "BOT_GRANT_REQUIRED",
      message: "Review this bot's actions and approve a run before starting it.",
    };
  }
  const row = value as Record<string, unknown>;
  if (Number(row.scriptRev) !== scriptRev) {
    return {
      ok: false,
      code: "BOT_GRANT_STALE",
      message: "This bot changed after its run was approved. Review the current version and start it again.",
    };
  }
  const runtime = Number(row.maxRuntimeMinutes);
  if (!Number.isSafeInteger(runtime) || runtime < 1 || runtime > MAX_SERVER_BOT_RUNTIME_MINUTES) {
    return {
      ok: false,
      code: "BOT_GRANT_INVALID",
      message: `Choose a run limit between 1 and ${MAX_SERVER_BOT_RUNTIME_MINUTES} minutes.`,
    };
  }
  if (
    !Array.isArray(row.riskClasses) ||
    row.riskClasses.some((risk) => !BOT_RISK_CLASSES.includes(risk as BotRiskClass))
  ) {
    return {
      ok: false,
      code: "BOT_GRANT_INVALID",
      message: "The bot run approval contains an unknown permission.",
    };
  }
  const supplied = [...new Set(row.riskClasses as BotRiskClass[])];
  const expected = [...policy.riskClasses];
  if (supplied.length !== expected.length || expected.some((risk) => !supplied.includes(risk))) {
    return {
      ok: false,
      code: "BOT_GRANT_STALE",
      message: "This bot's permissions changed after its run was approved. Review it and start again.",
    };
  }
  return {
    ok: true,
    grant: Object.freeze({
      scriptRev,
      riskClasses: Object.freeze(expected),
      maxRuntimeMinutes: runtime,
    }),
  };
}

function visitStep(
  step: MacroStep,
  macroIDs: Set<MacroID>,
  risks: Set<BotRiskClass>,
  restartBlockers: Set<MacroID>,
): void {
  macroIDs.add(step.macro);
  const entry = MACRO_RUN_POLICY[step.macro];
  for (const risk of entry.risks) {
    risks.add(risk);
  }
  if (!entry.restartSafe) {
    restartBlockers.add(step.macro);
  }
}

function visitNode(
  node: ProgramNode,
  macroIDs: Set<MacroID>,
  risks: Set<BotRiskClass>,
  restartBlockers: Set<MacroID>,
): boolean {
  if (node.kind === "macro") {
    visitStep(node, macroIDs, risks, restartBlockers);
    return false;
  }
  if (node.kind === "loop") {
    let hasSubBots = false;
    for (const child of node.body) {
      hasSubBots = visitNode(child, macroIDs, risks, restartBlockers) || hasSubBots;
    }
    return hasSubBots;
  }
  if (node.kind === "branch") {
    for (const child of node.then) {
      visitStep(child, macroIDs, risks, restartBlockers);
    }
    for (const child of node.else) {
      visitStep(child, macroIDs, risks, restartBlockers);
    }
    return false;
  }
  return true;
}

export function analyzeBotRunPolicy(script: BotScript): BotRunPolicy {
  const macroIDs = new Set<MacroID>();
  const risks = new Set<BotRiskClass>();
  const restartBlockers = new Set<MacroID>();
  let containsSubBots = false;
  let interruptsRestartSafe = true;
  for (const node of script.program) {
    containsSubBots = visitNode(node, macroIDs, risks, restartBlockers) || containsSubBots;
  }
  for (const interrupt of script.interrupts) {
    const entry = INTERRUPT_RUN_POLICY[interrupt.respond];
    for (const risk of entry.risks) {
      risks.add(risk);
    }
    interruptsRestartSafe = entry.restartSafe && interruptsRestartSafe;
  }
  return Object.freeze({
    macroIDs: Object.freeze([...macroIDs]),
    riskClasses: Object.freeze(BOT_RISK_CLASSES.filter((risk) => risks.has(risk))),
    restartSafe: !containsSubBots && restartBlockers.size === 0 && interruptsRestartSafe,
    restartBlockers: Object.freeze([...restartBlockers]),
    containsSubBots,
  });
}

/** Same-process MCC transport reacquisition only; never a process replay grant. */
export function supportsHostedOreJettisonRecovery(script: BotScript): boolean {
  const derived = analyzeBotRunPolicy(script);
  return !derived.containsSubBots && derived.restartBlockers.length === 1 &&
    derived.restartBlockers[0] === "jettison-ore" &&
    script.interrupts.every(row => INTERRUPT_RUN_POLICY[row.respond].restartSafe);
}
