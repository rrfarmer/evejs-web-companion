<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { setMercenaryOperationTracked, trackedJobsChanged, trackedMercenaryOperations } from "./jobTracking.ts";
  import { clientTexture } from "./skillGroupIcons.ts";

  let { store, flow, id, eligible, compact = false }: {
    store: ClientStore; flow: AppFlow; id: string; eligible: boolean; compact?: boolean;
  } = $props();
  const station = $derived(store.station);
  const words = $derived(store.words);
  const character = $derived($station.online?.characterID ?? null);
  const tracked = $derived.by(() => {
    void $trackedJobsChanged;
    return Object.hasOwn(trackedMercenaryOperations(character), id);
  });
  const track = "UI/Common/Track", untrack = "UI/Common/Untrack";
  const label = $derived(plainText($words.templates[tracked ? untrack : track] ?? (tracked ? "Untrack" : "Track")));
  $effect(() => { flow.requestWords([track, untrack]); });
</script>

{#if tracked || eligible}
  <button class="mto-track" class:compact type="button" aria-pressed={tracked} aria-label={label} title={label}
    disabled={!character} onclick={() => setMercenaryOperationTracked(character, id, !tracked)}>
    <img alt="" src={clientTexture(tracked ? "res:/UI/Texture/eveicon/control_icons/camera_untrack_16px.png"
      : "res:/UI/Texture/eveicon/system_icons/visibility_16px.png")} />
    {#if !compact}{label}{/if}
  </button>
{/if}

<style>
  button { display: inline-flex; align-items: center; justify-content: center; gap: 4px; }
  img { width: 16px; height: 16px; }
  .compact { align-self: start; padding: 3px; }
</style>
