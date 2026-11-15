// Goal R10: the browser end of the live event channel. The flow subscribes to
// the BFF's SSE route when a character comes online and feeds what arrives into
// the store — the session notifications the page used to throw away, and the
// chat messages the Chat panel used to poll for.
//
// What these cover: the stream opens on select and closes when the session
// ends; a pushed chat message lands in the right channel's backlog; a message
// the poll already delivered is not duplicated; pushed notifications land in the
// live slice with their cursor; an unreplayable snapshot triggers a re-read
// rather than pretending the backlog is continuous; and a stream that cannot
// open leaves the page on its polls instead of failing.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import type { EventSourceLike } from "./api.ts";

interface FakeSource extends EventSourceLike {
  readonly url: string;
  closed: boolean;
  emit(frame: unknown): void;
  open(): void;
  fail(): void;
}

function makeFakeEventSource(): {
  factory: (url: string) => EventSourceLike;
  sources: FakeSource[];
} {
  const sources: FakeSource[] = [];
  const factory = (url: string): EventSourceLike => {
    const source: FakeSource = {
      url,
      closed: false,
      onmessage: null,
      onopen: null,
      onerror: null,
      emit(frame: unknown) {
        source.onmessage?.({ data: JSON.stringify(frame) });
      },
      open() {
        source.onopen?.();
      },
      fail() {
        source.onerror?.();
      },
      close() {
        source.closed = true;
      },
    };
    sources.push(source);
    return source;
  };
  return { factory, sources };
}

const SELECT_RESPONSE = {
  ok: true,
  character: {
    characterID: 7,
    characterName: "Test Pilot",
    stationID: 60003760,
    structureID: null,
    solarSystemID: 30000142,
    corporationID: 98000000,
  },
  station: null,
  notifications: [],
};

const LOCAL_CHAT = {
  channel: "local",
  roomName: "local_30000142",
  solarSystemID: 30000142,
  corporationID: null,
  roster: [{ characterID: 7, name: "Me", corporationID: 98000000 }],
  messages: [{ characterID: 9, characterName: "Neighbor", message: "o7", createdAtMs: 1 }],
};

function makeFakeFetch(): { fetch: typeof fetch; paths: string[] } {
  const paths: string[] = [];
  const fakeFetch = (async (input: unknown, init?: { method?: string }) => {
    const path = String(input);
    paths.push(path);
    let body: unknown = { ok: true };
    if (path === "/api/bridge/select") {
      body = SELECT_RESPONSE;
    } else if (path === "/api/bridge/chat/local") {
      body = { ok: true, chat: LOCAL_CHAT, notifications: [] };
    } else if (path === "/api/bridge/call") {
      body = { ok: true, service: "s", method: "m", result: null, notifications: [] };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return body;
      },
    };
  }) as unknown as typeof fetch;
  return { fetch: fakeFetch, paths };
}

async function onlineFlow() {
  const store = createClientStore();
  const { fetch, paths } = makeFakeFetch();
  const { factory, sources } = makeFakeEventSource();
  const flow = createAppFlow(store, { fetch, eventSource: factory });
  await flow.selectCharacter(7);
  const source = sources[0];
  assert.ok(source, "selecting a character must open the live event channel");
  return { store, flow, source, sources, paths };
}

function gatewayFrame(event: unknown, sequence: number) {
  return {
    source: "evejs-web-gateway",
    apiVersion: 1,
    type: "event",
    cursor: { epoch: "epoch-1", sequence },
    event,
  };
}

test("selecting a character opens the live event channel", async () => {
  const { source, sources, store } = await onlineFlow();
  assert.equal(sources.length, 1);
  assert.equal(source.url, "/api/bridge/events");
  source.open();
  assert.equal(store.get().live.status, "live");
});

test("Academy decline notices use their installed notification strips", async () => {
  const { source, flow } = await onlineFlow();
  const typeName = "eve_public.academy.ships.api.DeclinedNotice";
  source.emit(gatewayFrame({ kind: "gateway-notice", notice: { typeName, payload: null } }, 1));
  source.emit(gatewayFrame({ kind: "gateway-notice", notice: { typeName, payload: { reason: "DECLINED_REASON_TRAVEL" } } }, 2));
  assert.deepEqual(flow.dialogsSaid.get(), []);

  const expected = {
    UNDOCK: "AcademyShipCannotUndockOutsideExordium",
    WARP: "AcademyShipCannotWarpOutsideExordium",
    EJECT: "AcademyShipCannotEject",
    DRONE: "AcademyDroneNeedsAcademyShip",
  };
  for (const [index, [reason, key]] of Object.entries(expected).entries()) {
    source.emit(gatewayFrame({ kind: "gateway-notice", notice: { typeName, payload: { reason: `DECLINED_REASON_${reason}` } } }, index + 3));
    assert.equal(flow.dialogsSaid.get().at(-1)?.dialog, key);
    assert.equal(flow.dialogsSaid.get().at(-1)?.fallbackType, "notify");
  }
  source.emit(gatewayFrame({
    kind: "gateway-notice",
    notice: { typeName, payload: { reason: "DECLINED_REASON_UNDOCK" } },
  }, 7));
  assert.equal(flow.dialogsSaid.get().filter((dialog) => dialog.dialog === expected.UNDOCK).length, 1);
});

