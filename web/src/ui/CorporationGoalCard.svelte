<script lang="ts">
  // jobboard features/corporation_goals/card (CorporationGoalCard): a corporation project's card - the career's flair, the
  // left line in the state's colour (Closed orange, Completed green, Expired red, else THEME_FOCUS), the contribution
  // method's title, the progress gauge (the corporation's on the outside, the pilot's inside), the name, the ISK remaining
  // (number_readable_short), the contribution icon with an unclaimed reward (ClaimableRewardsTooltip: UnclaimedRewardShort
  // and the ISK). A project manager's hover actions (Clone, View Participants) where the opener gives them. Shared by the
  // Corporation window's Projects (CorporationProjects.svelte) and the job board window.
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, CorporationGoal, CorporationGoals } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  let { store, flow, goal: g, methods, onOpen, onMenu, onClone, onViewParticipants }: {
    store: ClientStore; flow: AppFlow; goal: CorporationGoal; methods: CorporationGoals["methods"]; onOpen: () => void;
    onMenu?: (e: MouseEvent) => void; onClone?: () => void; onViewParticipants?: () => void;
  } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const G = "UI/Corporations/Goals/";
  $effect(() => {
    flow.requestWords(["UI/Common/ISK", "UI/Util/UnitPrefixThousandShort", "UI/Util/UnitPrefixMillionShort", "UI/Util/UnitPrefixBillionShort", "UI/Util/UnitPrefixTrillionShort",
      "UI/Common/UnclaimedRewardShort", G + "CloneProject", "UI/Corporations/FreelanceProjects/ViewParticipants", ...(g.methodID && methods[g.methodID]?.titleID ? [`#${methods[g.methodID]!.titleID}`] : [])]);
  });
  const nameAny = (k: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, k, id, "");
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: nameAny }));
  const isk = (v: number) => `${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${word("UI/Common/ISK") || "ISK"}`;
  // eveformat number_readable_short (3 significant digits, K / M / B / T) with ISK.
  function iskShort(value: number): string {
    const sig = (v: number) => (v === 0 ? 0 : Number(v.toPrecision(3)));
    const v = sig(value), k = v === 0 ? 0 : Math.max(0, Math.min(4, Math.floor(Math.log10(Math.abs(v)) / 3)));
    const scaled = v / 1000 ** k;
    let places = 0;
    for (let i = 0; i < 2; i++) if (Math.round(scaled * 10 ** (2 - i)) % 10 > 0) { places = 2 - i; break; }
    const text = scaled.toLocaleString("en-US", { minimumFractionDigits: places, maximumFractionDigits: places });
    const prefix = ["", "UI/Util/UnitPrefixThousandShort", "UI/Util/UnitPrefixMillionShort", "UI/Util/UnitPrefixBillionShort", "UI/Util/UnitPrefixTrillionShort"][k]!;
    return `${text}${prefix ? word(prefix) : ""} ${word("UI/Common/ISK") || "ISK"}`;
  }
  // careerConst.CAREERS_BG_FLAIR.
  const FLAIR: Record<number, string> = { 4: "explorer", 5: "industrialist", 6: "enforcer", 7: "sof" };
  const flair = (careerPath: number | null) => clientTexture(`res:/UI/Texture/Shared/CareerPaths/${(careerPath !== null && FLAIR[careerPath]) || "unclassified"}_flair.png`);
  const methodTitle = $derived.by(() => { const m = g.methodID ? methods[g.methodID] : undefined; return m?.titleID ? word(`#${m.titleID}`) : g.methodID ?? ""; });
  const remaining = $derived(Math.max(0, g.desired - g.current));
  const totalIsk = $derived((g.amountPerUnit ?? 0) * remaining);
  const ratio = $derived(g.desired ? g.current / g.desired : 0);
  const myRatio = $derived(!g.myProgress ? 0 : g.participationLimit ? g.myProgress / g.participationLimit : g.desired ? g.myProgress / g.desired : 0);
  const lineColor = $derived(g.state === 2 ? "#f39058" : g.state === 3 ? "#5fb85f" : g.state === 4 ? "#d4534f" : "var(--theme-focus, #58a6dc)");
</script>

<div class="cp-card" style:--line={lineColor} role="button" tabindex="-1" onclick={onOpen} onkeydown={() => {}} oncontextmenu={(e) => { if (!onMenu) return; e.preventDefault(); e.stopPropagation(); onMenu(e); }}>
  <img class="cp-flair" src={flair(g.careerPath)} alt="" />
  <div class="cp-card-top">
    <span class="cp-method" title={g.description}>{methodTitle}</span>
    <span class="cp-gauge" title={`${Math.round(ratio * 100)}% · ${Math.round(myRatio * 100)}%`} style:--outer={`${Math.min(1, ratio) * 360}deg`} style:--inner={`${Math.min(1, myRatio) * 360}deg`}><span></span></span>
  </div>
  <div class="cp-card-title">{g.name}</div>
  <div class="cp-card-bottom">{#if totalIsk}<span>¤ {iskShort(totalIsk)}</span>{/if}
    {#if g.myUnclaimed > 0}<span class="cp-claimable" title={`${word("UI/Common/UnclaimedRewardShort")} ${isk(g.myUnclaimed * (g.amountPerUnit ?? 0))}`}>✚</span>{/if}
    {#if onClone || onViewParticipants}<span class="cp-card-actions">
      {#if onClone}<button title={word(G + "CloneProject")} onclick={(e) => { e.stopPropagation(); onClone?.(); }}>⧉</button>{/if}
      {#if onViewParticipants}<button title={word("UI/Corporations/FreelanceProjects/ViewParticipants")} onclick={(e) => { e.stopPropagation(); onViewParticipants?.(); }}>☰</button>{/if}
    </span>{/if}</div>
</div>

<style>
  .cp-card { position: relative; height: 186px; display: flex; flex-direction: column; padding: 16px; box-sizing: border-box; overflow: hidden; border-left: 2px solid var(--line); background: rgba(0, 0, 0, 0.6); border-radius: 0 8px 8px 0; cursor: pointer; }
  .cp-flair { position: absolute; left: -175px; top: -175px; width: 400px; height: 400px; opacity: 0.35; pointer-events: none; }
  .cp-card-top { position: relative; display: flex; justify-content: space-between; align-items: flex-start; height: 50px; }
  .cp-method { opacity: 0.65; }
  .cp-gauge { width: 50px; height: 50px; border-radius: 50%; background: conic-gradient(var(--line) var(--outer), rgba(255, 255, 255, 0.1) 0); display: flex; align-items: center; justify-content: center; }
  .cp-gauge span { width: 38px; height: 38px; border-radius: 50%; background: radial-gradient(#111 55%, transparent 56%), conic-gradient(#fff var(--inner), rgba(255, 255, 255, 0.05) 0); }
  .cp-card-title { position: relative; flex: 1; font-size: 16px; font-weight: bold; padding-top: 8px; overflow: hidden; }
  .cp-card-bottom { position: relative; height: 24px; display: flex; align-items: center; justify-content: space-between; border-radius: 8px; background: rgba(255, 255, 255, 0.05); padding: 0 8px; }
  .cp-claimable { color: #5fb85f; }
  .cp-card-actions { display: flex; gap: 4px; opacity: 0; transition: opacity 0.3s; }
  .cp-card:hover .cp-card-actions { opacity: 1; }
  .cp-card-actions button { all: unset; cursor: pointer; width: 24px; text-align: center; }
</style>
