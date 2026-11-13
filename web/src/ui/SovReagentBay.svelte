<script lang="ts">
  // sov/reagentBay/reagentBayWnd.ReagnetBayWnd (OpenSovFuelDepositWindow, from a Sov Hub's Deposit Reagents in space;
  // min 500 x 290; caption SovereigntyHubReagentBayWithSystemName {solarSystemName}): the source combo (the colony
  // resources hold and the cargo, where the ship has the hold), a ReagentBayInputItem for each reagent (ice 81144, lava
  // 81143): the type's icon in two gauges (in the hub and with the window's amount, over four weeks of the burn), its
  // name, the time left in days (FormatTimeIntervalWritten) with the added time in green ("+n"), CurrentInHub
  // {qtyInHub}, FuelBurnRate {burnRate: AmountPerHour}, an integer input set to what the hold has (at most that; the
  // hint NumUnitsInCargo {qty} or NoSuchItemInCargo; a row with none at a quarter's opacity). A station manager also
  // sees NumUpgradesOnline {numOnline, numTotal}. Deposit (DepositReagentBtn, with something to deposit): asks
  // ConfirmReagentDepositFromCargo / ...FromReagentBay {itemList: "• n x type" lines}, then DoDepositItems - each type's
  // stacks largest first, AddRequest of min(stack, left) each; the window closes when all went in.
  // Not here: merging the stacks first (_MergeItemsBeforeDeposit), the colony resources hold read from the ship's
  // attributes (here the hold shows where it holds a reagent).
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, SovHubDetails } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import TypeIcon from "./TypeIcon.svelte";
  let { store, flow, hubID, solarSystemID, isStationMgr, onClose }: { store: ClientStore; flow: AppFlow; hubID: number; solarSystemID: number; isStationMgr: boolean; onClose: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const R = "UI/Sovereignty/SovHub/ReagentBay/";
  const REAGENTS = [81144, 81143];
  const LABELS = [R + "SovereigntyHubReagentBay", R + "SovereigntyHubReagentBayWithSystemName", R + "DepositReagentBtn", R + "NoReagentDataAvailable", R + "CurrentInHub", R + "FuelBurnRate",
    R + "NumUpgradesOnline", R + "NoDataAvailable", R + "NumUnitsInReagentBay", R + "NoSuchItemInInfrastructureHold", "UI/Sovereignty/AmountPerHour",
    "UI/Inflight/SpaceComponents/UnderConstruction/NumUnitsInCargo", "UI/Inflight/SpaceComponents/UnderConstruction/NoSuchItemInCargo", "UI/Common/QuantityAndItem",
    "/Carbon/UI/Common/WrittenDateTimeQuantity/Day", "UI/Ship/CargoHold", "UI/Ship/ColonyResourcesHold"];
  const nameAny = (k: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, k, id, "");
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: nameAny }));
  let details = $state<SovHubDetails | null>(null), stacks = $state<Awaited<ReturnType<AppFlow["reagentStacks"]>>>(null), loading = $state(true), busy = $state(false);
  let useHold = $state(false), qty = $state<Record<number, number>>({});
  async function load(): Promise<void> {
    loading = true;
    try {
      const [d, s] = await Promise.all([flow.sovHubDetails(hubID, solarSystemID), flow.reagentStacks()]);
      details = d; stacks = s;
      qty = Object.fromEntries(REAGENTS.map((t) => [t, held(t)]));
    } finally { loading = false; }
  }
  onMount(() => { flow.requestWords(LABELS); flow.requestNames([...REAGENTS.map((id) => ({ kind: "type" as const, id })), { kind: "system", id: solarSystemID }]); void load(); });
  const source = $derived(stacks ? (useHold ? stacks.resourceHold : stacks.cargo) : []);
  function held(typeID: number): number { return (stacks ? (useHold ? stacks.resourceHold : stacks.cargo) : []).filter((s) => s.typeID === typeID).reduce((n, s) => n + s.quantity, 0); }
  const hasHold = $derived((stacks?.resourceHold.length ?? 0) > 0);
  // InputItemController: the burn over four weeks; the days a number of units lasts.
  const days = (units: number, perHour: number) => { if (!perHour) return ""; const d = Math.floor(units / perHour / 24); return word("/Carbon/UI/Common/WrittenDateTimeQuantity/Day", { units: Math.max(0, d) }) || `${d} days`; };
  const progress = (units: number, perHour: number) => (perHour ? Math.min(1, Math.max(0, units / (perHour * 672))) : 0);
  const n = (v: number) => v.toLocaleString("en-US");
  const total = $derived(REAGENTS.reduce((s, t) => s + (qty[t] ?? 0), 0));
  async function deposit(): Promise<void> {
    if (busy || total <= 0) return;
    const lines = REAGENTS.filter((t) => qty[t]).map((t) => `• ${word("UI/Common/QuantityAndItem", { quantity: qty[t], item: t }) || `${qty[t]} x ${nameAny("type", t)}`}`).join("<br>");
    if (!(await flow.askClientDialogWith(useHold ? "ConfirmReagentDepositFromReagentBay" : "ConfirmReagentDepositFromCargo", { itemList: lines, rewardText: "" }, "Deposit the reagents?"))) return;
    busy = true;
    let failed = false;
    try {
      for (const t of REAGENTS) {
        let left = Math.min(qty[t] ?? 0, held(t));
        for (const s of source.filter((x) => x.typeID === t)) {
          if (left <= 0) break;
          const take = Math.min(s.quantity, left);
          if ((await flow.addSovHubFuel(hubID, s.itemID, take)) !== 200) { failed = true; break; }
          left -= take;
        }
        if (left > 0) failed = true;
      }
    } finally { busy = false; }
    if (!failed) { onClose(); return; }
    await load();
  }
  const isk = $derived(details);
