<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { filetimeToUnixMs } from "../bridge/activity.ts";
  import { CHARACTER_ATTRIBUTES, REMAP_MIN, REMAP_MAX, REMAP_TOTAL,
    type CharacterAttributeSnapshot, type CharacterAttributeOverviewRow } from "../bridge/characterAttributes.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { clientTexture } from "./skillGroupIcons.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  const words = $derived(store.words);
  const root = "UI/CharacterSheet/CharacterSheetWindow/Attributes/";
  const labels = {
    next: "UI/Neocom/NextDNAModification", now: "UI/Generic/Now", points: root + "Points",
    none: root + "NoAttributesFound", remaps: root + "BonusRemapsAvailable", overview: root + "AttributesOverview",
    title: root + "NeuralRemapping", implantBonus: root + "ImplantBonus", implantZero: root + "ImplantBonusZero",
    remapNow: root + "RemapStatsNow",
  } as const;
  function text(path: string, fallback: string, values: Record<string, number> = {}): string {
    const template = $words.templates[path];
    return typeof template === "string" ? plainText(formatTemplate(template, values, { nameOf: () => "" })) : fallback;
  }
  const icon = (index: number) => clientTexture(`res:/ui/texture/icons/22_32_${index}.png`);
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
  let snapshot = $state.raw<CharacterAttributeSnapshot | null>(null);
  let overview = $state.raw<readonly CharacterAttributeOverviewRow[] | null>(null);
  let error = $state("");
  let overviewError = $state("");
  let draft = $state.raw<Readonly<Record<number, number>>>({});
  let editable = $state(false);
  let busy = $state(false);
  let confirmation = $state<{ mode: "timed" } | { mode: "bonus"; left: number } | null>(null);
  let open = $state(false);
  let dialog: HTMLDialogElement | undefined = $state();
  let now = $state(Date.now());
  const next = $derived(snapshot?.remap?.nextTimedRespec ? filetimeToUnixMs(BigInt(snapshot.remap.nextTimedRespec)) : null);
  const canRemap = $derived(Boolean(snapshot?.remap && (next === null || next <= now || snapshot.remap.freeRespecs > 0)));
  const remaining = $derived(REMAP_TOTAL - Object.values(draft).reduce((sum, points) => sum + points, 0));

  let read = 0;
  async function refresh(): Promise<void> {
    const request = ++read;
    try {
      const latest = await flow.loadCharacterAttributes();
      if (request === read) { snapshot = latest; error = ""; }
    } catch (reason) {
      if (request === read) error = panelErrorWords(reason);
    }
  }

  onMount(() => {
    flow.requestWords([...Object.values(labels), ...CHARACTER_ATTRIBUTES.map(({ name }) => root + "Attribute" + name)]);
    const unsubscribe = flow.characterAttributesChanged.subscribe(() => { void refresh(); });
    const timer = setInterval(() => { now = Date.now(); }, 15_000);
    return () => { ++read; unsubscribe(); clearInterval(timer); };
  });

  async function showOverview(): Promise<void> {
    overview = null;
    overviewError = "";
    confirmation = null;
    editable = canRemap;
    open = true;
    await tick();
    dialog?.showModal();
    try {
      overview = await flow.loadCharacterAttributeOverview();
      draft = Object.fromEntries(overview.map(row => [row.id, Math.trunc(row.base)]));
    }
    catch (reason) { overviewError = panelErrorWords(reason); }
  }

  function change(id: number, points: number): void {
    const current = draft[id];
    if (current === undefined || points < REMAP_MIN || points > REMAP_MAX || points - current > Math.max(0, remaining)) return;
    draft = { ...draft, [id]: points };
    overviewError = "";
  }

  async function review(): Promise<void> {
    if (!overview || overview.length !== CHARACTER_ATTRIBUTES.length || remaining !== 0 || busy) return;
    if (overview.every(row => draft[row.id] === row.base)) { dialog?.close(); return; }
    busy = true;
    overviewError = "";
    try {
      const current = (await flow.loadCharacterAttributes()).remap;
      const available = current?.nextTimedRespec ? filetimeToUnixMs(BigInt(current.nextTimedRespec)) : null;
      if (current && (available === null || available <= Date.now())) confirmation = { mode: "timed" };
      else if (current && current.freeRespecs > 0) confirmation = { mode: "bonus", left: current.freeRespecs - 1 };
      else overviewError = "A neural remap is unavailable right now.";
    } catch (reason) { overviewError = panelErrorWords(reason); }
    finally { busy = false; }
  }

  async function confirm(): Promise<void> {
    if (!confirmation || busy) return;
    busy = true;
    overviewError = "";
    try {
      await flow.remapCharacterAttributes(draft);
      dialog?.close();
      await refresh();
    } catch (reason) { overviewError = panelErrorWords(reason); }
    finally { confirmation = null; busy = false; }
  }
</script>

