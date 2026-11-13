<script lang="ts">
  // Alliances/all_ui_rankings.py FormAlliancesRankings (Relationships > All Alliances): Show All at the bottom
  // (ConfirmShowAllRankedAlliances, yes / no, Yes kept; then GetRankedAlliances(0)); the scroll of
  // GetRankedAlliances(100) with the headers Name, Executor Corp, Short Name, Created ('ls'), Members, Alliance Standing
  // (standingsvc.GetStanding(corpid, allianceID): the corporation's contact standing, else 0; NotSet for None);
  // NoRankingsFound. A row's menu: the alliance's (Show Info) and Apply To Join (base_corporation_ui.ApplyToJoinAlliance;
  // disabled where CheckCanApplyToJoinAlliance fails) - ApplyToAllianceWnd (400 x 350, AllianceApplication: the
  // alliance's logo 64, ApplyForMembership {corporation}, CorporationApplicationText over the text (1000, set to
  // AskJoinAlliance), ThisApplicationOverwritesOlderOnes; OK - corp.ApplyToJoinAlliance(allianceID, text)).
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { AllianceInfo } from "../bridge/allianceInfo.ts";
  import type { CorpWar } from "../bridge/corpWars.ts";
  import { DATE_LABELS, formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { allianceLogoUrl } from "./ownerImages.ts";
  import { showInfo } from "./showInfo.ts";
  import OwnerPicture from "./OwnerPicture.svelte";
  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const imageServer = flow.imageServer;
  const R = "UI/Corporations/CorporationWindow/Alliances/Rankings/";
  const LABELS = ["ShowAll", "ExecutorCorp", "ShortName", "Created", "AllianceStanding", "NoRankingsFound", "NotSet", "ApplyToJoin"].map((k) => R + k)
    .concat(["UI/Common/Name", "UI/Corporations/CorporationWindow/Alliances/Members", "UI/Commands/ShowInfo", "UI/Corporations/BaseCorporationUI/AllianceApplication",
      "UI/Corporations/BaseCorporationUI/ApplyForMembership", "UI/Corporations/BaseCorporationUI/CorporationApplicationText",
      "UI/Corporations/BaseCorporationUI/ThisApplicationOverwritesOlderOnes", "UI/Common/Buttons/OK", "UI/Common/Buttons/Cancel", DATE_LABELS.ls!]);
  const fill = (label: string, values: Record<string, unknown> = {}) =>
    plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") }));
  let rows = $state<readonly { alliance: AllianceInfo; standing: number }[] | null>(null), error = $state(""), menuFor = $state<number | null>(null);
  let canApply = $state(false), applying = $state<number | null>(null), applyText = $state(""), busy = $state(false);
  let ceoID = $state<number | null>(null), wars = $state<readonly CorpWar[]>([]);
  const online = $derived($station.online);
  const director = $derived((BigInt(online?.corpRole ?? "0") & 1n) === 1n);
  async function show(maxLen: number): Promise<void> {
    if (maxLen === 0 && !await flow.askClientDialog("ConfirmShowAllRankedAlliances", "Show all alliances? This may take a while.", true)) return;
    try { rows = await flow.rankedAlliances(maxLen); } catch (e) { error = e instanceof Error ? e.message : String(e); rows = []; }
  }
  // corp.CheckCanApplyToJoinAlliance(allianceID): no alliance, a director, the CEO, not applied to it already, and no
  // war standing in the way (an aggressor's unfinished war, a mutual war, a defence another than that alliance's)
  function applyRefusal(allianceID: number | null): string | null {
    if (!online || online.allianceID) return "";
    if (!director || ceoID !== online.characterID) return "CrpAccessDenied";
    const corp = online.corporationID, now = BigInt(Date.now()) * 10000n + 116444736000000000n;
    for (const w of wars) {
      if (w.declaredByID === corp) { if (w.timeFinished !== null && now > w.timeFinished) continue; return "CanNotJoinAllianceWhileAgressor"; }
      if (w.mutual) return "CanNotJoinAllianceWithActiveMututalWars";
      if (w.againstID !== corp && allianceID !== null && w.againstID !== allianceID) return "CanNotJoinAllianceWhileAlliedWithOthers";
    }
    return null;
  }
  onMount(() => {
    flow.requestWords(LABELS); flow.loadImageServer(); void show(100);
    const o = online;
    if (o && !o.allianceID) {
      void Promise.all([flow.ownCorporationDetails(), flow.ownerWars(o.corporationID ?? 0)]).then(([home, w]) => { ceoID = home?.ceoID ?? null; wars = w; canApply = applyRefusal(null) === null; }).catch(() => {});
    }
  });
  async function openApply(allianceID: number): Promise<void> {
    menuFor = null;
    const why = applyRefusal(allianceID);
    if (why) { flow.sayDialog(why, null, why); return; }
    const mine = await flow.allianceApplications(true).catch(() => []);
    if (mine.some((a) => a.allianceID === allianceID)) { flow.sayDialog("CantApplyTwiceToAlliance", null, "You have already applied to this alliance."); return; }
    applyText = await flow.allianceApplicationStandardText(allianceID).catch(() => "");
    applying = allianceID;
  }
  async function confirmApply(): Promise<void> {
    if (busy || applying === null) return;
    busy = true;
    try { if (await flow.allianceApplicationAct({ kind: "apply", allianceID: applying, text: applyText })) applying = null; }
    catch (e) { error = e instanceof Error ? e.message : String(e); } finally { busy = false; }
  }
  const nameOf = (id: number | null) => (id ? resolvedName($names.resolved, "owner", id, "") : "");
  // '%s' of the standing: a float (a contact's relationship) as Python writes it, an int 0 as 0
  const standingText = (s: number | null) => (s === null ? fill(R + "NotSet") : s === 0 ? "0" : Number.isInteger(s) ? `${s}.0` : String(s));
</script>

{#if applying !== null}
  {@const allianceName = nameOf(applying) || rows?.find((r) => r.alliance.allianceID === applying)?.alliance.allianceName || ""}
  {@const logo = allianceLogoUrl($imageServer, applying)}
  <div class="ar-back">
    <div class="ar-apply" role="dialog" aria-modal="true" aria-label={fill("UI/Corporations/BaseCorporationUI/AllianceApplication")}>
      <header>{fill("UI/Corporations/BaseCorporationUI/AllianceApplication")}<button type="button" class="ar-x" aria-label="Close" onclick={() => (applying = null)}>×</button></header>
      <div class="ar-apply-top"><span class="ar-logo"><OwnerPicture name={allianceName} urls={logo ? [logo] : []} size={64} /></span><span class="ar-apply-title">{fill("UI/Corporations/BaseCorporationUI/ApplyForMembership", { corporation: allianceName })}</span></div>
      <label class="ar-label" for="ar-text">{fill("UI/Corporations/BaseCorporationUI/CorporationApplicationText")}</label>
      <textarea id="ar-text" maxlength="1000" bind:value={applyText}></textarea>
      <p class="ar-note">{fill("UI/Corporations/BaseCorporationUI/ThisApplicationOverwritesOlderOnes")}</p>
      <div class="ar-buttons">
        <button type="button" disabled={busy} onclick={() => void confirmApply()}>{fill("UI/Common/Buttons/OK")}</button>
        <button type="button" onclick={() => (applying = null)}>{fill("UI/Common/Buttons/Cancel")}</button>
      </div>
    </div>
  </div>
{/if}
<div class="ar">
  {#if error}<p class="error">{error}</p>{/if}
  <div class="ar-scroll">
    <div class="ar-row ar-head"><span>{fill("UI/Common/Name")}</span><span>{fill(R + "ExecutorCorp")}</span><span>{fill(R + "ShortName")}</span><span>{fill(R + "Created")}</span><span>{fill("UI/Corporations/CorporationWindow/Alliances/Members")}</span><span>{fill(R + "AllianceStanding")}</span></div>
    {#if rows}
      {#each rows as r (r.alliance.allianceID)}
        {@const a = r.alliance}
        <div class="ar-row" role="row" tabindex="-1" oncontextmenu={(e) => { e.preventDefault(); menuFor = menuFor === a.allianceID ? null : a.allianceID; }}>
          <span>{a.allianceName}</span><span>{nameOf(a.executorCorpID)}</span><span>{a.shortName}</span>
          <span>{a.startDate ? fill(DATE_LABELS.ls!, { datetime: { type: "long", value: a.startDate } }) : ""}</span><span>{a.memberCount}</span><span>{standingText(r.standing)}</span>
          {#if menuFor === a.allianceID}
            <div class="ar-menu" role="menu">
              <button type="button" role="menuitem" onclick={() => { menuFor = null; showInfo({ kind: "alliance", allianceID: a.allianceID ?? 0 }); }}>{fill("UI/Commands/ShowInfo")}</button>
              <button type="button" role="menuitem" disabled={!canApply} onclick={() => void openApply(a.allianceID ?? 0)}>{fill(R + "ApplyToJoin")}</button>
            </div>
          {/if}
        </div>
      {:else}
        <p class="ar-hint">{fill(R + "NoRankingsFound")}</p>
      {/each}
    {/if}
  </div>
  <div class="ar-buttons"><button type="button" onclick={() => void show(0)}>{fill(R + "ShowAll")}</button></div>
</div>

<style>
  .ar { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .ar-scroll { flex: 1; overflow-y: auto; }
  .ar-row { position: relative; display: grid; grid-template-columns: 1.6fr 1.4fr 0.8fr 0.9fr 0.6fr 0.8fr; align-items: center; min-height: 19px; padding: 0 4px; border-bottom: 1px solid rgba(255, 255, 255, 0.05); }
  .ar-head { font-size: 11px; opacity: 0.7; }
  .ar-hint { opacity: 0.8; padding: 4px; }
  .ar-menu { position: absolute; left: 20px; top: 18px; z-index: 5; display: flex; flex-direction: column; min-width: 160px; padding: 4px; background: rgba(20, 22, 25, 0.97); border: 1px solid rgba(255, 255, 255, 0.15); }
  .ar-menu button { text-align: left; background: none; border: 0; color: inherit; padding: 3px 6px; cursor: pointer; }
  .ar-buttons { display: flex; justify-content: center; gap: 4px; padding: 6px; }
  .ar-back { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; background: rgba(0, 0, 0, 0.35); }
  .ar-apply { width: 400px; height: 350px; display: flex; flex-direction: column; padding: 0 8px 8px; background: #15181b; border: 1px solid rgba(255, 255, 255, 0.15); }
  .ar-apply header { display: flex; justify-content: space-between; padding: 6px 0; font-weight: bold; }
  .ar-x { background: none; border: 0; color: inherit; font-size: 16px; cursor: pointer; }
  .ar-apply-top { height: 68px; display: flex; gap: 8px; }
  .ar-logo { width: 64px; height: 64px; display: grid; }
  .ar-apply-title { padding-top: 12px; font-size: 15px; }
  .ar-label { font-size: 11px; height: 16px; }
  .ar-apply textarea { height: 100px; resize: none; }
  .ar-note { padding-top: 8px; margin: 0; }
</style>
