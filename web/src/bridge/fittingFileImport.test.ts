import assert from "node:assert/strict";
import test from "node:test";
import { reserveImportedFittingName, resolveFittingFileProfile, type FittingFileType } from "./fittingFileImport.ts";

test("fitting XML profiles retain the last item at each type and flag and report dropped hardware", () => {
  const types = new Map<string, FittingFileType>([
    ["Merlin", { hullID: 603, typeID: 603, fittable: false, obsolete: false }],
    ["Railgun", { hullID: null, typeID: 10678, fittable: true, obsolete: false }],
    ["Charges", { hullID: null, typeID: 222, fittable: false, obsolete: false }],
    ["Old equipment", { hullID: null, typeID: 507, fittable: true, obsolete: true }],
  ]);
  const profile = { name: "Import check", description: "UTF-8 & α", hull: "Merlin", hardware: [
    { type: "Railgun", slot: "hi slot 0", qty: null },
    { type: "Charges", slot: "cargo", qty: "27" },
    { type: "Charges", slot: "cargo", qty: "42" },
    { type: "Old equipment", slot: "cargo", qty: null },
    { type: "Railgun", slot: "invalid flag", qty: null },
    { type: "Unknown equipment", slot: "lo slot 0", qty: null },
  ] };
  const entry = resolveFittingFileProfile(profile, types);
  assert.equal(entry.shipTypeID, 603);
  assert.equal(entry.description, profile.description);
  assert.deepEqual(entry.fitData, [[10678, 27, 1], [222, 5, 42]]);
  assert.deepEqual(entry.invalidSlots, ["Railgun"]);
  assert.deepEqual(entry.unknownTypes, ["Unknown equipment"]);
  assert.deepEqual(entry.obsoleteModules, ["Old equipment"]);
  assert.deepEqual(resolveFittingFileProfile({ ...profile, hull: "Unknown hull" }, types).unknownTypes, ["Unknown hull"]);
});

test("selected profiles reserve fitting names case-insensitively across the batch", () => {
  const used = new Set(["imported", "imported_0"]);
  assert.equal(reserveImportedFittingName("IMPORTED", used), "IMPORTED_1");
  assert.equal(reserveImportedFittingName(" Imported ", used), "Imported_2");
  const longName = "X".repeat(50);
  assert.equal(reserveImportedFittingName(longName, used), longName);
  assert.equal(reserveImportedFittingName(longName, used), "X".repeat(48) + "_0");
});
