import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";

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
