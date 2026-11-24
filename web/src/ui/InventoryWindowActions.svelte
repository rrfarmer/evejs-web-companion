<script lang="ts">
  // invWindow.Inventory in space: in compact mode its search field in the header (_get_search_field_parent:
  // _search_field_header_parent, centred), then the window's menu (CompactModeWindowAction, then GetMenuMoreOptions):
  // Show Sidebar, Always Open Separate, Keep Quick Filter Value, and in compact mode a separator, the caption View Mode and the view modes' radio buttons.
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { onMount } from "svelte";
  import WindowActionItems from "./WindowActionItems.svelte";
  import { applyWindowFlags, WINDOW_ACTION_WORDS } from "./windowFlags.ts";
  import { invAlwaysSeparate, invCompact, invFilter, invKeepFilter, invSidebar, invViewMode, setInvAlwaysSeparate, setInvCompact, setInvKeepFilter, setInvSidebar } from "./inventoryWindowSettings.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  const compact = invCompact;
  const sidebar = invSidebar;
  const filter = invFilter;
  const viewMode = invViewMode;
  const keepFilter = invKeepFilter;
  const alwaysSeparate = invAlwaysSeparate;
  const MODES = [["icons", "UI/Inventory/Icons", "Icons"], ["details", "UI/Inventory/Details", "Details"], ["list", "UI/Inventory/List", "List"]] as const;
  onMount(() => applyWindowFlags("inventory"));
  $effect(() => { flow.requestWords(["UI/Common/More", ...WINDOW_ACTION_WORDS, "UI/Inventory/ShowSidebar", "UI/Inventory/AlwaysOpenSeparate", "UI/Inventory/KeepQuickFilterValue", "UI/Inventory/ViewMode", "UI/Inventory/Icons", "UI/Inventory/Details", "UI/Inventory/List",
    "/Carbon/UI/Controls/Window/EnableCompactMode", "/Carbon/UI/Controls/Window/DisableCompactMode", "UI/Common/Search"]); });

  let open = $state(false);
  let root: HTMLElement;

  function word(label: string, fallback: string): string {
    const template = $words?.templates[label];
    return typeof template === "string" && template ? plainText(formatTemplate(template, {}, { nameOf: () => "" })) : fallback;
  }
</script>

<svelte:window onpointerdown={(event) => { if (open && !root.contains(event.target as Node)) open = false; }}
  onkeydown={(event) => { if (open && event.key === "Escape") { event.stopPropagation(); open = false; } }} />

<div class="inv-actions" bind:this={root}>
  {#if $compact}
    <input class="inv-head-search" placeholder={word("UI/Common/Search", "Search")} value={$filter}
      oninput={(event) => filter.set((event.target as HTMLInputElement).value)} onpointerdown={(event) => event.stopPropagation()} />
  {/if}
  <button type="button" class="win-btn" title={word("UI/Common/More", "More")} aria-label={word("UI/Common/More", "More")} aria-expanded={open}
    onpointerdown={(event) => event.stopPropagation()} onclick={() => (open = !open)}>⋯</button>
  {#if open}
    <div class="log-menu" role="menu" aria-label="Options">
      <WindowActionItems id="inventory" lightByDefault={false} {word} compact={{ on: $compact, toggle: () => setInvCompact(!$compact) }} onDone={() => (open = false)} />
      <button type="button" role="menuitemcheckbox" aria-checked={$sidebar} onpointerdown={(event) => event.stopPropagation()}
        onclick={() => setInvSidebar(!$sidebar)}>{word("UI/Inventory/ShowSidebar", "Show Sidebar")}</button>
      <button type="button" role="menuitemcheckbox" aria-checked={$alwaysSeparate} onpointerdown={(event) => event.stopPropagation()}
        onclick={() => setInvAlwaysSeparate(!$alwaysSeparate)}>{word("UI/Inventory/AlwaysOpenSeparate", "Always Open Separate")}</button>
      <button type="button" role="menuitemcheckbox" aria-checked={$keepFilter} onpointerdown={(event) => event.stopPropagation()}
        onclick={() => setInvKeepFilter(!$keepFilter)}>{word("UI/Inventory/KeepQuickFilterValue", "Keep Quick Filter Value")}</button>
      {#if $compact}
        <hr class="sep" />
        <span class="caption">{word("UI/Inventory/ViewMode", "View Mode")}</span>
        {#each MODES as [id, label, own] (id)}
          <button type="button" role="menuitemradio" aria-checked={$viewMode === id} onpointerdown={(event) => event.stopPropagation()}
            onclick={() => { viewMode.set(id); open = false; }}><span class="dot">{$viewMode === id ? "●" : ""}</span>{word(label, own)}</button>
        {/each}
      {/if}
    </div>
  {/if}
</div>

<style>
  .inv-actions { position: relative; display: flex; align-items: center; gap: 6px; }
  .inv-actions > .log-menu { left: auto; right: 0; }
  .inv-head-search { width: 140px; height: 18px; box-sizing: border-box; background: rgba(0, 0, 0, 0.3); color: #fff;
    border: 1px solid rgba(255, 255, 255, 0.15); font: inherit; font-size: 12px; padding: 0 4px; }
  .dot { display: inline-block; width: 16px; }
  .sep { border: 0; border-top: 1px solid rgba(255, 255, 255, 0.15); margin: 4px 0; width: 100%; }
</style>
