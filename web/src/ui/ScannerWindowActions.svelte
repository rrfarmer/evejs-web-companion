<script lang="ts">
  // ProbeScannerWindow's menu in space: CompactModeWindowAction (Enable / Disable compact mode).
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { probeScannerCompact, setProbeScannerCompact } from "./scannerWindowSettings.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  const compact = probeScannerCompact;
  $effect(() => { flow.requestWords(["/Carbon/UI/Controls/Window/EnableCompactMode", "/Carbon/UI/Controls/Window/DisableCompactMode"]); });

  let open = $state(false);
  let root: HTMLElement;

  function word(label: string, fallback: string): string {
    const template = $words?.templates[label];
    return typeof template === "string" && template ? plainText(formatTemplate(template, {}, { nameOf: () => "" })) : fallback;
  }
</script>

<svelte:window onpointerdown={(event) => { if (open && !root.contains(event.target as Node)) open = false; }}
  onkeydown={(event) => { if (open && event.key === "Escape") { event.stopPropagation(); open = false; } }} />

<div class="scanner-actions" bind:this={root}>
  <button type="button" class="win-btn" title="Options" aria-label="Options" aria-expanded={open}
    onpointerdown={(event) => event.stopPropagation()} onclick={() => (open = !open)}>⋯</button>
  {#if open}
    <div class="log-menu" role="menu" aria-label="Options">
      <button type="button" role="menuitem" onpointerdown={(event) => event.stopPropagation()}
        onclick={() => { setProbeScannerCompact(!$compact); open = false; }}>{$compact ? word("/Carbon/UI/Controls/Window/DisableCompactMode", "Disable compact mode") : word("/Carbon/UI/Controls/Window/EnableCompactMode", "Enable compact mode")}</button>
    </div>
  {/if}
</div>

<style>
  .scanner-actions { position: relative; }
  .scanner-actions > .log-menu { left: auto; right: 0; }
</style>
