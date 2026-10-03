"use strict";

// Saved Industry Manager plans (R109 slice 3), in the companion's own database
// (src/companionDb.js, table industry_plans). Shaped after piPlanStore.js on
// purpose: a plan is INTENT, kept on the server so it outlives one browser.
//
// What a plan holds: the product, how many runs of its blueprint, a note,
// active or done, and the player's CHOICES -- which types to buy instead of
// build, how many jobs a type's runs are split into, and the efficiencies to
// assume for a blueprint nobody owns. Everything computed (what is short, what
// is held, what to start next) is re-derived from live reads every time.
//
// ⚠ VALIDATION HERE IS SHAPE AND RANGE ONLY, as for PI plans. Whether a type is
// something a blueprint makes is the recipe book's question, answered in the
// browser; a plan naming something unknown is still shown, never dropped.
//
// ⚠ CHOICES ARE STORED CANONICAL: sorted, deduplicated, bounded. Two saves of
// the same choices write the same text, and a hostile body cannot grow a row
// without limit.
//
// Keying is global, as for PI plans and the bot library: a single-operator
// deployment, so the account a plan was saved from is not a tenancy boundary.

const crypto = require("crypto");

const MAX_PLANS_TOTAL = 500;
const MAX_NOTE_LEN = 500;
const MAX_RUNS = 1_000_000;
const MAX_CHOICE_ENTRIES = 1000;
const MAX_JOBS = 1000;
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

