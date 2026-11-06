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

import { failureCode, type Ask } from "./ask.ts";
import { observeDeferredShutdown } from "./moduleShutdown.ts";
import type { FlightNow } from "./movementWrites.ts";
import type { JsonValue } from "./wire.ts";

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
  /**
   * Begins several at once, as godma.RepairManyModules (2204 to 2223): InitiateModuleRepairMany(moduleIDs), answered
   * (success, missingCharges, failed); each begun one kept and ended after its own wait (`waitMsOf`). Fails as the
   * call fails.
   */
  beginMany(moduleIDs: readonly number[], waitMsOf: (moduleID: number) => number): Promise<{ readonly success: readonly number[]; readonly missingCharges: readonly number[]; readonly failed: readonly number[] }>;
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
  function keep(moduleID: number, waitMs: number): void {
    const mark = {};
    begun.set(moduleID, mark);
    // RepairModule_thread (2253): when the time is up, only the beginning that is still this module's ends it.
    later(waitMs, () => {
      if (begun.get(moduleID) === mark) void end(moduleID).catch(() => {});
    });
  }
  /** One of the answer's lists of modules (a list or tuple as the bridge carries it), as whole numbers. */
  const modulesIn = (value: unknown): number[] => {
    const items = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items) ? (value as { items: unknown[] }).items : [];
    return items.map((item) => Number(item && typeof item === "object" && "value" in item ? (item as { value: unknown }).value : item)).filter((id) => Number.isSafeInteger(id) && id > 0);
  };
  return {
    async begin(moduleID, waitMs) {
      if ((await act("dogmaIM", "InitiateModuleRepair", [moduleID])) === false) return false;
      keep(moduleID, waitMs);
      return true;
    },
    async beginMany(moduleIDs, waitMsOf) {
      const answer = await act("dogmaIM", "InitiateModuleRepairMany", [[...moduleIDs]]);
      // (success, missingCharges, failed): a tuple of three lists.
      const parts = Array.isArray(answer) ? answer : answer && typeof answer === "object" && Array.isArray((answer as { items?: unknown }).items) ? (answer as { items: unknown[] }).items : [];
      const [success, missingCharges, failed] = [modulesIn(parts[0]), modulesIn(parts[1]), modulesIn(parts[2])];
      // 2216 to 2218: each begun kept, its time stamp its own.
      for (const moduleID of success) keep(moduleID, waitMsOf(moduleID));
      return { success, missingCharges, failed };
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

// --- A module put online, and taken offline (the plan's Phase 6b) ---------------------------------------------
//
// Until 2026-10-13 it was one route of the BFF (POST /api/bridge/fitting/state), which sent the module with the
// ship the BFF held the pilot to be flying.
//
// THE CALLS, as the client makes them from a fitting slot (fittingSlotController.ToggleOnlineModule, 357 to 366;
// the slot's menu and its button offer it for a module whose type has the online effect, in a slot that is no
// rig's: baseSlot.GetMenu, 101 to 122, and IsOnlineable, 312 to 318), on the dogma location
// (clientDogmaLocation.py):
//
//   SetModuleOnline(dogmaItem.locationID, moduleID)     OnlineModule, 698 to 711
//   TakeModuleOffline(dogmaItem.locationID, moduleID)   OfflineModule, 713 to 723
//
// the ship the module is in, and the module. The client starts the online effect in its own dogma before it asks,
// and stops it again where the server refuses; a server that says the effect is running already
// (EffectAlreadyActive2) has refused nothing. It asks nothing at all for a module of a ship that is being boarded
// or left. Tranquility has one recorded: SetModuleOnline(shipID, moduleID), two whole numbers, on the dogma
// location's object, made by the client itself as a module moved from the hold to a slot
// (_OnlineModuleIfApplicable, 624 to 632), which the game port makes too (src/gamePort/pilots.js,
// onlineIfApplicable). No recording has a button's, nor any TakeModuleOffline.
//
// WHAT THE CLIENT ASKS ITS PILOT FIRST: before a module in a weapon bank is put offline from a fitting slot
// (QueryGroupOffline, 359 to 362), since that breaks the bank up. The page asks where it knows the banks, which is
// in space (ui/EquipmentPanel.svelte). Docked, it is not told of them, and asks nothing.
//
// WHAT THE PAGE DOES NOT DO AS THE CLIENT DOES: the module's button on the rack puts a module online or offline
// by the online effect itself (shipmodulebutton._ChangeOnline, 823 to 847: godma's Activate(itemID, 'online',
// None, 0) and Deactivate(itemID, 'online'), 2049 to 2071 and 2091 to 2101), and asks its pilot before any
// offline there (PutOffline). The page's rack has no such menu: both of its windows make the fitting slot's calls.
//
// THE SERVER (dogmaService/moduleOperation.js, _setModuleOnlineState) takes the ship and the module: the module
// must be the session's own character's and lie in that ship. It refuses with DeniedShipChanged,
// NotEnoughCapacitorForOnline (in space, under 95 in 100 of the capacitor), CannotOnlineReachedMaxGroupOnline and
// CrpAccessDenied, each of which bridge/refusals.ts words, and otherwise in sentences of its own (too little
// CPU or powergrid, a hold too full to lose a module's room). Taking a banked module offline breaks its bank up.
// Asked for what is so already (online while online, offline while offline) it answers nothing and refuses
// nothing (seen live 2026-10-13).
// Either transport carries the calls, asked of the dogma service by its name.
//
// ⚠ THE ANSWER IS NOTHING. The caller reads the fitting after, and goes by the module's state there.

/** Whether a call failed with this refusal of the server's: its envelope, and the key for its message. */
function refusedWith(reason: unknown, key: string): boolean {
  if (failureCode(reason) !== "CALL_REFUSED" || !(reason instanceof Error)) return false;
  const said = reason.message.trim();
  return said === key || said.endsWith(`: ${key}`);
}

/**
 * Puts a fitted module online (`online`) or takes it offline. `shipID` is the ship the module is in. A module the
 * server says is online already has not failed. Fails as the call fails.
 */
export async function setModuleOnline(act: Ask, shipID: number, moduleID: number, online: boolean): Promise<void> {
  for (const [what, id] of [["ship", shipID], ["module", moduleID]] as const) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`That ${what} could not be identified.`);
  }
  if (!online) {
    await act("dogmaIM", "TakeModuleOffline", [shipID, moduleID]);
    return;
  }
  try {
    await act("dogmaIM", "SetModuleOnline", [shipID, moduleID]);
  } catch (reason) {
    if (!refusedWith(reason, "EffectAlreadyActive2")) throw reason;
  }
}

