<script lang="ts">
  // recruitment/corpRecruitmentContainer.py CorpRecruitmentContainerSearch (Find New Corporation): the options at the
  // right, 240 wide - Search for Corporation (a corporation's name, Return to search: its ads alone, the options
  // dimmed), the play-style menu (PVE / PVP / Trade, each a group of types) with New Pilot Friendly, New Pilot
  // Focused and Roleplaying, Area of Operations, Primary Language (each a menu of the group's types, "N filters
  // selected" or "No filters selected"), Playtime (the hours, wrapping past midnight; "Local time" under it), the
  // Corporation Size range (0, 10, 50, 100, 200, 500, 1000, infinity), Max ISK / LP Tax Rate, and the Exclude
  // checkboxes (friendly fire, in an alliance, more SP than I have) - and the results at the left: corpRecProxy.
  // SearchCorpAds with them (GetSearchResults), each change searching again, NoAdsFound where none. The first visit's
  // defaults as ConstructLayout sets them: Exploration, Mission Running and New Pilot Friendly; the area of the
  // pilot's own space; the session's language (English); the playtime three hours either side of now (UTC).
  // (The results here are a plain list - the RecruitmentEntry with its details is the next unit.)
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { RecruitmentData } from "../app/api.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { showInfo } from "./showInfo.ts";
  import {
    buildHourMask, typesMask, CORP_SIZES, PLAYSTYLE_GROUPS, AREA_OF_OPERATIONS_GROUPID, LANGUAGE_GROUPID, PLAYSTYLE_GROUPID,
    NEWPILOTFRIENDLY_TYPEID, NEWPILOTFOCUSED_TYPEID, ROLEPLAY_TYPEID, EXPLORATION_TYPEID, MISSIONRUNNING_TYPEID,
    HIGHSEC_TYPEID, LOWSEC_TYPEID, NULLSEC_TYPEID, WORMHOLESPACE_TYPEID, ENGLISH_TYPEID, type RecruitmentAd,
  } from "../bridge/corpRecruitment.ts";
  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const skills = store.skills;
  const R = "UI/Corporations/CorporationWindow/Recruitment/";
  const LABELS = ["SearchForCorporation", "TypeHere", "NewPilotFriendly", "NewPilotFocused", "RoleplayingFocused2", "Playtime", "CorporationSize",
    "ExcludeHeader", "ExcludeFriendlyFire", "AllianceCheckboxText", "MinimumSPCheckboxText", "MaxISKTaxRate", "MaxLPTaxRate", "NoAdsFound",
    "NumFiltersSelected", "NoFiltersSelected", "LocalTime", "AdNotFoundForCorp", "PVE", "PVP", "Trade", "MatchHint"].map((k) => R + k);
  const word = (label: string, fallback: string) => plainText($words.templates[label] ?? fallback);
  const fill = (label: string, fallback: string, values: Record<string, string | number>) =>
    plainText(formatTemplate($words.templates[label] ?? fallback, values, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") }));

  // settings.char.ui as the client keeps them (one record for the pilot here)
  interface Saved {
    filterStates: Record<string, boolean>; languages: Record<string, boolean>; friendly: boolean; focused: boolean; roleplay: boolean;
    from: number; to: number; minMembers: number; maxMembers: number; maxIsk: number; maxLp: number;
    excludeFriendlyFire: boolean; excludeAlliances: boolean; excludeNotEnoughSP: boolean;
  }
  const KEY = `evejs.play.corpRecruitment.${$station.online?.characterID ?? 0}`;
  function load(): Saved | null { try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) as Saved : null; } catch { return null; } }
  let saved = $state<Saved | null>(null);
  $effect(() => { if (saved) try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* not kept */ } });

  let data = $state<RecruitmentData | null>(null);
  let ads = $state<readonly RecruitmentAd[] | null>(null);
  let error = $state("");
  let open = $state<"playStyle" | "area" | "language" | null>(null);
  let searchText = $state(""), searchedCorp = $state<number | null>(null), found = $state<readonly { id: number; name: string }[] | null>(null);
  const typesOf = (groupID: number): number[] => data ? Object.entries(data.types).filter(([, t]) => t.groupID === groupID).map(([id]) => Number(id)).sort((a, b) => a - b) : [];
  const typeName = (id: number) => { const n = data?.types[String(id)]?.nameID; return n ? word(`#${n}`, String(id)) : String(id); };
  const groupName = (id: number) => { const n = data?.groups[String(id)]?.nameID; return n ? word(`#${n}`, String(id)) : String(id); };

  function defaults(): Saved {
    // ConstructLayout's first-visit defaults
    const sec = (() => { const sys = $station.online?.solarSystemID; return (sys ? $names.systemSecurity[sys] : undefined) ?? $station.station?.security ?? 1; })();
    const region = ($station.online as { regionID?: number | null } | null)?.regionID ?? 0;
    const area = sec <= 0 ? (region >= 11000000 && region < 12000000 ? WORMHOLESPACE_TYPEID : NULLSEC_TYPEID) : sec < 0.45 ? LOWSEC_TYPEID : HIGHSEC_TYPEID;
    const hour = new Date().getUTCHours();
    return {
      filterStates: { [EXPLORATION_TYPEID]: true, [MISSIONRUNNING_TYPEID]: true, [NEWPILOTFRIENDLY_TYPEID]: true, [area]: true },
      languages: { [ENGLISH_TYPEID]: true }, friendly: false, focused: false, roleplay: false,
      from: (hour - 3 + 24) % 24, to: (hour + 3) % 24, minMembers: 0, maxMembers: 1000, maxIsk: 100, maxLp: 100,
      excludeFriendlyFire: false, excludeAlliances: false, excludeNotEnoughSP: false,
    };
  }

  let searching = 0;
  async function search(): Promise<void> {
    const s = saved;
    if (!s || !data || searchedCorp !== null) return;
    const n = ++searching;
    // GetSearchResults: the wanted play styles and areas (RemoveOldPlaystylesFromMask: only those groups' types)
    const valid = new Set([...typesOf(PLAYSTYLE_GROUPID), ...typesOf(AREA_OF_OPERATIONS_GROUPID)]);
    const want = Object.entries(s.filterStates).filter(([id, on]) => on && valid.has(Number(id))).map(([id]) => Number(id));
    const langs = Object.entries(s.languages).filter(([, on]) => on).map(([id]) => Number(id));
    const other = [...(s.friendly ? [NEWPILOTFRIENDLY_TYPEID] : []), ...(s.focused ? [NEWPILOTFOCUSED_TYPEID] : []), ...(s.roleplay ? [ROLEPLAY_TYPEID] : [])];
    try {
      const got = await flow.searchRecruitmentAds({
        typeMask: typesMask(want), langMask: typesMask(langs), excludeAlliances: s.excludeAlliances, excludeFriendlyFire: s.excludeFriendlyFire,
        spRestriction: s.excludeNotEnoughSP ? Math.trunc($skills.totalSkillPoints ?? 0) : null, minMembers: s.minMembers, maxMembers: s.maxMembers,
        maxISKTaxRate: s.maxIsk / 100, maxLPTaxRate: s.maxLp / 100, searchTimeMask: buildHourMask(s.from, s.to), otherMask: typesMask(other),
      });
      if (n === searching) { ads = [...got].sort((a, b) => (b.grade ?? -1) - (a.grade ?? -1) || (b.createDateTimeMs ?? 0) - (a.createDateTimeMs ?? 0)); error = ""; }
    } catch (e) { if (n === searching) { error = e instanceof Error ? e.message : String(e); ads = []; } }
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  // DelayedSearchAdverts: 800 ms after a change
  function later(ms = 800): void { if (timer) clearTimeout(timer); timer = setTimeout(() => void search(), ms); }
  function change(mutate: (s: Saved) => void, ms?: number): void { if (!saved) return; mutate(saved); saved = { ...saved }; later(ms); }

  async function searchByName(): Promise<void> {
    const text = searchText.trim();
    if (!text) { clearName(); return; }
    // searchOld.Search(text, groupCorporation, hideNPC=1, partial_terms)
    const got = await flow.searchOwners(text.toLowerCase(), [3], 0);
    const corps = (got.get(3) ?? []).filter((c) => !(c.id >= 1_000_000 && c.id < 2_000_000));
    if (corps.length === 1) await byCorp(corps[0]!); else found = corps;
  }
  async function byCorp(corp: { id: number; name: string }): Promise<void> {
    found = null; searchText = corp.name; searchedCorp = corp.id; ads = null;
    try { ads = await flow.recruitmentAdsOf(corp.id); } catch (e) { error = e instanceof Error ? e.message : String(e); ads = []; }
  }
  function clearName(): void { searchText = ""; searchedCorp = null; found = null; later(100); }

  function filterHint(typeIDs: readonly number[], states: Record<string, boolean>): string {
    const n = typeIDs.filter((id) => states[String(id)]).length;
    return n > 0 ? fill(R + "NumFiltersSelected", "{num} filters selected", { num: n }) : word(R + "NoFiltersSelected", "No filters selected");
  }
  function toggleGroup(typeIDs: readonly number[]): void {
    // ToggleSearchFilterStateOnGroup: all on turns them off, else all on
    change((s) => { const all = typeIDs.every((id) => s.filterStates[String(id)]); for (const id of typeIDs) s.filterStates[String(id)] = !all; });
  }
  const hh = (h: number) => `${String(h % 24 === 0 && h === 24 ? 24 : h % 24).padStart(2, "0")}:00`;
  const localHour = (utcHour: number) => (utcHour - new Date().getTimezoneOffset() / 60 + 48) % 24;

  onMount(() => {
    flow.requestWords(LABELS);
    void flow.recruitmentData().then((d) => {
      data = d;
      if (d) flow.requestWords([...Object.values(d.types).flatMap((t) => (t.nameID ? [`#${t.nameID}`] : [])), ...Object.values(d.groups).flatMap((g) => (g.nameID ? [`#${g.nameID}`] : []))]);
      saved = load() ?? defaults();
      void search();
    }).catch((e) => { error = e instanceof Error ? e.message : String(e); });
    return () => { if (timer) clearTimeout(timer); };
  });
  const playStyleTypes = $derived(typesOf(PLAYSTYLE_GROUPID));
</script>

<div class="corp-finder">
  <div class="cf-results">
    {#if error}<p class="error">{error}</p>{/if}
    {#if searchedCorp !== null && ads !== null && !ads.length}
      <p class="cf-note">{fill(R + "AdNotFoundForCorp", "{corpName} does not have any recruitment ads", { corpName: searchText })}</p>
      <!-- the corporation's own entry (User, showinfo), double click for its info -->
      <div class="cf-owner" role="button" tabindex="0" ondblclick={() => showInfo({ kind: "corporation", corporationID: searchedCorp! })}
        onkeydown={(e) => { if (e.key === "Enter") showInfo({ kind: "corporation", corporationID: searchedCorp! }); }}>{searchText}</div>
    {:else if ads !== null && !ads.length}
      <p class="cf-note">{word(R + "NoAdsFound", "No ads found")}</p>
    {/if}
    {#each ads ?? [] as ad (ad.adID)}
      <div class="cf-ad">
        <div class="cf-ad-head">
          <span class="cf-ad-title">{ad.title}</span>
          {#if ad.grade !== null}<span class="cf-grade" title={word(R + "MatchHint", "Match")}>{ad.grade}%</span>{/if}
        </div>
        <div class="cf-ad-corp">{resolvedName($names.resolved, "owner", ad.corporationID, "")}{#if ad.allianceID} · {resolvedName($names.resolved, "owner", ad.allianceID, "")}{/if} · {ad.memberCount}</div>
      </div>
    {/each}
  </div>
  <div class="cf-options">
    <div class="cf-header">{word(R + "SearchForCorporation", "Search for Corporation")}</div>
    <input class="cf-search" bind:value={searchText} maxlength="50" placeholder={word(R + "TypeHere", "Type here")}
      onkeydown={(e) => { if (e.key === "Enter") void searchByName(); }} oninput={() => { if (!searchText.trim()) clearName(); }} />
    {#if found}
      <div class="cf-found">{#each found as c (c.id)}<button type="button" onclick={() => void byCorp(c)}>{c.name}</button>{/each}</div>
    {/if}
    {#if saved && data}
      {@const s = saved}
      <fieldset class="cf-opts" disabled={searchedCorp !== null}>
        <div class="cf-header first">{groupName(PLAYSTYLE_GROUPID)}</div>
        <button type="button" class="cf-menu" aria-expanded={open === "playStyle"} title={playStyleTypes.filter((id) => s.filterStates[String(id)]).map(typeName).join(", ")}
          onclick={() => (open = open === "playStyle" ? null : "playStyle")}>{filterHint(playStyleTypes, s.filterStates)}</button>
        {#if open === "playStyle"}
          <div class="cf-menu-list">
            {#each PLAYSTYLE_GROUPS as g (g.label)}
              <label class="cf-menu-head"><input type="checkbox" checked={g.typeIDs.every((id) => s.filterStates[String(id)])} onchange={() => toggleGroup(g.typeIDs)} />{word(g.label, g.label.split("/").pop() ?? "")}</label>
              {#each g.typeIDs as id (id)}
                <label class="cf-menu-item"><input type="checkbox" checked={!!s.filterStates[String(id)]} onchange={() => change((x) => { x.filterStates[String(id)] = !x.filterStates[String(id)]; })} />{typeName(id)}</label>
              {/each}
            {/each}
          </div>
        {/if}
        <label class="cf-check"><input type="checkbox" checked={s.friendly} onchange={() => change((x) => { x.friendly = !x.friendly; })} />{word(R + "NewPilotFriendly", "New Pilot Friendly")}</label>
        <label class="cf-check"><input type="checkbox" checked={s.focused} onchange={() => change((x) => { x.focused = !x.focused; })} />{word(R + "NewPilotFocused", "New Pilot Focused")}</label>
        <label class="cf-check"><input type="checkbox" checked={s.roleplay} onchange={() => change((x) => { x.roleplay = !x.roleplay; })} />{word(R + "RoleplayingFocused2", "Roleplaying")}</label>
        {#each [{ key: "area", group: AREA_OF_OPERATIONS_GROUPID, langs: false }, { key: "language", group: LANGUAGE_GROUPID, langs: true }] as m (m.key)}
          {@const ids = typesOf(m.group)}
          {@const states = m.langs ? s.languages : s.filterStates}
          <div class="cf-header">{groupName(m.group)}</div>
          <button type="button" class="cf-menu" aria-expanded={open === m.key} title={ids.filter((id) => states[String(id)]).map(typeName).join(", ")}
            onclick={() => (open = open === m.key ? null : (m.key as "area" | "language"))}>{filterHint(ids, states)}</button>
          {#if open === m.key}
            <div class="cf-menu-list">
              {#each ids as id (id)}
                <label class="cf-menu-item"><input type="checkbox" checked={!!states[String(id)]}
                  onchange={() => change((x) => { const st = m.langs ? x.languages : x.filterStates; st[String(id)] = !st[String(id)]; })} />{typeName(id)}</label>
              {/each}
            </div>
          {/if}
        {/each}
        <div class="cf-header">{word(R + "Playtime", "Playtime")}</div>
        <div class="cf-range">
          <select aria-label="From" value={s.from} onchange={(e) => change((x) => { x.from = Number((e.currentTarget as HTMLSelectElement).value); }, 200)}>{#each Array.from({ length: 24 }, (_, i) => i) as h (h)}<option value={h}>{hh(h)}</option>{/each}</select>
          <span>–</span>
          <select aria-label="To" value={s.to} onchange={(e) => change((x) => { x.to = Number((e.currentTarget as HTMLSelectElement).value); }, 200)}>{#each Array.from({ length: 24 }, (_, i) => i + 1) as h (h)}<option value={h % 24 === 0 ? 24 : h}>{hh(h)}</option>{/each}</select>
        </div>
        <div class="cf-hint">{fill(R + "LocalTime", "Local time: {fromTime} - {toTime}", { fromTime: hh(localHour(s.from)), toTime: s.to === 24 ? "24:00" : hh(localHour(s.to)) })}</div>
        <div class="cf-header">{word(R + "CorporationSize", "Corporation Size")}</div>
        <div class="cf-range">
          <select aria-label="Min members" value={s.minMembers} onchange={(e) => change((x) => { x.minMembers = Number((e.currentTarget as HTMLSelectElement).value); }, 200)}>{#each CORP_SIZES.slice(0, -1) as n (n)}<option value={n}>{n}</option>{/each}</select>
          <span>–</span>
          <select aria-label="Max members" value={s.maxMembers} onchange={(e) => change((x) => { x.maxMembers = Number((e.currentTarget as HTMLSelectElement).value); }, 200)}>{#each CORP_SIZES.slice(1) as n (n)}<option value={n}>{n === 12600 ? "∞" : n}</option>{/each}</select>
        </div>
        <div class="cf-header">{word(R + "MaxISKTaxRate", "Max ISK Tax Rate")}</div>
        <input type="number" min="0" max="100" step="0.1" value={s.maxIsk} oninput={(e) => change((x) => { x.maxIsk = Math.min(100, Number((e.currentTarget as HTMLInputElement).value) || 0); }, 100)} />
        <div class="cf-header">{word(R + "MaxLPTaxRate", "Max LP Tax Rate")}</div>
        <input type="number" min="0" max="100" step="0.1" value={s.maxLp} oninput={(e) => change((x) => { x.maxLp = Math.min(100, Number((e.currentTarget as HTMLInputElement).value) || 0); }, 100)} />
        <div class="cf-header">{word(R + "ExcludeHeader", "Exclude")}</div>
        <label class="cf-check"><input type="checkbox" checked={s.excludeFriendlyFire} onchange={() => change((x) => { x.excludeFriendlyFire = !x.excludeFriendlyFire; })} />{word(R + "ExcludeFriendlyFire", "Friendly fire enabled")}</label>
        <label class="cf-check"><input type="checkbox" checked={s.excludeAlliances} onchange={() => change((x) => { x.excludeAlliances = !x.excludeAlliances; })} />{word(R + "AllianceCheckboxText", "In an alliance")}</label>
        <label class="cf-check"><input type="checkbox" checked={s.excludeNotEnoughSP} onchange={() => change((x) => { x.excludeNotEnoughSP = !x.excludeNotEnoughSP; })} />{word(R + "MinimumSPCheckboxText", "Requires more SP than I have")}</label>
      </fieldset>
    {/if}
  </div>
</div>

<style>
  .corp-finder { display: flex; gap: 8px; height: 100%; min-height: 0; }
  .cf-results { flex: 1; min-width: 0; overflow: auto; padding: 4px; }
  .cf-options { width: 240px; flex: none; overflow: auto; }
  .cf-opts { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; }
  .cf-opts:disabled { opacity: 0.3; }
  .cf-header { font-weight: bold; padding-top: 16px; }
  .cf-header.first { padding-top: 0; }
  .cf-search { width: 100%; box-sizing: border-box; margin-bottom: 16px; }
  .cf-menu { text-align: left; background: rgba(0, 0, 0, 0.35); border: 0; color: inherit; padding: 3px 6px; cursor: pointer; }
  .cf-menu-list { display: flex; flex-direction: column; padding: 4px; background: rgba(20, 22, 25, 0.95); border: 1px solid rgba(255, 255, 255, 0.12); }
  .cf-menu-head { font-weight: bold; margin-top: 4px; }
  .cf-menu-item { padding-left: 10px; }
  .cf-check { display: flex; gap: 6px; align-items: center; }
  .cf-check:first-of-type { padding-top: 4px; }
  .cf-range { display: flex; align-items: center; gap: 6px; }
  .cf-hint { font-size: 11px; padding: 4px 0 0 8px; opacity: 0.7; }
  .cf-found { display: flex; flex-direction: column; gap: 2px; margin: -12px 0 12px; }
  .cf-note { opacity: 0.7; }
  .cf-owner { padding: 6px 4px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); cursor: default; }
  .cf-ad { padding: 6px 4px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
  .cf-ad-head { display: flex; justify-content: space-between; }
  .cf-ad-title { font-weight: bold; }
  .cf-grade { font-size: 16px; }
  .cf-ad-corp { opacity: 0.7; font-size: 12px; }
</style>
