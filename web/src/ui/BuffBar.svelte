<script lang="ts">
  import { getContext, onDestroy } from "svelte";
  import { ContextMenu } from "../play/contextMenu.ts";
  import type { SpaceView } from "../play/spaceView.ts";
  // The ship HUD's buff bar (buffBarContainer.py, buffButtons.py; bridge/buffBar.ts): a slot for each kind of buff the
  // server says is on the pilot's ship and each kind of electronic warfare other ships' modules are working on it, as
  // the bar lays them out, each with its icon, its timer (the latest end of its buffs, or its jammer's cycle), and its
  // hint: the slot's caption, the attackers, then each buff's value, name and time left, written again every quarter
  // second while it is up (LoadTooltipPanel's AutoTimer).
  import { onMount, untrack } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { BUFF_SLOTS } from "../bridge/dbuffs.ts";
  import {
    buffHintRows,
    buffSlotOf,
    ewarHintRows,
    newBuffBarLayout,
    relaidBuffBar,
    shownBuffSlots,
    slotBuffEndMs,
    slotJamTimer,
    UNIT_MODIFIER_RELATIVE_PERCENT,
    type BuffHintWriter,
    type EwarHintWriter,
    type EwarSourceOf,
    type HintRow,
  } from "../bridge/buffBar.ts";
  import { valueAndUnitText, type AttributeWords } from "../bridge/typeComparison.ts";
  import { SHORT_INTERVAL_WORD_LABELS, shortWrittenInterval } from "../bridge/timeInterval.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { portal } from "./portal.ts";
  import { spaceSelection } from "../space/selection.ts";
  import { showInfo } from "./showInfo.ts";
  import { actionsForRow, type RowAction } from "../space/rowActions.ts";
  import { dispatchRowAction, isSingleCallAction } from "../space/rowActionRunner.ts";
  import { gateLinkFor } from "../space/gateLinks.ts";
  import { flyingDistances } from "./flyingDistances.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const warpDistance = flow.warpDistance;
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const buffBar = flow.buffBar;
  // svelte-ignore state_referenced_locally
  const space = store.space;
  // svelte-ignore state_referenced_locally
  const targeting = store.targeting;

  const HINT_LABELS = {
    numAttacks: "UI/Inflight/NumAttacks",
    attacker: "UI/Inflight/EwarAttacker2",
    attackerNpc: "UI/Inflight/EwarAttackerNPC2",
    andMore: "UI/Inflight/AndMorewarAttackers",
    failedAttempts: "UI/Inflight/EwarHints/FailedEwarAttempts",
  } as const;

  onMount(() => {
    flow.requestWords([
      ...new Set(BUFF_SLOTS.map((slot) => slot.hint)),
      ...Object.values(HINT_LABELS),
      "UI/InfoWindow/ValueAndUnit",
      ...SHORT_INTERVAL_WORD_LABELS,
    ]);
    flow.wantBuffBar();
  });

  let nowMs = $state(Date.now());
  /** The bar's children and which show, laid out again at each change of what is on the ship (relaidBuffBar). */
  let layout = $state(newBuffBarLayout());
  $effect(() => {
    const state = $buffBar;
    // (Read again as time goes: an effect's run ends with no notice, CheckForStopCandidates.)
    layout = relaidBuffBar(untrack(() => layout), state, nowMs);
  });
  const order = $derived(shownBuffSlots(layout));

  /**
   * Each slot's buff timer (UpdateDbuffTimer): started when the latest end of its buffs changes, and running down from
   * then to that end (ModuleEffectTimer.StartTimer(duration), at least 0.2 s), on the server's clock.
   */
  let buffTimers = $state<Record<string, { readonly endMs: number; readonly fromMs: number }>>({});
  $effect(() => {
    const state = $buffBar;
    const shown = order;
    const before = untrack(() => buffTimers);
    const now = Date.now() + state.clockOffsetMs;
    const next: Record<string, { readonly endMs: number; readonly fromMs: number }> = {};
    for (const name of shown) {
      const slot = buffSlotOf(name);
      const endMs = slot === null ? null : slotBuffEndMs(slot, state.incoming);
      if (endMs === null) continue;
      const kept = before[name];
      next[name] = kept !== undefined && kept.endMs === endMs ? kept : { endMs, fromMs: Math.min(now, endMs - 200) };
    }
    buffTimers = next;
  });

  let tip = $state<{ readonly slot: string; readonly left: number; readonly top: number; readonly below: boolean } | null>(null);
  $effect(() => {
    if (order.length === 0 && tip === null) return;
    const handle = setInterval(() => { nowMs = Date.now(); }, 250);
    return () => clearInterval(handle);
  });
  const serverNowMs = $derived(nowMs + $buffBar.clockOffsetMs);

  /**
   * How much of a slot's timer is left, 0 to 1, or null for a slot with none: the one started last of its buffs' and
   * its jammers' (each a ModuleEffectTimer, the last started drawn over the rest), on the browser's clock.
   */
  function timerLeft(name: string): number | null {
    const slot = buffSlotOf(name);
    if (slot === null) return null;
    const offset = $buffBar.clockOffsetMs;
    const buff = buffTimers[name];
    const fromBuff = buff === undefined ? null : { startMs: buff.fromMs - offset, endMs: buff.endMs - offset };
    const jam = slotJamTimer(slot, $buffBar, nowMs);
    const timer = fromBuff === null ? jam : jam === null || fromBuff.startMs >= jam.startMs ? fromBuff : jam;
    if (timer === null) return null;
    const span = timer.endMs - timer.startMs;
    return span <= 0 ? 0 : Math.max(0, Math.min(1, (timer.endMs - nowMs) / span));
  }

  const nameOf = (kind: Parameters<typeof resolvedName>[1], id: number): string => resolvedName($names.resolved, kind, id, "");
  function said(label: string, args: Readonly<Record<string, string | number>> = {}): string {
    const template = $words.templates[label];
    return typeof template === "string" ? plainText(formatTemplate(template, args, { nameOf })) : "";
  }
  const attributeWords: AttributeWords = {
    label: (path, args) => said(path, args ?? {}) || (path === "UI/InfoWindow/ValueAndUnit" && args ? `${args.value ?? ""} ${args.unit ?? ""}`.trim() : ""),
    message: () => "",
    unitName: (unitID) => (unitID === UNIT_MODIFIER_RELATIVE_PERCENT ? $buffBar.percentUnitName : ""),
    typeName: () => "",
    groupName: () => "",
    attribute: () => null,
    shortInterval: (ticks) => shortWrittenInterval(ticks, $words.templates),
  };
  const buffWriter: BuffHintWriter = {
    valueAndUnit: (value, unitID) => valueAndUnitText(value, unitID, attributeWords),
    interval: (ticks) => shortWrittenInterval(ticks, $words.templates) ?? "",
  };
  // localization.util.Sort's comparison (GetSortFunc): the names in lower case by the collator, then as they are the
  // other way about.
  const collator = new Intl.Collator("en");
  const ewarWriter: EwarHintWriter = {
    numAttacks: (num) => said(HINT_LABELS.numAttacks, { num }) || `${num}×`,
    attacker: (characterID, shipTypeID) => (characterID !== null
      ? said(HINT_LABELS.attacker, { attackerID: characterID, attackerShipID: shipTypeID }) || `${nameOf("character", characterID)} (${nameOf("type", shipTypeID)})`
      : said(HINT_LABELS.attackerNpc, { attackerShipID: shipTypeID }) || nameOf("type", shipTypeID)),
    andMore: (num) => said(HINT_LABELS.andMore, { num }) || `+${num}`,
    failedAttempts: () => said(HINT_LABELS.failedAttempts) || "Did not land",
    compare: (a, b) => collator.compare(a.toLowerCase(), b.toLowerCase()) || collator.compare(b, a),
  };
  /** The ballpark's item for a source (GetInvItem): the ship in space the page last saw, its type and its pilot. */
  const sourceOf: EwarSourceOf = (sourceID) => {
    const entity = store.space.get().snapshot?.entities.find((each) => each.itemID === sourceID) ?? null;
    return entity === null || entity.typeID === null ? null : { typeID: entity.typeID, characterID: entity.characterID };
  };

  /** The hint's rows: the attackers (GetNormalHintList), then the buffs (GetDbuffHintItemList). */
  function hintRows(name: string): HintRow[] {
    const slot = buffSlotOf(name);
    if (slot === null) return [];
    const ewar = ewarHintRows(slot, $buffBar, sourceOf, ewarWriter, nowMs);
    const buffs = buffHintRows(slot, $buffBar.incoming, $buffBar.facts, buffWriter, serverNowMs)
      .map((row) => ({ col1: row.value ?? "", col2: row.name, col3: row.timeLeft, fullRowText: null }));
    return [...ewar, ...buffs];
  }

  /**
   * BuffBtnController.GetButtonMenu: each source of the slot's electronic warfare on the ship that is in space, by its
   * pilot's name or else its type's, in name order (localization.util.Sort on the names), each opening that object's
   * menu (CelestialMenu; here what the overview and the tactical ring offer for it, after Show Info). A slot with no
   * source has no menu. OnButtonClick acts only with a combat command held (IsSomeCombatCommandLoaded), which the page
   * has none of, so a click does nothing.
   */
  let menu = $state<{ readonly slot: string; readonly x: number; readonly y: number; readonly open: number | null } | null>(null);
  function menuSources(name: string): { readonly itemID: number; readonly name: string }[] {
    const sources = [...new Set(($buffBar.jammers.get(name) ?? []).map((jammer) => jammer.sourceID))];
    const rows: { readonly itemID: number; readonly name: string }[] = [];
    for (const itemID of sources) {
      const item = sourceOf(itemID);
      if (item === null) continue;
      rows.push({ itemID, name: item.characterID !== null ? nameOf("character", item.characterID) : nameOf("type", item.typeID) });
    }
    return rows.sort((a, b) => ewarWriter.compare(a.name, b.name));
  }
  function sourceActions(itemID: number): readonly RowAction[] {
    const row = $space.snapshot?.entities.find((each) => each.itemID === itemID) ?? null;
    if (row === null) return [];
    return actionsForRow({
      kind: row.kind,
      locked: $targeting.lockedTargetIDs.includes(itemID),
      acquiring: $targeting.acquiringTargetIDs.includes(itemID),
      gateLink: gateLinkFor($space.gateLinks, itemID),
      groupID: row.groupID ?? null,
      warping: $space.snapshot?.ship?.mode === "WARP",
      categoryID: row.categoryID,
    }).filter((action) => isSingleCallAction(action.id));
  }
  // in flight, the sources in the shared context menu, each its object's own CelestialMenu as the submenu
  const flightView = getContext<(() => SpaceView | null) | undefined>("flightSpaceView");
  const sharedMenu = new ContextMenu();
  onDestroy(() => sharedMenu.close());
  function openMenu(event: MouseEvent, name: string): void {
    event.preventDefault();
    tip = null;
    const sources = menuSources(name);
    if (sources.length === 0) {
      menu = null;
      return;
    }
    const view = flightView?.();
    if (view) {
      sharedMenu.open(event.clientX, event.clientY, sources.map((source) => ({ label: source.name || "-", sub: view.menuEntriesFor(source.itemID) ?? [] })));
      return;
    }
    menu = { slot: name, x: event.clientX, y: event.clientY, open: null };
  }
  async function pickAction(itemID: number, action: RowAction): Promise<void> {
    menu = null;
    if (action.unavailable !== null) return;
    spaceSelection.select(itemID);
    await dispatchRowAction(flow, action.id, { itemID, gateLink: gateLinkFor($space.gateLinks, itemID) }, {
      warp: $warpDistance,
      orbit: Number($flyingDistances.orbit),
      hold: Number($flyingDistances.hold),
    }).catch((error: unknown) => console.error(error));
  }
  function pickShowInfo(itemID: number): void {
    menu = null;
    const row = $space.snapshot?.entities.find((each) => each.itemID === itemID) ?? null;
    if (row !== null) showInfo({ kind: "spaceObject", itemID, typeID: row.typeID });
  }

  function showTip(event: Event, name: string): void {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    // Above the bar where there is room for it, as the client's tooltip stands off its button; below it otherwise.
    const below = box.top < 160;
    tip = { slot: name, left: box.left + box.width / 2, top: below ? box.bottom + 6 : box.top - 6, below };
    // The attackers' names, asked for as the hint shows them.
    const refs = (($buffBar.jammers.get(name) ?? []).flatMap((jammer) => {
      const item = sourceOf(jammer.sourceID);
      return item === null ? [] : [{ kind: "type" as const, id: item.typeID }, ...(item.characterID === null ? [] : [{ kind: "character" as const, id: item.characterID }])];
    }));
    if (refs.length > 0) flow.requestNames(refs);
  }
