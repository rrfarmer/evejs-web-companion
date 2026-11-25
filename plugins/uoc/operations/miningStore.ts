import { randomUUID, createHash } from "node:crypto";
import type { MiningPreparationFitting } from "../restored/mining/miningPreparation.ts";

/** Plugin-owned analogue of WC74 miningOperationStore.js @ 213da333.
 * All accounts in one world share the fleet definitions. Each member keeps its own pilot and account. */
export type SyncDocument = { read(): unknown; write(value: unknown): void };
export type SavedDefinition = {
  operationID: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  name: string;
  area: {
    anchorSystemID: number;
    anchorSystemName: string | null;
    reach: string;
    targetClasses: string[];
    anomalyFamily?: "ORE" | "MOON";
  };
  targetPolicy: string;
  unloadPolicy: string;
  unloadDestination: Record<string, unknown> | null;
  members: {
    characterID: number;
    characterName: string;
    accountName: string;
    role: string;
    routineMode?: string;
    automationID: string;
    preparation?: MiningPreparationFitting;
  }[];
  policies?: any;
  preparation?: any;
  support?: any;
  oreLogistics?: any;
};
const object = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const pos = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const text = (s: unknown, n = 160) => typeof s === "string" && s.trim().length > 0 && s.length <= n;
const fail = (why: string): never => {
  throw Error(why);
};
const only = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).every((k) => keys.includes(k));
const validDivision = (n: unknown) =>
  n === null || (typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 7);
