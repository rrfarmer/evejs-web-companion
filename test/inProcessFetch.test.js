"use strict";

// A fetch that asks the BFF from inside its own process (src/inProcessFetch.js): what the hosted bots are given
// in place of loopback HTTP.
//
// What has to hold: whoever asks cannot tell which way a request went. So each thing is asked both ways here,
// with the world's fetch over HTTP and with this one in process, of the same app, and the answers set side by
// side.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { once } = require("node:events");
const express = require("express");

process.env.EVEJS_WEB_POC_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "in-process-fetch-"));
const { createInProcessFetch, hostedBotReach } = require("../src/inProcessFetch");
const { dispatchInProcess } = require("../src/pilotSocket");
const { createHostedEventSource } = require("../web/src/app/hostedEventSource.ts");

const TOKEN = "a-web-session-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const JSON_BODY = { "content-type": "application/json" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test_, waitMs = 2000) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const found = test_();
    if (found !== undefined && found !== null && found !== false) return found;
    if (Date.now() >= deadline) return null;
    await sleep(5);
  }
}

/** A small app with the shapes the BFF's routes have, and an event stream of the BFF's shape. */
function smallApp() {
  const app = express();
  const seen = [];
  const listeners = new Set();
  const state = { refuse: false, closes: 0 };
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1kb" }));
  const requireAuth = (req, res, next) => {
    // The event stream alone may be asked with its token in the address, as the BFF's is.
    const offered = req.headers.authorization || (req.path === "/api/bridge/events" && req.query.access_token ? `Bearer ${req.query.access_token}` : "");
    if (offered !== AUTH.authorization) {
      res.status(401).json({ ok: false, error: "AUTH_REQUIRED" });
      return;
    }
    next();
  };
  app.get("/api/echo", requireAuth, (req, res) => {
    seen.push(`GET ${req.originalUrl}`);
    res.set("x-odd", "kept").json({ ok: true, query: req.query, from: req.ip, claim: req.headers["x-evejs-bot-claim"] ?? null });
  });
  app.post("/api/echo", requireAuth, (req, res) => {
    seen.push(`POST ${req.originalUrl}`);
    res.status(201).json({ ok: true, got: req.body, type: req.headers["content-type"] ?? null });
  });
  app.post("/api/slow", requireAuth, async (req, res) => {
    await sleep(60);
    seen.push("POST /api/slow done");
    res.json({ ok: true, slow: true });
  });
  app.get("/api/throws", requireAuth, () => {
    throw Object.assign(new Error("The route's own refusal."), { code: "CALL_REFUSED", statusCode: 409 });
  });
  app.get("/api/text", (req, res) => res.type("text/plain").send("not json"));
  app.get("/api/bytes", (req, res) => res.type("application/octet-stream").send(Buffer.from([0, 255, 1, 254])));
  app.post("/api/nothing", (req, res) => res.status(204).end());
  app.get("/api/cookies", (req, res) => res.append("set-cookie", "a=1; Path=/").append("set-cookie", "b=2; Path=/").json({ ok: true }));
  // A status no Response can be made with.
  app.get("/api/odd-status", (req, res) => res.status(600).json({ ok: false }));
  app.get("/api/bridge/events", requireAuth, (req, res) => {
    if (state.refuse) {
      res.status(409).json({ ok: false, error: "NO_LIVE_SESSION" });
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
    res.write(": open\n\n");
    listeners.add(res);
    req.on("close", () => {
      state.closes += 1;
      listeners.delete(res);
    });
  });
  app.get("/elsewhere", (req, res) => res.json({ ok: true, page: true }));
  app.use((error, req, res, next) => {
    void next;
    const status = Number.isFinite(error && (error.statusCode ?? error.status)) ? error.statusCode ?? error.status : 500;
    res.status(status).json({ ok: false, error: error.code || error.type || "SERVER_ERROR", message: error.message });
  });
  return {
    app, seen, listeners, state,
    publish: (frame) => { for (const res of listeners) res.write(`data: ${JSON.stringify(frame)}\n\n`); },
    endAll: () => { for (const res of [...listeners]) { listeners.delete(res); res.end(); } },
  };
}

async function served(t) {
  const made = smallApp();
  const server = http.createServer(made.app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const elsewhere = [];
  const inProcess = createInProcessFetch(made.app, {
    baseUrl: base,
    fetch: async (input, init) => {
      elsewhere.push([input, init]);
      return new Response("from elsewhere", { status: 299 });
    },
  });
  return { ...made, base, inProcess, elsewhere, server };
}

/** What an asker reads of an answer: its status, whether it is "ok", what kind of thing it is, and all of it. */
async function read(response) {
  return {
    status: response.status,
    ok: response.ok,
    type: response.headers.get("content-type"),
    odd: response.headers.get("x-odd"),
    cookies: response.headers.getSetCookie(),
    bytes: [...new Uint8Array(await response.arrayBuffer())],
  };
}

// ── a request ────────────────────────────────────────────────────────────────

test("a request asked in process is answered as it is over HTTP: the status, the headers the asker reads and the body, for each shape of route", async (t) => {
  const h = await served(t);
  const big = JSON.stringify({ pad: "x".repeat(2000) });
  const cases = [
    ["a read, with its query", "/api/echo?a=1&b=two", { headers: AUTH }],
    ["a read with the host's own header on it", "/api/echo", { headers: { ...AUTH, "x-evejs-bot-claim": "the-claim" } }],
    ["headers given as Headers", "/api/echo", { headers: new Headers(AUTH) }],
    ["a write with a body", "/api/echo", { method: "POST", headers: { ...AUTH, ...JSON_BODY }, body: JSON.stringify({ characterID: 140000002, confirm: true }) }],
    ["a method in small letters", "/api/echo", { method: "post", headers: { ...AUTH, ...JSON_BODY }, body: "{}" }],
    ["a body the asker did not say the kind of", "/api/echo", { method: "POST", headers: AUTH, body: JSON.stringify({ unread: true }) }],
    ["a body that is no JSON, said to be", "/api/echo", { method: "POST", headers: { ...AUTH, ...JSON_BODY }, body: "{not json" }],
    ["a body over the app's limit", "/api/echo", { method: "POST", headers: { ...AUTH, ...JSON_BODY }, body: big }],
    ["nobody's token", "/api/echo", { headers: { authorization: "Bearer nobody's" } }],
    ["no token", "/api/echo", {}],
    ["a route that throws", "/api/throws", { headers: AUTH }],
    ["an answer that is text", "/api/text", {}],
    ["an answer that is bytes", "/api/bytes", {}],
    ["an answer with nothing in it", "/api/nothing", { method: "POST" }],
    ["an answer with a header said twice", "/api/cookies", {}],
  ];
  for (const [what, route, init] of cases) {
    const before = h.seen.length;
    const overHttp = await read(await fetch(`${h.base}${route}`, init));
    const reached = h.seen.slice(before);
    const inProcess = await read(await h.inProcess(`${h.base}${route}`, init));
    assert.deepEqual(inProcess, overHttp, what);
    assert.deepEqual(h.seen.slice(before + reached.length), reached, `${what}: the same route was reached`);
  }
  // The one answer that is not the same, and it is no route's: a path no route has is refused with 404 both
  // ways, by the app's own last page over HTTP and by the BFF's refusal in process, as on the tab's socket.
  const noRouteOverHttp = await fetch(`${h.base}/api/no-such-route`, { headers: AUTH });
  const noRouteInProcess = await h.inProcess(`${h.base}/api/no-such-route`, { headers: AUTH });
  assert.deepEqual([noRouteOverHttp.status, noRouteInProcess.status], [404, 404]);
  assert.match(await noRouteOverHttp.text(), /Cannot GET \/api\/no-such-route/);
  assert.deepEqual(await noRouteInProcess.json(), { ok: false, error: "NOT_FOUND" });
  // What the routes were handed, read back from two of the answers.
  const echoed = await (await h.inProcess(`${h.base}/api/echo?a=1`, { headers: { ...AUTH, "x-evejs-bot-claim": "the-claim" } })).json();
  assert.deepEqual(echoed, { ok: true, query: { a: "1" }, from: "127.0.0.1", claim: "the-claim" });
  const written = await (await h.inProcess(`${h.base}/api/echo`, { method: "POST", headers: { ...AUTH, ...JSON_BODY }, body: JSON.stringify({ n: 1 }) })).json();
  assert.deepEqual(written, { ok: true, got: { n: 1 }, type: "application/json" });
  // The address given as a URL, and as a path from the BFF's own.
  assert.equal((await h.inProcess(new URL(`${h.base}/api/echo`), { headers: AUTH })).status, 200);
  assert.equal((await h.inProcess("/api/echo", { headers: AUTH })).status, 200);
  assert.equal((await h.inProcess("/api/echo")).status, 401);
  assert.deepEqual((await read(await h.inProcess("/api/cookies"))).cookies, ["a=1; Path=/", "b=2; Path=/"]);
  assert.deepEqual(h.elsewhere, []);
});

test("what is not the BFF's own API at the BFF's own address goes to the fetch given, as it was asked", async (t) => {
  const h = await served(t);
  const before = h.seen.length;
  const init = { headers: AUTH };
  const asked = [
    ["http://127.0.0.1:1/api/echo", init],
    ["https://elsewhere.example/api/echo", init],
    [`${h.base}/elsewhere`, init],
    [`${h.base}/`, undefined],
    [new Request(`${h.base}/api/echo`, init), undefined],
    [`${h.base}/api/echo`, { method: "POST", headers: AUTH, body: new URLSearchParams({ a: "1" }) }],
    [`${h.base}/api/echo`, { method: "POST", headers: AUTH, body: Buffer.from("{}") }],
    ["http://[not an address", init],
  ];
  for (const [input, given] of asked) {
    const response = given === undefined ? await h.inProcess(input) : await h.inProcess(input, given);
    assert.equal(response.status, 299, String(input));
  }
  assert.equal(h.elsewhere.length, asked.length);
  for (const [index, [input, given]] of asked.entries()) {
    assert.equal(h.elsewhere[index][0], input);
    if (given !== undefined) assert.equal(h.elsewhere[index][1], given);
  }
  assert.equal(h.seen.length, before, "none of it reached the app");
  // With no fetch given, elsewhere is the world's, as it stands when the request is made.
  const world = globalThis.fetch;
  t.after(() => { globalThis.fetch = world; });
  const plain = createInProcessFetch(h.app, { baseUrl: h.base });
  globalThis.fetch = async (input) => new Response(`the world's: ${input}`, { status: 298 });
  const answer = await plain("https://elsewhere.example/x");
  assert.deepEqual([answer.status, await answer.text()], [298, "the world's: https://elsewhere.example/x"]);
});

test("a request given up on rejects with the reason it was given up for, as a fetch does; its route is not stopped", async (t) => {
  const h = await served(t);
  // Given up on before it was asked: nothing is run.
  const gone = new AbortController();
  gone.abort(new Error("already given up on"));
  await assert.rejects(h.inProcess(`${h.base}/api/slow`, { method: "POST", headers: AUTH, signal: gone.signal }), /already given up on/);
  await sleep(90);
  assert.deepEqual(h.seen, []);
  // Given up on while its route is at work: it rejects then, and the route finishes what it was doing.
  const during = new AbortController();
  const asked = h.inProcess(`${h.base}/api/slow`, { method: "POST", headers: AUTH, signal: during.signal });
  await sleep(10);
  during.abort(new Error("given up on while waiting"));
  await assert.rejects(asked, /given up on while waiting/);
  assert.deepEqual(h.seen, []);
  assert.ok(await until(() => h.seen.includes("POST /api/slow done")));
  // Not given up on: answered, and a later abort is nothing to it.
  const kept = new AbortController();
  const answer = await h.inProcess(`${h.base}/api/slow`, { method: "POST", headers: AUTH, signal: kept.signal });
  kept.abort(new Error("too late to matter"));
  assert.deepEqual(await answer.json(), { ok: true, slow: true });
  // A signal that outlives its request is not left listened to: once answered, and once failed.
  const listening = new Set();
  const lasting = { aborted: false, reason: undefined, addEventListener: (name, listener) => listening.add(listener), removeEventListener: (name, listener) => listening.delete(listener) };
  const pending = h.inProcess(`${h.base}/api/echo`, { headers: AUTH, signal: lasting });
  assert.equal(listening.size, 1);
  assert.equal((await pending).status, 200);
  assert.equal(listening.size, 0);
  await assert.rejects(h.inProcess(`${h.base}/api/odd-status`, { signal: lasting }), TypeError);
  assert.equal(listening.size, 0);
});

test("something thrown outside of every handler is a fetch that failed, with what was thrown as its cause", async () => {
  const thrown = new Error("outside of every handler");
  const broken = createInProcessFetch(() => { throw thrown; }, { baseUrl: "http://bff.test" });
  await assert.rejects(broken("http://bff.test/api/echo"), (error) => error instanceof TypeError && error.message === "fetch failed" && error.cause === thrown);
  // An answer no Response can be made of (a status outside what one may have) is a fetch that failed too, and
  // not a request that is never answered: for a request, and for the event stream's path.
  const oddFetch = createInProcessFetch(smallApp().app, { baseUrl: "http://bff.test" });
  await assert.rejects(oddFetch("http://bff.test/api/odd-status"), (error) => error instanceof TypeError && error.message === "fetch failed" && error.cause instanceof RangeError);
  const oddStream = createInProcessFetch((req, res) => res.writeHead(600).end("{}"), { baseUrl: "http://bff.test" });
  await assert.rejects(oddStream("http://bff.test/api/bridge/events"), (error) => error instanceof TypeError && error.message === "fetch failed" && error.cause instanceof RangeError);
  // Given up on first, and then it fails: the giving up is what the asker was told, once.
  const slow = createInProcessFetch((req, res, next) => setTimeout(() => next(thrown), 30), { baseUrl: "http://bff.test" });
  const controller = new AbortController();
  const asked = slow("http://bff.test/api/echo", { signal: controller.signal });
  controller.abort(new Error("given up on"));
  await assert.rejects(asked, /given up on/);
  await sleep(60);
});

test("a body sent as it is reaches the app under the kind its headers say, read by the app's own parser", async () => {
  const { app } = smallApp();
  const ask = async (headers, rawBody) => {
    const answer = await dispatchInProcess(app, { method: "POST", path: "/api/echo", headers: { ...AUTH, ...headers }, rawBody });
    return [answer.status, JSON.parse(answer.body.toString("utf8"))];
  };
  assert.deepEqual(await ask(JSON_BODY, '{"a":1}'), [201, { ok: true, got: { a: 1 }, type: "application/json" }]);
  assert.deepEqual(await ask(JSON_BODY, Buffer.from('{"b":2}')), [201, { ok: true, got: { b: 2 }, type: "application/json" }]);
  // Not said to be JSON: the app's parser leaves it unread, as it does over HTTP.
  assert.deepEqual((await ask({ "content-type": "text/plain" }, '{"a":1}'))[1].type, "text/plain");
  assert.deepEqual((await ask({ "content-type": "text/plain" }, '{"a":1}'))[1].got ?? {}, {});
  // A body handed over as a value is still sent as JSON, whatever the headers say of it.
  const asValue = await dispatchInProcess(app, { method: "POST", path: "/api/echo", headers: { ...AUTH, "content-type": "text/plain" }, body: { c: 3 } });
  assert.deepEqual(JSON.parse(asValue.body.toString("utf8")), { ok: true, got: { c: 3 }, type: "application/json" });
});

// ── the event stream ─────────────────────────────────────────────────────────

test("the event stream asked in process is an answer whose body is read as the route writes it", async (t) => {
  const h = await served(t);
  const url = `${h.base}/api/bridge/events?access_token=${TOKEN}`;
  const response = await h.inProcess(url, { headers: { accept: "text/event-stream" } });
  assert.deepEqual([response.status, response.ok, response.headers.get("content-type")], [200, true, "text/event-stream; charset=utf-8"]);
  assert.equal(h.listeners.size, 1);
  const reader = response.body.getReader();
  const text = async () => new TextDecoder().decode((await reader.read()).value);
  assert.equal(await text(), ": open\n\n");
  h.publish({ n: 1 });
  h.publish({ n: 2 });
  assert.equal(await text(), 'data: {"n":1}\n\n');
  assert.equal(await text(), 'data: {"n":2}\n\n');
  // Whoever reads stops: the route is told its listener has gone.
  await reader.cancel();
  assert.deepEqual([h.state.closes, h.listeners.size], [1, 0]);

  // The route ends it: the body ends, and there is nothing to tell the route.
  const ended = await h.inProcess(url);
  const endedReader = ended.body.getReader();
  await endedReader.read();
  h.endAll();
  assert.deepEqual(await endedReader.read(), { done: true, value: undefined });
  assert.equal(h.state.closes, 1);

  // Given up on by its signal while open: what is being read fails with the reason, and the route is told.
  const controller = new AbortController();
  const given = await h.inProcess(url, { signal: controller.signal });
  const givenReader = given.body.getReader();
  await givenReader.read();
  const waiting = givenReader.read();
  controller.abort(new Error("the bot was stopped"));
  await assert.rejects(waiting, /the bot was stopped/);
  assert.deepEqual([h.state.closes, h.listeners.size], [2, 0]);

  // Given up on before its route has answered at all: the asking rejects, the route is told, and what the route
  // then writes is handed to nobody.
  let late = null;
  const slowStream = createInProcessFetch((req, res) => {
    req.on("close", () => { late = "told"; });
    setTimeout(() => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": open\n\n"); }, 30);
  }, { baseUrl: h.base });
  const early = new AbortController();
  const asked = slowStream(url, { signal: early.signal });
  early.abort(new Error("given up on before it opened"));
  await assert.rejects(asked, /given up on before it opened/);
  assert.equal(late, "told");
  await sleep(60);
  // A signal that outlives a stream its route ended is not left listened to.
  const listening = new Set();
  const lasting = { aborted: false, reason: undefined, addEventListener: (name, listener) => listening.add(listener), removeEventListener: (name, listener) => listening.delete(listener) };
  const closing = await h.inProcess(url, { signal: lasting });
  assert.equal(listening.size, 1);
  h.endAll();
  await closing.body.cancel();
  assert.equal(listening.size, 0);
  const closesSoFar = h.state.closes;

  // Refused: an ordinary answer, the same as over HTTP, with nothing left open.
  h.state.refuse = true;
  const refused = await h.inProcess(url);
  assert.deepEqual(await read(refused), await read(await fetch(url)));
  assert.deepEqual([refused.status, h.listeners.size, h.state.closes], [409, 0, closesSoFar]);
  assert.equal((await h.inProcess(`${h.base}/api/bridge/events`)).status, 401);
  assert.equal((await h.inProcess(`${h.base}/api/bridge/events`, { method: "POST", headers: AUTH })).status, 404);
  assert.deepEqual(h.elsewhere, []);
});

