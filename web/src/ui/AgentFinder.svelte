<script lang="ts">
  // Agent Finder page (goal R6a): find a courier agent to travel to. The
  // per-station agentMgr.GetAgents roster is unreliable for this (0 agents for a
  // character re-selected into a docked station, and only the current station),
  // so this lists agents from the static agentAuthority reference table
  // (GET /api/agents/find — read-only static data, not a gateway call), sorted
  // by jumps from the current system (a single client-side BFS, distancesFrom).
  // "Set destination" sets the agent's station as the destination, as the
  // client's map menu does (nav/waypoints.ts); the autopilot, switched on in the
  // Travel tab, flies there and docks, and the live agents populate normally,
  // so the player can accept a courier (R4/R6).
  //
  // A pure reader of the store's finder slice; all fetch/decode/distance logic
  // lives in app/flow.ts. Mission kind + level are server-side filters (a
  // re-find); the text search + nearest-sort + render cap are client-side over
  // the returned rows (like R6's roster), so ~11k agents stay responsive.
  import { getContext, onMount } from "svelte";
  import { BridgeCallError } from "../bridge/callMethod.ts";
  import { isSessionLost } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { AgentFinderRow } from "../store/types.ts";
  import { resolvedName } from "../store/names.ts";
  import { filterFinderRows, parseJumpsLimit } from "./agentFinderFilter.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";

  let {
    store,
    flow,
    showTravel,
  }: { store: ClientStore; flow: AppFlow; showTravel?: () => void } = $props();

  // svelte-ignore state_referenced_locally
  const finder = store.finder;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  /**
   * On the play page the Agency as AgencyWndNew lays it out (agencyWnd.py: 1188 x 694 fixed, caption UI/Agency/Caption;
   * the header's tabs - the Agency's home, then the content groups in contentGroupConst.agencyTabSortOrder: Missions,
   * Encounters, Theaters of War, Exploration, Resource Harvesting, Corporation, Fleet Up, Help; the BookmarksBar at the
   * bottom). The page's agent finder is the Missions tab; the others say they are not built.
   */
  const retail = getContext("retailChrome") === true;
  // svelte-ignore state_referenced_locally
  const words = store.words;
  const AGENCY_TABS: readonly { id: string; label: string; own: string }[] = [
    { id: "home", label: "UI/Agency/Caption", own: "Agency" },
    { id: "missions", label: "UI/Agency/ContentGroups/ContentGroupMissions", own: "Missions" },
    { id: "encounters", label: "UI/Agency/ContentGroups/ContentGroupEncounters", own: "Encounters" },
    { id: "tow", label: "UI/Agency/ContentGroups/TheatersOfWar", own: "Theaters of War" },
    { id: "exploration", label: "UI/Agency/ContentGroups/ContentGroupExploration", own: "Exploration" },
    { id: "harvesting", label: "UI/Agency/ContentGroups/ContentGroupResourceHarvesting", own: "Resource Harvesting" },
    { id: "corp", label: "UI/Agency/ContentGroups/ContentGroupCorp", own: "Corporation" },
    { id: "fleetup", label: "UI/Agency/ContentGroups/ContentGroupFleetUp", own: "Fleet Up" },
    { id: "help", label: "UI/Agency/ContentGroups/ContentGroupHelp", own: "Help" },
  ];
  let agencyTab = $state("missions");
  $effect(() => { if (retail) flow.requestWords(AGENCY_TABS.map((t) => t.label)); });
  const agencyWord = (label: string, own: string): string => { const t = $words.templates[label]; return typeof t === "string" && t !== "" ? t : own; };

  // R7c — the finder rows already carry server-resolved station/system names; the
  // one bare ID left is the origin system in the summary note. Resolve it.
  $effect(() => {
    const origin = $finder.originSystemID;
    if (origin) {
      flow.requestNames([{ kind: "system", id: origin }]);
    }
  });

  function originText(): string {
    return resolvedName($names.resolved, "system", $finder.originSystemID, "your current system");
  }

  const RENDER_CAP = 60;
  let kind = $state("courier");
  let levelFilter = $state("all");
  let searchText = $state("");
  // "Within N jumps" is a client-side limit (R52), kept as the raw input string
  // so a blank field reads as "no limit" (opt-in) rather than 0. It does NOT
  // re-find — unlike kind/level, it filters rows we already hold.
  let jumpsLimitInput = $state("");
  let busy = $state(false);
  let error = $state("");

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) {
      return;
    }
    busy = true;
    error = "";
    try {
      await action();
    } catch (cause) {
      if (isSessionLost(cause)) {
        error = "The live session ended (idle timeout or another client took over).";
      } else {
        error = panelErrorWords(cause);
      }
    } finally {
      busy = false;
    }
  }

  // Kind + level are server-side filters: changing them re-runs the find.
  function find(): Promise<void> {
    const level = levelFilter === "all" ? null : Number(levelFilter);
    return run(() => flow.findAgents({ kind, level }));
  }

  onMount(() => {
    void find();
  });

  // The jumps limit + text search are client-side over the already-nearest-
  // sorted returned rows (jumps filter, then text filter — see filterFinderRows);
  // the render cap below counts what actually matched.
  const jumpsLimit = $derived(parseJumpsLimit(jumpsLimitInput));
  const filteredAgents = $derived<AgentFinderRow[]>(
    filterFinderRows($finder.agents, { jumpsLimit, searchText }),
  );
  const cappedAgents = $derived(filteredAgents.slice(0, RENDER_CAP));

  function jumpsText(jumps: number | null): string {
    if (jumps === null) {
      return "unreachable";
    }
    if (jumps === 0) {
      return "0 (here)";
    }
    return `${jumps}`;
  }

  async function setDestination(agent: AgentFinderRow): Promise<void> {
    await run(async () => {
      await flow.setDestinationToAgent(agent.agentID);
      // Point the player at the Travel tab (the autopilot readout lives there).
      showTravel?.();
    });
  }
