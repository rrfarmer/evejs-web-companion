import { definePluginViews } from "../../web/src/plugin-api/index.ts";
export default definePluginViews({
  id: "uoc",
  windows: {},
  page: () => import("./page/StandalonePage.svelte"),
});
