<script lang="ts">
  // jobboard features/corporation_goals/page (CorporationGoalPage, open_corporation_goal): Back, then the header (the
  // career's flair, the contribution method, the name; ClaimableRewardButton - ClaimValue {rewardValue}, success style
  // once completed, its tooltip the claimed / unclaimed / total breakdown - where there is an unclaimed reward), Progress
  // (the gauge, progress / target, the method's progress words; RemainingISKReward and the reward per unit), Your
  // Contribution (not for a manual goal, unless the pilot authors: yours / your total - the limit or the target;
  // AvailableToEarn with a limit, TotalEarned), the description, CreatedOn {dateString} with the creator and the
  // corporation. Claim: redeem_reward, the button busy at least 1.5 s, then the opener reads the goals again. Shared by
  // the Corporation window's Projects and the job board window.
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, CorporationGoal, CorporationGoals } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  let { store, flow, goal: g, methods, canAuthor, onBack, onClaimed }: {
    store: ClientStore; flow: AppFlow; goal: CorporationGoal; methods: CorporationGoals["methods"]; canAuthor: boolean;
    onBack: () => void; onClaimed: () => Promise<void> | void;
  } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const G = "UI/Corporations/Goals/";
  $effect(() => {
    flow.requestWords([G + "ClaimValue", G + "ClaimedTooltipBreakdown", G + "UnclaimedTooltipBreakdown", G + "TotalEarnedTooltipBreakdown", G + "Progress", G + "RemainingISKReward",
      G + "YourContribution", G + "ParticipationLimitExplanationTooltip", G + "AvailableToEarn", G + "TotalEarned", G + "CreatedOn", G + "Creator", "UI/Commands/Back", "UI/Common/Description", "UI/Common/ISK"]);
    flow.requestNames([{ kind: "owner", id: g.creator }, ...($station.online?.corporationID ? [{ kind: "owner" as const, id: $station.online.corporationID }] : [])]);
  });
  const nameAny = (k: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, k, id, "");
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: nameAny }));
  const isk = (v: number) => `${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${word("UI/Common/ISK") || "ISK"}`;
  const FLAIR: Record<number, string> = { 4: "explorer", 5: "industrialist", 6: "enforcer", 7: "sof" };
  const flair = (careerPath: number | null) => clientTexture(`res:/UI/Texture/Shared/CareerPaths/${(careerPath !== null && FLAIR[careerPath]) || "unclassified"}_flair.png`);
  const method = $derived(g.methodID ? methods[g.methodID] : undefined);
  const methodTitle = $derived(method?.titleID ? word(`#${method.titleID}`) : g.methodID ?? "");
  const progressDescription = $derived(method?.progressDescriptionID ? word(`#${method.progressDescriptionID}`) : "");
  const rewardDescription = $derived(method?.rewardingDescriptionID ? word(`#${method.rewardingDescriptionID}`) : "");
  const remaining = $derived(Math.max(0, g.desired - g.current));
  const myRemaining = $derived(g.participationLimit ? Math.min(remaining, Math.max(0, g.participationLimit - g.myProgress)) : remaining);
  const totalIsk = $derived((g.amountPerUnit ?? 0) * remaining);
  const myIsk = $derived((g.amountPerUnit ?? 0) * (g.participationLimit ? myRemaining : remaining));
  const ratio = $derived(g.desired ? g.current / g.desired : 0);
  const myRatio = $derived(!g.myProgress ? 0 : g.participationLimit ? g.myProgress / g.participationLimit : g.desired ? g.myProgress / g.desired : 0);
  const unclaimedIsk = $derived(g.myUnclaimed * (g.amountPerUnit ?? 0));
  const earnedIsk = $derived(g.myProgress * (g.amountPerUnit ?? 0));
  const lineColor = $derived(g.state === 2 ? "#f39058" : g.state === 3 ? "#5fb85f" : g.state === 4 ? "#d4534f" : "var(--theme-focus, #58a6dc)");
  const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  let claiming = $state(false);
  async function claim(): Promise<void> {
    if (claiming) return;
    claiming = true;
    try {
      await Promise.all([flow.redeemCorporationGoalReward(g.goalID), new Promise((r) => setTimeout(r, 1500))]);
      await onClaimed();
    } finally { claiming = false; }
  }
</script>

