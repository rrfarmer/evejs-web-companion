"use strict";

// MCC-owned scripts use the ordinary script runner. IDs identify behavior,
// while rev and botHost's document hash pin the exact granted implementation.
const BELT_MINER_ID = "mcc.belt.hauler-service.miner";
const BELT_HAULER_ID = "mcc.belt.hauler-service.hauler";
const DEFENDER_PROFILE = Object.freeze({ scriptID: "mcc.standard.defender", name: "Standard Defender", rev: 1 });
const PROFILES = Object.freeze({
  MINER: { scriptID: BELT_MINER_ID, name: "Belt Miner / Hauler Service", rev: 2 },
  HAULER: { scriptID: BELT_HAULER_ID, name: "Belt Hauler", rev: 1 },
});
// Families own distinct implementations. Future families cannot route through
// a belt routine merely because they share a member role.
const PROFILE_FAMILIES = Object.freeze({
  BELT: { family: "BELT", executable: true, profiles: PROFILES, selfUnload: selfUnloadProfile("belt", "Belt"), build: buildBeltProfile },
  ORE_ANOMALY: { family: "ORE_ANOMALY", executable: true, profiles: siteProfiles("ore-anomaly", "Ore Anomaly"), selfUnload: selfUnloadProfile("ore-anomaly", "Ore Anomaly"), build: buildOreAnomalyProfile },
  ICE: { family: "ICE", executable: true, profiles: siteProfiles("ice", "Ice"), selfUnload: selfUnloadProfile("ice", "Ice"), build: buildIceProfile },
  GAS: { family: "GAS", executable: false, profiles: {}, reason: "Gas profiles are not implemented." },
});
const familyCapabilities = () => Object.values(PROFILE_FAMILIES).map(({ build, ...metadata }) => metadata);

function selfUnloadProfile(id, name) {
  return Object.freeze({ scriptID: `mcc.${id}.self-unload.miner`, name: `${name} Miner / Self Unload`, rev: 1 });
}

function siteProfiles(id, name) {
  return Object.freeze({
    MINER: { scriptID: `mcc.${id}.hauler-service.miner`, name: `${name} Miner / Hauler Service`, rev: 1 },
    HAULER: { scriptID: `mcc.${id}.hauler-service.hauler`, name: `${name} Hauler`, rev: 1 },
  });
}

function buildOreAnomalyProfile(definition, member) { return buildSiteProfile(definition, member, "site"); }
function buildIceProfile(definition, member) { return buildSiteProfile(definition, member, "ice-site"); }

// Shared freight/control structure, distinct versioned semantic profiles. The
// site modes have operation-only travel authority and never select a belt.
function buildSiteProfile(definition, member, mode) {
  const result = buildMiningServiceDocument(definition, member);
  if (!result) return null;
  result.doc.notes = `MCC standard ${definition.area.targetClasses[0]} profile. Operation target authority only.`;
  const body = result.doc.program[0].body;
  const step = member.role === "MINER" ? body.find(row => row.id === "mine") : body.find(row => row.id === "hold-check").else.find(row => row.id === "travel");
  step.args.belt.belt.mode = mode;
  return result;
}

function standardProfileFor(definition, member) {
  if ((member?.routineMode || (member?.automationID ? "CUSTOM" : "STANDARD")) !== "STANDARD" ||
      definition?.area?.targetClasses?.length !== 1) return null;
  const family = PROFILE_FAMILIES[definition.area.targetClasses[0]];
  if (!family?.executable) return null;
  if (member.role === "DEFENDER") return DEFENDER_PROFILE;
  if (member.role === "COMMAND") return definition.support?.characterID === member.characterID
    ? { scriptID: "mcc.command.mining-support", name: "Mining Command / Support", rev: 1 } : null;
  if (member.role === "HAULER" && definition.support) {
    const base = family.profiles.HAULER;
    return definition.unloadPolicy === "HAULER_SERVICE" ? { ...base, scriptID: `${base.scriptID}.support-bound`, name: `${base.name} / Support Fleet`, rev: 1 } : null;
  }
  if (member.role === "MINER" && definition.support) {
    const base = definition.unloadPolicy === "SELF_UNLOAD" ? family.selfUnload : family.profiles.MINER;
    return { ...base, scriptID: `${base.scriptID}.support-bound`, name: `${base.name} / Fleet Miner`, rev: 1 };
  }
  if (definition.unloadPolicy === "SELF_UNLOAD") return member.role === "MINER" ? family.selfUnload : null;
  return definition.unloadPolicy === "HAULER_SERVICE" ? family.profiles[member.role] || null : null;
}

