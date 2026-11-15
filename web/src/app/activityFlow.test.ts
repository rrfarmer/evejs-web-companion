import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import { mailMarkupOfTyped } from "../bridge/mailMarkup.ts";
import type { BridgeCallRequestBody } from "../bridge/wire.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** What the generic call answers, by the service asked: nothing of each, in the form the server answers in. */
function emptyAnswerOf(service: string | undefined): unknown {
  if (service === "notificationMgr") return [];
  if (service === "calendarProxy") return [{ type: "list", items: [] }, { type: "list", items: [] }, null];
  if (service === "calendarMgr") return { type: "list", items: [] };
  // mailSvc.SyncMail (157): two messages, neither read.
  if (service === "mailMgr") return mailSyncOf(2);
  return null;
}

function keyVal(fields: Record<string, unknown>): unknown {
  return { type: "object", name: "util.KeyVal", args: { type: "dict", entries: Object.entries(fields) } };
}

/** SyncMail's answer of so many messages, none of them read. */
function mailSyncOf(unread: number): unknown {
  const ids = Array.from({ length: unread }, (_, place) => 4000 + place);
  return keyVal({
    newMail: { type: "list", items: ids.map((messageID) => keyVal({ messageID, senderID: 140000004, toCharacterIDs: "140000005", toListID: null, toCorpOrAllianceID: null, title: "Mail", sentDate: { type: "long", value: "133000000000000000" } })) },
    oldMail: { type: "list", items: [] },
    mailStatus: { type: "list", items: ids.map((messageID) => keyVal({ messageID, statusMask: 0, labelMask: 1 })) },
  });
}

test("loadActivity asks by the generic call the notification service's two, the calendar service's three, the mail service's sync and the skill history's notifications' two", async () => {
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    // By the generic call (notificationSvc.py 93 and 107; eveCalendarsvc.py 239 and 252; mailSvc.py 157;
    // skillHistoryProvider.py 32 to 34): no notifications, no events, no responses, two unread mails, and nothing
    // of the skill handler's.
    if (url === "/api/bridge/call") {
      const { service, method } = JSON.parse(String(init?.body ?? "{}")) as { service: string; method: string };
      return json({ ok: true, service, method, result: emptyAnswerOf(service) });
    }
    if (url === "/api/names") return json({ ok: true, names: {} });
    throw new Error(`unexpected fetch: ${url}`);
  };

  const store = createClientStore();
  const flow = createAppFlow(store, { fetch });
  await flow.loadActivity();

  assert.deepEqual(calls, [...Array.from({ length: 8 }, () => "/api/bridge/call"), "/api/names"]);
  assert.equal(store.get().activity.notifications.status, "ready");
  assert.deepEqual(store.get().activity.notifications.value, []);
  assert.equal(store.get().activity.calendarEvents.status, "ready");
  assert.equal(store.get().mail.unreadCount, 2);
  assert.equal(store.get().activity.mailError, null);
});

test("loadActivity lands partial success when the notification service's reads fail", async () => {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "/api/bridge/call") {
      const { service, method } = JSON.parse(String(init?.body ?? "{}")) as { service: string; method: string };
      return service === "notificationMgr"
        ? json({ ok: false, error: "CALL_FAILED", message: "notificationMgr unavailable" }, 503)
        : json({ ok: true, service, method, result: emptyAnswerOf(service) });
    }
    if (url === "/api/names") return json({ ok: true, names: {} });
    throw new Error(`unexpected fetch: ${url}`);
  };

  const store = createClientStore();
  await createAppFlow(store, { fetch }).loadActivity();

  const activity = store.get().activity;
  assert.equal(activity.loaded, true);
  assert.equal(activity.loading, false);
  assert.equal(activity.notifications.status, "error");
  assert.equal(activity.unprocessedCount.status, "error");
  assert.equal(activity.calendarEvents.status, "ready");
  assert.deepEqual(activity.calendarEvents.value, []);
  assert.equal(activity.calendarResponses.status, "ready");
  assert.equal(activity.mailError, null);
});