<div class="cp-overlay-head"><button class="cp-ghost" onclick={onBack}>{word("UI/Commands/Back")}</button></div>
<div class="cp-details">
  <header class="cp-job-head">
    <img class="cp-flair" src={flair(g.careerPath)} alt="" />
    <span class="cp-method">{methodTitle}</span>
    <h2>{g.name}</h2>
    {#if g.myUnclaimed > 0}
      <button class="cp-claim" class:done={g.state === 3} disabled={claiming} title={`${word(G + "ClaimedTooltipBreakdown")} ${isk(earnedIsk - unclaimedIsk)} · ${word(G + "UnclaimedTooltipBreakdown")} ${isk(unclaimedIsk)} · ${word(G + "TotalEarnedTooltipBreakdown")} ${isk(earnedIsk)}`}
        onclick={() => void claim()}>{claiming ? "…" : word(G + "ClaimValue", { rewardValue: isk(unclaimedIsk) })}</button>
    {/if}
  </header>
  <section><h3>{word(G + "Progress")}</h3>
    <div class="cp-progress">
      <div class="cp-overview">
        <span class="cp-gauge cp-gauge-big" style:--line={lineColor} style:--outer={`${Math.min(1, ratio) * 360}deg`} style:--inner="0deg"><span></span></span>
        <div><b>{g.current.toLocaleString("en-US")}</b><small>/ {g.desired.toLocaleString("en-US")}</small><small>{(ratio * 100).toFixed(0)}% <span class="cp-dim">{progressDescription}</span></small></div>
      </div>
      {#if g.amountPerUnit}
        <div class="cp-reward"><small>{word(G + "RemainingISKReward")}</small><b>{isk(totalIsk)}</b><small>{rewardDescription}</small><b>{isk(g.amountPerUnit)}</b></div>
      {/if}
    </div>
  </section>
  {#if g.methodID !== "Manual" || canAuthor}
    <section title={g.participationLimit ? word(G + "ParticipationLimitExplanationTooltip") : ""}><h3>{word(G + "YourContribution")}</h3>
      <div class="cp-progress">
        <div class="cp-overview">
          <span class="cp-gauge cp-gauge-big" style:--line={lineColor} style:--outer={`${Math.min(1, myRatio) * 360}deg`} style:--inner="0deg"><span></span></span>
          <div><b>{g.myProgress.toLocaleString("en-US")}</b><small>/ {(g.participationLimit ?? g.desired).toLocaleString("en-US")}</small><small>{(myRatio * 100).toFixed(0)}% <span class="cp-dim">{progressDescription}</span></small></div>
        </div>
        {#if g.amountPerUnit}
          <div class="cp-reward">
            {#if g.participationLimit}<small>{word(G + "AvailableToEarn")}</small><b>{isk(myIsk)}</b>{/if}
            <small>{word(G + "TotalEarned")}</small><b>{isk(earnedIsk)}</b>
          </div>
        {/if}
      </div>
    </section>
  {/if}
  {#if g.description}<section><h3>{word("UI/Common/Description")}</h3><p>{g.description}</p></section>{/if}
  <section><h3>{word(G + "CreatedOn", { dateString: date(g.created) })}</h3>
    <div class="cp-creator"><span><small>{word(G + "Creator")}</small><b>{nameAny("owner", g.creator)}</b></span><span>{nameAny("owner", $station.online?.corporationID ?? 0)}</span></div>
  </section>
</div>

<style>
  .cp-overlay-head { padding-top: 8px; min-height: 32px; }
  .cp-ghost { background: none; border: 1px solid rgba(255, 255, 255, 0.2); }
  .cp-details { flex: 1; min-height: 0; overflow: auto; padding-top: 16px; display: flex; flex-direction: column; }
  .cp-details h2 { margin: 24px 0 0; font-size: 20px; }
  .cp-details h3 { margin: 16px 0 8px; font-size: 14px; }
  .cp-job-head { position: relative; overflow: hidden; display: flex; flex-direction: column; gap: 4px; padding: 16px; background: rgba(0, 0, 0, 0.5); }
  .cp-flair { position: absolute; left: -175px; top: -175px; width: 400px; height: 400px; opacity: 0.25; pointer-events: none; }
  .cp-method { opacity: 0.65; position: relative; }
  .cp-claim { align-self: flex-start; margin-top: 16px; position: relative; }
  .cp-claim.done { background: rgba(95, 184, 95, 0.35); border-color: #5fb85f; }
  .cp-progress { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 500px)); gap: 8px 16px; min-height: 100px; }
  .cp-overview { display: flex; gap: 16px; align-items: flex-start; }
  .cp-overview div { display: flex; flex-direction: column; gap: 2px; }
  .cp-gauge { border-radius: 50%; background: conic-gradient(var(--line) var(--outer), rgba(255, 255, 255, 0.1) 0); display: flex; align-items: center; justify-content: center; }
  .cp-gauge span { border-radius: 50%; background: radial-gradient(#111 55%, transparent 56%), conic-gradient(#fff var(--inner), rgba(255, 255, 255, 0.05) 0); }
  .cp-gauge-big { width: 80px; height: 80px; flex: none; }
  .cp-gauge-big span { width: 64px; height: 64px; }
  .cp-dim { opacity: 0.65; }
  .cp-reward { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
  .cp-creator { display: flex; gap: 32px; }
  .cp-creator span { display: flex; flex-direction: column; }
</style>
