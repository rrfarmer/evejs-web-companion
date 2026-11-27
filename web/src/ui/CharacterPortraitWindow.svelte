<script lang="ts">
  import { onDestroy } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { ContextMenu } from "../play/contextMenu.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import DesktopWindow from "./DesktopWindow.svelte";
  import OwnerPicture from "./OwnerPicture.svelte";
  import { portraitDefaultPath, portraitUrl } from "./ownerImages.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import type { WindowRect } from "./windowResize.ts";

  let { store, flow, characterID, rect, z, focused, onFocus, onMove, onClose }: {
    store: ClientStore; flow: AppFlow; characterID: number; rect: WindowRect;
    z: number; focused: boolean; onFocus: () => void; onMove: (x: number, y: number) => void; onClose: () => void;
  } = $props();
  const captionLabel = "UI/InfoWindow/PortraitCaption";
  const captureLabel = "UI/Commands/CapturePortrait";
  const closeLabel = "/Carbon/UI/Common/Close";
  const fullBodyLabel = "UI/Preview/ViewFullBody";
  const names = $derived(store.names), words = $derived(store.words), imageServer = $derived(flow.imageServer);
  const name = $derived(resolvedName($names.resolved, "owner", characterID, ""));
  const title = $derived($words.templates[captionLabel]
    ? plainText(formatTemplate($words.templates[captionLabel], { character: characterID }, { nameOf: () => name }))
    : name ? "Character: " + name : "Portrait");
  const picture = $derived(portraitUrl($imageServer, characterID, 512));
  const pictures = $derived([...(picture ? [picture] : []), clientTexture(portraitDefaultPath(512))]);
  const side = $derived(Math.max(1, Math.min(512, rect.w - 8, rect.h - 84)));
  const menu = new ContextMenu();
  let capturing = $state(false);
  let captureStatus = $state("");
  let previewing = $state(false);
  let previewStatus = $state("");
  let active = true;
  onDestroy(() => { active = false; menu.close(); });

  $effect(() => {
    flow.loadImageServer();
    flow.requestNames([{ kind: "owner", id: characterID }]);
    flow.requestWords([captionLabel, captureLabel, closeLabel, fullBodyLabel]);
  });

  async function viewFullBody(): Promise<void> {
    if (previewing) return;
    previewing = true;
    previewStatus = "";
    try {
      const appearance = await flow.readCharacterPreviewAppearance(characterID);
      if (!active) return;
      if (appearance === null) {
        flow.sayDialog("CharacterHasNoDNA", { type: "dict", entries: [["charID", characterID]] }, "No appearance data is available for this character.");
      } else {
        previewStatus = "Full-body preview is unavailable in the browser.";
      }
    } catch (error) {
      if (active) previewStatus = panelErrorWords(error);
    } finally {
      if (active) previewing = false;
    }
  }

  async function capture(): Promise<void> {
    if (capturing) return;
    capturing = true;
    captureStatus = "";
    let found = false;
    try {
      await flow.capturePortraits([characterID], (id, image) => {
        const bytes = Uint8Array.from(atob(image.base64), char => char.charCodeAt(0));
        const link = document.createElement("a");
        link.href = URL.createObjectURL(new Blob([bytes], { type: image.contentType }));
        link.download = id + ".jpg";
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
        found = true;
      }, () => {});
      if (!found) captureStatus = "Portrait image unavailable.";
    } catch (error) {
      captureStatus = panelErrorWords(error);
    } finally {
      capturing = false;
    }
  }

  function options(event: MouseEvent): void {
    event.preventDefault();
    onFocus();
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const byPointer = event.type === "contextmenu";
    menu.open(byPointer ? event.clientX : bounds.left, byPointer ? event.clientY : bounds.bottom, [
      { path: captureLabel, label: plainText($words.templates[captureLabel] || "Capture Portrait"), run: () => void capture() },
      { path: closeLabel, label: plainText($words.templates[closeLabel] || "Close"), run: onClose },
    ]);
  }
</script>

<DesktopWindow win={{ id: "PortraitWindow", ...rect, z, minimized: false }} {title} {focused} {onFocus} {onMove} {onClose} resizable={false}>
  {#snippet headerActions()}
    <button type="button" class="win-btn portrait-more" aria-label="More options" title="More options"
      onpointerdown={event => event.stopPropagation()} onclick={options}>⋯</button>
  {/snippet}
  <div class="character-portrait" data-character-portrait={characterID}>
    <div role="img" aria-label={title} oncontextmenu={options}>
      <OwnerPicture {name} urls={pictures} size={side} />
    </div>
    <button type="button" class="minor portrait-full-body" disabled={previewing} onclick={viewFullBody}>
      {plainText($words.templates[fullBodyLabel] || "View Full Body")}
    </button>
    {#if previewStatus}<span class="portrait-preview-status" role="status">{previewStatus}</span>{/if}
    {#if captureStatus}<span role="status">{captureStatus}</span>{/if}
  </div>
</DesktopWindow>

<style>
  :global([data-win="PortraitWindow"] > .win-body) { padding: 4px; }
  .character-portrait { display: flex; flex-direction: column; align-items: center; gap: 2px; }
  .character-portrait > div { line-height: 0; }
  .character-portrait > span { color: var(--color-muted); }
</style>
