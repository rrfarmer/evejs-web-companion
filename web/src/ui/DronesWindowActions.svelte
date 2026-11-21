<script lang="ts">
  // DronesWindow.GetMenuMoreOptions (dronesWindow.py 625): the window's menu, its checkbox for the warp warning
  // (warp_warning_enabled_setting, UI/Drones/WarpWarningOption), a separator, the caption UI/Inventory/ViewMode and its
  // radio buttons Icons / List (drones_view_mode_setting).
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { droneViewIcons, droneViewModeFor, droneWarpWarning, droneWarpWarningFor, setDroneViewMode, setDroneWarpWarning } from "./droneSettings.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const character = store.character;
  const on = droneWarpWarning;
  const icons = droneViewIcons;
  $effect(() => { flow.requestWords(["UI/Drones/WarpWarningOption", "UI/Inventory/ViewMode", "UI/Inventory/Icons", "UI/Inventory/List"]); });
  $effect(() => { const id = $character.selectedCharacterID; if (id !== null) { droneWarpWarningFor(id); droneViewModeFor(id); } });

  let open = $state(false);
  let root: HTMLElement;

  function word(label: string, fallback: string): string {
    const template = $words?.templates[label];
    return typeof template === "string" && template ? plainText(formatTemplate(template, {}, { nameOf: () => "" })) : fallback;
  }
  function viewMode(on: boolean): void {
    const id = $character.selectedCharacterID;
    if (id !== null) setDroneViewMode(id, on);
    open = false;
  }
  function toggle(): void {
    const id = $character.selectedCharacterID;
    if (id !== null) setDroneWarpWarning(id, !$on);
  }
</script>

<svelte:window onpointerdown={(event) => { if (open && !root.contains(event.target as Node)) open = false; }}
  onkeydown={(event) => { if (open && event.key === "Escape") { event.stopPropagation(); open = false; } }} />

<div class="drones-actions" bind:this={root}>
  <button type="button" class="win-btn" title="Options" aria-label="Options" aria-expanded={open}
    onpointerdown={(event) => event.stopPropagation()} onclick={() => (open = !open)}>⋯</button>
  {#if open}
    <div class="log-menu" role="menu" aria-label="Options">
      <button type="button" role="menuitemcheckbox" aria-checked={$on} onpointerdown={(event) => event.stopPropagation()}
        onclick={toggle}><span class="check">{$on ? "✓" : ""}</span>{word("UI/Drones/WarpWarningOption", "Warp Warning")}</button>
      <hr class="sep" />
      <span class="caption">{word("UI/Inventory/ViewMode", "View Mode")}</span>
      <button type="button" role="menuitemradio" aria-checked={$icons} onpointerdown={(event) => event.stopPropagation()}
        onclick={() => viewMode(true)}><span class="check">{$icons ? "●" : ""}</span>{word("UI/Inventory/Icons", "Icons")}</button>
      <button type="button" role="menuitemradio" aria-checked={!$icons} onpointerdown={(event) => event.stopPropagation()}
        onclick={() => viewMode(false)}><span class="check">{$icons ? "" : "●"}</span>{word("UI/Inventory/List", "List")}</button>
    </div>
  {/if}
</div>

<style>
  .drones-actions { position: relative; }
  .drones-actions > .log-menu { left: auto; right: 0; }
  .check { display: inline-block; width: 16px; }
  /* a radio's mark is its own dot, not the menu's check */
  .drones-actions [role="menuitemradio"]::before { content: none !important; }
  .sep { border: 0; border-top: 1px solid rgba(255, 255, 255, 0.15); margin: 4px 0; width: 100%; }
</style>