// ── A module switched on, and off ────────────────────────────────────────────
//
// Until 2026-10-14 each was a route of the BFF (POST /api/bridge/modules/activate and .../deactivate), which named
// a launcher's or a propulsion module's effect from the game's data, made the one call, and read the running modules
// for its verdict; the deactivate's watched the module to its cycle's end. A retail client has no such routes: godma
// makes the calls (eve/client/script/environment/godma.py), on the dogma location bound for where the pilot is:
//
//   Activate(itemID, effectName, target, repeat)   2062, from the module's button (shipmodulebutton.py 1348): the
//                                                  module's default effect by name, the active target for an effect
//                                                  aimed at one, and 1000 or 0 for the repeats
//   Deactivate(itemID, effectName)                 2101, the effect it is stopping
//
// THE EFFECT is named always by the client. The page asks the game's data for a module type's default effect
// (GET /api/types/default-effects, the rule godma's), keeps it, and names it; where it has none to name (no type
// said, a type with none or more than one, or the data not read) it sends none, as its routes did: the game port
// names godma's then, and through the gateway the server works out a module's default effect for an Activate,
// though not for a Deactivate (a propulsion module stopped with no effect named keeps running).
//
// THE REPEATS: the page says -1 (until it is stopped) or 0 (one cycle), as its routes took them, and the game port
// sends the client's 1000 or 0 (src/gamePort/retailCalls.js, activation).
//
// ⚠ THE ANSWER IS NOT THE VERDICT, AS THE ROUTES HAD IT: the running modules are read after, as the server's ship
// has them (GET /api/bridge/modules/:itemID/state), a weapon bank's slave by its master. A stop accepted comes at the
// cycle's end: the module's cycle is read with the first reading, and the module watched to it (moduleShutdown.ts),
// the stop never asked again.

/** What a module's switching on or off came to, as the running modules say after it. */
export interface ModuleActionResult {
  readonly itemID: number;
  /** The module is running after an Activate; null where the reading could not say. */
  readonly active: boolean | null;
  /** The module has stopped after a Deactivate; null where the reading could not say. */
  readonly stopped: boolean | null;
  readonly activeModuleIDs: JsonValue;
  readonly notifications: readonly JsonValue[];
}

/** What a client knows of a module type's default effect without asking the server. */
export interface DefaultEffects {
  /** The type's default effect by name, or null where it has none or more than one, or it could not be read. */
  of(typeID: number): Promise<string | null>;
}

/**
 * A type's default effect, asked of the static data once for a type and kept: an effect's name, or that the type
 * has none. A reading that failed answers null and keeps nothing: the call goes with no effect named, as the
 * routes sent it, and the type is asked again next time.
 */
export function createDefaultEffects(
  read: (typeIDs: readonly number[]) => Promise<Readonly<Record<number, string | null>>>,
): DefaultEffects {
  const kept = new Map<number, string | null>();
  return {
    async of(typeID) {
      const known = kept.get(typeID);
      if (known !== undefined) return known;
      let answer: Readonly<Record<number, string | null>>;
      try {
        answer = await read([typeID]);
      } catch (reason) {
        if (failureCode(reason) === "SESSION_NOT_FOUND") throw reason;
        return null;
      }
      const named = answer[typeID];
      if (named === undefined) return null;
      kept.set(typeID, named);
      return named;
    },
  };
}