</script>

<div class="rb-back" role="presentation">
  <div class="rb" role="dialog" aria-label={word(R + "SovereigntyHubReagentBay")}>
    <header><span>{word(R + "SovereigntyHubReagentBayWithSystemName", { solarSystemName: nameAny("system", solarSystemID) }) || word(R + "SovereigntyHubReagentBay")}</span><button class="rb-x" onclick={onClose}>✕</button></header>
    <div class="rb-body">
      {#if hasHold}
        <div class="rb-combo"><select value={useHold ? "hold" : "cargo"} onchange={(e) => { useHold = e.currentTarget.value === "hold"; qty = Object.fromEntries(REAGENTS.map((t) => [t, held(t)])); }}>
          <option value="hold">{word("UI/Ship/ColonyResourcesHold") || "Infrastructure Hold"}</option><option value="cargo">{word("UI/Ship/CargoHold") || "Cargo Hold"}</option></select></div>
      {/if}
      {#if loading && !isk}<p class="rb-hint">…</p>
      {:else if !details?.fuel}<p class="rb-hint">{word(R + "NoReagentDataAvailable")}</p>
      {:else}
        {#each REAGENTS as t (t)}
          {@const f = details.fuel[t] ?? { amount: 0, perHour: 0 }}
          {@const inCargo = held(t)}
          {@const adding = Math.min(qty[t] ?? 0, inCargo)}
          <div class="rb-row" class:none={!inCargo}>
            <div class="rb-icon" style:--hub={`${progress(f.amount, f.perHour) * 360}deg`} style:--wnd={`${Math.min(1, progress(f.amount, f.perHour) + progress(adding, f.perHour)) * 360}deg`}><span><TypeIcon typeID={t} name={nameAny("type", t)} size="md" /></span></div>
            <div class="rb-text">
              <div><span>{nameAny("type", t)}</span> <small class="rb-dim">{days(f.amount, f.perHour)}{#if adding && f.perHour}<span class="rb-plus"> +{days(adding, f.perHour)}</span>{/if}</small></div>
              <small class="rb-dim">{word(R + "CurrentInHub", { qtyInHub: n(f.amount) })}</small>
              <small class="rb-dim">{word(R + "FuelBurnRate", { burnRate: word("UI/Sovereignty/AmountPerHour", { value: f.perHour }) })}</small>
            </div>
            <input type="number" min="0" max={inCargo} value={adding} title={inCargo ? word(useHold ? R + "NumUnitsInReagentBay" : "UI/Inflight/SpaceComponents/UnderConstruction/NumUnitsInCargo", { qty: inCargo }) : word(useHold ? R + "NoSuchItemInInfrastructureHold" : "UI/Inflight/SpaceComponents/UnderConstruction/NoSuchItemInCargo")}
              oninput={(e) => { qty = { ...qty, [t]: Math.max(0, Math.min(inCargo, Math.floor(Number(e.currentTarget.value) || 0))) }; }} />
          </div>
        {/each}
      {/if}
    </div>
    <footer>
      <small class="rb-dim">{#if isStationMgr && details}{details.upgrades ? word(R + "NumUpgradesOnline", { numOnline: details.upgrades.filter((u) => u.powerState === "POWER_STATE_ONLINE").length, numTotal: details.upgrades.length }) : word(R + "NoDataAvailable")}{/if}</small>
      <button disabled={busy || total <= 0} onclick={() => void deposit()}>{busy ? "…" : word(R + "DepositReagentBtn")}</button>
    </footer>
  </div>
</div>

<style>
  .rb-back { position: fixed; inset: 0; z-index: 30; display: flex; align-items: center; justify-content: center; pointer-events: none; }
  .rb { pointer-events: auto; width: 500px; min-height: 290px; display: flex; flex-direction: column; background: #1b1d21; border: 1px solid rgba(255, 255, 255, 0.15); }
  .rb > header { display: flex; justify-content: space-between; padding: 6px 8px; font-weight: bold; }
  .rb-x { all: unset; cursor: pointer; }
  .rb-body { flex: 1; padding: 6px 8px; display: flex; flex-direction: column; gap: 1px; }
  .rb-combo { display: flex; justify-content: flex-end; }
  .rb-row { display: flex; align-items: center; gap: 12px; min-height: 88px; padding: 3px 13px 3px 10px; }
  .rb-row.none { opacity: 0.25; }
  .rb-icon { width: 74px; height: 74px; border-radius: 50%; flex: none; background: conic-gradient(#58a6dc var(--hub), #a8aab0 var(--hub) var(--wnd), rgba(255, 255, 255, 0.06) 0); display: flex; align-items: center; justify-content: center; }
  .rb-icon > span { width: 66px; height: 66px; border-radius: 50%; background: #1b1d21; display: flex; align-items: center; justify-content: center; }
  .rb-text { flex: 1; display: flex; flex-direction: column; gap: 6px; padding-top: 4px; }
  .rb-row input { width: 100px; }
  .rb-dim { opacity: 0.65; }
  .rb-plus { color: #6fbf73; }
  .rb-hint { text-align: center; opacity: 0.65; }
  .rb > footer { display: flex; justify-content: space-between; align-items: center; padding: 8px; }
</style>
