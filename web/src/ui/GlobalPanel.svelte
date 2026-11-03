<script lang="ts">
  // The body of one GLOBAL window (globalWindow.ts) — the Bot Manager,
  // Planetary Industry or Fleet companions.
  //
  // ⚠ NOT PanelHost, AND THAT IS THE POINT. PanelHost is a pilot's panel host:
  // every branch in it takes that pilot's `store` and `flow`, so it cannot be
  // drawn with nobody in the client. These three are about every pilot, open
  // from the Pilot Hangar as readily as over a cockpit, and take neither — each
  // reaches the pilots it acts on through their own sessions or their accounts
  // (app/pilotReach.ts, app/piRosterRead.ts). PanelHost still carries the same
  // three for a phone, where a global tab is an ordinary workspace panel.
  //
  // The Bot Builder is the one pilot panel drawn here (globalWindow.ts
  // `BUILDER_TAB`), reading the pilot App bound it to — or nobody — through
  // HangarBotBuilder, which also carries its "Data from" picker.
  import BotManager from "./BotManager.svelte";
  import HangarBotBuilder from "./HangarBotBuilder.svelte";
  import FleetCompanions from "./FleetCompanions.svelte";
  import PiManager from "./PiManager.svelte";
  import IndustryManager from "./IndustryManager.svelte";
  import type { Session } from "../app/sessions.ts";
  import type { TabID } from "./tabs.ts";

  let {
    tab,
    sessions,
    builderSession = null,
    onBuilderPilot = () => {},
    onOpen,
    onGoToPilot,
  }: {
    tab: TabID;
    sessions: readonly Session[];
    /** The pilot the Bot Builder reads, or null for the pilotless builder. */
    builderSession?: Session | null;
    /** The Bot Builder's "Data from" picked another pilot, or none. */
    onBuilderPilot?: (sessionID: string | null) => void;
    /** Open a per-pilot panel (the Bot Builder, the built-in bots) on a workspace. */
    onOpen: (tab: TabID, sessionID?: string) => void;
    /** Make a pilot the active cockpit. */
    onGoToPilot: (sessionID: string) => void;
  } = $props();
</script>

{#if tab === "botManager"}
  <BotManager {sessions} {onOpen} />
{:else if tab === "botBuilder"}
  <HangarBotBuilder {sessions} pilot={builderSession} onPilot={onBuilderPilot} />
{:else if tab === "companion"}
  <FleetCompanions {sessions} {onGoToPilot} />
{:else if tab === "piManager"}
  <PiManager {sessions} {onOpen} />
{:else if tab === "industryManager"}
  <IndustryManager {sessions} {onOpen} />
{/if}