test("the Calendar reads the browsed month and keeps past events from all returned rowsets", async () => {
  const timestamp = "134282418600000000";
  const calls: unknown[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "/api/bridge/call");
    const { service, method, args } = JSON.parse(String(init?.body));
    calls.push([service, method, args]);
    const row = (eventID: number, flag: number) => keyVal({ eventID, flag, eventDateTime: { type: "long", value: timestamp } });
    return json({ ok: true, service, method, result: [{ type: "list", items: [row(1, 8)] }, { type: "list", items: [row(2, 1)] }, null] });
  };
  const flow = createAppFlow(createClientStore(), { fetch });
  const events = await flow.loadCalendarMonth(7, 2026);
  assert.deepEqual(calls, [["calendarProxy", "GetEventList", [7, 2026]]]);
  assert.deepEqual(events.map(event => [event.eventID, event.flag, event.eventDateTime]), [[1, 8, BigInt(timestamp)], [2, 1, BigInt(timestamp)]]);
});

test("Calendar event and invitation reads use the opened row's event and owner IDs", async () => {
  const calls: unknown[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (String(input) === "/api/names") return json({ ok: true, names: {} });
    assert.equal(String(input), "/api/bridge/call");
    const { service, method, args } = JSON.parse(String(init?.body));
    calls.push([service, method, args]);
    const result = method === "GetEventDetails" ? keyVal({ eventText: { type: "wstring", value: "The agenda" }, creatorID: 140_000_002 })
      : { type: "list", items: [keyVal({ characterID: 140_000_001, status: 3 })] };
    return json({ ok: true, service, method, result });
  };
  const flow = createAppFlow(createClientStore(), { fetch });
  assert.deepEqual(await flow.loadCalendarEvent(980000000006, 140_000_002), { eventText: "The agenda", creatorID: 140_000_002 });
  assert.deepEqual(await flow.loadCalendarInvitees(980000000006, 140_000_002), [{ characterID: 140_000_001, status: 3 }]);
  assert.deepEqual(calls, [["calendarProxy", "GetEventDetails", [980000000006, 140_000_002]],
    ["calendarMgr", "GetResponsesToEvent", [980000000006, 140_000_002]]]);
});

test("Calendar agenda reads the year boundary months and retains cancellation and response fields", async t => {
  const nowMs = Date.UTC(2026, 11, 31, 20);
  t.mock.timers.enable({ apis: ["Date"], now: nowMs });
  const calls: unknown[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "/api/bridge/call");
    const { service, method, args } = JSON.parse(String(init?.body));
    calls.push([service, method, args]);
    const event = keyVal({ eventID: args[0] === 12 ? 17 : 18, flag: 1, isDeleted: args[0] === 12 });
    const result = method === "GetEventList" ? [{ type: "list", items: [event] }, null, null]
      : [keyVal({ eventID: 17, status: 4 })];
    return json({ ok: true, service, method, result });
  };
  const flow = createAppFlow(createClientStore(), { fetch });
  const agenda = await flow.loadCalendarAgenda();
  assert.deepEqual(calls, [["calendarProxy", "GetEventList", [12, 2026]], ["calendarProxy", "GetEventList", [1, 2027]],
    ["calendarMgr", "GetResponsesForCharacter", []]]);
  assert.deepEqual(agenda.events.map(event => [event.eventID, event.isDeleted, event.flag]), [[17, true, 1], [18, false, 1]]);
  assert.deepEqual(agenda.responses, [{ eventID: 17, status: 4 }]);
  assert.equal(agenda.nowMs, nowMs);
});