/** A typeID map key ("101") as a number, or null. */
function keyID(key) {
  if (!/^[1-9][0-9]{0,15}$/.test(key)) return null;
  const id = Number(key);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * The player's choices, checked and made canonical:
 *   { buy: [typeID...], jobs: { typeID: n }, blueprints: { blueprintTypeID: { materialEfficiency, timeEfficiency } },
 *     decryptors: { blueprintTypeID: decryptorTypeID },   (decryptors: R109 slice 6)
 *     facilities?: { manufacturing?: facilityID, reaction?: facilityID } }
 * `facilities` is where a plan's jobs without an owned copy are built, per
 * activity, and is left out when none is chosen, so older plans read the same.
 */
function guardChoices(input) {
  if (input === undefined || input === null) return { buy: [], jobs: {}, blueprints: {}, decryptors: {} };
  if (!isPlainObject(input)) throw fail("INDUSTRY_PLAN_INVALID", "A plan's choices are not readable.");

  const buy = input.buy === undefined ? [] : input.buy;
  if (!Array.isArray(buy) || buy.length > MAX_CHOICE_ENTRIES || !buy.every(positiveInteger)) {
    throw fail("INDUSTRY_PLAN_INVALID", "What to buy is a list of items.");
  }

  const jobsIn = input.jobs === undefined ? {} : input.jobs;
  if (!isPlainObject(jobsIn) || Object.keys(jobsIn).length > MAX_CHOICE_ENTRIES) {
    throw fail("INDUSTRY_PLAN_INVALID", "Job splits are not readable.");
  }
  const jobs = {};
  for (const key of Object.keys(jobsIn).sort((a, b) => Number(a) - Number(b))) {
    const id = keyID(key);
    if (id === null || !integerIn(jobsIn[key], 1, MAX_JOBS)) {
      throw fail("INDUSTRY_PLAN_INVALID", `A job split is a whole number from 1 to ${MAX_JOBS}.`);
    }
    // One job is the default; storing it would only make two equal plans differ.
    if (jobsIn[key] > 1) jobs[String(id)] = jobsIn[key];
  }

  const blueprintsIn = input.blueprints === undefined ? {} : input.blueprints;
  if (!isPlainObject(blueprintsIn) || Object.keys(blueprintsIn).length > MAX_CHOICE_ENTRIES) {
    throw fail("INDUSTRY_PLAN_INVALID", "Blueprint terms are not readable.");
  }
  const blueprints = {};
  for (const key of Object.keys(blueprintsIn).sort((a, b) => Number(a) - Number(b))) {
    const id = keyID(key);
    const terms = blueprintsIn[key];
    if (
      id === null ||
      !isPlainObject(terms) ||
      !integerIn(terms.materialEfficiency, 0, 10) ||
      !integerIn(terms.timeEfficiency, 0, 20)
    ) {
      throw fail("INDUSTRY_PLAN_INVALID", "Material efficiency is 0 to 10, time efficiency 0 to 20.");
    }
    blueprints[String(id)] = { materialEfficiency: terms.materialEfficiency, timeEfficiency: terms.timeEfficiency };
  }

  const decryptorsIn = input.decryptors === undefined ? {} : input.decryptors;
  if (!isPlainObject(decryptorsIn) || Object.keys(decryptorsIn).length > MAX_CHOICE_ENTRIES) {
    throw fail("INDUSTRY_PLAN_INVALID", "Decryptor choices are not readable.");
  }
  const decryptors = {};
  for (const key of Object.keys(decryptorsIn).sort((a, b) => Number(a) - Number(b))) {
    const id = keyID(key);
    if (id === null || !positiveInteger(decryptorsIn[key])) {
      throw fail("INDUSTRY_PLAN_INVALID", "A decryptor choice names an item.");
    }
    decryptors[String(id)] = decryptorsIn[key];
  }

  const facilitiesIn = input.facilities === undefined ? {} : input.facilities;
  if (!isPlainObject(facilitiesIn)) {
    throw fail("INDUSTRY_PLAN_INVALID", "Where to build is not readable.");
  }
  const facilities = {};
  for (const key of Object.keys(facilitiesIn)) {
    if ((key !== "manufacturing" && key !== "reaction") || !positiveInteger(facilitiesIn[key])) {
      throw fail("INDUSTRY_PLAN_INVALID", "Where to build names a facility for manufacturing or reactions.");
    }
  }
  for (const key of ["manufacturing", "reaction"]) {
    if (facilitiesIn[key] !== undefined) facilities[key] = facilitiesIn[key];
  }

  const choices = { buy: [...new Set(buy)].sort((a, b) => a - b), jobs, blueprints, decryptors };
  return Object.keys(facilities).length > 0 ? { ...choices, facilities } : choices;
}

/** Stored text back to choices. A row damaged by hand reads as no choices. */
function parseChoices(text) {
  try {
    return guardChoices(JSON.parse(text));
  } catch {
    return { buy: [], jobs: {}, blueprints: {}, decryptors: {} };
  }
}

function rowToPlan(row) {
  return {
    planID: row.id,
    productTypeID: row.product_type_id,
    runs: row.runs,
    choices: parseChoices(row.choices),
    note: row.note,
    status: row.status,
    rev: row.rev,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Check the fields a create or update may carry. `partial` allows any subset
 * (an update); otherwise productTypeID and runs are required.
 */
function guardFields(input, partial) {
  if (!isPlainObject(input)) {
    throw fail("INDUSTRY_PLAN_INVALID", "That is not a plan.");
  }
  const out = {};
  if (input.productTypeID !== undefined || !partial) {
    if (!positiveInteger(input.productTypeID)) throw fail("INDUSTRY_PLAN_INVALID", "Choose something to build.");
    out.productTypeID = input.productTypeID;
  }
  if (input.runs !== undefined || !partial) {
    if (!integerIn(input.runs, 1, MAX_RUNS)) {
      throw fail("INDUSTRY_PLAN_INVALID", "Enter how many runs, as a whole number.");
    }
    out.runs = input.runs;
  }
  if (input.choices !== undefined) {
    out.choices = JSON.stringify(guardChoices(input.choices));
  }
  if (input.note !== undefined) {
    if (typeof input.note !== "string") throw fail("INDUSTRY_PLAN_INVALID", "A note is text.");
    const note = input.note.trim();
    if (note.length > MAX_NOTE_LEN) {
      throw fail("INDUSTRY_PLAN_INVALID", `A note is at most ${MAX_NOTE_LEN} characters.`);
    }
    out.note = note;
  }
  if (input.status !== undefined) {
    if (!STATUSES.includes(input.status)) throw fail("INDUSTRY_PLAN_INVALID", "A plan is active or done.");
    out.status = input.status;
  }
  return out;
}

/**
 * `db` is a lazy handle ({ get() } from companionDb.lazyCompanionDb) so that
 * building the store never opens the file.
 */
function createIndustryPlanStore({ db, now = () => new Date().toISOString(), uuid = () => crypto.randomUUID() }) {
  const conn = () => db.get();

  function getRow(planID) {
    return conn().prepare("SELECT * FROM industry_plans WHERE id = ?").get(String(planID)) || null;
  }

  return {
    /** Every plan, active first, then most recently changed. */
    list() {
      return conn()
        .prepare("SELECT * FROM industry_plans ORDER BY status = 'done', updated_at DESC, id")
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
        const total = database.prepare("SELECT COUNT(*) AS n FROM industry_plans").get().n;
        if (total >= MAX_PLANS_TOTAL) {
          throw fail("INDUSTRY_PLAN_LIMIT_REACHED", "You have reached the limit of saved plans.");
        }
        const planID = uuid();
        const timestamp = now();
        database
          .prepare(
            `INSERT INTO industry_plans
               (id, product_type_id, runs, choices, note, status, rev, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(
            planID,
            fields.productTypeID,
            fields.runs,
            fields.choices ?? JSON.stringify(guardChoices(undefined)),
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
        if (!row) throw fail("INDUSTRY_PLAN_NOT_FOUND", "That plan could not be found.");
        if (Number(baseRev) !== row.rev) {
          throw fail("INDUSTRY_PLAN_REV_CONFLICT", "This plan was changed somewhere else. Reopen it and try again.");
        }
        database
          .prepare(
            `UPDATE industry_plans
                SET product_type_id = ?, runs = ?, choices = ?, note = ?, status = ?, rev = rev + 1, updated_at = ?
              WHERE id = ?`,
          )
          .run(
            fields.productTypeID ?? row.product_type_id,
            fields.runs ?? row.runs,
            fields.choices ?? row.choices,
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
      return conn().prepare("DELETE FROM industry_plans WHERE id = ?").run(String(planID)).changes > 0;
    },
  };
}

module.exports = { createIndustryPlanStore, guardChoices, MAX_PLANS_TOTAL, MAX_NOTE_LEN, MAX_RUNS };
