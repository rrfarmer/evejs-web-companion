// Every action a bot can decide on has a case where the page carries actions
// out. An action with a sentence in the log (nav/botLog.test.ts holds that) and
// no case here would be logged as issued and do nothing: a launch's own warp
// was added on 2026-10-09 with no test that would have noticed it missing.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The action kinds the union itself declares, read out of the source. */
function unionKinds(): readonly string[] {
  const source = readFileSync(fileURLToPath(new URL("../nav/scriptDecide.ts", import.meta.url)), "utf8");
  const start = source.indexOf("export type ScriptAction =");
  assert.ok(start >= 0, "the action union moved");
  const end = source.indexOf("\nexport ", start + 1);
  const body = source.slice(start, end < 0 ? undefined : end);
  return [...new Set([...body.matchAll(/readonly kind: "([a-zA-Z]+)"/g)].map((match) => match[1] as string))];
}

test("every action the union declares has a case where the page carries actions out", () => {
  const flow = readFileSync(fileURLToPath(new URL("./flow.ts", import.meta.url)), "utf8");
  const kinds = unionKinds();
  assert.ok(kinds.length > 60, `the union read as ${kinds.length} kinds, which is too few to be it`);
  const missing = kinds.filter((kind) => !flow.includes(`case "${kind}":`));
  assert.deepEqual(missing, [], "these actions are decided on and never carried out");
});

test("a thing's warp, the autopilot's and a fleet member's are carried out by the page's own calls wherever the page warps; their routes' askers are gone", () => {
  const flow = readFileSync(fileURLToPath(new URL("./flow.ts", import.meta.url)), "utf8");
  const times = (text: string) => flow.split(text).length - 1;
  // The travel loop's warp: the client's autopilot's own call, and the menu's at nought where the loop flies a
  // pilot's own Dock or Jump.
  assert.equal(times("await warpAsTheAutopilot(destinationID);"), 1);
  assert.equal([...flow.matchAll(/warp: async \(destinationID, byMenu\) => \{[^}]*if \(byMenu\) \{\s+await warpToThing\(destinationID, MENU_WARP_RANGE_M\);\s+return;\s+\}[^}]*await warpAsTheAutopilot\(destinationID\);\s+\},/g)].length, 1);
  // The mining bot's own warp is the menu's call at nought too.
  assert.equal(times("await warpToThing(destinationID, MENU_WARP_RANGE_M);"), 2);
  // A script bot's.
  assert.equal([...flow.matchAll(/case "warp":\s+await warpToThing\(action\.targetID, MENU_WARP_RANGE_M\);\s+return;/g)].length, 1);
  // The fleet companion's: the autopilot's own call, and a fleet member by the pilot's number.
  assert.equal([...flow.matchAll(/case "warp":\s+await warpAsTheAutopilot\(action\.targetID\);\s+return;/g)].length, 1);
  assert.equal([...flow.matchAll(/await warpToMember\(action\.characterID\);\s+return;/g)].length, 1);
  // The flight panel's and the overview's: the autopilot's with no range said, the menu's with one.
  assert.equal(times("minRange === null ? autopilotWarpCall(bridgeDo, flightNow, destinationID) : warpToItemCall(bridgeDo, flightNow, destinationID, minRange)"), 1);
  // Each of the three goes as a write, with the pilot's flight read first.
  assert.equal(times("await warpToItemCall(bridgeDo, readFlightNow, targetID, range);"), 1);
  assert.equal(times("await autopilotWarpCall(bridgeDo, readFlightNow, targetID);"), 1);
  assert.equal(times("await warpToFleetMemberCall(bridgeDo, readFlightNow, characterID);"), 1);
  assert.equal(flow.includes("api.warpTo("), false);
  assert.equal(flow.includes("api.warpToFleetMember("), false);
  const api = readFileSync(fileURLToPath(new URL("./api.ts", import.meta.url)), "utf8");
  assert.equal(api.includes('"/api/bridge/flight/warp"'), false);
  assert.equal(api.includes("/api/bridge/flight/warp-member"), false);
});

