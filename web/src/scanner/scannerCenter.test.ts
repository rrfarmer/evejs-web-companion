import test from "node:test";
import assert from "node:assert/strict";

import type {
  ScanFieldValue,
  ScanFullState,
  ScanSite,
} from "../bridge/boundSmallServices.ts";
import {
  SCANNER_ACTION_IDS,
  buildScannerSitesView,
  scannerActionAvailability,
  scannerStateFromRead,
  type ScannerActionBindings,
} from "./scannerCenter.ts";

function scanSite(
  siteID: number | string,
  targetID: string | null,
  fields: Readonly<Record<string, ScanFieldValue>>,
): ScanSite {
  return { siteID, targetID, position: null, fields };
}

function fullState(overrides: Partial<ScanFullState> = {}): ScanFullState {
  return {
    anomalies: [],
    signatures: [],
    staticSites: [],
    structures: [],
    ...overrides,
  };
}

test("successful empty scanner state is distinct from loading and unavailable", () => {
  assert.equal(buildScannerSitesView({ status: "loading" }).status, "loading");

  const unavailable = buildScannerSitesView({
    status: "unavailable",
    reason: "The live scan read failed.",
  });
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.status === "unavailable" ? unavailable.message : "", "The live scan read failed.");

  const empty = buildScannerSitesView({ status: "ready", value: fullState() });
  assert.equal(empty.status, "empty");
  assert.equal(empty.totalSites, 0);
  assert.equal(empty.groups.length, 4, "a successful read knows that all four slots are empty");
});

test("a read that failed becomes unavailable, while a successful empty one stays ready", () => {
  // Whatever the failure said is for a console: the panel's sentence is its own.
  assert.deepEqual(scannerStateFromRead(null), {
    status: "unavailable",
    reason: "Scanner data could not be read from the live session.",
  });

  const empty: ScanFullState = fullState();
  assert.deepEqual(scannerStateFromRead(empty), { status: "ready", value: empty });
});

// The Group column is what tells a player the bot and the panel are reading the
// same thing: an ore-site row here is a row `warp-to-ore-anomaly` will fly to,
// and an "Unknown site" row is one it will deliberately skip.
test("anomaly rows carry the client's Group column, unreadable ones included", () => {
  const view = buildScannerSitesView({
    status: "ready",
    value: fullState({
      anomalies: [
        scanSite(1, "AAA-111", { scanStrengthAttribute: 211 }),
        scanSite(2, "BBB-222", { scanStrengthAttribute: 1136 }),
        // No attribute at all: the case both bot blocks refuse to guess at, so
        // the panel says so rather than leaving the cell blank.
        scanSite(3, "CCC-333", { scanStrengthAttribute: null }),
        // Attribute gone, archetype still there -> the row is rescued.
        scanSite(4, "DDD-444", { scanStrengthAttribute: null, archetypeID: 27 }),
      ],
      // A signature row never carries a scan-strength attribute, so it reports
      // no group rather than being labelled Unknown.
      signatures: [scanSite(5, "EEE-555", { difficulty: 3 })],
    }),
  });
  assert.equal(view.status, "ready");
  if (view.status !== "ready") {
    return;
  }
  const groups = view.groups.find((group) => group.kind === "anomaly")?.sites.map((site) => site.groupLabel);
  assert.deepEqual(groups, ["Ore site", "Combat site", "Unknown site", "Ore site"]);
  assert.equal(view.groups.find((group) => group.kind === "signature")?.sites[0]?.groupLabel, null);
});

