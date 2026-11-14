// The scanner's four writes, made by the page itself (the plan's Phase 6b).
//
// Until 2026-10-13 each was a route of the BFF (POST /api/bridge/scanner/launch, analyze, recover and reconnect,
// all over one helper), which read the pilot's scanner, refused where it had no launcher or no probes, made the
// client's call with what the scanner said and read the scanner again.
//
// THE CALLS, as the client's scan service makes them (eve/client/script/parklife/scanSvc.py, and
// probescanning/probeTracker.py for what it keeps):
//
//   launch      A formation's button (probeScannerPalette.LaunchFormation, 600 to 604), and the analyze button
//               while no probe is out (analyzeButton.launch, 85 to 86): scanSvc.MoveProbesToFormation, and so
//               probeTracker.MoveProbesToFormation (169 to 182). The probes held and the charges loaded must
//               make up the formation's number, or it is refused (CheckCanCreateFormation, 163 to
//               166: NotEnoughProbesToFormFormation); with fewer held than the formation has, it launches the
//               formation's number less the active ones: scanSvc.FindModuleAndLaunchProbes (487 to 498), the
//               ship's online probe launcher with a charge at its flag,
//
//                 dogmaLM.LaunchProbes(module.itemID, numProbes)
//
//               on the ship's dogma location, and nothing at all where there is no such launcher. The pinpoint
//               and the spread formation are of eight probes each (probescanning/formations.py: the module's
//               own bytecode makes three offsets and five more, and two and six more).
//   analyze     probeScannerPalette.Analyze (681 to 699) and analyzeButton.analyze (scanSvc.RequestScans_Check,
//               181 to 190), and then scanSvc.RequestScans (193 to 198):
//
//                 probes = self.probeTracker.GetProbesForScanning()
//                 self.GetScanMan().RequestScans(probes)
//
//               the idle probes by their numbers ({probeID: probe}), or None where no probe is idle or none is
//               held; after it the client holds itself to be scanning and those probes to be moving.
//   recover     probeScannerPalette.RecoverActiveProbes (674 to 678): scanSvc.RecoverProbes (324 to 337) with
//               every active probe, and so
//
//                 self.GetScanMan().RecoverProbes(probeIDs)
//
//               which answers the probes it recalled. Fewer than were asked for is told to the pilot
//               (probeTracker.RecoverProbes, 191 to 197: NotAllProbesReturnedSuccessfully).
//   reconnect   probeScannerPalette.ReconnectToLostProbes (669 to 671): scanSvc.ReconnectToLostProbes (269 to
//               285),
//
//                 self.GetScanMan().ReconnectToLostProbes()
//
//               with nothing; the server then tells of each probe again.
//
// The last three are asked of the system's scan manager, the object GetSystemScanMgr() answered: the BFF finds
// it, and such a call names none (bridgeCallPolicy.js, PAGE_OBJECT_CALLS). No Tranquility recording has any of
// the four: nobody launched a probe in one.
//
// WHAT THE CLIENT REFUSES BY ITSELF BEFORE IT ASKS, and the page with it:
//
//   while it holds itself to be scanning   every one of the palette's three (UserErrorIfScanning, 40 to 48:
//                                          ScanInProgressGeneric), and the analyze button is not enabled
//                                          (analyzeButton._update_enabled)
//   a formation's button                   wants every active probe idle (CheckButtonStates, 620 to 649)
//   the recover button                     wants an active probe, and every one of them idle (the same)
//   a recovery, and a reconnection         not from a capsule (ScnProbeRecoverToPod, 272 to 274 and 325 to 327)
//   a recovery                             not while a probe's ball is within 2,000 metres of the ship
//                                          (MIN_PROBE_RECOVER_DISTANCE, 25; ProbesTooCloseToRecover, 329 to 334:
//                                          a probe with no ball in the pilot's park is passed over)
//   a scan                                 not in void space, systems 34,000,000 to 34,999,999
//                                          (ProbeScannerVoidSpaceHint, 188 to 189; inventorycommon/const.py 48
//                                          and 49)
//   a scan in Abyssal space                asked of the pilot first, systems 32,000,000 to 32,999,999
//                                          (ProbeScannerAbyssalSpaceWarning, Yes or No, Yes kept where the box is
//                                          ticked, 183 to 187; const.py 46 and 47): the Scanner window asks it
//                                          (Scanner.svelte), and a bot's scan there goes only on a kept Yes
//   a reconnection                         needs an online probe launcher, and a minute since the last one
//                                          asked (CanClaimProbes, 299 to 302; RECONNECT_DELAY_MINUTES, 24;
//                                          ScannerProbeReconnectWait, 284 to 285). The time is noted before the
//                                          call is made, and stands where the call fails.
//
// The numbers (the eight, the 2,000, the minute, the two ranges of systems, a probe's states) were read from the
// compiled modules through the client's own Python, which bore out the decompiled source.
//
// WHAT THE PAGE DOES NOT DO AS THE CLIENT DOES, and says so:
//   - It has the Pinpoint and Spread formations only (bridge/probeFormations.ts): no custom ones, no size slider.
//   - The page has one button for a scan and one for a launch where the client has one for both (Launch with no
//     probe out, Analyze with probes out).
//   - The client goes by every probe it holds, the inactive ones too, for whether a formation can be made. The
//     page is told the active ones, and has no way to make a probe inactive.
//   - With no probe launcher and no reconnection asked before, the client's own reckoning of the wait fails on a
//     time it has not got. The page says a launcher is wanted.
//   - The minute is the pilot's simulation clock's in the client, and the page's own clock's here.
//
// WHAT THE SERVER TAKES FROM THE CALLER (read at the handlers: dogmaService/moduleOperation.js,
// _resolveValidatedProbeLaunchContext; exploration/scanMgrService.js): the launcher and the number, the probes
// and where they are to go, the probes to recall. The launcher must be the session's own character's, in the
// session's own ship, a probe launcher, online, with that many scanner probes loaded and eight out at most; the
// probes are looked for among the session's own character's and no other's. The server refuses a launch in
// sentences of its own and with NoCharges and DeniedShipChanged; the scan manager refuses nothing: a probe that is
// not the pilot's is passed over.
//
// ⚠ NO ANSWER IS WHAT THE PAGE GOES BY, but for the recall's, which is counted. The caller reads the scanner
// after, as it does after every order (app/flow.ts, runScannerAction).