test("a mission's marked spot is warped to by asking its agent, by the page's own call; and the mission block reads the journal and no folder of bookmarks", () => {
  const flow = readFileSync(fileURLToPath(new URL("./flow.ts", import.meta.url)), "utf8");
  assert.equal([...flow.matchAll(/case "warpMissionLocation":\s+await warpToMissionSpot\(action\.agentID, action\.locationType, action\.locationNumber\);\s+return;/g)].length, 1);
  assert.equal(flow.split("await warpToMissionLocationCall(bridgeDo, readFlightNow, { agentID, locationType, locationNumber });").length - 1, 1);
  // The bookmarks' folders are read for a saved spot's block, and no more for the mission's.
  assert.equal(flow.split('if (macro === "warp-to-bookmark") {').length - 1, 1);
  assert.equal(flow.includes('macro === "warp-to-bookmark" || macro === "fly-to-mission-site"'), false);
});

test("a launch's warp and a bookmark's are carried out by the page's own calls; their routes' askers are gone", () => {
  const flow = readFileSync(fileURLToPath(new URL("./flow.ts", import.meta.url)), "utf8");
  assert.equal([...flow.matchAll(/case "warpLaunch":\s+await warpToLaunchPickup\(action\.launchID\);\s+return;/g)].length, 1);
  assert.equal([...flow.matchAll(/case "warpBookmark":\s+await warpToSpot\(action\.bookmarkID\);\s+return;/g)].length, 1);
  assert.equal(flow.split("await warpToLaunchCall(bridgeDo, readFlightNow, launchID);").length - 1, 1);
  assert.equal(flow.split("await warpToBookmarkCall(bridgeDo, readFlightNow, bookmarkID);").length - 1, 1);
  assert.equal(flow.includes("api.warpToLaunch("), false);
  assert.equal(flow.includes("api.warpToBookmark("), false);
  const api = readFileSync(fileURLToPath(new URL("./api.ts", import.meta.url)), "utf8");
  assert.equal(api.includes("/api/bridge/flight/warp-launch"), false);
  assert.equal(api.includes("/api/bridge/flight/warp-bookmark"), false);
});

