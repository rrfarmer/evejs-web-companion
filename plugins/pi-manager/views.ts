// What the PI Manager's window draws (the browser only; see plugin.ts).

import { definePluginViews, type GlobalWindowView } from "../../web/src/plugin-api/index.ts";
import PiManager from "./ui/PiManager.svelte";

export default definePluginViews({
  id: "pi-manager",
  windows: { "plugin:pi-manager": PiManager as GlobalWindowView },
});
