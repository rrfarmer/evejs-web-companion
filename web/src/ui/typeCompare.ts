// Types asked to be compared from outside the compare tool (menusvc.CompareType, 2355 to 2363: the new tool,
// use_new_comparison_tool being on by default, ComparisonWindow.open_and_compare: comparisonWindow.py 85 to 97, the
// window opened where it is not and the type added to it), and the tool's settings (comparisonSettings.py): whether
// only the attributes that differ are shown (compare_onlyShowDifferent, a setting of the pilot's, kept), and the
// attributes hidden (attribute_blacklist, kept while the client runs).
//
// Watched as the market's details are (marketDetails.ts): by the workspace, which opens the window, and by the
// window, which takes the types (as it mounts, and while it is open) and adds them.

import { createSignal, readonlySignal, type ReadableSignal } from "../store/signals.ts";

export interface ComparisonSubject {
  readonly typeID: number;
  readonly itemID: number | null;
}

export function comparisonKey(subject: ComparisonSubject): string {
  return `${subject.typeID}:${subject.itemID ?? ""}`;
}

/** TypeComparer.add_types resolves the insertion index before taking any existing columns out. */
export function placeComparedSubjects(
  current: readonly ComparisonSubject[],
  incoming: readonly ComparisonSubject[],
  before: string | null,
  categoryOf: (typeID: number) => number | null,
): readonly ComparisonSubject[] {
  const index = before === null ? -1 : current.findIndex(subject => comparisonKey(subject) === before);
  const kept = [...current];
  const added: ComparisonSubject[] = [];
  const seen = new Set<string>();
  for (const subject of incoming) {
    const key = comparisonKey(subject);
    if (seen.has(key)) continue;
    seen.add(key);
    const existing = kept.findIndex(previous => comparisonKey(previous) === key);
    if (existing >= 0 && index < 0) continue;
    added.push(existing < 0 ? subject : kept.splice(existing, 1)[0]!);
  }
  if (added.length === 0) return current;
  const category = categoryOf(added[0]!.typeID);
  if (kept.some(subject => categoryOf(subject.typeID) !== category)) kept.length = 0;
  kept.splice(index < 0 ? kept.length : index, 0, ...added);
  return kept;
}

export interface TypeCompareTarget {
  /** How many times types have been asked to be compared. */
  readonly requests: ReadableSignal<number>;
  ask(typeIDs: readonly number[]): void;
  /** The types asked for and not yet taken by the window, which takes them; empty where there are none. */
  take(): number[];
}

export function createTypeCompareTarget(): TypeCompareTarget {
  const requests = createSignal(0);
  let pending: number[] = [];
  return {
    requests: readonlySignal(requests),
    ask(typeIDs) {
      pending = [...pending, ...typeIDs];
      requests.update((count) => count + 1);
    },
    take() {
      const taken = pending;
      pending = [];
      return taken;
    },
  };
}

export const typeCompareTarget: TypeCompareTarget = createTypeCompareTarget();

/** menusvc.CompareType(typeID): the compare tool comparing the type. */
export function compareType(typeID: number): void {
  typeCompareTarget.ask([typeID]);
}

/**
 * menusvc.CompareTypes(typeIDs) (2365 to 2377): the compare tool opened and comparing the types, in their order
 * (open_and_compare_multiple); opened even for none.
 */
export function compareTypes(typeIDs: readonly number[]): void {
  typeCompareTarget.ask(typeIDs);
}

const ONLY_DIFFERENT_KEY = "evejs.compare_onlyShowDifferent";

function storedOnlyDifferent(): boolean {
  try {
    return globalThis.localStorage?.getItem(ONLY_DIFFERENT_KEY) === "1";
  } catch {
    return false;
  }
}

const onlyDifferentSignal = createSignal<boolean>(storedOnlyDifferent());
const hiddenSignal = createSignal<ReadonlySet<number>>(new Set());

/** only_show_diffrentiators_setting (False by default). */
export const onlyShowDifferent: ReadableSignal<boolean> = readonlySignal(onlyDifferentSignal);
/** attribute_blacklist: the attributes the pilot has hidden. */
export const hiddenAttributes: ReadableSignal<ReadonlySet<number>> = readonlySignal(hiddenSignal);

export function setOnlyShowDifferent(value: boolean): void {
  onlyDifferentSignal.set(value);
  try {
    globalThis.localStorage?.setItem(ONLY_DIFFERENT_KEY, value ? "1" : "0");
  } catch {
    // Kept for this page only where the browser keeps nothing.
  }
}

/** AttributeBlacklist.toggle_attribute. */
export function toggleHiddenAttribute(attributeID: number): void {
  const hidden = new Set(hiddenSignal.get());
  if (hidden.has(attributeID)) hidden.delete(attributeID);
  else hidden.add(attributeID);
  hiddenSignal.set(hidden);
}

/**
 * AttributeBlacklist.toggle_show_all: where every attribute is shown (none hidden, and not only those that differ),
 * all of them hidden; else only those that differ turned off and none hidden.
 */
export function toggleShowAll(attributeIDs: readonly number[]): void {
  const showingAll = hiddenSignal.get().size === 0 && !onlyDifferentSignal.get();
  if (showingAll) {
    hiddenSignal.set(new Set([...hiddenSignal.get(), ...attributeIDs]));
  } else {
    setOnlyShowDifferent(false);
    if (hiddenSignal.get().size > 0) hiddenSignal.set(new Set());
  }
}
