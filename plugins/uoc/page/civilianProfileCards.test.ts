import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compile } from "svelte/compiler";
import { render } from "svelte/server";
import { createCivilianIndex } from "../civilian/index.ts";
import { createCivilianProfileRoutes } from "../civilian/profiles.ts";
import type { CivilianProfile } from "../civilian/profile.ts";
import type { openDefaultFarmerAccount, ServerBot } from "../restored/app/api.ts";
import { civilianSession } from "../restored/app/civilianSession.ts";
import { installPageContext } from "../restored/app/context.ts";

register("../../../web/src/ui/svelteSsrHook.ts", import.meta.url);

async function loadView(name: string, setup: string) {
  const file = new URL("../restored/ui/" + name + ".svelte", import.meta.url);
  const source = readFileSync(file, "utf8").replace("</script>", setup + "\n</script>");
  const { js } = compile(source, { filename: fileURLToPath(file), generate: "server" });
  const code = js.code.replace(/from (['"])([^'"]+)\1/g, (_line, _quote, uri: string) =>
    "from " + JSON.stringify(uri.startsWith(".") ? new URL(uri, file).href : import.meta.resolve(uri)));
  return (await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"))).default;
}

const pilot = { characterID: 7, characterName: "Courier Pilot", accountName: "Courier" };
const completed = {
  botID: "closed", characterID: 7, characterName: pilot.characterName, kind: "plugin",
  plugin: { pluginID: "uoc", run: "civilian-distribution", readout: null },
  scriptName: "Civilian Distribution", status: "stopped", phase: "Completed",
  startedAt: "2026-11-22T12:00:00Z", endedAt: "2026-11-22T13:00:00Z",
  civilianStatus: "Completed", civilianView: "HISTORY", missionID: 900,
  hasAcceptedMission: false, canContinue: false,
  missionProgress: { missionName: null, agentName: "Fixture Agent", corporationName: null, completedCount: 3 },
} as const satisfies Partial<ServerBot>;

type Restored = {
  workspace: Awaited<ReturnType<typeof openDefaultFarmerAccount>>;
  profiles: CivilianProfile[];
  accounts: string[];
  watchedAccounts: string[];
  maxRuntimeMinutes: number | null;
};
type Scenario = {
  restored?: Restored;
  action?: "configure" | "choose";
  bot?: Partial<ServerBot>;
  restore?: () => Promise<Restored>;
  save?: () => Promise<void>;
};
const context = globalThis as typeof globalThis & { civilianCardsTest?: Scenario };

test("Civilian Missions discovers history, saves a real profile and reopens it from Add pilot", async () => {
  const Missions = await loadView("CivilianMissions", `
    const scenario = globalThis.civilianCardsTest;
    scenario.restore = async () => {
      await restore(++authGeneration);
      return { workspace, profiles, accounts, watchedAccounts, maxRuntimeMinutes };
    };
    if (scenario.restored) {
      ({ workspace, profiles, maxRuntimeMinutes } = scenario.restored);
      profilesLoaded = true;
    }
    if (scenario.action === "configure") {
      configureWorker(scenario.bot, "Courier");
      maxJumps = 6;
    } else if (scenario.action === "choose") {
      openEditor();
      selectPilot({ characterID: 7, characterName: "Other label", accountName: "Courier" });
    }
    scenario.save = saveProfile;
  `);
  let runs: unknown = null, saved: unknown = null, writes = 0, policyAvailable = true;
  const index = createCivilianIndex({ read: () => runs, write: value => { runs = structuredClone(value); } });
  const worldID = "civilian-card-fixture";
  index.put({ worldID, owner: "courier", characterID: 7, botID: completed.botID, kind: "distribution",
    status: "stopped", phase: "Completed", pending: null, firstFailure: null, resolved: true, updatedAt: 60 });
  const before = structuredClone(runs);
  const routes = createCivilianProfileRoutes(() => ({
    doc: { read: () => structuredClone(saved), write: value => { saved = structuredClone(value); writes++; } },
    close() {},
  }), index.workerAccounts);
  const account = { username: "Operator", accountID: 1 };
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/center/account")) return Response.json({ ok: true, account, worldID });
    if (path === "/api/bots") return Response.json({ hostedRunPolicy: policyAvailable ? { maxRuntimeMinutes: 240 } : null });
    const method = init?.method ?? "GET";
    const route = routes[method + " " + path.replace("/api/plugins/uoc", "")];
    assert.ok(route, path);
    const request = { account, worldID, method, path, params: {}, query: {}, body: init?.body ? JSON.parse(String(init.body)) : null };
    const answer = await route(request);
    return Response.json(answer.body, { status: answer.status });
  };
  installPageContext({ readAccounts: () => [{ ...account, options: {
    token: "fixture-access", fetch: fetcher, baseUrl: "http://civilian.test",
  } }], accountPass: {
    optionsFor: async () => assert.fail("Discovery must not acquire any pilot."),
    forget() {}, async release() {},
  }, readPageAccounts: () => [pilot.accountName] });

  function page(scenario: Scenario) {
    context.civilianCardsTest = scenario;
    return render(Missions, {}).body;
  }
  try {
    const opened: Scenario = {};
    page(opened);
    const history = await opened.restore!();
    assert.deepEqual(history.profiles, []);
    assert.deepEqual(history.accounts, ["Operator", pilot.accountName]);
    assert.deepEqual(history.watchedAccounts, ["Operator"]);
    const configure: Scenario = { restored: history, action: "configure", bot: completed };
    const editor = page(configure);
    assert.match(editor, /Selected pilot: <strong>Courier Pilot/);
    assert.match(editor, /<option value="distribution" selected(?:="")?>Delivery \/ Courier/);
    assert.equal(writes, 0);
    await configure.save!();
    assert.equal(writes, 1);
    assert.deepEqual(runs, before);

    policyAvailable = false;
    const reopened: Scenario = {};
    page(reopened);
    const state = await reopened.restore!();
    assert.equal(state.profiles.length, 1);
    assert.equal(state.profiles[0]?.maxJumps, 6);
    assert.equal(state.profiles[0]?.mode, "distribution");
    const editing = page({ restored: state, action: "choose" });
    assert.match(editing, /Edit Courier Pilot/);
    assert.doesNotMatch(editing, /Selected pilot: <strong>Other label/);
    assert.equal(writes, 1);
  } finally {
    delete context.civilianCardsTest;
    civilianSession.save(null);
    installPageContext({});
  }
});

test("Civilian cards render history and the actions permitted by each mission state", async () => {
  const Cards = await loadView("CivilianWorkers", `
    const bot = globalThis.civilianCardsTest.bot;
    snapshots = { courier: { fresh: true, data: { bots: [bot], recovery: [], accountIdle: !!bot.endedAt } } };
    loaded = true;
  `);
  const profile: CivilianProfile = { pilot, mode: "distribution", automatic: true, agent: null, corporationID: null,
    runtime: 120, policy: "TIME", limit: 0, maxJumps: 6, searchJumps: 10, level: 1, fallback: false, parking: { mode: "NEAREST" } };
  function card(bot: Partial<ServerBot>, profiles: CivilianProfile[] = [profile]) {
    context.civilianCardsTest = { bot };
    return render(Cards, { props: { profiles, accounts: [pilot.accountName], watchedAccounts: [], refreshKey: 0 } }).body;
  }
  try {
    const history = card(completed, []);
    assert.match(history, /Mission #900[\s\S]*Fixture Agent[\s\S]*3 completed/);
    assert.match(history, /No saved mission settings[\s\S]*>Set up profile<\/button>/);
    assert.doesNotMatch(history, />(Start|Continue|Stop|Edit|Remove)<\/button>|Add a pilot to save its mission settings/);

    const stopped = card(completed);
    for (const action of ["Start", "Edit", "Remove"]) assert.ok(stopped.includes(">" + action + "</button>"), action);
    assert.doesNotMatch(stopped, />(Continue|Stop|Set up profile)<\/button>/);

    const accepted = card({ ...completed, civilianStatus: "Stopped · Mission accepted",
      civilianView: "CURRENT", hasAcceptedMission: true, canContinue: true });
    assert.match(accepted, />Continue<\/button>/);
    assert.doesNotMatch(accepted, />(Start|Stop)<\/button>/);

    const running = card({ ...completed, endedAt: null, status: "running", phase: "Delivering",
      civilianStatus: "Running", civilianView: "CURRENT", civilianOwned: true });
    assert.match(running, />Stop<\/button>/);
    assert.doesNotMatch(running, />(Start|Continue)<\/button>/);
  } finally {
    delete context.civilianCardsTest;
  }
});
