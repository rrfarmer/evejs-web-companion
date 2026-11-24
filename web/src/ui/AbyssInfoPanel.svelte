<script lang="ts">
  // The client's Abyssal info panel (eve/client/script/ui/shared/infoPanels/infoPanelAbyss.py InfoPanelAbyss), shown in
  // an Abyssal system while the abyss service has its objective chain (IsAvailable): headed "Abyssal Deadspace", and
  // the chain drawn as the client's objectives UI draws one (objectives/client/ui): each objective's title over its
  // tasks (ObjectiveEntry); a task's icon, or a check where it is complete, its title and its value
  // (ObjectiveTaskWidget); a progress task's bar, red for the targets left and green once complete
  // (ProgressBarTaskWidget); a target's hull, armour and shield bars in red (EnemyTargetWidget). What it shows is the
  // flow's (bridge/abyssObjectives.ts); the space feed is claimed while it is shown.
  //
  // A target's row (TargetTask: the gate to jump through, a lootable) is its thing's: the mouse pressed on it selects
  // the thing (mouse_down: stateSvc.SetState(selected), and the action menu, which here is the overview's action bar
  // for the selected thing), and a double click activates it (double_click: menu.Activate, flow.activateSpaceThing).
  // The other tasks' rows do nothing (ObjectiveTask's own mouse_down and double_click).
  //
  // Floating, it sits at the top left of the work area, where the client stacks its info panels; else it is a block
  // of the phone's in-space column.
  //
  // Not as the client has it yet: the icons (eveicon's); a target's click (the camera tracking it), its menu
  // (CelestialMenu: the space view has it - SpaceView.menuEntriesFor, as BuffBar opens a source's - not wired to these
  // rows yet, and not checked live: no abyssal run on the harness) and its highlight in space on hover; a locked target made the
  // active one on the mouse down (TacticalItemClicked); the header's menu.
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { ABYSS_PANEL_LABEL, type AbyssTaskRow } from "../bridge/abyssObjectives.ts";
  import { isAbyssalSystem } from "../bridge/scannerWrites.ts";
  import { spaceSelection } from "../space/selection.ts";
  import { resolvedName } from "../store/names.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";

  let { store, flow, floating = false }: { store: ClientStore; flow: AppFlow; floating?: boolean } = $props();
  // svelte-ignore state_referenced_locally
  const objectives = flow.abyssObjectives;
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const flight = store.flight;

  const nameOf = (kind: Parameters<typeof resolvedName>[1], id: number): string => resolvedName($names.resolved, kind, id, "");
  function word(label: string): string {
    const template = $words.templates[label];
    return typeof template === "string" ? plainText(formatTemplate(template, {}, { nameOf })) : "";
  }

  // InfoPanelAbyss.IsAvailable: an Abyssal system, and a chain.
  const available = $derived(isAbyssalSystem($flight.status?.solarSystemID ?? null) && $objectives !== null);
  const shown = $derived(available ? ($objectives ?? []) : []);

  /** eveicon's names for the chain's icons, as signs. */
  const ICONS: Readonly<Record<string, string>> = { more_horizontal: "⋯", target: "◎", jump_to: "➜" };
  function title(row: AbyssTaskRow): string {
    if (row.titleLabel !== null) return word(row.titleLabel);
    return row.typeID !== null ? nameOf("type", row.typeID) : "";
  }
  // TargetTask.mouse_down and double_click, for a row with a thing.
  function selectThing(row: AbyssTaskRow): void {
    if (row.itemID !== null) spaceSelection.select(row.itemID);
  }
  function activateThing(row: AbyssTaskRow): void {
    if (row.itemID !== null) void flow.activateSpaceThing(row.itemID).catch(() => {});
  }

  $effect(() => {
    if (!available) return;
    const labels = new Set<string>([ABYSS_PANEL_LABEL]);
    const types = new Set<number>();
    for (const objective of shown) {
      if (objective.titleLabel !== null) labels.add(objective.titleLabel);
      for (const row of objective.rows) {
        if (row.titleLabel !== null) labels.add(row.titleLabel);
        if (row.typeID !== null) types.add(row.typeID);
      }
    }
    flow.requestWords([...labels]);
    if (types.size > 0) flow.requestNames([...types].map((id) => ({ kind: "type" as const, id })));
  });
  // The space feed, for the targets counted and the gate found, while the panel is shown.
  $effect(() => {
    if (!available) return;
    flow.startSpacePolling();
    return () => flow.stopSpacePolling();
  });
