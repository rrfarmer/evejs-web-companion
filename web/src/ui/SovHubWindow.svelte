<script lang="ts">
  // sov/sovHub/sovHubWnd.SovHubWnd (OpenSovHubWnd; min 960 x 590, compact; caption the hub's name): the left - the
  // hub's name, SummaryCont (NumUpgradesOnline {numOnline} / NumUpgradesInstalled {numInstalled}), the UpgradeScrollCont
  // (columns ColumnPriority, ColumnUpgrade, ColumnPowerAllocation, ColumnWorkforceAllocation, ColumnUpkeep,
  // ColumnStartupCost, the online toggle, ColumnState; a row: its priority + 1, the type list's icon and the type's
  // name, power and workforce - a producer's ExtraAmount in green, else what it needs -, ConsumptionPerHour {amount},
  // the startup cost, the configured-online toggle, the state - Online, or PendingPowerState / LowPowerState in red with
  // the lacking resource's tooltip, Offline; the lacking resources from hubUtil.UpdateEffectiveStatesForUpgrades in
  // priority order), NoUpgradesInstalled or DropUpgradesToAdd where empty, and SaveChanges (disabled without changes).
  // The right, 300 wide: PowerCont and WorkforceCont (in use / total available, the max; the gauge), the workforce
  // transport, FuelLevels with the magma and ice gauges, and StartupCostHeader with the pending startups' lava and ice
  // ("000" where none).
  // Editing (HubController): the toggle (SetOnlineState: configured online or offline), the order (DoMove - here the
  // up / down arrows in place of the drag), removal (DeleteUpgrade: ConfirmDestroyUpgrade, Proceed / Cancel, then
  // UninstallRequest at once; FailedToRemoveUpgrade on failure) and Save Changes (with unsaved changes - the list of
  // (type, configured online) differs from the server's: ConfirmSovHubUpgradeChanges, ProcessConfigurationRequest with
  // every upgrade in order; ConfigurationSuccessfullySaved where the power states came back as simulated, else
  // ConfigurationSavedNotSame; SovHubChangeNotSaved on failure). While editing, the states are the simulation's
  // (UpdateEffectiveStatesForUpgrades with unsaved changes: a lacking one shows Offline). Closing with unsaved changes
  // asks ConfirmCloseSovHubWnd.
  // Not here yet: dropping new upgrades in, adding fuel, the workforce and access-list settings, Show on Map.
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, MySovHub, SovHubDetails, SovHubExtras, SovHubUpgrade } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  let { store, flow, hub, details, extras, onClose, onChanged }: { store: ClientStore; flow: AppFlow; hub: MySovHub; details: SovHubDetails | undefined; extras: SovHubExtras | undefined; onClose: () => void; onChanged: () => Promise<void> } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const W = "UI/Sovereignty/SovHub/HubWnd/", U = "UI/Sovereignty/SovHub/Upgrades/";
  const COLUMNS = ["ColumnPriority", "ColumnUpgrade", "ColumnPowerAllocation", "ColumnWorkforceAllocation", "ColumnUpkeep", "ColumnStartupCost", "", "ColumnState"];
  const LABELS = [...COLUMNS.filter(Boolean).map((k) => W + k), W + "SovHub", W + "SovHubName", W + "NumUpgradesOnline", W + "NumUpgradesInstalled", W + "SaveChanges", W + "FuelLevels",
    W + "StartupCostHeader", W + "ProceedBtn", W + "ConfigurationSuccessfullySaved", W + "ConfigurationSavedNotSame", U + "FailedToRemoveUpgrade", U + "MoveUpgrades",
    U + "DeleteUpgrade", U + "LackingResourcesHint", U + "NoUpgradesInstalled", U + "DropUpgradesToAdd", U + "ExtraAmount", U + "ConsumptionPerHour", U + "PendingPowerState", U + "LowPowerState", U + "UnknownPowerState",
    "UI/Common/Online", "UI/Common/Offline", "UI/Sovereignty/Power", "UI/Sovereignty/Workforce", "Tooltips/StructureUI/SovHubRedFuelState", "Tooltips/StructureUI/SovHubRedResourceState",
    "Tooltips/StructureUI/SovHubRedPowerState", "Tooltips/StructureUI/SovHubRedWorkforceState", "Tooltips/StructureUI/SovHubOnlineUpgrade", "Tooltips/StructureUI/SovHubOfflineUpgrade",
    ...COLUMNS.filter(Boolean).map((k) => "Tooltips/StructureUI/SovHub" + ({ ColumnPriority: "Priority", ColumnUpgrade: "InstalledUpgrades", ColumnPowerAllocation: "Allocation", ColumnWorkforceAllocation: "Allocation", ColumnUpkeep: "Upkeep", ColumnStartupCost: "Startup", ColumnState: "State" } as Record<string, string>)[k])];
  const nameAny = (k: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, k, id, "");
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: nameAny }));
  onMount(() => {
    flow.requestWords(LABELS);
    flow.requestNames([...(details?.upgrades ?? []).map((u) => ({ kind: "type" as const, id: u.typeID })), { kind: "type", id: 81143 }, { kind: "type", id: 81144 }]);
  });
  const n = (v: number) => v.toLocaleString("en-US");
  // The simulated list (installedUpgradesSimulated): each upgrade with its configured state, in priority order.
  type Sim = { u: SovHubUpgrade; online: boolean };
  let sim = $state<Sim[]>([]), busy = $state(false);
  let seen: SovHubDetails | undefined;
  $effect(() => { if (details !== seen) { seen = details; sim = (details?.upgrades ?? []).map((u) => ({ u, online: u.powerState !== "POWER_STATE_OFFLINE" })); } });
  const unsaved = $derived.by(() => {
    const original = (details?.upgrades ?? []).map((u) => `${u.typeID}:${u.powerState !== "POWER_STATE_OFFLINE"}`).join(",");
    return sim.map((x) => `${x.u.typeID}:${x.online}`).join(",") !== original;
  });
  function move(i: number, to: number): void { if (to < 0 || to >= sim.length) return; const next = [...sim]; const [x] = next.splice(i, 1); next.splice(to, 0, x!); sim = next; }
  async function remove(x: Sim): Promise<void> {
    if (busy || !(await flow.askClientDialog("ConfirmDestroyUpgrade", "Destroy this upgrade?"))) return;
    busy = true;
    try {
      if (!(await flow.uninstallSovHubUpgrade(hub.hubID, x.u.upgradeKey))) { flow.sayDialog("CustomInfo", { type: "dict", entries: [["info", word(U + "FailedToRemoveUpgrade")]] } as never, word(U + "FailedToRemoveUpgrade")); return; }
      await onChanged();
    } finally { busy = false; }
  }
  async function save(): Promise<void> {
    if (busy || !unsaved || !(await flow.askClientDialog("ConfirmSovHubUpgradeChanges", "Save these changes?"))) return;
    busy = true;
    try {
      const before = effective.map((e) => `${e.u.typeID}:${e.state}`).join(",");
      const r = await flow.saveSovHubUpgrades(hub.hubID, sim.map((x) => [x.u.typeID, x.online] as const));
      if ("status" in r) { flow.sayDialog("SovHubChangeNotSaved", null, "The changes were not saved."); return; }
      const after = r.states.map(([t, st]) => `${t}:${st}`).join(",");
      if (before === after) flow.sayDialog("CustomNotify", { type: "dict", entries: [["notify", word(W + "ConfigurationSuccessfullySaved")]] } as never, word(W + "ConfigurationSuccessfullySaved"));
      else flow.sayDialog("CustomInfo", { type: "dict", entries: [["info", word(W + "ConfigurationSavedNotSame")]] } as never, word(W + "ConfigurationSavedNotSame"));
      await onChanged();
    } finally { busy = false; }
  }
  async function close(): Promise<void> {
    if (unsaved && !(await flow.askClientDialog("ConfirmCloseSovHubWnd", "Close without saving?"))) return;
    onClose();
  }
  const LIST_ICONS: Record<number, string> = { 829: "☷", 622: "✸", 830: "⇄", 828: "◈", 620: "▣", 621: "⛏" };
  // hubUtil.UpdateEffectiveStatesForUpgrades over the simulated list, in priority order: power / workforce against the
  // hub's available plus what an online producer before adds; fuel - a new, pending or offline one's startup cost
  // plus an hour's upkeep - against the hub's fuel. Configured online and nothing lacking: online and counted; else
  // offline (configured so), offline with unsaved changes or low without them where lacking, pending where only the
  // startup lacks.
  const effective = $derived.by(() => {
    let power = details?.resources?.powerAvailable ?? 0, work = details?.resources?.workforceAvailable ?? 0, pUsed = 0, wUsed = 0;
    const fuelUsed = new Map<number, number>();
    return sim.map(({ u, online }) => {
      const lackP = u.powerRequired + pUsed > power, lackW = u.workforceRequired + wUsed > work;
      let cost = 0, lackS = false, lackF = false;
      if (u.fuelTypeID) {
        const used = fuelUsed.get(u.fuelTypeID) ?? 0, have = details?.fuel?.[u.fuelTypeID]?.amount ?? 0;
        if (u.powerState === "POWER_STATE_PENDING" || u.powerState === "POWER_STATE_OFFLINE") { lackS = u.startupCost + used > have; cost += u.startupCost; }
        cost += u.fuelPerHour ? 1 : 0;
        lackF = cost + used > have;
      }
      if (online && !lackP && !lackW && !lackF) { pUsed += u.powerRequired; wUsed += u.workforceRequired; if (cost) fuelUsed.set(u.fuelTypeID, (fuelUsed.get(u.fuelTypeID) ?? 0) + cost); }
      let state: SovHubUpgrade["powerState"];
      if (!online) state = "POWER_STATE_OFFLINE";
      else if (lackF || lackP || lackW) state = unsaved ? "POWER_STATE_OFFLINE" : "POWER_STATE_LOW";
      else if (lackS) state = "POWER_STATE_PENDING";
      else { state = "POWER_STATE_ONLINE"; power += u.powerProduced; work += u.workforceProduced; }
      return { u, online, state, lacking: [lackS ? "startup" : "", lackF ? "fuel" : "", lackP ? "power" : "", lackW ? "workforce" : ""].filter(Boolean) };
    });
  });
  const lacking = $derived(new Map(effective.map((e) => [e.u.typeID, e.lacking])));
  function stateOf(u: SovHubUpgrade, configured: boolean, powerState: SovHubUpgrade["powerState"]): { text: string; hint: string; red: boolean } {
    const T = "Tooltips/StructureUI/";
    // upgradeStateText: not configured online is Offline; else by the effective state.
    if (!configured) return { text: word("UI/Common/Offline"), hint: word(T + "SovHubOfflineUpgrade"), red: false };
    u = { ...u, powerState };
    // Configured online yet simulated offline (lacking, with unsaved changes): UnknownPowerState in red.
    if (u.powerState === "POWER_STATE_OFFLINE") return { text: word(U + "UnknownPowerState"), hint: "", red: true };
    if (u.powerState === "POWER_STATE_ONLINE") return { text: word("UI/Common/Online"), hint: word(T + "SovHubOnlineUpgrade"), red: false };
    const l = lacking.get(u.typeID) ?? [];
    if (u.powerState === "POWER_STATE_PENDING") return { text: word(U + "PendingPowerState"), hint: l.includes("startup") ? word(T + "SovHubRedFuelState") : "", red: true };
    if (u.powerState === "POWER_STATE_LOW") {
      const r = l.filter((x) => x !== "startup");
      return { text: word(U + "LowPowerState"), red: true, hint: r.length > 1 ? word(T + "SovHubRedResourceState") : r[0] === "power" ? word(T + "SovHubRedPowerState") : r[0] === "workforce" ? word(T + "SovHubRedWorkforceState") : "" };
    }
    return { text: word(U + "UnknownPowerState"), hint: "", red: true };
  }
  const listIcon = (typeID: number) => { const l = (extras?.listsByType[typeID] ?? [])[0]; return l ? LIST_ICONS[l] ?? "" : ""; };
  const produced = (key: "powerProduced" | "workforceProduced") => (details?.upgrades ?? []).filter((u) => u.powerState === "POWER_STATE_ONLINE").reduce((s, u) => s + u[key], 0);
  const power = $derived.by(() => { const p = produced("powerProduced"), max = (details?.maxPower ?? 0) + p, avail = (details?.resources?.powerAvailable ?? 0) + p, use = details?.resources?.powerAllocated ?? 0; return { use, avail, max }; });
  const work = $derived.by(() => {
    const p = produced("workforceProduced"), imported = details?.workforce?.mode === "import_settings" ? details.workforce.imports.reduce((s, [, a]) => s + a, 0) : 0;
    const exported = details?.workforce?.mode === "export_settings" ? details.workforce.exportAmount : 0;
    return { use: details?.resources?.workforceAllocated ?? 0, avail: (details?.resources?.workforceAvailable ?? 0) + p, max: (details?.maxWorkforce ?? 0) + p + imported, exported };
  });
  const startup = (typeID: number) => (details?.upgrades ?? []).filter((u) => u.fuelTypeID === typeID && u.powerState === "POWER_STATE_PENDING").reduce((s, u) => s + u.startupCost, 0);
  function timeLeft(typeID: number): { text: string; progress: number; amount: number; perHour: number } {
    const f = details?.fuel?.[typeID];
    if (!f || !f.perHour) return { text: "-", progress: 0, amount: f?.amount ?? 0, perHour: f?.perHour ?? 0 };
    const hours = f.amount / f.perHour;
    return { text: hours > 336 ? word(W + "NumWeeksShort", { numWeeks: Math.floor(hours / 168) }) : hours > 168 ? `${Math.floor(hours / 24)}d` : hours > 24 ? `${Math.floor(hours)}h` : `${Math.floor(hours)}h ${Math.floor((hours % 1) * 60)}m`,
      progress: Math.min(1, hours / 672), amount: f.amount, perHour: f.perHour };
  }
  const online = $derived(effective.filter((e) => e.state === "POWER_STATE_ONLINE").length);
