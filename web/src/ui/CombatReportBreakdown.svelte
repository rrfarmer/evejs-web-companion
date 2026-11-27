<script lang="ts">
  import { tick } from "svelte";
  import type { MapLocationInfo } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import type { CombatLogReport } from "../bridge/combatLog.ts";
  import { combatReportBreakdown, KILL_REPORT_PATH, type CombatReportAttacker } from "../bridge/combatReportBreakdown.ts";
  import { combatReportDate } from "../bridge/combatReportPresentation.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { shownSecurity } from "../bridge/systemSecurity.ts";
  import type { JsonValue } from "../bridge/wire.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName, type NameRef } from "../store/names.ts";
  import CorpLogo from "./CorpLogo.svelte";
  import OwnerPicture from "./OwnerPicture.svelte";
  import TypeIcon from "./TypeIcon.svelte";
  import { openFittingWindow } from "./fittingWindowTarget.ts";
  import { allianceLogoUrl, portraitDefaultPath, portraitUrl } from "./ownerImages.ts";
  import { clientTexture } from "./skillGroupIcons.ts";

  let { report, flow, store }: { report: CombatLogReport; flow: AppFlow; store: ClientStore } = $props();
  const names = $derived(store.names), words = $derived(store.words);
  const imageServer = $derived(flow.imageServer), logos = $derived(flow.corpLogos), logoLibrary = $derived(flow.corpLogoLibrary);
  const breakdown = $derived(combatReportBreakdown(report));
  const saveWord = $derived(word("SaveFitting", "Save Fitting"));
  const simulateWord = $derived(say("UI/Fitting/FittingWindow/SimulateShipFitting", "Simulate Fitting"));
  const buyWord = $derived(say("UI/Market/MarketQuote/BuyAll", "Buy All"));
  let hull = $state<"ship" | "capsule" | null>(null);
  let working = $state(false);
  let actionError = $state("");
  const number = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  const say = (path: string, fallback: string, values: Record<string, JsonValue> = {}) =>
    plainText(formatTemplate($words.templates[path] || fallback, values, { nameOf: name }));
  const word = (key: string, fallback: string, values?: Record<string, JsonValue>) => say(KILL_REPORT_PATH + key, fallback, values);
  const unknown = $derived(say("UI/Common/Unknown", "Unknown"));
  const name = (kind: NameRef["kind"], id: number | null | undefined) => id ? resolvedName($names.resolved, kind, id, "") : "";
  const owner = (id: number | null) => name("owner", id) || unknown;
  const typeName = (id: number | null) => name("type", id) || unknown;
  const victimName = $derived(owner(report.victimCharacterID ?? report.victimCorporationID));
  const shipName = $derived(typeName(report.victimShipTypeID));
  const group = $derived(name("typeGroup", report.victimShipTypeID));

  let location = $state.raw<MapLocationInfo | null>(null);
  $effect(() => {
    flow.loadImageServer();
    flow.loadOwnerLogos();
    if (report.victimCorporationID) flow.requestCorpLogos([report.victimCorporationID]);
    if (report.victimShipTypeID) flow.requestNames([{ kind: "typeGroup", id: report.victimShipTypeID }]);
    flow.requestNames(breakdown.sections.flatMap(section => section.lines.map(({ item }) => ({ kind: "typeCategory", id: item.typeID }))));
    let active = true;
    const id = report.solarSystemID;
    location = null;
    if (id) void flow.mapLocationShowInfo(id).then(result => { if (active) location = result; }).catch(() => {});
    return () => { active = false; };
  });
  $effect(() => {
    const typeID = report.victimShipTypeID;
    hull = null;
    if (!typeID || breakdown.sections.length === 0) return;
    let active = true;
    void flow.combatReportFittingKind(typeID).then(kind => { if (active) hull = kind; }).catch(() => {});
    return () => { active = false; };
  });

  async function fittingAction(action: "save" | "simulate" | "buy"): Promise<void> {
    if (working) return;
    working = true;
    actionError = "";
    try {
      if (action === "simulate") {
        await tick();
        openFittingWindow();
      }
      await flow.combatReportFittingAction(report, action);
    } catch (error) {
      actionError = panelErrorWords(error);
    } finally {
      working = false;
    }
  }

  const security = $derived(report.solarSystemID ? ($names.systemSecurity[report.solarSystemID] ?? location?.securityStatus ?? null) : null);
  const system = $derived(name("system", report.solarSystemID) || location?.name || unknown);
  const parents = $derived(location?.parents.slice().sort((left, right) => right.typeID - left.typeID).map(place => place.name) ?? []);
  const payout = $derived(Boolean(report.bountyClaimed || (report.loyaltyPoints ?? 0) > 0));
  const amount = (value: number | null) => value === null ? unknown : number(value) + " ISK";

  function portrait(id: number | null, size: number): string[] {
    const picture = id ? portraitUrl($imageServer, id, size) : null;
    return [...(picture ? [picture] : []), clientTexture(portraitDefaultPath(size))];
  }

  function damageOf(attacker: CombatReportAttacker): string {
    const percentage = report.damageTaken ? attacker.damage * 100 / report.damageTaken : 0;
    return word("DamageDone", "{damage} damage ({percentage}%)", { damage: attacker.damage, percentage });
  }
