<script lang="ts">
  // Alliances/all_ui_applications.py FormAlliancesApplications (Relationships > Applications, a player corporation's):
  // ShowRejected (viewRejected; the alliance tab only) over the scroll, a ToggleButtonGroup Alliance / My Applications
  // under it; both for a director (else RequireDirectorHint), the alliance's with an alliance (else
  // CorporationNotInAlliance {corpName}); headers Name, Status (New / Accepted / Effective / Rejected); NoApplicationsFound.
  // The alliance's: double-click or View - AllianceViewApplication (ViewApplicationDetails, 400 wide): From, Status,
  // TermsAndConditions; a new one Reject / Accept (Accept checked) and the AllianceApplicationText (1000, 96 high), OK /
  // Cancel - accepting with the corporation's wars asks AdoptWars first (WarsWillBeAdopted, each war, ConfirmAccept);
  // UpdateApplication(corpID, text, state), then AcceptedApplicationsTake24HoursToBecomeEffective where accepted.
  // Other states read-only, OK. My Applications: View - MyAllianceApplicationWnd (400 x 270: the alliance's logo 64,
  // YourApplicationToJoin, the text read-only, Status), and Delete for a new or rejected one (DeleteAllianceApplication).
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, AllianceApplication } from "../app/flow.ts";
  import type { CorpWar } from "../bridge/corpWars.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { allianceLogoUrl } from "./ownerImages.ts";
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
  const A = "UI/Corporations/CorporationWindow/Alliances/Applications/";
  const STATUS: Record<number, string> = { 1: "New", 2: "Accepted", 3: "Effective", 4: "Rejected" };
  const LABELS = ["ShowRejected", "MyApplications", "NoApplicationsFound", "CorporationNotInAlliance", "RequireDirectorHint", "Name", "Status", "View", "Delete", "From",
    "TermsAndConditions", "Reject", "Accept", "AllianceApplicationText", "ViewApplicationDetails", "Warning", "WarsWillBeAdopted", "ConfirmAccept", "AdoptWars",
    ...Object.values(STATUS)].map((k) => A + k)
    .concat(["UI/Corporations/CorporationWindow/Alliances/Alliance", "UI/Corporations/CorpApplications/ViewApplicationDetailCaption", "UI/Corporations/CorpApplications/YourApplicationToJoin",
      "UI/Corporations/BaseCorporationUI/CorporationApplicationText", "UI/Common/Buttons/OK", "UI/Common/Buttons/Cancel"]);
  const fill = (label: string, values: Record<string, unknown> = {}) =>
    plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") }));
  const nameOf = (id: number) => resolvedName($names.resolved, "owner", id, "") || String(id);
  const status = (s: number) => (STATUS[s] ? fill(A + STATUS[s]) : "");
  let tab = $state<"alliance" | "mine">("alliance"), showRejected = $state(false), apps = $state<readonly AllianceApplication[] | null>(null), error = $state("");
  let menuFor = $state<string | null>(null), viewing = $state<AllianceApplication | null>(null), decision = $state(2), decisionText = $state("");
  let adopting = $state<readonly CorpWar[] | null>(null), busy = $state(false);
  const online = $derived($station.online);
  const director = $derived((BigInt(online?.corpRole ?? "0") & 1n) === 1n);
  const hint = $derived(!director ? fill(A + "RequireDirectorHint")
    : tab === "alliance" && !online?.allianceID ? fill(A + "CorporationNotInAlliance", { corpName: resolvedName($names.resolved, "corporation", online?.corporationID ?? 0, "") }) : fill(A + "NoApplicationsFound"));
  function load(): void {
    apps = null;
    if (!director || (tab === "alliance" && !online?.allianceID)) { apps = []; return; }
    void flow.allianceApplications(tab === "mine", showRejected).then((a) => { apps = a; }, (e) => { error = e instanceof Error ? e.message : String(e); apps = []; });
  }
  onMount(() => { flow.requestWords(LABELS); flow.loadImageServer(); flow.requestNames([{ kind: "corporation", id: online?.corporationID ?? 0 }]); load(); });
  const key = (a: AllianceApplication) => `${a.allianceID}:${a.corporationID}`;
  function view(a: AllianceApplication): void { menuFor = null; viewing = a; decision = 2; decisionText = a.applicationText; adopting = null; }
  async function decide(): Promise<void> {
    const a = viewing;
    if (!a || busy) return;
    if (decision === 2 && adopting === null) {
      // the corporation's wars, which accepting adopts (war.GetWars(corporationID, 1))
      const wars = await flow.ownerWars(a.corporationID).catch(() => [] as readonly CorpWar[]);
      const now = BigInt(Date.now()) * 10000n + 116444736000000000n;
      const live = wars.filter((w) => w.timeFinished === null || w.timeFinished > now);
      if (live.length) { adopting = live; return; }
    }
    busy = true;
    try { if (await flow.allianceApplicationAct({ kind: "decide", corporationID: a.corporationID, text: decisionText, state: decision })) { viewing = null; load(); } }
    catch (e) { error = e instanceof Error ? e.message : String(e); } finally { busy = false; }
  }
  async function remove(a: AllianceApplication): Promise<void> {
    menuFor = null;
    try { await flow.allianceApplicationAct({ kind: "delete", allianceID: a.allianceID }); } catch (e) { error = e instanceof Error ? e.message : String(e); }
    load();
  }
