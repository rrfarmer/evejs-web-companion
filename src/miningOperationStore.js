"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const staticData = require("./staticData");
const { normalizePolicies } = require("./miningOperationPolicies");
const { normalizeSupport } = require("./miningOperationSupport");
const { normalizePreparation } = require("./miningPreparation");

const STORE_FILENAME = "mining-operations.json";
const ROLES = new Set(["MINER", "HAULER", "DEFENDER", "COMMAND"]);
const REACH = new Set(["CURRENT_SYSTEM", "CURRENT_AND_ADJACENT"]);
const TARGET_CLASSES = new Set(["BELT", "ORE_ANOMALY", "ICE", "GAS"]);
const UNLOAD = new Set(["HAULER_SERVICE", "SELF_UNLOAD"]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function cleanText(value, max = 100) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function normalizeDefinition(value, existing = null, now = () => new Date().toISOString(), uuid = crypto.randomUUID, resolveSystem = staticData.getSolarSystem, resolveStation = staticData.getStation) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw fail("MINING_OPERATION_INVALID", "That is not a Mining Operation definition.");
  }
  const name = cleanText(value.name, 80);
  const anchorSystemID = Number(value.area?.anchorSystemID);
  const reach = cleanText(value.area?.reach).toUpperCase();
  const targetClasses = Array.isArray(value.area?.targetClasses)
    ? [...new Set(value.area.targetClasses.map((row) => cleanText(row).toUpperCase()).filter((row) => TARGET_CLASSES.has(row)))]
    : [];
  const unloadPolicy = cleanText(value.unloadPolicy).toUpperCase();
  if (!name) throw fail("MINING_OPERATION_INVALID", "Give the operation a name.");
  if (!Number.isSafeInteger(anchorSystemID) || anchorSystemID <= 0) {
    throw fail("MINING_OPERATION_INVALID", "Choose an anchor solar system.");
  }
  const system = resolveSystem(anchorSystemID);
  if (!system || !system.solarSystemName) {
    throw fail("MINING_OPERATION_INVALID", "Choose a known anchor solar system from the map catalog.");
  }
  const anchorSystemName = String(system.solarSystemName);
  if (value.area?.anchorSystemName && cleanText(value.area.anchorSystemName, 120) !== anchorSystemName) {
    throw fail("MINING_OPERATION_INVALID", "Anchor system name and ID do not identify the same solar system.");
  }
  if (!REACH.has(reach)) throw fail("MINING_OPERATION_INVALID", "Choose a supported area reach.");
  if (targetClasses.length === 0) throw fail("MINING_OPERATION_INVALID", "Choose at least one target class.");
  if (!UNLOAD.has(unloadPolicy)) throw fail("MINING_OPERATION_INVALID", "Choose an unload policy.");
  let unloadDestination = null;
  if (value.unloadDestination != null) {
    const division = value.unloadDestination.corporationDivision == null ? null : Number(value.unloadDestination.corporationDivision);
    const corporationID = division === null ? null : Number(value.unloadDestination.corporationID);
    if (division !== null && (!Number.isSafeInteger(division) || division < 1 || division > 7)) {
      throw fail("MINING_OPERATION_INVALID", "Choose personal hangar or corporation division 1–7.");
    }
    if (division !== null && (!Number.isSafeInteger(corporationID) || corporationID <= 0)) {
      throw fail("MINING_OPERATION_INVALID", "Strict delivery requires the intended corporation ID.");
    }
    if (value.unloadDestination.kind === "structure") {
      const { id, name, solarSystemID, solarSystemName } = value.unloadDestination;
      const system = Number.isSafeInteger(solarSystemID) ? resolveSystem(solarSystemID) : null;
      if (!Number.isSafeInteger(id) || id < 1_000_000_000_000 || !cleanText(name, 160) ||
          !system?.solarSystemName || solarSystemName !== system.solarSystemName) {
        throw fail("MINING_OPERATION_INVALID", "Choose a resolved player structure and corporation division 1–7.");
      }
      unloadDestination = { kind: "structure", id, name: cleanText(name, 160),
        solarSystemID, solarSystemName: system.solarSystemName, corporationDivision: division, corporationID };
    } else {
      const stationID = Number(value.unloadDestination.stationID);
      const station = Number.isSafeInteger(stationID) && stationID > 0 ? resolveStation(stationID) : null;
      if (!station || !station.stationName) {
        throw fail("MINING_OPERATION_INVALID", "Choose a known unload station and corporation division 1–7.");
      }
      const stationSystem = resolveSystem(Number(station.solarSystemID));
      if (!stationSystem?.solarSystemName) throw fail("MINING_OPERATION_INVALID", "The unload station has no known solar system.");
      if (value.unloadDestination.stationName && cleanText(value.unloadDestination.stationName, 160) !== station.stationName) {
        throw fail("MINING_OPERATION_INVALID", "Unload station name and ID do not match.");
      }
      unloadDestination = { stationID, stationName: station.stationName,
        systemName: stationSystem.solarSystemName, corporationDivision: division, corporationID };
    }
  }
  if (!Array.isArray(value.members) || value.members.length === 0) {
    throw fail("MINING_OPERATION_INVALID", "Add at least one pilot.");
  }
  const seen = new Set();
  const members = value.members.map((row) => {
    const characterID = Number(row?.characterID);
    const role = cleanText(row?.role).toUpperCase();
    const automationID = cleanText(row?.automationID, 160);
    const routineMode = cleanText(row?.routineMode).toUpperCase() || (automationID ? "CUSTOM" : "STANDARD");
    const accountName = cleanText(row?.accountName, 120);
    if (!Number.isSafeInteger(characterID) || characterID <= 0 || seen.has(characterID)) {
      throw fail("MINING_OPERATION_INVALID", "Every member must be a different valid pilot.");
    }
    if (!ROLES.has(role)) throw fail("MINING_OPERATION_INVALID", "Every member needs an explicit role.");
    if (!["STANDARD", "CUSTOM"].includes(routineMode)) throw fail("MINING_OPERATION_INVALID", "Choose Standard or Custom routine mode.");
    if (routineMode === "CUSTOM" && !automationID && role !== "DEFENDER") throw fail("MINING_OPERATION_INVALID", "Custom members need an operation routine reference.");
    if (routineMode === "STANDARD" && automationID) throw fail("MINING_OPERATION_INVALID", "A Standard member cannot also select a custom routine.");
    if (!accountName) throw fail("MINING_OPERATION_INVALID", "Every member needs its owning account reference.");
    seen.add(characterID);
    return {
      characterID,
      characterName: cleanText(row.characterName, 120) || `Pilot ${characterID}`,
      accountName,
      role,
      routineMode,
      automationID,
      ...(row.preparation ? { preparation: normalizePreparation(row.preparation, true) } : {}),
    };
  });
  if (!members.some((member) => member.role === "MINER")) {
    throw fail("MINING_OPERATION_INVALID", "A Mining Operation needs at least one MINER.");
  }
  if (members.some(member => member.routineMode === "STANDARD") && targetClasses.length !== 1) {
    throw fail("MINING_OPERATION_INVALID", "Standard operations require exactly one target family.");
  }
  if (unloadPolicy === "HAULER_SERVICE" && !members.some((member) => member.role === "HAULER")) {
    throw fail("MINING_OPERATION_INVALID", "Hauler service needs at least one HAULER member.");
  }
  if (unloadPolicy === "SELF_UNLOAD" && members.some((member) => member.role === "HAULER")) {
    throw fail("MINING_OPERATION_INVALID", "Self unload does not use HAULER members.");
  }
  const stamp = now();
  const support = normalizeSupport(value.support, members);
  return {
    operationID: existing?.operationID || cleanText(value.operationID, 160) || uuid(),
    name,
    area: {
      anchorSystemID,
      anchorSystemName,
      reach,
      targetClasses,
    },
    targetPolicy: "ANY_ELIGIBLE",
    unloadPolicy,
    unloadDestination,
    policies: normalizePolicies(value.policies, resolveStation, resolveSystem),
    ...(support ? { support } : {}),
    preparation: normalizePreparation(value.preparation),
    members,
    createdAt: existing?.createdAt || stamp,
    updatedAt: stamp,
  };
}

