import { unixMsToFiletime } from "../bridge/activity.ts";
import { DATE_LABELS } from "../bridge/clientWords.ts";
import { unwrapLong } from "../bridge/wire.ts";

// selectedItemTimers.py only shows Upwell states marked non-vulnerable.
const STRUCTURE_REINFORCED = "UI/Structures/States/Reinforced";
const ENTITY_REINFORCED = "UI/Entities/States/Reinforced";
const STRUCTURE_STATES: Readonly<Record<number, string>> = {
  1: "UI/Structures/States/Unanchored",
  2: "UI/Structures/States/Anchoring",
  100: "UI/Structures/States/Online",
  101: "UI/Structures/States/Fitting",
  111: STRUCTURE_REINFORCED,
  113: STRUCTURE_REINFORCED,
  118: "UI/Structures/States/Invulnerable",
};
const ORBITAL_STATES: Readonly<Record<number, string>> = {
  [-6]: "UI/Entities/States/Anchoring",
  [-5]: "UI/Entities/States/Onlining",
  12: "UI/Entities/States/ShieldReinforced",
};
const STATE_UNTIL = "UI/Inflight/ActiveItem/InStateUntil";
const DATE = DATE_LABELS.ll!;
export const SELECTED_ITEM_TIMER_LABELS = [
  STATE_UNTIL, DATE, ENTITY_REINFORCED, ...new Set([...Object.values(STRUCTURE_STATES), ...Object.values(ORBITAL_STATES)]),
];

type Word = (label: string, args?: Readonly<Record<string, string | number>>) => string | null;

function itemsOf(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && "items" in value && Array.isArray(value.items)) return value.items;
  return [];
}

function clockOf(value: unknown): bigint | null {
  const ticks = typeof value === "bigint" ? value : unwrapLong(value);
  return ticks !== null && ticks > 0n ? ticks : null;
}

/** The timer lines for the currently selected slim item, in the client's order. */
export function selectedItemTimerText(
  item: { typeID: number | null; groupID: number | null; categoryID: number | null },
  slim: ReadonlyMap<unknown, unknown> | undefined,
  nowMs: number,
  word: Word,
): string {
  if (!slim) return "";
  const now = unixMsToFiletime(Math.trunc(nowMs));
  const lines: string[] = [];
  const add = (label: string | undefined, deadline: unknown, pausedAt?: unknown) => {
    const end = clockOf(deadline);
    if (label === undefined || end === null) return;
    const paused = clockOf(pausedAt);
    const timestamp = word(DATE, { datetime: String(paused === null ? end : end + now - paused) });
    const structureState = word(label);
    const text = timestamp && structureState ? word(STATE_UNTIL, { structureState, timestamp }) : null;
    if (text) lines.push(text);
  };
  if (item.categoryID === 65) {
    const [, end, paused] = itemsOf(slim.get("timer"));
    add(STRUCTURE_STATES[Number(slim.get("state"))], end, paused);
  }
  if (item.typeID === 81080) {
    const state = Number(slim.get("skyhook_state"));
    const [, end, paused] = itemsOf(slim.get("skyhook_timer"));
    if (state === 211 || state === 213) add(STRUCTURE_REINFORCED, end, paused);
  }
  if (item.groupID === 4810) {
    const [reinforced, deadline] = itemsOf(slim.get("component_reinforce"));
    const end = clockOf(deadline);
    if ((reinforced === true || reinforced === 1) && end !== null && end >= now) add(ENTITY_REINFORCED, end);
  }
  if (item.typeID === 2233 || item.groupID === 1106) {
    add(ORBITAL_STATES[Number(slim.get("orbitalState"))], slim.get("orbitalTimestamp"));
  } else if (item.groupID === 365 && Number(slim.get("posState")) === 3) {
    add(ENTITY_REINFORCED, slim.get("posTimestamp"));
  }
  return lines.join("\n");
}
