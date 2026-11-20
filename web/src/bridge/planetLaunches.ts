// The planets window's Launches tab, as the client has it.
//
// THE TAB (planetWindow.py ReconstructWindow, 40 to 53): the planets window reads the pilot's launches as it is built
// (planetUISvc.GetLaunches, which keeps what it read until the server says they changed: OnPILaunchesChange, 170 to
// 177), and is drawn again at that notice (58 to 61). Where there are launches it has two tabs, Colonies and
// Launches; where there are none, its colonies alone.
//
// EACH ROW (LaunchesPanel.UpdateScroll, 84 to 110, and AutoUpdateLaunchDecayTimes, 112 to 131): the time left before
// the launch's container re-enters, counted down each second (FormatTimeIntervalShortWritten of the decay time less
// what has passed since the launch), or the words for one burned up once five days have passed (piLaunchOrbitDecayTime);
// its solar system; its planet; when it was launched (FmtDate).
//
// ITS MENU (journal.py PlanetaryInteractionLaunchEntry.GetMenu, 425 to 444). A launch not burned up has its solar
// system's celestial menu (its route entries here) and, in the pilot's own system in space, Approach Location within
// const.minWarpDistance of the container's point (CmdFollowBall to the container, 50 m) or Warp To beyond it
// (CmdWarpToStuff 'launch'). A launch burned up has Remove alone (planetMgr.DeleteLaunch, its row taken off first and
// the launches read afresh after).

import type { LaunchDetail } from "./piColonies.ts";
import { BLUE_TIME } from "./timeInterval.ts";
import type { ColonyPin } from "../store/types.ts";
import type { DogmaStatic } from "./dogma/location.ts";

/** appConst.piLaunchOrbitDecayTime: five days, in the client's ticks. */
export const PI_LAUNCH_ORBIT_DECAY = BLUE_TIME.DAY * 5n;
// SpaceportPin.GetLaunchCycleTime and GetExportTax.
const COMMAND_LAUNCH_CYCLE_MS = 60_000;
const COMMAND_LAUNCH_TAX_RATE = 0.05;
const EXPORT_TAX = 1639;
const IMPORT_TAX_MULTIPLIER = 1640;

export function commandLaunchRemaining(lastLaunchAtMs: number | null, nowMs: number): number {
  return lastLaunchAtMs === null ? 0 : Math.max(0, lastLaunchAtMs + COMMAND_LAUNCH_CYCLE_MS - nowMs);
}

/**
 * format.FmtTime, as CommandCenterContainer shows the next launch time (nextLaunchTime less GetWallclockTime): hours,
 * minutes and seconds by integer division, so a part second is dropped, each with two leading zeroes, in
 * DateTimeShort3Elements ("{value1}:{value2}:{value3}").
 */
export function fmtTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const two = (value: number) => String(value).padStart(2, "0");
  return `${two(Math.floor(seconds / 3600))}:${two(Math.floor(seconds % 3600 / 60))}:${two(seconds % 60)}`;
}

export interface CommandLaunchFacts {
  readonly types: DogmaStatic["types"];
  readonly volumes: Readonly<Record<number, number | null>>;
}

export function quoteCommandLaunch(pin: ColonyPin, payload: Readonly<Record<number, number>>, facts: CommandLaunchFacts) {
  if (pin.kind !== "command") throw new Error("Only a command centre can launch commodities.");
  const entries = Object.entries(payload);
  if (!entries.length) throw new Error("Choose commodities to launch.");
  const rate = facts.types[pin.typeID]?.attributes.find(([id]) => id === EXPORT_TAX)?.[1];
  if (rate == null) throw new Error("The command centre's launch tax data is unavailable.");
  let tax = 0;
  let volume: number | null = 0;
  for (const [key, quantity] of entries) {
    const typeID = Number(key);
    const stock = pin.contents.find(row => row.typeID === typeID)?.quantity ?? 0;
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > stock) {
      throw new Error("The staged payload exceeds the commodities in storage.");
    }
    const type = facts.types[typeID];
    if (!type) throw new Error("A payload commodity's tax data is unavailable.");
    const multiplier = type.attributes.find(([id]) => id === IMPORT_TAX_MULTIPLIER)?.[1] ?? 0;
    tax += rate * multiplier * quantity;
    const perUnit = facts.volumes[typeID];
    volume = volume !== null && perUnit != null ? volume + perUnit * quantity : null;
  }
  return { tax: Math.round(tax * COMMAND_LAUNCH_TAX_RATE * 100) / 100, volume };
}
/** const.minWarpDistance, in metres. */
const MIN_WARP_DISTANCE = 150_000;
/** The client's clock at the Unix epoch, in its ticks of 100 ns since 1601. */
const FILETIME_AT_UNIX_EPOCH = 116_444_736_000_000_000n;

/** The pilot's launches as the flow keeps them for the window: not read yet, read, or a read that failed. */
export interface PlanetLaunchesRead {
  readonly loaded: boolean;
  readonly launches: readonly LaunchDetail[];
  readonly error: string | null;
}

/** blue.os.GetWallclockTime at a time in milliseconds since the Unix epoch. */
export function filetimeAt(ms: number): bigint {
  return BigInt(Math.floor(ms)) * BLUE_TIME.MSEC + FILETIME_AT_UNIX_EPOCH;
}

/** The time left before a launch's container re-enters, in ticks; null once it has (the row's `expired`). */
export function reentryLeft(launch: LaunchDetail, now: bigint): bigint | null {
  const passed = now - (launch.launchTime ?? 0n);
  return passed < PI_LAUNCH_ORBIT_DECAY ? PI_LAUNCH_ORBIT_DECAY - passed : null;
}

/** Where the pilot is, as a launch's menu goes by it. */
export interface LaunchMenuPilot {
  /** session.solarsystemid: the system the pilot is in, in space; null docked. */
  readonly inSpaceSystemID: number | null;
  /** The pilot's ship's point, null where it is not known. */
  readonly shipPosition: { readonly x: number; readonly y: number; readonly z: number } | null;
}

/** A launch's menu: its system's route entries, the move offered to it, and Remove. */
export interface LaunchMenu {
  /** The system whose route entries lead the menu; null for a launch burned up. */
  readonly routeSystemID: number | null;
  /** Approach Location (to the container) or Warp To (the launch); null where neither is offered. */
  readonly move: "approach" | "warp" | null;
  readonly remove: boolean;
}

/** PlanetaryInteractionLaunchEntry.GetMenu. A ship whose point is not known is offered no move. */
export function launchMenu(launch: LaunchDetail, expired: boolean, pilot: LaunchMenuPilot): LaunchMenu {
  if (expired) {
    return { routeSystemID: null, move: null, remove: true };
  }
  const routeSystemID = launch.solarSystemID > 0 ? launch.solarSystemID : null;
  if (launch.solarSystemID !== pilot.inSpaceSystemID || pilot.shipPosition === null) {
    return { routeSystemID, move: null, remove: false };
  }
  const at = pilot.shipPosition;
  const distance = Math.hypot(launch.x - at.x, launch.y - at.y, launch.z - at.z);
  return { routeSystemID, move: distance < MIN_WARP_DISTANCE ? "approach" : "warp", remove: false };
}
