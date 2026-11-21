// R102 Phase-4 BOUND WRITE acks — WB-ENTITY: the 4 drone-command writes
// (CmdReturnHome / CmdSalvage / CmdAbandonDrone / CmdReconnectToDrones) that hang
// off the R72 entity.MachoBindObject bind. PLUMBING ONLY — no UI.
//
// Each write dispatches as a BOUND Cmd* method off entityBindSpec() (the same
// bound two-step the dogma writes use — the BFF holds the OID handle, the browser
// never sees it), NOT the top-level /call seam. Every BFF route is confirm-gated
// (refuses without `confirm:true`) and folds the server return into the uniform
// ack `{ok, applied, result, notifications}` (dispatchBoundEntityWrite in
// server.js). ⚠ CmdAbandonDrone PERMANENTLY DISOWNS the drones — its route carries
// an extra-explicit confirm message.
//
// ⚠ FAST-MODE / educated guess: none fired live this batch (operator owns EveJS;
// no server restart), so this decoder was written from the droneRuntime handler
// code, not captured bytes. Every command returns a per-drone MULTI-RESULT dict
// (buildMultiDroneResult — a map of droneID → outcome/error), and `result` carries
// it through UNTOUCHED for a future drone UI to decode. `applied` is the confirm-
// gate's did-not-throw signal; a panel re-reads the space snapshot to prove it.
//
// ⚠ These are WRITES: never call a decoder to DRIVE a mutation — the confirm-gated
// BFF route is the only path, and it refuses without `confirm: true`.

import { isListValue, readPlainJsonField, unwrapLong, type JsonValue } from "./wire.ts";
import type { Ask } from "./ask.ts";

function truthy(value: JsonValue | undefined): boolean {
  return value === true;
}

/** The uniform ack every confirm-gated R102 bound entity drone-command write returns. */
export interface EntityDroneWriteAck {
  readonly ok: boolean;
  readonly applied: boolean;
  /** The raw server return — a per-drone multi-result dict — carried through untouched. */
  readonly result: JsonValue | null;
}

/**
 * Decode an R102 bound entity drone-command write ack. `applied` is the confirm-
 * gate's did-not-throw signal; `result` passes the per-drone multi-result dict
 * through. FAST-MODE: never fired live, so this is an educated guess from the
 * droneRuntime handler code.
 */
export function decodeEntityDroneWriteAck(response: JsonValue): EntityDroneWriteAck {
  const result = readPlainJsonField(response, "result");
  return {
    ok: truthy(readPlainJsonField(response, "ok")),
    applied: truthy(readPlainJsonField(response, "applied")),
    result: result === undefined ? null : (result as JsonValue),
  };
}

// ── Drones sent to salvage ───────────────────────────────────────────────────
//
// Until 2026-10-10 this was one route of the BFF (POST /api/bridge/entity/drones/salvage), which checked `confirm`
// and made the call on an entity handle of its own. A retail client makes it (droneFunctions.py 156 to 161), from a
// salvage drone's menu and from the drones' primary action:
//
//   eveMoniker.GetEntityAccess().CmdSalvage(droneIDs, targetID)
//       The drones as a list; the target the pilot's active one, or None where it has nothing targeted, and the
//       server then finds each drone a wreck. The Moniker is made for the order and binds carrying it. It answers
//       the drones that could not, each with why, and the client raises the first of those.
//
// In no Tranquility recording; CmdEngage and CmdReturnBay are, 61 times, each riding its own bind. The server acts
// for the session's own ship and on drones that ship controls. Either transport carries it, asked of entity by its
// name; the game port makes it on a Moniker of its own for the system the pilot is in.

/**
 * Sends these drones to salvage `targetID`, or any wreck they may where it is `null` (nought is taken for none).
 * With no drones nothing is asked. Answers what the server says of the drones that could not, as it came. Fails as
 * the call fails.
 */
export async function salvageWithDrones(act: Ask, droneIDs: readonly number[], targetID: number | null): Promise<JsonValue> {
  if (droneIDs.length === 0) return null;
  return act("entity", "CmdSalvage", [[...droneIDs], targetID === 0 ? null : targetID]);
}