test("the Academy travel notice opens one separate conversation, including on a fresh attempt", async () => {
  const { source, flow } = await onlineFlow();
  const notice = { typeName: "eve_public.academy.ships.api.DeclinedNotice", payload: { reason: "DECLINED_REASON_TRAVEL" } };
  const frame = (sequence: number) => gatewayFrame({ kind: "gateway-notice", notice }, sequence);
  assert.equal(flow.academyTravelConversation.get(), false);
  source.emit(frame(1));
  assert.equal(flow.academyTravelConversation.get(), true);
  assert.deepEqual(flow.dialogsSaid.get(), []);
  flow.closeAcademyTravelConversation();
  source.emit(frame(1));
  assert.equal(flow.academyTravelConversation.get(), false, "a replay of the closed notice does not reopen it");
  source.emit(frame(2));
  assert.equal(flow.academyTravelConversation.get(), true, "a new attempt can open the conversation again");
});

test("a pushed chat message lands in the channel backlog without a poll", async () => {
  const { source, store, paths } = await onlineFlow();
  const before = paths.filter((p) => p === "/api/bridge/chat/local").length;

  source.emit(
    gatewayFrame(
      {
        kind: "chat",
        channel: "local",
        roomName: "local_30000142",
        entry: {
          characterID: 9,
          characterName: "Neighbor",
          message: "pushed live",
          createdAtMs: 5,
        },
      },
      1,
    ),
  );

  const messages = store.get().chat.local.messages;
  assert.equal(messages.at(-1)?.message, "pushed live");
  assert.equal(messages.at(-1)?.characterName, "Neighbor");
  assert.equal(
    paths.filter((p) => p === "/api/bridge/chat/local").length,
    before,
    "a live message must not require a backlog read",
  );
});

test("a pushed corp message goes to the corp channel, not local", async () => {
  const { source, store } = await onlineFlow();
  source.emit(
    gatewayFrame(
      {
        kind: "chat",
        channel: "corp",
        entry: { characterID: 9, characterName: "Mate", message: "corp only", createdAtMs: 5 },
      },
      1,
    ),
  );
  assert.equal(store.get().chat.corp.messages.at(-1)?.message, "corp only");
  assert.equal(store.get().chat.local.messages.length, 0);
});

test("a message the poll already delivered is not duplicated by the push", async () => {
  const { source, store, flow } = await onlineFlow();
  await flow.loadChat("local");
  assert.equal(store.get().chat.local.messages.length, 1);

  // The same backlog entry the read returned, now arriving over the channel.
  source.emit(
    gatewayFrame(
      {
        kind: "chat",
        channel: "local",
        entry: { characterID: 9, characterName: "Neighbor", message: "o7", createdAtMs: 1 },
      },
      1,
    ),
  );
  assert.equal(
    store.get().chat.local.messages.length,
    1,
    "push and poll deliver the same entries; the store must dedupe them",
  );
});

test("pushed session notifications land in the live slice with their cursor", async () => {
  const { source, store } = await onlineFlow();
  source.emit(
    gatewayFrame(
      { kind: "notification", notification: { kind: "service", service: "OnX", method: "Notify" } },
      3,
    ),
  );
  source.emit(
    gatewayFrame(
      { kind: "notification", notification: { kind: "sessionchange", method: "OnSessionChanged" } },
      4,
    ),
  );

  const live = store.get().live;
  assert.equal(live.status, "live");
  assert.equal(live.epoch, "epoch-1");
  assert.equal(live.sequence, 4);
  assert.deepEqual(
    live.notifications.map((n) => n.kind),
    ["service", "sessionchange"],
  );
  assert.equal(live.notifications[0]?.service, "OnX");
});

test("an unreplayable snapshot re-reads the active channel instead of assuming continuity", async () => {
  const { source, store, paths } = await onlineFlow();
  const before = paths.filter((p) => p === "/api/bridge/chat/local").length;

  source.emit({
    source: "evejs-web-gateway",
    type: "snapshot",
    reason: "cursor_not_replayable",
    cursor: { epoch: "epoch-2", sequence: 12 },
  });

  assert.equal(store.get().live.epoch, "epoch-2");
  assert.equal(store.get().live.sequence, 12);
  // Give the re-read a turn to be issued.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(
    paths.filter((p) => p === "/api/bridge/chat/local").length > before,
    "a gap in the stream must trigger a re-read",
  );
});