test("a launchpad sent up at its office is carried out by the customs office's own transfer, and the colonies are read while offices are collected from", () => {
  const flow = readFileSync(fileURLToPath(new URL("./flow.ts", import.meta.url)), "utf8");
  const at = flow.indexOf('case "exportCustoms":');
  assert.ok(at >= 0);
  // The page's own two calls since 2026-10-13 (bridge/customsWrites.ts), where the pilot is as the flight read has it.
  assert.match(flow.slice(at, at + 400), /^case "exportCustoms": \{[\s\S]*?await exportToCustomsOffice\(bridgeAsk, bridgeDo, \{ dockedAt: dockedNow\(\) \}, action\.officeID, action\.pinID, action\.commodities\);\s+return;\s+\}/);
  const api = readFileSync(fileURLToPath(new URL("./api.ts", import.meta.url)), "utf8");
  assert.equal(api.includes('"/api/bridge/planet/customs/export"'), false);
  // The block needs what each launchpad holds, so the read that gives it runs for this block too.
  assert.match(flow, /if \(macro === "restart-extractors" \|\| macro === "launch-commodities" \|\| macro === "collect-customs"\) \{/);
});

test("a scan result's warp is carried out by the page's own call, by what the look read of the scanner; the route's asker is gone", () => {
  const flow = readFileSync(fileURLToPath(new URL("./flow.ts", import.meta.url)), "utf8");
  assert.equal([...flow.matchAll(/case "warpScan":\s+await warpToSite\(action\.target\);\s+return;/g)].length, 1);
  // The look's read of the scanner is kept with the system it was of, and handed to the call with a reader beside it.
  assert.equal(flow.split("sitesLastRead = { solarSystemID: status.solarSystemID, anomalies: full.anomalies, structures: full.structures };").length - 1, 1);
  assert.equal(flow.split("await warpToScanResultCall(bridgeDo, readFlightNow, sitesLastRead, () => readScanFullState(bridgeAsk), label);").length - 1, 1);
  assert.equal(flow.includes("api.warpToScanSite("), false);
  const api = readFileSync(fileURLToPath(new URL("./api.ts", import.meta.url)), "utf8");
  assert.equal(api.includes("/api/bridge/flight/warp-scan"), false);
});

test("an align is carried out by the page's own call wherever the page carries a bot's actions out, and before a recall's warp home", () => {
  const flow = readFileSync(fileURLToPath(new URL("./flow.ts", import.meta.url)), "utf8");
  // The fleet companion's actions and a script bot's: two places, and the same call in each.
  assert.equal(flow.split('case "align":').length - 1, 2);
  assert.equal([...flow.matchAll(/case "align":\s+await alignShip\(action\.targetID\);\s+return;/g)].length, 2);
  // Drones called home before a dock: the ship is aligned out while they come, and a refusal is let go.
  assert.equal(flow.split("await alignShip(best.itemID).catch(() => {});").length - 1, 1);
  // The route's asker is gone from the flow, and from the page's askers.
  assert.equal(flow.includes("api.alignTo("), false);
  const api = readFileSync(fileURLToPath(new URL("./api.ts", import.meta.url)), "utf8");
  assert.equal(api.includes("/api/bridge/flight/align"), false);
});

test("an approach and a keep at range are carried out by the page's own calls wherever the page carries a bot's actions out", () => {
  const flow = readFileSync(fileURLToPath(new URL("./flow.ts", import.meta.url)), "utf8");
  const times = (text: string) => flow.split(text).length - 1;
  // The fleet companion's approach: where to stop, or the client's own fifty metres where none is said.
  assert.equal(times("await approachShip(action.targetID, action.range ?? null);"), 1);
  // A script bot's and the mining bot's: the menu's approach, at the client's own fifty with no throttle.
  assert.equal(times("await approachShip(action.targetID, null);"), 1);
  assert.equal(times("await approachShip(destinationID, null);"), 1);
  // Nothing but the travel loop makes the autopilot's approach, a follow at nought with the throttle opened first.
  assert.equal(times("await approachShip(action.targetID, 0);"), 0);
  assert.equal(times("await approachShip(destinationID, 0);"), 0);
  // The travel loop's: the autopilot's, or the menu's at the client's own fifty where the loop says so.
  assert.equal(times("await approachShip(destinationID, byMenu ? null : 0);"), 1);
  // Keep at range, the companion's and a script bot's.
  assert.equal(times("await keepShipAtRange(action.targetID, action.range);"), 2);
  // Both are the page's own writes (bridgeDo), with the pilot's flight read before them.
  assert.equal(times("await approachCall(bridgeDo, readFlightNow, targetID, range);"), 1);
  assert.equal(times("await keepAtRangeCall(bridgeDo, readFlightNow, targetID, range);"), 1);
  assert.equal(times("const readFlightNow = async (): Promise<FlightNow> => decodeFlightStatus((await api.getFlightStatus(callOptions)).flight);"), 1);
  assert.equal([...flow.matchAll(/case "approach":/g)].length, 2);
  assert.equal([...flow.matchAll(/case "keepAtRange":/g)].length, 2);
  // The routes' askers are gone from the flow, and from the page's askers.
  assert.deepEqual([flow.includes("api.approach("), flow.includes("api.keepAtRange(")], [false, false]);
  const api = readFileSync(fileURLToPath(new URL("./api.ts", import.meta.url)), "utf8");
  assert.deepEqual([api.includes("/api/bridge/flight/approach"), api.includes("/api/bridge/flight/keep-at-range")], [false, false]);
});

test("an orbit is carried out by the page's own call wherever the page carries a bot's actions out", () => {
  const flow = readFileSync(fileURLToPath(new URL("./flow.ts", import.meta.url)), "utf8");
  const times = (text: string) => flow.split(text).length - 1;
  // Two dispatchers, as for keep-at-range: the script bot's, and the fleet
  // companion's (`flight auto`, where a gun boat orbits what it is shooting).
  assert.equal([...flow.matchAll(/case "orbit":/g)].length, 2);
  assert.equal([...flow.matchAll(/case "orbit":\s+await orbitShip\(action\.targetID, action\.range\);\s+return;/g)].length, 2);
  // The page's own write (bridgeDo), with the pilot's flight read before it.
  assert.equal(times("await orbitCall(bridgeDo, readFlightNow, targetID, range);"), 1);
  // The route's asker is gone from the flow, and from the page's askers.
  assert.equal(flow.includes("api.orbit("), false);
  const api = readFileSync(fileURLToPath(new URL("./api.ts", import.meta.url)), "utf8");
  assert.equal(api.includes("/api/bridge/flight/orbit"), false);
});

test("a stop is carried out by the page's own call wherever the page carries a bot's actions out, and the autopilot is given up first where a stop is the operator's", () => {
  const flow = readFileSync(fileURLToPath(new URL("./flow.ts", import.meta.url)), "utf8");
  const times = (text: string) => flow.split(text).length - 1;
  assert.equal([...flow.matchAll(/case "stopShip":/g)].length, 3);
  // The fleet companion's stop is an operator's word: the page's autopilot is given up, and then the ship is stopped.
  assert.equal([...flow.matchAll(/case "stopShip":\s+autopilot\?\.abort\(\);\s+await cutEngines\(\);\s+return;/g)].length, 1);
  // A support ship's, and a script bot's: one step of a running program, which carries on after it.
  assert.equal(times('case "stopShip": await cutEngines(); break;'), 1);
  assert.equal([...flow.matchAll(/case "stopShip":\s+await cutEngines\(\);\s+return;/g)].length, 1);
  // The page's own write (bridgeDo), with the pilot's flight read before it.
  assert.equal(times("await stopShipCall(bridgeDo, readFlightNow);"), 1);
  // The panel's: the autopilot given up first, then the stop.
  assert.equal([...flow.matchAll(/autopilot\?\.abort\(\);\s+await runFlightStep\("Stop", \(\) => orderedStep\(\(flightNow\) => stopShipCall\(bridgeDo, flightNow\)\)\);/g)].length, 1);
  // The route's asker is gone from the flow, and from the page's askers.
  assert.equal(flow.includes("api.stopShip("), false);
  const api = readFileSync(fileURLToPath(new URL("./api.ts", import.meta.url)), "utf8");
  assert.equal(api.includes("/api/bridge/flight/stop"), false);
});

test("a fleet is formed by the page's own call wherever the page carries a bot's actions out", () => {
  const flow = readFileSync(fileURLToPath(new URL("./flow.ts", import.meta.url)), "utf8");
  const times = (text: string) => flow.split(text).length - 1;
  // A support ship's, and a script bot's: each decided on the bot's own reading that it is in no fleet.
  assert.equal(times('if (action.kind === "createFleet") await formFleetCall(bridgeDo, false);'), 1);
  assert.equal([...flow.matchAll(/case "createFleet":\s+\/\/[^\n]*\n\s+\/\/[^\n]*\n\s+await formFleetCall\(bridgeDo, false\);\s+return;/g)].length, 1);
  assert.equal(times("formFleetCall(bridgeDo, false)"), 2);
  // The Fleet window's: none from a pilot the window knows to be in a fleet.
  assert.equal(times('await runFleetAction("form", () => formFleetCall(bridgeDo, store.fleet.get().availability === "ready"), "ready");'), 1);
  // The route's asker is gone from the flow, and from the page's askers.
  assert.equal(flow.includes("api.createFleet("), false);
  const api = readFileSync(fileURLToPath(new URL("./api.ts", import.meta.url)), "utf8");
  assert.equal(api.includes("/api/bridge/fleet/create"), false);
});

test("an invitation is accepted by the page's own call wherever the page carries a bot's actions out", () => {
  const flow = readFileSync(fileURLToPath(new URL("./flow.ts", import.meta.url)), "utf8");
  const times = (text: string) => flow.split(text).length - 1;
  // The fleet companion's, a support ship's, and a script bot's (with the invitation's fleet, or the one the
  // Fleet window was told of): each on the bot's own reading that it is in no fleet.
  assert.equal(times("await acceptFleetInviteCall(bridgeDo, action.fleetID, false);"), 2);
  assert.equal(times("await acceptFleetInviteCall(bridgeDo, fleetID, false);"), 1);
  // The Fleet window's: none from a pilot the window knows to be in a fleet.
  assert.equal(times('await runFleetAction("accept", () => acceptFleetInviteCall(bridgeDo, wanted, store.fleet.get().availability === "ready"), "ready");'), 1);
  // The route's asker is gone from the flow, and from the page's askers.
  assert.equal(flow.includes("api.acceptFleetInvite("), false);
  const api = readFileSync(fileURLToPath(new URL("./api.ts", import.meta.url)), "utf8");
  assert.equal(api.includes("/api/bridge/fleet/invite/accept"), false);
});

test("a pilot is invited by the page's own call wherever the page carries a bot's actions out", () => {
  const flow = readFileSync(fileURLToPath(new URL("./flow.ts", import.meta.url)), "utf8");
  const times = (text: string) => flow.split(text).length - 1;
  // A support ship's, and a script bot's: the invitee, and the pilot's own character for the page's refusal.
  assert.equal(times('else if (action.kind === "inviteToFleet") await inviteToFleetCall(bridgeDo, action.charID, onlineCharacterID());'), 1);
  assert.equal([...flow.matchAll(/case "inviteToFleet":\s+await inviteToFleetCall\(bridgeDo, action\.charID, onlineCharacterID\(\)\);\s+(return|break);/g)].length, 1);
  // The Fleet window's and the bot host's: with the fleet expected where one is given, and the dispatch fenced
  // where the caller gives a fence.
  assert.equal(times("inviteToFleetCall(assertCurrent ? fencedDo(assertCurrent) : bridgeDo, characterID, onlineCharacterID(), expectedFleetID)"), 1);
  // The route's asker is gone from the flow, and from the page's askers.
  assert.equal(flow.includes("api.inviteToFleet("), false);
  const api = readFileSync(fileURLToPath(new URL("./api.ts", import.meta.url)), "utf8");
  assert.equal(api.includes('"/api/bridge/fleet/invite"'), false);
});

test("a mining site's return point is bookmarked by the page's own call, where the page carries a bot's actions out", () => {
  const flow = readFileSync(fileURLToPath(new URL("./flow.ts", import.meta.url)), "utf8");
  // The hauler's own ship, the folder, the name and the note; kept two days, as it was by its route.
  assert.equal(flow.split("create: async (id, folder, name, note) => { await bookmarkLocationCall(bridgeDo, id, folder, name, note, BOOKMARK_EXPIRY.twoDays); },").length - 1, 1);
  assert.equal(flow.includes("api.bookmarkMiningSiteLocation("), false);
  const api = readFileSync(fileURLToPath(new URL("./api.ts", import.meta.url)), "utf8");
  assert.equal(api.includes('"/api/bridge/flight/bookmark-location"'), false);
  // What it reads, before to find a return point made already and after to see the one it made, is the page's
  // own read of the bookmarks (bridge/bookmarkReads.ts): a read that failed is no empty list of them.
  assert.equal(flow.split("read: async () => readMyActiveBookmarks(bridgeAsk),").length - 1, 1);
  assert.equal(flow.includes("api.loadActiveBookmarks("), false);
  assert.equal(flow.includes("decodeActiveBookmarks("), false);
  assert.equal(api.includes('"/api/bridge/bookmarks"'), false);
});

test("a target is locked by the page's own call wherever the page carries a bot's actions out; and let go by the flow's own letting go", () => {
  const flow = readFileSync(fileURLToPath(new URL("./flow.ts", import.meta.url)), "utf8");
  const times = (text: string) => flow.split(text).length - 1;
  // The fleet companion's, the mining bot's, a support ship's own mining and its tractor's, and a script bot's: each
  // on its own reading that the thing is not locked.
  assert.equal(times("await lockTargetCall(bridgeDo, action.targetID, null);"), 2);
  assert.equal(times("await lockTargetCall(bridgeDo, targetID, null);"), 1);
  assert.equal(times('case "lock": await lockTargetCall(bridgeDo, self.action.targetID, null); break;'), 1);
  assert.equal(times('case "lock": await lockTargetCall(bridgeDo, tractor.action.targetID, null); break;'), 1);
  // A script bot's letting go: by what the page has of the target, as the panel's is.
  assert.equal([...flow.matchAll(/case "unlock":\s+await releaseTarget\(action\.targetID\);\s+return;/g)].length, 1);
  assert.equal(flow.includes("api.lockTarget("), false);
  assert.equal(flow.includes("api.unlockTarget("), false);
  const api = readFileSync(fileURLToPath(new URL("./api.ts", import.meta.url)), "utf8");
  assert.equal(api.includes('"/api/bridge/targets/lock"'), false);
  assert.equal(api.includes('"/api/bridge/targets/unlock"'), false);
});
