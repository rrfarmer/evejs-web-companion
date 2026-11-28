import type { PluginRunContext } from "../../../../web/src/plugin-api/backend.ts";
import type { PilotSession } from "../../../../web/src/plugin-api/pilotSession.ts";
import {
  buildSlots,
  slotFlagOf,
  loadFitting,
  decodeFlightStatus,
  getFlightStatus,
} from "../../../../web/src/plugin-api/flying.ts";
import { decodeModuleObservation, type ModuleEffect } from "../../shared/moduleObservation.ts";
import { checkedInventory, type NativeInventoryRow } from "../../shared/nativeInventory.ts";

type Scope = {
  operationID: string;
  runID: string;
  sessionGeneration: number;
  characterID: number;
  shipID: number;
  moduleID: number;
  typeID: number;
};
type Fuel =
  | {
      availability: "available";
      source: "client-effective-dogma";
      typeID: number;
      requiredQuantity: number;
      availableQuantity: number;
      sufficient: boolean;
      eligibleFlags: readonly number[];
      stacks: readonly NativeInventoryRow[];
    }
  | { availability: "unknown"; reason: string };
export type IndustrialCoreRead =
  | { availability: "unknown"; scope: Scope; reason: string }
  | {
      availability: "available";
      scope: Scope;
      core: {
        flagID: number;
        effectID: number;
        effectName: string;
        online: true;
        active: boolean;
        effect: ModuleEffect | null;
        effectiveCycleMs: number | null;
        timeFiletime: string;
        wallclockFiletime: string;
      };
      fuel: Fuel;
      deactivation: "unknown";
      startedAt: number;
      effectObservedAt: number;
      completedAt: number;
    };
