import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { createCockpitProvisioningLifecycle, type CockpitProvisioningContext } from "./cockpitLifecycle.ts";
import { openWindow, closeWindow, toggleMinimize, focusedId, saveLayout, loadLayout } from "../ui/desktop.ts";
import { launchableTabsFor } from "../ui/tabs.ts";
import { isGlobalTab } from "../ui/globalWindow.ts";

register("../ui/svelteSsrHook.ts", import.meta.url);
const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const { createAppFlow } = await import("../app/flow.ts");
const ProvisioningPanel = (await import("../ui/ProvisioningPanel.svelte")).default;
const Neocom = (await import("../ui/Neocom.svelte")).default;
const source = (name: string) => readFileSync(new URL(`../ui/${name}`, import.meta.url), "utf8");

test("Ready Fit is one ordinary pilot window: open, focus, restore, close and reopen", () => {
  assert.equal(isGlobalTab("provisioning"), false);
  for (const docked of [true, false]) assert.ok(launchableTabsFor(docked).some(tab => tab.id === "provisioning" && tab.label === "Готовый фит"));
  let windows = openWindow([], "provisioning");
  windows = openWindow(windows, "market");
  windows = openWindow(windows, "provisioning");
  assert.equal(windows.filter(window => window.id === "provisioning").length, 1);
  assert.equal(focusedId(windows), "provisioning");
  windows = toggleMinimize(windows, "provisioning");
  windows = openWindow(windows, "provisioning");
  assert.equal(windows.find(window => window.id === "provisioning")?.minimized, false);
  windows = closeWindow(windows, "provisioning");
  assert.equal(windows.some(window => window.id === "provisioning"), false);
  windows = openWindow(windows, "provisioning");
  assert.equal(focusedId(windows), "provisioning");
});

