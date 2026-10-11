import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import type { EventSourceLike } from "./api.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const READ_NAMES = [
  "GetInitState",
  "GetWings",
  "GetMotd",
  "GetJoinRequests",
  "GetFleetComposition",
] as const;

function noFleet() {
  return {
    ok: true,
    characterID: 140000005,
    fleetID: null,
    reads: Object.fromEntries(
      READ_NAMES.map((name) => [name, { error: "CALL_REFUSED", message: "FleetNotFound" }]),
    ),
  };
}

function keyVal(entries: readonly (readonly [string, unknown])[]) {
  return { type: "object", name: "util.KeyVal", args: { type: "dict", entries } };
}

function populatedFleet() {
  const emptyDict = { type: "dict", entries: [] };
  return {
    ok: true,
    characterID: 140000005,
    fleetID: null,
    reads: {
      GetInitState: {
        result: keyVal([
          ["motd", "Ready up."],
          ["fleetID", 654500010000],
          ["members", emptyDict],
          ["squads", emptyDict],
          ["wings", emptyDict],
        ]),
      },
      GetWings: { result: emptyDict },
      GetMotd: { result: "Ready up." },
      GetJoinRequests: { result: emptyDict },
      GetFleetComposition: { result: { type: "list", items: [] } },
    },
  };
}

const FLEET_SNAPSHOT_INVALIDATIONS = [
  "OnFleetJoin",
  "OnFleetLeave",
  "OnFleetDisbanded",
  "OnFleetMemberChanged",
  "OnFleetMove",
  "OnFleetWingAdded",
  "OnFleetWingDeleted",
  "OnFleetWingNameChanged",
  "OnFleetSquadAdded",
  "OnFleetSquadDeleted",
  "OnFleetSquadNameChanged",
  "OnFleetMotdChanged",
  "OnFleetOptionsChanged",
  "OnFleetJoinRequest",
  "OnFleetJoinRejected",
] as const;

interface FakeSource extends EventSourceLike {
  emit(frame: unknown): void;
}

function makeFakeEventSource(): {
  factory: (url: string) => EventSourceLike;
  sources: FakeSource[];
} {
  const sources: FakeSource[] = [];
  const factory = (): EventSourceLike => {
    const source: FakeSource = {
      onmessage: null,
      onopen: null,
      onerror: null,
      emit(frame: unknown) {
        source.onmessage?.({ data: JSON.stringify(frame) });
      },
      close() {},
    };
    sources.push(source);
    return source;
  };
  return { factory, sources };
}

function notificationFrame(method: string, sequence: number, args: readonly unknown[] = []) {
  return {
    source: "evejs-web-gateway",
    apiVersion: 1,
    type: "event",
    cursor: { epoch: "fleet-epoch", sequence },
    event: {
      kind: "notification",
      notification: { kind: "client", service: null, method, args, kwargs: null },
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

async function onlineFleetFlow(
  fleetRead: (readNumber: number) => Promise<Response> | Response = () => json(populatedFleet()),
) {
  const store = createClientStore();
  const { factory, sources } = makeFakeEventSource();
  const state = { fleetReads: 0, activeFleetReads: 0, peakFleetReads: 0 };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "/api/bridge/select") {
      return json({
        ok: true,
        character: {
          characterID: 140000005,
          characterName: "Fleet Pilot",
          stationID: 60003760,
          structureID: null,
          solarSystemID: 30000142,
          corporationID: 98000001,
        },
        station: null,
        notifications: [],
      });
    }
    if (url === "/api/bridge/bound-fleet") {
      state.fleetReads += 1;
      state.activeFleetReads += 1;
      state.peakFleetReads = Math.max(state.peakFleetReads, state.activeFleetReads);
      try {
        return await fleetRead(state.fleetReads);
      } finally {
        state.activeFleetReads -= 1;
      }
    }
    if (url === "/api/bridge/call") {
      const request = JSON.parse(String(init?.body)) as { service: string; method: string };
      return json({
        ok: true,
        service: request.service,
        method: request.method,
        result: null,
        notifications: [],
      });
    }
    if (url === "/api/names") {
      return json({ ok: true, names: {} });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const flow = createAppFlow(store, { fetch, eventSource: factory });
  await flow.selectCharacter(140000005);
  const source = sources[0];
  assert.ok(source, "selecting a character must open the live Fleet event source");
  return { store, source, state };
}

test("loadFleet preserves the verified FleetNotFound state", async () => {
  const store = createClientStore();
  const flow = createAppFlow(store, { fetch: async () => json(noFleet()) });
  await flow.loadFleet();
  assert.equal(store.get().fleet.availability, "not-in-fleet");
  assert.equal(store.get().fleet.readError, null);
});

test("formFleet confirms through a follow-up bound-fleet read", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (url.endsWith("/api/bridge/fleet/create")) {
      return json({ ok: true, applied: true });
    }
    if (url.endsWith("/api/bridge/bound-fleet")) return json(populatedFleet());
    throw new Error(`unexpected fetch ${url}`);
  };
  const store = createClientStore();
  await createAppFlow(store, { fetch }).formFleet();

  assert.deepEqual(calls.map((call) => call.url), [
    "/api/bridge/fleet/create",
    "/api/bridge/bound-fleet",
  ]);
  assert.deepEqual(calls[0]!.body, { confirm: true });
  assert.equal(store.get().fleet.availability, "ready");
  assert.equal(store.get().fleet.actionError, null);
});

test("acceptFleetInvite uses the fleetID from OnFleetInvite and re-reads", async () => {
  let acceptedBody: Record<string, unknown> | null = null;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/bridge/fleet/invite/accept")) {
      acceptedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({ ok: true, applied: true });
    }
    if (url.endsWith("/api/bridge/bound-fleet")) return json(populatedFleet());
    throw new Error(`unexpected fetch ${url}`);
  };
  const store = createClientStore();
  store.apply({
    type: "fleet/pending-invite",
    invite: { fleetID: 654500010000, inviterID: 140000002, receivedAtMs: 100 },
  });
  await createAppFlow(store, { fetch }).acceptFleetInvite();

  assert.deepEqual(acceptedBody, { fleetID: 654500010000, confirm: true });
  assert.equal(store.get().fleet.availability, "ready");
  assert.equal(store.get().fleet.pendingInvite, null);
});

