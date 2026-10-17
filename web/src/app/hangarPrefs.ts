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

// ⚠ THIS NAME DOES NOT EXIST YET AT THE TIME OF WRITING. The codec module is
// being renamed from `decodeFleetCompanionRequestValue` to
// `decodeCompanionSetupValue` (verdict: `{ ok: true; setup: CompanionSetup }`
// or `{ ok: false; refusal: string }`) by the agent that owns
// `bots/companionRunPolicy.ts`, alongside the retired-keys allowance that lets
// an old role/tagging/module-list config still decode. This file calls the new
// name regardless, on the assumption that rename lands alongside this one.
import { decodeCompanionSetupValue } from "../bots/companionRunPolicy.ts";
import type { CompanionSetup } from "../nav/fleetCompanionLoop.ts";

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
  /**
   * What each pilot DOES in a squad: squad id -> character id -> the companion
   * setup that pilot starts with. A squad says WHICH pilots; this says what
   * each one is for.
   *
   * ⚠ A PARALLEL MAP, NOT A RICHER `members`, AND THAT IS THE WHOLE MIGRATION
   * STORY. Making the membership value richer would mean either bumping
   * STORAGE_VERSION -- which strands every existing arrangement under the old
   * key -- or teaching `numberList` two shapes, which leaves an older build
   * silently coercing the new value to `[]` and wiping every squad it touches.
   * A key an older build has never heard of is simply ignored by it: nothing to
   * migrate, nothing to lose, and membership keeps working exactly as before.
   *
   * ⚠ THE VALUE IS A `CompanionSetup`, NOT A WHOLE REQUEST WITH EMPTY MODULE
   * LISTS ANY MORE. There is no role to pick and nothing here derives modules
   * from a fit -- see docs/fleet-companion-simplification.md. What is stored is
   * exactly `fleeHealthFloor`, `capacitorFloor`, `maxFleeAttempts` and
   * `repairsAtStation`, plus `abandonDronesHealthFloor` when it was ever set;
   * `decodeCompanionSetupValue` is the door on the way out of localStorage, the
   * same door `botHost.start()` trusts, so this file invents no second codec.
   * A companion's eight module lists are never saved anywhere: they are read
   * off the hull it is actually flying when it starts, because an itemID saved
   * here would be stale the moment that pilot refits or changes ship.
   *
   * ⚠ THE PRESENCE OF AN ENTRY IS NOW THE ONLY MARKER THAT A PILOT IS SET UP
   * HERE. A role used to double as "this pilot is a companion in this squad";
   * with no role, that fact is exactly whether `companionConfigFor` returns
   * non-null, and unsetting one means removing the entry (`setCompanionConfig`
   * with `null`), not writing some sentinel into it.
   *
   * ⚠ AND IT IS localStorage, SO IT IS NOT THE AUTHORITY FOR A RUNNING BOT.
   * A headless run outlives the tab; `botHost` persists the request it was
   * STARTED with in its own durable roster row. This map is the template a
   * start is built from, never a live handle on a run.
   */
  readonly companionConfigs: Readonly<Record<string, Readonly<Record<string, CompanionSetup>>>>;
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
  companionConfigs: {},
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

/**
 * Stored companion configs, judged one at a time.
 *
 * ⚠ THE CODEC IS THE DOOR, AND IT IS THE ONE THE BOT HOST ALREADY USES.
 * `localStorage` is untrusted bytes like any other input -- another tab, an
 * older build, a hand-edited value -- so every entry goes through
 * `decodeCompanionSetupValue`, the same function `botHost.start()` trusts. A
 * refused entry is DROPPED rather than defaulted: an arrangement that cannot
 * be read back is a pilot with no config, which the UI already knows how to
 * show, whereas a fabricated default would be a setup nobody chose.
 *
 * ⚠ AN OLD-SHAPE STORED VALUE MUST STILL DECODE. Every config saved before
 * 2026-09-11 carries `role`, `attemptsTagging` and the eight module-id lists —
 * keys `CompanionSetup` no longer has. That is the codec's job, not this
 * file's: `decodeCompanionSetupValue` forgives exactly those retired keys and
 * hands back a `CompanionSetup` with the current ones. This function does not
 * (and must not) run a second migration of its own — it only decides, per
 * entry, whether the codec accepted it.
 */
function companionConfigMap(
  value: unknown,
): Record<string, Readonly<Record<string, CompanionSetup>>> {
  const out: Record<string, Record<string, CompanionSetup>> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return out;
  }
  for (const [squadID, perPilot] of Object.entries(value as Record<string, unknown>)) {
    if (!perPilot || typeof perPilot !== "object" || Array.isArray(perPilot)) {
      continue;
    }
    const pilots: Record<string, CompanionSetup> = {};
    for (const [characterID, stored] of Object.entries(perPilot as Record<string, unknown>)) {
      const decoded = decodeCompanionSetupValue(stored);
      if (decoded.ok) {
        pilots[characterID] = decoded.setup;
      }
    }
    if (Object.keys(pilots).length > 0) {
      out[squadID] = pilots;
    }
  }
  return out;
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
      companionConfigs: companionConfigMap(o.companionConfigs),
    };
  } catch {
    return EMPTY_PREFS;
  }
}

