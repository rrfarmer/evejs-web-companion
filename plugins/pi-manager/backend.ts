// The PI Manager's backend, run by the BFF in a process of its own
// (src/pluginHost.js): the saved plans and saved expansion plans, in the
// plugin's own database, and the PI blocks' next steps for bots the BFF hosts.
//
// Its routes are /api/plugins/pi-manager/..., the same shapes the BFF answered
// at /api/pi/plans and /api/pi/expansions before PI was a plugin.

import { createRequire } from "node:module";
import { pluginDataDir, startBackend, type BackendResponse, type BackendRoute } from "../../web/src/plugin-api/backend.ts";
import manifest from "./plugin.ts";

const require = createRequire(import.meta.url);
const { lazyPiDb } = require("./backend/piDb.cjs");
const { createPiPlanStore } = require("./backend/piPlanStore.cjs");
const { createPiExpansionStore } = require("./backend/piExpansionStore.cjs");

interface Store {
  list(): unknown[];
  create(fields: unknown): unknown;
  update(planID: string, fields: unknown, baseRev: number): unknown;
  remove(planID: string): boolean;
}

interface DbHandle {
  get(): { prepare(sql: string): { run(...values: unknown[]): unknown; all(): unknown[] }; transaction(fn: () => void): () => void; exec(sql: string): void };
  close(): void;
}

// A store refusal's code, as the status the BFF used to answer it with.
const STATUS: Readonly<Record<string, number>> = {
  PI_PLAN_INVALID: 400,
  PI_PLAN_LIMIT_REACHED: 409,
  PI_PLAN_REV_CONFLICT: 409,
  PI_PLAN_NOT_FOUND: 404,
  PI_EXPANSION_INVALID: 400,
  PI_EXPANSION_LIMIT_REACHED: 409,
  PI_EXPANSION_REV_CONFLICT: 409,
  PI_EXPANSION_NOT_FOUND: 404,
};

function answer(work: () => BackendResponse): BackendResponse {
  try {
    return work();
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    const status = typeof code === "string" ? STATUS[code] : undefined;
    if (status === undefined) throw error;
    return { status, body: { ok: false, error: code, message: (error as Error).message } };
  }
}

function fieldsAndRev(body: unknown): { fields: Record<string, unknown>; baseRev: number } {
  const { baseRev, ...fields } = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  return { fields, baseRev: Number(baseRev) };
}

/** One kind of saved plan's four routes, under `prefix`. */
function planRoutes(prefix: string, store: Store): Record<string, BackendRoute> {
  return {
    [`GET ${prefix}`]: () => answer(() => ({ body: { ok: true, plans: store.list() } })),
    [`POST ${prefix}`]: (request) => answer(() => ({ body: { ok: true, plan: store.create(request.body ?? {}) } })),
    [`POST ${prefix}/:planID`]: (request) => answer(() => {
      const { fields, baseRev } = fieldsAndRev(request.body);
      return { body: { ok: true, plan: store.update(request.params.planID!, fields, baseRev) } };
    }),
    [`POST ${prefix}/:planID/delete`]: (request) => answer(() => ({ body: { ok: true, removed: store.remove(request.params.planID!) } })),
  };
}

/** The backend's routes over a database handle; tests hand in one in memory. */
export function piRoutes(db: DbHandle): Record<string, BackendRoute> {
  return {
    ...planRoutes("/plans", createPiPlanStore({ db }) as Store),
    ...planRoutes("/expansions", createPiExpansionStore({ db }) as Store),
  };
}

const PLAN_COLUMNS = ["id", "type_id", "quantity", "note", "status", "rev", "created_at", "updated_at"];
const EXPANSION_COLUMNS = ["id", "settings", "rows", "note", "status", "rev", "created_at", "updated_at"];

/**
 * Take over the plans the companion's database kept before PI was a plugin,
 * row for row, once. The database records that it did, in the same transaction,
 * so a second handover changes nothing: a plan edited here stays as it is, and
 * one deleted here stays gone, whatever became of the BFF's marker file.
 */
export function adoptRows(db: DbHandle, records: unknown): void {
  const { plans = [], expansions = [] } = (records && typeof records === "object" ? records : {}) as {
    plans?: Record<string, unknown>[];
    expansions?: Record<string, unknown>[];
  };
  const conn = db.get();
  const insert = (table: string, columns: readonly string[], rows: readonly Record<string, unknown>[]) => {
    const statement = conn.prepare(`INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
    for (const row of rows) statement.run(...columns.map((column) => row[column]));
  };
  conn.transaction(() => {
    if (conn.prepare("SELECT id FROM pi_handover").all().length > 0) return;
    conn.prepare("INSERT INTO pi_handover (id, taken_at) VALUES (1, ?)").run(new Date().toISOString());
    insert("pi_plans", PLAN_COLUMNS, plans);
    insert("pi_expansion_plans", EXPANSION_COLUMNS, expansions);
  })();
}

// Started by the BFF's plugin host only; a test imports the functions above.
if (typeof process.send === "function") {
  const db = lazyPiDb({ dataDir: pluginDataDir() }) as DbHandle;
  startBackend({
    manifest,
    routes: piRoutes(db),
    adopt: (records) => adoptRows(db, records),
    // Everything it keeps is the database in its data directory, which the BFF
    // deletes after this: close it, so nothing is writing when it goes.
    cleanup: () => db.close(),
  });
}
