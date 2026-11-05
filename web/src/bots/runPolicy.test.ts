import test from "node:test";
import assert from "node:assert/strict";
import {
  INTERRUPT_RESPONSES,
  MACRO_IDS,
  startingStation,
  type BotScript,
  type InterruptRow,
  type MacroID,
  type ProgramNode,
} from "./botScript.ts";
import {
  analyzeBotRunPolicy,
  BOT_RISK_CLASSES,
  createBotLaunchGrant,
  INTERRUPT_RUN_POLICY,
  MACRO_RUN_POLICY,
  validateBotLaunchGrant,
  supportsHostedOreJettisonRecovery,
} from "./runPolicy.ts";

function script(
  program: readonly ProgramNode[],
  interrupts: readonly InterruptRow[] = [],
): BotScript {
  return {
    format: "evejs-bot-script",
    version: 1,
    name: "Policy test",
    notes: "",
    home: startingStation(),
    interrupts,
    program,
  };
}

function step(macro: MacroID): ProgramNode {
  return { id: `step-${macro}`, kind: "macro", macro, args: {} };
}

test("hosted ore custody eligibility never changes static destructive restart policy", () => {
  const doc = script([step("fleet-mine"), step("jettison-ore")]);
  assert.equal(supportsHostedOreJettisonRecovery(doc), true);
  assert.equal(analyzeBotRunPolicy(doc).restartSafe, false);
  assert.equal(MACRO_RUN_POLICY["jettison-ore"].restartSafe, false);
  assert.ok(analyzeBotRunPolicy(doc).riskClasses.includes("destructive"));
  for (const other of ["jettison-cargo", "refine-ore", "buy-item", "sell-item", "haul-all"] as const)
    assert.equal(supportsHostedOreJettisonRecovery(script([step("jettison-ore"), step(other)])), false);
});
test("a non-restart-safe interrupt cannot ride the ore custody recovery exception", () => {
  for (const respond of ["fight-back", "launch-drones", "dock-and-repair"] as const)
    assert.equal(supportsHostedOreJettisonRecovery(script([step("jettison-ore")], [
      { id: "watch", when: { kind: "hostile-on-grid" }, respond },
    ])), false);
});

test("every macro has exactly one explicit run policy", () => {
  assert.deepEqual(Object.keys(MACRO_RUN_POLICY).sort(), [...MACRO_IDS].sort());
});

test("every interrupt response has exactly one explicit run policy", () => {
  assert.deepEqual(Object.keys(INTERRUPT_RUN_POLICY).sort(), [...INTERRUPT_RESPONSES].sort());
});

test("interrupt actions are included in launch authority even when the program is harmless", () => {
  const base = step("wait");
  const launch = analyzeBotRunPolicy(script([base], [{
    id: "hostile-drones",
    when: { kind: "hostile-on-grid" },
    respond: "launch-drones",
  }]));
  assert.deepEqual(launch.riskClasses, ["combat"]);
  assert.equal(launch.restartSafe, false);
  const missingGrant = validateBotLaunchGrant(null, 1, launch);
  assert.equal(missingGrant.ok, false);
  if (!missingGrant.ok) assert.equal(missingGrant.code, "BOT_GRANT_REQUIRED");

  const repair = analyzeBotRunPolicy(script([base], [{
    id: "repair-watch",
    when: { kind: "shield-below", fraction: 0.8 },
    respond: "repair",
  }]));
  assert.deepEqual(repair.riskClasses, ["combat"]);
  assert.equal(repair.restartSafe, false);

  const alertOnly = analyzeBotRunPolicy(script([base], [{
    id: "alert-watch",
    when: { kind: "hostile-on-grid" },
    respond: "alert",
  }]));
  assert.deepEqual(alertOnly.riskClasses, []);
  assert.equal(alertOnly.restartSafe, true);
});

