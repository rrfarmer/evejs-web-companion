<script lang="ts">
  // Alliances/all_ui_home.py FormAlliancesHome (Alliances > General > My Alliance): with an alliance, the top - its
  // logo 128, the name (TextHeadline) and its info icon; the Details group (ListGroup, locked open): AllianceName,
  // Executor ('-' with none), ShortName, URL (a link), Description (LabelTextTop), CreatedByCorporation, CreatedBy,
  // Dictatorial (Yes / No), WarPermitStatus (GetLabelPathForAllowWar: Unknown / WarAllowed / WarNotAllowed, hint
  // WarPermitExplanation); the buttons at the bottom - for a director Edit Alliance (EditAllianceWnd, 420 x 300:
  // URL, Description (5000); OK - FormatUrl, alliance.UpdateAlliance(description, url)) and Declare War. Without one:
  // CorporationNotInAlliance {corpName} and, for the CEO, Create Alliance (CreateAllianceWnd - not on the page yet).
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { AllianceInfoExtra } from "../bridge/allianceInfo.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { allianceLogoUrl } from "./ownerImages.ts";
  import { showInfo } from "./showInfo.ts";
  import OwnerPicture from "./OwnerPicture.svelte";
  import CorporationDeclareWar from "./CorporationDeclareWar.svelte";
  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const imageServer = flow.imageServer;
  const H = "UI/Corporations/CorporationWindow/Alliances/Home/";
  const LABELS = ["CorporationNotInAlliance", "CreateAlliance", "EditAlliance", "DeclareWar", "AllianceName", "Executor", "ShortName", "CreatedByCorporation", "CreatedBy",
    "Dictatorial", "UpdateAlliance", "DirectorsCanEdit", "CEODeclareWarOnlyHint"].map((k) => H + k)
    .concat(["UI/Common/Details", "UI/Common/URL", "UI/Common/Description", "UI/Common/Buttons/Yes", "UI/Common/Buttons/No", "UI/Common/Buttons/OK", "UI/Common/Buttons/Cancel",
      "UI/WarPermit/WarPermitStatus", "UI/WarPermit/WarPermitExplanation", "UI/WarPermit/CorpStatusWarPermitUnknown", "UI/WarPermit/CorpStatusWarAllowed", "UI/WarPermit/CorpStatusWarNotAllowed"]);
  const fill = (label: string, values: Record<string, unknown> = {}) =>
    plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") }));
  const ownerName = (id: number | null) => (id ? resolvedName($names.resolved, "owner", id, "") || String(id) : "");
  let data = $state<{ alliance: AllianceInfoExtra; allowWar: boolean | null } | null>(null), loaded = $state(false), error = $state("");
  let editing = $state(false), declaring = $state(false), editUrl = $state(""), editDescription = $state(""), busy = $state(false);
  const corporationID = $derived($station.online?.corporationID ?? 0);
  const director = $derived((BigInt($station.online?.corpRole ?? "0") & 1n) === 1n);
  let ceoID = $state<number | null>(null);
  function load(): void {
    void flow.myAlliance().then((d) => { data = d; loaded = true; error = ""; }, (e) => { error = e instanceof Error ? e.message : String(e); loaded = true; });
  }
  onMount(() => {
    flow.requestWords(LABELS); flow.loadImageServer(); load();
    flow.requestNames([{ kind: "corporation", id: corporationID }]);
    void flow.ownCorporationDetails().then((home) => { ceoID = home?.ceoID ?? null; }).catch(() => {});
  });
  // EditAllianceWnd.Confirm: FormatUrl (an address without http(s):// gets http://), then UpdateAlliance
  const formatUrl = (url: string) => { const u = url.trim(); return u && !/^https?:\/\//i.test(u) ? `http://${u}` : u; };
  async function confirmEdit(): Promise<void> {
    if (busy) return;
    busy = true;
    try { if (await flow.updateAlliance(editDescription, formatUrl(editUrl))) { editing = false; load(); } }
    catch (e) { error = e instanceof Error ? e.message : String(e); } finally { busy = false; }
  }
  const warPermitLabel = (allowWar: boolean | null) => allowWar === null ? "UI/WarPermit/CorpStatusWarPermitUnknown" : allowWar ? "UI/WarPermit/CorpStatusWarAllowed" : "UI/WarPermit/CorpStatusWarNotAllowed";
</script>

{#if declaring}<CorporationDeclareWar {store} {flow} onClose={() => { declaring = false; }} />{/if}
{#if editing && data}
  <div class="ah-back">
    <div class="ah-edit" role="dialog" aria-modal="true" aria-label={fill(H + "UpdateAlliance")}>
      <header>{fill(H + "UpdateAlliance")}<button type="button" class="ah-x" aria-label="Close" onclick={() => (editing = false)}>×</button></header>
      <label class="ah-field-label" for="ah-url">{fill("UI/Common/URL")}</label>
      <input id="ah-url" type="text" maxlength="2048" bind:value={editUrl} />
      <label class="ah-field-label ah-desc-label" for="ah-desc">{fill("UI/Common/Description")}</label>
      <textarea id="ah-desc" maxlength="5000" bind:value={editDescription}></textarea>
      <div class="ah-edit-buttons">
        <button type="button" disabled={busy} onclick={() => void confirmEdit()}>{fill("UI/Common/Buttons/OK")}</button>
        <button type="button" onclick={() => (editing = false)}>{fill("UI/Common/Buttons/Cancel")}</button>
      </div>
    </div>
  </div>
{/if}
<div class="ah">
  {#if error}<p class="error">{error}</p>{/if}
  {#if data}
    {@const a = data.alliance}
    {@const logo = allianceLogoUrl($imageServer, a.allianceID ?? 0)}
    <div class="ah-top">
      <span class="ah-logo"><OwnerPicture name={ownerName(a.allianceID)} urls={logo ? [logo] : []} size={128} /></span>
      <span class="ah-name">{ownerName(a.allianceID) || a.allianceName}</span>
      <button type="button" class="ah-info" title="Show Info" onclick={() => showInfo({ kind: "alliance", allianceID: a.allianceID ?? 0 })}>ⓘ</button>
    </div>
    <div class="ah-scroll">
      <div class="ah-group">{fill("UI/Common/Details")}</div>
      <div class="ah-row"><span>{fill(H + "AllianceName")}</span><button type="button" class="ah-link" onclick={() => showInfo({ kind: "alliance", allianceID: a.allianceID ?? 0 })}>{ownerName(a.allianceID)}</button></div>
      <div class="ah-row"><span>{fill(H + "Executor")}</span>{#if a.executorCorpID}<button type="button" class="ah-link" onclick={() => showInfo({ kind: "corporation", corporationID: a.executorCorpID! })}>{ownerName(a.executorCorpID)}</button>{:else}<span>-</span>{/if}</div>
      <div class="ah-row"><span>{fill(H + "ShortName")}</span><span>{a.shortName}</span></div>
      <div class="ah-row"><span>{fill("UI/Common/URL")}</span>{#if a.url}<a href={a.url} target="_blank" rel="noopener noreferrer">{a.url}</a>{:else}<span></span>{/if}</div>
      <div class="ah-top-row"><small>{fill("UI/Common/Description")}</small><span>{a.description}</span></div>
      <div class="ah-row"><span>{fill(H + "CreatedByCorporation")}</span><button type="button" class="ah-link" onclick={() => showInfo({ kind: "corporation", corporationID: a.creatorCorpID ?? 0 })}>{ownerName(a.creatorCorpID)}</button></div>
      <div class="ah-row"><span>{fill(H + "CreatedBy")}</span><button type="button" class="ah-link" onclick={() => showInfo({ kind: "character", characterID: a.creatorCharID ?? 0 })}>{ownerName(a.creatorCharID)}</button></div>
      <div class="ah-row"><span>{fill(H + "Dictatorial")}</span><span>{fill(a.dictatorial ? "UI/Common/Buttons/Yes" : "UI/Common/Buttons/No")}</span></div>
      <div class="ah-row"><span>{fill("UI/WarPermit/WarPermitStatus")}</span><span>{fill(warPermitLabel(data.allowWar))} <span class="ah-more" title={fill("UI/WarPermit/WarPermitExplanation")}>ⓘ</span></span></div>
    </div>
    {#if director}
      <div class="ah-buttons">
        <button type="button" onclick={() => { editUrl = a.url ?? ""; editDescription = a.description; editing = true; }}>{fill(H + "EditAlliance")}</button>
        <button type="button" onclick={() => (declaring = true)}>{fill(H + "DeclareWar")}</button>
      </div>
    {/if}
  {:else if loaded}
    <p class="ah-hint">{fill(H + "CorporationNotInAlliance", { corpName: resolvedName($names.resolved, "corporation", corporationID, "") })}</p>
    {#if ceoID !== null && ceoID === $station.online?.characterID}
      <div class="ah-buttons"><button type="button" disabled title="Not on the page yet">{fill(H + "CreateAlliance")}</button></div>
    {/if}
  {/if}
</div>

<style>
  .ah { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .ah-top { display: flex; align-items: center; gap: 8px; padding-bottom: 16px; }
  .ah-logo { width: 128px; height: 128px; display: grid; }
  .ah-name { font-size: 22px; }
  .ah-info, .ah-link { background: none; border: 0; padding: 0; color: inherit; cursor: pointer; }
  .ah-link { text-align: right; color: #d8b766; }
  .ah-scroll { flex: 1; overflow-y: auto; }
  .ah-group { padding: 2px 4px; background: rgba(255, 255, 255, 0.06); font-weight: bold; }
  .ah-row { display: flex; justify-content: space-between; gap: 8px; min-height: 19px; padding: 2px 4px; border-bottom: 1px solid rgba(255, 255, 255, 0.05); }
  .ah-top-row { display: flex; flex-direction: column; padding: 2px 4px; border-bottom: 1px solid rgba(255, 255, 255, 0.05); white-space: pre-wrap; }
  .ah-top-row small { opacity: 0.7; }
  .ah-more { cursor: help; opacity: 0.7; }
  .ah-buttons { display: flex; justify-content: center; gap: 4px; padding-top: 8px; }
  .ah-hint { opacity: 0.8; padding: 8px; }
  .ah-back { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; background: rgba(0, 0, 0, 0.35); }
  .ah-edit { width: 420px; height: 300px; display: flex; flex-direction: column; padding: 0 8px 8px; background: #15181b; border: 1px solid rgba(255, 255, 255, 0.15); }
  .ah-edit header { display: flex; justify-content: space-between; padding: 6px 0; font-weight: bold; }
  .ah-x { background: none; border: 0; color: inherit; font-size: 16px; cursor: pointer; }
  .ah-field-label { font-size: 11px; padding-bottom: 4px; }
  .ah-desc-label { padding-top: 16px; }
  .ah-edit textarea { flex: 1; resize: none; }
  .ah-edit-buttons { display: flex; justify-content: center; gap: 4px; padding-top: 16px; }
</style>
