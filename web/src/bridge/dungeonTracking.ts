// The dungeon the pilot is in, as the client's dungeon tracking keeps it, and a gate's ship restrictions.
//
// TRACKED (eve/client/script/parklife/dungeonTracking.py): set by the server's OnEnteringDungeonRoom(dungeon_id,
// room_id, room_position, instance_id, dungeon_values), a room of the same dungeon only moving it on (124 to 133); let
// go by OnExitingDungeon(dungeon_id) where it is that dungeon or none is named (_clear_dungeon, 138 to 147), and by any
// change of the session's location (ProcessSessionChange, 56 to 61); asked of the keeper when a character's session
// starts in space (OnCharacterSessionChanged, 63 to 69: keeper.GetCurrentDungeonForCharacter(), a tuple of the
// dungeon, the room, the instance and the values, or None).
//
// USED by Activate Gate's refusal (movementFunctions.RealActivateAccelerationGate, 554 to 562): a DunShipCannotWarp or
// DunBlacklistCannotWarp, with a dungeon tracked, opens the Ship Restrictions window for that dungeon and the gate's
// own object (its slim item's dunObjectID), and says nothing else; with none tracked the refusal is raised as any
// UserError is.

import type { Ask } from "./ask.ts";
import { isListValue, readDictEntry, readDictPairs, unwrapLong, type JsonValue } from "./wire.ts";
import { filetimeToMs } from "../space/crimewatch.ts";

export interface ObjectiveTimer { readonly startMs: number; readonly endMs: number }
export type ObjectiveValue = number | string | boolean | readonly number[] | ObjectiveTimer | null;

export interface CurrentDungeon {
  readonly dungeonID: number;
  readonly roomID: number | null;
  readonly instanceID: number | null;
  readonly values?: Readonly<Record<string, JsonValue>>;
}

/** The refusals the client answers with the Ship Restrictions window where it knows the dungeon. */
export const SHIP_RESTRICTION_REFUSALS: ReadonlySet<string> = new Set(["DunShipCannotWarp", "DunBlacklistCannotWarp"]);

const whole = (value: unknown): number | null => {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};

function withDungeonValues(dungeon: CurrentDungeon, value: unknown): CurrentDungeon {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return dungeon;
  const record = value as Record<string, JsonValue>;
  const pairs = record.type === "dict" ? readDictPairs(record) : Object.entries(record);
  const values = Object.fromEntries(pairs.filter(([key]) => typeof key === "string"));
  return Object.keys(values).length ? { ...dungeon, values: { ...dungeon.values, ...values } } : dungeon;
}

/** OnDungeonValues belongs to the named current dungeon. Other keys survive partial updates. */
export function dungeonValuesChanged(current: CurrentDungeon | null, args: readonly unknown[]): CurrentDungeon | null {
  return current !== null && current.dungeonID === whole(args[0]) ? withDungeonValues(current, args[1]) : current;
}

function readObjectiveTimer(value: JsonValue): ObjectiveTimer | null {
  const startMs = filetimeToMs(unwrapLong(readDictEntry(value, "start_time"))?.toString() ?? null);
  const endMs = filetimeToMs(unwrapLong(readDictEntry(value, "end_time"))?.toString() ?? null);
  return startMs !== null && endMs !== null && endMs > startMs ? { startMs, endMs } : null;
}

/** The live scalar, ID lists and simulation-time timers used by objective tasks. */
export function dungeonObjectiveContext(dungeon: CurrentDungeon): Readonly<Record<string, ObjectiveValue>> {
  const context: Record<string, ObjectiveValue> = Object.create(null);
  for (const [key, value] of Object.entries(dungeon.values ?? {})) {
    const sequence = isListValue(value) ? value.items : Array.isArray(value) ? value : null;
    if (sequence !== null && sequence.every((item) => typeof item === "number" && Number.isSafeInteger(item))) {
      context[key] = sequence as readonly number[];
    } else if (value === null || typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
      context[key] = value;
    } else {
      const timer = readObjectiveTimer(value);
      if (timer !== null) context[key] = timer;
    }
  }
  return { ...context, dungeon_id: dungeon.dungeonID, dungeon_room_id: dungeon.roomID };
}

/** Once out of warp and outside the lobby, graph 669 sends start_objectives to the site graph. */
export function dungeonEntryObjectives(dungeon: CurrentDungeon, rules: readonly { readonly listKey: string | null; readonly objectiveKey: string }[]): readonly string[] {
  const lobbyRoom = whole(dungeon.values?.lobby_room_id);
  if (lobbyRoom !== null && lobbyRoom === dungeon.roomID) return [];
  return rules.filter(({ listKey }) => {
    if (listKey === null) return true;
    const value = dungeon.values?.[listKey];
    const ids = Array.isArray(value) ? value : isListValue(value) ? value.items : [];
    return ids.includes(dungeon.dungeonID);
  }).map(({ objectiveKey }) => objectiveKey);
}