</script>

{#if order.length > 0}
  <div class="buff-bar" role="list" aria-label="Effects on your ship">
    {#each order as name (name)}
      {@const slot = buffSlotOf(name)}
      {#if slot !== null}
        {@const iconFile = $buffBar.iconFiles.get(slot.iconID) ?? null}
        {@const left = timerLeft(name)}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div class="buff-slot {slot.kind}" role="listitem" tabindex="0" data-buff-slot={name}
          onmouseenter={(event) => showTip(event, name)} onmouseleave={() => (tip = null)}
          onfocus={(event) => showTip(event, name)} onblur={() => (tip = null)}
          oncontextmenu={(event) => openMenu(event, name)}>
          <span class="buff-slot-underlay" style:--underlay-grad={`url(${clientTexture("res:/UI/Texture/classes/ShipUI/EwarBar/ewarBarUnderlayGrad.png")})`}
            style:--underlay-clean={`url(${clientTexture("res:/UI/Texture/classes/ShipUI/EwarBar/ewarBarUnderlayClean.png")})`} aria-hidden="true"></span>
          {#if iconFile !== null}
            <img class="buff-slot-icon" src={clientTexture(iconFile)} alt="" width="40" height="40" />
          {/if}
          {#if left !== null}
            <span class="buff-slot-timer" style:--left={`${left * 360}deg`} aria-hidden="true"></span>
          {/if}
          <span class="buff-slot-name">{said(slot.hint) || "An effect on your ship"}</span>
        </div>
      {/if}
    {/each}
  </div>
{/if}

{#if menu !== null}
  <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
  <div class="buff-menu-shade" use:portal onclick={() => (menu = null)} oncontextmenu={(event) => { event.preventDefault(); menu = null; }}></div>
  <div class="buff-menu" role="menu" use:portal style:left={`${menu.x}px`} style:top={`${menu.y}px`}
    tabindex="-1" onkeydown={(event) => { if (event.key === "Escape") menu = null; }}>
    {#each menuSources(menu.slot) as source, index (source.itemID)}
      <button type="button" class="buff-menu-item" role="menuitem" aria-haspopup="menu" aria-expanded={menu.open === index}
        onclick={() => { if (menu !== null) menu = { ...menu, open: menu.open === index ? null : index }; }}>
        {source.name || "—"} <span aria-hidden="true">›</span>
      </button>
      {#if menu.open === index}
        <div class="buff-menu-sub" role="menu">
          <button type="button" class="buff-menu-item" role="menuitem" onclick={() => pickShowInfo(source.itemID)}>Show info</button>
          {#each sourceActions(source.itemID) as action (action.id)}
            <button type="button" class="buff-menu-item" role="menuitem" disabled={action.unavailable !== null}
              title={action.unavailable ?? undefined} onclick={() => void pickAction(source.itemID, action)}>
              {action.label}
            </button>
          {/each}
        </div>
      {/if}
    {/each}
  </div>
{/if}

{#if tip !== null}
  {@const slot = buffSlotOf(tip.slot)}
  {#if slot !== null}
    {@const rows = hintRows(tip.slot)}
    <div class="buff-tip" class:below={tip.below} role="tooltip" use:portal style:left={`${tip.left}px`} style:top={`${tip.top}px`}>
      <strong class="buff-tip-caption">{said(slot.hint) || "An effect on your ship"}</strong>
      {#each rows as row, index (index)}
        {#if row.fullRowText !== null}
          <span class="buff-tip-full">{row.fullRowText}</span>
        {:else}
          <span class="buff-tip-value">{row.col1}</span>
          <span class="buff-tip-name" class:wide={!row.col3}>{row.col2}</span>
          {#if row.col3}<span class="buff-tip-time">{row.col3}</span>{/if}
        {/if}
      {/each}
    </div>
  {/if}
{/if}
