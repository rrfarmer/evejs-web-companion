<script lang="ts">
  // corporation/corp_ui_applications.py ApplicationsWindow for the corporation (Administration > Recruitment >
  // Applications to Corporation): the top row - the status filter (a UtilMenu: each status but "invitation rejected",
  // kept as applicationStatus_<n>, none chosen meaning Unprocessed; Show Old Applications) and a quick filter on the
  // applicant's name -; Invite to Corporation for a personnel manager (InviteToCorpWnd: shown, not acting here); the
  // entries (CorpApplicationEntry, newest first, one expanded - corporation_applications_expanded[False]): the
  // applicant's portrait 48, "<b>name - status</b><br>ApplicationDate", Invite Applicant (status 0: accepted by the
  // corporation, 6) and Reject Application (any open status: RejectCorpApplicationWnd - 400 x 400, the applicant and
  // date, ApplicationRejectionText, the message (1000), ApplicationRejectionRegards; Reject: status 4 with the message).
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { APPLICATION_STATUS_LABELS, applicationEnded, type CorporationApplication } from "../bridge/corporationApplications.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { showInfo } from "./showInfo.ts";
  import { portraitUrl } from "./ownerImages.ts";
  import OwnerPicture from "./OwnerPicture.svelte";
  import LabelText from "./LabelText.svelte";
  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const imageServer = flow.imageServer;
  const P = "UI/Corporations/CorpApplications/";
  const LABELS = [P + "FilterByStatus", P + "InviteToCorp", P + "NoApplicationsFound", P + "ApplicationInviteApplicant", P + "RejectApplication",
    P + "ShowOldApplications", P + "ApplicationRejectionText", P + "ApplicationRejectionRegards", P + "CorpRejectionMessage",
    "UI/Corporations/Applications/ApplicationRejection", "UI/Corporations/Applications/ApplicationDate", "UI/Common/Buttons/Cancel"];
  const fill = (label: string, fallback: string, values: Record<string, unknown> = {}) =>
    plainText(formatTemplate($words.templates[label] ?? fallback, values as never, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") }));
  const nameOf = (id: number) => resolvedName($names.resolved, "owner", id, "…");
  const manager = $derived((BigInt($station.online?.corpRole ?? "0") & 128n) === 128n);
  const me = $station.online?.characterID ?? 0;
  // settings.char.ui: applicationStatus_<n>, applicationsShowOld_<corpID>, applicationsQuickFilter_OwnerID<corpID>
  const key = (k: string) => `evejs.play.corpApplications.${me}.${k}`;
  const read = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(key(k)); return v === null ? d : JSON.parse(v) as T; } catch { return d; } };
  const keep = (k: string, v: unknown) => { try { localStorage.setItem(key(k), JSON.stringify(v)); } catch { /* not kept */ } };
  const STATUSES = Object.keys(APPLICATION_STATUS_LABELS).map(Number);
  // InitViewingStatus: the statuses kept on; none - Unprocessed (0), kept on
  let viewing = $state<number[]>((() => { const on = STATUSES.filter((s) => read(`status${s}`, false)); if (on.length) return on; keep("status0", true); return [0]; })());
  let showOld = $state<boolean>(read("showOld", false)), filter = $state<string>(read("filter", "")), statusMenu = $state(false);
  let rows = $state<readonly CorporationApplication[] | null>(null), error = $state(""), busy = $state(false);
  let expanded = $state<number | null>(read("expanded", null));
  let rejecting = $state<CorporationApplication | null>(null), message = $state("");
  // InviteToCorpWnd (320 x 400): "Type search string", the name (32) and Search - lookupSvc.LookupEvePlayerCharacters;
  // the characters found (a click selects, a double click invites), Invite (disabled until one is selected) and Cancel
  const INVITE_LABELS = ["UI/Messages/1527/SelectCharacterTitle", "UI/Shared/TypeSearchString", "UI/Wallet/WalletWindow/WalletSearch", "UI/Ship/ShipConfig/Invite",
    "UI/Common/TypeInSearch", "UI/Shared/PleaseTypeSomething", "EVE/UI/Wallet/WalletWindow/SearchNoResults"];
  let inviting = $state(false), lookup = $state(""), found = $state<readonly number[] | null>(null), hint = $state(""), chosen = $state<number | null>(null);
  async function search(): Promise<void> {
    chosen = null;
    if (!lookup.trim()) { found = []; hint = fill("UI/Shared/PleaseTypeSomething", "Please type something"); return; }
    try { found = await flow.lookupPlayerCharacters(lookup.trim()); hint = found.length ? "" : fill("EVE/UI/Wallet/WalletWindow/SearchNoResults", "No results"); }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
  }
  async function invite(id: number | null): Promise<void> {
    if (id === null) return;
    if (await flow.inviteToJoinCorp(id)) { inviting = false; void load(); }
  }
  async function load(): Promise<void> {
    try { rows = await flow.corporationApplicationsToCorp(showOld); error = ""; } catch (e) { error = e instanceof Error ? e.message : String(e); rows = []; }
  }
  onMount(() => { flow.requestWords([...LABELS, ...INVITE_LABELS, ...Object.values(APPLICATION_STATUS_LABELS).map((l) => P + l)]); flow.loadImageServer(); void load(); });
  // GetApplications: the statuses viewed, then the name filter
  const shown = $derived((rows ?? []).filter((r) => showOld || viewing.includes(r.status))
    .filter((r) => !filter || nameOf(r.characterID).toLowerCase().includes(filter.toLowerCase())));
  function toggleStatus(s: number): void {
    const on = viewing.includes(s);
    keep(`status${s}`, !on);
    viewing = on ? viewing.filter((v) => v !== s) : [...viewing, s];
  }
  function expand(id: number): void { expanded = expanded === id ? null : id; keep("expanded", expanded); }
  async function decide(row: CorporationApplication, status: 4 | 6, text = ""): Promise<void> {
    if (busy) return;
    busy = true;
    try { await flow.corporationApplicationReview(row, status, text); rejecting = null; message = ""; await load(); }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { busy = false; }
  }
  const dateText = (row: CorporationApplication) => fill("UI/Corporations/Applications/ApplicationDate", "{[datetime]applicationDateTime}", { applicationDateTime: row.date.toString() });
  const corpName = $derived(resolvedName($names.resolved, "corporation", $station.online?.corporationID ?? 0, ""));
  $effect(() => { const id = $station.online?.corporationID; if (id) flow.requestNames([{ kind: "corporation", id }]); });
