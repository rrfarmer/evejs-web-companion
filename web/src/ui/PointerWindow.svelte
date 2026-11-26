<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { ContextMenu, type ContextEntry } from "../play/contextMenu.ts";
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
    addToGroup: "UI/HelpPointers/Wnd/AddToFavoriteSubGroup",
    addGroup: "UI/HelpPointers/Wnd/AddGroup", deleteGroup: "UI/HelpPointers/Wnd/DeleteGroup",
    folderName: "UI/Market/Marketbase/FolderName", typeFolderName: "UI/Market/Marketbase/TypeFolderName",
    ok: "UI/Common/Buttons/OK", cancel: "UI/Common/Buttons/Cancel",
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
  const pointerDragType = "application/x-evejs-ui-pointer";
  type FavoriteGroup = { readonly id: number; readonly name: string; readonly entries: readonly string[] };
  const menu = new ContextMenu();
  let panel: HTMLDivElement;
  let filter: HTMLInputElement;
  let favoriteRoot = $state<HTMLDetailsElement>();
  let folderDialog: HTMLDialogElement;
  let folderName = $state("");
  let query = $state("");
  let showFrames = $state(false);
  let favorites = $state.raw<readonly string[]>([]);
  let favoriteGroups = $state.raw<readonly FavoriteGroup[]>([]);
  let selected = $state<string | null>(null);
  let pointed = $state<string | null>(null);
  let notice = $state("");
  let frames = $state.raw<readonly { target: UiPointerTarget; rect: DOMRect }[]>([]);
  let hovered: string | null = null;
  let expiry: ReturnType<typeof setTimeout> | null = null;
  const needle = $derived(query.trim().toLocaleLowerCase());
  function matches(target: UiPointerTarget) {
    return target.label.toLocaleLowerCase().includes(needle);
  }

  function visibleFavorites(names: readonly string[]) {
    return names.flatMap(name => {
      const target = targetByName.get(name);
      return target && matches(target) ? [target] : [];
    });
  }

  const rootEntries = $derived(visibleFavorites(favorites));
  const folders = $derived(favoriteGroups.map(group => ({ ...group, visibleEntries: visibleFavorites(group.entries) }))
    .filter(group => group.visibleEntries.length || group.name.toLocaleLowerCase().includes(needle)));
  const showFavorites = $derived(!needle || rootEntries.length > 0 || folders.length > 0);
  const groups = $derived([
    { id: "neocom", label: label("neocom", "Neocom"), entries: neocom },
    { id: "interface", label: label("interface", "User Interface Elements"), entries: WALLET_POINTERS },
    { id: "station", label: label("station", "Station Services"), entries: STATION_POINTERS },
  ].map(group => ({ ...group, entries: group.entries.filter(matches).sort((a, b) => a.label.localeCompare(b.label)) }))
    .filter(group => group.entries.length > 0));

  function savedEntries(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((name): name is string => typeof name === "string" && targetByName.has(name)))];
  }

  onMount(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(preferenceKey) ?? "{}");
      showFrames = saved?.showFrames === true;
      favorites = savedEntries(saved?.favorites);
      if (Array.isArray(saved?.favoriteGroups)) {
        const restored = new Map<number, FavoriteGroup>();
        for (const group of saved.favoriteGroups) {
          if (!Number.isSafeInteger(group?.id) || group.id <= 0 || typeof group.name !== "string" || restored.has(group.id)) continue;
          restored.set(group.id, { id: group.id, name: group.name, entries: savedEntries(group.entries) });
        }
        favoriteGroups = [...restored.values()];
      }
    } catch { /* preferences are optional */ }
    flow.requestWords(Object.values(paths));
    filter.focus();
    return () => {
      menu.close();
      if (expiry !== null) clearTimeout(expiry);
    };
  });

  function save() {
    try { localStorage.setItem(preferenceKey, JSON.stringify({ showFrames, favorites, favoriteGroups })); } catch { /* preferences are optional */ }
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

  function openMenu(event: MouseEvent | KeyboardEvent, entries: ContextEntry[]) {
    event.preventDefault();
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    menu.open(event instanceof MouseEvent && event.clientX ? event.clientX : bounds.left,
      event instanceof MouseEvent && event.clientY ? event.clientY : bounds.bottom, entries);
  }

  function isMenuKey(event: KeyboardEvent) {
    return event.key === "ContextMenu" || event.shiftKey && event.key === "F10";
  }

  function changeEntries(groupID: number, update: (entries: readonly string[]) => readonly string[]) {
    if (groupID === 0) favorites = update(favorites);
    else favoriteGroups = favoriteGroups.map(group => group.id === groupID ? { ...group, entries: update(group.entries) } : group);
    save();
  }

  function addPointer(groupID: number, name: string, before?: string) {
    changeEntries(groupID, entries => {
      if (name === before || !before && entries.includes(name)) return entries;
      const next = entries.filter(entry => entry !== name);
      const index = before ? next.indexOf(before) : -1;
      next.splice(index < 0 ? next.length : index, 0, name);
      return next;
    });
  }

  function favoriteMenu(event: MouseEvent | KeyboardEvent, target: UiPointerTarget, groupID?: number) {
    if (groupID !== undefined) {
      openMenu(event, [{ label: label("remove", "Remove"),
        run: () => changeEntries(groupID, entries => entries.filter(name => name !== target.name)) }]);
      return;
    }
    const entries: ContextEntry[] = [{ label: label("add", "Add to Favorites"), run: () => addPointer(0, target.name) }];
    if (favoriteGroups.length) {
      entries.push({ label: label("addToGroup", "Add to Favorites Group"),
        sub: favoriteGroups.map(group => ({ label: group.name, run: () => addPointer(group.id, target.name) })) });
    }
    openMenu(event, entries);
  }

  function folderMenu(event: MouseEvent | KeyboardEvent, group?: FavoriteGroup) {
    if (!group) {
      openMenu(event, [{ label: label("addGroup", "Add Group"), run: () => {
        folderName = "";
        folderDialog.showModal();
      } }]);
      return;
    }
    openMenu(event, [{ label: label("deleteGroup", "Delete Group"), run: async () => {
      if (!await flow.askClientDialogWith("AskDeleteFavoritePointerGroup", { groupName: group.name },
        `Delete the Favorites group “${group.name}”?`)) return;
      favoriteGroups = favoriteGroups.filter(folder => folder.id !== group.id);
      save();
    } }]);
  }

  function createFolder(event: SubmitEvent) {
    event.preventDefault();
    const name = folderName.trim();
    if (!name) return;
    const id = Math.max(0, ...favoriteGroups.map(group => group.id)) + 1;
    favoriteGroups = [...favoriteGroups, { id, name, entries: [] }];
    folderDialog.close();
    if (favoriteRoot) favoriteRoot.open = true;
    save();
  }

  function dragPointer(event: DragEvent, name: string) {
    if (!event.dataTransfer) return;
    event.dataTransfer.effectAllowed = "copyMove";
    event.dataTransfer.setData(pointerDragType, name);
  }

  function allowPointerDrop(event: DragEvent) {
    if (event.dataTransfer?.types.includes(pointerDragType)) event.preventDefault();
  }

  function dropPointer(event: DragEvent, groupID: number, before?: string) {
    const name = event.dataTransfer?.getData(pointerDragType);
    if (!name || !targetByName.has(name)) return;
    event.preventDefault();
    addPointer(groupID, name, before);
  }
</script>

{#snippet pointerRow(target: UiPointerTarget, groupID?: number)}
  <button type="button" class="pointer-row" draggable="true" data-pointer-name={target.name}
    data-pointer-selected={selected === target.name} aria-label={label("point", `Point to ${target.label}`, { elementName: target.label })}
    onclick={() => point(target)} oncontextmenu={(event) => favoriteMenu(event, target, groupID)}
    onkeydown={(event) => { if (isMenuKey(event)) favoriteMenu(event, target, groupID); }}
    ondragstart={(event) => dragPointer(event, target.name)}
    ondragover={groupID === undefined ? undefined : allowPointerDrop}
    ondrop={groupID === undefined ? undefined : (event) => dropPointer(event, groupID, target.name)}>
    <img src={target.icon} alt="" /><span>{target.label}</span><img src={pointerIcon} alt="" class="point-icon" />
  </button>
{/snippet}

<svelte:window onpointermove={trackHover} onkeydown={chooseHovered} />
<div class="pointer-window" bind:this={panel}>
  <p>{label("about", "Use pointers to find controls on your screen.")}</p>
  <p>{label("shortcut", "UI Pointer shortcut: {shortcut}", { shortcut: shortcutOf("CmdGetUiPointer") || label("notSet", "Shortcut not set") })}</p>
  <label><input type="checkbox" bind:checked={showFrames} onchange={save} /> {label("highlights", "Show Highlights")}</label>
  {#if showFrames}<p class="hint">{label("highlightHint", "Hold Ctrl over a highlighted control to select it.")}</p>{/if}
  <input class="filter" type="search" maxlength="64" bind:this={filter} bind:value={query} aria-label={label("filter", "Filter")} placeholder={label("filter", "Filter")} />
  {#if notice}<p class="hint" role="status">{notice}</p>{/if}
  {#if showFavorites || groups.length}
    <div class="groups">
      {#if showFavorites}
        <details data-favorite-group="0" bind:this={favoriteRoot} open={Boolean(needle) || favorites.length > 0 || favoriteGroups.length > 0}>
          <summary oncontextmenu={(event) => folderMenu(event)}
            onkeydown={(event) => { if (isMenuKey(event)) folderMenu(event); }}
            ondragover={allowPointerDrop} ondrop={(event) => dropPointer(event, 0)}>{label("favorites", "Favorites")}</summary>
          {#each rootEntries as target (target.name)}
            {@render pointerRow(target, 0)}
          {/each}
          {#each folders as group (group.id)}
            <details class="favorite-folder" data-favorite-group={group.id} open={Boolean(needle)}>
              <summary oncontextmenu={(event) => folderMenu(event, group)}
                onkeydown={(event) => { if (isMenuKey(event)) folderMenu(event, group); }}
                ondragover={allowPointerDrop} ondrop={(event) => dropPointer(event, group.id)}>{group.name}</summary>
              {#each group.visibleEntries as target (target.name)}
                {@render pointerRow(target, group.id)}
              {/each}
            </details>
          {/each}
        </details>
      {/if}
      {#each groups as group (group.id)}
        <details open>
          <summary>{group.label}</summary>
          {#each group.entries as target (target.name)}
            {@render pointerRow(target)}
          {/each}
        </details>
      {/each}
    </div>
  {:else}
    <p role="status">{label("empty", "Nothing found")}</p>
  {/if}
</div>

<dialog bind:this={folderDialog} aria-label={label("folderName", "Folder Name")}>
  <h2>{label("folderName", "Folder Name")}</h2>
  <form onsubmit={createFolder}>
    <label>{label("typeFolderName", "Enter a folder name")}
      <input type="text" bind:value={folderName} maxlength="30" autocomplete="off" required />
    </label>
    <div class="folder-actions">
      <button type="submit" disabled={!folderName.trim()}>{label("ok", "OK")}</button>
      <button type="button" onclick={() => folderDialog.close()}>{label("cancel", "Cancel")}</button>
    </div>
  </form>
</dialog>

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
  .favorite-folder { margin-left: 10px; }
  dialog { width: min(320px, calc(100vw - 2rem)); color: var(--color-text); background: var(--color-panel); border: 1px solid var(--color-line); }
  form, form label { display: grid; gap: 0.5rem; }
  .folder-actions { display: flex; justify-content: end; gap: 0.5rem; }
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
