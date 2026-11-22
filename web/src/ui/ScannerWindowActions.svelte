<script lang="ts">
  // ProbeScannerWindow's menu in space: its window actions only (read through gridcheck: Lock window size and position,
  // compact mode, Disable Light Background, Collapse).
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { probeScannerCompact, setProbeScannerCompact } from "./scannerWindowSettings.ts";
  import { onMount } from "svelte";
  import WindowActionItems from "./WindowActionItems.svelte";
  import { applyWindowFlags, WINDOW_ACTION_WORDS } from "./windowFlags.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  const compact = probeScannerCompact;
  $effect(() => { flow.requestWords(["/Carbon/UI/Controls/Window/EnableCompactMode", "/Carbon/UI/Controls/Window/DisableCompactMode", ...WINDOW_ACTION_WORDS]); });
  onMount(() => applyWindowFlags("scanner"));

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
      <WindowActionItems id="scanner" lightByDefault={true} {word} compact={{ on: $compact, toggle: () => setProbeScannerCompact(!$compact) }} onDone={() => (open = false)} />
    </div>
  {/if}
</div>

<style>
  .scanner-actions { position: relative; }
  .scanner-actions > .log-menu { left: auto; right: 0; }
</style>
