<script lang="ts">
  import type { CharacterPreviewAppearance } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import DesktopWindow from "./DesktopWindow.svelte";
  import PortraitBaseHead from "./PortraitBaseHead.svelte";
  import type { WindowRect } from "./windowResize.ts";

  let { store, flow, characterID, appearance, rect, z, minWidth, minHeight, focused, onFocus, onMove, onResize, onClose, onPortrait }: {
    store: ClientStore; flow: AppFlow; characterID: number; appearance: CharacterPreviewAppearance;
    rect: WindowRect; z: number; minWidth: number; minHeight: number; focused: boolean;
    onFocus: () => void; onMove: (x: number, y: number) => void; onResize: (rect: WindowRect) => void;
    onClose: () => void; onPortrait: () => void;
  } = $props();
  const captionLabel = "UI/InfoWindow/PortraitCaption";
  const portraitLabel = "UI/Preview/ViewPortrait";
  const names = $derived(store.names), words = $derived(store.words);
  const name = $derived(resolvedName($names.resolved, "owner", characterID, ""));
  const title = $derived($words.templates[captionLabel]
    ? plainText(formatTemplate($words.templates[captionLabel], { character: characterID }, { nameOf: () => name }))
    : name ? "Character: " + name : "Character preview");

  $effect(() => {
    flow.requestNames([{ kind: "owner", id: characterID }]);
    flow.requestWords([captionLabel, portraitLabel]);
  });
</script>

<DesktopWindow win={{ id: "previewCharacterWnd", ...rect, z, minimized: false }} {title} {minWidth} {minHeight} {focused}
  {onFocus} {onClose} {onMove} onResizeRect={onResize}>
  <div class="character-preview" data-preview-character={characterID}>
    <div class="character-preview-stage">
      {#if appearance.model && (appearance.outfit || appearance.apparel.topmiddle)}
        <PortraitBaseHead model={appearance.model} bloodlineID={appearance.bloodlineID}
          outfit={appearance.outfit ?? appearance.apparel.topmiddle} apparel={appearance.apparel}
          hairstyle={appearance.hairstyle ?? undefined} morphs={appearance.morphs} piercings={appearance.piercings} />
      {:else}
        <p role="status">This character’s outfit could not be displayed.</p>
      {/if}
    </div>
    <button class="minor" type="button" onclick={onPortrait}>{plainText($words.templates[portraitLabel] || "View Portrait")}</button>
  </div>
</DesktopWindow>

<style>
  .character-preview { height: 100%; display: flex; flex-direction: column; align-items: center; gap: 6px; }
  .character-preview-stage { display: flex; flex: 1; min-height: 0; width: 100%; background: #171e1e; }
  .character-preview-stage p { margin: auto; color: var(--color-muted); }
</style>
