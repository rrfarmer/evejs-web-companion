<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import DesktopWindow from "./DesktopWindow.svelte";
  import ShipInfoPreview from "./ShipInfoPreview.svelte";
  import type { WindowRect } from "./windowResize.ts";

  let { store, flow, typeID, rect, z, minWidth, minHeight, focused, onFocus, onClose, onMove, onResize }: {
    store: ClientStore; flow: AppFlow; typeID: number; rect: WindowRect; z: number;
    minWidth: number; minHeight: number; focused: boolean; onFocus: () => void; onClose: () => void;
    onMove: (x: number, y: number) => void; onResize: (rect: WindowRect) => void;
  } = $props();
  const caption = "UI/Preview/PreviewCaption";
  const names = $derived(store.names), words = $derived(store.words);
  const name = $derived(resolvedName($names.resolved, "type", typeID, ""));
  const title = $derived(plainText($words.templates[caption] || "Preview"));
  $effect(() => {
    flow.requestWords([caption]);
    flow.requestNames([{ kind: "type", id: typeID }]);
  });
</script>

<DesktopWindow win={{ id: "previewWnd", ...rect, z, minimized: false }} {title} {minWidth} {minHeight} {focused}
  {onFocus} {onClose} {onMove} onResizeRect={onResize}>
  <div class="type-preview" data-preview-type={typeID}>
    {#if name}<h2>{name}</h2>{/if}
    <div class="type-preview-stage">
      <ShipInfoPreview {typeID} factionID={null} active expanded spaceEntity />
    </div>
  </div>
</DesktopWindow>

<style>
  .type-preview { display: flex; flex-direction: column; height: 100%; }
  .type-preview h2 { margin: 0 0 6px; font-size: 17px; font-weight: 500; }
  .type-preview-stage { flex: 1; min-height: 0; }
</style>
