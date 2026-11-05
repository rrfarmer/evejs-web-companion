// A plugin whose modules cannot be run fails alone: whatever it does while it
// loads, the others load, and nobody is left waiting.

import test from "node:test";
import assert from "node:assert/strict";

import { PLUGIN_API_VERSION, type PluginEntry, type PluginManifest } from "../plugin-api/index.ts";
import { loadPluginModules } from "./loadPlugins.ts";

const manifest = (id: string): PluginManifest => ({ id, name: id, version: "1.0.0", apiVersion: PLUGIN_API_VERSION, description: "Test." });
const good = (id: string): PluginEntry => ({ id, load: async () => ({ default: manifest(id) }) });

test("⚠ a plugin that throws while it loads fails alone, and the list's order is kept", async () => {
  const loaded = await loadPluginModules([
    good("first"),
    { id: "broken", load: () => { throw new Error("boom at the top of its module"); } },
    { id: "rejected", load: () => Promise.reject(new Error("chunk 404")) },
    good("last"),
  ], null);
  assert.deepEqual(loaded.manifests.map((entry) => entry.id), ["first", "last"]);
  assert.deepEqual(loaded.failures.map((status) => [status.id, status.state]), [["broken", "failed"], ["rejected", "failed"]]);
  assert.match(loaded.failures[0]?.error ?? "", /boom at the top of its module/);
  assert.match(loaded.failures[1]?.error ?? "", /chunk 404/);
});

test("⚠ a plugin that never finishes loading is given up on, and nobody waits for it", async () => {
  const loaded = await loadPluginModules([
    { id: "stuck", load: () => new Promise(() => {}) },
    good("fine"),
  ], null, { timeoutMs: 30 });
  assert.deepEqual(loaded.manifests.map((entry) => entry.id), ["fine"]);
  assert.match(loaded.failures[0]?.error ?? "", /did not finish loading/);
});

test("⚠ a plugin whose views throw is out whole, manifest and all", async () => {
  const loaded = await loadPluginModules([good("drawn"), good("fine")], [
    { id: "drawn", load: () => Promise.reject(new Error("a component threw")) },
  ]);
  assert.deepEqual(loaded.manifests.map((entry) => entry.id), ["fine"]);
  assert.match(loaded.failures[0]?.error ?? "", /a component threw/);
});

test("a module with no manifest, or another plugin's, is refused", async () => {
  const loaded = await loadPluginModules([
    { id: "empty", load: async () => ({}) as never },
    { id: "liar", load: async () => ({ default: manifest("somebody-else") }) },
  ], null);
  assert.deepEqual(loaded.manifests, []);
  assert.match(loaded.failures[0]?.error ?? "", /no manifest/);
  assert.match(loaded.failures[1]?.error ?? "", /its manifest says "somebody-else"/);
});

test("⚠ a plugin switched off is not run at all", async () => {
  let manifestsRun = 0;
  const off = await loadPluginModules([{ id: "off", load: async () => { manifestsRun += 1; return { default: manifest("off") }; } }], null, { disabled: new Set(["off"]) });
  assert.equal(manifestsRun, 0);
  assert.deepEqual(off.manifests, []);
  assert.deepEqual(off.switchedOff.map((status) => [status.id, status.state]), [["off", "disabled"]]);
});

test("the views of a plugin switched off are not loaded, and the BFF loads none", async () => {
  let viewsLoaded = 0;
  const views = [{ id: "off", load: async () => { viewsLoaded += 1; return { default: { id: "off", windows: {} } }; } }];
  await loadPluginModules([good("off")], views, { disabled: new Set(["off"]) });
  await loadPluginModules([good("off")], null);
  assert.equal(viewsLoaded, 0);
});
