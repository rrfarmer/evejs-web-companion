<script lang="ts">
  import { onMount } from "svelte";
  import type { Session } from "../app/sessions.ts";
  import { fetchTypeDogma } from "../app/api.ts";
  import { errorWords } from "../app/flow.ts";
  import { formatTemplate, plainText, type TemplateArguments } from "../bridge/clientWords.ts";
  import { JUMP_BRIDGE_INITIATE, JUMP_BRIDGE_ROOT, rechargedJumpBridgeGJ, type JumpBridgeCharge } from "../bridge/jumpBridgePanel.ts";
  import type { Entity, JumpBridgePanelState } from "../play/spaceView.ts";
  import type { ReadableSignal } from "../store/signals.ts";

  let { session, gate, state: bridgeState, simNow }: {
    session: Session; gate: Entity; state: ReadableSignal<JumpBridgePanelState>; simNow(): number;
  } = $props();
  // svelte-ignore state_referenced_locally
  const { flow, store: { station, words } } = session;
  const capitalChanged = flow.jumpBridgeCapitalChanged;
  const PERCENT = "UI/Common/Formatting/PercentageDecimal";
  const KEYS = ["JumpBridgeUnlinked", "ZoneNumber", "CapacitorStatus", "YourCostWithPercentage",
    "YourCostInsufficientCharge", "NoAccess", "Redacted"].map(part => JUMP_BRIDGE_ROOT + part);

  let requestedOpen = $state<boolean | null>(null);
  const expanded = $derived(requestedOpen ?? $bridgeState.near);
  const targetID = $derived($bridgeState.bridge.targetSystemID);
  const shipTypeID = $derived($bridgeState.shipTypeID);
  const chargeTag = $derived($bridgeState.bridge.chargeTag);
  const activation = $derived($bridgeState.bridge.activationState);
  let target = $state<{ name: string; security: number | null } | null>(null);
  let read = $state.raw<{ value: JumpBridgeCharge; simMs: number } | null | undefined>(undefined);
  let capacitor = $state<{ capacity: number; recharge: number } | null>(null);
  let cost = $state<{ zone: number; chargeGJ: number } | null>(null);
  let simMs = $state(0);
  let refresh = $state(0);
  let readError = $state("");
  let pending = $state(false);
  const capacity = $derived(capacitor?.capacity ?? 0);
  const charge = $derived(read && capacitor
    ? rechargedJumpBridgeGJ(read.value.chargeGJ, capacity, capacitor.recharge, simMs - read.simMs) : null);
  const percent = $derived(charge === null || capacity <= 0 ? 0 : charge * 100 / capacity);
  const costPercent = $derived(cost && capacity > 0 ? cost.chargeGJ * 100 / capacity : 0);
  const insufficient = $derived(charge !== null && cost !== null && charge < cost.chargeGJ);
  const chargedArc = $derived(insufficient ? 0 : Math.max(0, percent - costPercent) * .756);
  const costArc = $derived(Math.min(100, insufficient ? costPercent : percent) * .756);
  const canJump = $derived(!pending && targetID !== null && activation === 2 && read?.value.validShipType === true);

  onMount(() => {
    flow.requestWords([JUMP_BRIDGE_INITIATE, PERCENT, ...KEYS]);
    simMs = simNow();
    const display = setInterval(() => { simMs = simNow(); }, 2000);
    const reload = setInterval(() => { refresh++; }, 60_000);
    return () => { clearInterval(display); clearInterval(reload); };
  });

  $effect(() => {
    const id = targetID;
    target = null;
    if (id === null) return;
    let current = true;
    void flow.jumpBridgeSystem(id).then(system => { if (current) target = system; }).catch(() => {});
    return () => { current = false; };
  });

  $effect(() => {
    const itemID = gate.itemID;
    void chargeTag; void activation; void shipTypeID; void refresh; void $station.online?.allianceID;
    if (!expanded) return;
    let current = true;
    void flow.jumpBridgeCharge(itemID).then(value => {
      if (!current) return;
      simMs = simNow();
      read = value === null ? null : { value, simMs };
      readError = "";
    }).catch(error => {
      if (!current) return;
      read = undefined;
      readError = errorWords(error);
    });
    return () => { current = false; };
  });

  const authorized = $derived(read != null);
  $effect(() => {
    const typeID = gate.typeID;
    if (!expanded || !authorized || typeID === null) return;
    let current = true;
    void fetchTypeDogma([typeID], [482, 55], flow.requestOptions()).then(facts => {
      const values = facts[typeID], capacity = values?.[482], recharge = values?.[55];
      if (current && capacity !== undefined && recharge !== undefined) capacitor = { capacity, recharge };
    }).catch(() => {});
    return () => { current = false; };
  });

  $effect(() => {
    const typeID = gate.typeID, ship = shipTypeID, destination = targetID;
    void refresh; void $capitalChanged; void $station.online?.allianceID;
    cost = null;
    if (!expanded || !authorized || typeID === null || ship === null || destination === null) return;
    let current = true;
    void flow.jumpBridgePilotCost(typeID, ship, destination).then(value => { if (current) cost = value; }).catch(() => {});
    return () => { current = false; };
  });

  function word(key: string, fallback: string, args: TemplateArguments = {}): string {
    const text = $words.templates[key];
    return text ? plainText(formatTemplate(text, args, { templates: $words.templates })) : fallback;
  }

  const tj = (value: number, digits = 0) => (value / 1000).toLocaleString(undefined, {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  });
  const percentValue = (value: number) => Math.round(value * 10) / 10;
  const bridgeName = "Ansiblex Jump Bridge";
  const noAccess = $derived(word(JUMP_BRIDGE_ROOT + "NoAccess", "No Access"));
  async function jump(): Promise<void> {
    if (!canJump) return;
    pending = true;
    try { await flow.jumpThroughAnsiblex(gate.itemID); }
    finally { pending = false; }
  }
