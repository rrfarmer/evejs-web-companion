<script lang="ts">
  import type { AppFlow, DungeonOpportunityJob } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { formatTemplate, plainText, type TemplateArguments } from "../bridge/clientWords.ts";
  import { dungeonTravelAction, dungeonTravelProgress, isCurrentDungeonSite } from "../bridge/dungeonJobs.ts";
  import type { ShipRestrictions } from "../bridge/dungeonTracking.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { securityStatusColor, shownSecurity } from "../bridge/systemSecurity.ts";
  import { resolvedName } from "../store/names.ts";
  import { openDungeonJob } from "./jobBoardRequests.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import DungeonTrackButton from "./DungeonTrackButton.svelte";
  import SignatureObjectives from "./SignatureObjectives.svelte";

  let { store, flow, job, expanded = true, onToggle }: {
    store: ClientStore; flow: AppFlow; job: DungeonOpportunityJob; expanded?: boolean; onToggle?: () => void;
  } = $props();
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
  const docked = $derived($flight.status?.docked ?? !!$station.online?.stationID);
  const warping = $derived(($space.snapshot?.ship?.mode ?? $flight.status?.shipMode) === "WARP");
  const inside = $derived(!warping && isCurrentDungeonSite(job, here, $activeDungeon));
  const destination = $derived($waypoints.at(-1) === job.solarSystemID);
  const nameID = $derived(job.nameID ?? job.data?.nameID);
  const systemName = $derived(resolvedName($names.resolved, "system", job.solarSystemID, ""));
  const security = $derived($names.systemSecurity?.[job.solarSystemID] ?? null);
  const action = $derived(dungeonTravelAction({ local, inside, docked, destinationSet: destination, jumps: job.jumps, targetID: job.targetID }));
  const actionLabels = { destination: "UI/Inflight/SetDestination", jump: "UI/Inflight/Jump",
    undock: "UI/Neocom/UndockBtn", warp: "UI/Objectives/Titles/WarpToSite" };
  const travelTitle = "UI/Objectives/Titles/TravelToSite";
  const restrictionTitle = "UI/Objectives/Titles/ShipRestrictions";
  const jumpCount = "UI/Common/numberOfJumps";
  let busy = $state(false);
  let error = $state<string | null>(null);
  let restrictions = $state<ShipRestrictions | null>(null);
  let maximumJumps = $state(0);
  const progress = $derived(dungeonTravelProgress(job.jumps, destination, maximumJumps));
  const shipTypeID = $derived($flight.status?.shipTypeID ?? $space.snapshot?.ship?.typeID ?? null);
  const restricted = $derived(restrictions !== null && (shipTypeID === null || !restrictions.allowed.some((entry) => entry.typeID === shipTypeID)));
  const word = (label: string, args: TemplateArguments = {}) => plainText(formatTemplate($words.templates[label] ?? "", args, {
    nameOf: (kind, id) => resolvedName($names.resolved, kind, id, ""),
  }));
  const title = $derived((local && job.targetID ? `[${job.targetID}] ` : "") + (nameID ? word(`#${nameID}`) : word("UI/Common/Unknown")));
  const feature = $derived(job.data?.contentTags.find((tag) => tag.type === "feature") ?? null);
  $effect(() => {
    flow.requestWords(["UI/Generic/CurrentLocation", "UI/Opportunities/ViewOpportunity", "UI/Common/Unknown",
      "UI/Inflight/Warping", "UI/Generic/NoGateToGateRouteShort", travelTitle, restrictionTitle, jumpCount,
      ...Object.values(actionLabels), ...(nameID ? [`#${nameID}`] : [])]);
    flow.requestSystemSecurity([job.solarSystemID]);
  });
  $effect(() => {
    const dungeonID = job.dungeonID;
    restrictions = null;
    if (!expanded) return;
    let current = true;
    void flow.readDungeonShipRestrictions(dungeonID).then((data) => { if (current) restrictions = data; }, () => {});
    return () => { current = false; };
  });
  $effect(() => {
    const jumps = job.jumps;
    if (!destination) maximumJumps = 0;
    else if (jumps !== null && jumps > maximumJumps) maximumJumps = jumps;
  });
  async function travel(): Promise<void> {
    if (busy || action === null) return;
    busy = true;
    error = null;
    try {
      if (action === "destination") await flow.setDestination(job.solarSystemID);
      else if (action === "jump") await flow.jumpAlongWaypoints(job.solarSystemID);
      else if (action === "undock") await flow.undock();
      else if (job.targetID) await flow.warpToProbeResult(job.targetID, $warpDistance || 0);
    } catch (cause) {
      error = panelErrorWords(cause);
    } finally { busy = false; }
  }
