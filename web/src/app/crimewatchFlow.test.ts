// The pilot's combat timers and its ship's safety level on the page.
//
// The retail client's crimewatch service has them from the choosing of the character on, changes them at the
// server's notices of each (crimewatchSvc.py 222 to 288), and asks crimewatch again at a change of place, and in
// space at a change of system or ship (95, 119). The page reads them of the BFF at the same moments. On the game
// port the BFF answers from what the transport keeps as the client's service does.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";

const PILOT = 140000001;
const aSet = () => ({ type: "objectex1", header: [{ type: "token", value: "__builtin__.set" }, [{ type: "list", items: [] }]], list: [], dict: [] });
/** This server's answer for a pilot with nothing running, with the safety level given. */
const statesWith = (safetyLevel: number) => [[[100, null], [200, null], [400, null], [300, null], [500, null]], { type: "dict", entries: [] }, [aSet(), aSet()], safetyLevel];

interface PushSource {
  onmessage: ((event: { data: string }) => void) | null;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

/**
 * A pilot online with its live channel open. `answer` is what the crimewatch read answers now. `sets` is what
 * the safety level was asked to be set to, each as it was sent; `setFails` refuses the next, and `setHold` keeps
 * its answer back.
 */
async function online(from: { fail?: boolean; grade?: { result: unknown } | "not carried" | "fails" } = {}) {
  const store = createClientStore();
  const state: { answer: unknown; fail: boolean; hold: Promise<void> | null; setFails: boolean; setHold: Promise<void> | null; grade: unknown } = {
    answer: { ok: true, serverNowMs: Date.now() + 5000, clientStates: statesWith(2) }, fail: from.fail === true, hold: null, setFails: false, setHold: null,
    grade: "grade" in from ? from.grade : { result: 1 },
  };
  let reads = 0;
  let gradeReads = 0;
  /** The two reads as the page asked them: each a call of its pilot's, by the generic call. */
  const asked: Record<string, unknown>[] = [];
  const sets: Array<Record<string, unknown>> = [];
  let routeSets = 0;
  const fetchImpl = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const path = String(input);
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
    let status = 200;
    let answer: unknown = { ok: true };
    if (path === "/api/bridge/select") {
      answer = { ok: true, character: { characterID: body.characterID, characterName: "Test Pilot", stationID: 60003760, structureID: null, solarSystemID: 30000142, corporationID: 1000044 }, droneRecoveryCheckID: "check-1" };
    } else if (path === "/api/bridge/safety/set-level") {
      // The route the level was set by until the page made the call itself: nothing asks it now.
      routeSets += 1;
    } else if (path === "/api/bridge/call" && body.service === "crimewatch" && body.method === "SetSafetyLevel") {
      // crimewatchSvc's own call, made by the page (bridge/crimewatchWrites.ts).
      sets.push(body);
      if (state.setHold) await state.setHold;
      if (state.setFails) {
        status = 409;
        answer = { ok: false, error: "SESSION_CHANGE_IN_PROGRESS", message: "The session is changing place." };
      } else {
        answer = { ok: true, service: body.service, method: body.method, result: (body.args as unknown[])[0], notifications: [] };
      }
    } else if (path === "/api/bridge/call" && body.service === "subscriptionMgr" && body.method === "GetCloneGrade") {
      // clone_grade_svc's own call, asked by the page (bridge/cloneGradeReads.ts).
      gradeReads += 1;
      asked.push(body);
      if (state.grade === "fails") {
        status = 502;
        answer = { ok: false, error: "EVE_GATEWAY_UNREACHABLE", message: "The game server is unreachable." };
      } else if (state.grade === "not carried") {
        status = 403;
        answer = { ok: false, error: "CALL_NOT_ALLOWED", message: "subscriptionMgr.GetCloneGrade is not on the web-call allowlist." };
      } else {
        answer = { ok: true, service: body.service, method: body.method, result: (state.grade as { result: unknown }).result, notifications: [] };
      }
    } else if (path === "/api/bridge/call" && body.service === "crimewatch" && body.method === "GetClientStates") {
      // crimewatchSvc's own call, asked by the page (bridge/crimewatchReads.ts). The states are the call's result,
      // and the clock is what the answer says beside it, where it says one.
      reads += 1;
      asked.push(body);
      if (state.hold) await state.hold;
      if (state.fail) {
        status = 502;
        answer = { ok: false, error: "EVE_GATEWAY_UNREACHABLE", message: "The game server is unreachable." };
      } else {
        const said = state.answer as { serverNowMs?: unknown; clientStates?: unknown };
        answer = { ok: true, service: body.service, method: body.method, result: said.clientStates, notifications: [], ...("serverNowMs" in said ? { serverNowMs: said.serverNowMs } : {}) };
      }
    } else if (path === "/api/bridge/call") {
      answer = { ok: true, service: body.service, method: body.method, result: null, notifications: [] };
    }
    return { ok: status >= 200 && status < 300, status, async json() { return answer; } };
  }) as unknown as typeof fetch;
  const sources: PushSource[] = [];
  const eventSource = (): PushSource => {
    const source: PushSource = { onmessage: null, onopen: null, onerror: null, close() {} };
    sources.push(source);
    return source;
  };
  const flow = createAppFlow(store, { fetch: fetchImpl, eventSource });
  await flow.selectCharacter(PILOT);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const source = sources[0];
  assert.ok(source, "coming online opens the live channel");
  source.onopen?.();
  let sequence = 0;
  /** The server pushes a notification, and what it sets going is given time to finish. */
  const push = async (method: string, args: readonly unknown[]) => {
    sequence += 1;
    source.onmessage?.({ data: JSON.stringify({
      source: "evejs-web-gateway", apiVersion: 1, type: "event", cursor: { epoch: "epoch-1", sequence },
      event: { kind: "notification", notification: { kind: "client", service: null, method, args, kwargs: null } },
    }) });
    await new Promise((resolve) => setTimeout(resolve, 25));
  };
  const shown = () => store.flight.get().crimewatch;
  return { store, flow, state, push, shown, reads: () => reads, sets, routeSets: () => routeSets, grade: () => store.station.get().cloneGrade, gradeReads: () => gradeReads, asked };
}

