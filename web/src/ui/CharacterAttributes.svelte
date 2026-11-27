<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { filetimeToUnixMs } from "../bridge/activity.ts";
  import { CHARACTER_ATTRIBUTES, REMAP_MIN, REMAP_MAX,
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
  let open = $state(false);
  let dialog: HTMLDialogElement | undefined = $state();
  let now = $state(Date.now());
  const next = $derived(snapshot?.remap?.nextTimedRespec ? filetimeToUnixMs(BigInt(snapshot.remap.nextTimedRespec)) : null);

  onMount(() => {
    flow.requestWords([...Object.values(labels), ...CHARACTER_ATTRIBUTES.map(({ name }) => root + "Attribute" + name)]);
    void flow.loadCharacterAttributes().then(value => { snapshot = value; }, reason => { error = panelErrorWords(reason); });
    const timer = setInterval(() => { now = Date.now(); }, 15_000);
    return () => clearInterval(timer);
  });

  async function showOverview(): Promise<void> {
    overview = null;
    overviewError = "";
    open = true;
    await tick();
    dialog?.showModal();
    try { overview = await flow.loadCharacterAttributeOverview(); }
    catch (reason) { overviewError = panelErrorWords(reason); }
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
      <button type="button" onclick={showOverview}>{text(labels.overview, "Attributes Overview")}</button>
    </div>
  {/if}
</section>

{#if open}
  <dialog bind:this={dialog} data-window="attributerespecification" aria-label={text(labels.title, "Neural Remapping")}
    onclose={() => { open = false; }}>
    <h2>{text(labels.title, "Neural Remapping")}</h2>
    {#if overviewError}
      <p role="alert">{overviewError}</p>
    {:else if !overview}
      <p role="status">Reading base attributes…</p>
    {:else}
      <dl class="overview">
        {#each overview as row (row.id)}
          {@const attribute = CHARACTER_ATTRIBUTES.find(item => item.id === row.id)}
          {#if attribute}
            <div data-overview-attribute={row.id}>
              <dt><img src={icon(attribute.icon)} alt="" />{text(root + "Attribute" + attribute.name, attribute.name)}</dt>
              <dd><meter min={REMAP_MIN} max={REMAP_MAX} value={row.base} aria-label={`${attribute.name} base points`} title={String(row.base)}></meter>
                <span title="Implant bonus">{row.implantBonus ? text(labels.implantBonus, `+${row.implantBonus}`, { implantBonus: row.implantBonus }) : text(labels.implantZero, "+0")}</span>
                <strong>{row.base + row.implantBonus}</strong></dd>
            </div>
          {/if}
        {/each}
      </dl>
    {/if}
    <footer><form method="dialog"><button type="submit">Close</button></form></footer>
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
  .overview meter { width: clamp(44px, 18vw, 110px); }
  .overview strong { min-width: 2ch; text-align: right; }
  footer { display: flex; justify-content: end; padding-top: 12px; }
</style>