test("an opening snapshot with no cursor does NOT trigger a re-read", async () => {
  const { source, paths } = await onlineFlow();
  const before = paths.filter((p) => p === "/api/bridge/chat/local").length;
  source.emit({
    source: "evejs-web-gateway",
    type: "snapshot",
    reason: "no_cursor",
    cursor: { epoch: "epoch-1", sequence: 0 },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    paths.filter((p) => p === "/api/bridge/chat/local").length,
    before,
    "a fresh subscribe has missed nothing",
  );
});

test("a BFF status frame drives the live status (so the page can fall back to polling)", async () => {
  const { source, store } = await onlineFlow();
  source.emit({ source: "evejs-web-bff", type: "stream-status", state: "degraded" });
  assert.equal(store.get().live.status, "degraded");
  source.emit({ source: "evejs-web-bff", type: "stream-status", state: "live" });
  assert.equal(store.get().live.status, "live");
});

test("a stream error marks the channel degraded rather than throwing", async () => {
  const { source, store } = await onlineFlow();
  source.fail();
  assert.equal(store.get().live.status, "degraded");
});

test("releasing the session closes the stream and clears the live slice", async () => {
  const { source, store, flow } = await onlineFlow();
  source.emit(
    gatewayFrame({ kind: "notification", notification: { kind: "service" } }, 1),
  );
  assert.equal(store.get().live.notifications.length, 1);

  await flow.releaseSession();
  assert.equal(source.closed, true);
  assert.deepEqual(store.get().live.notifications, []);
  assert.equal(store.get().live.status, "idle");
});

test("a malformed frame is ignored, not thrown at the page", async () => {
  const { source, store } = await onlineFlow();
  source.onmessage?.({ data: "{not json" });
  source.emit({ source: "somebody-else", type: "event", event: { kind: "chat" } });
  source.emit(gatewayFrame({ kind: "unknown-kind" }, 1));
  assert.equal(store.get().live.notifications.length, 0);
  assert.equal(store.get().chat.local.messages.length, 0);
});

test("with no EventSource available the page stays on its polls", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch();
  // No `eventSource` injected and none on globalThis under node:test.
  const flow = createAppFlow(store, { fetch });
  await flow.selectCharacter(7);
  assert.equal(
    store.get().live.status,
    "degraded",
    "an unavailable channel must be reported, not silently treated as live",
  );
});

// ── the server's questions ───────────────────────────────────────────────────
//
// The event is the one src/gamePort/pilots.js publishes when the server calls
// agents.YesNo before a decline (test/gamePortPilots.test.js).

const DECLINE_QUESTION = {
  id: "q-0123456789",
  service: "agents",
  method: "YesNo",
  kind: "yesNo",
  title: { label: "UI/Agents/StandardMission/DeclineMissionTitle", parameters: { type: "dict", entries: [] }, text: null },
  body: { label: "UI/Agents/StandardMission/DeclineMessage", parameters: { type: "dict", entries: [] }, text: null },
  agentID: 3008416,
  contentID: 4802,
  suppressID: "AgtDeclineMission",
  askedAtMs: 1_000_000,
  expiresAtMs: 1_110_000,
};

/** An online flow whose requests are recorded with their bodies, and whose answer route answers as told. */
async function questionFlow(answerStatus = 200) {
  const store = createClientStore();
  const requests: Array<[string, unknown]> = [];
  const fetch = (async (input: unknown, init?: { body?: string }) => {
    const path = String(input);
    requests.push([path, init?.body === undefined ? undefined : JSON.parse(init.body)]);
    if (path.startsWith("/api/bridge/questions/") && answerStatus !== 200) {
      const error = answerStatus === 404 ? "QUESTION_NOT_FOUND" : "CALL_FAILED";
      return { ok: false, status: answerStatus, async json() { return { ok: false, error, message: "no" }; } };
    }
    const body = path === "/api/bridge/select" ? SELECT_RESPONSE
      : path === "/api/bridge/chat/local" ? { ok: true, chat: LOCAL_CHAT, notifications: [] }
        : { ok: true, answered: true };
    return { ok: true, status: 200, async json() { return body; } };
  }) as unknown as typeof globalThis.fetch;
  const { factory, sources } = makeFakeEventSource();
  const flow = createAppFlow(store, { fetch, eventSource: factory });
  await flow.selectCharacter(7);
  const answers = () => requests.filter(([path]) => path.startsWith("/api/bridge/questions/"));
  return { store, flow, source: sources[0]!, answers };
}

