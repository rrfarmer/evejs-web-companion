"use strict";

// Saved Planetary Industry plans, in the companion's own database
// (piDb.cjs, table pi_plans). A plan is INTENT: a commodity, how many,
// a note, and whether it is still wanted. The planner works everything else out
// from live stock each time it is shown, and future automation reads the same
// rows -- which is why they live on the server and not in one browser.
//
// ⚠ VALIDATION HERE IS SHAPE AND RANGE ONLY. Whether a typeID is a commodity a
// factory can make is the recipe table's question, and the browser answers it
// on read; a plan naming something unknown is still shown, never dropped.
//
// Keying is global, as for the bot library: this is a single-operator
// deployment, so the account a plan was saved from is not a tenancy boundary.

const crypto = require("crypto");

const MAX_PLANS_TOTAL = 500;
const MAX_NOTE_LEN = 500;
const STATUSES = Object.freeze(["active", "done"]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function positiveInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function rowToPlan(row) {
  return {
    planID: row.id,
    typeID: row.type_id,
    quantity: row.quantity,
    note: row.note,
    status: row.status,
    rev: row.rev,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Check the fields a create or update may carry. `partial` allows any subset
 * (an update); otherwise typeID and quantity are required.
 */
function guardFields(input, partial) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw fail("PI_PLAN_INVALID", "That is not a plan.");
  }
  const out = {};
  if (input.typeID !== undefined || !partial) {
    if (!positiveInteger(input.typeID)) throw fail("PI_PLAN_INVALID", "Choose something to make.");
    out.typeID = input.typeID;
  }
  if (input.quantity !== undefined || !partial) {
    if (!positiveInteger(input.quantity)) throw fail("PI_PLAN_INVALID", "Enter how many, as a whole number.");
    out.quantity = input.quantity;
  }
  if (input.note !== undefined) {
    if (typeof input.note !== "string") throw fail("PI_PLAN_INVALID", "A note is text.");
    const note = input.note.trim();
    if (note.length > MAX_NOTE_LEN) {
      throw fail("PI_PLAN_INVALID", `A note is at most ${MAX_NOTE_LEN} characters.`);
    }
    out.note = note;
  }
  if (input.status !== undefined) {
    if (!STATUSES.includes(input.status)) throw fail("PI_PLAN_INVALID", "A plan is active or done.");
    out.status = input.status;
  }
  return out;
}

/**
 * `db` is a lazy handle ({ get() } from piDb.lazyPiDb) so that
 * building the store never opens the file.
 */
function createPiPlanStore({ db, now = () => new Date().toISOString(), uuid = () => crypto.randomUUID() }) {
  const conn = () => db.get();

  function getRow(planID) {
    return conn().prepare("SELECT * FROM pi_plans WHERE id = ?").get(String(planID)) || null;
  }

  return {
    /** Every plan, active first, then most recently changed. */
    list() {
      return conn()
        .prepare("SELECT * FROM pi_plans ORDER BY status = 'done', updated_at DESC, id")
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
        const total = database.prepare("SELECT COUNT(*) AS n FROM pi_plans").get().n;
        if (total >= MAX_PLANS_TOTAL) {
          throw fail("PI_PLAN_LIMIT_REACHED", "You have reached the limit of saved plans.");
        }
        const planID = uuid();
        const timestamp = now();
        database
          .prepare(
            `INSERT INTO pi_plans (id, type_id, quantity, note, status, rev, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(planID, fields.typeID, fields.quantity, fields.note ?? "", fields.status ?? "active", timestamp, timestamp);
        return rowToPlan(getRow(planID));
      })();
    },

    /** Change some fields, if nobody changed the plan since `baseRev`. Returns it. */
    update(planID, input, baseRev) {
      const fields = guardFields(input, true);
      const database = conn();
      return database.transaction(() => {
        const row = getRow(planID);
        if (!row) throw fail("PI_PLAN_NOT_FOUND", "That plan could not be found.");
        if (Number(baseRev) !== row.rev) {
          throw fail("PI_PLAN_REV_CONFLICT", "This plan was changed somewhere else. Reopen it and try again.");
        }
        database
          .prepare(
            `UPDATE pi_plans
                SET type_id = ?, quantity = ?, note = ?, status = ?, rev = rev + 1, updated_at = ?
              WHERE id = ?`,
          )
          .run(
            fields.typeID ?? row.type_id,
            fields.quantity ?? row.quantity,
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
      return conn().prepare("DELETE FROM pi_plans WHERE id = ?").run(String(planID)).changes > 0;
    },
  };
}

module.exports = { createPiPlanStore, MAX_PLANS_TOTAL, MAX_NOTE_LEN };