import type { ScannerOperationsSnapshot, ScannerProbeOperation } from "../scanner/scannerCenter.ts";
import type { Ask } from "./ask.ts";
import { rangeStepFor, type Placement } from "./probeFormations.ts";
import type { JsonValue } from "./wire.ts";

/** probescanning/const.py: a probe's states. */
export const PROBE_STATE = Object.freeze({ INACTIVE: 0, IDLE: 1, MOVING: 2, WARPING: 3, SCANNING: 4, RETURNING: 5 });
/** probescanning/formations.py: the pinpoint formation's probes, and the spread's (MIN_PROBES_NEEDED, 16). */
export const PROBES_IN_A_FORMATION = 8;
/** scanSvc.py 25: MIN_PROBE_RECOVER_DISTANCE, in metres from the ship's surface. */
export const MIN_PROBE_RECOVER_DISTANCE = 2000;
/** probescanning/const.py scanProbeNumberOfRangeSteps. */
export const SCAN_RANGE_STEPS = 8;
/** scanSvc.py 24: RECONNECT_DELAY_MINUTES = 1. */
export const RECONNECT_DELAY_MS = 60_000;
/** inventorycommon/const.py 48 and 49: mapVoidSystemMin and mapVoidSystemMax (idCheckers.IsVoidSpaceSystem, 129). */
const VOID_SYSTEMS: readonly [number, number] = [34_000_000, 34_999_999];
/** inventorycommon/const.py 46 and 47: mapAbyssalSystemMin and mapAbyssalSystemMax (idCheckers.IsAbyssalSpaceSystem, 101). */
const ABYSSAL_SYSTEMS: readonly [number, number] = [32_000_000, 32_999_999];

