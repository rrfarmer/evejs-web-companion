import { unresolvedCombatRuns } from "./combatCustody.ts";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { pluginDataDir } from "../../../web/src/plugin-api/backend.ts";
import type { CombatDefinition } from "../restored/app/combatOperations.ts";
import { isFleetRewardPolicy } from "../combat/rewardPolicy.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
type DB = {
  pragma(s: string): unknown;
  exec(s: string): unknown;
  prepare(s: string): any;
  close(): void;
};
const modes = new Set([
  "BELT_PATROL",
  "GATE_PATROL",
  "SECURITY_MISSION",
  "COMBAT_ANOMALY",
  "DED_COMPLEX",
]);
const validWorld = (v: unknown): v is string =>
  typeof v === "string" && v.trim() === v && v.length > 0 && v.length <= 200;
const positive = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
export function validateCombatDefinition(value: unknown): CombatDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid operation definition.");
  const d = value as CombatDefinition;
  if (
    typeof d.name !== "string" ||
    !d.name.trim() ||
    d.name.length > 200 ||
    !modes.has(d.mode) ||
    !positive(d.durationMinutes) ||
    d.durationMinutes > 4320 ||
    !Array.isArray(d.members) ||
    d.members.length < 1 ||
    d.members.length > 8 ||
    d.members.some(
      (m) =>
        !m ||
        typeof m.accountName !== "string" ||
        !m.accountName.trim() ||
        m.accountName.length > 200 ||
        !positive(m.characterID) ||
        (m.required !== undefined && typeof m.required !== "boolean") ||
        !m.preparation ||
        typeof m.preparation !== "object" ||
        Array.isArray(m.preparation),
    ) ||
    new Set(d.members.map((m) => m.characterID)).size !== d.members.length ||
    new Set(d.members.map((m) => m.accountName.toLowerCase())).size !== d.members.length ||
    !(d.systemID === null || positive(d.systemID)) ||
    !(d.homeStationID === null || positive(d.homeStationID))
  )
    throw Error("Invalid operation definition.");
  if (
    d.operationID !== undefined &&
    (typeof d.operationID !== "string" || !/^[0-9a-f-]{36}$/i.test(d.operationID))
  )
    throw Error("Invalid operation ID.");
  if (d.revision !== undefined && !positive(d.revision)) throw Error("Invalid operation revision.");
  if (d.objective?.rewardPolicy !== undefined && !isFleetRewardPolicy(d.objective.rewardPolicy))
    throw Error("Invalid fleet reward policy.");
  const json = JSON.stringify(d);
  if (Buffer.byteLength(json, "utf8") > 65536) throw Error("Operation definition is too large.");
  return JSON.parse(json) as CombatDefinition;
}
/** Dedicated registry; the existing mission and run journals are never rewritten. */
export function createCombatStore(db: DB) {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.exec(
    "CREATE TABLE IF NOT EXISTS combat_operations (world TEXT NOT NULL, id TEXT PRIMARY KEY, created_by INTEGER NOT NULL, revision INTEGER NOT NULL, definition TEXT NOT NULL)",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS combat_operation_runs (world TEXT NOT NULL, operation_id TEXT NOT NULL, epoch TEXT NOT NULL, owner TEXT NOT NULL, character_id INTEGER NOT NULL, revision INTEGER NOT NULL, review_hash TEXT NOT NULL, setup TEXT NOT NULL, bot_id TEXT, status TEXT NOT NULL, receipt TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(world,operation_id,epoch))",
  );
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS combat_operation_one_live_run ON combat_operation_runs(world,operation_id) WHERE status <> 'ENDED'",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS combat_operation_members (world TEXT NOT NULL,operation_id TEXT NOT NULL,epoch TEXT NOT NULL,owner TEXT NOT NULL,character_id INTEGER NOT NULL,ship_id INTEGER NOT NULL,required INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL,bot_id TEXT,receipt TEXT,PRIMARY KEY(world,operation_id,epoch,character_id))",
  );
  if (
    !db
      .prepare("PRAGMA table_info(combat_operation_members)")
      .all()
      .some((c: any) => c.name === "required")
  )
    db.exec("ALTER TABLE combat_operation_members ADD COLUMN required INTEGER NOT NULL DEFAULT 1");
  const members = db.prepare(
    "SELECT * FROM combat_operation_members WHERE world=? AND operation_id=? AND epoch=? ORDER BY rowid",
  );
  const memberInsert = db.prepare(
    "INSERT INTO combat_operation_members(world,operation_id,epoch,owner,character_id,ship_id,required,status) VALUES(?,?,?,?,?,?,?, 'PLANNED')",
  );
  const groupMark = db.prepare(
    "UPDATE combat_operation_runs SET status='GROUP_INTENT' WHERE world=? AND operation_id=? AND epoch=? AND status='INTENT'",
  );
  const dispatch = db.prepare(
    "UPDATE combat_operation_members SET status='DISPATCHED' WHERE world=? AND operation_id=? AND epoch=? AND owner=? AND character_id=? AND status='PLANNED'",
  );
  const bindMember = db.prepare(
    "UPDATE combat_operation_members SET status='RUNNING',bot_id=? WHERE world=? AND operation_id=? AND epoch=? AND owner=? AND character_id=? AND ship_id=? AND status='DISPATCHED' AND EXISTS(SELECT 1 FROM combat_operation_runs r WHERE r.world=? AND r.operation_id=? AND r.epoch=? AND r.status='GROUP_INTENT' AND r.setup=?)",
  );
  const parkMember = db.prepare(
    "UPDATE combat_operation_members SET status='PARKED',receipt=? WHERE world=? AND operation_id=? AND epoch=? AND owner=? AND character_id=? AND bot_id=? AND status='RUNNING'",
  );
  const finishGroup = db.prepare(
    "UPDATE combat_operation_runs SET status='ENDED',bot_id=?,receipt=? WHERE world=? AND operation_id=? AND epoch=? AND status='GROUP_INTENT'",
  );
  const runs = db.prepare(
    "SELECT * FROM combat_operation_runs WHERE world=? AND operation_id=? ORDER BY rowid DESC",
  );
  const begin = db.prepare(
    "INSERT INTO combat_operation_runs(world,operation_id,epoch,owner,character_id,revision,review_hash,setup,status,created_at) SELECT ?,id,?,?,?,?,?,?, 'INTENT',? FROM combat_operations WHERE world=? AND id=? AND revision=?",
  );
  const bind = db.prepare(
    "UPDATE combat_operation_runs SET bot_id=?,status='RUNNING' WHERE world=? AND operation_id=? AND epoch=? AND owner=? AND character_id=? AND setup=? AND status='INTENT'",
  );
  const end = db.prepare(
    "UPDATE combat_operation_runs SET status='ENDED',receipt=? WHERE world=? AND operation_id=? AND epoch=? AND owner=? AND character_id=? AND bot_id=? AND status='RUNNING'",
  );
  const all = db.prepare(
    "SELECT definition FROM combat_operations WHERE world=? ORDER BY rowid DESC",
  );
  const get = db.prepare(
    "SELECT revision,definition FROM combat_operations WHERE world=? AND id=?",
  );
  const insert = db.prepare(
    "INSERT INTO combat_operations(world,id,created_by,revision,definition) VALUES(?,?,?,?,?)",
  );
  const update = db.prepare(
    "UPDATE combat_operations SET revision=?,definition=? WHERE world=? AND id=? AND revision=? AND NOT EXISTS(SELECT 1 FROM combat_operation_runs r WHERE r.world=combat_operations.world AND r.operation_id=combat_operations.id AND r.status <> 'ENDED')",
  );
  const del = db.prepare(
    "DELETE FROM combat_operations WHERE world=? AND id=? AND revision=? AND NOT EXISTS(SELECT 1 FROM combat_operation_runs r WHERE r.world=combat_operations.world AND r.operation_id=combat_operations.id AND r.status <> 'ENDED')",
  );
  function read(world: string, id: string): CombatDefinition | null {
    if (!validWorld(world)) throw Error("Verified world scope is required.");
    const row = get.get(world, id);
    return row ? validateCombatDefinition(JSON.parse(row.definition)) : null;
  }
  return {
    list(world: string): CombatDefinition[] {
      if (!validWorld(world)) throw Error("Verified world scope is required.");
      return all
        .all(world)
        .map((r: { definition: string }) => validateCombatDefinition(JSON.parse(r.definition)));
    },
    read,
    runs(world: string, id: string): any[] {
      if (!validWorld(world)) throw Error("Verified world scope is required.");
      return runs
        .all(world, id)
        .map((r: any) => ({
          ...r,
          setup: JSON.parse(r.setup),
          receipt: r.receipt === null ? null : JSON.parse(r.receipt),
        }));
    },
    members(world: string, id: string, epoch: string): any[] {
      if (!validWorld(world)) throw Error("Verified world scope is required.");
      return members
        .all(world, id, epoch)
        .map((r: any) => ({ ...r, receipt: r.receipt === null ? null : JSON.parse(r.receipt) }));
    },
    beginGroup(
      world: string,
      id: string,
      epoch: string,
      owner: string,
      characterID: number,
      revision: number,
      reviewHash: string,
      setup: unknown,
      actors: readonly {
        accountName: string;
        characterID: number;
        shipID: number;
        required?: boolean;
      }[],
    ) {
      if (
        !validWorld(world) ||
        !/^[-a-f0-9]{36}$/i.test(epoch) ||
        !owner ||
        !positive(characterID) ||
        !positive(revision) ||
        !/^[a-f0-9]{64}$/.test(reviewHash) ||
        actors.length < 1 ||
        actors.length > 8 ||
        !actors.some(
          (a) =>
            a.characterID === characterID && a.accountName.toLowerCase() === owner.toLowerCase(),
        ) ||
        actors.some((a) => !a.accountName || !positive(a.characterID) || !positive(a.shipID)) ||
        new Set(actors.map((a) => a.characterID)).size !== actors.length ||
        new Set(actors.map((a) => a.shipID)).size !== actors.length ||
        new Set(actors.map((a) => a.accountName.toLowerCase())).size !== actors.length
      )
        throw Error("Invalid group intent.");
      db.exec("BEGIN IMMEDIATE");
      try {
        if (
          begin.run(
            world,
            epoch,
            owner.toLowerCase(),
            characterID,
            revision,
            reviewHash,
            JSON.stringify(setup),
            Date.now(),
            world,
            id,
            revision,
          ).changes !== 1
        )
          throw Error("Operation changed; review again.");
        if (groupMark.run(world, id, epoch).changes !== 1)
          throw Error("Group intent could not be recorded.");
        for (const a of actors)
          memberInsert.run(
            world,
            id,
            epoch,
            a.accountName.toLowerCase(),
            a.characterID,
            a.shipID,
            (setup as any)?.members?.find((m: any) => m.characterID === a.characterID)?.required ===
              false
              ? 0
              : 1,
          );
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    dispatchMember(world: string, id: string, epoch: string, owner: string, characterID: number) {
      if (
        !validWorld(world) ||
        dispatch.run(world, id, epoch, owner.toLowerCase(), characterID).changes !== 1
      )
        throw Error("The member Start is already dispatched or not authorized.");
    },
    bindMember(
      world: string,
      id: string,
      epoch: string,
      owner: string,
      characterID: number,
      shipID: number,
      setup: unknown,
      botID: string,
    ) {
      if (
        !validWorld(world) ||
        !botID ||
        bindMember.run(
          botID,
          world,
          id,
          epoch,
          owner.toLowerCase(),
          characterID,
          shipID,
          world,
          id,
          epoch,
          JSON.stringify(setup),
        ).changes !== 1
      )
        throw Error("The hosted fleet member does not match its durable Start intent.");
    },
    finishMember(
      world: string,
      id: string,
      epoch: string,
      owner: string,
      characterID: number,
      botID: string,
      receipt: unknown,
    ) {
      if (!validWorld(world)) throw Error("Verified world scope is required.");
      db.exec("BEGIN IMMEDIATE");
      try {
        const prior = members
          .all(world, id, epoch)
          .find((m: any) => m.character_id === characterID);
        if (prior?.status === "PARKED") {
          if (
            prior.owner !== owner.toLowerCase() ||
            prior.bot_id !== botID ||
            prior.receipt !== JSON.stringify(receipt)
          )
            throw Error("The parked fleet member receipt changed.");
        } else if (
          parkMember.run(
            JSON.stringify(receipt),
            world,
            id,
            epoch,
            owner.toLowerCase(),
            characterID,
            botID,
          ).changes !== 1
        )
          throw Error("The parked fleet member does not match its held run.");
        const group = runs.all(world, id).find((r: any) => r.epoch === epoch),
          list = members.all(world, id, epoch);
        if (!group || !["GROUP_INTENT", "ENDED"].includes(group.status) || list.length < 1)
          throw Error("The fleet operation changed.");
        if (group.status === "GROUP_INTENT" && list.every((m: any) => m.status === "PARKED")) {
          const ownerRow =
            (JSON.parse(group.setup).missionOwnerID
              ? list.find((m: any) => m.character_id === group.character_id)
              : list.find((m: any) => m.receipt && JSON.parse(m.receipt).retired !== true)) ??
            list.find((m: any) => m.character_id === group.character_id);
          if (!ownerRow || !ownerRow.receipt) throw Error("Mission owner receipt is unavailable.");
          if (finishGroup.run(ownerRow.bot_id, ownerRow.receipt, world, id, epoch).changes !== 1)
            throw Error("The fleet operation changed before settlement.");
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    begin(
      world: string,
      id: string,
      epoch: string,
      owner: string,
      characterID: number,
      revision: number,
      reviewHash: string,
      setup: unknown,
    ) {
      if (
        !validWorld(world) ||
        !/^[-a-f0-9]{36}$/i.test(epoch) ||
        !owner ||
        !positive(characterID) ||
        !positive(revision) ||
        !/^[a-f0-9]{64}$/.test(reviewHash)
      )
        throw Error("Invalid operation launch intent.");
      if (
        begin.run(
          world,
          epoch,
          owner.toLowerCase(),
          characterID,
          revision,
          reviewHash,
          JSON.stringify(setup),
          Date.now(),
          world,
          id,
          revision,
        ).changes !== 1
      )
        throw Error("Operation changed; review again.");
    },
    bind(
      world: string,
      id: string,
      epoch: string,
      owner: string,
      characterID: number,
      setup: unknown,
      botID: string,
    ) {
      if (
        !validWorld(world) ||
        !botID ||
        bind.run(botID, world, id, epoch, owner.toLowerCase(), characterID, JSON.stringify(setup))
          .changes !== 1
      )
        throw Error("The hosted Security run does not match its durable operation intent.");
    },
    finish(
      world: string,
      id: string,
      epoch: string,
      owner: string,
      characterID: number,
      botID: string,
      receipt: unknown,
    ) {
      if (
        !validWorld(world) ||
        end.run(JSON.stringify(receipt), world, id, epoch, owner.toLowerCase(), characterID, botID)
          .changes !== 1
      )
        throw Error("The Security settlement does not match its durable operation run.");
    },
    save(world: string, createdBy: number, input: unknown): CombatDefinition {
      if (!validWorld(world) || !positive(createdBy))
        throw Error("Verified world scope and account are required.");
      const d = validateCombatDefinition(input);
      if (d.operationID === undefined) {
        if (d.revision !== undefined) throw Error("New operation cannot have a revision.");
        const result = { ...d, operationID: randomUUID(), revision: 1 };
        insert.run(world, result.operationID, createdBy, 1, JSON.stringify(result));
        return result;
      }
      if (!d.revision) throw Error("Revision is required.");
      const existing = read(world, d.operationID);
      const rows = runs
        .all(world, d.operationID)
        .map((r: any) => ({ ...r, receipt: r.receipt === null ? null : JSON.parse(r.receipt) }));
      if (!existing || unresolvedCombatRuns(rows, existing.mode).length)
        throw Error("Native combat custody remains unresolved.");
      const result = { ...d, revision: d.revision + 1 };
      if (
        update.run(result.revision, JSON.stringify(result), world, d.operationID, d.revision)
          .changes !== 1
      )
        throw Error("Operation changed or is unavailable; refresh and review again.");
      return result;
    },
    remove(world: string, id: string, revision: number): boolean {
      return validWorld(world) && positive(revision) && del.run(world, id, revision).changes === 1;
    },
    close() {
      db.close();
    },
  };
}
export function openCombatStore() {
  return createCombatStore(new Database(path.join(pluginDataDir(), "combat-operations.sqlite")));
}
