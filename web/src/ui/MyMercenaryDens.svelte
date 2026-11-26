<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import type { BookmarkPlace } from "../bridge/locationsList.ts";
  import type { MercenaryDenRow, MercenaryDensRead } from "../bridge/mercenaryDens.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { avoidanceItems, isAvoidablePlace } from "../nav/autopilotSettings.ts";
  import { celestialRouteEntries, isWaypointPlace } from "../nav/waypoints.ts";
  import { ContextMenu, type ContextEntry } from "../play/contextMenu.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { openAgencyGroup } from "./agencyRequests.ts";
  import BookmarkWindow from "./BookmarkWindow.svelte";
  import { notify } from "./notices.ts";
  import { showInfo } from "./showInfo.ts";
  import MercenaryDenManagement from "./MercenaryDenManagement.svelte";

  let { store, flow, onShowSystem }: { store: ClientStore; flow: AppFlow; onShowSystem?: (id: number) => void } = $props();
  const words = $derived(store.words);
  const names = $derived(store.names);
  const station = $derived(store.station);
  const flight = $derived(store.flight);
  const fleet = $derived(store.fleet);
  const waypoints = $derived(flow.waypoints);
  const here = $derived($flight.status?.solarSystemID ?? $station.online?.solarSystemID ?? null);
  const characterID = $derived($station.online?.characterID ?? null);
  const path = "UI/Sovereignty/MercenaryDen/MyMercenaryDensWindow/";
  const config = "UI/Sovereignty/MercenaryDen/ConfigurationWindow/";
  const labels = {
    deployed: [path + "DeployedDens", "Deployed Dens"],
    count: [path + "NumMyDensAndMax", "{numMyDens} / {numMax}"],
    empty: [path + "NoDensMessage", "You have no deployed Mercenary Dens."],
    agency: [path + "OpenAgencyButton", "Open Agency"],
    planet: [path + "HeaderPlanet", "Planet"],
    state: [path + "HeaderState", "State"],
    infomorphs: [path + "HeaderInfomorphs", "Infomorph Decryption Keys"],
    mto: [path + "HeaderMTOS", "MTO"],
    name: ["UI/Common/Name", "Name"],
    system: ["UI/Common/SolarSystem", "Solar System"],
    active: [config + "StateNameActive", "Active"],
    inactive: [config + "StateNameInactive", "Inactive"],
    activeHint: [config + "StateTooltipActive", "Mercenary Den is functional."],
    inactiveHint: [config + "StateTooltipInactive", "Mercenary Den is non-functional."],
    summaryName: [config + "MercenaryDenName", "{[item]typeID.name} {solarSystem}"],
    owner: [config + "Owner", "Owner:"],
    skyhookOwner: [config + "SkyhookOwner", "Skyhook Owner:"],
    missing: [config + "FailedToLoadData", "Failed to load data."],
    generation: [config + "InfomorphGenerationRateName", "Infomorph Decryption Key Rate"],
    generationHint: [config + "InfomorphGenerationRateTooltip", "The rate at which Infomorph Decryption Keys are generated per hour. The number generated ranges between the minimum and maximum quantities listed."],
    generationRange: [config + "InfomorphGenerationRateData", "{lower}-{upper}/h"],
    workforce: [config + "WorkforceCostName", "Workforce Impact"],
    workforceHint: [config + "WorkforceCostTooltip", "This Mercenary Den is disrupting {workforce_units} ({workforce_cost_percentage}) workforce provided by the adjacent Skyhook."],
    percentage: ["UI/Common/Formatting/Percentage", "{percentage}%"],
    retry: ["UI/Personalization/PaintTool/ErrorRetry", "Retry"],
    max: [path + "MyMaxDeployable", "My Maximum"],
    fullSkills: [path + "MaxDeployedWithFullSkills", "Maximum with full skills: {numDens}"],
    slot: [path + "EmptySlot", "Empty Slot"],
    slotDescription: [path + "EmptySlotDesc", "Available for deployment"],
    reload: [path + "ReloadData", "Reload"],
    location: ["UI/Common/Location", "Location"],
    info: ["UI/Commands/ShowInfo", "Show Info"],
    destination: ["UI/Inflight/SetDestination", "Set Destination"],
    addWaypoint: ["UI/Inflight/AddWaypoint", "Add Waypoint"],
    removeWaypoint: ["UI/Inflight/RemoveWaypoint", "Remove Waypoint"],
    travelTo: ["UI/Fleet/FleetBroadcast/Commands/BroadcastTravelTo", "Broadcast: Travel To"],
    saveLocation: ["UI/Inflight/BookmarkLocation", "Save Location…"],
    bookmarkLabel: ["UI/PeopleAndPlaces/NewBookmarkLocationLabel", "{loc} ({group})"],
    map: ["UI/Commands/ShowLocationOnMap", "Show on Map"],
    mapBrowser: ["UI/Inflight/ShowInMapBrowser", "Show in Mapbrowser ({locationType})"],
    avoid: ["UI/Inflight/AvoidLocation", "Avoid {theLocation} ({locationType})"],
    stopAvoiding: ["UI/Inflight/StopAvoidingLocation", "Do Not Avoid {theLocation} ({locationType})"],
  } as const;
  const columns = ["name", "system", "planet", "state", "infomorphs", "mto"] as const;
  const word = (key: keyof typeof labels, args: Record<string, string | number> = {}) =>
    plainText(formatTemplate($words.templates[labels[key][0]] ?? labels[key][1], args,
      { nameOf: (kind, id) => kind === "type" ? nameOf(kind, id, "Mercenary Den") : "" }));
  const nameOf = (kind: "type" | "system" | "planet" | "character" | "corporation", id: number, fallback: string) =>
    resolvedName($names.resolved, kind, id, fallback);
  const systemName = (row: MercenaryDenRow) => nameOf("system", row.solarSystemID, String(row.solarSystemID));
  const denName = (row: MercenaryDenRow) => `${systemName(row)} ${nameOf("type", row.typeID, "Mercenary Den")}`;
  const summaryName = $derived(selected ? word("summaryName", { typeID: selected.typeID, solarSystem: systemName(selected) }) : "");
  const integer = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  let directory = $state.raw<MercenaryDensRead | null>(null);
  let bookmark = $state.raw<BookmarkPlace | null>(null);
  const menu = new ContextMenu();
  const reloading = new SvelteSet<number>();
  let loadSerial = 0;
  let selection = $state(0);
  const selectionKey = $derived(`evejs.play.${characterID}.mercDenSelected`);
  const selectedID = $derived(directory?.owned.includes(selection) ? selection : directory?.owned[0]);
  const selected = $derived(directory?.rows.find(row => row.id === selectedID));
  let error = $state("");
  let revision = $state(0);
  const count = $derived(directory ? word("count", { numMyDens: directory.owned.length, numMax: directory.maximum }) : "");
  const capacityTip = $derived(directory && directory.maximum < directory.absoluteMaximum
    ? word("fullSkills", { numDens: directory.absoluteMaximum })
    : "");
  const workforcePercent = $derived(selected?.workforcePercent != null
    ? word("percentage", { percentage: selected.workforcePercent })
    : "—");
  function select(id: number) {
    selection = id;
    if (characterID) try { localStorage.setItem(selectionKey, String(id)); } catch { /* kept in this window */ }
  }
  function entry(key: keyof typeof labels, run: () => void): ContextEntry {
    return { path: labels[key][0], label: word(key), run };
  }
  function locationEntries(row: MercenaryDenRow): (ContextEntry | null)[] {
    const id = row.solarSystemID;
    const route = celestialRouteEntries(id, isWaypointPlace(id), here, $waypoints);
    const entries: (ContextEntry | null)[] = [
      { ...entry("info", () => showInfo({ kind: "mapLocation", typeID: 5, itemID: id })), info: true },
    ];
    if (route.setDestination) entries.push(entry("destination", () => flow.setDestination(id)));
    if (route.addWaypoint) entries.push(entry("addWaypoint", () => flow.addWaypoint(id)));
    if (route.removeWaypoint) entries.push(entry("removeWaypoint", () => flow.clearWaypoints(id)));
    if ($fleet.availability === "ready" && isWaypointPlace(id)) {
      entries.push(null, entry("travelTo", () => {
        void flow.broadcastTravelToSystem(id).catch(cause => {
          if (cause?.code !== "SESSION_REQUEST_RETIRED") notify({ kind: "danger", title: word("travelTo"), detail: String(cause) });
        });
      }));
    }
    entries.push(null, entry("saveLocation", () => {
      bookmark = {
        itemID: id, askIfKnown: true, typeName: () => word("system"),
        name: () => plainText(formatTemplate($words.templates[labels.bookmarkLabel[0]] ?? labels.bookmarkLabel[1],
          { loc: id, group: word("system") }, { nameOf: () => systemName(row) })),
      };
    }));
    if (isAvoidablePlace(id)) {
      const locationType = word("system");
      const show = onShowSystem;
      entries.push(null);
      if (show) {
        entries.push(entry("map", () => show(id)), {
          ...entry("mapBrowser", () => show(id)), label: word("mapBrowser", { locationType }),
        });
      }
      const avoiding = avoidanceItems(flow.autopilotSettings()).includes(id);
      const key = avoiding ? "stopAvoiding" : "avoid";
      entries.push({
        ...entry(key, () => avoiding ? flow.stopAvoidingLocation(id) : flow.avoidLocation(id)),
        label: plainText(formatTemplate($words.templates[labels[key][0]] ?? labels[key][1],
          { locationType, theLocation: id }, { nameOf: () => systemName(row) })),
      });
    }
    return entries;
  }
  async function reloadRow(id: number) {
    if (reloading.has(id)) return;
    const serial = loadSerial;
    reloading.add(id);
    try {
      const row = await flow.reloadMercenaryDen(id);
      if (serial === loadSerial && row && directory?.owned.includes(id)) {
        directory = { ...directory, rows: [...directory.rows.filter(item => item.id !== id), row] };
      }
    } catch (cause) {
      if (serial === loadSerial) notify({ kind: "danger", title: word("reload"), detail: panelErrorWords(cause) });
    } finally {
      if (serial === loadSerial) reloading.delete(id);
    }
  }
  function openRowMenu(id: number, row: MercenaryDenRow | undefined, x: number, y: number) {
    menu.open(x, y, row ? [
      { ...entry("info", () => showInfo({ kind: "type", itemID: row.id, typeID: row.typeID })), info: true },
      entry("saveLocation", () => {
        bookmark = {
          itemID: row.id, askIfKnown: true, requiresSpace: true, name: () => denName(row),
          typeName: () => nameOf("type", row.typeID, "Mercenary Den"),
        };
      }),
      { path: labels.location[0], label: word("location"), sub: locationEntries(row) },
    ] : [entry("reload", () => { void reloadRow(id); })]);
  }
  function menuFromKey(event: KeyboardEvent & { currentTarget: HTMLButtonElement }, id: number, row: MercenaryDenRow | undefined) {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    openRowMenu(id, row, bounds.left, bounds.bottom);
  }
  $effect(() => {
    let saved = 0;
    if (characterID) try { saved = Number(localStorage.getItem(selectionKey)); } catch { /* optional storage */ }
    selection = saved;
  });
  $effect(() => {
    void revision;
    void characterID;
    let current = true;
    reloading.clear();
    directory = null;
    error = "";
    flow.requestWords(Object.values(labels).map(([key]) => key));
    void flow.loadMyMercenaryDens().then(result => {
      if (current) directory = result;
    }).catch(cause => { if (current) error = panelErrorWords(cause); });
    return () => { current = false; loadSerial++; menu.close(); };
  });
