import type {JsonValue} from "../../../web/src/plugin-api/index.ts";
import {decodeDistributionSetup} from "../distribution/plan.ts";
import {decodeCivilianMiningSetup} from "../mining/setup.ts";
import type {FoundAgent, OperationPilotChoice} from "../restored/app/apiTypes.ts";
import type {CivilianParkingPolicy} from "../restored/nav/civilianParking.ts";

type ProfileAgent = Pick<FoundAgent, "agentID" | "name" | "stationID" | "corporationID" | "corporationName" | "level">;

export interface CivilianProfile {
 pilot: OperationPilotChoice;
 agent: ProfileAgent | null;
 mode: "mining" | "distribution";
 runtime: number;
 maxJumps: number;
 searchJumps: number;
 limit: number;
 policy: "TIME" | "COUNT";
 automatic: boolean;
 corporationID: number | null;
 corporationName?: string | null;
 level: number;
 fallback: boolean;
 parking: CivilianParkingPolicy;
}

export function civilianSetup(plan: CivilianProfile): JsonValue {
 if (!["mining", "distribution"].includes(plan.mode) || !["TIME", "COUNT"].includes(plan.policy)
     || !Number.isSafeInteger(plan.level) || plan.level < 1 || plan.level > 4)
  throw Error("Choose a supported mission type, level and stop rule.");
 if (!Number.isSafeInteger(plan.pilot.characterID) || plan.pilot.characterID <= 0
     || !Number.isSafeInteger(plan.runtime) || plan.runtime < 1 || plan.runtime > 4320)
  throw Error("The reviewed pilot or runtime is invalid.");
 if (plan.policy === "COUNT" && (!Number.isSafeInteger(plan.limit) || plan.limit < 1 || plan.limit > 500))
  throw Error("Choose one to 500 confirmed completed missions.");
 if (!plan.automatic && (!plan.agent || !plan.agent.stationID)) throw Error("The reviewed agent location is missing.");
 const agent = plan.automatic
  ? {mode:"auto", levelRule:plan.fallback ? "max" : "exact", level:plan.level, corporationID:plan.corporationID, maxJumps:plan.searchJumps}
  : {mode:"manual", agentID:plan.agent?.agentID, ...(plan.mode === "distribution" ? {stationID:plan.agent?.stationID} : {})};
 const parking = plan.parking.mode === "NEAREST" ? {mode:"nearest"}
  : {mode:"selected", kind:plan.parking.destination.kind, destinationID:plan.parking.destination.id, systemID:plan.parking.destination.solarSystemID};
 return {agent, ...(plan.mode === "distribution" ? {maxJumps:plan.maxJumps} : {}), missionCount:plan.policy === "COUNT" ? plan.limit : 1,
  parking, ...(plan.policy === "TIME" ? {durationMinutes:plan.runtime} : {})} as JsonValue;
}

const text = (value: unknown): value is string => typeof value === "string" && !!value.trim() && value.length <= 256;
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Store only the settings that belong to the profile. Ownership is verified by Start. */
export function readCivilianProfile(value: unknown): CivilianProfile {
 const input = value as Partial<CivilianProfile> | null;
 const pilot = input?.pilot;
 if (!input || !pilot || !text(pilot.accountName) || !text(pilot.characterName) || !positive(pilot.characterID)
     || typeof input.automatic !== "boolean" || typeof input.fallback !== "boolean")
  throw Error("Choose a pilot and mission settings.");
 const rawAgent = input.agent;
 if (!input.automatic && (!rawAgent || !positive(rawAgent.agentID) || !positive(rawAgent.stationID) || !text(rawAgent.name)))
  throw Error("Choose an agent from the mission directory.");
 const destination = input.parking?.mode === "SELECTED" ? input.parking.destination : null;
 let parking: CivilianParkingPolicy;
 if (input.parking?.mode === "NEAREST") parking = {mode:"NEAREST"};
 else if (destination && (destination.kind === "station" || destination.kind === "structure") &&
          positive(destination.id) && positive(destination.solarSystemID) && text(destination.name)) {
  const {kind, id, name, solarSystemID, solarSystemName} = destination;
  parking = {mode:"SELECTED", destination:{kind,id,name,solarSystemID,solarSystemName:text(solarSystemName) ? solarSystemName : null}};
 } else throw Error("Choose a parking policy and destination.");
 const plan = {
  pilot: {accountName:pilot.accountName, characterID:pilot.characterID, characterName:pilot.characterName},
  mode: input.mode, policy: input.policy, runtime: input.runtime, limit: input.policy === "TIME" ? 0 : input.limit,
  maxJumps: input.maxJumps, searchJumps: input.searchJumps, automatic: input.automatic,
  level: input.level, fallback: input.fallback, corporationID: input.corporationID,
  corporationName: text(input.corporationName) ? input.corporationName : null,
  agent: !input.automatic && rawAgent ? {agentID:rawAgent.agentID,name:rawAgent.name,stationID:rawAgent.stationID,
   corporationID:positive(rawAgent.corporationID) ? rawAgent.corporationID : null,
   corporationName:text(rawAgent.corporationName) ? rawAgent.corporationName : null,
   level:positive(rawAgent.level) && rawAgent.level <= 4 ? rawAgent.level : null} : null,
  parking,
 } as CivilianProfile;
 const setup = civilianSetup(plan);
 const checked = plan.mode === "mining" ? decodeCivilianMiningSetup(setup) : decodeDistributionSetup(setup);
 if (!checked) throw Error("Check the Civilian Mission settings and travel limits.");
 return plan;
}
