<script lang="ts">
  // corporation/corp_ui_freelance.py CorpUIFreelanceProjects - freelanceprojects/client/ui/admin_browser.py
  // AdminBrowserContainer (Corporation > General > Freelance Projects, a project manager's): AdminSummaryBar
  // (RemainingIskInActiveJobs - the managed projects' available ISK; CorpWindowActiveJobs n / GetCreationLimits'
  // max_active_projects_per_corporation, MaxJobNumberTooltip), the top row (ActiveButton / History toggle 300 wide; on
  // the right the timespan combo on History, the quick filter, the career-path filter menu, the sort menu on Active -
  // ActiveFreelanceProjectsSortBy, default name), Active (the managed projects of the corporation that are active, as
  // job cards) and History (Name, ContributionMethod, Created, Ended, Resolution, Progress, Creator;
  // HistoryTab/NoProjectsFound), CreateNewButton at the bottom.
  // Create New: CorporationFreelanceForm.svelte (open_create_project_window).
  // The admin details (corp_ui_freelance.show_selected_details - AdminDetailsContainer in the panel's overlay, Back to
  // the browser): the title, Progress (the gauge, current / target, "n% <progress_description>"; RemainingISKReward and
  // the reward per unit by the method's reward_description), Participants (Participant, Corporation, Alliance,
  // TotalAmount, OfTargetValue, OfPersonalTargetValue where a per-participant limit is set, ISKPayout - the share of the
  // target times its ISK, State; a committed one's kick, KickConfirmation asked; NoParticipantsFound), the buttons
  // DuplicateProject (CloneProject) and CloseProject while active (ConfirmClosure asked). A History row's menu: Duplicate,
  // ViewAdminDetails, ViewParticipants, the creator; its double click ViewAdminDetails.
  // A card's click, a History row's double click and its ViewAdminDetails open the job board's page of the job
  // (Job.on_click / open_freelance_project - jobboard features/freelance_projects/page.FreelanceProjectPage, here an
  // overlay of this panel): the corporation, the career, the title; the top buttons for a project manager
  // (DuplicateProject, while active ViewParticipants - the admin details - and CloseProject); the state (Resigned,
  // Kicked, Completed where the pilot's part is done, Closed); the CTA buttons (FreelanceProjectJob.get_cta_buttons:
  // while active Resign - ConfirmResignation asked - for a committed pilot, else Commit, enabled by can_commit -
  // has_max_projects_active against get_my_jobs_commit_limit, the age restriction, capacity, the state, the target - its
  // hint CommitDescription / CommittedToMaxProjects / CommittedMaxParticipants / CommitAgeRestricted; ClaimValue
  // {rewardValue} for the unredeemed units while there are any, JumpThroughError where the redeem failed); the body -
  // ExpiresIn / Expired and EndDate, ActiveParticipants (red at capacity, IncludingYou) and TotalParticipants, the age
  // restrictions panel (before the progress where unmet, after the objectives where met), Progress (contributors, current
  // / target, "n% <progress_description>"; MaxProgressPerContribution or RemainingISKinJob; the reward per unit or the
  // multiplier), YourContribution where committed or contributed (personal progress / limit, AvailableToEarn,
  // TotalEarned), Objectives (ContributionMethod; a delivery's item types and locations), Description, CreatedOn with
  // the creator and the corporation. Commit / Resign / Claim errors are shown under the buttons
  // (Errors/Commit|Resign/<error>).
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
  // GetStatusRequest after 5 s; a failure is GenericDeliveryError. Not here: the job board window itself (browse,
  // tracking), ViewMoreForCorporation, the closest solar system chip, the fanfare animation.
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, FreelanceDeliverable, FreelanceJob, FreelanceMethod, FreelanceProject } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import CorporationFreelanceForm from "./CorporationFreelanceForm.svelte";
  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const F = "UI/Corporations/FreelanceProjects/", G = "UI/Corporations/Goals/";
  const DB = "UI/Corporations/DeliverItem/DeliveryBox/", DE = "UI/Corporations/DeliverItem/Errors/";
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].map((m) => `/Carbon/UI/Common/MonthsWithYear/${m}`);
  const STATE_LABELS = ["StateUnspecified", "StateActive", "StateClosed", "StateCompleted", "StateExpired"].map((k) => G + k);
  const LABELS = [F + "RemainingIskInActiveJobs", F + "CorpWindowActiveJobs", F + "MaxJobNumberTooltip", F + "ActiveButton", F + "CreateProject/CreateNewButton",
    F + "HistoryTab/NoProjectsFound", G + "ContributionMethod", G + "Created", G + "Ended", G + "Resolution", G + "Progress", G + "DateCreated", G + "DateCreatedReversed",
    G + "ProgressReversed", G + "NumJumps", G + "NumJumpsReversed", ...STATE_LABELS, ...MONTHS, "UI/Common/History", "UI/Wallet/WalletWindow/Last30Days", "UI/Inventory/Filter",
    "UI/Common/SortBy", "UI/Common/Name", "UI/Inventory/NameReversed", "UI/Common/TimeRemainingFilter", "UI/Common/TimeRemainingReversedFilter", "UI/Common/Any",
    "Character/CareerPaths/CareerPath", "UI/Calendar/EventWindow/Creator", "UI/Common/ISK", "UI/Util/UnitPrefixThousandShort", "UI/Util/UnitPrefixMillionShort",
    "UI/Util/UnitPrefixBillionShort", "UI/Util/UnitPrefixTrillionShort", "UI/FreelanceProjects/DuplicateProject", "UI/Corporations/FreelanceProjects/CloneProject",
    "UI/Corporations/Goals/ViewAdminDetails", "UI/Corporations/FreelanceProjects/ViewParticipants", "UI/Corporations/FreelanceProjects/CloseProject", "UI/Commands/Back",
    "UI/Corporations/Goals/Progress", "UI/Corporations/Goals/Participants", "UI/Corporations/Goals/RemainingISKReward", "UI/Corporations/FreelanceProjects/Dialogs/ConfirmClosureHeader",
    "UI/Corporations/FreelanceProjects/Dialogs/ConfirmClosureBody", "UI/FreelanceProjects/ParticipantError",
    ...["Participant", "Corporation", "Alliance", "TotalAmount", "OfTargetValue", "OfPersonalTargetValue", "ISKPayout", "State", "NoParticipantsFound", "ParticipantsKickHint",
      "KickConfirmationTitle", "KickConfirmationBody", "ParticipantHint", "CorporationHint", "AllianceHint", "TotalAmountHint", "OfTargetValueHint", "OfPersonalTargetValueHint",
      "ISKPayoutHint", "StateHint"].map((k) => `UI/Corporations/FreelanceProjects/ParticipantsTab/${k}`),
    ...["Unspecified", "Committed", "Kicked", "Resigned"].map((k) => `UI/FreelanceProjects/ParticipantState/${k}`),
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
  const K = "UI/Corporations/FreelanceProjects/ParticipantsTab/";
  // ui/const STATE_DEFINITIONS: the participation states' labels and colours.
  const PSTATES: readonly [string, string][] = [["Unspecified", "#d4534f"], ["Committed", "#5fb85f"], ["Kicked", "#d4534f"], ["Resigned", "#e0913a"]];
  // eveformat currency.isk.
  const isk = (v: number) => `${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${word("UI/Common/ISK") || "ISK"}`;
  const nameAny = (k: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, k, id, "");
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: nameAny }));
  // eveformat number_readable_short with ISK (as the Projects summary).
  function iskShort(value: number): string {
    const v = value === 0 ? 0 : Number(value.toPrecision(3)), k = v === 0 ? 0 : Math.max(0, Math.min(4, Math.floor(Math.log10(Math.abs(v)) / 3)));
    const scaled = v / 1000 ** k;
    let places = 0;
    for (let i = 0; i < 2; i++) if (Math.round(scaled * 10 ** (2 - i)) % 10 > 0) { places = 2 - i; break; }
    const prefix = ["", "UI/Util/UnitPrefixThousandShort", "UI/Util/UnitPrefixMillionShort", "UI/Util/UnitPrefixBillionShort", "UI/Util/UnitPrefixTrillionShort"][k]!;
    return `${scaled.toLocaleString("en-US", { minimumFractionDigits: places, maximumFractionDigits: places })}${prefix ? word(prefix) : ""} ${word("UI/Common/ISK") || "ISK"}`;
  }
  const FLAIR: Record<number, string> = { 4: "explorer", 5: "industrialist", 6: "enforcer", 7: "sof" };
  const flair = (c: number | null) => clientTexture(`res:/UI/Texture/Shared/CareerPaths/${(c !== null && FLAIR[c]) || "unclassified"}_flair.png`);
  let careerNames = $state<Record<number, number>>({});
  onMount(() => {
    flow.requestWords(LABELS);
    void flow.freelanceCreation().then((d) => { methods = d.methods; flow.requestWords(d.methods.flatMap((m) => [m.title, m.description, m.progressDescription, m.rewardDescription, m.delivery?.itemTitle, m.delivery?.itemDescription, m.delivery?.locationTitle, m.delivery?.locationDescription]).filter(Boolean).map((n) => `#${n}`)); }, () => {});
    void flow.certifiedSkillPlans().then((r) => { if (r) careerNames = Object.fromEntries(r.careerPaths.filter((c) => c.nameID !== null).map((c) => [c.careerPathID, c.nameID!])); }, () => {});
  });

  let creating = $state<{ original: FreelanceProject | null } | null>(null);
  // The contribution methods' definitions, for the method's name, progress and reward words.
  let methods = $state<readonly FreelanceMethod[]>([]);
  const methodOf = (p: FreelanceProject) => methods.find((m) => m.name === p.method) ?? null;
  const msg = (id: number | undefined) => (id ? word(`#${id}`) : "");
  // The admin details overlay.
  let details = $state<FreelanceProject | null>(null), people = $state<readonly { characterID: number; progress: number; state: number }[] | null>(null);
  let affiliation = $state<Record<number, { corp: number | null; alliance: number | null }>>({}), busy = $state(false), notice = $state("");
  async function openDetails(p: FreelanceProject): Promise<void> {
    details = p; people = null; notice = "";
    const read = await flow.freelanceParticipants(p.projectID);
    if (details?.projectID !== p.projectID) return;
    people = read;
    for (const x of read ?? []) {
      if (affiliation[x.characterID]) continue;
      const corp = await flow.characterCorporation(x.characterID).catch(() => null);
      const alliance = corp ? await flow.corporationAlliance(corp).catch(() => null) : null;
      flow.requestNames([corp, alliance].filter((id): id is number => Boolean(id)).map((id) => ({ kind: "owner" as const, id })));
      affiliation = { ...affiliation, [x.characterID]: { corp, alliance } };
    }
  }
  async function kick(p: FreelanceProject, characterID: number): Promise<void> {
    const ok = await flow.askClientWarning(word(K + "KickConfirmationTitle"), word(K + "KickConfirmationBody", { character_id: characterID, project_name: p.name }) || "Kick?");
    if (!ok) return;
    busy = true;
    try { const e = await flow.freelanceManagerAction("kick", p.projectID, characterID); notice = e ? word(e.label) || e.label : ""; await openDetails(p); } finally { busy = false; }
  }
  async function closeProject(p: FreelanceProject): Promise<void> {
    const body = word("UI/Corporations/FreelanceProjects/Dialogs/ConfirmClosureBody", { project_name: p.name });
    if (!(await flow.askClientWarning(word("UI/Corporations/FreelanceProjects/Dialogs/ConfirmClosureHeader"), body || "Close?"))) return;
    busy = true;
    try {
      const e = await flow.freelanceManagerAction("close", p.projectID);
      if (e) { notice = word(e.label) || e.label; return; }
      // freelance_signals.on_closed: the details close.
      details = null; await load();
    } finally { busy = false; }
  }
  let rowMenu = $state<{ p: FreelanceProject; x: number; y: number } | null>(null);
  let page = $state<"active" | "history">("active"), filterText = $state(""), monthsSince = $state<number | null>(null);
  let read = $state<Awaited<ReturnType<AppFlow["corporationFreelanceProjects"]>> | null>(null), loading = $state(true);
  let career = $state<number | null>(null), menu = $state<"filter" | "sort" | null>(null);
  let sortBy = $state((() => { try { return localStorage.getItem("evejs.play.ActiveFreelanceProjectsSortBy") ?? "name"; } catch { return "name"; } })());
  function setSort(v: string): void { sortBy = v; menu = null; try { localStorage.setItem("evejs.play.ActiveFreelanceProjectsSortBy", v); } catch { /* the session keeps it */ } }
  async function load(): Promise<void> { loading = true; try { read = await flow.corporationFreelanceProjects(monthsSince); } finally { loading = false; } }
  $effect(() => { void monthsSince; void load(); });
  // FreelanceProjectsRepository._register_to_notices: a project created, closed, completed, expired or progressed, a
  // participant added, removed, kicked, contributing or redeeming - the managed projects (and an open details'
  // participants) are read again; on_closed / on_expired close the details of that project.
  // svelte-ignore state_referenced_locally
  const notices = flow.gatewayNotices;
  const FREELANCE_NOTICES = /^eve_public\.freelance\.project\.api\.(Created|Closed|Completed|Expired|Progressed|Participant(Added|Removed|Kicked|Contributed|RewardRedeemed))Notice$/;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const n = $notices;
    if (!n || !FREELANCE_NOTICES.test(n.typeName)) return;
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      void load().then(() => {
        const open = details;
        if (!open) return;
        const now = [...(read?.active ?? []), ...(read?.inactive ?? [])].find((x) => x.projectID === open.projectID);
        if (now && now.state !== 1 && open.state === 1) details = null; else if (now) { details = now; void openDetails(now); }
      });
    }, 500);
  });
  // The job board's page (FreelanceProjectPage, FreelanceProjectJob).
  let job = $state<FreelanceJob | null>(null), jobNotice = $state(""), claimFailed = $state(false);
  async function openJob(p: FreelanceProject): Promise<void> {
    jobNotice = ""; claimFailed = false;
    const j = await flow.freelanceJob(p.projectID);
    if (!j) { void openDetails(p); return; }
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
    } finally { busy = false; }
  }
  // Project.available_amount: remaining_personal_progress x isk_per_unit.
  const remaining = (p: FreelanceProject) => Math.max(0, p.target - p.current);
  const available = (p: FreelanceProject) => (p.contributionLimit ? Math.min(remaining(p), Math.max(0, p.contributionLimit - p.myProgress)) : remaining(p)) * p.iskPerUnit;
  const ratio = (p: FreelanceProject) => (p.target ? p.current / p.target : 0);
  const active = $derived((read?.active ?? []).filter((p) => p.state === 1));
  function filtered(list: readonly FreelanceProject[]): FreelanceProject[] {
    let out = [...list];
    if (filterText) out = out.filter((p) => p.name.toLowerCase().includes(filterText.toLowerCase()));
    if (career !== null) out = out.filter((p) => p.careerPath === career);
    return out;
  }
  function sorted(list: FreelanceProject[]): FreelanceProject[] {
    const by = <T,>(key: (p: FreelanceProject) => T, rev = false) => [...list].sort((a, b) => { const x = key(a), y = key(b); const c = x < y ? -1 : x > y ? 1 : 0; return rev ? -c : c; });
    switch (sortBy) {
      case "name": return by((p) => p.name.toLowerCase());
      case "name_reversed": return by((p) => p.name.toLowerCase(), true);
      case "date_created": return by((p) => p.created);
      case "date_created_reversed": return by((p) => p.created, true);
      case "progress": return by((p) => ratio(p));
      case "progress_reversed": return by((p) => ratio(p), true);
      case "time_remaining": return by((p) => p.deadline ?? 0);
      case "time_remaining_reversed": return by((p) => [p.deadline === null ? 1 : 0, p.deadline ?? 0].join(":"), true);
      default: return list;
    }
  }
  const cards = $derived(sorted(filtered(active)));
  const history = $derived(filtered(read?.inactive ?? []));
  const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const timespans = $derived.by(() => { const n = new Date(); return [{ value: "", label: word("UI/Wallet/WalletWindow/Last30Days") }, ...[1, 2, 3, 4, 5].map((i) => { const d = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - i, 1)); return { value: String(i), label: word(MONTHS[d.getUTCMonth()]!, { year: d.getUTCFullYear() }) }; })]; });
  const SORTS: readonly (readonly [string, string])[][] = [[["name", "UI/Common/Name"], ["name_reversed", "UI/Inventory/NameReversed"]], [["date_created", G + "DateCreated"], ["date_created_reversed", G + "DateCreatedReversed"]],
    [["time_remaining", "UI/Common/TimeRemainingFilter"], ["time_remaining_reversed", "UI/Common/TimeRemainingReversedFilter"]], [["progress", G + "Progress"], ["progress_reversed", G + "ProgressReversed"]],
    [["num_jumps", G + "NumJumps"], ["num_jumps_reversed", G + "NumJumpsReversed"]]];
  const remainingIsk = $derived(active.reduce((n, p) => n + available(p), 0));
