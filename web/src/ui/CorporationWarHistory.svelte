<script lang="ts">
  // corporation/war/warHistoryCont.py WarHistoryCont (Wars > War History, a player corporation's): one scroll of
  // the peace treaties' group, where there are any (PeaceTreatiesGroup {numTreaties} {numUniqueOwners}; each
  // TreatyEntry - the owner's logo 32, ForcedPeaceWithEntityWithReason / ...WithoutReason with the owner's link and
  // GetPeaceReasonText - surrendered, or HQ unavailable -, under it PeaceUntilAttackerText / ...DefenderText {date}),
  // then the Finished Wars group (infosvc.GetFinishedWarsGroup: its count shown, by year past 100 wars; each a WarEntry,
  // newest declared first): the corporation's wars and its alliance's (warsInfoMgr.GetWarsByOwnerID) finished before now.
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { CorpWar } from "../bridge/corpWars.ts";
  import { DATE_LABELS, formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import LabelText from "./LabelText.svelte";
  import WarEntry from "./WarEntry.svelte";
  import { linkFollowerOf, LINK_WORDS } from "./linkFollowers.ts";
  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const W = "UI/Corporations/Wars/";
  const LABELS = ["PeaceTreatiesGroup", "ForcedPeaceWithEntityWithReason", "ForcedPeaceWithEntityWithoutReason", "PeaceUntilAttackerText", "PeaceUntilDefenderText",
    "PeaceWarWasSurrendered", "PeaceHeadquartersUnavailable", "FinishedWars"].map((k) => W + k).concat([DATE_LABELS.ll!, ...Object.keys(LINK_WORDS)]);
  const fill = (label: string, values: Record<string, unknown> = {}) =>
    formatTemplate($words.templates[label] ?? "", values as never, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") });
  const followerOf = (url: string, text: string) => linkFollowerOf(url, flow, null, (label) => plainText($words.templates[label] ?? LINK_WORDS[label] ?? ""), text);
  let data = $state<Awaited<ReturnType<AppFlow["warHistory"]>> | null>(null), error = $state("");
  let treatiesOpen = $state(false), finishedOpen = $state(false), openYears = $state<number[]>([]);
  onMount(() => {
    flow.requestWords(LABELS);
    void flow.warHistory().then((d) => { data = d; }).catch((e) => { error = e instanceof Error ? e.message : String(e); });
  });
  const nowTicks = BigInt(Date.now()) * 10000n + 116444736000000000n;
  // GetPeaceReasonText: 4 surrendered; 1, 2, 3 the HQ unavailable; else none
  const reasonOf = (r: number) => (r === 4 ? plainText(fill(W + "PeaceWarWasSurrendered")) : [1, 2, 3].includes(r) ? plainText(fill(W + "PeaceHeadquartersUnavailable")) : "");
  const isAlliance = (id: number) => id >= 99_000_000 && id < 100_000_000;
  const linkOf = (id: number) => `<url=showinfo:${isAlliance(id) ? 16159 : 2}//${id}>${resolvedName($names.resolved, "owner", id, String(id))}</url>`;
  const finished = $derived((data?.wars ?? []).filter((w) => w.timeFinished !== null && w.timeFinished < nowTicks));
  // GetWarSubContent: newest declared first; past FINISHED_WARS_FOLDER_THRESHOLD (100) by the year finished
  const byDeclared = (ws: readonly CorpWar[]) => [...ws].sort((a, b) => Number((b.timeDeclared ?? 0n) - (a.timeDeclared ?? 0n)));
  const years = $derived.by(() => {
    const m = new Map<number, CorpWar[]>();
    for (const w of finished) { const y = new Date(Number((w.timeFinished! - 116444736000000000n) / 10000n)).getUTCFullYear(); m.set(y, [...(m.get(y) ?? []), w]); }
    return [...m.entries()].sort((a, b) => b[0] - a[0]);
  });
  const treaties = $derived(data ? [...data.outgoing.map((t) => ({ ...t, label: "PeaceUntilAttackerText" })), ...data.incoming.map((t) => ({ ...t, label: "PeaceUntilDefenderText" }))] : []);
  const uniqueOwners = $derived(new Set(treaties.map((t) => t.otherOwnerID)).size);
</script>

<div class="war-history">
  {#if error}<p class="error">{error}</p>{/if}
  {#if data}
    {#if treaties.length}
      <button type="button" class="wh-group" aria-expanded={treatiesOpen} onclick={() => (treatiesOpen = !treatiesOpen)}>{treatiesOpen ? "▾" : "▸"} {plainText(fill(W + "PeaceTreatiesGroup", { numTreaties: treaties.length, numUniqueOwners: uniqueOwners }))}</button>
      {#if treatiesOpen}
        {#each treaties as t, i (i)}
          {@const reason = reasonOf(t.peaceReason)}
          <div class="wh-treaty">
            <LabelText markup={fill(W + (reason ? "ForcedPeaceWithEntityWithReason" : "ForcedPeaceWithEntityWithoutReason"), { corpOrAllianceLink: linkOf(t.otherOwnerID), reason })} {followerOf} />
            <span class="wh-expiry">{plainText(fill(W + t.label, { peaceUntilDate: plainText(fill(DATE_LABELS.ll!, { datetime: { type: "long", value: t.expiryDate.toString() } })) }))}</span>
          </div>
        {/each}
      {/if}
    {/if}
    <button type="button" class="wh-group" aria-expanded={finishedOpen} onclick={() => (finishedOpen = !finishedOpen)}>{finishedOpen ? "▾" : "▸"} {plainText(fill(W + "FinishedWars"))} [{finished.length}]</button>
    {#if finishedOpen}
      {#if finished.length < 100}
        {#each byDeclared(finished) as w (w.warID)}<div class="wh-sub"><WarEntry {store} {flow} war={w} /></div>{/each}
      {:else}
        {#each years as [year, ws] (year)}
          <button type="button" class="wh-group wh-sub" aria-expanded={openYears.includes(year)} onclick={() => (openYears = openYears.includes(year) ? openYears.filter((y) => y !== year) : [...openYears, year])}>{openYears.includes(year) ? "▾" : "▸"} {year} [{ws.length}]</button>
          {#if openYears.includes(year)}{#each byDeclared(ws) as w (w.warID)}<div class="wh-sub2"><WarEntry {store} {flow} war={w} /></div>{/each}{/if}
        {/each}
      {/if}
    {/if}
  {/if}
</div>

<style>
  .war-history { display: flex; flex-direction: column; overflow: auto; height: 100%; }
  .wh-group { text-align: left; background: rgba(255, 255, 255, 0.05); border: 0; color: inherit; padding: 4px 6px; cursor: pointer; margin-bottom: 1px; }
  .wh-treaty { min-height: 42px; display: flex; flex-direction: column; justify-content: center; padding-left: 38px; border-bottom: 1px solid rgba(255, 255, 255, 0.06); }
  .wh-expiry { opacity: 0.8; }
  .wh-sub { padding-left: 16px; }
  .wh-sub2 { padding-left: 32px; }
  .error { color: #e06666; }
</style>
