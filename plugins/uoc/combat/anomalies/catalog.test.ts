import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { bundledCombatCatalog } from "./catalog.ts";
import { decodeCombatSites, isQualifiedAnomalyNpc } from "./discovery.ts";
const fixture = JSON.parse(
    fs.readFileSync(new URL("./natural2226Native.json", import.meta.url), "utf8"),
  ),
  dict = (entries: any[] = []) => ({ type: "dict", entries }),
  kv = (entries: any[]) => ({ type: "object", name: "util.KeyVal", args: dict(entries) });
test("natural 2226 supports the five-wave template fixture and disables GM 8589", () => {
  const all = bundledCombatCatalog(),
    p = all.find((x) => x.dungeonID === 2226);
  assert.ok(p?.enabled);
  assert.equal(p.entryRoomID, 0);
  assert.deepEqual(p.typeGroups, fixture.typeGroups);
  assert.equal(all.find((x) => x.dungeonID === 8589)?.enabled, false);
  for (const e of fixture.entries) {
    assert.equal(e.templateID, "client-dungeon:2226");
    assert.equal(e.siteFamily, "combat");
    assert.equal(e.siteKind, "anomaly");
    assert.equal(e.waves.length, 5);
    assert.deepEqual(e.completion, {
      objectiveMode: "destroy_all_encounters",
      completeObjectiveOnEncounterClear: true,
    });
  }
});
test("natural exact scanner row admits all native NPC types but no unrelated or GM source", () => {
  const all = bundledCombatCatalog(),
    e = fixture.entries[0],
    row = (did: number, instance = e.instanceID) =>
      kv([
        ["targetID", "TSR-201"],
        ["instanceID", instance],
        ["siteID", instance],
        ["dungeonID", did],
        ["archetypeID", 24],
        ["solarSystemID", e.systemID],
        ["position", [1, 2, 3]],
      ]),
    scan = (did: number) => [dict([[e.scannerKey, row(did)]]), dict(), dict(), dict()];
  const [site] = decodeCombatSites(scan(2226), e.systemID, 100, all);
  assert.ok(site);
  for (const id of [16981, 16996, 17006])
    assert.equal(
      isQualifiedAnomalyNpc(
        site,
        {
          kind: "ship",
          itemID: 4,
          typeID: id,
          groupID: 615,
          categoryID: 11,
          isNpc: true,
          isSelf: false,
          geometryAvailable: true,
        },
        all,
      ),
      true,
    );
  assert.equal(
    isQualifiedAnomalyNpc(
      site,
      {
        kind: "ship",
        itemID: 4,
        typeID: 16981,
        groupID: 616,
        categoryID: 11,
        isNpc: true,
        isSelf: false,
        geometryAvailable: true,
      },
      all,
    ),
    false,
  );
  for (const id of [8589, 5579, 2203])
    assert.deepEqual(decodeCombatSites(scan(id), e.systemID, 100, all), []);
});
