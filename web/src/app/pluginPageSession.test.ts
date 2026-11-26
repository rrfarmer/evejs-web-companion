import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import test from "node:test";
import { pluginGetJson } from "./api.ts";
import {
  closePageSource, emptyPageRoster, followPageRoster, launchPluginPage, pageLaunchURL, pageLink,
  sharePageRoster, type PluginPagePilot, type PluginPageProps,
} from "./pluginPageSession.ts";
import type { Session } from "./sessions.ts";
import { getSessionToken, setSessionTokenStorage, usePluginPageAuth } from "./sessionToken.ts";

const anna = { accountName: "Anna", characterID: 1, token: "first-bearer" };
const bob = { accountName: "Bob", characterID: 2, token: "second-bearer" };

function signIn(pilots: PluginPagePilot[], active: PluginPagePilot | null) {
  const sessions = pilots.map(({ accountName, characterID, token }) => ({
    id: accountName,
    flow: { sessionToken: () => token },
    store: { get: () => ({ session: { username: accountName }, station: { online: { characterID } } }) },
  })) as unknown as Session[];
  sharePageRoster(sessions, active?.accountName ?? null);
}

function observe(id: string | null) {
  const events = new EventEmitter();
  const history: PluginPageProps[] = [];
  const close = followPageRoster(id, roster => { history.push(roster); events.emit("update", roster); });
  return { close, history, next: async () => (await once(events, "update"))[0] as PluginPageProps };
}

test("launch and refresh borrow the current roster; storage holds only the link ID", { timeout: 5000 }, async t => {
  t.after(closePageSource);
  const entries = new Map([["wc-plugin-page-sessions:v1", JSON.stringify([anna])], ["evejs_web_poc_session", anna.token]]);
  const writes: string[] = [];
  const storage = {
    getItem: (k: string) => entries.get(k) ?? null,
    setItem: (k: string, v: string) => { writes.push(v); entries.set(k, v); },
    removeItem: (k: string) => { entries.delete(k); },
  };
  setSessionTokenStorage(storage);
  usePluginPageAuth();
  signIn([anna, bob], anna);
  const url = new URL(pageLaunchURL("/dashboard/"), "https://wc.test");
  assert.doesNotMatch(url.href, /first-bearer|second-bearer/);
  const id = pageLink(url, storage, () => { url.hash = ""; });
  assert.match(id!, /^[0-9a-f]{32}$/);
  assert.equal(url.hash, "");
  const first = observe(id);
  t.after(first.close);
  const opened = await first.next();
  assert.deepEqual(opened, { sessions: [anna, bob], activeSession: anna });
  assert.deepEqual(first.history, [opened]);
  assert.equal(getSessionToken(), anna.token);
  first.close();
  signIn([bob], bob);
  const reload = observe(pageLink(url, storage, assert.fail));
  t.after(reload.close);
  assert.deepEqual(await reload.next(), { sessions: [bob], activeSession: bob });
  assert.equal(getSessionToken(), bob.token);
  assert.deepEqual([...entries], [["wc-plugin-page-launch:v1", id]]);
  assert.deepEqual(writes, [id]);
});

test("login, active cockpit, logout, fresh login and source close update the same page", { timeout: 5000 }, async t => {
  usePluginPageAuth();
  signIn([], null);
  t.after(closePageSource);
  const id = pageLaunchURL("/dashboard/").split("=")[1]!;
  const page = observe(id);
  t.after(page.close);
  assert.deepEqual(await page.next(), emptyPageRoster);
  const fresh = { ...anna, token: "fresh-bearer" };
  for (const [pilots, active] of [
    [[anna], anna], [[anna, bob], anna], [[anna, bob], bob], [[bob], bob], [[bob, fresh], fresh],
  ] as [PluginPagePilot[], PluginPagePilot][]) {
    signIn(pilots, active);
    const roster = await page.next();
    assert.deepEqual(roster, { sessions: pilots, activeSession: active });
    assert.equal(getSessionToken(), active.token);
  }
  closePageSource();
  assert.deepEqual(await page.next(), emptyPageRoster);
  assert.equal(getSessionToken(), null);
});

test("direct links start empty and page APIs omit shared cookies even for explicit pilot calls", async () => {
  usePluginPageAuth();
  const direct = observe(pageLink(new URL("https://wc.test/dashboard/"), null, assert.fail));
  assert.deepEqual(direct.history, [emptyPageRoster]);
  assert.equal(getSessionToken(), null);
  const requests: RequestInit[] = [];
  const capture: typeof fetch = async (_url, init) => {
    requests.push(init!);
    return Response.json({ ok: true });
  };
  for (const pilot of [anna, bob]) await pluginGetJson("dashboard", "/status", { fetch: capture, token: pilot.token });
  await pluginGetJson("dashboard", "/status", { fetch: capture });
  assert.deepEqual(requests.map(r => new Headers(r.headers).get("authorization")), ["Bearer first-bearer", "Bearer second-bearer", null]);
  assert.ok(requests.every(r => r.credentials === "omit"));
  direct.close();
});