test("a pilot that comes online has crimewatch's states read, with the server's clock beside them", async () => {
  const { shown, reads, asked } = await online();
  assert.equal(reads(), 1);
  // Both reads of the choosing are the client's own calls, each with nothing, asked as a pilot's.
  assert.deepEqual(asked.map((body) => [body.service, body.method, body.args, body.kwargs, body.pilot]).sort(), [["crimewatch", "GetClientStates", [], null, true], ["subscriptionMgr", "GetCloneGrade", [], null, true]]);
  const reading = shown();
  assert.ok(reading !== null);
  assert.deepEqual([reading.states.safetyLevel, reading.states.timers.map((timer) => timer.state)], [2, [100, 200, 400, 300, 500]]);
  // The server's clock was five seconds ahead of the browser's at the read.
  assert.ok(reading.clockOffsetMs > 4900 && reading.clockOffsetMs <= 5000, String(reading.clockOffsetMs));
});

test("the states are read again at each of the server's notices of a timer, a flag or an engagement", async () => {
  const { state, push, shown, reads } = await online();
  let expected = 1;
  for (const notice of ["OnWeaponsTimerUpdate", "OnPvpTimerUpdate", "OnNpcTimerUpdate", "OnCriminalTimerUpdate", "OnDisapprovalTimerUpdate", "OnSystemCriminalFlagUpdates",
    "OnSystemDisapprovalFlagUpdates", "OnCrimewatchEngagementCreated", "OnCrimewatchEngagementEnded", "OnCrimewatchEngagementStartTimeout", "OnCrimewatchEngagementStopTimeout"]) {
    await push(notice, [102, { type: "long", value: "134360746443100000" }]);
    expected += 1;
    assert.equal(reads(), expected, notice);
  }
  // What the read answers then is what is shown.
  state.answer = { ok: true, serverNowMs: Date.now(), clientStates: statesWith(1) };
  await push("OnWeaponsTimerUpdate", [100, null]);
  assert.equal(shown()?.states.safetyLevel, 1);
  // Another notice reads nothing.
  await push("OnSecurityStatusUpdate", [1.5]);
  await push("OnItemsChanged", [1, 2]);
  await push("OnCharNowInStation", [[140000003, 98000000, null, null]]);
  assert.equal(reads(), expected + 1);
});

