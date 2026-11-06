// Pilot Hangar — the parts of the hangar screen that are the player's own
// ARRANGEMENT rather than the server's facts: squads, which squads sit on the
// chip row, which pilots are pinned inside their account, and which accounts are
// collapsed.
//
// None of this exists on the EveJS server. A squad is a label the player puts on
// a set of their own pilots so a mining op or a scout net can be brought online
// in one action; the server has no idea those pilots belong together. So it all
// lives in localStorage beside knownCharacters.ts (same origin, same "names and
// IDs only, never a secret" rule — see the header there).
//
// Everything below the load/save pair is a PURE function on a prefs value. The
// screen reads one snapshot, hands it to these, and writes the result back; no
// component reaches into storage itself, and every rule is testable without a
// DOM.

/** One player-made group of pilots, spanning accounts. */
export interface Squad {
  readonly id: string;
  readonly name: string;
  /** One of SQUAD_PALETTE — the dot/chip colour that identifies it at a glance. */
  readonly color: string;
}

export interface HangarPrefs {
  readonly squads: readonly Squad[];
  /** Squad id -> the characterIDs in it. A pilot may be in several squads. */
  readonly members: Readonly<Record<string, readonly number[]>>;
  /** Squad ids promoted to the chip row (the rest live in the picker). */
  readonly pinnedSquads: readonly string[];
  /** Pilots pinned to the top of their account. */
  readonly pinnedPilots: readonly number[];
  /** Accounts whose section is collapsed to its header. */
  readonly collapsedAccounts: readonly string[];
}

/** The five squad colours. A squad's colour is picked from these and no others. */
export const SQUAD_PALETTE: readonly string[] = [
  "#52d9a3",
  "#6fb4e8",
  "#e0b155",
  "#e07f7f",
  "#b48ae0",
];

export const EMPTY_PREFS: HangarPrefs = {
  squads: [],
  members: {},
  pinnedSquads: [],
  pinnedPilots: [],
  collapsedAccounts: [],
};

const STORAGE_VERSION = 1;
const STORAGE_KEY = `evejs-web-hangar-prefs:v${STORAGE_VERSION}`;

/** The slice of `Storage` this module needs; tests supply their own. */
export interface HangarPrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function detectStorage(): HangarPrefsStorage | null {
  try {
    const candidate = (globalThis as { localStorage?: HangarPrefsStorage | null }).localStorage;
    if (
      candidate &&
      typeof candidate.getItem === "function" &&
      typeof candidate.setItem === "function"
    ) {
      return candidate;
    }
  } catch {
    // Some privacy modes throw on touching localStorage — treat as unavailable.
  }
  return null;
}

let storage: HangarPrefsStorage | null = detectStorage();

/** Point this module at a different store (tests). Passing null disables it. */
export function setHangarPrefsStorage(next: HangarPrefsStorage | null): void {
  storage = next;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function numberList(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    : [];
}

function isSquad(value: unknown): value is Squad {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    o.id.length > 0 &&
    typeof o.name === "string" &&
    typeof o.color === "string"
  );
}

/** The saved arrangement, or an empty one when none is stored / storage is off. */
export function loadHangarPrefs(): HangarPrefs {
  if (!storage) return EMPTY_PREFS;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_PREFS;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return EMPTY_PREFS;
    const o = parsed as Record<string, unknown>;
    const squads = Array.isArray(o.squads) ? o.squads.filter(isSquad) : [];
    const members: Record<string, readonly number[]> = {};
    if (o.members && typeof o.members === "object" && !Array.isArray(o.members)) {
      for (const [key, value] of Object.entries(o.members as Record<string, unknown>)) {
        members[key] = numberList(value);
      }
    }
    return {
      squads,
      members,
      pinnedSquads: stringList(o.pinnedSquads),
      pinnedPilots: numberList(o.pinnedPilots),
      collapsedAccounts: stringList(o.collapsedAccounts),
    };
  } catch {
    return EMPTY_PREFS;
  }
}

/**
 * Fields on disk this build does not know. They are kept, because one may be a setting a
 * plugin has yet to take over (`formerHangarSetting`), and that plugin may be switched
 * off in this browser for now.
 */
function unknownFields(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const known = new Set(Object.keys(EMPTY_PREFS));
    return Object.fromEntries(Object.entries(parsed).filter(([field]) => !known.has(field)));
  } catch {
    return {};
  }
}

const savedListeners = new Set<(prefs: HangarPrefs) => void>();

/**
 * Hear each arrangement as it is saved: a pilot leaving a squad, a squad deleted. For a
 * plugin keeping its own settings per squad member, so that a pilot put back into a
 * squad does not silently get what it had. Returns how to stop listening.
 */
export function onHangarPrefsSaved(listener: (prefs: HangarPrefs) => void): () => void {
  savedListeners.add(listener);
  return () => { savedListeners.delete(listener); };
}

/** Write the arrangement. Best-effort: a full or blocked store is never fatal. */
export function saveHangarPrefs(prefs: HangarPrefs): void {
  if (storage) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify({ ...unknownFields(), ...prefs }));
    } catch {
      // The arrangement is a convenience; losing a write costs a re-pin, not data.
    }
  }
  for (const listener of [...savedListeners]) {
    try {
      listener(prefs);
    } catch (error) {
      console.error("A listener for the Hangar's arrangement threw:", error);
    }
  }
}

