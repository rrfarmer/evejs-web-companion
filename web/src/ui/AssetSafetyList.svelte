<script lang="ts">
  // shared/assets/assetSafety.py AssetSafetyCont, over a controller's GetItemsInSafety (SafetyControllerCharacter -
  // GetItemsInSafetyForCharacter, the Personal Assets window's Asset Safety tab; SafetyControllerCorp -
  // GetItemsInSafetyForCorp, the corporation's Assets > Safety): AssetSafetyEntry's rows - Name, Solar System, Manual
  // Delivery (Deliver To, filled as the wait passes, enabled once daysUntilCanDeliver days from the eject time are gone)
  // and Auto Delivery (an hourglass, the time left until daysUntilAutoMove days, the nearest NPC station), counted each
  // second (UpdateCounters_thread); none - NoItemsFound. Deliver To opens AssetSafetyDeliverWindow: DeliverToStation,
  // the explanation (delivery open or not yet, stations in the system or none), each structure then station with
  // Deliver (disabled before the manual delivery time), Cancel.
  import { onDestroy, onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, SafetyWrap } from "../app/flow.ts";
  import { shortWrittenInterval, SHORT_INTERVAL_WORD_LABELS } from "../bridge/timeInterval.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import LabelText from "./LabelText.svelte";
  import { linkFollowerOf, LINK_WORDS } from "./linkFollowers.ts";
  let { store, flow, load }: { store: ClientStore; flow: AppFlow; load: () => Promise<readonly SafetyWrap[]> } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const S = "UI/Inventory/AssetSafety/";
  const nameOf = (k: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, k, id, "");
  const text = (label: string, args: Record<string, unknown> = {}) => formatTemplate($words.templates[label] ?? "", args as never, { nameOf });
  const followerOf = (url: string, t: string) => linkFollowerOf(url, flow, null, (label) => plainText($words.templates[label] ?? LINK_WORDS[label] ?? ""), t);
  const DAY = 864000000000n;
  let wraps = $state<readonly SafetyWrap[] | null>(null), error = $state("");
  let nowTicks = $state(BigInt(Date.now()) * 10000n + 116444736000000000n);
  const clock = setInterval(() => { nowTicks = BigInt(Date.now()) * 10000n + 116444736000000000n; }, 1000);
  onDestroy(() => clearInterval(clock));
  const interval = (ticks: bigint) => shortWrittenInterval(ticks < 0n ? 0n : ticks, $words.templates) ?? "";
  async function reload(): Promise<void> {
    try { wraps = await load(); } catch (e) { error = e instanceof Error ? e.message : String(e); wraps = []; }
  }
  onMount(() => {
    flow.requestWords(["UI/Common/Name", "UI/Common/LocationTypes/SolarSystem", S + "ManualDelivery", S + "AutoDelivery", S + "DeliverTo",
      S + "AutoDeliveryHint", S + "DeliverBtnAvailableHint", S + "DeliverBtnNotAvailableNowHint", S + "DeliverToStation", S + "DeliveryExplanationText",
      S + "DeliveryExplanationTextNoStations", S + "DeliveryNotAvailableNowExplanationText", S + "DeliveryNotAvailableTextNoStations", S + "DeliverBtn",
      "UI/Generic/Cancel", "UI/Corporations/Assets/NoItemsFound", ...SHORT_INTERVAL_WORD_LABELS, ...Object.keys(LINK_WORDS)]);
    void reload();
  });
  let delivering = $state<{ wrap: SafetyWrap; targets: readonly { itemID: number; typeID: number; name: string }[] | null } | null>(null);
  async function openDeliver(wrap: SafetyWrap): Promise<void> {
    delivering = { wrap, targets: null };
    try { const targets = await flow.safetyDeliveryTargets(wrap.solarSystemID); if (delivering?.wrap === wrap) delivering = { wrap, targets }; }
    catch (e) { error = e instanceof Error ? e.message : String(e); delivering = null; }
  }
  async function deliver(wrap: SafetyWrap, destinationID: number): Promise<void> {
    try {
      const done = await flow.deliverSafetyWrap(wrap.assetWrapID, wrap.solarSystemID, destinationID);
      // DoDeliver closes the window whether or not the move went through, once asked.
      if (done) { delivering = null; await reload(); }
    } catch (e) { error = e instanceof Error ? e.message : String(e); delivering = null; }
  }
  function explanation(wrap: SafetyWrap, stationsInSystem: number): string {
    const manual = wrap.ejectTime + BigInt(wrap.daysUntilCanDeliver) * DAY - nowTicks, auto = wrap.ejectTime + BigInt(wrap.daysUntilAutoMove) * DAY - nowTicks;
    const args = { solarSystemName: `<url=showinfo:5//${wrap.solarSystemID}>${nameOf("system", wrap.solarSystemID)}</url>`,
      npcStationName: `<url=showinfo:${wrap.nearestStationTypeID}//${wrap.nearestStationID}>${nameOf("station", wrap.nearestStationID)}</url>`,
      timeUntil: interval(auto), timeUntilAutoDelivery: interval(auto), timUntilManualDelivery: interval(manual) };
    const label = manual < 0n ? (stationsInSystem ? S + "DeliveryExplanationText" : S + "DeliveryExplanationTextNoStations") : (stationsInSystem ? S + "DeliveryNotAvailableNowExplanationText" : S + "DeliveryNotAvailableTextNoStations");
    return text(label, args);
  }
</script>