const id = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
/** Read-only held Core preflight. Fuel is an effective-client estimate, not a server quote or mobility grant. */
export function createIndustrialCoreObservation(config: {
  operationID: string;
  runID: string;
  run: Pick<PluginRunContext, "characterID" | "baseUrl" | "fetch">;
  session: PilotSession;
  shipID: number;
  moduleID: number;
  typeID: number;
  sessionGeneration: number;
  current: () => void;
  now?: () => number;
}) {
  const { run, session } = config,
    now = config.now ?? Date.now,
    scope: Scope = Object.freeze({
      operationID: config.operationID,
      runID: config.runID,
      sessionGeneration: config.sessionGeneration,
      characterID: run.characterID,
      shipID: config.shipID,
      moduleID: config.moduleID,
      typeID: config.typeID,
    });
  const guard = () => {
    config.current();
    if (
      !scope.operationID ||
      !scope.runID ||
      ![scope.characterID, scope.shipID, scope.moduleID, scope.typeID].every(id) ||
      !Number.isSafeInteger(scope.sessionGeneration) ||
      scope.sessionGeneration < 0 ||
      session.flow.flying.isSessionClosing() ||
      session.flow.flying.sessionGeneration() !== scope.sessionGeneration ||
      session.store.station.get().online?.characterID !== scope.characterID
    )
      throw Error("held-owner-or-session-changed");
  };
  const options = () => ({
    ...session.flow.requestOptions(),
    baseUrl: run.baseUrl,
    fetch: run.fetch,
  });
  const readJSON = async (path: string): Promise<any> => {
    guard();
    const r = await run.fetch(new URL(path, run.baseUrl)),
      x = await r.json();
    guard();
    if (!r.ok || x?.ok !== true || x.available !== true)
      throw Error("native-type-metadata-unavailable");
    return x;
  };
  const flight = async () => {
    guard();
    const f = decodeFlightStatus((await getFlightStatus(options())).flight);
    guard();
    if (f.shipID !== scope.shipID || !id(f.solarSystemID) || f.docked === f.inSpace)
      throw Error("flight-scope-unavailable");
    return f;
  };
  const fitting = async () => {
    guard();
    const x = await loadFitting(options());
    guard();
    if (
      x.activeShipID !== scope.shipID ||
      x.errors.slots !== null ||
      x.errors.shipInfo !== null ||
      x.errors.online !== null
    )
      throw Error("fitting-unavailable");
    const slots = buildSlots(x.slots, x.shipInfo, x.online),
      all = slots
        .filter((s) => s.module)
        .map((s) => ({
          itemID: s.module!.itemID,
          typeID: s.module!.typeID,
          flagID: slotFlagOf(s.family, s.index),
          groupID: s.module!.groupID,
          online: s.module!.online,
        }));
    const hits = slots.filter(
      (s) =>
        s.family === "high" &&
        s.module?.itemID === scope.moduleID &&
        s.module.typeID === scope.typeID,
    );
    if (
      hits.length !== 1 ||
      !hits[0]?.module ||
      hits[0].module.groupID !== 515 ||
      !hits[0].module.online
    )
      throw Error("qualified-online-core-not-fitted");
    const flagID = slotFlagOf(hits[0].family, hits[0].index);
    if (
      !id(flagID) ||
      all.some((m) => !id(m.itemID) || !id(m.typeID) || !id(m.flagID)) ||
      new Set(all.map((m) => m.itemID)).size !== all.length ||
      new Set(all.map((m) => m.flagID)).size !== all.length
    )
      throw Error("fitting-identity-unavailable");
    return { flagID, signature: JSON.stringify(all.sort((a, b) => a.itemID - b.itemID)) };
  };
  async function observe(): Promise<IndustrialCoreRead> {
    const start = now();
    try {
      guard();
      const before = await flight(),
        first = await fitting(),
        meta = await readJSON(`/api/client-data/dogma-types?typeIDs=${scope.typeID}`),
        t = meta.types?.[scope.typeID];
      if (t?.categoryID !== 7 || t.groupID !== 515 || !Array.isArray(t.effects))
        throw Error("core-type-unavailable");
      const found = t.effects.filter(
        (e: unknown) =>
          id(e) &&
          typeof meta.effects?.[e]?.name === "string" &&
          /industrial.*core/i.test(meta.effects[e].name),
      );
      if (found.length !== 1) throw Error("core-effect-identity-unavailable");
      const effectID = found[0] as number,
        effectName = meta.effects[effectID].name as string;
      guard();
      const module = decodeModuleObservation(
          await session.flow.flying.bridgeAsk("dogmaIM", "ItemGetInfo", [scope.moduleID]),
          {
            moduleID: scope.moduleID,
            typeID: scope.typeID,
            ownerID: scope.characterID,
            shipID: scope.shipID,
            flagID: first.flagID,
          },
        ),
        effectObservedAt = now();
      guard();
      if (!module.online) throw Error("core-online-effect-unavailable");
      const matching = module.effects.filter((e) => e.effectID === effectID);
      if (
        matching.length > 1 ||
        matching.some(
          (e) => e.durationMs <= 0 || BigInt(e.startFiletime) > BigInt(module.timeFiletime),
        )
      )
        throw Error("core-active-effect-unavailable");
      const fuelType = module.attributes?.[713],
        amount = module.attributes?.[714],
        cycle = module.attributes?.[73];
      let fuel: Fuel = {
        availability: "unknown",
        reason: "effective-fuel-or-inventory-unavailable",
      };
      if (
        id(fuelType) &&
        typeof amount === "number" &&
        Number.isFinite(amount) &&
        amount > 0 &&
        Number.isSafeInteger(Math.round(amount)) &&
        Math.round(amount) > 0
      ) {
        try {
          const facts = await readJSON(`/api/client-data/dogma-types?typeIDs=${fuelType}`),
            group = facts.types?.[fuelType]?.groupID;
          if (!id(group)) throw Error("fuel-type-group-unavailable");
          const flags = group === 423 ? [133, 5] : [5],
            stacks: NativeInventoryRow[] = [],
            seenInventory = new Set<number>();
          guard();
          await session.flow.flying.bridgeDo("invCache", "InvalidateLocationCache", [scope.shipID]);
          guard();
          for (const flag of flags) {
            const raw = await session.flow.flying.bridgeAsk(
              "invbroker",
              "List",
              [],
              { flag },
              scope.shipID,
            );
            guard();
            const rows = checkedInventory(raw);
            if (
              rows.some(
                (x) =>
                  x.ownerID !== scope.characterID ||
                  x.locationID !== scope.shipID ||
                  x.flagID !== flag,
              ) ||
              rows.some((x) => seenInventory.has(x.itemID))
            )
              throw Error("fuel-inventory-identity-unavailable");
            for (const row of rows) seenInventory.add(row.itemID);
            stacks.push(...rows.filter((x) => x.typeID === fuelType));
          }
          const availableQuantity = stacks.reduce((n, x) => n + x.quantity, 0),
            requiredQuantity = Math.round(amount);
          if (!Number.isSafeInteger(availableQuantity)) throw Error("fuel-quantity-overflow");
          fuel = {
            availability: "available",
            source: "client-effective-dogma",
            typeID: fuelType,
            requiredQuantity,
            availableQuantity,
            sufficient: availableQuantity >= requiredQuantity,
            eligibleFlags: flags,
            stacks,
          };
        } catch {
          guard();
          fuel = { availability: "unknown", reason: "effective-fuel-or-inventory-unavailable" };
        }
      }
      const last = await fitting(),
        after = await flight(),
        end = now();
      guard();
      if (
        first.signature !== last.signature ||
        before.shipID !== after.shipID ||
        before.solarSystemID !== after.solarSystemID ||
        before.inSpace !== after.inSpace ||
        before.docked !== after.docked ||
        before.stationID !== after.stationID ||
        before.structureID !== after.structureID ||
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end < start ||
        !Number.isFinite(effectObservedAt) ||
        effectObservedAt < start ||
        effectObservedAt > end ||
        end - start >= 60000
      )
        throw Error("observation-scope-or-freshness-changed");
      return {
        availability: "available",
        scope,
        core: {
          flagID: first.flagID,
          effectID,
          effectName,
          online: true,
          active: matching.length === 1,
          effect: matching[0] ?? null,
          effectiveCycleMs:
            typeof cycle === "number" && Number.isFinite(cycle) && cycle > 0 ? cycle : null,
          timeFiletime: module.timeFiletime,
          wallclockFiletime: module.wallclockFiletime,
        },
        fuel,
        deactivation: "unknown",
        startedAt: start,
        effectObservedAt,
        completedAt: end,
      };
    } catch (error) {
      return {
        availability: "unknown",
        scope,
        reason: error instanceof Error ? error.message : "observation-unavailable",
      };
    }
  }
  return { observe };
}
