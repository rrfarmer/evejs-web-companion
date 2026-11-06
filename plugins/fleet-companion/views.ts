// What the plugin draws (the browser only; see plugin.ts).

import { definePluginViews, type GlobalWindowView } from "../../web/src/plugin-api/index.ts";
import FleetCompanions from "./ui/FleetCompanions.svelte";
import SquadFly from "./ui/SquadFly.svelte";
import MemberFlies from "./ui/MemberFlies.svelte";
// Read now, before the Hangar is drawn, so a setting the Hangar kept is taken over first.
import "./lib/companionSettings.ts";

export default definePluginViews({
  id: "fleet-companion",
  windows: { "plugin:fleet-companion": FleetCompanions as GlobalWindowView },
  squadControl: SquadFly,
  squadMemberSetting: MemberFlies,
});
