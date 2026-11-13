<script lang="ts">
  // corporation/war/allyWnd.py AllyWnd (350 x 282, caption Allies): the top (48) - the mercenary icon 46, Allies
  // (EveCaptionSmall), InWarAgainst {defenderName: the war's declaredByID's name} -, then the allies still fighting (an
  // AllyListEntry each: timeFinished not passed) or NoAlliesInWar. Without the war's allies (a warsInfoMgr row) they
  // are read from its statistics object's GetBaseInfo (GetAllies: the last of it).
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { CorpWar } from "../bridge/corpWars.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import WarAllyEntry from "./WarAllyEntry.svelte";
  let { store, flow, war, onClose }: { store: ClientStore; flow: AppFlow; war: CorpWar; onClose: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const W = "UI/Corporations/Wars/";
  const nameAny = (k: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, k, id, "");
  const fill = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: nameAny }));
  const now = BigInt(Date.now()) * 10000n + 116444736000000000n;
  // svelte-ignore state_referenced_locally
  let rows = $state(war.allies);
  const allies = $derived(rows.filter((a) => a.timeFinished === null || now <= a.timeFinished));
  onMount(() => {
    flow.requestWords([W + "Allies", W + "InWarAgainst", W + "NoAlliesInWar"]); flow.requestNames(war.allies.map((a) => ({ kind: "owner" as const, id: a.allyID })));
    if (war.noOfAllies !== null) void flow.warReport(war.warID).then((info) => { if (info) rows = info.allyRows; }).catch(() => {});
  });
</script>

<div class="aw-back">
  <div class="aw" role="dialog" aria-modal="true" aria-label={fill(W + "Allies") || "Allies"}>
    <header>{fill(W + "Allies") || "Allies"}<button type="button" class="aw-x" aria-label="Close" onclick={onClose}>×</button></header>
    <div class="aw-top">
      <span class="aw-icon">🛡</span>
      <span><span class="aw-title">{fill(W + "Allies")}</span><br />{fill(W + "InWarAgainst", { defenderName: resolvedName($names.resolved, "owner", war.declaredByID, String(war.declaredByID)) })}</span>
    </div>
    <div class="aw-scroll">
      {#each allies as a (a.allyID)}
        <WarAllyEntry {store} {flow} allyID={a.allyID} ally={a} warStarted={war.timeStarted} warFinished={war.timeStarted} />
      {:else}
        <p class="aw-none">{fill(W + "NoAlliesInWar")}</p>
      {/each}
    </div>
  </div>
</div>

<style>
  .aw-back { position: fixed; inset: 0; z-index: 1001; display: grid; place-items: center; background: rgba(0, 0, 0, 0.35); }
  .aw { width: 350px; height: 282px; display: flex; flex-direction: column; padding: 0 4px 4px; background: #15181b; border: 1px solid rgba(255, 255, 255, 0.15); }
  header { display: flex; justify-content: space-between; padding: 4px; font-weight: bold; }
  .aw-x { background: none; border: 0; color: inherit; font-size: 16px; cursor: pointer; }
  .aw-top { height: 48px; display: flex; gap: 4px; padding: 4px; }
  .aw-icon { width: 46px; font-size: 30px; text-align: center; }
  .aw-title { font-size: 15px; }
  .aw-scroll { flex: 1; overflow-y: auto; padding: 4px 0 4px 4px; }
  .aw-none { opacity: 0.8; }
</style>