test("only an ordinary primary click uses the noopener launch; modified links keep native defaults", t => {
  t.after(closePageSource);
  const opens: string[][] = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { open: (...args: string[]) => opens.push(args) } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
  let prevented = 0;
  const click = { currentTarget: { pathname: "/example/" }, button: 0, preventDefault: () => { prevented++; } };
  for (const modifier of [{ button: 1 }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { defaultPrevented: true }]) {
    assert.equal(launchPluginPage({ ...click, ...modifier } as unknown as MouseEvent), false);
  }
  assert.equal(prevented, 0);
  assert.equal(opens.length, 0);
  assert.equal(launchPluginPage(click as unknown as MouseEvent), true);
  assert.equal(prevented, 1);
  assert.equal(opens.length, 1);
  assert.match(opens[0]![0]!, /^\/example\/#wc-launch=[0-9a-f]{32}$/);
  assert.deepEqual(opens[0]!.slice(1), ["_blank", "noopener"]);
});

test("invalid channel messages never replace the session list or active pilot", { timeout: 5000 }, async t => {
  usePluginPageAuth();
  t.after(closePageSource);
  signIn([anna], anna);
  const id = pageLaunchURL("/dashboard/").split("=")[1]!;
  const channel = new BroadcastChannel("wc-plugin-page:" + id);
  t.after(() => channel.close());
  const page = observe(id);
  t.after(page.close);
  const initial = await page.next();
  for (const data of [false, {}, { sessions: {} }, { sessions: [anna, anna], activeSession: anna },
    { sessions: [{ ...bob, token: 1 }], activeSession: null }, { sessions: [null], activeSession: null },
    { sessions: [anna], activeSession: { ...anna, token: bob.token } }]) channel.postMessage(data);
  const valid = { sessions: [bob], activeSession: bob };
  channel.postMessage(valid);
  assert.deepEqual(await page.next(), valid);
  assert.deepEqual(page.history, [initial, valid]);
});

test("a lost source document lock clears the last roster without a close message", {
  skip: !navigator.locks, timeout: 5000,
}, async t => {
  usePluginPageAuth();
  const id = "a".repeat(32);
  const channel = new BroadcastChannel("wc-plugin-page:" + id);
  t.after(() => channel.close());
  const events = new EventEmitter();
  const acquired = once(events, "acquired");
  const lock = navigator.locks.request(channel.name, () => {
    events.emit("acquired");
    return once(events, "release");
  });
  t.after(() => { events.emit("release"); });
  await acquired;
  channel.onmessage = ({ data }) => {
    if (data === "read") channel.postMessage({ sessions: [bob], activeSession: bob });
  };
  const page = observe(id);
  t.after(page.close);
  assert.deepEqual((await page.next()).activeSession, bob);
  const cleared = page.next();
  events.emit("release");
  await lock;
  assert.deepEqual(await cleared, emptyPageRoster);
  assert.equal(getSessionToken(), null);
});

test("on LAN HTTP a silent source expires; the page asks for a fresh roster when contact resumes", { timeout: 5000 }, async t => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "locks");
  Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
  t.after(() => {
    if (descriptor) Object.defineProperty(navigator, "locks", descriptor);
    else Reflect.deleteProperty(navigator, "locks");
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  usePluginPageAuth();
  const id = "b".repeat(32);
  const source = new BroadcastChannel("wc-plugin-page:" + id);
  t.after(() => source.close());
  let pilot = anna;
  source.onmessage = ({ data }) => {
    if (data === "read") source.postMessage({ sessions: [pilot], activeSession: pilot });
  };
  const page = observe(id);
  t.after(page.close);
  assert.deepEqual((await page.next()).activeSession, anna);
  const expired = page.next();
  t.mock.timers.tick(90_000);
  assert.deepEqual(await expired, emptyPageRoster);
  assert.equal(getSessionToken(), null);
  pilot = bob;
  source.postMessage("present");
  assert.deepEqual((await page.next()).activeSession, bob);
  page.close();
  source.close();
  const reload = observe(id);
  t.after(reload.close);
  const unlinked = reload.next();
  t.mock.timers.tick(3000);
  assert.deepEqual(await unlinked, emptyPageRoster);
  assert.equal(getSessionToken(), null);
});
