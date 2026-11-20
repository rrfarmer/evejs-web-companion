"use strict";

// Scanner site names read from the server's own anomaly packs (issue 182), for
// an install with no client to word them. The packs here are invented, in the
// shape the server's content packs have (payload.dungeon.templatesByID).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createServerSiteNames } = require("../src/serverSiteNames");

function pack(templates) {
  return JSON.stringify({ schema: 1, manifest: {}, payload: { dungeon: { templatesByID: templates } } });
}

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "site-names-"));
  fs.mkdirSync(path.join(root, "content-packs"));
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, "content-packs", name), text);
  }
  return root;
}

test("a name message is answered with the name its anomaly pack gives it", async () => {
  const root = tree({
    "evejs-combat-anomalies-1.0.0.json": pack({
      "client-dungeon:1": { siteKind: "anomaly", dungeonNameID: 9001, resolvedName: "Angel Den" },
      "client-dungeon:2": { siteKind: "anomaly", dungeonNameID: 9002, resolvedName: " Angel Hidden Den " },
      "eve-university:x": { siteKind: "anomaly", resolvedName: "No Message Here" },
    }),
    "evejs-drone-anomalies-1.0.0.json": pack({ "client-dungeon:3": { dungeonNameID: 9003, resolvedName: "Drone Patrol" } }),
  });
  const names = createServerSiteNames({ eveRoot: root });
  assert.equal(await names.available(), true);
  assert.deepEqual(await names.names([9001, 9002, 9003, 9999]), {
    9001: "Angel Den",
    9002: "Angel Hidden Den",
    9003: "Drone Patrol",
    9999: null,
  });
});

test("only the anomaly packs are read: a mission pack's names are not a scanner site's", async () => {
  const root = tree({
    "evejs-security-missions-level-1-1.0.0.json": pack({ "m:1": { dungeonNameID: 7001, resolvedName: "A Mission Pocket" } }),
  });
  const names = createServerSiteNames({ eveRoot: root });
  assert.equal(await names.available(), false);
  assert.deepEqual(await names.names([7001]), { 7001: null });
});

test("a pack that cannot be read is reported and the others still answer", async () => {
  const root = tree({
    "evejs-combat-anomalies-1.0.0.json": "{ not json",
    "evejs-ore-anomalies-1.0.0.json": pack({ "client-dungeon:4": { dungeonNameID: 9004, resolvedName: "Average Kernite Deposit" } }),
  });
  const errors = [];
  const names = createServerSiteNames({ eveRoot: root, onError: (_error, file) => errors.push(file) });
  assert.deepEqual(await names.names([9004]), { 9004: "Average Kernite Deposit" });
  assert.deepEqual(errors, ["evejs-combat-anomalies-1.0.0.json"]);
});

test("no server tree, or no packs folder, is no names rather than an error", async () => {
  assert.equal(await createServerSiteNames({ eveRoot: null }).available(), false);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "site-names-"));
  assert.deepEqual(await createServerSiteNames({ eveRoot: empty }).names([1]), { 1: null });
});

test("a pack replaced on disk is read again, once the recheck time has passed", async () => {
  const root = tree({ "evejs-combat-anomalies-1.0.0.json": pack({ a: { dungeonNameID: 9001, resolvedName: "Angel Den" } }) });
  let clock = 0;
  const names = createServerSiteNames({ eveRoot: root, now: () => clock });
  assert.deepEqual(await names.names([9005]), { 9005: null });
  fs.writeFileSync(
    path.join(root, "content-packs", "evejs-combat-anomalies-1.0.0.json"),
    pack({ a: { dungeonNameID: 9001, resolvedName: "Angel Den" }, b: { dungeonNameID: 9005, resolvedName: "Angel Haven" } }),
  );
  assert.deepEqual(await names.names([9005]), { 9005: null }, "not looked at again inside the recheck time");
  clock += 60_000;
  assert.deepEqual(await names.names([9005]), { 9005: "Angel Haven" });
});

test("a pack that failed to read is tried again at the next look, not left out until it changes", async () => {
  const root = tree({ "evejs-combat-anomalies-1.0.0.json": "{ half written" });
  let clock = 0;
  const errors = [];
  const names = createServerSiteNames({ eveRoot: root, now: () => clock, onError: (_error, file) => errors.push(file) });
  assert.deepEqual(await names.names([9001]), { 9001: null });
  // The server finishes writing it; the size and time are the same as a reader might have seen.
  fs.writeFileSync(path.join(root, "content-packs", "evejs-combat-anomalies-1.0.0.json"), pack({ a: { dungeonNameID: 9001, resolvedName: "Angel Den" } }));
  clock += 60_000;
  assert.deepEqual(await names.names([9001]), { 9001: "Angel Den" });
  assert.deepEqual(errors, ["evejs-combat-anomalies-1.0.0.json"]);
});

test("asks that arrive together share one load", async () => {
  const root = tree({ "evejs-combat-anomalies-1.0.0.json": pack({ a: { dungeonNameID: 9001, resolvedName: "Angel Den" } }) });
  const names = createServerSiteNames({ eveRoot: root });
  const [first, second] = await Promise.all([names.names([9001]), names.names([9001])]);
  assert.deepEqual(first, { 9001: "Angel Den" });
  assert.deepEqual(second, { 9001: "Angel Den" });
});
