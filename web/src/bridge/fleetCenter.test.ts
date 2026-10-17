import test from "node:test";
import assert from "node:assert/strict";

import {
  authoritativeFleetMemberCharacterIDs,
  decodeFleetCenter,
  decodeFleetInviteAnswerNotification,
  decodeFleetInviteNotification,
  fleetCommanderWhereabouts,
  fleetInviteAnswerWords,
  memberWhereabouts,
} from "./fleetCenter.ts";

const READS = [
  "GetInitState",
  "GetWings",
  "GetMotd",
  "GetJoinRequests",
  "GetFleetComposition",
] as const;

function errorReads(message: string): Record<string, unknown> {
  return Object.fromEntries(
    READS.map((name) => [name, { error: "CALL_REFUSED", message }]),
  );
}

test("Fleet Center distinguishes an authoritative fleetless answer from an outage", () => {
  const none = decodeFleetCenter({
    ok: true,
    characterID: 140000005,
    fleetID: null,
    reads: errorReads("FleetNotFound"),
  } as never);
  assert.equal(none.availability, "not-in-fleet");
  assert.equal(none.fleet.initState.message, "FleetNotFound");

  const failed = decodeFleetCenter({
    ok: true,
    characterID: 140000005,
    fleetID: null,
    reads: errorReads("Gateway unavailable"),
  } as never);
  assert.equal(failed.availability, "unavailable");
});

test("Fleet Center reads the member gate's FleetNotInFleet refusal as fleetless", () => {
  // The bound reads pass fleetObjectHandler's member gate before the fleet
  // runtime, so a fleetless character is refused FleetNotInFleet on all five.
  const gated = decodeFleetCenter({
    ok: true,
    characterID: 140000005,
    fleetID: null,
    reads: errorReads("FleetNotInFleet"),
  } as never);
  assert.equal(gated.availability, "not-in-fleet");
  assert.deepEqual(authoritativeFleetMemberCharacterIDs(gated), []);

  // Either fleetless refusal, mixed across reads, is still one settled answer.
  const mixed = decodeFleetCenter({
    ok: true,
    characterID: 140000005,
    fleetID: null,
    reads: { ...errorReads("FleetNotInFleet"), GetMotd: { error: "CALL_REFUSED", message: "FleetNotFound" } },
  } as never);
  assert.equal(mixed.availability, "not-in-fleet");

  // One read failing for any other reason keeps the whole answer unknown.
  const partial = decodeFleetCenter({
    ok: true,
    characterID: 140000005,
    fleetID: null,
    reads: { ...errorReads("FleetNotInFleet"), GetWings: { error: "READ_FAILED", message: "timed out" } },
  } as never);
  assert.equal(partial.availability, "unavailable");
});

test("Fleet Center requires a successful GetInitState before calling a cached fleet ready", () => {
  const decoded = decodeFleetCenter({
    ok: true,
    characterID: 140000005,
    fleetID: 999000001,
    reads: errorReads("Read timed out"),
  } as never);
  assert.equal(decoded.availability, "unavailable");
});

test("bot fleet-member IDs distinguish a missing roster from an authoritative empty roster", () => {
  const unavailable = decodeFleetCenter({
    ok: true,
    characterID: 140000005,
    fleetID: 999000001,
    reads: errorReads("Read timed out"),
  } as never);
  assert.equal(authoritativeFleetMemberCharacterIDs(unavailable), null);

  const none = decodeFleetCenter({
    ok: true,
    characterID: 140000005,
    fleetID: null,
    reads: errorReads("FleetNotFound"),
  } as never);
  assert.deepEqual(authoritativeFleetMemberCharacterIDs(none), []);

  const ready = {
    availability: "ready",
    fleet: {
      initState: {
        value: {
          members: [
            { charID: 140000002 },
            { charID: "140000005" },
            { charID: 140000002 },
            { charID: null },
          ],
        },
      },
    },
  } as never;
  assert.deepEqual(authoritativeFleetMemberCharacterIDs(ready), [140000002, 140000005]);
});

test("each commander's place is read off the roster, the composition's word first, and a missing roster stays null", () => {
  const unavailable = decodeFleetCenter({
    ok: true,
    characterID: 140000005,
    fleetID: 999000001,
    reads: errorReads("Read timed out"),
  } as never);
  assert.equal(fleetCommanderWhereabouts(unavailable), null);

  const ready = {
    availability: "ready",
    fleet: {
      initState: {
        value: {
          members: [
            // The boss: docked by its own record, but the composition says in space.
            { charID: 140000002, role: 1, job: 0, stationID: 60000004, solarSystemID: 30002780 },
            // A squad member: not a commander, so not listed.
            { charID: 140000003, role: 4, job: 0, stationID: null, solarSystemID: 30002780 },
            // The creator, docked, with no composition entry.
            { charID: "140000005", role: 4, job: 2, stationID: 60000004, solarSystemID: 30002780 },
          ],
        },
      },
      composition: {
        value: [{ characterID: 140000002, shipTypeID: 648, stationID: null, solarSystemID: 30002781 }],
      },
    },
  } as never;
  assert.deepEqual(fleetCommanderWhereabouts(ready), [
    { characterID: 140000002, solarSystemID: 30002781, stationID: null },
    { characterID: 140000005, solarSystemID: 30002780, stationID: 60000004 },
  ]);
});

