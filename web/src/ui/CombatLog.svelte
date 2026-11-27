<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { combatReportHash, combatReportUrl, externalCombatReportUrl, type CombatLogReport } from "../bridge/combatLog.ts";
  import { COMBAT_REPORT_WORDS, combatReportDate, combatReportNameRefs, combatReportText } from "../bridge/combatReportPresentation.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { ContextMenu, type ContextEntry } from "../play/contextMenu.ts";
  import { CHARACTER_SHEET_POINTERS } from "../play/uiPointer.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName, type NameRef } from "../store/names.ts";
  import TypeIcon from "./TypeIcon.svelte";
  import { showInfo } from "./showInfo.ts";
  import { startLinkDrag } from "./linkFollowers.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  const words = $derived(store.words), names = $derived(store.names), station = $derived(store.station);
  const labels = {
    kills: "UI/Corporations/Wars/Killmails/ShowKills", losses: "UI/Corporations/Wars/Killmails/ShowLosses",
    report: "UI/Corporations/Wars/Killmails/KillReport", info: "UI/Commands/ShowInfo",
    copy: "UI/Control/Entries/CopyKillInformation", condensedCopy: "UI/CharacterSheet/CharacterSheetWindow/KillsTabs/CopyKillInfo",
    external: "UI/Control/Entries/CopyExternalKillLink", filter: "UI/Inventory/Filter", close: "UI/Common/Buttons/Close",
  };
  const tabPath = "UI/CharacterSheet/CharacterSheetWindow/KillsTabs/";
  const fields = ["Date", "Type", "Name", "Corporation", "Alliance", "Faction"];
  const word = (label: string, fallback: string) => plainText($words.templates[label] || fallback);
  const menu = new ContextMenu();
  type Mode = "kills" | "losses";
  // svelte-ignore state_referenced_locally
  const settingKey = `evejs.user.${store.session.get().accountID ?? "local"}.combatLog`;
  const saved = (() => { try { return JSON.parse(localStorage.getItem(settingKey) ?? "{}") ?? {}; } catch { return {}; } })();
  let mode = $state<Mode>(saved.mode === "losses" ? "losses" : "kills");
  let condensed = $state(saved.condensed === true);
  let filter = $state("");
  let rows = $state.raw<readonly CombatLogReport[] | null>(null);
  let cursors = $state<readonly (number | null)[]>([null]);
  let loading = $state(false);
  let error = $state("");
  let sequence = 0;
  let hashes = $state.raw<ReadonlyMap<number, string>>(new Map());
  const pageSize = 25;
  const pilot = $derived($station.online?.characterID ?? null);
  const name = (kind: NameRef["kind"], id: number | null) => id ? resolvedName($names.resolved, kind, id, "") : "";
  const owner = (id: number | null) => name("owner", id);
  const type = (id: number | null) => name("type", id);
  const unknown = $derived(word("UI/Common/Unknown", "Unknown"));
  const system = (row: CombatLogReport) => name("system", row.solarSystemID);
  const victim = (row: CombatLogReport) => owner(row.victimCharacterID) || owner(row.victimCorporationID) || unknown;
  const affiliations = (corporation: number | null, alliance: number | null) => [owner(corporation), owner(alliance)].filter(Boolean).join(" / ");
  const shown = $derived.by(() => {
    const q = filter.toLowerCase();
    return (rows ?? []).filter(row => [type(row.victimShipTypeID), owner(row.victimCharacterID),
      owner(row.victimCorporationID), owner(row.victimAllianceID)].some(value => value.toLowerCase().includes(q)));
  });

  function save() {
    try { localStorage.setItem(settingKey, JSON.stringify({ mode, condensed })); } catch { /* this visit only */ }
  }
  async function load() {
    const current = ++sequence;
    loading = true;
    error = "";
    try {
      const answer = await flow.personalCombatLog(mode, cursors.at(-1) ?? null);
      if (current !== sequence) return;
      flow.requestNames(combatReportNameRefs(answer));
      flow.requestSystemSecurity(answer.flatMap(row => row.solarSystemID ? [row.solarSystemID] : []));
      rows = answer;
      void Promise.all(answer.map(async row => [row.killID, await combatReportHash(row)] as const))
        .then(result => { if (sequence === current) hashes = new Map(result); }).catch(() => {});
    } catch (cause) { if (sequence === current) { error = panelErrorWords(cause); rows = []; } }
    finally { if (sequence === current) loading = false; }
  }
  onMount(() => {
    flow.requestWords([...Object.values(labels), ...fields.map(field => "UI/Common/" + field), "UI/Common/Unknown",
      ...COMBAT_REPORT_WORDS,
      ...["CondensedCombatLog", "NoKillsFound", "NoLossesFound", "ViewMore", "ViewPrevious"].map(key => tabPath + key)]);
    void load();
    return () => { sequence++; menu.close(); };
  });

  function showOpponent(row: CombatLogReport) {
    const loss = row.victimCharacterID === pilot;
    const characterID = loss ? row.finalCharacterID : row.victimCharacterID;
    const corporationID = loss ? row.finalCorporationID : row.victimCorporationID;
    if (characterID) showInfo({ kind: "character", characterID });
    else if (corporationID) showInfo({ kind: "corporation", corporationID });
    else if (!loss && row.victimAllianceID) showInfo({ kind: "alliance", allianceID: row.victimAllianceID });
  }
  const copy = (text: string) => void navigator.clipboard.writeText(text).catch(cause => { error = panelErrorWords(cause); });
  async function copyExternal(row: CombatLogReport) {
    try {
      const hash = hashes.get(row.killID) ?? await combatReportHash(row);
      copy(externalCombatReportUrl(row.killID, hash));
    } catch (cause) { error = panelErrorWords(cause); }
  }
  function menuFor(event: MouseEvent, row: CombatLogReport) {
    event.preventDefault();
    const entries: ContextEntry[] = [];
    if (!condensed) entries.push({ label: word(labels.info, "Show Info"), run: () => showOpponent(row) }, null);
    entries.push({ label: word(condensed ? labels.condensedCopy : labels.copy, "Copy Kill Information"), run: () => copy(combatReportText(row, $names, $words.templates)) },
      { label: word(labels.external, "Copy External Kill Link"), run: () => void copyExternal(row) });
    menu.open(event.clientX, event.clientY, entries);
  }
  function drag(event: DragEvent, row: CombatLogReport) {
    const hash = hashes.get(row.killID);
    if (hash) startLinkDrag(event, combatReportUrl(row.killID, hash), word(labels.report, "Kill Report"));
  }
