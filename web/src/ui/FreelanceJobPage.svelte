<script lang="ts">
  // jobboard features/freelance_projects/page.FreelanceProjectPage - a freelance job as the job board shows it: the
  // corporation, the career, the title; the top buttons for a project manager (DuplicateProject, while active
  // ViewParticipants and CloseProject - here where the opener gives them); the state (Resigned, Kicked, Completed
  // where the pilot's part is done, Closed); the CTA buttons (FreelanceProjectJob.get_cta_buttons: while active Resign -
  // ConfirmResignation asked - for a committed pilot, else Commit, enabled by can_commit - has_max_projects_active
  // against get_my_jobs_commit_limit, the age restriction, capacity, the state, the target - its hint
  // CommitDescription / CommittedToMaxProjects / CommittedMaxParticipants / CommitAgeRestricted; ClaimValue
  // {rewardValue} for the unredeemed units while there are any, JumpThroughError where the redeem failed); the body -
  // ExpiresIn / Expired and EndDate, ActiveParticipants (red at capacity, IncludingYou) and TotalParticipants, the age
  // restrictions panel (before the progress where unmet, after the objectives where met), Progress (contributors,
  // current / target, "n% <progress_description>"; MaxProgressPerContribution or RemainingISKinJob; the reward per unit
  // or the multiplier), YourContribution where committed or contributed (personal progress / limit, AvailableToEarn,
  // TotalEarned), Objectives (ContributionMethod; a delivery's item types and locations), Description, CreatedOn with
  // the creator and the corporation. Commit / Resign / Claim errors are shown under the buttons
  // (Errors/Commit|Resign/<error>). Opened from the corporation's Freelance Jobs (CorporationFreelance.svelte) and the
  // job board window (JobBoardWindow.svelte).
  // The dropbox (jobboard ui/dropbox.DropboxContainer, a committed pilot's on an active delivery job): not at a delivery
  // location (is_at_delivery_location: docked at one of the job's stations) DeliveryBoxNotDockedTitle with
  // DeliveryBoxNotDocked; there DeliveryBoxReady with DeliveryBoxDragTip, here over the pilot's items of the job's types
  // and groups in the hangar and the ship's delivery holds (the inventory window is the drag source in the client),
  // dragged onto the box or clicked; OnDropData's checks in order (DragErrorNotOwned, ALL_ALLOWED_FLAGS,
  // DragErrorInvalidItem with get_invalid_type_error, the personal limit - DragErrorPersonalProgressExceeded -, the
  // stack against remaining_personal_progress - DragErrorTooManyItems {remaining_count} with its tip -,
  // DragErrorCurrentShip) as CustomWarning OK; then the item primed (its name and count, DeliveryBoxTurnIn, Cancel and
  // DeliveryBoxButton); Deliver runs validate_delivery (ProjectInactive, NotCommited, QuantityTooHigh,
  // ErrorItemSingletonShip / Other, ItemMissing, StackChanged - the item read again) and deliver_item: DeliverRequest,
  // GetStatusRequest after 5 s; a failure is GenericDeliveryError. ViewMoreForCorporation (get_buttons, always, last;
  // open_corporation_window): the corporation's Show Info on its Freelance Projects tab. The CTA row starts with
  // TrackJobButton (details_page._construct_cta_buttons; shown while is_trackable - active and committed - or tracked:
  // Untrack, NORMAL, where tracked, else Track, GHOST); a commit tracks the job and a resign untracks it
  // (_on_participation_state_changed), and one that is no longer active is untracked (_on_state_changed). Not here:
  // the closest solar system chip, the fanfare animation.
  import { onMount } from "svelte";
  import { showCorporationInfoTab, TAB_FREELANCE_PROJECTS } from "./showInfo.ts";
  import { isFreelanceJobTracked, toggleTrackedFreelanceJob, trackedJobsChanged, trackFreelanceJob, untrackFreelanceJob } from "./jobTracking.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, FreelanceDeliverable, FreelanceJob, FreelanceMethod, FreelanceProject } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  let { store, flow, projectID, methods: given, onBack, onDuplicate, onViewParticipants, onCloseJob, onChanged }: {
    store: ClientStore; flow: AppFlow; projectID: string; methods?: readonly FreelanceMethod[]; onBack?: () => void;
    onDuplicate?: (p: FreelanceProject) => void; onViewParticipants?: (p: FreelanceProject) => void; onCloseJob?: (p: FreelanceProject) => Promise<void>;
    onChanged?: () => void;
  } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const F = "UI/Corporations/FreelanceProjects/", G = "UI/Corporations/Goals/";
  const DB = "UI/Corporations/DeliverItem/DeliveryBox/", DE = "UI/Corporations/DeliverItem/Errors/";
  const LABELS = ["UI/Common/Track", "UI/Common/Untrack", "UI/Commands/Back", "UI/Common/ISK", "UI/FreelanceProjects/ViewMoreForCorporation", "UI/FreelanceProjects/DuplicateProject", "UI/Corporations/FreelanceProjects/ViewParticipants", G + "Progress", G + "ContributionMethod",
    "UI/FreelanceProjects/Commit", "UI/FreelanceProjects/Resign", "UI/Corporations/Goals/ClaimValue", "UI/Inflight/JumpThroughError", "UI/FreelanceProjects/Resigned", "UI/FreelanceProjects/Kicked",
    "UI/Generic/Completed", "UI/Generic/Closed", "UI/Generic/Expired", "UI/Generic/ExpiresIn", "UI/ScienceAndIndustry/ScienceAndIndustryWindow/EndDate", "UI/FreelanceProjects/ActiveParticipants",
    "UI/FreelanceProjects/IncludingYou", "UI/FreelanceProjects/TotalParticipants", "UI/FreelanceProjects/ParticipantsInfoTooltip", "UI/FreelanceProjects/Contributors",
    F + "OverAllProgressTooltip", F + "MaxProgressPerContribution", F + "RemainingISKinJob", G + "YourContribution", G + "AvailableToEarn", G + "TotalEarned", G + "CreatedOn", G + "Creator",
    G + "CloseProject", "UI/Agents/StandardMission/Objectives", "UI/Common/Description", "UI/FreelanceProjects/AgeRestrictionMetHeader", "UI/FreelanceProjects/AgeRestrictionNotMetHeader",
    "UI/FreelanceProjects/AgeRestrictionBodyMinAndMaxAge", "UI/FreelanceProjects/AgeRestrictionBodyMinSpecified", "UI/FreelanceProjects/AgeRestrictionBodyMaxSpecified",
    ...["ResignButtonTooltip", "CommitDescription", "CommittedToMaxProjects", "CommittedMaxParticipants", "CommitAgeRestricted", "FreelanceParticipationLimitExplanationTooltip"].map((k) => F + "DetailsWindow/" + k),
    F + "Dialogs/ConfirmResignationHeader", F + "Dialogs/ConfirmResignationBody", F + "Dialogs/ConfirmResignationAgeRestrictionBody",
    ...["DeliveryBoxReady", "DeliveryBoxNotDocked", "DeliveryBoxNotDockedTitle", "DeliveryBoxDragTip", "DeliveryBoxTurnIn", "DeliveryBoxButton"].map((k) => DB + k), "UI/Generic/Cancel",
    ...["NotOwnedHeader", "NotOwnedBody", "InvalidItemHeader", "InvalidItemBody", "PersonalProgressExceededHeader", "PersonalProgressExceededBody", "TooManyItemsHeader", "TooManyItemsBody",
      "TooManyItemsTip", "CurrentShipHeader", "CurrentShipBody"].map((k) => DE + "DragErrors/DragError" + k), DE + "DragErrorInvalidItemGroupBody",
    ...["ProjectInactive", "NotCommited", "QuantityTooHigh", "GenericDelivery", "ItemMissing"].flatMap((k) => [DE + "Delivery/" + k + "ErrorTitle", DE + "Delivery/" + k + "Error"]),
    DE + "Delivery/StackChangedErrorTitle", DE + "Delivery/StackChangedErrorBody", DE + "ErrorItemSingletonShip", DE + "ErrorItemSingletonOther", "#503976", "#529260"];
  const isk = (v: number) => `${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${word("UI/Common/ISK") || "ISK"}`;
  const nameAny = (k: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, k, id, "");
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: nameAny }));
  const msg = (id: number | undefined) => (id ? word(`#${id}`) : "");
  const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const remaining = (p: FreelanceProject) => Math.max(0, p.target - p.current);
  const ratio = (p: FreelanceProject) => (p.target ? p.current / p.target : 0);
  let loaded = $state<readonly FreelanceMethod[]>([]);
  const methods = $derived(given && given.length ? given : loaded);
  const methodOf = (p: FreelanceProject) => methods.find((m) => m.name === p.method) ?? null;
  let careerNames = $state<Record<number, number>>({});
  onMount(() => {
    flow.requestWords(LABELS);
    if (!given?.length) void flow.freelanceCreation().then((d) => { loaded = d.methods; flow.requestWords(d.methods.flatMap((m) => [m.title, m.description, m.progressDescription, m.rewardDescription, m.delivery?.itemTitle, m.delivery?.itemDescription, m.delivery?.locationTitle, m.delivery?.locationDescription]).filter(Boolean).map((n) => `#${n}`)); }, () => {});
    void flow.certifiedSkillPlans().then((r) => { if (r) careerNames = Object.fromEntries(r.careerPaths.filter((c) => c.nameID !== null).map((c) => [c.careerPathID, c.nameID!])); }, () => {});
  });
  $effect(() => { void openJob(projectID); });
  let job = $state<FreelanceJob | null>(null), jobNotice = $state(""), claimFailed = $state(false), busy = $state(false), missing = $state(false);
  async function openJob(id: string): Promise<void> {
    jobNotice = ""; claimFailed = false;
    const j = await flow.freelanceJob(id);
    if (!j) { missing = true; return; }
    job = j;
    primed = null;
    void loadDeliverables();
    flow.requestNames([...j.project.itemTypes.map((id) => ({ kind: "type" as const, id })), ...j.project.itemGroups.map((id) => ({ kind: "group" as const, id })), ...j.project.deliveryStations.map((id) => ({ kind: "station" as const, id }))]);
  }
  // validation.check_age_restrictions.
  function meetsAge(j: FreelanceJob): boolean {
    const { minAge, maxAge } = j.project;
    if (minAge === null && maxAge === null) return true;
    const age = j.ageDays ?? 0;
    if (!minAge) return (maxAge ?? 0) >= age;
    if (!maxAge) return age >= minAge;
    return minAge <= age && age <= maxAge;
  }
  const atCapacity = (j: FreelanceJob) => j.project.maxCommitted !== null && j.project.participants === j.project.maxCommitted;
  // validation.check_can_commit's order: the age, capacity, already committed, the state, the target reached.
  function commitBlock(j: FreelanceJob): string | null {
    if (!meetsAge(j)) return "age";
    if (atCapacity(j)) return "capacity";
    if (j.participation === 1 || j.project.state !== 1 || j.project.current === j.project.target) return "other";
    return null;
  }
  function commitHint(j: FreelanceJob): string {
    const D = F + "DetailsWindow/";
    if (j.atMaxProjects) return word(D + "CommittedToMaxProjects");
    const b = commitBlock(j);
    return word(b === "capacity" ? D + "CommittedMaxParticipants" : b === "age" ? D + "CommitAgeRestricted" : D + "CommitDescription");
  }
  const personalRemaining = (j: FreelanceJob) => (j.project.contributionLimit ? Math.min(remaining(j.project), Math.max(0, j.project.contributionLimit - j.project.myProgress)) : remaining(j.project));
  function stateInfo(j: FreelanceJob): { text: string; color: string } | null {
    if (j.participation === 3) return { text: word("UI/FreelanceProjects/Resigned"), color: "#e0913a" };
    if (j.participation === 2) return { text: word("UI/FreelanceProjects/Kicked"), color: "#d4534f" };
    if (j.project.myProgress && personalRemaining(j) === 0) return { text: word("UI/Generic/Completed"), color: "#5fb85f" };
    if (j.project.state === 2) return { text: word("UI/Generic/Closed"), color: "#e0913a" };
    return null;
  }
  function ageText(j: FreelanceJob): string {
    const { minAge, maxAge } = j.project, n = (v: number) => v.toLocaleString("en-US");
    if (minAge && maxAge) return word("UI/FreelanceProjects/AgeRestrictionBodyMinAndMaxAge", { min_age: n(minAge), max_age: n(maxAge) });
    if (minAge) return word("UI/FreelanceProjects/AgeRestrictionBodyMinSpecified", { min_age: n(minAge) });
    if (maxAge) return word("UI/FreelanceProjects/AgeRestrictionBodyMaxSpecified", { max_age: n(maxAge) });
    return "";
  }
  // The dropbox.
  let deliverables = $state<Awaited<ReturnType<AppFlow["freelanceDeliverables"]>>>(null), primed = $state<FreelanceDeliverable | null>(null), delivering = $state(false);
  async function loadDeliverables(): Promise<void> { deliverables = await flow.freelanceDeliverables(); }
  // dropbox ALL_ALLOWED_FLAGS: TOP_LEVEL_FLAGS (hangar, ship hangar, deliveries), cargoHoldsValidForDeliveryService,
  // unlocked and none.
  const ALLOWED_FLAGS = new Set([4, 90, 173, 64, 0, 5, 133, 134, 135, 136, 143, 148, 149, 154, 155, 174, 176, 177, 181, 182, 183, 185, 188]);
  const atLocation = (p: FreelanceProject) => Boolean(deliverables?.stationID && p.deliveryStations.includes(deliverables.stationID));
  // validate_item_type: each of the job's specifications (types, groups) holds the item's.
  const typeOk = (p: FreelanceProject, it: FreelanceDeliverable) => (!p.itemTypes.length || p.itemTypes.includes(it.typeID)) && (!p.itemGroups.length || (it.groupID !== null && p.itemGroups.includes(it.groupID))) && (p.itemTypes.length > 0 || p.itemGroups.length > 0);
  function warn(header: string, warning: string): void {
    flow.sayDialog("CustomWarning", { type: "dict", entries: [["header", header], ["warning", warning]] } as never, warning || header);
  }
  // DropboxContainer.OnDropData.
  function dropItem(j: FreelanceJob, it: FreelanceDeliverable): void {
    const p = j.project, D = DE + "DragErrors/DragError";
    if (!atLocation(p)) return;
    const me = store.station.get().online?.characterID ?? null;
    if (it.ownerID !== null && me !== null && it.ownerID !== me) { warn(word(D + "NotOwnedHeader"), word(D + "NotOwnedBody")); return; }
    if (!ALLOWED_FLAGS.has(it.flagID)) return;
    if (!typeOk(p, it)) {
      const body = p.itemTypes.length ? word(D + "InvalidItemBody", { target_item: nameAny("type", p.itemTypes[0]!) }) : p.itemGroups.length ? word(DE + "DragErrorInvalidItemGroupBody", { target_group: nameAny("group", p.itemGroups[0]!), target_item: "" }) : "";
      warn(word(D + "InvalidItemHeader"), body); return;
    }
    if (p.contributionLimit && personalRemaining(j) <= 0) { warn(word(D + "PersonalProgressExceededHeader"), word(D + "PersonalProgressExceededBody")); return; }
    if (it.quantity > personalRemaining(j)) { warn(word(D + "TooManyItemsHeader"), `${word(D + "TooManyItemsBody", { remaining_count: personalRemaining(j) })}<br><br><color=0xff808080>${word(D + "TooManyItemsTip")}</color>`); return; }
    if (it.itemID === deliverables?.shipID) { warn(word(D + "CurrentShipHeader"), word(D + "CurrentShipBody")); return; }
    primed = it;
  }
  // _on_submit_pressed: validate_delivery, then deliver_item.
  async function deliver(j: FreelanceJob): Promise<void> {
    const it = primed, X = DE + "Delivery/";
    if (!it || delivering) return;
    const say = (k: string, body = "Error") => warn(word(X + k + "ErrorTitle"), word(X + k + body));
    if (j.project.state !== 1) { say("ProjectInactive"); return; }
    if (j.participation !== 1) { say("NotCommited"); return; }
    if (it.quantity > personalRemaining(j)) { say("QuantityTooHigh"); return; }
    if (it.singleton && it.categoryID === 6) { warn(word(X + "GenericDeliveryErrorTitle"), word(DE + "ErrorItemSingletonShip")); return; }
    if (it.singleton) { warn(word(X + "GenericDeliveryErrorTitle"), word(DE + "ErrorItemSingletonOther")); return; }
    await loadDeliverables();
    const now = deliverables?.items.find((x) => x.itemID === it.itemID);
    if (!now || now.flagID !== it.flagID || now.locationID !== it.locationID) { warn(word(X + "ItemMissingErrorTitle"), word(X + "ItemMissingError")); return; }
    if (now.quantity !== it.quantity) { warn(word(X + "StackChangedErrorTitle"), word(X + "StackChangedErrorBody")); return; }
    delivering = true;
    try {
      const r = await flow.deliverToFreelanceJob(j.project.projectID, it);
      if (!r) { say("GenericDelivery"); return; }
      primed = null;
      const again = await flow.freelanceJob(j.project.projectID);
      if (again && job?.project.projectID === again.project.projectID) job = again;
      await loadDeliverables();
    } finally { delivering = false; }
  }
  const DRAG = "application/x-freelance-item";
  async function jobAct(kind: "commit" | "resign" | "redeem"): Promise<void> {
    const j = job;
    if (!j || busy) return;
    if (kind === "resign") {
      const body = F + "Dialogs/" + (meetsAge(j) ? "ConfirmResignationBody" : "ConfirmResignationAgeRestrictionBody");
      if (!(await flow.askClientWarning(word(F + "Dialogs/ConfirmResignationHeader"), word(body) || "Resign?"))) return;
    }
    busy = true; jobNotice = "";
    try {
      const [e] = await Promise.all([flow.freelanceJobAction(kind, j.project.projectID), new Promise((r) => setTimeout(r, 1500))]);
      if (e && kind === "redeem") claimFailed = true;
      else if (e) { flow.requestWords([e.label]); jobNotice = e.label; }
      const again = await flow.freelanceJob(j.project.projectID);
      if (again && job?.project.projectID === again.project.projectID) job = again;
      if (again && kind !== "redeem") {
        const me = store.station.get().online?.characterID ?? null;
        if (again.participation === 1) trackFreelanceJob(me, again.project.projectID); else untrackFreelanceJob(me, again.project.projectID);
      }
    } finally { busy = false; }
  }
  // svelte-ignore state_referenced_locally
  const stationForTracking = store.station;
  const me = $derived($stationForTracking.online?.characterID ?? null);
  const tracked = $derived.by(() => { void $trackedJobsChanged; return job ? isFreelanceJobTracked(me, job.project.projectID) : false; });
  // _on_state_changed: a tracked job no longer trackable is untracked.
  $effect(() => { if (job && tracked && job.project.state !== 1) untrackFreelanceJob(me, job.project.projectID); });
