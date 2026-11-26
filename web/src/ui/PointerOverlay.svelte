<script lang="ts">
  import { onMount } from "svelte";
  import { dragUiPointer, visiblePointerTarget } from "../play/uiPointer.ts";
  import { dragUiPointerLinks, STATION_POINTER_LINK_LABEL } from "../play/uiPointerCatalog.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { portal } from "./portal.ts";

  let { store }: { store: ClientStore } = $props();
  let fills = $state.raw<{ name: string; rect: DOMRect }[]>([]);

  function drag(event: DragEvent, name: string) {
    dragUiPointer(event, name);
    dragUiPointerLinks(event, [name], store.words.get().templates[STATION_POINTER_LINK_LABEL]);
  }

  function updateFills() {
    const names = new Set(Array.from(document.querySelectorAll<HTMLElement>("[data-ui-pointer]"), element => element.dataset.uiPointer!));
    fills = [...names].flatMap(name => {
      const element = visiblePointerTarget(name);
      return element ? [{ name, rect: element.getBoundingClientRect() }] : [];
    });
  }

  onMount(() => {
    updateFills();
    const timer = setInterval(updateFills, 100);
    return () => clearInterval(timer);
  });
</script>

<div class="pointer-overlay" aria-hidden="true" use:portal>
  {#each fills as { name, rect } (name)}
    <div class="pointer-fill" data-pointer-fill={name} draggable="true" role="presentation"
      style:left={`${rect.left}px`} style:top={`${rect.top}px`}
      style:width={`${rect.width}px`} style:height={`${rect.height}px`}
      ondragstart={(event) => drag(event, name)}></div>
  {/each}
</div>

<style>
  .pointer-overlay { position: fixed; inset: 0; z-index: 951; pointer-events: none; }
  .pointer-fill {
    position: absolute;
    box-sizing: border-box;
    border: 1px solid rgba(51, 153, 255, 0.4);
    border-radius: 9px;
    background: rgba(51, 153, 255, 0.2);
    pointer-events: auto;
    animation: pulse 1.5s ease-in-out infinite alternate;
  }
  @keyframes pulse { from { opacity: 0.4; } to { opacity: 0.6; } }
  @media (prefers-reduced-motion: reduce) { .pointer-fill { animation: none; opacity: 0.5; } }
</style>
