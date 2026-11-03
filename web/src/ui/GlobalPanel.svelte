<script lang="ts">
  // The body of one GLOBAL window (globalWindow.ts): whatever its tab registered
  // to draw (globalWindowViews.ts), core's or a plugin's.
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
  import HangarBotBuilder from "./HangarBotBuilder.svelte";
  import { globalWindowView } from "./globalWindowViews.ts";
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

  const View = $derived(globalWindowView(tab));
</script>

{#if tab === "botBuilder"}
  <HangarBotBuilder {sessions} pilot={builderSession} onPilot={onBuilderPilot} />
{:else if View}
  <View {sessions} {onOpen} {onGoToPilot} />
{/if}
