// Dogma's writes made by the page itself (the plan's Phase 6b): a module overloaded, and cooled.
//
// Until 2026-10-10 each was one route of the BFF (POST /api/bridge/dogma/module/overload and
// .../stop-overload), which checked that the page had said `confirm` and made one call on a dogma
// object the BFF bound for itself, with no effect named. A retail client has no such routes: godma
// makes the calls (eve/client/script/environment/godma.py).
//
// THE CALLS, as the client makes them:
//
//   Overload(itemID, effectID)       godma.py 2075, on the dogma location bound for where the pilot is
//   StopOverload(itemID, effectID)   godma.py 2120, the same two
//
// The effect is the module's own effect of the overload category. The module's button finds it among
// the module's effects (shipmodulebutton.py 231) and does nothing at all for a module that has none;
// it overloads a module that is not overloaded and cools one that is. Tranquility has the first
// recorded, on the dogma location's object: Overload(moduleID, 3001).
//
// WHAT A MODULE'S OVERLOAD EFFECT IS the client has in its own static data. The page has a module's
// type and asks the BFF's copy of that data for the type's effect, once, and keeps the answer
// (GET /api/types/overload-effects: no call of the server's).
//
// THE SERVER overloads only a module fitted to the ship the session is flying, and answers the
// module's ID. Either transport carries the calls, asked of the dogma service by its name: the game
// port makes each on the dogma location it keeps as godma keeps it. THE ROUTES STILL STAND
// (src/server.js); nothing of the page's asks them now.

import type { Ask } from "./ask.ts";

/** A module overloaded (`on`) or cooled, with the ID of its own overload effect. Fails as the call fails. */
export async function setOverload(act: Ask, moduleID: number, effectID: number, on: boolean): Promise<void> {
  await act("dogmaIM", on ? "Overload" : "StopOverload", [moduleID, effectID]);
}

/** What a client knows of a module type's overload effect without asking the server. */
export interface OverloadEffects {
  /** The ID of the type's overload effect, or null for a type that has none. Fails where it could not be read. */
  of(typeID: number): Promise<number | null>;
}

/**
 * A type's overload effect, asked of the static data once for a type and kept: an effect, or that the type has
 * none. `read` answers for the types it is given; a type it says nothing of was not answered, and nothing is
 * kept of a reading that failed.
 */
export function createOverloadEffects(
  read: (typeIDs: readonly number[]) => Promise<Readonly<Record<number, number | null>>>,
): OverloadEffects {
  const kept = new Map<number, number | null>();
  return {
    async of(typeID) {
      const known = kept.get(typeID);
      if (known !== undefined) return known;
      const answer = await read([typeID]);
      const effectID = answer[typeID];
      if (effectID === undefined) throw new Error("What that module's overload effect is could not be read.");
      kept.set(typeID, effectID);
      return effectID;
    },
  };
}
