<script lang="ts">
  import { getContext, tick } from "svelte";
  import type { AppFlow, SignatureDungeonJob } from "../app/flow.ts";
  import { ObjectiveChain, type AbyssObjectiveRow } from "../bridge/abyssObjectives.ts";
  import { dungeonEntryObjectives, dungeonObjectiveContext } from "../bridge/dungeonTracking.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { holdToOpen } from "../play/radialMenu.ts";
  import type { SpaceView } from "../play/spaceView.ts";
  import { spaceSelection } from "../space/selection.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName, type NameRef } from "../store/names.ts";
  import { clientTexture } from "./skillGroupIcons.ts";

  let { store, flow, job }: { store: ClientStore; flow: AppFlow; job: SignatureDungeonJob } = $props();
  // svelte-ignore state_referenced_locally
  const { space, station, names, words } = store;
  // svelte-ignore state_referenced_locally
  const activeDungeon = flow.activeDungeon;
  const location = "UI/Generic/CurrentLocation";
  const getSpaceView = getContext<() => SpaceView | null>("flightSpaceView");
  let chain = $state.raw<ObjectiveChain | null>(null);
  let rows = $state.raw<readonly AbyssObjectiveRow[]>([]);
  const chainID = $derived(job.data?.objectiveChainID ?? null);
  const pilotID = $derived($station.online?.characterID ?? null);
  const instanceID = $derived($activeDungeon?.instanceID ?? null);
  const targets = $derived(new Map(($space.snapshot?.entities ?? []).map((entity) => [entity.itemID, entity])));
  let menu: HTMLDivElement;
  let menuEntries = $state.raw<ReturnType<SpaceView["objectiveTargetMenu"]>>([]);
  let pointerSelected = false;

  $effect(() => {
    chain = null;
    rows = [];
    if (!chainID || !pilotID || instanceID === null) return;
    let current = true;
    void flow.readObjectiveChain(chainID).then((data) => {
      if (!current || !data) return;
      const dungeon = $activeDungeon;
      if (!dungeon || dungeon.instanceID !== instanceID) return;
      const objectives = new ObjectiveChain(data, dungeonObjectiveContext(dungeon), pilotID);
      objectives.start([]);
      chain = objectives;
    });
    flow.startSpacePolling();
    return () => { current = false; flow.stopSpacePolling(); };
  });

  $effect(() => {
    const snapshot = $space.snapshot;
    const dungeon = $activeDungeon;
    if (!chain || !dungeon || snapshot?.solarSystemID !== job.solarSystemID) return;
    for (const [key, value] of Object.entries(dungeonObjectiveContext(dungeon))) chain.setContext(key, value);
    chain.observe(snapshot.entities);
    for (const key of dungeonEntryObjectives(dungeon, job.data?.objectiveEntryRules ?? [])) chain.startObjective(key);
    rows = chain.view().filter((objective) => objective.rows.length > 0);
  });

  $effect(() => {
    const labels = new Set([location]);
    const namesToLoad: NameRef[] = [];
    for (const objective of rows) {
      if (objective.titleLabel) labels.add(objective.titleLabel);
      for (const row of objective.rows) {
        if (row.titleLabel) labels.add(row.titleLabel);
        const target = row.itemID === null ? undefined : targets.get(row.itemID);
        if (target?.nameMessageID !== undefined) labels.add(`#${target.nameMessageID}`);
        if (target?.characterID != null) namesToLoad.push({ kind: "character", id: target.characterID });
        if (row.typeID !== null) namesToLoad.push({ kind: "type", id: row.typeID });
      }
    }
    flow.requestWords([...labels]);
    flow.requestNames(namesToLoad);
  });

  const nameOf = (kind: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, kind, id, "");
  const word = (label: string) => plainText(formatTemplate($words.templates[label] ?? "", {}, { nameOf }));

  function title(row: AbyssObjectiveRow["rows"][number]): string {
    if (row.titleLabel) return word(row.titleLabel);
    const target = row.itemID === null ? undefined : targets.get(row.itemID);
    const localized = target?.nameMessageID !== undefined ? word(`#${target.nameMessageID}`) : "";
    const pilot = target?.characterID != null ? nameOf("character", target.characterID) : "";
    return localized || pilot || (row.typeID === null ? "" : nameOf("type", row.typeID));
  }

  function selectTarget(itemID: number): boolean {
    const view = getSpaceView?.();
    if (view) return view.selectObjectiveTarget(itemID);
    spaceSelection.select(itemID);
    return true;
  }

  function holdTarget(node: HTMLButtonElement, itemID: number) {
    const destroy = holdToOpen(node, () => pointerSelected ? itemID : null,
      (id, x, y) => getSpaceView?.()?.openObjectiveRadial(id, x, y), false);
    return { destroy() { destroy(); getSpaceView?.()?.highlightObjectiveTarget(itemID, false); } };
  }

  async function openTargetMenu(event: MouseEvent, itemID: number): Promise<void> {
    const view = getSpaceView?.();
    if (!view) return;
    event.preventDefault();
    const source = event.currentTarget as HTMLButtonElement;
    menuEntries = view.objectiveTargetMenu(itemID);
    if (!menuEntries.length) return;
    await tick();
    if (!source.isConnected || !menu?.isConnected) return;
    if (!menu.matches(":popover-open")) menu.showPopover({ source });
    const { width, height } = menu.getBoundingClientRect();
    const anchor = source.getBoundingClientRect();
    const x = event.clientX || anchor.left;
    const y = event.clientY || anchor.bottom;
    menu.style.left = `${Math.max(0, Math.min(x, innerWidth - width))}px`;
    menu.style.top = `${Math.max(0, Math.min(y, innerHeight - height))}px`;
  }