// ── Drones set on a target, set to mine, and sent home ───────────────────────
//
// Until 2026-10-14 these were three routes of the BFF (POST /api/bridge/drones/engage, .../mine and .../recall),
// which made the call on an entity handle of their own after reading that the pilot was in space, and read the
// drones in space after. A retail client makes them as it makes the salvage, each on a Moniker made for the order:
//
//   eveMoniker.GetEntityAccess().CmdEngage(droneIDs, targetID)           droneFunctions.EngageTarget, 59 to 99 (93)
//   eveMoniker.GetEntityAccess().CmdMineRepeatedly(droneIDs, targetID)   droneFunctions.MineRepeatedly, 145 to 153 (151)
//   eveMoniker.GetEntityAccess().CmdReturnBay(droneIDs)                  droneFunctions.ReturnToDroneBay, 184 to 189 (187)
//
// the drones a list, the target the pilot's active one. Each answers the drones that could not, each with why, and
// the client raises the first of those (HandleMultipleCallError). CmdEngage is recorded on Tranquility fifty times
// and CmdReturnBay eleven, each riding its own bind; no recording has CmdMineRepeatedly (src/gamePort/retailCalls.js).
//
// What the client asks before it engages, and the page does not (the routes did not either): the drones it knows
// in its park (the rest are dropped, 60 to 68), the active target (DroneCommandRequiresActiveTarget where there is
// none, 70 to 72), a target a character owns in a starter system (refused there, 73 to 78), and the pilot's safety
// level against the engagement, with the question before attacking an NPC where its settings ask it (79 to 89).
// Mining asks the active target (146 to 148); sending home asks nothing.
//
// ⚠ THE ANSWER IS NOT WHAT THE PAGE GOES BY. The caller reads the drones in space after, as for every order.

/**
 * Sets these drones on `targetID`. With no drones nothing is asked. Answers what the server says of the drones that
 * could not, as it came. Fails as the call fails.
 */
export async function engageWithDrones(act: Ask, droneIDs: readonly number[], targetID: number): Promise<JsonValue> {
  if (droneIDs.length === 0) return null;
  return act("entity", "CmdEngage", [[...droneIDs], targetID]);
}

/**
 * Sets these mining drones on `targetID`, to mine it until told otherwise. With no drones nothing is asked. Answers
 * what the server says of the drones that could not, as it came. Fails as the call fails.
 */
export async function mineWithDrones(act: Ask, droneIDs: readonly number[], targetID: number): Promise<JsonValue> {
  if (droneIDs.length === 0) return null;
  return act("entity", "CmdMineRepeatedly", [[...droneIDs], targetID]);
}

/**
 * Sends these drones home to the drone bay; the server scoops each that reaches the ship. With no drones nothing is
 * asked. Answers what the server says of the drones that could not, as it came. Fails as the call fails.
 */
export async function returnDronesToBay(act: Ask, droneIDs: readonly number[]): Promise<JsonValue> {
  if (droneIDs.length === 0) return null;
  return act("entity", "CmdReturnBay", [[...droneIDs]]);
}

/**
 * Sends these drones home to orbit the ship (eveCommands.CmdDronesReturnAndOrbit: entity.CmdReturnHome(droneIDs)).
 * With no drones nothing is asked. Answers what the server says of the drones that could not.
 */
export async function returnDronesHome(act: Ask, droneIDs: readonly number[]): Promise<JsonValue> {
  if (droneIDs.length === 0) return null;
  return act("entity", "CmdReturnHome", [[...droneIDs]]);
}

/**
 * Abandons these drones (droneFunctions.AbandonDrone: entity.CmdAbandonDrone(droneIDs), after ConfirmAbandonDrone):
 * they stay in space, no longer the pilot's. With no drones nothing is asked.
 */
export async function abandonDrones(act: Ask, droneIDs: readonly number[]): Promise<JsonValue> {
  if (droneIDs.length === 0) return null;
  return act("entity", "CmdAbandonDrone", [[...droneIDs]]);
}

