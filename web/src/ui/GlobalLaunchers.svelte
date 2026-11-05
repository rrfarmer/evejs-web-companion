<script lang="ts">
  // THE DOORS ONTO THE GLOBAL WINDOWS, beside the brand.
  //
  // The Bot Manager, Fleet companions and the plugins' windows are each about
  // EVERY pilot, not the one on screen (globalWindow.ts). So their doors sit in
  // the one piece of chrome that is not about a pilot either: the brand strip,
  // which the Pilot Hangar and the character bar both carry. The same three
  // buttons, in the same order, in both — a player who opens the Bot Manager
  // from the hangar with nobody in the client finds it where they left it once
  // a pilot is up.
  //
  // ⚠ NOT IN THE NEOCOM RAIL. The rail is a pilot's workspace, remounted on
  // every switch and absent from the hangar entirely; a door there says "this
  // is about the pilot you are looking at", which is exactly what these
  // windows are not. `launchable: false` in tabs.ts keeps them out of it.
  //
  // ⚠ THE GLYPH IS NEVER THE ONLY LABEL (neocomIcons.ts states the rule). The
  // word rides with it wherever there is room, and `aria-label` carries it —
  // and the companions count in words — when a narrow bar drops the text.
  import { NEOCOM_GLYPHS, neocomGlyph } from "./neocomIcons.ts";
  import { coreStripLaunchers, pluginWindowGroups } from "./globalWindow.ts";
  import { pluginLaunchers } from "./pluginPins.ts";
  import { pinStore } from "./pluginPinStore.ts";
  import PluginLauncher from "./PluginLauncher.svelte";
  import PluginMenu from "./PluginMenu.svelte";
  import type { TabID } from "./tabs.ts";

  let {
    openIds,
    companionCount = 0,
    onOpen,
  }: {
    /** The global windows open right now (put away counts as open). */
    openIds: ReadonlySet<TabID>;
    /**
     * How many pilots are flying as companions. Shown as a count on the
     * Companions button, and absent at zero — a badge reading "0" is a badge
     * that has to be read before it can be dismissed.
     */
    companionCount?: number;
    onOpen: (id: TabID) => void;
  } = $props();

  // The plugins' launchers: what the player pinned (pluginPins.ts). Every plugin
  // window is in the Plugins menu at the end, whatever is pinned.
  const pins = pinStore();
  const groups = pluginWindowGroups();
  const pinnedLaunchers = $derived(pluginLaunchers($pins, groups, openIds));
</script>

<div class="global-launchers" role="group" aria-label="Every pilot">
  <a class="global-launch" href="/ship-provisioning" target="_blank" rel="noopener" aria-label="Provisioning Center" title="Open the separate Provisioning Center for owned pilots">
    <!-- Ready Fit's glyph (the `provisioning` tab), as the MCC door carries its tab's: without one, a narrow bar
         that drops the words left this door an empty box. -->
    <svg class="global-launch-glyph" viewBox="0 0 24 24" aria-hidden="true">
      {#each NEOCOM_GLYPHS.provisioning as d (d)}
        <path {d} />
      {/each}
    </svg>
    <span class="global-launch-text">Provisioning Center</span>
  </a>
  {#each coreStripLaunchers() as launcher (launcher.id)}
    {@const open = openIds.has(launcher.id)}
    {@const count = launcher.id === "companion" ? companionCount : 0}
    <button
      type="button"
      class="global-launch"
      class:open
      data-launch={launcher.id}
      aria-pressed={open}
      aria-label={count > 0 ? `${launcher.title} — ${count} flying` : launcher.title}
      title={launcher.hint}
      onclick={() => onOpen(launcher.id)}
    >
      <svg class="global-launch-glyph" viewBox="0 0 24 24" aria-hidden="true">
        {#each neocomGlyph(launcher.id) as d (d)}
          <path {d} />
        {/each}
      </svg>
      <span class="global-launch-text">{launcher.label}</span>
      {#if count > 0}
        <span class="global-launch-count" aria-hidden="true">{count}</span>
      {/if}
    </button>
  {/each}
  <a
    class="global-launch"
    data-launch="miningOperations"
    href="/mining-command-center"
    aria-label="Mining Command Center"
    title="Create and supervise multi-pilot mining operations"
  >
    <svg class="global-launch-glyph" viewBox="0 0 24 24" aria-hidden="true">
      {#each NEOCOM_GLYPHS.miningOperations as d (d)}
        <path {d} />
      {/each}
    </svg>
    <span class="global-launch-text">MCC</span>
  </a>
  <span class="global-launch-divider" aria-hidden="true"></span>
  {#each pinnedLaunchers as launcher (launcher.key)}
    <PluginLauncher {launcher} {openIds} {onOpen} />
  {/each}
  <PluginMenu {openIds} {onOpen} />
</div>
