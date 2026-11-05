"use strict";

// The PI Manager's OWN database: pi-manager.sqlite in the plugin's data
// directory (data/plugins/pi-manager), the only place its backend may write.
// Its plans lived in the companion's database before PI was a plugin; the BFF
// hands those rows over once (src/pluginHost.js, adopt), and the plugin keeps
// them from then on.
//
// ⚠ OPENED ON FIRST USE, NOT AT BOOT, so a backend that is never asked for a
// plan never creates the file.
//
// MIGRATIONS are an append-only list. `PRAGMA user_version` records how many
// have run; on open, every step past it runs in one transaction, so a crash
// mid-upgrade leaves the file at the old version rather than half-migrated.
// Never edit or reorder a shipped step -- add a new one.

const fs = require("fs");
const path = require("path");

const DB_FILENAME = "pi-manager.sqlite";

const MIGRATIONS = Object.freeze([
  // 1 -- saved PI plans: intent only, what to make and how many.
  `CREATE TABLE pi_plans (
     id         TEXT PRIMARY KEY,
     type_id    INTEGER NOT NULL CHECK (type_id > 0),
     quantity   INTEGER NOT NULL CHECK (quantity > 0),
     note       TEXT NOT NULL DEFAULT '',
     status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done')),
     rev        INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  // 2 -- saved PI expansion plans: where to look, and the colonies accepted.
  `CREATE TABLE pi_expansion_plans (
     id         TEXT PRIMARY KEY,
     settings   TEXT NOT NULL DEFAULT '{}',
     rows       TEXT NOT NULL DEFAULT '[]',
     note       TEXT NOT NULL DEFAULT '',
     status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','done')),
     rev        INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  // 3 -- that the companion's rows were taken over, in the same database as the
  // rows themselves, so a second handover cannot bring back a plan deleted since.
  `CREATE TABLE pi_handover (
     id       INTEGER PRIMARY KEY CHECK (id = 1),
     taken_at TEXT NOT NULL
   )`,
]);

/** Bring an open database up to the latest schema. Returns the version reached. */
function migrate(db, migrations = MIGRATIONS) {
  const current = db.pragma("user_version", { simple: true });
  if (current > migrations.length) {
    const error = new Error(
      `${DB_FILENAME} is at schema ${current}, newer than this build knows (${migrations.length}).`,
    );
    error.code = "PI_DB_TOO_NEW";
    throw error;
  }
  if (current === migrations.length) return current;
  db.transaction(() => {
    for (let step = current; step < migrations.length; step += 1) {
      db.exec(migrations[step]);
    }
    db.pragma(`user_version = ${migrations.length}`);
  })();
  return migrations.length;
}

/**
 * Open (creating when missing) and migrate. `filename` may be ":memory:" for
 * tests; otherwise the file is `dataDir/pi-manager.sqlite`.
 */
function openPiDb({ dataDir, filename } = {}) {
  // Required here, not at the top: a checkout without the native module can
  // still boot every route that never touches the database.
  const Database = require("better-sqlite3");
  let target = filename;
  if (!target) {
    fs.mkdirSync(dataDir, { recursive: true });
    target = path.join(dataDir, DB_FILENAME);
  }
  const db = new Database(target);
  if (target !== ":memory:") db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

/** A handle that opens the database on its first `get()`, then reuses it. */
function lazyPiDb(options) {
  let db = null;
  return {
    get() {
      if (db === null) db = openPiDb(options);
      return db;
    },
    close() {
      if (db !== null) db.close();
      db = null;
    },
  };
}

module.exports = { DB_FILENAME, MIGRATIONS, migrate, openPiDb, lazyPiDb };
