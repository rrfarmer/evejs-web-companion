import type { JsonValue } from "./wire.ts";
import type { RequiredSkills } from "./missingSkills.ts";
import { requiredSkillsRecursiveAsDict } from "./skillPlanMilestones.ts";

export const EXORDIUM_REGION = 10001004;
export const ACADEMY_TITLE = "UI/AcademyShips/WindowTitle";
export const ACADEMY_BUTTON = "UI/AcademyShips/WindowButton";
export const ACADEMY_CATEGORIES = [
  { id: 1, name: "Combat" },
  { id: 2, name: "Exploration" },
  { id: 3, name: "Mining" },
] as const;

export interface AcademyShipState {
  readonly shipID: number | null;
  readonly typeID: number | null;
  readonly fittingID: number | null;
  readonly stationID: number | null;
}

export interface AcademyItem {
  readonly typeID: number;
  readonly amount: number;
}

export interface AcademyOffer {
  readonly fittingID: number;
  readonly shipTypeID: number;
  readonly categoryID: number;
  readonly name: string;
  readonly nameID: number;
  readonly descriptionID: number;
  readonly taglineID: number;
  readonly modules: readonly AcademyItem[];
  readonly cargo: readonly AcademyItem[];
}

export interface AcademyType {
  readonly factionID: number | null;
  readonly categoryID: number | null;
  readonly descriptionID?: number | null;
  readonly effects: readonly number[];
  readonly standardTypeID: number;
  readonly slotCounts?: Readonly<Record<number, number>>;
}

