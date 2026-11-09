<script lang="ts">
  // The Station Services window's tabs in the play mode (dockedUI/lobbyWnd.py: Guests, Agents, Offices), from the
  // app's own station reads: the station's guests (station.GetGuests, read as the pilot docks), its agents
  // (agentMgr.GetAgents, flow.loadAgents) and the corporations with an office here (flow.loadStationOffices), each
  // read as its tab is first opened. Names through the app's name cache. An agent opens the app's conversation.
  import type { Session } from "../app/sessions.ts";
  import { resolvedName, type NameKind, type NameRef } from "../store/names.ts";

  let { session, onOpenAgents }: { session: Session; onOpenAgents: () => void } = $props();
  const station = $derived(session.store.station);
  const agents = $derived(session.store.agents);
  const names = $derived(session.store.names);
  const words = $derived(session.store.words);

  type Tab = "guests" | "agents" | "offices";
  let tab = $state<Tab>("guests");
  const asked = new Set<Tab>();
  function choose(next: Tab) {
    tab = next;
    if (asked.has(next)) return;
    asked.add(next);
    if (next === "agents") void session.flow.loadAgents().catch(() => {});
    if (next === "offices") void session.flow.loadStationOffices().catch(() => {});
  }
  choose("guests");

  const name = (kind: NameKind, id: number | null) => resolvedName($names.resolved, kind, id, "…");
  const guests = $derived($station?.guests ?? []);
  const stationID = $derived($station?.online?.stationID ?? null);
  const agentRows = $derived(($agents?.agents ?? []).filter((a) => stationID === null || a.stationID === stationID));
  const officeIDs = $derived($station?.offices?.corporationIDs ?? []);

  // the names on show, asked for as they come
  $effect(() => {
    const refs: NameRef[] = [
      ...guests.flatMap((g) => [{ kind: "character" as const, id: g.characterID }, ...(g.corporationID ? [{ kind: "corporation" as const, id: g.corporationID }] : [])]),
      ...agentRows.map((a) => ({ kind: "agent" as const, id: a.agentID })),
      ...officeIDs.map((id) => ({ kind: "corporation" as const, id })),
    ];
    if (refs.length) session.flow.requestNames(refs);
    // the agents' mission types are the client's own words, by label
    const labels = [...new Set(agentRows.map((a) => a.missionTypeLabel).filter((l): l is string => !!l))];
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
</div>
<div class="lobby-list">
  {#if tab === "guests"}
    {#each guests as g (g.characterID)}
      <div class="lobby-row"><span class="who">{name("character", g.characterID)}</span><span class="dim">{name("corporation", g.corporationID)}</span></div>
    {:else}<div class="dim">No guests.</div>{/each}
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
      {#each officeIDs as id (id)}
        <div class="lobby-row"><span class="who">{name("corporation", id)}</span></div>
      {:else}<div class="dim">{$station?.offices ? "No corporation has an office here." : "Reading the offices…"}</div>{/each}
      {#if $station?.offices?.freeOffices != null}<div class="dim free">{$station.offices.freeOffices} offices free</div>{/if}
    {/if}
  {/if}
</div>

<style>
  .lobby-tabs { display: flex; gap: 2px; margin-top: 12px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
  .lobby-tabs button { min-height: 0; padding: 4px 10px; background: transparent; border: 1px solid transparent; border-bottom: none;
    color: #9a9e99; font: 12px/1.3 var(--font); cursor: pointer; }
  .lobby-tabs button.on { color: #f0f1ee; background: rgba(255, 255, 255, 0.07); border-color: rgba(255, 255, 255, 0.12); box-shadow: inset 0 -2px 0 #d2d5d0; }
  .lobby-list { max-height: 240px; overflow-y: auto; padding: 6px 0; font: 12px/1.35 var(--font); }
  .lobby-row { display: flex; justify-content: space-between; gap: 8px; width: 100%; padding: 3px 4px; border: 0; background: transparent;
    color: #d7dad6; text-align: left; font: inherit; min-height: 0; }
  .lobby-row.agent { cursor: pointer; }
  .lobby-row.agent:hover { background: rgba(255, 255, 255, 0.07); }
  .who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dim { color: #8d918c; white-space: nowrap; }
  .free { margin-top: 6px; }
</style>
