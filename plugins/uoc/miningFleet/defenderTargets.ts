import { tacklersHolding, type decodeSpaceSnapshot } from "../../../web/src/plugin-api/flying.ts";

export type ActiveJam = Parameters<typeof tacklersHolding>[0][number];

type Scene = ReturnType<typeof decodeSpaceSnapshot>;
type Entity = Scene["entities"][number];
type Position = { x: number; y: number; z: number };
export type EscortWeapon = {
  range: number;
  chargeSize?: number;
  turret?: { optimal: number; falloff: number; tracking: number; resolution: number };
  missile?: { explosionRadius: number; explosionVelocity: number; exponent: number };
};
const length = (v: Position) => Math.hypot(v.x, v.y, v.z);
const subtract = (a: Position, b: Position) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Position, b: Position) => a.x * b.x + a.y * b.y + a.z * b.z;
const disabling = new Set([
  "fighterTackle",
  "webify",
  "ewRemoteSensorDamp",
  "electronic",
  "ewEnergyNeut",
  "ewEnergyVampire",
  "ewTrackingDisrupt",
  "ewGuidanceDisrupt",
]);
const usefulApplication = 0.15;
const lightNpcSignatureM = 80;

// This is a preference derived from native Dogma and the sampled geometry. Actual hits and effects still come from EveJS.
function application(
  weapon: EscortWeapon,
  ship: NonNullable<Scene["ship"]>,
  rat: Entity,
  offset: Position,
  distance: number,
  signature: number,
) {
  if (weapon.turret && ship.motionAvailable && rat.motionAvailable) {
    const relative = subtract(rat.velocity, ship.velocity);
    const center = Math.max(1, length(offset)),
      radial = dot(relative, offset) / center ** 2;
    const angular =
      length({
        x: relative.x - offset.x * radial,
        y: relative.y - offset.y * radial,
        z: relative.z - offset.z * radial,
      }) / center;
    const { tracking, resolution, optimal, falloff } = weapon.turret;
    const trackingTerm = (angular * resolution) / (tracking * signature);
    const rangeTerm =
      distance <= optimal ? 0 : falloff > 0 ? (distance - optimal) / falloff : Infinity;
    return 0.5 ** (trackingTerm ** 2 + rangeTerm ** 2);
  }
  if (weapon.missile && rat.motionAvailable) {
    const { explosionRadius, explosionVelocity, exponent } = weapon.missile;
    const size = signature / explosionRadius;
    return Math.min(
      1,
      size,
      ((size * explosionVelocity) / Math.max(0.000001, length(rat.velocity))) ** exponent,
    );
  }
  return null;
}

export function rankEscortTargets(input: {
  ship: NonNullable<Scene["ship"]>;
  targets: readonly Entity[];
  weapons: readonly EscortWeapon[];
  protectedShips: readonly number[];
  jams: readonly ActiveJam[];
  fleetFocus: readonly number[];
  signatureByType: Readonly<Record<number, Readonly<Record<number, number>>>>;
  lockRange: number | null;
  droneRange: number | null;
  now: number;
  defenderIndex?: number;
}) {
  const {
    ship,
    targets,
    weapons,
    protectedShips,
    jams,
    fleetFocus,
    signatureByType,
    lockRange,
    droneRange,
    now,
  } = input;
  const danger = new Map<number, number>();
  const tacklers = new Set(tacklersHolding(jams, now));
  for (const jam of jams)
    if (now < jam.receivedAtMs + (jam.durationMs ?? 20000) + 5000) {
      const priority =
        tacklers.has(jam.sourceBallID) || jam.jammingType === "fighterTackle"
          ? 3
          : disabling.has(jam.jammingType)
            ? 2
            : 0;
      danger.set(jam.sourceBallID, Math.max(priority, danger.get(jam.sourceBallID) ?? 0));
    }
  const charges = weapons.flatMap((w) => (w.chargeSize ? [w.chargeSize] : []));
  const weaponSize = charges.length ? charges.reduce((a, b) => a + b, 0) / charges.length : null;
  const rows = targets.map((rat) => {
    const offset = subtract(rat.position, ship.position),
      distance = Math.max(0, length(offset) - ship.radius - rat.radius);
    const signature = Math.max(1, signatureByType[rat.typeID ?? 0]?.[552] ?? rat.radius);
    const lockable = lockRange === null || distance <= lockRange;
    const shots = weapons
      .filter((w) => distance <= w.range)
      .map((w) => application(w, ship, rat, offset, distance, signature));
    const canShoot = lockable && shots.some((a) => a === null || a >= usefulApplication);
    const drones = droneRange !== null && distance <= droneRange;
    return {
      itemID: rat.itemID,
      typeID: rat.typeID,
      shieldRatio: rat.shieldRatio,
      armorRatio: rat.armorRatio,
      hullRatio: rat.hullRatio,
      engageable: canShoot || drones,
      inRange: (lockable && shots.length > 0) || drones,
      droneInRange: drones,
      canShoot,
      priority:
        danger.get(rat.itemID) ||
        Number(rat.targetEntityID !== null && protectedShips.includes(rat.targetEntityID)),
      focus: fleetFocus.filter((id) => id === rat.itemID).length,
      signature,
      distance,
    };
  });
  rows.sort(
    (a, b) =>
      Number(b.engageable) - Number(a.engageable) ||
      b.priority - a.priority ||
      Number(b.canShoot) - Number(a.canShoot) ||
      (a.canShoot && b.canShoot && weaponSize !== null
        ? weaponSize <= 1.5
          ? a.signature - b.signature
          : weaponSize >= 2.5
            ? b.signature - a.signature
            : 0
        : 0) ||
      b.focus - a.focus ||
      (a.engageable && b.engageable
        ? a.itemID - b.itemID
        : a.distance - b.distance || a.itemID - b.itemID),
  );
  const lead = rows[0];
  if (
    input.defenderIndex == null ||
    !lead?.engageable ||
    lead.typeID === null ||
    lead.priority >= 2 ||
    lead.signature > lightNpcSignatureM
  )
    return rows;
  // Spread equivalent light NPCs without overriding range, weapon application
  // or a disabling threat. The configured fleet order breaks simultaneous ties.
  const peers = rows
    .filter(
      (row) =>
        row.engageable &&
        row.priority === lead.priority &&
        row.typeID === lead.typeID &&
        row.signature <= lightNpcSignatureM &&
        row.canShoot === lead.canShoot &&
        row.droneInRange === lead.droneInRange,
    )
    .sort((a, b) => a.itemID - b.itemID);
  const offset = input.defenderIndex % peers.length;
  return [
    ...peers.slice(offset),
    ...peers.slice(0, offset),
    ...rows.filter((row) => !peers.includes(row)),
  ];
}
