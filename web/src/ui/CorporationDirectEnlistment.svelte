<script lang="ts">
  // corp_ui_direct_enlistment_mgt.CorpDirectEnlistmentMgt (Corporation > Administration > Wars > Direct Enlistment, a
  // director's): WhitelistManagement - WhiteListInfo, then a checkbox for each faction-warfare faction
  // (facwarCommon.GetAllFWFactions: the four occupiers, Angel Cartel and the Guristas; sorted by name), checked where
  // the corporation allows it (GetCorpAllowedEnlistmentFactions); CEOsOnly in red and the boxes disabled without the
  // director's role. Once the boxes differ from the saved list, Apply and Cancel (stretched): Apply asks
  // ApplyDirectEnlistmentBlacklistSettings {factions: the unchecked, "a, b and c"} where any is unchecked, else
  // ApplyDirectEnlistmentSettings {factions: the checked}, then SetMyCorpAllowedEnlistmentFactions and the list read
  // again; Cancel puts the boxes back.
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  let { store, flow, canEdit }: { store: ClientStore; flow: AppFlow; canEdit: boolean } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const D = "UI/Corporations/FWDirectEnlistment/";
  const FACTIONS = [500001, 500002, 500003, 500004, 500010, 500011];
  const nameAny = (k: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, k, id, "");
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: nameAny }));
  const factionName = (id: number) => nameAny("owner", id) || String(id);
  const sorted = $derived([...FACTIONS].sort((a, b) => factionName(a).localeCompare(factionName(b))));
  let saved = $state<readonly number[] | null>(null), checked = $state<number[]>([]), busy = $state(false);
  async function load(): Promise<void> { saved = await flow.corporationAllowedEnlistment(); checked = [...(saved ?? [])]; }
  onMount(() => {
    flow.requestWords([D + "WhiteListInfo", D + "CEOsOnly", D + "ApplyLabel", D + "CancelLabel"]);
    flow.requestNames(FACTIONS.map((id) => ({ kind: "owner" as const, id })));
    void load();
  });
  const changed = $derived(saved !== null && (checked.length !== saved.length || checked.some((id) => !saved!.includes(id))));
  // FormatGenericList(useConjunction=True).
  const listed = (ids: readonly number[]) => { const n = ids.map(factionName); return n.length < 2 ? n.join("") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`; };
  async function apply(): Promise<void> {
    const allowed = sorted.filter((id) => checked.includes(id)), notAllowed = sorted.filter((id) => !checked.includes(id));
    const ok = notAllowed.length
      ? await flow.askClientDialogWith("ApplyDirectEnlistmentBlacklistSettings", { factions: listed(notAllowed) }, `Disallow ${listed(notAllowed)}?`)
      : await flow.askClientDialogWith("ApplyDirectEnlistmentSettings", { factions: listed(allowed) }, `Allow ${listed(allowed)}?`);
    if (!ok) return;
    busy = true;
    try { const now = await flow.setCorporationAllowedEnlistment(allowed); if (now) { saved = now; checked = [...now]; } } finally { busy = false; }
  }
</script>

<div class="de">
  <p class="de-info">{word(D + "WhiteListInfo")}</p>
  <div class="de-list">
    {#each sorted as id (id)}
      <label class="de-row"><input type="checkbox" disabled={!canEdit || saved === null} checked={checked.includes(id)}
        onchange={(e) => { checked = e.currentTarget.checked ? [...checked, id] : checked.filter((x) => x !== id); }} />{factionName(id)}</label>
    {/each}
  </div>
  {#if !canEdit}<small class="de-red">{word(D + "CEOsOnly")}</small>{/if}
  {#if changed}
    <div class="de-buttons"><button disabled={busy} onclick={() => void apply()}>{word(D + "ApplyLabel")}</button><button disabled={busy} onclick={() => { checked = [...(saved ?? [])]; }}>{word(D + "CancelLabel")}</button></div>
  {/if}
</div>

<style>
  .de { padding: 8px; display: flex; flex-direction: column; }
  .de-info { margin: 0; opacity: 0.65; }
  .de-list { padding-top: 16px; display: flex; flex-direction: column; }
  .de-row { height: 30px; display: flex; align-items: center; gap: 8px; }
  .de-red { color: #d4534f; }
  .de-buttons { display: flex; gap: 4px; padding-top: 5px; margin-top: 10px; }
  .de-buttons button { flex: 1; }
</style>