</script>

  {#if missing}<p class="fp-hint">…</p>
  {:else if job}
    {@const j = job}
    {@const p = j.project}
    {@const m = methodOf(p)}
    {@const st = stateInfo(j)}
    {@const mine = j.participation === 1 || p.myProgress > 0}
    {@const ageRestricted = p.minAge !== null || p.maxAge !== null}
    {@const personalLimit = p.contributionLimit || p.target}
    <div class="fp-job">
      <div class="fp-job-top">{#if onBack}<button class="fp-ghost" onclick={() => onBack?.()}>{word("UI/Commands/Back")}</button>{/if}
        <span class="fp-dim">{p.careerPath !== null && careerNames[p.careerPath] ? word(`#${careerNames[p.careerPath]}`) : ""}</span><span class="fp-gap"></span>
        {#if onDuplicate}<button class="fp-ghost" title={word("UI/FreelanceProjects/DuplicateProject")} onclick={() => onDuplicate?.(p)}>⧉</button>{/if}
        {#if p.state === 1 && onViewParticipants}<button class="fp-ghost" title={word("UI/Corporations/FreelanceProjects/ViewParticipants")} onclick={() => onViewParticipants?.(p)}>☰</button>{/if}
        {#if p.state === 1 && onCloseJob}<button class="fp-ghost" title={word(G + "CloseProject")} disabled={busy} onclick={() => void onCloseJob?.(p)}>✕</button>{/if}
        <button class="fp-ghost" title={word("UI/FreelanceProjects/ViewMoreForCorporation")} onclick={() => showCorporationInfoTab(j.corporationID, TAB_FREELANCE_PROJECTS)}>⧉↗</button></div>
      <div class="fp-job-head"><h2>{p.name}</h2><b>{nameAny("owner", j.corporationID)}</b></div>
      {#if st}<div style:color={st.color}>{st.text}</div>{/if}
      <div class="fp-buttons fp-cta">
        {#if (p.state === 1 && j.participation === 1) || tracked}
          <button class:fp-ghost={!tracked} onclick={() => toggleTrackedFreelanceJob(me, p.projectID)}>{tracked ? "⊘" : "👁"} {word(tracked ? "UI/Common/Untrack" : "UI/Common/Track")}</button>
        {/if}
        {#if p.state === 1}
          {#if j.participation === 1}<button class="fp-ghost" title={word(F + "DetailsWindow/ResignButtonTooltip")} disabled={busy} onclick={() => void jobAct("resign")}>{word("UI/FreelanceProjects/Resign")}</button>
          {:else}<button title={commitHint(j)} disabled={busy || j.atMaxProjects || commitBlock(j) !== null} onclick={() => void jobAct("commit")}>{word("UI/FreelanceProjects/Commit")}</button>{/if}
        {/if}
        {#if j.unredeemed > 0}
          <button class="fp-claim" disabled={busy || claimFailed} onclick={() => void jobAct("redeem")}>{claimFailed ? word("UI/Inflight/JumpThroughError") : word(G + "ClaimValue", { rewardValue: isk(j.unredeemed * p.iskPerUnit) })}</button>
        {/if}
      </div>
      {#if jobNotice}<p class="fp-notice">{word(jobNotice) || jobNotice}</p>{/if}
      {#if m?.delivery && j.participation === 1 && p.state === 1}
        {@const here = atLocation(p)}
        <div class="fp-dropbox" class:inactive={!here} role="region" ondragover={(e) => { if (here && e.dataTransfer?.types.includes(DRAG)) e.preventDefault(); }}
          ondrop={(e) => { const id = Number(e.dataTransfer?.getData(DRAG) || NaN); const it = deliverables?.items.find((x) => x.itemID === id); if (it) { e.preventDefault(); dropItem(j, it); } }}>
          {#if primed && here}
            <div class="fp-primed"><span>{nameAny("type", primed.typeID) || primed.typeID}</span><b>{primed.quantity.toLocaleString("en-US")}</b>
              <span class="fp-gap"></span><button class="fp-ghost" disabled={delivering} onclick={() => { primed = null; }}>{word("UI/Generic/Cancel")}</button>
              <button disabled={delivering} onclick={() => void deliver(j)}>{delivering ? "…" : word(DB + "DeliveryBoxButton")}</button></div>
          {:else}<b class="fp-dim">{word(here ? DB + "DeliveryBoxReady" : DB + "DeliveryBoxNotDockedTitle")}</b>{/if}
          <small class="fp-banner">{word(!here ? DB + "DeliveryBoxNotDocked" : primed ? DB + "DeliveryBoxTurnIn" : DB + "DeliveryBoxDragTip")}</small>
          {#if here && !primed}
            <div class="fp-items">{#each (deliverables?.items ?? []).filter((it) => typeOk(p, it) && ALLOWED_FLAGS.has(it.flagID)) as it (it.itemID)}
              <button draggable="true" ondragstart={(e) => { e.dataTransfer?.setData(DRAG, String(it.itemID)); }} onclick={() => dropItem(j, it)}>{nameAny("type", it.typeID) || it.typeID} × {it.quantity.toLocaleString("en-US")}</button>{/each}</div>
          {/if}
        </div>
      {/if}
      <div class="fp-dim">{#if p.state === 1}{#if p.deadline && p.deadline > Date.now()}{word("UI/Generic/ExpiresIn", { color: "", remaining: { type: "long", value: String(BigInt(Math.max(0, p.deadline - Date.now())) * 10000n) } })}{:else}{word("UI/Generic/Expired")}{/if} | {/if}{word("UI/ScienceAndIndustry/ScienceAndIndustryWindow/EndDate")} {(p.deadline ?? p.finished) ? date((p.deadline ?? p.finished)!) : "-"}</div>
      <div class="fp-strip" title={word("UI/FreelanceProjects/ParticipantsInfoTooltip")}>
        <span><b style:color={atCapacity(j) ? "#d4534f" : ""}>{p.participants}</b> {word("UI/FreelanceProjects/ActiveParticipants")}{#if j.participation === 1} <small>{word("UI/FreelanceProjects/IncludingYou")}</small>{/if}</span>
        <span><b>{j.totalParticipants}</b> {word("UI/FreelanceProjects/TotalParticipants")}</span></div>
      {#if !meetsAge(j)}<div class="fp-age bad"><b>{word("UI/FreelanceProjects/AgeRestrictionNotMetHeader")}</b><span>{ageText(j)}</span></div>{/if}
      <section><h3 title={word(F + "OverAllProgressTooltip", { amount_of_contributors: p.contributors.toLocaleString("en-US"), contribution_percentage: `${(ratio(p) * 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}%` })}>{word(G + "Progress")}</h3>
        <div class="fp-progress">
          <div class="fp-overview"><span class="fp-gauge fp-gauge-big" style:--outer={`${Math.min(1, ratio(p)) * 360}deg`} title={word("UI/FreelanceProjects/Contributors")}><span>👥 {p.contributors}</span></span>
            <div><b>{p.current.toLocaleString("en-US")}</b><small>/ {p.target.toLocaleString("en-US")}</small><small>{Math.floor(ratio(p) * 100)}% <span class="fp-dim">{msg(m?.progressDescription)}</span></small></div></div>
          <div class="fp-reward">
            {#if m?.maxProgress && p.maxProgress}<small>{word(F + "MaxProgressPerContribution")}</small><b>{p.maxProgress.toLocaleString("en-US")}</b>
            {:else}<small>{word(F + "RemainingISKinJob")}</small><b>{isk(remaining(p) * p.iskPerUnit)}</b>{/if}
            <small>{msg(m?.rewardDescription)}</small><b>{m?.multiplier && p.multiplier ? `${Math.round(p.multiplier * 100)}%` : isk(p.iskPerUnit)}</b></div>
        </div>
      </section>
      {#if mine}
        <section><h3 title={p.contributionLimit ? word(F + "DetailsWindow/FreelanceParticipationLimitExplanationTooltip") : ""}>{word(G + "YourContribution")}</h3>
          <div class="fp-progress">
            <div class="fp-overview"><span class="fp-gauge fp-gauge-big" style:--outer={`${Math.min(1, p.myProgress / (personalLimit || 1)) * 360}deg`}><span></span></span>
              <div><b>{p.myProgress.toLocaleString("en-US")}</b><small>/ {personalLimit.toLocaleString("en-US")}</small><small>{Math.floor((p.myProgress / (personalLimit || 1)) * 100)}% <span class="fp-dim">{msg(m?.progressDescription)}</span></small></div></div>
            <div class="fp-reward"><small>{word(G + "AvailableToEarn")}</small><b>{isk(personalRemaining(j) * p.iskPerUnit)}</b><small>{word(G + "TotalEarned")}</small><b>{isk(p.myProgress * p.iskPerUnit)}</b></div>
          </div>
        </section>
      {/if}
      <section><h3>{word("UI/Agents/StandardMission/Objectives")}</h3>
        <div class="fp-attr" title={msg(m?.description)}><small>{word(G + "ContributionMethod")}</small><span>{msg(m?.title) || p.method}</span></div>
        {#if m?.delivery}
          <div class="fp-attr" title={msg(m.delivery.itemDescription)}><small>{msg(m.delivery.itemTitle)}</small><span>{[...p.itemTypes.map((t) => nameAny("type", t) || String(t)), ...p.itemGroups.map((g) => nameAny("group", g) || String(g))].join(", ")}</span></div>
          <div class="fp-attr" title={msg(m.delivery.locationDescription)}><small>{msg(m.delivery.locationTitle)}</small><span>{p.deliveryStations.map((sid) => nameAny("station", sid) || String(sid)).join(", ")}</span></div>
        {/if}
      </section>
      {#if meetsAge(j) && ageRestricted}<div class="fp-age"><b>{word("UI/FreelanceProjects/AgeRestrictionMetHeader")}</b><span>{ageText(j)}</span></div>{/if}
      {#if p.description}<section><h3>{word("UI/Common/Description")}</h3><p>{p.description}</p></section>{/if}
      <section><h3>{word(G + "CreatedOn", { dateString: date(p.created) })}</h3>
        <div class="fp-strip"><span><small>{word(G + "Creator")}</small> {nameAny("owner", p.creator)}</span><span>{nameAny("owner", j.corporationID)}</span></div></section>
    </div>
  {/if}

<style>
  .fp-job { display: flex; flex-direction: column; gap: 8px; padding: 8px 16px; }
  .fp-job h2 { margin: 16px 0 0; }
  .fp-job h3 { font-size: 13px; margin: 16px 0 8px; opacity: 0.9; }
  .fp-dim { opacity: 0.65; }
  .fp-hint { text-align: center; opacity: 0.65; }
  .fp-gap { flex: 1; }
  .fp-ghost { all: unset; cursor: pointer; padding: 2px 8px; opacity: 0.85; }
  .fp-ghost:disabled { opacity: 0.3; cursor: default; }
  .fp-buttons { display: flex; justify-content: center; padding-top: 8px; }
  .fp-notice { color: #d4534f; }
  .fp-progress { display: flex; gap: 16px; flex-wrap: wrap; }
  .fp-overview { display: flex; gap: 16px; align-items: center; min-width: 240px; }
  .fp-overview > div, .fp-reward { display: flex; flex-direction: column; }
  .fp-gauge { border-radius: 50%; background: conic-gradient(var(--theme-focus, #58a6dc) var(--outer), rgba(255, 255, 255, 0.1) 0); display: flex; align-items: center; justify-content: center; }
  .fp-gauge span { border-radius: 50%; background: #111; display: flex; align-items: center; justify-content: center; }
  .fp-gauge-big { width: 80px; height: 80px; }
  .fp-gauge-big span { width: 68px; height: 68px; font-size: 11px; opacity: 0.8; }
  .fp-reward { margin-left: auto; text-align: right; }
  .fp-dropbox { display: flex; flex-direction: column; gap: 6px; min-height: 120px; padding: 10px; border: 1px dashed var(--theme-focus, #58a6dc); border-radius: 8px; background: rgba(88, 166, 220, 0.08); }
  .fp-dropbox.inactive { border-color: rgba(255, 255, 255, 0.2); background: rgba(255, 255, 255, 0.03); }
  .fp-banner { opacity: 0.8; }
  .fp-items { display: flex; flex-wrap: wrap; gap: 6px; }
  .fp-items button { cursor: grab; }
  .fp-primed { display: flex; align-items: center; gap: 8px; }
  .fp-job-top { display: flex; align-items: center; gap: 4px; }
  .fp-job-head { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; }
  .fp-cta { justify-content: flex-start; gap: 8px; }
  .fp-claim { background: #2f5f2f; }
  .fp-strip { display: flex; gap: 32px; padding: 12px 8px; border-radius: 8px; background: rgba(255, 255, 255, 0.1); }
  .fp-age { display: flex; flex-direction: column; padding: 8px 16px; border-left: 6px solid #5fb85f; background: rgba(95, 184, 95, 0.15); }
  .fp-age b { color: #5fb85f; }
  .fp-age.bad { border-color: #d4534f; background: rgba(212, 83, 79, 0.15); }
  .fp-age.bad b { color: #d4534f; }
  .fp-attr { display: flex; flex-direction: column; padding-top: 8px; }
  .fp-attr small { opacity: 0.65; }
</style>
