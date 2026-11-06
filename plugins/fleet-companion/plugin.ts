// FLEET COMPANIONS: pilots that fly with a fleet and take its orders, from a browser tab or
// from this plugin's backend on the server.
//
// A plugin (web/src/plugin-api): a window listing every companion, a button on each squad
// and a tick under each of its pilots in the Pilot Hangar, and a run the server flies.

import { definePlugin } from "../../web/src/plugin-api/index.ts";

export default definePlugin({
  id: "fleet-companion",
  name: "Fleet companions",
  version: "1.0.0",
  apiVersion: 1,
  description: "Pilots that fly with a fleet and take its orders, in this tab or on the server.",
  label: "Companions",
  windows: [
    {
      id: "plugin:fleet-companion",
      label: "Companions",
      title: "Fleet companions",
      hint: "Fleet companions - every pilot flying with a fleet",
      glyph: ["M13 3l5 10-5-2.5L8 13z", "M6 13l3 7-3-1.5L3 20z"],
    },
  ],
  backend: "backend.ts",
  // Companions flown on the server when they were core's come back as this plugin's run.
  formerBotKinds: { companion: "fly" },
});
