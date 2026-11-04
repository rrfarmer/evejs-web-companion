<script lang="ts">
  // ONE PLUGIN LAUNCHER in the strip (pluginPins.ts `pluginLaunchers`): a pinned
  // window, which a click opens, or a plugin pinned whole, which a click lists
  // the windows of. Lit while any of its windows is open.
  import { neocomGlyph } from "./neocomIcons.ts";
  import type { PluginLauncher } from "./pluginPins.ts";
  import type { TabID } from "./tabs.ts";
  import { portal } from "./portal.ts";

  let { launcher, openIds, onOpen }: { launcher: PluginLauncher; openIds: ReadonlySet<TabID>; onOpen: (id: TabID) => void } = $props();

  let shown = $state(false);
  let place = $state({ top: 0, left: 0 });
  let button: HTMLButtonElement | undefined = $state();
  let panel: HTMLDivElement | undefined = $state();

  function press(): void {
    if (launcher.kind === "window" && launcher.windowID !== null) {
      onOpen(launcher.windowID);
      return;
    }
    if (shown) {
      shown = false;
      return;
    }
    const box = button!.getBoundingClientRect();
    place = { top: box.bottom + 2, left: Math.max(8, Math.min(box.left, window.innerWidth - 248)) };
    shown = true;
  }

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
  class="global-launch plugin-launcher"
  class:open={launcher.open || shown}
  data-launch={launcher.key}
  aria-pressed={launcher.kind === "window" ? launcher.open : undefined}
  aria-haspopup={launcher.kind === "plugin" ? "true" : undefined}
  aria-expanded={launcher.kind === "plugin" ? shown : undefined}
  aria-label={launcher.title}
  title={launcher.hint}
  bind:this={button}
  onclick={press}
>
  <svg class="global-launch-glyph" viewBox="0 0 24 24" aria-hidden="true">
    {#each neocomGlyph(launcher.glyphOf) as d (d)}<path {d} />{/each}
  </svg>
  <span class="global-launch-text">{launcher.label}</span>
</button>

{#if shown}
  <div use:portal class="plugin-panel plugin-launcher-panel" role="menu" aria-label={launcher.title} style:top="{place.top}px" style:left="{place.left}px" bind:this={panel}>
    {#each launcher.windows as win (win.id)}
      <div class="plugin-panel-row" role="none">
        <button
          type="button"
          class="plugin-panel-name"
          role="menuitem"
          class:open={openIds.has(win.id)}
          onclick={() => { shown = false; onOpen(win.id); }}
        >
          <svg class="global-launch-glyph" viewBox="0 0 24 24" aria-hidden="true">{#each neocomGlyph(win.id) as d (d)}<path {d} />{/each}</svg>
          <span>{win.title}</span>
        </button>
      </div>
    {/each}
  </div>
{/if}
