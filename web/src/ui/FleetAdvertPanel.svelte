<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import type { FleetAdvert } from "../bridge/fleetAds.ts";
  import { FLEET_JOB_CREATOR } from "../bridge/fleetCommand.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";

  let { store, flow, onEdit }: { store: ClientStore; flow: AppFlow; onEdit: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const { fleet, station, names, words } = store;
  // svelte-ignore state_referenced_locally
  const revision = flow.fleetAdvertRevision;
  const fleetID = $derived($fleet.availability === "ready" ? $fleet.authoritativeFleetID : null);
  const registered = $derived(fleetID !== null && $fleet.fleet?.initState.value.options.isRegistered === true);
  const boss = $derived($fleet.fleet?.initState.value.members.some(member =>
    Number(member.charID) === $station.online?.characterID && (member.job & FLEET_JOB_CREATOR) !== 0) ?? false);
  const R = "UI/Fleet/FleetRegistry/", W = "UI/Fleet/FleetWindow/";
  let advert = $state<FleetAdvert | null>(null);
  let loading = $state(false), removing = $state(false);
  let readFailed = $state(false);

  $effect(() => {
    const id = fleetID, enabled = registered;
    void $revision;
    if (id === null || !enabled) { advert = null; loading = false; readFailed = false; return; }
    let current = true;
    loading = true; readFailed = false;
    void flow.readFleetAdvert(id).then(result => {
      if (current) { advert = result; readFailed = result === null; }
    }, () => {
      if (current) { advert = null; readFailed = true; }
    }).finally(() => { if (current) loading = false; });
    return () => { current = false; };
  });
  $effect(() => {
    const leader = advert?.leader.charID, system = advert?.solarSystemID;
    flow.requestNames([...(leader ? [{ kind: "character" as const, id: leader }] : []),
      ...(system ? [{ kind: "system" as const, id: system }] : [])]);
  });
  $effect(() => {
    flow.requestWords([
      ...["DoNotHaveAnAdvert", "DoNotHaveAnAdvertDetailed", "UnnamedFleet", "MemberCount"].map(label => R + label),
      ...["CreateAdvert", "EditAdvert", "RemoveAdvert"].map(label => W + label),
      "UI/Fleet/Ranks/Boss", "UI/Common/Location", "UI/Common/Description",
    ]);
  });
  function word(label: string, fallback: string): string {
    const text = $words.templates[label];
    return typeof text === "string" && text ? plainText(formatTemplate(text, {}, { nameOf: () => "" })) : fallback;
  }
  function canEdit(): boolean {
    if (boss) return true;
    flow.sayDialog("FleetNotCreator", null, "Only the fleet's boss can change its advert.");
    return false;
  }
  async function remove(): Promise<void> {
    const id = fleetID;
    if (id === null || removing || !canEdit()) return;
    removing = true;
    try { await flow.removeFleetAdvert(id); } catch { /* A retired pilot no longer owns the open panel. */ }
    finally { removing = false; }
  }
</script>

<div class="fleet-advert" data-fleet-advert={registered ? "registered" : "empty"}>
  {#if registered}
    {#if advert && advert.fleetID === fleetID}
      <h3>{advert.fleetName || word(R + "UnnamedFleet", "Unnamed Fleet")}</h3>
      <dl>
        <dt>{word("UI/Fleet/Ranks/Boss", "Boss")}</dt>
        <dd>{resolvedName($names.resolved, "character", advert.leader.charID, "")}</dd>
        {#if !advert.hideInfo}
          <dt>{word("UI/Common/Location", "Location")}</dt>
          <dd>{resolvedName($names.resolved, "system", advert.solarSystemID, "Unknown")}</dd>
          <dt>{word(R + "MemberCount", "Member Count")}</dt><dd>{advert.numMembers}</dd>
        {/if}
      </dl>
      {#if advert.description}<p class="description">{advert.description}</p>{/if}
    {:else if loading}
      <p aria-live="polite">Reading fleet advert…</p>
    {:else if readFailed}
      <p role="status">The current fleet advert could not be read.</p>
    {/if}
    <div class="advert-actions">
      <button type="button" onclick={() => { if (canEdit()) onEdit(); }}>{word(W + "EditAdvert", "Edit Advert")}</button>
      <button type="button" disabled={removing} onclick={() => void remove()}>{word(W + "RemoveAdvert", "Remove Advert")}</button>
    </div>
  {:else}
    <h3>{word(R + "DoNotHaveAnAdvert", "You do not have a fleet advert")}</h3>
    <p>{word(R + "DoNotHaveAnAdvertDetailed", "Create an advert to list your fleet in Fleet Finder.")}</p>
    <div class="advert-actions"><button type="button" onclick={() => { if (canEdit()) onEdit(); }}>{word(W + "CreateAdvert", "Create Advert")}</button></div>
  {/if}
</div>

<style>
  .fleet-advert { padding: .5rem; }
  h3 { margin: 0 0 .5rem; }
  dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .25rem .75rem; margin: 0; }
  dt { color: var(--color-muted); }
  dd { margin: 0; }
  .description { white-space: pre-wrap; overflow-wrap: anywhere; }
  .advert-actions { display: flex; justify-content: flex-end; gap: .35rem; margin-top: .8rem; }
</style>
