<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { WarDungeonIdentity } from "../bridge/dungeonJobs.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { setWarDungeonTracked, trackedJobsChanged, trackedWarDungeonJobs } from "./jobTracking.ts";

  let { store, flow, job }: { store: ClientStore; flow: AppFlow; job: WarDungeonIdentity } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const characterID = $derived($station.online?.characterID ?? null);
  const tracked = $derived.by(() => {
    void $trackedJobsChanged;
    return trackedWarDungeonJobs(characterID).some((row) => row.kind === job.kind && row.instanceID === job.instanceID);
  });
  $effect(() => { flow.requestWords(["UI/Common/Track", "UI/Common/Untrack"]); });
</script>

<button type="button" class:tracked aria-pressed={tracked} disabled={!characterID} onclick={() => setWarDungeonTracked(characterID, job, !tracked)}>
  <img alt="" src={clientTexture(tracked
    ? "res:/UI/Texture/eveicon/control_icons/camera_untrack_16px.png"
    : "res:/UI/Texture/eveicon/system_icons/visibility_16px.png")} />
  {plainText($words.templates[tracked ? "UI/Common/Untrack" : "UI/Common/Track"] ?? "") || (tracked ? "Untrack" : "Track")}
</button>

<style>
  button { display: inline-flex; align-items: center; justify-content: center; gap: 4px; }
  button:not(.tracked):not(:hover) { background: transparent; }
  img { width: 16px; height: 16px; }
</style>
