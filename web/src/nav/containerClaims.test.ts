import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createScriptRunner, type ScriptRunnerDeps } from "./scriptRunner.ts";
import type { BotScript } from "../bots/botScript.ts";
import type { ScriptObservation } from "./scriptConditions.ts";
import type { MacroDecider, ScriptAction } from "./scriptDecide.ts";

const { createLootMemory, CONTAINER_LEASE_MS } = createRequire(import.meta.url)("../../../src/lootMemory.js");
const SYSTEM = 30000144;
const X = 80001, Y = 80002;
const doc: BotScript = {
  format: "evejs-bot-script", version: 1, name: "claim test", notes: "",
  home: { entity: "station", id: 60001, name: "Home", systemName: null }, interrupts: [],
  program: [{ id: "loot", kind: "macro", macro: "loot-containers", args: {} }],
};
function observation(): ScriptObservation {
  return {
    inSpace: true, docked: false, inWarp: false, shieldRatio: 1, armorRatio: 1, hullRatio: 1,
    health: 1, oreHoldFraction: 0, holdEmpty: true, hostileOnGrid: false, dronesOut: false,
    flightStatus: { inSpace: true, docked: false, solarSystemID: SYSTEM, stationID: null,
      structureID: null, shipID: 1, shipTypeID: 2, shipIsCapsule: false, shipMode: null,
      shipSpeedFraction: null },
  };
}
const decideFor = (loot: boolean): MacroDecider => (_step, obs) => {
  const ids = [X, Y].filter((id) => !(obs.claimedContainerIDs ?? []).includes(id));
  const id = ids[0];
  return { action: id ? (loot ? { kind: "lootContainer", containerID: id } : { kind: "approach", targetID: id }) : { kind: "wait" },
    containerTargetID: id, why: id ? "servicing" : "other haulers", phase: "Looting",
    armed: true, outcome: { kind: "acting" }, nextMem: {} };
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function rig() {
  let now = 1_000;
  const memory = createLootMemory({ now: () => now });
  function hauler(session: string, issue: ScriptRunnerDeps["issue"] = async () => {}, loot = false) {
    const issued: ScriptAction[] = [];
    const runner = createScriptRunner({
      observe: async () => observation(),
      issue: async (action, owner) => { issued.push(action); return issue(action, owner); },
      sleep: async () => {}, onProgress: () => {}, isSessionLost: () => false,
      refusalReason: (error) => String(error), registry: { "loot-containers": decideFor(loot) },
      travelHome: () => { throw new Error("unexpected home travel"); },
      claims: {
        read: async (runID, system) => memory.claimedItemIDs(system, session, runID),
        acquire: async (runID, system, item, renew) => memory.claimContainer(session, runID, system, item, renew),
        release: async (runID) => { memory.releaseClaims(session, runID); },
      },
    });
    runner.start(doc);
    return { runner, issued };
  }
  return { memory, hauler, advance: (ms: number) => { now += ms; } };
}

test("two runs service distinct live containers and own generation renews", async () => {
  const setup = rig();
  const a = setup.hauler("a"), b = setup.hauler("b");
  await a.runner.tick();
  await b.runner.tick();
  assert.deepEqual(a.issued, [{ kind: "approach", targetID: X }]);
  assert.deepEqual(b.issued, [{ kind: "approach", targetID: Y }]);
  setup.advance(CONTAINER_LEASE_MS - 1);
  await a.runner.tick(); // settle tick renews, without another world call
  assert.equal(setup.memory.claimContainer("third", "run", SYSTEM, X), false);
});

test("server graceful stop waits for an issued transfer before releasing exclusivity", async () => {
  const setup = rig();
  const pendingIssue = deferred(), started = deferred();
  const a = setup.hauler("a", async () => { started.resolve(); await pendingIssue.promise; }, true);
  const inFlight = a.runner.tick();
  await started.promise;
  const stop = a.runner.beginGracefulStop();
  assert.equal(setup.memory.claimContainer("b", "run", SYSTEM, X), false);
  pendingIssue.resolve();
  await Promise.all([inFlight, stop]);
  assert.equal(setup.memory.claimContainer("b", "run", SYSTEM, X), true);
});

test("unknown claim authority blocks the route without an inventory issue", async () => {
  const setup = rig();
  const a = setup.hauler("a");
  // A runner with no authority is still a valid pure-test controller, but may
  // not service a live container.
  const noAuthority = createScriptRunner({
    observe: async () => observation(), issue: async (action) => { a.issued.push(action); },
    sleep: async () => {}, onProgress: () => {}, isSessionLost: () => false,
    refusalReason: String, registry: { "loot-containers": decideFor(true) },
    travelHome: () => { throw new Error("unexpected home travel"); },
  });
  noAuthority.start(doc);
  // In space the stop flies home first (scriptRunner `pauseWith`); this home
  // decider throws, which is the second fault that ends the run.
  for (let i = 0; i < 5 && noAuthority.getStatus() === "running"; i++) await noAuthority.tick();
  assert.deepEqual(a.issued, []);
  assert.equal(noAuthority.getStatus(), "paused");
});

test("a stop during awaited claim renewal cannot publish a stale running settle", async () => {
  const setup = rig();
  const entered = deferred(), resume = deferred();
  const states: string[] = [];
  let acquisitions = 0;
  const runner = createScriptRunner({
    observe: async () => observation(), issue: async () => {},
    sleep: async () => {}, onProgress: (snapshot) => { states.push(snapshot.status); },
    isSessionLost: () => false, refusalReason: String,
    registry: { "loot-containers": decideFor(false) },
    travelHome: () => { throw new Error("unexpected home travel"); },
    claims: {
      read: async (runID, system) => setup.memory.claimedItemIDs(system, "a", runID),
      acquire: async (runID, system, item, renew) => {
        acquisitions += 1;
        if (acquisitions === 2) { entered.resolve(); await resume.promise; }
        return setup.memory.claimContainer("a", runID, system, item, renew);
      },
      release: async (runID) => { setup.memory.releaseClaims("a", runID); },
    },
  });
  runner.start(doc);
  await runner.tick(); // selects X and sets the ordinary settle budget
  const settling = runner.tick();
  await entered.promise;
  runner.stop();
  resume.resolve();
  await settling;
  assert.equal(runner.getStatus(), "stopped");
  assert.equal(states.at(-1), "stopped", "an obsolete settle must not emit running after stop");
});
