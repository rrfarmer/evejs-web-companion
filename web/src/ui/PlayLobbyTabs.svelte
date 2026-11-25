<script lang="ts">
  // The Station Services window's tabs in the play mode (dockedUI/lobbyWnd.py: Guests, Agents, Offices), from the
  // app's own station reads: the station's guests (station.GetGuests, read as the pilot docks), its agents
  // (agentMgr.GetAgents, flow.loadAgents) and the corporations with an office here (flow.loadStationOffices), each
  // read as its tab is first opened. Names through the app's name cache. An agent opens the app's conversation.
  import { onDestroy } from "svelte";
  import type { Session } from "../app/sessions.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { ContextMenu, type ContextEntry } from "../play/contextMenu.ts";
  import { resolvedName, type NameKind, type NameRef } from "../store/names.ts";
  import type { StationGuest } from "../store/types.ts";
  import OwnerPicture from "./OwnerPicture.svelte";
  import { portraitDefaultPath, portraitUrl } from "./ownerImages.ts";
  import { doubleClickOwner } from "./ownerDoubleClick.ts";
  import { showInfo } from "./showInfo.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import StationOfficeActions from "./StationOfficeActions.svelte";
  import StationPanel from "./StationPanel.svelte";

  let { session, guestMenu, onOpenAgents, onOpenInventory, onReprocess }: {
    session: Session;
    guestMenu: (guest: StationGuest) => readonly (ContextEntry | null)[];
    onOpenAgents: () => void;
    onOpenInventory: () => void;
    onReprocess?: (itemIDs: readonly number[]) => void;
  } = $props();
  const station = $derived(session.store.station);
  const agents = $derived(session.store.agents);
  const names = $derived(session.store.names);
  const words = $derived(session.store.words);
  const identity = $derived(session.store.session);
  const imageServer = $derived(session.flow.imageServer);

  type Tab = "guests" | "agents" | "offices" | "hangars";
  let tab = $state<Tab>("guests");
  const guestContext = new ContextMenu();
  const asked = new Set<Tab>();
  function choose(next: Tab) {
    tab = next;
    guestContext.close();
    guestSettingsOpen = false;
    if (asked.has(next)) return;
    asked.add(next);
    if (next === "agents") void session.flow.loadAgents().catch(() => {});
  }

  const name = (kind: NameKind, id: number | null) => resolvedName($names.resolved, kind, id, "…");
  const guests = $derived($station?.guests ?? []);
  const guestSearchLabel = "UI/Common/Search";
  const clearSearchLabel = "UI/Calendar/Hints/Clear";
  const guestSettingsLabel = "UI/Chat/UserlistSettingButtonHint";
  const compactGuestsLabel = "UI/Chat/ShowCompactMemberList";
  const guestSettingsKey = $derived(
    $identity.accountID === null ? null : `evejs.play.guestCondensedUserList.${$identity.accountID}`,
  );
  const guestPortraitFallback = clientTexture(portraitDefaultPath(32));
  let guestSettingsOpen = $state(false);
  let guestSettingsRoot: HTMLDivElement;
  let guestSettingsButton: HTMLButtonElement;
  let compactGuests = $state(false);
  $effect(() => {
    const key = guestSettingsKey;
    try { compactGuests = key !== null && localStorage.getItem(key) === "1"; }
    catch { compactGuests = false; }
  });

  function setCompactGuests(compact: boolean) {
    compactGuests = compact;
    const key = guestSettingsKey;
    try { if (key !== null) localStorage.setItem(key, compact ? "1" : "0"); }
    catch { /* The setting lasts for the current lobby. */ }
  }

  function dismissGuestSettings(event: KeyboardEvent) {
    if (!guestSettingsOpen || event.key !== "Escape") return;
    event.stopPropagation();
    guestSettingsOpen = false;
    guestSettingsButton.focus();
  }
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

  function openGuestMenu(event: MouseEvent | KeyboardEvent, guest: StationGuest) {
    event.preventDefault();
    event.stopPropagation();
    const entries = guestMenu(guest);
    if (!entries.length) return;
    if (event instanceof MouseEvent && (event.clientX !== 0 || event.clientY !== 0)) {
      guestContext.open(event.clientX, event.clientY, entries);
      return;
    }
    const row = (event.currentTarget as HTMLElement).getBoundingClientRect();
    guestContext.open(row.left, row.bottom, entries);
  }

  function guestKey(event: KeyboardEvent, guest: StationGuest) {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) openGuestMenu(event, guest);
  }

  onDestroy(() => {
    clearTimeout(filterTimer);
    guestContext.close();
  });
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
    const labels = ["UI/Station/Lobby/Hangars", availableOfficesLabel, officeInfoLabel, guestSearchLabel, clearSearchLabel, guestSettingsLabel, compactGuestsLabel,
      ...new Set(agentRows.map((a) => a.missionTypeLabel).filter((l): l is string => !!l))];
    if (labels.length) session.flow.requestWords(labels);
  });
  const word = (label: string | null) => (label ? (typeof $words?.templates?.[label] === "string" ? $words.templates[label] : "") : "");

  async function talk(agentID: number) {
    try { await session.flow.openConversation(agentID); } catch { /* the conversation says why */ }
    onOpenAgents();
  }
