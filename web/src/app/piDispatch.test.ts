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
  summarizeCustomsExport,
  type PiDispatchDeps,
} from "./piDispatch.ts";
import type { CustomsExportResult } from "./api.ts";
import { decodeScriptValue } from "../bots/scriptCodec.ts";
import { analyzeBotRunPolicy, validateBotLaunchGrant } from "../bots/runPolicy.ts";
import { BridgeCallError } from "../bridge/callMethod.ts";
import type { BotLaunchGrant } from "../bots/runPolicy.ts";
import { SCRIPT_MACROS } from "../nav/scriptMacros.ts";

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
    refuseExport?: BridgeCallError;
    exportResult?: CustomsExportResult;
  } = {},
): PiDispatchDeps & {
  log: string[];
  started: { characterID: number; scriptID: string; grant: BotLaunchGrant }[];
  exportedPlanetIDs: number[][];
} {
  const log: string[] = [];
  const exportedPlanetIDs: number[][] = [];
  const started: { characterID: number; scriptID: string; grant: BotLaunchGrant }[] = [];
  return {
    log,
    started,
    exportedPlanetIDs,
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
    async exportToCustoms(_characterID, planetIDs) {
      log.push(`export:${planetIDs.join(",")}`);
      exportedPlanetIDs.push([...planetIDs]);
      if (options.refuseExport) throw options.refuseExport;
      return options.exportResult ?? {
        connected: true,
        handedBack: null,
        planets: planetIDs.map((planetID) => ({
          planetID,
          planetName: `Planet ${planetID}`,
          solarSystemID: 30000001,
          solarSystemName: "Alpha",
          officeID: 1_200_000_000_000 + planetID,
          exported: true,
          units: 100,
          reason: null,
          message: null,
        })),
      };
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
  assert.deepEqual(decoded.doc.program.map((node) => node.kind === "macro" && node.macro), ["restart-extractors"]);
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
    "board-planetary-hauler",
    "launch-commodities",
    "undock",
    "travel-to-system",
    "collect-customs",
    "collect-launches",
    "travel-to-system",
    "collect-customs",
    "collect-launches",
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
  // ⚠ THE EXPORT COMES FIRST, BEFORE THE BOT. It selects the character in game,
  // so doing it afterwards would take the ship out from under the running bot.
  assert.deepEqual(first.log, [
    "signIn:acct",
    "export:40000001,40000002,40000003",
    "create",
    "start:s1",
    "signOut:tok",
  ]);
  assert.equal(library[0]!.name, PI_HAUL_BOT_NAME);

  const second = deps(library);
  assert.equal((await haulFor("acct", PILOT, COLONIES.slice(2), null, null, second)).kind, "started");
  assert.deepEqual(second.log, ["signIn:acct", "export:40000003", "update:s1@1", "start:s1", "signOut:tok"]);
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

test("⚠ an export the server refuses outright stops the haul: no bot is started", async () => {
  // Nothing reached the offices, so there is nothing out there to fetch — and
  // the refusal (a bot or another tab is flying this pilot) is the thing to say.
  const d = deps([], { refuseExport: refusal(409, "A server bot is flying this pilot. Stop the bot first.") });
  const outcome = await haulFor("acct", PILOT, COLONIES, null, null, d);
  assert.deepEqual(outcome, { kind: "refused", sentence: "A server bot is flying this pilot. Stop the bot first." });
  assert.deepEqual(d.log, ["signIn:acct", "export:40000001,40000002,40000003", "signOut:tok"]);
  assert.deepEqual(d.started, []);
});

test("one colony's refusal does not stop the haul; it is carried back with the start", async () => {
  const d = deps([], {
    exportResult: {
      connected: true,
      handedBack: null,
      planets: [
        { planetID: 40000001, planetName: "Alpha II", solarSystemID: 30000001, solarSystemName: "Alpha",
          officeID: 1_200_040_000_001, exported: true, units: 220, reason: null, message: null },
        { planetID: 40000002, planetName: "Alpha IX", solarSystemID: 30000001, solarSystemName: "Alpha",
          officeID: null, exported: false, units: 0, reason: "refused", message: "CannotLaunchCommoditiesNotFound" },
        // Between hauls a pad is often simply empty. That is not a refusal and
        // must not read as one.
        { planetID: 40000003, planetName: "Beta V", solarSystemID: 30000002, solarSystemName: "Beta",
          officeID: null, exported: false, units: 0, reason: "nothing-on-the-pads", message: null },
      ],
    },
  });
  const outcome = await haulFor("acct", PILOT, COLONIES, null, null, d);
  assert.equal(outcome.kind, "started");
  assert.deepEqual(outcome.kind === "started" ? outcome.exported : null, {
    units: 220,
    colonies: 1,
    refusals: ["Alpha IX: CannotLaunchCommoditiesNotFound"],
  });
  assert.equal(d.started.length, 1);
});

test("the export summary names a planet with no office, and says nothing about an empty pad", () => {
  const summary = summarizeCustomsExport({
    connected: true,
    handedBack: true,
    planets: [
      { planetID: 1, planetName: "Alpha II", solarSystemID: 2, solarSystemName: "Alpha",
        officeID: null, exported: false, units: 0, reason: "no-office", message: null },
      { planetID: 2, planetName: "Alpha IX", solarSystemID: 2, solarSystemName: "Alpha",
        officeID: null, exported: false, units: 0, reason: "nothing-on-the-pads", message: null },
      { planetID: 3, planetName: null, solarSystemID: 2, solarSystemName: "Alpha",
        officeID: 9, exported: true, units: 40, reason: null, message: null },
    ],
  });
  assert.deepEqual(summary, {
    units: 40,
    colonies: 1,
    refusals: ["Alpha II has no customs office to launch into."],
  });
});

test("a partial pad export keeps its successful units and refusal while the haul still collects them", async () => {
  const result: CustomsExportResult = {
    connected: true,
    handedBack: null,
    planets: [{
      planetID: 40000001, planetName: "Alpha II", solarSystemID: 30000001, solarSystemName: "Alpha",
      officeID: 1_200_040_000_001, exported: true, units: 70,
      reason: "refused", message: "CannotLaunchCommoditiesNotFound",
    }],
  };
  assert.deepEqual(summarizeCustomsExport(result), {
    units: 70,
    colonies: 1,
    refusals: ["Alpha II: CannotLaunchCommoditiesNotFound"],
  });
  const library: Saved[] = [];
  const d = deps(library, { exportResult: result });
  const outcome = await haulFor("acct", PILOT, COLONIES.slice(0, 1), null, null, d);
  assert.equal(outcome.kind, "started");
  const doc = library[0]!.doc as ReturnType<typeof piHaulBotDoc>;
  const collector = doc.program.find((step) => step.kind === "macro" && step.macro === "collect-customs");
  assert.ok(collector?.kind === "macro");
  // A partial export goes into the same depositor-scoped office. The generated
  // collector still takes that positive inventory rather than omitting it.
  const collected = SCRIPT_MACROS["collect-customs"]!(collector, {
    inSpace: true, inWarp: false, holds: null,
    flightStatus: { docked: false },
    snapshot: {
      inSpace: true,
      entities: [{ itemID: 1_200_040_000_001, groupID: 1025, radius: 1000, position: { x: 1000, y: 0, z: 0 } }],
      ship: { position: { x: 0, y: 0, z: 0 } },
    },
    customsOffices: [{ officeID: 1_200_040_000_001, units: 70, stacks: 1 }],
  } as never, {}, {});
  assert.deepEqual(collected.action, { kind: "collectCustoms", officeID: 1_200_040_000_001 });
});

// On the game port the BFF does not send the launchpads up before the run: the run does it itself, at each
// office, as the client does. The BFF says so, and that is no refusal.
test("an export the run itself will make at the offices is no refusal, and the summary says whose it is", () => {
  const summary = summarizeCustomsExport({
    connected: false,
    handedBack: null,
    atTheOffices: true,
    planets: [
      { planetID: 1, planetName: "Alpha II", solarSystemID: 2, solarSystemName: "Alpha", officeID: null, exported: false, units: 0, reason: "at-the-office", message: null },
      { planetID: 2, planetName: "Alpha IX", solarSystemID: 2, solarSystemName: "Alpha", officeID: null, exported: false, units: 0, reason: "at-the-office", message: null },
    ],
  });
  assert.deepEqual(summary, { units: 0, colonies: 0, refusals: [], atTheOffices: true });
});
