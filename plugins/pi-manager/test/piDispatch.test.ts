// R108 slice 4: dispatching "restart extractors" for a pilot, from the PI board.
//
// What is checked, and why each matters:
//
//   1. IT GOES THROUGH THE SERVER BOT HOST, ALWAYS. The bot host holds the one
//      honest claims map: it refuses a pilot a web session or another bot is
//      flying, in its own words. Nothing here selects a character.
//
//   2. THE BOT IS AN ORDINARY SAVED BOT. The host starts only saved bots, so
//      the board keeps one in the library — found by name, saved once if
//      missing — and it is visible and editable in the Bot Manager like any
//      other. A copy someone has CHANGED is not the board's any more: it is
//      not started blind, and not silently replaced either.
//
//   3. THE RISK IS DERIVED, NOT ASSERTED. The grant carries what the real
//      policy analysis says the saved document does, so an edited bot cannot
//      ride a stale approval.
//
//   4. THE SERVER'S REFUSAL IS SHOWN IN ITS OWN WORDS, and every throwaway
//      token is signed out, refused or not.

import test from "node:test";
import assert from "node:assert/strict";

import {
  PI_RESTART_BOT_NAME,
  PI_RESTART_RUNTIME_MINUTES,
  isPiRestartBot,
  piRestartBotDoc,
  restartExtractorsFor,
  haulFor,
  piHaulBotDoc,
  PI_HAUL_BOT_NAME,
  PI_HAUL_RUNTIME_MINUTES,
  type PiDispatchDeps,
} from "../lib/piDispatch.ts";
import { decodeScriptValue } from "../../../web/src/bots/scriptCodec.ts";
import { analyzeBotRunPolicy, validateBotLaunchGrant } from "../../../web/src/bots/runPolicy.ts";
import { BridgeCallError } from "../../../web/src/bridge/callMethod.ts";
import type { BotLaunchGrant } from "../../../web/src/bots/runPolicy.ts";
import { MACROS as SCRIPT_MACROS } from "./harness.ts";

const PILOT = 90000001;

interface Saved {
  scriptID: string;
  name: string;
  rev: number;
  doc: unknown;
}

function deps(
  library: Saved[] = [],
  options: {
    refuseSignIn?: boolean;
    refuseStart?: BridgeCallError;
  } = {},
): PiDispatchDeps & {
  log: string[];
  started: { characterID: number; scriptID: string; grant: BotLaunchGrant }[];
} {
  const log: string[] = [];
  const started: { characterID: number; scriptID: string; grant: BotLaunchGrant }[] = [];
  return {
    log,
    started,
    async signIn(accountName) {
      if (options.refuseSignIn) throw new Error("refused");
      log.push(`signIn:${accountName}`);
      return "tok";
    },
    async signOut(token) {
      log.push(`signOut:${token}`);
    },
    async listScripts() {
      return library.map(({ scriptID, name, rev }) => ({ scriptID, name, rev }));
    },
    async getScript(scriptID) {
      const found = library.find((row) => row.scriptID === scriptID);
      return found ? { scriptID, rev: found.rev, doc: found.doc } : null;
    },
    async createScript(doc) {
      log.push("create");
      const row = { scriptID: `s${library.length + 1}`, name: (doc as { name: string }).name, rev: 1, doc };
      library.push(row);
      return { scriptID: row.scriptID, rev: 1 };
    },
    async updateScript(scriptID, doc, baseRev) {
      log.push(`update:${scriptID}@${baseRev}`);
      const row = library.find((entry) => entry.scriptID === scriptID)!;
      row.doc = doc;
      row.rev = baseRev + 1;
      return { rev: row.rev };
    },
    async startServerBot(characterID, scriptID, grant) {
      log.push(`start:${scriptID}`);
      if (options.refuseStart) throw options.refuseStart;
      started.push({ characterID, scriptID, grant });
    },
  };
}

function refusal(status: number, message: string): BridgeCallError {
  return new BridgeCallError("CALL_REFUSED" as never, message, status);
}

test("the board's bot is a valid saved bot: one Restart extractors step, nothing else", () => {
  const decoded = decodeScriptValue(JSON.parse(JSON.stringify(piRestartBotDoc())));
  assert.equal(decoded.ok, true, decoded.ok ? "" : decoded.refusal);
  if (!decoded.ok) return;
  assert.equal(decoded.doc.name, PI_RESTART_BOT_NAME);
  assert.deepEqual(decoded.doc.program.map((node) => node.kind === "macro" && node.macro), ["pi-manager:restart-extractors"]);
  assert.deepEqual(decoded.doc.interrupts, []);
  assert.equal(isPiRestartBot(decoded.doc), true);
  // Changing colonies is all it does, and restarting it is safe.
  const policy = analyzeBotRunPolicy(decoded.doc);
  assert.deepEqual([...policy.riskClasses], ["colony"]);
});

