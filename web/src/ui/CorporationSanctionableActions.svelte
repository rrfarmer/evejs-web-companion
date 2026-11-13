<script lang="ts">
  // corporation/corp_ui_sanctionableactions.py CorpSanctionableActions (Corporation > Voting > Sanctionable Actions): the
  // In Effect / Not In Effect toggle; headers Type, Title, Description, Expires, Acted Upon, In Effect, Rescinded; one
  // ListGroup per action (the type: NewCEO, DeclarationOfWar, CreationOfShares, Expulsion, GeneralVote, UnlockBlueprint,
  // LockBlueprint; an action of CEO / war / shares / expel / lock / unlock with no parameter left out; the case's title
  // and description - in effect up to the first <br> -, an ItemInAssetSafetyWrap|structure description as its label;
  // FmtDate; No / Yes, AnswerWithTimestamp where a time was kept); without CanViewVotes MustBeCEODirectorOrShareholder;
  // none NoSanctionableActionsInEffect / NoNotInEffect. Show All at the bottom on Not In Effect only: it asks
  // ConfirmShowAllSanctionableActions (Yes suppressible) and lists the expired ones, the button gone. Opened: a general
  // vote's Decision (GetVoteCaseOptions[optionID]'s text); in effect MoreInfoEntry {ownerName} or
  // MoreInfoTypeNameAndLocation {typeID, location}; not in effect, for the active CEO where unexpired and not acted on
  // (not a CEO vote): ImplementAction with Apply (ActivateSanctionedAction; MustBeCEOToSanction otherwise), then
  // MoreInfo and the owner, or the type and LocatedAt {location}. OnSanctionedActionChanged reads it again.
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, CorporationSanctionedAction } from "../app/flow.ts";
  import { DATE_LABELS, formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const changes = flow.corporationSanctionChanges;
  const S = "UI/Corporations/CorpSanctionableActions/";
  const TYPE_LABELS: Record<number, string> = { 0: "NewCEO", 1: "DeclarationOfWar", 2: "CreationOfShares", 3: "Expulsion", 4: "GeneralVote", 6: "UnlockBlueprint", 5: "LockBlueprint" };
  const HEADERS = ["Type", "Title", "Description", "Expires", "ActedUpon", "InEffect", "Rescinded"];
  const LABELS = [...Object.values(TYPE_LABELS), ...HEADERS, "NotInEffect", "ShowAll", "NoSanctionableActionsInEffect", "NoNotInEffect", "AnswerWithTimestamp", "MoreInfoEntry",
    "MoreInfoTypeNameAndLocation", "ImplementAction", "MoreInfo", "LocatedAt", "MustBeCEOToSanction", "Decision", "ItemInAssetSafetyWrap"].map((k) => S + k)
    .concat(["UI/Corporations/AccessRestrictions/MustBeCEODirectorOrShareholder", "UI/Generic/No", "UI/Generic/Yes", "UI/Commands/Apply", DATE_LABELS.ll!]);
  const nameAny = (k: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, k, id, "");
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: nameAny }));
  // A label whose <t> tab stops lay it out in columns.
  const cols = (label: string, values: Record<string, unknown> = {}) => formatTemplate($words.templates[label] ?? "", values as never, { nameOf: nameAny }).split(/<t>/i).map((part) => plainText(part));
  const date = (t: bigint) => word(DATE_LABELS.ll!, { datetime: { type: "long", value: t.toString() } });
  onMount(() => { flow.requestWords(LABELS); });

  let tab = $state<"ineffect" | "notineffect">("ineffect"), expired = $state(false);
  let read = $state<Awaited<ReturnType<AppFlow["corporationSanctionedActions"]>> | null>(null), error = $state("");
  let opened = $state<Record<number, string | true>>({});
  let request = 0;
  async function load(): Promise<void> {
    const r = ++request;
    try {
      const v = await flow.corporationSanctionedActions(tab === "ineffect" ? 1 : expired ? 0 : 2);
      if (r === request) { read = v; error = ""; opened = {}; }
    } catch (e) { if (r === request) error = e instanceof Error ? e.message : String(e); }
  }
  // Refresh on the toggle and on OnSanctionedActionChanged.
  $effect(() => { void $changes; void tab; void expired; void load(); });
  async function showAll(): Promise<void> {
    if (!(await flow.askClientDialog("ConfirmShowAllSanctionableActions", "Show all the sanctionable actions, the expired ones too?", true))) return;
    expired = true;
  }
  function choose(next: "ineffect" | "notineffect"): void { tab = next; expired = false; }
  // GetDescription: ItemInAssetSafetyWrap|structureID.
  function description(text: string): string {
    if (text.startsWith("ItemInAssetSafetyWrap")) return word(S + "ItemInAssetSafetyWrap", { structure: Number(text.split("|")[1] ?? 0) });
    return text;
  }
  const firstLine = (text: string) => (tab === "ineffect" ? text.split("<br>")[0] ?? "" : text);
  function answer(flag: boolean, time: bigint | null): string {
    const a = word(flag ? "UI/Generic/Yes" : "UI/Generic/No");
    return time ? word(S + "AnswerWithTimestamp", { answer: a, timestamp: date(time) }) : a;
  }
  // Rescinded is always No, with the time where one was kept.
  const rescinded = (a: CorporationSanctionedAction) => (a.timeRescended ? word(S + "AnswerWithTimestamp", { answer: word("UI/Generic/No"), timestamp: date(a.timeRescended) }) : word("UI/Generic/No"));
  async function toggle(a: CorporationSanctionedAction): Promise<void> {
    if (opened[a.voteCaseID] !== undefined) { const next = { ...opened }; delete next[a.voteCaseID]; opened = next; return; }
    opened = { ...opened, [a.voteCaseID]: a.voteType === 4 ? await flow.sanctionedDecision(a.voteCaseID, a.optionID) : true };
  }
  const placeName = (id: number) => nameAny(id >= 60_000_000 && id < 64_000_000 ? "station" : "structure", id);
  async function apply(a: CorporationSanctionedAction): Promise<void> {
    if (!read?.activeCEO) { flow.sayDialog("CustomError", { type: "dict", entries: [["error", word(S + "MustBeCEOToSanction")]] } as never, word(S + "MustBeCEOToSanction")); return; }
    await flow.applySanctionedAction(a.voteCaseID);
    tab = "notineffect"; expired = false; void load();
  }
  const now = () => BigInt(Date.now()) * 10000n + 116444736000000000n;
  const rows = $derived(read ? read.actions.filter((a) => !([6, 0, 1, 2, 3, 5].includes(a.voteType) && a.parameter === 0)) : []);
