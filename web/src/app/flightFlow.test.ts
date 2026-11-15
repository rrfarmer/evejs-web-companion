// The R5a Flight controller against a faked BFF: undock/warp/jump/dock issue
// their BFF step and refresh the flight snapshot in the store; a movement
// refusal is surfaced as a visible reason (never a silent no-op) with the true
// state re-read; a lost session unwinds to offline.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import * as api from "./api.ts";
import { undock as undockCall } from "../bridge/placeChanges.ts";
import { createClientStore } from "../store/clientStore.ts";

interface Recorded {
  readonly path: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}

function makeFakeFetch(
  responder: (path: string, method: string, body: Record<string, unknown>) => { status: number; body: unknown },
): { fetch: typeof fetch; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const fakeFetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const path = String(input);
    const method = (init && init.method) || "GET";
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
    requests.push({ path, method, body });
    const outcome = responder(path, method, body);
    return {
      ok: outcome.status >= 200 && outcome.status < 300,
      status: outcome.status,
      async json() {
        return outcome.body;
      },
    };
  }) as unknown as typeof fetch;
  return { fetch: fakeFetch, requests };
}

async function waitFor(cond: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries && !cond(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const DOCKED = { inSpace: false, docked: true, solarSystemID: 30000142, stationID: 60003760, structureID: null, shipID: 9001, shipMode: null, shipSpeedFraction: null };
const IN_SPACE = { inSpace: true, docked: false, solarSystemID: 30000142, stationID: null, structureID: null, shipID: 9001, shipMode: "WARP", shipSpeedFraction: 1 };
const JUMPED = { ...IN_SPACE, solarSystemID: 30000140, shipMode: "STOP", shipSpeedFraction: 0 };

test("loadFlightStatus reads the current status into the store", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch((path) => {
    if (path === "/api/bridge/flight/status") {
      return { status: 200, body: { ok: true, flight: DOCKED, notifications: [] } };
    }
    throw new Error(`unexpected ${path}`);
  });
  const flow = createAppFlow(store, { fetch });

  await flow.loadFlightStatus();

  const flight = store.flight.get();
  assert.equal(flight.loaded, true);
  assert.equal(flight.status?.docked, true);
  assert.equal(flight.status?.stationID, 60003760);
});

/** What the page asked by the generic call, in order. */
const calls = (requests: Recorded[]) => requests.filter((request) => request.path === "/api/bridge/call").map((request) => request.body);

test("a definite Academy undock refusal shows the notice even without a live stream", async () => {
  const store = createClientStore();
  const { fetch, requests } = makeFakeFetch((path) => {
    if (path === "/api/bridge/flight/status") {
      return { status: 200, body: { ok: true, flight: DOCKED, notifications: [] } };
    }
    if (path === "/api/bridge/call") {
      return { status: 409, body: { ok: false, error: "ACADEMY_SHIP_UNDOCK_DECLINED", message: "The Academy ship undock was declined." } };
    }
    throw new Error(`unexpected ${path}`);
  });
  const flow = createAppFlow(store, { fetch });
  await flow.loadFlightStatus();
  await flow.undock();
  assert.equal(calls(requests).length, 1);
  assert.equal(store.flight.get().status?.docked, true);
  assert.equal(store.flight.get().actionError, null);
  assert.deepEqual(flow.dialogsSaid.get().map((dialog) => dialog.dialog), ["AcademyShipCannotUndockOutsideExordium"]);
});

test("a warp with no range said is the autopilot's own call and one with a range the menu's, each made by the page; the step is recorded", async () => {
  const store = createClientStore();
  const { fetch, requests } = makeFakeFetch((path, _method, body) => {
    if (path === "/api/bridge/flight/status") {
      return { status: 200, body: { ok: true, flight: IN_SPACE, notifications: [] } };
    }
    if (path === "/api/bridge/call") {
      return { status: 200, body: { ok: true, service: body.service, method: body.method, result: null, notifications: [] } };
    }
    throw new Error(`unexpected ${path}`);
  });
  const flow = createAppFlow(store, { fetch });

  await flow.warpTo(50001248);

  // autopilot.py 465: GetRemotePark().CmdWarpToStuffAutopilot(destinationID), as a pilot's write the page means.
  assert.deepEqual(calls(requests), [{ service: "beyonce", method: "CmdWarpToStuffAutopilot", args: [50001248], kwargs: null, pilot: true, confirm: true }]);
  assert.equal(store.flight.get().lastAction, "Warp");
  assert.equal(store.flight.get().actionError, null);
  // The pilot's flight was read before the order and after it: the step's answer is the flight read after.
  assert.deepEqual(requests.map((request) => request.path).filter((path) => path.startsWith("/api/bridge/")), ["/api/bridge/flight/status", "/api/bridge/call", "/api/bridge/flight/status"]);

  // movementFunctions.py 452: CmdWarpToStuff('item', itemID, minRange=warpRange), with the range that was said.
  await flow.warpTo(50001248, 10000);
  assert.deepEqual(calls(requests).at(-1), { service: "beyonce", method: "CmdWarpToStuff", args: ["item", 50001248], kwargs: { minRange: 10000 }, pilot: true, confirm: true });
  // Neither went by the route they went by until 2026-10-11.
  assert.equal(requests.some((request) => request.path === "/api/bridge/flight/warp"), false);
});

test("jump is the client's CmdStargateJump with both gates and the pilot's ship; a follow-up status shows the new system", async () => {
  const store = createClientStore();
  let jumped = false;
  const { fetch, requests } = makeFakeFetch((path, _method, body) => {
    if (path === "/api/bridge/flight/status") {
      return { status: 200, body: { ok: true, flight: jumped ? JUMPED : { ...IN_SPACE, shipMode: "STOP", shipSpeedFraction: 0 }, notifications: [] } };
    }
    if (path === "/api/bridge/call" && body.method === "CmdStargateJump") {
      jumped = true;
      return { status: 200, body: { ok: true, service: "beyonce", method: "CmdStargateJump", result: null, notifications: [] } };
    }
    throw new Error(`unexpected ${path}`);
  });
  const flow = createAppFlow(store, { fetch });

  await flow.jump(50001248, 50000802);

  // gateJumpSvc.py 124: CmdStargateJump(stargateID, beaconID, session.shipid).
  const jump = requests.find((request) => request.path === "/api/bridge/call")?.body;
  assert.deepEqual(jump, { service: "beyonce", method: "CmdStargateJump", args: [50001248, 50000802, 9001], kwargs: null, pilot: true, confirm: true });
  const flight = store.flight.get();
  assert.equal(flight.status?.solarSystemID, 30000140);
  assert.equal(flight.lastAction, "Jump");
});

test("dock returns the character to a station, by the client's CmdDock with the pilot's ship", async () => {
  const store = createClientStore();
  let docked = false;
  const { fetch, requests } = makeFakeFetch((path, _method, body) => {
    if (path === "/api/bridge/flight/status") {
      return { status: 200, body: { ok: true, flight: docked ? DOCKED : { ...IN_SPACE, shipMode: "STOP", shipSpeedFraction: 0 }, notifications: [] } };
    }
    if (path === "/api/bridge/call" && body.method === "CmdDock") {
      docked = true;
      return { status: 200, body: { ok: true, service: "beyonce", method: "CmdDock", result: null, notifications: [] } };
    }
    throw new Error(`unexpected ${path}`);
  });
  const flow = createAppFlow(store, { fetch });

  await flow.dock(60003760);

  // movementFunctions.RealDock (517): PerformSessionChange('dock', bp.CmdDock, itemID, session.shipid).
  const dock = requests.find((request) => request.path === "/api/bridge/call")?.body;
  assert.deepEqual(dock, { service: "beyonce", method: "CmdDock", args: [60003760, 9001], kwargs: null, pilot: true, confirm: true });
  assert.equal(store.flight.get().status?.docked, true);
  assert.equal(store.flight.get().lastAction, "Dock");
});

test("a movement refusal is surfaced as a visible reason and the true state re-read", async () => {
  const store = createClientStore();
  const { fetch, requests } = makeFakeFetch((path) => {
    if (path === "/api/bridge/call") {
      // The handler's own refusal (e.g. warp scrambled) passes through as a
      // CALL_REFUSED with the handler text.
      return { status: 409, body: { ok: false, error: "CALL_REFUSED", message: "You are warp scrambled." } };
    }
    if (path === "/api/bridge/flight/status") {
      return { status: 200, body: { ok: true, flight: IN_SPACE, notifications: [] } };
    }
    throw new Error(`unexpected ${path}`);
  });
  const flow = createAppFlow(store, { fetch });

  await flow.warpTo(50001248);

  const flight = store.flight.get();
  assert.match(flight.actionError ?? "", /Warp refused/);
  assert.match(flight.actionError ?? "", /warp scrambled/i);
  // The true state was re-read after the refusal (never a fake success).
  assert.equal(flight.status?.inSpace, true);
  assert.ok(requests.some((r) => r.path === "/api/bridge/flight/status"));
});

test("R31 — the out-of-range jump reads as a sentence, all the way to the store", async () => {
  // ⚠ THIS IS THE EXACT PAYLOAD THE RUNNING EMULATOR RETURNS. Captured live:
  // POST /api/bridge/flight/jump (the route, gone since 2026-10-14; the page's own call by the generic call is
  // answered with the same refusal) with the ship sitting at the station answers
  // 409 with this body, and before R31 the player was shown
  // "Jump refused: CALL_REFUSED: 101,UI/Menusvc/MenuHints/NotWithingMaxJumpDist"
  // — a client resource key, a numeric localization marker, and CCP's own
  // "Withing" typo, in the one place a player is most likely to look.
  const store = createClientStore();
  const { fetch, requests } = makeFakeFetch((path, _method, body) => {
    if (path === "/api/bridge/call" && body.method === "CmdStargateJump") {
      return {
        status: 409,
        body: {
          ok: false,
          error: "CALL_REFUSED",
          message: "101,UI/Menusvc/MenuHints/NotWithingMaxJumpDist",
        },
      };
    }
    if (path === "/api/bridge/flight/status") {
      return { status: 200, body: { ok: true, flight: IN_SPACE, notifications: [] } };
    }
    throw new Error(`unexpected ${path}`);
  });
  const flow = createAppFlow(store, { fetch });

  await flow.jump(50002185, 50001249);

  const message = store.flight.get().actionError ?? "";
  assert.equal(
    message,
    "Jump refused: That gate is too far away to jump through. Get closer to it first.",
  );
  // R9a, at the only place it actually matters — what reached the store.
  assert.ok(!message.includes("UI/"), "a resource path reached the player");
  assert.ok(!message.includes("101,"), "a localization marker reached the player");
  assert.ok(!message.includes("CALL_REFUSED"), "a wire code reached the player");
  assert.ok(!/[a-z][A-Z]/.test(message), "an identifier reached the player");
  // ⚠ THE REFUSAL IS NOT SWALLOWED. R31 changes the wording, never the fact:
  // the player is still told the jump did not happen, and the true state is
  // still re-read rather than optimistically assumed.
  assert.match(message, /refused/);
  assert.ok(requests.some((r) => r.path === "/api/bridge/flight/status"));
});

test("the flight status resolves system + station NAMES, cached across polls (R7a)", async () => {
  const store = createClientStore();
  const { fetch, requests } = makeFakeFetch((path) => {
    if (path === "/api/bridge/flight/status") {
      return { status: 200, body: { ok: true, flight: DOCKED, notifications: [] } };
    }
    if (path === "/api/map/resolve/30000142") {
      return { status: 200, body: { ok: true, id: 30000142, kind: "system", solarSystemID: 30000142, systemName: "Jita" } };
    }
    if (path === "/api/map/resolve/60003760") {
      return { status: 200, body: { ok: true, id: 60003760, kind: "station", stationID: 60003760, stationName: "Jita IV - Moon 4 - Caldari Navy Assembly Plant", solarSystemID: 30000142, systemName: "Jita" } };
    }
    throw new Error(`unexpected ${path}`);
  });
  const flow = createAppFlow(store, { fetch });

  await flow.loadFlightStatus();
  await waitFor(() => store.flight.get().solarSystemName !== null && store.flight.get().stationName !== null);

  const flight = store.flight.get();
  assert.equal(flight.solarSystemName, "Jita");
  assert.equal(flight.stationName, "Jita IV - Moon 4 - Caldari Navy Assembly Plant");

  // A second poll of the same location does NOT refetch the names (cached).
  const resolveBefore = requests.filter((r) => r.path.startsWith("/api/map/resolve/")).length;
  assert.equal(resolveBefore, 2);
  await flow.loadFlightStatus();
  await waitFor(() => true);
  const resolveAfter = requests.filter((r) => r.path.startsWith("/api/map/resolve/")).length;
  assert.equal(resolveAfter, resolveBefore, "names are cached; the second poll issues no resolve calls");
});

test("a lost session during a movement step unwinds to offline", async () => {
  const store = createClientStore();
  store.apply({
    type: "character/online",
    character: { characterID: 140000003, characterName: "Test", stationID: 60003760, structureID: null, solarSystemID: 30000142, corporationID: 98000000 },
    station: null,
  });
  const { fetch } = makeFakeFetch(() => ({
    status: 404,
    body: { ok: false, error: "SESSION_NOT_FOUND", message: "Bridge session gone." },
  }));
  const flow = createAppFlow(store, { fetch });

  await assert.rejects(
    () => flow.undock(),
    (error: unknown) => (error as { code?: string }).code === "SESSION_NOT_FOUND",
  );
  // The station slice was cleared (character/offline), unwinding to select.
  assert.equal(store.station.get().online, null);
});

// ── undocking with contraband aboard ─────────────────────────────────────────
//
// The retail client's _DoUndockAttempt (ui/station/base.py 488): refused with
// ShipContrabandWarningUndock, it asks OK / Cancel and undocks again with
// ignoreContraband set. The BFF answers that refusal as CONTRABAND_WARNING.

const WARNING = { ok: false, error: "CONTRABAND_WARNING", message: "A made-up warning about Slaves. Undock anyway?" };
/** The generic call's answer to an undock, which the BFF gives once the ship is in space. */
const UNDOCKED = { status: 200, body: { ok: true, service: "ship", method: "Undock", result: null, notifications: [] } };

/**
 * The pilot docked until an undock is answered, and in space after: the flight read before and after the page's
 * call, and the undock answered as `answer` has it for the flag the call names.
 */
function undockingFetch(answer: (ignoringContraband: boolean) => { status: number; body: unknown }) {
  let undocked = false;
  return makeFakeFetch((path, _method, body) => {
    if (path === "/api/bridge/flight/status") {
      return { status: 200, body: { ok: true, flight: undocked ? IN_SPACE : DOCKED, notifications: [] } };
    }
    if (path === "/api/bridge/call" && body.method === "Undock") {
      const answered = answer((body.args as unknown[])[1] === true);
      if (answered.status === 200) undocked = true;
      return answered;
    }
    // Arriving in space, the page looks up where it is; that is not what is being tested.
    return { status: 200, body: { ok: true } };
  });
}
function contrabandFetch() {
  return undockingFetch((ignoring) => (ignoring ? UNDOCKED : { status: 409, body: WARNING }));
}
/** The flag each of the page's undocks named, in order. */
const undocks = (requests: Recorded[]) => calls(requests).filter((body) => body.method === "Undock").map((body) => (body.args as unknown[])[1]);

test("undock is the client's ship.Undock, the pilot's ship named, and the in-space flight read after", async () => {
  const store = createClientStore();
  const { fetch, requests } = undockingFetch(() => UNDOCKED);
  const flow = createAppFlow(store, { fetch });

  await flow.undock();

  // ui/station/base.py 498: PerformSessionChange('undock', shipsvc.Undock, shipID, ignoreContraband, onlineModules=...)
  // (the online modules the game port names; the page sends none: bridge/placeChanges.ts).
  const undock = calls(requests).find((body) => body.method === "Undock");
  assert.deepEqual(undock, { service: "ship", method: "Undock", args: [9001, false], kwargs: { onlineModules: [] }, pilot: true, confirm: true });
  const flight = store.flight.get();
  assert.equal(flight.status?.inSpace, true);
  assert.equal(flight.lastAction, "Undock");
  assert.equal(flight.actionError, null);
});

test("an undock sends the warning armed, and one that is not warned about asks nothing", async () => {
  const store = createClientStore();
  const asked: string[] = [];
  const { fetch, requests } = undockingFetch(() => UNDOCKED);
  const flow = createAppFlow(store, { fetch, confirm: (message) => { asked.push(message); return true; } });
  await flow.undock();
  assert.deepEqual(undocks(requests), [false]);
  assert.deepEqual(asked, []);
  assert.equal(store.flight.get().lastAction, "Undock");
});

test("warned about contraband, the user is asked, and OK undocks again ignoring it", async () => {
  const store = createClientStore();
  const asked: string[] = [];
  const { fetch, requests } = contrabandFetch();
  const flow = createAppFlow(store, { fetch, confirm: async (message) => { asked.push(message); return true; } });
  await flow.undock();
  // Asked in the dialog's own words, which end in the question.
  assert.deepEqual(asked, [WARNING.message]);
  assert.deepEqual(undocks(requests), [false, true]);
  const flight = store.flight.get();
  assert.equal(flight.status?.inSpace, true);
  assert.equal(flight.lastAction, "Undock");
  assert.equal(flight.actionError, null);
});

test("Cancel leaves the ship docked, sends nothing more, and reports no failure", async () => {
  for (const confirm of [() => false, async () => false, undefined]) {
    const store = createClientStore();
    const { fetch, requests } = contrabandFetch();
    // With no way to ask (no browser), nobody is asked and the answer is Cancel.
    const flow = createAppFlow(store, confirm ? { fetch, confirm } : { fetch });
    await flow.undock();
    // The flight read and the one undock: nothing is re-read and nothing else is sent.
    assert.deepEqual(requests.map((request) => request.path), ["/api/bridge/flight/status", "/api/bridge/call"]);
    assert.deepEqual(undocks(requests), [false]);
    const flight = store.flight.get();
    assert.equal(flight.actionError, null);
    assert.notEqual(flight.lastAction, "Undock");
    assert.notEqual(flight.status?.inSpace, true);
  }
});

test("any other refusal of an undock is reported as before, and nobody is asked", async () => {
  const store = createClientStore();
  const asked: string[] = [];
  const { fetch, requests } = undockingFetch(() => ({ status: 409, body: { ok: false, error: "CALL_REFUSED", message: "ShipNotInHangar" } }));
  const flow = createAppFlow(store, { fetch, confirm: (message) => { asked.push(message); return true; } });
  await flow.undock();
  assert.deepEqual(asked, []);
  assert.equal(undocks(requests).length, 1);
  assert.match(store.flight.get().actionError ?? "", /^Undock refused: /);
});

test("the page's own automation undocks ignoring the warning, as the client does once it is suppressed", async () => {
  const { fetch, requests } = contrabandFetch();
  const act = api.bridgeDo({ fetch });
  const docked = async () => ({ inSpace: false, shipID: 9001, solarSystemID: 30000142 });
  await undockCall(act, docked, true);
  assert.deepEqual(undocks(requests), [true]);
  // And the warning is told from any other refusal by its code.
  await assert.rejects(undockCall(act, docked, false), (error) => api.isContrabandWarning(error));
  assert.equal(api.isContrabandWarning(new Error("CONTRABAND_WARNING")), false);
});