test("with no saved copy, one is saved, then started for that pilot on the server", async () => {
  const d = deps();
  const outcome = await restartExtractorsFor("alpha", PILOT, d);
  assert.deepEqual(outcome, { kind: "started" });
  assert.deepEqual(d.log, ["signIn:alpha", "create", "start:s1", "signOut:tok"]);
  const [run] = d.started;
  assert.equal(run!.characterID, PILOT);
  // The grant is one the server's own validator accepts for that document.
  const decoded = decodeScriptValue(piRestartBotDoc());
  assert.ok(decoded.ok);
  if (!decoded.ok) return;
  const verdict = validateBotLaunchGrant(run!.grant, 1, analyzeBotRunPolicy(decoded.doc));
  assert.equal(verdict.ok, true);
  assert.equal(run!.grant.maxRuntimeMinutes, PI_RESTART_RUNTIME_MINUTES);
});

test("an existing saved copy is reused, at its current revision, never saved twice", async () => {
  const library = [
    { scriptID: "x", name: "My mining bot", rev: 4, doc: {} },
    { scriptID: "pi", name: PI_RESTART_BOT_NAME, rev: 7, doc: piRestartBotDoc() },
  ];
  const d = deps(library);
  assert.deepEqual(await restartExtractorsFor("alpha", PILOT, d), { kind: "started" });
  assert.equal(d.log.includes("create"), false);
  assert.equal(d.started[0]!.scriptID, "pi");
  assert.equal(d.started[0]!.grant.scriptRev, 7);
});

test("⚠ a saved copy someone changed is not started, and not quietly replaced", async () => {
  const changed = { ...piRestartBotDoc(), program: [...piRestartBotDoc().program, { id: "u", kind: "macro", macro: "undock", args: {} }] };
  const d = deps([{ scriptID: "pi", name: PI_RESTART_BOT_NAME, rev: 3, doc: changed }]);
  const outcome = await restartExtractorsFor("alpha", PILOT, d);
  assert.equal(outcome.kind, "refused");
  assert.match(outcome.kind === "refused" ? outcome.sentence : "", /has been changed/);
  assert.equal(d.log.some((event) => event === "create" || event.startsWith("start:")), false);
  assert.equal(d.log.at(-1), "signOut:tok");
});

test("⚠ the server's refusal is shown in its own words, and the token is still signed out", async () => {
  const inUse = "A web session is flying this character. Log it out (or wait for it to expire), then start the bot.";
  const d = deps([], { refuseStart: refusal(409, inUse) });
  assert.deepEqual(await restartExtractorsFor("alpha", PILOT, d), { kind: "refused", sentence: inUse });
  assert.equal(d.log.at(-1), "signOut:tok");
});

test("a request that never reached the server says so, not the transport's message", async () => {
  const d = deps([], { refuseStart: refusal(0, "POST /api/bots/start aborted: fetch failed") });
  const outcome = await restartExtractorsFor("alpha", PILOT, d);
  assert.deepEqual(outcome, { kind: "refused", sentence: "The server could not be reached just now." });
});

test("a refused sign-in starts nothing", async () => {
  const d = deps([], { refuseSignIn: true });
  assert.deepEqual(await restartExtractorsFor("alpha", PILOT, d), {
    kind: "refused",
    sentence: "Could not sign in to this pilot's account just now.",
  });
  assert.deepEqual(d.started, []);
});

test("isPiRestartBot knows the board's bot from any other", () => {
  const decoded = decodeScriptValue(piRestartBotDoc());
  assert.ok(decoded.ok);
  if (!decoded.ok) return;
  assert.equal(isPiRestartBot({ ...decoded.doc, interrupts: [{ id: "w", when: { kind: "shield-below", fraction: 0.3 }, respond: "dock-and-pause" }] as never }), false);
  assert.equal(isPiRestartBot({ ...decoded.doc, program: [] }), false);
});

test("the run limit is the hour the board's row promises", () => {
  // bridge/piBoard.ts says "runs for an hour at most" before the button.
  assert.equal(PI_RESTART_RUNTIME_MINUTES, 60);
});

// ── Haul ─────────────────────────────────────────────────────────────────────

const COLONIES = [
  { planetID: 40000001, planetName: "Alpha II", solarSystemID: 30000001, solarSystemName: "Alpha" },
  { planetID: 40000002, planetName: "Alpha IX", solarSystemID: 30000001, solarSystemName: "Alpha" },
  { planetID: 40000003, planetName: "Beta V", solarSystemID: 30000002, solarSystemName: "Beta" },
];

test("⚠ the lap collects BOTH ways off a colony, in every system it visits", () => {
  // A launchpad goes up into the customs office before the run starts; a
  // command centre cannot (the server takes only a spaceport pin), so it still
  // leaves as a container in space. Dropping either collector strands goods.
  // ⚠ The hauler comes before the launch: a launch charges export tax, so a
  // pilot with no hauler has to stop before paying it.
  const doc = piHaulBotDoc(COLONIES, { division: 3, name: "Industry" });
  assert.deepEqual(doc.program.map((step) => (step.kind === "macro" ? `${step.macro}` : step.kind)), [
    "pi-manager:board-hauler",
    "pi-manager:launch-commodities",
    "undock",
    "travel-to-system",
    "pi-manager:collect-customs",
    "pi-manager:collect-launches",
    "travel-to-system",
    "pi-manager:collect-customs",
    "pi-manager:collect-launches",
    "travel-to-station",
    "unload-cargo",
    "board-previous-ship",
  ]);
  // One trip per SYSTEM, not per colony: two of the three share Alpha.
  assert.equal(doc.program.filter((step) => step.kind === "macro" && step.macro === "travel-to-system").length, 2);
  const unload = doc.program[10]!;
  assert.ok(unload.kind === "macro");
  assert.deepEqual(unload.args["into"], { kind: "corpDivision", division: 3, name: "Industry" });
  // It must survive the library's own reader, or the start would refuse it.
  const decoded = decodeScriptValue(JSON.parse(JSON.stringify(doc)));
  assert.ok(decoded.ok);
});

