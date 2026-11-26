<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolveUiPointer, STATION_POINTER_LINK_LABEL, UI_POINTER_BY_NAME } from "../play/uiPointerCatalog.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { portal } from "./portal.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  const invalid = "UI/Help/PointerWndInvalidPointer";
  const missing = "UI/Help/PointerWndNotOnScreen";
  let name = $state<string | null>(null);
  let anchor = $state.raw<{ rect: DOMRect; label: string } | null>(null);
  let expiry: ReturnType<typeof setTimeout>;

  function update() {
    const target = name === null ? undefined : UI_POINTER_BY_NAME.get(name);
    const element = target ? resolveUiPointer(target) : null;
    anchor = target && element ? { rect: element.getBoundingClientRect(), label: target.label } : null;
  }

  function point(event: Event) {
    const detail = (event as CustomEvent<{ flow: AppFlow; name: string }>).detail;
    if (detail?.flow !== flow) return;
    clearTimeout(expiry);
    name = detail.name;
    update();
    if (!anchor) {
      const target = UI_POINTER_BY_NAME.get(detail.name);
      const template = store.words.get().templates[target ? missing : invalid];
      const fallback = target ? `${target.label} is not on screen.` : "Invalid UI pointer.";
      const text = template ? plainText(formatTemplate(template, { elementName: target?.label ?? "" }, { nameOf: () => null })) : fallback;
      flow.sayDialog("CustomNotify", { type: "dict", entries: [["notify", text]] }, text);
      name = null;
      return;
    }
    expiry = setTimeout(() => { name = null; anchor = null; }, 2000);
  }

  $effect(() => {
    if (!name) return;
    const timer = setInterval(update, 100);
    return () => clearInterval(timer);
  });

  onMount(() => {
    flow.requestWords([invalid, missing, STATION_POINTER_LINK_LABEL]);
    window.addEventListener("eve-ui-pointer", point);
    return () => {
      window.removeEventListener("eve-ui-pointer", point);
      clearTimeout(expiry);
    };
  });
</script>

{#if anchor}
  {@const { rect, label } = anchor}
  <div class="shared-pointer" data-shared-pointer={name} use:portal
    style:left={`${rect.left}px`} style:top={`${rect.top}px`} style:width={`${rect.width}px`} style:height={`${rect.height}px`}>
    <span class:left={rect.right > window.innerWidth - 200}>{label}</span>
  </div>
{/if}

<style>
  .shared-pointer { position: fixed; z-index: 950; pointer-events: none; box-sizing: border-box; border: 2px solid #73c991; box-shadow: 0 0 12px #73c991; }
  span { position: absolute; left: 100%; top: 0; padding: 0.2rem 0.45rem; color: white; background: #182832; white-space: nowrap; }
  .left { right: 100%; left: auto; }
</style>