{#if delivering}
  {@const d = delivering}
  {@const manualLeft = d.wrap.ejectTime + BigInt(d.wrap.daysUntilCanDeliver) * DAY - nowTicks}
  <div class="asl-window" role="dialog" aria-label={plainText(text(S + "DeliverToStation"))}>
    <div class="asl-window-title">{plainText(text(S + "DeliverToStation"))}</div>
    {#if d.targets}
      <div class="asl-deliver-text"><LabelText markup={explanation(d.wrap, d.targets.length)} {followerOf} /></div>
      <div class="asl-window-list">
        {#each d.targets as t (t.itemID)}
          <div class="asl-deliver-row"><LabelText markup={`<url=showinfo:${t.typeID}//${t.itemID}>${t.name}</url>`} {followerOf} />
            <button disabled={manualLeft > 0n} onclick={() => void deliver(d.wrap, t.itemID)}>{plainText(text(S + "DeliverBtn"))}</button></div>
        {/each}
      </div>
    {/if}
    <div class="asl-window-buttons"><button onclick={() => { delivering = null; }}>{plainText(text("UI/Generic/Cancel"))}</button></div>
  </div>
{/if}

<div class="asl">
  {#if error}<p class="error">{error}</p>{/if}
  <div class="asl-row asl-head">{#each ["UI/Common/Name", "UI/Common/LocationTypes/SolarSystem", S + "ManualDelivery", S + "AutoDelivery"] as h (h)}<span>{plainText(text(h))}</span>{/each}</div>
  {#each wraps ?? [] as w (w.assetWrapID)}
    {@const manual = w.ejectTime + BigInt(w.daysUntilCanDeliver) * DAY - nowTicks}
    {@const auto = w.ejectTime + BigInt(w.daysUntilAutoMove) * DAY - nowTicks}
    <div class="asl-row">
      <span>{w.wrapName}</span>
      <span><LabelText markup={`<url=showinfo:5//${w.solarSystemID}>${nameOf("system", w.solarSystemID)}</url>`} {followerOf} /></span>
      <!-- SetDeliverBtnState: Disable(), then disabled = False - drawn disabled, still opening the window. -->
      <span><button class="asl-deliver" class:asl-dim={manual > 0n} aria-disabled={manual > 0n} onclick={() => void openDeliver(w)}
        title={manual < 0n ? plainText(text(S + "DeliverBtnAvailableHint")) : plainText(text(S + "DeliverBtnNotAvailableNowHint", { timeUntil: interval(manual) }))}>
        <span class="asl-progress" style:width={`${Math.min(1, Math.max(0, 1 - Number(manual) / (864000000000 * w.daysUntilCanDeliver))) * 100}%`}></span>
        <span class="asl-deliver-label">{plainText(text(S + "DeliverTo"))}</span></button></span>
      <span class="asl-auto"><img class="asl-hourglass" alt="" title={plainText(text(S + "AutoDeliveryHint"))} src="/client-res/ui/texture/classes/inventory/hourglass.png" />
        <span class="asl-auto-left">{interval(auto)}</span>
        <LabelText markup={`<url=showinfo:${w.nearestStationTypeID}//${w.nearestStationID}>${nameOf("station", w.nearestStationID)}</url>`} {followerOf} /></span>
    </div>
  {:else}
    {#if wraps}<p class="asl-hint">{plainText(text("UI/Corporations/Assets/NoItemsFound"))}</p>{/if}
  {/each}
</div>

<style>
  .asl { flex: 1; min-height: 0; overflow: auto; }
  .asl-dim { opacity: 0.5; }
  /* AssetSafetyEntry: 34 high; the Auto Delivery column 500 by default, the hourglass 24 x 24, the station at 150 */
  .asl-row { display: grid; grid-template-columns: minmax(140px, 1.5fr) 1fr 130px minmax(260px, 3fr); gap: 6px; align-items: center; min-height: 34px; border-bottom: 1px solid rgba(255, 255, 255, 0.05); padding: 0 4px; }
  .asl-head { min-height: 20px; font-size: 10px; opacity: 0.7; }
  .asl-deliver { position: relative; overflow: hidden; width: 120px; }
  .asl-progress { position: absolute; left: 0; top: 0; bottom: 0; background: rgba(255, 255, 255, 0.18); }
  .asl-deliver-label { position: relative; }
  .asl-auto { display: flex; align-items: center; gap: 4px; }
  .asl-hourglass { width: 24px; height: 24px; }
  .asl-auto-left { min-width: 122px; }
  .asl-hint { opacity: 0.7; padding: 6px 4px; }
  .asl-window { position: fixed; left: 50%; top: 30%; transform: translateX(-50%); z-index: 50; width: 600px; max-height: 620px; display: flex; flex-direction: column;
    background: rgba(12, 14, 16, 0.98); border: 1px solid rgba(255, 255, 255, 0.2); padding: 6px; gap: 6px; }
  .asl-window-title { font-weight: bold; }
  .asl-window-list { flex: 1; overflow: auto; display: flex; flex-direction: column; }
  .asl-window-buttons { display: flex; justify-content: center; gap: 6px; }
  .asl-deliver-text { opacity: 0.75; padding-bottom: 10px; border-bottom: 1px solid rgba(255, 255, 255, 0.2); }
  .asl-deliver-row { display: flex; justify-content: space-between; align-items: center; padding: 6px 7px; background: rgba(51, 51, 51, 0.3); border-bottom: 1px solid rgba(255, 255, 255, 0.2); font-weight: bold; }
  .asl-deliver-row button { width: 140px; }
</style>
