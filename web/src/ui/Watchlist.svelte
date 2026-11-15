<script lang="ts">
  // The fleet's watch list, as the client's WatchListPanel shows it (fleetWatchList.py): the pilot's watchlist in the
  // order its members were added, each by name; and its ship's shield, armour and hull where the ship is in the
  // pilot's ballpark (WatchListEntry.UpdateDamage, its ship by SlimItemFromCharID), with the ship's type beside it
  // (UpdateShipIcon, InBubble), and none where it is not. With nobody on it, the client's hint. Members are added and
  // taken off by the fleet's menu for a member (Contacts); the client opens this window on an add (AddFavorite, 676).
  // Not here yet: the damage and membership clearing controls, its two columns and dragging, the
  // broadcasts' icons, and the damage of a member out of the ballpark (OnFleetDamageStateChange, which EveJS never
  // sends).
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import {
    autoOpenWatchlist, colorWatchlistSelection, saveWatchlistColors, setAutoOpenWatchlist,
    watchlistColorSettings, WATCHLIST_AUTO_OPEN, WATCHLIST_COLORS,
  } from "./watchlistSettings.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const fleet = store.fleet;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const space = store.space;
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const characterID = $derived($station.online?.characterID ?? null);
  let autoOpen = $state(true);
  $effect(() => { autoOpen = characterID === null || autoOpenWatchlist(characterID); });

  const WORDS = {
    caption: "UI/Fleet/WatchList",
    empty: "UI/Fleet/Watchlist/DropFleetMembers",
    autoOpen: WATCHLIST_AUTO_OPEN,
    enterColors: "UI/Fleet/Watchlist/EnterColorEditMode",
    exitColors: "UI/Fleet/Watchlist/ExitColorEditMode",
    clearColors: "UI/Fleet/Watchlist/ClearAllColors",
    selectColor: "UI/Mail/Select Color",
    clearColor: "UI/SystemMenu/ResetSettings/Clear",
  } as const;

  function word(label: string, own: string): string {
    const template = $words.templates[label];
    return typeof template === "string" ? template : own;
  }

  const watched = $derived($fleet.watchlist ?? []);
  let editing = $state(false);
  let colors = $state<Readonly<Record<number, number>>>({});
  let selected = $state<readonly number[]>([]);
  let anchor: number | null = null;
  let selectionFleetID: number | null = null;

  $effect(() => {
    if (characterID === null) return;
    const settings = watchlistColorSettings(characterID);
    editing = settings.editing;
    colors = settings.colors;
  });
  $effect(() => {
    if ($fleet.authoritativeFleetID === selectionFleetID) return;
    selectionFleetID = $fleet.authoritativeFleetID;
    selected = [];
    anchor = null;
  });

  function keepColors() {
    if (characterID !== null) saveWatchlistColors(characterID, { editing, colors });
  }

  function select(character: number, event: MouseEvent) {
    const start = anchor === null ? -1 : watched.indexOf(anchor);
    const end = watched.indexOf(character);
    if (event.shiftKey && start >= 0) {
      selected = watched.slice(Math.min(start, end), Math.max(start, end) + 1);
      return;
    }
    selected = [character];
    anchor = character;
  }

  function setColor(character: number, color: number | null, event: MouseEvent) {
    colors = colorWatchlistSelection(colors, selected.filter(id => watched.includes(id)), character, color);
    keepColors();
    if (!(event.currentTarget instanceof HTMLElement)) return;
    const picker = event.currentTarget.closest("details");
    picker?.removeAttribute("open");
    picker?.querySelector("summary")?.focus();
  }

  /** The member's ship as the pilot's ballpark has it, or none where it is not there (SlimItemFromCharID). */
  function shipOf(characterID: number) {
    const snapshot = $space.snapshot;
    if (snapshot === null || !snapshot.inSpace) return null;
    return snapshot.entities.find((entity) => entity.characterID === characterID && !entity.isSelf) ?? null;
  }

  $effect(() => {
    flow.requestWords(Object.values(WORDS));
  });
  $effect(() => {
    const refs: { kind: "character" | "type"; id: number }[] = watched.map((id) => ({ kind: "character" as const, id }));
    for (const id of watched) {
      const ship = shipOf(id);
      if (ship !== null && ship.typeID !== null) refs.push({ kind: "type", id: ship.typeID });
    }
    if (refs.length > 0) flow.requestNames(refs);
  });

  const percent = (ratio: number | null): string => (ratio === null ? "" : `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`);
</script>