/** OnEnteringDungeonRoom's arguments: the dungeon, the room and the instance; null where they cannot be read. */
export function dungeonEntered(args: readonly unknown[]): CurrentDungeon | null {
  const dungeonID = whole(args[0]);
  return dungeonID === null ? null : withDungeonValues({ dungeonID, roomID: whole(args[1]), instanceID: whole(args[3]) }, args[4]);
}

/** The next tracked dungeon on OnEnteringDungeonRoom (OnEnteringDungeonRoom, 124 to 133). */
export function enterDungeonRoom(current: CurrentDungeon | null, entered: CurrentDungeon): CurrentDungeon {
  return current !== null && current.dungeonID === entered.dungeonID &&
    (entered.instanceID === null || current.instanceID === entered.instanceID)
    ? { ...current, roomID: entered.roomID } : entered;
}

/** The tracked dungeon after OnExitingDungeon(dungeon_id) (_clear_dungeon): let go where it is that one or none is named. */
export function exitDungeon(current: CurrentDungeon | null, args: readonly unknown[]): CurrentDungeon | null {
  const dungeonID = whole(args[0]);
  return current === null || dungeonID === null || current.dungeonID === dungeonID ? null : current;
}

/** keeper.GetCurrentDungeonForCharacter(): (dungeon_id, room_id, instance_id, dungeon_values), or None. */
export async function readCurrentDungeon(ask: Ask): Promise<CurrentDungeon | null> {
  const answer = await ask("keeper", "GetCurrentDungeonForCharacter", []);
  const parts = Array.isArray(answer) ? answer : isListValue(answer) ? answer.items : null;
  if (parts === null) return null;
  const dungeonID = whole(parts[0]);
  return dungeonID === null ? null : withDungeonValues({ dungeonID, roomID: whole(parts[1]), instanceID: whole(parts[2]) }, parts[3]);
}

/** The Ship Restrictions window's words (ship_restrictions_window.py). */
export const SHIP_RESTRICTIONS_LABELS = Object.freeze({
  caption: "UI/Dungeons/ShipRestrictionsWindow",
  showUnlockedOnly: "UI/Dungeons/ShipRestrictionShowUnlockedOnly",
  hideRestricted: "UI/Dungeons/ShipRestrictionHideRestricted",
  showList: "UI/Agents/Dialogue/DungeonShipRestrictionsShowList",
  notRestricted: "UI/Agents/Dialogue/DungeonShipRestrictionsListShipIsNotRestricted",
  restricted: "UI/Agents/Dialogue/DungeonShipRestrictionsListShipIsRestricted",
});

/**
 * ship_restrictions_window.SHIP_GROUP_ORDER: the ship tree's groups in the order the window lists them (shipgroup's
 * groupRookie to groupJumpFreighter, read through the client's Python); any other after them, by name.
 */
export const SHIP_GROUP_ORDER: readonly number[] = Object.freeze([
  4, 8, 9, 10, 11, 12, 13, 94, 14, 2101, 15, 93, 50, 16, 17, 18, 19, 20, 21, 96, 22, 23, 25, 24, 2109, 26, 47, 27, 28,
  32, 2102, 2104, 33, 2113, 34, 35, 41, 48, 42, 43, 36, 44, 40, 45, 46, 37, 38,
]);

/** What the BFF answers of a dungeon's restrictions (GET /api/dungeons/ship-restrictions). */
export interface ShipRestrictions {
  readonly dungeonNameID: number | null;
  readonly typeListID: number | null;
  /** Whether the groups are the client's ship tree's (else the inventory groups). */
  readonly shipTree: boolean;
  /** The ship tree's groups' names' messages, by group. */
  readonly groupNameIDs: Readonly<Record<number, number>>;
  readonly allowed: readonly { readonly typeID: number; readonly groupID: number }[];
  readonly restricted: readonly { readonly typeID: number; readonly groupID: number }[];
}

/** Decodes the BFF's answer; null for a dungeon the tables lack. */
export function decodeShipRestrictions(data: Readonly<Record<string, JsonValue>>): ShipRestrictions | null {
  if (data.found !== true) return null;
  const entries = (value: JsonValue | undefined) => (Array.isArray(value) ? value : []).flatMap((entry) => {
    const row = entry as Record<string, JsonValue> | null;
    const typeID = whole(row?.typeID);
    const groupID = whole(row?.groupID);
    return typeID !== null && groupID !== null ? [{ typeID, groupID }] : [];
  });
  const groupNameIDs: Record<number, number> = {};
  const groups = data.groups;
  if (typeof groups === "object" && groups !== null && !Array.isArray(groups)) {
    for (const [key, value] of Object.entries(groups)) {
      const nameID = whole((value as Record<string, JsonValue> | null)?.nameID);
      if (whole(key) !== null && nameID !== null) groupNameIDs[Number(key)] = nameID;
    }
  }
  return {
    dungeonNameID: whole(data.dungeonNameID),
    typeListID: whole(data.typeListID),
    shipTree: data.shipTree === true,
    groupNameIDs,
    allowed: entries(data.allowed),
    restricted: entries(data.restricted),
  };
}
