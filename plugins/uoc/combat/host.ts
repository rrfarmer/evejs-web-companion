import { registerCombatRun } from "./control.ts";
import path from "node:path";
import { createRequire } from "node:module";
import {
  pluginDataDir,
  type BackendRun,
  type PluginRunContext,
} from "../../../web/src/plugin-api/backend.ts";
import { createPilotSession, type PilotSession } from "../../../web/src/plugin-api/pilotSession.ts";
import { decodeSpaceSnapshot } from "../../../web/src/plugin-api/flying.ts";
import { createPilotFighter, SecurityTargetUnobserved } from "./pilotFighter.ts";
import { selectSecurityAgent } from "./agentSelection.ts";
import { securityReadout } from "./readout.ts";
import { isSecurityTarget } from "./securityTargets.ts";
import { securityHistory } from "./history.ts";
import { decodeModuleObservation } from "../shared/moduleObservation.ts";
import { checkedInventory } from "../shared/nativeInventory.ts";
import {
  decodeParkingPolicy,
  parkWithPolicy,
  routeDistances,
  type ParkingPolicy,
} from "../shared/parking.ts";
import { captureReward, compareRewards } from "../shared/rewards/index.ts";
import { registerRun, runExpiry, runOwner } from "../runControl.ts";
import { openCombatStore } from "../operations/combatStore.ts";
import { createSecurityJournal, type SecurityStorage } from "./journal.ts";
import {
  createSecurityCoordinator,
  securityLevelMatches,
  type Command,
  type Identity,
  type Observation,
  type State,
} from "./security.ts";
import {
  checkedJournal,
  conversation,
  securityDungeon,
  securityObjective,
  securityResumePhase,
} from "./native.ts";
import {
  isFleetRewardPolicy,
  withSecurityRewardQuestion,
  type FleetRewardPolicy,
} from "./rewardPolicy.ts";
const require = createRequire(import.meta.url),
  { createDocumentStore } = require("../documentStore.cjs");
