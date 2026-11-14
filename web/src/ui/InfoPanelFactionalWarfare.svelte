<script lang="ts">
  // infoPanels/infoPanelFactionalWarfare.InfoPanelFactionalWarfare (PANEL_FACTIONAL_WARFARE, after the route's in
  // PANELTYPES; FactionalWarfare.png). IsAvailable: the pilot's system is a warzone system (fwWarzoneSvc
  // IsWarzoneSolarSystem) - here, GetLocalOccupationState answers an occupation state.
  // - The header: UI/FactionWarfare/FactionalWarfare; in compact mode the status line instead, after a small gauge.
  // - ContestedFWSystemGauge (radius 25): the contested fraction (VictoryPointState: min(score / threshold, 1)) in the
  //   attacker's colour, the rest in the occupier's (FACTION_ID_TO_COLOR), a 0.01 black gap before each; inside it
  //   the adjacency's icon (ADJACENCY_STATE_TO_ICON_PATH_SMALL: front / HQ / support).
  // - GetStatusText: the occupier's name, then GetSystemCaptureStatusText - UI/FactionWarfare/StatusVulnerable (score at
  //   the threshold), StatusContested {num: fraction * 100} (score above 0), else StatusStable.
  // - GetAdjacencyText: ADJACENCY_TO_LABEL_SYSTEM_TEXT (UI/FactionWarfare/frontlines/FrontlineSystem, SecondlineSystem,
  //   BacklineSystem).
  // - _GetAdvantageTextAndHint (the net advantage line, EveLabelSmall, in normal mode outside Bulwark systems): the
  //   activity tracker's scores (fwAdvantageSvc: GetSolarSystemScoresRequest); the net score the occupier's
  //   contribution + floor less the attacker's; a winner where it is not 0: UI/FactionWarfare/shortAdvantageLine
  //   {factionName: the winner's race's name, netAdvantagePercent: |net| as {0:.0%}}, its hint advantagebreakdownTooltip
  //   {objectives, floor: the winner's contribution and floor as {0:.0%}}; else noFactionHasAdvantageShortLine.
  // Not here: the system upgrade's benefit icons, the battlefield scoreboards, the Bulwark systems, the title's
  // OpenMilitia link, the gauge's tooltip.
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, FactionWarfareLocal } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { clientTexture } from "../play/window.ts";
  let { store, flow, compact, onToggle }: { store: ClientStore; flow: AppFlow; compact: boolean; onToggle: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const flight = store.flight;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const F = "UI/FactionWarfare/";
  const systemID = $derived($flight.status?.solarSystemID ?? $station.online?.solarSystemID ?? null);
  let fw = $state<FactionWarfareLocal | null>(null);
  // fwWarzoneSvc / fwVictoryPointSvc keep the state while the session is in the system: asked again on a new system.
  $effect(() => {
    const asked = systemID;
    if (asked === null) { fw = null; return; }
    void flow.factionWarfareLocal().then((read) => { if (asked === systemID) fw = read; }, () => { fw = null; });
  });
  $effect(() => {
    flow.requestWords([F + "shortAdvantageLine", F + "advantagebreakdownTooltip", F + "noFactionHasAdvantageShortLine", ...Object.values(fw?.raceNameIDs ?? {}).map((id) => `#${id}`), F + "FactionalWarfare", F + "StatusVulnerable", F + "StatusContested", F + "StatusStable", F + "frontlines/FrontlineSystem", F + "frontlines/SecondlineSystem", F + "frontlines/BacklineSystem"]);
    if (fw?.occupation) flow.requestNames([{ kind: "owner", id: fw.occupation.occupierID }]);
  });
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: (k, id) => resolvedName($names.resolved, k, id, "") }));
  // fwwarzone dashboard const FACTION_ID_TO_COLOR (eveColor).
  const COLORS: Record<number, string> = { 500001: "#00ACD1", 500004: "#40AA5E", 500002: "#FE3743", 500003: "#E7B815", 500011: "#FFE1B0", 500010: "#E54500" };
  const ICONS: Record<string, string> = { FL: "front_icon_small", SL: "HQ_icon_small", BL: "support_icon_small" };
  const ADJACENCY: Record<string, string> = { FL: "frontlines/FrontlineSystem", SL: "frontlines/SecondlineSystem", BL: "frontlines/BacklineSystem" };
  const occ = $derived(fw?.occupation ?? null);
  const fraction = $derived(fw?.victory ? Math.min(fw.victory.score / fw.victory.threshold, 1) : 0);
  const statusText = $derived.by(() => {
    const v = fw?.victory;
    if (!v) return "";
    if (v.score >= v.threshold) return word(F + "StatusVulnerable");
    if (v.score > 0) return word(F + "StatusContested", { num: fraction * 100 });
    return word(F + "StatusStable");
  });
  const status = $derived(occ ? (statusText ? `${resolvedName($names.resolved, "owner", occ.occupierID, "")}: ${statusText}` : resolvedName($names.resolved, "owner", occ.occupierID, "")) : "");
  // Python's '{0:.0%}': the value * 100 rounded to a whole number (half to even), then "%".
  const percent = (value: number) => { const x = value * 100, r = Math.round(x); return `${Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r}%`; };
  const advantage = $derived.by((): { text: string; hint: string } | null => {
    const a = fw?.advantage;
    if (!a || !occ) return null;
    const score = (id: number | null) => (id !== null && a[id] ? a[id].contribution + a[id].floor : 0);
    const net = score(occ.occupierID) - score(occ.attackerID);
    const winner = net > 0 ? occ.occupierID : net < 0 ? occ.attackerID : null;
    if (winner === null) return { text: word(F + "noFactionHasAdvantageShortLine"), hint: "" };
    const raceName = fw?.raceNameIDs[winner] ? word(`#${fw.raceNameIDs[winner]}`) : "";
    return { text: word(F + "shortAdvantageLine", { factionName: raceName, netAdvantagePercent: percent(Math.abs(net)) }),
      hint: word(F + "advantagebreakdownTooltip", { objectives: percent(a[winner]?.contribution ?? 0), floor: percent(a[winner]?.floor ?? 0) }) };
  });
  // UpdateChart: a 0.01 black gap, the contested part (attacker), a 0.01 gap, the rest (occupier); in turns of 1.02.
  const gradient = $derived.by(() => {
    if (!occ) return "";
    const total = 1.02, a = COLORS[occ.attackerID ?? 0] ?? "#888", d = COLORS[occ.occupierID] ?? "#888";
    const p1 = (0.01 / total) * 100, p2 = ((0.01 + fraction) / total) * 100, p3 = ((0.02 + fraction) / total) * 100;
    return `conic-gradient(#000 0 ${p1}%, ${a} ${p1}% ${p2}%, #000 ${p2}% ${p3}%, ${d} ${p3}% 100%)`;
  });
