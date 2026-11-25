import path from "node:path";
import { createRequire } from "node:module";
import { pluginDataDir } from "../../../web/src/plugin-api/backend.ts";
import type { SyncDocument } from "./miningStore.ts";
const require = createRequire(import.meta.url),
  { createDocumentStore } = require("../documentStore.cjs");
let db: any = null;
export const preparationEvidenceKey = (
  world: string,
  id: string,
  run: string,
  characterID: number,
) => "evidence:" + JSON.stringify([world, id, run, characterID]);
/** A separate display document; inventory mutation journals are never replaced. */
export function readPreparationEvidence(
  world: string,
  id: string,
  run: string,
  characterID: number,
) {
  try {
    db ??= createDocumentStore(path.join(pluginDataDir(), "mining-preparation.sqlite"));
    return db.document(preparationEvidenceKey(world, id, run, characterID)).read();
  } catch {
    return null;
  }
}
export function closePreparationEvidence() {
  db?.close();
  db = null;
}
export function discardPreparationEvidence(world: string, id: string, run: string) {
  db ??= createDocumentStore(path.join(pluginDataDir(), "mining-preparation.sqlite"));
  db.deleteDocuments([], ["evidence:" + JSON.stringify([world, id, run]).slice(0, -1) + ","]);
}
export function preparationEvidence(
  value: any,
  scope: {
    world: string;
    operationID: string;
    operationRunID: string;
    characterID: number;
    shipID: number;
    role: string;
  },
) {
  const r = value?.readout;
  if (
    value?.version !== 1 ||
    value.world !== scope.world ||
    typeof value.botID !== "string" ||
    !value.botID ||
    !r ||
    r.operationID !== scope.operationID ||
    r.operationRunID !== scope.operationRunID ||
    r.characterID !== scope.characterID ||
    r.shipID !== scope.shipID ||
    r.role !== scope.role ||
    !["VERIFIED", "DEGRADED"].includes(r.state) ||
    !["VERIFIED", "MODIFIED", "UNKNOWN"].includes(r.equipment) ||
    !Array.isArray(r.targets) ||
    !Number.isFinite(r.observedAt)
  )
    return null;
  const source = r.source?.pin?.descriptor;
  return {
    ...structuredClone(r),
    historical: true,
    sourceLabel:
      r.sourceLabel ??
      (source?.kind === "corp"
        ? "Corporate division " + source.division
        : source?.kind === "hangar"
          ? "Personal local hangar"
          : "Previously observed supply source"),
    fittingName: r.fittingName ?? null,
  };
}
export function retainPreparation(
  document: SyncDocument,
  world: string,
  botID: string,
  readout: unknown,
) {
  document.write({ version: 1, world, botID, readout: structuredClone(readout) });
}
