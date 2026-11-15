<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { plainText } from "../bridge/clientWords.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  const ROOT = "UI/Inflight/SpaceComponents/JumpBridge/Info/";
  const sections = [
    { title: "JumpRestrictions", fallback: "Jump Restrictions" },
    { title: "CapacitorUsage", fallback: "Capacitor Usage" },
  ] as const;
  onMount(() => flow.requestWords([ROOT + "Mechanics", ...sections.flatMap(({ title }) => [ROOT + title, ROOT + title + "Text"])]));
</script>

<h3>{plainText($words.templates[ROOT + "Mechanics"] ?? "") || "Mechanics"}</h3>
{#each sections as section (section.title)}
  {@const items = plainText($words.templates[ROOT + section.title + "Text"] ?? "").split(/\r?\n/).map(text => text.trim()).filter(Boolean)}
  {#if items.length}
    <h4>{plainText($words.templates[ROOT + section.title] ?? "") || section.fallback}</h4>
    <ul>
      {#each items as item, index (index)}
        <li>{item}</li>
      {/each}
    </ul>
  {/if}
{/each}

<style>
  h4 { margin: 8px 0 0; padding: 6px 8px; background: rgb(255 255 255 / 5%); }
  ul { margin: 8px 0; padding-inline-start: 24px; }
  li + li { margin-top: 6px; }
</style>
