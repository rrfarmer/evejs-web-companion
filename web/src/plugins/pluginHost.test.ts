// Loading plugins: wholly in or wholly out, and a failed plugin fails only
// itself. Each test uses ids of its own, because the registries are module state.

import test from "node:test";
import assert from "node:assert/strict";

import { PLUGIN_API_VERSION, definePlugin, type PluginManifest } from "../plugin-api/index.ts";
import { activatePlugins, pluginProblem } from "./pluginHost.ts";
import { globalLaunchers, isGlobalTab } from "../ui/globalWindow.ts";
import { pluginMacro } from "../bots/pluginMacros.ts";
import { tabLabel } from "../ui/tabs.ts";

function manifest(id: string, extra: Partial<PluginManifest> = {}): PluginManifest {
  return definePlugin({ id, name: `Plugin ${id}`, version: "1.0.0", apiVersion: PLUGIN_API_VERSION, description: "Test.", ...extra });
}

const window = (id: `plugin:${string}`) => ({ id, label: "Board", title: `Window ${id}`, hint: "A board", glyph: ["M4 4h16v16H4z"] });

const block = (id: `${string}:${string}`) => ({
  id,
  name: "Wait a moment",
  category: "flow" as const,
  does: "Waits.",
  needs: null,
  spec: { args: [], untilRequired: false },
  runPolicy: { risks: [], restartSafe: true },
  reads: [],
  decide: () => {
    throw new Error("not run here");
  },
});

test("a plugin loads its windows and blocks, and says it is on", () => {
  const [status] = activatePlugins([manifest("alpha", { windows: [window("plugin:alpha")], macros: [block("alpha:wait")] })], [
    { id: "alpha", windows: { "plugin:alpha": (() => {}) as never } },
  ]);
  assert.equal(status?.state, "active");
  assert.equal(isGlobalTab("plugin:alpha"), true);
  assert.equal(tabLabel("plugin:alpha"), "Window plugin:alpha");
  assert.ok(globalLaunchers().some((launcher) => launcher.id === "plugin:alpha"));
  assert.notEqual(pluginMacro("alpha:wait"), null);
});

test("⚠ a plugin is refused whole: a window or block that is not its own loads nothing of it", () => {
  const statuses = activatePlugins([
    manifest("beta", { windows: [window("plugin:beta")], macros: [block("gamma:wait")] }),
    manifest("delta", { windows: [window("plugin:somebody-else")] }),
  ], null);
  assert.deepEqual(statuses.map((s) => s.state), ["failed", "failed"]);
  assert.match(statuses[0]?.error ?? "", /block "gamma:wait" is not this plugin's/);
  assert.match(statuses[1]?.error ?? "", /window "plugin:somebody-else" is not this plugin's/);
  assert.equal(isGlobalTab("plugin:beta"), false, "beta's own window did not load either");
});

test("⚠ an id listed twice in one plugin, or a block with no colon, is refused before any of it registers", () => {
  const twice = activatePlugins([manifest("kappa", { windows: [window("plugin:kappa"), window("plugin:kappa")] })], null);
  assert.equal(twice[0]?.state, "failed");
  assert.match(twice[0]?.error ?? "", /already a window called "plugin:kappa"/);
  assert.equal(isGlobalTab("plugin:kappa"), false, "its first window did not load either");
  const blocks = activatePlugins([manifest("lambda", { macros: [block("lambda:wait"), block("lambda:wait")] })], null);
  assert.match(blocks[0]?.error ?? "", /already a block called "lambda:wait"/);
  assert.equal(pluginMacro("lambda:wait"), null, "its first block did not load either");
  const colonless = activatePlugins([manifest("mu", { macros: [block("mux" as `${string}:${string}`)] })], null);
  assert.match(colonless[0]?.error ?? "", /block "mux" is not this plugin's/);
});

test("one plugin's failure leaves the next one loading", () => {
  const statuses = activatePlugins([manifest("Bad Id"), manifest("epsilon", { macros: [block("epsilon:wait")] })], null);
  assert.deepEqual(statuses.map((s) => s.state), ["failed", "active"]);
  assert.notEqual(pluginMacro("epsilon:wait"), null);
});

test("a plugin built for another API, a duplicate and a switched-off one load nothing", () => {
  const statuses = activatePlugins(
    [
      manifest("zeta", { apiVersion: PLUGIN_API_VERSION + 1, macros: [block("zeta:wait")] }),
      manifest("eta", { macros: [block("eta:wait")] }),
      manifest("eta"),
      manifest("theta", { macros: [block("theta:wait")] }),
    ],
    null,
    new Set(["theta"]),
  );
  assert.deepEqual(statuses.map((s) => s.state), ["incompatible", "active", "failed", "disabled"]);
  assert.equal(pluginMacro("zeta:wait"), null);
  assert.equal(pluginMacro("theta:wait"), null);
});

test("a window with nothing to draw is refused in the browser, and needs no view in the BFF", () => {
  assert.match(pluginProblem(manifest("iota", { windows: [window("plugin:iota")] }), { id: "iota", windows: {} }) ?? "", /nothing to draw/);
  assert.equal(pluginProblem(manifest("iota", { windows: [window("plugin:iota")] }), null), null);
});
