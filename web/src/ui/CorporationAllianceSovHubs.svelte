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
  // Not here yet: the expanded row (ExpandedSovHubEntry), the Sov Hub window, sorting by the loaded columns.
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, MySovHub, SovHubDetails } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
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
    H + "FuelCritical", H + "NotAvailable", "UI/Agency/ContentOfAnyDistance", "UI/Generic/CurrentSystem", "UI/Common/WithinJumps",
    ...["VulnerableNowType", "VulnerableType", "ReinforcedType", "InvulnerableType", "ContestedType", "Overtime", "Unknown", "VulnerabilityWindow"].map((k) => S + "Status/" + k), S + "StatusOngoing"];
  const nameAny = (k: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, k, id, "");
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: nameAny }));
  const read = (key: string, fallback: string) => { try { return localStorage.getItem(`evejs.play.${key}`) ?? fallback; } catch { return fallback; } };
  const keep = (key: string, value: string) => { try { localStorage.setItem(`evejs.play.${key}`, value); } catch { /* the session keeps it */ } };
  let hubs = $state<readonly MySovHub[] | null>(null), loading = $state(true), details = $state<Record<number, SovHubDetails>>({}), now = $state(Date.now());
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
          <span>⬢ {h.systemName}</span><span class="sh-num">{h.jumps ?? "-"}</span><span>{h.regionName}</span><span>{upgradesText(d)}</span><span>{powerText(d)}</span><span>{workforceText(d)}</span>
          <span title={t?.hint ?? ""}>{d ? (t ? t.icon : na()) : "…"}</span><span>{fuelText(d, 81143)}</span><span>{fuelText(d, 81144)}</span>
          <span>{word(S + "Status/" + STATUS_LABELS[status(h)], { typeName: "" })}</span><span class="sh-dim">{timer(h)}</span>
        </div>
      {:else}<p class="sh-hint">{word((hubs?.length ?? 0) > 0 ? H + "NoSovHubsFilteredOut" : H + "NoSovHubs")}</p>{/each}
    {/if}
  </div>
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
</style>
