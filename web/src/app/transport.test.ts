// The client's request lane (goal R92).
//
// Two properties matter here and neither is about speed: the browser must never
// be handed more requests than it can send, and a request that fails must be
// able to say WHICH failure it was — the server ignoring it, or it never
// getting a connection in the first place.

import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_IN_FLIGHT,
  TransportQueueError,
  createTransportLane,
} from "./transport.ts";

/** A task the test decides when to answer. */
function deferred<T = void>(): {
  promise: Promise<T>;
  settle: (value: T) => void;
  fail: (error: Error) => void;
} {
  let settle = (_value: T): void => {};
  let fail = (_error: Error): void => {};
  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { promise, settle, fail };
}

/** A lane with a hand-cranked clock and timer, so nothing here waits in real time. */
function testLane(over: { maxInFlight?: number; queueDeadlineMs?: number; hosted?: boolean } = {}) {
  let clock = 1_000;
  const timers: { at: number; fire: () => void }[] = [];
  const lane = createTransportLane({
    hosted: over.hosted,
    maxInFlight: over.maxInFlight ?? 2,
    queueDeadlineMs: over.queueDeadlineMs ?? 20_000,
    now: () => clock,
    setTimeout: (handler, ms) => {
      const timer = { at: clock + ms, fire: handler };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (handle) => {
      const index = timers.indexOf(handle as { at: number; fire: () => void });
      if (index >= 0) timers.splice(index, 1);
    },
  });
  return {
    lane,
    advance(ms: number) {
      clock += ms;
      for (const timer of [...timers]) {
        if (timer.at <= clock && timers.includes(timer)) {
          timers.splice(timers.indexOf(timer), 1);
          timer.fire();
        }
      }
    },
  };
}

// --- the cap -----------------------------------------------------------------

test("a pilot with a backlog yields to another pilot of equal priority", async () => {
  const { lane } = testLane({ hosted: true, maxInFlight: 1 });
  const held = deferred();
  const first = lane.run("read", "/held", () => held.promise);
  const order: string[] = [];
  const ask = (pilot: string) => lane.run("read", "/fleet", async () => { order.push(pilot); }, { pilot });
  const backlog = Array.from({ length: 30 }, () => ask("busy"));
  const last = ask("quiet");
  held.settle();
  await Promise.all([first, ...backlog, last]);
  assert.deepEqual(order.slice(0, 3), ["busy", "quiet", "busy"]);
});

test("a hosted queue timeout identifies active routes without exposing query parameters", async () => {
  const { lane, advance } = testLane({ hosted: true, maxInFlight: 1 });
  const held = deferred();
  const first = lane.run("poll", "/snapshot?token=private", () => held.promise);
  const next = lane.run("user", "/command", async () => assert.fail("expired command dispatched"));
  advance(20_000);
  await assert.rejects(next, (error: Error) => {
    assert.match(error.message, /hosted request slot.*Active routes: \/snapshot\./);
    assert.doesNotMatch(error.message, /private|browser|connection/);
    return true;
  });
  held.settle();
  await first;
  assert.equal(lane.queued(), 0);
});

test("no more requests are outstanding than the cap allows", async () => {
  // ⚠ The property the whole module exists for. Beyond the browser's ~6 per
  // origin, requests do not fail — they queue INSIDE the browser, invisibly, and
  // the server never hears about them.
  const { lane } = testLane({ maxInFlight: 2 });
  const held = [deferred(), deferred(), deferred(), deferred()];
  const runs = held.map((task, index) => lane.run("read", `/p${index}`, () => task.promise));
  await Promise.resolve();

  assert.equal(lane.inFlight(), 2, "the cap was exceeded");
  assert.equal(lane.queued(), 2, "the rest must wait in OUR queue, where we can see them");

  held[0]?.settle();
  held[1]?.settle();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(lane.inFlight(), 2, "a freed lane must be refilled");

  held[2]?.settle();
  held[3]?.settle();
  await Promise.all(runs);
});

test("a lane is freed even when the request FAILS", async () => {
  // ⚠ Otherwise the first network blip permanently narrows the lane, and enough
  // of them wedge the client shut — a far worse failure than the one this fixes.
  const { lane } = testLane({ maxInFlight: 1 });
  const first = deferred();
  const failing = lane.run("read", "/boom", () => first.promise);
  first.fail(new Error("dropped"));
  await assert.rejects(failing);
  assert.equal(lane.inFlight(), 0);

  const second = deferred();
  const ok = lane.run("read", "/fine", () => second.promise);
  await Promise.resolve();
  assert.equal(lane.inFlight(), 1, "the lane never came back");
  second.settle();
  await ok;
});

test("the task's own clock starts when it gets a lane, not when it was asked for", async () => {
  // ⚠ A queued request whose deadline had already been running would arrive at
  // the server with its budget spent — timing out against a server that answered
  // perfectly promptly.
  const { lane, advance } = testLane({ maxInFlight: 1 });
  const blocker = deferred();
  const blocking = lane.run("read", "/slow", () => blocker.promise);

  let startedAt = 0;
  let clockAtStart = -1;
  const queued = lane.run("read", "/queued", () => {
    startedAt += 1;
    clockAtStart = lane.inFlight();
    return Promise.resolve("done");
  });

  advance(10_000);
  assert.equal(startedAt, 0, "it must not have started while the lane was full");
  blocker.settle();
  await blocking;
  assert.equal(await queued, "done");
  assert.equal(startedAt, 1);
  assert.equal(clockAtStart, 1, "and it runs holding a lane of its own");
});

// --- priority ----------------------------------------------------------------

test("what the PLAYER did goes before background polling", async () => {
  // The one request whose latency a person can feel. Without this it waits
  // behind whatever polls happened to be in the lane when they clicked.
  const { lane } = testLane({ maxInFlight: 1 });
  const blocker = deferred();
  const blocking = lane.run("poll", "/blocking-poll", () => blocker.promise);

  const order: string[] = [];
  const pollRun = lane.run("poll", "/poll", () => {
    order.push("poll");
    return Promise.resolve();
  });
  const readRun = lane.run("read", "/read", () => {
    order.push("read");
    return Promise.resolve();
  });
  const userRun = lane.run("user", "/user", () => {
    order.push("user");
    return Promise.resolve();
  });

  blocker.settle();
  await Promise.all([blocking, pollRun, readRun, userRun]);
  assert.deepEqual(order, ["user", "read", "poll"], "priority was not honoured");
});

test("equal priorities keep their arrival order", async () => {
  // Otherwise a poll can be starved indefinitely by its own siblings.
  const { lane } = testLane({ maxInFlight: 1 });
  const blocker = deferred();
  const blocking = lane.run("read", "/blocking", () => blocker.promise);
  const order: string[] = [];
  const runs = ["a", "b", "c"].map((name) =>
    lane.run("read", `/${name}`, () => {
      order.push(name);
      return Promise.resolve();
    }),
  );
  blocker.settle();
  await Promise.all([blocking, ...runs]);
  assert.deepEqual(order, ["a", "b", "c"]);
});

// --- giving up on the queue --------------------------------------------------

test("a request that never gets a lane fails as a QUEUE error, not a timeout", async () => {
  // ⚠ The distinction the original field report could not make. "The server did
  // not answer" and "we never got a connection to ask on" are different faults
  // with different fixes, and the second one leaves NOTHING in any server log.
  const { lane, advance } = testLane({ maxInFlight: 1, queueDeadlineMs: 20_000 });
  const blocker = deferred();
  const blocking = lane.run("read", "/blocking", () => blocker.promise);
  const starved = lane.run("read", "/starved", () => Promise.resolve());

  advance(20_000);
  const error = await starved.then(
    () => null,
    (cause: unknown) => cause,
  );
  assert.ok(error instanceof TransportQueueError, `got ${String(error)}`);
  assert.match(error.message, /never got a connection/);
  assert.match(error.message, /waited 20s/);

  blocker.settle();
  await blocking;
});

test("giving up REMOVES it from the queue, so it cannot run later", async () => {
  // A ghost entry would start a request whose caller stopped listening 20s ago,
  // and would hold a lane doing it.
  const { lane, advance } = testLane({ maxInFlight: 1, queueDeadlineMs: 5_000 });
  const blocker = deferred();
  const blocking = lane.run("read", "/blocking", () => blocker.promise);
  let ran = false;
  const starved = lane.run("read", "/starved", () => {
    ran = true;
    return Promise.resolve();
  });
  advance(5_000);
  await assert.rejects(starved);
  assert.equal(lane.queued(), 0);

  blocker.settle();
  await blocking;
  await Promise.resolve();
  assert.equal(ran, false, "an abandoned request ran anyway");
});

test("a request that gets a lane immediately is never subject to the queue deadline", async () => {
  const { lane, advance } = testLane({ maxInFlight: 2, queueDeadlineMs: 1_000 });
  const held = deferred();
  const run = lane.run("read", "/slow-but-sent", () => held.promise);
  advance(60_000);
  held.settle();
  await run;
});

// --- the evidence ------------------------------------------------------------

test("a jammed lane says so, and says the failed request is a BYSTANDER", async () => {
  // ⚠ The sentence this module exists to produce. A field report naming the
  // request that failed sends everyone to read the wrong route; what matters is
  // that everything was stuck behind a server that stopped answering.
  const { lane, advance } = testLane({ maxInFlight: 2 });
  const held = [deferred(), deferred()];
  const runs = held.map((task, index) => lane.run("read", `/p${index}`, () => task.promise));
  await Promise.resolve();
  advance(30_000);

  const diagnosis = lane.diagnose();
  assert.equal(diagnosis.inFlight, 2);
  assert.equal(diagnosis.oldestOutstandingMs, 30_000);
  assert.match(diagnosis.verdict, /lanes were busy/);
  assert.match(diagnosis.verdict, /30s/);
  assert.match(diagnosis.verdict, /whatever they asked for/);

  held.forEach((task) => task.settle());
  await Promise.all(runs);
});

test("a quiet lane blames the CONNECTION, not the server being busy", async () => {
  // One failed request with nothing else outstanding is a different fault, and
  // saying "the server is overloaded" about it would be a lie.
  const { lane } = testLane({ maxInFlight: 2 });
  const diagnosis = lane.diagnose();
  assert.equal(diagnosis.inFlight, 0);
  assert.match(diagnosis.verdict, /connection itself failed/);
});

test("busy but MOVING is not reported as a stall", async () => {
  // A full lane is normal when a panel opens. Only age makes it evidence.
  const { lane, advance } = testLane({ maxInFlight: 2 });
  const held = [deferred(), deferred()];
  const runs = held.map((task, index) => lane.run("read", `/p${index}`, () => task.promise));
  await Promise.resolve();
  advance(200);

  assert.match(lane.diagnose().verdict, /each was moving/);
  held.forEach((task) => task.settle());
  await Promise.all(runs);
});

test("the queue error carries the diagnosis with it", async () => {
  const { lane, advance } = testLane({ maxInFlight: 1, queueDeadlineMs: 9_000 });
  const blocker = deferred();
  const blocking = lane.run("read", "/blocking", () => blocker.promise);
  const starved = lane.run("read", "/starved", () => Promise.resolve());
  advance(9_000);
  const error = (await starved.catch((cause: unknown) => cause)) as TransportQueueError;
  assert.equal(error.diagnosis.inFlight, 1);
  assert.ok(error.diagnosis.oldestOutstandingMs >= 9_000);
  blocker.settle();
  await blocking;
});

test("the shipped cap leaves room for the event stream and the page's own assets", () => {
  // ⚠ Sitting at the browser's ~6 would mean the first thing to overflow is
  // something we do not control: the EventSource that pins one socket for its
  // whole life, or an icon the page needs. The margin is the point.
  assert.ok(MAX_IN_FLIGHT < 6, `${MAX_IN_FLIGHT} leaves no margin`);
  assert.ok(MAX_IN_FLIGHT >= 3, "too few lanes would serialise the client");
});

test("a free lane dispatches SYNCHRONOUSLY, in the calling tick", () => {
  // ⚠ Found by an unrelated test, not by design. Routing every call through the
  // queue puts a microtask between it and its own `fetch`, so a caller that
  // fires a request without awaiting it has NOT started one by the time it
  // returns. That is a behaviour change for the whole client in the common case,
  // bought for nothing: when a lane is free there is nothing to wait for.
  const { lane } = testLane({ maxInFlight: 2 });
  let started = false;
  void lane.run("read", "/immediate", () => {
    started = true;
    return Promise.resolve();
  });
  assert.equal(started, true, "the request had not been issued when run() returned");
});

test("a request that has to QUEUE does not dispatch early", () => {
  const { lane } = testLane({ maxInFlight: 1 });
  const blocker = deferred();
  void lane.run("read", "/blocking", () => blocker.promise);
  let started = false;
  void lane.run("read", "/queued", () => {
    started = true;
    return Promise.resolve();
  });
  assert.equal(started, false, "it jumped the queue");
  blocker.settle();
});

test("a queue that has formed is not jumped by a later caller", () => {
  // ⚠ The fast path checks that NOTHING is waiting, not merely that a lane is
  // free. Without that, a request arriving in the instant a lane frees would
  // overtake everything already queued — including, eventually, for ever.
  const { lane } = testLane({ maxInFlight: 1 });
  const blocker = deferred();
  void lane.run("read", "/blocking", () => blocker.promise);
  void lane.run("read", "/first-in-line", () => Promise.resolve());
  let jumped = false;
  void lane.run("read", "/late", () => {
    jumped = true;
    return Promise.resolve();
  });
  assert.equal(jumped, false);
  assert.equal(lane.queued(), 2);
  blocker.settle();
});

// --- what goes on the socket -------------------------------------------------
//
// The cap is for the browser's connections. A request carried on the tab's socket (app/socketFetch.ts) uses none
// of them, however many are outstanding, so it holds no lane and waits for none.

test("a request carried on the socket is started at once, holds no lane, and waits behind nothing", async () => {
  const { lane } = testLane({ maxInFlight: 2 });
  // Both lanes held, and one more waiting for one.
  const held = [deferred(), deferred(), deferred()];
  const runs = held.map((task, index) => lane.run("read", `/http${index}`, () => task.promise));
  await Promise.resolve();
  assert.deepEqual([lane.inFlight(), lane.queued(), lane.carried()], [2, 1, 0]);

  // Eight on the socket, asked while every lane is busy: each is started in the tick it is asked.
  const started: number[] = [];
  const carriedTasks = Array.from({ length: 8 }, () => deferred<string>());
  const carriedRuns = carriedTasks.map((task, index) => lane.run("poll", `/socket${index}`, () => { started.push(index); return task.promise; }, { carried: true }));
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6, 7], "started without a microtask between the asking and the task");
  assert.deepEqual([lane.inFlight(), lane.queued(), lane.carried()], [2, 1, 8], "and nothing of the lanes was touched");

  // They are answered as they are answered, and counted down as they settle.
  carriedTasks[3]!.settle("three");
  assert.equal(await carriedRuns[3], "three");
  assert.equal(lane.carried(), 7);
  carriedTasks[0]!.fail(new Error("refused"));
  await assert.rejects(carriedRuns[0]!, /refused/);
  assert.equal(lane.carried(), 6);
  // What waits for a lane is still waiting for a lane: a carried one settling hands none on.
  assert.deepEqual([lane.inFlight(), lane.queued()], [2, 1]);
  held[0]!.settle();
  await runs[0];
  await Promise.resolve();
  assert.deepEqual([lane.inFlight(), lane.queued()], [2, 0]);
  for (const task of [...held.slice(1), ...carriedTasks]) task.settle(undefined as never);
  await Promise.allSettled([...runs, ...carriedRuns]);
  assert.deepEqual([lane.inFlight(), lane.queued(), lane.carried()], [0, 0, 0]);
});

test("a carried request that cannot even be started fails, and is not left counted", async () => {
  const { lane } = testLane();
  await assert.rejects(lane.run("read", "/socket", () => { throw new Error("could not be asked"); }, { carried: true }), /could not be asked/);
  assert.equal(lane.carried(), 0);
  // Said not to be carried, or not said: it takes a lane like any other.
  const task = deferred();
  const plain = lane.run("read", "/http", () => task.promise, { carried: false });
  const unsaid = lane.run("read", "/http", () => task.promise, {});
  assert.deepEqual([lane.inFlight(), lane.carried()], [2, 0]);
  task.settle();
  await Promise.all([plain, unsaid]);
});
