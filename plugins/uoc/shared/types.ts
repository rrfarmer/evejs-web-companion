// Pure structural aliases from the stable plugin API. No imports from core internals.
import type { ScriptObservation } from "../../../web/src/plugin-api/index.ts";
import type {
  combatFit,
  decodeSpaceSnapshot,
  loadInventory,
} from "../../../web/src/plugin-api/flying.ts";
export type { Ask } from "../../../web/src/plugin-api/flying.ts";
export type { JsonValue } from "../../../web/src/plugin-api/index.ts";
export type { DictEntry } from "./wire.ts";
export type CoreSpaceSnapshot = ReturnType<typeof decodeSpaceSnapshot>;
export type ModuleReach = {
  readonly moduleID: number;
  readonly typeID: number;
  readonly family: "mining" | "tractor";
  readonly resourceFamily: "ore" | "ice" | "gas" | null;
  readonly maxRangeMeters: number | null;
  readonly settlementSurfaceDistanceMeters: number | null;
  readonly availability: "available" | "unknown";
  readonly reason: string | null;
};
export type ModuleReachObservation = {
  readonly shipID: number | null;
  readonly sampledAtSimTimeMs: number | null;
  readonly availability: "available" | "unknown";
  readonly modules: readonly ModuleReach[] | null;
};
// Older core does not project moduleReach: absence remains unknown, never a range grant.
export type SpaceSnapshot = Omit<CoreSpaceSnapshot, "ship"> & {
  readonly ship:
    | (NonNullable<CoreSpaceSnapshot["ship"]> & {
        readonly moduleReach?: ModuleReachObservation | null;
      })
    | null;
};
export type SpaceEntity = SpaceSnapshot["entities"][number];
export type MiningHold = NonNullable<ScriptObservation["holds"]>[number];
export type AgentConversation = NonNullable<ScriptObservation["conversation"]>;
export type CoreJournalState = NonNullable<ScriptObservation["journal"]>;
export type MissionSpot = NonNullable<CoreJournalState["active"][number]["bookmarks"]>[number] & {
  readonly ownerID?: number | null;
};
export type JournalState = CoreJournalState;
export type InventoryItemRow = NonNullable<ScriptObservation["stationHangar"]>[number];
export type FittedModule = NonNullable<Parameters<typeof combatFit>[1][number]["module"]>;
export type RawInventoryPanel = Awaited<ReturnType<typeof loadInventory>>;
export interface CurrentDungeon {
  readonly dungeonID: number;
  readonly roomID: number | null;
  readonly instanceID: number | null;
}
export interface FoundAgent {
  readonly agentID: number;
  readonly name: string;
  readonly level: number | null;
  readonly divisionID: number | null;
  readonly agentTypeID: number | null;
  readonly missionKind: string | null;
  readonly missionTypeLabel: string | null;
  readonly corporationID: number | null;
  readonly corporationName?: string | null;
  readonly factionID: number | null;
  readonly stationID: number | null;
  readonly stationName: string | null;
  readonly solarSystemID: number | null;
  readonly solarSystemName: string | null;
}
export interface FindAgentsResult {
  readonly kind: string;
  readonly level: number | null;
  readonly total: number;
  readonly capped: boolean;
  readonly agents: readonly FoundAgent[];
}
