<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { SHIP_SKINR_GATEWAY, shipSkinrEarlyPrice, type ShipSkinrDesign, type ShipSkinrEarlyPrice,
    type SharedShipSkinrDesign, type ShipSkinrEntry, type ShipSkinrStudio } from "../bridge/shipSkinr.ts";
  import { readPlexVaultBalance } from "../bridge/plexVault.ts";
  import { PLEX_WALLET_NOTICE } from "../bridge/plexWalletNotice.ts";
  import { formatDuration } from "../bridge/skills.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { showInfo } from "./showInfo.ts";
  import ShipSkinrDesigner from "./ShipSkinrDesigner.svelte";
  import ShipSkinrPreview from "./ShipSkinrPreview.svelte";
  import ShipSkinrShare from "./ShipSkinrShare.svelte";

  let { store, flow, registerBeforeClose, linkedDesign = null }: {
    store: ClientStore; flow: AppFlow; registerBeforeClose?: (guard: () => Promise<boolean>) => () => void;
    linkedDesign?: SharedShipSkinrDesign | null;
  } = $props();
  const words = $derived(store.words);
  const names = $derived(store.names);
  const station = $derived(store.station);
  const skillsChanged = $derived(flow.shipSkinrSkillsChanged);
  const pilot = $derived($station.online?.characterID ?? null);
  const prefix = "UI/Personalization/ShipSkins/SKINR/Studio/";
  const labels = {
    studio: [prefix + "Title", "Studio"],
    sequencing: [prefix + "SequencingInProgress", "Sequencing In Progress"],
    sequencingSkills: [prefix + "MaxConcurrentSequencingJobsTooltipText", "Maximum number of concurrent Sequencing Jobs is affected by the following skills:"],
    saved: [prefix + "SavedDesigns", "Saved Designs"],
    create: [prefix + "CreateNewDesign", "Create New Design"],
    edit: [prefix + "EditDesign", "Edit Design"],
    delete: [prefix + "DeleteDesign", "Delete Design"],
    complete: [prefix + "CompleteJobNow", "Complete Now"],
    completed: ["UI/Generic/Completed", "Completed"],
  } as const;
  const word = (key: keyof typeof labels) => plainText($words.templates[labels[key][0]] ?? labels[key][1]);
  const limitPath = prefix + "DesignErrors/SaveLimitReached";
  const timeLeftPath = prefix + "TimeLeft";
  const insufficientPath = prefix + "InsufficientPLEX";
  let studio = $state.raw<ShipSkinrStudio | null>(null);
  let sequencingCapacity = $state.raw<Awaited<ReturnType<AppFlow["loadShipSkinrSequencingCapacity"]>> | null>(null);
  let designs = $state.raw<ReadonlyMap<string, ShipSkinrDesign | null>>(new Map());
  let error = $state("");
  let attempt = $state(0);
  let selected = $state<string | null>(null);
  let selectionAfterReload: string | null = null;
  let initialDesign = untrack(() => linkedDesign);
  let designer = $state.raw<{ entry: ShipSkinrEntry; design: ShipSkinrDesign; ownerID?: number } | "new" | null>(initialDesign);
  let deleting = $state.raw<ShipSkinrEntry | null>(null);
  let deleteError = $state("");
  let now = $state(Date.now());
  let completing = $state<string | null>(null);
  let jobError = $state("");
  let completed = $state("");
  let prices = $state.raw<readonly ShipSkinrEarlyPrice[]>([]);
  let plex = $state<bigint | null>(null);
  let jobRequest = 0;
  let balanceRequest = 0;
  let destroyed = false;
  const atSaveLimit = $derived(studio !== null && studio.designs.length >= studio.capacity);
  const saveLimit = $derived(studio ? plainText(formatTemplate(
    $words.templates[limitPath] ?? "All saved design slots are in use.",
    { current: studio.designs.length, limit: studio.capacity },
    { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") },
  )) : "");
  const selectedEntry = $derived([...(studio?.designs ?? []), ...(studio?.jobs ?? [])].find(row => row.id === selected));
  const selectedDesign = $derived(selectedEntry ? designs.get(selectedEntry.skin) : null);
  const hasJobs = $derived(Boolean(studio?.jobs.length));
  const formatPlex = (cents: number | bigint) => (Number(cents) / 100).toLocaleString();
  const format = (path: string, fallback: string, args: Record<string, string | number>) =>
    plainText(formatTemplate($words.templates[path] ?? fallback, args, { nameOf: () => "" }));
  const progress = (job: ShipSkinrEntry) => Math.max(0, Math.min(1,
    (now - job.startedAt) / (job.finishesAt - job.startedAt)));
  const remaining = (job: ShipSkinrEntry) =>
    format(timeLeftPath, "Time Left: {time_left}", { time_left: formatDuration(job.finishesAt - now) });
  const shipName = (design: ShipSkinrDesign) => resolvedName($names.resolved, "type", design.shipTypeID, String(design.shipTypeID));
  const title = (entry: ShipSkinrEntry) => {
    const design = designs.get(entry.skin);
    return design ? design.name || shipName(design) : design === null ? "Design unavailable" : "Loading design…";
  };

  onDestroy(() => { destroyed = true; });

  function designSaved(entry: ShipSkinrEntry) {
    selectionAfterReload = entry.id;
    attempt++;
  }

  async function remove(entry: ShipSkinrEntry) {
    const loaded = studio;
    if (!loaded?.designs.includes(entry) || designer || deleting) return;
    const current = () => !destroyed && deleting === entry && studio?.designs.includes(entry);
    deleting = entry;
    deleteError = "";
    try {
      const confirmed = await flow.askClientDialogWith("DeleteDesign", {}, "Delete this saved design?");
      if (!confirmed || !current()) return;
      await flow.deleteShipSkinrDesign(entry.id);
      const latest = studio;
      if (!current() || !latest) return;
      studio = { ...latest, designs: latest.designs.filter(row => row.id !== entry.id) };
      selected = null;
    } catch (cause) {
      if (current()) deleteError = panelErrorWords(cause);
    } finally {
      if (!destroyed && deleting === entry) deleting = null;
    }
  }

  async function refreshJobs() {
    if (!studio || !pilot) return;
    const request = ++jobRequest;
    const owner = pilot;
    const current = () => !destroyed && owner === pilot && request === jobRequest;
    try {
      const jobs = await flow.loadShipSkinrJobs();
      if (!current() || !studio) return;
      if (studio.jobs.some(job => job.id === selected) && !jobs.some(job => job.id === selected)) selected = null;
      studio = { ...studio, jobs };
      const missing = new Set(jobs.filter(job => !designs.has(job.skin)).map(job => job.skin));
      const entries = await Promise.all([...missing].map(async skin =>
        [skin, await flow.loadShipSkinrDesign(skin).catch(() => null)] as const));
      if (current() && entries.length) designs = new Map([...designs, ...entries]);
    } catch (cause) {
      if (current()) jobError = panelErrorWords(cause);
    }
  }

  async function refreshBalance() {
    const request = ++balanceRequest;
    try {
      const latest = await readPlexVaultBalance(flow.requestOptions());
      if (!destroyed && request === balanceRequest) plex = latest;
    } catch {
      if (!destroyed && request === balanceRequest) plex = null;
    }
  }

  async function complete(job: ShipSkinrEntry) {
    const quote = shipSkinrEarlyPrice(prices, job.finishesAt, Date.now());
    if (completing || quote === null || plex === null || plex < BigInt(quote)) return;
    const owner = pilot;
    const current = () => !destroyed && owner === pilot;
    completing = job.id;
    completed = "";
    jobError = "";
    try {
      const confirmed = await flow.askClientDialogWith("CompleteSequencingNow", { plex_cost: formatPlex(quote) },
        `Complete this sequencing job now for ${formatPlex(quote)} PLEX?`);
      if (!confirmed || !current() || !studio?.jobs.some(row => row.id === job.id)) return;
      const latest = shipSkinrEarlyPrice(prices, job.finishesAt, Date.now());
      if (latest !== quote) {
        jobError = "The completion price changed. Review the current price and try again.";
        return;
      }
      await flow.completeShipSkinrJob(job.id);
      if (!current() || !studio) return;
      completed = `${title(job)} · ${word("completed")}`;
      studio = { ...studio, jobs: studio.jobs.filter(row => row.id !== job.id) };
      if (selected === job.id) selected = null;
      void refreshJobs();
    } catch (cause) {
      if (current()) {
        jobError = panelErrorWords(cause);
        void refreshBalance();
      }
    } finally {
      if (current() && completing === job.id) completing = null;
    }
  }

  onMount(() => {
    const notices = flow.gatewayNotices;
    let previous = notices.get();
    const stop = notices.subscribe(notice => {
      if (previous === notice) return;
      previous = notice;
      if (notice?.typeName.startsWith(SHIP_SKINR_GATEWAY + "sequencing.job.api.")) void refreshJobs();
      if (hasJobs && notice?.typeName === PLEX_WALLET_NOTICE) void refreshBalance();
    });
    const changes = flow.plexVaultChanged;
    let last = changes.get();
    const stopChanges = changes.subscribe(change => {
      if (last === change) return;
      last = change;
      if (hasJobs) void refreshBalance();
    });
    return () => { stop(); stopChanges(); };
  });

  $effect(() => { flow.requestWords([...Object.values(labels).map(([path]) => path), limitPath, timeLeftPath, insufficientPath]); });
  $effect(() => {
    if (!hasJobs || !pilot) return;
    now = Date.now();
    const timer = window.setInterval(() => { now = Date.now(); }, 500);
    let current = true;
    void refreshBalance();
    void flow.loadShipSkinrEarlyPricing().then(result => {
      if (current) prices = result;
    }, cause => { if (current) jobError = panelErrorWords(cause); });
    return () => { current = false; clearInterval(timer); balanceRequest++; prices = []; plex = null; };
  });
  $effect(() => {
    void $skillsChanged;
    void attempt;
    if (!pilot) {
      sequencingCapacity = null;
      return;
    }
    let current = true;
    void flow.loadShipSkinrSequencingCapacity().then(capacity => {
      if (current) sequencingCapacity = capacity;
    }, () => { if (current) sequencingCapacity = null; });
    return () => { current = false; };
  });
  $effect(() => {
    void attempt;
    jobRequest++;
    studio = null;
    designs = new Map();
    selected = selectionAfterReload;
    selectionAfterReload = null;
    designer = initialDesign;
    initialDesign = null;
    deleting = null;
    deleteError = "";
    jobError = "";
    completed = "";
    completing = null;
    error = "";
    if (!pilot) return;
    let mounted = true;
    void flow.loadShipSkinrStudio().then(result => {
      if (!mounted) return;
      studio = result;
      const skins = new Set([...result.designs, ...result.jobs].map(row => row.skin));
      return Promise.all([...skins].map(async skin => {
        const design = await flow.loadShipSkinrDesign(skin).catch(() => null);
        return [skin, design] as const;
      })).then(entries => { if (mounted) designs = new Map([...entries, ...designs]); });
    }, cause => { if (mounted) error = panelErrorWords(cause); });
    return () => { mounted = false; };
  });
</script>

{#snippet completeButton(job: ShipSkinrEntry)}
  {@const quote = shipSkinrEarlyPrice(prices, job.finishesAt, now)}
  {#if quote !== null && job.startedAt}
    {@const insufficient = plex !== null && plex < BigInt(quote)}
    <button type="button" class="complete-job" disabled={!!completing || plex === null || insufficient}
      title={insufficient ? format(insufficientPath, "Insufficient PLEX. PLEX balance {plex_balance}.", { plex_balance: formatPlex(plex) }) : undefined}
      onclick={() => void complete(job)}>{word("complete")} · {formatPlex(quote)} PLEX</button>
  {/if}
{/snippet}

<section class="ship-skinr" aria-labelledby="ship-skinr-studio">
  <h2 id="ship-skinr-studio">{word(designer === "new" ? "create" : designer ? "edit" : "studio")}</h2>
  {#if designer}
    <ShipSkinrDesigner {store} {flow} atSaveLimit={atSaveLimit || !studio} {saveLimit} {registerBeforeClose}
      atJobCapacity={sequencingCapacity !== null && (studio?.jobs.length ?? 0) >= sequencingCapacity.maximum}
      saved={designer === "new" ? null : designer} onBack={() => designer = null} onSaved={designSaved} onSequenced={designSaved} />
  {:else if error}
    <p role="alert">{error}</p>
    <button type="button" onclick={() => attempt++}>Retry</button>
  {:else if !studio}
    <p role="status">Loading Studio…</p>
  {:else}
    <div class="skinr-sections">
      <section aria-label={word("sequencing")}>
        <header>
          <h3>{word("sequencing")}</h3>
          <span>{studio.jobs.length}{sequencingCapacity ? `/${sequencingCapacity.maximum}` : ""}</span>
          {#if sequencingCapacity}
            <details class="sequencing-skills">
              <summary aria-label={word("sequencingSkills")}>ⓘ</summary>
              <div>
                <p>{word("sequencingSkills")}</p>
                {#each sequencingCapacity.skills as skill (skill.typeID)}
                  <button type="button" data-sequencing-skill={skill.typeID} onclick={() => showInfo({ kind: "type", typeID: skill.typeID })}>
                    {resolvedName($names.resolved, "type", skill.typeID, skill.name)}
                    <span>{skill.level}/5</span>
                  </button>
                {/each}
              </div>
            </details>
          {/if}
        </header>
        {#if !studio.jobs.length}<p>No active sequencing jobs.</p>{/if}
        {#each studio.jobs as row (row.id)}
          <div class="sequence-job">
            <button class="skinr-entry" type="button" data-entry="job" aria-pressed={selected === row.id} disabled={!!deleting}
              onclick={() => selected = selected === row.id ? null : row.id}>
              <strong>{title(row)}</strong>
              <span>{row.quantity} SKINs</span>
              {#if row.startedAt && row.finishesAt > row.startedAt}
                <progress max="1" value={progress(row)} aria-label={word("sequencing")}></progress>
                <time datetime={new Date(row.finishesAt).toISOString()}>{remaining(row)}</time>
              {:else}
                <span>Pending</span>
              {/if}
            </button>
            {@render completeButton(row)}
          </div>
        {/each}
      </section>
      <section aria-label={word("saved")}>
        <header><h3>{word("saved")}</h3><span>{studio.designs.length}/{studio.capacity}</span></header>
        {#if !studio.designs.length}<p>No saved designs.</p>{/if}
        {#each studio.designs as row (row.id)}
          <button class="skinr-entry" type="button" data-entry="draft" aria-pressed={selected === row.id} disabled={!!deleting}
            onclick={() => selected = selected === row.id ? null : row.id}><strong>{title(row)}</strong></button>
        {/each}
      </section>
    </div>
    {#if selectedEntry && selectedDesign}
      {@const entry = selectedEntry}
      {@const design = selectedDesign}
      <section class="skinr-details" aria-label={title(selectedEntry)}>
        <div class="studio-preview"><ShipSkinrPreview {flow} {design} /></div>
        <div>
          <h3>{title(selectedEntry)}</h3>
          {#if selectedDesign.lineName}<p>{selectedDesign.lineName}</p>{/if}
          <p>{selectedDesign.tier ? `${shipName(selectedDesign)} · Tier ${selectedDesign.tier}` : shipName(selectedDesign)}</p>
        </div>
        <div class="skinr-actions">
          <button type="button" disabled={!!deleting} onclick={() => designer = "new"}>{word("create")}</button>
          {#if studio.designs.includes(selectedEntry)}
            <button type="button" disabled={!!deleting} onclick={() => designer = { entry, design }}>{word("edit")}</button>
            <button type="button" class="danger" disabled={!!deleting} onclick={() => void remove(entry)}>{word("delete")}</button>
            {#if pilot}
              {#key entry.id}<ShipSkinrShare {store} {flow} id={entry.id} name={design.name} ownerID={pilot} />{/key}
            {/if}
          {:else}
            {@render completeButton(entry)}
          {/if}
        </div>
      </section>
    {:else if !selectedEntry}
      <div class="skinr-actions">
        <button type="button" onclick={() => designer = "new"}>{word("create")}</button>
      </div>
    {/if}
    {#if deleteError}<p role="alert">{deleteError}</p>{/if}
    {#if jobError}<p role="alert">{jobError}</p>{/if}
    {#if completed}<p role="status">{completed}</p>{/if}
  {/if}
</section>

<style>
  .ship-skinr { display: grid; gap: 14px; padding: 18px; }
  h2, h3, p { margin: 0; }
  .skinr-sections { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 12px; }
  .skinr-sections section { display: grid; align-content: start; gap: 8px; padding: 14px; background: #ffffff08; }
  header { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .sequencing-skills { position: relative; }
  .sequencing-skills summary { cursor: pointer; list-style: none; padding-inline: 4px; }
  .sequencing-skills div { position: absolute; z-index: 1; inset-inline-end: 0; display: grid; gap: 6px;
    width: min(15rem, 50vw); padding: 10px; background: #182128; border: 1px solid #51606c; }
  .sequencing-skills button { display: flex; justify-content: space-between; gap: 6px; text-align: start; }
  p, time, span { color: #b8c3cc; }
  .skinr-entry { display: flex; flex-wrap: wrap; justify-content: space-between; text-align: left; gap: 8px; padding: 8px; }
  .skinr-entry[aria-pressed="true"] { border-color: #94b8c2; }
  .sequence-job { display: grid; gap: 4px; }
  .sequence-job progress { flex-basis: 100%; width: 100%; height: 5px; accent-color: #94b8c2; }
  .complete-job { justify-self: start; }
  .skinr-details { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 14px; background: #ffffff08; }
  .studio-preview { flex: 0 1 17rem; min-width: min(100%, 10rem); }
  .skinr-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-inline-start: auto; }
</style>