</script>

<svelte:window onpointerdown={(event) => {
  if (guestSettingsOpen && !guestSettingsRoot.contains(event.target as Node)) guestSettingsOpen = false;
}} />

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
  <div class="lobby-guest-tools">
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
    <div class="lobby-guest-settings" bind:this={guestSettingsRoot}>
      <button type="button" class="guest-settings-toggle" bind:this={guestSettingsButton}
        title={word(guestSettingsLabel) || "Member list settings"} aria-label={word(guestSettingsLabel) || "Member list settings"}
        aria-expanded={guestSettingsOpen} onclick={() => (guestSettingsOpen = !guestSettingsOpen)}
        onkeydown={dismissGuestSettings}>
        <img src={clientTexture("res:/UI/Texture/eveicon/system_icons/people_16px.png")} alt="" />
      </button>
      {#if guestSettingsOpen}
        <label class="guest-settings-option">
          <input type="checkbox" checked={compactGuests} onchange={(event) => setCompactGuests(event.currentTarget.checked)}
            onkeydown={dismissGuestSettings} />
          {word(compactGuestsLabel) || "Show Compact Member List"}
        </label>
      {/if}
    </div>
  </div>
{/if}
<div class="lobby-list">
  {#if tab === "guests"}
    {#each guestRows as g (g.characterID)}
      {@const portrait = compactGuests ? null : portraitUrl($imageServer, g.characterID, 32)}
      <button type="button" class="lobby-row guest-row" class:compact={compactGuests} aria-haspopup="menu"
        oncontextmenu={(event) => openGuestMenu(event, g)} onkeydown={(event) => guestKey(event, g)}
        onclick={(event) => { if (event.detail === 0) void doubleClickOwner(session.flow, g.characterID).catch(() => {}); }}
        ondblclick={() => void doubleClickOwner(session.flow, g.characterID).catch(() => {})}>
        {#if !compactGuests}
          <OwnerPicture name={g.pilot} urls={portrait ? [portrait, guestPortraitFallback] : [guestPortraitFallback]} />
        {/if}
        <span class="who">{g.pilot || "…"}</span>
        {#if !compactGuests}<span class="dim">{name("corporation", g.corporationID)}</span>{/if}
      </button>
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
  .lobby-guest-tools { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; }
  .lobby-guest-filter { position: relative; width: 100px; }
  .lobby-guest-filter input { box-sizing: border-box; width: 100%; height: 24px; padding: 2px 22px; border: 1px solid #444a48;
    background: #131819 url(/client-res/ui/texture/eveicon/system_icons/search_16px.png) 3px center / 16px no-repeat;
    color: #d7dad6; font: 12px/1.35 var(--font); }
  .lobby-guest-filter input::-webkit-search-cancel-button { appearance: none; }
  .clear-guest-filter { position: absolute; inset: 0 0 0 auto; width: 22px; padding: 0;
    border: 0; background: transparent; color: #b8bfba; cursor: pointer; }
  .lobby-guest-settings { position: relative; }
  .guest-settings-toggle { display: grid; place-items: center; width: 24px; height: 24px; padding: 0;
    border: 0; background: transparent; cursor: pointer; }
  .guest-settings-toggle:hover, .guest-settings-toggle[aria-expanded="true"] { background: rgba(255, 255, 255, 0.09); }
  .guest-settings-toggle img { width: 16px; height: 16px; }
  .guest-settings-option { position: absolute; z-index: 2; top: 100%; right: 0; display: flex; align-items: center;
    gap: 6px; padding: 6px 8px; border: 1px solid #444a48; background: #131819; color: #d7dad6;
    font: 12px/1.35 var(--font); white-space: nowrap; cursor: pointer; }
  .guest-settings-option input { margin: 0; }
  .lobby-list { max-height: 240px; overflow-y: auto; padding: 6px 0; font: 12px/1.35 var(--font); }
  .lobby-row { display: flex; justify-content: space-between; gap: 8px; width: 100%; padding: 3px 4px; border: 0; background: transparent;
    color: #d7dad6; text-align: left; font: inherit; min-height: 0; }
  .lobby-row.agent { cursor: pointer; }
  .lobby-row.agent:hover { background: rgba(255, 255, 255, 0.07); }
  .guest-row { box-sizing: border-box; align-items: center; justify-content: flex-start; height: 40px; cursor: pointer; }
  .guest-row:hover { background: rgba(255, 255, 255, 0.07); }
  .guest-row.compact { height: 18px; padding: 0 4px 0 16px; }
  .guest-row .dim { margin-left: auto; overflow: hidden; text-overflow: ellipsis; }
  .who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dim { color: #8d918c; white-space: nowrap; }
  .free { margin: 0 4px 4px; }
  .office-info { color: inherit; line-height: 1; background: transparent; border: 0; cursor: pointer; padding: 1px 4px; }
</style>
