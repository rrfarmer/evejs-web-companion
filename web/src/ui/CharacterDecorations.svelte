<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { achievementRequest } from "./achievementRequests.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const D = "UI/CharacterSheet/CharacterSheetWindow/DecoTabs/";
  const labels = ["Titles", "Ranks", "Medals", "Permissions", "Public", "Private", "NoMedals", "NoRanks",
    "Titles/Acquired", "Titles/NotAcquired", "Titles/NoContentHint", "Titles/EquipButtonLabel", "Titles/UnequipButtonLabel",
    "Titles/ViewAchievementButtonLabel", "SaveDecorationPermissionChanges", "SetAllDecorationPermissions"];
  const word = (key: string, fallback = key) => plainText($words.templates[D + key] ?? "") || fallback;
  type Tab = "Titles" | "Ranks" | "Medals" | "Permissions";
  let tab = $state<Tab>("Titles");
  let titleData = $state.raw<Awaited<ReturnType<AppFlow["characterTitles"]>> | null>(null);
  let medals = $state.raw<Awaited<ReturnType<AppFlow["personalMedals"]>> | null>(null);
  let ranks = $state.raw<Awaited<ReturnType<AppFlow["personalRanks"]>> | null>(null);
  let titleLinks = $state.raw<ReadonlyMap<string, string>>(new Map());
  let settings = $state<Record<number, 1 | 2 | 3>>({});
  let busy = $state(false), error = $state(""), loading = $state(true);
  const titles = $derived.by(() => {
    const own = new Set(titleData?.owned ?? []);
    const definitions = (titleData?.definitions ?? []).filter(t => !t.releasedAt || t.releasedAt <= Date.now());
    return { acquired: definitions.filter(t => own.has(t.id)), locked: definitions.filter(t => !own.has(t.id) && t.visibility !== 1) };
  });

  async function read(which: Tab = tab) {
    if (which === "Titles") titleData = await flow.characterTitles();
    else if (which === "Ranks") ranks = await flow.personalRanks();
    else { medals = await flow.personalMedals(); settings = {}; }
  }
  $effect(() => {
    const current = tab;
    let open = true;
    loading = true; error = "";
    void read(current).catch(e => { if (open) error = e instanceof Error ? e.message : String(e); }).finally(() => { if (open) loading = false; });
    return () => { open = false; };
  });
  $effect(() => {
    let open = true;
    flow.requestWords(labels.map(key => D + key));
    void flow.achievementCatalogue().then(c => {
      if (!open) return;
      const links = new Map<string, string>();
      for (const row of c.achievements) for (const m of row.milestones) for (const r of m.rewards) {
        if (r.titleID && !links.has(r.titleID)) links.set(r.titleID, row.id);
      }
      titleLinks = links;
    }).catch(() => {});
    const stop = flow.gatewayNotices.subscribe(n => {
      if (n?.typeName.startsWith("eve_public.cosmetic.character.title.api.") && !n.typeName.endsWith("SetAllInBubbleNotice")) {
        void read("Titles").catch(() => {});
      }
    });
    return () => { open = false; stop(); };
  });
  async function write(action: () => Promise<void>, page: Tab) {
    busy = true; error = "";
    try { await action(); await read(page); }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { busy = false; }
  }
  function save(all?: 2 | 3) {
    const deltas = (medals ?? []).flatMap(m => {
      const choice = all ?? settings[m.id];
      return choice && choice !== m.status ? [[m.id, choice] as const] : [];
    });
    if (deltas.length) void write(() => flow.savePersonalMedalPermissions(deltas), "Permissions");
  }
</script>

