<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import type { CharacterPreviewAppearance } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { KILL_REPORT_BREAKDOWN_WORDS } from "../bridge/combatReportBreakdown.ts";
  import { COMBAT_REPORT_LABEL, combatReportHash, combatReportUrl, externalCombatReportUrl, type CombatReportWindow } from "../bridge/combatLog.ts";
  import { COMBAT_REPORT_WORDS, combatReportNameRefs, combatReportText } from "../bridge/combatReportPresentation.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { ContextMenu } from "../play/contextMenu.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import CombatReportBreakdown from "./CombatReportBreakdown.svelte";
  import CharacterPortraitWindow from "./CharacterPortraitWindow.svelte";
  import CharacterPreviewWindow from "./CharacterPreviewWindow.svelte";
  import TypePreviewWindow from "./TypePreviewWindow.svelte";
  import DesktopWindow from "./DesktopWindow.svelte";
  import type { InfoWindowHost } from "./infoWindowHost.ts";
  import { startLinkDrag } from "./linkFollowers.ts";
  import { portal } from "./portal.ts";
  import { notify } from "./notices.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import type { WindowRect } from "./windowResize.ts";

  let { store, flow, inFront, host, onOpenIndustry }: {
    store: ClientStore; flow: AppFlow; inFront: boolean; host: InfoWindowHost | null; onOpenIndustry: () => void;
  } = $props();
  const windows = $derived(flow.combatReportWindows), words = $derived(store.words), names = $derived(store.names);
  const word = (key: string, fallback: string) => plainText($words.templates[key] || fallback);
  const caption = $derived(word(COMBAT_REPORT_LABEL, "Kill Report"));
  const dragLabel = "UI/Corporations/Wars/DragToShare";
  const dragHint = $derived(word(dragLabel, "Drag to share"));
  const copyTextLabel = "UI/Control/Entries/CopyKillInfo";
  const copyLinkLabel = "UI/Control/Entries/CopyExternalKillLink";
  const more = new ContextMenu();
  onDestroy(() => more.close());
  let layout = $state.raw<Readonly<Record<string, WindowRect>>>({});
  let hashes = $state.raw<ReadonlyMap<number, string>>(new Map());
  let layerOrder = $state.raw<Readonly<Record<string, number>>>({});
  let portrait = $state.raw<{ characterID: number; rect: WindowRect; z: number; opening: number } | null>(null);
  let characterPreview = $state.raw<{ characterID: number; appearance: CharacterPreviewAppearance; rect: WindowRect; z: number } | null>(null);
  let typePreview = $state.raw<{ typeID: number; rect: WindowRect; z: number } | null>(null);
  let portraitOpening = 0;
  let previousHost: InfoWindowHost | null = null;
  let displayed: readonly CombatReportWindow[] = [];

  $effect(() => {
    const currentHost = host;
    const reports = $windows;
    if (!currentHost || !inFront) { previousHost = null; more.close(); return; }
    const opened = reports.filter(view => currentHost !== previousHost || !displayed.includes(view));
    previousHost = currentHost;
    displayed = reports;
    if (opened.length) untrack(() => {
      currentHost.reveal();
      let z = currentHost.topZ();
      const next = { ...layerOrder };
      for (const view of opened) next[view.id] = ++z;
      layerOrder = next;
    });
  });

  $effect(() => {
    const reports = $windows.map(window => window.report);
    if (!reports.length) { hashes = new Map(); return; }
    flow.requestWords([COMBAT_REPORT_LABEL, dragLabel, copyTextLabel, copyLinkLabel, ...COMBAT_REPORT_WORDS,
      ...KILL_REPORT_BREAKDOWN_WORDS, "UI/Generic/Copy", "UI/Generic/Original", "UI/Abyss/AbyssalDepths"]);
    flow.requestNames(combatReportNameRefs(reports));
    flow.requestSystemSecurity(reports.flatMap(row => row.solarSystemID ? [row.solarSystemID] : []));
    let current = true;
    void Promise.all(reports.map(async row => [row.killID, await combatReportHash(row)] as const))
      .then(result => { if (current) hashes = new Map(result); }).catch(() => {});
    return () => { current = false; };
  });

  function rectangle(view: CombatReportWindow): WindowRect {
    const areaWidth = host?.element.clientWidth || innerWidth, areaHeight = host?.element.clientHeight || innerHeight;
    const width = Math.min(areaWidth, 650), height = Math.min(areaHeight, 640);
    const spread = view.id === "KillReportWnd" ? 0 : 24 * (view.report.killID % 6 + 1);
    return layout[view.id] ?? {
      x: Math.min(areaWidth - width, Math.round((areaWidth - width) / 2) + spread),
      y: Math.min(areaHeight - height, Math.round((areaHeight - height) / 2) + spread),
      w: width, h: height,
    };
  }

  function close(id: string): void {
    more.close();
    flow.closeCombatReportWindow(id);
    const next = { ...layout };
    delete next[id];
    layout = next;
    const order = { ...layerOrder };
    delete order[id];
    layerOrder = order;
  }

  function focus(id: string): void {
    const top = host?.topZ() ?? 0;
    if ((layerOrder[id] ?? 0) < top) layerOrder = { ...layerOrder, [id]: top + 1 };
    flow.raiseCombatReportWindow(id);
  }

  function drag(event: DragEvent, view: CombatReportWindow): void {
    const hash = hashes.get(view.report.killID);
    if (hash) startLinkDrag(event, combatReportUrl(view.report.killID, hash), caption);
  }

  function showPortrait(characterID: number): void {
    if (!host) return;
    const size = host.element;
    const width = size.clientWidth || innerWidth, height = size.clientHeight || innerHeight;
    const w = Math.min(width, 520), h = Math.min(height, 596);
    characterPreview = null;
    portrait = { characterID, rect: { w, h, x: Math.round((width - w) / 2), y: Math.round((height - h) / 2) },
      z: host.topZ() + 1, opening: ++portraitOpening };
  }

  function showCharacterPreview(characterID: number, appearance: CharacterPreviewAppearance): void {
    if (!host) return;
    const width = host.element.clientWidth || innerWidth, height = host.element.clientHeight || innerHeight;
    const w = Math.min(width, 540), h = Math.min(height, 560);
    const rect = { w, h, x: Math.round((width - w) / 2), y: Math.round((height - h) / 2) };
    characterPreview = { characterID, appearance, rect, z: host.topZ() + 1 };
    portrait = null;
    host.closeTab?.("characterSheet");
  }

  function focusCharacterPreview(): void {
    if (!host || !characterPreview) return;
    const top = host.topZ();
    if (top > characterPreview.z) characterPreview = { ...characterPreview, z: top + 1 };
  }

  function focusPortrait(): void {
    if (!host || !portrait) return;
    const top = host.topZ();
    if (top > portrait.z) portrait = { ...portrait, z: top + 1 };
  }

  function showTypePreview(typeID: number): void {
    if (!host) return;
    const width = host.element.clientWidth || innerWidth, height = host.element.clientHeight || innerHeight;
    const w = Math.min(width, 660), h = Math.min(height, 480);
    const rect = typePreview?.rect ?? { w, h, x: Math.round((width - w) / 2), y: Math.round((height - h) / 2) };
    typePreview = { typeID, rect, z: host.topZ() + 1 };
  }

  function focusTypePreview(): void {
    if (!host || !typePreview) return;
    const top = host.topZ();
    if (top > typePreview.z) typePreview = { ...typePreview, z: top + 1 };
  }

  async function copy(text: string | Promise<string>): Promise<void> {
    try {
      await navigator.clipboard.writeText(await text);
    } catch (error) {
      notify({ kind: "danger", title: caption, detail: panelErrorWords(error) });
    }
  }

  function options(event: MouseEvent, view: CombatReportWindow): void {
    const bounds = (event.currentTarget as HTMLButtonElement).getBoundingClientRect();
    focus(view.id);
    const report = view.report;
    more.open(bounds.left, bounds.bottom, [
      { path: copyTextLabel, label: word(copyTextLabel, "Copy Kill Information"),
        run: () => void copy(combatReportText(report, $names, $words.templates)) },
      { path: copyLinkLabel, label: word(copyLinkLabel, "Copy External Kill Link"),
        run: () => void copy(Promise.resolve(hashes.get(report.killID) ?? combatReportHash(report))
          .then(hash => externalCombatReportUrl(report.killID, hash))) },
    ]);
  }
