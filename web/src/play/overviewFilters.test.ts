import assert from "node:assert/strict";
import test from "node:test";
import type { CorpWar } from "../bridge/corpWars.ts";
import { gridBracketWanted, overviewRowWanted, type OverviewRelationships, type PresetMask } from "./overviewFilters.ts";

const ship = {
  isSelf: false, name: "Merlin", typeID: 603, groupID: 25, categoryID: 6, ownerID: 140_000_002,
  characterID: 140_000_002, corporationID: 98_000_002, allianceID: 99_000_002, warFactionID: 500001,
};
const station = { ...ship, groupID: 15, categoryID: 3, typeID: 1529, name: "Station" };
const targets: PresetMask = {
  groups: new Set([25, 517]), filteredStates: [11, 12, 14, 15, 16, 21, 45, 49], alwaysShownStates: [],
};
const warpTo: PresetMask = { groups: new Set([10, 15]), filteredStates: [], alwaysShownStates: [] };
const pilot: OverviewRelationships = {
  corporationID: 98_000_001, allianceID: 99_000_001, warFactionID: null, fleetMembers: new Set(),
  contacts: { personal: new Map(), corporate: new Map(), alliance: new Map() }, wars: [], now: 100n,
};
const normal = {
  override: "default" as const, selectedOrTargeted: false, showSpecials: false, hasBracketData: true,
};

test("an active tab's bracket mask can differ from its overview mask or show all", () => {
  assert.equal(overviewRowWanted(ship, ship.groupID, targets), true);
  assert.equal(gridBracketWanted(ship, ship.groupID, warpTo, targets, normal), false);
  assert.equal(overviewRowWanted(station, station.groupID, targets), false);
  assert.equal(gridBracketWanted(station, station.groupID, warpTo, targets, normal), true);
  assert.equal(gridBracketWanted(station, station.groupID, null, targets, normal), true);
});

test("a selected or targeted bracket survives preset filtering and the hide-all override", () => {
  assert.equal(gridBracketWanted(ship, ship.groupID, warpTo, targets, { ...normal, selectedOrTargeted: true }), true);
  assert.equal(gridBracketWanted(ship, ship.groupID, warpTo, targets, {
    ...normal, override: "none", selectedOrTargeted: true,
  }), true);
  assert.equal(gridBracketWanted(ship, ship.groupID, warpTo, targets, { ...normal, override: "none" }), false);
  assert.equal(gridBracketWanted(ship, ship.groupID, warpTo, targets, { ...normal, override: "all" }), true);
  assert.equal(gridBracketWanted(ship, ship.groupID, warpTo, targets, { ...normal, hasBracketData: false, selectedOrTargeted: true }), false);
});

test("special brackets and harvestable clouds obey their independent native visibility rules", () => {
  assert.equal(gridBracketWanted(station, 8, null, null, { ...normal, override: "all" }), false);
  assert.equal(gridBracketWanted(station, 8, null, null, { ...normal, override: "none", showSpecials: true }), true);
  assert.equal(gridBracketWanted(station, 711, null, null, { ...normal, showSpecials: true }), false);
  assert.equal(gridBracketWanted(station, 711, null, null, { ...normal, selectedOrTargeted: true }), true);
  const chunk = { ...station, typeID: 46031 };
  assert.equal(overviewRowWanted(chunk, 15, warpTo), false);
  assert.equal(gridBracketWanted({ ...station, typeID: 41235 }, 15, warpTo, targets, normal), false);
});

test("Targets excludes the eight installed states from the rows and brackets", () => {
  assert.equal(overviewRowWanted(ship, ship.groupID, targets, pilot), true);
  for (const relationships of [
    { fleetMembers: new Set([ship.characterID]) },
    { corporationID: ship.corporationID },
    { allianceID: ship.allianceID },
    { warFactionID: ship.warFactionID },
    { contacts: { ...pilot.contacts!, corporate: new Map([[ship.allianceID, 10]]) } },
    { contacts: { ...pilot.contacts!, personal: new Map([[ship.ownerID, 5]]) } },
  ]) {
    const context = { ...pilot, ...relationships };
    assert.equal(overviewRowWanted(ship, ship.groupID, targets, context), false, JSON.stringify(Object.keys(relationships)));
    assert.equal(gridBracketWanted(ship, ship.groupID, targets, targets, normal, context), false);
  }
  const agent = { ...ship, groupID: 517, categoryID: 11, ownerID: 3_000_001 };
  assert.equal(overviewRowWanted(agent, agent.groupID, targets, pilot), false);
  const drone = { ...ship, groupID: 100, categoryID: 18, characterID: null };
  const droneMask = { ...targets, groups: new Set([100]) };
  assert.equal(overviewRowWanted(drone, 100, droneMask, { ...pilot, fleetMembers: new Set([drone.ownerID]) }), false);
});

test("always-shown states take precedence without overriding the allowed groups", () => {
  const context = { ...pilot, fleetMembers: new Set([ship.characterID]) };
  const showFleet = { ...targets, alwaysShownStates: [11] };
  assert.equal(overviewRowWanted(ship, ship.groupID, showFleet, context), true);
  assert.equal(overviewRowWanted(ship, ship.groupID, { ...showFleet, groups: new Set() }, context), false);
  assert.equal(gridBracketWanted(ship, ship.groupID, targets, showFleet, normal, context), true);
});

test("a war ally is filtered unless the native current-war test has precedence", () => {
  const allied: CorpWar = {
    warID: 1, declaredByID: 98_000_006, againstID: pilot.allianceID!, timeDeclared: 2n, timeStarted: 60n,
    timeFinished: null, retracted: null, mutual: false, openForAllies: true,
    allyIDs: [ship.allianceID], allies: [{ allyID: ship.allianceID, timeStarted: 80n, timeFinished: 200n }], noOfAllies: null,
  };
  const opposing = { ...allied, warID: 2, declaredByID: ship.allianceID, allyIDs: [], allies: [] };
  assert.equal(overviewRowWanted(ship, ship.groupID, targets, { ...pilot, wars: [allied] }), false);
  assert.equal(overviewRowWanted(ship, ship.groupID, targets, { ...pilot, wars: [allied, opposing] }), true);
});
