// The pilot's board is a projection of OnHackingTurnComplete (hackingUISvc.py).
import { isListValue, readDictEntry, readKeyVal, unwrapBool, unwrapReal, type JsonValue } from "./wire.ts";

export type HackCoord = readonly [number, number];
export interface HackTile {
  readonly coord: HackCoord;
  readonly type: number;
  readonly subtype: number;
  readonly hidden: boolean;
  readonly blocked: boolean;
  readonly strength: number;
  readonly coherence: number;
  readonly distance: number | null;
  readonly contents: readonly (readonly [number, number])[];
}
export interface HackUtility {
  readonly subtype: number;
  readonly inUse: boolean;
  readonly remaining: number | null;
  readonly amount: number | null;
  readonly totalDuration: number | null;
}
export interface HackBoard {
  readonly start: { readonly moduleTypeID: number | null; readonly targetID: number | null };
  readonly style: number;
  readonly tiles: ReadonlyMap<string, HackTile>;
  readonly utilities: readonly HackUtility[];
  readonly coherence: number;
  readonly strength: number;
  readonly outcome: "won" | "lost" | null;
}
export type HackAction =
  | { readonly type: "tile"; readonly coord: HackCoord; readonly utility: number | null }
  | { readonly type: "virus"; readonly utility: number }
  | { readonly type: "quit" };

const event = {
  lost: 0, won: 1, start: 2, virus: 3, killed: 4, style: 5,
  flipped: 100, tile: 101, blocked: 102, reachable: 103,
  pickedUp: 200, removed: 201, inUse: 202,
  cache: 300, attack: 301, kernel: 302, repair: 303, vector: 304,
  shield: 305, weaken: 306, heal: 307, distance: 308, contents: 400,
} as const;

const list = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : isListValue(value) ? value.items : [];
const num = (value: unknown, key: string) => unwrapReal(readDictEntry(value, key));
const flag = (value: unknown, key: string) => unwrapBool(readDictEntry(value, key));
export const hackCoordKey = ([x, y]: HackCoord): string => x + "," + y;

function pair(value: unknown): readonly [number, number] | null {
  const tuple = value as { type?: unknown; items?: unknown } | null;
  const values = tuple?.type === "tuple" ? list(tuple.items) : list(value);
  const [x, y] = values;
  return values.length === 2 && typeof x === "number" && typeof y === "number" && Number.isSafeInteger(x) && Number.isSafeInteger(y)
    ? [x, y] : null;
}
const coordOf = (data: unknown): HackCoord | null => pair(readDictEntry(data, "coord"));

export function hackNeighbours([x, y]: HackCoord): HackCoord[] {
  const offset = y % 2 === 0 ? -1 : 0;
  return [[x - 1, y], [x + 1, y], [x + offset, y - 1], [x + offset + 1, y - 1],
    [x + offset, y + 1], [x + offset + 1, y + 1]];
}

