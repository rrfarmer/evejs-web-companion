// A saved fitting's contents as the client's fitting display lists them (eve/client/script/environment/fittingSvc.py
// GetTypesByRack, 968 to 1008, and GetFittingInfoForScrollList, 899 to 953): each slot kind under the name of its
// effect, its types counted and sorted by group, then the charges, fuel, drones, fighters, implants and boosters,
// modules in the hold, filaments, other things the hold takes, and anything else, each type with how many.

import { intDictOrder } from "./py27DictOrder.ts";

/** inventorycommon/const.py flags, categories and the ice products' group; evetypes/const.py the two lists. */
const HI_SLOTS = new Set([27, 28, 29, 30, 31, 32, 33, 34]);
const MED_SLOTS = new Set([19, 20, 21, 22, 23, 24, 25, 26]);
const LO_SLOTS = new Set([11, 12, 13, 14, 15, 16, 17, 18]);
const RIG_SLOTS = new Set([92, 93, 94]);
const SERVICE_SLOTS = new Set([164, 165, 166, 167, 168, 169, 170, 171]);
const VISIBLE_SUBSYSTEMS = new Set([125, 126, 127, 128]);
const FLAG_CARGO = 5;
const FLAG_DRONE_BAY = 87;
const FLAG_FIGHTER_BAY = 158;
const CATEGORY_MODULE = 7;
const CATEGORY_CHARGE = 8;
const CATEGORY_IMPLANT = 20;
const CATEGORY_SUBSYSTEM = 32;
const GROUP_ICE_PRODUCT = 423;
export const TYPE_LIST_FILAMENTS = 324;
export const TYPE_LIST_OTHER_CARGO_HOLD_TYPES = 518;

/** dogma/const.py: the effect each slot kind is headed by the name of (dogma.data.get_effect_display_name). */
export const RACK_EFFECTS = Object.freeze({ hiSlots: 12, medSlots: 13, lowSlots: 11, rigSlots: 2663, subSystems: 3772, serviceSlots: 6306 });

/** The labels the other kinds are headed by. */
export const CONTENTS_LABELS = Object.freeze({
  charges: "UI/Generic/Charges",
  ice: "UI/Inflight/MoonMining/Processes/Fuel",
  drones: "UI/Drones/Drones",
  fighters: "UI/Common/Fighters",
  implants: "UI/Fitting/FittingWindow/ImplantsAndBoosters",
  modules: "UI/Fitting/FittingWindow/FittingManagement/Modules",
  filaments: "UI/Fitting/FittingWindow/FittingManagement/Filaments",
  otherInCargo: "UI/Fitting/FittingWindow/FittingManagement/OtherItemsInCargo",
  other: "UI/Fitting/FittingWindow/FittingManagement/OtherItems",
});

export interface TypeFacts {
  readonly groupID: number | null;
  readonly categoryID: number | null;
  /** The type lists (evetypes.GetTypeIDsByListID) the type is on, of the two asked. */
  readonly lists: ReadonlySet<number>;
}

/** One heading of the list and what is under it, each type with how many. */
export interface FittingContentsGroup {
  readonly header: { readonly effectID: number } | { readonly label: string };
  readonly entries: readonly { readonly typeID: number; readonly qty: number }[];
}

/** inventorycommon/const.py: the hidden modifiers' flag, the fighter tubes, and a structure's modules' category. */
const FLAG_HIDDEN_MODIFIERS = 156;
const FIGHTER_TUBES = new Set([159, 160, 161, 162, 163]);
const CATEGORY_DRONE = 18;
const CATEGORY_FIGHTER = 87;
const CATEGORY_STRUCTURE_MODULE = 66;
/** inventorycommon/const.py fittingFlags: the module slots, the visible subsystems, three rig slots, the service slots. */
const FITTING_FLAGS = new Set([...LO_SLOTS, ...MED_SLOTS, ...HI_SLOTS, ...VISIBLE_SUBSYSTEMS, ...RIG_SLOTS, ...SERVICE_SLOTS]);
const MODULE_SLOTS = new Set([...LO_SLOTS, ...MED_SLOTS, ...HI_SLOTS]);

/**
 * fittingSvc.CreateFittingData (180 to 222), with the modules' charges put in the hold (putModuleAmmoInCargo): each
 * visible item of the ship's (inventorycommon.ItemIsVisible) that is fitted (IsShipFittingFlag and IsShipFittable)
 * one entry of its slot; the drones, fighters, the hold's charges and the modules' (to the hold), fuel, implants, the
 * hold's modules, filaments and the other things the hold takes, each type's stacks added up, after them in that
 * order, each kind in the order its dict iterates.
 */
