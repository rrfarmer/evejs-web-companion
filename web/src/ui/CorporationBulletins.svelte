<script lang="ts">
  // corporation/corp_ui_bulletins.py CorpUIBulletins: for a director the Add Bulletin button group and the sort order
  // menu (shown where there are two or more); in a player corporation the scroll of bulletin entries
  // (base_corporation GetBulletinEntries: each its title - fontsize 18, bold - over its body, then
  // BulletinPostedBy: the last editor, a show-info link, and the time, followed for a chat manager by BulletinEditLinks -
  // EDIT (EditBulletin: EditCorpBulletin with the bulletin; UpdateBulletin) and DELETE (ConfirmDeleteBulletin)), "No
  // bulletins" where there are none. Add Bulletin opens EditCorpBulletin (corp_ui_bulletins.py: its title, 100, and its
  // body, 4000; Submit and Cancel), here in the panel. The sort order menu: BulletinsOrder - BulletinDisplayOrder over
  // the titles in (sortOrder, -editDateTime) order, dragged to their places, Apply - UpdateBulletinOrder.
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { CorpBulletin } from "../bridge/corpBulletins.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import LabelText from "./LabelText.svelte";
  // alliance: Alliances/all_ui_home.py FormAlliancesBulletins - the alliance's bulletins (GetBulletinEntries(isAlliance)),
  // a director's Add Bulletin (UI/Corporations/CorporationWindow/Alliances/Home/AddBulletin) adding to the alliance
  let { store, flow, director = false, alliance = false }: { store: ClientStore; flow: AppFlow; director?: boolean; alliance?: boolean } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const LABELS = {
    add: "UI/Corporations/CorpUIHome/AddBulletin", allianceAdd: "UI/Corporations/CorporationWindow/Alliances/Home/AddBulletin", none: "UI/Corporations/BaseCorporationUI/NoBulletins",
    postedBy: "UI/Corporations/BaseCorporationUI/BulletinPostedBy", order: "UI/Corporations/CorpUIHome/BulletinDisplayOrder",
    editLinks: "UI/Corporations/BaseCorporationUI/BulletinEditLinks", apply: "UI/Commands/Apply",
  } as const;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // const.corpRoleChatManager: the edit links
  const chatManager = $derived((BigInt($station.online?.corpRole ?? "0") & 36028797018963968n) !== 0n);
  // BulletinEditLinks' text around its tags: " | ", EDIT, " ", DELETE
  const editLinkParts = $derived.by(() => {
    const t = $words.templates[LABELS.editLinks];
    const text = typeof t === "string" ? t : " | {startEditTag}EDIT{endEditTag} {startDelTag}DELETE{endDelTag}";
    const m = /^(.*)\{startEditTag\}(.*)\{endEditTag\}(.*)\{startDelTag\}(.*)\{endDelTag\}(.*)$/s.exec(text);
    return m ? { lead: m[1]!, edit: m[2]!, mid: m[3]!, del: m[4]!, tail: m[5]! } : { lead: " | ", edit: "EDIT", mid: " ", del: "DELETE", tail: "" };
  });
  let editTarget = $state<CorpBulletin | null>(null);
  let ordering = $state(false), order = $state<number[]>([]), dragging = $state<number | null>(null);
  function openOrder(): void {
    // BulletinsOrder: the bulletins by (sortOrder, -editDateTime)
    order = [...(rows ?? [])].sort((a, b) => a.sortOrder - b.sortOrder || Number((b.editDateTime ?? 0n) - (a.editDateTime ?? 0n))).map((b) => b.bulletinID);
    ordering = !ordering;
  }
  function dropOn(target: number | null): void {
    // MoveStuff: the dragged one put just before the one dropped on (the trailing empty entry: the end)
    const moved = dragging;
    dragging = null;
    if (moved === null || moved === target) return;
    const next = order.filter((id) => id !== moved);
    next.splice(target === null ? next.length : next.indexOf(target), 0, moved);
    order = next;
  }
  async function applyOrder(): Promise<void> {
    if (await flow.updateBulletinOrder(order, alliance)) { ordering = false; load(); }
  }
  async function remove(b: CorpBulletin): Promise<void> {
    if (await flow.deleteCorporationBulletin(b.bulletinID, alliance)) load();
  }
  function edit(b: CorpBulletin): void { editTarget = b; title = b.title; body = b.body; editing = true; }
  const EDIT_LABELS = ["UI/Corporations/EditCorpBulletin/EditBulletinCaption", "UI/Corporations/EditCorpBulletin/BulletinTitle", "UI/Common/Buttons/Submit", "UI/Common/Buttons/Cancel"];
  const word = (label: string, fallback: string) => plainText($words.templates[label] ?? fallback);
  let rows = $state<readonly CorpBulletin[] | null>(null);
  let error = $state("");
  let editing = $state(false), title = $state(""), body = $state(""), sending = $state(false);
  function load(): void {
    void flow.corporationBulletins(alliance).then((b) => { rows = b; }).catch((e) => { error = e instanceof Error ? e.message : String(e); rows = []; });
  }
  async function send(): Promise<void> {
    if (sending) return;
    sending = true;
    try {
      const done = editTarget ? await flow.editCorporationBulletin(editTarget, title, body, alliance) : await flow.addCorporationBulletin(title, body, alliance);
      if (done) { editing = false; editTarget = null; title = ""; body = ""; load(); }
    }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { sending = false; }
  }
  onMount(() => {
    flow.requestWords([...Object.values(LABELS), ...EDIT_LABELS]);
    let gone = false;
    void flow.corporationBulletins(alliance).then((b) => { if (!gone) rows = b; }).catch((e) => { if (!gone) { error = e instanceof Error ? e.message : String(e); rows = []; } });
    return () => { gone = true; };
  });
  /** BulletinPostedBy (charID, its show-info link, postTime). */
  function postedBy(b: CorpBulletin): string {
    return plainText(formatTemplate($words.templates[LABELS.postedBy] ?? "Posted by {[character]charID.name} {[datetime]postTime}",
      { charID: String(b.editCharacterID ?? 0), postTime: b.editDateTime === null ? "" : b.editDateTime.toString(), infoLinkData: "" },
      { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") }));
  }
</script>

<div class="corp-bulletins">
  {#if director}
    <div class="cb-buttons">
      <button type="button" onclick={() => { editTarget = null; title = ""; body = ""; editing = true; }}>{word(alliance ? LABELS.allianceAdd : LABELS.add, "Add Bulletin")}</button>
      {#if (rows?.length ?? 0) > 1}<button type="button" class="cb-order" aria-expanded={ordering} title={word(LABELS.order, "Bulletin Display Order")} onclick={openOrder}>⇅</button>{/if}
      {#if ordering && rows}
        <div class="cb-order-menu">
          <b>{word(LABELS.order, "Bulletin Display Order")}</b>
          {#each order as id (id)}
            <div class="cb-order-entry" class:drag={dragging === id} role="listitem" draggable="true" ondragstart={() => (dragging = id)} ondragover={(e) => e.preventDefault()} ondrop={(e) => { e.preventDefault(); dropOn(id); }}>{rows.find((b) => b.bulletinID === id)?.title ?? id}</div>
          {/each}
          <div class="cb-order-entry" role="listitem" ondragover={(e) => e.preventDefault()} ondrop={(e) => { e.preventDefault(); dropOn(null); }}></div>
          <button type="button" onclick={() => void applyOrder()}>{word(LABELS.apply, "Apply")}</button>
        </div>
      {/if}
    </div>
  {/if}
  {#if editing}
    <section class="cb-edit" aria-label={word(EDIT_LABELS[0]!, "Edit Bulletin")} aria-busy={sending}>
      <div class="cb-edit-caption">{word(EDIT_LABELS[0]!, "Edit Bulletin")}</div>
      <label class="cb-edit-title"><span>{word(EDIT_LABELS[1]!, "Title")}</span><input bind:value={title} maxlength="100" /></label>
      <textarea bind:value={body} maxlength="4000"></textarea>
      <div class="cb-edit-buttons">
        <button type="button" disabled={sending} onclick={send}>{word(EDIT_LABELS[2]!, "Submit")}</button>
        <button type="button" onclick={() => (editing = false)}>{word(EDIT_LABELS[3]!, "Cancel")}</button>
      </div>
    </section>
  {/if}
  {#if error}<p class="error">{error}</p>{/if}
  <div class="cb-scroll">
    {#if rows !== null && !rows.length}<p class="cb-empty">{word(LABELS.none, "No bulletins")}</p>{/if}
    {#each rows ?? [] as b (b.bulletinID)}
      <div class="cb-entry">
        <div class="cb-title">{b.title}</div>
        <div class="cb-body"><LabelText markup={b.body} /></div>
        <div class="cb-posted">{postedBy(b)}{#if chatManager}{editLinkParts.lead}<button type="button" class="cb-link" onclick={() => edit(b)}>{editLinkParts.edit}</button>{editLinkParts.mid}<button type="button" class="cb-link" onclick={() => void remove(b)}>{editLinkParts.del}</button>{editLinkParts.tail}{/if}</div>
      </div>
    {/each}
  </div>
</div>

<style>
  .corp-bulletins { display: flex; flex-direction: column; gap: 4px; height: 100%; min-height: 0; }
  .cb-buttons { display: flex; gap: 4px; justify-content: flex-end; }
  .cb-scroll { flex: 1; overflow: auto; min-height: 0; padding: 4px; }
  .cb-entry { padding: 6px 0 8px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
  .cb-title { font-size: 18px; font-weight: bold; }
  .cb-body { margin-top: 2px; }
  .cb-posted { margin-top: 6px; opacity: 0.65; font-size: 11px; }
  .cb-empty { opacity: 0.6; }
  .cb-buttons { position: relative; }
  .cb-link { background: none; border: 0; padding: 0; color: #d8b766; cursor: pointer; font-size: inherit; }
  .cb-order-menu { position: absolute; right: 0; top: 24px; z-index: 5; width: 200px; display: flex; flex-direction: column; gap: 2px; padding: 4px; background: rgba(20, 22, 25, 0.97); border: 1px solid rgba(255, 255, 255, 0.15); }
  .cb-order-entry { height: 20px; padding: 0 4px; cursor: ns-resize; border-top: 2px solid transparent; }
  .cb-order-entry.drag { opacity: 0.5; }
  .cb-order-menu button { align-self: center; margin-top: 4px; }
  .cb-edit { min-width: 420px; min-height: 300px; display: flex; flex-direction: column; gap: 4px; padding: 4px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(0, 0, 0, 0.35); }
  .cb-edit-caption { font-weight: bold; }
  .cb-edit-title { display: flex; align-items: center; gap: 6px; padding-left: 48px; font-size: 11px; }
  .cb-edit-title input { flex: 1; }
  .cb-edit textarea { flex: 1; min-height: 200px; resize: vertical; }
  .cb-edit-buttons { display: flex; gap: 4px; justify-content: center; padding-top: 16px; }
</style>
