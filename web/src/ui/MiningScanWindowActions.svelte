<script lang="ts">
  // MiningScanResultsWindow.GetCustomHeaderButtons: one WindowMenuAction - eveicon.bars_sort_ascending, UI/Mining/SortGroupsBy -
  // whose on_filter_button menu is the caption Sort Groups By, then the radio entries Alphabetically, Value and Type of
  // sort_groups_by_setting (read through gridcheck: 'Sort Groups By', 'Alphabetically', 'Value', 'Type').
  import { onDestroy } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { ContextMenu } from "../play/contextMenu.ts";
  import { clientTexture } from "../play/window.ts";
  import { loadMiningScanSort, miningScanSort, setMiningScanSort, type MiningScanSort } from "./miningScanSort.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  const characterID = () => store.character.get().selectedCharacterID ?? null;
  $effect(() => { flow.requestWords(["UI/Mining/SortGroupsBy", "UI/Mining/SortGroupsByAlphabetically", "UI/Mining/SortGroupsByValue", "UI/Mining/SortGroupsByType"]); loadMiningScanSort(characterID()); });
  const word = (label: string, own: string) => { const t = $words?.templates[label]; return typeof t === "string" && t !== "" ? plainText(t) : own; };
  const menu = new ContextMenu();
  onDestroy(() => menu.close());
  function open(e: MouseEvent): void {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const pick = (v: MiningScanSort) => () => setMiningScanSort(characterID(), v);
    menu.open(r.left, r.bottom, [
      { label: word("UI/Mining/SortGroupsBy", "Sort Groups By"), caption: true },
      { label: word("UI/Mining/SortGroupsByAlphabetically", "Alphabetically"), checked: $miningScanSort === "name", run: pick("name") },
      { label: word("UI/Mining/SortGroupsByValue", "Value"), checked: $miningScanSort === "value", run: pick("value") },
      { label: word("UI/Mining/SortGroupsByType", "Type"), checked: $miningScanSort === "type", run: pick("type") },
    ]);
  }
</script>

<button type="button" class="sort-groups" title={word("UI/Mining/SortGroupsBy", "Sort Groups By")} aria-label={word("UI/Mining/SortGroupsBy", "Sort Groups By")}
  onpointerdown={(e) => e.stopPropagation()} onclick={open}
  style:background-image={`url(${clientTexture("res:/ui/texture/eveicon/system_icons/bars_sort_ascending_16px.png")})`}></button>

<style>
  .sort-groups { width: 24px; height: 24px; min-height: 0; padding: 0; border: 0; background: center / 16px no-repeat; opacity: 0.75; cursor: pointer; flex: none; }
  .sort-groups:hover { opacity: 1; }
</style>
