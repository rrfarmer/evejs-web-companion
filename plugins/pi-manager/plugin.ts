// THE PI MANAGER — every pilot's planetary industry on one board: colonies and
// what needs attention, stock across pilots and corporations, a planner and
// an expansion search, and bots that restart extractors and haul.
//
// A plugin (web/src/plugin-api): it adds a window and five bot blocks, and its
// saved plans live in its own backend (backend.ts). The game's own planet
// windows - the per-pilot Planets panel and its launches - are core's, and
// this plugin reads them through the plugin API like any other.

import { definePlugin } from "../../web/src/plugin-api/index.ts";
import { PI_BLOCKS } from "./blocks.ts";

export default definePlugin({
  id: "pi-manager",
  name: "Planetary Industry",
  version: "1.0.0",
  apiVersion: 1,
  description: "Every pilot's colonies on one board, PI planning and expansion, and bots that restart extractors and haul.",
  windows: [
    {
      id: "plugin:pi-manager",
      label: "PI",
      title: "Planetary Industry",
      hint: "Planetary Industry — every pilot's colonies on one board",
      // A planet over three pins on a line.
      glyph: ["M12 3a5 5 0 1 0 0 10 5 5 0 0 0 0-10", "M4 20h.01M12 20h.01M20 20h.01", "M4 17h16"],
    },
  ],
  macros: PI_BLOCKS,
  backend: "backend.ts",
});
