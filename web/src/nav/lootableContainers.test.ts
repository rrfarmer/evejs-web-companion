import test from "node:test";
import assert from "node:assert/strict";

import type { SpaceEntity, SpaceSnapshot } from "../store/types.ts";
import { isLootableContainer, lootableContainersOnGrid, type LootWho } from "./lootableContainers.ts";

const ME = 90000001;
const MY_CORP = 98999911;
const OTHER_CORP = 98000002;
const MATE = 90000002;
const STRANGER = 90000003;
const NPC_CORP = 1000125;

const who: LootWho = { characterID: ME, corporationID: MY_CORP };

function can(over: Record<string, unknown> = {}): SpaceEntity {
  return {
    kind: "container", itemID: 5000, typeID: 23, groupID: 12, categoryID: 2, name: "Cargo Container",
    ownerID: null, radius: 10, position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
    isSelf: false, shieldRatio: null, armorRatio: null, hullRatio: null, characterID: null,
    corporationID: null, allianceID: null, securityStatus: null, maxVelocity: null, mode: null,
    capacitorRatio: null, remainingQuantity: null, miningYieldTypeID: null, beltID: null, oreGrade: null,
    ...over,
  } as unknown as SpaceEntity;
}

test("own can is lootable", () => assert.equal(isLootableContainer(can({ ownerID: ME }), who), true));
test("another player's jetcan is theft", () => assert.equal(isLootableContainer(can({ ownerID: STRANGER }), who), false));
test("unknown owner fails closed", () => assert.equal(isLootableContainer(can({ ownerID: null }), who), false));
test("ownerless zero decodes to null and stays closed", () => assert.equal(isLootableContainer(can({ ownerID: null, corporationID: null }), who), false));
test("NPC-owned debris is free", () => {
  assert.equal(isLootableContainer(can({ ownerID: NPC_CORP }), who), true);
  assert.equal(isLootableContainer(can({ ownerID: 3009841 }), who), true);
});
test("a corp-mate's can is lootable through the corporation", () => {
  assert.equal(isLootableContainer(can({ ownerID: MATE, corporationID: MY_CORP }), who), true);
});
test("a stranger's corporation does not grant", () => {
  assert.equal(isLootableContainer(can({ ownerID: MATE, corporationID: OTHER_CORP }), who), false);
});
test("lootRightCorpID wins over corporationID", () => {
  assert.equal(isLootableContainer(can({ ownerID: MATE, corporationID: OTHER_CORP, lootRightCorpID: MY_CORP }), who), true);
  assert.equal(isLootableContainer(can({ ownerID: MATE, corporationID: MY_CORP, lootRightCorpID: OTHER_CORP }), who), false);
});
test("an NPC corporation grants no corporation right", () => {
  const npcWho: LootWho = { characterID: ME, corporationID: NPC_CORP };
  assert.equal(isLootableContainer(can({ ownerID: MATE, corporationID: NPC_CORP }), npcWho), false);
});
test("no corporation of mine: a corporationID match cannot apply", () => {
  assert.equal(isLootableContainer(can({ ownerID: MATE, corporationID: MY_CORP }), { characterID: ME, corporationID: null }), false);
});
test("a container owned by my own player corporation is lootable", () => {
  assert.equal(isLootableContainer(can({ ownerID: MY_CORP }), who), true);
});
test("a container owned by another player corporation is not", () => {
  assert.equal(isLootableContainer(can({ ownerID: OTHER_CORP }), who), false);
});
test("abandoned is free for anyone, even with an unknown owner", () => {
  assert.equal(isLootableContainer(can({ ownerID: STRANGER, lootAbandoned: true }), who), true);
  assert.equal(isLootableContainer(can({ ownerID: null, lootAbandoned: true }), who), true);
});
test("corporation property: only that corporation", () => {
  const prop = { ownerID: OTHER_CORP, protectedPropertyCorporationID: OTHER_CORP, protectedPropertyCorporationMarkerPresent: true };
  assert.equal(isLootableContainer(can(prop), who), false);
  assert.equal(isLootableContainer(can({ ...prop, ownerID: MY_CORP, protectedPropertyCorporationID: MY_CORP }), who), true);
});
test("a marker with no usable corporation id fails closed", () => {
  assert.equal(isLootableContainer(can({ ownerID: ME, protectedPropertyCorporationMarkerPresent: true }), who), false);
});
test("abandonment beats a corporation-property marker", () => {
  assert.equal(isLootableContainer(can({ ownerID: OTHER_CORP, protectedPropertyCorporationID: OTHER_CORP, lootAbandoned: true }), who), true);
});
test("fleet member's can is lootable only when the fleet is known", () => {
  assert.equal(isLootableContainer(can({ ownerID: MATE, corporationID: OTHER_CORP }), { ...who, fleetMemberIDs: [MATE] }), true);
  assert.equal(isLootableContainer(can({ ownerID: MATE, corporationID: OTHER_CORP }), { ...who, fleetMemberIDs: [STRANGER] }), false);
  assert.equal(isLootableContainer(can({ ownerID: MATE, corporationID: OTHER_CORP }), { ...who, fleetMemberIDs: [] }), false);
});
test("alliance grants nothing", () => {
  assert.equal(isLootableContainer(can({ ownerID: STRANGER, allianceID: 99000001 }), { ...who, allianceID: 99000001 }), false);
});
test("only containers count", () => {
  assert.equal(isLootableContainer(can({ kind: "wreck", ownerID: ME }), who), false);
  assert.equal(isLootableContainer(can({ kind: null, ownerID: ME }), who), false);
});
test("no character id: only non-player or corp rules can apply", () => {
  const anon: LootWho = { characterID: null, corporationID: MY_CORP };
  assert.equal(isLootableContainer(can({ ownerID: null }), anon), false);
  assert.equal(isLootableContainer(can({ ownerID: NPC_CORP }), anon), true);
});

