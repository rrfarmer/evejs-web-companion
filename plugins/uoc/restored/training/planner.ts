export const FITTING_TIERS = ["FAST", "BALANCED", "VETERAN", "ELITE"] as const;
export type PlanDepth = (typeof FITTING_TIERS)[number];
export type SkillGoal = { typeID: number; level: number };
export type Recommendation = SkillGoal & { mandatoryLevel: number; reason: string };
export type FittingItem = readonly [typeID: number, flagID: number, quantity: number];
type DogmaType = {
  attributes: readonly (readonly [number, number | null])[];
  effects: readonly number[];
  requiredSkills: readonly number[];
  groupID: number | null;
  categoryID: number | null;
};
type DogmaModifier = {
  func: string | null;
  domain: string | null;
  operation: number | null;
  modifiedAttributeID: number | null;
  modifyingAttributeID: number | null;
};
export type FittingDogma = {
  types: Record<number, DogmaType | null>;
  effects: Record<
    number,
    { name?: string | null; modifiers?: readonly DogmaModifier[] | null } | null
  >;
};
type Hard = readonly { typeID: number; toLevel: number }[];
type Progression = readonly [balanced: number, veteran: number, elite: number];
const caps = (hard: Hard) => {
  const levels = new Map<number, number>();
  for (const row of hard)
    levels.set(row.typeID, Math.max(levels.get(row.typeID) ?? 0, row.toLevel));
  return levels;
};
const fitted = (flag: number) =>
  (flag >= 11 && flag <= 34) ||
  (flag >= 92 && flag <= 99) ||
  (flag >= 125 && flag <= 132) ||
  (flag >= 164 && flag <= 171);
const miningHullSkills = [32918, 17940, 22551, 33856];
// Dogma capacities for cargo and the specialized freight holds used in this skill plan.
const freightCapacity = new Set([
  38, 1556, 1557, 1558, 3136, 3227, 1653, 1646, 1559, 5646, 1560, 1564,
]);
const dogmaSkillLevel = 280,
  shipGroupHauler = 28;
const modifiersOf = (type: DogmaType, data: FittingDogma) =>
  type.effects
    .flatMap((id) => data.effects[id]?.modifiers ?? [])
    .filter((mod) => mod.func === "ItemModifier" && mod.domain === "shipID");

function haulingModifiers(hull: DogmaType, data: FittingDogma) {
  const attributes = new Map(hull.attributes);
  const freighter =
    hull.groupID === shipGroupHauler ||
    [...freightCapacity].some((id) => id !== 38 && (attributes.get(id) ?? 0) > 0);
  return modifiersOf(hull, data).filter((mod) => {
    if (
      mod.operation !== 6 ||
      mod.modifyingAttributeID === null ||
      mod.modifiedAttributeID === null
    )
      return false;
    const target = mod.modifiedAttributeID,
      coefficient = attributes.get(mod.modifyingAttributeID) ?? 0;
    if (!(Number(attributes.get(target)) > 0)) return false;
    return (
      (freightCapacity.has(target) && coefficient > 0) ||
      (freighter && ((target === 37 && coefficient > 0) || (target === 70 && coefficient < 0)))
    );
  });
}

export function haulingSkillCandidates(hullID: number, data: FittingDogma): readonly number[] {
  const hull = data.types[hullID];
  return hull && haulingModifiers(hull, data).length ? hull.requiredSkills : [];
}