function buildStandardProfile(definition, member) {
  if (member.role === "DEFENDER") {
    const profile = standardProfileFor(definition, member), destination = definition.unloadDestination;
    if (!profile || !destination) return null;
    const home = destination.kind === "structure"
      ? { entity: "structure", id: destination.id, name: destination.name, systemName: destination.solarSystemName }
      : { entity: "station", id: destination.stationID, name: destination.stationName, systemName: destination.systemName };
    if (!Number.isSafeInteger(home.id) || home.id <= 0 || !home.name || !home.systemName) return null;
    return { ...profile, doc: { format: "evejs-bot-script", version: 1, name: profile.name,
      notes: "MCC operation target only. Shared mobile combat and fit-driven Phase-1 utilities.", home,
      interrupts: [
        { id: "hull-emergency", when: { kind: "hull-below", fraction: 0.3 }, respond: "dock-and-pause" },
        { id: "armor-maintenance", when: { kind: "armor-below", fraction: 0.3 }, respond: "repair" },
      ], program: [{ id: "operation-loop", kind: "loop", repeat: { kind: "forever" }, body: [
        { id: "undock", kind: "macro", macro: "undock", args: {} },
        { id: "defend", kind: "macro", macro: "fight-with-drones", args: {} },
        { id: "idle", kind: "macro", macro: "wait", args: { seconds: { kind: "count", value: 4 } } },
      ] }] } };
  }
  if (member.role === "COMMAND") {
    const profile = standardProfileFor(definition, member), destination = definition.unloadDestination;
    if (!profile || !destination) return null;
    const home = destination.kind === "structure" ? { entity: "structure", id: destination.id, name: destination.name, systemName: destination.solarSystemName }
      : { entity: "station", id: destination.stationID, name: destination.stationName, systemName: destination.systemName };
    return { ...profile, doc: { format: "evejs-bot-script", version: 1, name: profile.name,
      notes: `MCC Mining Support v1: ${JSON.stringify(definition.support)}`, home, interrupts: [], program: [
        { id: "undock", kind: "macro", macro: "undock", args: {} }, { id: "support", kind: "macro", macro: "mining-support", args: {} },
      ] } };
  }
  const family = PROFILE_FAMILIES[definition?.area?.targetClasses?.[0]];
  return family?.executable ? family.build(definition, member) : null;
}

function buildBeltProfile(definition, member) {
  return buildMiningServiceDocument(definition, member);
}

function buildMiningServiceDocument(definition, member) {
  const profile = standardProfileFor(definition, member);
  if (!profile) return null;
  const destination = definition.unloadDestination;
  if (!destination) return null;
  if (destination?.corporationDivision != null &&
      (!Number.isSafeInteger(destination.corporationDivision) || destination.corporationDivision < 1 || destination.corporationDivision > 7)) return null;
  const station = destination.kind === "structure"
    ? Number.isSafeInteger(destination.id) && destination.id >= 1_000_000_000_000 && destination.name && destination.solarSystemName
      ? { entity: "structure", id: destination.id, name: destination.name, systemName: destination.solarSystemName }
      : null
    : Number.isSafeInteger(destination.stationID) && destination.stationID > 0 && destination.stationName && destination.systemName
      ? { entity: "station", id: destination.stationID, name: destination.stationName, systemName: destination.systemName }
      : null;
  if (!station) return null;
  const belt = { kind: "belt", belt: { mode: "nearest" } };
  const delivery = { id: "deliver", kind: "macro", macro: "deliver-ore", args: {
    station: { kind: "station", ref: station },
    ...(destination.corporationDivision == null ? {} : { into: { kind: "corpDivision", division: destination.corporationDivision, name: null } }),
  } };
  const doc = {
    format: "evejs-bot-script", version: 1, name: profile.name,
    notes: "MCC standard BELT profile. Resource target comes only from operation.currentTarget.",
    home: station, interrupts: [],
    program: member.role === "MINER" ? [{
      id: "loop", kind: "loop", repeat: { kind: "forever" }, body: [
        { id: "undock", kind: "macro", macro: "undock", args: {} },
        // Current Farmer/Batch 6 controller selects drones from ship capability;
        // the old per-step toggle is not part of the current script format.
        { id: "mine", kind: "macro", macro: definition.support ? "fleet-mine" : "mine-at-belt", args: { belt,
          ...(definition.support ? { support: { kind: "character", charID: definition.support.characterID,
            name: definition.members.find(row => row.characterID === definition.support.characterID)?.characterName ?? null } } : {}) }, until: { kind: "ore-hold-at-least", fraction: 0.9 } },
        definition.unloadPolicy === "SELF_UNLOAD" ? delivery : { id: "jettison", kind: "macro", macro: "jettison-ore", args: {} },
      ],
    }] : [{
      id: "loop", kind: "loop", repeat: { kind: "forever" }, body: [
        { id: "hold-check", kind: "branch", when: { kind: "ore-hold-at-least", fraction: 0.9 },
          then: [delivery],
          else: [
            { id: "undock", kind: "macro", macro: "undock", args: {} },
            { id: "travel", kind: "macro", macro: "travel-to-belt", args: { belt } },
            { id: "loot", kind: "macro", macro: "loot-containers", args: {} },
          ],
        },
        { id: "idle", kind: "macro", macro: "wait", args: { seconds: { kind: "count", value: 3 } } },
      ],
    }],
  };
  if (definition.support && member.role === "HAULER") doc.program[0].body.unshift({ id: "join-support", kind: "macro", macro: "join-support-fleet",
    args: { support: { kind: "character", charID: definition.support.characterID,
      name: definition.members.find(row => row.characterID === definition.support.characterID)?.characterName ?? null } } });
  return { ...profile, doc };
}

module.exports = { BELT_MINER_ID, BELT_HAULER_ID, PROFILES, PROFILE_FAMILIES, familyCapabilities, standardProfileFor, buildStandardProfile };