</script>

{#if available}
  <section class="abyss-panel" class:floating aria-label={word(ABYSS_PANEL_LABEL) || "Abyssal Deadspace"}>
    <header class="abyss-head">{word(ABYSS_PANEL_LABEL) || "Abyssal Deadspace"}</header>
    {#each shown as objective (objective.key)}
      <div class="abyss-objective" class:completed={objective.completed}>
        {#if objective.titleLabel !== null}<h4 class="abyss-objective-title">{word(objective.titleLabel)}</h4>{/if}
        {#each objective.rows as row (row.key)}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="abyss-task"
            class:thing={row.itemID !== null}
            onmousedown={() => selectThing(row)}
            ondblclick={() => activateThing(row)}
          >
            <div class="abyss-task-line">
              <span class="abyss-icon" class:check={row.completed} aria-hidden="true">{row.completed ? "✓" : (row.icon !== null ? (ICONS[row.icon] ?? "") : "")}</span>
              <span class="abyss-task-title">{title(row)}</span>
              {#if row.value}<span class="abyss-task-value">{row.value}</span>{/if}
            </div>
            {#if row.progress !== null}
              <div class="abyss-bar"><span class="abyss-fill" class:danger={row.danger} class:done={row.completed && !row.danger} style="width:{Math.max(0, Math.min(1, row.progress)) * 100}%"></span></div>
            {/if}
            {#if row.health !== null}
              <div class="abyss-health" aria-label="Hull, armour and shield">
                {#each [row.health.hull, row.health.armor, row.health.shield] as part, index (index)}
                  <div class="abyss-bar"><span class="abyss-fill danger" style="width:{Math.max(0, Math.min(1, part)) * 100}%"></span></div>
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/each}
  </section>
{/if}

<style>
  .abyss-panel {
    display: grid;
    gap: 4px;
    padding: 6px 8px;
    background: var(--color-panel, #11161c);
    border: 1px solid var(--color-line, #2b3540);
    font-size: 0.85rem;
  }
  /* Under the desktop's windows (z-index 1 and up), as the client's windows draw over its info panels; over the view. */
  .abyss-panel.floating {
    position: absolute;
    left: 0.6rem;
    top: 0.6rem;
    width: min(18rem, calc(100% - 1.2rem));
    z-index: 0;
  }
  .abyss-head {
    font-weight: 600;
    color: var(--color-text-bright, #e6f0fa);
  }
  .abyss-objective {
    padding: 4px 8px;
    background: rgba(0, 0, 0, 0.25);
    border-left: 2px solid transparent;
  }
  .abyss-objective.completed {
    border-left-color: var(--color-good, #6cc79a);
  }
  .abyss-objective-title {
    margin: 2px 0 4px;
    font-size: 0.95rem;
  }
  .abyss-task {
    padding: 2px 0;
  }
  /* ObjectiveTaskWidget.OnMouseEnter: a faint light over the row. */
  .abyss-task.thing {
    cursor: pointer;
    user-select: none;
  }
  .abyss-task:hover {
    background: rgba(255, 255, 255, 0.05);
  }
  .abyss-task-line {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .abyss-icon {
    width: 16px;
    text-align: center;
    color: var(--color-muted, #8fa3b8);
  }
  .abyss-icon.check {
    color: var(--color-good, #6cc79a);
  }
  .abyss-task-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .abyss-bar {
    position: relative;
    height: 4px;
    margin-top: 2px;
    background: rgba(255, 255, 255, 0.12);
  }
  .abyss-fill {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    background: var(--color-accent, #7fb4d9);
    transition: width 1s;
  }
  .abyss-fill.danger {
    background: var(--color-danger, #e08a8a);
  }
  .abyss-fill.done {
    background: var(--color-good, #6cc79a);
  }
  .abyss-health {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 4px;
  }
</style>