test("a hosted bot's event source reads the stream in process as it reads it over HTTP", async (t) => {
  const h = await served(t);
  const url = `${h.base}/api/bridge/events?access_token=${TOKEN}`;
  const heard = { http: [], inProcess: [] };
  const listen = (name, read_) => {
    const source = createHostedEventSource(url, { fetch: read_ });
    source.onopen = () => heard[name].push("open");
    source.onmessage = (event) => heard[name].push(event.data);
    source.onerror = () => heard[name].push("error");
    return source;
  };
  const overHttp = listen("http", fetch);
  const inProcess = listen("inProcess", h.inProcess);
  assert.ok(await until(() => h.listeners.size === 2 && heard.http.length === 1 && heard.inProcess.length === 1));
  h.publish({ source: "evejs-web-gateway", type: "event", event: { kind: "notification" } });
  h.publish({ pilot: "Пилот" });
  assert.ok(await until(() => heard.http.length === 3 && heard.inProcess.length === 3));
  assert.deepEqual(heard.inProcess, heard.http);
  assert.deepEqual(heard.inProcess, ["open", '{"source":"evejs-web-gateway","type":"event","event":{"kind":"notification"}}', '{"pilot":"Пилот"}']);
  // Stopped: the route is told for each, and neither says anything more.
  inProcess.close();
  assert.ok(await until(() => h.listeners.size === 1));
  overHttp.close();
  assert.ok(await until(() => h.listeners.size === 0));
  assert.equal(h.state.closes, 2);
  await sleep(30);
  assert.deepEqual(heard.inProcess, heard.http);
  assert.equal(heard.inProcess.length, 3);
});

// ── the setting ──────────────────────────────────────────────────────────────

test("hosted bots reach the BFF in process unless the setting says loopback, in so many letters", () => {
  assert.equal(hostedBotReach({}), "inprocess");
  assert.equal(hostedBotReach({ EVEJS_HOSTED_BOT_REACH: "" }), "inprocess");
  assert.equal(hostedBotReach({ EVEJS_HOSTED_BOT_REACH: "inprocess" }), "inprocess");
  assert.equal(hostedBotReach({ EVEJS_HOSTED_BOT_REACH: "loopback" }), "loopback");
  assert.equal(hostedBotReach({ EVEJS_HOSTED_BOT_REACH: " Loopback " }), "loopback");
  for (const bad of ["http", "in-process", "true", "0"]) {
    assert.throws(() => hostedBotReach({ EVEJS_HOSTED_BOT_REACH: bad }), new RegExp(`EVEJS_HOSTED_BOT_REACH must be "inprocess" or "loopback", not "${bad}"`));
  }
});
