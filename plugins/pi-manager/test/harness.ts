// The PI plugin's blocks, registered as the page registers them, for the
// plugin's tests. A test may reach into core (a test is not shipped, and the
// harness it drives a block through is core's); the plugin itself may not.

import { SCRIPT_MACROS } from "../../../web/src/nav/scriptMacros.ts";
import { pluginDeciders, pluginMacro, registerPluginMacro } from "../../../web/src/bots/pluginMacros.ts";
import type { MacroDecider } from "../../../web/src/nav/scriptDecide.ts";
import { PI_BLOCKS } from "../blocks.ts";

for (const block of PI_BLOCKS) {
  if (pluginMacro(block.id) === null) registerPluginMacro(block);
}

// Each block under its old core id too, so a test written against the core
// block reads the same against the plugin's.
const formerly = Object.fromEntries(PI_BLOCKS.flatMap((block) => (block.formerly ?? []).map((old) => [old, block.decide])));

/** Core's deciders, the plugin's under their ids, and the plugin's under their old ids. */
export const MACROS: Readonly<Record<string, MacroDecider>> = { ...SCRIPT_MACROS, ...pluginDeciders(), ...formerly };