/**
 * The client's question before a scan in Abyssal space (scanSvc.RequestScans_Check, 183 to 187): the dialog it puts
 * up, Yes and No, with suppress=uiconst.ID_YES (so Yes alone may be kept); a No and nothing is asked of the server.
 */
export const ABYSSAL_SCAN_QUESTION = "ProbeScannerAbyssalSpaceWarning";

/** Whether a system is an Abyssal pocket (idCheckers.IsAbyssalSpaceSystem). */
export function isAbyssalSystem(systemID: number | null): boolean {
  return systemID !== null && systemID >= ABYSSAL_SYSTEMS[0] && systemID <= ABYSSAL_SYSTEMS[1];
}

// The page's own words for what the client refuses. (The client's are its own text, and are not copied.)
export const SCANNER_NEEDS_SPACE = "Your ship must be in space to use the scanner.";
export const SCAN_IN_PROGRESS = "A scan is still running. Wait for it to finish, then try again.";
export const PROBES_ARE_BUSY = "Your probes are still on the move. Wait until every one of them is idle.";
export const ALL_PROBES_ARE_OUT = "All eight of your probes are already out.";
export const NO_PROBES_OUT = "You have no probes out. Launch probes first.";
export const NO_IDLE_PROBE = "None of your probes is idle yet, and your probe launcher holds no probes.";
export const SHIP_SCANS_ALONE = "None of your probes is idle: your ship will scan alone.";
export const NO_SCANNING_HERE = "Probe scanning is not available in this system.";
export const NO_PROBES_FOR_A_CAPSULE = "A capsule cannot recover or reconnect to probes. Board a ship first.";
export const PROBES_TOO_CLOSE_TO_RECOVER =
  "A probe is too close to your ship to be recovered. Move at least two kilometres away from it.";
export const NOT_ALL_PROBES_RETURNED =
  "Not every probe could be recalled. Refresh the scanner to see which are still out.";
export const RECONNECT_NEEDS_A_LAUNCHER = "Reconnecting to probes takes an online probe launcher on your ship.";
export const ABYSSAL_SCAN_UNANSWERED =
  "A scan in an Abyssal pocket waits for the pilot's answer to the scanner's warning, which a bot cannot give.";

/** A formation cannot be made of the probes out and the probes loaded. */
export function notEnoughProbesForAFormation(held: number, loaded: number): string {
  return `A probe formation takes ${PROBES_IN_A_FORMATION} probes. You have ${held} out and ${loaded} loaded.`;
}

/** A reconnection was asked less than a minute ago. */
export function reconnectWait(waitMs: number): string {
  const seconds = Math.max(1, Math.ceil(waitMs / 1000));
  return `You asked to reconnect to your probes a moment ago. Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`;
}

/** The scanner as the page reads it (GET /api/bridge/scanner/state): what a call goes by. */
export type ScannerRead = Pick<ScannerOperationsSnapshot, "inSpace" | "solarSystemID" | "launcher" | "probes" | "scanning">;

/** What the page knows of its ship where a call asks: whether it is a capsule, and how far a thing is from it. */
export interface ScannerShip {
  /** True in a capsule; null where the page has not been told. */
  readonly isCapsule: boolean | null;
  /** Metres from the ship's surface to a thing's, or null where the thing is not in the pilot's park. */
  surfaceDistanceTo(itemID: number): number | null;
}

/** Why an order is not made, in the page's words. */
export interface Refused {
  readonly refusal: string;
}

const isIdle = (probe: ScannerProbeOperation): boolean => probe.state === PROBE_STATE.IDLE;

/** What every one of the scanner's orders wants first: a ship in space, and no scan under way. */
function standing(scanner: ScannerRead): Refused | null {
  if (!scanner.inSpace) return { refusal: SCANNER_NEEDS_SPACE };
  if (scanner.scanning) return { refusal: SCAN_IN_PROGRESS };
  return null;
}

