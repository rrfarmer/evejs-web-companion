<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { combatReportDetails, combatReportHash, type CombatLogReport } from "../bridge/combatLog.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { shownSecurity } from "../bridge/systemSecurity.ts";
  import { ContextMenu, type ContextEntry } from "../play/contextMenu.ts";
  import { CHARACTER_SHEET_POINTERS } from "../play/uiPointer.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { JsonValue } from "../bridge/wire.ts";
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
  const mailPath = "UI/Util/CommonUtils/";
  const mailLabels = ["KillMail", "KillMailHeaderWithShip", "KillMailHeaderWithStructure",
    "KillMailPlayerAttacker", "KillMailPlayerAttackerWithFinalBlow", "KillMailMPCAttackerWithFinalBlow",
    "KillMailNPCAttacker", "KillMailDroppedItems", "KillMailDestroyedItems", "KillMailLostItem",
    "KillMAilLostStack", "KillMailLostStackBPC", "KillMailLostItemBPC", "KillMailItemLocation", "InContainer"];
  const itemLocations = {
    cargo: "UI/Generic/Cargo", drone: "UI/Common/DroneBay", implant: "UI/Common/Implant", other: "UI/Common/Other",
  };
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
  let opened = $state.raw<CombatLogReport | null>(null);
  let modal: HTMLDialogElement | undefined = $state();
  let hashes = $state.raw<ReadonlyMap<number, string>>(new Map());
  const pageSize = 25;
  const pilot = $derived($station.online?.characterID ?? null);
  const name = (kind: NameRef["kind"], id: number | null) => id ? resolvedName($names.resolved, kind, id, "") : "";
  const owner = (id: number | null) => name("owner", id);
  const type = (id: number | null) => name("type", id);
  const unknown = $derived(word("UI/Common/Unknown", "Unknown"));
  const date = (row: CombatLogReport) => row.killTime === null ? "" : plainText(formatTemplate(
    "{[datetime]datetime, time=long}", { datetime: String(row.killTime) }, { nameOf: name }));
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
      const refs: NameRef[] = [];
      const add = (kind: NameRef["kind"], ...ids: (number | null)[]) => {
        for (const id of ids) if (id) refs.push({ kind, id });
      };
      for (const row of answer) {
        add("owner", row.victimCharacterID, row.victimCorporationID, row.victimAllianceID, row.victimFactionID,
          row.finalCharacterID, row.finalCorporationID, row.finalAllianceID);
        add("type", row.victimShipTypeID, row.finalShipTypeID, row.finalWeaponTypeID);
        add("system", row.solarSystemID);
        if (row.moonID) add("celestial", row.moonID);
        const { attackers, items } = combatReportDetails(row);
        for (const each of attackers) {
          add("owner", each.characterID, each.corporationID, each.allianceID, each.factionID);
          add("type", each.shipTypeID, each.weaponTypeID);
        }
        add("type", ...items.map(item => item.typeID));
      }
      flow.requestNames(refs);
      flow.requestSystemSecurity(answer.flatMap(row => row.solarSystemID ? [row.solarSystemID] : []));
      rows = answer;
      void Promise.all(answer.map(async row => [row.killID, await combatReportHash(row)] as const))
        .then(result => { if (sequence === current) hashes = new Map(result); }).catch(() => {});
    } catch (cause) { if (sequence === current) { error = panelErrorWords(cause); rows = []; } }
    finally { if (sequence === current) loading = false; }
  }
  onMount(() => {
    flow.requestWords([...Object.values(labels), ...fields.map(field => "UI/Common/" + field), "UI/Common/Unknown",
      "UI/Common/None", ...mailLabels.map(key => mailPath + key), ...Object.values(itemLocations),
      ...["CondensedCombatLog", "NoKillsFound", "NoLossesFound", "ViewMore", "ViewPrevious"].map(key => tabPath + key)]);
    void load();
    return () => { sequence++; menu.close(); };
  });

  async function showReport(row: CombatLogReport) {
    opened = row;
    await tick();
    if (modal && !modal.open) modal.showModal();
  }
  function showOpponent(row: CombatLogReport) {
    const loss = row.victimCharacterID === pilot;
    const characterID = loss ? row.finalCharacterID : row.victimCharacterID;
    const corporationID = loss ? row.finalCorporationID : row.victimCorporationID;
    if (characterID) showInfo({ kind: "character", characterID });
    else if (corporationID) showInfo({ kind: "corporation", corporationID });
    else if (!loss && row.victimAllianceID) showInfo({ kind: "alliance", allianceID: row.victimAllianceID });
  }
  const attacker = (row: ReturnType<typeof combatReportDetails>["attackers"][number]) =>
    owner(row.characterID) || type(row.shipTypeID) || owner(row.corporationID) || unknown;
  const mail = (label: string, fallback: string, values: Record<string, JsonValue>) =>
    formatTemplate($words.templates[mailPath + label] || fallback, values, { nameOf: name });
  function mailText(row: CombatLogReport) {
    const { attackers, items } = combatReportDetails(row);
    const sec = row.solarSystemID ? $names.systemSecurity[row.solarSystemID] ?? null : null;
    const header = mail(row.victimCharacterID ? "KillMailHeaderWithShip" : "KillMailHeaderWithStructure",
      (row.victimCharacterID ? "Victim: {[character]victim.name}<br>" : "") +
      "Corp: {corporation}<br>Alliance: {alliance}<br>Faction: {faction}<br>Destroyed: {[item]target.name}<br>" +
      "System: {[location]system.name}<br>Security: {security}<br>Moon: {moon}<br>Damage Taken: {damage}<br>", {
        victim: row.victimCharacterID, corporation: owner(row.victimCorporationID) || unknown,
        alliance: owner(row.victimAllianceID) || unknown, faction: owner(row.victimFactionID) || unknown,
        target: row.victimShipTypeID, system: row.solarSystemID, security: sec === null ? null : shownSecurity(sec),
        moon: name("celestial", row.moonID) || unknown, damage: row.damageTaken ?? 0,
      });
    const none = word("UI/Common/None", "None");
    const parties = attackers.map(each => mail(each.characterID
      ? each.final ? "KillMailPlayerAttackerWithFinalBlow" : "KillMailPlayerAttacker"
      : each.final ? "KillMailMPCAttackerWithFinalBlow" : "KillMailNPCAttacker",
      `Name: {attacker}${each.final ? " (laid the final blow)" : ""}<br>Corp: {corporation}<br>Ship: {ship}<br>Weapon: {weapon}<br>Damage Done: {damage}<br><br>`, {
        attacker: attacker(each), security: each.security, corporation: owner(each.corporationID) || unknown,
        alliance: owner(each.allianceID) || none, faction: owner(each.factionID) || none,
        ship: type(each.shipTypeID) || unknown, weapon: type(each.weaponTypeID) || unknown,
        owner: owner(each.corporationID) || unknown, damage: each.damage,
      })).join("");
    const itemText = (kind: "dropped" | "destroyed") => {
      const listing = items.filter(item => item[kind] > 0).map(item => {
        const location = item.contained ? mail("InContainer", "In Container", {}) :
          item.flag === 5 ? word(itemLocations.cargo, "Cargo") : item.flag === 87 ? word(itemLocations.drone, "Drone Bay")
          : item.flag === 89 ? word(itemLocations.implant, "Implant") :
            item.flag >= 11 && item.flag <= 34 || item.flag >= 92 && item.flag <= 99 ? "" : word(itemLocations.other, "Other");
        const itemLocation = location ? mail("KillMailItemLocation", " ({itemLocation})", { itemLocation: location }) : "";
        const quantity = item[kind];
        const label = item.singleton === 2 ? quantity > 1 ? "KillMailLostStackBPC" : "KillMailLostItemBPC"
          : quantity > 1 ? "KillMAilLostStack" : "KillMailLostItem";
        return (item.contained ? "<t>" : "") + mail(label, "{[item]item.name}, Qty: {quantity}{itemLocation}<br>",
          { item: item.typeID, quantity, itemLocation });
      }).join("");
      if (!listing) return "";
      return kind === "dropped" ? mail("KillMailDroppedItems", "Dropped items:<br>{droppedItems}", { droppedItems: listing })
        : mail("KillMailDestroyedItems", "Destroyed items:<br>{destroyedItems}", { destroyedItems: listing });
    };
    return mail("KillMail", "{timestamp}<br><br>{header}<br>Involved parties:<br><br>{attackers}{destroyedItems}{droppedItems}", {
      timestamp: date(row), header, attackers: parties, destroyedItems: itemText("destroyed"), droppedItems: itemText("dropped"),
    }).replace(/[\r\n]/g, "").split(/<br\s*\/?>/i).map(line => plainText(line.replace(/<t>/gi, "   "))).join("\r\n");
  }
  const copy = (text: string) => void navigator.clipboard.writeText(text).catch(cause => { error = panelErrorWords(cause); });
  async function copyExternal(row: CombatLogReport) {
    try {
      const hash = hashes.get(row.killID) ?? await combatReportHash(row);
      copy(`https://esi.evetech.net/killmails/${row.killID}/${hash}`);
    } catch (cause) { error = panelErrorWords(cause); }
  }
  function menuFor(event: MouseEvent, row: CombatLogReport) {
    event.preventDefault();
    const entries: ContextEntry[] = [];
    if (!condensed) entries.push({ label: word(labels.info, "Show Info"), run: () => showOpponent(row) }, null);
    entries.push({ label: word(condensed ? labels.condensedCopy : labels.copy, "Copy Kill Information"), run: () => copy(mailText(row)) },
      { label: word(labels.external, "Copy External Kill Link"), run: () => void copyExternal(row) });
    menu.open(event.clientX, event.clientY, entries);
  }
  function drag(event: DragEvent, row: CombatLogReport) {
    const hash = hashes.get(row.killID);
    if (hash) startLinkDrag(event, `killReport:${row.killID}:${hash}`, word(labels.report, "Kill Report"));
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
        <tr data-combat-report={row.killID} oncontextmenu={event => menuFor(event, row)} ondblclick={() => void showReport(row)}>
          <td>{date(row)}</td><td>{type(row.victimShipTypeID) || unknown}</td>
          <td><button type="button" onclick={() => void showReport(row)}>{owner(row.victimCharacterID) || unknown}</button></td>
          <td>{owner(row.victimCorporationID) || unknown}</td><td>{owner(row.victimAllianceID) || unknown}</td><td>{owner(row.victimFactionID) || unknown}</td>
        </tr>
      {/each}</tbody>
    </table>
  {:else}
    {#each shown as row (row.killID)}
      {@const loss = row.victimCharacterID === pilot}
      <div class="kill-entry" data-combat-report={row.killID} role="group" draggable={hashes.has(row.killID)}
        ondragstart={event => drag(event, row)} oncontextmenu={event => menuFor(event, row)} ondblclick={() => void showReport(row)}>
        {#if row.victimShipTypeID}<TypeIcon typeID={row.victimShipTypeID} name={type(row.victimShipTypeID)} size="md" />{/if}
        <span class="lines">
          <button type="button" onclick={() => void showReport(row)}>{loss ? type(row.victimShipTypeID) || unknown : victim(row)} · {date(row)}</button>
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

{#if opened}
  <dialog bind:this={modal} aria-label={word(labels.report, "Kill Report")} onclose={() => { if (!modal?.open) opened = null; }}>
    <strong>{word(labels.report, "Kill Report")}</strong>
    <pre>{mailText(opened)}</pre>
    <form method="dialog"><button type="submit">{word(labels.close, "Close")}</button></form>
  </dialog>
{/if}

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
  .pages, form { display: flex; gap: 6px; justify-content: flex-end; margin-top: 8px; }
  dialog { color: var(--color-text); background: var(--color-panel, #181e23); border: 1px solid var(--color-line);
    width: min(520px, 90vw); max-height: 85vh; padding: 1rem; }
  pre { color: inherit; font: inherit; white-space: pre-wrap; }
</style>
