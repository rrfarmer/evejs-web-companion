"use strict";
const { positionValid, keyOf, rankMiningCandidates } = require("./miningLocality");
const { supportPolicy } = require("./miningOperationSupport");

const EXECUTABLE_TARGET_CLASSES = Object.freeze(["BELT", "ORE_ANOMALY", "ICE"]);
const DEFERRED_TARGET_CLASSES = Object.freeze(["GAS"]);
const STOP_STATES = ["STOPPING", "PARKING", "PARKING_FAILED", "STOPPED"];

function stamp(now) {
  return new Date(now()).toISOString();
}

function auditMiningScript(doc) {
  const macros = [];
  const unsupportedNodes = [];
  function visit(nodes) {
    if (!Array.isArray(nodes)) {
      unsupportedNodes.push("missing program body");
      return;
    }
    for (const node of nodes) {
      if (!node || typeof node !== "object") {
        unsupportedNodes.push("invalid program node");
        continue;
      }
      if (node.kind === "macro") macros.push(node);
      else if (node.kind === "loop") visit(node.body);
      else if (node.kind === "branch") {
        visit(node.then);
        visit(node.else);
      } else unsupportedNodes.push(String(node.kind || "unknown"));
    }
  }
  visit(doc?.program);
  const names = new Set(macros.map((row) => row.macro));
  const mineSteps = macros.filter((row) => ["mine-at-belt", "fleet-mine"].includes(row.macro));
  const hasOrePreference = mineSteps.some((row) => {
    const arg = row.args?.ores;
    return arg && arg.kind === "oreList" && Array.isArray(arg.ores) && arg.ores.length > 0;
  });
  const resourceSteps = macros.filter(row => ["mine-at-belt", "fleet-mine", "travel-to-belt"].includes(row.macro));
  const families = [...new Set(resourceSteps.map(row => row.args?.belt?.belt?.mode === "site" ? "ORE_ANOMALY" : row.args?.belt?.belt?.mode === "ice-site" ? "ICE" : "BELT"))];
  const siteMine = mineSteps.some((row) => row.args?.belt?.belt?.mode === "site");
  return {
    targetClasses: families,
    hasOrePreference,
    miner: mineSteps.length > 0,
    hauler: names.has("travel-to-belt") && names.has("loot-containers") && names.has("deliver-ore"),
    normalJettison: names.has("jettison-ore"),
    selfUnload: names.has("deliver-ore"),
    macros: [...names],
    unsupportedNodes,
    pinnedResourceTarget: macros.some((row) =>
      (["mine-at-belt", "fleet-mine", "travel-to-belt"].includes(row.macro)) &&
      row.args?.belt?.belt?.mode === "chosen"),
    invalidResourceMode: macros.some((row) => {
      if (!["mine-at-belt", "fleet-mine", "travel-to-belt"].includes(row.macro)) return false;
      const mode = row.args?.belt?.belt?.mode;
      return !["nearest", "site", "ice-site", "chosen"].includes(mode);
    }),
    mixedResourceFlow: families.length !== 1 || (names.has("warp-to-ore-anomaly") && !siteMine),
  };
}

// Only these blocks have an operation target overlay, or do not select a
// resource destination at all. Unknown/composed nodes fail closed: a sub-bot
// could hide an independent target selector from a superficial macro scan.
const OPERATION_MACROS = Object.freeze({
  MINER: new Set(["undock", "mine-at-belt", "fleet-mine", "warp-to-ore-anomaly", "jettison-ore", "deliver-ore", "travel-to-station", "dock-at-nearest", "unload-cargo", "defend-with-drones", "hardeners-on", "wait", "repair-ship", "refine-ore", "compress-ore"]),
  COMMAND: new Set(["undock", "mining-support"]),
  HAULER: new Set(["join-support-fleet", "undock", "travel-to-belt", "loot-containers", "deliver-ore", "travel-to-station", "dock-at-nearest", "unload-cargo", "hardeners-on", "wait", "repair-ship"]),
  DEFENDER: new Set(["undock", "fight-with-drones", "wait"]),
});

function operationRoutineCompatibility(definition, role, audit, executionClasses) {
  if (!audit) return "The referenced routine no longer exists.";
  if (role === "DEFENDER") return definition.members?.filter(row => row.role === role).every(row =>
    (row.routineMode || (row.automationID ? "CUSTOM" : "STANDARD")) === "STANDARD") &&
    audit.unsupportedNodes.length === 0 && audit.macros.includes("fight-with-drones") &&
    audit.macros.every(name => OPERATION_MACROS.DEFENDER.has(name))
    ? null : "DEFENDER requires the Standard Defender profile; custom escort routines are unsupported.";
  if (role === "COMMAND") return definition.support && audit.unsupportedNodes.length === 0 &&
    audit.macros.includes("mining-support") && audit.macros.every(name => OPERATION_MACROS.COMMAND.has(name)) ? null : "COMMAND requires the Standard Mining Support profile.";
  if (audit.unsupportedNodes.length > 0) return `Unsupported program node: ${audit.unsupportedNodes[0]}.`;
  if (audit.pinnedResourceTarget) return "A pinned belt/site competes with operation.currentTarget; use nearest belt or site mode.";
  if (audit.invalidResourceMode) return "The routine has an unsupported resource target mode; use nearest belt or ore site mode.";
  if (audit.mixedResourceFlow) return "Belt and ore-site travel/mining blocks cannot compete in one operation routine.";
  const allowed = OPERATION_MACROS[role];
  const competing = audit.macros.find((macro) => !allowed?.has(macro));
  if (competing) return `The ${competing} block is not operation-target-aware and may select a competing destination.`;
  if (role === "HAULER") {
    if (definition.support && !audit.macros.includes("join-support-fleet")) return "Support-bound HAULER requires Join support fleet.";
    if (!audit.targetClasses.some(kind => executionClasses.includes(kind))) return "This HAULER routine cannot execute the operation's selected target family.";
    return audit.hauler ? null : "A HAULER routine needs Travel to belt, Loot containers, and Deliver ore blocks.";
  }
  if (definition.support && (!audit.macros.includes("fleet-mine") || audit.macros.includes("mine-at-belt"))) return "Support-bound MINER requires Fleet Miner; legacy mining remains available with support disabled.";
  if (!audit.miner) return "A MINER routine needs a Mine at a belt or ore site block.";
  if (audit.hasOrePreference) return "An operation routine cannot own an independent ore preference list. Use a Standard profile and the operation resource policy.";
  if (!audit.targetClasses.some((kind) => executionClasses.includes(kind))) {
    return "This MINER routine cannot execute the operation's selected target class.";
  }
  if (definition.unloadPolicy === "HAULER_SERVICE" && !audit.normalJettison) {
    return "A HAULER_SERVICE miner routine needs a Jettison ore block.";
  }
  if (definition.unloadPolicy === "SELF_UNLOAD" && !audit.selfUnload) {
    return "A SELF_UNLOAD miner routine needs a Deliver ore block.";
  }
  return null;
}