</script>

{#if bookmark}
  {#key bookmark.itemID}<BookmarkWindow {store} {flow} place={bookmark} onDone={() => bookmark = null} />{/key}
{/if}

<section class="mercenary-dens" aria-label="My Mercenary Dens">
  {#if error}
    <p role="alert">{error}</p>
    <button type="button" onclick={() => revision++}>{word("retry")}</button>
  {:else if directory === null}
    <p role="status">Loading mercenary dens…</p>
  {:else}
    <header><strong>{word("deployed")}</strong><span title={`${word("max")} ${directory.maximum}${capacityTip ? "\n" + capacityTip : ""}`}>{count}</span></header>
    {#if directory.owned.length === 0}
      <div class="empty">
        <p>{word("empty")}</p>
        <button type="button" onclick={() => openAgencyGroup(85)}>{word("agency")}</button>
      </div>
    {:else}
      <div class="den-layout">
        <div class="den-roster"><table>
        <thead><tr>{#each columns as key}<th scope="col">{word(key)}</th>{/each}</tr></thead>
        <tbody>
          {#each directory.owned as id (id)}
            {@const row = directory.rows.find(entry => entry.id === id)}
            <tr data-den={id} class:current={selectedID === id} aria-busy={reloading.has(id)} oncontextmenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openRowMenu(id, row, event.clientX, event.clientY);
            }}>
              {#if row}
                <td><button class="den-name" type="button" aria-pressed={selectedID === id} onclick={() => select(id)} onkeydown={(event) => menuFromKey(event, id, row)}>{denName(row)}</button></td>
                <td>{systemName(row)}</td>
                <td>{nameOf("planet", row.planetID, "—")}</td>
                <td>{word(row.enabled ? "active" : "inactive")}</td>
                <td>{integer.format(row.infomorphs)}</td>
                <td>{row.activities === null ? "—" : integer.format(row.activities)}</td>
              {:else}
                <td colspan="6"><button class="den-name" type="button" aria-pressed={selectedID === id} onclick={() => select(id)} onkeydown={(event) => menuFromKey(event, id, row)}>Mercenary Den {id} · {word("missing")}</button></td>
              {/if}
            </tr>
          {/each}
          {#each Array.from({ length: Math.max(0, directory.maximum - directory.owned.length) }) as _}
            <tr class="empty-slot"><td>{word("slot")}</td><td colspan="5">{word("slotDescription")}</td></tr>
          {/each}
        </tbody>
        </table></div>
        {#if selected}
          <aside class="den-summary" aria-label={summaryName}>
            <div class="den-summary-heading">
              <h3>{summaryName}</h3>
              <span class:enabled={selected.enabled} title={word(selected.enabled ? "activeHint" : "inactiveHint")}>
                {word(selected.enabled ? "active" : "inactive")}
              </span>
            </div>
            <dl>
              <dt>{word("owner")}</dt>
              <dd>
                {#if selected.ownerCharacterID}
                  <button class="owner-link" type="button" onclick={() => selected && showInfo({ kind: "character", characterID: selected.ownerCharacterID })}>
                    {nameOf("character", selected.ownerCharacterID, String(selected.ownerCharacterID))}
                  </button>
                {:else}{word("missing")}{/if}
              </dd>
              <dt>{word("skyhookOwner")}</dt>
              <dd>
                {#if selected.skyhookOwnerCorporationID}
                  <button class="owner-link" type="button" onclick={() => selected && showInfo({ kind: "corporation", corporationID: selected.skyhookOwnerCorporationID })}>
                    {nameOf("corporation", selected.skyhookOwnerCorporationID, String(selected.skyhookOwnerCorporationID))}
                  </button>
                {:else}{word("missing")}{/if}
              </dd>
              <dt title={word("generationHint")}>{word("generation")}</dt>
              <dd>{word("generationRange", { lower: selected.infomorphsPerHour[0], upper: selected.infomorphsPerHour[1] })}</dd>
              <dt>{word("workforce")}</dt>
              <dd title={word("workforceHint", { workforce_units: selected.workforceCost, workforce_cost_percentage: workforcePercent })}>{workforcePercent}</dd>
            </dl>
            <MercenaryDenManagement {store} {flow} den={selected} {characterID} />
          </aside>
        {/if}
      </div>
    {/if}
  {/if}
</section>

<style>
  section { display: grid; align-content: start; gap: 10px; min-width: 0; overflow: auto; }
  header { display: flex; justify-content: space-between; padding: 8px; background: #ffffff0d; }
  .empty { display: grid; justify-items: center; gap: 8px; text-align: center; }
  p { margin: 0; white-space: pre-line; }
  table { border-collapse: collapse; width: 100%; text-align: left; }
  th, td { padding: 5px 8px; border-bottom: 1px solid #ffffff18; }
  th:nth-last-child(-n+2), td:nth-last-child(-n+2) { text-align: right; }
  .empty-slot { opacity: 0.7; }
  .empty-slot td { text-align: left; }
  button { justify-self: start; }
  .den-layout { display: flex; flex-wrap: wrap; align-items: start; gap: 12px; }
  .den-roster { flex: 2 1 30rem; min-width: 0; overflow-x: auto; }
  .den-summary { flex: 1 1 15rem; min-width: 0; display: grid; gap: 10px; padding: 10px; background: #ffffff0d; }
  .den-summary-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .den-summary h3 { margin: 0; font-size: 14px; }
  .den-summary-heading span { color: #b8bdc6; }
  .den-summary-heading .enabled { color: #97d9a8; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 5px 12px; margin: 0; }
  dd { margin: 0; text-align: right; }
  tr.current { background: #ffffff17; }
  .den-name, .owner-link { background: none; border: 0; color: inherit; padding: 0; text-align: inherit; cursor: pointer; }
  .den-name:hover, .owner-link { text-decoration: underline; }
</style>
