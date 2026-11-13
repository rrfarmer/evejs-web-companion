<script lang="ts">
  // corporation/corp_ui_votes.py VoteWizardDialog (Votes > Propose Vote, a director's): a modal wizard, caption and
  // heading ProposeVote with the votes icon, one scroll per step and the buttons OK / Back / Cancel / Next as each step
  // sets them. 1: SelectVoteType - Create Shares, Expel Corporation Member, General Vote (a change of type starts the
  // vote afresh, InitVote). 3 shares: NumberOfShares (1 to 10000000, default 1). 4 expel: ExpelCorpMember with the
  // member picked (HintSelectMember until then) and Pick - GetMemberIDsWithMoreThanAvgShares in a list (SelectCorpMember,
  // SelectMemberToExpel), oneself refused (CannotExpelYourself); Next does nothing without one. 7 general:
  // NumberOfOptions (2 to 50, default 2); 8: one field per option (OptionText {option}, hint EnterTextForOption or the
  // text given before), an empty one refused going on (OptionCannotBeMepty). 9: Title (GetVoteTitle - CreateShares
  // {shares}, ExpelFromCorporation {char}, empty for general - max 100), Description (max 1000), NumberOfDays (1 to 30,
  // default 1); an empty title / description refused (HintTitleCannotBeEmpty, HintDescriptionCannotBeMEmpty). 10: the
  // summary (Type, SharesToCreate / ExpelCorpMember / each option, Title, Description, NumberOfDays) and OK -
  // corpvotes.CreateVote (OK disabled at once). Next: 1 -> 3 / 4 / 7, 3 / 4 / 8 -> 9, else one on; Back: 3 / 4 / 7 -> 1,
  // 9 -> 3 / 4 / 8, else one back. Integer fields are clamped as intmode clamps them.
  // Docked (a station or a structure): Lock Blueprint and Unlock Blueprint too. 5 lockdown: OnlyUsedBPCanBeLocked,
  // the hangar combo (SelectItemsToLockDown; GetAccessibleHangars), the blueprints (BlueprintWithSize {item,
  // stacksize, extraInfo}); NoCorpHangarAvailable without an office or hangar. 6 unlock: HintNoLockedItemsInLocation
  // where nothing is locked, else the combo (SelectItemToUnlock; the hangars and OptionAllLockedItemsAtStation) and
  // the locked items (LockedBlueprintLabel {item, extraInfo}). A row clicked is the item (Next shown then; without
  // one only Back leaves). GenerateBlueprintExtraInfo: a copy's CopyRuns / CopyRunsInfinite, ProductivityLevel,
  // MaterialLevel - ExtraInfoWrapper of them listed. The title LockdownItem / UnlockItem {item}; the summary Lockdown /
  // Unlock and the type's name; CreateVote's options ((LockdownItem, {item}), (DontLockdownItem, {item}), itemID,
  // typeID, locationID).
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, CorporationVoteBlueprint, CorporationVoteBlueprints } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { onMount } from "svelte";
  let { store, flow, onClose }: { store: ClientStore; flow: AppFlow; onClose: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const P = "UI/Corporations/CorporationWindow/Politics/";
  const LABELS = ["SelectVoteType", "VoteTypeCreateShares", "VoteTypeGeneral", "NumberOfShares", "Pick", "SelectMemberToExpel", "CannotExpelYourself", "HintSelectMember",
    "NumberOfOptions", "OptionText", "EnterTextForOption", "OptionCannotBeMepty", "Title", "Description", "NumberOfDays", "HintTitleCannotBeEmpty",
    "HintDescriptionCannotBeMEmpty", "SharesToCreate", "ProposeVote", "CreateShares", "ExpelFromCorporation", "VoteTypeLockBlueprint", "VoteTypeUnlockBlueprint",
    "OnlyUsedBPCanBeLocked", "SelectItemsToLockDown", "NoCorpHangarAvailable", "HintNoLockedItemsInLocation", "SelectItemToUnlock", "OptionAllLockedItemsAtStation",
    "BlueprintWithSize", "LockedBlueprintLabel", "CopyRuns", "CopyRunsInfinite", "ProductivityLevel", "MaterialLevel", "ExtraInfoWrapper", "Lockdown", "Unlock",
    "LockdownItem", "UnlockItem"].map((k) => P + k)
    .concat(["UI/Common/Formatting/ListGenericDelimiter", "UI/Corporations/Common/ExpelCorpMember", "UI/Corporations/Common/SelectCorpMember", "UI/Common/Type", "UI/Generic/OK", "UI/Commands/Back", "UI/Commands/Cancel", "UI/Commands/Next"]);
  const nameAny = (k: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, k, id, "");
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: nameAny }));
  onMount(() => { flow.requestWords(LABELS); });

  type VoteType = 2 | 3 | 4 | 5 | 6;
  // IsDocked() or IsControllingStructure(): the blueprint votes too.
  const docked = $derived(Boolean($station.online?.stationID || $station.online?.structureID));
  const TYPES = $derived<readonly [VoteType, string][]>([[2, P + "VoteTypeCreateShares"], [3, "UI/Corporations/Common/ExpelCorpMember"], [4, P + "VoteTypeGeneral"],
    ...(docked ? [[5, P + "VoteTypeLockBlueprint"], [6, P + "VoteTypeUnlockBlueprint"]] as [VoteType, string][] : [])]);
  // InitVote's fields.
  let step = $state(1), voteType = $state<VoteType>(2);
  let shares = $state(1), memberID = $state(0), memberName = $state<string | null>(null);
  let optionsCount = $state(2), options = $state<string[]>([]), optionEdits = $state<string[]>([]);
  let title = $state<string | null>(null), description = $state(""), days = $state(1);
  let picking = $state<readonly number[] | null>(null), pickedID = $state(0), submitting = $state(false);
  let itemID = $state(0), typeID = $state(0), flagInput = $state<number | null>(null), bp = $state<CorporationVoteBlueprints | null>(null);
  function initVote(type: VoteType): void {
    voteType = type; shares = 1; memberID = 0; memberName = null; optionsCount = 2; options = []; title = null; description = ""; days = 1;
    itemID = 0; typeID = 0; flagInput = null; bp = null;
  }
  async function loadBlueprints(): Promise<void> {
    bp = null;
    const read = await flow.corporationVoteBlueprints(voteType === 5 ? "lockdown" : "unlock", flagInput);
    flow.requestNames(read.items.map((i) => ({ kind: "type" as const, id: i.typeID })));
    bp = read; if (flagInput === null) flagInput = read.flag;
  }
  function extraInfo(i: CorporationVoteBlueprint): string {
    const b = i.blueprint;
    if (!b) return "";
    const parts: string[] = [];
    if (!b.original) parts.push(b.runs !== -1 ? word(P + "CopyRuns", { runsRemaining: b.runs }) : word(P + "CopyRunsInfinite"));
    if (b.timeEfficiency) parts.push(word(P + "ProductivityLevel", { productivityLevel: b.timeEfficiency }));
    if (b.materialEfficiency) parts.push(word(P + "MaterialLevel", { materialLevel: b.materialEfficiency }));
    return word(P + "ExtraInfoWrapper", { extraInfo: parts.join(word("UI/Common/Formatting/ListGenericDelimiter") || ", ") });
  }
  const rowLabel = (i: CorporationVoteBlueprint) => (voteType === 5 ? word(P + "BlueprintWithSize", { item: i.typeID, stacksize: i.quantity, extraInfo: extraInfo(i) })
    : word(P + "LockedBlueprintLabel", { item: i.typeID, extraInfo: i.blueprint ? extraInfo(i) : null }));
  const rows = $derived(bp ? [...bp.items].map((i) => ({ i, label: rowLabel(i) })).sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase())) : []);
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.trunc(Number(v)) || lo));
  const info = (label: string) => flow.sayDialog("CustomInfo", { type: "dict", entries: [["info", word(label)]] } as never, word(label));
  // GetVoteTitle: made once, on the first visit to the details.
  function voteTitle(): string {
    if (title === null) title = voteType === 2 ? word(P + "CreateShares", { shares }) : voteType === 3 ? word(P + "ExpelFromCorporation", { char: memberID })
      : voteType === 5 ? word(P + "LockdownItem", { item: typeID }) : voteType === 6 ? word(P + "UnlockItem", { item: typeID }) : "";
    return title;
  }
  function enter(next: number): void {
    if (next === 8) optionEdits = Array.from({ length: optionsCount }, () => "");
    if (next === 9) voteTitle();
    step = next;
    if (next === 5 || next === 6) void loadBlueprints();
  }
  // The funcOut of the step left: false keeps the step.
  function leave(next: number): boolean {
    if (step === 3) shares = clamp(shares, 1, 10_000_000);
    if (step === 4) return next < step || memberID !== 0;
    if (step === 5 || step === 6) return itemID !== 0 || next === 1;
    if (step === 7) optionsCount = clamp(optionsCount, 2, 50);
    if (step === 8) {
      const kept: string[] = [];
      for (const raw of optionEdits) {
        const value = raw.trim();
        if (!value) { if (next < step) continue; info(P + "OptionCannotBeMepty"); return false; }
        kept.push(value);
      }
      options = kept;
    }
    if (step === 9) {
      title = (title ?? "").trim(); description = description.trim(); days = clamp(days, 1, 30);
      if (next < step) return true;
      if (!title) { info(P + "HintTitleCannotBeEmpty"); return false; }
      if (!description) { info(P + "HintDescriptionCannotBeMEmpty"); return false; }
    }
    return true;
  }
  const nextOf = () => (step === 1 ? (voteType === 2 ? 3 : voteType === 3 ? 4 : voteType === 5 ? 5 : voteType === 6 ? 6 : 7) : step >= 3 && step <= 6 || step === 8 ? 9 : step + 1);
  const backOf = () => (step >= 3 && step <= 7 ? 1 : step === 9 ? (voteType === 2 ? 3 : voteType === 3 ? 4 : voteType === 5 ? 5 : voteType === 6 ? 6 : 8) : step - 1);
  function go(next: number): void { if (leave(next)) enter(next); }
  async function pick(): Promise<void> {
    const ids = await flow.corporationMembersWithMoreThanAvgShares();
    flow.requestNames(ids.map((id) => ({ kind: "owner" as const, id })));
    pickedID = 0; picking = ids;
  }
  function choose(): void {
    const id = pickedID; picking = null;
    if (!id) return;
    if (id === $station.online?.characterID) { info(P + "CannotExpelYourself"); return; }
    memberID = id; memberName = nameAny("owner", id);
  }
  async function ok(): Promise<void> {
    submitting = true;
    const base = { title: title ?? "", description, days };
    const made = await flow.proposeCorporationVote(voteType === 2 ? { ...base, voteType, shares } : voteType === 3 ? { ...base, voteType, memberID, memberName: memberName ?? "" }
      : voteType === 5 || voteType === 6 ? { ...base, voteType, itemID, typeID, locationID: bp?.locationID ?? Number($station.online?.stationID ?? $station.online?.structureID ?? 0) } : { ...base, voteType, options });
    if (made) onClose(); else submitting = false;
  }
  const typeName = $derived(word(TYPES.find(([t]) => t === voteType)![1]));