export interface AcademyCatalogue {
  readonly offers: readonly AcademyOffer[];
  readonly facts: Readonly<Record<number, AcademyType>>;
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function academyStateOf(value: JsonValue): AcademyShipState | null {
  if (value === null) return null;
  if (typeof value === "object" && "type" in value && value.type === "objectex1" && Array.isArray(value.header)) {
    const [klass, args] = value.header;
    if (klass?.type === "token" && klass.value === "academyships.common.types.AcademyShipState"
        && Array.isArray(args) && args.length === 4 && args.every(part => part === null || positive(part))) {
      const [shipID, typeID, fittingID, stationID] = args as [number | null, number | null, number | null, number | null];
      return { shipID, typeID, fittingID, stationID };
    }
  }
  throw new Error("The Academy loan state could not be read.");
}

// storylines/common/airnpeconstants.py: unknown checkpoints map to scene 1.1.
export function academyTutorialLocked(state: JsonValue, checkpoint: JsonValue): boolean {
  return state === 1 && ![64, 65, 66, 67, 91, 92].some(id => id === checkpoint);
}

const EMPIRES = [500003, 500001, 500004, 500002];
const FACTION_BY_RACE: Readonly<Record<number, number>> = { 1: 500001, 2: 500002, 4: 500003, 8: 500004 };
const RECOMMENDED: Readonly<Record<number, readonly number[]>> = {
  1: [95859, 97272], 2: [97268, 95861], 4: [97270, 97274], 8: [95860, 97273],
};

export function recommendedAcademyShip(raceID: number, categoryID: number): number | undefined {
  return RECOMMENDED[raceID]?.[categoryID - 1];
}

export function academyOffers(catalogue: AcademyCatalogue, categoryID: number, raceID: number, name: (offer: AcademyOffer) => string): AcademyOffer[] {
  const recommended = recommendedAcademyShip(raceID, categoryID);
  const faction = FACTION_BY_RACE[raceID];
  const rank = (offer: AcademyOffer): [number, number, number] => {
    const id = catalogue.facts[offer.shipTypeID]?.factionID;
    const empire = id == null ? -1 : EMPIRES.indexOf(id);
    return [Number(offer.shipTypeID !== recommended), Number(id !== faction), empire < 0 ? -1 : empire];
  };
  return catalogue.offers.filter(offer => offer.categoryID === categoryID).sort((left, right) => {
    const a = rank(left), b = rank(right);
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || name(left).localeCompare(name(right));
  });
}

const RACK_FLAGS: Readonly<Record<number, number>> = { 12: 27, 13: 19, 11: 11, 2663: 92 };
export const ACADEMY_RACKS = [
  { flag: 27, label: "High Slots" }, { flag: 19, label: "Medium Slots" }, { flag: 11, label: "Low Slots" },
  { flag: 92, label: "Rig Slots" }, { flag: 87, label: "Drone Bay" }, { flag: 5, label: "Cargo Hold" },
] as const;

export interface AcademyRackItem extends AcademyItem {
  readonly flag: number;
  readonly rack: number;
}

export function academyFit(offer: AcademyOffer, facts: AcademyCatalogue["facts"]): AcademyRackItem[] {
  const rows: AcademyRackItem[] = [];
  const used = new Map<number, number>();
  for (const item of offer.modules) {
    const type = facts[item.typeID];
    const effect = type?.effects.find(id => id in RACK_FLAGS || id === 3772 || id === 6306);
    const rack = effect === undefined ? undefined : RACK_FLAGS[effect];
    if (rack !== undefined) {
      const first = used.get(rack) ?? 0;
      for (let offset = 0; offset < item.amount; offset++) {
        rows.push({ typeID: item.typeID, amount: 1, rack, flag: rack + first + offset });
      }
      used.set(rack, first + item.amount);
    } else if (type?.categoryID === 18) {
      rows.push({ ...item, rack: 87, flag: 87 });
    }
  }
  const rackOrder = ACADEMY_RACKS.map(({ flag }) => Number(flag));
  return [
    ...rows.sort((a, b) => rackOrder.indexOf(a.rack) - rackOrder.indexOf(b.rack)),
    ...offer.cargo.map(item => ({ ...item, rack: 5, flag: 5 })),
  ];
}

export function academyWheelSlots(offer: AcademyOffer, facts: AcademyCatalogue["facts"]) {
  const fit = academyFit(offer, facts);
  const counts = facts[offer.shipTypeID]?.slotCounts;
  return ACADEMY_RACKS.flatMap(({ flag: rack, label }) =>
    Array.from({ length: counts?.[rack] ?? 0 }, (_, index) => {
      const flag = rack + index;
      return { rack, flag, label, index, typeID: fit.find(item => item.flag === flag)?.typeID ?? null };
    }),
  );
}

export function academyStandardType(typeID: number, facts: AcademyCatalogue["facts"]): number {
  const equivalent = facts[typeID]?.standardTypeID;
  return positive(equivalent) ? equivalent : typeID;
}

export function academyStandardTypes(offer: AcademyOffer, facts: AcademyCatalogue["facts"]) {
  const distinct = (ids: readonly number[]) => [...new Set(ids.map(id => academyStandardType(id, facts)))];
  return {
    shipAndFit: distinct([offer.shipTypeID, ...offer.modules.map(item => item.typeID)]),
    cargo: distinct(offer.cargo.map(item => item.typeID)),
  };
}

/** build_standard_skill_requirements combines recursive needs in fit order, with each skill at its highest level. */
export function academyPlanRequirements(typeIDs: readonly number[], required: RequiredSkills): (readonly [number, number])[] {
  const levels = new Map<number, number>();
  for (const typeID of typeIDs) {
    const needs = requiredSkillsRecursiveAsDict(typeID, required).sort(([left], [right]) => left - right);
    for (const [skill, level] of needs) levels.set(skill, Math.max(level, levels.get(skill) ?? 0));
  }
  return [...levels];
}

export function academyStandardBuy(offer: AcademyOffer, facts: AcademyCatalogue["facts"]): ReadonlyMap<number, number> {
  const wanted = new Map<number, number>();
  for (const item of [{ typeID: offer.shipTypeID, amount: 1 }, ...offer.modules, ...offer.cargo]) {
    const id = academyStandardType(item.typeID, facts);
    wanted.set(id, (wanted.get(id) ?? 0) + item.amount);
  }
  return wanted;
}
