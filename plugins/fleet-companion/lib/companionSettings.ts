// Which pilots fly as companions in which squad, and with what: squad id -> character id -> the
// setup it starts with. The presence of an entry is the only marker that a pilot is set up there.
//
// A template a start is built from, never a live handle on a run: a server run keeps what it
// was started with on core's roster. It lasts in this browser, as the squads themselves do.

import { formerHangarSetting, loadHangarPrefs, onHangarPrefsSaved, pluginSetting } from "../../../web/src/plugin-api/index.ts";
import { decodeCompanionSetupValue } from "./companionRunPolicy.ts";
import type { CompanionSetup } from "./fleetCompanionLoop.ts";

export type CompanionSetups = Readonly<Record<string, Readonly<Record<string, CompanionSetup>>>>;

/** Saved bytes are untrusted, and an entry that cannot be read is one that was never set up. */
function decodeSetups(raw: unknown): CompanionSetups | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const squads: Record<string, Record<string, CompanionSetup>> = {};
  for (const [squadID, perPilot] of Object.entries(raw)) {
    if (perPilot === null || typeof perPilot !== "object" || Array.isArray(perPilot)) continue;
    const pilots: Record<string, CompanionSetup> = {};
    for (const [characterID, value] of Object.entries(perPilot)) {
      const decoded = decodeCompanionSetupValue(value);
      if (decoded.ok) pilots[characterID] = decoded.setup;
    }
    if (Object.keys(pilots).length > 0) squads[squadID] = pilots;
  }
  return squads;
}

export const companionSetups = pluginSetting<CompanionSetups>("plugin:fleet-companion.setups", {
  initial: {},
  decode: decodeSetups,
  formerly: () => formerHangarSetting("companionConfigs"),
});

/** One pilot's setup in one squad, or null when it has none. */
export function setupFor(setups: CompanionSetups, squadID: string, characterID: number): CompanionSetup | null {
  return setups[squadID]?.[String(characterID)] ?? null;
}

/** Give a pilot its setup in a squad, or clear it with null. */
export function withSetup(setups: CompanionSetups, squadID: string, characterID: number, setup: CompanionSetup | null): CompanionSetups {
  const perPilot = { ...(setups[squadID] ?? {}) };
  if (setup === null) delete perPilot[String(characterID)];
  else perPilot[String(characterID)] = setup;
  const next = { ...setups };
  if (Object.keys(perPilot).length === 0) delete next[squadID];
  else next[squadID] = perPilot;
  return next;
}

/** Every member of a squad set up to fly, in membership order. */
export function squadRoster(setups: CompanionSetups, squadID: string, memberIDs: readonly number[]): readonly { readonly characterID: number; readonly setup: CompanionSetup }[] {
  const perPilot = setups[squadID] ?? {};
  return memberIDs.flatMap((characterID) => {
    const setup = perPilot[String(characterID)];
    return setup === undefined ? [] : [{ characterID, setup }];
  });
}

/**
 * Only what is still in its squad. A pilot taken out and put back must be ticked again, not
 * silently get what it had, and a deleted squad's id is never used again.
 */
export function prunedSetups(setups: CompanionSetups, members: Readonly<Record<string, readonly number[]>>): CompanionSetups {
  const next: Record<string, Record<string, CompanionSetup>> = {};
  for (const [squadID, perPilot] of Object.entries(setups)) {
    const pilots = Object.fromEntries(Object.entries(perPilot).filter(([id]) => (members[squadID] ?? []).includes(Number(id))));
    if (Object.keys(pilots).length > 0) next[squadID] = pilots;
  }
  return JSON.stringify(next) === JSON.stringify(setups) ? setups : next;
}

onHangarPrefsSaved((prefs) => companionSetups.set(prunedSetups(companionSetups.get(), prefs.members)));
// The Hangar in another tab may have changed things while this one was shut.
companionSetups.set(prunedSetups(companionSetups.get(), loadHangarPrefs().members));