</script>

<div class="vw-back">
  <div class="vw" role="dialog" aria-label={word(P + "ProposeVote")}>
    <header><span>{word(P + "ProposeVote")}</span><button class="vw-x" onclick={onClose}>✕</button></header>
    <div class="vw-top"><img src="/client-res/ui/texture/windowicons/votes.png" alt="" /><span>{word(P + "ProposeVote")}</span></div>
    <div class="vw-scroll">
      {#if step === 1}
        <label class="vw-row">{word(P + "SelectVoteType")}
          <select value={String(voteType)} onchange={(e) => initVote(Number(e.currentTarget.value) as VoteType)}>
            {#each TYPES as [t, label] (t)}<option value={String(t)}>{word(label)}</option>{/each}
          </select></label>
      {:else if step === 3}
        <label class="vw-row">{word(P + "NumberOfShares")}<input type="number" min="1" max="10000000" bind:value={shares} /></label>
      {:else if step === 4}
        <div class="vw-top-label"><small>{word("UI/Corporations/Common/ExpelCorpMember")}</small><span>{memberName ?? word(P + "HintSelectMember")}</span></div>
        <div class="vw-row"><span></span><button onclick={() => void pick()}>{word(P + "Pick")}</button></div>
      {:else if step === 5 || step === 6}
        {#if !bp}<p class="vw-hint">…</p>
        {:else if bp.unavailable}<div class="vw-header">{word(P + (step === 5 ? "NoCorpHangarAvailable" : "HintNoLockedItemsInLocation"))}</div>
        {:else}
          {#if step === 5}<div class="vw-header">{word(P + "OnlyUsedBPCanBeLocked")}</div>{/if}
          <label class="vw-row">{word(P + (step === 5 ? "SelectItemsToLockDown" : "SelectItemToUnlock"))}
            <select value={String(flagInput ?? "")} onchange={(e) => { flagInput = Number(e.currentTarget.value); void loadBlueprints(); }}>
              {#each bp.hangars as h (h.flag)}<option value={String(h.flag)}>{h.name}</option>{/each}
              {#if step === 6}<option value="1000">{word(P + "OptionAllLockedItemsAtStation")}</option>{/if}
            </select></label>
          <hr />
          {#each rows as r (r.i.itemID)}
            <button class="vw-item" class:picked={itemID === r.i.itemID} onclick={() => { itemID = r.i.itemID; typeID = r.i.typeID; }}>{r.label}</button>
          {/each}
        {/if}
      {:else if step === 7}
        <label class="vw-row">{word(P + "NumberOfOptions")}<input type="number" min="2" max="50" bind:value={optionsCount} /></label>
      {:else if step === 8}
        {#each optionEdits as _, i (i)}
          <label class="vw-row">{word(P + "OptionText", { option: i + 1 })}<input maxlength="100" bind:value={optionEdits[i]} placeholder={options[i] ?? word(P + "EnterTextForOption", { option: i + 1 })} /></label>
        {/each}
      {:else if step === 9}
        <label class="vw-row">{word(P + "Title")}<input maxlength="100" value={title ?? ""} oninput={(e) => { title = e.currentTarget.value; }} /></label>
        <label class="vw-row">{word(P + "Description")}<input maxlength="1000" bind:value={description} /></label>
        <label class="vw-row">{word(P + "NumberOfDays")}<input type="number" min="1" max="30" bind:value={days} /></label>
      {:else if step === 10}
        <div class="vw-sum"><span>{word("UI/Common/Type")}</span><span>{typeName}</span></div>
        {#if voteType === 2}<div class="vw-sum"><span>{word(P + "SharesToCreate")}</span><span>{shares}</span></div>
        {:else if voteType === 3}<div class="vw-sum"><span>{word("UI/Corporations/Common/ExpelCorpMember")}</span><span>{memberName}</span></div>
        {:else if voteType === 5 || voteType === 6}<div class="vw-sum"><span>{word(P + (voteType === 5 ? "Lockdown" : "Unlock"))}</span><span>{nameAny("type", typeID)}</span></div>
        {:else}{#each options as o, i (i)}<div class="vw-sum"><span>{word(P + "OptionText", { option: i + 1 })}</span><span>{o}</span></div>{/each}{/if}
        <div class="vw-sum"><span>{word(P + "Title")}</span><span>{title}</span></div>
        <div class="vw-sum"><span>{word(P + "Description")}</span><span>{description}</span></div>
        <div class="vw-sum"><span>{word(P + "NumberOfDays")}</span><span>{days}</span></div>
      {/if}
    </div>
    <footer>
      {#if step === 10}<button disabled={submitting} onclick={() => void ok()}>{word("UI/Generic/OK")}</button>{/if}
      {#if step !== 1}<button onclick={() => go(backOf())}>{word("UI/Commands/Back")}</button>{/if}
      <button onclick={onClose}>{word("UI/Commands/Cancel")}</button>
      {#if step !== 10 && !((step === 5 || step === 6) && itemID === 0)}<button onclick={() => go(nextOf())}>{word("UI/Commands/Next")}</button>{/if}
    </footer>
    {#if picking}
      <div class="vw-list">
        <header>{word("UI/Corporations/Common/SelectCorpMember")}</header>
        <p>{word(P + "SelectMemberToExpel")}</p>
        <div class="vw-list-rows">
          {#each picking as id (id)}<button class:picked={pickedID === id} onclick={() => { pickedID = id; }} ondblclick={() => { pickedID = id; choose(); }}>{nameAny("owner", id) || id}</button>{/each}
        </div>
        <footer><button disabled={!pickedID} onclick={choose}>{word("UI/Generic/OK")}</button><button onclick={() => { picking = null; }}>{word("UI/Commands/Cancel")}</button></footer>
      </div>
    {/if}
  </div>
</div>

<style>
  .vw-back { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.4); z-index: 6; }
  .vw { position: relative; min-width: 400px; min-height: 300px; display: flex; flex-direction: column; background: #1b1d21; border: 1px solid rgba(255, 255, 255, 0.15); }
  .vw > header { display: flex; justify-content: space-between; padding: 4px 8px; font-size: 11px; opacity: 0.8; }
  .vw-x { all: unset; cursor: pointer; }
  .vw-top { height: 58px; display: flex; align-items: center; gap: 6px; padding: 0 8px; font-size: 16px; }
  .vw-top img { width: 64px; height: 64px; margin-top: -2px; }
  .vw-scroll { flex: 1; min-height: 120px; overflow: auto; margin: 6px; padding: 4px; border: 1px solid rgba(255, 255, 255, 0.1); display: flex; flex-direction: column; gap: 4px; }
  .vw-row { display: grid; grid-template-columns: 160px 1fr; align-items: center; gap: 8px; min-height: 24px; }
  .vw-top-label { display: flex; flex-direction: column; }
  .vw-top-label small { opacity: 0.65; }
  .vw-header { font-weight: bold; padding: 2px 0; }
  .vw-hint { opacity: 0.65; text-align: center; }
  .vw-item { all: unset; cursor: pointer; padding: 2px 4px; }
  .vw-item.picked, .vw-item:hover { background: rgba(255, 255, 255, 0.12); }
  .vw-sum { display: grid; grid-template-columns: 200px 1fr; min-height: 24px; align-items: center; }
  .vw-sum span:first-child { opacity: 0.65; }
  .vw > footer { display: flex; justify-content: flex-end; gap: 6px; padding: 6px; }
  .vw-list { position: absolute; inset: 20px; display: flex; flex-direction: column; background: #1b1d21; border: 1px solid rgba(255, 255, 255, 0.2); padding: 8px; gap: 6px; }
  .vw-list-rows { flex: 1; overflow: auto; display: flex; flex-direction: column; }
  .vw-list-rows button { all: unset; cursor: pointer; padding: 2px 4px; }
  .vw-list-rows button.picked { background: rgba(255, 255, 255, 0.15); }
  .vw-list footer { display: flex; justify-content: flex-end; gap: 6px; }
</style>