test("fleet invite notification retains the authoritative fleet and inviter IDs", () => {
  assert.deepEqual(
    decodeFleetInviteNotification(
      "OnFleetInvite",
      [{ type: "long", value: "654500010000" }, 140000002, "AskJoinFleet", {}],
      1234,
    ),
    { fleetID: 654500010000, inviterID: 140000002, receivedAtMs: 1234 },
  );
  assert.equal(decodeFleetInviteNotification("OnFleetJoin", [1, 2], 1234), null);
  assert.equal(decodeFleetInviteNotification("OnFleetInvite", [0, 2], 1234), null);
});

test("Fleet Center takes the session's own word that there is no fleet, and nothing less", () => {
  // On the game port the route asks nothing of a fleet the session is not in, and says so.
  const notAsked = Object.fromEntries(READS.map((name) => [name, { error: "NOT_ASKED", message: null }]));
  const none = decodeFleetCenter({ ok: true, characterID: 140000002, fleetID: null, membership: "none", reads: notAsked } as never);
  assert.equal(none.availability, "not-in-fleet");
  assert.equal(none.fleet.sessionHasNoFleet, true);
  assert.deepEqual(authoritativeFleetMemberCharacterIDs(none), []);
  // Reads that were not asked, with nobody saying the session has no fleet, are not an answer.
  for (const membership of [undefined, null, "asked", "NONE", true]) {
    const unsaid = decodeFleetCenter({ ok: true, characterID: 140000002, fleetID: null, membership, reads: notAsked } as never);
    assert.deepEqual([unsaid.availability, unsaid.fleet.sessionHasNoFleet], ["unavailable", false], String(membership));
  }
  // A fleet that answers for itself outranks it.
  const ready = decodeFleetCenter({
    ok: true, characterID: 140000002, fleetID: null, membership: "none",
    reads: { ...notAsked, GetInitState: { result: { type: "object", name: "util.KeyVal", args: { type: "dict", entries: [["fleetID", 654500010000], ["members", { type: "dict", entries: [] }]] } } } },
  } as never);
  assert.equal(ready.availability, "ready");
});

test("a member's ship and place are the fleet composition's word, and its own record's only where that has none", () => {
  // The client keeps neither in a member's record once the record has changed (fleetSvc.OnFleetMemberChanged makes
  // a new one of six fields); its window for them asks GetFleetComposition.
  const keyVal = (entries: readonly (readonly [string, unknown])[]) => ({ type: "object", name: "util.KeyVal", args: { type: "dict", entries } });
  const joined = keyVal([["charID", 140000002], ["wingID", 1], ["squadID", 2], ["role", 4], ["job", 0], ["shipTypeID", 648], ["stationID", 60000004], ["solarSystemID", 30002780]]);
  const changed = keyVal([["charID", 140000003], ["wingID", 1], ["squadID", 2], ["role", 4], ["job", 0]]);
  const unnamed = keyVal([["wingID", 1], ["shipTypeID", 670], ["stationID", 60003760], ["solarSystemID", 30000142]]);
  const entry = (characterID: unknown, shipTypeID: unknown, stationID: unknown, solarSystemID: unknown) =>
    keyVal([["characterID", characterID], ["shipTypeID", shipTypeID], ["stationID", stationID], ["solarSystemID", solarSystemID], ["skills", { type: "list", items: [] }], ["skillIDs", { type: "list", items: [] }]]);
  const center = (composition: readonly unknown[]) => decodeFleetCenter({
    ok: true,
    characterID: 140000002,
    fleetID: null,
    reads: {
      GetInitState: { result: keyVal([["fleetID", 654500010000], ["members", { type: "dict", entries: [[140000002, joined], [140000003, changed], [0, unnamed]] }]]) },
      GetWings: { result: { type: "dict", entries: [] } },
      GetMotd: { result: "" },
      GetJoinRequests: { result: { type: "dict", entries: [] } },
      GetFleetComposition: { result: { type: "list", items: composition } },
    },
  } as never).fleet;

  // With no composition: each record's own, which for a changed record is nothing.
  const whereabouts = (fleet: ReturnType<typeof center>, index: number) => {
    const member = fleet.initState.value.members[index];
    assert.ok(member, `member ${index}`);
    return memberWhereabouts(member, fleet.composition.value);
  };
  const bare = center([]);
  assert.equal(bare.initState.value.members.length, 3);
  assert.deepEqual(whereabouts(bare, 0), { shipTypeID: 648, stationID: 60000004, solarSystemID: 30002780 });
  assert.deepEqual(whereabouts(bare, 1), { shipTypeID: null, stationID: null, solarSystemID: null });
  assert.deepEqual(whereabouts(bare, 2), { shipTypeID: 670, stationID: 60003760, solarSystemID: 30000142 });

  // The composition's word is taken whole: a pilot it says is in space is not docked where its record last had it.
  const fleet = center([entry(140000003, 587, null, 30000144), entry(140000002, 648, null, 30002781), entry(null, 1, 2, 3)]);
  assert.deepEqual(whereabouts(fleet, 0), { shipTypeID: 648, stationID: null, solarSystemID: 30002781 });
  assert.deepEqual(whereabouts(fleet, 1), { shipTypeID: 587, stationID: null, solarSystemID: 30000144 });
  // A record that names nobody is nobody's entry, even one that names nobody too.
  assert.deepEqual(whereabouts(fleet, 2), { shipTypeID: 670, stationID: 60003760, solarSystemID: 30000142 });
});