test("site rows use supplied dungeon/type names and never promote numeric ids to labels", () => {
  const view = buildScannerSitesView(
    {
      status: "ready",
      value: fullState({
        anomalies: [
          scanSite(5380000140001, "FTW-038", {
            dungeonNameID: 110922,
            entryObjectTypeID: 28356,
            difficulty: 2,
          }),
        ],
        signatures: [
          scanSite("9223372036854775001", "ABC-123", {
            difficulty: 4,
            deviation: 1500,
          }),
        ],
        structures: [
          scanSite(1030000000001, "QEE-288", {
            typeID: 35832,
            groupID: 1657,
            categoryID: 65,
          }),
        ],
      }),
    },
    {
      dungeonNames: { 110922: "Guristas Hideaway" },
      typeNames: {
        28356: "Cosmic acceleration gate",
        35832: "Astrahus",
      },
    },
  );
  assert.equal(view.status, "ready");
  if (view.status !== "ready") {
    return;
  }

  const anomaly = view.groups.find((group) => group.kind === "anomaly")?.sites[0];
  const signature = view.groups.find((group) => group.kind === "signature")?.sites[0];
  const structure = view.groups.find((group) => group.kind === "structure")?.sites[0];
  assert.equal(anomaly?.name, "Guristas Hideaway");
  assert.equal(anomaly?.typeName, "Cosmic acceleration gate");
  assert.equal(signature?.name, "Unidentified cosmic signature");
  assert.equal(signature?.signalLabel, "ABC-123");
  assert.equal(signature?.deviationMeters, 1500);
  assert.equal(structure?.name, "Astrahus");

  for (const row of [anomaly, signature, structure]) {
    assert.ok(row);
    assert.doesNotMatch(row!.name, /110922|28356|35832|9223372036854775001/);
  }
});

test("only the supported high-value probe action set is exposed", () => {
  assert.deepEqual(SCANNER_ACTION_IDS, ["launch", "recover", "analyze", "reconnect"]);
  for (const forbidden of ["destroy", "set-destination", "set-range", "set-activity", "cone-scan"]) {
    assert.equal((SCANNER_ACTION_IDS as readonly string[]).includes(forbidden), false);
  }
});

test("action policy refuses missing prerequisites instead of fabricating probe state", () => {
  const missing = {
    launch: scannerActionAvailability("launch"),
    recover: scannerActionAvailability("recover"),
    analyze: scannerActionAvailability("analyze"),
    reconnect: scannerActionAvailability("reconnect"),
  };
  assert.equal(missing.launch.enabled, false);
  assert.equal(missing.recover.enabled, false);
  assert.equal(missing.analyze.enabled, false);
  assert.equal(missing.reconnect.enabled, false);
  assert.match(missing.recover.detail, /probe IDs are not available/i);
  assert.match(missing.analyze.detail, /will not invent a scan map/i);

  const empty: ScannerActionBindings = {
    launch: { moduleID: 0, count: 8, run: () => {} },
    recover: { probeIDs: [], run: () => {} },
    analyze: { probeMap: {}, run: () => {} },
  };
  assert.equal(scannerActionAvailability("launch", empty).enabled, false);
  assert.equal(scannerActionAvailability("recover", empty).enabled, false);
  assert.equal(scannerActionAvailability("analyze", empty).enabled, false);
});

test("valid bindings enable actions and only launch carries consumptive confirmation", () => {
  const actions: ScannerActionBindings = {
    launch: {
      moduleID: 7400000030,
      count: 8,
      launcherName: "Sisters Core Probe Launcher",
      run: () => {},
    },
    recover: { probeIDs: [70000001, 70000001, 70000002], run: () => {} },
    analyze: { probeMap: { "70000001": { rangeStep: 2 } }, run: () => {} },
    reconnect: { run: () => {} },
  };
  for (const id of SCANNER_ACTION_IDS) {
    assert.equal(scannerActionAvailability(id, actions).enabled, true, `${id} should be enabled`);
  }
  const launch = scannerActionAvailability("launch", actions);
  assert.match(launch.confirmation?.message ?? "", /moves probe charges out of the ship/i);
  assert.equal(scannerActionAvailability("recover", actions).confirmation, null);
  assert.equal(scannerActionAvailability("analyze", actions).confirmation, null);
  assert.equal(scannerActionAvailability("reconnect", actions).confirmation, null);
});

