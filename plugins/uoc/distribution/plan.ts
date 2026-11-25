import { decodeParkingPolicy, type ParkingPolicy } from "../shared/parkingPolicy.ts";
import { readContinuation, type MissionContinuation } from "../civilian/acceptedMission.ts";
import type { BotScript, JsonValue, MacroStep } from "../../../web/src/plugin-api/index.ts";

type Agent =
  | { readonly mode: "manual"; readonly agentID: number; readonly stationID: number }
  | {
      readonly mode: "auto";
      readonly levelRule: "exact" | "max";
      readonly level: number;
      readonly corporationID: number | null;
      readonly maxJumps: number;
    };
export interface CivilianDistributionSetup {
  readonly agent: Agent;
  readonly maxJumps: number;
  readonly missionCount: number;
  readonly parking?: ParkingPolicy;
  readonly durationMinutes?: number;
  readonly continuation?: MissionContinuation;
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]) =>
  Object.keys(v).length === names.length && names.every((k) => Object.hasOwn(v, k));
const positive = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const jumps = (n: unknown): n is number => positive(n) && n <= 30;

/** Strictly canonicalize external setup; never infer an agent's station. */
export function decodeDistributionSetup(value: unknown): CivilianDistributionSetup | null {
  if (
    !record(value) ||
    !Object.keys(value).every((k) =>
      ["agent", "maxJumps", "missionCount", "parking", "durationMinutes", "continuation"].includes(
        k,
      ),
    ) ||
    !["agent", "maxJumps", "missionCount"].every((k) => Object.hasOwn(value, k)) ||
    !positive(value.missionCount) ||
    value.missionCount > 500 ||
    !jumps(value.maxJumps) ||
    !record(value.agent)
  )
    return null;
  const parking = decodeParkingPolicy(value.parking);
  if (
    !parking ||
    (value.durationMinutes !== undefined &&
      (!positive(value.durationMinutes) || value.durationMinutes > 4320))
  )
    return null;
  const continuation =
    value.continuation === undefined ? undefined : readContinuation(value.continuation);
  if (
    continuation === null ||
    (continuation && (value.missionCount !== 1 || value.durationMinutes !== undefined))
  )
    return null;
  const extras = {
    ...(value.parking === undefined ? {} : { parking }),
    ...(value.durationMinutes === undefined
      ? {}
      : { durationMinutes: value.durationMinutes as number }),
    ...(continuation ? { continuation } : {}),
  };
  const a = value.agent;
  if (
    a.mode === "manual" &&
    keys(a, ["mode", "agentID", "stationID"]) &&
    positive(a.agentID) &&
    positive(a.stationID)
  )
    return {
      agent: { mode: "manual", agentID: a.agentID, stationID: a.stationID },
      maxJumps: value.maxJumps,
      missionCount: value.missionCount,
      ...extras,
    };
  if (
    a.mode === "auto" &&
    keys(a, ["mode", "levelRule", "level", "corporationID", "maxJumps"]) &&
    (a.levelRule === "exact" || a.levelRule === "max") &&
    positive(a.level) &&
    a.level <= 4 &&
    (a.corporationID === null || positive(a.corporationID)) &&
    jumps(a.maxJumps)
  )
    return {
      agent: {
        mode: "auto",
        levelRule: a.levelRule,
        level: a.level,
        corporationID: a.corporationID,
        maxJumps: a.maxJumps,
      },
      maxJumps: value.maxJumps,
      missionCount: value.missionCount,
      ...extras,
    };
  return null;
}

/** One ordinary mission. The runner's native Complete receipt owns completion. */
export function civilianDistributionPlan(setup: CivilianDistributionSetup): BotScript {
  const a = setup.agent;
  const beginning: MacroStep[] =
    a.mode === "manual"
      ? [
          {
            id: "agent-station",
            kind: "macro" as const,
            macro: "travel-to-station" as const,
            args: {
              station: {
                kind: "station" as const,
                ref: { entity: "station" as const, id: a.stationID, name: null, systemName: null },
              },
            },
          },
          {
            id: "request",
            kind: "macro" as const,
            macro: "request-mission" as const,
            args: {
              agent: {
                kind: "agent" as const,
                ref: { entity: "agent" as const, id: a.agentID, name: null, systemName: null },
              },
            },
          },
        ]
      : [
          {
            id: "find-agent",
            kind: "macro" as const,
            macro: "find-distribution-agent" as const,
            args: {
              level: { kind: "count" as const, value: a.level },
              fallback: { kind: "toggle" as const, enabled: a.levelRule === "max" },
              maxJumps: { kind: "count" as const, value: a.maxJumps },
              ...(a.corporationID === null
                ? {}
                : { corporation: { kind: "corp" as const, id: a.corporationID, name: null } }),
            },
          },
          { id: "request", kind: "macro" as const, macro: "request-mission" as const, args: {} },
        ];
  return {
    format: "evejs-bot-script",
    version: 1,
    name: "Civilian distribution",
    notes: "One verified Distribution mission.",
    home: { entity: "station", id: null, name: null, systemName: null, starting: true },
    interrupts: [
      { id: "hull-floor", when: { kind: "hull-below", fraction: 0.5 }, respond: "dock-and-pause" },
    ],
    program: [
      ...beginning,
      {
        id: "accept",
        kind: "macro",
        macro: "accept-mission",
        args: {
          maxJumps: { kind: "count", value: setup.maxJumps },
          decline: { kind: "toggle", enabled: false },
        },
      },
      { id: "load", kind: "macro", macro: "load-mission-cargo", args: {} },
      { id: "dropoff", kind: "macro", macro: "travel-to-dropoff", args: {} },
      { id: "complete", kind: "macro", macro: "turn-in-mission", args: {} },
    ],
  };
}
export function distributionSetupJson(setup: CivilianDistributionSetup): JsonValue {
  return setup as unknown as JsonValue;
}