/**
 * The launch a formation's button makes: which launcher, and how many probes; or why none.
 * (probeTracker.MoveProbesToFormation, 169 to 182; scanSvc.FindModuleAndLaunchProbes, 487 to 498.)
 */
export function launchOf(scanner: ScannerRead): { readonly moduleID: number; readonly count: number } | Refused {
  const not = standing(scanner);
  if (not) return not;
  const held = scanner.probes.length;
  const launcher = scanner.launcher !== null && scanner.launcher.online ? scanner.launcher : null;
  const loaded = launcher === null ? 0 : launcher.loadedCount;
  if (held + loaded < PROBES_IN_A_FORMATION) return { refusal: notEnoughProbesForAFormation(held, loaded) };
  // With the formation's number held the client moves them into it and launches none.
  if (held >= PROBES_IN_A_FORMATION) return { refusal: ALL_PROBES_ARE_OUT };
  if (!scanner.probes.every(isIdle)) return { refusal: PROBES_ARE_BUSY };
  // (Fewer than eight held and eight made up: a launcher is there, with a charge in it.)
  return { moduleID: launcher!.moduleID, count: PROBES_IN_A_FORMATION - held };
}

/** One probe as RequestScans is sent it: what the read said of it. */
function probeSent(probe: ScannerProbeOperation): JsonValue {
  return {
    typeID: probe.typeID,
    pos: [...probe.pos],
    destination: [...probe.destination],
    scanRange: probe.scanRange,
    rangeStep: probe.rangeStep,
    state: probe.state,
    expiry: probe.expiry,
  };
}

/**
 * A formation's button (probeScannerPalette.CheckButtonStates 636 to 649; probeTracker.MoveProbesToFormation 169 to
 * 182): offered where the probes held and the charges loaded make the formation and every probe is idle. What it
 * launches: the active probes' shortfall from eight, or nothing where eight are held (they are moved into it).
 */
export function formationOf(scanner: ScannerRead): { readonly launch: { readonly moduleID: number; readonly count: number } | null } | Refused {
  const not = standing(scanner);
  if (not) return not;
  const held = scanner.probes.length;
  const launcher = scanner.launcher !== null && scanner.launcher.online ? scanner.launcher : null;
  const loaded = launcher === null ? 0 : launcher.loadedCount;
  if (held + loaded < PROBES_IN_A_FORMATION) return { refusal: notEnoughProbesForAFormation(held, loaded) };
  if (!scanner.probes.every(isIdle)) return { refusal: PROBES_ARE_BUSY };
  return { launch: held < PROBES_IN_A_FORMATION && launcher !== null ? { moduleID: launcher.moduleID, count: PROBES_IN_A_FORMATION - held } : null };
}

/**
 * The probes a scan is asked with, by their numbers: the idle ones (probeTracker.GetProbesForScanning, 256 to
 * 263); null, the ship alone, where probes are out and none is idle; or why no scan is asked.
 *
 * The analyze button is offered where a probe is idle or a probe launcher holds charges
 * (analyzeButton._update_enabled), and once probes are out it analyzes (on_clicked). With none of them idle,
 * GetProbesForScanning answers None, and RequestScans sends it: the ship scans alone (scanSvc.RequestScans, 195 to
 * 197, probeIDs [session.shipid]). With no probe out the button launches instead (the page's launch button).
 */
export function scanOf(scanner: ScannerRead): { readonly probes: Readonly<Record<string, JsonValue>> | null } | Refused {
  const not = standing(scanner);
  if (not) return not;
  const system = scanner.solarSystemID;
  if (system !== null && system >= VOID_SYSTEMS[0] && system <= VOID_SYSTEMS[1]) return { refusal: NO_SCANNING_HERE };
  if (scanner.probes.length === 0) return { refusal: NO_PROBES_OUT };
  const idle = scanner.probes.filter(isIdle);
  if (idle.length === 0) {
    return scanner.launcher !== null && scanner.launcher.loadedCount > 0 ? { probes: null } : { refusal: NO_IDLE_PROBE };
  }
  return { probes: Object.fromEntries(idle.map((probe) => [String(probe.probeID), probeSent(probe)])) };
}

