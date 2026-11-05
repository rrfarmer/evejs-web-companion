"use strict";

// Saved PI expansion plans, in the companion's own database
// (piDb.cjs, table pi_expansion_plans). Shaped after
// industryPlanStore.js on purpose: a plan is INTENT, kept on the server so it
// outlives one browser.
//
// What a plan holds: where to look (settings: home system, how far, how much
// null-sec to tolerate, which pilots) and the colonies the player accepted
// (rows: pilot, planet, resource, product), a note, active or done. Whether a
// row is built is re-derived from live colonies on every read, never stored.
//
// ⚠ VALIDATION HERE IS SHAPE AND RANGE ONLY. Whether a planet exists, is in
// range or offers the resource is the planner's question, answered in the
// browser; a row naming something unknown is still shown, never dropped.
//
// ⚠ SETTINGS ARE STORED CANONICAL: pilots sorted and deduplicated, only the
// known keys kept. Two saves of the same settings write the same text, and a
// hostile body cannot grow a row without limit. Rows keep the order given.
//
// Keying is global, as for the other plan stores: a single-operator
// deployment, so the account a plan was saved from is not a tenancy boundary.

const crypto = require("crypto");

const MAX_PLANS_TOTAL = 500;
const MAX_NOTE_LEN = 500;
const MAX_ROWS = 120;
const MAX_CHARACTERS = 50;
const MAX_JUMPS = 5;
const STATUSES = Object.freeze(["active", "done"]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function positiveInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function integerIn(value, min, max) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Where to look, checked and made canonical:
 *   { homeSystemID, maxJumps: 0..5, nullsecTolerance: 0..1, characterIDs: [id...] }
 */
function guardSettings(input) {
  if (!isPlainObject(input)) throw fail("PI_EXPANSION_INVALID", "A plan's settings are not readable.");
  if (!positiveInteger(input.homeSystemID)) throw fail("PI_EXPANSION_INVALID", "Choose a home system.");
  if (!integerIn(input.maxJumps, 0, MAX_JUMPS)) {
    throw fail("PI_EXPANSION_INVALID", `Jumps is a whole number from 0 to ${MAX_JUMPS}.`);
  }
  const tolerance = input.nullsecTolerance;
  if (typeof tolerance !== "number" || !Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1) {
    throw fail("PI_EXPANSION_INVALID", "Null-sec tolerance is a number from 0 to 1.");
  }
  const characterIDs = input.characterIDs;
  if (
    !Array.isArray(characterIDs) ||
    characterIDs.length > MAX_CHARACTERS ||
    !characterIDs.every(positiveInteger) ||
    new Set(characterIDs).size !== characterIDs.length
  ) {
    throw fail("PI_EXPANSION_INVALID", "Pilots are a list of different characters.");
  }
  return {
    homeSystemID: input.homeSystemID,
    maxJumps: input.maxJumps,
    nullsecTolerance: tolerance,
    characterIDs: [...characterIDs].sort((a, b) => a - b),
  };
}

/**
 * The accepted colonies, checked and kept in the order given:
 *   [{ characterID, planetID, resourceTypeID, productTypeID }]
 */
function guardRows(input) {
  if (!Array.isArray(input) || input.length > MAX_ROWS) {
    throw fail("PI_EXPANSION_INVALID", `A plan has a list of at most ${MAX_ROWS} colonies.`);
  }
  const seen = new Set();
  return input.map((row) => {
    if (
      !isPlainObject(row) ||
      !positiveInteger(row.characterID) ||
      !positiveInteger(row.planetID) ||
      !positiveInteger(row.resourceTypeID) ||
      !positiveInteger(row.productTypeID)
    ) {
      throw fail("PI_EXPANSION_INVALID", "A colony names a pilot, a planet, a resource and a product.");
    }
    const key = `${row.characterID}:${row.planetID}`;
    if (seen.has(key)) throw fail("PI_EXPANSION_INVALID", "A pilot can have one colony on a planet.");
    seen.add(key);
    return {
      characterID: row.characterID,
      planetID: row.planetID,
      resourceTypeID: row.resourceTypeID,
      productTypeID: row.productTypeID,
    };
  });
}

/** Stored text back to settings. A row damaged by hand reads as no settings. */
function parseSettings(text) {
  try {
    return guardSettings(JSON.parse(text));
  } catch {
    return { homeSystemID: null, maxJumps: 0, nullsecTolerance: 0, characterIDs: [] };
  }
}

/** Stored text back to rows. A row damaged by hand reads as no colonies. */
function parseRows(text) {
  try {
    return guardRows(JSON.parse(text));
  } catch {
    return [];
  }
}

function rowToPlan(row) {
  return {
    planID: row.id,
    settings: parseSettings(row.settings),
    rows: parseRows(row.rows),
    note: row.note,
    status: row.status,
    rev: row.rev,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Check the fields a create or update may carry. `partial` allows any subset
 * (an update); otherwise settings and rows are required.
 */
function guardFields(input, partial) {
  if (!isPlainObject(input)) {
    throw fail("PI_EXPANSION_INVALID", "That is not a plan.");
  }
  const out = {};
  if (input.settings !== undefined || !partial) {
    out.settings = JSON.stringify(guardSettings(input.settings));
  }
  if (input.rows !== undefined || !partial) {
    out.rows = JSON.stringify(guardRows(input.rows));
  }
  if (input.note !== undefined) {
    if (typeof input.note !== "string") throw fail("PI_EXPANSION_INVALID", "A note is text.");
    const note = input.note.trim();
    if (note.length > MAX_NOTE_LEN) {
      throw fail("PI_EXPANSION_INVALID", `A note is at most ${MAX_NOTE_LEN} characters.`);
    }
    out.note = note;
  }
  if (input.status !== undefined) {
    if (!STATUSES.includes(input.status)) throw fail("PI_EXPANSION_INVALID", "A plan is active or done.");
    out.status = input.status;
  }
  return out;
}

/**
 * `db` is a lazy handle ({ get() } from piDb.lazyPiDb) so that
 * building the store never opens the file.
 */
function createPiExpansionStore({ db, now = () => new Date().toISOString(), uuid = () => crypto.randomUUID() }) {
  const conn = () => db.get();

  function getRow(planID) {
    return conn().prepare("SELECT * FROM pi_expansion_plans WHERE id = ?").get(String(planID)) || null;
  }

  return {
    /** Every plan, active first, then most recently changed. */
    list() {
      return conn()
        .prepare("SELECT * FROM pi_expansion_plans ORDER BY status = 'done', updated_at DESC, id")
        .all()
        .map(rowToPlan);
    },

    /** One plan, or null. */
    get(planID) {
      const row = getRow(planID);
      return row ? rowToPlan(row) : null;
    },

    /** Save a new plan; returns it. */
    create(input) {
      const fields = guardFields(input, false);
      const database = conn();
      return database.transaction(() => {
        const total = database.prepare("SELECT COUNT(*) AS n FROM pi_expansion_plans").get().n;
        if (total >= MAX_PLANS_TOTAL) {
          throw fail("PI_EXPANSION_LIMIT_REACHED", "You have reached the limit of saved plans.");
        }
        const planID = uuid();
        const timestamp = now();
        database
          .prepare(
            `INSERT INTO pi_expansion_plans
               (id, settings, rows, note, status, rev, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(
            planID,
            fields.settings,
            fields.rows,
            fields.note ?? "",
            fields.status ?? "active",
            timestamp,
            timestamp,
          );
        return rowToPlan(getRow(planID));
      })();
    },

    /** Change some fields, if nobody changed the plan since `baseRev`. Returns it. */
    update(planID, input, baseRev) {
      const fields = guardFields(input, true);
      const database = conn();
      return database.transaction(() => {
        const row = getRow(planID);
        if (!row) throw fail("PI_EXPANSION_NOT_FOUND", "That plan could not be found.");
        if (Number(baseRev) !== row.rev) {
          throw fail("PI_EXPANSION_REV_CONFLICT", "This plan was changed somewhere else. Reopen it and try again.");
        }
        database
          .prepare(
            `UPDATE pi_expansion_plans
                SET settings = ?, rows = ?, note = ?, status = ?, rev = rev + 1, updated_at = ?
              WHERE id = ?`,
          )
          .run(
            fields.settings ?? row.settings,
            fields.rows ?? row.rows,
            fields.note ?? row.note,
            fields.status ?? row.status,
            now(),
            row.id,
          );
        return rowToPlan(getRow(row.id));
      })();
    },

    /** Delete for good; true when it existed. */
    remove(planID) {
      return conn().prepare("DELETE FROM pi_expansion_plans WHERE id = ?").run(String(planID)).changes > 0;
    },
  };
}

module.exports = {
  createPiExpansionStore,
  guardSettings,
  guardRows,
  MAX_PLANS_TOTAL,
  MAX_NOTE_LEN,
  MAX_ROWS,
};
