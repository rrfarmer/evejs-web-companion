<script lang="ts">
  // corporation/corp_ui_votes.py CorpVotes (Corporation > Voting > Votes, where corpvotes.CanViewVotes): the Open Votes /
  // Closed Votes toggle at the top, the scroll (headers Title, Started, Ends; one ListGroup per vote case - GetVoteText:
  // the case's text, or for shares / war / lockdown / unlock / expel / general its VoteType label; FmtDate 'ls' for the
  // start and end; the description as its hint), and at the bottom Propose Vote (a director's) and Run For CEO (one not
  // the CEO with Corporation Management, where CanRunForCEO). Open: without CanViewVotes AccessDeniedOnlyShareholders,
  // none NoOpenVotes; a case opened (GetOpenVoteSubContent): each option numbered - VoteItemHasVoted for the one voted
  // for, else VoteItemCannotVote, where the pilot has voted or cannot vote; else VoteItemCanVote with a Vote button
  // (InsertVote, the button disabled at once); a lockdown / unlock case's item and where it is
  // (MoreInfoItemLocatedAtLocation). Closed: NoClosedVotes, a case opened (GetClosedVoteSubContent): each option and
  // ClosedVoteResultColumn (percentage of the votes, votes for, total). GetVoteOptionText: the option's text, or for
  // shares / war / lockdown / unlock / expel the label the option's number picks. OnVoteCaseChanged / OnVoteCast read
  // it again. Run For CEO: ProposeCEOVote's HybridWnd (ProposeVote; Title, VoteMemberForCEO {char} set, required, at
  // most 500; Description, at most 100; DaysToLive 1 to 5) then CreateVote.
  // Propose Vote: VoteWizardDialog (CorporationVoteWizard.svelte), modal.
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, CorporationVoteCase, CorporationVoteOption, CorporationVoting } from "../app/flow.ts";
  import { DATE_LABELS, formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import CorporationVoteWizard from "./CorporationVoteWizard.svelte";
  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const voteChanges = flow.corporationVoteChanges;
  const P = "UI/Corporations/CorporationWindow/Politics/";
  const TYPE_LABELS: Record<number, string> = { 2: "VoteTypeCreateShares", 1: "VoteTypeDeclareWar", 5: "VoteTypeLockBlueprint", 6: "VoteTypeUnlockBlueprint", 3: "VoteTypeKickMember", 4: "VoteTypeGeneral" };
  const LABELS = [...Object.values(TYPE_LABELS), "Title", "Started", "Ends", "Description", "NoClosedVotes", "NoOpenVotes", "AccessDeniedOnlyShareholders", "ProposeVote",
    "RunForCEO", "OpenVotes", "ClosedVotes", "VoteItemHasVoted", "VoteItemCannotVote", "Vote", "VoteItemCanVote", "MoreInfoItemLocatedAtLocation",
    "ClosedVoteResultColumn", "VoteMemberForCEO", "DaysToLive", "CreateShares", "DoNotCreateShares", "DeclareWarAgainst", "DontDeclareWar", "LockdownItem",
    "DontLockdownItem", "UnlockItem", "DontUnlockItem", "ExpelFromCorporation", "DontExpelCorporationMember"].map((k) => P + k)
    .concat(["UI/Generic/OK", "UI/Generic/Cancel", DATE_LABELS.ls!]);
  const nameAny = (k: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, k, id, "");
  const fill = (label: string, values: Record<string, unknown> = {}) => formatTemplate($words.templates[label] ?? "", values as never, { nameOf: nameAny });
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(fill(label, values));
  const date = (t: bigint | null) => (t === null ? "" : word(DATE_LABELS.ls!, { datetime: { type: "long", value: t.toString() } }));

  let tab = $state<"open" | "closed">("open");
  let voting = $state<CorporationVoting | null>(null), error = $state("");
  let opened = $state<Record<number, { options: readonly CorporationVoteOption[]; votedFor: number; canVote: boolean } | "loading">>({});
  let casting = $state<Record<string, boolean>>({});
  let read = 0;
  async function load(): Promise<void> {
    const request = ++read;
    try {
      const v = await flow.corporationVoting();
      if (request !== read) return;
      voting = v; error = "";
      // ReloadVoteCaseSubContentIfVisible: an opened case reads its options again.
      for (const id of Object.keys(opened)) void openCase(Number(id), true);
    } catch (e) { if (request === read) error = e instanceof Error ? e.message : String(e); }
  }
  onMount(() => { flow.requestWords(LABELS); });
  // RefreshVotes on the toggle and on OnVoteCaseChanged / OnVoteCast.
  $effect(() => { void $voteChanges; void load(); });
  async function openCase(id: number, again = false): Promise<void> {
    if (!again && opened[id]) { const next = { ...opened }; delete next[id]; opened = next; return; }
    if (!again) opened = { ...opened, [id]: "loading" };
    try {
      const detail = await flow.corporationVoteOptions(id);
      for (const o of detail.options) if (o.parameter1) flow.requestNames([{ kind: "type", id: o.parameter1 }]);
      if (opened[id] !== undefined) opened = { ...opened, [id]: detail };
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
  }
  const voteText = (v: CorporationVoteCase) => (TYPE_LABELS[v.voteType] ? word(P + TYPE_LABELS[v.voteType]) : v.voteCaseText);
  const typeName = (id: number) => nameAny("type", id) || String(id);
  function optionText(o: CorporationVoteOption, v: CorporationVoteCase): string {
    const first = o.optionID === 0;
    switch (v.voteType) {
      case 2: return first ? word(P + "CreateShares", { shares: o.parameter }) : word(P + "DoNotCreateShares");
      case 1: return first ? word(P + "DeclareWarAgainst", { Name: nameAny("owner", o.parameter) }) : word(P + "DontDeclareWar");
      case 5: return word(P + (first ? "LockdownItem" : "DontLockdownItem"), { item: o.parameter1 });
      case 6: return word(P + (first ? "UnlockItem" : "DontUnlockItem"), { item: o.parameter1 });
      case 3: return first ? word(P + "ExpelFromCorporation", { char: o.parameter }) : word(P + "DontExpelCorporationMember");
      default: return o.optionText;
    }
  }
  async function cast(v: CorporationVoteCase, o: CorporationVoteOption): Promise<void> {
    casting = { ...casting, [`${v.voteCaseID}:${o.optionID}`]: true };
    await flow.castCorporationVote(v.voteCaseID, o.optionID);
  }
  const cases = $derived(voting ? (tab === "open" ? voting.open : voting.closed) : []);
  const hint = $derived(!voting ? "" : tab === "open" && !voting.canView ? word(P + "AccessDeniedOnlyShareholders") : tab === "open" ? word(P + "NoOpenVotes") : word(P + "NoClosedVotes"));
  // ProposeCEOVote's HybridWnd.
  let proposing = $state(false);
  let ceoForm = $state<{ title: string; description: string; days: number } | null>(null), ceoBusy = $state(false);
  function openCeoForm(): void { ceoForm = { title: word(P + "VoteMemberForCEO", { char: $station.online?.characterID ?? 0 }), description: "", days: 1 }; }
  async function submitCeo(): Promise<void> {
    if (!ceoForm || !ceoForm.title.trim()) return;
    ceoBusy = true;
    try { if (await flow.runForCEO(ceoForm.title, ceoForm.description, Math.max(1, Math.min(5, Math.trunc(ceoForm.days) || 1)))) ceoForm = null; }
    finally { ceoBusy = false; }
  }
</script>

<div class="cv">
  <div class="cv-toggle">
    <button class:active={tab === "open"} onclick={() => { tab = "open"; }}>{word(P + "OpenVotes")}</button>
    <button class:active={tab === "closed"} onclick={() => { tab = "closed"; }}>{word(P + "ClosedVotes")}</button>
  </div>
  {#if error}<p class="error">{error}</p>{/if}
  <div class="cv-scroll">
    <div class="cv-head"><span>{word(P + "Title")}</span><span>{word(P + "Started")}</span><span>{word(P + "Ends")}</span></div>
    {#each cases as v (v.voteCaseID)}
      {@const detail = opened[v.voteCaseID]}
      <button class="cv-group" title={v.description} onclick={() => void openCase(v.voteCaseID)}>
        <span>{detail ? "▾" : "▸"} {voteText(v)}</span><span>{date(v.startDateTime)}</span><span>{date(v.endDateTime)}</span>
      </button>
      {#if detail && detail !== "loading"}
        {#if tab === "open"}
          {#each detail.options as o, i (o.optionID)}
            {#if detail.votedFor >= 0 || !detail.canVote}
              <div class="cv-sub">{word(P + (o.optionID === detail.votedFor ? "VoteItemHasVoted" : "VoteItemCannotVote"), { optionNumber: i + 1, optionText: optionText(o, v) })}</div>
            {:else}
              <div class="cv-sub cv-can"><span>{word(P + "VoteItemCanVote", { optionNumber: i + 1, optionText: optionText(o, v) })}</span>
                <button disabled={casting[`${v.voteCaseID}:${o.optionID}`]} onclick={() => void cast(v, o)}>{word(P + "Vote")}</button></div>
            {/if}
          {/each}
        {:else}
          {@const total = detail.options.reduce((n, o) => n + o.votesFor, 0)}
          {#each detail.options as o (o.optionID)}
            <div class="cv-sub cv-result"><span>{optionText(o, v)}</span><span>{word(P + "ClosedVoteResultColumn", { percentage: total > 0 ? (o.votesFor / total) * 100 : 0, votesFor: o.votesFor, totalVotes: total })}</span></div>
          {/each}
        {/if}
        {#if v.voteType === 5 || v.voteType === 6}
          {#each detail.options.filter((o) => o.parameter) as o (o.optionID)}
            <div class="cv-sub cv-line">{word(P + "MoreInfoItemLocatedAtLocation", { item: o.parameter1, loc: o.parameter2 })}</div>
          {/each}
        {/if}
      {/if}
    {:else}
      {#if voting}<p class="cv-hint">{hint}</p>{/if}
    {/each}
  </div>
  {#if voting && (voting.canPropose || voting.canRunForCEO)}
    <div class="cv-buttons">
      {#if voting.canPropose}<button onclick={() => { proposing = true; }}>{word(P + "ProposeVote")}</button>{/if}
      {#if voting.canRunForCEO}<button onclick={openCeoForm}>{word(P + "RunForCEO")}</button>{/if}
    </div>
  {/if}
  {#if proposing}<CorporationVoteWizard {store} {flow} onClose={() => { proposing = false; }} />{/if}
  {#if ceoForm}
    {@const f = ceoForm}
    <div class="cv-modal-back">
      <div class="cv-modal" role="dialog" aria-label={word(P + "ProposeVote")}>
        <header>{word(P + "ProposeVote")}</header>
        <label>{word(P + "Title")}<input bind:value={f.title} maxlength="500" required /></label>
        <label>{word(P + "Description")}<textarea bind:value={f.description} maxlength="100"></textarea></label>
        <label>{word(P + "DaysToLive")}<input type="number" min="1" max="5" bind:value={f.days} /></label>
        <footer><button disabled={ceoBusy || !f.title.trim()} onclick={() => void submitCeo()}>{word("UI/Generic/OK")}</button><button onclick={() => { ceoForm = null; }}>{word("UI/Generic/Cancel")}</button></footer>
      </div>
    </div>
  {/if}
</div>

<style>
  .cv { position: relative; display: flex; flex-direction: column; height: 100%; padding: 4px; box-sizing: border-box; }
  .cv-toggle { display: flex; margin-bottom: 8px; }
  .cv-toggle button { flex: 1; }
  .cv-toggle button.active { background: rgba(255, 255, 255, 0.15); }
  .cv-scroll { flex: 1; min-height: 0; overflow: auto; }
  .cv-head, .cv-group { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 6px; }
  .cv-head { font-size: 11px; opacity: 0.65; padding: 2px 4px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); }
  .cv-group { all: unset; display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 6px; height: 19px; align-items: center; padding: 0 4px; cursor: pointer; width: 100%; box-sizing: border-box; }
  .cv-group:hover { background: rgba(255, 255, 255, 0.06); }
  .cv-sub { padding: 2px 4px 2px 22px; min-height: 19px; display: flex; align-items: center; }
  .cv-can { justify-content: space-between; }
  .cv-result { display: grid; grid-template-columns: 2fr 1fr; }
  .cv-line { border-top: 1px solid rgba(255, 255, 255, 0.1); opacity: 0.8; }
  .cv-hint { text-align: center; opacity: 0.65; }
  .cv-buttons { height: 25px; margin-top: 4px; display: flex; justify-content: center; gap: 6px; }
  .cv-modal-back { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.4); z-index: 5; }
  .cv-modal { min-width: 320px; display: flex; flex-direction: column; gap: 8px; padding: 8px; background: #1b1d21; border: 1px solid rgba(255, 255, 255, 0.15); }
  .cv-modal header { font-weight: bold; }
  .cv-modal label { display: flex; flex-direction: column; gap: 2px; }
  .cv-modal footer { display: flex; justify-content: flex-end; gap: 6px; }
</style>