test("leaveFleet makes the page's own call on the fleet's object, does not trust its answer, and lands the no-fleet reread", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, body: typeof init.body === "string" ? JSON.parse(init.body) : null });
    if (url.endsWith("/api/bridge/call")) return json({ ok: true, service: "fleetObjectHandler", method: "LeaveFleet", result: true, notifications: [] });
    if (url.endsWith("/api/bridge/bound-fleet")) return json(noFleet());
    throw new Error(`unexpected fetch ${url}`);
  };
  const store = createClientStore();
  await createAppFlow(store, { fetch }).leaveFleet();
  // fleetSvc.LeaveFleet (369): self.fleet.LeaveFleet(), as a pilot's write the page means. And nothing of the route.
  assert.deepEqual(calls, [
    { url: "/api/bridge/call", body: { service: "fleetObjectHandler", method: "LeaveFleet", args: [], kwargs: null, pilot: true, confirm: true } },
    { url: "/api/bridge/bound-fleet", body: null },
  ]);
  assert.equal(store.get().fleet.availability, "not-in-fleet");
  assert.equal(store.get().fleet.actionError, null);
});

test("a leaving the server refuses is said, in the page's words for that refusal, and the fleet is read again all the same", async () => {
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/api/bridge/call")) return json({ ok: false, error: "CALL_REFUSED", message: "FleetNotInFleet" }, 409);
    if (url.endsWith("/api/bridge/bound-fleet")) return json(noFleet());
    throw new Error(`unexpected fetch ${url}`);
  };
  const store = createClientStore();
  await createAppFlow(store, { fetch }).leaveFleet();
  assert.deepEqual(calls, ["/api/bridge/call", "/api/bridge/bound-fleet"]);
  assert.equal(store.get().fleet.actionError, "The fleet action was refused. You are not in that fleet.");
});

test("every Fleet snapshot invalidation notification triggers an authoritative reread", async () => {
  const { store, source, state } = await onlineFleetFlow();

  for (const [index, method] of FLEET_SNAPSHOT_INVALIDATIONS.entries()) {
    source.emit(notificationFrame(method, index + 1));
    const expectedReads = index + 1;
    await waitFor(
      () =>
        state.fleetReads === expectedReads &&
        store.get().fleet.loaded &&
        !store.get().fleet.loading,
      `${method} did not finish its Fleet snapshot reread`,
    );
    // Let drainFleetRefreshes clear its worker before issuing the next distinct
    // event. This test checks each name independently; burst behavior is below.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  source.emit(notificationFrame("OnFleetInviteExpired", 100));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    state.fleetReads,
    FLEET_SNAPSHOT_INVALIDATIONS.length,
    "an unrecognized Fleet-like event must not invent a roster invalidation",
  );
});

