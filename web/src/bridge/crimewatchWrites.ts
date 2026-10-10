// Crimewatch's write, made by the page itself (the plan's Phase 6b).
//
// Until 2026-10-10 the ship's safety level was set by one route of the BFF
// (POST /api/bridge/safety/set-level), which checked that the page had said
// `confirm`, checked that the level was one of the three, and made one call. A
// retail client has no such route: its crimewatch service makes the call
// (eve/client/script/ui/services/crimewatchSvc.py).
//
// THE CALL, as the client makes it:
//
//   crimewatch.SetSafetyLevel(safetyLevel)   crimewatchSvc.py 343: one of the three levels (crimewatch/const.py:
//                                            none 0, partial 1, full 2), on the moniker for where the pilot is,
//                                            made for the call. The service then has that level as the level
//                                            (344) and asks crimewatch nothing.
//
// It is in none of the Tranquility recordings: its form is from the client's own
// code alone.
//
// WHO MAKES IT. The safety button's selector (shipSafetyButton.py 464): a level
// no lower than the one now is set at once; a lower one wants a second press, on
// a Confirm beside it (475, 660); a level that is locked is not set at all. That
// asking is the selector's, and the page's selector does the same
// (ui/SafetyChooser.svelte, space/crimewatch.ts). This is the call it ends in.
//
// WHAT THE SERVER MAKES OF IT. It sets the level of the session's own character,
// and takes any number as one of the three. What it answers the client does not
// read, and neither does this.
//
// Either transport carries the call. THE ROUTE STILL STANDS (src/server.js);
// nothing of the page's asks it now.

import type { Ask } from "./ask.ts";

/** The ship's safety level set to one of the three. Fails as the call fails. */
export async function setSafetyLevel(act: Ask, level: 0 | 1 | 2): Promise<void> {
  await act("crimewatch", "SetSafetyLevel", [level]);
}