function createMiningOperationStore(options) {
  const dataDir = options.dataDir;
  const now = options.now || (() => new Date().toISOString());
  const uuid = options.uuid || (() => crypto.randomUUID());
  const resolveSystem = options.resolveSystem || staticData.getSolarSystem;
  const resolveStation = options.resolveStation || staticData.getStation;
  const filePath = path.join(dataDir, STORE_FILENAME);

  function readAll() {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return parsed && Array.isArray(parsed.operations) ? parsed.operations.map(row => ({ ...row,
        policies: normalizePolicies(row.policies, resolveStation, resolveSystem),
        preparation: normalizePreparation(row.preparation),
      })) : [];
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  function writeAll(operations) {
    fs.mkdirSync(dataDir, { recursive: true });
    const tempPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify({ version: 1, operations }, null, 2), "utf8");
    fs.renameSync(tempPath, filePath);
  }

  return {
    list() {
      return readAll();
    },
    get(operationID) {
      return readAll().find((row) => row.operationID === String(operationID)) || null;
    },
    save(value) {
      const all = readAll();
      const index = all.findIndex((row) => row.operationID === String(value?.operationID || ""));
      const definition = normalizeDefinition(value, index >= 0 ? all[index] : null, now, uuid, resolveSystem, resolveStation);
      if (index >= 0) all[index] = definition;
      else all.push(definition);
      writeAll(all);
      return definition;
    },
    remove(operationID) {
      const all = readAll();
      const next = all.filter((row) => row.operationID !== String(operationID));
      if (next.length === all.length) return false;
      writeAll(next);
      return true;
    },
  };
}

module.exports = { createMiningOperationStore, normalizeDefinition, STORE_FILENAME };
