// The Fitting window's skill warning as the client reckons it (ui/shared/fittingScreen/skillRequirements.py,
// warningIconCont.py, shipfitting/fittingWarnings.py GetSlotsMissingSkills): how many skills the ship and what it
// holds are missing, the slots and holds showing it, the skills its tooltip lists for the ship and fit and for the
// cargo hold, and the list its training time and actions go by, in the order the client's sets and dicts give it.

import { isSkillRequirementMet, missingSkillsRecursive, type PilotSkills, type RequiredSkills } from "./missingSkills.ts";
import { intDictOrder, intSetOf, intSetUnion, type IntSet } from "./py27DictOrder.ts";

/** inventorycommon const categoryBlueprint: a blueprint's skills are not counted. */
const CATEGORY_BLUEPRINT = 9;
/** moduleSlotFlags, and GetSlotsMissingSkills' extra holds: the cargo hold, drone bay, fighter bay and the tubes. */
const MODULE_SLOT_FLAGS: readonly number[] = Array.from({ length: 24 }, (_, at) => 11 + at);
const EXTRA_HOLDS: readonly number[] = [5, 87, 158, 159, 160, 161, 162, 163];

/** AddSkillTooltipForTypeIDs: the rows and training targets for two collections of item types. */
export interface FittingSkillRequirements {
  /** The ship and fit's skills missing, each at the highest level needed. */
  readonly fit: readonly (readonly [number, number])[];
  /** The cargo hold's, those the ship and fit's list has at that level or above left out. */
  readonly cargo: readonly (readonly [number, number])[];
  /** Whether the cargo hold has types missing skills that the ship and fit has not (its heading shown). */
  readonly cargoListed: boolean;
  /** Whether both have (the Ship and Fit heading shown). */
  readonly shipAndFitHeading: boolean;
  /**
   * The skills the training time and the actions go by (GetSkillsMissingToUseAllSkillsFromListRecursiveAsList of both
   * lists joined): each at its level, a skill's own missing needs before it.
   */
  readonly listed: readonly (readonly [number, number])[];
  /** GetMissingSkillBooksFromList of them: those the pilot has not (GetSkill). */
  readonly missingBooks: readonly number[];
}

/** The skill warning of a ship, its fit and its holds. */
export interface FittingSkillWarning extends FittingSkillRequirements {
  /** The skills missing, of every type of the ship, its fit, its bays and its cargo (the icon's counter). */
  readonly count: number;
  /** GetSlotsMissingSkills: each module slot and hold holding a type that misses a skill. */
  readonly flags: readonly number[];
  /** The types of the ship and what it holds that miss a skill (missingSkillsForTypeID's), which the pickers mark. */
  readonly typesMissing: readonly number[];
}

/** What the warning goes by: the types, the items in their slots and holds, the skills needed and the pilot's. */
export interface FittingSkillInputs {
  /** _GetAllTypesForShipAndFit: the hull's type, then each item fitted to it's, in the order its dict iterates them. */
  readonly ship: number;
  readonly fitted: readonly number[];
  /** The drone bay's, fighter bay's and each tube's types (_GetTypesInFlag), in that order of flags. */
  readonly bays: readonly (readonly number[])[];
  /** _GetAllTypesForCargoHold. */
  readonly cargo: readonly number[];
  /** The items fitted to the ship and those of its holds, (typeID, flagID). */
  readonly items: readonly (readonly [number, number])[];
  readonly required: RequiredSkills;
  /** The pilot's skills, and with the lapsed ones (GetSkills, GetAllSkills). */
  readonly mine: PilotSkills;
  readonly lapsed: PilotSkills;
  /** evetypes.GetCategoryID, null where the type does not exist. */
  readonly categoryOf: (typeID: number) => number | null;
}

type SkillFacts = Pick<FittingSkillInputs, "required" | "mine" | "lapsed" | "categoryOf">;

/**
 * GetMissingSkills_HighestLevelByTypeID: of each type in the order given (none that does not exist, nor a blueprint),
 * each skill missing to use it however deep (GetSkillsMissingToUseItemRecursive), at the highest level any needs it,
 * in the order the dict of them iterates (each skill set first as it is met); and each type's missing skills.
 */
export function missingSkillsHighestLevel(typeIDs: Iterable<number>, inputs: SkillFacts): { readonly highest: Map<number, number>; readonly byType: Map<number, Set<number>> } {
  const met = new Map<number, number>();
  const byType = new Map<number, Set<number>>();
  for (const typeID of typeIDs) {
    const categoryID = inputs.categoryOf(typeID);
    if (categoryID === null || categoryID === CATEGORY_BLUEPRINT) continue;
    for (const [skill, level] of missingSkillsRecursive(typeID, inputs.required, inputs.mine, inputs.lapsed)) {
      met.set(skill, Math.trunc(Math.max(level, met.get(skill) ?? 0)));
      const skills = byType.get(typeID) ?? new Set<number>();
      skills.add(skill);
      byType.set(typeID, skills);
    }
  }
  return { highest: new Map(intDictOrder([...met.keys()]).map((skill) => [skill, met.get(skill) ?? 0])), byType };
}

