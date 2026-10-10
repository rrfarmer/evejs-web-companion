// Dogma's writes made by the page itself (the plan's Phase 6b): a module overloaded, and cooled; and a
// module's repair, begun and ended (below, with what a retail client does of each).
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

// ── A module's repair ────────────────────────────────────────────────────────
//
// Until 2026-10-10 a repair was one route of the BFF (POST /api/bridge/dogma/module/repair/start), which checked
// `confirm` and made InitiateModuleRepair on the BFF's own dogma object. Nothing made the other half. A retail
// client's repair is two calls, both godma's:
//
//   InitiateModuleRepair(itemID)   godma.py 2227 (RepairModule). The module button's Repair, offered for a module
//                                  with damage that is not being repaired (shipmodulebutton.py 497 to 505). The
//                                  server takes the paste and begins. An answer of False begins nothing.
//   StopModuleRepair(itemID)       godma.py 2261 (StopRepairModule). GODMA SENDS IT ITSELF: when the repair's time
//                                  is up (RepairModule_thread: the module's damage over the character's repair
//                                  rate is the minutes, and it waits a second more), at Cancel Repair, and for
//                                  every repair it began when the session changes station, system, ship,
//                                  character or structure (ProcessSessionChange, 1199).
//
// THE SERVER MENDS THE MODULE AT THE SECOND CALL, by the time since the first, and not before. A repair that is
// begun and never ended takes the paste and mends nothing: that is what the page's route did.
//
// Neither call is in a Tranquility recording: their forms are from the client's code alone. The server begins a
// repair only for a damaged module of the session's own character, fitted to the ship it is flying, and ends only
// a repair that session began. Either transport carries both, asked of the dogma service by its name.

/**
 * How long godma lets a repair run before it ends it: the module's damage over the character's repair rate is the
 * minutes (godma.py 2248 to 2251), cut to whole milliseconds as godma cuts them, and the second it adds.
 */
export function repairWaitMs(damage: number, repairRate: number): number {
  return Math.trunc((damage / repairRate) * 60 * 1000) + 1000;
}

/** The repairs begun here and not yet ended: godma's modulesBeingRepaired. */
export interface ModuleRepairs {
  /**
   * Begins a module's repair, which takes the paste. False where the server answers False: nothing is kept.
   * Otherwise the repair is ended after `waitMs`, unless it was ended before. Fails as the call fails.
   */
  begin(moduleID: number, waitMs: number): Promise<boolean>;
  /** Ends a repair begun here, which is when the server mends the module. Nothing for a module not being repaired. */
  end(moduleID: number): Promise<void>;
  /** Ends every repair begun here: godma's doing at a session's change. One that fails does not keep the rest. */
  endAll(): Promise<void>;
  beingRepaired(moduleID: number): boolean;
}

/**
 * A pilot's repairs. `later` runs something after so many milliseconds (a timer, unless a test stands in);
 * `ended` is told of each repair once it has been ended, mended or not.
 */
export function createModuleRepairs(
  act: Ask,
  options: { readonly later?: (ms: number, run: () => void) => void; readonly ended?: (moduleID: number) => void } = {},
): ModuleRepairs {
  const later = options.later ?? ((ms, run) => { setTimeout(run, ms); });
  /** Each module being repaired, with the mark of the beginning that is its own (godma keeps a time stamp). */
  const begun = new Map<number, object>();
  async function end(moduleID: number): Promise<void> {
    if (!begun.has(moduleID)) return;
    try {
      await act("dogmaIM", "StopModuleRepair", [moduleID]);
    } finally {
      // 2262 to 2264: said and forgotten whatever became of the call.
      begun.delete(moduleID);
      options.ended?.(moduleID);
    }
  }
  return {
    async begin(moduleID, waitMs) {
      if ((await act("dogmaIM", "InitiateModuleRepair", [moduleID])) === false) return false;
      const mark = {};
      begun.set(moduleID, mark);
      // RepairModule_thread (2253): when the time is up, only the beginning that is still this module's ends it.
      later(waitMs, () => {
        if (begun.get(moduleID) === mark) void end(moduleID).catch(() => {});
      });
      return true;
    },
    end,
    async endAll() {
      for (const moduleID of [...begun.keys()]) await end(moduleID).catch(() => {});
    },
    beingRepaired: (moduleID) => begun.has(moduleID),
  };
}
