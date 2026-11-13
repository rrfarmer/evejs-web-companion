<script lang="ts">
  // Alliances/all_ui_systems.FormAlliancesSystems (Corporation > Alliances > Sovereignty > Systems, in an alliance): the
  // top - the capital icon, AllianceCapital, SelectCapitalSystemDescription; the current capital's trace (the system,
  // its security, < constellation < region) with CurrentCapital and the star on the right, or NoCapital; a pending
  // capital's trace with CapitalChangeTime {time: until it applies} and, for a director of the executor corporation,
  // the cancel (CustomQuestion CancelPendingCapital / CancelPendingCapitalDetails, CancelCapitalSystemTransition).
  // Then the ClaimedSystemsDashboard (no Refresh; the search, claimedSystemsDashboard_searchString): the systems where
  // the alliance has a TCU, columns System, Constellation, Region, Jumps, DefenseMultiplierBonus (1 /
  // GetOccupancyMultiplier), StrategicIndex, MilitaryIndex, IndustryIndex (the index bars), and on the right the capital
  // star - CurrentCapital, or SetAsCapital (CustomQuestion SetNewCapital / SetNewCapitalDetails, SetCapitalSystem);
  // ClaimedListNoSystems when empty. A capital matches "current capital" in the search.
  // Not here: Show In Map, the multiplier icon's tooltip, the rows' celestial menus.
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, AllianceSystems, ClaimedSystemRow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const S = "UI/Sovereignty/";
  const HEADERS = ["UI/Common/LocationTypes/System", "UI/Common/LocationTypes/Constellation", "UI/Common/LocationTypes/Region", "UI/Common/Jumps", S + "DefenseMultiplierBonus",
    S + "StrategicIndex", S + "MilitaryIndex", S + "IndustryIndex"];
  const LABELS = [...HEADERS, S + "AllianceCapital", S + "SelectCapitalSystemDescription", S + "NoCapital", S + "CurrentCapital", S + "CapitalChangeTime", "UI/Common/Buttons/Cancel",
    S + "CancelPendingCapital", S + "CancelPendingCapitalDetails", S + "SetNewCapital", S + "SetNewCapitalDetails", S + "SetAsCapital", S + "ClaimedListNoSystems",
    S + "DefenseMultiplierDisplayNumber", "UI/Common/Buttons/Search"];
  const nameAny = (k: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, k, id, "");
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: nameAny }));
  const allianceID = $derived($station.online?.allianceID ?? null);
  let read = $state<AllianceSystems | null>(null), loading = $state(true), busy = $state(false), now = $state(Date.now());
  async function load(): Promise<void> { loading = true; try { read = await flow.allianceSystems(); } finally { loading = false; } }
  onMount(() => { flow.requestWords(LABELS); void load(); const t = setInterval(() => { now = Date.now(); }, 1000); return () => clearInterval(t); });
  $effect(() => { if (allianceID) flow.requestNames([{ kind: "owner", id: allianceID }]); });
  // infoPanelSvc.GetSolarSystemTrace: the system and its security, then < constellation < region.
  const trace = (id: number) => { const p = read?.places[id]; return p ? `${p.name} ${p.security === null ? "" : p.security.toFixed(1)} < ${p.constellationName} < ${p.regionName}` : String(id); };
  // A [timeinterval] token's value: the interval in FILETIME units.
  const interval = (ms: number) => ({ type: "long", value: (BigInt(Math.max(0, Math.round(ms))) * 10000n).toString() });
  async function ask(header: string, question: string): Promise<boolean> {
    return flow.askClientDialogWith("CustomQuestion", { header: word(header), question: word(question) }, word(question) || "Are you sure?");
  }
  async function setCapital(s: ClaimedSystemRow): Promise<void> {
    if (s.isCapital || busy || !(await ask(S + "SetNewCapital", S + "SetNewCapitalDetails"))) return;
    busy = true;
    try { if (await flow.allianceCapital("set", s.solarSystemID)) await load(); } finally { busy = false; }
  }
  async function cancelCapital(): Promise<void> {
    if (busy || !(await ask(S + "CancelPendingCapital", S + "CancelPendingCapitalDetails"))) return;
    busy = true;
    try { if (await flow.allianceCapital("cancel")) await load(); } finally { busy = false; }
  }
  let search = $state((() => { try { return localStorage.getItem("evejs.play.claimedSystemsDashboard_searchString") ?? ""; } catch { return ""; } })());
  function setSearch(v: string): void { search = v; try { localStorage.setItem("evejs.play.claimedSystemsDashboard_searchString", v); } catch { /* the session keeps it */ } }
  let sortBy = $state(0), ascending = $state(true);
  const rows = $derived.by(() => {
    const all = (read?.systems ?? []).map((s) => ({ s, sort: [s.systemName.toLowerCase(), s.constellationName.toLowerCase(), s.regionName.toLowerCase(), s.jumps ?? 1e9, s.multiplier, s.strategic, s.military, s.industrial] as const,
      text: `${s.systemName} ${s.constellationName} ${s.regionName}`.toLowerCase() + (s.isCapital ? ` ${word(S + "CurrentCapital").toLowerCase()}` : "") }));
    const q = search.toLowerCase();
    return (q ? all.filter((r) => r.text.includes(q)) : all).sort((a, b) => { const x = a.sort[sortBy]!, y = b.sort[sortBy]!; const c = x < y ? -1 : x > y ? 1 : 0; return ascending ? c : -c; });
  });
  const star = clientTexture("res:/ui/Texture/classes/Sov/CapitalStarSelection20.png");
  const select = clientTexture("res:/UI/Texture/classes/Sov/selectCapitalButton20.png");