</script>

{#if viewing && tab === "alliance"}
  {@const a = viewing}
  <div class="aa-back">
    <div class="aa-view" role="dialog" aria-modal="true" aria-label={fill(A + "ViewApplicationDetails")}>
      <header>{fill(adopting ? A + "AdoptWars" : A + "ViewApplicationDetails")}<button type="button" class="aa-x" aria-label="Close" onclick={() => (viewing = null)}>×</button></header>
      {#if adopting}
        <div class="aa-h">{fill(A + "Warning")}</div>
        <p>{fill(A + "WarsWillBeAdopted")}</p>
        {#each adopting as w (w.warID)}<p>{nameOf(w.declaredByID)} vs {nameOf(w.againstID)}</p>{/each}
        <p>{fill(A + "ConfirmAccept")}</p>
        <div class="aa-buttons"><button type="button" disabled={busy} onclick={() => void decide()}>{fill("UI/Common/Buttons/OK")}</button><button type="button" onclick={() => (viewing = null)}>{fill("UI/Common/Buttons/Cancel")}</button></div>
      {:else}
        <div class="aa-h">{fill(A + "From")}</div><p>{nameOf(a.corporationID)}</p>
        <div class="aa-h">{fill(A + "Status")}</div><p>{status(a.state)}</p>
        <div class="aa-h">{fill(A + "TermsAndConditions")}</div>
        {#if a.state === 1}
          <label class="aa-choice"><input type="radio" name="aa-state" value={4} bind:group={decision} />{fill(A + "Reject")}</label>
          <label class="aa-choice"><input type="radio" name="aa-state" value={2} bind:group={decision} />{fill(A + "Accept")}</label>
          <label class="aa-label" for="aa-text">{fill(A + "AllianceApplicationText")}</label>
          <textarea id="aa-text" maxlength="1000" bind:value={decisionText}></textarea>
          <div class="aa-buttons"><button type="button" disabled={busy} onclick={() => void decide()}>{fill("UI/Common/Buttons/OK")}</button><button type="button" onclick={() => (viewing = null)}>{fill("UI/Common/Buttons/Cancel")}</button></div>
        {:else}
          <div class="aa-lt"><span>{fill(A + "Status")}</span><span>{status(a.state)}</span></div>
          <textarea readonly value={a.applicationText}></textarea>
          <div class="aa-buttons"><button type="button" onclick={() => (viewing = null)}>{fill("UI/Common/Buttons/OK")}</button></div>
        {/if}
      {/if}
    </div>
  </div>
{/if}
{#if viewing && tab === "mine"}
  {@const a = viewing}
  {@const logo = allianceLogoUrl($imageServer, a.allianceID)}
  <div class="aa-back">
    <div class="aa-mine" role="dialog" aria-modal="true" aria-label={fill("UI/Corporations/CorpApplications/ViewApplicationDetailCaption")}>
      <header>{fill("UI/Corporations/CorpApplications/ViewApplicationDetailCaption")}<button type="button" class="aa-x" aria-label="Close" onclick={() => (viewing = null)}>×</button></header>
      <div class="aa-top"><span class="aa-logo"><OwnerPicture name={nameOf(a.allianceID)} urls={logo ? [logo] : []} size={64} /></span><span class="aa-title">{fill("UI/Corporations/CorpApplications/YourApplicationToJoin", { corpName: nameOf(a.allianceID) })}</span></div>
      <span class="aa-label">{fill("UI/Corporations/BaseCorporationUI/CorporationApplicationText")}</span>
      <textarea readonly value={a.applicationText}></textarea>
      <span class="aa-label">{fill(A + "Status")}</span><b>{status(a.state)}</b>
      <div class="aa-buttons"><button type="button" onclick={() => (viewing = null)}>{fill("UI/Common/Buttons/OK")}</button></div>
    </div>
  </div>
{/if}
<div class="aa">
  {#if tab === "alliance"}<label class="aa-rejected"><input type="checkbox" bind:checked={showRejected} onchange={() => load()} />{fill(A + "ShowRejected")}</label>{/if}
  {#if error}<p class="error">{error}</p>{/if}
  <div class="aa-scroll">
    {#if apps && apps.length}
      <div class="aa-row aa-head"><span>{fill(A + "Name")}</span><span>{fill(A + "Status")}</span></div>
      {#each apps as a (key(a))}
        <div class="aa-row" role="row" tabindex="-1" ondblclick={() => view(a)} oncontextmenu={(e) => { e.preventDefault(); menuFor = menuFor === key(a) ? null : key(a); }}>
          <span>{nameOf(tab === "mine" ? a.allianceID : a.corporationID)}</span><span>{status(a.state)}</span>
          {#if menuFor === key(a)}
            <div class="aa-menu" role="menu">
              <button type="button" role="menuitem" onclick={() => view(a)}>{fill(A + "View")}</button>
              {#if tab === "mine" && (a.state === 4 || a.state === 1)}<button type="button" role="menuitem" onclick={() => void remove(a)}>{fill(A + "Delete")}</button>{/if}
            </div>
          {/if}
        </div>
      {/each}
    {:else if apps}
      <p class="aa-hint">{hint}</p>
    {/if}
  </div>
  <div class="aa-tabs">
    <button type="button" class:active={tab === "alliance"} onclick={() => { tab = "alliance"; load(); }}>{fill("UI/Corporations/CorporationWindow/Alliances/Alliance")}</button>
    <button type="button" class:active={tab === "mine"} onclick={() => { tab = "mine"; load(); }}>{fill(A + "MyApplications")}</button>
  </div>
</div>

<style>
  .aa { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .aa-rejected { display: flex; gap: 4px; align-items: center; height: 18px; padding: 4px; }
  .aa-scroll { flex: 1; overflow-y: auto; margin: 4px; }
  .aa-row { position: relative; display: grid; grid-template-columns: 2fr 1fr; align-items: center; height: 19px; padding: 0 4px; border-bottom: 1px solid rgba(255, 255, 255, 0.05); cursor: default; }
  .aa-head { font-size: 11px; opacity: 0.7; }
  .aa-hint { opacity: 0.8; padding: 4px; }
  .aa-menu { position: absolute; left: 20px; top: 18px; z-index: 5; display: flex; flex-direction: column; min-width: 140px; padding: 4px; background: rgba(20, 22, 25, 0.97); border: 1px solid rgba(255, 255, 255, 0.15); }
  .aa-menu button { text-align: left; background: none; border: 0; color: inherit; padding: 3px 6px; cursor: pointer; }
  .aa-tabs { display: flex; gap: 2px; padding: 4px; }
  .aa-tabs button { flex: 1; }
  .aa-tabs button.active { background: rgba(255, 255, 255, 0.15); }
  .aa-back { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; background: rgba(0, 0, 0, 0.35); }
  .aa-view, .aa-mine { width: 400px; display: flex; flex-direction: column; padding: 0 8px 8px; background: #15181b; border: 1px solid rgba(255, 255, 255, 0.15); }
  .aa-view { min-height: 320px; }
  .aa-mine { height: 270px; }
  .aa-view header, .aa-mine header { display: flex; justify-content: space-between; padding: 6px 0; font-weight: bold; }
  .aa-x { background: none; border: 0; color: inherit; font-size: 16px; cursor: pointer; }
  .aa-h { font-weight: bold; padding-top: 4px; }
  .aa-view p { margin: 2px 0 4px; }
  .aa-choice { display: flex; align-items: center; gap: 4px; }
  .aa-lt { display: flex; justify-content: space-between; }
  .aa-label { font-size: 11px; padding-top: 4px; }
  .aa-view textarea, .aa-mine textarea { height: 96px; resize: none; }
  .aa-top { height: 68px; display: flex; gap: 8px; }
  .aa-logo { width: 64px; height: 64px; display: grid; }
  .aa-title { padding-top: 12px; font-size: 15px; }
  .aa-buttons { display: flex; justify-content: center; gap: 4px; padding-top: 8px; margin-top: auto; }
</style>