</script>

<section class="corp-apps" aria-label={fill(P + "ApplicationsToCorp", "Applications")}>
  <div class="ca-top">
    <button type="button" class="ca-status" title={fill(P + "FilterByStatus", "Filter by status")} aria-expanded={statusMenu} onclick={() => (statusMenu = !statusMenu)}>⚑</button>
    <input class="ca-filter" bind:value={filter} placeholder="Filter" onchange={() => keep("filter", filter)} />
    {#if statusMenu}
      <div class="ca-status-menu" role="menu">
        {#each STATUSES.filter((s) => s !== 3) as s (s)}
          <label><input type="checkbox" checked={viewing.includes(s)} onchange={() => toggleStatus(s)} />{fill(P + APPLICATION_STATUS_LABELS[s], APPLICATION_STATUS_LABELS[s] ?? "")}</label>
        {/each}
        <hr />
        <label><input type="checkbox" checked={showOld} onchange={() => { showOld = !showOld; keep("showOld", showOld); void load(); }} />{fill(P + "ShowOldApplications", "Show old applications")}</label>
      </div>
    {/if}
  </div>
  {#if error}<p class="error">{error}</p>{/if}
  <div class="ca-scroll">
    {#if rows !== null && !shown.length}<p class="ca-empty">{fill(P + "NoApplicationsFound", "No applications found")}</p>{/if}
    {#each [...shown].sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0)) as row (row.applicationID)}
      {@const url = portraitUrl($imageServer, row.characterID, 64)}
      <article class="ca-entry">
        <div class="ca-head">
          <button type="button" class="ca-expander" aria-expanded={expanded === row.applicationID} onclick={() => expand(row.applicationID)}>{expanded === row.applicationID ? "▾" : "▸"}</button>
          <button type="button" class="ca-portrait" onclick={() => showInfo({ kind: "character", characterID: row.characterID })}><OwnerPicture name={nameOf(row.characterID)} urls={url ? [url] : []} size={48} /></button>
          <button type="button" class="ca-name" onclick={() => expand(row.applicationID)}>
            <b>{nameOf(row.characterID)} - <span class="ca-st">{fill(P + (APPLICATION_STATUS_LABELS[row.status] ?? ""), "")}</span></b><br />{dateText(row)}
          </button>
          {#if manager}
            <span class="ca-buttons">
              {#if row.status === 0}<button type="button" disabled={busy} onclick={() => void decide(row, 6)}>{fill(P + "ApplicationInviteApplicant", "Invite Applicant")}</button>{/if}
              {#if !applicationEnded(row.status)}<button type="button" disabled={busy} onclick={() => { rejecting = row; message = ""; }}>{fill(P + "RejectApplication", "Reject Application")}</button>{/if}
            </span>
          {/if}
        </div>
        {#if expanded === row.applicationID}<div class="ca-text"><LabelText markup={row.displayText} /></div>{/if}
      </article>
    {/each}
  </div>
  {#if manager}<div class="ca-bottom"><button type="button" onclick={() => { inviting = true; lookup = ""; found = null; chosen = null; hint = fill("UI/Common/TypeInSearch", "Type in a search"); }}>{fill(P + "InviteToCorp", "Invite to Corporation")}</button></div>{/if}
  {#if inviting}
    <div class="ca-reject-back">
      <div class="ca-invite" role="dialog" aria-modal="true" aria-label={fill("UI/Messages/1527/SelectCharacterTitle", "Select Character")}>
        <header>{fill("UI/Messages/1527/SelectCharacterTitle", "Select Character")}</header>
        <div class="ca-invite-top">
          <span class="small">{fill("UI/Shared/TypeSearchString", "Type search string")}</span>
          <span class="ca-invite-row"><input bind:value={lookup} maxlength="32" onkeydown={(e) => { if (e.key === "Enter") void search(); }} />
            <button type="button" onclick={() => void search()}>{fill("UI/Wallet/WalletWindow/WalletSearch", "Search")}</button></span>
        </div>
        <div class="ca-invite-list" role="listbox">
          {#if hint}<p class="ca-empty">{hint}</p>{/if}
          {#each found ?? [] as id (id)}
            <div role="option" tabindex="0" aria-selected={chosen === id} class:picked={chosen === id} onclick={() => (chosen = id)} ondblclick={() => void invite(id)} onkeydown={(e) => { if (e.key === "Enter") void invite(id); }}>{nameOf(id)}</div>
          {/each}
        </div>
        <div class="ca-reject-buttons">
          <button type="button" disabled={chosen === null} onclick={() => void invite(chosen)}>{fill("UI/Ship/ShipConfig/Invite", "Invite")}</button>
          <button type="button" onclick={() => (inviting = false)}>{fill("UI/Common/Buttons/Cancel", "Cancel")}</button>
        </div>
      </div>
    </div>
  {/if}
  {#if rejecting}
    {@const row = rejecting}
    {@const url = portraitUrl($imageServer, row.characterID, 64)}
    <div class="ca-reject-back">
      <div class="ca-reject" role="dialog" aria-modal="true" aria-label={fill("UI/Corporations/Applications/ApplicationRejection", "Application Rejection")}>
        <header>{fill("UI/Corporations/Applications/ApplicationRejection", "Application Rejection")}</header>
        <div class="ca-reject-top">
          <OwnerPicture name={nameOf(row.characterID)} urls={url ? [url] : []} size={48} />
          <span><button type="button" class="ca-link" onclick={() => showInfo({ kind: "character", characterID: row.characterID })}>{nameOf(row.characterID)}</button><br />{dateText(row)}</span>
        </div>
        <div class="ca-reject-body">
          <p>{fill(P + "ApplicationRejectionText", "Dear {charName}, your application to {corpName} has been rejected.", { charName: nameOf(row.characterID), corpName })}</p>
          <textarea bind:value={message} maxlength="1000" placeholder={fill(P + "CorpRejectionMessage", "Message")}></textarea>
          <p>{fill(P + "ApplicationRejectionRegards", "Regards, {corpName}", { corpName })}</p>
        </div>
        <div class="ca-reject-buttons">
          <button type="button" disabled={busy} onclick={() => void decide(row, 4, message)}>{fill(P + "RejectApplication", "Reject Application")}</button>
          <button type="button" onclick={() => (rejecting = null)}>{fill("UI/Common/Buttons/Cancel", "Cancel")}</button>
        </div>
      </div>
    </div>
  {/if}
</section>

<style>
  .corp-apps { display: flex; flex-direction: column; height: 100%; min-height: 360px; }
  .ca-top { position: relative; height: 20px; display: flex; justify-content: flex-end; gap: 4px; padding: 4px; }
  .ca-filter { width: 100px; }
  .ca-status { background: none; border: 0; color: inherit; cursor: pointer; }
  .ca-status-menu { position: absolute; right: 110px; top: 26px; z-index: 3; display: flex; flex-direction: column; padding: 6px; background: rgba(20, 22, 25, 0.97); border: 1px solid rgba(255, 255, 255, 0.15); }
  .ca-scroll { flex: 1; overflow: auto; padding: 4px; }
  .ca-empty { opacity: 0.6; }
  .ca-entry { border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
  .ca-head { height: 53px; display: flex; align-items: center; gap: 2px; }
  .ca-expander, .ca-name, .ca-portrait, .ca-link { background: none; border: 0; color: inherit; cursor: pointer; padding: 0; text-align: left; }
  .ca-portrait { width: 48px; height: 48px; }
  .ca-name { flex: 1; min-width: 0; padding-left: 6px; font-size: 14px; }
  .ca-st { font-size: 12px; }
  .ca-buttons { display: flex; gap: 4px; padding-right: 4px; }
  .ca-text { background: rgba(0, 0, 0, 0.2); padding: 4px 4px 8px 70px; white-space: pre-wrap; }
  .ca-bottom { display: flex; justify-content: center; padding: 6px; }
  .ca-reject-back { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; background: rgba(0, 0, 0, 0.35); }
  .ca-reject { width: 400px; height: 400px; display: flex; flex-direction: column; background: #15181b; border: 1px solid rgba(255, 255, 255, 0.15); }
  .ca-reject header { padding: 4px 6px; font-weight: bold; }
  .ca-reject-top { height: 58px; display: flex; gap: 8px; padding: 6px 8px 0; }
  .ca-reject-top span { padding-top: 6px; }
  .ca-link { color: rgb(224, 224, 224); text-decoration: underline; }
  .ca-reject-body { flex: 1; display: flex; flex-direction: column; padding: 8px; min-height: 0; }
  .ca-reject-body textarea { flex: 1; resize: none; margin-top: 4px; }
  .ca-reject-body p { margin: 0; }
  .ca-reject-body p:last-child { padding-top: 4px; }
  .ca-reject-buttons { display: flex; gap: 4px; justify-content: center; padding: 6px; }
  .ca-invite { width: 320px; height: 400px; display: flex; flex-direction: column; background: #15181b; border: 1px solid rgba(255, 255, 255, 0.15); }
  .ca-invite header { padding: 4px 6px; font-weight: bold; }
  .ca-invite-top { height: 70px; display: flex; flex-direction: column; gap: 2px; padding: 16px 4px 0 70px; }
  .ca-invite-row { display: flex; gap: 2px; }
  .ca-invite-row input { width: 86px; }
  .small { font-size: 11px; }
  .ca-invite-list { flex: 1; overflow: auto; margin: 4px; border: 1px solid rgba(255, 255, 255, 0.1); }
  .ca-invite-list div { height: 18px; padding: 0 4px; cursor: default; }
  .ca-invite-list div.picked { background: rgba(255, 255, 255, 0.12); }
</style>
