<script lang="ts">
  import { tick, untrack } from "svelte";
  import type { Session } from "../app/sessions.ts";
  import { formatTemplate, plainText, type TemplateArguments } from "../bridge/clientWords.ts";
  import { hackCoordKey, hackNeighbours, type HackAction, type HackTile, type HackUtility } from "../bridge/hacking.ts";
  import { playUiEvent } from "../play/uiAudio.ts";
  import { clientTexture } from "../play/window.ts";
  import { resolvedName } from "../store/names.ts";
  import DesktopWindow from "./DesktopWindow.svelte";

  let { session }: { session: Session } = $props();
  // The play shell remounts this window when it changes pilots.
  // svelte-ignore state_referenced_locally
  const flow = session.flow;
  const board = flow.hackBoard;
  // svelte-ignore state_referenced_locally
  const { words, names } = session.store;

  const texture = (file: string) => clientTexture("res:/ui/texture/classes/hacking/" + file + ".png");
  const nodes = {
    "-1": ["UnknownNode", "Unknown node"], 0: ["SegmentNode", "Segment"],
    1: ["Virus", "Virus"], 2: ["CoreNode", "System core"], 3: ["DefenseNode", "Defense subsystem"],
    5: ["UtilityNode", "Utility node"], 6: ["DataCacheNode", "Data cache"],
  } as const;
  const utilities = [
    ["UtilitySelfRepair", "Self Repair", "utilSelfRepair"],
    ["UtilityKernalRot", "Kernel Rot", "utilKernalRot"],
    ["UtilitySecondaryVector", "Secondary Vector", "utilSecondVector"],
    ["UtilityPolymorphicShield", "Polymorphic Shield", "utilPolymorphShield"],
  ] as const;
  const defenses: Readonly<Record<number, readonly [string, string, string]>> = {
    100: ["AntiVirusNode", "Anti-Virus", "defSoftAntiVirus"],
    101: ["FirewallNode", "Firewall", "defSoftFirewall"],
    102: ["HoneyPotStrength", "Virus Suppressor", "defSoftHoneyPotStrength"],
    103: ["HoneyPotHealing", "Restoration Node", "defSoftHoneyPotHealing"],
    104: ["DisruptorNode", "Disruptor", "defSoftIds"],
  };
  const cores: Readonly<Record<number, string>> = { 10: "coreHigh", 11: "coreLow", 12: "coreMedium" };
  const wordsNeeded = [
    "HackSuccess", "HackFailed", "Coherence", "Strength", "EmptyUtilitySlot", "BlockedNode",
    ...Object.values(nodes).map(entry => entry[0]),
    ...utilities.map(entry => entry[0]), ...Object.values(defenses).map(entry => entry[0]),
  ].map(label => "UI/Hacking/" + label);

  const word = (key: string, fallback: string, args: TemplateArguments = {}) => {
    const template = $words.templates["UI/Hacking/" + key];
    return template ? plainText(formatTemplate(template, args, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, String(id)) })) : fallback;
  };
  const utilityHint = (slot: HackUtility) => {
    const utility = utilities[slot.subtype];
    if (!utility) return word("EmptyUtilitySlot", "Empty utility slot");
    if (slot.amount === null || slot.totalDuration === null) return utility[1];
    return word(utility[0], utility[1], { amount: slot.amount, turns: slot.totalDuration });
  };
  const typeName = (id: number | null, fallback: string) => resolvedName($names.resolved, "type", id, fallback);
  const tileName = (tile: HackTile) => {
    const entry = tile.type === 3 && defenses[tile.subtype] || tile.type === 5 && utilities[tile.subtype] ||
      nodes[tile.type as keyof typeof nodes] || nodes[-1];
    return word(entry[0], entry[1]);
  };
  const nodeIcon = (tile: HackTile) => {
    if (tile.type === 2) return cores[tile.subtype] ?? "coreLow";
    if (tile.type === 3) return defenses[tile.subtype]?.[2];
    if (tile.type === 5) return utilities[tile.subtype]?.[2];
    if (tile.type === 6) return "tileDataCache";
  };
  const tileBackground = (tile: HackTile, reachable: boolean) =>
    tile.hidden ? (reachable ? "tileUnflipped" : "tileBlocked") :
      [0, 1, 5, 6].includes(tile.type) ? "infected" + (1 + Math.abs(tile.coord[0] + tile.coord[1]) % 4) : "tileIconFrame";

  let viewportWidth = $state(innerWidth);
  let viewportHeight = $state(innerHeight);
  let moved = $state<{ x: number; y: number } | null>(null);
  const w = $derived(Math.max(260, Math.min(898, viewportWidth - 20)));
  const h = $derived(Math.max(300, Math.min(647, viewportHeight - 20)));
  const fieldWidth = $derived(Math.min(w - 12, (h - 144) * 898 / 501));
  let selection = $state<number | null>(null);
  let inFlight = $state(false);
  let failure = $state("");
  let hovered = $state<string | null>(null);
  let content = $state<HTMLElement | null>(null);
  const tiles = $derived($board ? [...$board.tiles.values()] : []);
  const title = $derived(typeName($board?.start.moduleTypeID ?? null, "Hacking"));
  const left = (tile: HackTile) => (tile.coord[0] + (tile.coord[1] % 2 ? 0.5 : 0)) * 86;
  const top = (tile: HackTile) => tile.coord[1] * 53;
  const middleX = $derived(tiles.length ? (Math.min(...tiles.map(left)) + Math.max(...tiles.map(left))) / 2 : 0);
  const middleY = $derived(tiles.length ? (Math.min(...tiles.map(top)) + Math.max(...tiles.map(top))) / 2 : 0);
  const fieldX = (tile: HackTile) => (left(tile) - middleX) * 100 / 898 + 50;
  const fieldY = (tile: HackTile) => (top(tile) - middleY) * 100 / 501 + 50;
  const adjacent = (tile: HackTile) => hackNeighbours(tile.coord)
    .map(coord => $board?.tiles.get(hackCoordKey(coord)))
    .filter(peer => peer !== undefined);
  const flippable = (tile: HackTile) => !tile.blocked && adjacent(tile).some(peer => !peer.hidden && !peer.blocked);
  const playable = (tile: HackTile) => !tile.blocked && (tile.hidden ? flippable(tile) : [2, 3, 5, 6].includes(tile.type));
  const edges = $derived(tiles.flatMap(tile => adjacent(tile).filter(peer =>
    peer.coord[1] > tile.coord[1] || (peer.coord[1] === tile.coord[1] && peer.coord[0] > tile.coord[0])).map(peer => {
      const dx = left(peer) - left(tile);
      const dy = top(peer) - top(tile);
      return { first: tile, second: peer, width: Math.hypot(dx, dy) * 100 / 898, angle: Math.atan2(dy, dx) };
    })));
  const hint = $derived(hovered === null ? null : $board?.tiles.get(hovered));
  const outcomeText = $derived($board?.outcome === "won" ? word("HackSuccess", "Hack Successful") : word("HackFailed", "Hack Failed"));

  const activation = $derived($board?.start);
  $effect(() => {
    if (!activation) return;
    selection = null;
    failure = "";
    hovered = null;
    flow.requestWords(wordsNeeded);
    inFlight = false;
    void playUiEvent("minigame_start");
    const style = untrack(() => $board?.style);
    if (style === 0 || style === 1) void playUiEvent(style === 0 ? "minigame_type_hack" : "minigame_type_arch");
    void tick().then(() => content?.focus({ preventScroll: true }));
    return () => { void playUiEvent("minigame_stop"); };
  });
  $effect(() => {
    const attempt = $board;
    if (!attempt?.outcome) return;
    void playUiEvent(attempt.outcome === "won" ? "minigame_win" : "minigame_loose");
    const timer = setTimeout(() => flow.clearHack(attempt), 1600);
    return () => clearTimeout(timer);
  });

  async function send(action: HackAction) {
    if (inFlight || !$board || $board.outcome) return;
    const active = $board.start;
    inFlight = true;
    failure = "";
    try {
      await flow.playHack(action);
    } catch (error) {
      if ($board?.start === active) failure = error instanceof Error ? error.message : "The hacking action failed.";
    } finally {
      if ($board?.start === active) inFlight = false;
    }
  }

  function chooseUtility(index: number) {
    const slot = $board?.utilities[index];
    if (!slot || slot.subtype < 0 || slot.inUse || inFlight || $board?.outcome) return;
    if (slot.subtype === 0 || slot.subtype === 3) void send({ type: "virus", utility: index });
    else selection = selection === index ? null : index;
  }

  function clickTile(tile: HackTile) {
    if (inFlight) return;
    const utility = selection;
    selection = null;
    void send({ type: "tile", coord: tile.coord, utility });
  }

  function dismiss() {
    if (!$board) return;
    if ($board.outcome) flow.clearHack($board);
    else void send({ type: "quit" });
  }

  function shortcuts(event: KeyboardEvent) {
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === "Escape") dismiss();
    else if (/^[1-3]$/.test(event.key)) chooseUtility(Number(event.key) - 1);
    else return;
    event.stopPropagation();
    event.preventDefault();
  }