</script>

{#if inFront && host && ($windows.length || portrait || characterPreview || typePreview)}
  <div class="combat-report-layer" use:portal={host.element}>
    {#each $windows as view (view.id)}
      {@const rect = rectangle(view)}
      <DesktopWindow win={{ id: view.id, ...rect, minimized: false, z: layerOrder[view.id] ?? 1 }} title={caption}
        icon={clientTexture("res:/UI/Texture/WindowIcons/killreport.png")} focused={(layerOrder[view.id] ?? 0) >= host.topZ()}
        minWidth={Math.min(host.element.clientWidth || innerWidth, 650)} minHeight={Math.min(host.element.clientHeight || innerHeight, 640)}
        onFocus={() => focus(view.id)} onClose={() => close(view.id)}
        onMove={(x, y) => { layout = { ...layout, [view.id]: { ...rect, x, y } }; }}
        onResizeRect={next => { layout = { ...layout, [view.id]: next }; }}>
        {#snippet headerActions()}
          <span class="report-link" role="presentation" draggable={hashes.has(view.report.killID)} ondragstart={event => drag(event, view)}
            onpointerdown={event => event.stopPropagation()} title={dragHint}>{dragHint}</span>
          <button type="button" class="win-btn report-more" aria-label="More options" title="More options"
            onpointerdown={event => event.stopPropagation()} onclick={event => options(event, view)}>⋯</button>
        {/snippet}
        {#key view.report.killID}
          <CombatReportBreakdown report={view.report} {store} {flow} {onOpenIndustry} canShare={hashes.has(view.report.killID)}
            onShare={event => drag(event, view)} shareHint={dragHint} onPortrait={showPortrait} onTypePreview={showTypePreview} />
        {/key}
      </DesktopWindow>
    {/each}
    {#if portrait}
      {#key portrait.opening}
        <CharacterPortraitWindow {store} {flow} characterID={portrait.characterID} rect={portrait.rect} z={portrait.z}
          focused={portrait.z >= host.topZ()} onFocus={focusPortrait} onClose={() => portrait = null}
          onFullBody={appearance => { if (portrait) showCharacterPreview(portrait.characterID, appearance); }}
          onMove={(x, y) => { if (portrait) portrait = { ...portrait, rect: { ...portrait.rect, x, y } }; }} />
      {/key}
    {/if}
    {#if characterPreview}
      {#key characterPreview.characterID}
        <CharacterPreviewWindow {store} {flow} characterID={characterPreview.characterID} appearance={characterPreview.appearance}
          rect={characterPreview.rect} z={characterPreview.z}
          minWidth={Math.min(host.element.clientWidth || innerWidth, 420)} minHeight={Math.min(host.element.clientHeight || innerHeight, 320)}
          focused={characterPreview.z >= host.topZ()} onFocus={focusCharacterPreview} onClose={() => characterPreview = null}
          onPortrait={() => { if (characterPreview) showPortrait(characterPreview.characterID); }}
          onMove={(x, y) => { if (characterPreview) characterPreview = { ...characterPreview, rect: { ...characterPreview.rect, x, y } }; }}
          onResize={rect => { if (characterPreview) characterPreview = { ...characterPreview, rect }; }} />
      {/key}
    {/if}
    {#if typePreview}
      <TypePreviewWindow {store} {flow} typeID={typePreview.typeID} rect={typePreview.rect} z={typePreview.z}
        minWidth={Math.min(host.element.clientWidth || innerWidth, 660)} minHeight={Math.min(host.element.clientHeight || innerHeight, 320)}
        focused={typePreview.z >= host.topZ()} onFocus={focusTypePreview} onClose={() => typePreview = null}
        onMove={(x, y) => { if (typePreview) typePreview = { ...typePreview, rect: { ...typePreview.rect, x, y } }; }}
        onResize={rect => { if (typePreview) typePreview = { ...typePreview, rect }; }} />
    {/if}
  </div>
{/if}

<style>
  .combat-report-layer { position: absolute; inset: 0; pointer-events: none; }
  .combat-report-layer :global(.win) { pointer-events: auto; }
  .report-link { color: var(--color-accent-bright); cursor: grab; padding: 2px 8px; }
</style>
