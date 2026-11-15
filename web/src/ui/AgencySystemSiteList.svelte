<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AgencySiteSystem } from "../bridge/agencySites.ts";
  import type { SpaceEntity } from "../store/types.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { MIN_WARP_DISTANCE_M } from "../bridge/spaceActivate.ts";
  import type { WarDungeonKind } from "../bridge/dungeonJobs.ts";
  import { bracketIcon, loadBrackets } from "../play/brackets.ts";
  import { resolvedName } from "../store/names.ts";
  import { trackedJobsChanged } from "./jobTracking.ts";
  import WarDungeonTrackButton from "./WarDungeonTrackButton.svelte";

  let { flow, store, system, label, word, provider, hub = null }: {
    flow: AppFlow;
    store: ClientStore;
    system: AgencySiteSystem;
    label: string;
    word: (key: string) => string;
    provider: WarDungeonKind;
    hub?: SpaceEntity | null;
  } = $props();
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const flight = store.flight;
  // svelte-ignore state_referenced_locally
  const space = store.space;
  // svelte-ignore state_referenced_locally
  const names = store.names;
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
  let selectedHubID = $state<number | null>(null);
  let bracketsReady = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);
  const sites = $derived(system.sites.filter((site) => site !== null));
  const selectedHub = $derived(hub && (hub.itemID === selectedHubID || !sites.length) ? hub : null);
  const selected = $derived(selectedHub ? undefined : sites.find((site) => site.instanceID === selectedSiteID) ?? sites[0]);
  const hubName = $derived(hub?.typeID ? resolvedName($names.resolved, "type", hub.typeID, hub.name ?? "") : hub?.name ?? "");
  const hubIcon = $derived(hub && bracketsReady ? bracketIcon(hub) : null);
  const hubTooClose = $derived.by(() => {
    const snapshot = $space.snapshot;
    if (!selectedHub || selectedHub.geometryAvailable === false || !snapshot?.ship || snapshot.solarSystemID !== here) return false;
    const from = snapshot.ship.position, to = selectedHub.position;
    return Math.hypot(from.x - to.x, from.y - to.y, from.z - to.z) <= MIN_WARP_DISTANCE_M;
  });
  let trackableSite = $state<{ readonly systemID: number; readonly instanceID: number } | null>(null);

  $effect(() => {
    flow.requestWords([
      "UI/Inflight/SetDestination", "UI/Inflight/DestinationSet", "UI/Inflight/WarpToBookmark",
      "UI/Inflight/Warping", "UI/Neocom/UndockBtn", "UI/Common/Unknown", label,
      "UI/Agency/DisabledHintAlreadyThere",
      ...sites.flatMap((site) => site.dungeonNameID ? ["#" + site.dungeonNameID] : []),
    ]);
  });
  $effect(() => {
    const typeID = hub?.typeID;
    if (typeID) {
      flow.requestNames([{ kind: "type", id: typeID }]);
      void loadBrackets().then(() => { bracketsReady = true; });
    }
  });
  $effect(() => { void selected?.instanceID; void selectedHub?.itemID; error = null; });
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

  async function travel(targetID?: string | number): Promise<void> {
    if (busy) return;
    busy = true;
    error = null;
    try {
      if (typeof targetID === "number") await flow.warpTo(targetID, $warpDistance || 0);
      else if (targetID) await flow.warpToProbeResult(targetID, $warpDistance || 0);
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
    <li><button type="button" aria-pressed={selected?.instanceID === site.instanceID}
      onclick={() => { selectedHubID = null; selectedSiteID = site.instanceID; }}>
      {(site.dungeonNameID && word("#" + site.dungeonNameID)) || word("UI/Common/Unknown")}
    </button></li>
  {/each}
  {#if hub}
    {@const id = hub.itemID}
    <li><button class="hub" type="button" aria-pressed={selectedHub?.itemID === id} onclick={() => (selectedHubID = id)}>
      {#if hubIcon}<img alt="" src={hubIcon} />{/if}
      {hubName || word("UI/Common/Unknown")}
    </button></li>
  {/if}
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
{:else if selectedHub}
  {@const targetID = selectedHub.itemID}
  <button class="primary" type="button" disabled={busy || inWarp || hubTooClose} title={hubTooClose ? word("UI/Agency/DisabledHintAlreadyThere") : ""}
    onclick={() => void travel(targetID)}>
    {word(inWarp ? "UI/Inflight/Warping" : "UI/Inflight/WarpToBookmark")}
  </button>
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
  .hub { display: flex; align-items: center; gap: 4px; }
  .hub img { width: 16px; height: 16px; }
  li button[aria-pressed="true"] { background: rgb(255 255 255 / 0.14); }
  .site-actions { display: flex; gap: 6px; margin-top: 10px; }
  .primary { flex: 1; }
  p { margin: 4px 0; font-size: 12px; }
</style>
