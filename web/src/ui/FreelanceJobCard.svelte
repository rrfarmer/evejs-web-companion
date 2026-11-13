<script lang="ts">
  // jobboard features/freelance_projects/card - a freelance job's card, as the job board's pages and Show Info's
  // Freelance Projects tab (FreelanceJobProviderSection) draw it: the corporation, the progress % (the overall gauge,
  // the pilot's part inside), the title, the ISK still to earn (available_amount) or, on Unclaimed Rewards, ClaimValue,
  // YouAreAParticipant where committed, the deadline; TrackJobIconButton (Track / Untrack, while trackable or tracked)
  // shown on hover, and always while tracked. Its click opens the job's page.
  import type { ClientStore } from "../store/clientStore.ts";
  import type { FreelanceJob } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { isFreelanceJobTracked, toggleTrackedFreelanceJob, trackedJobsChanged } from "./jobTracking.ts";
  let { store, job, claim = false, onOpen }: { store: ClientStore; job: FreelanceJob; claim?: boolean; onOpen: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const nameAny = (k: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, k, id, "");
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: nameAny }));
  const isk = (v: number) => `${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${word("UI/Common/ISK") || "ISK"}`;
  const left = (j: FreelanceJob) => { const p = j.project, r = Math.max(0, p.target - p.current); return (p.contributionLimit ? Math.min(r, Math.max(0, p.contributionLimit - p.myProgress)) : r) * p.iskPerUnit; };
  const p = $derived(job.project);
  const pct = $derived(p.target ? p.current / p.target : 0);
  const mine = $derived((p.contributionLimit || p.target) ? p.myProgress / (p.contributionLimit || p.target) : 0);
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const me = $derived($station.online?.characterID ?? null);
  const tracked = $derived.by(() => { void $trackedJobsChanged; return isFreelanceJobTracked(me, p.projectID); });
  const trackable = $derived(p.state === 1 && job.participation === 1);
</script>

<div class="jb-card" role="button" tabindex="-1" onclick={onOpen} onkeydown={() => {}}>
  <div class="jb-card-top"><span class="jb-dim">{nameAny("owner", job.corporationID)}</span>
    <span class="jb-gauge" style:--outer={`${Math.min(1, pct) * 360}deg`} style:--inner={`${Math.min(1, mine) * 360}deg`}><span>{Math.floor(pct * 100)}%</span></span></div>
  <div class="jb-title">{p.name}</div>
  <div class="jb-bottom">
    {#if claim}<span class="gold">{word("UI/Corporations/Goals/ClaimValue", { rewardValue: isk(job.unredeemed * p.iskPerUnit) })}</span>
    {:else}<span>¤ {isk(left(job))}</span>{/if}
    {#if job.participation === 1}<span class="jb-dim" title={word("UI/Corporations/FreelanceProjects/YouAreAParticipant")}>✔</span>{/if}
    {#if p.deadline}<span class="jb-dim">{new Date(p.deadline).toISOString().slice(0, 10)}</span>{/if}
    {#if trackable || tracked}<button class="jb-track" class:on={tracked} title={word(tracked ? "UI/Common/Untrack" : "UI/Common/Track")}
      onclick={(e) => { e.stopPropagation(); toggleTrackedFreelanceJob(me, p.projectID); }}>{tracked ? "⊘" : "👁"}</button>{/if}
  </div>
</div>

<style>
  .gold { color: #d4aa3c; }
  .jb-card { cursor: pointer; height: 150px; display: flex; flex-direction: column; padding: 12px; box-sizing: border-box; border-left: 2px solid var(--theme-focus, #58a6dc); background: rgba(0, 0, 0, 0.6); border-radius: 0 8px 8px 0; }
  .jb-card-top { display: flex; justify-content: space-between; }
  .jb-dim { opacity: 0.65; }
  .jb-gauge { width: 40px; height: 40px; border-radius: 50%; background: conic-gradient(var(--theme-focus, #58a6dc) var(--outer), rgba(255, 255, 255, 0.1) 0); display: flex; align-items: center; justify-content: center; }
  .jb-gauge span { width: 30px; height: 30px; border-radius: 50%; background: conic-gradient(#d4aa3c var(--inner), #111 0); display: flex; align-items: center; justify-content: center; font-size: 10px; }
  .jb-title { flex: 1; font-weight: bold; padding-top: 6px; }
  .jb-track { all: unset; cursor: pointer; opacity: 0; padding: 0 4px; }
  .jb-card:hover .jb-track, .jb-track.on { opacity: 1; }
  .jb-bottom { display: flex; gap: 8px; justify-content: space-between; align-items: center; padding: 2px 8px; border-radius: 8px; background: rgba(255, 255, 255, 0.05); }
</style>
