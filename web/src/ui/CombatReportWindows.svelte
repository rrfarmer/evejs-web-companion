<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { COMBAT_REPORT_LABEL, combatReportHash, combatReportUrl, type CombatReportWindow } from "../bridge/combatLog.ts";
  import { COMBAT_REPORT_WORDS, combatReportNameRefs, combatReportText } from "../bridge/combatReportPresentation.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import DesktopWindow from "./DesktopWindow.svelte";
  import { startLinkDrag } from "./linkFollowers.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import type { WindowRect } from "./windowResize.ts";

  let { store, flow, inFront }: { store: ClientStore; flow: AppFlow; inFront: boolean } = $props();
  const windows = $derived(flow.combatReportWindows), names = $derived(store.names), words = $derived(store.words);
  const caption = $derived(plainText($words.templates[COMBAT_REPORT_LABEL] || "Kill Report"));
  const dragLabel = "UI/Corporations/Wars/DragToShare";
  const dragHint = $derived(plainText($words.templates[dragLabel] || "Drag to share"));
  let layout = $state.raw<Readonly<Record<string, WindowRect>>>({});
  let hashes = $state.raw<ReadonlyMap<number, string>>(new Map());

  $effect(() => {
    const reports = $windows.map(window => window.report);
    if (!reports.length) { hashes = new Map(); return; }
    flow.requestWords([COMBAT_REPORT_LABEL, dragLabel, ...COMBAT_REPORT_WORDS]);
    flow.requestNames(combatReportNameRefs(reports));
    flow.requestSystemSecurity(reports.flatMap(row => row.solarSystemID ? [row.solarSystemID] : []));
    let current = true;
    void Promise.all(reports.map(async row => [row.killID, await combatReportHash(row)] as const))
      .then(result => { if (current) hashes = new Map(result); }).catch(() => {});
    return () => { current = false; };
  });

  function rectangle(view: CombatReportWindow): WindowRect {
    const width = Math.min(innerWidth, 540), height = Math.min(innerHeight, 580);
    const spread = view.id === "KillReportWnd" ? 0 : 24 * (view.report.killID % 6 + 1);
    return layout[view.id] ?? {
      x: Math.min(innerWidth - width, Math.round((innerWidth - width) / 2) + spread),
      y: Math.min(innerHeight - height, Math.round((innerHeight - height) / 2) + spread),
      w: width, h: height,
    };
  }

  function close(id: string): void {
    flow.closeCombatReportWindow(id);
    const next = { ...layout };
    delete next[id];
    layout = next;
  }

  function drag(event: DragEvent, view: CombatReportWindow): void {
    const hash = hashes.get(view.report.killID);
    if (hash) startLinkDrag(event, combatReportUrl(view.report.killID, hash), caption);
  }
</script>

{#if inFront && $windows.length}
  <div class="combat-report-layer">
    {#each $windows as view, index (view.id)}
      {@const rect = rectangle(view)}
      <DesktopWindow win={{ id: view.id, ...rect, minimized: false, z: index + 1 }} title={caption}
        icon={clientTexture("res:/UI/Texture/WindowIcons/killreport.png")} focused={index === $windows.length - 1}
        minWidth={Math.min(innerWidth, 320)} minHeight={Math.min(innerHeight, 260)}
        onFocus={() => flow.raiseCombatReportWindow(view.id)} onClose={() => close(view.id)}
        onMove={(x, y) => { layout = { ...layout, [view.id]: { ...rect, x, y } }; }}
        onResizeRect={next => { layout = { ...layout, [view.id]: next }; }}>
        {#snippet headerActions()}
          <span class="report-link" role="presentation" draggable={hashes.has(view.report.killID)} ondragstart={event => drag(event, view)}
            onpointerdown={event => event.stopPropagation()} title={dragHint}>{dragHint}</span>
        {/snippet}
        <pre data-kill-report-id={view.report.killID}>{combatReportText(view.report, $names, $words.templates)}</pre>
      </DesktopWindow>
    {/each}
  </div>
{/if}

<style>
  .combat-report-layer { position: fixed; inset: 0; pointer-events: none; z-index: 160; }
  .combat-report-layer :global(.win) { pointer-events: auto; }
  pre { color: inherit; font: inherit; white-space: pre-wrap; }
  .report-link { color: var(--color-accent-bright); cursor: grab; padding: 2px 8px; }
</style>