<section class="decorations" aria-label="Decorations">
  <nav aria-label="Decorations tabs">
    {#each ["Titles", "Ranks", "Medals", "Permissions"] as value}
      <button type="button" aria-pressed={tab === value} onclick={() => tab = value as Tab}>{word(value)}</button>
    {/each}
  </nav>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if loading}<p role="status">Loading {tab.toLowerCase()}…</p>
  {:else if tab === "Titles"}
    {#if !titles.acquired.length && !titles.locked.length}<p>{word("Titles/NoContentHint", "No titles found.")}</p>{/if}
    {#each [{ rows: titles.acquired, label: "Titles/Acquired", fallback: "Acquired", owned: true }, { rows: titles.locked, label: "Titles/NotAcquired", fallback: "Not Acquired", owned: false }] as group}
      {#if group.rows.length}
        <h3>{word(group.label, group.fallback)}</h3>
        {#each group.rows as title (title.id)}
          {@const equipped = titleData?.equipped === title.id}
          {@const linked = titleLinks.get(title.id)}
          <article class:locked={!group.owned} class:equipped>
            <span>{title.name}</span>
            {#if linked}<button type="button" onclick={() => achievementRequest.set(linked)}>{word("Titles/ViewAchievementButtonLabel", "View Achievement")}</button>{/if}
            {#if group.owned}<button type="button" disabled={busy} onclick={() => write(() => flow.setCharacterTitle(equipped ? null : title.id), "Titles")}>{equipped ? word("Titles/UnequipButtonLabel", "Unequip") : word("Titles/EquipButtonLabel", "Equip")}</button>{/if}
          </article>
        {/each}
      {/if}
    {/each}
  {:else if tab === "Ranks"}
    {#each ranks ?? [] as row (row.factionID)}<article><span>{resolvedName($names.resolved, "owner", row.factionID, "Faction")}</span><span>Rank {row.rank}</span></article>
    {:else}<p>{word("NoRanks", "No ranks.")}</p>{/each}
  {:else if tab === "Medals"}
    {#if !medals?.length}<p>{word("NoMedals", "No medals.")}</p>{/if}
    {#each [3, 2] as status}
      {@const rows = (medals ?? []).filter(x => x.status === status)}
      {#if rows.length}<h3>{word(status === 3 ? "Public" : "Private")}</h3>{/if}
      {#each rows as row (row.id)}<article><strong>{row.title}</strong><span>{row.description}</span></article>{/each}
    {/each}
  {:else}
    {#each medals ?? [] as row (row.id)}
      <article><span>{row.title}</span><select aria-label={`Permissions for ${row.title}`} value={settings[row.id] ?? row.status} onchange={e => { settings[row.id] = Number(e.currentTarget.value) as 1 | 2 | 3; }}>
        <option value={2}>{word("Private")}</option><option value={3}>{word("Public")}</option><option value={1}>Remove</option>
      </select></article>
    {:else}<p>{word("NoMedals", "No medals.")}</p>{/each}
    {#if medals?.length}
      <div class="actions">
        <button type="button" disabled={busy} onclick={() => save()}>{word("SaveDecorationPermissionChanges", "Save Changes")}</button>
        <button type="button" disabled={busy} onclick={() => save(2)}>Set All Private</button>
        <button type="button" disabled={busy} onclick={() => save(3)}>Set All Public</button>
      </div>
    {/if}
  {/if}
</section>

<style>
  .decorations { padding: 6px; }
  nav, .actions { display: flex; gap: 4px; margin-bottom: 6px; }
  nav { border-bottom: 1px solid #ffffff2a; }
  button, select { color: inherit; border: 1px solid #ffffff24; background: #20272d; padding: 5px 10px; }
  nav button { background: transparent; border: 0; }
  nav button[aria-pressed="true"] { border-bottom: 2px solid #8ccdde; }
  h3 { font-size: 15px; margin: 12px 0 6px; }
  article { display: flex; align-items: center; gap: 4px; min-height: 38px; padding: 3px 8px; margin-bottom: 2px; background: #ffffff08; }
  article span:first-child { margin-right: auto; }
  article.locked { color: #a7adb4; }
  article.equipped { box-shadow: inset 2px 0 #8ccdde; }
</style>
