<script lang="ts">
  // Alliances/sovHubs/sovHubPage.SovHubPage (Corporation > Alliances > Sovereignty > Sov Hubs, a station manager's):
  // SovereigntyHubs, the filters (the location combo - any distance, current system, within 2 / 5 / 10 jumps,
  // sovHubPageFilter_location; the quick filter on the system or region name, sovhub_page_text_filter), and the hubs of
  // the pilot's corporation that are also claims (GetMySovHubsAndSystems). Columns: ColumnSovHub (the system),
  // Jumps, Region, ColumnUpgrades (NumUpgradesOnlineShort: the online of the installed), ColumnPower (available +
  // produced / max + produced), ColumnWorkforce (available + produced / max + produced + imported), WorceforceMode
  // (the mode's icon, its label and the import sources or export destination as the hint), ColumnLavaFuel /
  // ColumnIceFuel (FuelDepleted where none or where pending startups need more; else by the configured-online upkeep:
  // over four weeks FuelFull, over one FuelLow, else FuelCritical; "-" without upkeep), Status (the vulnerability
  // state's word without a type) and ColumnVulnerabilityHour (the status timer). NotAvailable where a read failed;
  // NoSovHubs, or NoSovHubsFilteredOut where the filters hid some.
  // A row's expander opens ExpandedSovHubEntry: SovHubName {solarSystemName} and region > constellation > system;
  // Upgrades - the UpgradeGraph (the six upgrade type lists 829, 622, 830, 828, 620, 621 round a circle, from 180
  // degrees, a step of 60; the installed and the online count of each list over the largest, at least 0.1 of the
  // radius) and NumUpgradesOnline; Fuel - FuelMagmaCont / FuelIceCont (the time left - amount / burn per hour as
  // GetTimeLeftTextForTypeID words it, NumWeeksShort over two weeks - on a gauge of four weeks, the amount, AmountPerHour)
  // with the lava / ice state; Power and Workforce compact (allocated / total available, the max, the gauge); the
  // workforce transport (SectionWorkforceTransport: the configured mode, WorkforceTransport* words, the import sources
  // with their amounts); the corporation's skyhooks in the system.
  // EditStructure opens the Sov Hub window (SovHubWindow.svelte). Not here yet: the gauges' tooltips, sorting by the
  // loaded columns.
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, MySovHub, SovHubDetails, SovHubExtras } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import SovHubWindow from "./SovHubWindow.svelte";
  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const H = "UI/Sovereignty/HubPage/", S = "UI/Sovereignty/";
  const HEADERS = [H + "ColumnSovHub", "UI/Common/Jumps", "UI/Common/LocationTypes/Region", H + "ColumnUpgrades", H + "ColumnPower", H + "ColumnWorkforce",
    S + "SovHub/HubWnd/WorceforceMode", H + "ColumnLavaFuel", H + "ColumnIceFuel", "UI/Generic/Status", H + "ColumnVulnerabilityHour"];
  const MODES: Record<string, string> = { inactive: S + "SovHub/HubWnd/WorkforceIdle", import_settings: S + "SovHub/HubWnd/WorkforceImport", export_settings: S + "SovHub/HubWnd/WorkforceExport", transit: S + "SovHub/HubWnd/WorkforceTransit" };
  const LABELS = [...HEADERS, ...Object.values(MODES), H + "SovereigntyHubs", H + "NoSovHubs", H + "NoSovHubsFilteredOut", H + "NumUpgradesOnlineShort", H + "FuelDepleted", H + "FuelFull", H + "FuelLow",
    H + "FuelCritical", H + "NotAvailable", S + "SovHub/HubWnd/SovHubName", H + "EditStructure", H + "Upgrades", H + "Fuel", H + "NumUpgradesOnline", S + "Power", S + "Workforce",
    S + "SovHub/HubWnd/SectionWorkforceTransport", S + "AmountPerHour", S + "SovHub/HubWnd/NumWeeksShort", S + "SovHub/HubWnd/TimeUntilMagmaRunsOut", S + "SovHub/HubWnd/TimeUntilIceRunsOut",
    ...["Inactive", "Import", "Export", "ExportNoConnection", "ExportNotConfigured", "Transit"].map((k) => S + "SovHub/Upgrades/WorkforceTransport" + k),
    S + "SovHub/HubWnd/SourceSystemNotConnected", S + "SovHub/HubWnd/SourceSystemNotSendingWorkforce", S + "SovHub/UnknownWorkforceMode", "UI/Agency/ContentOfAnyDistance", "UI/Generic/CurrentSystem", "UI/Common/WithinJumps",
    ...["VulnerableNowType", "VulnerableType", "ReinforcedType", "InvulnerableType", "ContestedType", "Overtime", "Unknown", "VulnerabilityWindow"].map((k) => S + "Status/" + k), S + "StatusOngoing"];
  const nameAny = (k: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, k, id, "");
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: nameAny }));
  const read = (key: string, fallback: string) => { try { return localStorage.getItem(`evejs.play.${key}`) ?? fallback; } catch { return fallback; } };
  const keep = (key: string, value: string) => { try { localStorage.setItem(`evejs.play.${key}`, value); } catch { /* the session keeps it */ } };
  let hubs = $state<readonly MySovHub[] | null>(null), loading = $state(true), details = $state<Record<number, SovHubDetails>>({}), now = $state(Date.now());
  let hubWindow = $state<MySovHub | null>(null);
  // After a save or a removal: the hub's details and extras read again (the window's simulation restarts from them).
  async function reloadHub(h: MySovHub): Promise<void> {
    const d = await flow.sovHubDetails(h.hubID, h.solarSystemID);
    details = { ...details, [h.hubID]: d };
    const x = await flow.sovHubExtras(h.hubID, h.solarSystemID, (d.upgrades ?? []).map((u) => u.typeID));
    extras = { ...extras, [h.hubID]: x };
  }
  let open = $state<Record<number, boolean>>({}), extras = $state<Record<number, SovHubExtras>>({});
  function toggle(h: MySovHub): void {
    open = { ...open, [h.hubID]: !open[h.hubID] };
    if (open[h.hubID] && !extras[h.hubID]) {
      const types = (details[h.hubID]?.upgrades ?? []).map((u) => u.typeID);
      void flow.sovHubExtras(h.hubID, h.solarSystemID, types).then((x) => { extras = { ...extras, [h.hubID]: x }; }, () => {});
    }
  }
  onMount(() => { flow.requestNames([{ kind: "type", id: 81080 }]); });
  // UpgradeGraph: GetAllUpgradeTypeLists' order and their icons (texturePathByTypeList).
  const LISTS: readonly [number, string][] = [[829, "☷"], [622, "✸"], [830, "⇄"], [828, "◈"], [620, "▣"], [621, "⛏"]];
  function graph(d: SovHubDetails | undefined, x: SovHubExtras | undefined): { total: string; online: string; icons: { x: number; y: number; icon: string; listID: number }[] } | null {
    if (!d?.upgrades || !x) return null;
    const total = new Map(LISTS.map(([id]) => [id, 0])), online = new Map(LISTS.map(([id]) => [id, 0]));
    for (const u of d.upgrades) {
      const list = LISTS.find(([id]) => (x.listsByType[u.typeID] ?? []).includes(id))?.[0];
      if (list === undefined) continue;
      total.set(list, total.get(list)! + 1);
      if (u.powerState === "POWER_STATE_ONLINE") online.set(list, online.get(list)! + 1);
    }
    const most = Math.max(...total.values()), r = 55, max = r - 3, iconAt = r + 12;
    const pts = (m: Map<number, number>) => LISTS.map(([id], i) => { const a = ((180 + 60 * (i + 1)) * Math.PI) / 180, v = Math.max(0.1, m.get(id)! / most) * max; return `${80 + v * Math.sin(a)},${80 + v * Math.cos(a)}`; }).join(" ");
    return { total: most ? pts(total) : "", online: most ? pts(online) : "",
      icons: LISTS.map(([listID, icon], i) => { const a = ((180 + 60 * (i + 1)) * Math.PI) / 180; return { x: 80 + iconAt * Math.sin(a), y: 80 + iconAt * Math.cos(a), icon, listID }; }) };
  }
  // hubUtil.GetTimeLeftTextForTypeID: over two weeks NumWeeksShort, else the days, the hours, or hours and minutes.
  function timeLeft(d: SovHubDetails | undefined, typeID: number): { text: string; progress: number } {
    const f = d?.fuel?.[typeID];
    if (!f || !f.perHour) return { text: "-", progress: 0 };
    const hours = f.amount / f.perHour;
    const text = hours > 336 ? word(S + "SovHub/HubWnd/NumWeeksShort", { numWeeks: Math.floor(hours / 168) })
      : hours > 168 ? `${Math.floor(hours / 24)}d` : hours > 24 ? `${Math.floor(hours)}h` : `${Math.floor(hours)}h ${Math.floor((hours % 1) * 60)}m`;
    return { text, progress: Math.min(1, hours / 672) };
  }
  function resources(h: MySovHub, d: SovHubDetails | undefined): { power: [string, string, string, number, number]; workforce: [string, string, string, number, number, number] } | null {
    if (!d) return null;
    const pp = produced(d, "powerProduced"), wp = produced(d, "workforceProduced");
    const imported = d.workforce?.mode === "import_settings" ? d.workforce.imports.reduce((n, [, a]) => n + a, 0) : 0;
    const exported = d.workforce?.mode === "export_settings" ? d.workforce.exportAmount : 0;
    const pMax = d.maxPower + pp, pAvail = (d.resources?.powerAvailable ?? 0) + pp, wMax = d.maxWorkforce + wp + imported, wAvail = (d.resources?.workforceAvailable ?? 0) + wp;
    const n = (v: number) => v.toLocaleString("en-US");
    return {
      power: [d.resources ? n(d.resources.powerAllocated) : na(), n(pAvail), n(pMax), pMax ? (d.resources?.powerAllocated ?? 0) / pMax : 0, pMax ? pAvail / pMax : 0],
      workforce: [d.resources ? n(d.resources.workforceAllocated) : na(), n(wAvail), n(wMax), wMax ? (d.resources?.workforceAllocated ?? 0) / wMax : 0, wMax ? wAvail / wMax : 0, wMax ? (wAvail + exported) / wMax : 0],
    };
  }
  // WorkforceController.GetWorkforceTransportDesc and GetWorkforceImportSystems.
  function transport(d: SovHubDetails | undefined, x: SovHubExtras | undefined): { mode: string; desc: string; sources: { name: string; amount: number | null }[] } | null {
    if (!x) return null;
    const c = x.configuration, w = d?.workforce;
    if (!c) return { mode: na(), desc: "", sources: [] };
    const mode = c.mode ? word(MODES[c.mode] ?? "") : word(S + "SovHub/UnknownWorkforceMode");
    if (!w) return { mode, desc: "", sources: [] };
    const T = S + "SovHub/Upgrades/WorkforceTransport";
    const sysName = (id: number) => nameAny("system", id) || String(id);
    if (c.mode === "inactive") return { mode, desc: word(T + "Inactive"), sources: [] };
    if (c.mode === "import_settings") {
      const got = new Map(w.imports);
      return { mode, desc: word(T + "Import", { amount: w.imports.reduce((n, [, a]) => n + a, 0), solarSystemNames: "" }),
        sources: [...w.imports.map(([id, a]) => ({ name: sysName(id), amount: a })), ...c.sources.filter((id) => !got.has(id)).map((id) => ({ name: sysName(id), amount: null }))] };
    }
    if (c.mode === "export_settings") {
      if (w.exportTo) return { mode, desc: word(T + "Export", { amount: w.exportAmount, solarSystemName: sysName(w.exportTo) }), sources: [] };
      if (c.exportTo) return { mode, desc: word(T + "ExportNoConnection", { amount: c.exportAmount, solarSystemName: sysName(c.exportTo) }), sources: [] };
      return { mode, desc: word(T + "ExportNotConfigured", { amount: w.exportAmount }), sources: [] };
    }
    if (c.mode === "transit") return { mode, desc: word(T + "Transit"), sources: [] };
    return { mode, desc: "", sources: [] };
  }
  let location = $state(read("sovHubPageFilter_location", "")), filterText = $state(read("sovhub_page_text_filter", ""));
  async function load(): Promise<void> {
    loading = true;
    try {
      hubs = await flow.mySovHubs();
      for (const h of hubs ?? []) void flow.sovHubDetails(h.hubID, h.solarSystemID).then((d) => { details = { ...details, [h.hubID]: d }; }, () => {});
    } finally { loading = false; }
  }
  onMount(() => { flow.requestWords(LABELS); void load(); const t = setInterval(() => { now = Date.now(); }, 1000); return () => clearInterval(t); });
  const here = $derived($station.online?.solarSystemID ?? null);
  // IsFilteredOutByLocation / IsFilteredByName.
  const shown = $derived((hubs ?? []).filter((h) => {
    if (location === "1" && h.solarSystemID !== here) return false;
    if (location && location !== "1" && (h.jumps ?? Infinity) > Number(location)) return false;
    const q = filterText.trim().toLowerCase();
    return !q || h.systemName.toLowerCase().includes(q) || h.regionName.toLowerCase().includes(q);
  }).sort((a, b) => a.systemName.localeCompare(b.systemName)));
  const na = () => word(H + "NotAvailable", { color: "" }) || "N/A";
  const produced = (d: SovHubDetails, key: "powerProduced" | "workforceProduced") => (d.upgrades ?? []).filter((u) => u.powerState === "POWER_STATE_ONLINE" && u[key] > 0).reduce((n, u) => n + u[key], 0);
  function upgradesText(d: SovHubDetails | undefined): string {
    if (!d) return "…";
    if (!d.upgrades) return na();
    return word(H + "NumUpgradesOnlineShort", { online: d.upgrades.filter((u) => u.powerState === "POWER_STATE_ONLINE").length, installed: d.upgrades.length });
  }
  function powerText(d: SovHubDetails | undefined): string {
    if (!d) return "…";
    if (!d.resources || !d.upgrades) return na();
    const p = produced(d, "powerProduced");
    return `${d.resources.powerAvailable + p}/${d.maxPower + p}`;
  }
  function workforceText(d: SovHubDetails | undefined): string {
    if (!d) return "…";
    if (!d.upgrades) return na();
    const p = produced(d, "workforceProduced"), imported = d.workforce?.mode === "import_settings" ? d.workforce.imports.reduce((n, [, a]) => n + a, 0) : 0;
    return `${(d.resources?.workforceAvailable ?? 0) + p}/${d.maxWorkforce + p + imported}`;
  }
  function transit(d: SovHubDetails | undefined): { icon: string; hint: string } | null {
    if (!d?.workforce) return null;
    const w = d.workforce, lines = [word(MODES[w.mode ?? ""] ?? "")];
    if (w.mode === "import_settings") for (const [id, amount] of w.imports) lines.push(` - ${nameAny("system", id) || id} (${amount})`);
    if (w.mode === "export_settings") lines.push(` - ${w.exportTo ? nameAny("system", w.exportTo) || w.exportTo : na()} (${w.exportAmount})`);
    // hubUtil.GetTexturePathForWorkforceMode: transit, import, export, else the workforce icon.
    return { icon: w.mode === "transit" ? "→" : w.mode === "import_settings" ? "↓" : w.mode === "export_settings" ? "↑" : "⚇", hint: lines.join("\n") };
  }
  // GetTimeLeftTextForAllConfiguredOnline.
  function fuelText(d: SovHubDetails | undefined, typeID: number): string {
    if (!d) return "…";
    if (!d.fuel || !d.upgrades) return na();
    const f = d.fuel[typeID];
    if (!f) return word(H + "FuelDepleted");
    const startup = d.upgrades.filter((u) => u.fuelTypeID === typeID && u.powerState === "POWER_STATE_PENDING").reduce((n, u) => n + u.startupCost, 0);
    if (startup > f.amount) return word(H + "FuelDepleted");
    const perHour = d.upgrades.filter((u) => u.powerState !== "POWER_STATE_OFFLINE" && u.fuelTypeID === typeID).reduce((n, u) => n + u.fuelPerHour, 0);
    if (!perHour) return "-";
    const hours = f.amount / perHour;
    return word(hours > 672 ? H + "FuelFull" : hours > 168 ? H + "FuelLow" : H + "FuelCritical");
  }
  type Status = "vulnerable" | "overtime" | "reinforced" | "invulnerable" | "contested";
  const status = (h: MySovHub): Status => (h.campaign ? (now < h.campaign.startMs ? "reinforced" : "contested") : !h.vulnerability ? "invulnerable" : now < h.vulnerability.startMs ? "invulnerable" : now > h.vulnerability.endMs ? "overtime" : "vulnerable");
  const STATUS_LABELS: Record<Status, string> = { vulnerable: "VulnerableNowType", overtime: "VulnerableType", reinforced: "ReinforcedType", invulnerable: "InvulnerableType", contested: "ContestedType" };
  const two = (n: number) => String(n).padStart(2, "0");
  const date = (ms: number) => { const d = new Date(ms); return `${d.getUTCFullYear()}.${two(d.getUTCMonth() + 1)}.${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`; };
  const clock = (ms: number) => { const d = new Date(ms); return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`; };
  const span = (ms: number) => { const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return [d ? `${d}d` : "", h ? `${h}h` : "", m ? `${m}m` : "", !d && !h ? `${x}s` : ""].filter(Boolean).join(" "); };
  const countdown = (target: number) => (target > now ? `${span(target - now)} ${date(target)}` : word(S + "Status/Overtime"));
  // GetVulnerabilityTime: GetStructureStatusString's time string on one line.
  function timer(h: MySovHub): string {
    switch (status(h)) {
      case "vulnerable": return countdown(h.vulnerability!.endMs);
      case "overtime": return word(S + "Status/Overtime");
      case "reinforced": return countdown(h.campaign!.startMs);
      case "contested": return word(S + "StatusOngoing");
      default: return h.vulnerability ? `${word(S + "Status/VulnerabilityWindow")} ${h.vulnerability.startMs - now > 86400000 ? date(h.vulnerability.startMs) : clock(h.vulnerability.startMs)}-${clock(h.vulnerability.endMs)}` : word(S + "Status/Unknown");
    }
  }
  const LOCATIONS: readonly [string, string, Record<string, unknown>][] = [["", "UI/Agency/ContentOfAnyDistance", {}], ["1", "UI/Generic/CurrentSystem", {}], ["2", "UI/Common/WithinJumps", { numJumps: 2 }],
    ["5", "UI/Common/WithinJumps", { numJumps: 5 }], ["10", "UI/Common/WithinJumps", { numJumps: 10 }]];
</script>

<div class="sh">
  <h2 class="sh-title">{word(H + "SovereigntyHubs")}</h2>
  <div class="sh-filters">
    <select value={location} onchange={(e) => { location = e.currentTarget.value; keep("sovHubPageFilter_location", location); }}>
      {#each LOCATIONS as [value, label, values] (value)}<option {value}>{word(label, values)}</option>{/each}
    </select>
    <span class="sh-gap"></span>
    <input type="search" value={filterText} oninput={(e) => { filterText = e.currentTarget.value; keep("sovhub_page_text_filter", filterText); }} />
  </div>
  <div class="sh-table">
    <div class="sh-row sh-head">{#each HEADERS as h (h)}<span>{word(h)}</span>{/each}</div>
    {#if loading && !hubs}<p class="sh-hint">…</p>
    {:else}
      {#each shown as h (h.hubID)}
        {@const d = details[h.hubID]}
        {@const t = transit(d)}
        <div class="sh-row">
          <span class="sh-name"><button class="sh-exp" onclick={() => toggle(h)}>{open[h.hubID] ? "▾" : "▸"}</button>⬢ {h.systemName}</span><span class="sh-num">{h.jumps ?? "-"}</span><span>{h.regionName}</span><span>{upgradesText(d)}</span><span>{powerText(d)}</span><span>{workforceText(d)}</span>
          <span title={t?.hint ?? ""}>{d ? (t ? t.icon : na()) : "…"}</span><span>{fuelText(d, 81143)}</span><span>{fuelText(d, 81144)}</span>
          <span>{word(S + "Status/" + STATUS_LABELS[status(h)], { typeName: "" })}</span><span class="sh-dim">{timer(h)}</span>
        </div>
        {#if open[h.hubID]}
          {@const x = extras[h.hubID]}
          {@const g = graph(d, x)}
          {@const r = resources(h, d)}
          {@const tr = transport(d, x)}
          <div class="sh-exp-row">
            <div class="sh-exp-top"><div><div class="sh-exp-name">{word(S + "SovHub/HubWnd/SovHubName", { solarSystemName: h.systemName })}</div>
              <small class="sh-dim">{h.regionName} &gt; {h.constellationName} &gt; {h.systemName}</small></div>
              <button onclick={() => { hubWindow = h; }}>⧉ {word(H + "EditStructure")}</button></div>
            <div class="sh-exp-body">
              <div class="sh-col" style:width="145px"><small class="sh-dim">{word(H + "Upgrades")}</small>
                <svg width="160" height="160" viewBox="0 0 160 160">
                  {#each [1, 2, 3, 4, 5] as i (i)}<circle cx="80" cy="80" r={i * 11} fill="none" stroke="rgba(150,150,150,0.5)" stroke-width="0.5" />{/each}
                  {#if g}
                    {#if g.total}<polygon points={g.total} fill="none" stroke="#5a6470" stroke-width="1" />{/if}
                    {#if g.online}<polygon points={g.online} fill="none" stroke="#58a6dc" stroke-width="1.3" />{/if}
                    {#each g.icons as ic (ic.listID)}<text x={ic.x} y={ic.y + 5} text-anchor="middle" font-size="12" fill="rgba(255,255,255,0.4)">{ic.icon}</text>{/each}
                  {/if}
                </svg>
                <small class="sh-dim sh-center">{d?.upgrades ? word(H + "NumUpgradesOnline", { online: d.upgrades.filter((u) => u.powerState === "POWER_STATE_ONLINE").length, installed: d.upgrades.length }) : na()}</small></div>
              {#each [[81143, "TimeUntilMagmaRunsOut"], [81144, "TimeUntilIceRunsOut"]] as const as [typeID, hint], i (typeID)}
                {@const t = timeLeft(d, typeID)}
                {@const f = d?.fuel?.[typeID]}
                <div class="sh-col" style:width="120px"><small class="sh-dim">{i === 0 ? word(H + "Fuel") : " "}</small>
                  <div class="sh-fuel" style:--p={`${t.progress * 360}deg`} title={word(S + "SovHub/HubWnd/" + hint)}><span><b>{t.text}</b><small>{d?.fuel ? (f?.amount ?? 0) : na()}</small><small>{word(S + "AmountPerHour", { value: f?.perHour ?? 0 })}</small></span></div>
                  <small class="sh-dim sh-center">{fuelText(d, typeID)}</small></div>
              {/each}
              <div class="sh-col" style:width="300px">
                {#if r}
                  {#each [["Power", r.power], ["Workforce", r.workforce]] as const as [label, v] (label)}
                    <small class="sh-dim">{word(S + label)}</small>
                    <div class="sh-res"><span>{v[0]} <span class="sh-dim">/ {v[1]}</span></span><span class="sh-dim">{v[2]}</span></div>
                    <div class="sh-gauge"><i style:width={`${Math.min(1, v[4]) * 100}%`} class="avail"></i>{#if v.length > 5}<i style:width={`${Math.min(1, (v as readonly unknown[])[5] as number) * 100}%`} class="exp"></i>{/if}<i style:width={`${Math.min(1, v[3]) * 100}%`} class="use"></i></div>
                  {/each}
                {/if}
                <small class="sh-dim">{word(S + "SovHub/HubWnd/SectionWorkforceTransport")}</small>
                {#if tr}<div>{tr.mode}</div><small class="sh-dim">{tr.desc}</small>
                  <div class="sh-sources">{#each tr.sources as src (src.name)}<span title={src.amount === null ? word(S + "SovHub/HubWnd/SourceSystemNotConnected") : !src.amount ? word(S + "SovHub/HubWnd/SourceSystemNotSendingWorkforce") : ""}>{src.amount ? `${src.name} (${src.amount})` : `⚠ ${src.name}`}</span>{/each}</div>
                {:else}<small>…</small>{/if}
              </div>
              <div class="sh-col sh-sky"><b>{x ? (x.skyhooks ?? na()) : "…"}</b><small class="sh-dim">{nameAny("type", 81080) || "Orbital Skyhook"}</small></div>
            </div>
          </div>
        {/if}
      {:else}<p class="sh-hint">{word((hubs?.length ?? 0) > 0 ? H + "NoSovHubsFilteredOut" : H + "NoSovHubs")}</p>{/each}
    {/if}
  </div>
  {#if hubWindow}<SovHubWindow {store} {flow} hub={hubWindow} details={details[hubWindow.hubID]} extras={extras[hubWindow.hubID]} onClose={() => { hubWindow = null; }} onChanged={() => reloadHub(hubWindow!)} />{/if}
</div>

<style>
  .sh { display: flex; flex-direction: column; height: 100%; padding: 8px; box-sizing: border-box; }
  .sh-title { margin: 0; font-size: 18px; flex: none; }
  .sh-filters { display: flex; height: 30px; margin: 20px 0 16px; align-items: center; flex: none; }
  .sh-gap { flex: 1; }
  .sh-table { flex: 1; min-height: 0; overflow: auto; }
  .sh-row { display: grid; grid-template-columns: 100px 40px 80px 60px 100px 120px 70px 80px 80px 100px minmax(200px, 1fr); gap: 6px; min-height: 30px; align-items: center; padding: 0 4px; background: rgba(255, 255, 255, 0.1); margin-bottom: 1px; }
  .sh-head { background: none; min-height: 22px; font-size: 11px; opacity: 0.7; }
  .sh-num { text-align: right; }
  .sh-dim { opacity: 0.75; }
  .sh-hint { text-align: center; opacity: 0.65; }
  .sh-name { display: flex; align-items: center; gap: 4px; }
  .sh-exp { all: unset; cursor: pointer; width: 16px; }
  .sh-exp-row { min-height: 300px; padding: 20px 8px 8px 24px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
  .sh-exp-top { display: flex; justify-content: space-between; align-items: flex-start; height: 40px; margin-bottom: 20px; }
  .sh-exp-name { font-size: 15px; }
  .sh-exp-body { display: flex; gap: 0; padding-left: 8px; }
  .sh-col { display: flex; flex-direction: column; gap: 4px; }
  .sh-center { text-align: center; }
  .sh-fuel { width: 110px; height: 110px; margin-top: 20px; border-radius: 50%; background: conic-gradient(#58a6dc var(--p), rgba(255, 255, 255, 0.08) 0); display: flex; align-items: center; justify-content: center; }
  .sh-fuel > span { width: 104px; height: 104px; border-radius: 50%; background: #15171a; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .sh-fuel small { opacity: 0.65; }
  .sh-res { display: flex; justify-content: space-between; }
  .sh-gauge { position: relative; height: 4px; background: rgba(255, 255, 255, 0.08); margin-bottom: 10px; }
  .sh-gauge i { position: absolute; left: 0; top: 0; bottom: 0; }
  .sh-gauge i.avail { background: #58a6dc; }
  .sh-gauge i.exp { background: #6fbf73; }
  .sh-gauge i.use { background: #5a6c80; }
  .sh-sources { display: flex; flex-wrap: wrap; gap: 10px; }
  .sh-sky { width: 100px; padding-left: 30px; justify-content: center; }
  .sh-sky b { font-size: 20px; }
</style>