function snap(entities: SpaceEntity[]): SpaceSnapshot {
  return { inSpace: true, solarSystemID: 30000001, shipID: 1, sampledAtMs: 0, entities, ship: null };
}

test("lootableContainersOnGrid filters, keeps order, honours set-aside (set and predicate)", () => {
  const s = snap([
    can({ itemID: 1, ownerID: ME }),
    can({ itemID: 2, ownerID: STRANGER }),
    can({ itemID: 3, ownerID: NPC_CORP }),
    can({ itemID: 4, ownerID: MATE, corporationID: MY_CORP }),
    can({ itemID: 5, kind: "wreck", ownerID: ME }),
    can({ itemID: 6, ownerID: ME, isSelf: true }),
  ]);
  assert.deepEqual(lootableContainersOnGrid(s, who).map((e) => e.itemID), [1, 3, 4]);
  assert.deepEqual(lootableContainersOnGrid(s, who, new Set([3])).map((e) => e.itemID), [1, 4]);
  assert.deepEqual(lootableContainersOnGrid(s, who, (id) => id === 1).map((e) => e.itemID), [3, 4]);
});

test("lootableContainersOnGrid tolerates a null snapshot", () => {
  assert.deepEqual(lootableContainersOnGrid(null, who), []);
  assert.deepEqual(lootableContainersOnGrid(undefined, who, new Set()), []);
});

test("a site's own container, owned by the system (owner 1), is free to take, as the server's loot right has it", () => {
  const siteCan = { kind: "container", itemID: 5100, ownerID: 1, corporationID: null, characterID: null } as unknown as SpaceEntity;
  assert.equal(isLootableContainer(siteCan, { characterID: 90000001, corporationID: 98999901 }), true);
  // A player's jetcan is still not.
  const jetcan = { kind: "container", itemID: 5101, ownerID: 90000777, corporationID: 98999977, characterID: 90000777 } as unknown as SpaceEntity;
  assert.equal(isLootableContainer(jetcan, { characterID: 90000001, corporationID: 98999901 }), false);
});
