import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import type { Component } from "svelte";
import { render } from "svelte/server";
import { definePlugin, definePluginViews } from "../plugin-api/index.ts";
import { isGlobalTab, pluginPageAt, pluginWindowGroups } from "../ui/globalWindow.ts";
import { meetPlugins, pluginLaunchers, togglePlugin, type PinState } from "../ui/pluginPins.ts";
import { activatePagePlugins, pluginProblem } from "./pluginHost.ts";

register("../ui/svelteSsrHook.ts", import.meta.url);

const component: Component = () => ({});
const pageView = async () => ({ default: component });
const makeManifest = (id: string, label: string) => ({
  id, label, name: label, apiVersion: 1, version: "1.0.0", description: label,
});

test("a standalone page uses the third existing pin slot and renders a new-tab link", async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const pins: PinState = {
    pins: [{ kind: "plugin", pluginID: "first" }, { kind: "plugin", pluginID: "second" }],
    seen: ["first", "second"],
  };
  const values = new Map([
    ["evejs-web-plugin-pins:v1", JSON.stringify(pins)],
    ["evejs-web-plugins-disabled:v1", JSON.stringify(["disabled-page"])],
  ]);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });

  const windows = ["first", "second"].map((id) => ({
    id,
    window: { id: `plugin:${id}` as const, label: id, title: id, hint: id, glyph: [] },
  }));
  const dashboard = definePlugin({
    ...makeManifest("dashboard", "Dashboard"),
    page: {},
  });
  const statuses = await activatePagePlugins([
    ...windows.map(({ id, window }) => ({ id, load: async () => ({ default: definePlugin({ ...makeManifest(id, id), windows: [window] }) }) })),
    { id: dashboard.id, load: async () => ({ default: dashboard }) },
    { id: "disabled-page", load: async () => { throw new Error("Disabled plugin loaded"); } },
  ], [
    ...windows.map(({ id, window }) => ({ id, load: async () => ({ default: definePluginViews({ id, windows: { [window.id]: component } }) }) })),
    { id: dashboard.id, load: async () => ({ default: definePluginViews({ id: dashboard.id, windows: {}, page: pageView }) }) },
  ]);
  assert.deepEqual(statuses.map(({ state }) => state), ["active", "active", "active", "disabled"]);
  for (const path of ["/dashboard", "/dashboard/", "/dashboard/section/"]) {
    assert.equal((await pluginPageAt(path)?.load())?.default, component);
  }
  assert.equal(pluginPageAt("/dashboard-other/"), undefined);
  assert.equal(pluginPageAt("/disabled-page/"), undefined);
  assert.equal(isGlobalTab("plugin:dashboard"), false);
  assert.equal(isGlobalTab("plugin:first"), true);

  const groups = pluginWindowGroups();
  const seen = meetPlugins(pins, groups);
  const launchers = pluginLaunchers(seen, groups, new Set());
  assert.deepEqual(launchers.map(({ kind }) => kind), ["window", "window", "page"]);
  assert.equal(launchers[2]?.pageHref, "/dashboard/");
  const group = groups.find(({ plugin }) => plugin.id === dashboard.id)!;
  assert.deepEqual(group.windows, []);
  const unpinned = togglePlugin(seen, group);
  assert.equal(meetPlugins(unpinned, groups), unpinned);
  assert.equal(pluginLaunchers(unpinned, groups, new Set()).length, 2);

  const GlobalLaunchers = (await import("../ui/GlobalLaunchers.svelte")).default;
  const html = render(GlobalLaunchers, { props: { openIds: new Set(), onOpen() {} } }).body;
  assert.match(html, /<a[^>]+data-launch="plugin:dashboard"[^>]+href="\/dashboard\/"[^>]+target="_blank"[^>]+rel="noopener"/);
  assert.match(html, /<button[^>]+data-launch="window:plugin:first"/);
  assert.match(html, /data-launch="window:plugin:second".*data-launch="plugin:dashboard".*data-launch="plugins"/s);
  assert.match(html, /<button[^>]+data-launch="botManager"/);
  assert.match(html, /<button[^>]+data-launch="industryManager"/);
});

test("a page requires a browser view; the backend can load the same manifest without Svelte", () => {
  const manifest = definePlugin({ ...makeManifest("other-dashboard", "Other dashboard"), page: {} });
  assert.equal(pluginProblem(manifest, null), null);
  assert.match(pluginProblem(manifest, { id: manifest.id, windows: {} }) ?? "", /page has nothing to draw/);
});

test("reserved core paths and a page without a manifest are refused", () => {
  for (const id of ["api", "assets", "dist", "icon-cache", "goblin-factory", "pilot-training", "ship-provisioning", "mining-command-center"]) {
    assert.match(pluginProblem({ ...makeManifest(id, id), page: {} }, null) ?? "", /belongs to Web Companion/);
  }
  assert.match(pluginProblem(makeManifest("example", "Example"), { id: "example", windows: {}, page: pageView }) ?? "", /no manifest/);
});

test("noopener launches keep both pilot tokens, active account and reload isolated from a fresh link", async () => {
  const { pageContext, pageLaunchURL } = await import("../app/pluginPageSession.ts");
  const { getSessionToken } = await import("../app/sessionToken.ts");
  const sessions = ["one", "two"].map((accountName, i) => ({ accountName, characterID: i + 1, token: accountName + "-token" }));
  const retained = new Map<string, string>();
  const storage = { getItem: (k: string) => retained.get(k) ?? null, setItem: (k: string, v: string) => { retained.set(k, v); } };
  const url = new URL(pageLaunchURL("/dashboard/", { sessions, activeSession: sessions[0]! }), "https://wc.test");
  assert.doesNotMatch(url.href, /one|two|token/);
  const opened = await pageContext(url, storage, () => { url.hash = ""; });
  assert.deepEqual(opened.sessions, sessions);
  assert.equal(getSessionToken(), "one-token");
  assert.equal(url.hash, "");
  assert.deepEqual(await pageContext(url, storage, assert.fail), opened);
  const direct = await pageContext(url, { ...storage, getItem: () => null }, assert.fail);
  assert.deepEqual(direct, { sessions: [], activeSession: null });
  assert.equal(getSessionToken(), null);
  const { disableCookieFallback } = await import("../app/sessionToken.ts");
  const { pluginGetJson } = await import("../app/api.ts");
  disableCookieFallback();
  const requests: RequestInit[] = [];
  const capture = async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests.push(init!);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  for (const pilot of opened.sessions) await pluginGetJson("dashboard", "/status", { fetch: capture, token: pilot.token });
  await pluginGetJson("dashboard", "/status", { fetch: capture });
  assert.deepEqual(requests.map(r => new Headers(r.headers).get("authorization")), ["Bearer one-token", "Bearer two-token", null]);
  assert.ok(requests.every(r => r.credentials === "omit"));
});