</script>

<svelte:window bind:innerWidth={viewportWidth} bind:innerHeight={viewportHeight} />

{#if $board}
  <div class="hacking-desktop">
    <DesktopWindow win={{ x: moved?.x ?? Math.max(0, (viewportWidth - w) / 2), y: moved?.y ?? Math.max(0, (viewportHeight - h) / 2), w, h, z: 1, minimized: false }}
      {title} focused={true} showTitle={false} resizable={false} onFocus={() => {}}
      onMove={(x, y) => (moved = { x, y })} onResize={() => {}} onClose={dismiss}>
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions (This game surface owns the utility shortcuts.) -->
      <div class="hacking" class:ended={$board.outcome !== null} bind:this={content} role="application" aria-label="Hacking board" tabindex="-1" onkeydown={shortcuts}>
        <div class="field" style:width={fieldWidth + "px"}>
          {#each edges as edge (hackCoordKey(edge.first.coord) + ":" + hackCoordKey(edge.second.coord))}
            <div class="link" class:exposed={!edge.first.hidden && !edge.second.hidden && !edge.first.blocked && !edge.second.blocked}
              style:left={fieldX(edge.first) + "%"} style:top={fieldY(edge.first) + "%"}
              style:width={edge.width + "%"} style:rotate={edge.angle + "rad"}></div>
          {/each}
          {#each tiles as tile (hackCoordKey(tile.coord))}
            {@const reachable = flippable(tile)}
            {@const icon = nodeIcon(tile)}
            <button type="button" class="node" class:hidden-node={tile.hidden} class:explored={!tile.hidden}
              class:blocked={tile.blocked || (tile.hidden && !reachable)} class:combat={tile.type === 2 || tile.type === 3}
              data-coord={hackCoordKey(tile.coord)} data-node-type={tile.type} data-blocked={tile.blocked}
              style:left={fieldX(tile) + "%"} style:top={fieldY(tile) + "%"}
              aria-label={tileName(tile)} aria-disabled={Boolean($board.outcome || inFlight || !playable(tile))}
              disabled={Boolean($board.outcome || !playable(tile))}
              onpointerenter={() => (hovered = hackCoordKey(tile.coord))} onpointerleave={() => (hovered = null)}
              onfocus={() => (hovered = hackCoordKey(tile.coord))} onblur={() => (hovered = null)}
              onclick={() => clickTile(tile)}>
              <img alt="" class="frame" src={texture(tileBackground(tile, reachable))} />
              {#if icon}<img alt="" class="node-icon" src={texture(icon)} />{/if}
              {#if tile.type === 2 || tile.type === 3}
                <span class="node-coherence" aria-label={word("Coherence", "Coherence")}>{tile.coherence}</span>
                <span class="node-strength" aria-label={word("Strength", "Strength")}>{tile.strength}</span>
              {:else if tile.distance !== null && tile.distance > 0}
                <span class="distance">{tile.distance}</span>
              {/if}
            </button>
          {/each}
        </div>
        <div class="footer">
          <div class="virus-stats">
            <img alt="" src={texture("hudIcon")} />
            <span title={word("Coherence", "Coherence")} aria-label={word("Coherence", "Coherence")} class:low={$board.coherence < 50}>
              {$board.coherence}
            </span>
            <span title={word("Strength", "Strength")} aria-label={word("Strength", "Strength")}>{$board.strength}</span>
          </div>
          <div class="utilities" aria-label="Utility slots">
            {#each $board.utilities as slot, index (index)}
              {@const utility = utilities[slot.subtype]}
              {@const label = utilityHint(slot)}
              <button type="button" title={label} aria-label={label} aria-pressed={selection === index}
                class:selected={selection === index} class:active={slot.inUse}
                disabled={!utility || slot.inUse || Boolean($board.outcome)}
                onclick={() => chooseUtility(index)}>
                {#if utility}<img alt="" src={texture(utility[2])} />{/if}
                {#if slot.inUse && slot.remaining !== null}<span>{slot.remaining}</span>{/if}
              </button>
            {/each}
          </div>
          <div class="hint">
            {#if failure}<span role="alert">{failure}</span>
            {:else if hint}
              {hint.blocked ? word("BlockedNode", "Blocked node") : tileName(hint)}
              {#each hint.contents as [id, quantity]}<br />{quantity} × {typeName(id, String(id))}{/each}
            {/if}
          </div>
        </div>
        {#if $board.outcome}<div class="result" role="status">{outcomeText}</div>{/if}
      </div>
    </DesktopWindow>
  </div>
{/if}

<style>
  .hacking-desktop { position: fixed; inset: 0; z-index: 34; pointer-events: none; color: #e2f1ef; }
  .hacking-desktop :global(.win) { position: absolute; pointer-events: auto; overflow: hidden; background: #111919; }
  .hacking-desktop :global(.win-body) { height: calc(100% - 24px); padding: 0; overflow: hidden; }
  .hacking { position: relative; display: grid; height: 100%; place-items: center; outline: none; isolation: isolate; }
  .field { position: absolute; top: calc(50% - 40px); left: 50%; transform: translate(-50%, -50%); aspect-ratio: 898 / 501; }
  .link { position: absolute; height: 1px; background: rgba(137, 204, 194, .35); transform-origin: left center; pointer-events: none; }
  .link.exposed { background: #c36530; box-shadow: 0 0 4px #944318; }
  .node { position: absolute; width: 5.345%; aspect-ratio: 1; transform: translate(-50%, -50%); color: #dffaf5; border: none; padding: 0; background: none; cursor: pointer; }
  .node:disabled { cursor: default; }
  .node .frame { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
  .node.blocked .frame { opacity: .56; }
  .node.explored .frame { filter: sepia(.8) saturate(2); }
  .node.combat .frame { filter: none; opacity: .72; }
  .node:not(:disabled):is(:hover,:focus-visible) { background: center / contain no-repeat url("/client-res/ui/texture/classes/hacking/tilehover.png"); outline: 1px solid #a7e2d8; }
  .node-icon { position: relative; width: 95%; height: 95%; object-fit: contain; pointer-events: none; }
  .node-coherence, .node-strength, .distance { position: absolute; font-size: clamp(10px, 1.5vw, 14px); line-height: 1; text-shadow: 1px 1px 3px #000, -1px -1px 3px #000; }
  .node-coherence { top: -3px; right: 0; color: #ffc190; }
  .node-strength { bottom: -2px; left: 0; color: #ff8c8c; }
  .distance { inset: 38% 0 auto; }
  .footer { position: absolute; display: grid; grid-template-columns: minmax(0, 1fr) max-content minmax(0, 1fr); gap: 12px; align-items: center; bottom: 0; left: 0; right: 0; padding: 0 15px 14px; min-height: 75px; }
  .virus-stats { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; padding: 3px 0; font-size: 17px; }
  .virus-stats img { order: 1; width: 32px; height: 32px; }
  .virus-stats span { padding: 2px 8px; border-bottom: 3px solid #965216; background: rgba(15, 18, 18, .8); }
  .virus-stats span.low { color: #ff8c8c; }
  .virus-stats span:last-child { order: 2; border-color: #982020; }
  .utilities { display: flex; gap: 2px; }
  .utilities button { position: relative; width: min(9vw, 42px); aspect-ratio: 1; border: 0; color: #fff; background: center / contain no-repeat url("/client-res/ui/texture/classes/hacking/utiltilebase.png"); padding: 3px; }
  .utilities button img { width: 100%; height: 100%; }
  .utilities button span { position: absolute; bottom: 1px; right: 3px; font-size: 13px; }
  .utilities button:disabled { opacity: .53; }
  .utilities button.selected, .utilities button.active { outline: 1px solid #f7b47a; opacity: 1; }
  .hint { text-align: right; font-size: 12px; }
  .result { position: absolute; inset: 0; display: grid; place-items: center; color: #fff; font-size: clamp(20px, 4vw, 30px); font-weight: bold; text-shadow: 0 2px 8px #000; pointer-events: none; }
  .ended .field, .ended .footer { opacity: .45; transition: opacity .6s ease-out; }
  @media (prefers-reduced-motion: reduce) { .ended .field, .ended .footer { transition: none; } }
</style>
