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

// ── The weapons linked and unlinked all at once ──────────────────────────────
//
// Until 2026-10-10 each was one route of the BFF (POST /api/bridge/dogma/weapons/link-all and .../unlink-all),
// which checked `confirm` and made the call on the BFF's own dogma object, naming the ship itself. A retail
// client's group-all button makes them (groupAllIcon.py 28 to 39), through its dogma location:
//
//   LinkAllWeapons(shipID)     clientDogmaLocation.py 800: where some weapon could still be grouped (CanGroupAll).
//                              It answers the ship's banks, each master with its slaves.
//   UnlinkAllModules(shipID)   clientDogmaLocation.py 794: where every weapon that can be is grouped already.
//
// THE SHIP is session.shipid, the one the pilot is flying. THE BUTTON IS DEAD for two seconds after a request of
// its kind was answered (UpdateGroupAllButton, and GROUPALL_THROTTLE_TIMER), each kind with a wait of its own.
//
// Neither is in a Tranquility recording; LinkWeapons(shipID, master, slave), which links two by hand, is, riding
// the dogma location's bind. The server holds every bank call to the ship the session is flying. Either transport
// carries both, asked of the dogma service by its name.

/** clientDogmaLocation.py 33, GROUPALL_THROTTLE_TIMER. */
const GROUP_ALL_WAIT_MS = 2000;

export interface WeaponGrouping {
  /** Links every weapon of the ship that can be. False, with nothing asked, while the client's button would be dead. Fails as the call fails. */
  linkAll(shipID: number): Promise<boolean>;
  /** Breaks every bank of the ship, the same way. */
  unlinkAll(shipID: number): Promise<boolean>;
}

/** A pilot's linking and unlinking of all its weapons, with the wait the client's button keeps between two of a kind. */
export function createWeaponGrouping(act: Ask, now: () => number = Date.now): WeaponGrouping {
  // lastGroupAllRequest and lastUngroupAllRequest: when the last request of each kind was answered.
  const answered: { link: number | null; unlink: number | null } = { link: null, unlink: null };
  // UpdateGroupAllButton: dead until the time since, as a share of the wait, is above 0.999.
  const dead = (at: number | null): boolean => at !== null && (now() - at) / GROUP_ALL_WAIT_MS <= 0.999;
  return {
    async linkAll(shipID) {
      if (dead(answered.link)) return false;
      await act("dogmaIM", "LinkAllWeapons", [shipID]);
      answered.link = now();
      return true;
    },
    async unlinkAll(shipID) {
      if (dead(answered.unlink)) return false;
      await act("dogmaIM", "UnlinkAllModules", [shipID]);
      answered.unlink = now();
      return true;
    },
  };
}

// ── Ammunition loaded and unloaded ───────────────────────────────────────────
//
// Until 2026-10-10 each was one route of the BFF (POST /api/bridge/dogma/ammo/load and .../unload), which took a
// word for the place and named the ship and the place itself. A retail client's dogma location makes them
// (clientDogmaLocation.py 973 to 1141):
//
//   LoadAmmo(shipID, moduleID, [chargeItemID, ...], chargeLocationID)
//        LoadChargesToModule, 991: one module by its ID, a bank's master standing for its bank. The module's menu
//        on the rack and a charge dropped on a fitting slot both come to it. Every one Tranquility has recorded is
//        this, with the ship as the place: (shipID, moduleID, [chargeItemID], shipID), answering nothing.
//   LoadAmmo(shipID, [moduleID, ...], [chargeItemID, ...], ammoLocationID)
//        LoadAmmoToModules, 996: several modules at once.
//   UnloadAmmo(shipID, [moduleID, ...], (locationID, ownerID, flag))
//        UnloadAmmoFromModules, 1140, as a fitting slot unfits its charge (fittingSlotController.py 172 to 188):
//        to (where the pilot is docked, the pilot, the hangar flag), or to (the ship, the pilot, the cargo flag).
//
// THE SHIP is the one the session is flying. THE PLACE charges are taken from is where they lie: the ship, for its
// hold, or the station or structure the pilot is docked in, for the hangar. No quantity is named in an unload: the
// modules are emptied. Whether a charge fits a module is the server's to say.
//
// The server holds both calls to the ship the session is flying and to places that session can reach. Either
// transport carries both, asked of the dogma service by its name.

/** invConst.flagHangar and flagCargo: the flags the client names with a place for ammunition. */
const FLAG_HANGAR = 4;
const FLAG_CARGO = 5;

/** Where ammunition lies, or goes: the hold of the ship the pilot is flying, or the hangar of where it is docked. */
export type AmmoPlace = "cargo" | "hangar";

/** What the session says of the pilot, for a call that names its ship and where it is. */
export interface AmmoSession {
  /** session.shipid. */
  readonly shipID: number;
  /** session.charid. */
  readonly characterID: number;
  /** session.structureid or session.stationid: where the pilot is docked, and null in space. */
  readonly dockedAt: number | null;
}

/** A place's ID: the ship for its hold, and where the pilot is docked for the hangar. In space there is no hangar. */
function placeID(session: AmmoSession, place: AmmoPlace): number {
  if (place === "cargo") return session.shipID;
  if (session.dockedAt === null) throw new Error("The hangar is at hand only while docked.");
  return session.dockedAt;
}

/** Puts the charges of these stacks into the modules. One module is named by its ID, several as a list. Fails as the call fails. */
export async function loadAmmo(act: Ask, session: AmmoSession, moduleIDs: readonly number[], chargeItemIDs: readonly number[], from: AmmoPlace): Promise<void> {
  if (moduleIDs.length === 0) throw new Error("No module was named to load.");
  // LoadChargesToModule raises before it calls where there are none.
  if (chargeItemIDs.length === 0) throw new Error("There are no charges to load.");
  const fromID = placeID(session, from);
  await act("dogmaIM", "LoadAmmo", [session.shipID, moduleIDs.length === 1 ? moduleIDs[0]! : [...moduleIDs], [...chargeItemIDs], fromID]);
}

/** Empties the modules of their charges, into the hold or the hangar. Fails as the call fails. */
export async function unloadAmmo(act: Ask, session: AmmoSession, moduleIDs: readonly number[], to: AmmoPlace): Promise<void> {
  if (moduleIDs.length === 0) throw new Error("No module was named to unload.");
  const destination = [placeID(session, to), session.characterID, to === "cargo" ? FLAG_CARGO : FLAG_HANGAR];
  await act("dogmaIM", "UnloadAmmo", [session.shipID, [...moduleIDs], destination]);
}