test("the states are read again at a change of place, of system or of ship, and at no other change of the session", async () => {
  const { push, reads } = await online();
  await push("OnSessionChanged", [{ stationid: [60003760, null], locationid: [60003760, 30000142], solarsystemid: [null, 30000142] }]);
  assert.equal(reads(), 2);
  await push("OnSessionChanged", [{ shipid: [1, 2] }]);
  assert.equal(reads(), 3);
  await push("OnSessionChanged", [{ solarsystemid: [30000142, 30000144] }]);
  assert.equal(reads(), 4);
  // A dict as the wire spells one.
  await push("OnSessionChanged", [{ type: "dict", entries: [["locationid", [30000144, 60003760]]] }]);
  assert.equal(reads(), 5);
  await push("OnSessionChanged", [{ corpid: [1000044, 98000000], corprole: [0, 1] }]);
  await push("OnSessionChanged", [{}]);
  assert.equal(reads(), 5);
});

test("a read that fails, or that says no states, leaves what was shown", async () => {
  const { state, push, shown, reads } = await online();
  const first = shown();
  state.fail = true;
  await push("OnWeaponsTimerUpdate", [100, null]);
  assert.deepEqual([shown(), reads()], [first, 2]);
  state.fail = false;
  for (const answer of [{}, { serverNowMs: Date.now() + 5000, clientStates: null }, { serverNowMs: Date.now() + 5000, clientStates: "none" }, { serverNowMs: Date.now() + 5000, clientStates: { type: "list", items: statesWith(0) } }]) {
    state.answer = answer;
    await push("OnWeaponsTimerUpdate", [100, null]);
    assert.deepEqual(shown(), first, JSON.stringify(answer).slice(0, 60));
  }
});

test("states that come with no clock said are shown all the same, counted against the clock the page last had", async () => {
  const { state, push, shown } = await online();
  // The first read said the server was five seconds ahead. One that says nothing of the time, or what is no time:
  for (const answer of [{ clientStates: statesWith(0) }, { serverNowMs: "now", clientStates: statesWith(1) }]) {
    state.answer = answer;
    await push("OnWeaponsTimerUpdate", [100, null]);
    const reading = shown();
    assert.ok(reading !== null);
    assert.equal(reading.states.safetyLevel, (answer.clientStates as unknown[])[3]);
    assert.ok(reading.clockOffsetMs > 4800 && reading.clockOffsetMs <= 5000, String(reading.clockOffsetMs));
  }
  // And one that says the clocks agree now is counted against that.
  state.answer = { serverNowMs: Date.now(), clientStates: statesWith(2) };
  await push("OnWeaponsTimerUpdate", [100, null]);
  assert.ok(Math.abs(shown()?.clockOffsetMs ?? 9999) < 200, String(shown()?.clockOffsetMs));
});

test("a read that answers after the pilot has gone offline is not shown", async () => {
  const { store, state, push, shown, reads } = await online();
  let release: () => void = () => {};
  state.hold = new Promise<void>((resolve) => { release = resolve; });
  state.answer = { ok: true, serverNowMs: Date.now(), clientStates: statesWith(0) };
  await push("OnWeaponsTimerUpdate", [100, null]);
  assert.equal(reads(), 2);
  store.apply({ type: "character/offline" } as never);
  assert.equal(shown(), null);
  release();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(shown(), null);
});

// ── the safety level set ─────────────────────────────────────────────────────
//
// crimewatchSvc.SetSafetyLevel (343 to 345): the client sets the level at the server, then has it as the level and
// tells its button so. It asks crimewatch nothing after. A refusal is raised before the line that keeps it.

test("a safety level set from the page is sent once, and is the level shown from then on with crimewatch not read again", async () => {
  const { flow, shown, reads, sets, routeSets } = await online();
  const before = shown();
  await flow.setSafetyLevel(1);
  // crimewatchSvc.SetSafetyLevel (343): the service's own call with the level, as a pilot's and as a write the page means.
  assert.deepEqual([sets, reads(), shown()?.states.safetyLevel], [[{ service: "crimewatch", method: "SetSafetyLevel", args: [1], kwargs: null, pilot: true, confirm: true }], 1, 1]);
  // Nothing else of what was read is changed.
  assert.deepEqual([shown()?.states.timers, shown()?.clockOffsetMs], [before?.states.timers, before?.clockOffsetMs]);
  await flow.setSafetyLevel(0);
  await flow.setSafetyLevel(2);
  assert.deepEqual([sets.map((sent) => (sent.args as unknown[])[0]), reads(), shown()?.states.safetyLevel], [[1, 0, 2], 1, 2]);
  // The route it was set by is not asked.
  assert.equal(routeSets(), 0);
});