// --- pure edits -------------------------------------------------------------

/** A squad id that cannot collide with another made in the same millisecond. */
export function nextSquadId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `squad-${uuid}` : `squad-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** The next palette colour for a new squad, cycling so two in a row differ. */
export function nextSquadColor(prefs: HangarPrefs): string {
  return SQUAD_PALETTE[prefs.squads.length % SQUAD_PALETTE.length] ?? SQUAD_PALETTE[0]!;
}

/** Add a squad (optionally with its founding members) and return the new prefs. */
export function addSquad(
  prefs: HangarPrefs,
  squad: Squad,
  memberIDs: readonly number[] = [],
): HangarPrefs {
  return {
    ...prefs,
    squads: [...prefs.squads, squad],
    members: { ...prefs.members, [squad.id]: [...memberIDs] },
  };
}

/** Rename / recolour one squad. An unknown id leaves the prefs untouched. */
export function updateSquad(
  prefs: HangarPrefs,
  id: string,
  patch: { name?: string; color?: string },
): HangarPrefs {
  return {
    ...prefs,
    squads: prefs.squads.map((s) =>
      s.id === id ? { ...s, name: patch.name ?? s.name, color: patch.color ?? s.color } : s,
    ),
  };
}

/** Delete a squad, its membership and its pin in one go — no dangling ids. */
export function deleteSquad(prefs: HangarPrefs, id: string): HangarPrefs {
  const members = { ...prefs.members };
  delete members[id];
  return {
    ...prefs,
    squads: prefs.squads.filter((s) => s.id !== id),
    members,
    pinnedSquads: prefs.pinnedSquads.filter((s) => s !== id),
  };
}

/** Put a pilot in a squad or take it out. */
export function toggleSquadMember(
  prefs: HangarPrefs,
  squadID: string,
  characterID: number,
): HangarPrefs {
  const current = prefs.members[squadID] ?? [];
  const leaving = current.includes(characterID);
  const next = leaving
    ? current.filter((id) => id !== characterID)
    : [...current, characterID];
  return { ...prefs, members: { ...prefs.members, [squadID]: next } };
}

/**
 * Put several pilots in an existing squad at once, skipping the ones already in
 * it. This is "add the selection to Mining Op": a union, never a replacement —
 * adding two pilots to a squad must not drop the four already in it. An unknown
 * squad id leaves the prefs untouched, so a squad deleted in another tab cannot
 * resurrect itself as a members entry with no squad.
 */
export function addSquadMembers(
  prefs: HangarPrefs,
  squadID: string,
  characterIDs: readonly number[],
): HangarPrefs {
  if (!prefs.squads.some((s) => s.id === squadID)) return prefs;
  const current = prefs.members[squadID] ?? [];
  const have = new Set(current);
  const added = characterIDs.filter((id) => !have.has(id));
  if (added.length === 0) return prefs;
  return { ...prefs, members: { ...prefs.members, [squadID]: [...current, ...added] } };
}

function toggleIn<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/** Promote a squad to the chip row, or send it back to the picker. */
export function togglePinnedSquad(prefs: HangarPrefs, id: string): HangarPrefs {
  return { ...prefs, pinnedSquads: toggleIn(prefs.pinnedSquads, id) };
}

/** Pin a pilot to the top of its account, or unpin it. */
export function togglePinnedPilot(prefs: HangarPrefs, characterID: number): HangarPrefs {
  return { ...prefs, pinnedPilots: toggleIn(prefs.pinnedPilots, characterID) };
}

/** Collapse an account section to its header, or open it again. */
export function toggleCollapsedAccount(prefs: HangarPrefs, accountName: string): HangarPrefs {
  return { ...prefs, collapsedAccounts: toggleIn(prefs.collapsedAccounts, accountName) };
}

/**
 * Drop every trace of pilots that are no longer in the roster. Called after a
 * "remove pilot" / "remove account" in manage mode so a squad does not keep
 * counting a pilot the player can no longer see.
 */
export function forgetPilots(prefs: HangarPrefs, characterIDs: readonly number[]): HangarPrefs {
  const gone = new Set(characterIDs);
  const members: Record<string, readonly number[]> = {};
  for (const [squadID, ids] of Object.entries(prefs.members)) {
    members[squadID] = ids.filter((id) => !gone.has(id));
  }
  return {
    ...prefs,
    members,
    pinnedPilots: prefs.pinnedPilots.filter((id) => !gone.has(id)),
  };
}

/** The squads one pilot belongs to, in the order the player made them. */
export function squadsForPilot(prefs: HangarPrefs, characterID: number): Squad[] {
  return prefs.squads.filter((s) => (prefs.members[s.id] ?? []).includes(characterID));
}

/** How many pilots are in a squad, counting only ones still in the roster. */
export function squadMemberCount(
  prefs: HangarPrefs,
  squadID: string,
  knownIDs: ReadonlySet<number>,
): number {
  return (prefs.members[squadID] ?? []).filter((id) => knownIDs.has(id)).length;
}
