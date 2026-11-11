<script lang="ts">
  // The client's skill plan editor (skillPlanEditor/skillPlanEditorPanel.py), for a new personal or corporation plan or
  // a copy of one to edit (skillPlanPanel.OnCreateNewPersonalSkillPlanButton, OnCreateNewCorpSkillPlanButton,
  // OnEditSkillPlanButton: skillPlan.GetCopy()). Its rules
  // are bridge/skillPlanEditor.ts; every change of the skills goes through the client's validation
  // (bridge/skillPlanValidation.ts, as EditableSkillPlanController does).
  //
  //   Back            ShouldContinueAfterAskingAboutLeavingEditor: AskCloseSkillPlanEditor where the plan was changed
  //   the catalogue   SkillsCataloguePanel: its caption Skills, the text filter, the groups, a group's skills, each
  //                   with its add button (EditorSkillEntryPrimaryButton: the next level, hinted AddSkillLevelToPlan,
  //                   or off with AllLevelsInPlan where V is in the plan)
  //   the contents    SkillPlanEditorContents: the caption Skill Plan and the count of levels, the filter, each level
  //                   ("skill level") with its remove button (EditorSkillLevelEntryPrimaryButton: RemoveFromPlan, or off
  //                   with RemoveFromPlanLocked where it may not go); NoSkillsInPlanHint with none,
  //                   NoSkillsMatchingFilters with none shown
  //   the overview    SkillPlanEditorOverview: Name (50 letters, counted, hinted EnterPlanName), Description (1000
  //                   letters, hinted EnterPlanDescription), Clear (the skills, the name and the description) and Save
  //                   (off with CantSaveTooltip with no skill or no name)
  //   the category    a corporation plan's only (HasEditableCategoryID): the overview's Category combo, None and then the
  //                   career paths in the client's table's order (_GetCategoryComboOptions); Clear puts it back to None;
  //                   Save sends it (OnSaveButton: SetCategoryID from the combo)
  //
  //   milestones      the overview's milestone editor (SkillPlanProgressIndicatorEditable and its header): Milestones
  //                   with the count of five, each milestone's kind and name with its Remove Milestone, an empty slot
  //                   while one is free; a skill level dragged from the contents, a skill from the catalogue, or an
  //                   item or a fitted module (its type) dropped on it is added, and on a milestone replaces it after
  //                   the client's question (a saved fitting: CantAddAsMilestone)
  //                   (bridge/skillPlanEditorMilestones.ts); an edited plan's milestones are its own, copied (GetCopy)
  //
  //   the contents' drags   SkillPlanEditorContents OnDropData and OnEntryDropData: a level dragged onto a level moves
  //                   above it, onto the list's end to the end (MoveSkillRequirement, only where the plan stays valid; the
  //                   line where it would land, grey where the move is valid and red where not); with Shift, the skill's
  //                   next level put in above it (where IsSkillInsertionValid) or at the end; a skill from the catalogue
  //                   put in above a level or at the end (InsertSkillRequirement, AppendSkillRequirement); a saved
  //                   fitting (the fitting window's, as FittingEntry) its hull's and modules' needs appended where the
  //                   plan lacks them (_OnDropFitting, BulkAddAllSkillsRequiredFor); an item or a fitted module its
  //                   type's requirements (_OnTypeDropData, _AddRequirementsForType: a milestone made of it where one
  //                   is free, else its needs alone; nothing for a type that can be no milestone)
  //   double clicks   a level's: its skill's next level appended (OnEntryDblClicked); a catalogue skill's: Show Info
  //   selection       a level clicked: selected, the others marked by how they stand to it (OnEntryClicked,
  //                   GetRequirementStateForEntry); Ctrl and a click on the selected one: none
  //   the contents' menu  GetUtilMenu: Copy Skills to Clipboard, Import Skills from Clipboard (its hint the client's
  //                   format examples; the queue's importer, the BFF's port), Clear Skills (and the milestones)
  //
  //   the catalogue's filter  SkillFilterCombo (kept as skillEditorCatalogueCombo): Show All, Injected, Trainable Now,
  //                   Have Prerequisites (SkillGroupController.GetSkillsFiltered, bridge/skillPlanEditor.ts
  //                   CatalogueSkillState), with the text filter too
  //   the groups      SkillGroupEntry: the group's icon (ICON_BY_GROUPID), its name, how many of its skills the filters
  //                   keep (none: no number and the entry faded), its bar of levels trained of all its skills' and an
  //                   alpha clone's levels past its ceiling in omega orange
  //   a catalogue skill  SkillGroupSkillEntry: its menu (GetMenu: GetMenuForSkill, SkillRowMenu) and its tooltip below it
  //                   (LoadSkillEntryTooltipInfoOnly, SkillRowTip; none while dragging)
  //
  //   the catalogue's rest  SkillGroupSkillEntry: the skill's bar (SkillBar) and its next level's own time, dimmed
  //                   (UpdateTrainingTimeLabel); SkillGroupEntry's tooltip (SkillGroupTip); the pilot's skill points above
  //                   them (skillPointsLabel: GetTotalSkillPointsForCharacter, then every two seconds while a skill trains
  //                   GetEstimatedTotalSkillPoints); all read again as the queue or the skills change (_OnSkillsStateChanged)
  //
  // Not done: the end line while an item is dragged over (its type is not readable before the drop), fittings dragged
  // as text links, a milestone's level changed in its tooltip, the ring.
  import { onMount, untrack } from "svelte";
  import type { SkillPlanTemplate } from "./skillPlanTemplate.ts";
  import SkillGroupTip from "./SkillGroupTip.svelte";
  import { serverNow, trainingReadout } from "../bridge/skills.ts";
  import { shortWrittenInterval } from "../bridge/timeInterval.ts";
  import { portal } from "./portal.ts";
  import SkillRowMenu from "./SkillRowMenu.svelte";
  import SkillRowTip from "./SkillRowTip.svelte";
  import { endSkillDrag, startSkillDrag } from "./skillDrag.ts";
  import { DRAG_MIME, decodeDrag } from "./dragDrop.ts";
  import { droppedFittingDrag, isFittingDrag, type DraggedFitting } from "./fittingDrag.ts";
  import { skillGroupIcon } from "./skillGroupIcons.ts";
  import { skillMenuEntries, type SkillMenuEntry } from "../bridge/skillMenu.ts";
  import type { SkillRowInfo } from "../bridge/skillPlans.ts";
  import { showInfo } from "./showInfo.ts";
  import { planRowRequirement } from "../bridge/skillPlans.ts";
  import type { SkillPlanValidationFacts } from "../bridge/skillPlanValidation.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { nextLocalID } from "../app/localID.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { romanLevel } from "../bridge/skills.ts";
  import { validateSkillPlan, type SkillLevel } from "../bridge/skillPlanValidation.ts";
  import { milestoneSubType, requiredSkillsRecursiveAsDict, type Milestone } from "../bridge/skillPlanMilestones.ts";
  import {
    MAX_NUM_MILESTONES, copiedMilestones, dropped, milestonesChanged, typeValidAsMilestone, withMilestoneAdded,
    withMilestoneRemoved, withMilestonesCheckedAgainst, withTypeRequirementsAdded, type EditorMilestones,
  } from "../bridge/skillPlanEditorMilestones.ts";
  import type { PersonalSkillPlanEntry } from "../bridge/skillPlans.ts";
  import {
    MAX_PLAN_DESCRIPTION_LENGTH, MAX_PLAN_NAME_LENGTH, canRemoveLevel, canSavePlan, catalogueGroups, catalogueSearch,
    editedPlanDiffers, highestPlanLevel, nextPlanLevel, withLevelAppended, withLevelRemoved, type CatalogueGroup,
    insertionIsValid, moveIsValid, planLevelIndex, withLevelInserted, withLevelMoved, withLevelsAppended,
    CATALOGUE_FILTERS, catalogueSkillPasses, groupProgress, type CatalogueFilter, type CatalogueSkillRow, groupSummary,
    withNeedsOfTypesAppended,
  } from "../bridge/skillPlanEditor.ts";

  let { store, flow, plan, planCount, onClose, corp = null, template = null }: {
    store: ClientStore;
    flow: AppFlow;
    /** The plan edited, or null for a new one. */
    plan: PersonalSkillPlanEntry | null;
    /** How many plans of its kind there are (the new plan's limit): personal ones, or the corporation's. */
    planCount: number;
    /** Gone back, the plan saved or not. */
    onClose: (saved: boolean) => void;
    /** A corporation plan's: its category (null for a new plan, None chosen) and the career paths to choose from. */
    corp?: { readonly categoryID: number | null; readonly categories: readonly { readonly id: number; readonly name: string }[] } | null;
    /** A new plan's template (skillPlanTemplate.ts), applied as the editor opens. */
    template?: SkillPlanTemplate | null;
  } = $props();

  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // The Category combo's value (0: None).
  // svelte-ignore state_referenced_locally
  let categoryID = $state(corp?.categoryID ?? 0);

  const OWN: Readonly<Record<string, string>> = {
    "UI/CharacterSheet/CharacterSheetWindow/SkillTabs/SkillPoints": "{[numeric]skillPoints, useGrouping} skill points",
    // SkillFilterCombo's options.
    "UI/CharacterSheet/CharacterSheetWindow/SkillTabs/ShowAllSkills": "Every skill",
    "UI/CharacterSheet/CharacterSheetWindow/SkillTabs/ShowOnlyCurrentSkills": "Skills you have",
    "UI/CharacterSheet/CharacterSheetWindow/SkillTabs/ShowOnlyTrainableSkills": "Skills you can train now",
    "UI/CharacterSheet/CharacterSheetWindow/SkillTabs/ShowOnlyHavePrerequisits": "Skills whose needs you meet",
    "UI/SkillPlan/CopySkillsToClipboard": "Copy the plan's skills",
    "UI/SkillPlan/ImportSkillsFromClipboard": "Add the skills on the clipboard",
    "UI/SkillPlan/ClearSkills": "Take every skill out",
    "UI/SkillQueue/ImportSkillplanFormatHint": "One skill to a line, its name and then its level: {[item]typeID.name} 3, or {[item]typeID.name} III",
    "UI/SkillPlan/Skills": "Skills",
    "UI/SkillPlan/SkillPlan": "Plan",
    "UI/SkillPlan/AddSkillLevelToPlan": "Put level {skillLevel} of it in the plan",
    "UI/SkillPlan/AllLevelsInPlan": "Every level of it is in the plan",
    "UI/SkillPlan/RemoveFromPlan": "Take this level out of the plan",
    "UI/SkillPlan/RemoveFromPlanLocked": "Another skill in the plan needs this level",
    "UI/SkillPlan/NoSkillsInPlanHint": "No skill is in the plan yet.",
    "UI/CharacterSheet/CharacterSheetWindow/SkillTabs/NoSkillsMatchingFilters": "No skill shown with these filters",
    "UI/Common/Name": "Name",
    "UI/Common/Description": "Description",
    "UI/Common/Category": "Category",
    "UI/Generic/None": "None",
    "UI/SkillPlan/EnterPlanName": "The plan's name",
    "UI/SkillPlan/EnterPlanDescription": "What the plan is for",
    "UI/Inventory/Clear": "Clear",
    "UI/Common/Buttons/Save": "Save",
    "Tooltips/SkillPlanner/CantSaveTooltip": "A plan wants a name and a skill before it is saved.",
    "UI/InfoWindow/RequiredSkillNameAndLevel": "{[item]skill.name} {level}",
    "UI/SkillPlan/Milestones": "Milestones",
    "UI/SkillPlan/SkillMilestonesDescText": "Points of the plan worth reaching on the way.",
    "UI/SkillPlan/RemoveMilestone": "Remove",
    "UI/SkillPlan/AddingMilestones": "Adding milestones",
    "UI/SkillPlan/MilestonesDragDropInformation": "Drag a skill or a level of one here to make it a milestone.",
    "UI/SkillPlan/MilestoneShip": "Ship",
    "UI/SkillPlan/MilestoneSkill": "Skill",
    "UI/SkillPlan/MilestoneModule": "Module",
    "UI/SkillPlan/MilestoneOther": "Other",
    "Tooltips/SkillPlanner/SkillPlanNameStringWithType": "A plan for {typeName}",
  };

  function word(label: string, args: Readonly<Record<string, string | number>> = {}): string {
    const template = $words.templates[label];
    const text = typeof template === "string" ? template : OWN[label];
    return text === undefined ? "" : plainText(formatTemplate(text, args, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") }));
  }

  // The plan as edited (a copy: nothing is saved until Save).
  // svelte-ignore state_referenced_locally
  let name = $state(plan?.name ?? "");
  // svelte-ignore state_referenced_locally
  let description = $state(plan?.description ?? "");
  // svelte-ignore state_referenced_locally
  let requirements = $state<SkillLevel[]>(plan ? plan.requirements.map(([skill, level]) => [skill, level] as const) : []);
  let saving = $state(false);
  let working = $state(false);
  let note = $state("");

  const edited = $derived({ name, description, requirements });

  // The catalogue.
  let groups = $state<CatalogueGroup[] | null | undefined>(undefined);
  let selectedGroupID = $state<number | null>(null);
  let catalogueFilter = $state("");
  // SkillFilterCombo: its choice kept (settings.char.ui skillEditorCatalogueCombo), Show All where none was kept.
  const CATALOGUE_COMBO_KEY = "evejs.skillEditorCatalogueCombo";
  function keptCatalogueFilter(): CatalogueFilter {
    try {
      const kept = localStorage.getItem(CATALOGUE_COMBO_KEY);
      return CATALOGUE_FILTERS.some((filter) => filter.id === kept) ? (kept as CatalogueFilter) : "alltrainable";
    } catch {
      return "alltrainable";
    }
  }
  let catalogueFilterID = $state<CatalogueFilter>(keptCatalogueFilter());
  function chooseCatalogueFilter(id: CatalogueFilter): void {
    catalogueFilterID = id;
    try {
      localStorage.setItem(CATALOGUE_COMBO_KEY, id);
    } catch {
      // Not kept; chosen all the same.
    }
  }
  /** The catalogue's skills as the skill controllers answer them; none until read (the filters then keep all). */
  let catalogueStates = $state<ReadonlyMap<number, CatalogueSkillRow>>(new Map());
  /** Each group's certificates claimed and of all, read with the catalogue. */
  let groupCertificates = $state<ReadonlyMap<number, { readonly claimed: number; readonly total: number }>>(new Map());
  async function readCatalogueStates(): Promise<void> {
    if (!groups) return;
    const [states, certificates] = await Promise.all([
      flow.skillCatalogueStates(groups.flatMap((group) => group.skills.map((skill) => skill.typeID))),
      flow.skillGroupCertificates(groups.map((group) => group.groupID)),
    ]);
    if (states !== null) catalogueStates = states;
    if (certificates !== null) groupCertificates = certificates;
  }

  // _OnSkillsStateChanged: the entries read again as the queue or the skills change (the first read is the mount's).
  // svelte-ignore state_referenced_locally
  const skillsSheet = store.skills;
  let statesFor: string | null = null;
  $effect(() => {
    const sheet = $skillsSheet;
    const key = (sheet.queue?.entries ?? []).map((entry) => entry.typeID + ":" + entry.toLevel).join(",") + "|" + (sheet.totalSkillPoints ?? "");
    untrack(() => {
      if (statesFor === null) {
        statesFor = key;
        return;
      }
      if (key === statesFor) return;
      statesFor = key;
      void readCatalogueStates();
    });
  });

  // skillPointsLabel: SkillPoints with GetTotalSkillPointsForCharacter (the points of every skill, lapsed counted, and
  // the free ones); while a skill trains, every two seconds GetEstimatedTotalSkillPoints (that skill's points as the
  // service holds them taken off, its estimate now put on).
  let pointsClock = $state(Date.now());
  const skillPointsShown = $derived.by(() => {
    const sheet = $skillsSheet;
    if (sheet.totalSkillPoints === null) return null;
    const readout = trainingReadout(sheet.queue, serverNow(sheet.clockOffsetMs, pointsClock));
    if (readout === null) return sheet.totalSkillPoints;
    const cached = catalogueStates.get(readout.typeID)?.cachedPoints;
    return cached === undefined ? sheet.totalSkillPoints : sheet.totalSkillPoints - cached + Math.trunc(readout.skillPoints);
  });

  /** FormatTimeIntervalShortWritten, day to minute. */
  function interval(ticks: number): string {
    const written = shortWrittenInterval(BigInt(Math.trunc(ticks)), $words.templates, "day", "minute");
    if (written !== null) return written;
    const minutes = Math.ceil(ticks / 600_000_000);
    const [days, hours, mins] = [Math.floor(minutes / 1440), Math.floor((minutes % 1440) / 60), minutes % 60];
    return [days > 0 ? days + "d" : "", hours > 0 ? hours + "h" : "", mins + "m"].filter(Boolean).join(" ");
  }

  // SkillGroupEntry.LoadTooltipPanel: below the group, with its attributes' names and pictures read once.
  let groupTip = $state<{ readonly groupID: number; readonly top: number; readonly left: number } | null>(null);
  let attributeShown = $state<ReadonlyMap<number, { readonly displayNameID: number | null; readonly iconFile: string | null }>>(new Map());
  function showGroupTip(groupID: number, event: Event): void {
    if (dragging !== null || !(event.currentTarget instanceof HTMLElement)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    groupTip = { groupID, top: rect.bottom + 6, left: rect.left };
  }
  const passes = (typeID: number): boolean => catalogueSkillPasses(catalogueStates.get(typeID), catalogueFilterID);
  const shownSkills = $derived(
    (!groups ? [] : catalogueFilter !== "" ? catalogueSearch(groups, catalogueFilter) : groups.find((group) => group.groupID === selectedGroupID)?.skills ?? [])
      .filter((skill) => passes(skill.typeID)),
  );
  /** UpdateSkillGroupNumFilteredLabels: how many of each group's skills the filter and the text keep. */
  function groupCount(group: CatalogueGroup): number {
    const text = catalogueFilter.toLowerCase();
    return group.skills.filter((skill) => passes(skill.typeID) && (text === "" || skill.name.toLowerCase().includes(text))).length;
  }

  // A catalogue skill's tooltip and menu (SkillGroupSkillEntry LoadTooltipPanel, GetMenu), read for the skill as they
  // are asked and kept while the editor is open.
  let skillInfos = $state<ReadonlyMap<number, SkillRowInfo>>(new Map());
  async function infoOf(typeID: number): Promise<SkillRowInfo | null> {
    const kept = skillInfos.get(typeID);
    if (kept !== undefined) return kept;
    const read = await flow.skillRowInfoFor([typeID]);
    const info = read?.get(typeID) ?? null;
    if (info !== null) skillInfos = new Map([...skillInfos, [typeID, info]]);
    return info;
  }
  let catalogueTip = $state<{ readonly typeID: number; readonly top: number; readonly left: number } | null>(null);
  async function showCatalogueTip(typeID: number, event: Event): Promise<void> {
    if (dragging !== null || catalogueMenu !== null || !(event.currentTarget instanceof HTMLElement)) return;
    // GetTooltipPointer: POINT_BOTTOM_2, below the entry.
    const rect = event.currentTarget.getBoundingClientRect();
    catalogueTip = { typeID, top: rect.bottom + 8, left: rect.left };
    await infoOf(typeID);
  }
  // The tooltip stays while the pointer is on it (its panel takes the pointer): taken away a moment after the pointer
  // leaves the skill, unless it came onto the tooltip.
  let catalogueTipHeld = false;
  let catalogueTipTimer: ReturnType<typeof setTimeout> | null = null;
  function hideCatalogueTip(typeID: number): void {
    if (catalogueTipTimer !== null) clearTimeout(catalogueTipTimer);
    catalogueTipTimer = setTimeout(() => {
      catalogueTipTimer = null;
      if (!catalogueTipHeld && catalogueTip !== null && catalogueTip.typeID === typeID) catalogueTip = null;
    }, 200);
  }
  function catalogueTipHover(inside: boolean): void {
    catalogueTipHeld = inside;
    if (!inside && catalogueTip !== null) hideCatalogueTip(catalogueTip.typeID);
  }
  let catalogueMenu = $state<{ readonly typeID: number; readonly entries: readonly SkillMenuEntry[]; readonly x: number; readonly y: number } | null>(null);
  async function openCatalogueMenu(typeID: number, event: MouseEvent): Promise<void> {
    event.preventDefault();
    catalogueTip = null;
    const { clientX: x, clientY: y } = event;
    const info = await infoOf(typeID);
    if (info === null) return;
    catalogueMenu = { typeID, entries: skillMenuEntries(typeID, info.menu), x, y };
  }

  // The milestones (to add, and the plan's ids to delete), the plan's own as read, and the types' facts read.
  let milestones = $state<EditorMilestones>({ toAdd: [], toDelete: [] });
  let persisted = $state<readonly Milestone[]>([]);
  let typeFacts = $state<{ required: Record<number, readonly (readonly [number, number])[]>; categoryID: Map<number, number | null> }>({ required: {}, categoryID: new Map() });
  const newMilestoneID = nextLocalID;

  async function readTypeFacts(typeIDs: readonly number[]): Promise<boolean> {
    const missing = [...new Set(typeIDs)].filter((typeID) => !typeFacts.categoryID.has(typeID));
    if (missing.length === 0) return true;
    flow.requestNames(missing.map((typeID) => ({ kind: "type" as const, id: typeID })));
    const read = await flow.skillPlanTypeFacts(missing).catch(() => null);
    if (read === null) return false;
    typeFacts = { required: { ...typeFacts.required, ...read.required }, categoryID: new Map([...typeFacts.categoryID, ...read.categoryID]) };
    return true;
  }

  const MILESTONE_KIND_LABELS = {
    ship: "UI/SkillPlan/MilestoneShip",
    module: "UI/SkillPlan/MilestoneModule",
    skill: "UI/SkillPlan/MilestoneSkill",
    other: "UI/SkillPlan/MilestoneOther",
  } as const;

  function milestoneName(milestone: Milestone): string {
    return milestone.kind === "skill"
      ? word("UI/InfoWindow/RequiredSkillNameAndLevel", { skill: milestone.typeID, level: romanLevel(milestone.level), levelColor: "#ffffff" })
      : resolvedName($names.resolved, "type", milestone.typeID, "");
  }

  // GetSkillsRequiring for the plan's skills, as read.
  let requiring = $state(new Map<number, ReadonlyMap<number, readonly number[]>>());
  let contentsFilter = $state("");

  // ---- The contents' drags, double clicks, selection and menu (SkillPlanEditorContents, SkillPlanEditorSkillEntry) ----

  /** What is being dragged here: a level of the plan (SkillLevelDragData) or a catalogue skill (a type's, level null). */
  let dragging = $state<{ readonly typeID: number; readonly level: number | null } | null>(null);
  /** The plan's skills' validation facts, read as a drag begins, for the drop line's colour. */
  let dragFacts: SkillPlanValidationFacts | null = null;
  /** DragIndicatorLine: above a level (its index in the plan) or at the list's end, grey where the drop is a valid move and red where not. */
  let dropLine = $state<{ readonly at: number | "end"; readonly valid: boolean } | null>(null);

  function draggedOf(event: DragEvent): { readonly typeID: number; readonly level: number | null } | null {
    if (dragging !== null) return dragging;
    const raw = event.dataTransfer?.getData("application/x-evejs-skill-level");
    if (!raw) return null;
    try {
      const data = JSON.parse(raw) as { typeID?: unknown; level?: unknown };
      return typeof data.typeID === "number" ? { typeID: data.typeID, level: typeof data.level === "number" ? data.level : null } : null;
    } catch {
      return null;
    }
  }

  function dragEnd(): void {
    dragging = null;
    dropLine = null;
    endSkillDrag();
  }

  /** The validation facts of the plan's skills and those given, or null where the client's data could not be read. */
  async function factsWith(typeIDs: readonly number[]): Promise<SkillPlanValidationFacts | null> {
    return flow.skillPlanValidationFor([...new Set([...requirements.map(([skill]) => skill), ...typeIDs])]).catch(() => null);
  }

  /** What the plan's skills take dropped: a level or a catalogue skill, an item or a fitted module, a saved fitting. */
  function dropTaken(event: DragEvent): boolean {
    const types = event.dataTransfer?.types ?? [];
    return types.includes("application/x-evejs-skill-level") || types.includes(DRAG_MIME) || isFittingDrag(event);
  }

  /** OnEntryDragEnter: the line above the level, its colour by whether a level dragged may move there (any other drag's: valid). */
  function rowDragOver(event: DragEvent, skill: number, level: number): void {
    if (!dropTaken(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const at = planLevelIndex(requirements, skill, level);
    let valid = true;
    if (dragging !== null && dragging.level !== null && dragFacts !== null) {
      valid = moveIsValid(requirements, planLevelIndex(requirements, dragging.typeID, dragging.level), at, dragFacts);
    }
    dropLine = { at, valid };
  }

  /**
   * OnScrollDragEnter: the line at the list's end, as a level moved to the end would land; for a catalogue skill too
   * (IsValidContentsDragData). None for a fitting (no type of its own), nor for an item, whose type is not readable
   * until the drop.
   */
  function contentsDragOver(event: DragEvent): void {
    if (!dropTaken(event)) return;
    event.preventDefault();
    if (!event.dataTransfer?.types.includes("application/x-evejs-skill-level")) return;
    let valid = true;
    if (dragging !== null && dragging.level !== null && dragFacts !== null) {
      valid = moveIsValid(requirements, planLevelIndex(requirements, dragging.typeID, dragging.level), requirements.length, dragFacts);
    }
    dropLine = { at: "end", valid };
  }

  /** OnEntryDropData: dropped on a level. */
  async function rowDrop(event: DragEvent, above: SkillLevel): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    const data = draggedOf(event);
    const shift = event.shiftKey;
    dragEnd();
    if (data === null) return void (await dropOther(event));
    if (working) return;
    working = true;
    try {
      const facts = await factsWith([data.typeID]);
      if (facts === null) {
        note = "The client's skill data could not be read: the plan was not changed.";
        return;
      }
      if (data.level !== null) {
        if (shift) {
          // The skill's next level put in above it, where the plan would stay valid (IsSkillInsertionValid).
          const next = nextPlanLevel(requirements, data.typeID);
          if (data.level < 5 && next !== null && insertionIsValid(requirements, data.typeID, next, planLevelIndex(requirements, above[0], above[1]), facts)) {
            requirements = withLevelInserted(requirements, data.typeID, next, above, facts);
          }
        } else {
          requirements = withLevelMoved(requirements, data.typeID, data.level, above, facts) ?? requirements;
        }
      } else {
        // A skill from the catalogue (a type's drag, a skill): its next level put in above (InsertSkillRequirement).
        requirements = withLevelInserted(requirements, data.typeID, null, above, facts);
      }
      await readRequiring();
    } finally {
      working = false;
    }
  }

  /** OnDropData: dropped on the list, not on a level. */
  async function contentsDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    const data = draggedOf(event);
    const shift = event.shiftKey;
    dragEnd();
    if (data === null) return void (await dropOther(event));
    if (working) return;
    working = true;
    try {
      const facts = await factsWith([data.typeID]);
      if (facts === null) {
        note = "The client's skill data could not be read: the plan was not changed.";
        return;
      }
      if (data.level !== null) {
        if (shift) {
          if (data.level < 5) requirements = withLevelAppended(requirements, data.typeID, facts);
        } else {
          // _MoveEntryToBottom.
          requirements = withLevelMoved(requirements, data.typeID, data.level, null, facts) ?? requirements;
        }
      } else {
        requirements = withLevelAppended(requirements, data.typeID, facts);
      }
      await readRequiring();
    } finally {
      working = false;
    }
  }

  /**
   * OnDropData and OnEntryDropData past a skill's drag, alike on a level or on the list: a fitting (a FittingEntry: a
   * saved one, one not saved, the Fitting window's; _OnDropFitting), else an item or a fitted module (_OnTypeDropData).
   * A link dropped (a TextLink) is not taken: the client's own reading of it unpacks parse_fitting_url's one string
   * into two names (UNPACK_SEQUENCE 2, in OnDropData's and OnEntryDropData's bytecode) and raises. What was dropped is
   * read before any await, as a drop's data can only be.
   */
  async function dropOther(event: DragEvent): Promise<void> {
    const fitting = droppedFittingDrag(event);
    const item = fitting === null ? decodeDrag(event.dataTransfer?.getData(DRAG_MIME) ?? null) : null;
    if ((fitting === null && item === null) || working) return;
    working = true;
    note = "";
    try {
      if (fitting !== null) await addFittingNeeds(fitting.kind === "fitting" ? fitting.fitting : await flow.draggedFittingOf(fitting.source));
      else if (item !== null) await addTypeRequirements(item.typeID);
      await readRequiring();
    } catch {
      note = "That could not be put in the plan.";
    } finally {
      working = false;
    }
  }

  /** _OnDropFitting: the hull's and each module's needs appended where the plan lacks that level (BulkAddAllSkillsRequiredFor). */
  async function addFittingNeeds(fitting: Pick<DraggedFitting, "shipTypeID" | "fitData"> | null): Promise<void> {
    const typeIDs = fitting === null ? null : await flow.skillPlanFittingTypes(fitting);
    if (typeIDs === null) {
      note = "That fitting's types could not be read: the plan was not changed.";
      return;
    }
    if (!(await readTypeFacts(typeIDs))) {
      note = "The client's data for that could not be read.";
      return;
    }
    const needs = typeIDs.flatMap((typeID) => requiredSkillsRecursiveAsDict(typeID, typeFacts.required).map(([skill]) => skill));
    const facts = await factsWith(needs);
    if (facts === null) {
      note = "The client's skill data could not be read: the plan was not changed.";
      return;
    }
    requirements = withNeedsOfTypesAppended(requirements, typeIDs, typeFacts.required, facts);
  }

  /** _AddRequirementsForType: for a type that may be a milestone, one made of it where one is free, else its needs alone. */
  async function addTypeRequirements(typeID: number): Promise<void> {
    if (!(await readTypeFacts([typeID]))) {
      note = "The client's data for that could not be read.";
      return;
    }
    const categoryID = typeFacts.categoryID.get(typeID) ?? null;
    if (!typeValidAsMilestone(categoryID, (typeFacts.required[typeID] ?? []).length > 0)) return;
    const isSkill = milestoneSubType(categoryID) === "skill";
    const needs = requiredSkillsRecursiveAsDict(typeID, typeFacts.required).map(([skill]) => skill);
    const facts = await factsWith(isSkill ? [...needs, typeID] : needs);
    if (facts === null) {
      note = "The client's skill data could not be read: the plan was not changed.";
      return;
    }
    const added = withTypeRequirementsAdded(milestones, requirements, typeID, isSkill, typeFacts.required, newMilestoneID, (list) => validateSkillPlan(list, facts));
    requirements = added.list;
    milestones = added.milestones;
  }

  // OnEntryClicked: the level clicked selected, the others marked by how they stand to it.
  let selection = $state<{
    readonly skill: number;
    readonly level: number;
    readonly prereqs: ReadonlyMap<number, number>;
    readonly requiredFor: ReadonlySet<number>;
  } | null>(null);
  async function selectLevel(skill: number, level: number, ctrlKey: boolean): Promise<void> {
    if (ctrlKey && selection !== null && selection.skill === skill && selection.level === level) {
      selection = null;
      return;
    }
    // GetPreReqsAndRequiredForSkillLevel: get_dogma_required_skills and GetSkillsRequiring(skill, level).
    const [facts, requiringRead] = await Promise.all([
      flow.skillPlanTypeFacts([skill]).catch(() => null),
      flow.skillsRequiring([skill]).catch(() => null),
    ]);
    selection = {
      skill,
      level,
      prereqs: new Map(facts?.required[skill] ?? []),
      requiredFor: new Set(requiringRead?.get(skill)?.get(level) ?? []),
    };
  }
  /** ReconstructScrollEntries: the selection kept while its level is in the plan. */
  function levelMark(skill: number, level: number): "selected" | "marked" | null {
    const chosen = selection;
    if (chosen === null || planLevelIndex(requirements, chosen.skill, chosen.level) < 0) return null;
    if (chosen.skill === skill && chosen.level === level) return "selected";
    return planRowRequirement(chosen, { skill, level }, chosen.prereqs, chosen.requiredFor) === null ? null : "marked";
  }

  // GetUtilMenu: Copy Skills to Clipboard, Import Skills from Clipboard, Clear Skills.
  let contentsMenu = $state<{ readonly left: number; readonly top: number } | null>(null);
  function openContentsMenu(event: MouseEvent): void {
    if (contentsMenu !== null) {
      contentsMenu = null;
      return;
    }
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    contentsMenu = { left: Math.max(8, rect.right - 240), top: rect.bottom + 4 };
  }
  $effect(() => {
    if (contentsMenu === null) return;
    const close = (event: Event): void => {
      if (!(event.target instanceof Element && event.target.closest(".plan-editor-contents-menu, .plan-editor-menu-button"))) contentsMenu = null;
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape") contentsMenu = null;
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
  /** CopySkillsToClipboard: GetRequirementsClipboardText, each level "name level" and a new line. */
  function copySkills(): void {
    contentsMenu = null;
    const text = requirements.map(([typeID, level]) => `${resolvedName($names.resolved, "type", typeID, String(typeID))} ${level}\n`).join("");
    void navigator.clipboard?.writeText(text).catch(() => {});
  }
  /** ImportSkillsFromClipboard: the clipboard read as the queue's importer reads it, its levels appended. */
  async function importSkills(): Promise<void> {
    contentsMenu = null;
    if (working) return;
    const text = await navigator.clipboard?.readText().catch(() => null);
    if (typeof text !== "string" || text === "") return;
    working = true;
    note = "";
    try {
      const levels = await flow.skillPlanImportText(text);
      if (levels === null) {
        note = "The clipboard's skills could not be read.";
        return;
      }
      if (levels.length === 0) return;
      const facts = await factsWith(levels.map(([typeID]) => typeID));
      if (facts === null) {
        note = "The client's skill data could not be read: the plan was not changed.";
        return;
      }
      requirements = withLevelsAppended(requirements, levels, facts);
      await readRequiring();
    } finally {
      working = false;
    }
  }
  /** ClearSkills: every level out, and the milestones (ClearMilestones). */
  function clearSkills(): void {
    contentsMenu = null;
    requirements = [];
    milestones = milestones.toAdd.reduce((out, milestone) => withMilestoneRemoved(out, milestone.id), milestones);
    selection = null;
  }

  onMount(() => {
    flow.requestWords(Object.keys(OWN));
    // ImportSkillplanFormatHint's skill: appConst.typeSpaceshipCommand.
    flow.requestNames([{ kind: "type", id: 3327 }]);
    void (async () => {
      const catalogue = await flow.skillCatalogue();
      groups = catalogue ? catalogueGroups(catalogue.skills, (typeID) => catalogue.held.has(typeID)) : null;
      if (groups && groups.length > 0) selectedGroupID = groups[0]!.groupID;
      await readCatalogueStates();
    })();
    void flow.attributeDisplay([164, 165, 166, 167, 168]).then((shown) => {
      if (shown !== null) attributeShown = shown;
    });
    const pointsTimer = setInterval(() => {
      pointsClock = Date.now();
    }, 2000);
    void readRequiring();
    // GetCopy: an edited plan's milestones, copied.
    if (plan) {
      const editedPlan = plan;
      void (async () => {
        const read = await flow.skillPlanMilestones(editedPlan, corp ? "corporation" : "character").catch(() => null);
        if (!read) return;
        persisted = read.milestones;
        milestones = copiedMilestones(read.milestones, newMilestoneID);
        await readTypeFacts(read.milestones.map((milestone) => milestone.typeID));
      })();
    }
    return () => clearInterval(pointsTimer);
  });

  /** A skill level, or a skill, dragged (skillPlanUtil: SkillLevelDragData, or a type's). */
  function dragStart(event: DragEvent, typeID: number, level: number | null): void {
    event.dataTransfer?.setData("application/x-evejs-skill-level", JSON.stringify({ typeID, level }));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "copyMove";
    dragging = { typeID, level };
    // A TypeDragData (a SkillLevelDragData is one too), for a drop onto the skill queue.
    startSkillDrag({ kind: "type", typeID });
    dragFacts = null;
    void factsWith([typeID]).then((facts) => {
      if (dragging !== null && dragging.typeID === typeID && dragging.level === level) dragFacts = facts;
    });
  }

  function dragOver(event: DragEvent): void {
    if (dropTaken(event)) event.preventDefault();
  }

  /** SkillPlanProgressIndicatorEditable._OnDataDropped and SkillPlanEditorOverview.OnMilestoneDataDropped. */
  async function dropMilestone(event: DragEvent, onMilestoneID: string | null): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    const raw = event.dataTransfer?.getData("application/x-evejs-skill-level");
    // GetDragDataTypeIDAndLevel: an item's or a fitted module's type; a fitting has none (CantAddAsMilestone).
    const item = raw ? null : decodeDrag(event.dataTransfer?.getData(DRAG_MIME) ?? null);
    if (!raw && item === null) {
      if (droppedFittingDrag(event) !== null) flow.sayCantAddAsMilestone();
      return;
    }
    if (working) return;
    let data: { typeID: number; level: number | null };
    if (item !== null) {
      data = { typeID: item.typeID, level: null };
    } else {
      try {
        data = JSON.parse(raw!);
      } catch {
        return;
      }
    }
    working = true;
    note = "";
    try {
      if (!(await readTypeFacts([data.typeID]))) {
        note = "The client's data for that could not be read.";
        return;
      }
      const categoryID = typeFacts.categoryID.get(data.typeID) ?? null;
      const what = dropped(data.typeID, data.level, categoryID);
      if (!typeValidAsMilestone(categoryID, (typeFacts.required[data.typeID] ?? []).length > 0)) {
        flow.sayCantAddAsMilestone();
        return;
      }
      let current = milestones;
      const old = onMilestoneID === null ? undefined : current.toAdd.find((each) => each.id === onMilestoneID);
      if (old) {
        // evetypes.GetName of each: the type, or the skill.
        if (!(await flow.askReplaceMilestone(resolvedName($names.resolved, "type", old.typeID, ""), resolvedName($names.resolved, "type", what.typeID, "")))) return;
        current = withMilestoneRemoved(current, old.id);
      }
      const added = withMilestoneAdded(current, requirements, what.typeID, what.level, typeFacts.required, newMilestoneID);
      if (added === null) {
        milestones = current;
        return;
      }
      const facts = await flow.skillPlanValidationFor([...new Set(added.list.map(([skill]) => skill))]);
      if (facts === null) {
        note = "The client's skill data could not be read: the plan was not changed.";
        return;
      }
      const list = added.list;
      validateSkillPlan(list, facts);
      requirements = list;
      milestones = added.milestones;
      await readRequiring();
    } catch {
      note = "That could not be made a milestone.";
    } finally {
      working = false;
    }
  }

  /**
   * The template's Apply, as the editor opens on the new plan: a list's levels appended (AppendSkillRequirements, none
   * without a skill or a level) and its name set (RequirementListSkillPlanTemplate); a type's needs, a milestone made of
   * it where one is free (_AddRequirementsForType's way: a skill's needs to level I and its level I, else the type),
   * else its needs alone, and where the plan has no name, SkillPlanNameStringWithType with the type's name
   * (TypeRequirementSkillPlanTemplate).
   */
  async function applyTemplate(given: SkillPlanTemplate): Promise<void> {
    working = true;
    note = "";
    try {
      if (given.kind === "list") {
        const levels = given.requirements.filter(([skill, level]) => skill !== null && level !== null).map(([skill, level]) => [skill, level] as const);
        if (levels.length > 0) {
          const facts = await factsWith(levels.map(([skill]) => skill));
          if (facts === null) {
            note = "The client's skill data could not be read: the plan was not changed.";
            return;
          }
          requirements = withLevelsAppended(requirements, levels, facts);
        }
        if (given.name) name = given.name;
      } else {
        await addTypeRequirements(given.typeID);
        if (name === "") name = word("Tooltips/SkillPlanner/SkillPlanNameStringWithType", { typeName: resolvedName($names.resolved, "type", given.typeID, String(given.typeID)) });
      }
      await readRequiring();
    } finally {
      working = false;
    }
  }
  onMount(() => {
    if (template) {
      flow.requestNames(template.kind === "type" ? [{ kind: "type", id: template.typeID }] : []);
      void applyTemplate(template);
    }
  });

  async function readRequiring(): Promise<void> {
    const skills = [...new Set(requirements.map(([skill]) => skill))];
    flow.requestNames(skills.map((skill) => ({ kind: "type" as const, id: skill })));
    const missing = skills.filter((skill) => !requiring.has(skill));
    if (missing.length === 0) return;
    const read = await flow.skillsRequiring(missing).catch(() => null);
    if (read) requiring = new Map([...requiring, ...read]);
  }

  const skillsNeeding = (typeID: number, level: number): readonly number[] => requiring.get(typeID)?.get(level) ?? [];

  /** EditorSkillEntryPrimaryButton.OnClickFunc */
  async function addLevel(typeID: number): Promise<void> {
    if (working) return;
    working = true;
    note = "";
    try {
      const facts = await flow.skillPlanValidationFor([...new Set([...requirements.map(([skill]) => skill), typeID])]);
      if (facts === null) {
        note = "The client's skill data could not be read: the plan was not changed.";
        return;
      }
      requirements = withLevelAppended(requirements, typeID, facts);
      await readRequiring();
    } catch {
      note = "That level could not be put in the plan.";
    } finally {
      working = false;
    }
  }

  /** EditorSkillLevelEntryPrimaryButton._Remove */
  async function removeLevel(typeID: number, level: number): Promise<void> {
    if (working) return;
    working = true;
    note = "";
    try {
      const facts = await flow.skillPlanValidationFor([...new Set(requirements.map(([skill]) => skill))]);
      if (facts === null) {
        note = "The client's skill data could not be read: the plan was not changed.";
        return;
      }
      // RemoveSkillRequirement: the level out, the milestones that then lack a skill out (_CheckRemoveMilestones), then
      // the plan put right.
      const without = requirements.filter(([skill, l]) => !(skill === typeID && l === level));
      if (milestones.toAdd.length > 0 && (await readTypeFacts(milestones.toAdd.map((milestone) => milestone.typeID)))) {
        milestones = withMilestonesCheckedAgainst(milestones, without, typeFacts.required);
      }
      requirements = withLevelRemoved(requirements, typeID, level, facts);
    } catch {
      note = "That level could not be taken out.";
    } finally {
      working = false;
    }
  }

  /** SkillPlanEditorOverview.OnClearButton */
  function clear(): void {
    requirements = [];
    milestones = milestones.toAdd.reduce((out, milestone) => withMilestoneRemoved(out, milestone.id), milestones);
    name = "";
    categoryID = 0;
    description = "";
  }

  /** SkillPlanEditorPanel.OnBack */
  async function back(): Promise<void> {
    const changed = editedPlanDiffers(plan, edited) || milestonesChanged(milestones, plan ? persisted : null);
    if (changed && !(await flow.askLeaveSkillPlanEditor())) return;
    onClose(false);
  }

  /** SkillPlanEditorOverview.OnSaveButton */
  async function save(): Promise<void> {
    if (saving || !canSavePlan(edited)) return;
    saving = true;
    try {
      const corpSave = corp ? { categoryID, savedCategoryID: corp.categoryID } : undefined;
      if (await flow.saveSkillPlan(edited, plan, planCount, { milestones, persisted }, corpSave)) onClose(true);
    } finally {
      saving = false;
    }
  }

  const shownRows = $derived(
    requirements.filter(([skill]) => contentsFilter === "" || resolvedName($names.resolved, "type", skill, "").toLowerCase().includes(contentsFilter.toLowerCase())),
  );
</script>

<div class="plan-editor">
  <div class="plan-editor-head">
    <button type="button" class="plan-editor-back" aria-label="Back" onclick={() => void back()}>←</button>
  </div>
  {#if note}
    <p class="note">{note}</p>
  {/if}
  <div class="plan-editor-body">
    <section class="plan-editor-catalogue">
      <div class="plan-editor-caption">
        <h3>{word("UI/SkillPlan/Skills")}</h3>
        <select class="plan-editor-filter-combo" value={catalogueFilterID} aria-label="Skills shown"
          onchange={(event) => chooseCatalogueFilter((event.currentTarget as HTMLSelectElement).value as CatalogueFilter)}>
          {#each CATALOGUE_FILTERS as filter (filter.id)}
            <option value={filter.id}>{word(filter.label)}</option>
          {/each}
        </select>
        <input type="search" bind:value={catalogueFilter} aria-label="Filter skills" />
      </div>
      {#if skillPointsShown !== null}
        <p class="plan-editor-points">{word("UI/CharacterSheet/CharacterSheetWindow/SkillTabs/SkillPoints", { skillPoints: skillPointsShown })}</p>
      {/if}
      {#if groups === undefined}
        <p class="note">Reading the skills…</p>
      {:else if groups === null}
        <p class="error">The skills could not be read.</p>
      {:else}
        <div class="plan-editor-groups" role="tablist">
          {#each groups as group (group.groupID)}
            {@const count = groupCount(group)}
            {@const progress = groupProgress(group.skills, catalogueStates)}
            {@const icon = skillGroupIcon(group.groupID)}
            <button type="button" role="tab" class="plan-editor-group" aria-selected={catalogueFilter === "" && selectedGroupID === group.groupID}
              class:selected={catalogueFilter === "" && selectedGroupID === group.groupID} class:none={count === 0}
              onclick={() => { catalogueFilter = ""; selectedGroupID = group.groupID; }}
              onmouseenter={(event) => showGroupTip(group.groupID, event)} onmouseleave={() => { if (groupTip?.groupID === group.groupID) groupTip = null; }}>
              {#if icon !== null}<img class="plan-editor-group-icon" src={icon} alt="" width="32" height="32" />{/if}
              <span class="plan-editor-group-name">{group.name}</span>
              <span class="plan-editor-group-count">{count === 0 ? "" : count}</span>
              <span class="plan-editor-group-bar" aria-hidden="true">
                <span class="trained" style:width={`${Math.max(0, progress.trained - progress.disabled) * 100}%`}></span>
                <span class="omega" style:width={`${progress.disabled * 100}%`}></span>
              </span>
            </button>
          {/each}
        </div>
        {#if groupTip !== null}
          {@const tipGroup = groups.find((group) => group.groupID === groupTip?.groupID)}
          {#if tipGroup !== undefined}
            <SkillGroupTip {store} {flow} groupID={tipGroup.groupID} name={tipGroup.name} summary={groupSummary(tipGroup.skills, catalogueStates)}
              certificates={groupCertificates.get(tipGroup.groupID) ?? null}
              attributes={attributeShown} top={groupTip.top} left={groupTip.left} />
          {/if}
        {/if}
        <ul class="plan-editor-skills">
          {#each shownSkills as skill (skill.typeID)}
            {@const next = nextPlanLevel(requirements, skill.typeID)}
            {@const full = highestPlanLevel(requirements, skill.typeID) === 5}
            {@const row = catalogueStates.get(skill.typeID)}
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <li draggable="true" ondragstart={(event) => { catalogueTip = null; dragStart(event, skill.typeID, null); }} ondragend={dragEnd}
              oncontextmenu={(event) => void openCatalogueMenu(skill.typeID, event)}
              onmouseenter={(event) => void showCatalogueTip(skill.typeID, event)} onmouseleave={() => hideCatalogueTip(skill.typeID)}
              ondblclick={(event) => { if (!(event.target instanceof Element && event.target.closest("button"))) showInfo({ kind: "type", typeID: skill.typeID }); }}>
              <span class="plan-editor-skill-bar" aria-hidden="true">
                {#each row?.boxes ?? [] as one, box (box)}
                  <span class="skill-box {one.box}" class:partial={one.partial}></span>
                {/each}
              </span>
              <span class="plan-editor-skill-name">{skill.name}</span>
              {#if row !== undefined && row.nextTicks !== null}
                <span class="plan-editor-skill-time">{interval(row.nextTicks)}</span>
              {/if}
              <button type="button" class="plan-editor-add" disabled={full || working}
                title={full ? word("UI/SkillPlan/AllLevelsInPlan") : word("UI/SkillPlan/AddSkillLevelToPlan", { skillLevel: next ?? 1 })}
                aria-label={full ? word("UI/SkillPlan/AllLevelsInPlan") : word("UI/SkillPlan/AddSkillLevelToPlan", { skillLevel: next ?? 1 })}
                onclick={() => void addLevel(skill.typeID)}>+</button>
            </li>
          {/each}
        </ul>
        {#if catalogueTip !== null && skillInfos.get(catalogueTip.typeID) !== undefined}
          <SkillRowTip {store} {flow} typeID={catalogueTip.typeID} info={skillInfos.get(catalogueTip.typeID)!} top={catalogueTip.top} left={catalogueTip.left} onHover={catalogueTipHover} />
        {/if}
        {#if catalogueMenu !== null}
          {@const menuFor = catalogueMenu}
          <SkillRowMenu {store} {flow} skill={menuFor.typeID} entries={menuFor.entries} x={menuFor.x} y={menuFor.y}
            onClose={() => { catalogueMenu = null; }} onApplied={() => { skillInfos = new Map(); }} />
        {/if}
      {/if}
    </section>
    <section class="plan-editor-contents">
      <div class="plan-editor-caption">
        <h3>{word("UI/SkillPlan/SkillPlan")} <span class="plan-editor-count">{requirements.length}</span></h3>
        <input type="search" bind:value={contentsFilter} aria-label="Filter the plan" />
        <button type="button" class="plan-editor-menu-button" aria-haspopup="menu" aria-expanded={contentsMenu !== null} onclick={openContentsMenu}>☰</button>
      </div>
      {#if contentsMenu !== null}
        <span class="hull-menu plan-editor-contents-menu" role="menu" use:portal style:left={`${contentsMenu.left}px`} style:top={`${contentsMenu.top}px`}>
          <button type="button" role="menuitem" onclick={copySkills}>{word("UI/SkillPlan/CopySkillsToClipboard")}</button>
          <button type="button" role="menuitem" title={word("UI/SkillQueue/ImportSkillplanFormatHint", { typeID: 3327 })} onclick={() => void importSkills()}>{word("UI/SkillPlan/ImportSkillsFromClipboard")}</button>
          <button type="button" role="menuitem" onclick={clearSkills}>{word("UI/SkillPlan/ClearSkills")}</button>
        </span>
      {/if}
      {#if requirements.length === 0}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <p class="empty plan-editor-hint" ondragover={contentsDragOver} ondrop={(event) => void contentsDrop(event)}>{word("UI/SkillPlan/NoSkillsInPlanHint")}</p>
      {:else if shownRows.length === 0}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <p class="empty" ondragover={contentsDragOver} ondrop={(event) => void contentsDrop(event)}>{word("UI/CharacterSheet/CharacterSheetWindow/SkillTabs/NoSkillsMatchingFilters")}</p>
      {:else}
        <ul class="plan-editor-rows" ondragover={contentsDragOver} ondrop={(event) => void contentsDrop(event)} ondragleave={(event) => { if (event.target === event.currentTarget) dropLine = null; }}>
          {#each shownRows as [skill, level], at (at)}
            {@const removable = canRemoveLevel(requirements, skill, level, skillsNeeding)}
            {@const mark = levelMark(skill, level)}
            {@const lineHere = dropLine !== null && dropLine.at === planLevelIndex(requirements, skill, level)}
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <li draggable="true" ondragstart={(event) => dragStart(event, skill, level)} ondragend={dragEnd}
              class:selected={mark === "selected"} class:marked={mark === "marked"} class:drop-above={lineHere} class:drop-invalid={lineHere && dropLine?.valid === false}
              ondragover={(event) => rowDragOver(event, skill, level)} ondrop={(event) => void rowDrop(event, [skill, level])}
              onclick={(event) => { if (!(event.target instanceof Element && event.target.closest("button"))) void selectLevel(skill, level, event.ctrlKey); }}
              onkeydown={(event) => { if (event.key === "Enter") void selectLevel(skill, level, event.ctrlKey); }}
              ondblclick={(event) => { if (!(event.target instanceof Element && event.target.closest("button"))) void addLevel(skill); }}>
              <span>{word("UI/InfoWindow/RequiredSkillNameAndLevel", { skill, level: romanLevel(level), levelColor: "#ffffff" })}</span>
              <button type="button" class="plan-editor-remove" disabled={!removable || working}
                title={word(removable ? "UI/SkillPlan/RemoveFromPlan" : "UI/SkillPlan/RemoveFromPlanLocked")}
                aria-label={word(removable ? "UI/SkillPlan/RemoveFromPlan" : "UI/SkillPlan/RemoveFromPlanLocked")}
                onclick={() => void removeLevel(skill, level)}>✕</button>
            </li>
          {/each}
          {#if dropLine !== null && dropLine.at === "end"}
            <li class="plan-editor-drop-end" class:drop-invalid={!dropLine.valid} aria-hidden="true"></li>
          {/if}
        </ul>
      {/if}
    </section>
    <section class="plan-editor-overview">
      <div class="plan-editor-milestones" role="list" aria-label={word("UI/SkillPlan/Milestones")} ondragover={dragOver} ondrop={(event) => void dropMilestone(event, null)}>
        <div class="plan-editor-milestones-head">
          <span title={word("UI/SkillPlan/SkillMilestonesDescText")}>{word("UI/SkillPlan/Milestones")}</span>
          <span class="plan-editor-counter">{milestones.toAdd.length}/{MAX_NUM_MILESTONES}</span>
        </div>
        {#each milestones.toAdd as milestone (milestone.id)}
          <div class="plan-editor-milestone" role="listitem" ondragover={dragOver} ondrop={(event) => void dropMilestone(event, milestone.id)}>
            <span class="plan-editor-milestone-kind">{word(MILESTONE_KIND_LABELS[milestoneSubType(typeFacts.categoryID.get(milestone.typeID) ?? null)])}</span>
            <span class="plan-editor-milestone-name">{milestoneName(milestone)}</span>
            <button type="button" title={word("UI/SkillPlan/RemoveMilestone")} aria-label={word("UI/SkillPlan/RemoveMilestone")}
              onclick={() => { milestones = withMilestoneRemoved(milestones, milestone.id); }}>✕</button>
          </div>
        {/each}
        {#if milestones.toAdd.length < MAX_NUM_MILESTONES}
          <div class="plan-editor-milestone-slot" role="listitem" title={word("UI/SkillPlan/AddingMilestones") + "\n" + word("UI/SkillPlan/MilestonesDragDropInformation")}>+</div>
        {/if}
      </div>
      <label for="plan-editor-name">{word("UI/Common/Name")}</label>
      <div class="plan-editor-name">
        <input id="plan-editor-name" type="text" maxlength={MAX_PLAN_NAME_LENGTH} placeholder={word("UI/SkillPlan/EnterPlanName")} bind:value={name} />
        <span class="plan-editor-counter">{name.length}/{MAX_PLAN_NAME_LENGTH}</span>
      </div>
      <label for="plan-editor-description">{word("UI/Common/Description")}</label>
      <textarea id="plan-editor-description" rows="6" maxlength={MAX_PLAN_DESCRIPTION_LENGTH} placeholder={word("UI/SkillPlan/EnterPlanDescription")} bind:value={description}></textarea>
      {#if corp}
        <label for="plan-editor-category">{word("UI/Common/Category")}</label>
        <select id="plan-editor-category" bind:value={categoryID}>
          <option value={0}>{word("UI/Generic/None")}</option>
          {#each corp.categories as category (category.id)}
            <option value={category.id}>{category.name}</option>
          {/each}
        </select>
      {/if}
      <div class="plan-editor-buttons">
        <button type="button" onclick={clear}>{word("UI/Inventory/Clear")}</button>
        <button type="button" class="primary" disabled={!canSavePlan(edited) || saving || working}
          title={canSavePlan(edited) ? undefined : word("Tooltips/SkillPlanner/CantSaveTooltip")}
          onclick={() => void save()}>{word("UI/Common/Buttons/Save")}</button>
      </div>
    </section>
  </div>
</div>

<style>
  .plan-editor { display: flex; flex-direction: column; gap: 0.5rem; }
  .plan-editor-back { align-self: flex-start; }
  .plan-editor-body { display: grid; grid-template-columns: minmax(14rem, 1fr) minmax(14rem, 1fr) minmax(12rem, 0.8fr); gap: 1rem; align-items: start; }
  .plan-editor-caption { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; }
  .plan-editor-caption h3 { margin: 0; }
  .plan-editor-count { opacity: 0.6; font-size: 0.9em; }
  .plan-editor-groups { display: flex; flex-wrap: wrap; gap: 0.25rem; margin: 0.5rem 0; }
  .plan-editor-groups button.selected { outline: 1px solid currentColor; }
  /* SkillGroupEntry: the 32px icon, the name, the count at the right, the bar of levels trained (the theme's accent at
     0.2) and of an alpha's levels past its ceiling (COLOR_OMEGA_ORANGE at 0.6); faded to 0.4 where the filters keep none. */
  .plan-editor-group { position: relative; display: flex; align-items: center; gap: 0.4rem; padding: 0.2rem 0.5rem 0.2rem 0.25rem; overflow: hidden; }
  .plan-editor-group.none { opacity: 0.4; }
  .plan-editor-group-icon { flex: none; }
  .plan-editor-group-name { flex: 1; text-align: left; }
  .plan-editor-group-count { min-width: 1.2rem; text-align: right; opacity: 0.8; }
  .plan-editor-group-bar { position: absolute; left: 0; bottom: 0; right: 0; height: 100%; display: flex; pointer-events: none; z-index: 0; }
  .plan-editor-group > :not(.plan-editor-group-bar) { position: relative; z-index: 1; }
  .plan-editor-group-bar .trained { background: rgba(88, 167, 191, 0.2); }
  .plan-editor-group-bar .omega { background: rgba(232, 179, 74, 0.6); }
  .plan-editor-filter-combo { max-width: 10rem; }
  .plan-editor-skills, .plan-editor-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.25rem; max-height: 28rem; overflow-y: auto; }
  .plan-editor-skills li, .plan-editor-rows li { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; padding: 0.2rem 0.5rem; background: rgba(255, 255, 255, 0.04); }
  .plan-editor-hint { white-space: pre-line; }
  .plan-editor-overview { display: flex; flex-direction: column; gap: 0.35rem; }
  .plan-editor-milestones { display: flex; flex-direction: column; gap: 0.25rem; padding: 0.5rem; margin-bottom: 0.75rem; border: 1px dashed var(--line, #555); }
  .plan-editor-milestones-head { display: flex; justify-content: space-between; }
  .plan-editor-milestone { display: flex; align-items: center; gap: 0.5rem; padding: 0.2rem 0.4rem; background: rgba(255, 255, 255, 0.05); }
  .plan-editor-milestone-kind { font-size: 0.75rem; text-transform: uppercase; opacity: 0.7; min-width: 3.5rem; }
  .plan-editor-milestone-name { flex: 1; }
  .plan-editor-milestone-slot { text-align: center; opacity: 0.5; padding: 0.3rem; border: 1px dotted var(--line, #555); }
  .plan-editor-skills li[draggable="true"], .plan-editor-rows li[draggable="true"] { cursor: grab; }
  .plan-editor-points { margin: 0; }
  .plan-editor-skill-bar { display: inline-flex; gap: 2px; flex: none; }
  .plan-editor-skill-name { flex: 1; min-width: 0; }
  .plan-editor-skill-time { opacity: 0.35; flex: none; }
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
  /* DragIndicatorLine: VALID_LINE_COLOR (0.8 grey) where the drop is a valid move, INVALID_LINE_COLOR (0.7 red) where not. */
  .plan-editor-rows li.drop-above { box-shadow: inset 0 2px 0 #cccccc; }
  .plan-editor-rows li.drop-above.drop-invalid { box-shadow: inset 0 2px 0 #b30000; }
  .plan-editor-rows li.plan-editor-drop-end { min-height: 0; height: 2px; padding: 0; background: #cccccc; }
  .plan-editor-rows li.plan-editor-drop-end.drop-invalid { background: #b30000; }
  /* SkillEntryUnderlay: the level selected, and those standing to it in its hover look. */
  .plan-editor-rows li { cursor: pointer; }
  .plan-editor-rows li.selected { background: rgba(255, 255, 255, 0.16); outline: 1px solid rgba(255, 255, 255, 0.35); }
  .plan-editor-rows li.marked { background: rgba(255, 255, 255, 0.1); }
  .plan-editor-name { display: flex; align-items: center; gap: 0.5rem; }
  .plan-editor-name input { flex: 1; }
  .plan-editor-counter { font-size: 0.8rem; opacity: 0.6; }
  .plan-editor-buttons { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
  .plan-editor-buttons button { flex: 1; }
</style>
