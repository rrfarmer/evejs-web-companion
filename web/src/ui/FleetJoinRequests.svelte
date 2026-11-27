<script lang="ts">
  import { getContext, onMount } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { noticeBoard } from "./notices.ts";
  import { showInfo } from "./showInfo.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const { fleet, names, words } = store;
  const openOwnerMenu = getContext<((event: MouseEvent | KeyboardEvent, characterID: number) => void) | undefined>("characterOwnerMenu");
  const helpLabel = "UI/Fleet/FleetWindow/JoinRequestsHelp";
  const acceptLabel = "UI/Fleet/AcceptJoinRequest", rejectLabel = "UI/Fleet/RejectJoinRequest";
  const pending = new SvelteSet<number>();
  const read = $derived($fleet.fleet?.joinRequests);
  const rows = $derived((read?.value ?? []).flatMap(request => {
    const id = Number(request.charID);
    if (!Number.isSafeInteger(id) || id <= 0) return [];
    return [{ id, name: resolvedName($names.resolved, "character", id, String(id)) }];
  }).sort((a, b) => a.name.localeCompare(b.name)));

  onMount(() => {
    flow.requestWords([helpLabel, acceptLabel, rejectLabel]);
    const release = flow.retainFleetDetails();
    void flow.loadFleet().catch(() => {});
    return release;
  });

  function word(label: string, fallback: string): string {
    const text = $words.templates[label];
    return typeof text === "string" && text ? plainText(text) : fallback;
  }

  async function decide(characterID: number, accept: boolean): Promise<void> {
    const fleetID = $fleet.authoritativeFleetID;
    if (fleetID === null || pending.has(characterID)) return;
    pending.add(characterID);
    try {
      await flow.decideFleetJoinRequest(fleetID, characterID, accept);
    } catch (error) {
      noticeBoard.post({ kind: "warn", title: "Join requests", detail: error instanceof Error ? error.message : String(error) });
    } finally {
      pending.delete(characterID);
    }
  }
</script>

<section class="fleet-join-requests">
  <p>{word(helpLabel, "The following pilots wish to participate in your fleet")}</p>
  {#if read?.error}<p role="status">Join requests could not be read.</p>{/if}
  <ul>
    {#each rows as row (row.id)}
      <li data-fleet-applicant={row.id} oncontextmenu={event => openOwnerMenu?.(event, row.id)}>
        <button class="evelink showInfo" type="button" onclick={event => showInfo({ kind: "character", characterID: row.id }, { shift: event.shiftKey })}
          onkeydown={event => { if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) openOwnerMenu?.(event, row.id); }}>{row.name}</button>
        <button type="button" disabled={pending.has(row.id)} onclick={() => void decide(row.id, true)}>{word(acceptLabel, "Accept")}</button>
        <button type="button" disabled={pending.has(row.id)} onclick={() => void decide(row.id, false)}>{word(rejectLabel, "Reject")}</button>
      </li>
    {/each}
  </ul>
</section>

<style>
  section { padding: .45rem .6rem; }
  p { margin: 0 0 .4rem; }
  ul { padding: 0; margin: 0; list-style: none; }
  li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: .35rem; align-items: center; min-height: 23px; }
  li button { min-height: 22px; }
  .evelink { justify-self: start; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
