<script lang="ts">
  // corporation/corp_ui_killreports.py CorpKillReports: the top row - the Show Kills / Show Losses combo (its choice kept,
  // CorpCombatLogCombo), the previous / next page buttons, the quick filter (150 wide, at the right) - and the scroll of
  // KillMail entries (control/entries/kill_mail.py), NUM_KILL_ENTRIES a page from corpRegistry.GetRecentKills /
  // GetRecentLosses(num, offset): a page's offset the smallest killID of the one before (ShowKillsEx). Each entry: the
  // victim's ship's icon (42 x 42, its frame) and three lines - a loss (the victim the pilot or the corporation): the
  // ship and how long ago, the killer's corporation (and alliance), the killer's ship and weapon; a kill: the victim
  // and how long ago, the victim's corporation (and alliance), the ship and the system. The filter keeps a kill whose
  // ship, victim, its corporation or alliance has the text (GetCombatEntries.FilterOut).
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { KillReport } from "../bridge/corpKillReports.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import TypeIcon from "./TypeIcon.svelte";
  let { store, flow, active = true }: { store: ClientStore; flow: AppFlow; active?: boolean } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  /** corp_ui_killreports NUM_KILL_ENTRIES */
  const NUM_KILL_ENTRIES = 10;
  const LABELS = {
    kills: "UI/Corporations/Wars/Killmails/ShowKills", losses: "UI/Corporations/Wars/Killmails/ShowLosses",
    noKills: "UI/Corporations/CorporationWindow/Wars/NoKillsFound", noLosses: "UI/Corporations/CorporationWindow/Wars/NoLossesFound",
    previous: "UI/Common/Previous", more: "UI/Common/ViewMore", filter: "UI/Inventory/Filter",
    shipAndTime: "UI/Control/Entries/KillMailShipAndTime", characterAndTime: "UI/Control/Entries/KillMailCharacterAndTime",
    shipAndWeapon: "UI/Control/Entries/KillMailShipAndWeapon", shipAndSystem: "UI/Control/Entries/KillMailShipAndSolarSystem",
    unknown: "UI/Control/Entries/KillMailUnknown",
  } as const;
  const word = (label: string, fallback: string) => plainText($words.templates[label] ?? fallback);
  const nameOf = (kind: Parameters<typeof resolvedName>[1], id: number | null) => (id ? resolvedName($names.resolved, kind, id, "") : "");
  const fill = (label: string, fallback: string, values: Record<string, string | number | null>) =>
    plainText(formatTemplate($words.templates[label] ?? fallback, Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v === null ? "" : String(v)])), { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") }));

  const COMBO_KEY = "evejs.play.CorpCombatLogCombo";
  let combat = $state<"kills" | "losses">((() => { try { return localStorage.getItem(COMBO_KEY) === "losses" ? "losses" : "kills"; } catch { return "kills"; } })());
  let filter = $state("");
  let rows = $state<readonly KillReport[] | null>(null);
  let error = $state("");
  let page = $state(0);
  /** prevIDs: each page's offset (the first's none) */
  let offsets: (number | null)[] = [null];
  let serial = 0;
  async function show(offset: number | null): Promise<void> {
    const request = ++serial;
    error = "";
    try {
      const answer = await flow.corporationKillReports(combat, NUM_KILL_ENTRIES, offset);
      if (request !== serial) return;
      rows = answer;
    } catch (cause) { if (request === serial) { error = cause instanceof Error ? cause.message : String(cause); rows = []; } }
  }
  function pick(kind: "kills" | "losses"): void {
    combat = kind;
    try { localStorage.setItem(COMBO_KEY, kind); } catch { /* kept for this page only */ }
    page = 0; offsets = [null];
    void show(null);
  }
  function next(): void {
    if (!rows?.length) return;
    offsets[page + 1] = Math.min(...rows.map((r) => r.killID));
    page++;
    void show(offsets[page] ?? null);
  }
  function previous(): void {
    if (page <= 0) return;
    page--;
    void show(offsets[page] ?? null);
  }
  let loaded = false;
  $effect(() => { if (active && !loaded) { loaded = true; void show(null); } });
  onMount(() => { flow.requestWords(Object.values(LABELS)); });

  const shown = $derived.by(() => {
    const text = filter.trim().toLowerCase();
    if (!rows || !text) return rows ?? [];
    return rows.filter((k) => [nameOf("type", k.victimShipTypeID), nameOf("owner", k.victimCharacterID), nameOf("owner", k.victimCorporationID), nameOf("owner", k.victimAllianceID)].some((n) => n.toLowerCase().includes(text)));
  });
  /** How long ago, in the client's 100 ns ticks (blue.os.GetWallclockTime() - killTime, at least 0). */
  const ago = (k: KillReport) => (k.killTimeMs === null ? null : Math.max(0, Date.now() - k.killTimeMs) * 10000);
  /** _GetCorpAndOrAllianceText: the corporation, and the alliance after it where there is one. */
  const corpAndAlliance = (corpID: number | null, allianceID: number | null) => [nameOf("owner", corpID), nameOf("owner", allianceID)].filter(Boolean).join(" / ");
  function lines(k: KillReport): string[] {
    const online = $station.online;
    const loss = (online?.characterID != null && online.characterID === k.victimCharacterID) || (online?.corporationID != null && online.corporationID === k.victimCorporationID);
    if (loss) {
      const weapon = k.finalShipTypeID && k.finalWeaponTypeID ? fill(LABELS.shipAndWeapon, "{[item]shipTypeID.name} / {[item]weaponTypeID.name}", { shipTypeID: k.finalShipTypeID, weaponTypeID: k.finalWeaponTypeID })
        : nameOf("type", k.finalShipTypeID ?? k.finalWeaponTypeID);
      return [fill(LABELS.shipAndTime, "{[item]shipTypeID.name}", { shipTypeID: k.victimShipTypeID, killTime: ago(k) }), corpAndAlliance(k.finalCorporationID, k.finalAllianceID), weapon];
    }
    if (!k.victimCharacterID && !k.victimCorporationID) return [word(LABELS.unknown, "Unknown")];
    const who = k.victimCharacterID ? fill(LABELS.characterAndTime, "{[character]characterID.name}", { characterID: k.victimCharacterID, killTime: ago(k) }) : "";
    const where = k.victimShipTypeID && k.solarSystemID ? fill(LABELS.shipAndSystem, "{[item]shipTypeID.name}", { shipTypeID: k.victimShipTypeID, solarSystemID: k.solarSystemID, regionID: null, security: null }) : nameOf("type", k.victimShipTypeID);
    return [who, corpAndAlliance(k.victimCorporationID, k.victimAllianceID), where];
  }
</script>

<div class="kill-reports">
  <div class="kr-top">
    <select class="kr-combo" value={combat} onchange={(e) => pick(e.currentTarget.value === "losses" ? "losses" : "kills")}>
      <option value="kills">{word(LABELS.kills, "Show Kills")}</option>
      <option value="losses">{word(LABELS.losses, "Show Losses")}</option>
    </select>
    <span class="kr-grow"></span>
    <button type="button" class="kr-page" disabled={page <= 0} title={word(LABELS.previous, "Previous")} onclick={previous}>‹</button>
    <button type="button" class="kr-page" disabled={(rows?.length ?? 0) < NUM_KILL_ENTRIES} title={word(LABELS.more, "View More")} onclick={next}>›</button>
    <input class="kr-filter" type="search" placeholder={word(LABELS.filter, "Filter")} bind:value={filter} />
  </div>
  {#if error}<p class="error">{error}</p>{/if}
  <div class="kr-scroll">
    {#if rows !== null && !shown.length}
      <p class="kr-empty">{combat === "kills" ? word(LABELS.noKills, "No kills found") : word(LABELS.noLosses, "No losses found")}</p>
    {/if}
    {#each shown as k (k.killID)}
      <div class="kr-entry">
        <span class="kr-icon">{#if k.victimShipTypeID}<TypeIcon typeID={k.victimShipTypeID} name={nameOf("type", k.victimShipTypeID)} size="md" />{/if}</span>
        <span class="kr-lines">{#each lines(k) as line, i (i)}<span class="kr-line">{line}</span>{/each}</span>
      </div>
    {/each}
  </div>
</div>

<style>
  .kill-reports { display: flex; flex-direction: column; gap: 8px; height: 100%; min-height: 0; }
  .kr-top { display: flex; align-items: center; gap: 4px; }
  .kr-grow { flex: 1; }
  .kr-filter { width: 150px; }
  .kr-page { width: 24px; }
  .kr-scroll { flex: 1; overflow: auto; min-height: 0; }
  .kr-entry { display: flex; gap: 4px; padding: 2px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.06); }
  .kr-icon { width: 42px; height: 42px; flex: none; box-shadow: inset 0 0 0 1px rgba(102, 102, 102, 0.5); overflow: hidden; }
  .kr-icon :global(.type-icon) { width: 42px; height: 42px; }
  .kr-lines { display: flex; flex-direction: column; min-width: 0; padding-top: 2px; }
  .kr-line { height: 14px; line-height: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .kr-empty { opacity: 0.6; padding: 8px; }
</style>
