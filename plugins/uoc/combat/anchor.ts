import type { PluginRunContext } from "../../../web/src/plugin-api/backend.ts";
import type { PilotSession } from "../../../web/src/plugin-api/pilotSession.ts";
import { getFlightStatus, decodeFlightStatus } from "../../../web/src/plugin-api/flying.ts";
const groups = new Map<number, number>([
  [25, 1],
  [324, 1],
  [830, 1],
  [831, 1],
  [834, 1],
  [893, 1],
  [1283, 1],
  [420, 2],
  [541, 2],
  [1305, 2],
  [1534, 2],
  [26, 3],
  [358, 3],
  [832, 3],
  [833, 3],
  [894, 3],
  [906, 3],
  [963, 3],
  [419, 4],
  [540, 4],
  [1201, 4],
  [27, 5],
  [381, 5],
  [898, 5],
  [900, 5],
]);
/** WC74 combatOperations.js hull class mapping; unknown hulls remain unknown. */
export function combatShipClass(categoryID: unknown, groupID: unknown): number | null {
  return categoryID === 6 && typeof groupID === "number" ? (groups.get(groupID) ?? null) : null;
}
export function selectCombatAnchor<
  T extends { characterID: number; shipID: number; shipClass: number | null },
>(members: readonly T[], maximum = Infinity): T | null {
  return (
    [...members]
      .filter(
        (m) =>
          Number.isSafeInteger(m.characterID) &&
          m.characterID > 0 &&
          Number.isSafeInteger(m.shipID) &&
          m.shipID > 0 &&
          Number.isSafeInteger(m.shipClass) &&
          m.shipClass! > 0 &&
          m.shipClass! <= maximum,
      )
      .sort((a, b) => b.shipClass! - a.shipClass! || a.characterID - b.characterID)[0] ?? null
  );
}
export async function readCombatShipClass(
  run: Pick<PluginRunContext, "fetch" | "baseUrl">,
  typeID: number,
  current: () => void,
): Promise<number | null> {
  if (!Number.isSafeInteger(typeID) || typeID <= 0) return null;
  current();
  const response = await run.fetch(
      new URL(`/api/client-data/type-prices?typeIDs=${typeID}`, run.baseUrl),
    ),
    body = await response.json();
  current();
  if (!response.ok || body?.ok !== true) return null;
  return combatShipClass(body.categoryID?.[typeID], body.groupID?.[typeID]);
}

/** Qualify this held ship twice around the native hull-class read. A successor
 * must be in flight, stable and outside warp; unknown geometry/classes never win. */
export async function readHeldCombatAnchor<T extends { characterID: number; shipID: number }>(
  run: Pick<PluginRunContext, "fetch" | "baseUrl">,
  session: PilotSession,
  member: T,
  current: () => void,
  inFlight: boolean,
) {
  const read = async () => {
    current();
    const f = decodeFlightStatus(
      (
        await getFlightStatus({
          ...session.flow.requestOptions(),
          baseUrl: run.baseUrl,
          fetch: run.fetch,
        })
      ).flight,
    );
    current();
    return f;
  };
  const before = await read();
  if (before.shipID !== member.shipID) throw Error("Selected anchor ship changed.");
  const shipClass = await readCombatShipClass(run, before.shipTypeID ?? 0, current),
    after = await read();
  const stable =
    after.shipID === member.shipID &&
    after.shipTypeID === before.shipTypeID &&
    after.solarSystemID === before.solarSystemID &&
    (!after.transition || after.transition.phase === "ready") &&
    (!before.transition || before.transition.phase === "ready");
  const flying =
    !inFlight ||
    (before.inSpace &&
      !before.docked &&
      after.inSpace &&
      !after.docked &&
      typeof before.shipMode === "string" &&
      typeof after.shipMode === "string" &&
      !/warp/i.test(before.shipMode) &&
      !/warp/i.test(after.shipMode));
  return { ...member, shipClass: stable && flying ? shipClass : null };
}