function safeJSON(v: unknown, depth = 0): boolean {
  if (depth > 24) return false;
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.length <= 1000 && v.every((x) => safeJSON(x, depth + 1));
  return (
    object(v) &&
    Object.keys(v).length <= 100 &&
    Object.values(v).every((x) => safeJSON(x, depth + 1))
  );
}
/** Validate declared types and preserve every supported original field, never normalize away a user's selection. */
export function validateDefinition(input: unknown): asserts input is SavedDefinition {
  if (
    !object(input) ||
    !safeJSON(input) ||
    JSON.stringify(input).length > 200000 ||
    !only(input, [
      "operationID",
      "revision",
      "createdAt",
      "updatedAt",
      "name",
      "area",
      "targetPolicy",
      "unloadPolicy",
      "unloadDestination",
      "members",
      "policies",
      "preparation",
      "support",
      "oreLogistics",
    ])
  )
    fail("Invalid mining operation document.");
  const v = input as Record<string, any>;
  if (
    (v.operationID !== undefined && !text(v.operationID)) ||
    (v.revision !== undefined && !pos(v.revision)) ||
    (v.createdAt !== undefined && !text(v.createdAt)) ||
    (v.updatedAt !== undefined && !text(v.updatedAt))
  )
    fail("Invalid operation identity or revision.");
  if (
    !text(v.name, 80) ||
    !object(v.area) ||
    !only(v.area, [
      "anchorSystemID",
      "anchorSystemName",
      "reach",
      "targetClasses",
      "anomalyFamily",
    ]) ||
    !pos(v.area.anchorSystemID) ||
    (v.area.anomalyFamily !== undefined && !["ORE", "MOON"].includes(v.area.anomalyFamily)) ||
    !(v.area.anchorSystemName === null || text(v.area.anchorSystemName, 160)) ||
    !["CURRENT_SYSTEM", "CURRENT_AND_ADJACENT"].includes(v.area.reach) ||
    !Array.isArray(v.area.targetClasses) ||
    !v.area.targetClasses.length ||
    new Set(v.area.targetClasses).size !== v.area.targetClasses.length ||
    v.area.targetClasses.some(
      (x: unknown) => !["BELT", "ORE_ANOMALY", "ICE", "GAS"].includes(String(x)),
    ) ||
    v.targetPolicy !== "ANY_ELIGIBLE" ||
    !["HAULER_SERVICE", "SELF_UNLOAD"].includes(v.unloadPolicy)
  )
    fail("Invalid area, target family or unload policy.");
  if (
    !Array.isArray(v.members) ||
    !v.members.length ||
    new Set(v.members.map((m: any) => m?.characterID)).size !== v.members.length ||
    v.members.some(
      (m: any) =>
        !object(m) ||
        !only(m, [
          "characterID",
          "characterName",
          "accountName",
          "role",
          "routineMode",
          "automationID",
          "preparation",
        ]) ||
        !pos(m.characterID) ||
        !text(m.characterName, 120) ||
        !text(m.accountName, 120) ||
        !["MINER", "HAULER", "COMMAND", "DEFENDER"].includes(m.role) ||
        !(m.routineMode === undefined || ["STANDARD", "CUSTOM"].includes(m.routineMode)) ||
        typeof m.automationID !== "string" ||
        m.automationID.length > 160 ||
        ((m.routineMode ?? (m.automationID ? "CUSTOM" : "STANDARD")) === "CUSTOM") !==
          !!m.automationID,
    )
  )
    fail("Invalid operation roster or routine.");
  if (
    !v.members.some((m: any) => m.role === "MINER") ||
    (v.unloadPolicy === "HAULER_SERVICE" && !v.members.some((m: any) => m.role === "HAULER")) ||
    (v.unloadPolicy === "SELF_UNLOAD" && v.members.some((m: any) => m.role === "HAULER")) ||
    v.members.filter((m: any) => m.role === "COMMAND").length > 1
  )
    fail("Roster does not match the selected delivery policy.");
  if (v.unloadDestination !== null && v.unloadDestination !== undefined) {
    const d = v.unloadDestination;
    if (
      !object(d) ||
      !validDivision(d.corporationDivision) ||
      (d.corporationDivision !== null && !pos(d.corporationID))
    )
      fail("Invalid delivery corporation or division.");
    if (d.kind === "structure") {
      if (
        !pos(d.id) ||
        !text(d.name) ||
        !pos(d.solarSystemID) ||
        !(d.solarSystemName === null || text(d.solarSystemName))
      )
        fail("Invalid structure destination.");
    } else if (!pos(d.stationID) || !text(d.stationName)) fail("Invalid station destination.");
  }
  if (v.policies !== undefined) {
    const p = v.policies;
    if (
      !object(p) ||
      p.version !== 1 ||
      !object(p.parking) ||
      !["STAY_IN_PLACE", "RETURN_HOME_DOCK", "RETURN_HOME_UNLOAD_DOCK"].includes(p.parking.mode) ||
      !validDivision(p.parking.corporationDivision) ||
      (p.parking.mode !== "STAY_IN_PLACE" && !object(p.parking.destination)) ||
      (p.travelAssist !== undefined &&
        (!object(p.travelAssist) || !["AUTO", "DISABLED"].includes(p.travelAssist.mode))) ||
      (p.resourcePolicy !== undefined &&
        (!object(p.resourcePolicy) ||
          !["ANY_ELIGIBLE", "PREFER_LIST"].includes(p.resourcePolicy.mode) ||
          p.resourcePolicy.source !== "MANUAL" ||
          !Array.isArray(p.resourcePolicy.typeIDs) ||
          p.resourcePolicy.typeIDs.some((id: unknown) => !pos(id)) ||
          p.resourcePolicy.typeIDs.length > 20))
    )
      fail("Invalid operation policy.");
  }
  if (v.policies !== undefined) {
    const p = v.policies;
    if (
      !only(p, [
        "version",
        "parking",
        "resourcePolicy",
        "travelAssist",
        "resourceTarget",
        "scouting",
        "defense",
      ]) ||
      !only(p.parking, ["mode", "destination", "corporationDivision", "corporationID"]) ||
      (p.parking.corporationDivision !== null && !pos(p.parking.corporationID)) ||
      (p.resourcePolicy !== undefined && !only(p.resourcePolicy, ["mode", "source", "typeIDs"])) ||
      (p.travelAssist !== undefined && !only(p.travelAssist, ["mode"])) ||
      (
        [
          ["resourceTarget", "ANY_ELIGIBLE"],
          ["scouting", "DISABLED"],
          ["defense", "EXISTING_SELF_DEFENSE"],
        ] as const
      ).some(
        ([key, mode]) =>
          p[key] !== undefined &&
          (!object(p[key]) || !only(p[key], ["mode"]) || p[key].mode !== mode),
      )
    )
      fail("Invalid operation policy fields.");
    const d = p.parking.destination;
    if (d !== null && d !== undefined) {
      if (!object(d)) fail("Invalid parking destination.");
      if (d.kind === "structure") {
        if (
          !only(d, ["kind", "id", "name", "solarSystemID", "solarSystemName"]) ||
          !pos(d.id) ||
          !text(d.name) ||
          !pos(d.solarSystemID) ||
          !(d.solarSystemName === null || text(d.solarSystemName))
        )
          fail("Invalid parking structure.");
      } else if (
        !only(d, ["kind", "stationID", "stationName", "systemName"]) ||
        !pos(d.stationID) ||
        !text(d.stationName) ||
        !text(d.systemName)
      )
        fail("Invalid parking station.");
    }
  }
  if (
    v.oreLogistics !== undefined &&
    (!object(v.oreLogistics) ||
      v.oreLogistics.version !== 1 ||
      typeof v.oreLogistics.remoteCompression !== "boolean" ||
      typeof v.oreLogistics.compressedJettisonFraction !== "number" ||
      v.oreLogistics.compressedJettisonFraction <= 0 ||
      v.oreLogistics.compressedJettisonFraction > 1)
  )
    fail("Invalid ore logistics policy.");
  if (
    v.preparation !== undefined &&
    (!object(v.preparation) ||
      !object(v.preparation.source) ||
      !["hangar", "corp"].includes(v.preparation.source.kind) ||
      (v.preparation.source.kind === "corp" &&
        ((v.preparation.source.corporationID !== undefined &&
          !pos(v.preparation.source.corporationID)) ||
          !validDivision(v.preparation.source.division) ||
          v.preparation.source.division === null)) ||
      typeof v.preparation.suppliesRequired !== "boolean" ||
      (v.preparation.replenishSupplies !== undefined &&
        typeof v.preparation.replenishSupplies !== "boolean") ||
      (v.preparation.supplies !== undefined &&
        (!Array.isArray(v.preparation.supplies) ||
          v.preparation.supplies.some(
            (s: any) =>
              !object(s) ||
              !pos(s.typeID) ||
              !pos(s.target) ||
              !["CARRIED_SPARES", "TOTAL_ABOARD"].includes(s.mode) ||
              !Array.isArray(s.eligibleFlags) ||
              !s.eligibleFlags.length ||
              s.eligibleFlags.some(
                (f: unknown) => typeof f !== "number" || ![5, 133, 143].includes(f),
              ) ||
              typeof s.required !== "boolean",
          ))))
  )
    fail("Invalid equipment preparation.");
  if (v.preparation !== undefined) {
    const x = v.preparation;
    if (
      !only(x, [
        "source",
        "providerCharacterID",
        "fittingID",
        "suppliesRequired",
        "replenishSupplies",
        "supplies",
      ]) ||
      (x.providerCharacterID !== undefined && !pos(x.providerCharacterID)) ||
      (x.fittingID !== undefined && !pos(x.fittingID)) ||
      !only(
        x.source,
        x.source.kind === "hangar" ? ["kind"] : ["kind", "corporationID", "division"],
      ) ||
      x.supplies?.some(
        (r: any) => !only(r, ["typeID", "target", "mode", "eligibleFlags", "required"]),
      )
    )
      fail("Invalid equipment preparation fields.");
  }
  if (
    v.oreLogistics !== undefined &&
    !only(v.oreLogistics, ["version", "remoteCompression", "compressedJettisonFraction"])
  )
    fail("Invalid ore logistics fields.");
  if (v.support !== undefined) {
    const x = v.support;
    if (
      !object(x) ||
      x.version !== 1 ||
      !pos(x.characterID) ||
      !v.members.some((m: any) => m.role === "COMMAND" && m.characterID === x.characterID) ||
      Object.keys(x).some(
        (k) =>
          ![
            "version",
            "characterID",
            "fleetPolicy",
            "maintainBursts",
            "useIndustrialCore",
            "coreRequirement",
            "enableCompression",
            "selfMining",
            "tractor",
            "collection",
            "compressCollectedOre",
            "supportLoss",
          ].includes(k),
      ) ||
      [
        ["fleetPolicy", ["EXISTING_ONLY", "MANAGED"]],
        ["coreRequirement", ["continueWithoutCore", "requireCore"]],
        ["collection", ["TRACTOR_ONLY", "TRACTOR_AND_COLLECT"]],
        ["supportLoss", ["PAUSE", "CONTINUE_UNSUPPORTED", "STOP"]],
      ].some(
        ([key, values]) =>
          x[key as string] !== undefined && !(values as string[]).includes(x[key as string]),
      ) ||
      [
        "maintainBursts",
        "useIndustrialCore",
        "enableCompression",
        "selfMining",
        "tractor",
        "compressCollectedOre",
      ].some((key) => x[key] !== undefined && typeof x[key] !== "boolean")
    )
      fail("Invalid command support policy.");
  }
  for (const m of v.members)
    if (
      m.preparation !== undefined &&
      (!object(m.preparation) ||
        !only(m.preparation, ["providerCharacterID", "fittingID"]) ||
        Object.values(m.preparation).some((x) => !pos(x)))
    )
      fail("Invalid member fitting selection.");
}
type Envelope = { version: 1; definitions: SavedDefinition[] };
export function createMiningDefinitionStore(
  document: SyncDocument,
  now = () => new Date().toISOString(),
  uuid: () => string = () => randomUUID(),
) {
  function read(): Envelope {
    const v = document.read();
    if (v === null) return { version: 1, definitions: [] };
    if (!object(v) || v.version !== 1 || !Array.isArray(v.definitions))
      throw Error("Saved operation storage requires reconciliation.");
    const records = v.definitions as SavedDefinition[];
    for (const row of records) {
      validateDefinition(row);
      if (
        !text(row.operationID) ||
        !pos(row.revision) ||
        !text(row.createdAt) ||
        !text(row.updatedAt)
      )
        fail("Saved operation revision is invalid.");
    }
    if (new Set(records.map((x) => x.operationID)).size !== records.length)
      fail("Duplicate operation identity.");
    return { version: 1, definitions: structuredClone(records) };
  }
  function list() {
    return read().definitions;
  }
  function get(id: string) {
    return list().find((x) => x.operationID === id) ?? null;
  }
  function save(value: unknown) {
    validateDefinition(value);
    const original = value as SavedDefinition,
      all = list(),
      id = original.operationID;
    const current = id ? all.find((x) => x.operationID === id) : undefined;
    if (id && !current) fail("Operation was not found in this world.");
    if (current && original.revision !== current.revision)
      fail("Operation changed since editing; reload before saving.");
    const at = now(),
      row = {
        ...structuredClone(original),
        operationID: current?.operationID ?? uuid(),
        revision: (current?.revision ?? 0) + 1,
        createdAt: current?.createdAt ?? at,
        updatedAt: at,
      };
    const next = current ? all.map((x) => (x.operationID === id ? row : x)) : [...all, row];
    document.write({ version: 1, definitions: next });
    return structuredClone(row);
  }
  function remove(id: string, revision: number) {
    const all = list(),
      current = all.find((x) => x.operationID === id);
    if (!current) return false;
    if (current.revision !== revision)
      fail("Operation changed since review; reload before deleting.");
    document.write({ version: 1, definitions: all.filter((x) => x.operationID !== id) });
    return true;
  }
  return { list, get, save, remove };
}
export function definitionHash(v: SavedDefinition) {
  return createHash("sha256").update(JSON.stringify(v)).digest("hex");
}
