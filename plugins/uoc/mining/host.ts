import { progressDeadline, travelFacts, readAfterTimeout } from "../shared/progressDeadline.ts";
import { uocStore } from "../backendStores.ts";
import { createHash } from "node:crypto";
import { type BackendRun, type PluginRunContext } from "../../../web/src/plugin-api/backend.ts";
import { createPilotSession } from "../../../web/src/plugin-api/pilotSession.ts";
import {
  buildSlots,
  slotFlagOf,
  loadFitting,
  fetchTypeDogma,
  decodeSpaceSnapshot,
  decodeTargetIDs,
  lockTarget,
} from "../../../web/src/plugin-api/flying.ts";
import { decodeCivilianMiningSetup } from "./setup.ts";
import { decodeMiningObjective } from "./objective.ts";
import { miningMissionFit, sameMission } from "./miningMission.ts";
import {
  agentMission,
  checkedJournal,
  conversation,
  checkedInventory,
  missionLabel,
  type MissionJournal,
} from "../distribution/native.ts";
import {
  busyAgentMessage,
  confirmedMissionAccept,
  existingMissionRefusal,
  missionRefusalText,
  referralConflict,
  referralTargets,
} from "../civilian/missionConflict.ts";
import { registerRun, runOwner, runExpiry } from "../runControl.ts";
import type { MiningObjective } from "../shared/missionTypes.ts";
import { unwrapReal, unwrapLong } from "../shared/wire.ts";
import { parkWithPolicy } from "../shared/parking.ts";
import { captureReward, compareRewards } from "../shared/rewards/index.ts";
import { activateDuringOriginalLock, targetGoneRefusal } from "./activation.ts";
import { decodeModuleObservation } from "../shared/moduleObservation.ts";
import { observeMiningCycle } from "../shared/miningCycle.ts";
import { checkedInventory as checkedNativeInventory } from "../shared/nativeInventory.ts";
import { miningAcceptedMission, miningIdentity, rolloverMiningState } from "./history.ts";
import { CivilianMissionMismatch, sameAcceptedMission } from "../civilian/acceptedMission.ts";
import { civilianProvenance, registerCivilianRecovery } from "../civilian/recovery.ts";
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const identity = miningIdentity;
type Store = { read(): any; write(value: any): void };
class RequestedStop extends Error {}
export function createNativeMiningRun(
  deps: {
    shutdown?: AbortSignal;
    attach?: typeof createPilotSession;
    document?: (run: PluginRunContext) => Store;
    wait?: typeof wait;
    now?: () => number;
  } = {},
): BackendRun {
  return {
    check(value) {
      const setup = decodeCivilianMiningSetup(value);
      return setup
        ? {
            ok: true,
            setup: setup as any,
            name: "Civilian mining",
            policy: { riskClasses: ["inventory", "mission"], restartSafe: false },
          }
        : {
            ok: false,
            refusal:
              "Choose one supported Mining mission, an agent or level, corporation and travel limit.",
          };
    },
    async start(run) {
      const setup = decodeCivilianMiningSetup(run.setup);
      if (!setup || run.held.characterID !== run.characterID)
        throw new Error("The held pilot or Mining setup changed.");
      const { store, flow } = await (deps.attach ?? createPilotSession)(run),
        options = flow.requestOptions(),
        sleep = deps.wait ?? wait;
      const [owner, expires] = await Promise.all([runOwner(run), runExpiry(run)]).catch((error) => {
        flow.setLivePush(false);
        throw error;
      });
      const setupKey = hash(setup);
      let state: any,
        continuation = setup.continuation;
      let document: Store;
      try {
        deps.shutdown?.throwIfAborted();
        const db = deps.document ? null : uocStore("missions.sqlite");
        document = deps.document?.(run) ?? db!.document("native-mining:" + run.characterID);
        const legacy = db?.document("mining-missions").read() as
          { records?: Record<string, unknown> } | null | undefined;
        const prior = Object.values(legacy?.records ?? {}).find(
          (r: any) => r.state?.characterID === run.characterID,
        ) as any;
        const previous = document.read(),
          scope = civilianProvenance(run),
          stored = previous?.civilian;
        if (
          stored &&
          scope &&
          (stored.worldID !== scope.worldID ||
            stored.owner !== scope.owner ||
            stored.characterID !== scope.characterID)
        )
          throw new CivilianMissionMismatch(
            "The retained Mining checkpoint belongs to another world or account.",
          );
        if (
          continuation &&
          (!scope ||
            !stored ||
            stored.kind !== "mining" ||
            stored.botID !== (run.resumed ? run.botID : continuation.botID))
        )
          throw new CivilianMissionMismatch(
            "The original Mining checkpoint no longer belongs to this pilot and account.",
          );
        if (
          continuation &&
          previous?.completed === true &&
          previous.completionReceipt?.mission === continuation.key
        ) {
          rolloverMiningState(previous, null, run.characterID, setupKey); // Validate the completed receipt before reporting it.
          run.report({
            status: "stopped",
            phase: "Completed",
            why: "The agent already confirmed this Mining mission.",
            readout: {
              completedCount: 1,
              agentID: continuation.agentID,
              mission: continuation.missionID,
              missionSettled: true,
              pending: null,
              acceptedMission: null,
            },
          });
          flow.setLivePush(false);
          return { stop() {} };
        }
        state = rolloverMiningState(previous, prior?.state ?? null, run.characterID, setupKey);
        if (continuation && !sameAcceptedMission(continuation, miningAcceptedMission(state)))
          throw new CivilianMissionMismatch("The saved accepted Mining mission no longer matches.");
      } catch (error) {
        flow.setLivePush(false);
        throw error;
      }
      const now = deps.now ?? Date.now;
      const windDownAt = Math.min(
        expires - 180000,
        setup.durationMinutes === undefined ? Infinity : now() + setup.durationMinutes * 60000,
      );
      let runCompleted = 0,
        verifiedContinuation = false;
      let active = true,
        stopRequested = false,
        inMutation = false,
        parking = false,
        ended = false,
        released = false,
        task: Promise<void> | null = null,
        parkPromise: Promise<void> | null = null;
      const generation = flow.flying.sessionGeneration();
      const current = () => {
        deps.shutdown?.throwIfAborted();
        if (
          !active ||
          flow.flying.sessionGeneration() !== generation ||
          flow.flying.isSessionClosing()
        )
          throw new Error("Mining pilot session changed.");
      };
      const save = () => {
        current();
        const provenance = civilianProvenance(run);
        if (provenance) state.civilian = provenance;
        document.write(state);
      };
      const missionSettled = () =>
        state.completed === true &&
        state.pending === null &&
        !state.legacy?.cycle &&
        !state.legacy?.pending;
      let currentLocationID: number | undefined;
      const readout = () => ({
        completedCount: runCompleted,
        agentID: state.agentID,
        corporationID: state.agentCorporationID ?? null,
        mission: state.mission?.content.contentID ?? continuation?.missionID ?? null,
        quantity: state.quantity ?? 0,
        pending: state.pending?.kind ?? null,
        legacyCycle: !!state.legacy?.cycle,
        missionSettled: missionSettled(),
        recoveryRequired: !missionSettled(),
        firstFailure: state.lastFailure ?? null,
        reward: state.reward ?? null,
        acceptedMission:
          !continuation || verifiedContinuation ? miningAcceptedMission(state) : null,
        continuing: !!continuation,
        currentLocationID: currentLocationID ?? null,
        missionDestinationID: state.mission?.systemID ?? null,
      });
      const guard = () => {
        current();
        if (!parking && !inMutation && (stopRequested || now() >= windDownAt))
          throw new RequestedStop();
      };
      const report = (
        phase: string,
        why: string,
        travel?: { destinationID: number; returning: boolean },
      ) =>
        run.report({
          status: "running",
          phase,
          why,
          readout: { ...readout(), travel: travel ?? null } as any,
        });
      async function get(url: string, body?: unknown) {
        current();
        const res = await run.fetch(
          new URL(url, run.baseUrl),
          body === undefined
            ? undefined
            : {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              },
        );
        const data = await res.json();
        current();
        if (!res.ok || data.ok === false)
          throw Object.assign(
            new Error(data.message ?? data.refusal?.key ?? data.error ?? "Native request failed."),
            { data, status: res.status },
          );
        return data;
      }
      async function ask(service: string, method: string, args: unknown[] = [], of?: number) {
        return (
          await get("/api/bridge/call", {
            service,
            method,
            args,
            pilot: true,
            confirm: true,
            ...(of === undefined ? {} : { of }),
          })
        ).result;
      }
      async function flight() {
        const f = (await readAfterTimeout(() => get("/api/bridge/flight/status"))).flight;
        if (
          !f ||
          !Number.isSafeInteger(f.shipID) ||
          f.shipID <= 0 ||
          !Number.isSafeInteger(f.solarSystemID)
        )
          throw new Error("Physical pilot location is unreadable.");
        if (state.shipID && state.shipID !== f.shipID) throw new Error("Mining ship changed.");
        state.shipID = f.shipID;
        currentLocationID = f.docked
          ? (f.stationID ?? f.structureID ?? f.solarSystemID)
          : f.solarSystemID;
        return f;
      }
      async function journal() {
        const j = checkedJournal(await ask("agentMgr", "GetMyJournalDetails"), "missions");
        if (!j) throw new Error("Native mission journal is unreadable.");
        return j;
      }
      const agentRecord = async (id: number) =>
        (await get(`/api/bridge/agents/${id}/record`)).agent;
      const agentBriefing = (id: number) => get(`/api/bridge/agents/${id}/briefing`);
      async function dialogue(id: number, action: number | null = null) {
        const c = conversation(await ask("agentMgr", "DoAction", [action], id));
        if (!c) throw new Error("Native agent conversation is unreadable.");
        return c;
      }
      async function objective(id: number) {
        const r = await agentBriefing(id);
        if (!r.errors || Object.values(r.errors).some((x) => x !== null))
          throw new Error("Native objective read is incomplete.");
        const decoded = decodeMiningObjective(r.briefing, r.objective, run.characterID, id);
        if (!decoded.objective) throw new Error(decoded.reason);
        return decoded.objective;
      }
      async function holds() {
        // The supported client-local operation retires only this ship's cached
        // inventory. The following List reads native contents, without reconnecting.
        await ask("invCache", "InvalidateLocationCache", [state.shipID]);
        const r = await get("/api/bridge/ship/ore-hold");
        if (r.activeShipID !== state.shipID || !Array.isArray(r.holds) || !r.holds.length)
          throw new Error("Mining hold identity is unreadable.");
        const flags: Record<string, number> = {
          cargo: 5,
          ore: 134,
          gas: 135,
          ice: 181,
          asteroid: 182,
        };
        const observedFlags = new Set<number>(),
          allIDs = new Set<number>(),
          shipID = state.shipID;
        return (await Promise.all(
          r.holds.map(async (h: any) => {
            const flag = flags[h.key];
            if (
              !flag ||
              observedFlags.has(flag) ||
              h.error !== null ||
              !Array.isArray(h.items) ||
              typeof h.present !== "boolean" ||
              !h.capacity ||
              !Number.isFinite(h.capacity.capacity) ||
              !Number.isFinite(h.capacity.used)
            )
              throw new Error("Mining hold contents or capacity are unreadable.");
            observedFlags.add(flag);
            if (!h.present) {
              if (h.items.length) throw new Error("Native hold contents contradict its capacity.");
              return { ...h, items: [] };
            }
            const rows = checkedNativeInventory(await ask("invbroker", "List", [flag], shipID));
            for (const row of rows) {
              if (
                row.ownerID !== run.characterID ||
                row.locationID !== shipID ||
                row.flagID !== flag ||
                allIDs.has(row.itemID)
              )
                throw new Error("Native Mining hold ownership or row identity changed.");
              allIDs.add(row.itemID);
            }
            return { ...h, items: rows };
          }),
        )) as any[];
      }
      const quantity = (hs: any[], typeID: number) =>
        hs.reduce(
          (n, h) =>
            n +
            h.items
              .filter((i: any) => i.typeID === typeID)
              .reduce((m: number, i: any) => {
                if (!Number.isSafeInteger(i.quantity) || i.quantity < 0)
                  throw new Error("Invalid native ore quantity.");
                return m + i.quantity;
              }, 0),
          0,
        );
      async function hangar(typeID: number) {
        const r = await get("/api/bridge/inventory"),
          f = await flight();
        if (
          !f.docked ||
          r.stationID !== f.stationID ||
          r.activeShipID !== f.shipID ||
          r.hangar?.error !== null
        )
          throw new Error("Mission destination inventory is unreadable.");
        const rows = checkedInventory(r.hangar.list);
        if (!rows) throw new Error("Mission hangar rows are unreadable.");
        return rows.filter((i) => i.typeID === typeID).reduce((n, i) => n + i.quantity, 0);
      }
      async function scene() {
        const r = await get("/api/bridge/space/snapshot"),
          s = decodeSpaceSnapshot(r.space);
        if (s.ship?.itemID !== state.shipID || s.stateValid === false)
          throw new Error("Mining scene identity is unreadable.");
        return s;
      }
      async function travel(destination: number, systemOnly = false, returning = false) {
        const arrived = (f: Awaited<ReturnType<typeof flight>>) =>
          (!f.transition || f.transition.phase === "ready") &&
          (systemOnly
            ? f.inSpace && f.solarSystemID === destination && !/warp/i.test(f.shipMode ?? "")
            : f.docked && f.stationID === destination);
        guard();
        if (arrived(await flight())) return;
        const describeRoute = () =>
          report(
            parking ? "Parking" : "Traveling",
            systemOnly
              ? "Flying to the system named in the Mining mission."
              : "Flying to the verified station.",
            { destinationID: destination, returning },
          );
        describeRoute();
        const started = await flow.startRoute(destination);
        if (!started.started) throw new Error(started.reason);
        const progressing = progressDeadline(3600000, now);
        let lastPosition: unknown;
        while (true) {
          guard();
          const previousLocation = currentLocationID,
            fresh = await flight();
          if (arrived(fresh)) {
            if (systemOnly) flow.abortRoute();
            return;
          }
          if (previousLocation !== currentLocationID) describeRoute();
          const p = flow.flying.autopilotProgress();
          if (p && ["error", "paused", "aborted"].includes(p.status))
            throw new Error(p.failureReason ?? "Navigation stopped.");
          const s = fresh.inSpace ? await scene().catch(() => null) : null;
          if (s?.ship?.position) lastPosition = s.ship.position;
          if (!progressing(travelFacts(fresh, p, lastPosition)))
            throw Error(
              "Navigation made no observable native progress; current location was rechecked. Stop or review the route.",
            );
          await sleep(2000);
        }
      }
      async function fit(family: "ore" | "ice") {
        const raw = await loadFitting(options);
        if (raw.activeShipID !== state.shipID || Object.values(raw.errors).some((x) => x !== null))
          throw new Error("Native fitting is unreadable.");
        const slots = buildSlots(raw.slots, raw.shipInfo, raw.online);
        const modules = slots.flatMap((s) => (s.family === "high" && s.module ? [s.module] : []));
        const facts = await fetchTypeDogma(
          modules.map((m) => m.typeID),
          [73, 77, 182, 183, 184, 1285, 1289, 1290],
          options,
        );
        const selected = miningMissionFit(modules, facts)
          .filter((m) => m.family === family)
          .map((m) => {
            const slot = slots.find((s) => s.module?.itemID === m.itemID),
              flagID = slot ? slotFlagOf(slot.family, slot.index) : null;
            if (!flagID) throw new Error("The mining module's fitted slot is unknown.");
            return { ...m, flagID };
          });
        if (!selected.length) throw new Error("No compatible online native mining module.");
        return selected;
      }
      async function moduleState(m: { itemID: number; typeID: number; flagID: number }) {
        return decodeModuleObservation(await ask("dogmaIM", "ItemGetInfo", [m.itemID]), {
          moduleID: m.itemID,
          typeID: m.typeID,
          ownerID: run.characterID,
          shipID: state.shipID,
          flagID: m.flagID,
        });
      }
      async function mutate<T>(kind: string, details: any, write: () => Promise<T>) {
        guard();
        if (state.pending)
          throw new Error(
            "An earlier " + state.pending.kind + " needs read-only reconciliation; no replay.",
          );
        state.pending = { kind, details, issuedAt: Date.now() };
        save();
        inMutation = true;
        try {
          return await write();
        } finally {
          inMutation = false;
        }
      }
      const settled = () => {
        state.pending = null;
        save();
      };
      function completeMission(id: number, receipt: unknown, j: MissionJournal) {
        state.completed = true;
        state.completedCount = 1;
        state.completionReceipt = {
          agentID: id,
          mission: identity(state.mission),
          native: receipt,
          journal: j,
          at: now(),
        };
        settled();
      }
      async function press(
        id: number,
        kind: "request" | "accept" | "complete",
        journalKey?: string,
      ) {
        if (continuation && kind !== "complete")
          throw Error("Continue can only complete its already accepted Mining mission.");
        const nativeJournal = await readAfterTimeout(journal),
          before = agentMission(nativeJournal, id);
        if (kind === "request") {
          if (before) return busyAgentMessage(before);
          const referral = (await referralTargets(nativeJournal, agentBriefing)).get(id);
          if (referral) return referralConflict(referral, id);
        } else if (
          !before ||
          before.missionKey !== journalKey ||
          before.missionState !== (kind === "accept" ? 1 : 2)
        )
          throw Error("The selected agent's mission changed before " + kind + ".");
        guard();
        const c = await dialogue(id),
          buttons = kind === "request" ? [2] : kind === "accept" ? [3, 5] : [6, 7],
          button = c.actions.find((a) => buttons.includes(a.button));
        if (!button) {
          if (kind === "request") return c.says || "no matching native Request action";
          throw new Error("No native " + kind + " action is currently offered.");
        }
        const rewardBefore =
          kind === "complete"
            ? await captureReward(run, run.characterID, id, state.agentCorporationID ?? null)
            : null;
        const expected = kind === "request" ? null : await objective(id);
        if (
          kind === "complete" &&
          (!expected ||
            expected.completionStatus !== 1 ||
            identity(expected) !== miningAcceptedMission(state)?.key)
        )
          throw Error("The accepted Mining objective changed or is not ready to complete.");
        const fresh = agentMission(await readAfterTimeout(journal), id);
        if (
          fresh?.missionKey !== before?.missionKey ||
          fresh?.missionState !== before?.missionState ||
          (kind === "request"
            ? !!fresh
            : !fresh ||
              fresh.missionID !== expected?.content.contentID ||
              fresh.missionState !== (kind === "accept" ? 1 : 2))
        )
          throw Error("The selected agent's mission changed before " + kind + ".");
        let receipt;
        try {
          receipt = await mutate(
            kind,
            {
              agentID: id,
              actionID: button.id,
              objective: expected,
              ...(kind === "complete" ? { journalKey: fresh?.missionKey } : {}),
            },
            () => dialogue(id, button.id),
          );
        } catch (error) {
          if (continuation && kind === "complete" && state.pending?.kind === "complete") {
            const j = await readAfterTimeout(journal).catch(() => null);
            const terminal = j?.completed?.find(
              (row) => row.agentID === id && row.missionKey === fresh?.missionKey,
            );
            if (j && terminal && !agentMission(j, id)) {
              completeMission(id, { completed: true, journalMission: terminal }, j);
              return;
            }
          }
          const refusal = kind === "request" ? missionRefusalText(error) : null;
          if (refusal && state.pending?.kind === "request" && !agentMission(await journal(), id)) {
            settled();
            return refusal;
          }
          throw error;
        }
        state.pending.receipt = receipt;
        save();
        const j = await journal(),
          after = agentMission(j, id);
        if (kind === "request" && after?.missionState !== 1) {
          if (!after && existingMissionRefusal(receipt.says)) {
            settled();
            return receipt.says;
          }
          throw new Error(
            `Agent ${id}: Request did not produce a confirmed offer. ${receipt.says}`,
          );
        }
        if (kind === "accept") {
          if (
            !confirmedMissionAccept(receipt) ||
            !expected ||
            after?.missionState !== 2 ||
            after.missionID !== before?.missionID
          )
            throw new Error("This run's acceptance of the Mining offer could not be confirmed.");
          const accepted = await objective(id);
          if (accepted.missionState !== 2 || !sameMission(expected, accepted, false))
            throw Error("The accepted Mining objective differs from the offer this run accepted.");
          state.mission = accepted;
          state.acceptedJournalKey = after.missionKey;
          state.acceptedByRun = run.botID;
        }
        if (kind === "complete") {
          if (receipt.completed !== true || after)
            throw new Error("Native completion is unresolved; no repeat.");
          completeMission(id, receipt, j);
        } else settled();
        if (kind === "complete" && rewardBefore) {
          const after = await captureReward(
            run,
            run.characterID,
            id,
            state.agentCorporationID ?? null,
          );
          state.reward = compareRewards(rewardBefore, after, identity(state.mission));
          save();
        }
        return after;
      }
      async function chooseAgent(
        currentJournal: MissionJournal,
        excluded: ReadonlyMap<number, string>,
      ) {
        if (state.legacy?.pending)
          throw new Error(
            "The preserved Mining mutation needs reconciliation before it can be repeated.",
          );
        const a = setup!.agent;
        const eligible = (native: any, id: number) =>
          native?.agentID === id &&
          native.divisionID === 23 &&
          native.agentTypeID === 2 &&
          native.stationID > 0 &&
          (a.mode === "manual"
            ? id === a.agentID
            : (a.corporationID === null || native.corporationID === a.corporationID) &&
              (a.levelRule === "exact"
                ? native.level === a.level
                : native.level >= 1 && native.level <= a.level));
        const retained = miningAcceptedMission(state);
        if (retained && (a.mode !== "manual" || a.agentID === retained.agentID)) {
          const row = agentMission(currentJournal, retained.agentID);
          if (
            row?.missionState === 2 &&
            row.missionID === retained.missionID &&
            (!state.acceptedJournalKey || state.acceptedJournalKey === row.missionKey)
          ) {
            const native = await agentRecord(row.agentID);
            if (eligible(native, row.agentID)) {
              const owned = await objective(row.agentID);
              if (owned.missionState === 2 && identity(owned) === retained.key) {
                state.acceptedJournalKey = row.missionKey;
                return { agent: native, owned };
              }
            }
          }
        }
        if (state.pending || state.legacy?.cycle)
          throw Error(
            "The previous Mining action has no matching accepted mission. Review it before starting another.",
          );
        if (a.mode === "manual") {
          const busy = agentMission(currentJournal, a.agentID);
          if (busy) throw Error(busyAgentMessage(busy));
          return { agent: await agentRecord(a.agentID), owned: null };
        }
        const referrals = await referralTargets(currentJournal, agentBriefing);
        let reason = [...excluded.values()].at(-1);
        for (let level = a.level; level >= (a.levelRule === "max" ? 1 : a.level); level--) {
          guard();
          await flow.findAgents({ kind: "mining", level, limit: 5000 });
          const found = store.finder.get();
          if (!found.loaded || found.error || found.capped || found.total !== found.agents.length)
            throw new Error("Mining agent discovery is incomplete.");
          for (const candidate of found.agents
            .filter(
              (c) =>
                c.level === level &&
                c.missionKind === "mining" &&
                c.stationID &&
                c.jumps !== null &&
                c.jumps <= a.maxJumps &&
                (a.corporationID === null || c.corporationID === a.corporationID),
            )
            .sort(
              (a, b) => (a.jumps ?? Infinity) - (b.jumps ?? Infinity) || a.agentID - b.agentID,
            )) {
            if (excluded.has(candidate.agentID)) continue;
            const busy = agentMission(currentJournal, candidate.agentID);
            if (busy) {
              reason = busyAgentMessage(busy);
              continue;
            }
            guard();
            const native = await agentRecord(candidate.agentID);
            if (native?.divisionID !== 23 || native.agentTypeID !== 2) continue;
            if (
              native.agentID !== candidate.agentID ||
              native.level !== level ||
              native.stationID !== candidate.stationID ||
              native.solarSystemID !== candidate.solarSystemID ||
              (a.corporationID !== null && native.corporationID !== a.corporationID)
            )
              throw new Error("Mining agent directory identity changed.");
            const referral = referrals.get(candidate.agentID);
            if (referral) {
              reason = referralConflict(referral, candidate.agentID);
              continue;
            }
            const c = await dialogue(candidate.agentID);
            if (/standings are not high enough|too low standings/i.test(c.says)) continue;
            if (c.actions.some((x) => x.button === 2)) return { agent: native, owned: null };
            if (c.says) reason = `Agent ${candidate.agentID}: ${c.says}`;
          }
        }
        throw new Error(
          reason ??
            "No accessible Mining agent matches the selected levels, corporation and jump limit.",
        );
      }
      async function pocket(o: MiningObjective) {
        const raw = await ask("keeper", "GetCurrentDungeonForCharacter"),
          parts = Array.isArray(raw) ? raw : (raw as any)?.items;
        const num = (x: any) => Number(unwrapLong(x));
        if (
          !Array.isArray(parts) ||
          num(parts[0]) !== o.content.dungeonID ||
          !Number.isSafeInteger(num(parts[2])) ||
          num(parts[2]) <= 0
        )
          return null;
        if ((await ask("missionTrackerMgr", "IsInActiveDungeonID", [o.agentID])) !== true)
          return null;
        const s = await scene();
        if (!s.inSpace || /warp/i.test((await flight()).shipMode ?? "")) return null;
        if (s.solarSystemID !== o.systemID) return null;
        const rocks = s.entities.filter(
          (e) =>
            e.typeID === o.content.typeID &&
            e.categoryID === 25 &&
            e.groupID === o.content.resourceGroupID &&
            e.remainingQuantity !== 0,
        );
        return { s, rocks, instanceID: num(parts[2]) };
      }
      async function enter(o: MiningObjective) {
        guard();
        if (await pocket(o)) {
          if (
            state.pending?.kind === "mission-warp" &&
            state.pending.details?.mission === identity(o)
          ) {
            state.lastWarpSettlement = {
              intent: state.pending,
              outcome: "ARRIVED_CURRENT_POCKET",
              at: now(),
            };
            settled();
          }
          return;
        }
        if (state.banked === undefined && !(await flight()).docked) await travel(o.stationID);
        const origin = await flight();
        if (origin.solarSystemID !== o.systemID) await travel(o.systemID, true);
        else if (origin.docked) {
          await flow.undock();
          guard();
        }
        if (
          state.pending?.kind === "mission-warp" &&
          state.pending.details?.mission === identity(o) &&
          (await flight()).shipMode !== "WARP"
        ) {
          state.lastWarpSettlement = {
            intent: state.pending,
            outcome: "NO_CURRENT_WARP",
            at: now(),
          };
          settled();
        }
        if (!state.pending)
          await mutate("mission-warp", { mission: identity(o) }, () =>
            flow.warpToMissionBookmark(
              {
                agentID: o.agentID,
                locationType: "dungeon",
                locationNumber: o.locationNumber,
                solarSystemID: o.systemID,
                isAgentBase: false,
                referringAgentID: null,
              },
              0,
            ),
          );
        const progressing = progressDeadline(300000, now);
        let lastPosition: unknown;
        while (true) {
          guard();
          const p = await pocket(o);
          if (p) {
            state.instanceID = p.instanceID;
            settled();
            return;
          }
          const f = await flight(),
            s = f.inSpace ? await scene().catch(() => null) : null;
          if (s?.ship?.position) lastPosition = s.ship.position;
          if (!progressing(travelFacts(f, null, lastPosition)))
            throw Error(
              "Mission warp has no observable native progress; the current pocket/location were rechecked. Continue or Dock/Stop without replaying a mining mutation.",
            );
          await sleep(2000);
        }
      }
      async function mine(o: MiningObjective) {
        const modules = await fit(o.content.family),
          module = modules[0]!;
        let approaching: number | null = null;
        while (true) {
          guard();
          const hs = await holds(),
            q = quantity(hs, o.content.typeID);
          state.quantity = q;
          save();
          const fresh = await objective(o.agentID);
          if (identity(fresh) !== identity(o))
            throw new Error("Accepted mission identity changed.");
          if (
            q >= Math.max(0, o.content.quantity - (state.banked ?? 0)) ||
            fresh.completionStatus === 1
          )
            return;
          const h = [o.content.family === "ice" ? "ice" : "asteroid", "ore", "cargo"]
            .map((key) => hs.find((h) => h.present && h.key === key))
            .find(Boolean);
          if (!h) throw new Error("No compatible hold is available for the mission resource.");
          if (h.capacity.capacity - h.capacity.used + 1e-9 < o.unitVolume) {
            if (q === 0)
              throw new Error(
                "The mining hold has no room for the mission resource. Free some capacity before continuing.",
              );
            await bankCargo(o);
            await enter(o);
            continue;
          }
          const p = await pocket(o);
          if (!p)
            throw new Error("Mission resource grid is unavailable; this is not a clear claim.");
          const retired = new Set(
            (state.retiredTargets ?? [])
              .filter((r: any) => r.mission === identity(o))
              .map((r: any) => r.targetID),
          );
          p.rocks = p.rocks.filter((r) => !retired.has(r.itemID));
          if (!p.rocks.length)
            throw new Error(
              "No remaining native-confirmed mission resource is observable; this is not a completion claim.",
            );
          const ship = p.s.ship!;
          if (ship.geometryAvailable !== true || p.rocks.some((r) => r.geometryAvailable !== true))
            throw new Error("Native mining geometry is unavailable.");
          const distances = p.rocks
            .map((r) => ({
              r,
              d: Math.max(
                0,
                Math.hypot(
                  r.position.x - ship.position.x,
                  r.position.y - ship.position.y,
                  r.position.z - ship.position.z,
                ) -
                  r.radius -
                  ship.radius,
              ),
            }))
            .sort((a, b) => a.d - b.d);
          const target = distances[0]!,
            nativeModule = await moduleState(module),
            range = nativeModule.attributes?.[54];
          if (typeof range !== "number" || !(range > 0))
            throw new Error("Native mining range is unavailable.");
          if (target.d > range * 0.9) {
            report("Approaching", "Closing to the native reported mining range.");
            if (approaching !== target.r.itemID) {
              await flow.approach(target.r.itemID, Math.max(50, range * 0.7));
              approaching = target.r.itemID;
            }
            await sleep(2500);
            continue;
          }
          approaching = null;
          report("Mining", "Locking the exact mission resource.");
          let lockReceipt;
          try {
            lockReceipt = await mutate(
              "target-lock",
              { targetID: target.r.itemID, mission: identity(o) },
              () => lockTarget(flow.flying.bridgeDo, target.r.itemID, null),
            );
          } catch (error) {
            if (!targetGoneRefusal(error)) throw error;
            current();
            state.retiredTargets = [
              ...(state.retiredTargets ?? []),
              {
                targetID: target.r.itemID,
                mission: identity(o),
                intent: state.pending,
                outcome: "REFUSED_TARGET_NOT_FOUND",
                refusal: (error as any).refusal,
                observedAt: Date.now(),
              },
            ];
            settled();
            report("Mining", "The depleted resource is gone; selecting another mission asteroid.");
            continue;
          }
          state.pending.receipt = lockReceipt;
          save();
          guard();
          const originalLock = structuredClone(state.pending);
          // The lock command is not proof of a lock. Observe the same exact target
          // before asking the module to activate.
          // This is the client's event cache. Give it a chance to report the lock;
          // absence is not a native refusal. Mining Activate independently checks the
          // exact server lock before any mining effect or consumable debit.
          let locked = false;
          for (let i = 0; i < 5; i++) {
            guard();
            const locks = await get("/api/bridge/targets");
            const ids = decodeTargetIDs(locks.targetIDs);
            if (ids?.includes(target.r.itemID)) {
              locked = true;
              break;
            }
            await sleep(1000);
          }
          state.lastTargeting = store.targeting.get();
          save();
          if (locked) settled();
          const before = quantity(await holds(), o.content.typeID),
            cycleMs = (await moduleState(module)).attributes?.[73];
          if (typeof cycleMs !== "number" || cycleMs <= 0)
            throw new Error("Native mining cycle duration is unavailable.");
          const activation = await activateDuringOriginalLock(
            {
              characterID: run.characterID,
              shipID: state.shipID,
              moduleID: module.itemID,
              targetID: target.r.itemID,
              mission: identity(o),
              lockOrdinal: originalLock.issuedAt,
              lockIssuedAt: originalLock.issuedAt,
            },
            {
              current,
              nextOrdinal: state.nextActivationOrdinal ?? 1,
              wait: sleep,
              confirmLock: async () =>
                decodeTargetIDs((await get("/api/bridge/targets")).targetIDs)?.includes(
                  target.r.itemID,
                ) === true,
              savePending(attempt) {
                guard();
                state.nextActivationOrdinal = attempt.ordinal + 1;
                state.pending = {
                  kind: "mining-cycle",
                  issuedAt: attempt.issuedAt,
                  ownerRunID: run.botID,
                  originalLock,
                  attempt,
                  details: {
                    moduleID: module.itemID,
                    typeID: module.typeID,
                    flagID: module.flagID,
                    targetID: target.r.itemID,
                    before,
                    cycleMs,
                    mission: identity(o),
                  },
                };
                save();
              },
              saveRefusal(refusal) {
                current();
                state.activationRefusals = [...(state.activationRefusals ?? []), refusal];
                state.pending = originalLock;
                save();
              },
              async native(id, opts) {
                try {
                  guard();
                } catch (error) {
                  if (error instanceof RequestedStop) {
                    state.lastActivationNotDispatched = {
                      intent: state.pending,
                      reason: "STOP_BEFORE_DISPATCH",
                      at: Date.now(),
                    };
                    state.pending = originalLock;
                    save();
                  }
                  throw error;
                }
                inMutation = true;
                // Keep refusal handling around the native dispatch only. State reads
                // after an accepted Activate cannot authorize another activation.
                try {
                  return await flow.flying.bridgeDo("dogmaIM", "Activate", [
                    id,
                    "",
                    opts.targetID,
                    opts.repeat,
                  ]);
                } finally {
                  inMutation = false;
                }
              },
            },
          );
          state.pending.receipt = activation.result;
          save();
          const outcome = await observeMiningCycle({
            targetID: target.r.itemID,
            cycleMs,
            before,
            current: guard,
            module: () => moduleState(module),
            quantity: async () => quantity(await holds(), o.content.typeID),
            onActive(observed) {
              if (!state.pending.activeProof) {
                state.pending.activeProof = observed;
                save();
              }
            },
            onProgress(gain) {
              report(
                "Mining",
                gain > 0
                  ? "Native ore yield observed."
                  : "Waiting for the accepted native mining cycle.",
              );
            },
            wait: sleep,
          });
          state.quantity = before + outcome.gain;
          state.lastCycle = {
            ...state.pending,
            activeObserved: true,
            gain: outcome.gain,
            observedAt: outcome.observedAt,
          };
          settled();
        }
      }
      async function bankCargo(o: MiningObjective, returning = false) {
        await travel(o.stationID, false, returning);
        guard();
        const hs = await holds(),
          before = quantity(hs, o.content.typeID),
          bank = await hangar(o.content.typeID);
        if (continuation && state.pending?.kind === "unload") {
          const intent = state.pending.details;
          if (
            !Number.isSafeInteger(intent?.before) ||
            intent.before <= 0 ||
            !Number.isSafeInteger(intent.bank) ||
            intent.bank < 0 ||
            before !== 0 ||
            bank !== intent.bank + intent.before
          )
            throw Error(
              "The previous Mining unload is still unconfirmed in native inventory. It will not be repeated.",
            );
          settled();
        }
        if (before > 0) {
          const ids = hs.flatMap((h) =>
            h.items.filter((i: any) => i.typeID === o.content.typeID).map((i: any) => i.itemID),
          );
          let responseError: unknown;
          try {
            await mutate("unload", { before, bank, itemIDs: ids }, () =>
              get("/api/bridge/ship/ore-hold/unload", { itemIDs: ids }),
            );
          } catch (error) {
            if (!continuation || state.pending?.kind !== "unload") throw error;
            responseError = error;
          }
          if (
            quantity(await holds(), o.content.typeID) !== 0 ||
            (await hangar(o.content.typeID)) !== bank + before
          )
            throw Error("Native ore transfer needs reconciliation.", { cause: responseError });
          settled();
        }
        state.banked = await hangar(o.content.typeID);
        state.quantity = 0;
        save();
      }
      async function deliver(o: MiningObjective) {
        await bankCargo(o, true);
        const latest = await objective(o.agentID);
        if (identity(latest) !== identity(o) || latest.completionStatus !== 1)
          throw new Error("Native mission objective is not complete.");
        report("Completing", "Submitting the verified Mining objective to the agent.");
        await press(o.agentID, "complete", state.acceptedJournalKey);
      }
      async function reconcileSettledCycle(o: MiningObjective) {
        const legacy = state.pending == null ? state.legacy?.cycle : null;
        const intent = legacy ?? state.pending;
        if (!legacy && intent?.kind !== "mining-cycle") return;
        if (legacy) {
          const f = await flight();
          if (
            state.legacy.characterID !== run.characterID ||
            state.legacy.shipID !== f.shipID ||
            !Number.isSafeInteger(legacy.moduleID)
          )
            throw Error("The retained cycle belongs to another pilot or ship.");
          const m = (await fit(o.content.family)).find((m) => m.itemID === legacy.moduleID);
          if (!m) throw Error("Read the original mining module before continuing its cycle.");
          const observed = await moduleState(m);
          if (observed.effects.some((e) => e.effectID !== 16))
            throw Error(
              "The original mining cycle is still active; leave paused or Dock/Stop before another Activate.",
            );
          const inventory = await holds();
          state.cycleSettlements = [
            ...(state.cycleSettlements ?? []),
            {
              intent: structuredClone(legacy),
              outcome: "NATIVE_EFFECT_SETTLED",
              yieldOutcome: "NOT_ATTRIBUTED",
              module: observed,
              inventory,
              observedAt: now(),
            },
          ];
          state.legacy = { ...state.legacy, cycle: null };
          state.quantity = quantity(inventory, o.content.typeID);
          save();
          return;
        }
        const a = intent.attempt,
          d = intent.details,
          f = await flight();
        if (
          !a ||
          a.characterID !== run.characterID ||
          a.shipID !== state.shipID ||
          a.moduleID !== d?.moduleID ||
          a.targetID !== d?.targetID
        )
          throw new Error("The retained Mining cycle does not match the pilot and exact mission.");
        const rows = (await get("/api/bots")).bots;
        if (
          rows.some(
            (b: any) => b.botID !== run.botID && b.characterID === run.characterID && !b.endedAt,
          )
        )
          throw Error("Another current owner controls this pilot.");
        // The current host-held RPC session proves authority; expired/missing historical bot rows do not determine the current module state.
        const m = (await fit(o.content.family)).find((m) => m.itemID === a.moduleID);
        if (
          !m ||
          (d.typeID !== undefined && d.typeID !== m.typeID) ||
          (d.flagID !== undefined && d.flagID !== m.flagID)
        )
          throw new Error("The original Mining module is no longer fitted.");
        const observed = await moduleState(m);
        if (observed.effects.some((e) => e.effectID !== 16))
          throw new Error("The original Mining effect is still active.");
        const inventory = await holds(),
          q = quantity(inventory, o.content.typeID);
        // This retires physical effect custody, not an unknown yield receipt.
        // Keep the original intent intact; continue from observed owned inventory
        // with a new ordinal, never by replaying its Activate.
        state.cycleSettlements = [
          ...(state.cycleSettlements ?? []),
          {
            intent,
            ownerRunID: intent.ownerRunID ?? null,
            currentOwnerRunID: run.botID,
            outcome: "NATIVE_EFFECT_SETTLED",
            yieldOutcome: "NOT_ATTRIBUTED",
            module: observed,
            inventory,
            stationID: f.stationID,
            observedAt: Date.now(),
          },
        ];
        state.quantity = q;
        settled();
      }
      async function park(reason: string) {
        if (parkPromise) return parkPromise;
        parkPromise = (async () => {
          parking = true;
          report("Parking", reason);
          const f = await flight();
          if (!f.docked) {
            const fits = state.mission ? await fit(state.mission.content.family) : [];
            for (const m of fits) {
              const s = await moduleState(m);
              if (s.activeTargets.length) {
                if (!state.shutdownIntent) {
                  state.shutdownIntent = {
                    moduleID: m.itemID,
                    shipID: state.shipID,
                    issuedAt: Date.now(),
                  };
                  save();
                  try {
                    await flow.flying.bridgeDo("dogmaIM", "Deactivate", [m.itemID, ""]);
                  } catch {
                    /* Observe the original request; never replay it. */
                  }
                }
                for (let i = 0; i < 150; i++) {
                  if (!(await moduleState(m)).activeTargets.length) break;
                  await sleep(2000);
                }
                if ((await moduleState(m)).activeTargets.length)
                  throw new Error("Mining module shutdown remains pending.");
                state.lastShutdown = {
                  intent: state.shutdownIntent,
                  observed: await moduleState(m),
                };
                state.shutdownIntent = null;
                save();
              }
            }
          }
          const chosen = await parkWithPolicy(
            run,
            { store, flow },
            report,
            current,
            setup!.parking ?? { mode: "nearest" },
          );
          state.parkingDestination = chosen;
          save();
          const end = await flight();
          if (!end.docked || !(end.stationID ?? end.structureID))
            throw new Error("Parking docking is unconfirmed.");
          if (state.pending?.kind === "target-lock") {
            const targets = await get("/api/bridge/targets");
            if (Array.isArray(targets.targetIDs) && targets.targetIDs.length === 0) {
              state.lastLockSettlement = {
                intent: state.pending,
                outcome: "SETTLED_DOCKED",
                shipID: end.shipID,
                stationID: end.stationID ?? end.structureID,
                at: Date.now(),
              };
              settled();
            }
          }
          ended = !state.pending;
          if (ended) unregister();
          run.report({
            status: state.pending ? "paused" : "stopped",
            phase: state.pending
              ? "Docked — reconciliation pending"
              : state.completed
                ? "Completed"
                : continuation && state.lastFailure
                  ? "Needs attention"
                  : "Docked",
            why: reason,
            readout: {
              ...readout(),
              parking: {
                state: "DOCKED",
                stationID: end.stationID ?? null,
                structureID: end.structureID ?? null,
                destinationID: end.stationID ?? end.structureID,
                kind: chosen.kind,
                systemID: end.solarSystemID,
                release: "PENDING_CORE",
              },
            } as any,
          });
        })().catch((error) => {
          parking = false;
          parkPromise = null;
          run.report({ status: "paused", phase: "Parking blocked", why: String(error) });
        });
        return parkPromise;
      }
      const requestStop = () => {
        stopRequested = true;
        flow.abortRoute();
        void task?.then(() => {
          if (!ended) void park("Stopped after native settlement.");
        });
      };
      const unregister = registerRun(run, owner, requestStop);
      let workEnded = false;
      const unregisterRecovery = registerCivilianRecovery(
        run,
        async () => {
          current();
          if (!workEnded)
            throw Error(
              "The original Mining executor is still working; read its current progress before reconciliation.",
            );
          const j = await journal(),
            f = await flight();
          if (!state.mission)
            return {
              nativeReconciled: false,
              journalStatus: j.active.length + j.offered.length ? "NONEMPTY" : "EMPTY",
              reason:
                "No exact accepted objective is stored; no mission action or checkpoint was cleared.",
              ...readout(),
            };
          if (agentMission(j, state.agentID)?.missionState !== 2)
            throw Error(
              "The exact accepted Mining journal identity is unavailable; retained custody is unchanged.",
            );
          const o = await objective(state.agentID);
          if (identity(o) !== identity(state.mission) || o.missionState !== 2)
            throw Error("The accepted objective changed; retained custody is unchanged.");
          const before = state.pending;
          if (before?.kind === "mining-cycle") await reconcileSettledCycle(o);
          const result = {
            nativeReconciled: before?.kind === "mining-cycle" && !state.pending,
            journalStatus: "NONEMPTY",
            activeMissions: j.active.length,
            offeredMissions: j.offered.length,
            objectiveState: o.completionStatus,
            cycle:
              state.pending?.kind === "mining-cycle"
                ? "UNKNOWN"
                : state.cycleSettlements?.length
                  ? "NATIVE_EFFECT_SETTLED"
                  : "NO_PENDING_CYCLE",
            reason: state.pending
              ? "The dispatched " + state.pending.kind + " remains unresolved; no replay."
              : "Native accepted mission remains unfinished. Physical cycle settlement does not prove mission completion.",
            ...readout(),
          };
          if (f.docked && !f.inSpace) {
            const id = f.stationID ?? f.structureID,
              kind = f.structureID ? "structure" : "station",
              policy = setup!.parking,
              qualified =
                Number.isSafeInteger(id) &&
                id > 0 &&
                (policy?.mode !== "selected" ||
                  (policy.destinationID === id &&
                    policy.kind === kind &&
                    policy.systemID === f.solarSystemID));
            if (!state.pending) parkPromise = null;
            // A diagnostic check must not navigate, stop a host or release its session.
            // The operator's later Stop uses the unchanged original Parking path.
            if (!qualified)
              result.reason += ` Native dock ${id ?? "unknown"} does not verify the selected Parking destination; use the original Stop control for approved Parking.`;
            run.report({
              status: "paused",
              phase: "Recovery reviewed",
              why: result.reason,
              readout: {
                ...readout(),
                parking: qualified
                  ? {
                      state: "DOCKED",
                      destinationID: id,
                      kind,
                      systemID: f.solarSystemID,
                      release: "UNCONFIRMED",
                    }
                  : null,
              } as any,
            });
          }
          return result;
        },
        async () => {
          current();
          if (!workEnded || ended)
            throw Error("The original executor is already working or has released its session.");
          const mission = miningAcceptedMission(state);
          if (!mission) throw Error("No confirmed accepted Mining mission is available.");
          continuation = { ...mission, botID: run.botID };
          verifiedContinuation = false;
          runCompleted = 0;
          stopRequested = false;
          parkPromise = null;
          workEnded = false;
          task = launchWork();
        },
      );
      async function continueObjective(): Promise<MiningObjective | null> {
        if (!continuation) throw Error("A saved Mining mission is required.");
        const j = await readAfterTimeout(journal),
          row = agentMission(j, continuation.agentID);
        const journalKey = state.pending?.details?.journalKey ?? state.acceptedJournalKey;
        const terminal = j.completed?.find(
          (entry) =>
            entry.agentID === continuation!.agentID &&
            entry.missionID === continuation!.missionID &&
            entry.missionKey === journalKey,
        );
        if (state.pending?.kind === "complete") {
          const { receipt, details } = state.pending;
          if (
            !row &&
            (receipt?.completed === true || terminal) &&
            details?.agentID === continuation.agentID &&
            details.objective?.missionState === 2 &&
            identity(details.objective) === continuation.key
          ) {
            if (!state.mission) state.mission = details.objective;
            completeMission(
              continuation.agentID,
              receipt?.completed === true ? receipt : { completed: true, journalMission: terminal },
              j,
            );
            runCompleted = 1;
            return null;
          }
          throw Error(
            "Mining Complete was already sent, but its result is unconfirmed. It will not be sent again.",
          );
        }
        if (!row && terminal && !state.pending) {
          if (!state.mission) state.mission = state.legacy?.objective;
          completeMission(continuation.agentID, { completed: true, journalMission: terminal }, j);
          runCompleted = 1;
          return null;
        }
        if (
          row?.missionState !== 2 ||
          row.missionID !== continuation.missionID ||
          (journalKey && row.missionKey !== journalKey)
        )
          throw new CivilianMissionMismatch(
            "The saved Mining mission is no longer accepted by this agent. It may have completed or expired.",
          );
        const o = await objective(continuation.agentID);
        if (o.missionState !== 2 || identity(o) !== continuation.key)
          throw new CivilianMissionMismatch(
            "The native Mining objective does not match the saved accepted mission.",
          );
        verifiedContinuation = true;
        if (
          state.legacy?.pending ||
          (state.pending &&
            !["mining-cycle", "mission-warp", "target-lock", "unload"].includes(state.pending.kind))
        )
          throw Error("The previous Mining action requires native reconciliation before Continue.");
        const agent = await agentRecord(o.agentID);
        if (
          agent?.agentID !== o.agentID ||
          agent.stationID !== o.stationID ||
          agent.divisionID !== 23 ||
          agent.agentTypeID !== 2
        )
          throw Error("The saved Mining agent or station is no longer available.");
        state.agentID = o.agentID;
        state.agentStationID = o.stationID;
        state.agentCorporationID = agent.corporationID ?? null;
        state.acceptedJournalKey = row.missionKey;
        state.lastFailure = null;
        save();
        return o;
      }
      async function ordinaryObjective() {
        if (
          state.pending &&
          !["mining-cycle", "mission-warp", "target-lock"].includes(state.pending.kind)
        )
          throw new Error(
            "The previous " + state.pending.kind + " requires read-only reconciliation; no replay.",
          );
        const excluded = new Map<number, string>();
        report("Finding an agent", "Checking available agents and the current mission journal.");
        while (true) {
          const { agent, owned } = await chooseAgent(await journal(), excluded);
          if (
            !agent?.stationID ||
            agent.divisionID !== 23 ||
            agent.agentTypeID !== 2 ||
            (setup!.agent.mode === "manual" && agent.agentID !== setup!.agent.agentID)
          )
            throw new Error("Ordinary Mining agent identity is unverified.");
          if (!owned && (state.mission || state.legacy?.objective)) {
            const { history, ...previous } = state;
            state = rolloverMiningState(null, null, run.characterID, setupKey);
            state.shipID = previous.shipID;
            state.history = [
              ...(history ?? []),
              { ...previous, outcome: "HISTORICAL_OUTCOME_UNKNOWN" },
            ];
          }
          state.agentID = agent.agentID;
          state.agentStationID = agent.stationID;
          state.agentCorporationID = agent.corporationID ?? null;
          save();
          if (owned) {
            if ((await flight()).solarSystemID !== owned.systemID) await travel(agent.stationID);
            await fit(owned.content.family);
            return owned;
          }
          await travel(agent.stationID);
          report("Requesting", "Requesting one Mining mission.");
          const offer = await press(agent.agentID, "request");
          if (typeof offer === "string") {
            const reason = `Agent ${agent.agentID} refused Request: ${offer}`;
            if (setup!.agent.mode === "manual") throw Error(reason);
            excluded.set(agent.agentID, reason);
            continue;
          }
          if (offer?.missionState !== 1) throw Error("Request did not produce a Mining offer.");
          let o: MiningObjective;
          try {
            o = await objective(agent.agentID);
          } catch (error) {
            throw Error(
              `${missionLabel(offer)}: ${String(error)} Review its briefing in the agent journal.`,
            );
          }
          if (o.missionState !== 1 || o.content.contentID !== offer.missionID)
            throw Error("The requested Mining offer changed before review.");
          await fit(o.content.family);
          report("Accepting", "Accepting the checked Mining offer.");
          await press(agent.agentID, "accept", offer.missionKey);
          return state.mission as MiningObjective;
        }
      }
      async function oneMission() {
        guard();
        await flight();
        const o = continuation ? await continueObjective() : await ordinaryObjective();
        if (!o) return;
        state.mission = o;
        save();
        if (state.pending?.kind === "target-lock") {
          const ids = decodeTargetIDs((await get("/api/bridge/targets")).targetIDs),
            f = await flight();
          if (ids?.includes(state.pending.details?.targetID) || (f.docked && ids?.length === 0)) {
            state.lastLockSettlement = {
              intent: state.pending,
              outcome: "CURRENT_NATIVE_TARGET_STATE",
              at: now(),
            };
            settled();
          }
        }
        if (
          state.pending?.kind === "mission-warp" &&
          state.pending.details?.mission !== identity(o)
        )
          throw Error("The retained warp names another mission.");
        await reconcileSettledCycle(o);
        if (state.pending?.kind === "mission-warp" && (await flight()).docked) {
          state.lastWarpSettlement = {
            intent: state.pending,
            outcome: "CURRENTLY_DOCKED",
            at: now(),
          };
          settled();
        }
        report(
          continuation ? "Continuing" : "Entering mission",
          "Working on the exact accepted mission.",
        );
        if (continuation && state.pending?.kind === "unload") await bankCargo(o);
        if (!(await flight()).docked && (continuation || state.banked === undefined))
          await travel(o.stationID);
        if ((await flight()).docked) {
          if ((await flight()).stationID !== o.stationID) await travel(o.stationID);
          state.banked = await hangar(o.content.typeID);
          save();
        }
        // Banked inventory and current holds guide planning, independently of old cycle attribution.
        if ((state.banked ?? 0) + quantity(await holds(), o.content.typeID) < o.content.quantity) {
          await enter(o);
          await mine(o);
        }
        await deliver(o);
        if (!state.completed || state.pending)
          throw new Error("The Mining completion receipt is unresolved; no repeat.");
        runCompleted++;
      }
      async function work() {
        while (
          continuation
            ? runCompleted === 0
            : setup!.durationMinutes !== undefined || runCompleted < setup!.missionCount
        ) {
          guard();
          await oneMission();
          if (
            continuation ||
            (setup!.durationMinutes === undefined && runCompleted >= setup!.missionCount)
          )
            break;
          guard();
          state = rolloverMiningState(state, null, run.characterID, setupKey);
          save();
        }
        await park(`The agent confirmed ${runCompleted} completed Mining mission(s).`);
      }
      function launchWork() {
        return work()
          .catch(async (error) => {
            if (!active || ended || deps.shutdown?.aborted) return;
            const reason = error instanceof RequestedStop ? "Stop requested." : String(error);
            if (continuation && !verifiedContinuation && !(error instanceof RequestedStop)) {
              ended = true;
              unregister();
              run.report({
                status: "error",
                phase: "Needs attention",
                why: reason,
                readout: {
                  ...readout(),
                  ...(error instanceof CivilianMissionMismatch
                    ? { acceptedMission: null, continuationUnavailable: true }
                    : {}),
                  firstFailure: reason,
                } as any,
              });
              return;
            }
            if (error instanceof RequestedStop && continuation) verifiedContinuation = true; // The original acceptance remains recorded when stopped before a native read.
            state.lastFailure = error instanceof RequestedStop ? null : reason;
            save();
            await park(reason);
          })
          .finally(() => {
            workEnded = true;
          });
      }
      task = launchWork();
      return {
        async stop() {
          if (released) return;
          stopRequested = true;
          flow.abortRoute();
          try {
            await task;
            await parkPromise;
          } finally {
            active = false;
            unregisterRecovery();
            unregister();
            flow.setLivePush(false);
            released = true;
          }
        },
      };
    },
  };
}
export const civilianMiningRun = createNativeMiningRun();
