import assert from "node:assert/strict";
import { register, registerHooks } from "node:module";
import test from "node:test";
import { render } from "svelte/server";
import { PLUGINS } from "../../index.ts";
import { PLUGIN_VIEWS } from "../../views.ts";
import { isGlobalTab, pluginPageAt, pluginWindowGroups } from "../../../web/src/ui/globalWindow.ts";
import { pinStore } from "../../../web/src/ui/pluginPinStore.ts";
import { meetPlugins, pluginLaunchers, togglePlugin, type PinState } from "../../../web/src/ui/pluginPins.ts";
import { activatePagePlugins } from "../../../web/src/plugins/pluginHost.ts";

register("../../../web/src/ui/svelteSsrHook.ts", import.meta.url);

test("UOC only appears as a plugin launcher and legacy links stay absent in both states", async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const windowPlugins = ["pi-manager", "fleet-companion"];
  const pins: PinState = {
    pins: windowPlugins.map((pluginID) => ({ kind: "plugin", pluginID })),
    seen: windowPlugins,
  };
  const disabledKey = "evejs-web-plugins-disabled:v1";
  const values = new Map([
    ["evejs-web-plugin-pins:v1", JSON.stringify(pins)],
    [disabledKey, JSON.stringify(["uoc"])],
  ]);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });

  const Hangar = (await import("../../../web/src/ui/PilotHangar.svelte")).default;
  const renderHangar = () => render(Hangar, {
    props: { onlineIDs: new Set<number>(), onLaunch: async () => {}, onShowPilot() {}, onOpenGlobal() {} },
  }).body;
  const legacy = /href="\/(?:mining-command-center|pilot-training|goblin-factory|ship-provisioning|courier|distribution-center|combat-operations-center)(?:["/?#])/;

  const disabled = await activatePagePlugins(PLUGINS, PLUGIN_VIEWS);
  assert.deepEqual(disabled.map(({ id, state }) => [id, state]), [
    ["pi-manager", "active"], ["fleet-companion", "active"], ["uoc", "disabled"],
  ]);
  assert.equal(pluginPageAt("/uoc/"), undefined);
  const otherLaunchers = pluginLaunchers(pins, pluginWindowGroups(), new Set()).map(({ key }) => key);
  assert.equal(otherLaunchers.length, 2);
  const withoutUoc = renderHangar();
  assert.doesNotMatch(withoutUoc, legacy);
  assert.doesNotMatch(withoutUoc, /data-launch="plugin:uoc"/);

  values.set(disabledKey, "[]");
  const [enabled] = await activatePagePlugins(
    PLUGINS.filter(({ id }) => id === "uoc"),
    PLUGIN_VIEWS.filter(({ id }) => id === "uoc"),
  );
  assert.equal(enabled?.state, "active");
  const page = pluginPageAt("/uoc/");
  assert.ok(page);
  assert.equal(pluginPageAt("/uoc/distribution-center/"), page);
  assert.equal(pluginPageAt("/uoc-other/"), undefined);
  assert.equal(isGlobalTab("plugin:uoc"), false);

  const groups = pluginWindowGroups();
  const seen = meetPlugins(pins, groups);
  const launchers = pluginLaunchers(seen, groups, new Set());
  assert.deepEqual(launchers.map(({ key }) => key), [...otherLaunchers, "plugin:uoc"]);
  assert.equal(launchers[2]?.kind, "page");
  const group = groups.find(({ plugin }) => plugin.id === "uoc")!;
  assert.deepEqual(group.windows, []);
  const unpinned = togglePlugin(seen, group);
  assert.equal(meetPlugins(unpinned, groups), unpinned);
  assert.deepEqual(pluginLaunchers(unpinned, groups, new Set()).map(({ key }) => key), otherLaunchers);

  // The browser creates this store again on reload. Use the same pin reducer in this test process.
  pinStore().set(seen);
  const withUoc = renderHangar();
  assert.doesNotMatch(withUoc, legacy);
  assert.match(withUoc, /<a[^>]+data-launch="plugin:uoc"[^>]+href="\/uoc\/"[^>]+target="_blank"[^>]+rel="noopener"/);
  for (const html of [withoutUoc, withUoc]) {
    for (const key of ["botManager", "industryManager", ...otherLaunchers, "plugins"]) {
      assert.ok(html.includes(`data-launch="${key}"`), key);
    }
  }
  const order = [...otherLaunchers, "plugin:uoc", "plugins"].map((key) => withUoc.indexOf(`data-launch="${key}"`));
  assert.deepEqual(order, [...order].sort((left, right) => left - right));
});


test("the stock page loader renders UOC and passes the linked account directory", async (t) => {
  const styles = registerHooks({
    load(url, context, next) {
      return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context);
    },
  });
  t.after(() => styles.deregister());
  const locationProperty = Object.getOwnPropertyDescriptor(globalThis, "location");
  t.after(() => {
    if (locationProperty) Object.defineProperty(globalThis, "location", locationProperty);
    else Reflect.deleteProperty(globalThis, "location");
  });

  const { installPageContext, workspaceAccounts } = await import("../restored/app/context.ts");
  t.after(() => installPageContext({}));
  const sessions = [
    { accountName: "RosterOne", characterID: 31, token: "fixture-one" },
    { accountName: "RosterTwo", characterID: 32, token: "fixture-two" },
  ];
  for (const [path, text] of [
    ["/uoc/", "Unified Operations Center"],
    ["/uoc/distribution-center/", "Distribution Center"],
  ] as const) {
    Object.defineProperty(globalThis, "location", { configurable: true, value: new URL(path, "http://fixture") });
    const page = pluginPageAt(path);
    assert.ok(page);
    const { default: Page } = await page.load();
    const html = render(Page, { props: { sessions, activeSession: sessions[1]! } }).body;
    assert.ok(html.includes(text));
    assert.doesNotMatch(html, /fixture-one|fixture-two/);
    assert.deepEqual(workspaceAccounts(), ["RosterTwo", "RosterOne"]);
    const direct = render(Page, { props: { sessions: [], activeSession: null } }).body;
    assert.ok(direct.includes(text));
    assert.deepEqual(workspaceAccounts(), []);
  }
});