<section data-character-attributes aria-label="Attributes">
  {#if error}
    <p role="alert">{error}</p>
  {:else if !snapshot}
    <p role="status">Reading attributes…</p>
  {:else if !snapshot.attributes.size}
    <p>{text(labels.none, "No attributes found.")}</p>
  {:else}
    <dl class="attributes">
      {#each CHARACTER_ATTRIBUTES as { id, name, icon: index } (id)}
        {@const value = snapshot.attributes.get(id)}
        {#if value !== undefined}
          <div data-character-attribute={id}>
            <dt><img src={icon(index)} alt="" />{text(root + "Attribute" + name, name)}</dt>
            <dd>{text(labels.points, `${value} points`, { skillPoints: value })}</dd>
          </div>
        {/if}
      {/each}
    </dl>
    <div class="remap">
      {#if snapshot.remap}
        <div>
          <small>{text(labels.next, "Next Neural Remap")}</small>
          <div data-next-remap>{next !== null && next > now ? date.format(next) : text(labels.now, "Now")}</div>
          {#if snapshot.remap.freeRespecs > 0}
            <div data-bonus-remaps>{text(labels.remaps, `Bonus Remaps Available: ${snapshot.remap.freeRespecs}`, { remapsAvailable: snapshot.remap.freeRespecs })}</div>
          {/if}
        </div>
      {/if}
      <button type="button" onclick={showOverview}>{canRemap ? text(labels.remapNow, "Remap Now") : text(labels.overview, "Attributes Overview")}</button>
    </div>
  {/if}
</section>

{#if open}
  <dialog bind:this={dialog} data-window="attributerespecification" aria-label={text(labels.title, "Neural Remapping")}
    oncancel={event => { if (busy) event.preventDefault(); }} onclose={() => { open = false; }}>
    <h2>{text(labels.title, "Neural Remapping")}</h2>
    {#if overviewError}
      <p role="alert">{overviewError}</p>
    {/if}
    {#if confirmation}
      <p data-remap-confirmation={confirmation.mode}>
        {confirmation.mode === "timed" ? "Use your timed neural remap? Your next timed remap will be available in 12 months."
          : `Use a bonus neural remap? Remaining bonus remaps after this change: ${confirmation.left}.`}
      </p>
    {:else if !overview && !overviewError}
      <p role="status">Reading base attributes…</p>
    {:else if overview}
      <dl class="overview">
        {#each overview as row (row.id)}
          {@const attribute = CHARACTER_ATTRIBUTES.find(item => item.id === row.id)}
          {#if attribute}
            <div data-overview-attribute={row.id}>
              <dt><img src={icon(attribute.icon)} alt="" />{text(root + "Attribute" + attribute.name, attribute.name)}</dt>
              <dd>
                {#if editable}
                  {@const value = draft[row.id] ?? row.base}
                  <button type="button" aria-label={`Decrease ${attribute.name}`} disabled={busy || value <= REMAP_MIN} onclick={() => change(row.id, value - 1)}>−</button>
                  <input type="range" min={REMAP_MIN} max={REMAP_MAX} {value} disabled={busy} aria-label={`${attribute.name} base points`}
                    oninput={event => { change(row.id, event.currentTarget.valueAsNumber); event.currentTarget.valueAsNumber = draft[row.id] ?? value; }} />
                  <button type="button" aria-label={`Increase ${attribute.name}`} disabled={busy || value >= REMAP_MAX || remaining <= 0} onclick={() => change(row.id, value + 1)}>+</button>
                {:else}
                  <meter min={REMAP_MIN} max={REMAP_MAX} value={row.base} aria-label={`${attribute.name} base points`} title={String(row.base)}></meter>
                {/if}
                <span title="Implant bonus">{row.implantBonus ? text(labels.implantBonus, `+${row.implantBonus}`, { implantBonus: row.implantBonus }) : text(labels.implantZero, "+0")}</span>
                <strong>{(editable ? draft[row.id] ?? row.base : row.base) + row.implantBonus}</strong></dd>
            </div>
          {/if}
        {/each}
      </dl>
      {#if editable}<p data-remap-unassigned>Unassigned points {remaining}</p>{/if}
    {/if}
    <footer>
      {#if confirmation}
        <button type="button" disabled={busy} onclick={() => { confirmation = null; }}>No</button>
        <button type="button" disabled={busy} onclick={confirm}>Yes</button>
      {:else}
        <form method="dialog"><button type="submit" disabled={busy}>{editable ? "Cancel" : "Close"}</button></form>
        {#if editable}<button type="button" disabled={busy || !overview || overview.length !== CHARACTER_ATTRIBUTES.length || remaining !== 0} onclick={review}>Save Changes</button>{/if}
      {/if}
    </footer>
  </dialog>
{/if}

<style>
  dl { margin: 0; }
  dl > div { min-height: 32px; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 8px; border-bottom: 1px solid var(--color-line); }
  dt, dd { display: flex; align-items: center; gap: 8px; margin: 0; }
  img { width: 24px; height: 24px; object-fit: contain; }
  .remap { display: flex; gap: 12px; align-items: flex-start; justify-content: space-between; padding: 8px; }
  .remap button { margin-left: auto; }
  dialog { width: min(450px, calc(100vw - 2rem)); color: var(--color-text); background: var(--color-panel); border: 1px solid var(--color-line); }
  h2 { font-size: 16px; margin: 0 0 12px; }
  .overview meter, .overview input { width: clamp(44px, 18vw, 110px); }
  .overview strong { min-width: 2ch; text-align: right; }
  footer { display: flex; justify-content: end; gap: 8px; padding-top: 12px; }
</style>
