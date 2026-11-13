<script lang="ts">
  // Alliances/all_ui_sovereignty.FormAlliancesSovereignty (Corporation > Alliances > Sovereignty > Sovereignty, in an
  // alliance): the top - DefaultVulnerabilityTimeLabel, then in highlight VulnerabilityTime {hour}, or
  // VulnerabilityTimeWithFutureChange {hour, newHour, validAfterDate} while a new hour is pending, or Unknown; for a
  // director of the executor corporation the menu on the right (SetSovereigntyHour, SetNewVulnerabilityTimeDescription,
  // the 24 hours as VulnerabilityTime, Set - asking updateNewPrimeTime where a change is pending - SetPrimeHour). Then
  // the SovDashboard: Refresh on the left, the search (120) on the right, the columns System, Constellation, Region,
  // Jumps, StructureBonus, Structure, Status, Timer (sorted by the header clicked), DashboardNoStructures when empty. A
  // row's status: GetStructureStatusString - a campaign before its start Reinforced (the start's countdown), after it
  // Contested (StatusOngoing); no window Invulnerable (Status/Unknown); before the window Invulnerable
  // (VulnerabilityWindow start-end), in it VulnerableNow (the end's countdown), after it Vulnerable (Overtime).
  // Not here: the bonus icon's tooltip, the rows' menus and the info links.
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, AllianceSovereignty, SovStructureRow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const S = "UI/Sovereignty/";
  const HEADERS = ["UI/Common/LocationTypes/System", "UI/Common/LocationTypes/Constellation", "UI/Common/LocationTypes/Region", "UI/Common/Jumps", S + "StructureBonus",
    "UI/Inflight/Scanner/Structure", "UI/Generic/Status", S + "Timer"];
  const LABELS = [...HEADERS, S + "DefaultVulnerabilityTimeLabel", S + "VulnerabilityTime", S + "VulnerabilityTimeWithFutureChange", "UI/Common/Unknown", S + "SetSovereigntyHour",
    S + "SetNewVulnerabilityTimeDescription", "UI/Common/CommandSet", "UI/Commands/Refresh", "UI/Common/Buttons/Search", S + "DashboardNoStructures", S + "TCU", S + "Sovhub",
    S + "DefenseMultiplierDisplayNumber", ...["VulnerableNowType", "VulnerableType", "ReinforcedType", "InvulnerableType", "ContestedType", "Overtime", "Unknown", "VulnerabilityWindow"].map((k) => S + "Status/" + k),
    S + "StatusOngoing"];
  const nameAny = (k: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, k, id, "");
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: nameAny }));
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const allianceID = $derived($station.online?.allianceID ?? null);
  $effect(() => { if (allianceID) flow.requestNames([{ kind: "owner", id: allianceID }]); });
  let read = $state<AllianceSovereignty | null>(null), loading = $state(true), menu = $state(false), hour = $state(0), now = $state(Date.now());
  async function load(): Promise<void> { loading = true; try { read = await flow.allianceSovereignty(); hour = read?.prime?.current ?? 0; } finally { loading = false; } }
  onMount(() => { flow.requestWords(LABELS); void load(); const t = setInterval(() => { now = Date.now(); }, 1000); return () => clearInterval(t); });
  const two = (n: number) => String(n).padStart(2, "0");
  // FmtDate 'ls' / 'ns' (UTC, EVE time) and FmtTime.
  const date = (ms: number) => { const d = new Date(ms); return `${d.getUTCFullYear()}.${two(d.getUTCMonth() + 1)}.${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`; };
  const clock = (ms: number) => { const d = new Date(ms); return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`; };
  const span = (ms: number) => { const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return [d ? `${d}d` : "", h ? `${h}h` : "", m ? `${m}m` : "", !d && !h ? `${x}s` : ""].filter(Boolean).join(" "); };
  // A [datetime] token's value: the FILETIME long.
  const filetime = (ms: number) => ({ type: "long", value: (BigInt(Math.round(ms)) * 10000n + 116444736000000000n).toString() });
  const countdown = (target: number) => (target > now ? `${span(target - now)} · ${date(target)}` : word(S + "Status/Overtime"));
  const primeText = $derived.by(() => {
    const p = read?.prime;
    if (!p || p.current === null) return word("UI/Common/Unknown");
    if (p.next !== null && p.nextValidAfterMs !== null && now < p.nextValidAfterMs) return word(S + "VulnerabilityTimeWithFutureChange", { hour: p.current, newHour: p.next, validAfterDate: filetime(p.nextValidAfterMs) });
    return word(S + "VulnerabilityTime", { hour: p.current });
  });
  async function setPrime(): Promise<void> {
    const p = read?.prime;
    if (p?.next && p.nextValidAfterMs) {
      // entosisConst.CHANGE_PRIMETIME_DELAY: 48 hours.
      const ok = await flow.askClientDialogWith("updateNewPrimeTime", { currentPendingTime: `${p.next}:00`, currentPendingDate: date(p.nextValidAfterMs), newPendingTime: `${hour}:00`, newPendingDate: date(Date.now() + 48 * 3600000) }, "Replace the pending change?");
      if (!ok) return;
    }
    if (await flow.setAlliancePrimeHour(hour)) { menu = false; await load(); }
  }
  // dashboardConst statuses.
  type Status = "vulnerable" | "overtime" | "reinforced" | "invulnerable" | "contested";
  function status(s: SovStructureRow): Status {
    if (s.campaign) return now < s.campaign.startMs ? "reinforced" : "contested";
    if (!s.vulnerability) return "invulnerable";
    return now < s.vulnerability.startMs ? "invulnerable" : now > s.vulnerability.endMs ? "overtime" : "vulnerable";
  }
  const typeLabel = (s: SovStructureRow) => word(s.typeID === 32226 ? S + "TCU" : S + "Sovhub");
  function statusText(s: SovStructureRow): [string, string] {
    const typeName = typeLabel(s);
    switch (status(s)) {
      case "vulnerable": return [word(S + "Status/VulnerableNowType", { typeName }), countdown(s.vulnerability!.endMs)];
      case "overtime": return [word(S + "Status/VulnerableType", { typeName }), word(S + "Status/Overtime")];
      case "reinforced": return [word(S + "Status/ReinforcedType", { typeName }), countdown(s.campaign!.startMs)];
      case "contested": return [word(S + "Status/ContestedType", { typeName }), word(S + "StatusOngoing")];
      default: return [word(S + "Status/InvulnerableType", { typeName }), s.vulnerability
        ? `${word(S + "Status/VulnerabilityWindow")} ${s.vulnerability.startMs - now > 86400000 ? date(s.vulnerability.startMs) : clock(s.vulnerability.startMs)}-${clock(s.vulnerability.endMs)}` : word(S + "Status/Unknown")];
    }
  }
  const COLORS: Record<Status, string> = { vulnerable: "", overtime: "", invulnerable: "", reinforced: "rgba(245, 145, 28, 0.27)", contested: "rgba(235, 36, 38, 0.27)" };
  let search = $state((() => { try { return localStorage.getItem("evejs.play.sovDashboard_searchString") ?? ""; } catch { return ""; } })());
  let sortBy = $state(0), ascending = $state(true);
  const rows = $derived.by(() => {
    const all = (read?.structures ?? []).map((s) => { const [st, timer] = statusText(s); return { s, st, timer, sort: [s.systemName.toLowerCase(), s.constellationName.toLowerCase(), s.regionName.toLowerCase(), s.jumps ?? 1e9, s.defenseMultiplier, s.typeID, st.toLowerCase(), timer] as const }; });
    const q = search.toLowerCase();
    const shown = q ? all.filter((r) => [r.sort[0], r.sort[1], r.sort[2], r.sort[6], r.timer.toLowerCase(), typeLabel(r.s).toLowerCase()].join(" ").includes(q)) : all;
    return shown.sort((a, b) => { const x = a.sort[sortBy]!, y = b.sort[sortBy]!; const c = x < y ? -1 : x > y ? 1 : 0; return ascending ? c : -c; });
  });
  function setSearch(v: string): void { search = v; try { localStorage.setItem("evejs.play.sovDashboard_searchString", v); } catch { /* the session keeps it */ } }
</script>

<div class="as">
  <div class="as-top">
    <div><div>{word(S + "DefaultVulnerabilityTimeLabel")}</div><div class="as-hi">{primeText}</div></div>
    {#if read?.canSetPrime}<button class="as-menu-btn" title={word(S + "SetSovereigntyHour")} onclick={() => { menu = !menu; }}>☰</button>{/if}
    {#if menu}
      <div class="as-menu">
        <b>{word(S + "SetSovereigntyHour")}</b>
        <p>{word(S + "SetNewVulnerabilityTimeDescription")}</p>
        <div class="as-menu-row"><select bind:value={hour}>{#each Array.from({ length: 24 }, (_, i) => i) as h (h)}<option value={h}>{word(S + "VulnerabilityTime", { hour: h })}</option>{/each}</select>
          <button onclick={() => void setPrime()}>{word("UI/Common/CommandSet")}</button></div>
      </div>
    {/if}
  </div>
  <div class="as-bar"><button onclick={() => void load()}>{word("UI/Commands/Refresh")}</button><span class="as-gap"></span>
    <input type="search" placeholder={word("UI/Common/Buttons/Search")} value={search} oninput={(e) => setSearch(e.currentTarget.value)} maxlength="64" /></div>
  <div class="as-table">
    <div class="as-row as-head">{#each HEADERS as h, i (h)}<button onclick={() => { if (sortBy === i) ascending = !ascending; else { sortBy = i; ascending = true; } }}>{word(h)}{sortBy === i ? (ascending ? " ▲" : " ▼") : ""}</button>{/each}</div>
    {#if loading && !read}<p class="as-hint">…</p>
    {:else}
      {#each rows as r (r.s.itemID)}
        {@const st = status(r.s)}
        <div class="as-row" style:background={COLORS[st]}>
          <span>{r.s.systemName}{#if r.s.security !== null} <small class="as-dim">{r.s.security.toFixed(1)}</small>{/if}</span><span>{r.s.constellationName}</span><span>{r.s.regionName}</span>
          <span>{r.s.jumps ?? "-"}</span><span>{word(S + "DefenseMultiplierDisplayNumber", { bonusMultiplier: r.s.defenseMultiplier.toFixed(1) }) || `x${r.s.defenseMultiplier.toFixed(1)}`}</span>
          <span>{typeLabel(r.s)}</span><span style:color={st === "reinforced" ? "#f5911c" : st === "contested" ? "#eb2426" : ""}>{r.st}</span><span class="as-dim">{r.timer}</span>
        </div>
      {:else}<p class="as-hint">{word(S + "DashboardNoStructures", { allianceName: nameAny("owner", allianceID ?? 0) })}</p>{/each}
    {/if}
  </div>
</div>

<style>
  .as { position: relative; display: flex; flex-direction: column; height: 100%; padding: 8px; box-sizing: border-box; }
  .as-top { position: relative; display: flex; justify-content: space-between; align-items: center; flex: none; }
  .as-hi { color: #58a6dc; }
  .as-menu-btn { all: unset; cursor: pointer; padding: 4px; }
  .as-menu { position: absolute; right: 0; top: 100%; z-index: 5; width: 270px; padding: 8px; background: #1b1d21; border: 1px solid rgba(255, 255, 255, 0.15); display: flex; flex-direction: column; gap: 6px; }
  .as-menu p { margin: 0; opacity: 0.8; }
  .as-menu-row { display: flex; gap: 6px; justify-content: space-between; padding-top: 10px; }
  .as-menu-row select { width: 150px; }
  .as-bar { display: flex; margin-top: 16px; flex: none; }
  .as-bar input { width: 120px; }
  .as-gap { flex: 1; }
  .as-table { flex: 1; min-height: 0; overflow: auto; margin-top: 8px; }
  .as-row { display: grid; grid-template-columns: 1fr 1fr 1fr 60px 100px 80px 1.5fr 1.1fr; gap: 6px; min-height: 46px; align-items: center; padding: 0 4px; border-bottom: 1px solid rgba(255, 255, 255, 0.05); }
  .as-head { min-height: 22px; font-size: 11px; }
  .as-head button { all: unset; cursor: pointer; opacity: 0.7; }
  .as-hint { text-align: center; opacity: 0.65; }
  .as-dim { opacity: 0.65; }
</style>