</script>

{#if retail}
  <nav class="ag-tabs">
    {#each AGENCY_TABS as t (t.id)}
      <button type="button" class:active={agencyTab === t.id} onclick={() => (agencyTab = t.id)}>{agencyWord(t.label, t.own)}</button>
    {/each}
  </nav>
  {#if agencyTab !== "missions"}<p class="note">This panel is not on the play page yet.</p>{/if}
{/if}
<div class:ag-hidden={retail && agencyTab !== "missions"}>
{#if !retail}
<section class="panel">
  <header class="panel-head">
    <h2 class="panel-title">Agent Finder</h2>
  </header>
</section>
{/if}

<section>
  <h2>Filters</h2>
  <div class="agent-filter">
    <label>
      Mission kind
      <select bind:value={kind} disabled={busy} onchange={() => void find()}>
        <option value="courier">Courier</option>
        <option value="encounter">Encounter</option>
        <option value="mining">Mining</option>
        <option value="research">Research</option>
        <option value="all">All</option>
      </select>
    </label>
    <label>
      Level
      <select bind:value={levelFilter} disabled={busy} onchange={() => void find()}>
        <option value="all">All</option>
        <option value="1">1</option>
        <option value="2">2</option>
        <option value="3">3</option>
        <option value="4">4</option>
        <option value="5">5</option>
      </select>
    </label>
    <label>
      Within jumps
      <input
        type="number"
        inputmode="numeric"
        min="0"
        step="1"
        placeholder="any"
        value={jumpsLimitInput}
        oninput={(event) => (jumpsLimitInput = event.currentTarget.value)}
      />
    </label>
    <label>
      Search (name / system)
      <input type="search" placeholder="name or system" bind:value={searchText} />
    </label>
    <button type="button" disabled={busy} onclick={() => void find()}>Refresh</button>
  </div>
  {#if error}
    <p class="error">{error}</p>
  {/if}
  {#if $finder.error}
    <p class="error">{$finder.error}</p>
  {/if}
</section>

{#if $finder.target}
  <section>
    <h2>Destination</h2>
    <p>
      Heading for <strong>{$finder.target.name}</strong>
      (L{$finder.target.level ?? "?"}) at
      {$finder.target.stationName ?? resolvedName($names.resolved, "station", $finder.target.stationID, "the station")}
      in {$finder.target.solarSystemName ?? resolvedName($names.resolved, "system", $finder.target.solarSystemID, "its system")}
      — {jumpsText($finder.target.jumps)} jumps.
    </p>
    <p class="note">
      Switch the autopilot on in the Travel tab to fly there. When you arrive and
      dock, open Agents &amp; Missions to talk to the agent and accept a courier.
    </p>
    {#if showTravel}
      <p><button type="button" onclick={() => showTravel?.()}>Go to Travel tab</button></p>
    {/if}
  </section>
{/if}

<section>
  <h2>Agents</h2>
  {#if !$finder.loaded}
    <p class="note">Loading agents…</p>
  {:else if $finder.agents.length === 0}
    <p class="empty">No agents match this filter.</p>
  {:else}
    <p class="note">
      Showing {cappedAgents.length} of {filteredAgents.length} matching{#if jumpsLimit !== null}
        within {jumpsLimit} {jumpsLimit === 1 ? "jump" : "jumps"}{/if}
      ({$finder.total}{$finder.capped ? "+" : ""} for this filter), nearest first
      from {originText()}.
      {#if $finder.capped}
        Pick a level to narrow the list.
      {:else if filteredAgents.length > cappedAgents.length}
        Refine the search to narrow the list.
      {/if}
    </p>
    {#if cappedAgents.length === 0}
      <p class="empty">
        No agents match your filters{#if jumpsLimit !== null} within {jumpsLimit} {jumpsLimit === 1 ? "jump" : "jumps"} (unreachable agents are hidden){/if}.
      </p>
    {:else}
      <div class="table-wrap overflow-x-auto">
        <table class="guests agent-finder reflow">
          <thead>
            <tr>
              <th>Agent</th>
              <th class="num">Lvl</th>
              <th>Kind</th>
              <th>Station</th>
              <th>System</th>
              <th class="num">Jumps</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each cappedAgents as agent (agent.agentID)}
              <tr class:self={agent.jumps === 0}>
                <td data-label="Agent">{agent.name}</td>
                <td class="num" data-label="Lvl">{agent.level ?? "?"}</td>
                <td data-label="Kind">{agent.missionKind ?? "—"}</td>
                <td data-label="Station">{agent.stationName ?? resolvedName($names.resolved, "station", agent.stationID, "—")}</td>
                <td data-label="System">{agent.solarSystemName ?? resolvedName($names.resolved, "system", agent.solarSystemID, "—")}</td>
                <td class="num" data-label="Jumps">{jumpsText(agent.jumps)}</td>
                <td data-label="">
                  <button
                    type="button"
                    disabled={busy || agent.stationID === null}
                    onclick={() => setDestination(agent)}
                  >
                    Set destination
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
</section>
</div>
