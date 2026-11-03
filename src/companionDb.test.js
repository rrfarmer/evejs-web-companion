"use strict";

// The companion's own database (src/companionDb.js): created where it belongs,
// migrated step by step, and never downgraded.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { DB_FILENAME, MIGRATIONS, migrate, openCompanionDb } = require("./companionDb");

test("the database file is created in the data dir, folder and all", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-db-"));
  const dataDir = path.join(root, "not-yet");
  const db = openCompanionDb({ dataDir });
  try {
    assert.ok(fs.existsSync(path.join(dataDir, DB_FILENAME)));
    assert.equal(db.pragma("user_version", { simple: true }), MIGRATIONS.length);
    assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
  } finally {
    db.close();
  }
  // Reopening an existing file runs nothing again and keeps what is there.
  const again = openCompanionDb({ dataDir });
  try {
    assert.equal(again.pragma("user_version", { simple: true }), MIGRATIONS.length);
  } finally {
    again.close();
  }
});

test("migrations run only the steps past user_version, in one transaction", () => {
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  const steps = ["CREATE TABLE a (x INTEGER)", "CREATE TABLE b (y INTEGER)"];
  assert.equal(migrate(db, steps.slice(0, 1)), 1);
  assert.equal(migrate(db, steps), 2);
  assert.equal(migrate(db, steps), 2);
  // A broken step leaves the version where it was.
  assert.throws(() => migrate(db, [...steps, "CREATE TABLE a (x INTEGER)"]));
  assert.equal(db.pragma("user_version", { simple: true }), 2);
  db.close();
});

test("a database newer than this build is refused, not downgraded", () => {
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  db.pragma(`user_version = ${MIGRATIONS.length + 1}`);
  assert.throws(() => migrate(db), { code: "COMPANION_DB_TOO_NEW" });
  db.close();
});