/** Trace the skill-level multiplier into a hull bonus coefficient and then into a useful ship attribute. */
function haulingBonuses(hull: DogmaType, data: FittingDogma) {
  const improvements = haulingModifiers(hull, data);
  return hull.requiredSkills.flatMap((typeID) => {
    const skill = data.types[typeID];
    if (skill?.categoryID !== 16) return [];
    const coefficients = new Set(
      modifiersOf(skill, data)
        .filter((mod) => mod.operation === 0 && mod.modifyingAttributeID === dogmaSkillLevel)
        .map((mod) => mod.modifiedAttributeID),
    );
    const benefits = improvements
      .filter((mod) => coefficients.has(mod.modifyingAttributeID))
      .map((mod) => mod.modifiedAttributeID!);
    if (!benefits.length) return [];
    const capacity = benefits.some((id) => freightCapacity.has(id)),
      movement = benefits.some((id) => id === 37 || id === 70);
    return [
      {
        typeID,
        reason:
          capacity && movement
            ? "Increases the selected hull's hauling capacity and improves its movement."
            : capacity
              ? "Increases the selected hull's hauling capacity."
              : "Improves the selected hauling hull's speed or alignment.",
      },
    ];
  });
}
const droneOperationSkills = [24241, 33699, 3441, 23594];

