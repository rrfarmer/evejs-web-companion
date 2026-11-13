<script lang="ts">
  // corporation/war/warDeclare.py WarDeclareWnd (WarDeclareWarDeclaration) with WarDeclareController: the caption -
  // the page's name and " (n/total)" - over the page, Back (not on the first) / Next (disabled until the page may be
  // left) or, on the summary, the declaration's button. Aggressive war's pages: Type and Corp, Pick HQ, Cost, Summary;
  // mutual war's: Type and Corp, Summary.
  //  - Type and Corp (WarDeclarePagePickTypeCorp): WarDeclareSummaryWarType and the two radio buttons; TypeSearchString,
  //    the name (100, 200 wide), Search, Exact; the owners (war.SearchForWarableEntity) - the warable ones greyed where
  //    already at war, or (aggressive) without a war permit or under an outgoing peace treaty, the non-warable
  //    corporations (in an alliance) greyed - each greyed one's reason as a hint; SearchForEntityToWarDeclare where
  //    nothing was searched; the selected opponent (WarDeclareSelectedOpponent; WarDeclareNoOpponentSelected).
  //  - Pick HQ: WarDeclarePickHqText (24 hours), a filter (64, 120 wide), the valid war HQs (GetValidWarHQs);
  //    WarDeclareNoPotentialHqFound(WithFilter); the selected HQ (WarDeclareSelectedWarHq / WarDeclareNoWarHqSelected).
  //  - Cost: WarDeclareCost (COST_OF_WAR 100,000,000 ISK, WAR_COOLDOWN_HOURS 24).
  //  - Summary: the two sides (Attacker / Defender; Party A / B), the war's type ("Aggressive war" / "Mutual War", not
  //    localized in the client), the start (fighting starts now where a finished war with the defender exists, else a
  //    day on; mutual: WAR_SPOOLUP_HOURS 24 and the invitation's expiry, 7 days), the HQ, the cost.
  // (The side's logos are their names here.)
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, WarableSearch } from "../app/flow.ts";
  import type { CorpWar } from "../bridge/corpWars.ts";
  import { DATE_LABELS, formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  let { store, flow, onClose }: { store: ClientStore; flow: AppFlow; onClose: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const W = "UI/Corporations/Wars/";
  const LABELS = ["WarDeclareWarDeclaration", "DeclareWarPageTypeAndCorp", "DeclareWarPagePickHQ", "DeclareWarPageCost", "DeclareWarPageSummary",
    "DeclareWarFinializeMutualDeclaration", "DeclareWarFinializeAggressiveDeclaration", "WarDeclareSummaryWarType", "WarTypeAggressive", "WarTypeMutual",
    "WarDeclareSelectedOpponent", "SearchForEntityToWarDeclare", "WarDeclareNoOpponentSelected", "WarDeclarePickHqText", "WarDeclareSelectedWarHq",
    "WarDeclareNoWarHqSelected", "WarDeclareNoPotentialHqFoundWithFilter", "WarDeclareNoPotentialHqFound", "WarDeclareCost", "WarDeclareSummaryStartTime",
    "WarDeclareSummaryMutualWarStartTime", "WarDeclareSummaryMutalWarInviteExpiry", "WarDeclareSummaryFightingStartsNow", "WarDeclareSummaryWarHq",
    "WarDeclareSummaryCost", "WarDeclareSummaryPartyA", "WarDeclareSummaryPartyB", "WarDeclareSummaryAttacker", "WarDeclareSummaryDefender", "Vs",
    "WarDeclareInAlliance", "WarDeclareCorpOrAllianceHasForcedPeace", "WarDeclareCorpOrAllianceDoesNotHaveWarPermit", "WarDeclareAlreadyAtWar"].map((k) => W + k)
    .concat(["UI/Shared/TypeSearchString", "UI/Corporations/CorporationWindow/Standings/Search", "UI/Corporations/CorporationWindow/Standings/SearchExact",
      "UI/Corporations/CorporationWindow/Standings/ExactCorpOrAllianceNameNotFound", "UI/Corporations/CorporationWindow/Standings/CorpOrAllianceNameNotFound",
      "/Carbon/UI/Common/Next", "/Carbon/UI/Commands/Back", "UI/Inventory/Filter", DATE_LABELS.ls!]);
  const fill = (label: string, fallback: string, values: Record<string, unknown> = {}) =>
    plainText(formatTemplate($words.templates[label] ?? fallback, values as never, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") }));
  // the searched owners' own names first (an alliance's is not among the corporations' names)
  const nameOf = (id: number) => found?.warable.find((o) => o.ownerID === id)?.name || resolvedName($names.resolved, "owner", id, "")
    || resolvedName($names.resolved, id >= 99_000_000 ? "alliance" : "corporation", id, String(id));
  const MUTUAL = 1, AGGRESSIVE = 2, PICK = 1, HQ = 2, COST = 3, SUMMARY = 4;
  const PAGE_NAMES: Record<number, string> = { 1: "DeclareWarPageTypeAndCorp", 2: "DeclareWarPagePickHQ", 3: "DeclareWarPageCost", 4: "DeclareWarPageSummary" };
  // WarDeclareController
  let warType = $state(AGGRESSIVE), page = $state(PICK), defenderID = $state<number | null>(null), warHQ = $state<number | null>(null);
  const attackerID = $station.online?.allianceID ?? $station.online?.corporationID ?? 0;
  const steps = $derived(warType === MUTUAL ? [PICK, SUMMARY] : [PICK, HQ, COST, SUMMARY]);
  const canContinue = $derived(page === PICK ? defenderID !== null : !(warType === AGGRESSIVE && page === HQ && warHQ === null));
  function next(): void { const i = steps.indexOf(page); page = steps[Math.min(i + 1, steps.length - 1)]!; if (page === HQ) void loadHQs(); if (page === SUMMARY) void loadWars(); }
  function back(): void { const i = steps.indexOf(page); page = steps[Math.max(i - 1, 0)]!; }
  // the opponent search
  let text = $state(""), exact = $state((() => { try { return localStorage.getItem("evejs.play.declareWar_SearchExactChk") === "true"; } catch { return false; } })());
  let found = $state<WarableSearch | null>(null), hint = $state(""), busy = $state(false);
  async function search(): Promise<void> {
    const s = text.trim();
    if (!s) { found = null; defenderID = null; hint = fill(W + "SearchForEntityToWarDeclare", "Search for a corporation or alliance to declare war on"); return; }
    busy = true;
    try {
      found = await flow.searchWarableOwners(s, exact);
      hint = found.warable.length ? "" : fill(exact ? "UI/Corporations/CorporationWindow/Standings/ExactCorpOrAllianceNameNotFound" : "UI/Corporations/CorporationWindow/Standings/CorpOrAllianceNameNotFound", "No corporation or alliance named {searchString}", { searchString: s });
      if (!found.warable.length) defenderID = null;
      if (defenderID !== null && !rows.some((r) => r.id === defenderID && !r.disabled)) defenderID = null;
    } finally { busy = false; }
  }
  // GetUnsortedScrollList (+ the non-warable corporations): the selected first, then by name
  const rows = $derived.by(() => {
    if (!found) return [];
    const f = found, mutual = warType === MUTUAL;
    const out = f.warable.map((o) => {
      const atWar = f.opponents.includes(o.ownerID), treaty = !mutual && f.treatyOwners.includes(o.ownerID);
      const disabled = atWar || (!mutual && (!o.warPermit || treaty));
      const reason = !disabled ? "" : treaty ? fill(W + "WarDeclareCorpOrAllianceHasForcedPeace", "{corpAllianceName} has an enforced peace", { corpAllianceName: o.name })
        : !o.warPermit && !mutual ? fill(W + "WarDeclareCorpOrAllianceDoesNotHaveWarPermit", "{corpAllianceName} is not war eligible", { corpAllianceName: o.name })
        : fill(W + "WarDeclareAlreadyAtWar", "Already at war with {corpAllianceName}", { corpAllianceName: o.name });
      return { id: o.ownerID, name: o.name || nameOf(o.ownerID), disabled, reason };
    }).concat(f.nonWarable.map((c) => ({ id: c.id, name: c.name, disabled: true, reason: fill(W + "WarDeclareInAlliance", "{corpAllianceName} is in an alliance", { corpAllianceName: c.name }) })));
    return out.sort((a, b) => Number(b.id === defenderID) - Number(a.id === defenderID) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  });
  // the HQs
  let hqs = $state<readonly { structureID: number; typeID: number; itemName: string }[] | null>(null), hqFilter = $state("");
  async function loadHQs(): Promise<void> {
    hqs = await flow.validWarHQs();
    if (warHQ !== null && !hqs.some((h) => h.structureID === warHQ)) warHQ = null;
  }
  const shownHQs = $derived((hqs ?? []).filter((h) => !hqFilter.trim() || h.itemName.toLowerCase().includes(hqFilter.trim().toLowerCase()))
    .sort((a, b) => Number(b.structureID === warHQ) - Number(a.structureID === warHQ) || a.itemName.toLowerCase().localeCompare(b.itemName.toLowerCase())));
  // the summary's start: WouldWarStartImmediately - a finished war with the defender
  let attackerWars = $state<readonly CorpWar[]>([]);
  async function loadWars(): Promise<void> { attackerWars = await flow.ownerWars(attackerID); }
  const startsNow = $derived(defenderID !== null && attackerWars.some((w) => [w.declaredByID, w.againstID].includes(defenderID!) && w.timeFinished !== null));
  const dateIn = (days: number) => fill(DATE_LABELS.ls!, "", { datetime: { type: "long", value: String(BigInt(Date.now() + days * 86_400_000) * 10000n + 116444736000000000n) } });
  const [sideA, sideB] = $derived(warType === MUTUAL ? [fill(W + "WarDeclareSummaryPartyA", "Party A"), fill(W + "WarDeclareSummaryPartyB", "Party B")]
    : [fill(W + "WarDeclareSummaryAttacker", "Attacker"), fill(W + "WarDeclareSummaryDefender", "Defender")]);
  let declaring = $state(false);
  async function declare(): Promise<void> {
    if (declaring || defenderID === null) return;
    declaring = true;
    try {
      const ok = warType === MUTUAL ? await flow.sendMutualWarInvite(defenderID) : warHQ !== null && await flow.declareWarAgainst(defenderID, warHQ);
      if (ok) onClose();
    } finally { declaring = false; }
  }
  onMount(() => { flow.requestWords(LABELS); flow.requestNames([{ kind: $station.online?.allianceID ? "alliance" : "corporation", id: attackerID }]); hint = ""; });
  const isk = (n: number) => `${n.toLocaleString("en-US")} ISK`;
</script>

<div class="dw-back">
  <div class="dw" role="dialog" aria-modal="true" aria-label={fill(W + "WarDeclareWarDeclaration", "War Declaration")}>
    <header><span>{fill(W + PAGE_NAMES[page], "")} <span class="dw-count">({steps.indexOf(page) + 1}/{steps.length})</span></span><button type="button" class="dw-x" aria-label="Close" onclick={onClose}>×</button></header>
    <div class="dw-main">
      {#if page === PICK}
        <div>{fill(W + "WarDeclareSummaryWarType", "War Type")}</div>
        <label class="dw-radio"><input type="radio" name="warType" checked={warType === AGGRESSIVE} onchange={() => { warType = AGGRESSIVE; void search(); }} />{fill(W + "WarTypeAggressive", "Aggressive")}</label>
        <label class="dw-radio"><input type="radio" name="warType" checked={warType === MUTUAL} onchange={() => { warType = MUTUAL; warHQ = null; void search(); }} />{fill(W + "WarTypeMutual", "Mutual")}</label>
        <div class="dw-small">{fill("UI/Shared/TypeSearchString", "Type search string")}</div>
        <div class="dw-search">
          <input bind:value={text} maxlength="100" onkeydown={(e) => { if (e.key === "Enter") void search(); }} />
          <button type="button" disabled={busy} onclick={() => void search()}>{fill("UI/Corporations/CorporationWindow/Standings/Search", "Search")}</button>
          <label><input type="checkbox" checked={exact} onchange={() => { exact = !exact; try { localStorage.setItem("evejs.play.declareWar_SearchExactChk", String(exact)); } catch { /* not kept */ } }} />{fill("UI/Corporations/CorporationWindow/Standings/SearchExact", "Exact")}</label>
        </div>
        <div class="dw-list" role="listbox">
          {#if !found}<p class="dw-hint">{fill(W + "SearchForEntityToWarDeclare", "Search for a corporation or alliance to declare war on")}</p>{:else if hint}<p class="dw-hint">{hint}</p>{/if}
          {#each rows as r (r.id)}
            <div role="option" tabindex="0" aria-selected={defenderID === r.id} aria-disabled={r.disabled} class:disabled={r.disabled} class:picked={defenderID === r.id}
              title={r.reason} onclick={() => { if (!r.disabled) defenderID = r.id; }} onkeydown={(e) => { if (e.key === "Enter" && !r.disabled) defenderID = r.id; }}>{r.name}</div>
          {/each}
        </div>
        <div class="dw-selected-label">{fill(W + "WarDeclareSelectedOpponent", "Selected opponent")}</div>
        <div class="dw-selected">{defenderID !== null ? nameOf(defenderID) : fill(W + "WarDeclareNoOpponentSelected", "No opponent selected")}</div>
      {:else if page === HQ}
        <p>{fill(W + "WarDeclarePickHqText", "Pick a war headquarters", { numHours: 24 })}</p>
        <div class="dw-filter"><input bind:value={hqFilter} maxlength="64" placeholder={fill("UI/Inventory/Filter", "Filter")} /></div>
        <div class="dw-list" role="listbox">
          {#if hqs !== null && !shownHQs.length}<p class="dw-hint">{fill(W + (hqs.length && hqFilter.trim() ? "WarDeclareNoPotentialHqFoundWithFilter" : "WarDeclareNoPotentialHqFound"), "No potential war HQ found")}</p>{/if}
          {#each shownHQs as h (h.structureID)}
            <div role="option" tabindex="0" aria-selected={warHQ === h.structureID} class:picked={warHQ === h.structureID} onclick={() => (warHQ = h.structureID)} onkeydown={(e) => { if (e.key === "Enter") warHQ = h.structureID; }}>{h.itemName}</div>
          {/each}
        </div>
        <div class="dw-selected-label">{fill(W + "WarDeclareSelectedWarHq", "Selected war HQ")}</div>
        <div class="dw-selected">{warHQ !== null ? (hqs?.find((h) => h.structureID === warHQ)?.itemName ?? String(warHQ)) : fill(W + "WarDeclareNoWarHqSelected", "No war HQ selected")}</div>
      {:else if page === COST}
        <div class="dw-cost">{fill(W + "WarDeclareCost", "A war costs {warCost}", { warCost: isk(100_000_000), numHoursCooldown: 24 })}</div>
      {:else}
        <div class="dw-sides"><span class="dw-a">{sideA}<br /><b>{nameOf(attackerID)}</b></span><span class="dw-vs" title={fill(W + "Vs", "vs")}>⚔</span><span class="dw-b">{sideB}<br /><b>{defenderID !== null ? nameOf(defenderID) : ""}</b></span></div>
        <div class="dw-summary">
          <div><span>{fill(W + "WarDeclareSummaryWarType", "War Type")}</span><span>{warType === MUTUAL ? "Mutual War" : "Aggressive war"}</span></div>
          <div><span>{sideA}</span><span>{nameOf(attackerID)}</span></div>
          <div><span>{sideB}</span><span>{defenderID !== null ? nameOf(defenderID) : ""}</span></div>
          {#if warType === MUTUAL}
            <div><span>{fill(W + "WarDeclareSummaryStartTime", "Start time")}</span><span>{fill(W + "WarDeclareSummaryMutualWarStartTime", "{numHoursInSpoolup} hours after acceptance", { numHoursInSpoolup: 24 })}</span></div>
            <div class="dw-gap"></div>
            <div><span>{fill(W + "WarDeclareSummaryMutalWarInviteExpiry", "Invite expiry")}</span><span>{dateIn(7)}</span></div>
          {:else}
            <div><span>{fill(W + "WarDeclareSummaryStartTime", "Start time")}</span><span>{startsNow ? fill(W + "WarDeclareSummaryFightingStartsNow", "Fighting starts now") : dateIn(1)}</span></div>
            <div><span>{fill(W + "WarDeclareSummaryWarHq", "War HQ")}</span><span>{hqs?.find((h) => h.structureID === warHQ)?.itemName ?? ""}</span></div>
            <div><span>{fill(W + "WarDeclareSummaryCost", "Cost")}</span><span>{isk(100_000_000)}</span></div>
          {/if}
        </div>
      {/if}
    </div>
    <div class="dw-buttons">
      {#if page !== PICK}<button type="button" onclick={back}>{fill("/Carbon/UI/Commands/Back", "Back")}</button>{:else}<span></span>{/if}
      {#if page === SUMMARY}
        <button type="button" disabled={declaring} onclick={() => void declare()}>{fill(W + (warType === MUTUAL ? "DeclareWarFinializeMutualDeclaration" : "DeclareWarFinializeAggressiveDeclaration"), "Declare War")}</button>
      {:else}
        <button type="button" disabled={!canContinue} onclick={next}>{fill("/Carbon/UI/Common/Next", "Next")}</button>
      {/if}
    </div>
  </div>
</div>

<style>
  .dw-back { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; background: rgba(0, 0, 0, 0.35); }
  .dw { width: 460px; height: 520px; display: flex; flex-direction: column; background: #15181b; border: 1px solid rgba(255, 255, 255, 0.15); }
  header { height: 52px; display: flex; justify-content: space-between; align-items: center; padding: 0 8px 0 60px; font-size: 16px; }
  .dw-count { color: rgba(255, 255, 255, 0.4); }
  .dw-x { background: none; border: 0; color: inherit; font-size: 16px; cursor: pointer; }
  .dw-main { flex: 1; display: flex; flex-direction: column; gap: 3px; padding: 4px 8px; min-height: 0; }
  .dw-radio { display: flex; gap: 6px; align-items: center; }
  .dw-small { font-size: 11px; padding-top: 10px; }
  .dw-search { display: flex; gap: 4px; align-items: center; }
  .dw-search input:first-child { width: 200px; }
  .dw-list { flex: 1; overflow: auto; margin: 4px 0; border: 1px solid rgba(255, 255, 255, 0.1); }
  .dw-list div { height: 18px; padding: 0 4px; cursor: default; }
  .dw-list div.picked { background: rgba(255, 255, 255, 0.12); }
  .dw-list div.disabled { opacity: 0.25; }
  .dw-hint { opacity: 0.7; padding: 4px; }
  .dw-selected-label { padding-top: 8px; }
  .dw-selected { height: 43px; display: flex; align-items: center; justify-content: center; background: rgba(255, 255, 255, 0.06); font-weight: bold; }
  .dw-filter { display: flex; justify-content: flex-end; }
  .dw-filter input { width: 120px; }
  .dw-cost { white-space: pre-wrap; padding: 4px; }
  .dw-sides { height: 80px; display: flex; justify-content: center; align-items: center; gap: 30px; text-align: center; }
  .dw-a { color: #e06666; }
  .dw-b { color: #6aa8e0; }
  .dw-vs { opacity: 0.3; font-size: 24px; }
  .dw-summary { background: rgba(255, 255, 255, 0.04); padding: 6px; }
  .dw-summary div { display: flex; justify-content: space-between; padding: 6px 6px 0; }
  .dw-gap { height: 6px; }
  .dw-buttons { display: flex; justify-content: space-between; padding: 16px 8px 8px; }
</style>