/** What the page's module calls go by: where the pilot is, the reading of a module, and the types' default effects. */
export interface ModuleDeps {
  readonly flightNow: () => Promise<FlightNow>;
  /** GET /api/bridge/modules/:itemID/state for the ship, the module's cycle with it where `cycle`. */
  readonly state: (itemID: number, shipID: number, cycle: boolean) => Promise<Record<string, JsonValue>>;
  readonly effects: DefaultEffects;
  /** The flow's guard: throws where the flow has gone on to another pilot. */
  readonly current?: () => void;
}

/** The effect a call names: the caller's, else the type's default, else none. */
async function effectFor(deps: ModuleDeps, effect: string | undefined, typeID: number | undefined): Promise<string> {
  if (effect) return effect;
  if (!typeID) return "";
  return (await deps.effects.of(typeID)) ?? "";
}

/** The ship the pilot is flying, in space. Fails before any call for a pilot docked. */
async function shipInSpace(deps: ModuleDeps): Promise<number> {
  const now = await deps.flightNow();
  if (!now.inSpace || now.shipID === null) throw new Error("The ship is not in space; undock first.");
  return now.shipID;
}

const numberOr = (value: JsonValue | undefined): number => (typeof value === "number" && Number.isSafeInteger(value) ? value : Number.NaN);
const flagOf = (value: JsonValue | undefined): boolean | null => (typeof value === "boolean" ? value : null);
const noticesOf = (data: Record<string, JsonValue>): readonly JsonValue[] => (Array.isArray(data.notifications) ? data.notifications : []);

/** How long an accepted Activate gets to show as running, and how often it is looked for. */
const ACTIVATION_SHOWS_WITHIN_MS = 2_000;
const ACTIVATION_LOOK_MS = 250;

/**
 * Switches a module on: its default effect named, at the target where one is said, until it is stopped (-1) or
 * for one cycle (0). Fails as the call fails, and before it for a ship not in space.
 *
 * The module's state is read until it shows as running, for a moment: the server answers the call before the ship's
 * state says so. Read once, a module that had started was reported as refused (seen live 2026-11-06: four salvagers
 * reported refused, and all four running in the server's own samples).
 */
export async function activateModule(
  act: Ask,
  deps: ModuleDeps,
  itemID: number,
  opts: { effect?: string; typeID?: number; targetID?: number | null; repeat?: -1 | 0 } = {},
  clock: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ModuleActionResult> {
  const now = clock.now ?? Date.now;
  const sleep = clock.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const shipID = await shipInSpace(deps);
  const effect = await effectFor(deps, opts.effect, opts.typeID);
  const targetID = opts.targetID && opts.targetID > 0 ? opts.targetID : null;
  // -1 is "as the effect allows": the game port sends the client's 1000 for an effect that can repeat and 0 for one
  // that cannot (shipmodulebutton.py 112 to 122, GetRepeatCount, and 1338), which it knows as godma knows the module.
  await act("dogmaIM", "Activate", [itemID, effect, targetID, opts.repeat === 0 ? 0 : -1]);
  const startedAt = now();
  let after = await deps.state(itemID, shipID, false);
  // Each read hands over what the server has said since the last, so none of it is dropped.
  const notifications = [...noticesOf(after)];
  while (flagOf(after.stopped) === true && now() - startedAt < ACTIVATION_SHOWS_WITHIN_MS) {
    await sleep(ACTIVATION_LOOK_MS);
    deps.current?.();
    after = await deps.state(itemID, shipID, false);
    notifications.push(...noticesOf(after));
  }
  const stopped = flagOf(after.stopped);
  return { itemID: numberOr(after.itemID), active: stopped === null ? null : !stopped, stopped: null, activeModuleIDs: after.activeModuleIDs ?? null, notifications };
}

/**
 * Switches a module off, its effect named, and watches it to its cycle's end where the stop is to come there.
 * Fails as the call fails, and before it for a ship not in space.
 */
export async function deactivateModule(
  act: Ask,
  deps: ModuleDeps,
  itemID: number,
  opts: { effect?: string; typeID?: number } = {},
  clock: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ModuleActionResult> {
  const now = clock.now ?? Date.now;
  const shipID = await shipInSpace(deps);
  const effect = await effectFor(deps, opts.effect, opts.typeID);
  await act("dogmaIM", "Deactivate", [itemID, effect]);
  const startedAt = now();
  const first = await deps.state(itemID, shipID, true);
  const cycleMs = typeof first.cycleMs === "number" && Number.isFinite(first.cycleMs) && first.cycleMs > 0 ? first.cycleMs : null;
  // As the route waited: the cycle and five seconds where the cycle was read, fifteen seconds where it was not.
  const budgetMs = cycleMs === null ? 15_000 : Math.ceil(cycleMs) + 5_000;
  const remainingMs = first.stopped === false ? Math.max(0, startedAt + budgetMs - now()) : 0;
  const watched = await observeDeferredShutdown({ ...first, remainingMs }, itemID, {
    current: deps.current ?? (() => {}),
    read: (ship) => deps.state(itemID, ship, false),
    now: clock.now,
    sleep: clock.sleep,
  });
  return { itemID: numberOr(watched.itemID), active: null, stopped: flagOf(watched.stopped), activeModuleIDs: watched.activeModuleIDs ?? null, notifications: noticesOf(watched) };
}