type Setup = (
  | { agentID: number }
  | { agent: { mode: "auto"; maxJumps: number | null; corporationID: number | null } }
) & {
  missionCount: number | null;
  rewardPolicy?: FleetRewardPolicy;
  stopAfterMinutes?: number;
  level?: 1 | 2;
  levelRule?: "EXACT" | "UP_TO";
  agentScope?: { systemID?: number; corporationID?: number; maxJumps?: number };
  parking?: ParkingPolicy;
  operationID?: string;
  operationRunID?: string;
  resumeExpected?: { runID: string; acceptedKey: string };
};
const positive = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const fleetQualified = (v: { contentID: number; dungeonID: number }) =>
  (v.contentID === 2925 && v.dungeonID === 1940) ||
  (v.contentID === 13735 && v.dungeonID === 3030) ||
  (v.contentID === 909 && v.dungeonID === 209);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function setupOf(v: unknown): Setup | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>,
    keys = Object.keys(r);
  if (
    keys.some(
      (k) =>
        ![
          "agentID",
          "agent",
          "missionCount",
          "stopAfterMinutes",
          "level",
          "levelRule",
          "agentScope",
          "parking",
          "operationID",
          "operationRunID",
          "resumeExpected",
          "rewardPolicy",
        ].includes(k),
    ) ||
    !(
      (positive(r.missionCount) && r.stopAfterMinutes === undefined) ||
      (r.missionCount === null && positive(r.stopAfterMinutes))
    ) ||
    "agent" in r === "agentID" in r
  )
    return null;
  const parking = r.parking === undefined ? undefined : decodeParkingPolicy(r.parking);
  if (r.parking !== undefined && !parking) return null;
  if (
    (r.level !== undefined && r.level !== 1 && r.level !== 2) ||
    (r.levelRule !== undefined && r.levelRule !== "EXACT" && r.levelRule !== "UP_TO")
  )
    return null;
  const scope = r.agentScope as Record<string, unknown> | undefined;
  if (
    scope !== undefined &&
    (!scope ||
      typeof scope !== "object" ||
      Array.isArray(scope) ||
      Object.keys(scope).some((k) => !["systemID", "corporationID", "maxJumps"].includes(k)) ||
      (scope.systemID !== undefined && !positive(scope.systemID)) ||
      (scope.corporationID !== undefined && !positive(scope.corporationID)) ||
      (scope.maxJumps !== undefined &&
        (!Number.isSafeInteger(scope.maxJumps) || (scope.maxJumps as number) < 0)))
  )
    return null;
  const hasOp = "operationID" in r,
    hasRun = "operationRunID" in r;
  if (
    hasOp !== hasRun ||
    (hasOp &&
      (!(typeof r.operationID === "string" && /^[0-9a-f-]{36}$/i.test(r.operationID)) ||
        !(typeof r.operationRunID === "string" && /^[0-9a-f-]{36}$/i.test(r.operationRunID))))
  )
    return null;
  const resume = r.resumeExpected as Record<string, unknown> | undefined;
  if (
    resume !== undefined &&
    (!hasOp ||
      !resume ||
      typeof resume !== "object" ||
      Array.isArray(resume) ||
      Object.keys(resume).sort().join(",") !== "acceptedKey,runID" ||
      typeof resume.runID !== "string" ||
      !resume.runID ||
      resume.runID.length > 200 ||
      typeof resume.acceptedKey !== "string" ||
      !resume.acceptedKey ||
      resume.acceptedKey.length > 1000)
  )
    return null;
  if (r.rewardPolicy !== undefined && !isFleetRewardPolicy(r.rewardPolicy)) return null;
  const extra = {
    ...(r.rewardPolicy !== undefined ? { rewardPolicy: r.rewardPolicy } : {}),
    ...(r.stopAfterMinutes !== undefined ? { stopAfterMinutes: r.stopAfterMinutes as number } : {}),
    ...(r.level !== undefined ? { level: r.level as 1 | 2 } : {}),
    ...(r.levelRule !== undefined ? { levelRule: r.levelRule as "EXACT" | "UP_TO" } : {}),
    ...(scope ? { agentScope: scope as Setup["agentScope"] } : {}),
    ...(parking ? { parking } : {}),
    ...(resume ? { resumeExpected: resume as Setup["resumeExpected"] } : {}),
    ...(hasOp
      ? { operationID: r.operationID as string, operationRunID: r.operationRunID as string }
      : {}),
  };
  if (positive(r.agentID)) return { agentID: r.agentID, missionCount: r.missionCount, ...extra };
  const a = r.agent as Record<string, unknown> | null;
  if (
    !a ||
    typeof a !== "object" ||
    Array.isArray(a) ||
    Object.keys(a).length !== 3 ||
    a.mode !== "auto" ||
    !(a.maxJumps === null || (Number.isSafeInteger(a.maxJumps) && (a.maxJumps as number) >= 0)) ||
    !(a.corporationID === null || positive(a.corporationID))
  )
    return null;
  return {
    agent: {
      mode: "auto",
      maxJumps: a.maxJumps as number | null,
      corporationID: a.corporationID as number | null,
    },
    missionCount: r.missionCount,
    ...extra,
  };
}
export interface SecurityFleetHooks {
  memberActive?(id: number): boolean;
  memberDecisions?(): readonly unknown[];
  control?(run: PluginRunContext, owner: string, stop: () => void): () => void;
  readonly friendlyMembers?: readonly { characterID: number; shipID: number }[];
  anchor?(): { characterID: number; shipID: number; size: number } | null;
  register(
    run: PluginRunContext,
    session: PilotSession,
    current: () => void,
    settle: () => Promise<void>,
    shipID: number,
    account: string,
  ): void;
  ready(): Promise<boolean>;
  publish(identity: Identity, anchor: { x: number; y: number; z: number }): void;
  everyoneArrived(): boolean;
  selectTarget(targets: readonly number[]): number | null;
  assertTarget(target: number): void;
  settle(): Promise<void>;
  stop(): void;
  finished(receipt: unknown): void;
  diagnostic(kind: string, data: unknown): void;
}
export interface SecurityHostDeps {
  fleet?: SecurityFleetHooks;
  attach?: typeof createPilotSession;
  document?: (run: PluginRunContext) => SecurityStorage;
  telemetry?: (run: PluginRunContext) => SecurityStorage;
  sleep?: (ms: number) => Promise<void>;
}
/** Solo native Security adapter; no fleet coordination and no saved Builder script. */
export function createNativeSecurityRun(deps: SecurityHostDeps = {}): BackendRun {
  return {
    check(value) {
      const setup = setupOf(value);
      return setup
        ? {
            ok: true,
            setup: setup as any,
            name: "Security mission (solo L1)",
            policy: { riskClasses: ["inventory", "combat", "mission"], restartSafe: false },
          }
        : {
            ok: false,
            refusal: "Choose a level 1 or 2 Security agent and a positive number of missions.",
          };
    },
    async start(run) {
      const setup = setupOf(run.setup);
      if (!setup || run.resumed || run.held.characterID !== run.characterID)
        throw new Error(
          "Security setup or held pilot is invalid; unfinished work requires reconciliation.",
        );
      const [owner, expiry] = await Promise.all([runOwner(run), runExpiry(run)]);
      let timeStopAt: number | null = null;
      if (setup.stopAfterMinutes !== undefined) {
        const response = await run.fetch(new URL("/api/bots", run.baseUrl)),
          body = await response.json();
        const matches = Array.isArray(body?.bots)
          ? body.bots.filter((b: any) => b.botID === run.botID && b.characterID === run.characterID)
          : [];
        const started = matches.length === 1 ? Date.parse(matches[0].startedAt) : NaN;
        if (!response.ok || !Number.isFinite(started) || started > Date.now() + 5000)
          throw Error("The hosted start time is unavailable.");
        timeStopAt = started + setup.stopAfterMinutes * 60000;
      }
      let operationWorld: string | null = null;
      if (setup.operationID && setup.operationRunID) {
        const response = await run.fetch(new URL("/api/plugins/uoc/world", run.baseUrl)),
          body = await response.json();
        if (!response.ok || body?.ok !== true || typeof body.worldID !== "string" || !body.worldID)
          throw Error("The Security operation world is unavailable.");
        operationWorld = body.worldID;
        const registry = openCombatStore();
        try {
          registry.bind(
            body.worldID as string,
            setup.operationID,
            setup.operationRunID,
            owner,
            run.characterID,
            setup,
            run.botID,
          );
        } finally {
          registry.close();
        }
      }
      const storageDB = deps.document
        ? null
        : createDocumentStore(path.join(pluginDataDir(), "missions.sqlite"));
      const document = deps.document?.(run) ?? storageDB.document(`security:${run.characterID}`);
      let history: ReturnType<typeof securityHistory>;
      try {
        history = securityHistory(document, owner.toLowerCase(), run.characterID);
      } catch (error) {
        storageDB?.close();
        throw error;
      }
      const storage = history.storage;
      let volatileTelemetry: unknown = null;
      const telemetry = deps.telemetry?.(run) ??
        storageDB?.document(`security-telemetry:${run.characterID}:${run.botID}`) ?? {
          read: () => volatileTelemetry,
          write: (v: unknown) => {
            volatileTelemetry = v;
          },
        };
      const previous = telemetry.read() as any;
      let diagnostics: { runID: string; events: any[] } = { runID: run.botID, events: [] };
      if (previous && previous.runID === run.botID && Array.isArray(previous.events))
        diagnostics = { runID: run.botID, events: previous.events.slice(-63) };
      function diagnostic(kind: string, data: unknown) {
        deps.fleet?.diagnostic(kind, data);
        diagnostics = {
          runID: run.botID,
          events: [...diagnostics.events, { kind, at: Date.now(), data }].slice(-64),
        };
        telemetry.write(diagnostics);
      }
      let active = true,
        stopRequested = false,
        parking = false,
        ended = false,
        fightStarted = false,
        settled = false,
        sequence = 0,
        entryAnchor: { x: number; y: number; z: number } | null = null;
      let task: Promise<void> | null = null,
        parkTask: Promise<void> | null = null,
        session: PilotSession | null = null,
        generation: number | null = null;
      let currentIdentity: Identity | null = null,
        anchorKey: string | null = null,
        droneUnresolved = false,
        lastMissionEvidence = "",
        selectedAgentName: string | null = null;
      const moduleStops = new Set<number>();
      const current = () => {
        if (
          !active ||
          !session ||
          session.flow.flying.sessionGeneration() !== generation ||
          session.flow.flying.isSessionClosing() ||
          (deps.fleet && session.store.station.get().online?.characterID !== run.characterID)
        )
          throw new Error("Security held pilot session changed.");
      };
      const guard = () => {
        current();
        if (
          !parking &&
          (stopRequested ||
            Date.now() >= expiry - 180000 ||
            (timeStopAt !== null && Date.now() >= timeStopAt))
        )
          throw new Error("Security stop requested; productive work is fenced.");
      };
      let lastReadout: unknown = null;
      const report = (phase: string, why: string, readout: unknown = null) => {
        if (readout !== null) lastReadout = readout;
        const anchor = deps.fleet?.anchor?.();
        run.report({
          status: "running",
          phase,
          why,
          readout: (anchor && lastReadout && typeof lastReadout === "object"
            ? {
                ...(lastReadout as object),
                anchor,
                ...(deps.fleet?.memberDecisions
                  ? { memberDecisions: deps.fleet.memberDecisions() }
                  : {}),
              }
            : lastReadout) as any,
        });
      };
      async function get(url: string, body?: unknown, signal?: AbortSignal) {
        current();
        const response = await run.fetch(
          new URL(url, run.baseUrl),
          body === undefined
            ? undefined
            : {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
                ...(signal ? { signal } : {}),
              },
        );
        const data = await response.json();
        current();
        if (!response.ok || data.ok === false)
          throw new Error(data.message ?? data.error ?? "Security read failed.");
        return data;
      }
      async function ask(
        service: string,
        method: string,
        args: unknown[] = [],
        of?: number,
        signal?: AbortSignal,
      ) {
        return (
          await get(
            "/api/bridge/call",
            {
              service,
              method,
              args,
              pilot: true,
              confirm: true,
              ...(of === undefined ? {} : { of }),
            },
            signal,
          )
        ).result;
      }
      async function flight() {
        const f = (await get("/api/bridge/flight/status")).flight;
        if (!f || !positive(f.shipID) || !positive(f.solarSystemID))
          throw new Error("Security pilot location is unreadable.");
        return f;
      }
      async function scene() {
        const raw = (await get("/api/bridge/space/snapshot")).space;
        if (!raw || !Array.isArray(raw.entities))
          throw new Error("Security scene entities are unreadable.");
        const s = decodeSpaceSnapshot(raw);
        if (
          !s.inSpace ||
          s.stateValid === false ||
          !s.ship ||
          s.ship.geometryAvailable !== true ||
          s.shipID !== s.ship.itemID
        )
          throw new Error("Security scene is unreadable.");
        return s;
      }
      async function mission() {
        const j = checkedJournal(await ask("agentMgr", "GetMyJournalDetails"));
        if (
          !j ||
          j.active.length + j.offered.length > 1 ||
          [...j.active, ...j.offered].some((r) => r.agentID !== agentID)
        )
          throw new Error("Security journal is unreadable or a different mission retains custody.");
        if (!j.active.length && !j.offered.length)
          return { journal: j, objective: null, unqualifiedOffer: null };
        const r = await get(`/api/bridge/agents/${agentID}/briefing`);
        if (!r.errors || Object.values(r.errors).some((x) => x !== null))
          throw new Error("Security briefing is unreadable.");
        const objective = securityObjective(r.objective, j, agentID, record?.level ?? 1);
        if (!objective) {
          const offered = j.offered.length === 1 && j.active.length === 0 ? j.offered[0] : null;
          if (offered)
            return {
              journal: j,
              objective: null,
              unqualifiedOffer: {
                agentID: offered.agentID,
                missionID: offered.missionID,
                missionKey: offered.missionKey,
              },
            };
          throw new Error("Security objective or mission identity is unsupported/unreadable.");
        }
        return { journal: j, objective, unqualifiedOffer: null };
      }
      async function dungeon() {
        const d = securityDungeon(await ask("keeper", "GetCurrentDungeonForCharacter"));
        const tracker = await ask("missionTrackerMgr", "IsInActiveDungeonID", [agentID]);
        return tracker === true ? d : null;
      }
      /** Every offensive call is rechecked against the exact accepted mission, current instance and NPC target. */
      async function fenceCombat(target: number | null, allowCompleted = false) {
        guard();
        if (deps.fleet && !(await deps.fleet.ready()))
          throw Error("Native combat fleet roster is not verified.");
        guard();
        const id = currentIdentity;
        if (!id || !positive(id.instanceID)) throw new Error("No current Security room authority.");
        const [f, m, d, s] = await Promise.all([flight(), mission(), dungeon(), scene()]);
        guard();
        if (
          !f.inSpace ||
          f.shipID !== s.shipID ||
          m.objective?.offer.key !== id.acceptedKey ||
          m.objective.offer.status !== "accepted" ||
          !d ||
          d.dungeonID !== id.dungeonID ||
          d.instanceID !== id.instanceID ||
          d.roomID !== id.roomID
        )
          throw new Error("Security mission or room changed before a combat action.");
        if (
          !entryAnchor ||
          !s.ship ||
          Math.hypot(
            s.ship.position.x - entryAnchor.x,
            s.ship.position.y - entryAnchor.y,
            s.ship.position.z - entryAnchor.z,
          ) > 250000
        )
          throw new Error("The Security ship is outside the confirmed mission room.");
        if (target !== null && !s.entities.some((e) => e.itemID === target))
          throw new SecurityTargetUnobserved("Target absent before native engage.");
        if (!allowCompleted && m.objective.objectiveComplete && m.objective.dungeonComplete)
          throw Error("Security objective is already complete.");
        if (
          target !== null &&
          !s.entities.some(
            (e) =>
              e.itemID === target &&
              isSecurityTarget(id, e) &&
              Math.hypot(
                e.position.x - entryAnchor!.x,
                e.position.y - entryAnchor!.y,
                e.position.z - entryAnchor!.z,
              ) <= 500000,
          )
        )
          throw new Error("Combat target is not a freshly observed hostile NPC.");
        if (deps.fleet) {
          deps.fleet.publish(id, entryAnchor);
          if (target !== null) deps.fleet.assertTarget(target);
        }
        diagnostic("scope", {
          characterID: run.characterID,
          shipID: f.shipID,
          acceptedKey: id.acceptedKey,
          dungeon: d,
          anchor: entryAnchor,
          sceneSampledAt: s.sampledAtMs,
        });
      }
      async function fenceFriendly(characterID: number, shipID: number) {
        const member = deps.fleet?.friendlyMembers?.find(
          (m) => m.characterID === characterID && m.shipID === shipID,
        );
        if (
          !member ||
          deps.fleet?.memberActive?.(characterID) === false ||
          characterID === run.characterID
        )
          throw Error("Fleet repair recipient is not a selected fleet member.");
        await fenceCombat(null);
        const s = await scene();
        guard();
        if (
          !entryAnchor ||
          !s.entities.some(
            (e) =>
              e.itemID === shipID &&
              e.kind === "ship" &&
              e.ownerID === characterID &&
              e.geometryAvailable &&
              Math.hypot(
                e.position.x - entryAnchor!.x,
                e.position.y - entryAnchor!.y,
                e.position.z - entryAnchor!.z,
              ) <= 500000,
          )
        )
          throw Error("Fleet repair recipient is not present in the current room.");
      }
      const fencedFetch: typeof fetch = async (input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          run.baseUrl,
        );
        if (
          fightStarted &&
          url.pathname === "/api/bridge/call" &&
          (init?.method ?? "GET").toUpperCase() === "POST" &&
          typeof init?.body === "string"
        ) {
          const body = JSON.parse(init.body),
            key = `${body.service}.${body.method}`,
            a = Array.isArray(body.args) ? body.args : [];
          if (key === "dogmaIM.AddTarget") {
            const member = deps.fleet?.friendlyMembers?.find(
              (m) => m.shipID === Number(a[0]) && m.characterID !== run.characterID,
            );
            if (member) await fenceFriendly(member.characterID, member.shipID);
            else await fenceCombat(Number(a[0]));
          } else if (key === "entity.CmdEngage") await fenceCombat(Number(a[1]));
          else if (key === "dogmaIM.Activate") {
            const target = a[2];
            if (
              target !== null &&
              target !== undefined &&
              target !== 0 &&
              !positive(Number(target))
            )
              throw new Error("Combat target is invalid.");
            const member = deps.fleet?.friendlyMembers?.find(
              (m) => m.shipID === Number(target) && m.characterID !== run.characterID,
            );
            if (member) {
              const remote = session!.flow.flying.resolveRemoteRepModuleIDs();
              if (
                ![...remote.shield, ...remote.armor, ...remote.hull, ...remote.cap].includes(
                  Number(a[0]),
                )
              )
                throw Error("Only a classified remote repair module may target a fleet member.");
              await fenceFriendly(member.characterID, member.shipID);
            } else await fenceCombat(positive(Number(target)) ? Number(target) : null);
          } else if (key === "ship.LaunchDrones") await fenceCombat(null);
          else if (
            ["beyonce.CmdFollowBall", "beyonce.CmdOrbit", "beyonce.CmdKeepAtRange"].includes(key)
          ) {
            const member = deps.fleet?.friendlyMembers?.find(
              (m) => m.shipID === Number(a[0]) && m.characterID !== run.characterID,
            );
            if (member) await fenceFriendly(member.characterID, member.shipID);
            else await fenceCombat(Number(a[0]));
          }
        }
        return run.fetch(input, init);
      };
      try {
        session = await (deps.attach ?? createPilotSession)({ ...run, fetch: fencedFetch });
        generation = session.flow.flying.sessionGeneration();
      } catch (error) {
        storageDB?.close();
        throw error;
      }
      let f: any, record: any;
      let agentID = "agentID" in setup ? setup.agentID : (history.candidate?.agentID ?? 0);
      const journal = createSecurityJournal(storage, {
        accountID: owner.toLowerCase(),
        characterID: run.characterID,
        runID: run.botID,
      });
      try {
        f = await flight();
        history.rollover(f.docked === true);
        if (!agentID) {
          if (!("agent" in setup)) throw Error("Security agent scope is missing.");
          const existing = checkedJournal(await ask("agentMgr", "GetMyJournalDetails"));
          if (!existing || existing.active.length || existing.offered.length)
            throw Error("Existing mission prevents automatic agent selection.");
          const level = setup.level ?? 1,
            rule = setup.levelRule ?? "EXACT",
            levels = rule === "UP_TO" && level === 2 ? [1, 2] : [level],
            pages = [];
          for (const requestedLevel of levels) {
            guard();
            await session!.flow.findAgents({
              kind: "encounter",
              level: requestedLevel,
              limit: 5000,
            });
            guard();
            const page = session!.store.finder.get();
            if (!page.loaded || page.error || page.capped || page.total !== page.agents.length)
              throw Error("Security agent discovery is incomplete.");
            pages.push({ ...page, agents: [...page.agents] });
          }
          const found = {
            loaded: true,
            error: null,
            capped: false,
            total: pages.reduce((n, p) => n + p.agents.length, 0),
            agents: pages.flatMap((p) => p.agents),
          };
          const chosen = await selectSecurityAgent(
            found,
            {
              ...setup.agent,
              systemID: setup.agentScope?.systemID,
              currentStationID: f.docked ? f.stationID : undefined,
              level,
              levelRule: rule,
            },
            async (candidate) => {
              guard();
              const verified = (await get(`/api/bridge/agents/${candidate.agentID}/record`)).agent;
              if (
                !verified ||
                verified.agentID !== candidate.agentID ||
                verified.level !== candidate.level ||
                verified.divisionID !== 24 ||
                verified.agentTypeID !== 2 ||
                verified.stationID !== candidate.stationID ||
                verified.solarSystemID !== candidate.solarSystemID ||
                verified.corporationID !== candidate.corporationID
              )
                throw Error("Security agent record changed during selection.");
              const response = conversation(
                await ask("agentMgr", "DoAction", [null], candidate.agentID),
              );
              if (!response) throw Error("Security agent access could not be read.");
              return response.actions.some((x) => x.button === 2 && positive(x.id));
            },
          );
          agentID = chosen.agentID;
          selectedAgentName = chosen.name;
          diagnostic("agent-auto-selected", {
            agentID,
            name: selectedAgentName,
            maxJumps: setup.agent.maxJumps,
            corporationID: setup.agent.corporationID,
          });
        }
        record = (await get(`/api/bridge/agents/${agentID}/record`)).agent;
        if (
          !record ||
          record.agentID !== agentID ||
          !securityLevelMatches(record.level, setup.level ?? 1, setup.levelRule ?? "EXACT") ||
          record.divisionID !== 24 ||
          record.agentTypeID !== 2 ||
          !positive(record.stationID) ||
          !positive(record.solarSystemID)
        )
          throw new Error("The selected Security agent or requested level was not verified.");
        if (
          (setup.agentScope?.systemID && record.solarSystemID !== setup.agentScope.systemID) ||
          (setup.agentScope?.corporationID &&
            record.corporationID !== setup.agentScope.corporationID)
        )
          throw Error("The selected agent does not match the requested system or corporation.");
        if (setup.agentScope?.maxJumps !== undefined) {
          const graph = await get("/api/map/graph"),
            distance = routeDistances(f.solarSystemID, graph).get(record.solarSystemID);
          if (distance === undefined || distance > setup.agentScope.maxJumps)
            throw Error("The selected agent is outside the requested reachable jump range.");
        }
        // A docked pilot has no current dungeon; the native tracker must still answer
        // a boolean before a request can put a mission in its journal.
        const keeper = await ask("keeper", "GetCurrentDungeonForCharacter"),
          tracker = await ask("missionTrackerMgr", "IsInActiveDungeonID", [record.agentID]);
        if (typeof tracker !== "boolean" || (keeper !== null && !securityDungeon(keeper)))
          throw new Error("Native dungeon or mission tracker authority is unavailable.");
        if (setup.resumeExpected && !history.candidate)
          throw Error("The exact source Security journal is unavailable.");
        if (history.candidate) {
          const prior = history.candidate,
            oldJournal = createSecurityJournal(storage, {
              accountID: owner.toLowerCase(),
              characterID: run.characterID,
              runID: prior.runID,
            });
          const validated = await oldJournal.read();
          const m = await mission();
          const handoffPhase = validated?.identity
            ? securityResumePhase(f, validated.identity, keeper, tracker)
            : null;
          if (
            !validated ||
            (setup.resumeExpected &&
              (prior.runID !== setup.resumeExpected.runID ||
                validated.identity?.acceptedKey !== setup.resumeExpected.acceptedKey)) ||
            (deps.fleet && validated.identity && !fleetQualified(validated.identity)) ||
            !handoffPhase ||
            f.shipID !== validated.shipID ||
            validated.agentID !== agentID ||
            (validated.agentLevel ?? 1) !== record.level ||
            validated.agentStationID !== record.stationID ||
            validated.agentSystemID !== record.solarSystemID ||
            !validated.identity ||
            m.objective?.offer.status !== "accepted" ||
            m.objective.offer.key !== validated.identity.acceptedKey ||
            m.objective.offer.contentID !== validated.identity.contentID ||
            m.objective.offer.dungeonID !== validated.identity.dungeonID ||
            m.objective.offer.destinationSystemID !== validated.identity.destinationSystemID ||
            m.objective.offer.locationNumber !== validated.identity.locationNumber ||
            (setup.missionCount !== null && validated.completed.length >= setup.missionCount)
          )
            throw new Error(
              "Current Security mission, ship or dungeon does not match native custody.",
            );
          await ask("invCache", "InvalidateLocationCache", [f.shipID]);
          const bay = checkedInventory(await ask("invbroker", "List", [87], f.shipID));
          if (
            bay.some(
              (r) => r.ownerID !== run.characterID || r.locationID !== f.shipID || r.flagID !== 87,
            )
          )
            throw new Error("Docked Security drone bay is unreadable.");
          if (!bay.length) {
            if (
              !(await session!.flow.flying.readFit()) ||
              session!.store.fitting.get().activeShipID !== f.shipID
            )
              throw Error("Docked Security fit is unreadable.");
            const weapons = session!.flow.flying.resolveDefenseModuleIDs().weapons,
              remote = session!.flow.flying.resolveRemoteRepModuleIDs();
            if (
              !weapons.length &&
              !(
                deps.fleet &&
                [...remote.shield, ...remote.armor, ...remote.hull, ...remote.cap].length
              )
            )
              throw Error(
                "Docked Security ship has no verified combat drones, weapons or fleet repair.",
              );
          }
          for (const flag of [
            ...Array.from({ length: 24 }, (_, i) => 11 + i),
            ...Array.from({ length: 8 }, (_, i) => 92 + i),
            ...Array.from({ length: 8 }, (_, i) => 125 + i),
          ]) {
            const rows = checkedInventory(await ask("invbroker", "List", [flag], f.shipID));
            for (const r of rows) {
              if (
                r.ownerID !== run.characterID ||
                r.locationID !== f.shipID ||
                r.flagID !== flag ||
                r.categoryID === null
              )
                throw new Error("Docked Security fitting is unreadable.");
              if (r.categoryID === 7) {
                const info = decodeModuleObservation(
                  await ask("dogmaIM", "ItemGetInfo", [r.itemID]),
                  {
                    moduleID: r.itemID,
                    typeID: r.typeID,
                    ownerID: run.characterID,
                    shipID: f.shipID,
                    flagID: flag,
                  },
                );
                if (info.effects.some((e) => e.effectID !== 16))
                  throw new Error("Security module has not settled.");
              }
            }
          }
          if (handoffPhase === "COMBAT") {
            const s = await scene();
            if (s.shipID !== f.shipID || s.solarSystemID !== f.solarSystemID || !s.ship)
              throw Error("Current Security room ship position is unreadable.");
            entryAnchor = s.ship.position;
            anchorKey = validated.identity.acceptedKey;
            diagnostic("current-room-continuation", {
              acceptedKey: anchorKey,
              dungeon: securityDungeon(keeper),
              anchor: entryAnchor,
            });
          }
          history.handoff({
            ...validated,
            revision: 1,
            runID: run.botID,
            deadlineMs: expiry - 180000,
            missionLimit: setup.missionCount,
            phase: handoffPhase!,
            reason: null,
          });
        } else
          await journal.save(null, {
            version: 1,
            revision: 1,
            runID: run.botID,
            accountID: owner.toLowerCase(),
            characterID: run.characterID,
            shipID: f.shipID,
            agentID: record.agentID,
            agentStationID: record.stationID,
            agentSystemID: record.solarSystemID,
            agentLevel: record.level,
            deadlineMs: expiry - 180000,
            missionLimit: setup.missionCount,
            phase: "AGENT",
            reason: null,
            offer: null,
            identity: null,
            pending: null,
            before: null,
            completed: [],
          });
      } catch (error) {
        session.flow.setLivePush(false);
        storageDB?.close();
        throw error;
      }
      const observe = async (): Promise<Observation> => {
        guard();
        const [f, m] = await Promise.all([flight(), mission()]);
        if (deps.fleet) {
          const offer = m.objective?.offer ?? null,
            evidence = JSON.stringify(
              offer
                ? [
                    offer.key,
                    offer.status,
                    offer.contentID,
                    offer.dungeonID,
                    m.objective?.objectiveComplete,
                    m.objective?.dungeonComplete,
                  ]
                : null,
            );
          if (evidence !== lastMissionEvidence) {
            lastMissionEvidence = evidence;
            diagnostic(
              offer
                ? offer.status === "offered"
                  ? "mission-offered"
                  : "mission-accepted"
                : "mission-empty",
              {
                agentID: agentID,
                offer,
                objectiveComplete: m.objective?.objectiveComplete ?? null,
                dungeonComplete: m.objective?.dungeonComplete ?? null,
              },
            );
          }
        }
        const dialogue =
          f.docked && f.stationID === record.stationID
            ? conversation(await ask("agentMgr", "DoAction", [null], record.agentID))
            : null;
        if (f.docked && f.stationID === record.stationID && !dialogue)
          throw new Error("Security agent conversation is unreadable.");
        const state = (await journal.read())!,
          buttons = {
            request: dialogue?.actions.find((a) => a.button === 2)?.id ?? null,
            accept: dialogue?.actions.find((a) => [3, 4, 5].includes(a.button))?.id ?? null,
            complete: dialogue?.actions.find((a) => [6, 7].includes(a.button))?.id ?? null,
          };
        if (state.identity && state.identity.acceptedKey !== anchorKey) {
          if (anchorKey !== null && (!settled || fighter.dirty))
            throw new Error("Prior Security combat has not settled; mission transition blocked.");
          anchorKey = state.identity.acceptedKey;
          entryAnchor = null;
          currentIdentity = null;
          settled = false;
          moduleStops.clear();
        }
        let room: Observation["dungeon"] = null,
          entry: Observation["entry"] = null,
          npcs: number[] | null = null,
          gates: Observation["gates"] = null;
        if (f.inSpace && state.identity) {
          const [d, s] = await Promise.all([dungeon(), scene()]);
          room = d;
          const same =
            d &&
            d.dungeonID === state.identity.dungeonID &&
            (!state.identity.instanceID || d.instanceID === state.identity.instanceID);
          if (same && s.ship && s.shipID === state.shipID && !/warp/i.test(f.shipMode ?? "warp")) {
            if (!entryAnchor && m.objective?.position) entryAnchor = m.objective.position;
            if (state.pending?.kind === "GATE" && d!.roomID !== state.pending.fromRoomID)
              entryAnchor = s.ship.position;
            const near =
              !!entryAnchor &&
              Math.hypot(
                s.ship.position.x - entryAnchor.x,
                s.ship.position.y - entryAnchor.y,
                s.ship.position.z - entryAnchor.z,
              ) <= 250000;
            // This sequence records a fresh keeper/tracker + scene observation; it is
            // not represented as a native push or a dungeon-completion event.
            if (near) {
              entry = {
                sequence: ++sequence,
                at: Date.now(),
                characterID: run.characterID,
                shipID: f.shipID,
                dungeonID: d!.dungeonID,
                instanceID: d!.instanceID,
                roomID: d!.roomID,
                landed: true,
                onEntryGrid: true,
              };
              npcs = s.entities
                .filter(
                  (e) =>
                    isSecurityTarget(state.identity, e) &&
                    Math.hypot(
                      e.position.x - entryAnchor!.x,
                      e.position.y - entryAnchor!.y,
                      e.position.z - entryAnchor!.z,
                    ) <= 500000,
                )
                .map((e) => e.itemID);
              gates = s.entities
                .filter(
                  (e) =>
                    e.groupID === 366 &&
                    e.geometryAvailable === true &&
                    Math.hypot(
                      e.position.x - entryAnchor!.x,
                      e.position.y - entryAnchor!.y,
                      e.position.z - entryAnchor!.z,
                    ) <= 500000,
                )
                .map((e) => ({
                  itemID: e.itemID,
                  distanceM: Math.max(
                    0,
                    Math.hypot(
                      e.position.x - s.ship!.position.x,
                      e.position.y - s.ship!.position.y,
                      e.position.z - s.ship!.position.z,
                    ) -
                      e.radius -
                      s.ship!.radius,
                  ),
                  onEntryGrid: true,
                }));
            }
          }
        }
        const o = m.objective;
        return {
          observedAt: Date.now(),
          characterID: run.characterID,
          shipID: f.shipID,
          agentID: record.agentID,
          agentLevel: record.level,
          agentStationID: record.stationID,
          agentSystemID: record.solarSystemID,
          dockedStationID: f.docked ? f.stationID : null,
          systemID: f.solarSystemID,
          inSpace: f.inSpace === true,
          unqualifiedOffer: m.unqualifiedOffer ?? null,
          inWarp: f.inSpace ? /warp/i.test(f.shipMode ?? "warp") : false,
          mission: o?.offer ?? null,
          buttons,
          routeReachable: o ? o.offer.destinationSystemID === f.solarSystemID : null,
          entry,
          dungeon: room,
          objectiveComplete: o?.objectiveComplete ?? null,
          dungeonObjectiveComplete: o?.dungeonComplete ?? null,
          combatSettled: settled,
          eligibleNpcIDs: npcs,
          gates,
          wallet: null,
          lp: null,
          credits: null,
        };
      };
      const execute = async (command: Command, assertCurrent: () => void) => {
        guard();
        assertCurrent();
        const state = (await journal.read())!,
          f = await flight();
        if (f.shipID !== state.shipID) throw new Error("Security ship changed before dispatch.");
        if (command.kind === "ROUTE_AGENT" || command.kind === "ROUTE_SYSTEM") {
          const destination =
            command.kind === "ROUTE_AGENT" ? state.agentStationID : command.destinationSystemID;
          if (!positive(destination)) throw new Error("Security route destination is unknown.");
          if (command.kind === "ROUTE_SYSTEM" && f.docked && f.solarSystemID === destination) {
            await session!.flow.undock();
            return;
          }
          const r = await session!.flow.startRoute(destination);
          if (!r.started) throw new Error(r.reason);
          return;
        }
        if (
          command.kind === "REQUEST" ||
          command.kind === "ACCEPT" ||
          command.kind === "COMPLETE"
        ) {
          if (!f.docked || f.stationID !== state.agentStationID)
            throw new Error("The exact agent station is required.");
          const m = await mission();
          if (command.kind === "REQUEST" && (m.journal.active.length || m.journal.offered.length))
            throw new Error("Existing mission prevents Request.");
          if (
            command.kind !== "REQUEST" &&
            (!m.objective ||
              m.objective.offer.key !== (state.identity?.acceptedKey ?? state.offer?.key))
          )
            throw new Error("Security mission changed before agent action.");
          if (
            command.kind === "COMPLETE" &&
            (!state.identity || !m.objective?.objectiveComplete || !m.objective.dungeonComplete)
          )
            throw new Error("Native Security objective is not complete.");
          const before =
            command.kind === "COMPLETE"
              ? await captureReward(
                  run,
                  run.characterID,
                  record.agentID,
                  record.corporationID ?? null,
                )
              : null;
          const allowedButtons =
            command.kind === "REQUEST" ? [2] : command.kind === "ACCEPT" ? [3, 4, 5] : [6, 7];
          const c = conversation(await ask("agentMgr", "DoAction", [null], record.agentID));
          const button = c?.actions.find(
            (a) => a.id === command.actionID && allowedButtons.includes(a.button),
          );
          if (!button) throw new Error("Fresh Security agent action changed.");
          guard();
          assertCurrent();
          diagnostic("agent-action-dispatch", {
            commandID: command.id,
            kind: command.kind,
            actionID: button.id,
            agentID: record.agentID,
            missionKey: command.missionKey,
          });
          if (command.kind === "COMPLETE")
            diagnostic("complete-dispatch", {
              commandID: command.id,
              acceptedKey: state.identity?.acceptedKey,
              agentID: record.agentID,
              actionID: button.id,
              objectiveComplete: m.objective?.objectiveComplete,
              dungeonComplete: m.objective?.dungeonComplete,
            });
          const dispatch = (signal?: AbortSignal) =>
            ask("agentMgr", "DoAction", [button.id], record.agentID, signal);
          const response = conversation(
            await (command.kind === "COMPLETE" && state.identity
              ? withSecurityRewardQuestion(
                  session!,
                  state.identity,
                  setup!.rewardPolicy ?? "KEEP",
                  () => {
                    guard();
                    assertCurrent();
                  },
                  dispatch,
                )
              : dispatch()),
          );
          diagnostic("agent-action-response", {
            commandID: command.id,
            kind: command.kind,
            actionID: button.id,
            responseReadable: response !== null,
            completed: response?.completed === true,
          });
          if (command.kind === "REQUEST" && !response)
            throw Error("Security Request response is unreadable; custody retained.");
          if (command.kind === "COMPLETE")
            diagnostic("complete-response", {
              commandID: command.id,
              acceptedKey: state.identity?.acceptedKey,
              completed: response?.completed === true,
            });
          if (command.kind === "COMPLETE" && response?.completed !== true)
            throw Error("The native agent did not confirm Security mission turn-in.");
          if (
            command.kind === "COMPLETE" &&
            response?.completed === true &&
            before &&
            state.identity
          ) {
            const after = await captureReward(
              run,
              run.characterID,
              record.agentID,
              record.corporationID ?? null,
            );
            return {
              completed: true,
              reward: compareRewards(before, after, state.identity.acceptedKey),
            };
          }
          return { completed: response?.completed === true };
        }
        if (command.kind === "MISSION_WARP") {
          const m = await mission();
          if (
            !state.identity ||
            m.objective?.offer.key !== state.identity.acceptedKey ||
            command.locationNumber !== state.identity.locationNumber
          )
            throw new Error("Security mission warp identity changed.");
          if (f.docked) await session!.flow.undock();
          guard();
          assertCurrent();
          await session!.flow.warpToMissionBookmark(
            {
              agentID: record.agentID,
              locationType: "dungeon",
              locationNumber: command.locationNumber!,
              referringAgentID: null,
            } as any,
            0,
          );
          return;
        }
        if (command.kind === "APPROACH_GATE" || command.kind === "GATE") {
          const o = await observe();
          if (
            !state.identity ||
            !positive(command.targetID) ||
            !o.gates?.some(
              (g) =>
                g.itemID === command.targetID &&
                g.onEntryGrid &&
                (command.kind !== "GATE" || g.distanceM <= 2200),
            )
          )
            throw new Error("The exact Security gate is not observable.");
          guard();
          assertCurrent();
          if (command.kind === "APPROACH_GATE")
            await session!.flow.approach(command.targetID, 2000);
          else {
            const fresh = await scene(),
              gate = fresh.entities.find((e) => e.itemID === command.targetID);
            if (
              !gate ||
              gate.groupID !== 366 ||
              gate.typeID === null ||
              [47685, 47686, 48964, 49563, 80944].includes(gate.typeID)
            )
              throw new Error("The observed gate is not an ordinary Security acceleration gate.");
            await session!.flow.flying.bridgeDo(
              "keeper",
              "ActivateAccelerationGate",
              [command.targetID],
              { violateSafetyTimer: 1 },
            );
          }
          return;
        }
      };
      function droneSample(
        s: Awaited<ReturnType<typeof scene>>,
        ids: readonly number[],
        target: number | null,
      ) {
        const npc =
          target === null
            ? null
            : (s.entities.find((e) => e.itemID === target && e.kind === "ship") ?? null);
        return {
          sampledAt: s.sampledAtMs,
          observedAt: Date.now(),
          scope: currentIdentity,
          anchor: entryAnchor,
          shipID: s.shipID,
          shipPosition: s.ship?.position ?? null,
          target,
          npc: npc
            ? {
                itemID: npc.itemID,
                typeID: npc.typeID,
                groupID: npc.groupID,
                shield: npc.shieldRatio,
                armor: npc.armorRatio,
                hull: npc.hullRatio,
                position: npc.position,
              }
            : null,
          drones: ids.map((id) => {
            const d = s.entities.find((e) => e.itemID === id && e.kind === "drone");
            return d
              ? {
                  itemID: id,
                  ownerID: d.ownerID,
                  controllerID: d.controllerID,
                  targetID: d.targetEntityID,
                  activity: d.droneActivity,
                  position: d.geometryAvailable ? d.position : null,
                  distanceToShip:
                    d.geometryAvailable && s.ship?.geometryAvailable
                      ? Math.hypot(
                          d.position.x - s.ship.position.x,
                          d.position.y - s.ship.position.y,
                          d.position.z - s.ship.position.z,
                        )
                      : null,
                  distanceToTarget:
                    d.geometryAvailable && npc?.geometryAvailable
                      ? Math.hypot(
                          d.position.x - npc.position.x,
                          d.position.y - npc.position.y,
                          d.position.z - npc.position.z,
                        )
                      : null,
                }
              : { itemID: id, missing: true };
          }),
        };
      }
      const fighterState = {
        get currentIdentity() {
          return currentIdentity;
        },
        set currentIdentity(value) {
          currentIdentity = value;
        },
        get entryAnchor() {
          return entryAnchor;
        },
        set entryAnchor(value) {
          entryAnchor = value;
        },
        get droneUnresolved() {
          return droneUnresolved;
        },
        set droneUnresolved(value) {
          droneUnresolved = value;
        },
      };
      const fighter = createPilotFighter({
        run,
        session: () => session!,
        state: fighterState,
        current,
        guard,
        flight,
        mission,
        dungeon,
        scene,
        ask,
        diagnostic,
        droneSample,
        fenceCombat,
        fenceRoomForAbsence: () => fenceCombat(null, true),
        ...(deps.fleet?.friendlyMembers
          ? { friendlyMembers: deps.fleet.friendlyMembers, fenceFriendly }
          : {}),
        sleep: deps.sleep ?? sleep,
        moduleStops,
        ...(storageDB
          ? {
              moduleDocuments: {
                locks: storageDB.document(`security-module-lock:${run.botID}`),
                actions: storageDB.document(`security-module-action:${run.botID}`),
                reloads: storageDB.document(`security-module-reload:${run.botID}`),
              },
            }
          : {}),
        checkBeforeEngage: (target) => {
          guard();
          deps.fleet?.assertTarget(target);
        },
        selectTargets: deps.fleet
          ? (targets) => {
              const target = deps.fleet!.selectTarget(targets.map((t) => t.itemID));
              return targets.filter((t) => t.itemID === target);
            }
          : undefined,
      });
      deps.fleet?.register(run, session!, current, () => fighter.settle(current), f.shipID, owner);
      const coordinator = createSecurityCoordinator({
        journal,
        observe,
        execute,
        now: Date.now,
        allowOffer: deps.fleet ? (offer) => fleetQualified(offer) : undefined,
        combat: async (id, assertCurrent) => {
          guard();
          assertCurrent();
          currentIdentity = id;
          fightStarted = true;
          settled = false;
          if (deps.fleet) {
            if (!entryAnchor) throw Error("Security entry anchor is missing.");
            deps.fleet.publish(id, entryAnchor);
            if (!deps.fleet.everyoneArrived()) return;
          }
          await fighter.tick(id, assertCurrent);
        },
        settle: async (assertCurrent) => {
          if (deps.fleet) await deps.fleet.settle();
          else await fighter.settle(assertCurrent);
          settled = true;
          fightStarted = false;
          currentIdentity = null;
        },
      });
      async function park(reason: string) {
        if (parking || ended) return;
        deps.fleet?.stop();
        parking = true;
        await coordinator.stop();
        try {
          if (droneUnresolved)
            throw new Error("A drone command remains in flight; custody is retained.");
          await fighter.settle(current);
          fightStarted = false;
          currentIdentity = null;
          const beforeParking = await journal.read();
          if (!beforeParking) throw new Error("Security journal vanished before parking.");
          lastReadout = securityReadout(beforeParking, diagnostics);
          const result = await parkWithPolicy(
            run,
            session!,
            report,
            current,
            setup!.parking ?? { mode: "nearest" },
          );
          const state = await journal.read();
          if (!state) throw new Error("Security journal vanished during parking.");
          const pending = state.pending !== null,
            finalReadout = securityReadout(state, diagnostics, result),
            receiptPhase =
              setup!.stopAfterMinutes !== undefined &&
              reason.startsWith("Security work time elapsed") &&
              !state.identity &&
              !state.offer &&
              !pending
                ? "DONE"
                : state.phase;
          if (!pending) {
            if (operationWorld && setup!.operationID && setup!.operationRunID) {
              const registry = openCombatStore();
              try {
                registry.finish(
                  operationWorld,
                  setup!.operationID,
                  setup!.operationRunID,
                  owner,
                  run.characterID,
                  run.botID,
                  {
                    phase: receiptPhase,
                    identity: state.identity,
                    completed: state.completed,
                    parking: result,
                    reason,
                  },
                );
              } finally {
                registry.close();
              }
            }
            deps.fleet?.finished({
              phase: receiptPhase,
              identity: state.identity,
              completed: state.completed,
              parking: result,
              reason,
              ...(deps.fleet.anchor?.() ? { anchor: deps.fleet.anchor!() } : {}),
              ...(deps.fleet.memberDecisions
                ? { memberDecisions: deps.fleet.memberDecisions() }
                : {}),
            });
            ended = true;
            unregister();
          } else parking = false;
          const anchor = deps.fleet?.anchor?.();
          run.report({
            status: pending ? "paused" : "stopped",
            phase: pending ? "Docked — reconciliation pending" : "Docked",
            why: pending
              ? `${reason} Security ${state.pending!.kind} remains unresolved; no replay.`
              : reason,
            readout: (anchor ? { ...finalReadout, anchor } : finalReadout) as any,
          });
        } catch (error) {
          parking = false;
          const saved = await journal.read();
          run.report({
            status: "paused",
            phase: "Parking blocked",
            why: error instanceof Error ? error.message : String(error),
            ...(saved ? { readout: securityReadout(saved, diagnostics) as any } : {}),
          });
        }
      }
      const requestStop = () => {
        deps.fleet?.stop();
        stopRequested = true;
        session!.flow.abortRoute();
        void task?.then(() => {
          if (!ended)
            parkTask ??= park("Security stop requested.").finally(() => {
              parkTask = null;
            });
        });
      };
      const unregister =
        deps.fleet?.control?.(run, owner, requestStop) ??
        (setup!.operationID
          ? registerCombatRun(run, owner, requestStop, requestStop)
          : registerRun(run, owner, requestStop));
      task = (async () => {
        try {
          while (active && !stopRequested) {
            if (timeStopAt !== null && Date.now() >= Math.min(timeStopAt, expiry - 180000)) {
              await park("Security work time elapsed; parking after the safety boundary.");
              return;
            }
            if (deps.fleet && !(await deps.fleet.ready())) {
              await (deps.sleep ?? sleep)(1000);
              continue;
            }
            const state = await journal.read();
            if (!state || state.phase === "DONE" || state.phase === "BLOCKED") {
              await park(
                state?.phase === "DONE"
                  ? "Security mission complete."
                  : (state?.reason ?? "Security state unavailable."),
              );
              return;
            }
            await coordinator.tick();
            const latest = await journal.read();
            if (!latest) throw new Error("Security journal vanished after observation.");
            if (
              state.pending?.kind === "COMPLETE" &&
              latest.pending === null &&
              latest.completed.some((c) => c.commandID === state.pending!.id)
            )
              diagnostic("complete-confirmed", {
                commandID: state.pending.id,
                acceptedKey: state.identity?.acceptedKey,
              });
            if (latest.phase === "DONE" || latest.phase === "BLOCKED") continue;
            report(
              latest.phase,
              selectedAgentName
                ? `Security agent: ${selectedAgentName}.`
                : "Observing the exact Security mission.",
              securityReadout(latest, diagnostics),
            );
            await (deps.sleep ?? sleep)(2000);
          }
          if (active && !ended) await park("Security stop requested.");
        } catch (error) {
          if (active && !ended) await park(error instanceof Error ? error.message : String(error));
        }
      })();
      return {
        async stop() {
          if (!active) return;
          deps.fleet?.stop();
          stopRequested = true;
          session!.flow.abortRoute();
          await task;
          await parkTask;
          if (!ended)
            throw new Error(
              "Security custody or pending command is unresolved; release is blocked.",
            );
          active = false;
          unregister();
          session!.flow.setLivePush(false);
          storageDB?.close();
        },
      };
    },
  };
}
export const civilianSecurityRun = createNativeSecurityRun();