test("the haul doc with no division unloads into the pilot's own hangar", () => {
  const unload = piHaulBotDoc(COLONIES.slice(0, 1), null).program.find((step) => step.kind === "macro" && step.macro === "unload-cargo");
  assert.ok(unload !== undefined && unload.kind === "macro");
  assert.deepEqual(unload.args, {});
});

test("the saved haul launches nonempty command centres even below one percent full", () => {
  const decoded = decodeScriptValue(piHaulBotDoc(COLONIES.slice(0, 1), null));
  assert.ok(decoded.ok);
  if (!decoded.ok) return;
  const launch = decoded.doc.program.find((step) => step.id === "launch")!;
  assert.ok(launch.kind === "macro");
  const result = SCRIPT_MACROS["launch-commodities"]!(launch, {
    colonies: [{
      planetID: COLONIES[0]!.planetID,
      planetName: COLONIES[0]!.planetName,
      pins: [{
        pinID: 100,
        kind: "command",
        usedM3: 1,
        capacityM3: 500,
        contents: [{ typeID: 2398, quantity: 1 }],
        lastLaunchAtMs: null,
      }],
    }],
  } as never, {}, {});
  assert.equal(result.action.kind, "launchCommodities");
});

test("haul: saves the bot once, then rewrites it on the next haul and starts that revision", async () => {
  const library: Saved[] = [];
  const first = deps(library);
  const started = await haulFor("acct", PILOT, COLONIES, null, null, first);
  assert.equal(started.kind, "started");
  // Nothing is sent before the bot starts: the run sends each launchpad up at
  // its office, on the pilot's own session.
  assert.deepEqual(first.log, [
    "signIn:acct",
    "create",
    "start:s1",
    "signOut:tok",
  ]);
  assert.equal(library[0]!.name, PI_HAUL_BOT_NAME);

  const second = deps(library);
  assert.equal((await haulFor("acct", PILOT, COLONIES.slice(2), null, null, second)).kind, "started");
  assert.deepEqual(second.log, ["signIn:acct", "update:s1@1", "start:s1", "signOut:tok"]);
  const grant = second.started[0]!.grant;
  assert.equal(grant.scriptRev, 2);
  assert.equal(grant.maxRuntimeMinutes, PI_HAUL_RUNTIME_MINUTES);
  assert.ok(validateBotLaunchGrant(grant, 2, analyzeBotRunPolicy(piHaulBotDoc(COLONIES.slice(2), null))).ok);
});

test("haul: nothing ticked is refused before anyone is signed in", async () => {
  const d = deps();
  const outcome = await haulFor("acct", PILOT, [], null, null, d);
  assert.equal(outcome.kind, "refused");
  assert.deepEqual(d.log, []);
});

test("a picked delivery station: unload there, then fly back to where the earlier ship is parked", () => {
  const station = { entity: "station" as const, id: 60000004, name: "Home Office", systemName: "Alpha" };
  const doc = piHaulBotDoc(COLONIES.slice(0, 1), null, station);
  const tail = doc.program.slice(-4).map((step) => (step.kind === "macro" ? step.macro : step.kind));
  assert.deepEqual(tail, ["travel-to-station", "unload-cargo", "travel-to-station", "board-previous-ship"]);
  const deliver = doc.program.find((step) => step.id === "deliver")!;
  assert.ok(deliver.kind === "macro");
  assert.deepEqual(deliver.args["station"], { kind: "station", ref: station });
  const home = doc.program.find((step) => step.id === "home")!;
  assert.ok(home.kind === "macro");
  assert.deepEqual(home.args["station"], { kind: "station", ref: { entity: "station", id: null, name: null, systemName: null, starting: true } });
  // And the bot's home is that station: a run that starts in space docks there.
  assert.deepEqual(doc.home, station);
});

test("no delivery station picked: the bot's home is where the run starts", () => {
  assert.deepEqual(piHaulBotDoc(COLONIES.slice(0, 1), null, null).home, { entity: "station", id: null, name: null, systemName: null, starting: true });
});

test("no station picked, or the starting station picked: one trip back, no second leg", () => {
  for (const deliverTo of [null, { entity: "station" as const, id: null, name: null, systemName: null, starting: true }]) {
    const doc = piHaulBotDoc(COLONIES.slice(0, 1), null, deliverTo);
    assert.equal(doc.program.filter((step) => step.kind === "macro" && step.macro === "travel-to-station").length, 1);
  }
});