/** Recommendations follow fitted tools and the effective hull. Cargo spares do not define the ship's role. */
export function recommendFittingSkills(
  hullID: number,
  equipment: readonly FittingItem[],
  hard: Hard,
  depth: PlanDepth,
  data: FittingDogma,
): Recommendation[] {
  if (depth === "FAST") return [];
  const tier = FITTING_TIERS.indexOf(depth) - 1;
  const floors = caps(hard),
    goals = new Map<number, Recommendation>();
  const add = (typeID: number, progression: Progression, reason: string) => {
    const level = progression[tier] ?? 0,
      mandatoryLevel = floors.get(typeID) ?? 0,
      old = goals.get(typeID);
    if (level > mandatoryLevel && (!old || level > old.level))
      goals.set(typeID, { typeID, level, mandatoryLevel, reason });
  };
  const hull = data.types[hullID];
  const mods = equipment.flatMap(([id, flag, quantity]) => {
    const type = data.types[id];
    return type && fitted(flag) && (type.categoryID === 7 || type.categoryID === 32)
      ? [{ type, quantity }]
      : [];
  });
  const drones = equipment.flatMap(([id, flag, quantity]) => {
    const type = data.types[id];
    return type && flag === 87 && type.categoryID === 18 ? [{ type, quantity }] : [];
  });
  const attr = (type: DogmaType | null | undefined, id: number) =>
    type?.attributes.find((row) => row[0] === id)?.[1] ?? 0;
  const has = (type: DogmaType | null | undefined, effect: number) =>
    type?.effects.includes(effect) === true;
  const effectNamed = (type: DogmaType | null | undefined, name: RegExp) =>
    type?.effects.some((id) => name.test(data.effects[id]?.name ?? "")) === true;
  const required = (type: DogmaType, skill: number) => type.requiredSkills.includes(skill);
  const moduleHas = (effect: number) => mods.some((m) => has(m.type, effect));
  const moduleNeeds = (skill: number) => mods.some((m) => required(m.type, skill));
  const demand = (attribute: number) => mods.some((m) => attr(m.type, attribute) > 0);

  add(3449, [2, 4, 4], "Sublight speed for travel and repositioning.");
  add(3453, [2, 4, 4], "Agility for quicker alignment and maneuvering.");
  add(3392, [2, 3, 3], "Inexpensive structure hit points for everyday piloting.");
  if (demand(50)) add(3426, [2, 3, 4], "CPU headroom for this fitting's modules.");
  if (demand(30)) add(3413, [2, 3, 4], "Powergrid headroom for this fitting's modules.");
  if (demand(6)) {
    add(3417, [2, 3, 4], "Capacitor recharge for the installed active modules.");
    add(3418, [0, 3, 4], "Larger capacitor reserve for the installed active modules.");
  }
  const ore = mods.some(
    (m) => has(m.type, 67) && required(m.type, 3386) && !required(m.type, 16281),
  );
  const ice = mods.some((m) => has(m.type, 67) && required(m.type, 16281));
  const gas = mods.filter((m) => has(m.type, 2726) && required(m.type, 25544));
  if (ore) {
    add(3386, [3, 4, 5], "Increases yield of the fitted ore mining lasers or strip miners.");
    add(
      3410,
      [0, 3, 5],
      "Astrogeology adds 5% ore yield per level to modules requiring Mining. Level V has a substantial rank-3 SP cost.",
    );
  }
  if (ice) add(16281, [2, 4, 5], "Shortens the fitted ice harvester's cycle.");
  const scoops = Math.min(
    5,
    gas.reduce((n, m) => n + m.quantity, 0),
  );
  if (scoops > 1)
    add(
      25544,
      [scoops, scoops, scoops],
      `Supports running the ${scoops} fitted gas harvesters together. Further levels add no extra harvesters to this fit.`,
    );
  if (
    (ore && effectNamed(hull, /mining.*(yield|duration)|miningLaserDuration/i)) ||
    (ice && effectNamed(hull, /ice.*(duration|harvesting)/i)) ||
    (gas.length && effectNamed(hull, /gas.*(duration|harvesting)/i))
  ) {
    for (const id of miningHullSkills.filter((id) => hull?.requiredSkills.includes(id)))
      add(id, [2, 4, 5], "Improves the hull's bonus for the fitted harvesting equipment.");
  }
  if (moduleNeeds(22578))
    add(
      22578,
      [2, 4, 4],
      "Reduces the fitted mining upgrade's extra CPU demand on mining equipment.",
    );

  const turret = moduleHas(10) && moduleNeeds(3300),
    missile = moduleHas(101) && moduleNeeds(3319);
  const ewar =
    moduleNeeds(3435) &&
    (moduleHas(39) ||
      moduleHas(6426) ||
      effectNamed(mods.find((m) => required(m.type, 3435))?.type, /scramble|webif|disrupt/i));
  if (ore || ice || gas.length || turret || missile || ewar || drones.length) {
    add(3431, [2, 3, 4], "Faster target locking for the selected equipment.");
    if (attr(hull, 192) >= 4)
      add(3429, [0, 2, 3], "Additional locked targets within this hull's targeting limit.");
  }
  if (turret) {
    add(3300, [3, 4, 4], "Improves rate of fire for fitted turrets.");
    add(3310, [2, 4, 4], "Additional rate of fire for fitted turrets.");
    add(3312, [2, 4, 4], "Tracking for fitted turrets against moving targets.");
    add(3315, [0, 0, 3], "Advanced turret damage for fitted guns.");
    if (mods.some((m) => has(m.type, 10) && attr(m.type, 6) > 0))
      add(3316, [2, 3, 4], "Reduces capacitor use of the fitted capacitor-powered turrets.");
    if (moduleNeeds(3303))
      add(3303, [3, 4, 5], "Damage bonus for the fitted small energy turrets.");
    if (moduleNeeds(12213))
      add(12213, [2, 3, 4], "Specialization damage bonus for the fitted T2 small pulse lasers.");
  }
  if (missile) {
    add(3319, [2, 4, 4], "Faster cycling for the fitted missile launchers.");
    add(21071, [2, 4, 4], "Improves missile launcher rate of fire.");
    add(20314, [0, 3, 4], "Better missile application against moving targets.");
    add(20315, [0, 0, 3], "Advanced damage for the fitted missile launchers.");
  }
  if (ewar) add(3435, [2, 3, 4], "Reduces capacitor use of the fitted tackle.");
  if (moduleHas(6731) && moduleNeeds(3450))
    add(3450, [2, 3, 4], "Afterburner capacitor use and cycle behavior.");
  if (moduleHas(6730) && moduleNeeds(3454))
    add(3454, [0, 3, 4], "Reduces the fitted microwarpdrive's capacitor cost.");

  const armor =
    moduleHas(27) || mods.some((m) => effectNamed(m.type, /armor.*(resist|hitpoint|hpbonus)/i));
  const shield =
    moduleHas(4) || moduleHas(21) || mods.some((m) => effectNamed(m.type, /shield.*resist/i));
  if (armor) add(3394, [2, 4, 4], "Armor hit points for the selected armor tank.");
  if (moduleHas(27)) add(3393, [2, 4, 4], "Shorter cycles for the fitted armor repairer.");
  if (shield) {
    add(3419, [2, 4, 4], "Shield capacity for the selected shield tank.");
    add(3416, [2, 3, 4], "Shield recharge for the selected shield tank.");
  }
  if (moduleHas(4)) add(21059, [0, 3, 4], "Reduces capacitor use of the fitted shield booster.");

  const miningDrones = drones.some((d) => has(d.type, 17) && required(d.type, 3438));
  const iceDrones = drones.some((d) => required(d.type, 43702));
  const combatDrones = drones.filter((d) => has(d.type, 10));
  if (miningDrones || iceDrones || combatDrones.length) {
    let bandwidth = attr(hull, 1271),
      usable = 0;
    for (const d of [...drones].sort((a, b) => attr(a.type, 1272) - attr(b.type, 1272))) {
      const used = attr(d.type, 1272);
      if (used <= 0) continue;
      const n = Math.min(d.quantity, Math.floor(bandwidth / used), 5 - usable);
      usable += n;
      bandwidth -= n * used;
    }
    if (usable > 1)
      add(
        3436,
        [Math.min(usable, 3), usable, usable],
        `Controls up to ${usable} of the fitted drones within the hull's bandwidth.`,
      );
    add(12305, [2, 3, 4], "Reduces transit time for the fitted drones.");
    if (miningDrones || combatDrones.length)
      add(
        3442,
        [0, 0, 3],
        "Advanced damage or yield for the fitted combat or ore-mining drones. Requires Drones V.",
      );
  }
  if (miningDrones) add(3438, [2, 4, 5], "Yield for the fitted ore mining drones.");
  if (iceDrones) add(43702, [2, 4, 5], "Cycle time for the fitted ice mining drones.");
  if (drones.some((d) => required(d.type, 22541)))
    add(22541, [0, 3, 4], "Yield and speed for the fitted advanced mining drones.");
  if (combatDrones.length) {
    for (const id of droneOperationSkills.filter((id) =>
      combatDrones.some((d) => required(d.type, id)),
    ))
      add(id, [2, 4, 5], "Damage for the fitted drone class.");
    add(23606, [0, 3, 4], "Improves fitted combat drone optimal range.");
    add(23618, [0, 3, 4], "Improves fitted combat drone durability.");
  }
  const hauling = hull ? haulingBonuses(hull, data) : [];
  if (hauling.length) {
    for (const bonus of hauling) add(bonus.typeID, [2, 4, 5], bonus.reason);
    add(3455, [2, 4, 4], "Reduces capacitor use on repeated hauling warps.");
  }
  return [...goals.values()].sort((a, b) => a.typeID - b.typeID);
}

/** Existing saved MASTERY requests keep their original skill goals and never adopt the new ELITE policy. */
export function legacyMasteryGoals(hard: Hard, attributes: DogmaType["attributes"]): SkillGoal[] {
  const floors = caps(hard),
    goals = new Map(floors);
  for (const id of goals.keys()) goals.set(id, 5);
  const values = new Map(attributes);
  for (const [id, attribute] of [
    [3426, 48],
    [3413, 11],
    [3418, 482],
    [3417, 55],
    [3416, 479],
    [3419, 263],
    [3392, 9],
    [3394, 265],
    [3449, 37],
    [3453, 70],
  ] as const)
    if ((values.get(attribute) ?? 0) > 0) goals.set(id, 5);
  return [...goals]
    .filter(([id, level]) => level > (floors.get(id) ?? 0))
    .map(([typeID, level]) => ({ typeID, level }));
}
