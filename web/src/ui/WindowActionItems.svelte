<script lang="ts">
  // The client's window actions at the head of a window's More menu (read through gridcheck on droneview, logger and
  // ActiveShipCargo): Lock window size and position, the window's compact mode where it has one, Disable / Enable Light
  // Background (from the window's default_isLightBackground), Collapse / Expand, then a line before its own entries.
  // (Enable always above fullscreen views is left out: nothing fullscreen to rise above on this page.)
  import { onMount } from "svelte";
  import { applyWindowFlags, setWindowFlag, windowFlags, type WindowFlag } from "./windowFlags.ts";

  let { id, lightByDefault, word, compact = null, onDone }: {
    id: string;
    lightByDefault: boolean;
    word: (label: string, own: string) => string;
    compact?: { on: boolean; toggle: () => void } | null;
    onDone: () => void;
  } = $props();
  // svelte-ignore state_referenced_locally
  let flags = $state(windowFlags(id));
  // svelte-ignore state_referenced_locally
  onMount(() => { applyWindowFlags(id); caption = (anchor?.closest(".win")?.querySelector<HTMLElement>(".win-title")?.dataset.title ?? "").trim(); });
  // DefaultWindowControls._get_menu_title: a compact (or stacked) window, its header gone, heads the menu with its caption
  // (an AddCaption, TextHeader 18 at 12 in the client's compact droneview, g377), then a line before the actions
  let anchor: HTMLElement | undefined = $state();
  let caption = $state("");
  const lightOn = $derived(lightByDefault ? !flags.nolight : flags.light);
  function flip(which: WindowFlag): void { setWindowFlag(id, which, !flags[which]); flags = windowFlags(id); onDone(); }
  const W = "/Carbon/UI/Controls/Window/";
  // each entry with its action's eveicon (WindowControls._add_action_to_menu passes action.icon: unlocked / locked,
  // compact / uncompact, light_background_on / _off, collapse / expand, the toggles' current icon)
  const I = (n: string) => `/client-res/ui/texture/eveicon/system_icons/${n}_16px.png`;
</script>

<span class="anchor" bind:this={anchor} hidden></span>
{#if compact?.on && caption}<span class="caption first">{caption}</span><hr class="sep" />{/if}
<button type="button" role="menuitem" onpointerdown={(event) => event.stopPropagation()}
  class="has-icon" onclick={() => flip("locked")}><img alt="" src={I(flags.locked ? "locked" : "unlocked")} />{flags.locked ? word(`${W}Unlock`, "Unlock window size and position") : word(`${W}Lock`, "Lock window size and position")}</button>
{#if compact}
  <button type="button" role="menuitem" onpointerdown={(event) => event.stopPropagation()}
    class="has-icon" onclick={() => { compact.toggle(); onDone(); }}><img alt="" src={I(compact.on ? "uncompact" : "compact")} />{compact.on ? word(`${W}DisableCompactMode`, "Disable compact mode") : word(`${W}EnableCompactMode`, "Enable compact mode")}</button>
{/if}
<button type="button" role="menuitem" onpointerdown={(event) => event.stopPropagation()}
  class="has-icon" onclick={() => flip(lightByDefault ? "nolight" : "light")}><img alt="" src={I(lightOn ? "light_background_on" : "light_background_off")} />{lightOn ? word(`${W}DisableLightBackground`, "Disable Light Background") : word(`${W}EnableLightBackground`, "Enable Light Background")}</button>
<button type="button" role="menuitem" onpointerdown={(event) => event.stopPropagation()}
  class="has-icon" onclick={() => flip("collapsed")}><img alt="" src={I(flags.collapsed ? "expand" : "collapse")} />{flags.collapsed ? word(`${W}Expand`, "Expand") : word(`${W}Collapse`, "Collapse")}</button>
<hr class="sep" />

<style>
  .sep { border: 0; border-top: 1px solid rgba(255, 255, 255, 0.15); margin: 4px 0; width: 100%; }
  /* (no line closing a menu with nothing of its own after the actions: the probe scanner) */
  .sep:last-child { display: none; }
  /* the client's caption at 8 (the menu's top), its line 8 under it and the first entry at 52 (g377) */
  :global(.fly-windows .log-menu) .caption.first { padding: 0 0 8px 4px; }
</style>
