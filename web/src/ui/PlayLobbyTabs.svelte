<script lang="ts">
  // The Station Services window's tabs in the play mode (dockedUI/lobbyWnd.py: Guests, Agents, Offices), from the
  // app's own station reads: the station's guests (station.GetGuests, read as the pilot docks), its agents
  // (agentMgr.GetAgents, flow.loadAgents) and the corporations with an office here (flow.loadStationOffices), each
  // read as its tab is first opened. Names through the app's name cache. An agent opens the app's conversation.
  import { onDestroy } from "svelte";
  import type { Session } from "../app/sessions.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName, type NameKind, type NameRef } from "../store/names.ts";
  import { showInfo } from "./showInfo.ts";
  import StationOfficeActions from "./StationOfficeActions.svelte";
  import StationPanel from "./StationPanel.svelte";

  let { session, onOpenAgents, onOpenInventory, onReprocess }: {
    session: Session;
    onOpenAgents: () => void;
    onOpenInventory: () => void;
    onReprocess?: (itemIDs: readonly number[]) => void;
  } = $props();
  const station = $derived(session.store.station);
  const agents = $derived(session.store.agents);
  const names = $derived(session.store.names);
  const words = $derived(session.store.words);

  type Tab = "guests" | "agents" | "offices" | "hangars";
  let tab = $state<Tab>("guests");
  const asked = new Set<Tab>();
  function choose(next: Tab) {
    tab = next;
    if (asked.has(next)) return;
    asked.add(next);
    if (next === "agents") void session.flow.loadAgents().catch(() => {});
  }
  choose("guests");

  const name = (kind: NameKind, id: number | null) => resolvedName($names.resolved, kind, id, "…");
  const guests = $derived($station?.guests ?? []);
  const guestSearchLabel = "UI/Common/Search";
  const clearSearchLabel = "UI/Calendar/Hints/Clear";
  let guestSearch = $state("");
  let guestFilter = $state("");
  let guestSearchInput: HTMLInputElement;
  let filterTimer: ReturnType<typeof setTimeout> | undefined;
  const guestRows = $derived(guests
    .map(guest => ({ ...guest, pilot: resolvedName($names.resolved, "character", guest.characterID, "") }))
    .filter(guest => guest.pilot.toLowerCase().includes(guestFilter))
    .sort((a, b) => a.pilot.localeCompare(b.pilot, undefined, { sensitivity: "base" })));

  function applyGuestFilter() {
    clearTimeout(filterTimer);
    filterTimer = undefined;
    guestFilter = guestSearch.toLowerCase();
  }

  function scheduleGuestFilter(event: Event & { currentTarget: HTMLInputElement }) {
    guestSearch = event.currentTarget.value;
    if (filterTimer === undefined) filterTimer = setTimeout(applyGuestFilter, 400);
  }

  function clearGuestFilter() {
    guestSearch = "";
    applyGuestFilter();
    guestSearchInput.focus();
  }

  onDestroy(() => clearTimeout(filterTimer));
  const stationID = $derived($station?.online?.stationID ?? null);
  const officeContext = $derived.by(() => {
    const online = $station?.online;
    const dock = online?.stationID ?? online?.structureID;
    return dock == null ? null : `${dock}:${online?.corporationID}:${online?.corpRole}`;
  });
  $effect(() => {
    if (tab === "offices" && officeContext !== null) {
      void session.flow.loadStationOffices().catch(() => {});
    }
  });
  const agentRows = $derived(($agents?.agents ?? []).filter((a) => stationID === null || a.stationID === stationID));
  const officeIDs = $derived($station?.offices?.corporationIDs ?? []);
  const officeRows = $derived(officeIDs.map(id => ({ id, name: name("corporation", id) }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id));
  const availableOfficesLabel = "UI/Station/Lobby/NumAvailableOffices";
  const officeInfoLabel = "UI/Station/Lobby/CorpShowInfoButton";

  // the names on show, asked for as they come
  $effect(() => {
    const refs: NameRef[] = [
      ...guests.flatMap((g) => [{ kind: "character" as const, id: g.characterID }, ...(g.corporationID ? [{ kind: "corporation" as const, id: g.corporationID }] : [])]),
      ...agentRows.map((a) => ({ kind: "agent" as const, id: a.agentID })),
      ...officeIDs.map((id) => ({ kind: "corporation" as const, id })),
    ];
    if (refs.length) session.flow.requestNames(refs);
    // the agents' mission types are the client's own words, by label
    const labels = ["UI/Station/Lobby/Hangars", availableOfficesLabel, officeInfoLabel, guestSearchLabel, clearSearchLabel,
      ...new Set(agentRows.map((a) => a.missionTypeLabel).filter((l): l is string => !!l))];
    if (labels.length) session.flow.requestWords(labels);
  });
  const word = (label: string | null) => (label ? (typeof $words?.templates?.[label] === "string" ? $words.templates[label] : "") : "");

  async function talk(agentID: number) {
    try { await session.flow.openConversation(agentID); } catch { /* the conversation says why */ }
    onOpenAgents();
  }
</script>

<div class="lobby-tabs" role="tablist">
  <button role="tab" class:on={tab === "guests"} aria-selected={tab === "guests"} onclick={() => choose("guests")}>Guests [{guests.length}]</button>
  <button role="tab" class:on={tab === "agents"} aria-selected={tab === "agents"} onclick={() => choose("agents")}>Agents</button>
  <button role="tab" class:on={tab === "offices"} aria-selected={tab === "offices"} onclick={() => choose("offices")}>Offices</button>
  <button role="tab" class:on={tab === "hangars"} aria-selected={tab === "hangars"} onclick={() => choose("hangars")}>{word("UI/Station/Lobby/Hangars") || "Hangars"}</button>
</div>
{#if tab === "hangars"}
  <StationPanel store={session.store} flow={session.flow} lobbyHangars {onOpenInventory} {onReprocess} />
{:else}
{#if tab === "guests"}
  <div class="lobby-guest-filter">
    <input type="search" maxlength="37" aria-label={word(guestSearchLabel) || "Search"}
      placeholder={word(guestSearchLabel) || "Search"} value={guestSearch} oninput={scheduleGuestFilter}
      onblur={applyGuestFilter} bind:this={guestSearchInput}
      onkeydown={(event) => { if (event.key === "Enter") applyGuestFilter(); }} />
    {#if guestSearch}
      <button type="button" class="clear-guest-filter" title={word(clearSearchLabel) || "Clear"}
        aria-label={word(clearSearchLabel) || "Clear"} onclick={clearGuestFilter}>×</button>
    {/if}
  </div>
{/if}
<div class="lobby-list">
  {#if tab === "guests"}
    {#each guestRows as g (g.characterID)}
      <div class="lobby-row"><span class="who">{g.pilot || "…"}</span><span class="dim">{name("corporation", g.corporationID)}</span></div>
    {:else}<div class="dim">{guestFilter ? "No matching guests." : "No guests."}</div>{/each}
  {:else if tab === "agents"}
    {#each agentRows as a (a.agentID)}
      <button class="lobby-row agent" onclick={() => talk(a.agentID)}>
        <span class="who">{name("agent", a.agentID)}</span>
        <span class="dim">{a.level ? `Level ${a.level}` : ""}{word(a.missionTypeLabel) ? ` · ${word(a.missionTypeLabel)}` : ""}</span>
      </button>
    {:else}<div class="dim">{$agents?.loaded ? "No agents here." : "Reading the agents…"}</div>{/each}
  {:else}
    {#if $station?.offices && !$station.offices.available}
      <div class="dim">This connection does not carry the offices.</div>
    {:else}
      {#if $station?.offices?.freeOffices != null}
        {@const numOffices = $station.offices.freeOffices}
        <div class="dim free">{plainText(formatTemplate(word(availableOfficesLabel), { numOffices }, { nameOf: name })) || `${numOffices} offices free`}</div>
      {/if}
      {#each officeRows as office (office.id)}
        <div class="lobby-row"><span class="who">{office.name}</span>
          <button type="button" class="office-info" title={plainText(word(officeInfoLabel)) || "Show Info"}
            aria-label={`Show Info for ${office.name}`} onclick={() => showInfo({ kind: "corporation", corporationID: office.id })}>ⓘ</button>
        </div>
      {:else}<div class="dim">{$station?.offices ? "No corporation has an office here." : "Reading the offices…"}</div>{/each}
    {/if}
  {/if}
</div>
{#if tab === "offices"}<StationOfficeActions store={session.store} flow={session.flow} />{/if}
{/if}

<style>
  .lobby-tabs { display: flex; gap: 2px; margin-top: 12px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
  .lobby-tabs button { min-height: 0; padding: 4px 6px; background: transparent; border: 1px solid transparent; border-bottom: none;
    color: #9a9e99; font: 12px/1.3 var(--font); cursor: pointer; }
  .lobby-tabs button.on { color: #f0f1ee; background: rgba(255, 255, 255, 0.07); border-color: rgba(255, 255, 255, 0.12); box-shadow: inset 0 -2px 0 #d2d5d0; }
  .lobby-guest-filter { position: relative; width: 100px; margin-top: 8px; }
  .lobby-guest-filter input { box-sizing: border-box; width: 100%; height: 24px; padding: 2px 22px; border: 1px solid #444a48;
    background: #131819 url(/client-res/ui/texture/eveicon/system_icons/search_16px.png) 3px center / 16px no-repeat;
    color: #d7dad6; font: 12px/1.35 var(--font); }
  .lobby-guest-filter input::-webkit-search-cancel-button { appearance: none; }
  .clear-guest-filter { position: absolute; inset: 0 0 0 auto; width: 22px; padding: 0;
    border: 0; background: transparent; color: #b8bfba; cursor: pointer; }
  .lobby-list { max-height: 240px; overflow-y: auto; padding: 6px 0; font: 12px/1.35 var(--font); }
  .lobby-row { display: flex; justify-content: space-between; gap: 8px; width: 100%; padding: 3px 4px; border: 0; background: transparent;
    color: #d7dad6; text-align: left; font: inherit; min-height: 0; }
  .lobby-row.agent { cursor: pointer; }
  .lobby-row.agent:hover { background: rgba(255, 255, 255, 0.07); }
  .who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dim { color: #8d918c; white-space: nowrap; }
  .free { margin: 0 4px 4px; }
  .office-info { color: inherit; line-height: 1; background: transparent; border: 0; cursor: pointer; padding: 1px 4px; }
</style>