</script>

<div class="sa">
  <div class="sa-toggle">
    <button class:active={tab === "ineffect"} onclick={() => choose("ineffect")}>{word(S + "InEffect")}</button>
    <button class:active={tab === "notineffect"} onclick={() => choose("notineffect")}>{word(S + "NotInEffect")}</button>
  </div>
  {#if error}<p class="error">{error}</p>{/if}
  <div class="sa-scroll">
    <div class="sa-row sa-head">{#each HEADERS as h (h)}<span>{word(S + h)}</span>{/each}</div>
    {#if read && !read.canView}
      <p class="sa-hint">{word("UI/Corporations/AccessRestrictions/MustBeCEODirectorOrShareholder")}</p>
    {:else}
      {#each rows as a (a.voteCaseID)}
        {@const open = opened[a.voteCaseID]}
        <button class="sa-row sa-group" onclick={() => void toggle(a)}>
          <span>{open !== undefined ? "▾" : "▸"} {word(S + TYPE_LABELS[a.voteType]!)}</span><span>{firstLine(a.voteCaseText)}</span><span>{description(firstLine(a.description))}</span>
          <span>{date(a.expires)}</span><span>{answer(a.actedUpon, a.timeActedUpon)}</span><span>{answer(a.inEffect, null)}</span><span>{rescinded(a)}</span>
        </button>
        {#if open !== undefined}
          {#if a.voteType === 4}
            <div class="sa-sub sa-label"><span>{word(S + "Decision")}</span><span>{open}</span></div><hr />
          {:else if tab === "ineffect"}
            <div class="sa-sub sa-line sa-cols">{#if [0, 1, 3].includes(a.voteType)}{#each cols(S + "MoreInfoEntry", { ownerName: nameAny("owner", a.parameter) }) as part, i (i)}<span>{part}</span>{/each}{:else if a.voteType === 5 || a.voteType === 6}{#each cols(S + "MoreInfoTypeNameAndLocation", { typeID: a.parameter1, location: a.parameter2 }) as part, i (i)}<span>{part}</span>{/each}{/if}</div>
          {:else}
            {#if a.voteType !== 0 && read?.activeCEO && a.expires > now() && !a.actedUpon}
              <div class="sa-sub sa-button"><span>{word(S + "ImplementAction")}</span><button onclick={() => void apply(a)}>{word("UI/Commands/Apply")}</button></div>
            {/if}
            {#if [0, 1, 3].includes(a.voteType)}<div class="sa-sub sa-line sa-cols"><span>{word(S + "MoreInfo")}</span><span>{nameAny("owner", a.parameter)}</span></div>
            {:else if a.voteType === 5 || a.voteType === 6}<div class="sa-sub sa-line sa-cols"><span>{word(S + "MoreInfo")}</span><span>{nameAny("type", a.parameter1)}</span><span>{word(S + "LocatedAt", { location: a.parameter2 })}</span></div>{/if}
          {/if}
        {/if}
      {:else}
        {#if read}<p class="sa-hint">{word(S + (tab === "ineffect" ? "NoSanctionableActionsInEffect" : "NoNotInEffect"))}</p>{/if}
      {/each}
    {/if}
  </div>
  <div class="sa-buttons">{#if tab === "notineffect" && !expired}<button onclick={() => void showAll()}>{word(S + "ShowAll")}</button>{/if}</div>
</div>

<style>
  .sa { display: flex; flex-direction: column; height: 100%; padding: 4px; box-sizing: border-box; }
  .sa-toggle { display: flex; margin-bottom: 8px; }
  .sa-toggle button { flex: 1; }
  .sa-toggle button.active { background: rgba(255, 255, 255, 0.15); }
  .sa-scroll { flex: 1; min-height: 0; overflow: auto; }
  .sa-row { display: grid; grid-template-columns: 1.1fr 1.4fr 1.6fr 1fr 0.9fr 0.7fr 0.8fr; gap: 6px; padding: 0 4px; }
  .sa-head { font-size: 11px; opacity: 0.65; border-bottom: 1px solid rgba(255, 255, 255, 0.1); padding-bottom: 2px; }
  .sa-group { all: unset; display: grid; grid-template-columns: 1.1fr 1.4fr 1.6fr 1fr 0.9fr 0.7fr 0.8fr; gap: 6px; padding: 0 4px; min-height: 19px; align-items: center; cursor: pointer; width: 100%; box-sizing: border-box; }
  .sa-group span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sa-group:hover { background: rgba(255, 255, 255, 0.06); }
  .sa-sub { padding: 2px 4px 2px 22px; min-height: 19px; display: flex; align-items: center; gap: 12px; }
  .sa-button { justify-content: space-between; }
  .sa-label span:first-child { opacity: 0.65; width: 120px; }
  .sa-line { border-top: 1px solid rgba(255, 255, 255, 0.1); }
  .sa-cols span:first-child { opacity: 0.65; }
  .sa-hint { text-align: center; opacity: 0.65; }
  .sa-buttons { min-height: 25px; display: flex; justify-content: center; }
</style>
