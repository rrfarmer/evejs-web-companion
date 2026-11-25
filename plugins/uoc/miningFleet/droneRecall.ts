import {
  decodeDroneBay,
  decodeSpaceSnapshot,
  getDrones,
  getSpaceSnapshot,
  returnDronesToBay,
} from "../../../web/src/plugin-api/flying.ts";
import { unwrapLong, type JsonValue } from "../shared/wire.ts";
import type { PluginRunContext } from "../../../web/src/plugin-api/backend.ts";
import type { PilotSession } from "../../../web/src/plugin-api/pilotSession.ts";
import { boundedDroneRead, boundedDroneWrite, checkDroneEngage } from "../combat/droneAdapter.ts";
import { fleetReadFailed } from "./stopSignal.ts";

type Run = Pick<PluginRunContext, "baseUrl" | "fetch">;
type RecallOptions = {
  ids?: readonly number[];
  pendingLaunch?: readonly number[];
  onProgress?: (message: string) => void;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  timeoutMs?: number;
};

function droneID(value: JsonValue | undefined): number | null {
  const long = unwrapLong(value);
  const id = long === null ? NaN : Number(long);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function fleetDronesInSpace(raw: JsonValue) {
  if (!Array.isArray(raw)) return null;
  const out = [],
    seen = new Set<number>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const row = entry as Record<string, JsonValue>;
    const itemID = droneID(row.itemID);
    if (itemID === null || seen.has(itemID) || typeof row.controlled !== "boolean") return null;
    seen.add(itemID);
    const shield =
      row.shieldRatio == null ? NaN : Number(unwrapLong(row.shieldRatio) ?? row.shieldRatio);
    out.push({
      itemID,
      typeID: droneID(row.typeID),
      controlled: row.controlled,
      activity: typeof row.activity === "string" && row.activity.length > 0 ? row.activity : null,
      targetID: droneID(row.targetID),
      shieldRatio: Number.isFinite(shield) ? Math.min(1, Math.max(0, shield)) : null,
    });
  }
  return out;
}

export async function readFleetDronePanel(
  run: Run,
  session: PilotSession,
  shipID: number,
  current: () => void,
) {
  current();
  const raw = await boundedDroneRead(
    () => getDrones({ ...session.flow.requestOptions(), baseUrl: run.baseUrl, fetch: run.fetch }),
    12000,
  ).catch(fleetReadFailed);
  current();
  const bay = decodeDroneBay(raw.bay),
    out = fleetDronesInSpace(raw.inSpace);
  if (
    raw.activeShipID !== shipID ||
    raw.errors?.bay !== null ||
    raw.errors?.inSpace !== null ||
    !Array.isArray(raw.bay) ||
    !bay ||
    !out ||
    bay.length !== raw.bay.length
  )
    throw Error("Drone bay or in-space observation is unavailable for the held ship.");
  return { bay, out, shipInfo: raw.shipInfo };
}

/** Stock return order and a fresh inventory read. A drone leaving the grid is not a bay receipt. */
export async function recallFleetDrones(
  run: Run,
  session: PilotSession,
  shipID: number,
  current: () => void,
  options: RecallOptions = {},
) {
  const flying = session.flow.flying,
    now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const wanted = options.ids ? new Set(options.ids) : null;
  const expected = new Set(options.pendingLaunch ?? []),
    asked = new Set<number>();
  const progressWindow = options.timeoutMs ?? 45000;
  let deadline = now() + progressWindow;
  const bestDistance = new Map<number, number>();
  const request = { ...session.flow.requestOptions(), baseUrl: run.baseUrl, fetch: run.fetch };
  let previousMissing: string | null = null,
    missingReads = 0,
    refusal: string | null = null;
  while (true) {
    current();
    await boundedDroneRead(
      () => flying.bridgeDo("invCache", "InvalidateLocationCache", [shipID]),
      12000,
    ).catch(fleetReadFailed);
    const { out, bay } = await readFleetDronePanel(run, session, shipID, current);
    const selected = out.filter((row) => wanted === null || wanted.has(row.itemID));
    for (const row of selected) expected.add(row.itemID);
    const bayIDs = new Set(bay.map((row) => row.itemID));
    const remaining = [...expected].filter((id) => !bayIDs.has(id));
    const controlled = selected.filter((row) => row.controlled);
    const unaccounted = remaining.filter((id) => !controlled.some((row) => row.itemID === id));
    if (!remaining.length && !controlled.length)
      return { unrecovered: [] as number[], stillControlled: [] as number[], refusal };
    const missingKey = unaccounted
      .slice()
      .sort((a, b) => a - b)
      .join(",");
    if (!controlled.length && missingKey && missingKey === previousMissing) missingReads++;
    else missingReads = 0;
    previousMissing = missingKey;
    if (controlled.length) {
      const scene = await boundedDroneRead(() => getSpaceSnapshot(request), 8000).then(
        (row) => decodeSpaceSnapshot(row.space),
        () => null,
      );
      current();
      if (
        scene?.stateValid !== false &&
        scene?.shipID === shipID &&
        scene.ship?.geometryAvailable
      ) {
        const ship = scene.ship;
        for (const row of scene.entities) {
          if (
            !row.geometryAvailable ||
            row.controllerID !== shipID ||
            !controlled.some((d) => d.itemID === row.itemID)
          )
            continue;
          const meters = Math.hypot(
            row.position.x - ship.position.x,
            row.position.y - ship.position.y,
            row.position.z - ship.position.z,
          );
          const previous = bestDistance.get(row.itemID);
          if (previous === undefined || meters < previous - 100) {
            bestDistance.set(row.itemID, meters);
            deadline = now() + progressWindow;
          }
        }
      }
    }
    if (missingReads >= 2 || now() >= deadline)
      return {
        unrecovered: remaining,
        stillControlled: controlled.map((row) => row.itemID),
        refusal,
      };

    const ids = controlled
      .filter((row) => !asked.has(row.itemID) && row.activity !== "returning")
      .map((row) => row.itemID);
    if (ids.length) {
      for (const id of ids) asked.add(id);
      current();
      try {
        const reply = await boundedDroneWrite(
          () => returnDronesToBay(flying.bridgeDo, ids),
          12000,
          () => {},
        );
        checkDroneEngage(reply, ids);
      } catch (error) {
        current();
        refusal = error instanceof Error ? error.message : String(error);
      }
    }
    options.onProgress?.("Waiting for native drone-bay readback before departure.");
    await wait(1000);
  }
}

export class FleetDroneReturnIncomplete extends Error {
  readonly ids: readonly number[];
  constructor(ids: readonly number[], reason: string | null) {
    super("Drone return did not settle for " + ids.join(", ") + (reason ? ". " + reason : "."));
    this.ids = ids;
  }
}

export function assertFleetDroneDeparture(result: Awaited<ReturnType<typeof recallFleetDrones>>) {
  if (result.stillControlled.length)
    throw new FleetDroneReturnIncomplete(result.stillControlled, result.refusal);
  return result.unrecovered.length
    ? "Drones not recovered to the bay: " + result.unrecovered.join(", ") + "."
    : null;
}