test("a level the server refused is thrown to who set it, and the level shown is left as it was", async () => {
  const { flow, state, shown, reads, sets } = await online();
  state.setFails = true;
  await assert.rejects(flow.setSafetyLevel(0), /changing place/);
  assert.deepEqual([sets.length, reads(), shown()?.states.safetyLevel], [1, 1, 2]);
  // The next one, taken, is shown.
  state.setFails = false;
  await flow.setSafetyLevel(0);
  assert.deepEqual([sets.length, shown()?.states.safetyLevel], [2, 0]);
});

test("a level set before crimewatch was ever read has nothing to go into, and one answered after another pilot came online is thrown away", async () => {
  const unread = await online({ fail: true });
  assert.equal(unread.shown(), null);
  await unread.flow.setSafetyLevel(1);
  assert.deepEqual([unread.sets.length, unread.shown()], [1, null]);
  // The set is on its way; the pilot goes, and another comes online on this page and has its own states read.
  const { store, flow, state, shown } = await online();
  let release: () => void = () => {};
  state.setHold = new Promise<void>((resolve) => { release = resolve; });
  const setting = flow.setSafetyLevel(0);
  await new Promise((resolve) => setTimeout(resolve, 25));
  store.apply({ type: "character/offline" } as never);
  await flow.selectCharacter(PILOT + 1);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(shown()?.states.safetyLevel, 2);
  release();
  // The flow throws every answer that comes for a pilot who has gone; the pilot now online keeps its own level.
  await assert.rejects(setting, /retired pilot session/);
  assert.equal(shown()?.states.safetyLevel, 2);
});

// ── the clone's grade ────────────────────────────────────────────────────────
//
// clone_grade_svc: asked as the account logs in and kept (125); OnSubscriptionChangedServer(new_state) is the grade
// from then on (243), with nothing asked. The BFF's transport asks at the pilot's login; the page reads it once.

test("a pilot that comes online has its clone grade read once, and the server's notice is the grade from then on", async () => {
  const alpha = await online({ grade: { result: 0 } });
  assert.deepEqual([alpha.grade(), alpha.gradeReads()], [0, 1]);
  await alpha.push("OnSubscriptionChangedServer", [1]);
  assert.deepEqual([alpha.grade(), alpha.gradeReads()], [1, 1]);
  await alpha.push("OnSubscriptionChangedServer", [0]);
  assert.deepEqual([alpha.grade(), alpha.gradeReads()], [0, 1]);
  // A notice that says neither grade leaves what was had; another notice, and a change of the session, read nothing.
  for (const args of [[], [2], ["1"], [null], [{ type: "long", value: "1" }]]) await alpha.push("OnSubscriptionChangedServer", args);
  await alpha.push("OnWeaponsTimerUpdate", [100, null]);
  await alpha.push("OnSessionChanged", [{ shipid: [1, 2] }]);
  assert.deepEqual([alpha.grade(), alpha.gradeReads()], [0, 1]);
  // The crimewatch reads are their own, and the notice of the grade set none going.
  assert.equal(alpha.reads(), 3);
  // Gone offline: no grade is shown for nobody.
  alpha.store.apply({ type: "character/offline" } as never);
  assert.equal(alpha.grade(), null);
});

test("a pilot whose connection carries no clone grade, or whose read fails, has none; and the notice still says one", async () => {
  // The web gateway's pilot: its transport does not carry the call, and the page is told so.
  const gateway = await online({ grade: "not carried" });
  assert.deepEqual([gateway.grade(), gateway.gradeReads()], [null, 1]);
  // A read that fails leaves none, and the pilot is online all the same.
  const failed = await online({ grade: "fails" });
  assert.deepEqual([failed.grade(), failed.gradeReads(), failed.store.station.get().online?.characterID], [null, 1, PILOT]);
  await failed.push("OnSubscriptionChangedServer", [0]);
  assert.equal(failed.grade(), 0);
  // An answer that says neither grade is none.
  for (const cloneGrade of [2, "0", true, null]) assert.equal((await online({ grade: { result: cloneGrade } })).grade(), null, String(cloneGrade));
});
