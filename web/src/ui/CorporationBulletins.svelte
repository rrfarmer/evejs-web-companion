<script lang="ts">
  // corporation/corp_ui_bulletins.py CorpUIBulletins: for a director the Add Bulletin button group and the sort order
  // menu (shown where there are two or more); in a player corporation the scroll of bulletin entries
  // (base_corporation GetBulletinEntries: each its title - fontsize 18, bold - over its body, then
  // BulletinPostedBy: the last editor, a show-info link, and the time), "No bulletins" where there are none. (The
  // writes - adding, editing, deleting, reordering - are shown, not acting; the edit links a chat manager gets are not
  // drawn.)
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { CorpBulletin } from "../bridge/corpBulletins.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import LabelText from "./LabelText.svelte";
  let { store, flow, director = false }: { store: ClientStore; flow: AppFlow; director?: boolean } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const LABELS = {
    add: "UI/Corporations/CorpUIHome/AddBulletin", none: "UI/Corporations/BaseCorporationUI/NoBulletins",
    postedBy: "UI/Corporations/BaseCorporationUI/BulletinPostedBy", order: "UI/Corporations/CorpUIHome/BulletinDisplayOrder",
  } as const;
  const word = (label: string, fallback: string) => plainText($words.templates[label] ?? fallback);
  let rows = $state<readonly CorpBulletin[] | null>(null);
  let error = $state("");
  onMount(() => {
    flow.requestWords(Object.values(LABELS));
    let gone = false;
    void flow.corporationBulletins().then((b) => { if (!gone) rows = b; }).catch((e) => { if (!gone) { error = e instanceof Error ? e.message : String(e); rows = []; } });
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
      <button type="button" disabled title="Not on the play page yet">{word(LABELS.add, "Add Bulletin")}</button>
      {#if (rows?.length ?? 0) > 1}<button type="button" class="cb-order" disabled title={word(LABELS.order, "Bulletin Display Order")}>⇅</button>{/if}
    </div>
  {/if}
  {#if error}<p class="error">{error}</p>{/if}
  <div class="cb-scroll">
    {#if rows !== null && !rows.length}<p class="cb-empty">{word(LABELS.none, "No bulletins")}</p>{/if}
    {#each rows ?? [] as b (b.bulletinID)}
      <div class="cb-entry">
        <div class="cb-title">{b.title}</div>
        <div class="cb-body"><LabelText markup={b.body} /></div>
        <div class="cb-posted">{postedBy(b)}</div>
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
</style>