test("a same-turn burst of Fleet invalidations coalesces into one reread", async () => {
  const { store, source, state } = await onlineFleetFlow();

  source.emit(notificationFrame("OnFleetMemberChanged", 1));
  source.emit(notificationFrame("OnFleetMove", 2));
  source.emit(notificationFrame("OnFleetMotdChanged", 3));

  await waitFor(
    () => state.fleetReads === 1 && store.get().fleet.loaded && !store.get().fleet.loading,
    "the coalesced Fleet reread did not finish",
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(state.fleetReads, 1);
  assert.equal(state.peakFleetReads, 1);
});

test("an invalidation during a Fleet read queues one non-concurrent follow-up", async () => {
  const firstRead = deferred<Response>();
  const { store, source, state } = await onlineFleetFlow((readNumber) =>
    readNumber === 1 ? firstRead.promise : json(populatedFleet()),
  );

  source.emit(notificationFrame("OnFleetMemberChanged", 1));
  await waitFor(
    () => state.fleetReads === 1 && state.activeFleetReads === 1,
    "first Fleet read never started",
  );

  source.emit(notificationFrame("OnFleetMove", 2));
  source.emit(notificationFrame("OnFleetOptionsChanged", 3));
  source.emit(notificationFrame("OnFleetJoinRequest", 4));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(state.fleetReads, 1, "the in-flight read must not be overlapped");
  assert.equal(state.peakFleetReads, 1);

  firstRead.resolve(json(populatedFleet()));
  await waitFor(
    () =>
      state.fleetReads === 2 &&
      state.activeFleetReads === 0 &&
      store.get().fleet.loaded &&
      !store.get().fleet.loading,
    "the dirty Fleet worker did not finish exactly one follow-up read",
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(state.fleetReads, 2);
  assert.equal(state.peakFleetReads, 1, "Fleet bound reads must remain single-flight");
});

// --- R24: the two pushed notifications with a real payload, plus the
// __MultiEvent unwrap that was silently dropping fleet member-change batches
// before applyPushedNotification learned to open them. ------------------------

test("a pushed OnFleetBroadcast lands on the fleet slice", async () => {
  const { store, source } = await onlineFleetFlow();
  assert.equal(store.get().fleet.lastBroadcast, null);

  source.emit(
    notificationFrame("OnFleetBroadcast", 1, [
      "EnemySpotted",
      3,
      "90000002",
      30000142,
      1000000000042,
      32872,
    ]),
  );

  await waitFor(
    () => store.get().fleet.lastBroadcast !== null,
    "the pushed OnFleetBroadcast never landed on the fleet slice",
  );
  const broadcast = store.get().fleet.lastBroadcast;
  assert.equal(broadcast?.name, "EnemySpotted");
  assert.equal(broadcast?.scope, 3);
  // The bare decimal string case (⚠ in fleetBroadcasts.ts) — our own gateway's
  // actual shape for a passthrough id, not the {type:"long"} wrapper.
  assert.equal(broadcast?.senderCharID, 90000002);
  assert.equal(broadcast?.senderSolarSystemID, 30000142);
  assert.equal(broadcast?.itemID, 1000000000042);
  assert.equal(broadcast?.typeID, 32872);
});

test("a pushed OnFleetStateChange lands, and an empty tag map stays distinct from null", async () => {
  const { store, source } = await onlineFleetFlow();
  assert.equal(store.get().fleet.targetTags, null);

  source.emit(
    notificationFrame("OnFleetStateChange", 1, [
      keyVal([["targetTags", { type: "dict", entries: [[1000000000042, "A"]] }]]),
    ]),
  );
  await waitFor(
    () => store.get().fleet.targetTags !== null,
    "the pushed target-tag map never landed on the fleet slice",
  );
  assert.equal(store.get().fleet.targetTags?.get(1000000000042), "A");
  assert.equal(store.get().fleet.targetTags?.size, 1);

  // A second push with NOTHING tagged must still land as an EMPTY MAP, never
  // null — null means "never received", and this fleet plainly has.
  source.emit(
    notificationFrame("OnFleetStateChange", 2, [
      keyVal([["targetTags", { type: "dict", entries: [] }]]),
    ]),
  );
  await waitFor(
    () => store.get().fleet.targetTags?.size === 0,
    "the empty tag map never replaced the populated one",
  );
  assert.notEqual(store.get().fleet.targetTags, null);
});

test("a __MultiEvent batching two OnFleetMemberChanged pairs coalesces into one dropped-today refresh", async () => {
  const { store, source, state } = await onlineFleetFlow();

  // The server's only call site for __MultiEvent (notifyFleetMultiEvent) wraps
  // exactly this: more than one OnFleetMemberChanged landing in the same tick.
  // Member-change args are irrelevant to the invalidation path (it only ever
  // schedules a reread), so placeholders are enough here.
  source.emit(
    notificationFrame("__MultiEvent", 1, [
      ["OnFleetMemberChanged", []],
      ["OnFleetMemberChanged", []],
    ]),
  );

  await waitFor(
    () =>
      state.fleetReads === 1 && store.get().fleet.loaded && !store.get().fleet.loading,
    "the __MultiEvent batch never triggered a Fleet reread — the bug this fixes",
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    state.fleetReads,
    1,
    "two member-changed pairs in one batch must coalesce to ONE reread, not two",
  );
  assert.equal(state.peakFleetReads, 1);
});

test("a nested __MultiEvent is refused, not expanded, while its sibling pair still dispatches", async () => {
  const { store, source, state } = await onlineFleetFlow();

  source.emit(
    notificationFrame("__MultiEvent", 1, [
      // Pathological: the server never actually wraps its own wrapper.
      ["__MultiEvent", [["OnFleetMemberChanged", []]]],
      ["OnFleetMemberChanged", []],
    ]),
  );

  await waitFor(
    () =>
      state.fleetReads === 1 && store.get().fleet.loaded && !store.get().fleet.loading,
    "the sibling OnFleetMemberChanged pair never triggered its reread",
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    state.fleetReads,
    1,
    "a nested __MultiEvent must be refused outright, never expanded into its own reread",
  );
});

test("an unrecognised method still invents no refresh (unaffected by the new dispatch)", async () => {
  const { store, source, state } = await onlineFleetFlow();

  source.emit(notificationFrame("OnFleetInviteExpired", 1));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(state.fleetReads, 0, "an unrecognised Fleet-like event must not invent a roster invalidation");
  assert.equal(store.get().fleet.lastBroadcast, null);
  assert.equal(store.get().fleet.targetTags, null);
});

// --- fleet-companion phase 7: the jam pushes -------------------------------
//
// OnJamStart/OnJamEnd reach the browser on the same SSE channel as the fleet
// notifications (the gateway's stub suppresses only DoDestinyUpdate), so this
// needs no gateway patch. It is the only read anywhere that says WHO is
// holding this ship down.

test("a pushed OnJamStart lands on the space slice, naming the aggressor", async () => {
  const { store, source } = await onlineFleetFlow();
  assert.deepEqual([...store.get().space.jams], []);

  source.emit(
    notificationFrame("OnJamStart", 1, [9001, 9002, 90000001, "warpScramblerMWD", 0, 5000]),
  );

  await waitFor(
    () => store.get().space.jams.length === 1,
    "the pushed OnJamStart never landed on the space slice",
  );
  const jam = store.get().space.jams[0];
  assert.equal(jam?.sourceBallID, 9001, "the aggressor names itself and must survive the trip");
  assert.equal(jam?.jammingType, "warpScramblerMWD");
  assert.equal(jam?.durationMs, 5000);
});

test("the matching OnJamEnd takes it off again", async () => {
  const { store, source } = await onlineFleetFlow();

  source.emit(
    notificationFrame("OnJamStart", 1, [9001, 9002, 90000001, "warpScrambler", 0, 5000]),
  );
  await waitFor(() => store.get().space.jams.length === 1, "the jam never landed");

  source.emit(notificationFrame("OnJamEnd", 2, [9001, 9002, 90000001, "warpScrambler"]));
  await waitFor(() => store.get().space.jams.length === 0, "the jam was never released");
});

// A jam push must not be mistaken for a roster invalidation - it carries its
// own payload and there is no route to re-read it from.
test("a jam push triggers no fleet reread", async () => {
  const { store, source, state } = await onlineFleetFlow();

  source.emit(
    notificationFrame("OnJamStart", 1, [9001, 9002, 90000001, "webify", 0, 5000]),
  );
  await waitFor(() => store.get().space.jams.length === 1, "the jam never landed");

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(state.fleetReads, 0, "a jam is not a roster invalidation");
  // ⚠ EVERY JAM TYPE IS KEPT, not just tackle. Narrowing to the two tackle
  // types is a READ-time job (tacklersHolding), so a later reader that wants to
  // know it is being webbed does not have to re-plumb the wire.
  assert.equal(store.get().space.jams[0]?.jammingType, "webify");
});

// --- the pushed lock (`OnTarget`) -------------------------------------------
//
// The same channel and the same stub as the jam pushes above. It is the one
// fact rung 6 and rung 7 are both blocked on — drones will not go onto a ship
// this hull has not locked, and the guns will not come up until the lock is
// observed — and before this it was only ever learned from a POLL, so it cost
// a whole tick of the companion's cadence every fight.

test("a pushed OnTarget add lands the lock without waiting for a GetTargets poll", async () => {
  const { store, source } = await onlineFleetFlow();
  assert.deepEqual(store.get().targeting.lockedTargetIDs, []);

  source.emit(notificationFrame("OnTarget", 1, ["add", 9001]));

  await waitFor(
    () => store.get().targeting.lockedTargetIDs.length === 1,
    "the pushed OnTarget never reached the targeting slice",
  );
  assert.deepEqual(store.get().targeting.lockedTargetIDs, [9001]);
});

test("a pushed OnTarget lost takes the lock off again", async () => {
  const { store, source } = await onlineFleetFlow();

  source.emit(notificationFrame("OnTarget", 1, ["add", 9001]));
  await waitFor(() => store.get().targeting.lockedTargetIDs.length === 1, "the lock never landed");

  source.emit(notificationFrame("OnTarget", 2, ["lost", 9001, "TargetingAttemptCancelled"]));
  await waitFor(
    () => store.get().targeting.lockedTargetIDs.length === 0,
    "the lock was never released",
  );
});

// ⚠ THE ONE THAT WOULD CORRUPT THE LIST. `otheradd` carries the id of a ship
// that locked US. Folding it in would put another ship's id where this hull's
// own locks live, and the drone rung would send drones onto it.
test("somebody else locking this ship is not a lock of ours", async () => {
  const { store, source, state } = await onlineFleetFlow();

  source.emit(notificationFrame("OnTarget", 1, ["otheradd", 9001]));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(store.get().targeting.lockedTargetIDs, []);
  assert.equal(state.fleetReads, 0, "and it is not a roster invalidation either");
});

test("the names a fleet's roster needs are asked for by the composition's word for each member", async () => {
  const record = (charID: number, more: readonly (readonly [string, unknown])[] = []) => keyVal([["charID", charID], ["wingID", null], ["squadID", null], ["role", 1], ["job", 0], ...more]);
  const entry = (characterID: number, shipTypeID: number, stationID: number | null, solarSystemID: number) =>
    keyVal([["characterID", characterID], ["shipTypeID", shipTypeID], ["stationID", stationID], ["solarSystemID", solarSystemID]]);
  const fleet = populatedFleet();
  fleet.reads.GetInitState.result = keyVal([
    ["motd", ""],
    ["fleetID", 654500010000],
    ["members", { type: "dict", entries: [[140000005, record(140000005)], [140000002, record(140000002, [["shipTypeID", 670], ["stationID", 60003760], ["solarSystemID", 30000142]])], [140000003, record(140000003, [["shipTypeID", 588], ["stationID", 60003466], ["solarSystemID", 30000140]])]] }],
    ["wings", { type: "dict", entries: [] }],
  ]) as never;
  fleet.reads.GetFleetComposition.result = { type: "list", items: [entry(140000005, 587, null, 30000144), entry(140000002, 648, 60000004, 30002780)] } as never;
  const asked: string[] = [];
  const store = createClientStore();
  const flow = createAppFlow(store, {
    fetch: async (input: unknown, init?: { body?: unknown }) => {
      if (String(input) === "/api/names") {
        const body = JSON.parse(String(init?.body)) as { items?: { kind: string; id: number }[] };
        for (const ref of body.items ?? []) asked.push(`${ref.kind}:${ref.id}`);
        return json({ ok: true, names: {} });
      }
      return json(fleet);
    },
  });
  await flow.loadFleet();
  await waitFor(() => asked.length > 0, "the roster's names were never asked for");
  // The composition's ship and place for the two it names; the record's own for the one it does not.
  for (const wanted of ["type:587", "system:30000144", "type:648", "station:60000004", "system:30002780", "type:588", "station:60003466", "system:30000140"]) {
    assert.ok(asked.includes(wanted), `${wanted} is asked for, of ${asked.join(" ")}`);
  }
  for (const stale of ["type:670", "station:60003760", "system:30000142"]) assert.equal(asked.includes(stale), false, stale);
});

test("a fleet whose composition has not caught up with its roster is read once more when the composition can be had again", async () => {
  // fleetSvc.GetFleetComposition keeps what it was answered for twenty seconds: a member who joined since is not in it.
  const record = (charID: number) => keyVal([["charID", charID], ["wingID", null], ["squadID", null], ["role", 1], ["job", 0]]);
  const entry = (characterID: number) => keyVal([["characterID", characterID], ["shipTypeID", 587], ["stationID", null], ["solarSystemID", 30000144]]);
  const fleetWith = (members: readonly number[], inComposition: readonly number[] | null) => {
    const fleet = populatedFleet();
    fleet.reads.GetInitState.result = keyVal([["motd", ""], ["fleetID", 654500010000], ["members", { type: "dict", entries: members.map((charID) => [charID, record(charID)]) }], ["wings", { type: "dict", entries: [] }]]) as never;
    fleet.reads.GetFleetComposition.result = (inComposition === null ? null : { type: "list", items: inComposition.map(entry) }) as never;
    return fleet;
  };
  const flowReading = (answers: readonly unknown[]) => {
    const state = { reads: 0 };
    const store = createClientStore();
    const flow = createAppFlow(store, {
      fleetCompositionRereadMs: 25,
      fetch: async (input: unknown) => {
        if (String(input) === "/api/names") return json({ ok: true, names: {} });
        state.reads += 1;
        return json(answers[Math.min(state.reads, answers.length) - 1]);
      },
    });
    return { flow, state, store };
  };
  const settled = () => new Promise((resolve) => setTimeout(resolve, 150));
  /** The re-read is on a real timer: wait for it by the clock, a second at most. */
  const until = async (predicate: () => boolean, message: string): Promise<void> => {
    for (let waited = 0; waited < 1000 && !predicate(); waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(predicate(), message);
  };
  const both = [140000005, 140000002];

  // One member is not in the composition yet: read again once it can be had, and then it is.
  const caughtUp = flowReading([fleetWith(both, [140000005]), fleetWith(both, both)]);
  await caughtUp.flow.loadFleet();
  assert.equal(caughtUp.state.reads, 1);
  await until(() => caughtUp.state.reads === 2, "the fleet was never read again for its composition");
  await settled();
  assert.equal(caughtUp.state.reads, 2);
  assert.equal(caughtUp.store.get().fleet.fleet?.composition.value.length, 2);

  // A composition that still has not the member is not asked after for ever: once for that roster.
  const never = flowReading([fleetWith(both, [140000005])]);
  await never.flow.loadFleet();
  await until(() => never.state.reads === 2, "the fleet was never read again for its composition");
  await settled();
  assert.equal(never.state.reads, 2);
  // Until the roster is another roster: then once more for that.
  const grew = flowReading([fleetWith(both, [140000005]), fleetWith(both, [140000005]), fleetWith([...both, 140000003], [140000005])]);
  await grew.flow.loadFleet();
  await until(() => grew.state.reads === 2, "no second read");
  await settled();
  await grew.flow.loadFleet();
  await until(() => grew.state.reads === 4, "the grown roster was not read again for");
  await settled();
  assert.equal(grew.state.reads, 4);

  // A composition that catches up of itself before the time is up is not read for again.
  const overtaken = flowReading([fleetWith(both, [140000005]), fleetWith(both, both)]);
  await overtaken.flow.loadFleet();
  await overtaken.flow.loadFleet();
  await settled();
  assert.equal(overtaken.state.reads, 2);
  // Once it has caught up, the same roster falling behind again is read for again.
  const again = flowReading([fleetWith(both, [140000005]), fleetWith(both, [140000005]), fleetWith(both, both), fleetWith(both, [140000005]), fleetWith(both, both)]);
  await again.flow.loadFleet();
  await until(() => again.state.reads === 2, "no second read");
  await settled();
  await again.flow.loadFleet();
  await again.flow.loadFleet();
  await until(() => again.state.reads === 5, "the roster that fell behind again was not read for again");

  // Everyone is in it, or the pilot has no composition to be shown (it commands nothing): nothing is read again.
  for (const [why, fleet] of [["all in it", fleetWith(both, both)], ["none to show", fleetWith(both, null)], ["an empty one", fleetWith(both, [])], ["no fleet", noFleet()]] as const) {
    const quiet = flowReading([fleet]);
    await quiet.flow.loadFleet();
    await settled();
    assert.equal(quiet.state.reads, 1, why);
  }
});
