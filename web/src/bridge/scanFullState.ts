// The scanner's sites, asked by the page itself (the plan's Phase 6b).
//
// Until 2026-10-10 they were one route of the BFF (GET /api/bridge/scan-full-state), which made the one call and
// put the BFF's word for the pilot's system beside its answer.
//
// THE CALL, as the client makes it:
//
//   sensorSuiteService.UpdateSignalTracker (722)                the agency's signatures, as they are shown
//   sensorSuiteService.FullyUpdateSignalTrackerDebounced (718)  the anomaly tracker, at most once a second
//
// each of which is self.scanSvc.GetScanMan().GetFullState(), and hands the answer on with session.solarsystemid2,
// read before the call is made. scanSvc.GetScanMan (113 to 116) is the object sm.RemoteSvc('scanMgr')
// .GetSystemScanMgr() answered, kept while the session is in that system. Tranquility's recording has
// GetSystemScanMgr() once and GetFullState() on what it answered, twice, with an empty tuple.
//
// THE OBJECT IS THE BFF'S TO FIND. The session has one scan manager, so the call names none (it takes no `of`):
// the BFF asks the object it keeps for the pilot, which the scanner's other calls are made on too, and through
// the web gateway asks the service by its name, as the route did (src/server.js, systemScanCall).
//
// WHAT THE SERVER TAKES FROM THE CALLER: nothing. It answers the sites of the system the session is in, docked or
// in space, and registers nothing.
//
// The answer is a tuple of four: anomalies, signatures, static sites, structures, each a dict by site. A system
// with none has four empty ones. A read that fails is the caller's to hear of: no sites are made up in its place.

import type { Ask } from "./ask.ts";
import { decodeFullState, type ScanFullState } from "./boundSmallServices.ts";

/** The sites the system's scan manager knows of, in the system the pilot's session is in. Fails as the call fails. */
export async function readScanFullState(ask: Ask): Promise<ScanFullState> {
  return decodeFullState(await ask("scanMgr", "GetFullState", []));
}