</script>

{#if occ}
  <section class="ip-panel">
    <div class="ip-top">
      <div class="ip-gutter">
        <button type="button" class="ip-expand" class:expanded={!compact} aria-label={compact ? "Expand" : "Collapse"} onclick={onToggle}>
          <img alt="" src={clientTexture("res:/UI/Texture/classes/Neocom/arrowDown.png")} /></button>
        <span class="ip-icon"><img alt="" src={clientTexture("res:/UI/Texture/Classes/InfoPanels/FactionalWarfare.png")} /></span>
      </div>
      {#if compact}<span class="fw-gauge small" style:background={gradient}><span></span></span><span class="fw-line">{status}</span>
      {:else}<span class="fw-title">{word(F + "FactionalWarfare")}</span>{/if}
    </div>
    {#if !compact}
      <div class="ip-main fw-main">
        <span class="fw-gauge" style:background={gradient} title={word(F + (ADJACENCY[occ.adjacency] ?? ""))}><span>
          {#if ICONS[occ.adjacency]}<img alt="" src={clientTexture(`res:/UI/Texture/classes/frontlines/${ICONS[occ.adjacency]}.png`)} />{/if}</span></span>
        <div class="fw-text">
          <span class="fw-line">{status}</span>
          {#if ADJACENCY[occ.adjacency]}<span class="fw-line">{word(F + ADJACENCY[occ.adjacency])}</span>{/if}
          {#if advantage}<span class="fw-small" title={advantage.hint}>{advantage.text}</span>{/if}
        </div>
      </div>
    {/if}
  </section>
{/if}

<style>
  .ip-panel { pointer-events: auto; margin-bottom: 6px; }
  .ip-top { display: flex; align-items: center; min-height: 28px; gap: 6px; }
  .ip-gutter { display: flex; width: 56px; flex: none; }
  .ip-expand, .ip-icon { all: unset; cursor: pointer; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; opacity: 0.8; }
  .ip-expand img { width: 7px; height: 7px; transform: rotate(-90deg); }
  .ip-expand.expanded img { transform: none; }
  .ip-icon img { width: 18px; height: 18px; }
  .fw-title { font-size: 14px; letter-spacing: 0.04em; color: rgb(255 255 255 / 0.85); }
  .fw-main { padding-left: 56px; display: flex; align-items: center; gap: 10px; }
  .fw-gauge { flex: none; width: 50px; height: 50px; border-radius: 50%; display: flex; align-items: center; justify-content: center; }
  .fw-gauge > span { width: 43px; height: 43px; border-radius: 50%; background: rgb(0 0 0 / 0.85); display: flex; align-items: center; justify-content: center; }
  .fw-gauge img { width: 32px; height: 32px; margin-top: 2px; }
  .fw-gauge.small { width: 20px; height: 20px; }
  .fw-gauge.small > span { width: 16px; height: 16px; }
  .fw-text { display: flex; flex-direction: column; gap: 2px; }
  .fw-line { font-size: 12px; color: rgb(255 255 255 / 0.85); }
  .fw-small { margin-top: 8px; font-size: 11px; color: rgb(255 255 255 / 0.75); }
</style>