</script>

<div class="bridge" role="region" aria-label={bridgeName}>
  <button class="tether" type="button" aria-expanded={expanded} onclick={() => { requestedOpen = !expanded; }}>
    <img src="/client-res/ui/texture/classes/shipcaster/shipcastercentericon.png" alt="" />{bridgeName}
    <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
  </button>
  {#if expanded}
    <div class="console">
      {#if readError}<div class="capacity" role="status">{readError}</div>
      {:else if read === null}<div class="capacity">{word(JUMP_BRIDGE_ROOT + "Redacted", "Redacted")}</div>
      {:else if charge !== null}
        {@const left = tj(charge)}
        {@const total = tj(capacity)}
        <div class="capacity" aria-label="Bridge capacitor">
          {word(JUMP_BRIDGE_ROOT + "CapacitorStatus", `${left} / ${total} TJ`, { capacitorLeft: left, totalCapacitor: total })}
          <span class="separator" aria-hidden="true"></span>
          {word(PERCENT, `${percentValue(percent)}%`, { percentage: percentValue(percent) })}
        </div>
      {:else}<div class="capacity" role="status">Reading bridge capacitor…</div>{/if}

      <div class="destination">
        {#if target}{target.name} {target.security?.toFixed(1) ?? ""}
        {:else if targetID === null}{word(JUMP_BRIDGE_ROOT + "JumpBridgeUnlinked", "Unlinked")}{/if}
      </div>
      {#if read === null}
        <div class="cost warning">{noAccess}</div>
      {:else if cost && charge !== null}
        {@const amount = tj(cost.chargeGJ, 1)}
        {@const percentage = percentValue(costPercent)}
        <div class="zone">{word(JUMP_BRIDGE_ROOT + "ZoneNumber", `Zone ${cost.zone}`, { zoneNumber: cost.zone })}</div>
        <div class="cost" class:warning={insufficient}>
          {insufficient
            ? word(JUMP_BRIDGE_ROOT + "YourCostInsufficientCharge", `Your cost ${amount} TJ. Insufficient charge.`, { cost: amount, colorValue: "ff6060" })
            : word(JUMP_BRIDGE_ROOT + "YourCostWithPercentage", `Your cost ${amount} TJ (${percentage}%)`, { cost: amount, percentage, colorValue: "ffffff" })}
        </div>
      {/if}
      <div class="arc-window" aria-hidden="true">
        {#if charge === null}<img class="center" src="/client-res/ui/texture/classes/shipcaster/shipcastercentericon.png" alt="" />
        {:else}<div class="arc" style:--charge={`${chargedArc}deg`} style:--cost={`${Math.max(chargedArc, costArc)}deg`}></div>{/if}
      </div>
      <div class="jump-actions">
        <button class="jump" type="button" disabled={!canJump} title={read === null ? noAccess : undefined} onclick={() => void jump().catch(error => { readError = errorWords(error); })}>
          {word(JUMP_BRIDGE_INITIATE, "Initiate Jump")}
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .bridge { color: #e1eef1; pointer-events: auto; text-align: center; font-size: 12px; }
  .tether { display: inline-flex; align-items: center; gap: 7px; background: #132126e6; color: inherit; border: 1px solid #647881; padding: 4px 9px; cursor: pointer; }
  .tether img { width: 17px; height: 17px; }
  .console { min-height: 170px; box-sizing: border-box; padding: 10px 6px 4px; background: linear-gradient(#14252de6, #081016f2); border: 1px solid #617b86; }
  .capacity { display: flex; justify-content: center; align-items: center; gap: 8px; min-height: 16px; color: #c6dce4; }
  .separator { height: 4px; border-left: 1px solid #8399a3; }
  .destination { font-size: 20px; margin-top: 4px; line-height: 1.15; min-height: 22px; }
  .zone { color: #8ccad9; margin-top: 2px; }
  .cost { display: inline-block; margin: 4px auto 0; border: 1px solid #53616b; background: #03090c60; padding: 3px 8px; }
  .warning { color: #ff8b81; }
  .arc-window { position: relative; width: 204px; height: 36px; margin: 3px auto 0; overflow: hidden; background: url("/client-res/ui/texture/classes/shipcaster/shipcastercenter.png") center top / 204px 66px no-repeat; }
  .arc { position: absolute; width: 238px; height: 238px; left: 50%; top: 2px; transform: translateX(-50%); border-radius: 50%; background: conic-gradient(from -37.8deg, #e5f2f1 0 var(--charge), #db5548 var(--charge) var(--cost), #53717e var(--cost) 75.6deg, transparent 75.6deg); mask: radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 4px)); }
  .center { width: 26px; height: 26px; }
  .jump-actions { background: url("/client-res/ui/texture/classes/shipcaster/shipcasterleftside.png") left center / 105px 24px no-repeat, url("/client-res/ui/texture/classes/shipcaster/shipcasterrightside.png") right center / 105px 24px no-repeat; }
  .jump { min-width: 135px; padding: 5px 10px; color: #edf9fc; background: #233e49; border: 1px solid #a0bbc3; cursor: pointer; }
  .jump:hover:enabled { background: #365b69; }
  .jump:disabled { cursor: default; opacity: .5; }
</style>
