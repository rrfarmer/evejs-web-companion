<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { DungeonOpportunityIdentity } from "../bridge/dungeonJobs.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { setDungeonTracked, trackedJobsChanged, trackedDungeonJobs } from "./jobTracking.ts";

  let { store, flow, job }: { store: ClientStore; flow: AppFlow; job: DungeonOpportunityIdentity } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const untrackedObjectiveDungeonInstanceID = flow.untrackedObjectiveDungeonInstanceID;
  const characterID = $derived($station.online?.characterID ?? null);
  const tracked = $derived.by(() => {
    if (job.kind === "signature" || job.kind === "combat") return $untrackedObjectiveDungeonInstanceID !== job.instanceID;
    void $trackedJobsChanged;
    return trackedDungeonJobs(characterID).some((row) => row.kind === job.kind && row.instanceID === job.instanceID);
  });
  $effect(() => { flow.requestWords(["UI/Common/Track", "UI/Common/Untrack"]); });
  function toggleTracking(): void {
    const { kind, instanceID } = job;
    if (kind === "signature" || kind === "combat") flow.setObjectiveDungeonTracked(instanceID, !tracked);
    else setDungeonTracked(characterID, { kind, instanceID }, !tracked);
  }
</script>

<button type="button" class:tracked aria-pressed={tracked} disabled={!characterID} onclick={toggleTracking}>
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
