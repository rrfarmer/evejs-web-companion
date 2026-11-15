<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { loadJumpBridgeAttributes, loadTypeList, type JumpBridgeAttributes } from "../app/api.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { showInfo } from "./showInfo.ts";

  let { store, flow, typeID }: { store: ClientStore; flow: AppFlow; typeID: number } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const ROOT = "UI/Inflight/SpaceComponents/JumpBridge/";
  const INFO = ROOT + "Info/";
  const ATTRIBUTES = "UI/InfoWindow/TabNames/Attributes";
  const zoneLabels = [1, 2, 3, 4, 5].map(zone => ROOT + `Zone${zone}Modifier`);
  let tab = $state<"manual" | "attributes">("manual");
  let attributes = $state<JumpBridgeAttributes | null>(null);
  let restricted = $state<readonly number[] | null>(null);
  let loadingRestrictions = $state(false);
  let restrictionError = $state(false);
  const sections = [
    { title: "JumpRestrictions", fallback: "Jump Restrictions" },
    { title: "CapacitorUsage", fallback: "Capacitor Usage" },
  ] as const;
  const label = (key: string, fallback: string) => plainText($words.templates[key] ?? "") || fallback;
  onMount(() => {
    let active = true;
    flow.requestWords([INFO + "Mechanics", ...sections.flatMap(({ title }) => [INFO + title, INFO + title + "Text"]),
      ATTRIBUTES, ROOT + "InfoAttributesHeader", ROOT + "ShipRestrictions", ...zoneLabels]);
    void loadJumpBridgeAttributes(typeID, flow.requestOptions()).then(value => {
      if (active) attributes = value;
    }).catch(() => {});
    return () => { active = false; };
  });

  async function readRestrictions(event: Event) {
    if (!(event.currentTarget as HTMLDetailsElement).open || restricted || loadingRestrictions || !attributes) return;
    loadingRestrictions = true;
    restrictionError = false;
    try {
      restricted = await loadTypeList(attributes.restrictionTypeList, flow.requestOptions());
      if (restricted) flow.requestNames(restricted.map(id => ({ kind: "type", id })));
      else restrictionError = true;
    } catch {
      restrictionError = true;
    } finally {
      loadingRestrictions = false;
    }
  }
</script>

{#if attributes}
  <div class="info-tabs" role="group" aria-label="Jump bridge information">
    <button type="button" aria-pressed={tab === "manual"} onclick={() => tab = "manual"}>{label(INFO + "Mechanics", "User Manual")}</button>
    <button type="button" aria-pressed={tab === "attributes"} onclick={() => tab = "attributes"}>{label(ATTRIBUTES, "Attributes")}</button>
  </div>
{/if}
{#if tab === "attributes" && attributes}
  <h3>{label(ROOT + "InfoAttributesHeader", "Jump Bridge Attributes")}</h3>
  <details ontoggle={event => void readRestrictions(event)}>
    <summary>{label(ROOT + "ShipRestrictions", "Ship Restrictions")}</summary>
    {#if loadingRestrictions}
      <p class="note">Loading ships…</p>
    {:else if restrictionError}
      <p class="note">Ship restrictions unavailable.</p>
    {:else if restricted}
      <ul>
        {#each restricted as id (id)}
          {@const name = resolvedName($names.resolved, "type", id, "")}
          {#if name}
            <li><button type="button" class="evelink showInfo" onclick={() => showInfo({ kind: "type", typeID: id })}>{name}</button></li>
          {/if}
        {/each}
      </ul>
    {/if}
  </details>
  <dl class="kv">
    {#each attributes.zoneModifiers as modifier, zone (zone)}
      <dt>{label(zoneLabels[zone] ?? "", `Zone ${zone + 1} Modifier`)}</dt>
      <dd>{modifier}</dd>
    {/each}
  </dl>
{:else}
  <h3>{label(INFO + "Mechanics", "User Manual")}</h3>
  {#each sections as section (section.title)}
    {@const items = plainText($words.templates[INFO + section.title + "Text"] ?? "").split(/\r?\n/).map(text => text.trim()).filter(Boolean)}
    {#if items.length}
      <h4>{label(INFO + section.title, section.fallback)}</h4>
      <ul>
        {#each items as item, index (index)}
          <li>{item}</li>
        {/each}
      </ul>
    {/if}
  {/each}
{/if}

<style>
  .info-tabs { display: flex; margin: 6px 0; border-bottom: 1px solid rgb(255 255 255 / 10%); }
  .info-tabs button { padding: 4px 12px; background: none; border: 0; border-bottom: 2px solid transparent; }
  .info-tabs button[aria-pressed="true"] { color: white; border-bottom-color: rgb(255 255 255 / 85%); }
  h4 { margin: 8px 0 0; padding: 6px 8px; background: rgb(255 255 255 / 5%); }
  ul { margin: 8px 0; padding-inline-start: 24px; }
  li + li { margin-top: 6px; }
</style>