test("Calendar replies send the native IDs and chosen status and re-read after a lost reply", async () => {
  const calls: unknown[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "/api/bridge/call");
    const { service, method, args, pilot, confirm } = JSON.parse(String(init?.body));
    calls.push([service, method, args, pilot, confirm]);
    if (calls.length === 2) return json({ ok: false, message: "Connection lost" }, 502);
    return json({ ok: true, service, method, result: null });
  };
  const flow = createAppFlow(createClientStore(), { fetch });
  const initial = flow.calendarUpdated.get();
  await flow.respondToCalendarEvent(980000000006, 140_000_002, 4);
  assert.equal(flow.calendarUpdated.get(), initial + 1);
  await assert.rejects(flow.respondToCalendarEvent(980000000006, 140_000_002, 2));
  assert.equal(flow.calendarUpdated.get(), initial + 2);
  assert.deepEqual(calls, [
    ["calendarMgr", "SendEventResponse", [980000000006, 140_000_002, 4], true, true],
    ["calendarMgr", "SendEventResponse", [980000000006, 140_000_002, 2], true, true],
  ]);
});

test("New Calendar Event writes the native FILETIME, text and personal invitees through the confirmed pilot call", async () => {
  const calls: BridgeCallRequestBody[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "/api/bridge/call");
    const body = JSON.parse(String(init?.body)) as BridgeCallRequestBody;
    calls.push(body);
    return json({ ok: true, service: body.service, method: body.method, result: { type: "long", value: "980000000042" } });
  };
  const flow = createAppFlow(createClientStore(), { fetch });
  const initial = flow.calendarUpdated.get();
  const startsAt = Date.UTC(2026, 10, 17, 12, 15);
  const draft = { startsAt, title: "Drill", description: mailMarkupOfTyped("Use <angles> & lines.\nBring scanners."),
    duration: 120, important: true, inviteeIDs: [140_000_001] };
  for (const scope of ["personal", "corporation", "alliance"] as const) {
    assert.equal(await flow.createCalendarEvent({ ...draft, scope }), 980000000042);
  }
  const args = [
    { type: "long", value: (BigInt(startsAt) * 10_000n + 116444736000000000n).toString() }, 120,
    { type: "wstring", value: "Drill" }, { type: "wstring", value: "Use &lt;angles&gt; &amp; lines.<br>Bring scanners." }, 1,
  ];
  assert.deepEqual(calls.map(({ service, method, args, pilot, confirm }) => [service, method, args, pilot, confirm]), [
    ["calendarMgr", "CreatePersonalEvent", [...args, { type: "list", items: [140_000_001] }], true, true],
    ["calendarMgr", "CreateCorporationEvent", args, true, true],
    ["calendarMgr", "CreateAllianceEvent", args, true, true],
  ]);
  assert.equal(flow.calendarUpdated.get(), initial + 3);
});

test("the Calendar only retries a charged invitation when the organizer accepts the quoted in-game cost", async () => {
  const calls: unknown[] = [];
  const values = { type: "dict", entries: [["totalCost", 50], ["totalCostISK", "50 ISK"]] };
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body.kwargs);
    if (body.kwargs?.approvedCost === 50) return json({ ok: true, service: body.service, method: body.method, result: 17 });
    return json({ ok: false, error: "CALL_REFUSED", refusal: { key: "ContactCostNotApproved", values } }, 409);
  };
  const flow = createAppFlow(createClientStore(), { fetch });
  const send = () => flow.createCalendarEvent({
    scope: "personal", startsAt: Date.UTC(2026, 10, 17, 12), title: "Drill", description: "",
    duration: null, important: false, inviteeIDs: [140_000_001],
  });
  async function answer(yes: boolean): Promise<void> {
    for (let i = 0; i < 20 && flow.dialogsSaid.get().length === 0; ++i) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const question = flow.dialogsSaid.get()[0];
    assert.equal(question?.dialog, "CSPACalendarCheck");
    flow.answerDialog(question!.n, yes);
  }
  const declined = send();
  await answer(false);
  assert.equal(await declined, null);
  assert.deepEqual(calls.map(kwargs => kwargs ?? null), [null]);
  const approved = send();
  await answer(true);
  assert.equal(await approved, 17);
  assert.deepEqual(calls.map(kwargs => kwargs ?? null), [null, null, { approvedCost: 50 }]);
});