/** GetMissingSkillsForTypeIDs: a set of the types, in the order given, whose own skills are not met (IsSkillRequirementMet). */
function typesMissingSkills(typeIDs: Iterable<number>, inputs: SkillFacts): IntSet {
  return intSetOf([...typeIDs].filter((typeID) => !isSkillRequirementMet(typeID, inputs.required, inputs.mine)));
}

/**
 * GetSkillsMissingToUseAllSkillsFromListRecursive: of each skill listed short of its level, its own missing needs
 * however deep (unless the skill is had, lapsed, with points), then the skill at the highest level asked, each first
 * set where it is met (an OrderedDict).
 */
function missingFromListRecursive(listed: readonly (readonly [number, number])[], inputs: SkillFacts): [number, number][] {
  const found = new Map<number, number>();
  const short = (skill: number, level: number) => {
    const trained = inputs.mine.get(skill)?.trainedSkillLevel;
    return trained === undefined || trained < level;
  };
  const walkable = (skill: number) => {
    const had = inputs.lapsed.get(skill);
    return had === undefined || had.trainedSkillPoints <= 0;
  };
  const walk = (of: number): void => {
    for (const [skill, level] of inputs.required[of] ?? []) {
      if (!short(skill, level)) continue;
      if (skill !== of && walkable(skill)) walk(skill);
      found.set(skill, Math.max(found.get(skill) ?? 0, level));
    }
  };
  for (const [skill, level] of listed) {
    if (!short(skill, level)) continue;
    // `skillTypeID not in skills` of a list of pairs: always so, the skill's own needs walked.
    if (walkable(skill)) walk(skill);
    found.set(skill, Math.max(found.get(skill) ?? 0, level));
  }
  return [...found];
}

/** 24.02 builds the same tooltip from a dogma location or from an Academy preview's standard type IDs. */
export function fittingSkillRequirements(
  shipAndFit: Iterable<number>,
  cargo: Iterable<number>,
  inputs: SkillFacts,
): FittingSkillRequirements {
  const fitMissing = typesMissingSkills(shipAndFit, inputs);
  const fitHighest = missingSkillsHighestLevel(fitMissing.keys(), inputs).highest;
  const cargoMissing = typesMissingSkills(cargo, inputs);
  cargoMissing.differenceUpdate(fitMissing);
  const cargoHighest = missingSkillsHighestLevel(cargoMissing.keys(), inputs).highest;
  for (const [skill, level] of [...cargoHighest]) if ((fitHighest.get(skill) ?? 0) >= level) cargoHighest.delete(skill);
  // allSkillLevelsByID: the two lists' skills (a set of each's keys, joined), each at the higher of their levels.
  const joined = intSetUnion(intSetOf(fitHighest.keys()), intSetOf(cargoHighest.keys())).keys()
    .map((skill) => [skill, Math.max(fitHighest.get(skill) ?? 0, cargoHighest.get(skill) ?? 0)] as const);
  const listed = missingFromListRecursive(joined, inputs);
  return {
    fit: [...fitHighest],
    cargo: [...cargoHighest],
    cargoListed: cargoMissing.keys().length > 0,
    shipAndFitHeading: fitMissing.keys().length > 0 && cargoMissing.keys().length > 0,
    listed,
    missingBooks: listed.map(([skill]) => skill).filter((skill) => !inputs.mine.has(skill)),
  };
}

/** GetSkillTooltip and the separate warning counter and slot highlights. */
export function fittingSkillWarning(inputs: FittingSkillInputs): FittingSkillWarning {
  const shipAndFit = intSetOf([inputs.ship, ...inputs.fitted]);
  for (const bay of inputs.bays) shipAndFit.update(intSetOf(bay));
  const cargo = intSetOf(inputs.cargo);
  const requirements = fittingSkillRequirements(shipAndFit.keys(), cargo.keys(), inputs);
  // GetAllTypeIDsMissingSkillsForShipAndContent updates the fitted type set in place for the counter.
  shipAndFit.update(cargo);
  const { highest, byType } = missingSkillsHighestLevel(shipAndFit.keys(), inputs);
  const validFlags = new Set([...MODULE_SLOT_FLAGS, ...EXTRA_HOLDS]);
  const flags = [...new Set(inputs.items.filter(([typeID, flagID]) => validFlags.has(flagID) && byType.has(typeID)).map(([, flagID]) => flagID))];
  return {
    ...requirements,
    count: highest.size,
    flags,
    typesMissing: [...byType.keys()],
  };
}