</script>

<div class="fp">
  <div class="fp-summary">
    <div class="fp-stat"><b>{iskShort(remainingIsk)}</b><span>{word(F + "RemainingIskInActiveJobs")}</span></div>
    <div class="fp-stat" title={word(F + "MaxJobNumberTooltip", { maxNum: read?.maxActive ?? 0 })}><b>{active.length}{#if read?.maxActive}<small>/{read.maxActive}</small>{/if}</b><span>{word(F + "CorpWindowActiveJobs")}</span></div>
  </div>
  <div class="fp-top">
    <div class="fp-toggle">
      <button class:active={page === "active"} onclick={() => { page = "active"; filterText = ""; }}>{word(F + "ActiveButton")}</button>
      <button class:active={page === "history"} onclick={() => { page = "history"; filterText = ""; }}>{word("UI/Common/History")}</button>
    </div>
    <span class="fp-gap"></span>
    {#if page === "active"}<button class="fp-icon" title={word("UI/Common/SortBy")} onclick={() => { menu = menu === "sort" ? null : "sort"; }}>⇅</button>{/if}
    <button class="fp-icon" class:on={career !== null} title={word("UI/Inventory/Filter")} onclick={() => { menu = menu === "filter" ? null : "filter"; }}>⏷</button>
    <input class="fp-filter" type="search" bind:value={filterText} />
    {#if page === "history"}
      <select value={monthsSince === null ? "" : String(monthsSince)} onchange={(e) => { monthsSince = e.currentTarget.value ? Number(e.currentTarget.value) : null; }}>
        {#each timespans as t (t.value)}<option value={t.value}>{t.label}</option>{/each}
      </select>
    {/if}
    {#if menu === "sort"}
      <div class="fp-menu"><div class="fp-caption">{word("UI/Common/SortBy")}</div>
        {#each SORTS as group, gi (gi)}{#if gi}<hr />{/if}{#each group as [value, label] (value)}<button onclick={() => setSort(value)}>{sortBy === value ? "◉" : "○"} {word(label)}</button>{/each}{/each}</div>
    {:else if menu === "filter"}
      <div class="fp-menu"><div class="fp-caption">{word("Character/CareerPaths/CareerPath")}</div>
        <button onclick={() => { career = null; }}>{career === null ? "◉" : "○"} {word("UI/Common/Any")}</button>
        {#each [4, 5, 6, 7] as c (c)}<button onclick={() => { career = c; }}>{career === c ? "◉" : "○"} {careerNames[c] ? word(`#${careerNames[c]}`) : FLAIR[c]}</button>{/each}</div>
    {/if}
  </div>
  <div class="fp-panels">
    {#if loading && !read}<p class="fp-hint">…</p>
    {:else if page === "active"}
      {#if !cards.length}<p class="fp-hint">{word(F + "HistoryTab/NoProjectsFound")}</p>
      {:else}
        <div class="fp-cards">
          {#each cards as p (p.projectID)}
            <div class="fp-card" title={p.description} role="button" tabindex="-1" onclick={() => void openJob(p)} onkeydown={() => {}}>
              <img class="fp-flair" src={flair(p.careerPath)} alt="" />
              <div class="fp-card-top"><span class="fp-dim">{p.careerPath !== null && careerNames[p.careerPath] ? word(`#${careerNames[p.careerPath]}`) : ""}</span>
                <span class="fp-gauge" style:--outer={`${Math.min(1, ratio(p)) * 360}deg`}><span></span></span></div>
              <div class="fp-card-title">{p.name}</div>
              <div class="fp-card-bottom">{#if p.iskPerUnit}<span>¤ {iskShort(remaining(p) * p.iskPerUnit)}</span>{/if}{#if p.deadline}<span class="fp-dim">{date(p.deadline)}</span>{/if}</div>
            </div>
          {/each}
        </div>
      {/if}
    {:else}
      <div class="fp-row fp-head"><span>{word("UI/Common/Name")}</span><span>{word(G + "ContributionMethod")}</span><span>{word(G + "Created")}</span><span>{word(G + "Ended")}</span>
        <span>{word(G + "Resolution")}</span><span>{word(G + "Progress")}</span><span>{word("UI/Calendar/EventWindow/Creator")}</span></div>
      {#each history as p (p.projectID)}
        <div class="fp-row" role="row" tabindex="-1" ondblclick={() => void openJob(p)} oncontextmenu={(e) => { e.preventDefault(); rowMenu = { p, x: e.offsetX, y: (e.currentTarget as HTMLElement).offsetTop + e.offsetY }; }}><span>{p.name}</span><span>{msg(methodOf(p)?.title) || "-"}</span><span>{date(p.created)}</span><span>{p.finished ? date(p.finished) : "-"}</span>
          <span style:color={p.state === 3 ? "#5fb85f" : "#d4534f"}>{word(STATE_LABELS[p.state] ?? STATE_LABELS[0]!)}</span><span>{(ratio(p) * 100).toFixed(0)}%</span><span>{nameAny("owner", p.creator)}</span></div>
      {:else}<p class="fp-hint">{word(F + "HistoryTab/NoProjectsFound")}</p>{/each}
    {/if}
  </div>
  {#if rowMenu}
    {@const m = rowMenu}
    <div class="fp-menu fp-rowmenu" style:left={`${m.x}px`} style:top={`${m.y + 80}px`} role="menu" tabindex="-1" onmouseleave={() => { rowMenu = null; }}>
      <button title={word("UI/Corporations/FreelanceProjects/CloneProject")} onclick={() => { creating = { original: m.p }; rowMenu = null; }}>⧉ {word("UI/FreelanceProjects/DuplicateProject")}</button>
      <button onclick={() => { void openJob(m.p); rowMenu = null; }}>{word("UI/Corporations/Goals/ViewAdminDetails")}</button>
      <button onclick={() => { void openDetails(m.p); rowMenu = null; }}>{word("UI/Corporations/FreelanceProjects/ViewParticipants")}</button>
      <hr /><span class="fp-dim">{nameAny("owner", m.p.creator)}</span>
    </div>
  {/if}
  {#if details}
    {@const p = details}
    {@const m = methodOf(p)}
    {@const limited = Boolean(p.contributionLimit)}
    <div class="fp-overlay">
      <div><button class="fp-ghost" onclick={() => { details = null; }}>{word("UI/Commands/Back")}</button></div>
      <h2>{p.name}</h2>
      <section><h3>{word("UI/Corporations/Goals/Progress")}</h3>
        <div class="fp-progress">
          <div class="fp-overview"><span class="fp-gauge fp-gauge-big" style:--outer={`${Math.min(1, ratio(p)) * 360}deg`}><span></span></span>
            <div><b>{p.current.toLocaleString("en-US")}</b><small>/ {p.target.toLocaleString("en-US")}</small><small>{(ratio(p) * 100).toFixed(0)}% <span class="fp-dim">{msg(m?.progressDescription)}</span></small></div></div>
          {#if p.iskPerUnit}<div class="fp-reward"><small>{word("UI/Corporations/Goals/RemainingISKReward")}</small><b>{isk(remaining(p) * p.iskPerUnit)}</b><small>{msg(m?.rewardDescription)}</small><b>{isk(p.iskPerUnit)}</b></div>{/if}
        </div>
      </section>
      <section class="fp-people"><h3>{word("UI/Corporations/Goals/Participants")}{#if people === null && details}<span class="fp-dim" title={word("UI/FreelanceProjects/ParticipantError")}> …</span>{/if}</h3>
        <div class="fp-prow fp-head" class:limited>
          {#each ["Participant", "Corporation", "Alliance", "TotalAmount", "OfTargetValue", ...(limited ? ["OfPersonalTargetValue"] : []), "ISKPayout", "State"] as k (k)}<span title={word(K + k + "Hint")}>{word(K + k)}</span>{/each}<span></span></div>
        {#each people ?? [] as x (x.characterID)}
          {@const a = affiliation[x.characterID]}
          <div class="fp-prow" class:limited><span>{nameAny("owner", x.characterID)}</span><span>{a?.corp ? nameAny("owner", a.corp) : ""}</span><span>{a?.alliance ? nameAny("owner", a.alliance) : "-"}</span>
            <span>{x.progress}</span><span>{(p.target ? (x.progress / p.target) * 100 : 0).toFixed(1)}%</span>{#if limited}<span>{((x.progress / (p.contributionLimit || 1)) * 100).toFixed(1)}%</span>{/if}
            <span>{isk(p.target ? (x.progress / p.target) * p.target * p.iskPerUnit : 0)}</span><span style:color={PSTATES[x.state]?.[1] ?? PSTATES[0]![1]}>{word(`UI/FreelanceProjects/ParticipantState/${PSTATES[x.state]?.[0] ?? "Unspecified"}`)}</span>
            <button class="fp-ghost" title={word(K + "ParticipantsKickHint")} disabled={x.state !== 1 || busy} onclick={() => void kick(p, x.characterID)}>✕</button></div>
        {:else}{#if people}<p class="fp-hint">{word(K + "NoParticipantsFound")}</p>{/if}{/each}
      </section>
      {#if notice}<p class="fp-notice">{notice}</p>{/if}
      <div class="fp-buttons fp-end">
        <button class="fp-ghost" title={word("UI/Corporations/FreelanceProjects/CloneProject")} onclick={() => { creating = { original: p }; }}>⧉ {word("UI/FreelanceProjects/DuplicateProject")}</button>
        {#if p.state === 1}<button class="fp-ghost" disabled={busy} onclick={() => void closeProject(p)}>✕ {word("UI/Corporations/FreelanceProjects/CloseProject")}</button>{/if}
      </div>
    </div>
  {/if}
  {#if job && !details}
    {@const j = job}
    {@const p = j.project}
    {@const m = methodOf(p)}
    {@const st = stateInfo(j)}
    {@const mine = j.participation === 1 || p.myProgress > 0}
    {@const ageRestricted = p.minAge !== null || p.maxAge !== null}
    {@const personalLimit = p.contributionLimit || p.target}
    <div class="fp-overlay fp-job">
      <div class="fp-job-top"><button class="fp-ghost" onclick={() => { job = null; }}>{word("UI/Commands/Back")}</button>
        <span class="fp-dim">{p.careerPath !== null && careerNames[p.careerPath] ? word(`#${careerNames[p.careerPath]}`) : ""}</span><span class="fp-gap"></span>
        <button class="fp-ghost" title={word("UI/FreelanceProjects/DuplicateProject")} onclick={() => { creating = { original: p }; }}>⧉</button>
        {#if p.state === 1}
          <button class="fp-ghost" title={word("UI/Corporations/FreelanceProjects/ViewParticipants")} onclick={() => { job = null; void openDetails(p); }}>☰</button>
          <button class="fp-ghost" title={word(G + "CloseProject")} disabled={busy} onclick={() => void closeProject(p).then(() => { if (!details) job = null; })}>✕</button>
        {/if}</div>
      <div class="fp-job-head"><h2>{p.name}</h2><b>{nameAny("owner", j.corporationID)}</b></div>
      {#if st}<div style:color={st.color}>{st.text}</div>{/if}
      <div class="fp-buttons fp-cta">
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
  <div class="fp-buttons"><button onclick={() => { creating = { original: null }; }}>{word(F + "CreateProject/CreateNewButton")}</button></div>
  {#if creating}<CorporationFreelanceForm {store} {flow} original={creating.original} onClose={(made) => { creating = null; if (made) { details = null; void load(); } }} />{/if}
</div>

<style>
  .fp { position: relative; display: flex; flex-direction: column; height: 100%; padding: 0 8px 8px; box-sizing: border-box; }
  .fp-summary { height: 48px; margin-top: 8px; display: flex; gap: 32px; flex: none; }
  .fp-stat { min-width: 120px; display: flex; flex-direction: column; padding-left: 20px; border-left: 2px solid rgba(255, 255, 255, 0.3); }
  .fp-stat b { font-size: 20px; line-height: 24px; }
  .fp-stat small, .fp-stat span, .fp-dim { opacity: 0.65; }
  .fp-top { position: relative; height: 32px; margin-top: 8px; display: flex; gap: 8px; align-items: center; flex: none; }
  .fp-toggle { width: 300px; display: flex; }
  .fp-toggle button { flex: 1; }
  .fp-toggle button.active { background: rgba(255, 255, 255, 0.15); }
  .fp-gap { flex: 1; }
  .fp-filter { width: 120px; }
  .fp-icon { all: unset; cursor: pointer; width: 24px; text-align: center; opacity: 0.8; }
  .fp-icon.on { color: var(--theme-focus, #58a6dc); }
  .fp-menu { position: absolute; right: 0; top: 34px; z-index: 5; min-width: 220px; display: flex; flex-direction: column; gap: 2px; padding: 6px; background: #1b1d21; border: 1px solid rgba(255, 255, 255, 0.15); }
  .fp-menu button { all: unset; cursor: pointer; padding: 2px 4px; }
  .fp-caption { font-size: 11px; opacity: 0.65; }
  .fp-panels { flex: 1; min-height: 0; overflow: auto; margin-top: 16px; }
  .fp-hint { text-align: center; opacity: 0.65; }
  .fp-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 550px)); gap: 16px; }
  .fp-card { position: relative; height: 186px; display: flex; flex-direction: column; padding: 16px; box-sizing: border-box; overflow: hidden; border-left: 2px solid var(--theme-focus, #58a6dc); background: rgba(0, 0, 0, 0.6); border-radius: 0 8px 8px 0; }
  .fp-flair { position: absolute; left: -175px; top: -175px; width: 400px; height: 400px; opacity: 0.35; pointer-events: none; }
  .fp-card-top { position: relative; display: flex; justify-content: space-between; height: 50px; }
  .fp-gauge { width: 50px; height: 50px; border-radius: 50%; background: conic-gradient(var(--theme-focus, #58a6dc) var(--outer), rgba(255, 255, 255, 0.1) 0); display: flex; align-items: center; justify-content: center; }
  .fp-gauge span { width: 38px; height: 38px; border-radius: 50%; background: #111; }
  .fp-card-title { position: relative; flex: 1; font-size: 16px; font-weight: bold; padding-top: 8px; }
  .fp-card-bottom { position: relative; height: 24px; display: flex; justify-content: space-between; align-items: center; border-radius: 8px; background: rgba(255, 255, 255, 0.05); padding: 0 8px; }
  .fp-row { display: grid; grid-template-columns: 2fr 1.4fr 1fr 1fr 1fr 0.7fr 1.2fr; gap: 6px; min-height: 24px; align-items: center; padding: 0 4px; }
  .fp-head { font-size: 11px; opacity: 0.65; border-bottom: 1px solid rgba(255, 255, 255, 0.1); }
  .fp-buttons { display: flex; justify-content: center; padding-top: 8px; }
  .fp-card, .fp-row:not(.fp-head) { cursor: pointer; }
  .fp-rowmenu { right: auto; }
  .fp-rowmenu hr { width: 100%; opacity: 0.2; }
  .fp-overlay { position: absolute; inset: 0; z-index: 6; overflow: auto; padding: 8px 16px; background: #15171a; display: flex; flex-direction: column; gap: 8px; }
  .fp-overlay h2 { margin: 16px 0 0; }
  .fp-overlay h3 { font-size: 13px; margin: 16px 0 8px; opacity: 0.9; }
  .fp-ghost { all: unset; cursor: pointer; padding: 2px 8px; opacity: 0.85; }
  .fp-ghost:disabled { opacity: 0.3; cursor: default; }
  .fp-progress { display: flex; gap: 16px; flex-wrap: wrap; }
  .fp-overview { display: flex; gap: 16px; align-items: center; min-width: 240px; }
  .fp-overview > div, .fp-reward { display: flex; flex-direction: column; }
  .fp-gauge-big { width: 80px; height: 80px; }
  .fp-gauge-big span { width: 68px; height: 68px; }
  .fp-reward { margin-left: auto; text-align: right; }
  .fp-prow { display: grid; grid-template-columns: 1.4fr 1.4fr 1.2fr 0.8fr 0.8fr 1.1fr 0.9fr 24px; gap: 6px; min-height: 28px; align-items: center; padding: 0 4px; }
  .fp-prow.limited { grid-template-columns: 1.4fr 1.4fr 1.2fr 0.8fr 0.8fr 0.8fr 1.1fr 0.9fr 24px; }
  .fp-notice { color: #d4534f; }
  .fp-end { justify-content: flex-end; gap: 8px; }
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
  .fp-job .fp-gauge-big span { font-size: 11px; opacity: 0.8; }
</style>
