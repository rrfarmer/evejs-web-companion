<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AgencySiteSystem } from "../bridge/agencySites.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { WarDungeonKind } from "../bridge/dungeonJobs.ts";
  import { trackedJobsChanged } from "./jobTracking.ts";
  import WarDungeonTrackButton from "./WarDungeonTrackButton.svelte";

  let { flow, store, system, label, word, provider }: {
    flow: AppFlow;
    store: ClientStore;
    system: AgencySiteSystem;
    label: string;
    word: (key: string) => string;
    provider: WarDungeonKind;
  } = $props();
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const flight = store.flight;
  // svelte-ignore state_referenced_locally
  const space = store.space;
  // svelte-ignore state_referenced_locally
  const waypoints = flow.waypoints;
  // svelte-ignore state_referenced_locally
  const warpDistance = flow.warpDistance;
  // svelte-ignore state_referenced_locally
  const anomaliesChanged = flow.agencyAnomaliesChanged;
  const here = $derived($flight.status?.solarSystemID ?? $station.online?.solarSystemID ?? null);
  const docked = $derived($flight.status?.docked ?? !!$station.online?.stationID);
  const inWarp = $derived(($space.snapshot?.ship?.mode ?? $flight.status?.shipMode) === "WARP");
  const destinationSet = $derived($waypoints.at(-1) === system.solarSystemID);
  let selectedSiteID = $state<number | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);
  const sites = $derived(system.sites.filter((site) => site !== null));
  const selected = $derived(sites.find((site) => site.instanceID === selectedSiteID) ?? sites[0]);
  let trackableSite = $state<{ readonly systemID: number; readonly instanceID: number } | null>(null);

  $effect(() => {
    flow.requestWords([
      "UI/Inflight/SetDestination", "UI/Inflight/DestinationSet", "UI/Inflight/WarpToBookmark",
      "UI/Inflight/Warping", "UI/Neocom/UndockBtn", "UI/Common/Unknown", label,
      ...sites.flatMap((site) => site.dungeonNameID ? ["#" + site.dungeonNameID] : []),
    ]);
  });
  $effect(() => { void selected?.instanceID; error = null; });
  $effect(() => {
    const instanceID = selected?.instanceID, systemID = system.solarSystemID;
    void $station.online?.warFactionID;
    void here;
    void $waypoints;
    void $anomaliesChanged;
    void $trackedJobsChanged;
    if (!instanceID) { trackableSite = null; return; }
    let current = true;
    void flow.warDungeonJobs().then((jobs) => {
      if (current) trackableSite = jobs.some((job) => job.kind === provider && job.solarSystemID === systemID && job.instanceID === instanceID)
        ? { systemID, instanceID } : null;
    }, () => { if (current) trackableSite = null; });
    return () => { current = false; };
  });

  async function travel(targetID?: string): Promise<void> {
    if (busy) return;
    busy = true;
    error = null;
    try {
      if (targetID) await flow.warpToProbeResult(targetID, $warpDistance || 0);
      else await flow.undock();
    } catch (cause) {
      error = panelErrorWords(cause);
    } finally {
      busy = false;
    }
  }
</script>

<h4>{word(label)}</h4>
<ul>
  {#each sites as site (site.instanceID)}
    <li><button type="button" aria-pressed={selected?.instanceID === site.instanceID} onclick={() => (selectedSiteID = site.instanceID)}>
      {(site.dungeonNameID && word("#" + site.dungeonNameID)) || word("UI/Common/Unknown")}
    </button></li>
  {/each}
  </ul>
<div class="site-actions">
{#if selected && trackableSite?.instanceID === selected.instanceID && trackableSite.systemID === system.solarSystemID}
  <WarDungeonTrackButton {store} {flow} job={{ kind: provider, instanceID: selected.instanceID }} />
{/if}
{#if system.solarSystemID !== here}
  <button class="primary" type="button" disabled={destinationSet} onclick={() => flow.setDestination(system.solarSystemID)}>
    {word(destinationSet ? "UI/Inflight/DestinationSet" : "UI/Inflight/SetDestination")}
  </button>
{:else if docked}
  <button class="primary" type="button" disabled={busy} onclick={() => void travel()}>{word("UI/Neocom/UndockBtn")}</button>
{:else if selected?.targetID}
  {@const targetID = selected.targetID}
  <button class="primary" type="button" disabled={busy || inWarp} onclick={() => void travel(targetID)}>
    {word(inWarp ? "UI/Inflight/Warping" : "UI/Inflight/WarpToBookmark")}
  </button>
{/if}
</div>
{#if error}<p role="status">{error}</p>{/if}

<style>
  h4 { margin: 12px 0 5px; font-size: 13px; }
  ul { max-height: 110px; overflow: auto; list-style: none; padding: 0; margin: 0; background: rgb(0 0 0 / 0.3); }
  li button { width: 100%; padding: 4px 8px; text-align: left; font-size: 12px; }
  li button[aria-pressed="true"] { background: rgb(255 255 255 / 0.14); }
  .site-actions { display: flex; gap: 6px; margin-top: 10px; }
  .primary { flex: 1; }
  p { margin: 4px 0; font-size: 12px; }
</style>