test("what the inviter is told of an invitation turned down is read from OnFleetJoinReject: the pilot, and the server's reason where it is one the client knows", () => {
  // fleetSvc.OnFleetJoinReject(memberID, reasonCode), 1217. evefleet's two reasons: 1, no response; 2, already in a fleet.
  assert.deepEqual(decodeFleetInviteAnswerNotification("OnFleetJoinReject", [140000003, 1]), { characterID: 140000003, reason: "no-response" });
  assert.deepEqual(decodeFleetInviteAnswerNotification("OnFleetJoinReject", [140000003, 2]), { characterID: 140000003, reason: "in-a-fleet" });
  // No reason, or one the client does not know: turned down, and no more is said of it (1218, 1222).
  for (const code of [null, undefined, 0, 3, -1, "2x", {}, [2], true]) {
    assert.deepEqual(decodeFleetInviteAnswerNotification("OnFleetJoinReject", [140000003, code]), { characterID: 140000003, reason: "none" }, JSON.stringify(code) ?? "undefined");
  }
  assert.deepEqual(decodeFleetInviteAnswerNotification("OnFleetJoinReject", [140000003]), { characterID: 140000003, reason: "none" });
  // The wire's longs, and numbers as text.
  assert.deepEqual(decodeFleetInviteAnswerNotification("OnFleetJoinReject", [{ type: "long", value: "140000003" }, { type: "long", value: "2" }]), { characterID: 140000003, reason: "in-a-fleet" });
  assert.deepEqual(decodeFleetInviteAnswerNotification("OnFleetJoinReject", ["140000003", "1"]), { characterID: 140000003, reason: "no-response" });
  // Another notice, or nobody named, is nothing: the applicant's own notice is not this one.
  for (const [method, args] of [["OnFleetJoinRejected", [140000003, 1]], ["OnFleetJoin", [140000003, 1]], [null, [140000003, 1]], ["OnFleetJoinReject", [0, 1]], ["OnFleetJoinReject", [null, 2]], ["OnFleetJoinReject", []], ["OnFleetJoinReject", ["a pilot", 1]]] as const) {
    assert.equal(decodeFleetInviteAnswerNotification(method, args), null, JSON.stringify([method, args]));
  }
});

test("the page says in its own words what the inviter was told, and names the pilot where it can", () => {
  assert.equal(fleetInviteAnswerWords("Test Three", "none"), "Test Three turned down your fleet invitation.");
  assert.equal(fleetInviteAnswerWords("Test Three", "no-response"), "Test Three did not answer your fleet invitation.");
  assert.equal(fleetInviteAnswerWords("Test Three", "in-a-fleet"), "Test Three is already in a fleet, so your invitation was turned down.");
  for (const nobody of [null, "", "   "]) {
    assert.equal(fleetInviteAnswerWords(nobody, "none"), "The pilot you invited turned down your fleet invitation.", JSON.stringify(nobody));
    assert.equal(fleetInviteAnswerWords(nobody, "no-response"), "The pilot you invited did not answer your fleet invitation.", JSON.stringify(nobody));
    assert.equal(fleetInviteAnswerWords(nobody, "in-a-fleet"), "The pilot you invited is already in a fleet, so your invitation was turned down.", JSON.stringify(nobody));
  }
  assert.equal(fleetInviteAnswerWords("  Test Three ", "none"), "Test Three turned down your fleet invitation.");
});