export function createFittingData(
  items: readonly { readonly typeID: number; readonly flagID: number | null; readonly quantity: number }[],
  facts: (typeID: number) => TypeFacts,
  { includeHiddenModifiers = false } = {},
): [number, number, number][] {
  const fitData: [number, number, number][] = [];
  const kinds: { readonly flag: number; readonly order: number[]; readonly totals: Map<number, number> }[] = [
    FLAG_DRONE_BAY, FLAG_FIGHTER_BAY, FLAG_CARGO, FLAG_CARGO, FLAG_CARGO, FLAG_CARGO, FLAG_CARGO, FLAG_CARGO,
  ].map((flag) => ({ flag, order: [] as number[], totals: new Map<number, number>() }));
  const [drones, fighters, charges, ice, implants, modulesInCargo, filaments, other] = kinds;
  const add = (kind: (typeof kinds)[number], typeID: number, quantity: number): void => {
    if (!kind.totals.has(typeID)) kind.order.push(typeID);
    kind.totals.set(typeID, (kind.totals.get(typeID) ?? 0) + quantity);
  };
  for (const { typeID, flagID: flag, quantity } of items) {
    if (flag === null || (!includeHiddenModifiers && flag === FLAG_HIDDEN_MODIFIERS)) continue;
    const { groupID, categoryID, lists } = facts(typeID);
    if ((FITTING_FLAGS.has(flag) || flag === FLAG_HIDDEN_MODIFIERS) && (categoryID === CATEGORY_MODULE || categoryID === CATEGORY_SUBSYSTEM || categoryID === CATEGORY_STRUCTURE_MODULE)) fitData.push([typeID, flag, 1]);
    else if (categoryID === CATEGORY_DRONE && flag === FLAG_DRONE_BAY) add(drones!, typeID, quantity);
    else if (categoryID === CATEGORY_FIGHTER && (flag === FLAG_FIGHTER_BAY || FIGHTER_TUBES.has(flag))) add(fighters!, typeID, quantity);
    else if (categoryID === CATEGORY_CHARGE && flag === FLAG_CARGO) add(charges!, typeID, quantity);
    else if (categoryID === CATEGORY_IMPLANT && flag === FLAG_CARGO) add(implants!, typeID, quantity);
    else if ((categoryID === CATEGORY_MODULE || categoryID === CATEGORY_SUBSYSTEM) && flag === FLAG_CARGO) add(modulesInCargo!, typeID, quantity);
    else if (groupID === GROUP_ICE_PRODUCT && flag === FLAG_CARGO) add(ice!, typeID, quantity);
    else if (categoryID === CATEGORY_CHARGE && MODULE_SLOTS.has(flag)) add(charges!, typeID, quantity);
    else if (lists.has(TYPE_LIST_FILAMENTS)) add(filaments!, typeID, quantity);
    else if (lists.has(TYPE_LIST_OTHER_CARGO_HOLD_TYPES)) add(other!, typeID, quantity);
  }
  for (const kind of kinds) {
    for (const typeID of intDictOrder(kind.order)) fitData.push([typeID, kind.flag, kind.totals.get(typeID) ?? 0]);
  }
  return fitData;
}

type Rack = keyof typeof RACK_EFFECTS;
type Other = keyof typeof CONTENTS_LABELS;

/** GetTypesByRack and GetFittingInfoForScrollList, from a fitting's fitData (each entry its type, flag and how many). */
export function fittingContents(
  fitData: readonly { readonly typeID: number; readonly flagID: number; readonly quantity: number }[],
  facts: (typeID: number) => TypeFacts,
): FittingContentsGroup[] {
  // A slot kind counts its types (a defaultdict(int), each entry one); every other kind keeps each type's quantity,
  // the last one given (a dict). Each in the order the types were first set, as the dict iterates it.
  const racks = new Map<Rack, { order: number[]; counts: Map<number, number> }>();
  const others = new Map<Other, { order: number[]; quantities: Map<number, number> }>();
  const countIn = (rack: Rack, typeID: number): void => {
    const into = racks.get(rack) ?? { order: [] as number[], counts: new Map<number, number>() };
    racks.set(rack, into);
    if (!into.counts.has(typeID)) into.order.push(typeID);
    into.counts.set(typeID, (into.counts.get(typeID) ?? 0) + 1);
  };
  const putIn = (kind: Other, typeID: number, qty: number): void => {
    const into = others.get(kind) ?? { order: [] as number[], quantities: new Map<number, number>() };
    others.set(kind, into);
    if (!into.quantities.has(typeID)) into.order.push(typeID);
    into.quantities.set(typeID, qty);
  };
  for (const { typeID, flagID: flag, quantity: qty } of fitData) {
    const { groupID, categoryID, lists } = facts(typeID);
    if (categoryID === CATEGORY_CHARGE) putIn("charges", typeID, qty);
    else if (categoryID === CATEGORY_IMPLANT) putIn("implants", typeID, qty);
    else if (groupID === GROUP_ICE_PRODUCT) putIn("ice", typeID, qty);
    else if (HI_SLOTS.has(flag)) countIn("hiSlots", typeID);
    else if (MED_SLOTS.has(flag)) countIn("medSlots", typeID);
    else if (LO_SLOTS.has(flag)) countIn("lowSlots", typeID);
    else if (RIG_SLOTS.has(flag)) countIn("rigSlots", typeID);
    else if (SERVICE_SLOTS.has(flag)) countIn("serviceSlots", typeID);
    else if (VISIBLE_SUBSYSTEMS.has(flag)) countIn("subSystems", typeID);
    else if (flag === FLAG_DRONE_BAY) putIn("drones", typeID, qty);
    else if (flag === FLAG_FIGHTER_BAY) putIn("fighters", typeID, qty);
    else if ((categoryID === CATEGORY_MODULE || categoryID === CATEGORY_SUBSYSTEM) && flag === FLAG_CARGO) putIn("modules", typeID, qty);
    else if (lists.has(TYPE_LIST_FILAMENTS)) putIn("filaments", typeID, qty);
    else if (lists.has(TYPE_LIST_OTHER_CARGO_HOLD_TYPES)) putIn("otherInCargo", typeID, qty);
    else putIn("other", typeID, qty);
  }
  const groups: FittingContentsGroup[] = [];
  for (const rack of Object.keys(RACK_EFFECTS) as Rack[]) {
    const held = racks.get(rack);
    if (held === undefined || held.order.length === 0) continue;
    // SortListOfTuples by group: a stable sort, so types of one group keep the dict's order.
    const entries = intDictOrder(held.order)
      .map((typeID) => ({ typeID, qty: held.counts.get(typeID) ?? 0, groupID: facts(typeID).groupID ?? 0 }))
      .sort((left, right) => left.groupID - right.groupID)
      .map(({ typeID, qty }) => ({ typeID, qty }));
    groups.push({ header: { effectID: RACK_EFFECTS[rack] }, entries });
  }
  for (const kind of Object.keys(CONTENTS_LABELS) as Other[]) {
    const held = others.get(kind);
    if (held === undefined || held.order.length === 0) continue;
    groups.push({ header: { label: CONTENTS_LABELS[kind] }, entries: intDictOrder(held.order).map((typeID) => ({ typeID, qty: held.quantities.get(typeID) ?? 0 })) });
  }
  return groups;
}