</script>

<div class="sy">
  <div class="sy-top">
    <img src={clientTexture("res:/ui/Texture/classes/Sov/capitalSystem.png")} alt="" width="32" height="32" />
    <div><div class="sy-large">{word(S + "AllianceCapital")}</div><small class="sy-dim">{word(S + "SelectCapitalSystemDescription")}</small></div>
  </div>
  {#if read}
    <div class="sy-line"><span>{read.capital?.current ? trace(read.capital.current) : word(S + "NoCapital")}</span>
      {#if read.capital?.current}<span class="sy-right">{word(S + "CurrentCapital")} <img src={clientTexture("res:/ui/Texture/classes/Sov/CapitalStarSelection.png")} alt="" width="16" height="16" /></span>{/if}</div>
    {#if read.capital?.next}
      <div class="sy-line"><span>{trace(read.capital.next)}</span>
        <span class="sy-right">{word(S + "CapitalChangeTime", { time: interval((read.capital.nextValidAfterMs ?? now) - now) })}
          {#if read.isExecDirector}<button class="sy-x" title={word("UI/Common/Buttons/Cancel")} disabled={busy} onclick={() => void cancelCapital()}>✕</button>{/if}</span></div>
    {/if}
  {/if}
  <div class="sy-bar"><span class="sy-gap"></span><input type="search" placeholder={word("UI/Common/Buttons/Search")} value={search} oninput={(e) => setSearch(e.currentTarget.value)} maxlength="64" /></div>
  <div class="sy-table">
    <div class="sy-row sy-head">{#each HEADERS as h, i (h)}<button onclick={() => { if (sortBy === i) ascending = !ascending; else { sortBy = i; ascending = true; } }}>{word(h)}{sortBy === i ? (ascending ? " ▲" : " ▼") : ""}</button>{/each}<span></span></div>
    {#if loading && !read}<p class="sy-hint">…</p>
    {:else}
      {#each rows as r (r.s.solarSystemID)}
        <div class="sy-row">
          <span>{r.s.systemName}{#if r.s.security !== null} <small class="sy-dim">{r.s.security.toFixed(1)}</small>{/if}</span><span>{r.s.constellationName}</span><span>{r.s.regionName}</span><span>{r.s.jumps ?? "-"}</span>
          <span>{word(S + "DefenseMultiplierDisplayNumber", { bonusMultiplier: r.s.multiplier.toFixed(1) }) || `${r.s.multiplier.toFixed(1)}x`}</span>
          {#each [r.s.strategic, r.s.military, r.s.industrial] as level, i (i)}<span class="sy-bars" title={String(level)}>{#each [1, 2, 3, 4, 5] as b (b)}<i class:on={b <= level}></i>{/each}</span>{/each}
          <button class="sy-star" title={word(r.s.isCapital ? S + "CurrentCapital" : S + "SetAsCapital")} disabled={busy} onclick={() => void setCapital(r.s)}><img src={r.s.isCapital ? star : select} alt="" width="20" height="20" /></button>
        </div>
      {:else}<p class="sy-hint">{word(S + "ClaimedListNoSystems", { allianceName: nameAny("owner", allianceID ?? 0) })}</p>{/each}
    {/if}
  </div>
</div>

<style>
  .sy { display: flex; flex-direction: column; height: 100%; padding: 4px 4px 8px; box-sizing: border-box; }
  .sy-top { height: 42px; display: flex; align-items: center; gap: 6px; padding-left: 4px; flex: none; }
  .sy-large { font-size: 15px; }
  .sy-dim { opacity: 0.65; }
  .sy-line { height: 24px; display: flex; align-items: center; justify-content: space-between; padding: 0 4px; flex: none; }
  .sy-line:first-of-type { margin-top: 8px; }
  .sy-right { display: flex; align-items: center; gap: 6px; }
  .sy-x { all: unset; cursor: pointer; opacity: 0.8; }
  .sy-bar { display: flex; margin-top: 8px; flex: none; }
  .sy-bar input { width: 120px; }
  .sy-gap { flex: 1; }
  .sy-table { flex: 1; min-height: 0; overflow: auto; margin-top: 8px; }
  .sy-row { display: grid; grid-template-columns: 1fr 1fr 1fr 60px 100px 110px 110px 110px 54px; gap: 6px; min-height: 46px; align-items: center; padding: 0 4px; border-bottom: 1px solid rgba(255, 255, 255, 0.05); }
  .sy-head { min-height: 22px; font-size: 11px; }
  .sy-head button { all: unset; cursor: pointer; opacity: 0.7; }
  .sy-bars { display: flex; gap: 2px; }
  .sy-bars i { width: 12px; height: 8px; background: rgba(255, 255, 255, 0.12); }
  .sy-bars i.on { background: #58a6dc; }
  .sy-star { all: unset; cursor: pointer; justify-self: end; }
  .sy-hint { text-align: center; opacity: 0.65; }
</style>
