<script lang="ts">
  import { onMount } from "svelte";
  import { fetchTypeDogma, type TypeMetaFacts } from "../app/api.ts";
  import { isSessionLost, type AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText, type TemplateArguments } from "../bridge/clientWords.ts";
  import { FLEET_JOB_CREATOR, isFleetCommander } from "../bridge/fleetCommand.ts";
  import { canSeeCompositionMember, compositionID, summarizeFleetComposition } from "../bridge/fleetComposition.ts";
  import { BASE_UPWELL_JUMP_COST } from "../bridge/shipInfoAttributes.ts";
  import { rankLabel } from "../bridge/fleetMemberMenu.ts";
  import type { FleetMember } from "../bridge/boundFleet.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName, type NameKind } from "../store/names.ts";
  import OwnerFleetMenu from "./OwnerFleetMenu.svelte";
  import PlaceRouteMenu from "./PlaceRouteMenu.svelte";
  import { showInfo } from "./showInfo.ts";

  let { store, flow, openWatchlist }: { store: ClientStore; flow: AppFlow; openWatchlist?: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const { fleet, station, words, names } = store;
  const LABEL = "UI/Fleet/FleetComposition/";
  const POSITION = "UI/Fleet/FleetWindow/FleetPosition";
  const SYSTEM_HEADING = { label: "UI/Common/SolarSystem", own: "Solar System" };
  function word(label: string, fallback: string, args: TemplateArguments = {}): string {
    return plainText(formatTemplate($words.templates[label] || fallback, args, { nameOf: (kind, id) => name(kind, id, String(id)) }));
  }
  function name(kind: NameKind, id: number | null, fallback = ""): string {
    return resolvedName($names.resolved, kind, id, fallback);
  }
  function rankPath(role: number, boss: boolean): string {
    return role >= 1 && role <= 4 ? rankLabel(role) + (boss ? "Boss" : "") : "UI/Fleet/Ranks/NonMember";
  }
  function rankLabelFor(member: FleetMember): string {
    const boss = (member.job & FLEET_JOB_CREATOR) !== 0;
    const role = ["Non-Member", "Fleet Commander", "Wing Commander", "Squad Commander", "Squad Member"][member.role] ?? "Non-Member";
    return word(rankPath(member.role, boss), boss ? role + " (Boss)" : role);
  }

  const bound = $derived($fleet.fleet);
  const me = $derived(bound?.initState.value.members.find(member => Number(member.charID) === $station.online?.characterID));
  const canRead = $derived(me !== undefined && isFleetCommander(me));
  const composition = $derived(canRead && bound?.composition.error === null ? bound.composition.value : []);
  const members = $derived(new Map(bound?.initState.value.members.map(member => [compositionID(member.charID), member])));
  const typeKey = $derived([...new Set(composition.map(entry => compositionID(entry.shipTypeID)).filter(id => id !== null))].sort((a, b) => a - b).join(","));

  let tab = $state<"composition" | "summary">("composition");
  let query = $state("");
  let selected = $state<ReadonlySet<number>>(new Set());
  let menuFor = $state<number | null>(null);
  let refreshing = $state(false);
  let refreshError = $state(false);
  let meta = $state<ReadonlyMap<number, TypeMetaFacts | null> | null>(null);
  let jumpCosts = $state<Awaited<ReturnType<typeof fetchTypeDogma>> | null>(null);
  let staticError = $state(false);
  let metadataRetry = $state(0);

  $effect(() => {
    const refs: { kind: NameKind; id: number | null }[] = composition.flatMap(entry => [
      { kind: "character", id: compositionID(entry.characterID) },
      { kind: "system", id: compositionID(entry.solarSystemID) },
      { kind: "type", id: compositionID(entry.shipTypeID) },
      ...entry.skillIDs.map(id => ({ kind: "type" as const, id: compositionID(id) })),
    ]);
    flow.requestNames(refs.flatMap(({ kind, id }) => id === null ? [] : [{ kind, id }]));
  });
  $effect(() => {
    $fleet.authoritativeFleetID;
    metadataRetry;
    const ids = typeKey ? typeKey.split(",").map(Number) : [];
    let current = true;
    meta = ids.length ? null : new Map();
    jumpCosts = ids.length ? null : {};
    staticError = false;
    if (ids.length) {
      const results = Promise.allSettled([flow.typeFacts(ids), fetchTypeDogma(ids, [BASE_UPWELL_JUMP_COST], flow.requestOptions())]);
      void results.then(([facts, costs]) => {
        if (!current) return;
        meta = facts.status === "fulfilled" ? facts.value : null;
        jumpCosts = costs.status === "fulfilled" ? costs.value : null;
        staticError = !meta || !jumpCosts;
        if (meta) flow.requestNames([...meta.values()].flatMap(fact => fact?.groupID ? [{ kind: "group", id: fact.groupID }] : []));
      });
    }
    return () => { current = false; };
  });
  function groupOf(typeID: number): number | null {
    return meta?.get(typeID)?.groupID ?? null;
  }

  const filtered = $derived.by(() => {
    if (!me) return [];
    const needle = query.trim().toLowerCase();
    return composition.flatMap(entry => {
      const id = compositionID(entry.characterID);
      const member = members.get(id);
      if (id === null || !member || !canSeeCompositionMember(me, member)) return [];
      const pilot = id === $station.online?.characterID ? $station.online.characterName : name("character", id, String(id));
      const systemID = compositionID(entry.solarSystemID);
      const location = [name("system", systemID, systemID === null ? "" : String(systemID)), entry.stationID ? word(LABEL + "Docked", "(Docked)") : ""].filter(Boolean).join(" ");
      const typeID = compositionID(entry.shipTypeID);
      const hull = name("type", typeID, typeID === null ? "" : String(typeID));
      const group = typeID === null ? "" : name("group", groupOf(typeID));
      const role = rankLabelFor(member);
      const skillIDs = entry.skillIDs.map(compositionID);
      const levels = entry.skills.length >= 3 && skillIDs.length >= 3 && skillIDs.slice(0, 3).every(skillID => skillID !== null)
        ? word(LABEL + "SkillLevels", "{skillLevelA} / {skillLevelB} / {skillLevelC}", {
            skillLevelA: entry.skills[2], skillLevelB: entry.skills[1], skillLevelC: entry.skills[0],
          }) : "";
      const skillHint = levels ? [2, 1, 0].map(index => name("type", skillIDs[index], String(skillIDs[index])) + " " + entry.skills[index]).join(" · ") : "";
      const wing = bound?.initState.value.wings.find(item => String(item.wingID) === String(member.wingID));
      const squad = wing?.squads.find(item => String(item.squadID) === String(member.squadID));
      const position = [wing?.name, squad?.name].filter(Boolean).join(" / ");
      return [pilot, location, hull, group, role, levels, position].join("\t").toLowerCase().includes(needle)
        ? [{ id, pilot, systemID, location, typeID, hull, group, role, levels, skillHint, position }] : [];
    });
  });
  const selectedCount = $derived(filtered.filter(row => selected.has(row.id)).length);
  const summary = $derived(summarizeFleetComposition(composition, groupOf, typeID => jumpCosts?.[typeID]?.[BASE_UPWELL_JUMP_COST]));
  const byType = $derived([...summary.byType].sort((a, b) => b.count - a.count || name("type", a.typeID).localeCompare(name("type", b.typeID))));
  const byGroup = $derived([...summary.byGroup].sort((a, b) => b.count - a.count || name("group", a.groupID).localeCompare(name("group", b.groupID))));
  const costText = (value: number) => value.toLocaleString("en-US") + " GJ";
  const unknownShip = $derived(word(LABEL + "UnknownShipTypeID", "Unknown"));
  const unknownCost = $derived(word(LABEL + "UnknownJumpCost", "Unknown"));
  function toggleSelected(id: number): void {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selected = next;
  }

  async function refresh(): Promise<void> {
    refreshing = true;
    refreshError = false;
    selected = new Set();
    if (staticError) metadataRetry++;
    try {
      await flow.loadFleet();
    } catch (cause) {
      if (!isSessionLost(cause)) refreshError = true;
    } finally {
      refreshing = false;
    }
  }
  onMount(() => {
    flow.requestWords([
      ...["FleetComposition", "FleetSummary", "FleetCompositionHelp", "ShipType", "ShipGroup", "FleetRole", "FleetSkills",
        "NumShips", "UnknownShipTypeID", "UnknownJumpCost", "BaseUpwellJumpCost", "UpwellJumpCostTotal", "PilotsSelected", "Docked", "SkillLevels"].map(key => LABEL + key),
      ...[1, 2, 3, 4, 0].flatMap(role => [rankPath(role, false), rankPath(role, true)]),
      POSITION, "UI/Common/Name", "UI/Common/Location", "UI/Common/NothingFound", "UI/Commands/Refresh", "UI/Inventory/Filter",
    ]);
    const release = flow.retainFleetDetails();
    void refresh();
    return release;
  });
</script>

<div class="composition">
  <header>
    <p>{word(LABEL + "FleetCompositionHelp", "Review your fleet's ships, locations and fleet roles.")}</p>
    <button type="button" disabled={refreshing || !canRead} onclick={() => void refresh()}>{word("UI/Commands/Refresh", "Refresh")}</button>
  </header>
  <nav aria-label="Fleet composition views">
    <button type="button" aria-pressed={tab === "composition"} onclick={() => tab = "composition"}>{word(LABEL + "FleetComposition", "Fleet Composition")}</button>
    <button type="button" aria-pressed={tab === "summary"} onclick={() => tab = "summary"}>{word(LABEL + "FleetSummary", "Fleet Summary")}</button>
  </nav>
  {#if !bound && refreshing}
    <p role="status">Loading fleet composition…</p>
  {:else if !canRead}
    <p role="status">Fleet Composition is available to fleet commanders and the fleet boss.</p>
  {:else if bound?.composition.error || refreshError}
    <p role="status">Fleet composition could not be read. Try Refresh.</p>
  {:else if tab === "composition"}
    <div class="filter"><input type="search" aria-label="Filter fleet composition" placeholder={word("UI/Inventory/Filter", "Filter")} maxlength="64"
      bind:value={query} oninput={() => { selected = new Set(); menuFor = null; }} /></div>
    <div class="scroll">
      <table aria-label="Fleet composition roster">
        <thead><tr>
          <th>{word("UI/Common/Name", "Name")}</th><th>{word("UI/Common/Location", "Location")}</th>
          <th>{word(LABEL + "ShipType", "Ship Type")}</th><th>{word(LABEL + "ShipGroup", "Ship Group")}</th>
          <th>{word(LABEL + "FleetRole", "Fleet Role")}</th><th>{word(LABEL + "FleetSkills", "Fleet Skills")}</th>
          <th>{word(POSITION, "Fleet Position")}</th>
        </tr></thead>
        <tbody>
          {#each filtered as row (row.id)}
            <tr class:selected={selected.has(row.id)} oncontextmenu={event => { event.preventDefault(); menuFor = menuFor === row.id ? null : row.id; }}>
              <td><label><input type="checkbox" checked={selected.has(row.id)} onchange={() => toggleSelected(row.id)} /> {row.pilot}</label>
                <button type="button" class="minor" aria-label={"Actions for " + row.pilot} aria-expanded={menuFor === row.id} onclick={() => menuFor = menuFor === row.id ? null : row.id}>▾</button>
              </td>
              <td>{row.location}</td>
              <td>{#if row.typeID !== null}{@const typeID = row.typeID}<button type="button" class="evelink" onclick={() => showInfo({ kind: "type", typeID })}>{row.hull}</button>{/if}</td>
              <td>{row.group}</td><td>{row.role}</td><td title={row.skillHint}>{row.levels}</td><td>{row.position}</td>
            </tr>
            {#if menuFor === row.id}
              <tr><td colspan="7" class="row-actions">
                <OwnerFleetMenu {store} {flow} {openWatchlist} ownerID={row.id} onDone={() => menuFor = null} />
                {#if row.systemID !== null}<PlaceRouteMenu {store} {flow} placeID={row.systemID} heading={SYSTEM_HEADING} />{/if}
              </td></tr>
            {/if}
          {:else}
            <tr><td colspan="7">{word("UI/Common/NothingFound", "Nothing found")}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
    <footer>{word(LABEL + "PilotsSelected", "{numSelected} of {numTotalPilots} pilots selected", { numSelected: selectedCount, numTotalPilots: filtered.length })}</footer>
  {:else}
    {#if staticError}<p role="status">Some ship data could not be loaded. Try Refresh.</p>{/if}
    <div class="summary">
      <div class="scroll">
        <table aria-label="Fleet summary by ship type">
          <thead><tr>
            <th>{word(LABEL + "ShipType", "Ship Type")}</th><th>{word(LABEL + "ShipGroup", "Ship Group")}</th>
            <th class="number">{word(LABEL + "NumShips", "Ships")}</th><th class="number">{word(LABEL + "BaseUpwellJumpCost", "Base Upwell Jump Cost")}</th>
          </tr></thead>
          <tbody>
            {#each byType as row (row.typeID)}
              <tr>
                <td><button type="button" class="evelink" onclick={() => showInfo({ kind: "type", typeID: row.typeID })}>{name("type", row.typeID, String(row.typeID))}</button></td>
                <td>{name("group", row.groupID)}</td><td class="number">{row.count}</td>
                <td class="number">{jumpCosts === null ? "—" : row.jumpCost === null ? unknownCost : costText(row.jumpCost)}</td>
              </tr>
            {/each}
            {#if summary.unknownShips}
              <tr><td>{unknownShip}</td><td></td><td class="number">{summary.unknownShips}</td><td></td></tr>
            {/if}
          </tbody>
          {#if jumpCosts !== null}
            <tfoot><tr><td colspan="4" class="number">{word(LABEL + "UpwellJumpCostTotal", "Total: {totalCost}", { totalCost: costText(summary.totalCost) })}</td></tr></tfoot>
          {/if}
        </table>
      </div>
      <div class="scroll">
        <table aria-label="Fleet summary by ship group">
          <thead><tr><th>{word(LABEL + "ShipGroup", "Ship Group")}</th><th class="number">{word(LABEL + "NumShips", "Ships")}</th></tr></thead>
          <tbody>
            {#each byGroup as row (row.groupID)}
              <tr><td>{name("group", row.groupID, row.groupID === null && meta ? unknownShip : "")}</td><td class="number">{row.count}</td></tr>
            {/each}
            {#if summary.unknownShips}<tr><td>{unknownShip}</td><td class="number">{summary.unknownShips}</td></tr>{/if}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</div>

<style>
  .composition { display: flex; flex-direction: column; min-height: 100%; gap: 6px; font-size: 12px; }
  header { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
  p { margin: 0; color: var(--muted); }
  nav { display: flex; border-bottom: 1px solid var(--line); }
  nav button { background: transparent; border: 0; border-bottom: 2px solid transparent; border-radius: 0; }
  nav button[aria-pressed="true"] { border-color: var(--accent); }
  .filter, footer { text-align: right; }
  .filter input { width: 120px; max-width: 100%; }
  .scroll { overflow: auto; min-height: 0; }
  .summary { display: grid; grid-template-rows: minmax(72px, 1fr) minmax(58px, .55fr); gap: 10px; flex: 1; min-height: 150px; }
  table { width: 100%; border-collapse: collapse; text-align: left; }
  th, td { padding: 4px 6px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { color: var(--muted); font-weight: 600; }
  label { display: inline-flex; align-items: center; gap: 3px; }
  tr.selected { background: rgba(130, 174, 210, .16); }
  .number { text-align: right; font-variant-numeric: tabular-nums; }
  .row-actions { white-space: normal; }
  button.evelink, button.minor { padding: 0 3px; background: transparent; border: 0; }
</style>
