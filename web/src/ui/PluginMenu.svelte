<script lang="ts">
  // THE PLUGINS MENU — every plugin window, from one button beside the brand.
  //
  // A row per plugin. One with several windows opens them in place, on hover
  // or on a click of the row (a phone has no hover), and each window row opens
  // its window. The pin at the end of a row puts a launcher in the strip
  // (pluginPins.ts): the plugin row's pin the whole plugin, a window row's pin
  // that window alone. A window of a plugin pinned whole shows its pin as
  // covered by the plugin's.
  //
  // ⚠ A PANEL ON <body>, PLACED UNDER THE BUTTON (portal.ts). The strip scrolls
  // sideways on a narrow bar and sits in headers with stacking orders of their
  // own; drawn inside it, the panel would be clipped or under the windows.
  import { neocomGlyph, NEOCOM_GLYPHS } from "./neocomIcons.ts";
  import { pluginWindowGroups, type PluginWindowGroup } from "./globalWindow.ts";
  import { isPluginPinned, isWindowPinned, togglePlugin, toggleWindow } from "./pluginPins.ts";
  import { pinStore } from "./pluginPinStore.ts";
  import type { TabID } from "./tabs.ts";
  import { portal } from "./portal.ts";

  let { openIds, onOpen }: { openIds: ReadonlySet<TabID>; onOpen: (id: TabID) => void } = $props();

  const groups: readonly PluginWindowGroup[] = pluginWindowGroups();
  const pins = pinStore();
  const PIN = ["M9 4h6l-1 5 3 3H7l3-3z", "M12 15v5"];
  const CHEVRON = ["M9 6l6 6-6 6"];

  let shown = $state(false);
  let query = $state("");
  let expanded = $state<string | null>(null);
  let place = $state({ top: 0, left: 0 });
  let button: HTMLButtonElement | undefined = $state();
  let panel: HTMLDivElement | undefined = $state();

  const PANEL_WIDTH = 300;

  function toggle(): void {
    if (shown) {
      shown = false;
      return;
    }
    const box = button!.getBoundingClientRect();
    place = { top: box.bottom + 2, left: Math.max(8, Math.min(box.right - PANEL_WIDTH, window.innerWidth - PANEL_WIDTH - 8)) };
    query = "";
    expanded = null;
    shown = true;
  }

  function open(id: TabID): void {
    shown = false;
    onOpen(id);
  }

  function matches(group: PluginWindowGroup): boolean {
    const words = query.trim().toLowerCase();
    if (words.length === 0) return true;
    return group.plugin.name.toLowerCase().includes(words) ||
      group.windows.some((win) => win.title.toLowerCase().includes(words));
  }

  const visible = $derived(groups.filter(matches));

  function outside(event: PointerEvent): void {
    if (!shown) return;
    const target = event.target as Node;
    if (button?.contains(target) || panel?.contains(target)) return;
    shown = false;
  }
</script>

<svelte:window onpointerdown={outside} onkeydown={(event) => { if (event.key === "Escape") shown = false; }} />

<button
  type="button"
  class="global-launch plugin-menu-button"
  class:open={shown}
  data-launch="plugins"
  aria-haspopup="true"
  aria-expanded={shown}
  aria-label={`Plugins, ${groups.length}`}
  title="Plugins — what this client adds beyond the game's own windows"
  bind:this={button}
  onclick={toggle}
>
  <svg class="global-launch-glyph" viewBox="0 0 24 24" aria-hidden="true">
    {#each NEOCOM_GLYPHS.pluginManager as d (d)}<path {d} />{/each}
  </svg>
  <span class="global-launch-text">Plugins</span>
  {#if groups.length > 0}<span class="plugin-menu-count" aria-hidden="true">{groups.length}</span>{/if}
</button>

{#if shown}
  <div use:portal class="plugin-panel" role="menu" aria-label="Plugins" style:top="{place.top}px" style:left="{place.left}px" bind:this={panel}>
    {#if groups.length > 3}
      <input class="plugin-panel-find" type="search" placeholder="Find a plugin window" aria-label="Find a plugin window" bind:value={query} />
    {/if}
    {#if groups.length === 0}
      <p class="plugin-panel-note">This client carries no plugins.</p>
    {/if}
    {#each visible as group (group.plugin.id)}
      {@const several = group.windows.length > 1}
      {@const whole = isPluginPinned($pins, group.plugin.id)}
      {@const isOpen = expanded === group.plugin.id || (query.trim().length > 0 && several)}
      <div class="plugin-panel-row" role="none" onmouseenter={() => { if (several) expanded = group.plugin.id; }}>
        <button
          type="button"
          class="plugin-panel-name"
          role="menuitem"
          aria-expanded={several ? isOpen : undefined}
          onclick={() => (several ? (expanded = isOpen ? null : group.plugin.id) : open(group.windows[0]!.id))}
        >
          {#if several}
            <svg class="plugin-panel-chevron" class:down={isOpen} viewBox="0 0 24 24" aria-hidden="true">{#each CHEVRON as d (d)}<path {d} />{/each}</svg>
          {:else}
            <span class="plugin-panel-chevron" aria-hidden="true"></span>
          {/if}
          <svg class="global-launch-glyph" viewBox="0 0 24 24" aria-hidden="true">{#each group.plugin.glyph ?? neocomGlyph(group.windows[0]!.id) as d (d)}<path {d} />{/each}</svg>
          <span>{group.plugin.name}</span>
        </button>
        <button
          type="button"
          class="plugin-panel-pin"
          class:pinned={whole}
          aria-pressed={whole}
          aria-label={whole ? `Unpin ${group.plugin.name}` : `Pin ${group.plugin.name} beside the brand`}
          title={whole ? `Unpin ${group.plugin.name}` : `Pin ${group.plugin.name} beside the brand`}
          onclick={() => pins.update((state) => togglePlugin(state, group))}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">{#each PIN as d (d)}<path {d} />{/each}</svg>
        </button>
      </div>
      {#if several && isOpen}
        {#each group.windows as win (win.id)}
          {@const alone = isWindowPinned($pins, win.id)}
          <div class="plugin-panel-row plugin-panel-window" role="none">
            <button type="button" class="plugin-panel-name" role="menuitem" class:open={openIds.has(win.id)} onclick={() => open(win.id)}>
              <span>{win.title}</span>
            </button>
            {#if whole}
              <span class="plugin-panel-pin covered" title={`Pinned with ${group.plugin.name}`} aria-label={`Pinned with ${group.plugin.name}`}>
                <svg viewBox="0 0 24 24" aria-hidden="true">{#each PIN as d (d)}<path {d} />{/each}</svg>
              </span>
            {:else}
              <button
                type="button"
                class="plugin-panel-pin"
                class:pinned={alone}
                aria-pressed={alone}
                aria-label={alone ? `Unpin ${win.title}` : `Pin ${win.title} beside the brand`}
                title={alone ? `Unpin ${win.title}` : `Pin ${win.title} beside the brand`}
                onclick={() => pins.update((state) => toggleWindow(state, group, win.id))}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">{#each PIN as d (d)}<path {d} />{/each}</svg>
              </button>
            {/if}
          </div>
        {/each}
      {/if}
    {/each}
    {#if query.trim().length > 0 && visible.length === 0}
      <p class="plugin-panel-note">No plugin window is called that.</p>
    {/if}
    <button type="button" class="plugin-panel-manage" role="menuitem" onclick={() => open("pluginManager")}>Manage plugins</button>
  </div>
{/if}
