<script lang="ts">
  import { getContext, tick } from "svelte";
  import type { AppFlow, ObjectiveDungeonJob } from "../app/flow.ts";
  import { standingWithSkillBonus } from "../bridge/agencyAgents.ts";
  import { ObjectiveChain, type AbyssObjectiveRow } from "../bridge/abyssObjectives.ts";
  import { dungeonEntryObjectives, dungeonObjectiveContext, SHIP_RESTRICTIONS_LABELS, winterNexusDeposited, winterNexusEntryObjectives } from "../bridge/dungeonTracking.ts";
  import { isSceneBlind } from "../bridge/space.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { holdToOpen } from "../play/radialMenu.ts";
  import type { SpaceView } from "../play/spaceView.ts";
  import { spaceSelection } from "../space/selection.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName, type NameRef } from "../store/names.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import DungeonShipRestrictionsTask from "./DungeonShipRestrictionsTask.svelte";

  let { store, flow, job }: { store: ClientStore; flow: AppFlow; job: ObjectiveDungeonJob } = $props();
  // svelte-ignore state_referenced_locally
  const { flight, space, station, names, words, skills, standings, inventory } = store;
  // svelte-ignore state_referenced_locally
  const corporationFactions = flow.corporationFactions;
  // svelte-ignore state_referenced_locally
  const activeDungeon = flow.activeDungeon;
  // svelte-ignore state_referenced_locally
  const objectivesClosed = flow.activeDungeonObjectivesClosed;
  const location = "UI/Generic/CurrentLocation";
  const getSpaceView = getContext<() => SpaceView | null>("flightSpaceView");
  const getSimNow = getContext<() => number | null>("flightSimNow");
  let chain = $state.raw<ObjectiveChain | null>(null);
  let rows = $state.raw<readonly AbyssObjectiveRow[]>([]);
  const chainID = $derived(job.data?.objectiveChainID ?? null);
  const jobKind = $derived(job.kind);
  const pilotID = $derived($station.online?.characterID ?? null);
  const instanceID = $derived($activeDungeon?.instanceID ?? null);
  const winterRules = $derived(job.data?.winterNexusObjectives);
  const winterRestartMs = $derived(winterRules?.restartHackMs ?? 0);
  const winterGrid = $derived.by(() => {
    const snapshot = $space.snapshot;
    if (!snapshot || snapshot.solarSystemID !== job.solarSystemID || isSceneBlind(true, snapshot)) return "waiting";
    return snapshot.ship?.warp ? "warping" : "landed";
  });
  const winterDeposit = $derived(winterNexusDeposited($activeDungeon));
  let delayingWinterHack = $state(false);
  const targets = $derived(new Map(($space.snapshot?.entities ?? []).map((entity) => [entity.itemID, entity])));
  let menu: HTMLDivElement;
  let menuEntries = $state.raw<ReturnType<SpaceView["objectiveTargetMenu"]>>([]);
  let pointerSelected = false;
  let entryObjectives: readonly string[] = [];
  const standingByFaction = $derived($standings.char && new Map($standings.char.map((entry) => [entry.fromID, entry.standing])));
  const levelBySkill = $derived($skills.skills && new Map($skills.skills.map((skill) => [skill.typeID, skill.level])));

  function npcStanding(ownerID: number): number | null {
    // npcs.common.owner.get_npc_faction and npcs.client.entitystandings.
    const factionID = ownerID >= 500000 && ownerID < 599999 ? ownerID : $corporationFactions?.[String(ownerID)];
    if (factionID === 500021 || (factionID === undefined && $corporationFactions !== null)) return 0;
    if (factionID === undefined || !standingByFaction || !levelBySkill) return null;
    return standingWithSkillBonus(factionID, factionID, standingByFaction, (id) => levelBySkill.get(id) ?? 0);
  }

  $effect(() => {
    chain = null;
    rows = [];
    entryObjectives = [];
    if (!chainID || !pilotID || instanceID === null) return;
    let current = true;
    if (jobKind === "combat") {
      flow.loadCorporationFactions();
      if (standings.get().char === null) void flow.loadStandings().catch(() => {});
      if (skills.get().skills === null) void flow.loadSkills().catch(() => {});
    }
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
    if (winterRestartMs > 0 && instanceID !== null) void flow.loadInventory().catch(() => {});
  });

  $effect(() => {
    const wait = winterRestartMs > 0 && instanceID !== null && winterDeposit && winterGrid === "landed";
    delayingWinterHack = wait;
    if (!wait) return;
    const timer = setTimeout(() => { delayingWinterHack = false; }, winterRestartMs);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    const snapshot = $space.snapshot;
    const dungeon = $activeDungeon;
    if (!chain || !dungeon || snapshot?.solarSystemID !== job.solarSystemID) return;
    if ($objectivesClosed) {
      for (const key of entryObjectives) chain.stopObjective(key);
      entryObjectives = [];
      rows = [];
      return;
    }
    if (winterRules && winterGrid === "waiting") return;
    for (const [key, value] of Object.entries(dungeonObjectiveContext(dungeon))) chain.setContext(key, value);
    chain.observe(snapshot.entities, getSimNow?.() ?? snapshot.sampledAtMs, npcStanding);
    const hasDevice = !!winterRules && $inventory.activeShipID === snapshot.shipID && $inventory.cargo.error === null &&
      $inventory.cargo.rows.some((row) => row.typeID === winterRules.cargoTypeID && row.quantity > 0);
    const wanted = winterRules
      ? winterNexusEntryObjectives(dungeon, winterRules, winterGrid, hasDevice, delayingWinterHack, entryObjectives)
      : dungeonEntryObjectives(dungeon, job.data?.objectiveEntryRules ?? []);
    for (const key of entryObjectives) if (!wanted.includes(key)) chain.stopObjective(key);
    for (const key of wanted) chain.startObjective(key);
    entryObjectives = wanted;
    rows = chain.view().filter((objective) => objective.rows.length > 0 || objective.completed || objective.titleOnly);
  });

  $effect(() => {
    const labels = new Set([location]);
    const namesToLoad: NameRef[] = [];
    for (const objective of rows) {
      if (objective.titleLabel) labels.add(objective.titleLabel);
      for (const row of objective.rows) {
        if (row.titleLabel) labels.add(row.titleLabel);
        if (row.shipRestrictionGateID !== undefined) labels.add(SHIP_RESTRICTIONS_LABELS.task);
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
  <div class="signature-objective" class:objective-completed={objective.completed}>
    {#if objective.titleLabel}<strong>{word(objective.titleLabel)}</strong>{/if}
    {#each objective.rows as row (row.key)}
      {@const name = title(row)}
      {#if row.itemID !== null}
        {@const itemID = row.itemID}
        {#if row.shipRestrictionGateID !== undefined && $activeDungeon}
          <DungeonShipRestrictionsTask {flow} dungeonID={$activeDungeon.dungeonID} gateID={row.shipRestrictionGateID}
            shipTypeID={$flight.status?.shipTypeID ?? null} label={word(SHIP_RESTRICTIONS_LABELS.task)} />
        {/if}
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
      {:else if row.progress !== null}
        <div class="objective-progress" class:danger={row.danger}>
          <span>{name}</span><span>{row.value}</span>
          <div class="objective-progress-bar" role="progressbar" aria-label={name}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(row.progress * 100)}>
            <div style:width={`${row.progress * 100}%`}></div>
          </div>
        </div>
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
  .objective-progress { display: grid; grid-template-columns: 1fr auto; gap: 3px; }
  .objective-progress-bar { grid-column: 1 / -1; height: 4px; background: rgb(255 255 255 / 0.2); }
  .objective-progress-bar div { height: 100%; background: #c5cdd0; }
  .objective-progress.danger .objective-progress-bar div { background: var(--color-danger, #e08a8a); }
  .objective-completed { border-left: 2px solid var(--color-good, #6cc79a); padding-left: 6px; }
  .completed { color: #9fd689; }
  p { margin: 3px 0 5px; opacity: 0.8; font-size: 12px; }
  .target:hover, .target:focus-visible { background: rgb(255 255 255 / 0.12); }
  .target-menu { position: fixed; margin: 0; padding: 3px; border: 1px solid #667275; background: #151b1e; color: #e4e9eb; min-width: 140px; }
  .target-menu button { display: block; width: 100%; padding: 5px 8px; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; }
  .target-menu button:hover, .target-menu button:focus-visible { background: #38484c; }
</style>
