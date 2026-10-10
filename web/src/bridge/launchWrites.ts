// A planetary launch's record removed, by the page itself (the plan's Phase 6b).
//
// Until 2026-10-10 it was one route of the BFF (POST /api/bridge/planet/launch/delete),
// which checked that the page had said `confirm` and made one call. A retail
// client has no such route: its journal makes the call.
//
// THE CALL, as the client makes it:
//
//   planetMgr.DeleteLaunch(launchID)   journal.py 464: of the planet manager by its name, with the launch's
//                                      ID. The journal's list of launches has Remove on each (443); it takes
//                                      the row off its list, makes this call, and asks for the launches
//                                      afresh, asking the pilot nothing first.
//
// It is in none of the Tranquility recordings: its form is from the client's own
// code alone.
//
// WHAT IT REMOVES is the record, and nothing else: the launch's container and
// whatever is in it stay in space. The server removes a launch only for the
// character that launched it. The one thing here that removes a launch is a
// bot's collecting of one, which does so only once it has seen the container
// empty (app/flow.ts, collectLaunch).
//
// Either transport carries the call. THE ROUTE STILL STANDS (src/server.js);
// nothing of the page's asks it now.

import type { Ask } from "./ask.ts";

/** One planetary launch's record removed. Fails as the call fails. */
export async function removeLaunch(act: Ask, launchID: number): Promise<void> {
  await act("planetMgr", "DeleteLaunch", [launchID]);
}
