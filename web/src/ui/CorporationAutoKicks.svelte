<script lang="ts">
  // corporation/corp_ui_member_autokicks.py CorpAutoKicks (Administration > Members > Auto-Kick Management, a
  // director's): the scroll of corp.GetPendingAutoKicks() - each "<the member's link><t><who kicked them's link>" - under
  // the headers CorpMemberName, KickCreatedBy; NoPendingAutoKicks where there are none.
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import LabelText from "./LabelText.svelte";
  import { linkFollowerOf, LINK_WORDS } from "./linkFollowers.ts";
  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const M = "UI/Corporations/CorporationWindow/Members/";
  const fill = (label: string) => plainText(formatTemplate($words.templates[label] ?? "", {} as never, { nameOf: (k, id) => resolvedName($names.resolved, k, id, "") }));
  const followerOf = (url: string, text: string) => linkFollowerOf(url, flow, null, (label) => plainText($words.templates[label] ?? LINK_WORDS[label] ?? ""), text);
  const link = (id: number) => `<url=showinfo:1377//${id}>${resolvedName($names.resolved, "owner", id, String(id))}</url>`;
  let kicks = $state<readonly { characterID: number; kickedByID: number }[] | null>(null), error = $state("");
  onMount(() => {
    flow.requestWords([M + "CorpMemberName", M + "KickCreatedBy", M + "NoPendingAutoKicks", ...Object.keys(LINK_WORDS)]);
    void flow.pendingAutoKicks().then((k) => { kicks = k; }, (e) => { error = e instanceof Error ? e.message : String(e); kicks = []; });
  });
</script>

<div class="ak">
  {#if error}<p class="error">{error}</p>{/if}
  <div class="ak-row ak-head"><span>{fill(M + "CorpMemberName")}</span><span>{fill(M + "KickCreatedBy")}</span></div>
  {#if kicks}
    {#each kicks as k (k.characterID)}
      <div class="ak-row"><LabelText markup={link(k.characterID)} {followerOf} /><LabelText markup={link(k.kickedByID)} {followerOf} /></div>
    {:else}
      <p class="ak-hint">{fill(M + "NoPendingAutoKicks")}</p>
    {/each}
  {/if}
</div>

<style>
  .ak { display: flex; flex-direction: column; padding: 4px; }
  .ak-row { display: grid; grid-template-columns: 1fr 1fr; min-height: 19px; align-items: center; padding: 0 4px; border-bottom: 1px solid rgba(255, 255, 255, 0.05); }
  .ak-head { font-size: 11px; opacity: 0.7; }
  .ak-hint { opacity: 0.8; padding: 4px; }
</style>