/** Each turn is applied in server order; the native start marker follows tiles and inventory. */
export function applyHackTurn(previous: HackBoard | null, args: readonly unknown[]): HackBoard | null {
  const events = list(args[0]).map(row => ({ id: readKeyVal(row, "eventID"), data: readKeyVal(row, "eventData") }));
  const start = events.find(row => row.id === event.start);
  if (!start && (!previous || previous.outcome)) return previous;
  const board = start ? {
    start: { moduleTypeID: num(start.data, "moduleTypeID"), targetID: num(start.data, "targetID") },
    style: num(start.data, "gameType") ?? 0, coherence: 0, strength: 0,
    outcome: null, tiles: new Map<string, HackTile>(), utilities: [] as HackUtility[],
  } : { ...previous!, tiles: new Map(previous!.tiles), utilities: [...previous!.utilities] };
  function contentsOf(data: unknown) {
    const items = readDictEntry(data, "contentsList");
    return items === undefined ? null : list(items).map(pair).filter((item): item is HackCoord =>
      item !== null && item[0] > 0 && item[1] > 0);
  }
  function updateTile(data: unknown, killed = false) {
    const coord = coordOf(data);
    if (!coord) return;
    const key = hackCoordKey(coord);
    const tile = board.tiles.get(key);
    const hidden = flag(data, "hidden") ?? tile?.hidden ?? false;
    board.tiles.set(key, {
      coord, hidden, blocked: flag(data, "blocked") ?? tile?.blocked ?? false,
      type: killed ? 0 : num(data, "type") ?? tile?.type ?? -1,
      subtype: killed ? -1 : num(data, "subtype") ?? tile?.subtype ?? -1,
      strength: killed ? 0 : num(data, "strength") ?? tile?.strength ?? 0,
      coherence: killed ? 0 : num(data, "coherence") ?? tile?.coherence ?? 0,
      distance: hidden || killed ? null : num(data, "distanceIndicator") ?? tile?.distance ?? null,
      contents: contentsOf(data) ?? tile?.contents ?? [],
    });
  }
  function updateVirus(data: unknown) {
    board.coherence = num(data, "coherence") ?? board.coherence;
    board.strength = num(data, "strength") ?? board.strength;
  }
  function updateObject(data: unknown, killed = false) {
    if (num(data, "type") === 1 && coordOf(data) === null) updateVirus(data);
    else updateTile(data, killed);
  }
  function updateInventory(value: unknown) {
    if (!Array.isArray(value) && !isListValue(value)) return;
    board.utilities = list(value).map(slot => ({
      subtype: num(slot, "subtype") ?? -1, inUse: flag(slot, "isInUse") ?? false,
      remaining: num(slot, "durationRemaining"), amount: num(slot, "info"), totalDuration: num(slot, "totalDuration"),
    }));
  }
  function updateCharge(data: unknown, change: Partial<HackUtility>) {
    const index = num(data, "index");
    if (index !== null && board.utilities[index]) board.utilities[index] = { ...board.utilities[index], ...change };
  }
  for (const { id, data } of events) {
    switch (id) {
      case event.lost: board.outcome = "lost"; break;
      case event.won: board.outcome = "won"; break;
      case event.style: board.style = num(data, "style") ?? board.style; break;
      case event.virus:
        updateVirus(data);
        updateInventory(readDictEntry(data, "inventory"));
        break;
      case event.killed: updateObject(data, true); break;
      case event.flipped: case event.tile: case event.blocked: case event.reachable:
      case event.cache: case event.kernel: case event.distance: case event.contents:
        updateTile(data);
        break;
      case event.pickedUp:
        updateTile(readDictEntry(data, "replacementObject"));
        updateInventory(readDictEntry(data, "inventory"));
        break;
      case event.removed:
        updateInventory(readDictEntry(readDictEntry(data, "inventory"), "inventory"));
        break;
      case event.inUse: updateCharge(data, { inUse: flag(data, "value") ?? false }); break;
      case event.attack:
        updateObject(readDictEntry(data, "attackerResult"));
        updateObject(readDictEntry(data, "defenderResult"));
        break;
      case event.repair: case event.vector: case event.shield:
        updateCharge(data, { remaining: num(data, "durationRemaining") });
        if (id === event.repair) updateVirus(readDictEntry(data, "target"));
        if (id === event.vector) updateTile(data);
        break;
      case event.weaken: updateVirus(readDictEntry(data, "virus")); break;
      case event.heal: updateTile(readDictEntry(data, "healedObject")); break;
    }
  }
  return board;
}

export function hackCalls(action: HackAction): readonly (readonly [string, JsonValue[]])[] {
  if (action.type === "quit") return [["QuitHackingAttempt", []]];
  if (action.type === "virus") return [["UsedUtilityElementOnVirus", [action.utility]]];
  const coord: JsonValue = { type: "tuple", items: [...action.coord] };
  const click: readonly [string, JsonValue[]] = ["ClickedOnTile", [coord]];
  // OnTileClicked also submits the trailing click when a targeted utility was selected.
  return action.utility === null ? [click] : [["UsedUtilityElement", [action.utility, coord]], click];
}