test("a question the server asks is held for the user, and nothing is answered until the user answers", async () => {
  const { store, source, answers } = await questionFlow();
  source.emit(gatewayFrame({ kind: "question", question: DECLINE_QUESTION }, 5));
  const live = store.get().live;
  assert.deepEqual(live.questions.map((question) => [question.id, question.kind, question.agentID, question.body.label]), [
    ["q-0123456789", "yesNo", 3008416, "UI/Agents/StandardMission/DeclineMessage"],
  ]);
  assert.equal(live.sequence, 5);
  assert.deepEqual(answers(), [], "the user pressed the button; the question is theirs");

  // Something that is not a question this client can show is not held, and not answered.
  source.emit(gatewayFrame({ kind: "question", question: { ...DECLINE_QUESTION, id: "q2", kind: "choice" } }, 6));
  assert.equal(store.get().live.questions.length, 1);
  assert.deepEqual(answers(), []);
});

test("the user's answer is posted as given, and the question closes", async () => {
  for (const answer of [true, false]) {
    const { store, flow, source, answers } = await questionFlow();
    source.emit(gatewayFrame({ kind: "question", question: DECLINE_QUESTION }, 5));
    await flow.answerQuestion("q-0123456789", answer);
    assert.deepEqual(answers(), [["/api/bridge/questions/q-0123456789/answer", { answer }]]);
    assert.deepEqual(store.get().live.questions, []);
  }
});

test("the server closing a question takes it off the page", async () => {
  const { store, source } = await questionFlow();
  source.emit(gatewayFrame({ kind: "question", question: DECLINE_QUESTION }, 5));
  source.emit(gatewayFrame({ kind: "question-closed", id: "q-0123456789", reason: "expired" }, 6));
  assert.deepEqual(store.get().live.questions, []);
  assert.equal(store.get().live.sequence, 6);
  // A close with no ID closes nothing.
  source.emit(gatewayFrame({ kind: "question", question: DECLINE_QUESTION }, 7));
  source.emit(gatewayFrame({ kind: "question-closed" }, 8));
  assert.equal(store.get().live.questions.length, 1);
});

test("answering a question that has already closed closes it here quietly; any other failure leaves it open and is raised", async () => {
  const gone = await questionFlow(404);
  gone.source.emit(gatewayFrame({ kind: "question", question: DECLINE_QUESTION }, 5));
  await gone.flow.answerQuestion("q-0123456789", true);
  assert.deepEqual(gone.store.get().live.questions, []);

  const broken = await questionFlow(502);
  broken.source.emit(gatewayFrame({ kind: "question", question: DECLINE_QUESTION }, 5));
  await assert.rejects(broken.flow.answerQuestion("q-0123456789", true));
  assert.equal(broken.store.get().live.questions.length, 1, "still open: the server is still waiting");
});

test("a choice and a number are held for the user like a Yes/No, and answered in their own shapes", async () => {
  const { store, flow, source, answers } = await questionFlow();
  const words = (label: string) => ({ label, parameters: { type: "dict", entries: [] }, text: null });
  source.emit(gatewayFrame({ kind: "question", question: {
    ...DECLINE_QUESTION, id: "q-choice", method: "SingleChoiceBox", kind: "choice",
    choices: [words("UI/Agents/Research/SkillListing"), words("UI/Agents/Research/SkillListing")],
  } }, 5));
  source.emit(gatewayFrame({ kind: "question", question: {
    ...DECLINE_QUESTION, id: "q-quantity", method: "GetQuantity", kind: "quantity", agentID: null,
    quantity: { min: 1, max: 12, initial: 12, digits: 0 },
  } }, 6));
  assert.deepEqual(store.get().live.questions.map((question) => [question.id, question.kind, question.choices.length, question.quantity?.max ?? null]), [
    ["q-choice", "choice", 2, null],
    ["q-quantity", "quantity", 0, 12],
  ]);
  await flow.answerQuestion("q-choice", { confirmed: true, index: 1 });
  await flow.answerQuestion("q-quantity", 7);
  assert.deepEqual(answers(), [
    ["/api/bridge/questions/q-choice/answer", { answer: { confirmed: true, index: 1 } }],
    ["/api/bridge/questions/q-quantity/answer", { answer: 7 }],
  ]);
  assert.deepEqual(store.get().live.questions, []);

  // Cancel on a number box is null, and null is sent, not left out.
  source.emit(gatewayFrame({ kind: "question", question: {
    ...DECLINE_QUESTION, id: "q-again", method: "GetQuantity", kind: "quantity", quantity: { min: 1, max: 12, initial: 12, digits: 0 },
  } }, 7));
  await flow.answerQuestion("q-again", null);
  assert.deepEqual(answers().at(-1), ["/api/bridge/questions/q-again/answer", { answer: null }]);
});
