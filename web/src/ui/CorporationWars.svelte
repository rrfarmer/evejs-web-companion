<script lang="ts">
  // corporation/corp_ui_wars.py CorpWars (Wars > Ongoing Wars): a ToggleButtonGroup - Our Wars, All Wars (hint
  // UpdateDelay15Minutes) - over the two panes, Declare War at the bottom (disabled for a non-director with
  // DeclareWarNotAvailableCorp, in an alliance for one not its executor's director with ...Alliance). Our Wars:
  // get_scroll_entries(session.allianceid or corpid, myWars) - war.GetWars, newest war entries; none:
  // CorpOrAllianceNotInvolvedInWars. All Wars: the top row (Show cry for help - allwars_showcryforhelp, its hint
  // NotFilterWhenSearching; a 150-wide search, 32, and Search: CorporationOrAlliancePickerDailog, then that owner's
  // wars under a SearchResult header that clears), PopulateTop50 (warsInfoMgr.GetTop50 below the last war shown, or
  // GetWarsRequiringAssistance; newest first; a NumRecentWars header on the first page), Prev / Next (Next disabled
  // under WARS_PER_PAGE, Prev on the first page). (The war entries are plain lines here - the client's WarEntry is the
  // next unit; Declare War shown, not acting.)
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { CorpWar } from "../bridge/corpWars.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const C = "UI/Corporations/CorporationWindow/", W = "UI/Corporations/Wars/";
  const LABELS = [C + "Wars/OurWars", W + "AllWars", "UI/Corporations/Common/UpdateDelay15Minutes", C + "Alliances/Rankings/DeclareWar", W + "DeclareWarNotAvailableCorp",
    W + "DeclareWarNotAvailableAlliance", W + "ShowCryForHelp", W + "NotFilterWhenSearching", C + "Standings/Search", "UI/Common/Prev", "UI/Common/Next",
    W + "NumRecentWars", W + "SearchResult", C + "Wars/CorpOrAllianceNotInvolvedInWars"];
  const fill = (label: string, fallback: string, values: Record<string, unknown> = {}) =>
    plainText(formatTemplate($words.templates[label] ?? fallback, values as never, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") }));
  const nameOf = (id: number) => resolvedName($names.resolved, "owner", id, "") || resolvedName($names.resolved, id >= 99_000_000 ? "alliance" : "corporation", id, String(id));
  const online = $derived($station.online);
  const ownerID = $derived(online?.allianceID ?? online?.corporationID ?? 0);
  // DeclareWar's availability: a director; in an alliance, its executor corporation's (not read here: a director allowed)
  const director = $derived((BigInt(online?.corpRole ?? "0") & 1n) === 1n);
  const declareReason = $derived(director ? null : online?.allianceID ? W + "DeclareWarNotAvailableAlliance" : W + "DeclareWarNotAvailableCorp");
  let tab = $state<"our" | "all">("our"), error = $state("");
  let ours = $state<readonly CorpWar[] | null>(null);
  let batches = $state<(readonly CorpWar[])[]>([]), page = $state<readonly CorpWar[] | null>(null);
  const read = (k: string, d: boolean) => { try { const v = localStorage.getItem(`evejs.play.${k}`); return v === null ? d : v === "true"; } catch { return d; } };
  let cryForHelp = $state(read("allwars_showcryforhelp", false)), searchText = $state("");
  let searchOwner = $state<{ id: number; name: string } | null>(null), searchWars = $state<readonly CorpWar[] | null>(null), picks = $state<readonly { id: number; name: string }[] | null>(null);
  async function showOurs(): Promise<void> {
    try { ours = [...await flow.ownerWars(ownerID)].sort((a, b) => b.warID - a.warID); } catch (e) { error = e instanceof Error ? e.message : String(e); ours = []; }
  }
  // PopulateTop50(browse): -1 the batch before, 1 below the last war shown, none the newest
  async function top50(browse: -1 | 0 | 1 = 0): Promise<void> {
    try {
      if (cryForHelp) { page = await flow.recentWars(2147483647, true); batches = []; return; }
      if (browse === -1 && batches.length > 1) { batches = batches.slice(0, -1); page = batches[batches.length - 1]!; return; }
      if (browse === 1 && batches.length) {
        const last = batches[batches.length - 1]!;
        const got = await flow.recentWars(last[last.length - 1]!.warID, false);
        if (got.length) { batches = [...batches, got]; page = got; }
        return;
      }
      const got = await flow.recentWars(2147483647, false);
      batches = got.length ? [got] : []; page = got;
    } catch (e) { error = e instanceof Error ? e.message : String(e); page = []; }
  }
  async function search(): Promise<void> {
    const text = searchText.trim();
    if (!text) return;
    // CorporationOrAlliancePickerDailog: corporations and alliances by the name
    const got = await flow.searchOwners(text, [3, 4], 0);
    const found = [...(got.get(3) ?? []), ...(got.get(4) ?? [])];
    if (found.length === 1) await chooseOwner(found[0]!); else picks = found;
  }
  async function chooseOwner(o: { id: number; name: string }): Promise<void> {
    picks = null; searchOwner = o;
    try { searchWars = await flow.ownerWars(o.id); } catch (e) { error = e instanceof Error ? e.message : String(e); searchWars = []; }
  }
  function clearSearch(): void { searchText = ""; searchOwner = null; searchWars = null; void top50(); }
  onMount(() => { flow.requestWords(LABELS); void showOurs(); });
  $effect(() => { if (ownerID) flow.requestNames([{ kind: online?.allianceID ? "alliance" : "corporation", id: ownerID }]); });
  $effect(() => { if (tab === "all" && page === null && !searchOwner) void top50(); });
  const sorted = $derived(page ? [...page].sort((a, b) => b.warID - a.warID) : []);
  const line = (w: CorpWar) => `${nameOf(w.declaredByID)} — ${nameOf(w.againstID)}`;
</script>

<div class="corp-wars">
  <div class="cw-tabs" role="tablist">
    <button type="button" role="tab" aria-selected={tab === "our"} onclick={() => (tab = "our")}>{fill(C + "Wars/OurWars", "Our Wars")}</button>
    <button type="button" role="tab" aria-selected={tab === "all"} title={fill("UI/Corporations/Common/UpdateDelay15Minutes", "")} onclick={() => (tab = "all")}>{fill(W + "AllWars", "All Wars")}</button>
  </div>
  {#if error}<p class="error">{error}</p>{/if}
  {#if tab === "our"}
    <div class="cw-scroll">
      {#if ours !== null && !ours.length}<p class="cw-hint">{fill(C + "Wars/CorpOrAllianceNotInvolvedInWars", "{corpName} is not involved in any wars", { corpName: nameOf(ownerID) })}</p>{/if}
      {#each ours ?? [] as w (w.warID)}<div class="cw-war">{line(w)}</div>{/each}
    </div>
  {:else}
    <div class="cw-settings">
      <label class="cw-cry" title={fill(W + "NotFilterWhenSearching", "")}><input type="checkbox" checked={cryForHelp}
        onchange={() => { cryForHelp = !cryForHelp; try { localStorage.setItem("evejs.play.allwars_showcryforhelp", String(cryForHelp)); } catch { /* not kept */ } void top50(); }} />{fill(W + "ShowCryForHelp", "Show cry for help")}</label>
      <span class="cw-search"><input bind:value={searchText} maxlength="32" onkeydown={(e) => { if (e.key === "Enter") void search(); }} />
        <button type="button" onclick={() => void search()}>{fill(C + "Standings/Search", "Search")}</button></span>
    </div>
    {#if picks}
      <div class="cw-picks">{#each picks as o (o.id)}<button type="button" onclick={() => void chooseOwner(o)}>{o.name}</button>{/each}</div>
    {/if}
    <div class="cw-scroll">
      {#if searchOwner}
        <button type="button" class="cw-header cw-clear" onclick={clearSearch}>{fill(W + "SearchResult", "Search result: {searchResult}", { searchResult: searchText })} ×</button>
        {#if searchWars !== null && !searchWars.length}<p class="cw-hint">{fill(C + "Wars/CorpOrAllianceNotInvolvedInWars", "{corpName} is not involved in any wars", { corpName: searchOwner.name })}</p>{/if}
        {#each searchWars ?? [] as w (w.warID)}<div class="cw-war">{line(w)}</div>{/each}
      {:else}
        {#if sorted.length && batches.length <= 1}<div class="cw-header">{fill(W + "NumRecentWars", "{numWars} recent wars", { numWars: sorted.length })}</div>{/if}
        {#each sorted as w (w.warID)}<div class="cw-war">{line(w)}</div>{/each}
      {/if}
    </div>
    <div class="cw-browse">
      <button type="button" disabled={batches.length <= 1} onclick={() => void top50(-1)}>{fill("UI/Common/Prev", "Prev")}</button>
      <button type="button" disabled={(page?.length ?? 0) < 50} onclick={() => void top50(1)}>{fill("UI/Common/Next", "Next")}</button>
    </div>
  {/if}
  <div class="cw-declare">
    <button type="button" disabled title={declareReason ? fill(declareReason, "") : "Not on the play page yet"}>{fill(C + "Alliances/Rankings/DeclareWar", "Declare War")}</button>
  </div>
</div>

<style>
  .corp-wars { display: flex; flex-direction: column; height: 100%; min-height: 300px; }
  .cw-tabs { display: flex; gap: 2px; padding-bottom: 8px; }
  .cw-tabs button[aria-selected="true"] { font-weight: bold; }
  .cw-settings { display: flex; justify-content: space-between; align-items: center; padding: 2px 4px 0; }
  .cw-cry { display: flex; gap: 6px; align-items: center; }
  .cw-search { display: flex; gap: 4px; }
  .cw-search input { width: 150px; }
  .cw-picks { display: flex; flex-direction: column; gap: 2px; padding: 4px; }
  .cw-scroll { flex: 1; overflow: auto; padding-top: 4px; }
  .cw-hint { opacity: 0.7; padding: 4px; }
  .cw-header { display: block; width: 100%; text-align: left; font-weight: bold; padding: 2px 4px; background: rgba(255, 255, 255, 0.06); border: 0; color: inherit; }
  .cw-clear { cursor: pointer; }
  .cw-war { padding: 4px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
  .cw-browse { display: flex; justify-content: space-between; padding: 0 4px 4px; }
  .cw-declare { display: flex; justify-content: center; padding-top: 8px; }
  .error { color: #e06666; }
</style>