<section class="watchlist" aria-label="{word(WORDS.caption, 'Watch List')} [{watched.length}]">
  <header>
    <h3>{word(WORDS.caption, "Watch List")} [{watched.length}]</h3>
    {#if characterID !== null}
      <details class="options">
        <summary aria-label="More options" title="More options">⋯</summary>
        <div class="options-panel">
          <label>
            <input type="checkbox" checked={autoOpen} onchange={(event) => {
              autoOpen = event.currentTarget.checked;
              if (characterID !== null) setAutoOpenWatchlist(characterID, autoOpen);
            }} />
            {word(WORDS.autoOpen, "Auto-open Watchlist")}
          </label>
          <button type="button" onclick={(event) => {
            editing = !editing;
            selected = [];
            anchor = null;
            keepColors();
            event.currentTarget.closest("details")?.removeAttribute("open");
          }}>{editing ? word(WORDS.exitColors, "Exit Color Edit Mode") : word(WORDS.enterColors, "Enter Color Edit Mode")}</button>
          <button type="button" disabled={Object.keys(colors).length === 0} onclick={() => { colors = {}; keepColors(); }}>{word(WORDS.clearColors, "Clear All Colors")}</button>
        </div>
      </details>
    {/if}
  </header>
  {#if watched.length === 0}
    <p class="empty">{word(WORDS.empty, "Add fleet members to watch them here.")}</p>
  {:else}
    <ul>
      {#each watched as characterID (characterID)}
        {@const ship = shipOf(characterID)}
        {@const name = resolvedName($names.resolved, "character", characterID, `Pilot ${characterID}`)}
        {@const color = WATCHLIST_COLORS[colors[characterID] ?? -1]}
        <li data-character-id={characterID} class:selected={editing && selected.includes(characterID)}
          style:background-color={color ? `rgb(${color[1]} / 25%)` : undefined}>
          {#if editing}
            <button type="button" class="name select-pilot" aria-pressed={selected.includes(characterID)}
              onclick={(event) => select(characterID, event)}>{name}</button>
          {:else}
            <span class="name">{name}</span>
          {/if}
          {#if ship !== null}
            <span class="ship">{ship.typeID === null ? "" : resolvedName($names.resolved, "type", ship.typeID, "")}</span>
            <span class="gauges" title="shield {percent(ship.shieldRatio)}, armour {percent(ship.armorRatio)}, hull {percent(ship.hullRatio)}">
              {#each [ship.shieldRatio, ship.armorRatio, ship.hullRatio] as ratio, index (index)}
                <span class="gauge" data-part={["shield", "armor", "hull"][index]}><span class="fill" style:width={percent(ratio) || "0%"}></span></span>
              {/each}
            </span>
          {/if}
          {#if editing}
            <details class="color-picker">
              <summary aria-label={`${word(WORDS.selectColor, "Select Color")} · ${name}`}>
                <span class="swatch" style:background={color ? `rgb(${color[1]})` : "transparent"}></span>▾
              </summary>
              <div class="color-panel">
                {#each WATCHLIST_COLORS as [label, rgb], index (label)}
                  <button type="button" class="swatch" title={label} aria-label={label} aria-pressed={colors[characterID] === index}
                    style:background={`rgb(${rgb})`} onclick={(event) => setColor(characterID, index, event)}></button>
                {/each}
                <button type="button" class="swatch" title={word(WORDS.clearColor, "Clear")} aria-label={word(WORDS.clearColor, "Clear")}
                  onclick={(event) => setColor(characterID, null, event)}>×</button>
              </div>
            </details>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .watchlist { display: flex; flex-direction: column; gap: 0.4rem; }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; }
  h3 { margin: 0; font-size: 0.9rem; letter-spacing: 0.04em; text-transform: uppercase; }
  details { position: relative; }
  summary { list-style: none; cursor: pointer; padding: 0 0.25rem; }
  .options-panel, .color-panel { position: absolute; right: 0; z-index: 1; padding: 0.5rem; background: var(--panel, #161a20); border: 1px solid var(--line, #444); }
  .options-panel { display: grid; gap: 0.25rem; white-space: nowrap; }
  .empty { margin: 0; opacity: 0.75; }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.2rem; }
  li { display: flex; align-items: center; gap: 0.5rem; min-height: 24px; }
  li.selected { outline: 1px solid rgb(255 255 255 / 40%); outline-offset: -1px; }
  .name { flex: 1 1 auto; }
  .select-pilot { text-align: left; border: 0; background: transparent; }
  .color-picker summary { display: flex; align-items: center; gap: 0.2rem; }
  .color-panel { display: grid; grid-template-columns: repeat(5, 16px); gap: 4px; }
  .swatch { width: 16px; height: 16px; display: inline-grid; place-items: center; padding: 0; border: 1px solid rgb(255 255 255 / 25%); line-height: 1; }
  .swatch[aria-pressed="true"] { outline: 1px solid white; }
  .ship { opacity: 0.75; font-size: 0.85rem; }
  .gauges { display: flex; flex-direction: column; gap: 2px; width: 78px; }
  .gauge { display: block; height: 4px; background: rgba(255, 255, 255, 0.12); }
  .fill { display: block; height: 100%; background: #6fa8dc; }
  .gauge[data-part="armor"] .fill { background: #c9c9c9; }
  .gauge[data-part="hull"] .fill { background: #d9a441; }
</style>
