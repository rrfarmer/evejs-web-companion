import assert from "node:assert/strict";
import test from "node:test";
import type { FleetCompositionEntry, FleetMember } from "./boundFleet.ts";
import { canSeeCompositionMember, summarizeFleetComposition } from "./fleetComposition.ts";
import { FLEET_ROLE } from "./fleetMemberMenu.ts";

test("fleet summary multiplies the hull cost, combines groups and counts ships with unknown data", () => {
  const ships = [603, "603", 587, 606, null].map((shipTypeID, characterID): FleetCompositionEntry => ({
    characterID, solarSystemID: null, stationID: null, shipTypeID, skills: [], skillIDs: [],
  }));
  const summary = summarizeFleetComposition(ships, typeID => typeID === 606 ? 29 : 25, typeID => (
    { 603: 12.5, 587: 0 } as Record<number, number>
  )[typeID]);

  assert.deepEqual(summary, {
    byType: [
      { typeID: 603, groupID: 25, count: 2, jumpCost: 25 },
      { typeID: 587, groupID: 25, count: 1, jumpCost: 0 },
      { typeID: 606, groupID: 29, count: 1, jumpCost: null },
    ],
    byGroup: [{ groupID: 25, count: 3 }, { groupID: 29, count: 1 }],
    unknownShips: 1,
    totalCost: 25,
  });
});

test("the composition roster respects command scope and the boss bit", () => {
  const member: FleetMember = {
    charID: 140000001, wingID: 10, squadID: 20, skills: [], timestamp: null, stationID: null,
    clientID: null, job: 0, role: FLEET_ROLE.member, shipTypeID: null, solarSystemID: null,
    memberOptOuts: { acceptsConduitJumps: false, acceptsFleetRegroups: false, acceptsFleetWarp: false },
  };
  assert.equal(canSeeCompositionMember({ ...member, job: 1 }, member), false);
  assert.equal(canSeeCompositionMember({ ...member, job: 3, wingID: 30, squadID: 40 }, member), true);
  assert.equal(canSeeCompositionMember({ ...member, role: FLEET_ROLE.leader }, member), true);
  assert.equal(canSeeCompositionMember({ ...member, role: FLEET_ROLE.wingCmdr, wingID: "10", squadID: 40 }, member), true);
  assert.equal(canSeeCompositionMember({ ...member, role: FLEET_ROLE.wingCmdr, wingID: 30 }, member), false);
  assert.equal(canSeeCompositionMember({ ...member, role: FLEET_ROLE.squadCmdr, squadID: 40 }, member), false);
  assert.equal(canSeeCompositionMember({ ...member, role: FLEET_ROLE.squadCmdr, squadID: "20" }, member), true);
});