test("changing an interrupt to a consequential response makes an old grant stale", () => {
  const harmless = analyzeBotRunPolicy(script([step("wait")], [{
    id: "watch",
    when: { kind: "hostile-on-grid" },
    respond: "alert",
  }]));
  const grant = createBotLaunchGrant(3, harmless, 60);
  const armed = analyzeBotRunPolicy(script([step("wait")], [{
    id: "watch",
    when: { kind: "hostile-on-grid" },
    respond: "launch-drones",
  }]));
  assert.equal(validateBotLaunchGrant(grant, 3, armed).ok, false);
});

test("risk classes are closed and emitted in stable order", () => {
  const result = analyzeBotRunPolicy(script([step("buy-item"), step("jettison-cargo"), step("fight-the-rats")]));
  assert.deepEqual(result.riskClasses, ["financial", "inventory", "combat", "destructive"]);
  assert.ok(result.riskClasses.every((risk) => BOT_RISK_CLASSES.includes(risk)));
  assert.equal(result.restartSafe, false);
  assert.deepEqual(result.restartBlockers, ["buy-item", "jettison-cargo"]);
});

test("branches and loop bodies are classified, not only top-level steps", () => {
  const result = analyzeBotRunPolicy(
    script([
      {
        id: "loop",
        kind: "loop",
        repeat: { kind: "times", count: 2 },
        body: [
          {
            id: "branch",
            kind: "branch",
            when: { kind: "shield-below", fraction: 0.5 },
            then: [{ id: "repair", kind: "macro", macro: "repair-ship", args: {} }],
            else: [{ id: "dock", kind: "macro", macro: "dock-at-nearest", args: {} }],
          },
        ],
      },
    ]),
  );
  assert.deepEqual(result.macroIDs, ["repair-ship", "dock-at-nearest"]);
  assert.deepEqual(result.riskClasses, ["financial", "inventory"]);
  assert.equal(result.restartSafe, false);
});

test("sub-bots are never declared restart-safe before immutable expansion", () => {
  const result = analyzeBotRunPolicy(
    script([{ id: "sub", kind: "sub-bot", scriptID: "child-id", name: "Child" }]),
  );
  assert.equal(result.containsSubBots, true);
  assert.equal(result.restartSafe, false);
});

test("observed-state movement scripts remain restart-safe", () => {
  const result = analyzeBotRunPolicy(script([step("undock"), step("travel-to-station"), step("wait")]));
  assert.equal(result.restartSafe, true);
  assert.deepEqual(result.riskClasses, []);
  assert.deepEqual(result.restartBlockers, []);
});

test("a launch grant is exact-revision, exact-risk, and finite", () => {
  const policy = analyzeBotRunPolicy(script([step("buy-item")]));
  const grant = createBotLaunchGrant(7, policy, 60);
  assert.deepEqual(validateBotLaunchGrant(grant, 7, policy), { ok: true, grant });
  assert.equal(validateBotLaunchGrant({ ...grant, scriptRev: 8 }, 7, policy).ok, false);
  assert.equal(validateBotLaunchGrant({ ...grant, riskClasses: [] }, 7, policy).ok, false);
  assert.equal(
    validateBotLaunchGrant({ ...grant, riskClasses: [...grant.riskClasses, "combat"] }, 7, policy).ok,
    false,
  );
  assert.equal(validateBotLaunchGrant({ ...grant, maxRuntimeMinutes: 0 }, 7, policy).ok, false);
  assert.equal(validateBotLaunchGrant(null, 7, policy).ok, false);
});

test("a run may be approved for up to 72 hours and no longer", () => {
  const policy = analyzeBotRunPolicy(script([step("wait")]));
  const grant = createBotLaunchGrant(7, policy, 72 * 60);
  assert.equal(validateBotLaunchGrant(grant, 7, policy).ok, true);
  assert.equal(validateBotLaunchGrant({ ...grant, maxRuntimeMinutes: 72 * 60 + 1 }, 7, policy).ok, false);
});