</script>

{#snippet corpPicture(id: number | null, size: number)}
  <div class="corporation-picture" style:width="{size}px" style:height="{size}px">
    {#if id && $logos[id] && $logoLibrary}
      <CorpLogo library={$logoLibrary} logo={$logos[id]!} name={owner(id)} />
    {:else}
      <OwnerPicture name={owner(id)} urls={[]} {size} />
    {/if}
  </div>
{/snippet}

{#snippet attackerCard(attacker: CombatReportAttacker)}
  {@const displayName = attacker.characterID ? owner(attacker.characterID) : typeName(attacker.shipTypeID)}
  {@const affiliation = attacker.allianceID || attacker.factionID}
  <div class="attacker" data-attacker={attacker.characterID || attacker.corporationID} data-damage={attacker.damage}>
    <OwnerPicture name={displayName} urls={portrait(attacker.characterID, 64)} size={64} />
    <div class="attacker-equipment">
      {#if attacker.shipTypeID}<TypeIcon typeID={attacker.shipTypeID} name={typeName(attacker.shipTypeID)} size="md" />{/if}
      {#if attacker.weaponTypeID}<TypeIcon typeID={attacker.weaponTypeID} name={typeName(attacker.weaponTypeID)} size="md" />{/if}
    </div>
    <div class="attacker-details">
      <strong title={displayName}>{displayName}</strong>
      {#if attacker.corporationID}<span title={owner(attacker.corporationID)}>{owner(attacker.corporationID)}</span>{/if}
      {#if affiliation}<span title={owner(affiliation)}>{owner(affiliation)}</span>{/if}
      {#if attacker.weaponTypeID}<small class="damage-done">{damageOf(attacker)}</small>{/if}
    </div>
  </div>
{/snippet}

<div class="kill-report" data-kill-report-id={report.killID}>
  <div class="victim">
    <div class="victim-images">
      {#if report.victimCharacterID}
        <OwnerPicture name={victimName} urls={portrait(report.victimCharacterID, 128)} size={128} />
      {:else}
        {@render corpPicture(report.victimCorporationID, 128)}
      {/if}
      <div class="ship-image"><TypeIcon typeID={report.victimShipTypeID} name={shipName} size="lg" /></div>
    </div>
    <div class="victim-details">
      <h2>{report.victimCharacterID ? victimName : shipName}</h2>
      {#if report.victimCorporationID}
        <div class="victim-affiliation">
          {@render corpPicture(report.victimCorporationID, 32)}
          {#if report.victimAllianceID}
            {@const logo = allianceLogoUrl($imageServer, report.victimAllianceID)}
            <OwnerPicture name={owner(report.victimAllianceID)} urls={logo ? [logo] : []} size={32} />
          {/if}
          <div>{owner(report.victimCorporationID)}
            {#if report.victimAllianceID || report.victimFactionID}
              <br />{owner(report.victimAllianceID ?? report.victimFactionID)}
            {/if}
          </div>
        </div>
      {/if}
      {#if report.victimCharacterID}<div class="destroyed-ship">{shipName}{group ? " (" + group + ")" : ""}</div>{/if}
      <time>{combatReportDate(report)}</time>
      <div class="kill-location">{system}{security === null ? "" : " " + shownSecurity(security).toFixed(1)}{parents.length ? " < " + parents.join(" < ") : ""}</div>
    </div>
  </div>

  <div class="report-columns">
    <div class="involved">
      {#if report.killRightSupplied}
        <div class="killed-on-behalf">
          <h3>{word("KilledOnBehalf", "Killed on behalf of")}</h3>
          <OwnerPicture name={owner(report.killRightSupplied)} urls={portrait(report.killRightSupplied, 64)} size={64} />
          {owner(report.killRightSupplied)}
        </div>
      {/if}
      <h3 class="party-count">{word("InvolvedParties", "Involved Parties ({parties})", { parties: breakdown.parties })}</h3>
      <div class="damage-taken">{word("TotalDamage", "{damage} Total Damage Taken", { damage: report.damageTaken ?? 0 })}</div>
      {#if breakdown.final}
        <div class="final-blow"><h4>{word("FinalBlow", "Final blow")}</h4>{@render attackerCard(breakdown.final)}</div>
      {/if}
      {#if breakdown.top}
        <div class="top-damage"><h4>{word("TopDamage", "Top damage")}</h4>{@render attackerCard(breakdown.top)}</div>
      {/if}
      {#if breakdown.others.length}
        <div class="other-attackers">{#each breakdown.others as attacker}{@render attackerCard(attacker)}{/each}</div>
      {/if}
    </div>
    <div class="fitting-breakdown">
      <h3>{word("FittingAndContent", "Fitting and content")}</h3>
      <div class="item-groups">
        {#each breakdown.sections as section (section.name)}
          <div class="item-group" data-rack={section.name}>
            <h4>{section.name === "Other" ? section.fallback : word(section.name, section.fallback)}</h4>
            {#each section.lines as line}
              {@const type = typeName(line.item.typeID)}
              {@const blueprint = name("typeCategory", line.item.typeID).toLowerCase() === "blueprint"}
              {@const suffix = !blueprint ? "" : " (" + (line.item.singleton === 2
                ? say("UI/Generic/Copy", "Copy") : say("UI/Generic/Original", "Original")).toLowerCase() + ")"}
              <div class="kill-item" class:dropped={line.result === "dropped"} data-type={line.item.typeID}
                data-result={line.result} data-depth={line.depth} style:padding-inline-start="{6 + line.depth * 16}px">
                <TypeIcon typeID={line.item.typeID} name={type} />
                <span class="item-name" title={type + suffix}>{type}{suffix}</span>
                <span class="quantity">{number(line.quantity)}</span>
              </div>
            {/each}
          </div>
        {:else}
          <div class="empty-items">{say("UI/Corporations/Assets/NoItemsFound", "No items found")}</div>
        {/each}
      </div>
      <div class="report-totals">
        <div class="total-worth"><span>{word("TotalWorth", "Total worth")}</span><strong>{amount(report.iskLost || null)}</strong></div>
        {#if payout}
          <div class="total-destroyed"><span>{word("PendInsurance", "Destroyed")}</span><span>{amount(report.iskDestroyed)}</span></div>
          {#if report.bountyClaimed}<div class="bounty"><span>{word("BountyPaidOut", "Bounty paid out")}</span><span>{amount(report.bountyClaimed)}</span></div>{/if}
          {#if (report.loyaltyPoints ?? 0) > 0}
            <div class="loyalty"><span>{word("LPPaidOut", "LP paid out")}</span>
              <span>{say("UI/LPStore/AmountLP", "{lpAmount} LP", { lpAmount: number(report.loyaltyPoints!) })}</span></div>
          {/if}
        {/if}
      </div>
      {#if hull}
        <div class="fitting-actions" aria-busy={working}>
          {#if hull === "ship"}
            <button type="button" class="minor report-save-fit" disabled={working} onclick={() => fittingAction("save")}>{saveWord}</button>
            <button type="button" class="minor report-simulate-fit" disabled={working} onclick={() => fittingAction("simulate")}>{simulateWord}</button>
          {/if}
          <button type="button" class="minor report-buy-all" disabled={working} onclick={() => fittingAction("buy")}>{buyWord}</button>
        </div>
        {#if actionError}<div class="action-error" role="status">{actionError}</div>{/if}
      {/if}
    </div>
  </div>
</div>

<style>
  .kill-report { display: flex; flex-direction: column; height: 100%; gap: 12px; container-type: inline-size; }
  .victim { display: flex; align-items: flex-start; gap: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--color-line); }
  .victim-images { display: flex; gap: 3px; }
  .ship-image { width: 128px; height: 128px; flex: none; }
  .ship-image :global(.type-icon) { width: 100%; height: 100%; }
  .corporation-picture { display: grid; flex: none; place-items: center; overflow: hidden; }
  .corporation-picture > :global(*) { width: 100%; height: 100%; }
  .victim-details { display: flex; flex-direction: column; justify-content: center; min-width: 0; min-height: 128px; }
  h2, h3, h4 { margin: 0; font-weight: 500; }
  h2 { font-size: 18px; }
  h3 { font-size: 15px; margin-bottom: 4px; }
  h4 { font-size: 12px; margin-bottom: 3px; color: var(--color-muted); }
  .victim-affiliation { display: flex; align-items: center; gap: 6px; margin: 5px 0; }
  .destroyed-ship, time { display: block; }
  time, .kill-location { color: var(--color-muted); }
  .kill-location { overflow-wrap: anywhere; }
  .report-columns { display: grid; grid-template-columns: minmax(210px, 42%) minmax(0, 1fr); gap: 12px; flex: 1; min-height: 0; }
  .involved, .fitting-breakdown { min-width: 0; }
  .involved { display: flex; flex-direction: column; overflow: auto; scrollbar-width: thin; }
  .fitting-breakdown { display: flex; flex-direction: column; min-height: 0; }
  .final-blow, .top-damage, .killed-on-behalf { margin: 10px 0; }
  .attacker { display: flex; align-items: flex-start; gap: 4px; min-width: 0; }
  .attacker-equipment { display: flex; flex-direction: column; width: 32px; flex: none; }
  .attacker-equipment :global(.type-icon) { width: 32px; height: 32px; }
  .attacker-details { align-self: stretch; display: flex; flex-direction: column; min-width: 0; padding-inline-start: 3px; font-size: 12px; }
  .attacker-details > :is(strong, span) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 400; }
  .attacker-details .damage-done { margin-top: auto; color: var(--color-muted); }
  .other-attackers { display: grid; gap: 3px; padding-top: 6px; border-top: 1px solid var(--color-line); }
  .damage-taken, .total-destroyed > :last-child { color: var(--color-danger); }
  .item-groups { flex: 1; overflow: auto; scrollbar-width: thin; }
  .item-group h4 { padding: 4px 6px; margin: 0; background: var(--color-panel-2); }
  .kill-item { display: flex; align-items: center; gap: 5px; min-height: 26px; padding-inline-end: 6px; }
  .kill-item.dropped { background: color-mix(in srgb, #658e72 23%, transparent); }
  .item-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .quantity { font-variant-numeric: tabular-nums; }
  .empty-items { padding: 6px; color: var(--color-muted); }
  .report-totals { margin-top: 10px; border-top: 1px solid var(--color-line); padding-top: 5px; }
  .report-totals > div { display: flex; justify-content: space-between; gap: 6px; }
  .fitting-actions { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--color-line); }
  .report-buy-all { margin-inline-start: auto; }
  .action-error { color: var(--color-danger); }
  .total-worth { font-size: 14px; margin-bottom: 3px; }
  .loyalty > :last-child, .bounty > :last-child { color: var(--color-good); }
  @container (max-width: 480px) {
    .victim { flex-wrap: wrap; }
    .victim-details { min-height: 0; width: 100%; }
    .report-columns { grid-template-columns: minmax(0, 1fr); }
    .involved, .item-groups { overflow: visible; }
    .ship-image { max-width: 40vw; }
  }
</style>