/**
 * The skill plan editor's types of a dropped fitting (SkillPlanEditorContents._OnDropFitting): the hull, then each of
 * GetTypesByRack's kinds in this order, its types as its dict iterates them, each once: the subsystems, high, medium,
 * low and rig slots, charges, fighters, drones, implants and the hold's modules; then the kinds left as that dict
 * iterates them (asked of the client's own Python: serviceSlots, filaments, ice, other, otherInCargo), where they
 * hold any.
 */
export function fittingTypesForSkillPlan(
  shipTypeID: number,
  fitData: readonly { readonly typeID: number; readonly flagID: number; readonly quantity: number }[],
  facts: (typeID: number) => TypeFacts,
): number[] {
  const kinds = new Map<string, number[]>();
  const into = (kind: string, typeID: number): void => {
    const order = kinds.get(kind) ?? [];
    kinds.set(kind, order);
    if (!order.includes(typeID)) order.push(typeID);
  };
  for (const { typeID, flagID: flag } of fitData) {
    const { groupID, categoryID, lists } = facts(typeID);
    if (categoryID === CATEGORY_CHARGE) into("charges", typeID);
    else if (categoryID === CATEGORY_IMPLANT) into("implants", typeID);
    else if (groupID === GROUP_ICE_PRODUCT) into("ice", typeID);
    else if (HI_SLOTS.has(flag)) into("hiSlots", typeID);
    else if (MED_SLOTS.has(flag)) into("medSlots", typeID);
    else if (LO_SLOTS.has(flag)) into("lowSlots", typeID);
    else if (RIG_SLOTS.has(flag)) into("rigSlots", typeID);
    else if (SERVICE_SLOTS.has(flag)) into("serviceSlots", typeID);
    else if (VISIBLE_SUBSYSTEMS.has(flag)) into("subSystems", typeID);
    else if (flag === FLAG_DRONE_BAY) into("drones", typeID);
    else if (flag === FLAG_FIGHTER_BAY) into("fighters", typeID);
    else if ((categoryID === CATEGORY_MODULE || categoryID === CATEGORY_SUBSYSTEM) && flag === FLAG_CARGO) into("modules", typeID);
    else if (lists.has(TYPE_LIST_FILAMENTS)) into("filaments", typeID);
    else if (lists.has(TYPE_LIST_OTHER_CARGO_HOLD_TYPES)) into("otherInCargo", typeID);
    else into("other", typeID);
  }
  const typeIDs = [shipTypeID];
  const take = (kind: string): void => {
    for (const typeID of intDictOrder(kinds.get(kind) ?? [])) if (!typeIDs.includes(typeID)) typeIDs.push(typeID);
  };
  for (const kind of ["subSystems", "hiSlots", "medSlots", "lowSlots", "rigSlots", "charges", "fighters", "drones", "implants", "modules"]) take(kind);
  for (const kind of ["serviceSlots", "filaments", "ice", "other", "otherInCargo"]) take(kind);
  return typeIDs;
}
