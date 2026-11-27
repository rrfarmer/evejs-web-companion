<script lang="ts">
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import type { BookmarkPlace } from "../bridge/locationsList.ts";
  import { mercenaryDenNotice, type MercenaryDenRow, type MercenaryDensRead } from "../bridge/mercenaryDens.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { ContextMenu, type ContextEntry } from "../play/contextMenu.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { openAgencyGroup } from "./agencyRequests.ts";
  import BookmarkWindow from "./BookmarkWindow.svelte";
  import { solarSystemMenu, solarSystemMenuWords } from "./solarSystemMenu.ts";
  import { notify } from "./notices.ts";
  import { showInfo } from "./showInfo.ts";
  import MercenaryDenManagement from "./MercenaryDenManagement.svelte";

  let { store, flow, onShowSystem, onShowMapBrowser }: {
    store: ClientStore; flow: AppFlow; onShowSystem?: (id: number) => void; onShowMapBrowser?: (id: number) => void;
  } = $props();
  const words = $derived(store.words);
  const names = $derived(store.names);
  const station = $derived(store.station);
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
    saveLocation: ["UI/Inflight/BookmarkLocation", "Save Location…"],
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
  const reloadAgain = new Set<number>();
  const pendingRosterRefresh = new Set<number>();
  const activityRevisions = new SvelteMap<number, number>();
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
  async function reloadRow(id: number, showError = true) {
    if (reloading.has(id)) {
      reloadAgain.add(id);
      return;
    }
    const serial = loadSerial;
    reloading.add(id);
    try {
      do {
        reloadAgain.delete(id);
        try {
          const row = await flow.reloadMercenaryDen(id);
          if (serial === loadSerial && row && directory?.owned.includes(id)) {
            directory = { ...directory, rows: [...directory.rows.filter(item => item.id !== id), row] };
          }
        } catch (cause) {
          if (showError && serial === loadSerial) notify({ kind: "danger", title: word("reload"), detail: panelErrorWords(cause) });
        }
      } while (serial === loadSerial && reloadAgain.has(id));
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
      { path: labels.location[0], label: word("location"),
        sub: solarSystemMenu(store, flow, row.solarSystemID, () => systemName(row), place => { bookmark = place; }, onShowSystem, onShowMapBrowser) },
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
    const notices = flow.gatewayNotices;
    let lastSeen = notices.get()?.n;
    return notices.subscribe(notice => {
      if (!notice || notice.n === lastSeen) return;
      lastSeen = notice.n;
      const change = mercenaryDenNotice(notice.typeName, notice.payload);
      if (!change || (directory && !directory.owned.includes(change.denID))) return;
      if (change.operations) activityRevisions.set(change.denID, notice.n);
      if (change.roster) {
        if (directory) void reloadRow(change.denID, false);
        else pendingRosterRefresh.add(change.denID);
      }
    });
  });
  $effect(() => {
    void revision;
    void characterID;
    let current = true;
    reloading.clear();
    reloadAgain.clear();
    pendingRosterRefresh.clear();
    activityRevisions.clear();
    directory = null;
    error = "";
    flow.requestWords([...Object.values(labels).map(([key]) => key), ...solarSystemMenuWords]);
    void flow.loadMyMercenaryDens().then(result => {
      if (!current) return;
      directory = result;
      for (const id of pendingRosterRefresh) {
        if (result.owned.includes(id)) void reloadRow(id, false);
      }
      pendingRosterRefresh.clear();
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
            <MercenaryDenManagement {store} {flow} den={selected} {characterID} activityRevision={activityRevisions.get(selected.id) ?? 0} />
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