// --- A drone scooped (the plan's Phase 6b) ------------------------------------
//
// Until 2026-10-11 it was one route of the BFF (POST /api/bridge/drones/scoop).
//
// THE CALL, as the client makes it (droneFunctions.RealScoopToDroneBay, 192 to 197), from a drone's menu
// (menusvc.ScoopToDroneBay, 3624):
//
//   ship = sm.StartService('gameui').GetShipAccess()
//   ret = ship.ScoopDrone(objectIDs)
//
// the drones as one list, on the ship's own object; and what it answers of each drone that could not be scooped
// is told to the pilot (HandleMultipleCallError). For one drone the client flies to within reach of it first
// (GetCloseAndTryCommand), which the page does not: the server says where a drone is too far. No Tranquility
// recording has a scoop.
//
// THE PAGE ASKS IT OF THE SHIP'S SERVICE BY ITS NAME; the game port makes it on the ship's Moniker for where the
// pilot is.
//
// WHAT THE SERVER TAKES FROM THE CALLER: the drones. The ship is the session's own. Of each drone it says why
// where it will not: not in local space, under somebody's control, too far away, no room in the bay.
//
// ⚠ THE ANSWER IS NOT WHAT THE PAGE GOES BY. It is empty where every drone was scooped; the caller reads the
// drones in space after, as it does for every order to drones.

/**
 * Scoops these drones into the ship's drone bay. With no drones nothing is asked. Answers what the server says
 * of the drones that could not be scooped, as it came. Fails as the call fails.
 */
export async function scoopDrones(act: Ask, droneIDs: readonly number[]): Promise<JsonValue> {
  if (droneIDs.length === 0) return null;
  if (!droneIDs.every((droneID) => Number.isSafeInteger(droneID) && droneID > 0)) {
    throw new Error("That drone could not be identified.");
  }
  return act("ship", "ScoopDrone", [[...droneIDs]]);
}

// --- Drones launched (the plan's Phase 6b) ------------------------------------
//
// Until 2026-10-14 it was one route of the BFF (POST /api/bridge/drones/launch), which read that the pilot was in
// space and the drones out, made the call with the pilot's own character for whose behalf, and read the drones
// again until a new one showed, three seconds at most.
//
// THE CALL, as the client makes it (droneFunctions.LaunchDrones, 210 to 214, from the drones window and the
// menu, and eveMisc.LaunchFromShip, 13 to 61):
//
//   sm.GetService('godma').GetStateManager().SendDroneSettings()
//   ret = sm.StartService('gameui').GetShipAccess().LaunchDrones(oldItems, whoseBehalfID, ignoreWarning)
//
// oldItems a list of (itemID, quantity) for the stacks, whoseBehalfID None, ignoreWarning False. The answer is a
// dict of each stack to what came of it: the new drones' numbers, or for a drone that did not launch a tuple the
// client raises as a UserError of its own (41 to 59). Before the call the client sends the pilot's drone settings
// (godma's SendDroneSettings: ChangeDroneSettings with whether drones are aggressive and focus fire, 2337 to
// 2341), which the page has none of and does not send (its route did not either). The game port makes the stacks a
// list (src/gamePort/retailCalls.js, launching). No Tranquility recording has a launch.
//
// ⚠ THE DRONES SHOW IN THE PILOT'S PARK WITH ITS NEXT UPDATE, which may come after the answer: the caller reads
// the drones again until those the answer named are out (src/app/flow.ts, launchedThenRead).

/** A stack of drones in the bay to launch, and how many of it. */
export interface DronesToLaunch {
  readonly itemID: number;
  readonly quantity: number;
}

/** What a launch answered: the drones that came out, and what the server said of each that did not. */
export interface Launched {
  readonly droneIDs: readonly number[];
  readonly refusals: readonly JsonValue[];
  /** The answer's own pairs: each stack launched (its itemID) and the drones it became (OnItemLaunch's ids). */
  readonly byStack: ReadonlyMap<number, readonly number[]>;
}

/**
 * Launches these stacks, as the client's launch does. With none nothing is asked. Answers what the server said, as
 * it came. Fails as the call fails.
 */
export async function launchDrones(act: Ask, stacks: readonly DronesToLaunch[]): Promise<JsonValue> {
  const asked = stacks.filter((stack) => Number.isSafeInteger(stack.itemID) && stack.itemID > 0 && stack.quantity > 0);
  if (asked.length === 0) return null;
  return act("ship", "LaunchDrones", [asked.map((stack) => [stack.itemID, stack.quantity]), null, false]);
}

/**
 * The launch's answer as the client reads it (eveMisc.LaunchFromShip, 41 to 49): each stack's new drones, and a
 * tuple for each that did not launch. Null where the answer is no dict.
 */
