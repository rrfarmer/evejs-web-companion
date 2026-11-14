<script lang="ts">
  // The client's Personal Plans (skillPlan/browser/personalPlansPanel.py), in the Skills window: the pilot's own skill
  // plans, read on the public gateway as the client reads them (flow.personalSkillPlans: GetAll, each plan by Get,
  // GetActive for the tracked one), sorted by name (SkillPlanScroll: localization.util.Sort).
  //
  // Each plan's entry is SkillPlanEntry's: its name; the time left to train it (GetTotalTrainingTimeLeftText:
  // FormatTimeIntervalShortWritten from the day, to the hour above a day, the minute above an hour, else the second),
  // or Completed, green, with the completed mark; the tracked mark (UpdateTrackedIcon), its hint Tracked Skill Plan;
  // and its menu's Delete (the client's DeleteSkillPlan question, then Delete). With none, the panel's hint "no
  // personal plans"; where the gateway could not be had, the client's connection error (_GetSkillPlans).
  //
  // A plan clicked opens (SkillPlanEntry.OnClick; selectedPlan/selectedSkillPlanContainer.py), in the list's place:
  // the caption Skill Plan and the plan's name (MilestoneIndicatorHeader), its close; Delete (its hint DeletePlan,
  // the same question) and Track (OnTrackButton, _ToggleTracked: SetActive with the plan, or with none where it is
  // tracked; its hint TrackPlanHint or UntrackPlanHint, its icon look_at or camera_untrack); Show and Hide Skill Plan
  // Contents; the Skill Plan Completed banner where the plan is completed; and the description. The contents
  // (contents/skillPlanContents.py): the caption, Hide Trained Skills (settings.char.ui SkillPlanContentsHideTrained,
  // on unless turned off), the filter on the skill's name, and each of the plan's skill levels in its order
  // (SkillPlanContentsSkillEntry): the skill bar for the level, "skill level" (RequiredSkillNameAndLevel) and the
  // level's training time, faint (GetTrainingTimeForLevelText: from the day to the minute); with none shown,
  // NoSkillsMatchingFilters.
  //
  // At its foot, hidden where the plan is completed (UpdateComponents), the locked panel (SkillPlanLockedCont): the
  // books button, its count of books missing in red where any are (its hint SkillbooksMissing, or
  // NoSkillbooksMissing), which shows the contents (onMissingSkillsButtonSignal); the omega button only where the plan
  // is omega locked (its hint OmegaMissing), with the lock. Then Start Training (UpdateStartTrainingButton): off where
  // the plan cannot be trained (StartTrainingLockedHint) or has nothing left to train
  // (StartTrainingNothingToTrainHint), else StartTrainingHint. It adds the plan's levels left to the queue and starts
  // it, then tracks the plan (at once where none is tracked; on the client's AskTrackPlan question where another is),
  // and says SkillsAddedNotification where levels were added (TrainSkills; the client's notice, said here in the view).
  //
  // The panel opens on Certified Plans (skillPlansBrowserPanel: Certified Plans, then Personal Plans; the choice kept).
  // Certified Plans (certifiedPlansPanel.py, bridge/certifiedSkillPlans.ts): the AIR plan alone until it is trained or
  // queued, the career paths locked (CareerPathsLockedByAIR); then the career paths in the client's table's order, hinted by
  // their descriptions (SelectCareerPathHint till one is chosen, the choice kept); the empire factions in factionByRace's
  // order, the pilot's own chosen with a career path, none for the Industrialist; and the chosen ones' plans, by name. A
  // certified plan opened has no Edit or Delete (IsEditable), is tracked as any plan, and has its table's milestones.
  //
  // Corporation Plans (corpPlansPanel.py, bridge/corpSkillPlans.ts), the third tab, only for a pilot in a player
  // corporation (IsPlayerCorporation): the corporation's plans (flow.corpSkillPlans); where there are any, the career
  // paths as category buttons (one chosen or none), NumShown and the filter on the name; twelve to a page by name, the
  // page buttons where there is more than one page; NoCorpSkillPlans or NoSkillPlansMatchingFilters with none shown.
  // A corporation plan opened (its caption CorpSkillPlan) has Edit and Delete, as its entry's menu has, only for a pilot
  // with corpRoleSkillPlanManager (IsEditable); the panel's Create (CreateCorpPlanButton, under the plans or the hint:
  // off without the role, CorpPlanCreateRequiresRoleHint, or at a hundred) and Edit open the editor with the plan's
  // Category; a save reads the panel again from its first page. It cannot be tracked (IsTrackable): Track (its hint
  // SaveAnTrackPlan) saves a
  // copy among the personal plans, opens it and tracks it (_CreateCopySelectAndTrack), and Start Training tracks such
  // a copy (_CheckSetCurrentSkillPlanAsTracked). Its milestones are the corporation's.
  //
  // Create (CreatePersonalPlanButton, under the plans or alone where there are none: off where there are ten,
  // MaximumSkillPlanReached; its tooltip CreatePersonalSkillPlan and PlansInTotal), the opened plan's Edit (its hint
  // EditPlan) and an entry's menu's Edit open the editor (SkillPlanEditor.svelte) in the list's place, on a new plan
  // or a copy of the plan; a save goes back to the list, read again (OnSkillPlanCreated, OnSkillPlanSaved).
  //
  // The contents' rows each have their level's button (SkillLevelEntryPrimaryButton, bridge/skillPlanLevelButton.ts):
  // omega, a book to buy, queued (out of the queue, or off where it may not come out), trained (off), or to queue with
  // what it needs; its hint the client's, add's with the points the level lacks and the pilot's points a minute. Under
  // the rows, Buy Missing Skillbooks with their count where any is not held (UpdateSkillsMissingBanner; its click
  // buy_missing_skills). After either, the contents are read again (OnSkillQueueChanged, OnSkillsAvailable).
  //
  // Each entry has its progress gauge (UpdateProgressGauge: the points trained white, the queued ones' cryo blue after
  // them, bridge/skillPlans.ts planProgressAt), drawn again each second with its time left while any plan shown has
  // levels queued (_UpdateTrainingTimeThread), and read again when the queue changes (OnSkillQueueChanged); and the
  // omega mark where the plan has a skill an alpha may not train and the pilot is alpha (CheckShowOmegaIndicator).
  // Hovered, an entry shows its tooltip (SkillPlanEntryTooltip, at the entry's right): Skill Plan, the description,
  // SkillbooksMissing2 with their count where any book is not held, and RequireOmega with the count of skills an alpha
  // may not train where the pilot is alpha.
  //
  // The opened plan's share button (MakeDragObject) is dragged into a chat's send box to give the plan's link
  // (bridge/skillPlanLink.ts: <a href="skillPlan:{id}:{owner}">{name}</a>). A link followed from a chat opens the plan
  // here (OpenSkillPlanWnd): one of the pilot's own as itself; another's by GetShared (flow.sharedSkillPlan) as a linked
  // plan, which has no Edit or Delete and is tracked by a copy (IsEditable, IsTrackable: its owner is not the pilot);
  // SkillPlanNotFound where it is had nowhere.
  //
  // The corporation's notices (another member's changes) come on the pilot's stream as the gateway sends them, and are
  // taken as the client's panels take them (corpNotice, below).
  //
  // Where the plan is omega locked the contents show Upgrade Clone State (UpdateOmegaBanner) above the books' button.
  // It, the omega level button and the locked panel's omega button open the clone upgrade window in the client (the
  // Omega upsell window, the store's); the page has no store, so they are off, and their hints say so.
  //
  // Not done: the links in a description shown in the tooltip (its LINKSTYLE_REGULAR label), Share, the clone upgrade
  // window (the store), the faction and career icons, a skill row's selection,
  // menu, tooltip and drag (its selection is done), the tooltip and drag of an entry, and a notice kept
  // while the session does not match it yet (the client's notice routing cache).
  import { onMount, tick, untrack } from "svelte";
  import { skillPlanTemplateTarget, type SkillPlanTemplate } from "./skillPlanTemplate.ts";
  import { portal } from "./portal.ts";
  import SkillPlanEditor from "./SkillPlanEditor.svelte";
  import { MAX_PERSONAL_PLANS, uuidFromBytes } from "../bridge/skillPlans.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { romanLevel } from "../bridge/skills.ts";
  import { shortWrittenInterval, SHORT_INTERVAL_WORD_LABELS } from "../bridge/timeInterval.ts";
  import { skillMenuEntries, type SkillMenuEntry } from "../bridge/skillMenu.ts";
  import type { SkillRowInfo } from "../bridge/skillPlans.ts";
  import { showInfo } from "./showInfo.ts";
  import SkillRowMenu from "./SkillRowMenu.svelte";
  import SkillRowTip from "./SkillRowTip.svelte";
  import { endSkillDrag, startSkillDrag } from "./skillDrag.ts";
  import {
    planProgressAt, planRowRequirement, requirementsClipboardText, skillPlanRowVisible, sortPlansByName, startTrainingState, timeLeftShowTo,
    type PersonalSkillPlanEntry, type PersonalSkillPlansRead, type SkillPlanContentRow, type SkillPlanDetail,
  } from "../bridge/skillPlans.ts";
  import { milestoneLastSkillIndex, type MilestoneEntry } from "../bridge/skillPlanMilestones.ts";
  import { LEVEL_BUTTON_HINTS, levelButtonOff, type LevelButtonState } from "../bridge/skillPlanLevelButton.ts";
  import { serveSkillPlanCareerRequest, skillPlanCareerRequests } from "./skillPlanCareerRequests.ts";
  import { CAREER_PATH_INDUSTRIALIST, PLAN_ID_AIR, certifiedPlanUuid, certifiedPlansShown, empireFactions } from "../bridge/certifiedSkillPlans.ts";
  import type { CertifiedPlanEntry, CorpPlanEntry, GatewayNotice, SkillPlanLinkFollowed } from "../app/flow.ts";
  import { LINK_DRAG_TYPE, skillPlanUrl } from "../bridge/skillPlanLink.ts";
  import { CORP_PLANS_PER_PAGE, MAX_CORP_PLANS, corpPlanPages, corpPlansFiltered, inPlayerCorporation } from "../bridge/corpSkillPlans.ts";
  import {
    CAREER_BUTTON,
    CAREER_HINT_LABELS,
    CIRCULAR_BUTTON,
    FACTION_HINT_LABELS,
    SKILL_PLAN_INFO_ICON,
    careerIcon,
    factionIcon,
  } from "./skillPlanIcons.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  /** A plan as it is opened: a personal one, a certified one (with its table's milestones) or a corporation's. */
  type OpenedPlan = PersonalSkillPlanEntry & {
    readonly certified?: true;
    readonly milestoneList?: CertifiedPlanEntry["milestoneList"];
    readonly corp?: CorpPlanEntry["corp"];
    readonly categoryID?: CorpPlanEntry["categoryID"];
    /** A certified plan's number (its link's id). */
    readonly planID?: number;
    /** A plan opened by its link that is none of the pilot's own (GetOwnedByOther): not editable, not trackable. */
    readonly linked?: true;
    /** A certified plan's career path and faction (GetCareerPathID, GetFactionID). */
    readonly careerPathID?: number | null;
    readonly factionID?: number | null;
  };

  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const skillsSheet = store.skills;

  /** The page's own words, where the install's are not to hand. */
  const OWN: Readonly<Record<string, string>> = {
    "UI/SkillPlan/PersonalPlans": "My own plans",
    "UI/SkillPlan/PersonalPlansHoverTooltip": "Plans you made or copied for yourself.",
    "UI/SkillPlan/NoPersonalSkillPlans": "You have made no skill plan of your own.",
    "UI/SkillPlan/ConnectionError": "Skill plans cannot be reached just now.",
    "UI/SkillPlan/Completed": "All trained",
    "UI/SkillPlan/TrackedSkillPlan": "The plan you are following",
    "UI/Common/Buttons/Delete": "Delete",
    "UI/SkillPlan/SkillPlan": "Plan",
    "UI/SkillPlan/DeletePlan": "Delete this plan for good.",
    "UI/SkillPlan/TrackPlanHint": "Follow this plan's progress.",
    "UI/SkillPlan/UntrackPlanHint": "Stop following this plan's progress.",
    "UI/SkillPlan/SkillPlanCompleted": "Every skill in this plan is trained",
    "UI/SkillPlan/ShowSkillPlanContents": "Show the skills",
    "UI/SkillPlan/HideSkillPlanContents": "Hide the skills",
    "UI/SkillPlan/SkillPlanOverview": "Its skills",
    "UI/SkillPlan/HideTrainedSkills": "Leave out those trained",
    "UI/CharacterSheet/CharacterSheetWindow/SkillTabs/NoSkillsMatchingFilters": "No skill shown with these filters",
    "UI/InfoWindow/RequiredSkillNameAndLevel": "{[item]skill.name} {level}",
    "UI/SkillPlan/StartTraining": "Train it",
    "UI/SkillPlan/StartTrainingHint": "Put as many of this plan's levels as fit into your training queue.",
    "UI/SkillPlan/StartTrainingLockedHint": "This plan cannot be trained yet: a book is missing, or it needs omega.",
    "UI/SkillPlan/StartTrainingNothingToTrainHint": "Every level of this plan is trained or queued already.",
    "UI/SkillPlan/SkillsAddedNotification": "{numSkills} put in the queue from {planName}.",
    "UI/SkillPlan/SkillbooksMissing": "{numMissing} books not held",
    "UI/SkillPlan/NoSkillbooksMissing": "Every book is held",
    "UI/SkillPlan/OmegaMissing": "{numMissing} of its skills need omega.",
    "UI/SkillPlan/CreateNewSkillPlan": "New plan",
    "UI/SkillPlan/CreatePersonalSkillPlan": "Make a plan of your own",
    "UI/SkillPlan/PlansInTotal": "Plans: {numPlans} of {numTotal}",
    "UI/SkillPlan/MaximumSkillPlanReached": "You have {numPlans} plans, as many as can be kept.",
    "UI/SkillPlan/EditPlan": "Change this plan",
    "UI/Neocom/Edit": "Edit",
    "UI/SkillPlan/Milestones": "Milestones",
    "UI/SkillPlan/SkillMilestonesDescText": "Points of the plan worth reaching on the way.",
    "UI/SkillPlan/MilestoneShip": "Ship",
    "UI/SkillPlan/MilestoneSkill": "Skill",
    "UI/SkillPlan/MilestoneModule": "Module",
    "UI/SkillPlan/MilestoneOther": "Other",
    "UI/SkillPlan/TotalTrainingTime": "Time to train:",
    "UI/SkillPlan/CertifiedPlans": "Ready-made plans",
    "UI/SkillPlan/CertifiedPlansHoverTooltip": "Plans made for each career path.",
    "UI/SkillPlan/SelectCareerPathHint": "Choose a career path",
    "UI/SkillPlan/CareerPathsLockedByAIR": "Finish the AIR plan to open the career paths.",
    // The opened plan's faction and career path icons' tooltips (selectedSkillPlanContainer.py LoadFactionTooltip,
    // LoadCareerTooltip: HINT_BY_FACTION_ID, HINT_BY_CAREER_ID).
    "UI/SkillPlan/SkillPlanFaction": "Faction",
    "UI/SkillPlan/SkillPlanCareerPath": "Career path",
    "UI/SkillPlan/SkillPlanFactionAmarr": "A plan for a pilot of the Amarr Empire.",
    "UI/SkillPlan/SkillPlanFactionGallente": "A plan for a pilot of the Gallente Federation.",
    "UI/SkillPlan/SkillPlanFactionMinmatar": "A plan for a pilot of the Minmatar Republic.",
    "UI/SkillPlan/SkillPlanFactionCaldari": "A plan for a pilot of the Caldari State.",
    "UI/SkillPlan/SkillPlanCareerPathEnforcer": "A plan for the Enforcer's path.",
    "UI/SkillPlan/SkillPlanCareerPathExplorer": "A plan for the Explorer's path.",
    "UI/SkillPlan/SkillPlanCareerPathIndustrial": "A plan for the Industrialist's path.",
    "UI/SkillPlan/SkillPlanCareerPathSoldier": "A plan for the Soldier of Fortune's path.",
    "UI/SkillPlan/CertifiedSkillPlan": "Ready-made plan",
    "UI/SkillPlan/SavePlan": "Keep a copy among your own plans",
    "UI/SkillPlan/CorpPlans": "My corporation's plans",
    "UI/SkillPlan/CorpPlansHoverTooltip": "Plans your corporation keeps for its members.",
    "UI/SkillPlan/NumShown": "{numShown} of {numTotal} shown",
    "UI/SkillPlan/CorpSkillPlan": "Corporation plan",
    "UI/SkillPlan/NoSkillPlansMatchingFilters": "No plan matches these filters.",
    "UI/SkillPlan/NoCorpSkillPlans": "Your corporation keeps no skill plan.",
    "UI/SkillPlan/SaveAnTrackPlan": "Keep a copy among your own plans, and follow that.",
    "UI/SkillPlan/CreateCorpSkillPlan": "Make a plan for your corporation",
    "UI/CloneState/RequiresOmegaClone": "Needs an omega clone",
    "UI/SkillPlan/SkillbooksMissing2": "Books not held",
    "UI/SkillPlan/RequireOmega": "Needs omega",
    "UI/CloneState/UpgradeCloneState": "Upgrade the clone",
    "UI/SkillPlan/CopySkillsToClipboard": "Copy the plan's skills",
    "UI/SkillPlan/SharePlan": "Drag this into a chat to give the plan's link",
    "UI/SkillPlan/ClickToBuyMissingSkillAndRequirements": "A book for this skill, or for one it needs, is not held: buy them.",
    "UI/SkillPlan/RemoveFromQueue": "This level is queued: take it out.",
    "UI/SkillPlan/RemoveFromQueueLocked": "This level is queued, and another queued skill needs it.",
    "UI/SkillPlan/AlreadyTrained": "This level is trained.",
    "UI/SkillPlan/AddToQueue": "Queue it to level {skillLevel}",
    "UI/Skills/SkillPointsRequired": "Points still needed",
    "UI/CharacterSheet/CharacterSheetWindow/SkillTabs/SpPerMinute": "{spPerMin} points a minute",
    "UI/SkillPlan/BuyMissingSkillbooks": "Buy the books not held ({numMissing})",
    "UI/SkillPlan/CorpPlanCreateRequiresRoleHint": "Making your corporation's plans needs its skill plan manager role.",
  };

  // The panels (skillPlansBrowserPanel's toggle buttons): Certified Plans, Personal Plans, and Corporation Plans for a
  // pilot in a player corporation; the choice kept (skillPlanUtil.GetPersistedPanelID, its default the certified one;
  // the certified one shown where the corporation's is kept and not had).
  const PANEL_KEY = "evejs.skillPlansPanel";
  type Panel = "certified" | "personal" | "corporation";
  function storedPanel(): Panel {
    try {
      const kept = localStorage.getItem(PANEL_KEY);
      return kept === "personal" || kept === "corporation" ? kept : "certified";
    } catch {
      return "certified";
    }
  }
  let panel = $state<Panel>(storedPanel());
  function choosePanel(next: Panel): void {
    panel = next;
    try {
      localStorage.setItem(PANEL_KEY, next);
    } catch {
      // Kept for this page only.
    }
  }

  // The Certified Plans panel (certifiedPlansPanel.py).
  let certified = $state<Awaited<ReturnType<AppFlow["certifiedSkillPlans"]>> | undefined>(undefined);
  const CAREER_KEY = "evejs.skillPlanCareerPathID";
  let careerPathID = $state<number | null>(null);
  let factionID = $state<number | null>(null);

  async function loadCertified(): Promise<void> {
    certified = await flow.certifiedSkillPlans().catch(() => null);
    // AutoSelectCareerPath: the career path kept, chosen again.
    if (certified && careerPathID === null) {
      try {
        const kept = Number(localStorage.getItem(CAREER_KEY));
        if (certified.careerPaths.some((career) => career.careerPathID === kept)) chooseCareer(kept);
      } catch {
        // None kept.
      }
    }
  }

  // SkillPlanDockablePanel.ShowCertifiedPlans(careerID), asked from the Career Portal (skillPlanCareerRequests): the
  // certified plans panel with that career path chosen.
  $effect(() => skillPlanCareerRequests.subscribe((asked) => {
    if (!asked) return;
    serveSkillPlanCareerRequest(asked.n);
    choosePanel("certified");
    try { localStorage.setItem(CAREER_KEY, String(asked.careerPathID)); } catch { /* chosen below where it can be */ }
    if (certified) chooseCareer(asked.careerPathID);
    else careerPathID = null;
  }));
  /** OnCareerPathTabGroup: the pilot's race's faction chosen with it; none for the Industrialist. */
  function chooseCareer(id: number): void {
    careerPathID = id;
    factionID = id === CAREER_PATH_INDUSTRIALIST ? null : certified?.raceFactionID ?? null;
    try {
      localStorage.setItem(CAREER_KEY, String(id));
    } catch {
      // Kept for this page only.
    }
  }

  /** A message by its number, in the install's words. */
  function message(messageID: number | null): string {
    const template = messageID === null ? undefined : $words.templates[`#${messageID}`];
    return typeof template === "string" ? plainText(formatTemplate(template, {}, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") })) : "";
  }

  /** CertifiedSkillPlanController.GetName and GetDescription: their messages. */
  const certifiedEntries = $derived(
    certified ? certified.plans.map((plan): CertifiedPlanEntry => ({ ...plan, name: message(plan.nameID), description: message(plan.descriptionID) })) : [],
  );
  const certifiedShown = $derived(sortPlansByName(certifiedPlansShown(certifiedEntries, careerPathID, factionID)));
  const airPlan = $derived(certifiedEntries.find((plan) => plan.id === certifiedPlanUuid(PLAN_ID_AIR)) ?? null);

  // The Corporation Plans panel (corpPlansPanel.py): its plans, the category and filter chosen, the page shown.
  const inCorp = $derived(inPlayerCorporation($station.online?.corporationID ?? null));
  const shownPanel = $derived<Panel>(panel === "corporation" && !inCorp ? "certified" : panel);
  let corp = $state<Awaited<ReturnType<AppFlow["corpSkillPlans"]>> | undefined>(undefined);
  let corpCategoryID = $state<number | null>(null);
  let corpFilter = $state("");
  let corpPage = $state(0);
  let corpReading = false;

  async function loadCorp(): Promise<void> {
    if (corpReading) return;
    corpReading = true;
    try {
      corp = await flow.corpSkillPlans().catch(() => null);
    } finally {
      corpReading = false;
    }
  }

  // Show: the panel's plans read when it is shown.
  $effect(() => {
    if (shownPanel === "corporation" && corp === undefined) void loadCorp();
  });

  /** OnCategoryButtonGroup (isOptional: the chosen one clicked again, none chosen), then the first page. */
  function chooseCorpCategory(id: number): void {
    corpCategoryID = corpCategoryID === id ? null : id;
    corpPage = 0;
  }

  /** OnQuickFilterEdit, then the first page. */
  function setCorpFilter(text: string): void {
    corpFilter = text;
    corpPage = 0;
  }

  const corpAll = $derived(corp ? corpPlansFiltered(corp.plans, corpCategoryID, corpFilter) : []);
  const corpShown = $derived(corpAll.slice(corpPage * CORP_PLANS_PER_PAGE, (corpPage + 1) * CORP_PLANS_PER_PAGE));
  /** The editor's Category choices after None (_GetCategoryComboOptions: the career paths in the table's order). */
  const corpCategories = $derived((certified?.careerPaths ?? []).map((career) => ({ id: career.careerPathID, name: message(career.nameID) })));

  // certifiedPlansPanel._OnSizeChange_NoBlock (158 to 164): under 550 high or 860 wide, the career paths are plain
  // buttons with their names (SimpleCareerPathToggleButtonGroupButton); else each its picture, its name and its info
  // icon (CareerPathToggleButtonGroupButton). Measured on the window's body below the panel's tabs.
  let sectionElement = $state<HTMLElement | null>(null);
  let headElement = $state<HTMLElement | null>(null);
  let limitedHeight = $state(true);
  $effect(() => {
    const host = sectionElement?.parentElement ?? null;
    if (host === null || typeof ResizeObserver === "undefined") return;
    const measure = (): void => {
      const height = host.clientHeight - (headElement?.offsetHeight ?? 0);
      limitedHeight = height < 550 || host.clientWidth < 860;
    };
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    measure();
    return () => observer.disconnect();
  });

  /**
   * UpdateFactionIcon and UpdateCareerPathIcon: an opened plan's faction icon (ICON_BY_FACTION_ID, a certified plan's
   * faction) and career path icon (CAREERS_32_SIZES, where GetCareerPathID is one: a certified plan's career path, a
   * corporation plan's category), each with its tooltip's header and text (LoadFactionTooltip, LoadCareerTooltip).
   */
  function viewIcons(plan: OpenedPlan): { readonly kind: "faction" | "career"; readonly src: string; readonly title: string }[] {
    const icons: { readonly kind: "faction" | "career"; readonly src: string; readonly title: string }[] = [];
    const faction = plan.factionID ? factionIcon(plan.factionID) : null;
    if (faction !== null && plan.factionID) {
      icons.push({ kind: "faction", src: faction, title: `${word("UI/SkillPlan/SkillPlanFaction")}\n${word(FACTION_HINT_LABELS.get(plan.factionID) ?? "")}` });
    }
    const careerPathID = plan.certified ? plan.careerPathID ?? null : plan.corp ? plan.categoryID ?? null : null;
    const career = careerPathID ? careerIcon(careerPathID, 32) : null;
    if (career !== null && careerPathID) {
      icons.push({ kind: "career", src: career, title: `${word("UI/SkillPlan/SkillPlanCareerPath")}\n${word(CAREER_HINT_LABELS.get(careerPathID) ?? "")}` });
    }
    return icons;
  }

  onMount(() => {
    flow.requestWords([...Object.keys(OWN), ...SHORT_INTERVAL_WORD_LABELS]);
    void load();
    void loadCertified();
    // A link followed before the window was open (the window opens on it).
    const waiting = flow.takeSkillPlanLink();
    if (waiting !== null) void followLink(waiting);
  });

  // A skill plan link followed (link.py handle_link, OpenSkillPlanWnd): the plan opened here, whichever panel is shown.
  // svelte-ignore state_referenced_locally
  const skillPlanLinks = flow.skillPlanLinks;
  let linkSeen = 0;
  $effect(() => {
    const followed = $skillPlanLinks;
    if (followed === null || followed.n === linkSeen) return;
    linkSeen = followed.n;
    const waiting = untrack(() => flow.takeSkillPlanLink());
    if (waiting !== null) untrack(() => void followLink(waiting));
  });

  /** A plan opened by its link that is none of the pilot's own (the linked window's plan). */
  let linked = $state<OpenedPlan | null>(null);

  /**
   * OpenSkillPlanWnd: the plan among the pilot's own (skillPlanService.Get: the certified ones by number, the personal
   * and the corporation's by uuid), else another's (GetOwnedByOther: the flow says SkillPlanNotFound where none is had);
   * then opened. The client opens it in a window of its own (SkillPlanPanelWnd, LinkedSkillPlanContainer); here it is
   * opened in the panel, over whichever list is shown.
   */
  async function followLink(link: SkillPlanLinkFollowed): Promise<void> {
    editing = null;
    let found: OpenedPlan | null = null;
    if (typeof link.skillPlanID === "number") {
      if (certified === undefined) await loadCertified();
      const id = certifiedPlanUuid(link.skillPlanID);
      found = certifiedEntries.find((plan) => plan.id === id) ?? null;
    } else {
      const id = link.skillPlanID;
      if (read === undefined) await load();
      found = read?.plans.find((plan) => plan.id === id) ?? null;
      if (found === null && inCorp) {
        if (corp === undefined) await loadCorp();
        found = corp?.plans.find((plan) => plan.id === id) ?? null;
      }
      if (found === null) {
        const shared = await flow.sharedSkillPlan(id, link.ownerID);
        if (shared !== null) {
          linked = shared;
          found = shared;
        }
      }
    }
    if (found !== null) open(found);
  }

  /**
   * The share button's drag data (GetShareButtonDragData: SkillPlanDragData, its get_link): the plan's link, its owner
   * the pilot for a personal plan, the corporation for the corporation's, none for a certified or another's plan.
   */
  function shareDrag(event: DragEvent, plan: OpenedPlan): void {
    const online = store.station.get().online;
    const ownerID = plan.certified || plan.linked ? null : plan.corp ? online?.corporationID ?? null : online?.characterID ?? null;
    const id = plan.certified && plan.planID !== undefined ? plan.planID : plan.id;
    event.dataTransfer?.setData(LINK_DRAG_TYPE, JSON.stringify({ url: skillPlanUrl(id, ownerID), text: plan.name }));
    event.dataTransfer?.setData("text/plain", `<a href="${skillPlanUrl(id, ownerID)}">${plan.name}</a>`);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
  }

  function word(label: string, args: Readonly<Record<string, string | number>> = {}): string {
    const template = $words.templates[label];
    const text = typeof template === "string" ? template : OWN[label];
    return text === undefined ? "" : plainText(formatTemplate(text, args, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") }));
  }

  let read = $state<PersonalSkillPlansRead | null | undefined>(undefined);
  let error = $state("");
  let busy = $state(false);

  async function load(): Promise<void> {
    busy = true;
    try {
      read = await flow.personalSkillPlans();
    } finally {
      busy = false;
    }
  }

  const plans = $derived(read ? sortPlansByName(read.plans) : []);

  /** FormatTimeIntervalShortWritten from the day to `showTo`, in the install's words; the page's own otherwise. */
  function interval(ticks: number, showTo: "hour" | "minute" | "second"): string {
    const written = shortWrittenInterval(BigInt(Math.trunc(ticks)), $words.templates, "day", showTo);
    if (written !== null) return written;
    const minutes = Math.ceil(ticks / 600_000_000);
    const [days, hours, mins] = [Math.floor(minutes / 1440), Math.floor((minutes % 1440) / 60), minutes % 60];
    return [days > 0 ? `${days}d` : "", hours > 0 ? `${hours}h` : "", `${mins}m`].filter(Boolean).join(" ");
  }

  /** GetTotalTrainingTimeLeftText */
  function timeLeft(plan: PersonalSkillPlanEntry, ticksGone = 0): string {
    if (plan.completed) return word("UI/SkillPlan/Completed");
    if (plan.trainingTicks === null) return "–";
    const ticks = Math.max(0, plan.trainingTicks - ticksGone);
    return interval(ticks, timeLeftShowTo(ticks));
  }

  // OnSkillQueueChanged: each entry's gauge drawn as the queue now is (UpdateProgressGauge). The page reads its entries
  // again when the queue it holds changes: a save from anywhere, or a reading of the sheet that finds it changed.
  const queueSignature = $derived(
    $skillsSheet.queue === null
      ? null
      : `${$skillsSheet.queue.active}|${$skillsSheet.queue.entries.map((entry) => `${entry.typeID}:${entry.toLevel}`).join(",")}`,
  );
  let queueSeen: string | null | undefined = undefined;
  $effect(() => {
    const signature = queueSignature;
    if (queueSeen === undefined || signature === queueSeen) {
      queueSeen = signature;
      return;
    }
    queueSeen = signature;
    void load();
    void loadCertified();
    if (corp !== undefined) void loadCorp();
    // And the opened plan's contents (SkillPlanContents.OnSkillQueueChanged: its entries refreshed, their buttons, bars,
    // tooltips and menus as the queue now is), from a row's menu or from the queue anywhere.
    untrack(() => {
      if (selected !== null && contents !== undefined && contents.planID === selected.id) void readContents(selected);
    });
  });

  // The entry's tooltip, for the entry hovered or focused: at its right, or at its left where the screen ends first.
  // ---- A contents row: its menu, tooltip, drag and double click (SkillPlanContentsSkillEntry, SkillPlanSkillEntry) ----
  //
  //   GetMenu        the skill bar's: menusvc.GetMenuForSkill (bridge/skillMenu.ts), on a right click
  //   LoadTooltipPanel  LoadSkillEntryTooltipInfoOnly: the description, the level and the points, and for a skill in the
  //                  queue the level it trains to, the time until then and the rate (no actions). Not here: the
  //                  description's info icon, the tooltip being shown and gone with the pointer (and the expert systems'
  //                  notice, the page having no expert systems)
  //   GetDragData    the skill bar's: a listentry.SkillEntry; dropped into a chat's send box it is the type's link
  //                  (eveEditPlainText.py 140: evelink.type_link). The queue's own drop (skillQueuePanelNew 852) is not
  //                  the page's yet
  //   OnDblClick     Show Info on the skill

  /** The opened plan's info for a skill, where its contents were read. */
  function rowInfo(skill: number): SkillRowInfo | null {
    return contents?.detail?.skillInfo?.get(skill) ?? null;
  }

  let rowMenu = $state<{ readonly skill: number; readonly entries: readonly SkillMenuEntry[]; readonly x: number; readonly y: number } | null>(null);
  function openRowMenu(skill: number, event: MouseEvent): void {
    const info = rowInfo(skill);
    if (info === null) return;
    event.preventDefault();
    rowTip = null;
    rowMenu = { skill, entries: skillMenuEntries(skill, info.menu), x: event.clientX, y: event.clientY };
  }
  let rowTip = $state<{ readonly skill: number; readonly top: number; readonly left: number | null; readonly right: number | null } | null>(null);
  function showRowTip(skill: number, event: Event): void {
    if (rowMenu !== null || rowInfo(skill) === null || !(event.currentTarget instanceof HTMLElement)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    // GetTooltipPointer: POINT_RIGHT_2, the tooltip at the entry's right where it fits.
    const fitsRight = rect.right + TIP_GAP + TIP_WIDTH <= window.innerWidth;
    rowTip = { skill, top: rect.top, left: fitsRight ? rect.right + TIP_GAP : null, right: fitsRight ? null : window.innerWidth - rect.left + TIP_GAP };
  }
  // The tooltip stays while the pointer is on it (its panel takes the pointer): taken away a moment after the pointer
  // leaves the row, unless it came onto the tooltip.
  let rowTipHeld = false;
  let rowTipTimer: ReturnType<typeof setTimeout> | null = null;
  function hideRowTip(skill: number): void {
    if (rowTipTimer !== null) clearTimeout(rowTipTimer);
    rowTipTimer = setTimeout(() => {
      rowTipTimer = null;
      if (!rowTipHeld && rowTip !== null && rowTip.skill === skill) rowTip = null;
    }, 200);
  }
  function rowTipHover(inside: boolean): void {
    rowTipHeld = inside;
    if (!inside && rowTip !== null) hideRowTip(rowTip.skill);
  }

  /** GetDragData: the skill as a listentry.SkillEntry, taken by a chat's send box as the type's link. */
  function skillDrag(event: DragEvent, skill: number): void {
    rowTip = null;
    const name = resolvedName($names.resolved, "type", skill, "");
    event.dataTransfer?.setData(LINK_DRAG_TYPE, JSON.stringify({ url: `showinfo:${skill}`, text: name }));
    event.dataTransfer?.setData("text/plain", `<a href="showinfo:${skill}">${name}</a>`);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
    // A listentry.SkillEntry, its trained the skill had (lapsed counted); had where its row was not read.
    const info = rowInfo(skill);
    startSkillDrag({ kind: "skillEntry", typeID: skill, trained: info === null ? true : info.menu.trainedLevel !== null });
  }

  let tip = $state<{ readonly planID: string; readonly top: number; readonly left: number | null; readonly right: number | null } | null>(null);
  /** The tooltip's widest (17rem) and the gap between it and the entry, in pixels. */
  const TIP_WIDTH = 272;
  const TIP_GAP = 8;
  function showTip(plan: OpenedPlan, event: Event): void {
    if (!(event.currentTarget instanceof HTMLElement)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const fitsRight = rect.right + TIP_GAP + TIP_WIDTH <= window.innerWidth;
    tip = {
      planID: plan.id,
      top: rect.top,
      left: fitsRight ? rect.right + TIP_GAP : null,
      right: fitsRight ? null : window.innerWidth - rect.left + TIP_GAP,
    };
  }
  function hideTip(plan: OpenedPlan): void {
    if (tip !== null && tip.planID === plan.id) tip = null;
  }

  // The corporation's notices (CorpSkillPlanNoticeMessenger and CorpMilestoneNoticeMessenger, taken by
  // skillPlanService's OnRemoteCorpSkillPlan* and the milestone service's cache), as the client's panels take them:
  //   Created, Deleted, NameUpdated, DescriptionUpdated, CategoryUpdated   the corporation panel made again from its
  //       first page (on_created, on_deleted, on_saved: ReconstructPagination), none of it where the corporation's
  //       plans were never read (corpCache None); the three updates also close what is open over the panels, a plan
  //       or the editor (skillPlanPanel.OnSkillPlanSaved: _HideAllOverlays), and Deleted closes the plan it deletes
  //       where that one is open (OnSkillPlanDeleted)
  //   SkillRequirementsUpdated   the plan's skills as they now are (ResetSkillRequirements), the opened one's contents
  //       read again
  //   a milestone Created or Deleted   the opened corporation plan's milestones read again
  // svelte-ignore state_referenced_locally
  const gatewayNotices = flow.gatewayNotices;
  const CORP_PLAN_NOTICE = "eve_public.corporation.skill.plan.";
  let noticeSeen = 0;
  $effect(() => {
    const notice = $gatewayNotices;
    if (notice === null || notice.n === noticeSeen) return;
    noticeSeen = notice.n;
    untrack(() => corpNotice(notice));
  });

  function corpNotice(notice: GatewayNotice): void {
    if (!notice.typeName.startsWith(CORP_PLAN_NOTICE)) return;
    const kind = notice.typeName.slice(CORP_PLAN_NOTICE.length);
    if (kind.startsWith("milestone.")) {
      if (selected !== null && selected.corp) void readMilestones(selected);
      return;
    }
    if (corp === undefined) return;
    const payload = notice.payload !== null && typeof notice.payload === "object" && !Array.isArray(notice.payload)
      ? (notice.payload as Record<string, unknown>)
      : {};
    const identifier = (payload.identifier ?? payload.skill_plan ?? {}) as Record<string, unknown>;
    const planID = uuidFromBytes(String(identifier.uuid ?? ""));
    if (kind === "SkillRequirementsUpdatedNotice") {
      void loadCorp().then(() => {
        if (selected !== null && selected.corp && selected.id === planID) void readContents(selected);
      });
      return;
    }
    if (kind === "NameUpdatedNotice" || kind === "DescriptionUpdatedNotice" || kind === "CategoryUpdatedNotice") {
      editing = null;
      close();
    } else if (kind === "DeletedNotice" && selectedID !== null && selectedID === planID) {
      close();
    } else if (kind !== "CreatedNotice") {
      return;
    }
    corpPage = 0;
    void loadCorp();
  }

  // _UpdateTrainingTimeThread: while a plan shown has levels queued (GetInTrainingRatio above nought), the entries are
  // drawn again each second (UpdateState).
  let now = $state(Date.now());
  const anyTraining = $derived.by(() => {
    const shownPlans: readonly OpenedPlan[] = [...(read?.plans ?? []), ...certifiedEntries, ...(corp?.plans ?? [])];
    return shownPlans.some((plan) => plan.progress !== undefined && plan.progress !== null && (plan.progress.training !== null || plan.progress.inTraining > 0));
  });
  $effect(() => {
    if (!anyTraining) return;
    now = Date.now();
    const timer = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => clearInterval(timer);
  });

  // The entry's menu (SkillPlanEntry.GetMenu), one open at a time; kept while it closes so nothing reads it gone.
  let menu = $state<{ readonly plan: OpenedPlan; readonly x: number; readonly y: number } | null>(null);
  let menuUp = $state(false);

  $effect(() => {
    if (!menuUp) return;
    const close = (event: Event): void => {
      if (!(event.target instanceof Element && event.target.closest(".hull-menu"))) menuUp = false;
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape") menuUp = false;
    };
    const timer = setTimeout(() => {
      window.addEventListener("pointerdown", close);
      window.addEventListener("keydown", key);
    });
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", key);
    };
  });

  function openMenu(plan: OpenedPlan, event: MouseEvent): void {
    event.preventDefault();
    menu = { plan, x: event.clientX, y: event.clientY };
    menuUp = true;
  }

  async function deletePlan(plan: OpenedPlan): Promise<void> {
    menuUp = false;
    error = "";
    try {
      if (plan.corp) {
        // _DeleteCorp; OnSkillPlanDeleted: the panel's pages made again, the first shown.
        if (await flow.deleteCorpSkillPlan(plan.id)) {
          if (selectedID === plan.id) selectedID = null;
          await loadCorp();
          corpPage = 0;
        }
      } else if (await flow.deletePersonalSkillPlan(plan.id)) {
        if (selectedID === plan.id) selectedID = null;
        await load();
      }
    } catch {
      // _DeletePersonal, _DeleteCorp: message_player(ConnectionError).
      error = word("UI/SkillPlan/ConnectionError");
    }
  }

  // --- A plan opened ---------------------------------------------------------------------------------------------

  // The editor, open on a plan (a copy) or a new one (plan null), a new one with a template where a skill window asked.
  let editing = $state<{ readonly plan: OpenedPlan | null; readonly corp: boolean; readonly template?: SkillPlanTemplate | null } | null>(null);

  // A new plan asked for by a skill window's Create Skill Plan (skillPlanTemplate.ts; SkillPlanPanel with its
  // skillPlanTemplate: OnCreateNewPersonalSkillPlanWithTemplate): the personal plans shown, and the editor begun afresh
  // on a new plan with the template; where no more plans may be had, the personal plans alone.
  const templateRequests = skillPlanTemplateTarget.requests;
  $effect(() => {
    void $templateRequests;
    const taken = untrack(() => skillPlanTemplateTarget.take());
    if (taken === null) return;
    untrack(() => {
      menuUp = false;
      selectedID = null;
      linked = null;
      choosePanel("personal");
      editing = null;
    });
    if (taken.template !== null) void tick().then(() => (editing = { plan: null, corp: false, template: taken.template }));
  });

  /** The editor on a plan, or on a new one (plan null; corp: the corporation's, OnCreateNewCorpSkillPlanButton). */
  function edit(plan: OpenedPlan | null, corp = plan?.corp === true): void {
    menuUp = false;
    editing = { plan, corp };
  }

  function editorClosed(saved: boolean): void {
    const corpPlan = editing?.corp === true;
    editing = null;
    if (saved) {
      selectedID = null;
      // OnSkillPlanCreated, OnSkillPlanSaved: the corporation panel's pages made again, its first shown.
      if (corpPlan) {
        corpPage = 0;
        void loadCorp();
      } else {
        void load();
      }
    }
  }

  /**
   * CreateCorpPlanButton's tooltip: its header, the plans in total, the warning (_GetWarningText: the role wanted, or
   * the most reached).
   */
  function createCorpTip(numPlans: number, canEdit: boolean): string {
    const lines = [word("UI/SkillPlan/CreateCorpSkillPlan"), word("UI/SkillPlan/PlansInTotal", { numPlans, numTotal: MAX_CORP_PLANS })];
    if (!canEdit) lines.push(word("UI/SkillPlan/CorpPlanCreateRequiresRoleHint"));
    else if (numPlans >= MAX_CORP_PLANS) lines.push(word("UI/SkillPlan/MaximumSkillPlanReached", { numPlans: MAX_CORP_PLANS }));
    return lines.join("\n");
  }

  /** CreatePersonalPlanButton's tooltip: its header, the plans in total, the warning at the most. */
  function createTip(numPlans: number): string {
    const lines = [word("UI/SkillPlan/CreatePersonalSkillPlan"), word("UI/SkillPlan/PlansInTotal", { numPlans, numTotal: MAX_PERSONAL_PLANS })];
    if (numPlans >= MAX_PERSONAL_PLANS) lines.push(word("UI/SkillPlan/MaximumSkillPlanReached", { numPlans: MAX_PERSONAL_PLANS }));
    return lines.join("\n");
  }

  let selectedID = $state<string | null>(null);
  const selected = $derived<OpenedPlan | null>(
    selectedID === null
      ? null
      : (read?.plans.find((plan) => plan.id === selectedID)
        ?? certifiedEntries.find((plan) => plan.id === selectedID)
        ?? corp?.plans.find((plan) => plan.id === selectedID)
        ?? (linked !== null && linked.id === selectedID ? linked : null)
        ?? null),
  );
  let contentsShown = $state(false);
  /** The plan opened, as read (its rows, books, locks): undefined while read, null where it could not be. */
  let contents = $state<{ readonly planID: string; readonly detail: SkillPlanDetail | null } | undefined>(undefined);
  /** SkillsAddedNotification's words, said in the view after Start Training. */
  let notice = $state("");
  let training = $state(false);
  let filter = $state("");

  const HIDE_TRAINED_KEY = "evejs.SkillPlanContentsHideTrained";
  function hideTrainedSetting(): boolean {
    try {
      return localStorage.getItem(HIDE_TRAINED_KEY) !== "false";
    } catch {
      return true;
    }
  }
  let hideTrained = $state(hideTrainedSetting());
  function setHideTrained(on: boolean): void {
    hideTrained = on;
    try {
      localStorage.setItem(HIDE_TRAINED_KEY, on ? "true" : "false");
    } catch {
      // Kept for this page only.
    }
  }

  function open(plan: OpenedPlan): void {
    tip = null;
    rowSelection = null;
    contentsMenu = null;
    selectedID = plan.id;
    notice = "";
    void readContents(plan);
    void readMilestones(plan);
  }

  function close(): void {
    selectedID = null;
    contents = undefined;
    milestones = undefined;
    notice = "";
  }

  // The opened plan's milestones (flow.skillPlanMilestones): undefined while read, a null list where they could not be.
  let milestones = $state<{ readonly planID: string; readonly list: readonly MilestoneEntry[] | null } | undefined>(undefined);

  async function readMilestones(plan: OpenedPlan): Promise<void> {
    milestones = undefined;
    // A certified plan's milestones are its table's (CertifiedSkillPlanController.GetMilestones): nothing asked, nothing put right.
    if (plan.certified) {
      const list = await flow.certifiedPlanMilestones(plan.milestoneList ?? []).catch(() => null);
      if (selectedID === plan.id) milestones = { planID: plan.id, list };
      return;
    }
    // A corporation plan's are the corporation's (CorpSkillPlanMilestoneService).
    const read_ = await flow.skillPlanMilestones(plan, plan.corp ? "corporation" : "character").catch(() => null);
    if (selectedID !== plan.id) return;
    milestones = { planID: plan.id, list: read_ ? read_.milestones : null };
    // _AddSkillsMissingForMilestones put skills in the plan: the plan as it now is, and its view read again.
    if (read_ && read_.requirements !== null) {
      const requirements = read_.requirements;
      if (plan.corp && corp) corp = { ...corp, plans: corp.plans.map((each) => (each.id === plan.id ? { ...each, requirements } : each)) };
      else if (!plan.corp && read) read = { ...read, plans: read.plans.map((each) => (each.id === plan.id ? { ...each, requirements } : each)) };
      if (selected !== null && selected.id === plan.id) await readContents(selected);
    }
  }

  /** The milestone kinds' words (MilestoneInfoTooltip._GetTypeLabel). */
  const MILESTONE_KIND_LABELS = {
    ship: "UI/SkillPlan/MilestoneShip",
    module: "UI/SkillPlan/MilestoneModule",
    skill: "UI/SkillPlan/MilestoneSkill",
    other: "UI/SkillPlan/MilestoneOther",
  } as const;

  async function readContents(plan: PersonalSkillPlanEntry): Promise<void> {
    contents = undefined;
    const detail = await flow.skillPlanDetail(plan).catch(() => null);
    if (selectedID === plan.id) contents = { planID: plan.id, detail };
  }

  /** OnToggleContents */
  function toggleContents(): void {
    contentsShown = !contentsShown;
  }

  /** TrainSkills */
  async function startTraining(plan: OpenedPlan): Promise<void> {
    if (!read || training) return;
    training = true;
    error = "";
    notice = "";
    try {
      // _CheckSetCurrentSkillPlanAsTracked: a corporation's plan tracked by a copy among the personal plans.
      const outcome = await flow.trainSkillPlan(plan, read.trackedID, plan.corp || plan.linked ? () => copyAsPersonal(plan) : undefined);
      if (plan.corp || plan.linked) await load();
      if (read) read = { ...read, trackedID: outcome.trackedID };
      if (outcome.added !== null && outcome.added > 0) notice = word("UI/SkillPlan/SkillsAddedNotification", { numSkills: outcome.added, planName: plan.name });
    } catch {
      error = word("UI/SkillPlan/ConnectionError");
    } finally {
      training = false;
    }
    // OnSkillQueueChanged: the view's buttons and the contents' bars as the queue now is.
    if (selectedID === plan.id) await readContents(plan);
  }

  /**
   * SaveSkillPlan: a copy of the plan saved as a personal plan (GetSkillPlanCopy: with its milestones, a certified
   * plan's from its table, a personal plan's as read), then opened (on_selected).
   */
  async function savePlanCopy(plan: OpenedPlan): Promise<void> {
    if (copying) return;
    copying = true;
    error = "";
    try {
      const newID = await copyAsPersonal(plan);
      if (newID === null) return;
      await load();
      const copy = read?.plans.find((each) => each.id === newID);
      if (copy) open(copy);
    } finally {
      copying = false;
    }
  }
  let copying = $state(false);

  /** GetSkillPlanCopy: SkillPlanCopied said, the copy saved among the personal plans; its id, null where not saved. */
  function copyAsPersonal(plan: OpenedPlan): Promise<string | null> {
    const milestoneList = plan.certified
      ? plan.milestoneList ?? []
      : milestones !== undefined && milestones.planID === plan.id && milestones.list !== null ? milestones.list : [];
    return flow.copySkillPlan(
      { name: plan.name, description: plan.description, requirements: plan.requirements, milestones: milestoneList },
      read ? read.plans.length : null,
    );
  }

  /** _CreateCopySelectAndTrack: the copy saved, opened (on_selected), then tracked. */
  async function trackCopy(plan: OpenedPlan): Promise<void> {
    if (copying) return;
    copying = true;
    error = "";
    try {
      const newID = await copyAsPersonal(plan);
      if (newID === null) return;
      await load();
      const copy = read?.plans.find((each) => each.id === newID);
      if (copy) open(copy);
      try {
        const tracked = await flow.setTrackedSkillPlan(newID);
        if (read) read = { ...read, trackedID: tracked };
      } catch {
        error = word("UI/SkillPlan/ConnectionError");
        if (read) read = { ...read, trackedID: null };
      }
    } finally {
      copying = false;
    }
  }

  // A level's button (SkillLevelEntryPrimaryButton): its mark by state (the client's icons stand for these).
  const LEVEL_BUTTON_MARKS: Readonly<Record<LevelButtonState, string>> = {
    omega: "Ω",
    book: "📖",
    remove: "−",
    "remove-locked": "−",
    trained: "✔",
    add: "+",
  };
  let levelBusy = $state(false);

  /**
   * A hint of a button that opens the clone upgrade window (uicore.cmd.OpenCloneUpgradeWindow: the Omega upsell window,
   * the store's), with why the page's does not: as the apply-points button says it (ClientDialogs.svelte).
   */
  function withoutStore(hint: string): string {
    return `${hint} (The page has no store.)`;
  }

  // A contents row clicked (OnEntryClicked): it selected, the others marked by how they stand to it
  // (GetRequirementStateForEntry: a prerequisite or required for it, both drawn alike, SkillEntryUnderlay's hover look).
  // Ctrl and a click on the selected row: none selected and nothing marked. Kept for the plan it was made in.
  let rowSelection = $state<{
    readonly planID: string;
    readonly skill: number;
    readonly level: number;
    readonly prereqs: ReadonlyMap<number, number>;
    readonly requiredFor: ReadonlySet<number>;
  } | null>(null);

  async function selectRow(plan: OpenedPlan, row: SkillPlanContentRow, ctrlKey: boolean): Promise<void> {
    const selectedNow = rowSelection !== null && rowSelection.planID === plan.id && rowSelection.skill === row.skill && rowSelection.level === row.level;
    if (ctrlKey && selectedNow) {
      rowSelection = null;
      return;
    }
    // GetPreReqsAndRequiredForSkillLevel: get_dogma_required_skills and GetSkillsRequiring(skill, level).
    const [facts, requiring] = await Promise.all([
      flow.skillPlanTypeFacts([row.skill]).catch(() => null),
      flow.skillsRequiring([row.skill]).catch(() => null),
    ]);
    if (selectedID !== plan.id) return;
    rowSelection = {
      planID: plan.id,
      skill: row.skill,
      level: row.level,
      prereqs: new Map(facts?.required[row.skill] ?? []),
      requiredFor: new Set(requiring?.get(row.skill)?.get(row.level) ?? []),
    };
  }

  function rowMark(plan: OpenedPlan, row: SkillPlanContentRow): "selected" | "marked" | null {
    const selection = rowSelection;
    if (selection === null || selection.planID !== plan.id) return null;
    if (selection.skill === row.skill && selection.level === row.level) return "selected";
    return planRowRequirement(selection, row, selection.prereqs, selection.requiredFor) === null ? null : "marked";
  }

  // The contents' menu (GetUtilMenu): Copy Skills to Clipboard. Its GM's Train All Skills is not the page's.
  let contentsMenu = $state<{ readonly left: number; readonly top: number } | null>(null);
  function openContentsMenu(event: MouseEvent): void {
    if (contentsMenu !== null) {
      contentsMenu = null;
      return;
    }
    if (!(event.currentTarget instanceof HTMLElement)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    contentsMenu = { left: Math.max(8, rect.right - 220), top: rect.bottom + 4 };
  }
  $effect(() => {
    if (contentsMenu === null) return;
    const close = (event: Event): void => {
      if (!(event.target instanceof Element && event.target.closest(".skill-plan-contents-menu, .skill-plan-contents-menu-button"))) contentsMenu = null;
    };
    const timer = setTimeout(() => window.addEventListener("pointerdown", close));
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", close);
    };
  });

  /** CopySkillsToClipboard: GetRequirementsClipboardText, the skills by their names. */
  function copySkills(plan: OpenedPlan): void {
    contentsMenu = null;
    const text = requirementsClipboardText(plan, (typeID) => resolvedName($names.resolved, "type", typeID, String(typeID)));
    void navigator.clipboard.writeText(text).catch(() => {});
  }

  /** GetTooltipText; add's with the points the level lacks and the pilot's points a minute (LoadTooltipPanel). */
  function levelHint(row: SkillPlanContentRow): string {
    if (row.button !== "add") return word(LEVEL_BUTTON_HINTS[row.button]);
    const lines = [word(LEVEL_BUTTON_HINTS.add, { skillLevel: row.level })];
    if (row.pointsMissing !== null) lines.push(`${word("UI/Skills/SkillPointsRequired")}: ${row.pointsMissing.toLocaleString("en-US")}`);
    if (row.pointsPerMinute !== null) lines.push(word("UI/CharacterSheet/CharacterSheetWindow/SkillTabs/SpPerMinute", { spPerMin: row.pointsPerMinute }));
    return lines.join("\n");
  }

  /** The level's button clicked (_OnClick), then the contents read again (OnSkillQueueChanged, OnSkillsAvailable). */
  async function levelAction(plan: OpenedPlan, row: SkillPlanContentRow): Promise<void> {
    if (levelBusy || levelButtonOff(row.button)) return;
    levelBusy = true;
    try {
      await flow.skillPlanLevelAction(row.skill, row.level, row.button);
    } finally {
      levelBusy = false;
    }
    if (selectedID === plan.id) await readContents(plan);
  }

  /** OnMissingSkillbooksButton: buy_missing_skills of the plan's books not held; then the contents read again. */
  async function buyMissingBooks(plan: OpenedPlan, missing: readonly number[]): Promise<void> {
    if (levelBusy) return;
    levelBusy = true;
    try {
      await flow.buyMissingSkillBooks(missing);
    } finally {
      levelBusy = false;
    }
    if (selectedID === plan.id) await readContents(plan);
  }

  /** OnTrackButton, _ToggleTracked */
  async function toggleTracked(plan: OpenedPlan): Promise<void> {
    if (!read) return;
    // A plan that cannot be tracked (IsTrackable: a corporation's, or another's opened by its link):
    // _CreateCopySelectAndTrack.
    if (plan.corp || plan.linked) {
      await trackCopy(plan);
      return;
    }
    error = "";
    const want = read.trackedID === plan.id ? null : plan.id;
    try {
      const tracked = await flow.setTrackedSkillPlan(want);
      if (read) read = { ...read, trackedID: tracked };
    } catch {
      // _SetTrackedPlanID: message_player(ConnectionError), and nothing tracked after it.
      error = word("UI/SkillPlan/ConnectionError");
      if (read) read = { ...read, trackedID: null };
    }
  }

  const shownRows = $derived(
    contents && contents.detail
      ? contents.detail.rows.filter((row) => skillPlanRowVisible(row, hideTrained, filter, resolvedName($names.resolved, "type", row.skill, "")))
      : [],
  );
</script>

<section bind:this={sectionElement}>
  <header class="panel-head" bind:this={headElement}>
    <div class="skill-plan-tabs" role="tablist">
      <button type="button" role="tab" aria-selected={shownPanel === "certified"} class:selected={shownPanel === "certified"}
        title={word("UI/SkillPlan/CertifiedPlansHoverTooltip")} onclick={() => { close(); editing = null; choosePanel("certified"); }}>{word("UI/SkillPlan/CertifiedPlans")}</button>
      <button type="button" role="tab" aria-selected={shownPanel === "personal"} class:selected={shownPanel === "personal"}
        title={word("UI/SkillPlan/PersonalPlansHoverTooltip")} onclick={() => { close(); editing = null; choosePanel("personal"); }}>{word("UI/SkillPlan/PersonalPlans")}</button>
      {#if inCorp}
        <button type="button" role="tab" aria-selected={shownPanel === "corporation"} class:selected={shownPanel === "corporation"}
          title={word("UI/SkillPlan/CorpPlansHoverTooltip")} onclick={() => { close(); editing = null; choosePanel("corporation"); }}>{word("UI/SkillPlan/CorpPlans")}</button>
      {/if}
    </div>
    <span class="controls">
      <button type="button" disabled={busy} onclick={() => { void load(); void loadCertified(); if (inCorp) void loadCorp(); }}>Refresh</button>
    </span>
  </header>
  <!-- ToggleButtonGroupButtonCircular: from the back, the stroke (0.1), the fill (selected; half hovered), the glow
       (selected, twice the button's size) and the 32px icon (white; black selected); its name where it has no icon. -->
  {#snippet circularArt(icon: string | null, label: string)}
    <img class="circular-stroke" src={CIRCULAR_BUTTON.stroke} alt="" />
    <img class="circular-fill" src={CIRCULAR_BUTTON.fill} alt="" />
    <img class="circular-glow" src={CIRCULAR_BUTTON.glow} alt="" />
    {#if icon !== null}
      <img class="circular-icon" src={icon} alt="" />
    {:else}
      <span class="circular-label">{label}</span>
    {/if}
  {/snippet}
  {#snippet planCard(plan: OpenedPlan, withMenu: boolean)}
    {@const shown = plan.progress ? planProgressAt(plan.progress, now) : null}
    <li onmouseenter={(event) => showTip(plan, event)} onmouseleave={() => hideTip(plan)}
      onfocusin={(event) => showTip(plan, event)} onfocusout={() => hideTip(plan)}>
      <button type="button" class="skill-plan-card" onclick={() => open(plan)} oncontextmenu={(event) => { if (withMenu) openMenu(plan, event); }}>
        <span class="skill-plan-name">{plan.name}</span>
        {#if read && read.trackedID === plan.id}
          <span class="skill-plan-tracked" title={word("UI/SkillPlan/TrackedSkillPlan")} aria-label={word("UI/SkillPlan/TrackedSkillPlan")}>👁</span>
        {/if}
        <!-- GaugeMultiValue: the progress ratio, then the in-training one after it. -->
        <span class="skill-plan-gauge" aria-hidden="true">
          {#if shown !== null}
            <span class="skill-plan-gauge-trained" style:width={`${Math.min(100, shown.progress * 100)}%`}></span>
            <span class="skill-plan-gauge-training" style:width={`${Math.min(100, shown.inTraining * 100)}%`}></span>
          {/if}
        </span>
        <span class="skill-plan-time" class:completed={plan.completed}>
          {timeLeft(plan, shown?.ticksGone ?? 0)}
          <span class="skill-plan-marks">
            {#if plan.omegaMark}<span class="skill-plan-omega" aria-hidden="true">Ω</span>{/if}
            {#if plan.completed}<span class="skill-plan-done" aria-hidden="true">✔</span>{/if}
          </span>
        </span>
      </button>
      <!-- SkillPlanEntryTooltip: its pointer on its left, so it stands at the entry's right (at its left where the
           screen ends first); fixed, on the page's body (portal.ts), so the window neither cuts it off nor moves it. -->
      {#if tip !== null && tip.planID === plan.id}
      <div class="skill-plan-tip" role="tooltip" use:portal style:top={`${tip.top}px`}
        style:left={tip.left === null ? undefined : `${tip.left}px`} style:right={tip.right === null ? undefined : `${tip.right}px`}>
        <strong>{word("UI/SkillPlan/SkillPlan")}</strong>
        {#if plan.description}<p>{plan.description}</p>{/if}
        {#if (plan.missingBooks ?? 0) > 0}
          <span class="skill-plan-tip-row"><span class="skill-plan-tip-icon books" aria-hidden="true">📖</span>{word("UI/SkillPlan/SkillbooksMissing2")}<span class="skill-plan-tip-count">x{plan.missingBooks}</span></span>
        {/if}
        {#if (plan.numOmegaSkills ?? 0) > 0}
          <span class="skill-plan-tip-row"><span class="skill-plan-tip-icon omega" aria-hidden="true">Ω</span>{word("UI/SkillPlan/RequireOmega")}<span class="skill-plan-tip-count">x{plan.numOmegaSkills}</span></span>
        {/if}
      </div>
      {/if}
    </li>
  {/snippet}
  {#if error}
    <p class="error">{error}</p>
  {/if}
  {#if editing !== null}
    <SkillPlanEditor {store} {flow} plan={editing.plan} template={editing.template ?? null} planCount={editing.corp ? corp?.plans.length ?? 0 : plans.length} onClose={editorClosed}
      corp={editing.corp ? { categoryID: editing.plan?.categoryID ?? null, categories: corpCategories } : null} />
  {:else if selected !== null}
    {@const plan = selected}
    {@const tracked = read?.trackedID === plan.id}
    {@const trackHint = plan.corp || plan.linked ? "UI/SkillPlan/SaveAnTrackPlan" : tracked ? "UI/SkillPlan/UntrackPlanHint" : "UI/SkillPlan/TrackPlanHint"}
    <div class="skill-plan-view">
      <div class="skill-plan-view-head">
        <span class="skill-plan-caption">{word(plan.certified ? "UI/SkillPlan/CertifiedSkillPlan" : plan.corp ? "UI/SkillPlan/CorpSkillPlan" : "UI/SkillPlan/SkillPlan")}</span>
        <span class="skill-plan-view-name">{plan.name}</span>
        <button type="button" class="skill-plan-close" aria-label="Close" onclick={close}>✕</button>
      </div>
      <!-- ConstructIconCont, UpdateFactionIcon, UpdateCareerPathIcon: the plan's faction at the left and its career path
           at the right (a certified plan's; a corporation's category is its career path), each at half opacity, with
           its tooltip. -->
      {#if viewIcons(plan).length > 0}
        <div class="skill-plan-view-icons">
          {#each viewIcons(plan) as icon (icon.kind)}
            <img class={icon.kind} src={icon.src} alt="" width="32" height="32" title={icon.title} />
          {/each}
        </div>
      {/if}
      <div class="skill-plan-view-buttons">
        <!-- UpdateInformation: Edit and Delete only where the plan is editable (IsEditable: not a certified one; a
             corporation's only with corpRoleSkillPlanManager). -->
        {#if plan.corp}
          {#if corp?.canEdit}
            <button type="button" title={word("UI/SkillPlan/EditPlan")} aria-label={word("UI/SkillPlan/EditPlan")} onclick={() => edit(plan)}>✎</button>
            <button type="button" title={word("UI/SkillPlan/DeletePlan")} aria-label={word("UI/SkillPlan/DeletePlan")} onclick={() => void deletePlan(plan)}>🗑</button>
          {/if}
        {:else if !plan.certified && !plan.linked}
          <button type="button" title={word("UI/SkillPlan/EditPlan")} aria-label={word("UI/SkillPlan/EditPlan")} onclick={() => edit(plan)}>✎</button>
          <button type="button" title={word("UI/SkillPlan/DeletePlan")} aria-label={word("UI/SkillPlan/DeletePlan")} onclick={() => void deletePlan(plan)}>🗑</button>
        {/if}
        <!-- shareButton (MakeDragObject): dragged into a chat's send box, the plan's link. -->
        <span class="skill-plan-share" role="button" tabindex="-1" draggable="true" title={word("UI/SkillPlan/SharePlan")}
          aria-label={word("UI/SkillPlan/SharePlan")} ondragstart={(event) => shareDrag(event, plan)}>⇪</span>
        <!-- saveButton: on every plan, a copy among the personal plans. -->
        <button type="button" disabled={copying} title={word("UI/SkillPlan/SavePlan")} aria-label={word("UI/SkillPlan/SavePlan")} onclick={() => void savePlanCopy(plan)}>💾</button>
        <button type="button" class="skill-plan-track" class:tracked disabled={plan.corp && copying}
          title={word(trackHint)} aria-label={word(trackHint)}
          aria-pressed={tracked} onclick={() => void toggleTracked(plan)}>👁</button>
      </div>
      <button type="button" class="skill-plan-toggle" onclick={toggleContents}>
        {contentsShown ? "◂" : "▸"} {word(contentsShown ? "UI/SkillPlan/HideSkillPlanContents" : "UI/SkillPlan/ShowSkillPlanContents")}
      </button>
      {#if plan.completed}
        <div class="skill-plan-completed"><span aria-hidden="true">✔</span> {word("UI/SkillPlan/SkillPlanCompleted")}</div>
      {/if}
      {#if plan.description}
        <p class="skill-plan-description">{plan.description}</p>
      {/if}
      <!-- The milestones (SkillPlanProgressIndicator's, with MilestoneInfoTooltip's facts): each one's kind, its type or
           its skill and level, Completed where it is, else the time left to train what its type needs. Listed in the
           order the plan reaches them (GetMilestoneLastSkillIndex); the client's ring places them by a dict's order. -->
      {#if milestones !== undefined && milestones.planID === plan.id && milestones.list !== null && milestones.list.length > 0}
        {@const ordered = [...milestones.list].sort((a, b) => milestoneLastSkillIndex(a.needs, plan.requirements) - milestoneLastSkillIndex(b.needs, plan.requirements))}
        <div class="skill-plan-milestones">
          <h3 title={word("UI/SkillPlan/SkillMilestonesDescText")}>{word("UI/SkillPlan/Milestones")}</h3>
          <ul>
            {#each ordered as milestone (milestone.id)}
              <li class:completed={milestone.completed}>
                <span class="skill-plan-milestone-kind">{word(MILESTONE_KIND_LABELS[milestone.subType])}</span>
                <span class="skill-plan-milestone-name">{milestone.kind === "skill"
                  ? word("UI/InfoWindow/RequiredSkillNameAndLevel", { skill: milestone.typeID, level: romanLevel(milestone.level), levelColor: "#ffffff" })
                  : resolvedName($names.resolved, "type", milestone.typeID, "")}</span>
                {#if milestone.completed}
                  <span class="skill-plan-milestone-time"><span aria-hidden="true">✔</span> {word("UI/SkillPlan/Completed")}</span>
                {:else if milestone.trainingTicks !== null && milestone.trainingTicks > 0}
                  <span class="skill-plan-milestone-time">{word("UI/SkillPlan/TotalTrainingTime")} {interval(milestone.trainingTicks, "second")}</span>
                {/if}
              </li>
            {/each}
          </ul>
        </div>
      {/if}
      {#if contentsShown}
        <div class="skill-plan-contents">
          <div class="skill-plan-contents-head">
            <h3>{word("UI/SkillPlan/SkillPlanOverview")}</h3>
            <!-- The UtilMenu at the caption's right. -->
            <button type="button" class="skill-plan-contents-menu-button" aria-haspopup="menu" aria-expanded={contentsMenu !== null}
              aria-label={word("UI/SkillPlan/CopySkillsToClipboard")} title={word("UI/SkillPlan/CopySkillsToClipboard")}
              onclick={openContentsMenu}>☰</button>
          </div>
          {#if contentsMenu !== null}
            <span class="hull-menu skill-plan-contents-menu" role="menu" use:portal style:left={`${contentsMenu.left}px`} style:top={`${contentsMenu.top}px`}>
              <button type="button" role="menuitem" onclick={() => copySkills(plan)}>{word("UI/SkillPlan/CopySkillsToClipboard")}</button>
            </span>
          {/if}
          <div class="skill-plan-filters">
            <label><input type="checkbox" checked={hideTrained} onchange={(event) => setHideTrained((event.currentTarget as HTMLInputElement).checked)} />
              {word("UI/SkillPlan/HideTrainedSkills")}</label>
            <input type="search" bind:value={filter} aria-label="Filter" />
          </div>
          {#if contents === undefined || contents.planID !== plan.id}
            <p class="note">Reading the plan's skills…</p>
          {:else if contents.detail === null}
            <p class="error">Your skills could not be read.</p>
          {:else if shownRows.length === 0}
            <p class="empty">{word("UI/CharacterSheet/CharacterSheetWindow/SkillTabs/NoSkillsMatchingFilters")}</p>
          {:else}
            <ul class="skill-plan-rows">
              {#each shownRows as row, at (at)}
                {@const mark = rowMark(plan, row)}
                <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                <li class="skill-plan-row" class:selected={mark === "selected"} class:marked={mark === "marked"} aria-current={mark === "selected" ? "true" : undefined}
                  draggable="true" ondragstart={(event) => skillDrag(event, row.skill)} ondragend={endSkillDrag}
                  ondblclick={(event) => { if (!(event.target instanceof Element && event.target.closest("button"))) showInfo({ kind: "type", typeID: row.skill }); }}
                  oncontextmenu={(event) => openRowMenu(row.skill, event)}
                  onmouseenter={(event) => showRowTip(row.skill, event)} onmouseleave={() => hideRowTip(row.skill)}
                  onclick={(event) => { if (!(event.target instanceof Element && event.target.closest("button"))) void selectRow(plan, row, event.ctrlKey); }}
                  onkeydown={(event) => { if (event.key === "Enter") void selectRow(plan, row, event.ctrlKey); }}>
                  <span class="skill-bar" aria-hidden="true">
                    {#each row.boxes as one, box (box)}
                      <span class="skill-box {one.box}" class:partial={one.partial}></span>
                    {/each}
                  </span>
                  <span class="skill-plan-row-name">{word("UI/InfoWindow/RequiredSkillNameAndLevel", { skill: row.skill, level: romanLevel(row.level), levelColor: "#ffffff" })}</span>
                  <span class="skill-plan-row-time">{row.ticks === null ? "–" : interval(row.ticks, "minute")}</span>
                  <!-- The omega state opens the clone upgrade window (OnOmegaMissingAction), which is the store's: off here, and why. -->
                  <button type="button" class="skill-plan-row-button {row.button}" disabled={levelButtonOff(row.button) || row.button === "omega" || levelBusy}
                    title={row.button === "omega" ? withoutStore(levelHint(row)) : levelHint(row)} aria-label={levelHint(row)}
                    onclick={() => void levelAction(plan, row)}>{LEVEL_BUTTON_MARKS[row.button]}</button>
                </li>
              {/each}
            </ul>
            {#if rowTip !== null && rowInfo(rowTip.skill) !== null}
              <SkillRowTip {store} {flow} typeID={rowTip.skill} info={rowInfo(rowTip.skill)!} top={rowTip.top} left={rowTip.left} right={rowTip.right} onHover={rowTipHover} />
            {/if}
            {#if rowMenu !== null}
              {@const menuFor = rowMenu}
              <!-- Apply Skill Points: the contents read again once the points are in (OnSkillsChanged). The queue's
                   entries need nothing here: the contents are read again as the queue changes (OnSkillQueueChanged). -->
              <SkillRowMenu {store} {flow} skill={menuFor.skill} entries={menuFor.entries} x={menuFor.x} y={menuFor.y}
                onClose={() => { rowMenu = null; }}
                onApplied={() => { if (selected !== null) void readContents(selected); }} />
            {/if}
          {/if}
          <!-- UpdateOmegaBanner: Upgrade Clone State (SkillPlanOmegaButton) where the plan is omega locked, above the books'
               button; it opens the clone upgrade window, the store's, so it is off here, and says why. -->
          {#if contents !== undefined && contents.planID === plan.id && contents.detail !== null && contents.detail.omegaLocked}
            <button type="button" class="skill-plan-upgrade" disabled title={withoutStore(word("UI/CloneState/UpgradeCloneState"))}>
              <span aria-hidden="true">Ω</span> {word("UI/CloneState/UpgradeCloneState")}
            </button>
          {/if}
          {#if contents !== undefined && contents.planID === plan.id && contents.detail !== null && contents.detail.missingBooks.length > 0}
            {@const missing = contents.detail.missingBooks}
            <button type="button" class="skill-plan-buy-books" disabled={levelBusy}
              onclick={() => void buyMissingBooks(plan, missing)}>{word("UI/SkillPlan/BuyMissingSkillbooks", { numMissing: missing.length })}</button>
          {/if}
        </div>
      {/if}
      {#if notice}
        <p class="note">{notice}</p>
      {/if}
      {#if !plan.completed && contents !== undefined && contents.planID === plan.id && contents.detail !== null}
        {@const detail = contents.detail}
        {@const state = startTrainingState(detail)}
        <div class="skill-plan-foot">
          <div class="skill-plan-locks">
            <button type="button" class="skill-plan-lock books" class:locked={detail.missingBooks.length > 0}
              title={detail.missingBooks.length > 0 ? word("UI/SkillPlan/SkillbooksMissing", { numMissing: detail.missingBooks.length }) : word("UI/SkillPlan/NoSkillbooksMissing")}
              aria-label={detail.missingBooks.length > 0 ? word("UI/SkillPlan/SkillbooksMissing", { numMissing: detail.missingBooks.length }) : word("UI/SkillPlan/NoSkillbooksMissing")}
              onclick={toggleContents}>📖{#if detail.missingBooks.length > 0}<span class="skill-plan-lock-count">{detail.missingBooks.length}</span>{/if}</button>
            {#if detail.omegaLocked}
              <span class="skill-plan-lock-icon" aria-hidden="true">🔒</span>
              <!-- SkillPlanLockedCont.OnOmegaButton opens the clone upgrade window, the store's: not here, and its hint says why. -->
              <span class="skill-plan-lock omega locked" title={withoutStore(word("UI/SkillPlan/OmegaMissing", { numMissing: detail.numOmegaSkills }))}
                aria-label={word("UI/SkillPlan/OmegaMissing", { numMissing: detail.numOmegaSkills })}>Ω</span>
            {/if}
          </div>
          <button type="button" class="skill-plan-train" disabled={state !== "ready" || training}
            title={word(state === "locked" ? "UI/SkillPlan/StartTrainingLockedHint" : state === "nothing" ? "UI/SkillPlan/StartTrainingNothingToTrainHint" : "UI/SkillPlan/StartTrainingHint")}
            onclick={() => void startTraining(plan)}>{word("UI/SkillPlan/StartTraining")}</button>
        </div>
      {/if}
    </div>
  {:else if shownPanel === "certified"}
    <!-- The Certified Plans panel: the AIR plan alone until it is trained or queued, the career paths locked; then the
         career paths, the factions (none for the Industrialist) and the chosen ones' plans. -->
    {#if certified === undefined}
      <p class="note">Reading the certified plans…</p>
    {:else if certified === null}
      <p class="error">The client's certified plans could not be read.</p>
    {:else}
      {#if !certified.airFinished && airPlan !== null}
        <ul class="skill-plan-cards skill-plan-air">{@render planCard(airPlan, false)}</ul>
      {/if}
      <div class="skill-plan-careers" class:pictured={!limitedHeight} role="tablist">
        {#each certified.careerPaths as career (career.careerPathID)}
          {@const picture = limitedHeight ? null : careerIcon(career.careerPathID, 128)}
          {#if picture === null}
            <button type="button" role="tab" disabled={!certified.airFinished} aria-selected={careerPathID === career.careerPathID}
              class:selected={careerPathID === career.careerPathID}
              title={certified.airFinished ? message(career.descriptionID) : word("UI/SkillPlan/CareerPathsLockedByAIR")}
              onclick={() => chooseCareer(career.careerPathID)}>{message(career.nameID)}</button>
          {:else}
            <!-- CareerPathToggleButtonGroupButton: in a 270 by 290 frame, from the back, the two lines (at 80 to either
                 side, 92 selected), the selection highlight (smoke blue, 0.2 selected), the hexagon (0.1; 0.5 hovered,
                 1 selected), the glow (0.2; 0.8 selected), the fixed frame and the 80px icon (white; black selected);
                 under it the career's name and its info icon, the career's description its hint. -->
            <button type="button" role="tab" class="career-path" disabled={!certified.airFinished} aria-selected={careerPathID === career.careerPathID}
              class:selected={careerPathID === career.careerPathID}
              title={certified.airFinished ? undefined : word("UI/SkillPlan/CareerPathsLockedByAIR")}
              onclick={() => chooseCareer(career.careerPathID)}>
              <span class="career-path-art" aria-hidden="true">
                <span class="career-path-line left"></span>
                <span class="career-path-line right"></span>
                <span class="career-path-selection" style:mask-image={`url(${CAREER_BUTTON.selection})`} style:-webkit-mask-image={`url(${CAREER_BUTTON.selection})`}></span>
                <img class="career-path-hexagon" src={CAREER_BUTTON.hexagon} alt="" />
                <img class="career-path-glow" src={CAREER_BUTTON.glow} alt="" />
                <img class="career-path-fixed" src={CAREER_BUTTON.fixed} alt="" />
                <img class="career-path-icon" src={picture} alt="" />
              </span>
              <span class="career-path-title">
                <span class="career-path-name">{message(career.nameID)}</span>
                <img class="career-path-info" src={SKILL_PLAN_INFO_ICON} alt="" title={message(career.descriptionID)} />
              </span>
            </button>
          {/if}
        {/each}
      </div>
      {#if certified.airFinished}
        {#if careerPathID === null}
          <p class="skill-plan-hint">{word("UI/SkillPlan/SelectCareerPathHint")}</p>
        {:else}
          {#if careerPathID !== CAREER_PATH_INDUSTRIALIST}
            <!-- ConstructEmpireFactionTabGroup: a line across, the four factions' round buttons in its middle 45%
                 (EmpireFactionToggleButtonGroupButton: each its icon, the faction's name its hint). -->
            <div class="skill-plan-factions" role="radiogroup">
              <span class="faction-line outer"></span>
              {#each empireFactions() as faction (faction)}
                {@const icon = factionIcon(faction)}
                <span class="faction-slot">
                  <span class="faction-line"></span>
                  <button type="button" role="radio" class="circular" aria-checked={factionID === faction} class:selected={factionID === faction}
                    title={resolvedName($names.resolved, "faction", faction, "")} aria-label={resolvedName($names.resolved, "faction", faction, String(faction))}
                    onclick={() => { factionID = faction; }}>
                    {@render circularArt(icon, resolvedName($names.resolved, "faction", faction, String(faction)))}
                  </button>
                  <span class="faction-line"></span>
                </span>
              {/each}
              <span class="faction-line outer"></span>
            </div>
          {/if}
          <ul class="skill-plan-cards">
            {#each certifiedShown as plan (plan.id)}
              {@render planCard(plan, false)}
            {/each}
          </ul>
        {/if}
      {/if}
    {/if}
  {:else if shownPanel === "corporation"}
    <!-- The Corporation Plans panel: the category buttons, NumShown and the filter where there are plans; twelve to a
         page by name, the page buttons where there is more than one page. -->
    {#if corp === undefined}
      <p class="note">Reading your corporation's plans…</p>
    {:else if corp === null}
      <p class="error">{word("UI/SkillPlan/ConnectionError")}</p>
    {:else}
      {@const corpRead = corp}
      {#if corpRead.plans.length > 0}
        <div class="skill-plan-corp-filters">
          <div class="skill-plan-categories" role="group">
            <!-- ToggleButtonGroupCircular: each career path's 32px icon (CAREERS_32_SIZES) on a 48px round button, its
                 name the hint. -->
            {#each certified?.careerPaths ?? [] as career (career.careerPathID)}
              <button type="button" class="circular" aria-pressed={corpCategoryID === career.careerPathID} class:selected={corpCategoryID === career.careerPathID}
                title={message(career.nameID)} aria-label={message(career.nameID)} onclick={() => chooseCorpCategory(career.careerPathID)}>
                {@render circularArt(careerIcon(career.careerPathID, 32), message(career.nameID))}
              </button>
            {/each}
          </div>
          <span class="skill-plan-num-shown">{word("UI/SkillPlan/NumShown", { numShown: corpShown.length, numTotal: corpRead.plans.length })}</span>
          <input type="search" value={corpFilter} aria-label="Filter" oninput={(event) => setCorpFilter((event.currentTarget as HTMLInputElement).value)} />
        </div>
      {/if}
      {#if corpShown.length === 0}
        <p class="empty">{word(corpRead.plans.length > 0 ? "UI/SkillPlan/NoSkillPlansMatchingFilters" : "UI/SkillPlan/NoCorpSkillPlans")}</p>
      {:else}
        <ul class="skill-plan-cards">
          {#each corpShown as plan (plan.id)}
            {@render planCard(plan, corpRead.canEdit)}
          {/each}
        </ul>
        {#if corpPlanPages(corpAll.length) > 1}
          <div class="skill-plan-pages" role="group">
            {#each Array.from({ length: corpPlanPages(corpAll.length) }, (_, at) => at) as at (at)}
              <button type="button" aria-pressed={corpPage === at} class:selected={corpPage === at} onclick={() => { corpPage = at; }}>{at + 1}</button>
            {/each}
          </div>
        {/if}
      {/if}
      <!-- CreateCorpPlanButton (UpdateState): off without corpRoleSkillPlanManager or at a hundred plans. -->
      <button type="button" class="skill-plan-create" disabled={!corpRead.canEdit || corpRead.plans.length >= MAX_CORP_PLANS}
        title={createCorpTip(corpRead.plans.length, corpRead.canEdit)} onclick={() => edit(null, true)}>{word("UI/SkillPlan/CreateNewSkillPlan")}</button>
    {/if}
  {:else if read === undefined}
    <p class="note">Reading your skill plans…</p>
  {:else if read === null}
    <p class="error">{word("UI/SkillPlan/ConnectionError")}</p>
  {:else if plans.length === 0}
    <p class="empty">{word("UI/SkillPlan/NoPersonalSkillPlans")}</p>
    <button type="button" class="skill-plan-create" title={createTip(0)} onclick={() => edit(null)}>{word("UI/SkillPlan/CreateNewSkillPlan")}</button>
  {:else}
    <ul class="skill-plan-cards">
      {#each plans as plan (plan.id)}
        {@render planCard(plan, true)}
      {/each}
    </ul>
    <button type="button" class="skill-plan-create" disabled={plans.length >= MAX_PERSONAL_PLANS} title={createTip(plans.length)}
      onclick={() => edit(null)}>{word("UI/SkillPlan/CreateNewSkillPlan")}</button>
  {/if}
  {#if menuUp && menu !== null}
    {@const menuFor = menu}
    <span class="hull-menu" role="menu" use:portal style:left={`${menuFor.x}px`} style:top={`${menuFor.y}px`}>
      <button type="button" role="menuitem" onclick={() => edit(menuFor.plan)}>{word("UI/Neocom/Edit")}</button>
      <button type="button" role="menuitem" onclick={() => void deletePlan(menuFor.plan)}>{word("UI/Common/Buttons/Delete")}</button>
    </span>
  {/if}
</section>

<style>
  .skill-plan-tabs, .skill-plan-careers { display: flex; flex-wrap: wrap; gap: 0.35rem; }
  .skill-plan-tabs button.selected, .skill-plan-careers button.selected:not(.career-path) { outline: 1px solid currentColor; }
  .skill-plan-careers { margin: 0.5rem 0; }
  .skill-plan-careers button { flex: 1; min-height: 2.5rem; }
  /* The career paths' pictures (CareerPathToggleButtonGroupButton), the group 315 high with 50 below. */
  .skill-plan-careers.pictured { flex-wrap: nowrap; gap: 0; margin: 0 0 50px; height: 315px; }
  .career-path { position: relative; flex: 1; min-width: 0; height: 315px; padding: 0; border: 0; background: none; color: inherit; font: inherit; cursor: pointer; }
  .career-path:disabled { cursor: default; }
  .career-path-art { position: absolute; left: 50%; top: 0; width: 270px; height: 290px; transform: translateX(-50%); pointer-events: none; }
  .career-path-art > * { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); }
  .career-path-line { width: 2px; height: 45px; background: #ffffff; opacity: 0.6; transition: opacity 0.15s, margin-left 0.15s; }
  .career-path-line.left { margin-left: -80px; }
  .career-path-line.right { margin-left: 80px; }
  .career-path-selection { width: 246px; height: 279px; background: #305665; opacity: 0; mask-size: 100% 100%; -webkit-mask-size: 100% 100%; transition: opacity 0.15s; }
  .career-path-hexagon { width: 140px; height: 162px; opacity: 0.1; transition: opacity 0.15s; }
  .career-path-glow { width: 270px; height: 290px; opacity: 0.2; transition: opacity 0.15s; }
  .career-path-fixed { width: 182px; height: 162px; }
  .career-path-icon { width: 80px; height: 80px; transition: filter 0.15s; }
  .career-path:not(:disabled):not(.selected):hover .career-path-hexagon { opacity: 0.5; }
  .career-path.selected .career-path-line { opacity: 1; }
  .career-path.selected .career-path-line.left { margin-left: -92px; }
  .career-path.selected .career-path-line.right { margin-left: 92px; }
  .career-path.selected .career-path-selection { opacity: 0.2; }
  .career-path.selected .career-path-hexagon { opacity: 1; }
  .career-path.selected .career-path-glow { opacity: 0.8; }
  .career-path.selected .career-path-icon { filter: brightness(0); }
  .career-path:disabled .career-path-icon { opacity: 0.1; }
  .career-path-title { position: absolute; left: 50%; bottom: 0; height: 30px; display: flex; align-items: center; gap: 10px; transform: translateX(-50%);
    white-space: nowrap; font-size: 1.25rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .career-path-info { width: 20px; height: 20px; }
  /* The empire factions: 48 high, 25 above and below; the line at 0.1 across, broken by each round button. */
  .skill-plan-factions { display: flex; align-items: center; height: 48px; margin: 25px 0; }
  .faction-line { flex: 1; height: 2px; background: #ffffff; opacity: 0.1; }
  .faction-line.outer { flex: 0 0 27.5%; }
  .faction-slot { flex: 1; display: flex; align-items: center; }
  /* ToggleButtonGroupButtonCircular, 48 round with a 32 icon. */
  .circular { position: relative; flex: none; width: 48px; height: 48px; min-height: 0; padding: 0; border: 0; background: none; color: inherit; cursor: pointer; }
  .circular > * { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); pointer-events: none; }
  .circular-stroke, .circular-fill { width: 48px; height: 48px; }
  .circular-stroke { opacity: 0.1; }
  .circular-fill { opacity: 0; transition: opacity 0.15s; }
  .circular-glow { width: 96px; height: 96px; max-width: none; opacity: 0; transition: opacity 0.15s; }
  .circular-icon { width: 32px; height: 32px; transition: filter 0.15s; }
  .circular-label { font-size: 0.9rem; white-space: nowrap; }
  .circular:not(.selected):hover .circular-fill { opacity: 0.5; }
  .circular.selected .circular-fill, .circular.selected .circular-glow { opacity: 1; }
  .circular.selected .circular-icon { filter: brightness(0); }
  .circular.selected .circular-label { color: #000000; }
  /* The opened plan's faction and career path icons (ConstructIconCont: 32 high, 6 above, each at half opacity). */
  .skill-plan-view-icons { display: flex; justify-content: space-between; height: 32px; margin-top: 6px; }
  .skill-plan-view-icons img { opacity: 0.5; }
  .skill-plan-view-icons img.career { margin-left: auto; }
  .skill-plan-hint { text-align: center; font-size: 1.1rem; opacity: 0.8; }
  .skill-plan-air { max-width: 20rem; margin: 0 auto 0.75rem; }
  /* corpPlansPanel: the category buttons at the left, NumShown and the filter at the right; the page buttons below. */
  .skill-plan-corp-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; margin-bottom: 0.75rem; }
  .skill-plan-categories, .skill-plan-pages { display: flex; flex-wrap: wrap; gap: 0.35rem; }
  .skill-plan-categories { flex: 1; }
  .skill-plan-pages { margin-top: 0.75rem; }
  .skill-plan-pages button.selected { outline: 1px solid currentColor; }
  /* SkillPlanScroll: as many to a row as fit at 325 wide, each entry 134 high. */
  .skill-plan-cards { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr)); gap: 0.75rem; }
  .skill-plan-card { position: relative; width: 100%; display: flex; flex-direction: column; justify-content: flex-end; align-items: stretch; gap: 0.5rem;
    min-height: 5.5rem; padding: 0.75rem 2rem 0.75rem 1rem; text-align: left; font: inherit; color: inherit; cursor: pointer;
    border: 1px solid var(--line, #333); background: var(--panel-raised, rgba(255, 255, 255, 0.04)); }
  .skill-plan-card:hover { background: rgba(255, 255, 255, 0.08); }
  .skill-plan-name { font-size: 1.15rem; overflow-wrap: anywhere; }
  .skill-plan-tracked { position: absolute; top: 0.6rem; right: 0.7rem; }
  .skill-plan-time { display: flex; justify-content: space-between; align-items: center; }
  /* GaugeMultiValue: four high on a dark track; eveColor.WHITE, then eveColor.CRYO_BLUE. */
  .skill-plan-gauge { display: flex; height: 4px; background: rgba(0, 0, 0, 0.4); overflow: hidden; }
  .skill-plan-gauge-trained { background: #ffffff; }
  .skill-plan-gauge-training { background: #58a7bf; }
  .skill-plan-marks { display: flex; gap: 0.5rem; align-items: center; }
  /* SkillPlanEntryTooltip: a standard tooltip, one column; its rows' icons twenty wide, each count in a badge. */
  .skill-plan-tip { position: fixed; z-index: 60; display: flex; flex-direction: column; gap: 0.45rem; width: max-content; max-width: 17rem;
    padding: 0.6rem 0.75rem; border: 1px solid var(--line, #333); background: rgba(10, 12, 16, 0.96); pointer-events: none; }
  .skill-plan-tip p { margin: 0; overflow-wrap: anywhere; }
  .skill-row-tip { width: 17rem; }
  .skill-row-tip-pair { display: flex; justify-content: space-between; gap: 0.75rem; }
  .skill-row-tip-queued { color: #58a7bf; }
  .skill-plan-tip-row { display: flex; align-items: center; gap: 0.6rem; }
  .skill-plan-tip-icon { width: 1.25rem; text-align: center; }
  .skill-plan-tip-icon.books { color: #e05a4f; }
  .skill-plan-tip-icon.omega { color: #e8b34a; }
  .skill-plan-tip-count { padding: 0 0.3rem; border-radius: 0.3rem; background: rgba(255, 255, 255, 0.15); }
  .skill-plan-omega { color: #e8b34a; }
  /* TextColor.SUCCESS where the plan is completed. */
  .skill-plan-time.completed { color: #4caf50; }
  /* CreatePersonalPlanButton: 200 by 70, its words large. */
  .skill-plan-create { display: block; margin: 0.75rem auto 0; min-width: 12rem; min-height: 3rem; font-size: 1.05rem; }

  .skill-plan-view { display: flex; flex-direction: column; gap: 0.75rem; padding: 0.75rem 1rem 1rem; border: 1px solid var(--line, #333); background: rgba(0, 0, 0, 0.6); }
  .skill-plan-view-head { display: flex; align-items: baseline; gap: 0.75rem; }
  .skill-plan-caption { font-size: 0.8rem; text-transform: uppercase; opacity: 0.7; }
  .skill-plan-view-name { flex: 1; font-size: 1.3rem; overflow-wrap: anywhere; }
  .skill-plan-view-buttons { display: flex; gap: 0.4rem; }
  .skill-plan-track.tracked { outline: 1px solid currentColor; }
  .skill-plan-toggle { align-self: stretch; text-align: left; }
  /* PlanCompletedBanner: the completed mark on COPPER_OXIDE_GREEN, the words black on white. */
  .skill-plan-completed { display: flex; align-items: center; gap: 0.6rem; padding: 0.4rem 0.75rem; color: #000; background: #fff; border-left: 2.6rem solid #3c8a5e; }
  .skill-plan-description { margin: 0; white-space: pre-wrap; }
  .skill-plan-milestones h3 { margin: 0 0 0.35rem; }
  .skill-plan-milestones ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.3rem; }
  .skill-plan-milestones li { display: flex; align-items: center; gap: 0.75rem; padding: 0.3rem 0.5rem; background: rgba(255, 255, 255, 0.04); }
  .skill-plan-milestone-kind { min-width: 5rem; font-size: 0.8rem; text-transform: uppercase; opacity: 0.7; }
  .skill-plan-milestone-name { flex: 1; }
  .skill-plan-milestones li.completed .skill-plan-milestone-time { color: #4caf50; }
  .skill-plan-contents { display: flex; flex-direction: column; gap: 0.5rem; }
  .skill-plan-contents h3 { margin: 0; }
  .skill-plan-filters { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; }
  .skill-plan-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .skill-plan-row { display: flex; align-items: center; gap: 0.75rem; min-height: 2rem; padding: 0 0.5rem; background: rgba(255, 255, 255, 0.04); }
  .skill-plan-row-name { flex: 1; }
  .skill-plan-row-time { opacity: 0.35; }
  /* ListEntryUnderlay: the selected row, and a row marked (SkillEntryUnderlay's hover look). */
  .skill-plan-row { cursor: pointer; }
  .skill-plan-row.selected { background: rgba(255, 255, 255, 0.16); outline: 1px solid rgba(255, 255, 255, 0.35); }
  .skill-plan-row.marked { background: rgba(255, 255, 255, 0.1); }
  .skill-plan-contents-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
  /* The share button: a drag source, drawn as the view's buttons are. */
  .skill-plan-share { display: inline-flex; align-items: center; justify-content: center; min-width: 2rem; padding: 0.15rem 0.4rem;
    border: 1px solid var(--line, #333); cursor: grab; user-select: none; }
  /* SkillLevelEntryPrimaryButton: 36 wide at the row's right; DANGER for a book to buy, MONETIZATION for omega. */
  .skill-plan-row-button { min-width: 2.25rem; }
  .skill-plan-row-button.book { color: #e05a4f; }
  .skill-plan-row-button.omega { color: #e8b34a; }
  .skill-plan-buy-books { display: block; width: 100%; margin-top: 0.5rem; color: #e05a4f; }
  /* SkillPlanOmegaButton: the MONETIZATION style, 36 high, ten above the books' button. */
  .skill-plan-upgrade { display: block; width: 100%; min-height: 2.25rem; margin-top: 0.6rem; color: #e8b34a; }
  .skill-plan-foot { display: flex; flex-direction: column; align-items: stretch; gap: 0.5rem; }
  .skill-plan-locks { display: flex; justify-content: center; align-items: center; gap: 1rem; }
  /* The lock buttons (lockButton.py): the books' framed white, PRIMARY_BLUE where locked, with the count on HOT_RED;
     the omega one SAND_YELLOW where locked. */
  .skill-plan-lock { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 2.5rem; height: 2.5rem;
    border: 1px solid #fff; background: rgba(60, 138, 94, 0.3); }
  .skill-plan-lock.books.locked { border-color: #58a7bf; background: rgba(55, 73, 87, 0.3); }
  .skill-plan-lock.omega.locked { border-color: #d8b25a; background: rgba(160, 120, 50, 0.3); }
  .skill-plan-lock-count { position: absolute; right: -0.4rem; bottom: -0.4rem; min-width: 1.1rem; height: 1.1rem; border-radius: 50%;
    font-size: 0.7rem; line-height: 1.1rem; text-align: center; color: #fff; background: #dd2c2c; }
  .skill-plan-lock-icon { color: #dd2c2c; }
  /* The skill bar's boxes, as the skill requirement window draws them (skillLevel.py). */
  .skill-bar { display: inline-flex; gap: 2px; }
  .skill-box { width: 8px; height: 8px; box-sizing: border-box; }
  .skill-box.none { visibility: hidden; }
  .skill-box.trained { background: rgba(204, 204, 204, 1); }
  .skill-box.training { background: rgba(204, 204, 204, 0.6); outline: 1px solid rgba(204, 204, 204, 1); }
  .skill-box.queued { background: #3ea8d9; }
  .skill-box.untrained { background: rgba(255, 255, 255, 0.3); }
  .skill-box.small { width: 4px; height: 4px; margin: 2px; background: rgba(255, 255, 255, 0.3); }
  .skill-box.trained-omega { background: rgba(252, 194, 7, 0.8); }
  .skill-box.small-omega { width: 4px; height: 4px; margin: 2px; background: rgba(252, 194, 7, 0.6); }
  .skill-box.partial { outline: 1px solid rgba(204, 204, 204, 1); }
</style>