</script>

{#each rows as objective (objective.key)}
  <div class="signature-objective">
    {#if objective.titleLabel}<strong>{word(objective.titleLabel)}</strong>{/if}
    {#each objective.rows as row (row.key)}
      {@const name = title(row)}
      {#if row.itemID !== null}
        {@const itemID = row.itemID}
        <button type="button" class="target" class:completed={row.completed}
          onpointerdowncapture={(event) => { pointerSelected = event.button === 0 && selectTarget(itemID); }}
          use:holdTarget={itemID}
          onpointerenter={() => getSpaceView?.()?.highlightObjectiveTarget(itemID, true)}
          onpointerleave={() => getSpaceView?.()?.highlightObjectiveTarget(itemID, false)}
          onclick={(event) => {
            if (event.detail === 0 ? selectTarget(itemID) : pointerSelected) getSpaceView?.()?.trackObjectiveTarget(itemID);
          }}
          ondblclick={() => {
            if (pointerSelected && (getSpaceView?.()?.canActivateObjectiveTarget(itemID) ?? true)) {
              void flow.activateSpaceThing(itemID).catch(() => {});
            }
          }}
          oncontextmenu={(event) => { void openTargetMenu(event, itemID); }}>
          {#if row.completed}<img alt="" src={clientTexture("res:/UI/Texture/eveicon/system_icons/checkmark_16px.png")} />{/if}
          {name}
        </button>
      {:else if name}
        <span>{name} {row.value}</span>
      {/if}
    {/each}
  </div>
{:else}
  <p>{word(location)}</p>
{/each}

<div class="target-menu" popover="auto" bind:this={menu} aria-label="Target actions">
  {#each menuEntries as entry (entry.title)}
    <button type="button" onclick={() => { menu.hidePopover(); entry.run(); }}>{entry.title}</button>
  {/each}
</div>

<style>
  .signature-objective { display: grid; gap: 4px; padding: 6px 8px; background: rgb(0 0 0 / 0.25); font-size: 12px; }
  .target { display: flex; gap: 4px; align-items: center; padding: 2px 0; border: 0; color: inherit; background: transparent; text-align: left; font: inherit; cursor: pointer; }
  .target img { width: 16px; height: 16px; }
  .completed { color: #9fd689; }
  p { margin: 3px 0 5px; opacity: 0.8; font-size: 12px; }
  .target:hover, .target:focus-visible { background: rgb(255 255 255 / 0.12); }
  .target-menu { position: fixed; margin: 0; padding: 3px; border: 1px solid #667275; background: #151b1e; color: #e4e9eb; min-width: 140px; }
  .target-menu button { display: block; width: 100%; padding: 5px 8px; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; }
  .target-menu button:hover, .target-menu button:focus-visible { background: #38484c; }
</style>