export function decodeLaunched(answer: JsonValue): Launched | null {
  const dict = answer !== null && typeof answer === "object" && !Array.isArray(answer) && (answer as { type?: unknown }).type === "dict"
    ? (answer as { entries?: unknown }).entries : null;
  if (!Array.isArray(dict)) return null;
  const entries = dict as readonly JsonValue[];
  const droneIDs: number[] = [];
  const refusals: JsonValue[] = [];
  const byStack = new Map<number, number[]>();
  for (const entry of entries) {
    if (!Array.isArray(entry)) continue;
    const stackID = Number(unwrapLong(entry[0] as JsonValue) ?? Number.NaN);
    const seq = entry[1];
    const items: readonly JsonValue[] = isListValue(seq) ? seq.items : Array.isArray(seq) ? seq : [];
    for (const each of items) {
      if (Array.isArray(each)) {
        refusals.push(each);
        continue;
      }
      const id = Number(unwrapLong(each) ?? Number.NaN);
      if (Number.isSafeInteger(id) && id > 0) {
        droneIDs.push(id);
        if (Number.isSafeInteger(stackID) && stackID > 0) byStack.set(stackID, [...(byStack.get(stackID) ?? []), id]);
      }
    }
  }
  return { droneIDs, refusals, byStack };
}

// --- Lost drones reconnected to (the plan's Phase 6b) -------------------------
//
// Until 2026-10-13 it was one route of the BFF (POST /api/bridge/entity/drones/reconnect), which made the call and
// read the drones in space after.
//
// THE CALL, as the client makes it (droneFunctions.ReconnectToDrones, 217 to 241, and _ReconnectToDroneCandidates,
// 244 to 259), from the ship's own menu ("Reconnect to Lost Drones", menusvc.py 1647 to 1648, offered for the
// pilot's own ship where it can carry drones, is in no structure and is not warping:
// celestialCheckers.OfferReconnectToLostDrones, 1187 to 1198) and from its shortcut (eveCommands.py 1315 to 1316):
//
//   entity = eveMoniker.GetEntityAccess()
//   ret = entity.CmdReconnectToDrones(droneCandidates)
//
// the candidates as one list: every ball in the pilot's park that is of the Drone category, is the pilot's own
// character's, and is not among the drones the client holds to be its own (michelle.GetDrones), twenty-five at
// most (MAX_DRONE_RECONNECTS, appConst.py 2069; the compiled module has 25). With no candidate nothing is asked,
// and the pilot is told none was found. What the server answers of the drones it would not take is told to the
// pilot, one refusal at a time. No Tranquility recording has it.
//
// THE PAGE'S WINDOW has a button for each loose drone where the client has one command for all of them: the
// drones are the caller's to name, and this sends what it is given, the first twenty-five.
//
// THE PAGE ASKS IT OF THE ENTITY SERVICE BY ITS NAME; the game port makes it on a Moniker of its own for the
// system the pilot is in.
//
// WHAT THE SERVER TAKES FROM THE CALLER: the drones. Each must be a drone in the session's own scene, the
// session's own character's, and under nobody's control (droneRuntime.commandReconnectToDrones); one of another's
// is passed over. It refuses, for all that are left, where the ship has as many drones out as it may or too
// little bandwidth for the next.
//
// ⚠ THE ANSWER IS NOT WHAT THE PAGE GOES BY. The caller reads the drones in space after: a drone reconnected to
// is one the ship controls.

/** appConst.py 2069: the most drones one reconnection asks for. */
export const MAX_DRONE_RECONNECTS = 25;

/**
 * Asks the ship to take control of these drones again. With no drones nothing is asked. Answers what the server
 * says of the drones it would not take, as it came. Fails as the call fails.
 */
export async function reconnectToDrones(act: Ask, droneIDs: readonly number[]): Promise<JsonValue> {
  if (droneIDs.length === 0) return null;
  if (!droneIDs.every((droneID) => Number.isSafeInteger(droneID) && droneID > 0)) {
    throw new Error("That drone could not be identified.");
  }
  return act("entity", "CmdReconnectToDrones", [droneIDs.slice(0, MAX_DRONE_RECONNECTS)]);
}