function createMiningOperations(options) {
  const store = options.store;
  const targetBoard = options.targetBoard;
  const beltMemory = options.beltMemory;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const runtimes = new Map();

  function definition(operationID) {
    return store.get(operationID);
  }

  function freshRuntime(def) {
    return {
      operationID: def.operationID,
      state: "DRAFT",
      currentTarget: null,
      executionTargetClasses: [],
      members: new Map(def.members.map((member) => [member.characterID, {
        characterID: member.characterID,
        role: member.role,
        botID: null,
        runtimeState: "DRAFT",
        phase: null,
        reason: null,
        failureCode: null,
      }])),
      drainingTargets: [],
      ownedContainers: new Map(),
      containerProvenanceUnconfirmed: false,
      rendezvous: null,
      history: [],
      createdAt: stamp(now),
      startedAt: null,
      stoppedAt: null,
      stopFailures: [],
      authorityLoss: false,
      tailClaimLoss: false,
      recoveryAmbiguous: false,
      completedTargetInRun: false,
      supportStatus: null, supportLostSinceMs: null,
    };
  }

  function runtimeFor(operationID) {
    const def = definition(operationID);
    if (!def) return null;
    let runtime = runtimes.get(def.operationID);
    if (!runtime) {
      runtime = freshRuntime(def);
      runtimes.set(def.operationID, runtime);
    }
    // Definitions can be edited while stopped. Rebuild missing member rows but
    // never pretend a removed active member disappeared from botHost.
    for (const member of def.members) {
      if (!runtime.members.has(member.characterID)) {
        runtime.members.set(member.characterID, {
          characterID: member.characterID,
          role: member.role,
          botID: null,
          runtimeState: "DRAFT",
          phase: null,
          reason: null,
          failureCode: null,
        });
      }
    }
    return runtime;
  }

  function history(runtime, kind, target = null, evidence = null) {
    runtime.history.push({ kind, at: stamp(now), target, evidence });
    if (runtime.history.length > 100) runtime.history.splice(0, runtime.history.length - 100);
  }

  function begin(operationID, executionTargetClasses, operationRunID = null) {
    const def = definition(operationID);
    if (!def) return { ok: false, code: "MINING_OPERATION_NOT_FOUND", message: "That Mining Operation no longer exists." };
    const classes = executionTargetClasses ?? def.area.targetClasses;
    if (!classes.length || classes.some(kind => !EXECUTABLE_TARGET_CLASSES.includes(kind)) ||
        def.area.targetClasses.some(kind => !EXECUTABLE_TARGET_CLASSES.includes(kind))) {
      return { ok: false, code: "NO_EXECUTABLE_TARGET_CLASS", message: "Only the BELT profile family is executable in this foundation." };
    }
    const runtime = runtimeFor(operationID);
    if (!["DRAFT", "STOPPED"].includes(runtime.state)) {
      return { ok: false, code: "MINING_OPERATION_ACTIVE", message: "That Mining Operation is already active." };
    }
    runtime.state = "ASSEMBLING";
    runtime.operationRunID = operationRunID;
    runtime.currentTarget = null;
    runtime.executionTargetClasses = [...new Set(classes)];
    runtime.drainingTargets = [];
    runtime.ownedContainers = new Map();
    runtime.containerProvenanceUnconfirmed = false;
    runtime.rendezvous = null;
    runtime.startedAt = stamp(now);
    runtime.stoppedAt = null;
    runtime.stopFailures = [];
    runtime.parkingTargetsReleased = false;
    runtime.authorityLoss = false;
    runtime.tailClaimLoss = false;
    runtime.recoveryAmbiguous = false;
    runtime.completedTargetInRun = false;
    runtime.supportStatus = null; runtime.supportLostSinceMs = null;
    runtime.lastSelectionKey = null;
    for (const member of def.members) {
      runtime.members.set(member.characterID, {
        characterID: member.characterID,
        role: member.role,
        botID: null,
        runtimeState: "STARTING",
        phase: "Starting operation routine",
        reason: null,
        failureCode: null,
      });
    }
    return { ok: true, runtime };
  }

  function memberStarted(operationID, characterID, botID) {
    const runtime = runtimeFor(operationID);
    const member = runtime?.members.get(Number(characterID));
    if (!member) return false;
    member.botID = botID;
    member.runtimeState = "RUNNING";
    member.phase = "Waiting for operation target";
    member.reason = null;
    member.failureCode = null;
    return true;
  }

  function releaseRendezvousIfReady(runtime) {
    const barrier = runtime.rendezvous;
    if (!barrier) return false;
    const pending = barrier.required.filter((id) => !barrier.ready.includes(id));
    if (pending.length > 0) return false;
    for (const characterID of barrier.required) {
      const member = runtime.members.get(characterID);
      if (member?.runtimeState === "READY_FOR_RENDEZVOUS") {
        member.runtimeState = "RUNNING";
        member.phase = "Relocating with main body";
      }
    }
    runtime.rendezvous = null;
    runtime.currentTarget = null;
    if (runtime.state !== "DEGRADED") runtime.state = "RELOCATING";
    history(runtime, "RENDEZVOUS_RELEASED", barrier.target, null);
    return true;
  }

  function memberFailed(operationID, characterID, reason) {
    const runtime = runtimeFor(operationID);
    const member = runtime?.members.get(Number(characterID));
    if (!member) return false;
    member.runtimeState = "FAILED";
    member.phase = "Unavailable";
    member.reason = String(reason?.message || reason || "This member could not start.");
    member.failureCode = typeof reason?.code === "string" ? reason.code : null;
    runtime.state = "DEGRADED";
    if (runtime.rendezvous) {
      runtime.rendezvous.required = runtime.rendezvous.required.filter((id) => id !== Number(characterID));
      releaseRendezvousIfReady(runtime);
    }
    return true;
  }

  function loseClaim(runtime, key) {
    if (runtime.currentTarget?.targetKey !== key) return;
    const previous = runtime.currentTarget;
    const board = targetBoard.get(key);
    runtime.currentTarget = null;
    runtime.rendezvous = null;
    runtime.authorityLoss = true;
    if (!STOP_STATES.includes(runtime.state)) runtime.state = "DEGRADED";
    history(runtime, "TARGET_CLAIM_LOST", null, { targetKey: key,
      priorLeaseExpiresAt: previous.leaseExpiresAt ?? null,
      boardState: board?.state ?? null,
      boardOwner: board?.claimedByOperationID ?? null });
  }

  function loseDrainClaim(runtime, key) {
    const before = runtime.drainingTargets.length;
    runtime.drainingTargets = runtime.drainingTargets.filter((row) => row.target?.targetKey !== key);
    if (runtime.drainingTargets.length === before) return;
    runtime.tailClaimLoss = true;
    if (!STOP_STATES.includes(runtime.state)) runtime.state = "DEGRADED";
    history(runtime, "TARGET_CLAIM_LOST", null, { targetKey: key, logisticsTail: true });
  }

  // botHost is the pilot ownership authority. Keep a claim alive while at
  // least one hosted member is active, even if its script observation stalls.
  // A dead host cannot run this heartbeat, so the board's bounded lease still
  // releases abandoned claims. Failed launch members do not cancel survivors.
  function renewHostedClaims(bots = []) {
    const activeOperations = new Set((bots || [])
      .filter((bot) => bot.operationID && bot.endedAt === null && ["starting", "running", "paused"].includes(bot.status))
      .map((bot) => bot.operationID));
    for (const [operationID, runtime] of runtimes) {
      if (!activeOperations.has(operationID)) continue;
      const key = runtime.currentTarget?.claimedByOperationID === operationID
        ? runtime.currentTarget.targetKey : null;
      if (key) {
        if (targetBoard.heartbeat(operationID, key)) runtime.currentTarget = targetBoard.get(key);
        else loseClaim(runtime, key);
      }
      for (const tail of [...runtime.drainingTargets]) {
        if (tail.target?.targetKey && !targetBoard.heartbeat(operationID, tail.target.targetKey)) {
          loseDrainClaim(runtime, tail.target.targetKey);
        }
      }
    }
  }

  function finishLaunch(operationID) {
    const runtime = runtimeFor(operationID);
    if (!runtime) return null;
    const failed = [...runtime.members.values()].some((member) => member.runtimeState === "FAILED");
    const runningMiners = [...runtime.members.values()].some(
      (member) => member.role === "MINER" && member.runtimeState === "RUNNING",
    );
    runtime.state = failed ? "DEGRADED" : runningMiners ? "SELECTING" : "DEGRADED";
    return runtime;
  }

  function observeMemberLocation(operationID, characterID, space, inSpace, observedAt = now()) {
    const runtime = runtimeFor(operationID);
    const member = runtime?.members.get(Number(characterID));
    if (!member || STOP_STATES.includes(runtime.state)) return;
    member.location = inSpace && typeof space?.ship?.mode === "string" && !["warp", "warping"].includes(space.ship.mode.toLowerCase()) && positionValid(space?.ship?.position) && Number.isSafeInteger(space.solarSystemID)
      ? { systemID: space.solarSystemID, position: { ...space.ship.position }, observedAt } : null;
  }

  function reserveCandidates(operationID, characterID, candidates) {
    const def = definition(operationID), runtime = runtimeFor(operationID);
    if (!def || !runtime || !Array.isArray(candidates) || candidates.length > 500) return { acquired: false, reason: "INVALID_CANDIDATES", target: null };
    // Eligibility precedes locality. reserveCandidate revalidates every rule in
    // the same synchronous turn, including depletion reset and the final claim.
    const eligible = candidates.filter(c => c && typeof c.targetName === "string" && c.targetName.trim() && runtime.executionTargetClasses.includes(c.targetType) &&
      def.area.targetClasses.includes(c.targetType) && c.systemID === def.area.anchorSystemID &&
      (c.targetType === "BELT" || (Number.isSafeInteger(c.siteID) && c.siteID > 0 && positionValid(c.position) &&
        (c.instanceID == null || (Number.isSafeInteger(c.instanceID) && c.instanceID > 0)) && c.siteIdentity === `site:${c.siteID}:instance:${c.instanceID ?? c.siteID}`)) &&
      !(c.targetType === "BELT" && beltMemory.dryBelts(String(c.systemName || "")).some(row => row.beltName === c.targetName && row.all)))
      .filter(c => {
        const entry = targetBoard.get(keyOf(c));
        if (entry?.claimedByOperationID && entry.claimedByOperationID !== operationID) return false;
        return !entry?.depletionEvidence || entry.depletionEvidence.source === "belt-memory" || entry.depletionEvidence.scannerDisappeared === true;
      });
    const ranked = rankMiningCandidates(eligible, [...runtime.members.values()], now());
    for (const row of ranked) {
      const result = reserveCandidate(operationID, characterID, row.candidate);
      if (result.acquired) {
        if (runtime.lastSelectionKey !== result.target.targetKey) {
          history(runtime, "TARGET_SELECTION", result.target, { policy: "PREFER_FLEET_LOCALITY", selected: row.key,
            candidates: ranked.slice(0, 20).map(({ candidate, ...score }) => score) });
          runtime.lastSelectionKey = result.target.targetKey;
        }
        return result;
      }
    }
    return { acquired: false, reason: "NO_AVAILABLE_ELIGIBLE_TARGET", target: null };
  }

  function reserveCandidate(operationID, characterID, candidate) {
    const def = definition(operationID);
    const runtime = runtimeFor(operationID);
    if (runtime && STOP_STATES.includes(runtime.state)) return { acquired: false, reason: "Operation is stopping; target reservation is disabled.", target: null };
    const member = runtime?.members.get(Number(characterID));
    if (!def || !runtime || !member || member.role !== "MINER") {
      return { acquired: false, reason: "NOT_OPERATION_MINER", target: null };
    }
    if (runtime.currentTarget !== null) {
      const key = runtime.currentTarget.targetKey;
      if (!targetBoard.heartbeat(operationID, key)) {
        loseClaim(runtime, key);
        return { acquired: false, reason: "TARGET_CLAIM_LOST", target: null };
      }
      runtime.currentTarget = targetBoard.get(key);
      return { acquired: true, reason: null, target: runtime.currentTarget };
    }
    const type = String(candidate?.targetType || "").toUpperCase();
    const systemID = Number(candidate?.systemID);
    if (!EXECUTABLE_TARGET_CLASSES.includes(type) || !runtime.executionTargetClasses.includes(type) || !def.area.targetClasses.includes(type)) {
      return { acquired: false, reason: "TARGET_CLASS_NOT_EXECUTABLE", target: null };
    }
    // v0.1's discovery authority is current-system only. CURRENT_AND_ADJACENT is
    // represented, but candidates from an unscanned neighbour are never accepted.
    if (systemID !== def.area.anchorSystemID) {
      return { acquired: false, reason: "OUTSIDE_EXECUTABLE_AREA", target: null };
    }
    if (type === "BELT") {
      const dry = beltMemory.dryBelts(String(candidate.systemName || ""));
      if (dry.some((row) => row.beltName === candidate.targetName && row.all)) {
        return { acquired: false, reason: "DEPLETED", target: null };
      }
      // Belt memory owns the respawn/reset clock. Once its TTL has forgotten a
      // belt, remove only the target-board projection of that same evidence so
      // a permanent second depletion truth cannot outlive the authority.
      const key = `BELT:${systemID}:${String(candidate.targetName || "").trim()}`;
      const projected = targetBoard.get(key);
      if (projected?.state === "DEPLETED" && projected.depletionEvidence?.source === "belt-memory") {
        targetBoard.clearDepleted(key);
      }
    } else if (type === "ORE_ANOMALY" || type === "ICE") {
      if (!Number.isSafeInteger(candidate.siteID) || candidate.siteID <= 0 ||
          (candidate.instanceID != null && (!Number.isSafeInteger(candidate.instanceID) || candidate.instanceID <= 0)) ||
          candidate.siteIdentity !== `site:${candidate.siteID}:instance:${candidate.instanceID ?? candidate.siteID}` ||
          !candidate.position || ![candidate.position.x, candidate.position.y, candidate.position.z].every(Number.isFinite)) {
        return { acquired: false, reason: "SITE_IDENTITY_UNAVAILABLE", target: null };
      }
      // A scanner label that was confirmed absent and is visible again is
      // current authoritative evidence of a new site identity. Only that
      // disappearance proof resets; an empty rock grid may linger in the
      // scanner and must not be made claimable again merely because it lists.
      const key = `${type}:${systemID}:${candidate.siteIdentity}`;
      const projected = targetBoard.get(key);
      if (projected?.state === "DEPLETED" && projected.depletionEvidence?.scannerDisappeared === true) {
        targetBoard.clearDepleted(key);
      }
    }
    const result = targetBoard.reserve(operationID, candidate);
    if (result.acquired) {
      runtime.currentTarget = result.target;
      runtime.authorityLoss = false;
      if (runtime.state !== "DEGRADED") runtime.state = "TRAVELING";
      history(runtime, "TARGET_RESERVED", result.target, null);
    }
    return result;
  }

  function activateTarget(operationID, characterID, key) {
    const runtime = runtimeFor(operationID);
    if (runtime && STOP_STATES.includes(runtime.state)) return false;
    const member = runtime?.members.get(Number(characterID));
    if (!runtime || !member || member.role !== "MINER" || runtime.currentTarget?.targetKey !== key) return false;
    if (!targetBoard.activate(operationID, key)) {
      loseClaim(runtime, key);
      return false;
    }
    runtime.currentTarget = targetBoard.get(key);
    if (runtime.state !== "DEGRADED") runtime.state = "MINING";
    member.phase = "Mining operation target";
    history(runtime, "TARGET_ACTIVE", runtime.currentTarget, null);
    return true;
  }

  function depleteTarget(operationID, characterID, key, evidence = {}) {
    const def = definition(operationID);
    const runtime = runtimeFor(operationID);
    if (runtime && STOP_STATES.includes(runtime.state)) return false;
    const member = runtime?.members.get(Number(characterID));
    const target = runtime?.currentTarget;
    if (!def || !runtime || !member || member.role !== "MINER" || target?.targetKey !== key) return false;
    if (target.claimedByOperationID === operationID && !targetBoard.heartbeat(operationID, key)) {
      loseClaim(runtime, key);
      return false;
    }
    // More than one miner will observe the same empty grid. The first report
    // establishes the fleet-wide clearance barrier; later reports are the
    // individual confirmations that each miner has disposed of its remainder.
    if (runtime.rendezvous?.target?.targetKey === key) {
      if (def.unloadPolicy === "HAULER_SERVICE" && evidence.partialDumpConfirmed !== true) return false;
      if (!runtime.rendezvous.ready.includes(Number(characterID))) {
        runtime.rendezvous.ready.push(Number(characterID));
      }
      member.runtimeState = "READY_FOR_RENDEZVOUS";
      member.phase = "Clear of depleted target";
      releaseRendezvousIfReady(runtime);
      return true;
    }
    const proof = {
      source: target.targetType === "BELT" ? "belt-memory" : "scanner/grid",
      reportedByCharacterID: Number(characterID),
      ...evidence,
    };
    const activeHaulers = def.unloadPolicy === "HAULER_SERVICE"
      ? [...runtime.members.values()]
        .filter((row) => row.role === "HAULER" && ["RUNNING", "running"].includes(row.runtimeState))
        .map((row) => row.characterID)
      : [];
    const draining = activeHaulers.length > 0;
    if (!targetBoard.markDepleted(operationID, key, proof, draining)) {
      loseClaim(runtime, key);
      return false;
    }
    if (target.targetType === "BELT" && target.systemName) {
      beltMemory.markDry(target.systemName, target.targetName, null);
    }
    history(runtime, "TARGET_DEPLETED", target, proof);
    runtime.completedTargetInRun = true;
    const required = [...runtime.members.values()]
      .filter((row) => row.role === "MINER" && ["RUNNING", "running"].includes(row.runtimeState))
      .map((row) => row.characterID);
    if (def.unloadPolicy === "HAULER_SERVICE") {
      if (draining) {
        runtime.drainingTargets.push({ target: targetBoard.get(key), pendingHaulers: activeHaulers });
      }
      runtime.currentTarget = targetBoard.get(key);
      runtime.rendezvous = {
        kind: "MINER_CLEARANCE",
        target: runtime.currentTarget,
        required,
        // Scanner disappearance proves depletion, not freight custody.
        ready: evidence.partialDumpConfirmed === true ? [Number(characterID)] : [],
      };
      member.runtimeState = evidence.partialDumpConfirmed === true ? "READY_FOR_RENDEZVOUS" : "RUNNING";
      member.phase = evidence.partialDumpConfirmed === true ? "Clear of depleted target" : "Clearing depleted target";
      if (runtime.state !== "DEGRADED") runtime.state = draining ? "DRAINING" : "RELOCATING";
      releaseRendezvousIfReady(runtime);
    } else {
      runtime.currentTarget = targetBoard.get(key);
      runtime.rendezvous = { kind: "SELF_UNLOAD", target: runtime.currentTarget, required, ready: [] };
      if (runtime.state !== "DEGRADED") runtime.state = "UNLOADING";
    }
    return true;
  }

  function markReady(operationID, characterID) {
    const runtime = runtimeFor(operationID);
    if (runtime && STOP_STATES.includes(runtime.state)) return false;
    const id = Number(characterID);
    const member = runtime?.members.get(id);
    if (!runtime?.rendezvous || !member || member.role !== "MINER") return false;
    if (!runtime.rendezvous.ready.includes(id)) runtime.rendezvous.ready.push(id);
    member.runtimeState = "READY_FOR_RENDEZVOUS";
    member.phase = "Ready for rendezvous";
    releaseRendezvousIfReady(runtime);
    return true;
  }

  function finishDrain(operationID, characterID, targetKey) {
    const runtime = runtimeFor(operationID);
    if (runtime && STOP_STATES.includes(runtime.state)) return false;
    const id = Number(characterID);
    const member = runtime?.members.get(id);
    if (!runtime || !member || member.role !== "HAULER") return false;
    if (runtime.rendezvous?.target?.targetKey === targetKey) return false;
    if (!runtime.drainingTargets.some(row => row.target.targetKey === targetKey && row.pendingHaulers.includes(id))) return false;
    if (!targetBoard.heartbeat(operationID, targetKey)) {
      loseDrainClaim(runtime, targetKey);
      return false;
    }
    let changed = false;
    for (const drain of runtime.drainingTargets) {
      if (drain.target.targetKey !== String(targetKey || "")) continue;
      const before = drain.pendingHaulers.length;
      drain.pendingHaulers = drain.pendingHaulers.filter((pilot) => pilot !== id);
      if (before !== drain.pendingHaulers.length) changed = true;
      if (drain.pendingHaulers.length === 0) {
        targetBoard.finishDraining(operationID, drain.target.targetKey);
        runtime.ownedContainers.delete(drain.target.targetKey);
        history(runtime, "LOGISTICS_TAIL_COMPLETED", drain.target);
      }
    }
    runtime.drainingTargets = runtime.drainingTargets.filter((row) => row.pendingHaulers.length > 0);
    if (changed) {
      history(runtime, "HAULER_DRAIN_COMPLETED", { targetKey }, { characterID: id, catchUpTargetKey: runtime.currentTarget?.targetKey ?? null });
      member.runtimeState = "RUNNING";
      member.phase = "Catching up to current target";
    }
    return changed;
  }

  function assignment(operationID, characterID) {
    const def = definition(operationID);
    const runtime = runtimeFor(operationID);
    const memberDef = def?.members.find((row) => row.characterID === Number(characterID));
    const member = runtime?.members.get(Number(characterID));
    if (!def || !runtime || !memberDef || !member) return null;
    const policy = supportPolicy(def.support, runtime.supportStatus, runtime.supportLostSinceMs, now());
    runtime.supportLostSinceMs = policy.lostSinceMs;
    const stopping = STOP_STATES.includes(runtime.state);
    if (runtime.currentTarget?.claimedByOperationID === operationID) {
      const key = runtime.currentTarget.targetKey;
      if (targetBoard.heartbeat(operationID, key)) {
        runtime.currentTarget = targetBoard.get(key);
      } else {
        loseClaim(runtime, key);
      }
    }
    let tail = runtime.drainingTargets.find((row) => row.pendingHaulers.includes(Number(characterID))) || null;
    if (tail?.target?.targetKey && !targetBoard.heartbeat(operationID, tail.target.targetKey)) {
      loseDrainClaim(runtime, tail.target.targetKey);
      tail = null;
    }
    return {
      operationID,
      operationRunID: runtime.operationRunID || null,
      operationName: def.name,
      ...(def.support ? { support: def.support, supportPolicy: policy,
        intendedFleetCharacterIDs: def.members.filter(row => row.role !== "DEFENDER").map(row => row.characterID) } : {}),
      role: memberDef.role,
      unloadPolicy: def.unloadPolicy,
      travelAssist: def.policies?.travelAssist?.mode ?? "DISABLED",
      // Custom routines retain their strict preflight/explicit resource semantics.
      resourcePolicy: (memberDef.routineMode || (memberDef.automationID ? "CUSTOM" : "STANDARD")) === "STANDARD"
        ? def.policies?.resourcePolicy ?? { mode: "ANY_ELIGIBLE", source: "MANUAL", typeIDs: [] } : null,
      area: def.area,
      state: runtime.state,
      stopRequested: stopping,
      currentTarget: stopping ? null : runtime.currentTarget,
      logisticsTarget: stopping ? null : tail?.target ?? null,
      ownedContainerIDs: stopping ? [] : [...(runtime.ownedContainers.get((tail?.target ?? runtime.currentTarget)?.targetKey) ?? [])],
      miningOwnerIDs: def.members.filter(row => row.role === "MINER").map(row => row.characterID),
      containerProvenanceUnconfirmed: runtime.containerProvenanceUnconfirmed,
      rendezvous: runtime.rendezvous === null ? null : {
        kind: runtime.rendezvous.kind,
        required: [...runtime.rendezvous.required],
        ready: [...runtime.rendezvous.ready],
        thisMemberReady: runtime.rendezvous.ready.includes(Number(characterID)),
      },
    };
  }

  function registerContainer(operationID, characterID, containerID, systemID, expectedTargetKey = null, expectedClaimedAt = null) {
    const runtime = runtimeFor(operationID);
    const def = definition(operationID);
    const target = runtime?.currentTarget;
    if (!runtime || !def?.members.some(row => row.characterID === Number(characterID) && row.role === "MINER") ||
        !target || target.claimedByOperationID !== operationID || target.systemID !== Number(systemID) ||
        expectedTargetKey !== null && target.targetKey !== expectedTargetKey ||
        expectedClaimedAt !== null && target.claimedAt !== expectedClaimedAt ||
        !Number.isSafeInteger(containerID) || containerID <= 0 || STOP_STATES.includes(runtime.state)) return false;
    const ids = runtime.ownedContainers.get(target.targetKey) ?? new Set();
    ids.add(containerID);
    runtime.ownedContainers.set(target.targetKey, ids);
    return true;
  }

  function blockContainerProvenance(operationID) {
    const runtime = runtimeFor(operationID);
    if (runtime) { runtime.containerProvenanceUnconfirmed = true; runtime.state = "DEGRADED"; }
  }

  function beginStop(operationID) {
    const runtime = runtimeFor(operationID);
    if (!runtime) return null;
    if (runtime.state !== "STOPPED") runtime.state = "STOPPING";
    runtime.stopFailures = [];
    return runtime;
  }

  function memberParking(operationID, characterID, state, reason = null) {
    const runtime = runtimeFor(operationID);
    const member = runtime?.members.get(Number(characterID));
    if (!member) return;
    member.parkingState = state;
    member.phase = state === "PARKED" ? "Parked safely" : state;
    member.reason = reason;
    if (state === "PARKED") member.runtimeState = "STOPPED";
    if (state === "PARKING") runtime.state = "PARKING";
  }

  function releaseStopTargets(operationID) {
    const runtime = runtimeFor(operationID);
    if (!runtime || !STOP_STATES.includes(runtime.state) || runtime.parkingTargetsReleased) return;
    history(runtime, "TARGET_RELEASED_ON_STOP", runtime.currentTarget);
    targetBoard.releaseOperation(operationID);
    runtime.currentTarget = null;
    runtime.drainingTargets = [];
    runtime.rendezvous = null;
    runtime.parkingTargetsReleased = true;
    runtime.ownedContainers.clear();
  }

  function finishStop(operationID, failures, parking = false) {
    const runtime = runtimeFor(operationID);
    if (!runtime) return null;
    runtime.stopFailures = failures.map((row) => ({ ...row }));
    if (failures.length > 0) {
      runtime.state = parking ? "PARKING_FAILED" : "STOPPING";
      return runtime;
    }
    targetBoard.releaseOperation(operationID);
    runtime.currentTarget = null;
    runtime.drainingTargets = [];
    runtime.rendezvous = null;
    runtime.state = "STOPPED";
    runtime.ownedContainers.clear();
    runtime.stoppedAt = stamp(now);
    for (const member of runtime.members.values()) {
      if (member.runtimeState !== "FAILED") {
        member.runtimeState = "STOPPED";
        member.phase = parking ? "Parked safely" : "Stopped safely";
      }
    }
    return runtime;
  }

  function reconcileBots(bots) {
    const active = new Map();
    for (const bot of bots || []) {
      if (bot.operationID && bot.operationStopRequested && bot.parking?.state === "PARKING_FAILED" && bot.endedAt) {
        const recovered = runtimeFor(bot.operationID);
        if (recovered && ["DRAFT", "PARKING_FAILED"].includes(recovered.state)) {
          recovered.state = "PARKING_FAILED";
          if (!recovered.stopFailures.some(row => row.characterID === bot.characterID)) {
            recovered.stopFailures.push({ characterID: bot.characterID, message: bot.parking.reason });
          }
          memberParking(bot.operationID, bot.characterID, "PARKING_FAILED", bot.parking.reason);
        }
      }
      if (!bot.operationID || bot.endedAt) continue;
      active.set(Number(bot.characterID), bot);
      const def = definition(bot.operationID);
      if (!def) continue;
      const runtime = runtimeFor(bot.operationID);
      const row = runtime.members.get(Number(bot.characterID));
      if (row) {
        row.expiresAt = bot.expiresAt ?? null;
        row.maxRuntimeMinutes = bot.maxRuntimeMinutes ?? null;
        row.botID = bot.botID;
        if (bot.operationRunID) runtime.operationRunID = bot.operationRunID;
        row.preparation = bot.preparation || null;
        row.runtimeState = bot.status;
        row.phase = bot.phase;
        row.reason = bot.why;
        if (bot.parking) {
          row.parkingState = bot.parking.state;
          row.reason = bot.parking.reason || bot.why;
        }
        if (["running", "starting"].includes(bot.status)) row.failureCode = null;
      }
      if (runtime.state === "DRAFT" || runtime.state === "STOPPED") {
        runtime.state = "DEGRADED";
        runtime.recoveryAmbiguous = true;
        runtime.startedAt = bot.startedAt;
        history(runtime, "RECOVERED_UNKNOWN", null, { reason: "botHost resumed without a trusted current target" });
      }
    }
    for (const [operationID, runtime] of runtimes) {
      if (["DRAFT", ...STOP_STATES].includes(runtime.state)) continue;
      for (const row of runtime.members.values()) {
        if (row.botID && !active.has(row.characterID) && !["FAILED", "STOPPED"].includes(row.runtimeState)) {
          memberFailed(operationID, row.characterID, "The hosted automation is no longer running.");
        }
      }
    }
  }

  function deriveState(def, runtime) {
    if (["DRAFT", "ASSEMBLING", ...STOP_STATES].includes(runtime.state)) return runtime.state;
    if (def.support && (supportPolicy(def.support, runtime.supportStatus, runtime.supportLostSinceMs, now()).mode !== "NORMAL" || runtime.supportStatus?.state !== "READY")) return "DEGRADED";
    const members = def.members.map((member) => runtime.members.get(member.characterID));
    if (runtime.authorityLoss || runtime.tailClaimLoss || runtime.recoveryAmbiguous ||
        members.some((row) => !row || row.runtimeState === "FAILED" ||
          !["RUNNING", "running", "starting", "READY_FOR_RENDEZVOUS"].includes(row.runtimeState))) return "DEGRADED";
    if (runtime.rendezvous?.kind === "SELF_UNLOAD") return "UNLOADING";
    if (runtime.rendezvous?.kind === "MINER_CLEARANCE") return runtime.drainingTargets.length ? "DRAINING" : "RELOCATING";
    if (runtime.currentTarget?.state === "ACTIVE") return "MINING";
    if (runtime.drainingTargets.length || runtime.completedTargetInRun) return "RELOCATING";
    return runtime.currentTarget?.state === "RESERVED" ? "TRAVELING" : "SELECTING";
  }

  function publicRuntime(def, runtime, bots) {
    const members = def.members.map((member) => {
      const row = runtime.members.get(member.characterID) || {};
      const hosted = bots.find(bot => bot.operationID === def.operationID && bot.characterID === member.characterID && bot.botID === row.botID && !bot.endedAt);
      const last = !hosted && ["DRAFT", "FAILED"].includes(row.runtimeState) ? bots
        .filter(bot => bot.operationID === def.operationID && bot.characterID === member.characterID && bot.endedAt)
        .sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)))[0] : null;
      return { ...member, ...row, hosted: !!hosted,
        preparation: row.preparation || (row.failureCode ? {state:"BLOCKED",equipment:"UNKNOWN",supplies:"UNKNOWN",targets:[],reason:row.reason} : null),
        hostStartedAt: hosted?.startedAt ?? null, hostResumedAt: hosted?.resumedAt ?? null,
        expiresAt: hosted?.expiresAt ?? null, maxRuntimeMinutes: hosted?.maxRuntimeMinutes ?? null,
        lastHostReason: last?.why ?? null };
    });
    const unhealthy = members.find((member) => member.runtimeState === "FAILED" ||
      !["RUNNING", "running", "starting", "READY_FOR_RENDEZVOUS"].includes(member.runtimeState));
    const statusReason = runtime.state !== "DEGRADED" ? null : runtime.authorityLoss
      ? "A target claim was lost; target-dependent work is gated until a new claim is reserved."
      : runtime.tailClaimLoss ? "A logistics-tail claim was lost; its cleanup cannot be assumed complete."
      : runtime.recoveryAmbiguous ? "Hosted members recovered without a trusted current target."
      : def.support ? runtime.supportStatus?.reason || "Support observation is unavailable."
      : unhealthy ? `${unhealthy.characterName}: ${unhealthy.reason || unhealthy.phase || "required member unavailable"}`
      : "A required operation member is unavailable.";
    const preparationMembers = members;
    return {
      operationID: def.operationID,
      operationRunID: runtime.operationRunID || null,
      preparation: { state: preparationMembers.some(m=>["BLOCKED","RECOVERY_REQUIRED"].includes(m.preparation?.state))
        ? preparationMembers.some(m=>m.preparation?.state==="RECOVERY_REQUIRED") ? "RECOVERY_REQUIRED" : "BLOCKED"
        : preparationMembers.every(m=>["VERIFIED","DEGRADED"].includes(m.preparation?.state))
          ? preparationMembers.some(m=>m.preparation?.state==="DEGRADED") ? "DEGRADED" : "VERIFIED"
          : preparationMembers.some(m=>m.preparation?.state==="PREPARING") ? "PREPARING" : "PENDING",
        members: preparationMembers.map(m=>({characterID:m.characterID,role:m.role,...(m.preparation || {state:"PENDING",equipment:"UNKNOWN",supplies:"UNKNOWN",targets:[]})})) },
      state: runtime.state,
      statusReason,
      ...(def.support ? { supportStatus: runtime.supportStatus, supportPolicy: supportPolicy(def.support, runtime.supportStatus, runtime.supportLostSinceMs, now()) } : {}),
      observedAt: stamp(now),
      recoveryRequired: runtime.recoveryAmbiguous && !["DRAFT", "STOPPED"].includes(runtime.state),
      currentTarget: runtime.currentTarget,
      members,
      logisticsTail: runtime.drainingTargets.map((row) => ({
        target: row.target,
        pendingHaulers: [...row.pendingHaulers],
      })),
      rendezvous: runtime.rendezvous === null ? null : {
        kind: runtime.rendezvous.kind,
        target: runtime.rendezvous.target,
        required: [...runtime.rendezvous.required],
        ready: [...runtime.rendezvous.ready],
      },
      history: [...runtime.history],
      startedAt: runtime.startedAt,
      stoppedAt: runtime.stoppedAt,
      stopFailures: [...runtime.stopFailures],
    };
  }

  function list(bots = []) {
    reconcileBots(bots);
    renewHostedClaims(bots);
    return store.list().map((def) => {
      const runtime = runtimeFor(def.operationID);
      runtime.state = deriveState(def, runtime);
      return { definition: def, runtime: publicRuntime(def, runtime, bots) };
    });
  }

  function remove(operationID) {
    const runtime = runtimeFor(operationID);
    if (runtime && !["DRAFT", "STOPPED"].includes(runtime.state)) {
      return { ok: false, code: "MINING_OPERATION_ACTIVE", message: "Stop the operation before deleting it." };
    }
    runtimes.delete(String(operationID));
    return { ok: store.remove(operationID) };
  }

  return {
    observeSupport(operationID, characterID, value) {
      const def = definition(operationID), runtime = runtimeFor(operationID);
      if (!def?.support || def.support.characterID !== characterID || !runtime || STOP_STATES.includes(runtime.state)) return false;
      if (!value || !["READY", "DEGRADED", "RECOVERY", "BLOCKED"].includes(value.state) || !["active", "inactive", "unknown"].includes(value.core)) return false;
      const previous = runtime.supportStatus;
      runtime.supportStatus = { state: value.state, core: value.core, collection: typeof value.collection === "string" ? value.collection.slice(0, 40) : null,
        reason: typeof value.reason === "string" ? value.reason.slice(0, 240) : null, observedAtMs: now() };
      if (previous?.state !== value.state || previous?.reason !== runtime.supportStatus.reason) history(runtime, "SUPPORT_STATE", null, runtime.supportStatus);
      return true;
    },
    store,
    targetBoard,
    list,
    definition,
    runtimeFor,
    begin,
    memberStarted,
    memberFailed,
    finishLaunch,
    reserveCandidate,
    reserveCandidates,
    observeMemberLocation,
    activateTarget,
    depleteTarget,
    markReady,
    finishDrain,
    assignment,
    registerContainer,
    blockContainerProvenance,
    beginStop,
    finishStop,
    memberParking,
    releaseStopTargets,
    reconcileBots,
    renewHostedClaims,
    remove,
  };
}

module.exports = {
  createMiningOperations,
  auditMiningScript,
  operationRoutineCompatibility,
  EXECUTABLE_TARGET_CLASSES,
  DEFERRED_TARGET_CLASSES,
};