</script>

<article class="dungeon-opportunity">
  {#if onToggle}
    <header>
      <button type="button" class="view" title={word("UI/Opportunities/ViewOpportunity")} aria-label={word("UI/Opportunities/ViewOpportunity")}
        onclick={() => openDungeonJob(job)}>
        <img alt="" src={clientTexture(feature?.icon ?? "res:/UI/Texture/eveicon/system_icons/visibility_16px.png")} />
      </button>
      <button type="button" class="opportunity-title" aria-expanded={expanded} onclick={onToggle}>{title}</button>
    </header>
  {/if}
  <div class="actions">
    <DungeonTrackButton {store} {flow} {job} />
    {#if !onToggle && action}
      <button type="button" disabled={busy || warping} onclick={() => void travel()}>{word(warping ? "UI/Inflight/Warping" : actionLabels[action])}</button>
    {/if}
  </div>
  {#if expanded}
    {#if inside && onToggle}
      {#if job.kind === "signature"}<SignatureObjectives {store} {flow} {job} />
      {:else}<p>{word("UI/Generic/CurrentLocation")}</p>{/if}
    {/if}
    {#if !inside && (onToggle || restricted)}
      <div class="objective">
        {#if onToggle}<strong>{word(travelTitle)}</strong>{/if}
        {#if restricted}
          <button class="restriction" type="button" onclick={() => flow.openShipRestrictions(job.dungeonID)}>{word(restrictionTitle)}</button>
        {/if}
        {#if onToggle && !local}
          <div class="location">
            <span>{#if security !== null}<b style:color={securityStatusColor(security)}>{shownSecurity(security).toFixed(1)}</b>{" "}{/if}{systemName}</span>
            <span>{job.jumps === null ? word("UI/Generic/NoGateToGateRouteShort") : word(jumpCount, { numJumps: job.jumps })}</span>
          </div>
          {#if job.jumps !== null}<progress value={progress} max="1" aria-label={word(travelTitle)}></progress>{/if}
        {/if}
        {#if onToggle && action}
          <button type="button" disabled={busy || warping} onclick={() => void travel()}>{word(warping ? "UI/Inflight/Warping" : actionLabels[action])}</button>
        {/if}
      </div>
    {/if}
    {#if error}<p role="status">{error}</p>{/if}
  {/if}
</article>

<style>
  .dungeon-opportunity { margin: 6px 0; }
  header { display: flex; gap: 4px; }
  .view { flex: none; padding: 4px; }
  .view img { display: block; width: 16px; height: 16px; }
  .opportunity-title { flex: 1; font-size: 12px; font-weight: 600; text-align: left; padding: 4px 6px; }
  .actions { display: flex; gap: 5px; flex-wrap: wrap; }
  .objective { display: grid; gap: 4px; margin-top: 4px; padding: 8px; background: rgb(0 0 0 / 0.25); font-size: 12px; }
  .location { display: flex; justify-content: space-between; gap: 4px; }
  progress { width: 100%; height: 5px; accent-color: var(--theme-focus, #58a6dc); }
  .restriction { color: #f39082; justify-self: start; }
  p { margin: 3px 0 5px; opacity: 0.8; font-size: 12px; }
</style>