test("Ready Fit layout belongs to its pilot and restores through the existing desktop model", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value),
  } });
  try {
    saveLayout(42, { wins: openWindow([], "provisioning"), dockCollapsed: false, dockWidth: 340,
      targetsX: 20, targetsY: 12, stationExpanded: false });
    assert.equal(loadLayout(42)?.wins[0]?.id, "provisioning");
    assert.equal(loadLayout(43), null);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

function fixture() {
  let context: CockpitProvisioningContext = { characterID: 42, corporationID: 98, shipID: 100,
    stationID: 600, structureID: null, docked: true, transitioning: false, transitionEpoch: 1,
    options: { token: "held-token", baseUrl: "https://fixture.invalid", captureNotificationSink: () => () => {} } };
  const lifecycle = createCockpitProvisioningLifecycle(() => context);
  return { lifecycle, context: () => context, change: (update: Partial<CockpitProvisioningContext>) => {
    context = { ...context, ...update }; return lifecycle.observe();
  } };
}

test("review captures the held session options without losing injected fetch or notification lifecycle", () => {
  const f = fixture(), lease = f.lifecycle.capture();
  assert.equal(lease.options.token, "held-token");
  assert.equal(lease.options.baseUrl, "https://fixture.invalid");
  assert.equal(lease.options.captureNotificationSink, f.context().options.captureNotificationSink);
  assert.equal(lease.options.priority, "user");
  (f.context().options as { token: string }).token = "replacement-token";
  assert.equal(lease.options.token, "held-token", "request auth is a snapshot of mutable flow options");
  assert.equal(lease.isCurrent(), false);
  assert.equal(lease.isHeld(), false);
});

test("pilot switches, session release and replacement tokens retire the accepted review", () => {
  for (const change of [{ characterID: 43 }, { characterID: null }, { options: { token: "new-token" } }]) {
    const f = fixture(), lease = f.lifecycle.capture();
    assert.equal(f.change(change), true);
    assert.equal(lease.isHeld(), false);
    assert.throws(() => lease.assertCurrent(), /changed/);
  }
});

test("ship, location and transition generation changes retire review but allow same-pilot refresh after boarding", () => {
  for (const change of [{ shipID: 101 }, { stationID: 601 }, { structureID: 999 }, { docked: false },
    { transitioning: true }, { transitionEpoch: 2 }]) {
    const f = fixture(), lease = f.lifecycle.capture();
    assert.equal(f.change(change), true);
    assert.equal(lease.isCurrent(), false);
    assert.equal(lease.isHeld(), true);
    assert.equal(f.lifecycle.capture().isCurrent(), true);
  }
});

test("a context changing away and back cannot accept an old reply; closed windows retire every reply", async () => {
  const f = fixture(), lease = f.lifecycle.capture();
  const lateReply = Promise.resolve().then(() => lease.assertCurrent());
  f.change({ shipID: 101 }); f.change({ shipID: 100 });
  await assert.rejects(lateReply, /changed/);
  const held = f.lifecycle.capture();
  f.lifecycle.dispose();
  assert.equal(held.isHeld(), false); assert.equal(held.isCurrent(), false);
});

test("offline notification after the parent removes its pilot retires review without reading retired prop getters", async () => {
  const store = createClientStore();
  const online = { characterID: 42, characterName: "Current Pilot", stationID: 600,
    structureID: null, solarSystemID: 300, corporationID: 98 };
  store.apply({ type: "character/online", character: online, station: null });
  const flow = createAppFlow(store, { perSessionToken: true, initialSessionToken: "held-token" });
  let active: { store: typeof store; flow: typeof flow } | null = { store, flow };
  let retiredGetterReads = 0;
  const props = {
    get store() { if (!active) { retiredGetterReads++; throw new TypeError("Cannot read properties of null (reading 'store')"); } return active.store; },
    get flow() { if (!active) { retiredGetterReads++; throw new TypeError("Cannot read properties of null (reading 'flow')"); } return active.flow; },
  };
  // App's roster subscriber is registered before the panel's subscriber.
  const stopParent = store.station.subscribe(slice => { if (!slice.online) active = null; });
  const cockpitStore = props.store, cockpitFlow = props.flow;
  const lifecycle = createCockpitProvisioningLifecycle(() => ({
    characterID: cockpitStore.station.get().online?.characterID ?? null,
    corporationID: cockpitStore.station.get().online?.corporationID ?? null,
    shipID: 100, stationID: 600, structureID: null, docked: true, transitioning: false,
    transitionEpoch: 1, options: cockpitFlow.requestOptions(),
  }));
  const failures: unknown[] = [];
  let resetCount = 0;
  const stopPanel = cockpitStore.station.subscribe(() => {
    try { if (lifecycle.observe()) resetCount++; } catch (error) { failures.push(error); }
  });
  const accepted = lifecycle.capture();
  const lateReply = Promise.resolve().then(() => accepted.assertHeld());
  try {
    store.apply({ type: "character/offline" });
    assert.equal(active, null, "parent binding disappears before the panel callback");
    assert.equal(resetCount, 1); assert.deepEqual(failures, []);
    assert.equal(retiredGetterReads, 0);
    await assert.rejects(lateReply, /held pilot session changed/);
    // A reselect of the same pilot cannot revive the old accepted review.
    store.apply({ type: "character/online", character: online, station: null });
    assert.equal(accepted.isHeld(), false);
  } finally { lifecycle.dispose(); stopPanel(); stopParent(); }
});

test("Ready Fit captures stable cockpit props before any lifecycle or asynchronous callback", () => {
  const panel = source("ProvisioningPanel.svelte");
  assert.match(panel, /const cockpitStore = store;/); assert.match(panel, /const cockpitFlow = flow;/);
  const callbacks = panel.slice(panel.indexOf("const lifecycle ="));
  assert.doesNotMatch(callbacks, /\b(?:store|flow)\./, "callbacks must never evaluate App's retired reactive prop getters");
  assert.match(callbacks, /cockpitStore\.flight\.get\(\)/);
  assert.match(callbacks, /cockpitFlow\.requestOptions\(\)/);
  assert.match(callbacks, /await cockpitFlow\.loadFlightStatus\(\)/);
  assert.match(callbacks, /await cockpitFlow\.loadInventory\(\)/);
});

test("Ready Fit renders the current held pilot and ship and Neocom launches a window button", () => {
  const store = createClientStore();
  store.apply({ type: "character/online", character: { characterID: 42, characterName: "Current Pilot",
    stationID: 600, structureID: null, solarSystemID: 300, corporationID: 98 }, station: null } as never);
  store.apply({ type: "flight/status", status: { inSpace: false, docked: true, solarSystemID: 300,
    stationID: 600, structureID: null, shipID: 100, shipTypeID: 587, shipIsCapsule: false,
    shipMode: null, shipSpeedFraction: null } } as never);
  const panel = render(ProvisioningPanel, { props: { store, flow: createAppFlow(store, { perSessionToken: true }) } }).body;
  assert.match(panel, /Current Pilot/); assert.match(panel, /Current ship/);
  assert.match(panel, /NEW_HULL_ONLY/); assert.match(panel, /Open separate Provisioning Center/);
  assert.doesNotMatch(panel, /Review hash|Review ID|target pilot/i);
  const rail = render(Neocom, { props: { store, isDocked: true, openIds: new Set(["provisioning"]),
    focusedId: "provisioning", onSelect: () => {} } }).body;
  assert.match(rail, /<button[^>]+aria-label="Готовый фит"/);
  assert.doesNotMatch(rail, /href="\/ship-provisioning"/);
});

test("one shared current-pilot consumer keeps definition provider separate from physical source", () => {
  const host = source("PanelHost.svelte"), panel = source("ProvisioningPanel.svelte");
  assert.match(host, /tab === "provisioning"[\s\S]{0,100}<ProvisioningPanel \{store\} \{flow\}/);
  assert.doesNotMatch(source("StationPanel.svelte"), /ProvisioningPanel/);
  assert.doesNotMatch(source("Fitting.svelte"), /ProvisioningPanel/);
  assert.match(panel, /Fitting definition provider/); assert.match(panel, /Physical item source/);
  assert.doesNotMatch(panel, /selectCharacter|centerApply|centerReview|Factory|factoryClient|createAppFlow|createClientStore|journal/i);
  for (const call of ["provisioningOptions", "reviewProvisioning", "replenishProvisioning", "reviewShipProvisioning", "provisionShip", "reconcileProvisioning"])
    assert.match(panel, new RegExp(`api\\.${call}\\(`));
  assert.match(panel, /lease\.assertCurrent\(\)/); assert.match(panel, /lease\.assertHeld\(\)/);
  assert.match(panel, /target\.deficit \?\? "Unknown"/);
  assert.match(panel, /review\.source\.access\.take === true \? "permitted" : review\.source\.access\.take === false \? "denied" : "UNKNOWN"/);
  assert.match(panel, /cockpitStore\.station\.subscribe\(changedContext\)/);
  assert.match(panel, /onDestroy\(\(\) => \{ lifecycle\.dispose\(\)/);
});

test("confirmation stays separate from review and refuses unsafe plans while accepting supported exact-match no-op", () => {
  const panel = source("ProvisioningPanel.svelte");
  assert.match(panel, />Review<\/button>/); assert.match(panel, />Replenish Consumables<\/button>/);
  assert.match(panel, /Review Provision Ship plan/); assert.match(panel, /"Provision Ship"/);
  assert.match(panel, /shipReview\.plan\.unsupported\.length === 0/);
  assert.match(panel, /shipReview\.plan\.destructiveActions\.length === 0/);
  assert.match(panel, /\["ALREADY_SATISFIED", "NEW_HULL", "CONTINUE"\]\.includes/);
  assert.match(panel, /!validShipReview \|\| !safeShipPlan/);
  assert.match(panel, /No new hull or duplicate loading will be dispatched/);
  assert.doesNotMatch(panel, /\{shipReview\.reviewHash\}|\{review\.reviewHash\}/);
});
