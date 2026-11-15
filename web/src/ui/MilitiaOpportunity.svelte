<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { MILITIA_FACTIONS, type MilitiaFactionID, type MilitiaOffice } from "../bridge/militiaEnlistment.ts";
  import { clientTexture } from "../play/window.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { untrackMilitiaJob } from "./jobTracking.ts";
  import { openTheatersOfWar } from "./theatersOfWarRequests.ts";

  let { store, flow, factionID }: { store: ClientStore; flow: AppFlow; factionID: MilitiaFactionID } = $props();
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const travelLabel = "UI/Objectives/Titles/TravelToLocation";
  const continueLabel = "UI/Objectives/Titles/ContinueFWEnlistment";
  const openLabel = "UI/FactionWarfare/FwEnlistmentWnd";
  const destinationLabel = "UI/Inflight/SetDestination";
  const dockLabel = "UI/Inflight/DockInStation";
  const untrackLabel = "UI/Common/Untrack";
  let office = $state<MilitiaOffice | null | undefined>(undefined);
  let problem = $state("");
  let docking = $state(false);
  const faction = $derived(MILITIA_FACTIONS[factionID]);
  const titleLabel = $derived(`UI/FactionWarfare/frontlinesDashboard/CTA${faction.banner}`);
  const arrived = $derived(office != null && $station.online?.stationID === office.stationID);
  const inOfficeSystem = $derived(office != null && $station.online?.solarSystemID === office.systemID && !$station.online?.stationID && !$station.online?.structureID);
  const title = $derived(word(titleLabel, `Enlist with ${resolvedName($names.resolved, "owner", factionID, faction.name)}`));
  const place = $derived(office ? resolvedName($names.resolved, "station", office.stationID, String(office.stationID)) : "");

  function word(label: string, fallback: string): string {
    const template = $words.templates[label];
    return template ? plainText(formatTemplate(template, {})) || fallback : fallback;
  }
  $effect(() => {
    flow.requestWords([titleLabel, travelLabel, continueLabel, openLabel, destinationLabel, dockLabel, untrackLabel]);
    flow.requestNames([{ kind: "owner", id: factionID }]);
  });
  $effect(() => {
    const id = factionID;
    const pilot = $station.online?.characterID;
    const system = $station.online?.solarSystemID;
    office = undefined;
    problem = "";
    if (!pilot || !system) return;
    let current = true;
    void flow.nearestMilitiaOffice(id, true).then((data) => { if (current) office = data; }, (error: unknown) => {
      if (!current) return;
      office = null;
      problem = error instanceof Error ? error.message : String(error);
    });
    return () => { current = false; };
  });

  async function travel(stationID: number) {
    if (docking) return;
    if (!inOfficeSystem) { flow.setDestination(stationID); return; }
    docking = true;
    problem = "";
    try { await flow.dockAt(stationID); }
    catch (error) { problem = error instanceof Error ? error.message : String(error); }
    finally { docking = false; }
  }
</script>

<article class="militia-opportunity" aria-label={title}>
  <header>
    <img alt="" src={clientTexture(`res:/UI/Texture/Classes/Enlistment/logos/${faction.logo}.png`)} />
    <strong>{title}</strong>
    <button type="button" onclick={() => untrackMilitiaJob($station.online?.characterID ?? null, factionID)}>{word(untrackLabel, "Untrack")}</button>
  </header>
  {#if office}
    <div class:done={arrived}>
      <span>{word(travelLabel, "Travel to location")}</span>
      <strong>{place}</strong>
      {#if !arrived}
        <button type="button" disabled={docking} onclick={() => office && travel(office.stationID)}>
          {inOfficeSystem ? word(dockLabel, "Dock") : word(destinationLabel, "Set Destination")}
        </button>
      {/if}
    </div>
  {:else if office === undefined}<p>Finding a militia office…</p>
  {:else if !problem}<p>No militia office is available.</p>{/if}
  {#if arrived}<div class="continue">{word(continueLabel, "Continue Factional Warfare enlistment")}</div>{/if}
  <div><button type="button" onclick={() => openTheatersOfWar("enlistment")}>{word(openLabel, "Enlistment")}</button></div>
  {#if problem}<p role="alert">{problem}</p>{/if}
</article>

<style>
  .militia-opportunity { padding: 8px; margin-bottom: 2px; border: 1px solid #ffffff20; background: #101419b8; }
  header, div { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 4px; }
  header img { width: 22px; height: 22px; object-fit: contain; }
  header strong { flex: 1 1 auto; }
  .done { opacity: .7; text-decoration: line-through; }
  button { font: inherit; color: inherit; background: #ffffff0d; border: 1px solid #ffffff29; padding: 3px 7px; cursor: pointer; }
  button:hover { background: #ffffff1c; }
  p { margin: 4px 0; }
</style>
