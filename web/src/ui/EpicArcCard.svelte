<script lang="ts">
  // jobboard features/epic_arcs/card.EpicArcCard (a JobHeroCard): the arc's picture at the right
  // (epicArcConst.BACKGROUND_BY_EPICARCID) under a gradient from black at the left, the faction's logo at the bottom
  // right (FACTION_LOGO_BY_EPICARCID). At the top the feature's tag (contentTags feature_epic_arcs: its eveicon and
  // title), the progress gauge at the right while the arc is started, and the solar system of the arc's active agent
  // (SolarSystemChip). Then the subtitle (the faction's name) and the title (the arc's name, two lines). The state
  // (EpicArcJob.get_state_info) colours the left line and is said at the bottom: offered (UI/Agency/EpicArcAvailable,
  // WARNING_ORANGE), unavailable (UI/Menusvc/MenuHints/Unavailable, WARNING_ORANGE), complete
  // (UI/Agency/EpicArcComplete, SUCCESS_GREEN). Its click opens the arc's page.
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, EpicArcsRead } from "../app/flow.ts";
  import { ARC_COMPLETE, ARC_STARTED, ARC_UNAVAILABLE, EPIC_ARC_LOOKS, type EpicArcView } from "../bridge/epicArcs.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { securityStatusColor, shownSecurity } from "../bridge/systemSecurity.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  let { store, flow, arc, featureTag, onOpen }: { store: ClientStore; flow: AppFlow; arc: EpicArcView; featureTag: EpicArcsRead["featureTag"]; onOpen: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const agents = store.agents;
  const look = $derived(EPIC_ARC_LOOKS[arc.epicArcID] ?? null);
  const systemID = $derived(arc.activeAgentID ? $agents.agentSolarSystems[arc.activeAgentID] ?? null : null);
  $effect(() => {
    flow.requestWords(["UI/Agency/EpicArcAvailable", "UI/Menusvc/MenuHints/Unavailable", "UI/Agency/EpicArcComplete", ...[arc.nameID, featureTag?.title ?? null].filter((x): x is number => x !== null).map((x) => `#${x}`)]);
    if (arc.activeAgentID) flow.requestAgentSolarSystem(arc.activeAgentID);
  });
  $effect(() => {
    if (systemID === null) return;
    flow.requestNames([{ kind: "system", id: systemID }]);
    flow.requestSystemSecurity([systemID]);
  });
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: (k, id) => resolvedName($names.resolved, k, id, "") }));
  const offered = $derived(arc.state === 2 || arc.replayable);
  const state = $derived(offered ? { text: word("UI/Agency/EpicArcAvailable"), color: "#e6a23c", icon: "💬" }
    : arc.state === ARC_UNAVAILABLE ? { text: word("UI/Menusvc/MenuHints/Unavailable"), color: "#e6a23c", icon: "✕" }
    : arc.state === ARC_COMPLETE ? { text: word("UI/Agency/EpicArcComplete", { completeTime: { type: "long", value: String(BigInt(arc.completeTimeMs ?? 0) * 10000n + 116_444_736_000_000_000n) } }), color: "#5fb85f", icon: "✔" }
    : null);
  const ratio = $derived(arc.missions ? arc.missionsCompleted / arc.missions : 0);
  const security = $derived(systemID === null ? null : $names.systemSecurity?.[systemID] ?? null);
</script>

<div class="ea-card" role="button" tabindex="-1" style:border-left-color={state?.color ?? "var(--theme-focus, #58a6dc)"} onclick={onOpen} onkeydown={() => {}}>
  {#if look}<img class="ea-bg" alt="" src={clientTexture(`res:/UI/Texture/classes/Opportunities/${look.background}.png`)} />{/if}
  <div class="ea-gradient"></div>
  {#if look}<img class="ea-logo" alt="" src={clientTexture(`res:/UI/Texture/eveicon/faction_logos/${look.logo}_64px.png`)} />{/if}
  <div class="ea-top">
    {#if featureTag?.icon}<img class="ea-tag" alt="" src={clientTexture(featureTag.icon)} />{/if}
    <span class="ea-dim">{featureTag?.title ? word(`#${featureTag.title}`) : ""}</span>
    {#if arc.state === ARC_STARTED}<span class="ea-gauge" style:--outer={`${ratio * 360}deg`}><span>{Math.floor(ratio * 100)}%</span></span>{/if}
  </div>
  {#if systemID !== null}<div class="ea-system">{#if security !== null}<b style:color={securityStatusColor(security)}>{shownSecurity(security).toFixed(1)}</b>{/if} {resolvedName($names.resolved, "system", systemID, "")}</div>{/if}
  <div class="ea-middle">
    {#if arc.factionID}<div class="ea-sub">{resolvedName($names.resolved, "owner", arc.factionID, "")}</div>{/if}
    <div class="ea-title">{arc.nameID ? word(`#${arc.nameID}`) : ""}</div>
  </div>
  {#if state}<div class="ea-state" style:color={state.color}>{state.icon} {state.text}</div>{/if}
</div>

<style>
  .ea-card { position: relative; overflow: hidden; cursor: pointer; height: 176px; display: flex; flex-direction: column; padding: 12px; box-sizing: border-box; border-left: 2px solid; background: #000; border-radius: 0 8px 8px 0; grid-column: 1 / -1; }
  .ea-bg { position: absolute; right: 0; top: 0; height: 176px; width: auto; max-width: none; pointer-events: none; }
  .ea-gradient { position: absolute; inset: 0; width: 60%; background: linear-gradient(to right, rgba(0, 0, 0, 0.9), rgba(0, 0, 0, 0)); pointer-events: none; }
  .ea-logo { position: absolute; right: 16px; bottom: 16px; width: 48px; height: 48px; opacity: 0.6; pointer-events: none; }
  .ea-top, .ea-system, .ea-middle, .ea-state { position: relative; }
  .ea-top { display: flex; align-items: center; gap: 6px; height: 20px; }
  .ea-tag { width: 16px; height: 16px; }
  .ea-dim { opacity: 0.7; font-size: 12px; }
  .ea-gauge { margin-left: auto; width: 50px; height: 50px; border-radius: 50%; background: conic-gradient(#4fd1c5 var(--outer), rgba(0, 0, 0, 0.6) 0); display: flex; align-items: center; justify-content: center; }
  .ea-gauge > span { width: 44px; height: 44px; border-radius: 50%; background: rgba(0, 0, 0, 0.8); display: flex; align-items: center; justify-content: center; font-size: 11px; }
  .ea-system { margin-top: 8px; font-size: 12px; }
  .ea-middle { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; padding-bottom: 6px; }
  .ea-sub { padding-bottom: 4px; }
  .ea-title { font-weight: bold; font-size: 16px; max-width: 60%; }
  .ea-state { font-size: 12px; }
</style>