/** Write the arrangement. Best-effort: a full or blocked store is never fatal. */
export function saveHangarPrefs(prefs: HangarPrefs): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // The arrangement is a convenience; losing a write costs a re-pin, not data.
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
  // The configs go with it, for the same "no dangling ids" reason the members
  // and the pin do: a squad id nobody can see again must not keep a set of
  // companion setups alive in storage for ever.
  const companionConfigs = { ...prefs.companionConfigs };
  delete companionConfigs[id];
  return {
    ...prefs,
    squads: prefs.squads.filter((s) => s.id !== id),
    members,
    pinnedSquads: prefs.pinnedSquads.filter((s) => s !== id),
    companionConfigs,
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
  const withMembers = { ...prefs, members: { ...prefs.members, [squadID]: next } };
  if (!leaving) {
    return withMembers;
  }
  // ⚠ A PILOT TAKEN OUT LOSES ITS SETUP HERE. Keeping it would leave a config
  // that `setCompanionConfig` itself would now refuse to write, readable by
  // nothing and pruned by nothing -- and if the pilot were ever put back it
  // would silently inherit a setup from whenever it last left.
  const perPilot = { ...(withMembers.companionConfigs[squadID] ?? {}) };
  delete perPilot[String(characterID)];
  const companionConfigs = { ...withMembers.companionConfigs };
  if (Object.keys(perPilot).length === 0) {
    delete companionConfigs[squadID];
  } else {
    companionConfigs[squadID] = perPilot;
  }
  return { ...withMembers, companionConfigs };
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
  const companionConfigs: Record<string, Readonly<Record<string, CompanionSetup>>> = {};
  for (const [squadID, perPilot] of Object.entries(prefs.companionConfigs)) {
    const kept = Object.fromEntries(
      Object.entries(perPilot).filter(([characterID]) => !gone.has(Number(characterID))),
    );
    if (Object.keys(kept).length > 0) {
      companionConfigs[squadID] = kept;
    }
  }
  return {
    ...prefs,
    members,
    pinnedPilots: prefs.pinnedPilots.filter((id) => !gone.has(id)),
    companionConfigs,
  };
}

/**
 * Give one pilot its companion setup inside one squad, or clear it with null.
 *
 * ⚠ IT REFUSES A PILOT THAT IS NOT IN THE SQUAD, the same way `addSquadMembers`
 * refuses an unknown squad id: a config against a non-member is a setting
 * nothing would ever read, and it would survive every prune that walks
 * membership.
 */
export function setCompanionConfig(
  prefs: HangarPrefs,
  squadID: string,
  characterID: number,
  setup: CompanionSetup | null,
): HangarPrefs {
  if (!(prefs.members[squadID] ?? []).includes(characterID)) {
    return prefs;
  }
  const perPilot = { ...(prefs.companionConfigs[squadID] ?? {}) };
  if (setup === null) {
    delete perPilot[String(characterID)];
  } else {
    perPilot[String(characterID)] = setup;
  }
  const companionConfigs = { ...prefs.companionConfigs };
  if (Object.keys(perPilot).length === 0) {
    delete companionConfigs[squadID];
  } else {
    companionConfigs[squadID] = perPilot;
  }
  return { ...prefs, companionConfigs };
}

/**
 * One pilot's companion setup in one squad, or null when it has none.
 *
 * ⚠ THIS NULL IS NOW THE WHOLE OF "IS THIS PILOT A COMPANION HERE". A role
 * used to answer that question and set the pilot's job in the same field; with
 * no role, existence is the only signal left, so the hangar UI reads this
 * directly rather than reaching for a field on the result.
 */
export function companionConfigFor(
  prefs: HangarPrefs,
  squadID: string,
  characterID: number,
): CompanionSetup | null {
  return prefs.companionConfigs[squadID]?.[String(characterID)] ?? null;
}

/**
 * Every pilot in this squad that is set up to fly, in membership order.
 *
 * This is what a squad start works through: a member with no config is not
 * included, because there is nothing to start it with.
 */
export function companionSquadRoster(
  prefs: HangarPrefs,
  squadID: string,
): readonly { readonly characterID: number; readonly setup: CompanionSetup }[] {
  const perPilot = prefs.companionConfigs[squadID] ?? {};
  return (prefs.members[squadID] ?? []).flatMap((characterID) => {
    const setup = perPilot[String(characterID)];
    return setup === undefined ? [] : [{ characterID, setup }];
  });
}

// ⚠ `competingTaggers` USED TO LIVE HERE AND IS GONE. It counted pilots with
// `attemptsTagging` set, because a tag is unique fleet-wide and two taggers in
// one squad would fight over letters. That setting no longer exists: tagging
// is gated server-side on `obs.canTag` (only a fleet/wing/squad commander may
// write a tag) and the rung only ever tags a ship that is tackling THIS pilot,
// with an already-lettered ship skipped -- so two companions can collide only
// if the same ship tackled both of them in the same tick, before either letter
// was visible. See docs/fleet-companion-simplification.md, "Tagging", and the
// matching note in bots/squadStart.ts.

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