/**
 * The probes a recovery recalls: every active one (scanSvc.GetActiveProbes), where there is one and all are idle;
 * or why none. What only the ship can say (a capsule, a probe too close) is the call's own to refuse, below.
 */
export function recallOf(scanner: ScannerRead): { readonly probeIDs: readonly number[] } | Refused {
  const not = standing(scanner);
  if (not) return not;
  if (scanner.probes.length === 0) return { refusal: NO_PROBES_OUT };
  if (!scanner.probes.every(isIdle)) return { refusal: PROBES_ARE_BUSY };
  return { probeIDs: scanner.probes.map((probe) => probe.probeID) };
}

/** How many a list the server answered has, or null where it is no list the page can read. */
function countOf(answer: JsonValue): number | null {
  if (Array.isArray(answer)) return answer.length;
  const items = answer !== null && typeof answer === "object" ? (answer as { items?: JsonValue }).items : undefined;
  return Array.isArray(items) ? items.length : null;
}

/** The scanner's four orders, for one pilot. `now` is the clock the minute between reconnections is kept by. */
export function createScannerWrites(act: Ask, now: () => number = Date.now) {
  /** scanSvc.lastReconnection: when a reconnection was last asked, or null. */
  let lastReconnectionMs: number | null = null;

  return {
    /** Launches the probes a formation wants. Refuses as the client does; fails as the call fails. */
    async launch(scanner: ScannerRead): Promise<void> {
      const launch = launchOf(scanner);
      if ("refusal" in launch) throw new Error(launch.refusal);
      await act("dogmaIM", "LaunchProbes", [launch.moduleID, launch.count]);
    },

    /** Asks for a scan with the idle probes. Refuses as the client does; fails as the call fails. */
    async analyze(scanner: ScannerRead): Promise<void> {
      const scan = scanOf(scanner);
      if ("refusal" in scan) throw new Error(scan.refusal);
      await act("scanMgr", "RequestScans", [scan.probes]);
    },

    /**
     * Recalls every active probe. Refuses as the client does; fails as the call fails, and where the server
     * recalled fewer than were asked for.
     */
    async recover(scanner: ScannerRead, ship: ScannerShip): Promise<void> {
      const recall = recallOf(scanner);
      if ("refusal" in recall) throw new Error(recall.refusal);
      if (ship.isCapsule === true) throw new Error(NO_PROBES_FOR_A_CAPSULE);
      for (const probeID of recall.probeIDs) {
        const distance = ship.surfaceDistanceTo(probeID);
        if (distance !== null && distance < MIN_PROBE_RECOVER_DISTANCE) throw new Error(PROBES_TOO_CLOSE_TO_RECOVER);
      }
      const recalled = countOf(await act("scanMgr", "RecoverProbes", [[...recall.probeIDs]]));
      if (recalled !== null && recalled < recall.probeIDs.length) throw new Error(NOT_ALL_PROBES_RETURNED);
    },

    /** scanSvc.FindModuleAndLaunchProbes (487 to 498): LaunchProbes(module, count), as a formation's button wants. */
    async launchCount(moduleID: number, count: number): Promise<void> {
      await act("dogmaIM", "LaunchProbes", [moduleID, count]);
    },

    /**
     * probeTracker.ProbeGoToPoint (148 to 157): an idle probe given its place as its destination, and the range step
     * whose range is nearest the place's size. Both are the client's own list's; the game port's transport keeps
     * them and sends nothing. (The client sets the step on the probe itself; SetProbeRangeStep also makes it the
     * step a new probe starts on, which the next placement overrides.)
     */
    /** probeTracker.SetProbeDestination (88 to 90), from the map's RegisterProbeMove: an idle probe given its destination. */
    async moveTo(probe: ScannerProbeOperation, destination: readonly [number, number, number]): Promise<void> {
      if (probe.state !== PROBE_STATE.IDLE) return;
      await act("scanMgr", "SetProbeDestination", [probe.probeID, [...destination]]);
    },

    /** probeTracker.SetProbeRangeStep (92 to 101), from the map's RegisterProbeScale / ScaleAllProbes: an idle probe's step. */
    async stepTo(probe: ScannerProbeOperation, rangeStep: number): Promise<void> {
      if (probe.state !== PROBE_STATE.IDLE || rangeStep === probe.rangeStep) return;
      await act("scanMgr", "SetProbeRangeStep", [probe.probeID, rangeStep]);
    },

    async sendToPlace(probe: ScannerProbeOperation, placement: Placement): Promise<void> {
      if (probe.state !== PROBE_STATE.IDLE) return;
      await act("scanMgr", "SetProbeDestination", [probe.probeID, [...placement.destination]]);
      const step = rangeStepFor(placement.size, probe.rangeSteps ?? []);
      if (step !== null && step !== probe.rangeStep) await act("scanMgr", "SetProbeRangeStep", [probe.probeID, step]);
    },

    /**
     * The probe menu's Scan Range (scanSvc.GetProbeMenu 398 to 401, SetScanRange_Check 409 to 413): each chosen probe
     * given the step, refused while a scan is under way (UserErrorIfScanning). SetProbeRangeStep is the client's own
     * list's (probeTracker.SetProbeRangeStep, which changes nothing for a step outside the eight); on the game port
     * the transport keeps it and sends nothing, and the next RequestScans carries it.
     */
    async setRangeStep(scanner: ScannerRead, probeIDs: readonly number[], rangeStep: number): Promise<void> {
      if (scanner.scanning === true) throw new Error(SCAN_IN_PROGRESS);
      if (!Number.isInteger(rangeStep) || rangeStep < 1 || rangeStep > SCAN_RANGE_STEPS) return;
      const held = new Set(scanner.probes.map((probe) => probe.probeID));
      for (const probeID of probeIDs) {
        if (held.has(probeID)) await act("scanMgr", "SetProbeRangeStep", [probeID, rangeStep]);
      }
    },

    /**
     * The probe menu's Recover Probe (RecoverProbe_Check, 416 to 420; scanSvc.RecoverProbes 324 to 337): the chosen
     * probes recalled, refused while a scan is under way, from a capsule, or with one of them within 2,000 metres.
     * Fails where the server recalled fewer than were asked for (probeTracker.RecoverProbes).
     */
    async recoverSome(scanner: ScannerRead, ship: ScannerShip, probeIDs: readonly number[]): Promise<void> {
      if (scanner.scanning === true) throw new Error(SCAN_IN_PROGRESS);
      if (ship.isCapsule === true) throw new Error(NO_PROBES_FOR_A_CAPSULE);
      for (const probeID of probeIDs) {
        const distance = ship.surfaceDistanceTo(probeID);
        if (distance !== null && distance < MIN_PROBE_RECOVER_DISTANCE) throw new Error(PROBES_TOO_CLOSE_TO_RECOVER);
      }
      const recalled = countOf(await act("scanMgr", "RecoverProbes", [[...probeIDs]]));
      if (recalled !== null && recalled < probeIDs.length) throw new Error(NOT_ALL_PROBES_RETURNED);
    },

    /** Asks the server to tell of the pilot's probes again. Refuses as the client does; fails as the call fails. */
    async reconnect(scanner: ScannerRead, ship: ScannerShip): Promise<void> {
      const not = standing(scanner);
      if (not) throw new Error(not.refusal);
      if (ship.isCapsule === true) throw new Error(NO_PROBES_FOR_A_CAPSULE);
      if (scanner.launcher === null || !scanner.launcher.online) throw new Error(RECONNECT_NEEDS_A_LAUNCHER);
      const at = now();
      if (lastReconnectionMs !== null && at - lastReconnectionMs <= RECONNECT_DELAY_MS) {
        throw new Error(reconnectWait(RECONNECT_DELAY_MS - (at - lastReconnectionMs)));
      }
      lastReconnectionMs = at;
      await act("scanMgr", "ReconnectToLostProbes", []);
    },
  };
}

export type ScannerWrites = ReturnType<typeof createScannerWrites>;