</script>

<div class="hw-back" role="presentation">
  <div class="hw" role="dialog" aria-label={word(W + "SovHubName", { solarSystemName: hub.systemName })}>
    <header><span>{word(W + "SovHubName", { solarSystemName: hub.systemName }) || word(W + "SovHub")}</span><button class="hw-x" onclick={() => void close()}>✕</button></header>
    <div class="hw-body">
      <div class="hw-left">
        <div class="hw-name">{word(W + "SovHubName", { solarSystemName: hub.systemName })}</div>
        <div class="hw-summary"><span>{word(W + "NumUpgradesOnline", { numOnline: online })}</span><span>/</span><span class="hw-dim">{word(W + "NumUpgradesInstalled", { numInstalled: sim.length })}</span></div>
        <div class="hw-table">
          <div class="hw-row hw-head">{#each COLUMNS as c, i (i)}<span>{c ? word(W + c) : ""}</span>{/each}</div>
          {#if !details?.upgrades}<p class="hw-hint">{word("UI/Sovereignty/NotAvailable")}</p>
          {:else}
            {#each effective as e, i (e.u.typeID)}
              {@const u = e.u}
              {@const st = stateOf(u, e.online, e.state)}
              {@const l = e.lacking}
              <div class="hw-row" class:restricted={st.red}>
                <span class="hw-num"><span class="hw-move" title={word(U + "MoveUpgrades")}><button disabled={busy || i === 0} onclick={() => move(i, i - 1)}>▴</button><button disabled={busy || i === effective.length - 1} onclick={() => move(i, i + 1)}>▾</button></span>{i + 1}</span>
                <span><span class="hw-dim">{listIcon(u.typeID)}</span> {nameAny("type", u.typeID) || u.typeID}</span>
                <span class="hw-num" class:green={u.powerProduced > 0} class:red={l.includes("power")}>{u.powerProduced > 0 ? word(U + "ExtraAmount", { amount: n(u.powerProduced) }) : n(u.powerRequired)} ⚡</span>
                <span class="hw-num" class:green={u.workforceProduced > 0} class:red={l.includes("workforce")}>{u.workforceProduced > 0 ? word(U + "ExtraAmount", { amount: n(u.workforceProduced) }) : n(u.workforceRequired)} ⚇</span>
                <span class="hw-num" class:red={l.includes("fuel")} title={nameAny("type", u.fuelTypeID)}>{word(U + "ConsumptionPerHour", { amount: n(u.fuelPerHour) })}</span>
                <span class="hw-num" class:red={l.includes("startup")} title={nameAny("type", u.fuelTypeID)}>{n(u.startupCost)}</span>
                <span title={!e.online && l.length ? word(U + "LackingResourcesHint") : ""}><input type="checkbox" disabled={busy} checked={e.online} onchange={(ev) => { sim = sim.map((x) => (x.u.typeID === u.typeID ? { ...x, online: ev.currentTarget.checked } : x)); }} /></span>
                <span class="hw-state"><span class:red={st.red} title={st.hint}>{st.text}</span><button class="hw-trash" title={word(U + "DeleteUpgrade")} disabled={busy} onclick={() => void remove(e)}>🗑</button></span>
              </div>
            {:else}<p class="hw-hint">{word(hub.solarSystemID === $station.online?.solarSystemID ? U + "DropUpgradesToAdd" : U + "NoUpgradesInstalled")}</p>{/each}
          {/if}
        </div>
        <div class="hw-buttons"><button disabled={!unsaved || busy} onclick={() => void save()}>{word(W + "SaveChanges")}</button></div>
      </div>
      <div class="hw-right">
        {#each [["UI/Sovereignty/Power", power.use, power.avail, power.max, 0], ["UI/Sovereignty/Workforce", work.use, work.avail, work.max, work.exported]] as const as [label, use, avail, max, exported] (label)}
          <small class="hw-dim">{word(label)}</small>
          <div class="hw-res"><span><b>{n(use)}</b> <span class="hw-dim">/ {n(avail)}</span></span><span class="hw-dim">{n(max)}</span></div>
          <div class="hw-gauge"><i class="avail" style:width={`${max ? Math.min(1, (avail + exported) / max) * 100 : 0}%`}></i><i class="avail2" style:width={`${max ? Math.min(1, avail / max) * 100 : 0}%`}></i><i class="use" style:width={`${max ? Math.min(1, use / max) * 100 : 0}%`}></i></div>
        {/each}
        <small class="hw-dim">{word(W + "FuelLevels")}</small>
        <div class="hw-fuels">
          {#each [81143, 81144] as typeID (typeID)}
            {@const t = timeLeft(typeID)}
            <div class="hw-fuel" style:--p={`${t.progress * 360}deg`}><span><b>{t.text}</b><small>{details?.fuel ? t.amount : word("UI/Sovereignty/NotAvailable")}</small><small>{word("UI/Sovereignty/AmountPerHour", { value: t.perHour })}</small></span></div>
          {/each}
        </div>
        <small class="hw-dim">{word(W + "StartupCostHeader")}</small>
        <div class="hw-startup">{#each [81143, 81144] as typeID (typeID)}<span title={nameAny("type", typeID)}>{typeID === 81143 ? "♨" : "❄"} <b>{startup(typeID) || "000"}</b></span>{/each}</div>
      </div>
    </div>
  </div>
</div>

<style>
  .hw-back { position: absolute; inset: 0; z-index: 8; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.45); }
  .hw { width: 960px; max-width: 98%; min-height: 590px; max-height: 98%; display: flex; flex-direction: column; background: #1b1d21; border: 1px solid rgba(255, 255, 255, 0.15); }
  .hw > header { display: flex; justify-content: space-between; padding: 6px 8px; font-weight: bold; }
  .hw-x { all: unset; cursor: pointer; }
  .hw-body { flex: 1; min-height: 0; display: flex; gap: 24px; padding: 8px; }
  .hw-left { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .hw-name { font-size: 15px; padding-left: 26px; }
  .hw-summary { display: flex; gap: 10px; padding: 6px 0 6px 10px; font-size: 12px; }
  .hw-table { flex: 1; min-height: 0; overflow: auto; }
  .hw-row { display: grid; grid-template-columns: 50px 1.6fr 90px 90px 90px 80px 40px 1fr; gap: 6px; min-height: 30px; align-items: center; padding: 0 4px; border-bottom: 1px solid rgba(255, 255, 255, 0.05); }
  .hw-head { font-size: 11px; opacity: 0.7; min-height: 22px; }
  .hw-num { text-align: right; }
  .hw-row.restricted > span:nth-child(2) { color: #d4534f; }
  .red { color: #d4534f; }
  .green { color: #6fbf73; }
  .hw-dim { opacity: 0.65; }
  .hw-hint { text-align: center; opacity: 0.65; }
  .hw-move { display: inline-flex; flex-direction: column; margin-right: 6px; vertical-align: middle; }
  .hw-move button, .hw-trash { all: unset; cursor: pointer; font-size: 10px; line-height: 10px; opacity: 0.6; }
  .hw-move button:disabled, .hw-trash:disabled { opacity: 0.2; cursor: default; }
  .hw-state { display: flex; justify-content: space-between; }
  .hw-trash { font-size: 12px; }
  .hw-buttons { display: flex; justify-content: flex-end; padding-top: 8px; }
  .hw-right { width: 300px; flex: none; display: flex; flex-direction: column; gap: 4px; }
  .hw-res { display: flex; justify-content: space-between; align-items: baseline; }
  .hw-res b { font-size: 18px; }
  .hw-gauge { position: relative; height: 4px; background: rgba(255, 255, 255, 0.08); margin-bottom: 10px; }
  .hw-gauge i { position: absolute; left: 0; top: 0; bottom: 0; }
  .hw-gauge i.avail { background: #6fbf73; }
  .hw-gauge i.avail2 { background: #58a6dc; }
  .hw-gauge i.use { background: #5a6c80; }
  .hw-fuels { display: flex; gap: 10px; justify-content: center; height: 120px; align-items: center; }
  .hw-fuel { width: 110px; height: 110px; border-radius: 50%; background: conic-gradient(#58a6dc var(--p), rgba(255, 255, 255, 0.08) 0); display: flex; align-items: center; justify-content: center; }
  .hw-fuel > span { width: 104px; height: 104px; border-radius: 50%; background: #1b1d21; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .hw-fuel small { opacity: 0.65; }
  .hw-startup { display: flex; gap: 60px; padding-top: 4px; }
  .hw-startup b { font-size: 15px; }
</style>