</script>

<section class="combat-log">
  <div class="combat-options">
    <label><select aria-label={word(labels.kills, "Show Kills") + " / " + word(labels.losses, "Show Losses")}
      data-ui-pointer={CHARACTER_SHEET_POINTERS.combatFilter} value={mode} onchange={event => {
        mode = event.currentTarget.value === "losses" ? "losses" : "kills";
        cursors = [null]; rows = null; save(); void load();
      }}>
      <option value="kills">{word(labels.kills, "Show Kills")}</option>
      <option value="losses">{word(labels.losses, "Show Losses")}</option>
    </select></label>
    <input type="search" aria-label={word(labels.filter, "Filter")} placeholder={word(labels.filter, "Filter")} bind:value={filter} />
    <label class="condensed"><input type="checkbox" bind:checked={condensed} onchange={() => {
      cursors = [null]; save(); void load();
    }} /> {word(tabPath + "CondensedCombatLog", "Condensed Combat Log")}</label>
  </div>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if loading && rows === null}<p role="status">Loading combat log…</p>
  {:else if !shown.length && !error}<p>{mode === "kills" ? word(tabPath + "NoKillsFound", "No kills found") : word(tabPath + "NoLossesFound", "No losses found")}</p>
  {:else if condensed}
    <table><thead><tr>{#each fields as field (field)}<th>{word("UI/Common/" + field, field)}</th>{/each}</tr></thead>
      <tbody>{#each shown as row (row.killID)}
        <tr data-combat-report={row.killID} oncontextmenu={event => menuFor(event, row)} ondblclick={event => flow.openCombatReport(row, event.shiftKey)}>
          <td>{combatReportDate(row)}</td><td>{type(row.victimShipTypeID) || unknown}</td>
          <td><button type="button" onclick={event => flow.openCombatReport(row, event.shiftKey)}>{owner(row.victimCharacterID) || unknown}</button></td>
          <td>{owner(row.victimCorporationID) || unknown}</td><td>{owner(row.victimAllianceID) || unknown}</td><td>{owner(row.victimFactionID) || unknown}</td>
        </tr>
      {/each}</tbody>
    </table>
  {:else}
    {#each shown as row (row.killID)}
      {@const loss = row.victimCharacterID === pilot}
      <div class="kill-entry" data-combat-report={row.killID} role="group" draggable={hashes.has(row.killID)}
        ondragstart={event => drag(event, row)} oncontextmenu={event => menuFor(event, row)} ondblclick={event => flow.openCombatReport(row, event.shiftKey)}>
        {#if row.victimShipTypeID}<TypeIcon typeID={row.victimShipTypeID} name={type(row.victimShipTypeID)} size="md" />{/if}
        <span class="lines">
          <button type="button" onclick={event => flow.openCombatReport(row, event.shiftKey)}>{loss ? type(row.victimShipTypeID) || unknown : victim(row)} · {combatReportDate(row)}</button>
          <span>{loss ? affiliations(row.finalCorporationID, row.finalAllianceID) : affiliations(row.victimCorporationID, row.victimAllianceID)}</span>
          <span>{loss ? [type(row.finalShipTypeID), type(row.finalWeaponTypeID)].filter(Boolean).join(" / ")
            : [type(row.victimShipTypeID), system(row)].filter(Boolean).join(" · ")}</span>
        </span>
      </div>
    {/each}
  {/if}
  {#if cursors.length > 1 || (rows?.length ?? 0) >= pageSize}
    <div class="pages">
      {#if cursors.length > 1}<button type="button" disabled={loading} onclick={() => { cursors = cursors.slice(0, -1); void load(); }}>{word(tabPath + "ViewPrevious", "View Previous")}</button>{/if}
      {#if rows && rows.length >= pageSize}<button type="button" disabled={loading}
        onclick={() => { cursors = [...cursors, Math.min(...(rows ?? []).map(row => row.killID))]; void load(); }}>{word(tabPath + "ViewMore", "View More")}</button>{/if}
    </div>
  {/if}
</section>

<style>
  .combat-options { display: grid; grid-template-columns: 1fr auto; gap: 6px; margin-bottom: 8px; }
  .combat-options input[type="search"] { width: 150px; }
  .condensed { grid-column: 1 / -1; }
  .kill-entry { display: flex; gap: 6px; min-height: 46px; padding: 2px 0; border-bottom: 1px solid var(--color-line); }
  .lines { display: flex; flex-direction: column; min-width: 0; }
  .lines button, td button { background: none; border: 0; padding: 0; color: inherit; text-align: left; }
  .lines button:hover, td button:hover { text-decoration: underline; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 4px; border-bottom: 1px solid var(--color-line); }
  .pages { display: flex; gap: 6px; justify-content: flex-end; margin-top: 8px; }
</style>
