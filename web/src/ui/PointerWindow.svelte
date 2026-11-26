<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { ContextMenu } from "../play/contextMenu.ts";
  import { NEOCOM_DEFAULT } from "../play/neocom.ts";
  import { shortcutOf } from "../play/shortcutKeys.ts";
  import { neocomPointerName, STATION_POINTERS, visiblePointerTarget, WALLET_POINTERS, type UiPointerTarget } from "../play/uiPointer.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { portal } from "./portal.ts";
  import { clientTexture } from "./skillGroupIcons.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  const paths = {
    about: "UI/Help/AboutHelpPointerWindow", shortcut: "UI/Help/PointerWndTextWithShortcut",
    notSet: "UI/Help/ShortcutNotSet", highlights: "UI/Help/PointerWndShowHighlights",
    highlightHint: "UI/Help/PointerWndShowHighlightsDesc", filter: "UI/Inventory/Filter",
    favorites: "UI/HelpPointers/Wnd/FavoriteGroup", neocom: "UI/Help/PointerWndNeocomHeader",
    interface: "UI/Help/PointerWndUiElements",
    station: "UI/Help/PointerWndStationServices", empty: "UI/Common/NothingFound",
    point: "UI/Help/PointerWndPointTo", missing: "UI/Help/PointerWndNotOnScreen",
    add: "UI/HelpPointers/Wnd/AddToFavoriteRoot", remove: "UI/HelpPointers/Wnd/RemoveFromGroup",
  } as const;
  const words = $derived(store.words);
  const session = $derived(store.session);
  const preferenceKey = $derived(`evejs.user.${$session.accountID ?? "local"}.pointerWindow`);
  function label(key: keyof typeof paths, fallback: string, values: Record<string, string> = {}): string {
    const template = $words.templates[paths[key]];
    return template ? plainText(formatTemplate(template, values, { nameOf: () => null })) : fallback;
  }
  const neocom = NEOCOM_DEFAULT.map(item => ({ name: neocomPointerName(item.id), label: item.label, icon: item.icon }));
  const targets = [...neocom, ...WALLET_POINTERS, ...STATION_POINTERS];
  const targetByName = new Map(targets.map(target => [target.name, target]));
  const pointerIcon = clientTexture("res:/UI/Texture/Classes/HelpPointer/highlightElement.png");
  const menu = new ContextMenu();
  let panel: HTMLDivElement;
  let filter: HTMLInputElement;
  let query = $state("");
  let showFrames = $state(false);
  let favorites = $state.raw<readonly string[]>([]);
  let selected = $state<string | null>(null);
  let pointed = $state<string | null>(null);
  let notice = $state("");
  let frames = $state.raw<readonly { target: UiPointerTarget; rect: DOMRect }[]>([]);
  let hovered: string | null = null;
  let expiry: ReturnType<typeof setTimeout> | null = null;
  const needle = $derived(query.trim().toLocaleLowerCase());
  const groups = $derived([
    { id: "favorites", label: label("favorites", "Favorites"), entries: targets.filter(row => favorites.includes(row.name)) },
    { id: "neocom", label: label("neocom", "Neocom"), entries: neocom },
    { id: "interface", label: label("interface", "User Interface Elements"), entries: WALLET_POINTERS },
    { id: "station", label: label("station", "Station Services"), entries: STATION_POINTERS },
  ].map(group => ({ ...group, entries: group.entries.filter(row => row.label.toLocaleLowerCase().includes(needle))
    .slice().sort((a, b) => a.label.localeCompare(b.label)) }))
    .filter(group => !needle && group.id === "favorites" || group.entries.length > 0));

  onMount(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(preferenceKey) ?? "{}");
      showFrames = saved?.showFrames === true;
      if (Array.isArray(saved?.favorites)) favorites = [...new Set<string>(saved.favorites.filter((name: unknown) => typeof name === "string" && targetByName.has(name)))];
    } catch { /* preferences are optional */ }
    flow.requestWords(Object.values(paths));
    filter.focus();
    return () => {
      menu.close();
      if (expiry !== null) clearTimeout(expiry);
    };
  });

  function save() {
    try { localStorage.setItem(preferenceKey, JSON.stringify({ showFrames, favorites })); } catch { /* preferences are optional */ }
  }

  function pointerElement(target: UiPointerTarget): HTMLElement | null {
    const element = visiblePointerTarget(target.name);
    if (element || !target.parent) return element;
    const parent = targetByName.get(target.parent);
    return parent ? pointerElement(parent) : null;
  }

  function updateFrames() {
    if (!panel?.getClientRects().length) { frames = []; return; }
    const shown = showFrames ? targets : targets.filter(target => target.name === pointed);
    frames = shown.flatMap(target => {
      const node = target.name === pointed ? pointerElement(target) : visiblePointerTarget(target.name);
      return node ? [{ target, rect: node.getBoundingClientRect() }] : [];
    });
  }

  $effect(() => {
    if (!showFrames && !pointed) { frames = []; return; }
    updateFrames();
    const timer = setInterval(updateFrames, 200);
    return () => clearInterval(timer);
  });

  function point(target: UiPointerTarget) {
    selected = target.name;
    if (expiry !== null) { clearTimeout(expiry); expiry = null; }
    if (!pointerElement(target)) {
      pointed = null;
      notice = label("missing", `${target.label} is not on screen.`, { elementName: target.label });
      return;
    }
    notice = "";
    pointed = target.name;
    expiry = setTimeout(() => { pointed = null; expiry = null; }, 8000);
  }

  function trackHover(event: PointerEvent) {
    const node = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-ui-pointer]") : null;
    hovered = node?.dataset.uiPointer ?? null;
  }

  async function chooseHovered(event: KeyboardEvent) {
    if (event.key !== "Control" || !showFrames || !panel?.getClientRects().length || !hovered || !targetByName.has(hovered)) return;
    selected = hovered;
    query = "";
    notice = "";
    await tick();
    panel.querySelector('[data-pointer-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }

  function favoriteMenu(event: MouseEvent | KeyboardEvent, target: UiPointerTarget, remove: boolean) {
    event.preventDefault();
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    menu.open(event instanceof MouseEvent && event.clientX ? event.clientX : bounds.left,
      event instanceof MouseEvent && event.clientY ? event.clientY : bounds.bottom, [{
        label: remove ? label("remove", "Remove from Group") : label("add", "Add to Favorites"),
        run: () => {
          favorites = remove ? favorites.filter(id => id !== target.name) : [...new Set([...favorites, target.name])];
          save();
        },
      }]);
  }
</script>

<svelte:window onpointermove={trackHover} onkeydown={chooseHovered} />
<div class="pointer-window" bind:this={panel}>
  <p>{label("about", "Use pointers to find controls on your screen.")}</p>
  <p>{label("shortcut", "UI Pointer shortcut: {shortcut}", { shortcut: shortcutOf("CmdGetUiPointer") || label("notSet", "Shortcut not set") })}</p>
  <label><input type="checkbox" bind:checked={showFrames} onchange={save} /> {label("highlights", "Show Highlights")}</label>
  {#if showFrames}<p class="hint">{label("highlightHint", "Hold Ctrl over a highlighted control to select it.")}</p>{/if}
  <input class="filter" type="search" maxlength="64" bind:this={filter} bind:value={query} aria-label={label("filter", "Filter")} placeholder={label("filter", "Filter")} />
  {#if notice}<p class="hint" role="status">{notice}</p>{/if}
  {#if groups.length}
    <div class="groups">
      {#each groups as group (group.id)}
        <details open={Boolean(needle) || group.id !== "favorites" || favorites.length > 0}>
          <summary>{group.label}</summary>
          {#each group.entries as target (target.name)}
            <button type="button" class="pointer-row" data-pointer-name={target.name}
              data-pointer-selected={selected === target.name} aria-label={label("point", `Point to ${target.label}`, { elementName: target.label })}
              onclick={() => point(target)} oncontextmenu={(event) => favoriteMenu(event, target, group.id === "favorites")}
              onkeydown={(event) => { if (event.key === "ContextMenu" || event.shiftKey && event.key === "F10") favoriteMenu(event, target, group.id === "favorites"); }}>
              <img src={target.icon} alt="" /><span>{target.label}</span><img src={pointerIcon} alt="" class="point-icon" />
            </button>
          {/each}
        </details>
      {/each}
    </div>
  {:else}
    <p role="status">{label("empty", "Nothing found")}</p>
  {/if}
</div>

{#if frames.length}
  <div class="pointer-layer" aria-hidden="true" use:portal>
    {#each frames as { target, rect } (target.name)}
      <div class="pointer-frame" class:selected={selected === target.name} class:pointed={pointed === target.name}
        data-pointing={target.name} style:left={`${rect.left}px`} style:top={`${rect.top}px`} style:width={`${rect.width}px`} style:height={`${rect.height}px`}>
        {#if pointed === target.name}<span>{target.label}</span>{/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .pointer-window { display: grid; gap: 0.4rem; }
  p { margin: 0; }
  .hint { color: var(--color-text-muted); }
  .filter { justify-self: end; width: min(100%, 200px); }
  summary { cursor: pointer; padding: 0.25rem; font-weight: 600; }
  .pointer-row { min-height: 32px; width: 100%; display: flex; align-items: center; gap: 0.6rem; text-align: left; }
  .pointer-row img { width: 24px; height: 24px; object-fit: contain; }
  .pointer-row .point-icon { margin-left: auto; width: 20px; height: 20px; }
  .pointer-row[data-pointer-selected="true"] { box-shadow: inset 2px 0 #73c991; }
  .pointer-layer { position: fixed; inset: 0; pointer-events: none; z-index: 950; }
  .pointer-frame { position: fixed; box-sizing: border-box; border: 1px solid rgba(73, 173, 255, 0.72); }
  .pointer-frame.selected { border-color: #73c991; }
  .pointer-frame.pointed { border-width: 2px; box-shadow: 0 0 12px #73c991; }
  .pointer-frame span { position: absolute; left: 100%; top: 0; padding: 0.2rem 0.45rem; color: white; background: #182832; white-space: nowrap; }
</style>
