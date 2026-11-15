<script lang="ts">
  import type { AppFlow, WarDungeonJob } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { resolvedName } from "../store/names.ts";
  import { openWarDungeonJob } from "./jobBoardRequests.ts";
  import WarDungeonTrackButton from "./WarDungeonTrackButton.svelte";

  let { store, flow, job, header = true }: { store: ClientStore; flow: AppFlow; job: WarDungeonJob; header?: boolean } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const flight = store.flight;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const space = store.space;
  // svelte-ignore state_referenced_locally
  const waypoints = flow.waypoints;
  // svelte-ignore state_referenced_locally
  const warpDistance = flow.warpDistance;
  // svelte-ignore state_referenced_locally
  const activeDungeon = flow.activeDungeon;
  const here = $derived($flight.status?.solarSystemID ?? $station.online?.solarSystemID ?? null);
  const local = $derived(here === job.solarSystemID);
  const inside = $derived(local && $activeDungeon?.instanceID === job.instanceID);
  const docked = $derived($flight.status?.docked ?? !!$station.online?.stationID);
  const warping = $derived(($space.snapshot?.ship?.mode ?? $flight.status?.shipMode) === "WARP");
  const destination = $derived($waypoints.at(-1) === job.solarSystemID);
  const nameID = $derived(job.nameID ?? job.data?.nameID);
  let busy = $state(false);
  let error = $state<string | null>(null);
  const word = (label: string) => plainText($words.templates[label] ?? "");
  const title = $derived((local && job.targetID ? `[${job.targetID}] ` : "") + (nameID ? word(`#${nameID}`) : word("UI/Common/Unknown")));
  const actionLabel = $derived(!local ? (destination ? "UI/Inflight/DestinationSet" : "UI/Inflight/SetDestination")
    : docked ? "UI/Neocom/UndockBtn" : warping ? "UI/Inflight/Warping" : "UI/Inflight/WarpToBookmark");
  $effect(() => {
    flow.requestWords(["UI/Generic/CurrentLocation", "UI/Opportunities/ViewOpportunity", "UI/Common/Unknown", "UI/Inflight/DestinationSet",
      "UI/Inflight/SetDestination", "UI/Neocom/UndockBtn", "UI/Inflight/Warping", "UI/Inflight/WarpToBookmark",
      ...(nameID ? [`#${nameID}`] : [])]);
  });
  async function travel(): Promise<void> {
    if (busy) return;
    busy = true;
    error = null;
    try {
      if (!local) await flow.setDestination(job.solarSystemID);
      else if (docked) await flow.undock();
      else if (job.targetID) await flow.warpToProbeResult(job.targetID, $warpDistance || 0);
    } catch (cause) {
      error = panelErrorWords(cause);
    } finally { busy = false; }
  }
</script>

<article class="war-opportunity">
  {#if header}
    <button type="button" class="opportunity-title" title={word("UI/Opportunities/ViewOpportunity")} onclick={() => openWarDungeonJob(job)}>{title}</button>
    <p>{inside ? word("UI/Generic/CurrentLocation") : resolvedName($names.resolved, "system", job.solarSystemID, "")}</p>
  {/if}
  <div class="actions">
    <WarDungeonTrackButton {store} {flow} {job} />
    {#if !inside && (!local || docked || job.targetID)}
      <button type="button" disabled={busy || (!local ? destination : warping)} onclick={() => void travel()}>{word(actionLabel)}</button>
    {/if}
  </div>
  {#if error}<p role="status">{error}</p>{/if}
</article>

<style>
  .war-opportunity { margin: 6px 0; }
  .opportunity-title { display: block; width: 100%; font-size: 12px; font-weight: 600; text-align: left; padding: 4px 6px; }
  .actions { display: flex; gap: 5px; flex-wrap: wrap; }
  p { margin: 3px 0 5px; opacity: 0.8; font-size: 12px; }
</style>
