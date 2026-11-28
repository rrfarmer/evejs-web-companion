import { nextLocalID } from "../app/localID.ts";
import { authenticatedJson, ownerOptions, runHosted, type ApiOptions } from "../app/context.ts";
import {
  checkPluginRun,
  createPluginRunGrant,
  startPluginRun,
  listServerBots,
  type JsonValue,
  type ServerBot,
} from "../../../../web/src/plugin-api/index.ts";
import { resolveDestination, resolveAccessibleStructure } from "../app/api.ts";
import { securityTimePolicy } from "../../combat/timePolicy.ts";
import { planFleetMoves } from "../../miningFleet/fleetMoves.ts";
import { selectCombatAnchor } from "../../combat/anchor.ts";
import type {
  CombatDefinition,
  CombatReview,
  CombatRow,
  HostedRunPolicy,
} from "../app/combatOperations.ts";

// Proposed plugin-owned operation API. These calls intentionally fail if the
// backend has not registered the corresponding route; they do not fall back to
// the unrelated stock core operation endpoints or invent a successful launch.
const base = "/api/plugins/uoc/combat-operations";
const route = (id: string, action: string) => `${base}/${encodeURIComponent(id)}/${action}`;
type Candidate = {
  runName:
    "coc-security" | "security-fleet-owner" | "anomaly-fleet-member" | "combat-patrol-member";
  characterID: number;
  accountName: string;
  setup: Record<string, JsonValue>;
  members?: { characterID: number; accountName: string; required: boolean }[];
};
type CheckedActor = {
  characterID: number;
  accountName: string;
  shipID: number;
  runName:
    | "security-fleet-owner"
    | "security-fleet-assistant"
    | "anomaly-fleet-member"
    | "combat-patrol-member";
  policy: Awaited<ReturnType<typeof checkPluginRun>>["policy"];
};
type FittingProof = { characterID: number; fittingID: number; shipID: number; fingerprint: string };
type Checked = {
  preparations?: FittingProof[];
  id: string;
  hash: string;
  candidate: Candidate;
  setup: JsonValue;
  policy: Awaited<ReturnType<typeof checkPluginRun>>["policy"];
  duration: number;
  grantDuration: number;
  actors?: CheckedActor[];
  fleetMoves?: readonly { characterID: number; shipID: number; fromFleetID: number }[];
};
const reviewed = new Map<string, Checked>();
async function actor(accountName: string, characterID: number) {
  const o = await ownerOptions(accountName),
    roster = await authenticatedJson("/api/pilot-training/characters", o);
  if (
    typeof roster.account !== "string" ||
    roster.account.toLowerCase() !== accountName.toLowerCase() ||
    !Array.isArray(roster.characters) ||
    roster.characters.filter((c: any) => c.characterID === characterID).length !== 1
  )
    throw Error("The selected pilot account and roster could not be verified.");
  return o;
}
async function assertPilotFree(o: Awaited<ReturnType<typeof ownerOptions>>, characterID: number) {
  const bots = await listServerBots(o);
  if (bots.some((b) => !b.endedAt))
    throw Error(
      "This account already has an active hosted run; stop and release it before starting.",
    );
  const status = await authenticatedJson(
    `/api/pilot-training/ownership?characterID=${characterID}`,
    o,
  );
  if (
    status.ownership?.characterID !== characterID ||
    status.ownership.owner !== "OFF" ||
    status.ownership.online !== false
  )
    throw Error(
      "The exact pilot is not independently confirmed offline and free; existing ownership is preserved.",
    );
}
async function runtimeAllowed(o: Awaited<ReturnType<typeof ownerOptions>>, duration: number) {
  const response = await authenticatedJson("/api/bots", o),
    policy = response?.hostedRunPolicy;
  if (
    !Number.isSafeInteger(duration) ||
    duration < 1 ||
    !Number.isSafeInteger(policy?.maxRuntimeMinutes) ||
    duration > policy.maxRuntimeMinutes
  )
    throw Error("The selected runtime exceeds the current hosted policy.");
  return policy.maxRuntimeMinutes as number;
}
/** Decimal readbacks are converted only while individual cents stay exactly
 * representable; unavailable or unsafe values remain unknown. */
function rewardNumber(v: unknown): number | null {
  if (typeof v === "number")
    return Number.isFinite(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER / 100 ? v : null;
  if (typeof v !== "string" || v.length > 40 || !/^-?\d+(?:\.\d{1,2})?$/.test(v)) return null;
  const negative = v.startsWith("-"),
    parts = (negative ? v.slice(1) : v).split("."),
    cents = BigInt(parts[0]!) * 100n + BigInt((parts[1] ?? "").padEnd(2, "0"));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(negative ? -cents : cents) / 100;
}
export function mapSecurityReceipt(r: any) {
  const key = r?.missionKey ?? r?.identity?.acceptedKey,
    raw = r?.reward,
    field = (name: string, legacy: string) =>
      rewardNumber(raw ? raw[name] : (r?.[name] ?? r?.[legacy]));
  return {
    identity: { acceptedKey: typeof key === "string" ? key : undefined },
    reward: {
      iskDelta: field("confirmedIsk", "isk"),
      lpDelta: field("observedLpChange", "lp"),
      taxISK: field("withheldIsk", "taxISK"),
      corporationLpDelta: field("observedCorporationLpChange", "corporationLp"),
    },
  };
}
type ExactSecurityProgress = {
  phase: string;
  identity: any;
  completed: ReturnType<typeof mapSecurityReceipt>[];
};
async function exactSecurityProgress(
  accountName: string,
  characterID: number,
  runID: string,
): Promise<ExactSecurityProgress | null> {
  try {
    const opts = await actor(accountName, characterID),
      base = `/api/plugins/uoc/security/${characterID}`,
      q = `runID=${encodeURIComponent(runID)}`,
      progress = await authenticatedJson(`${base}/progress?${q}`, opts);
    if (
      progress?.ok !== true ||
      progress.characterID !== characterID ||
      progress.runID !== runID ||
      typeof progress.phase !== "string" ||
      !Number.isSafeInteger(progress.readout?.completedCount) ||
      progress.readout.completedCount < 0
    )
      throw Error("Security progress identity is unavailable.");
    const count = progress.readout.completedCount,
      completed: ReturnType<typeof mapSecurityReceipt>[] = [],
      keys = new Set<string>();
    let offset = 0;
    do {
      const page = await authenticatedJson(`${base}/receipts?${q}&offset=${offset}`, opts);
      if (
        page?.ok !== true ||
        page.characterID !== characterID ||
        page.runID !== runID ||
        page.completedCount !== count ||
        page.offset !== offset ||
        !Array.isArray(page.entries) ||
        page.entries.length > 20 ||
        page.entries.some(
          (e: any) => typeof e?.missionKey !== "string" || !e.missionKey || keys.has(e.missionKey),
        ) ||
        new Set(page.entries.map((e: any) => e.missionKey)).size !== page.entries.length
      )
        throw Error("Security receipt page changed.");
      for (const entry of page.entries) {
        keys.add(entry.missionKey);
        completed.push(mapSecurityReceipt(entry));
      }
      if (page.nextOffset === null) {
        if (completed.length !== count) throw Error("Security receipt set is incomplete.");
        break;
      }
      if (
        !Number.isSafeInteger(page.nextOffset) ||
        page.nextOffset !== offset + page.entries.length ||
        page.entries.length === 0 ||
        page.nextOffset >= count
      )
        throw Error("Security receipt cursor is invalid.");
      offset = page.nextOffset;
    } while (true);
    return { phase: progress.phase, identity: progress.identity ?? null, completed };
  } catch {
    return null;
  }
}
async function pilotReleased(accountName: string, characterID: number) {
  try {
    const own = await actor(accountName, characterID),
      [status, current] = await Promise.all([
        authenticatedJson(`/api/pilot-training/ownership?characterID=${characterID}`, own),
        authenticatedJson("/api/plugins/uoc/runs/current", own),
      ]);
    return (
      status.ownership?.characterID === characterID &&
      status.ownership.owner === "OFF" &&
      status.ownership.online === false &&
      Array.isArray(current.runs) &&
      !current.runs.some((r: any) => r.characterID === characterID)
    );
  } catch {
    return false;
  }
}
function mappedRun(
  x: any,
  d: CombatDefinition,
  bot: ServerBot | null,
  progress: ExactSecurityProgress | null = null,
  releasedProof = false,
) {
  const receipt = x.receipt,
    ended = x.status === "ENDED",
    released = ended && releasedProof,
    incomplete = x.status === "INTENT";
  const native = x.nativeStatus,
    security = d.mode === "SECURITY_MISSION" || !!x.setup?.missionOwnerID;
  const completed = security
    ? (progress?.completed ??
      (Array.isArray(receipt?.completed) ? receipt.completed.map(mapSecurityReceipt) : []))
    : (native?.completed ?? (Array.isArray(receipt?.completed) ? receipt.completed : []));
  const count =
    typeof (bot?.plugin?.readout as any)?.completedCount === "number"
      ? (bot?.plugin?.readout as any).completedCount
      : null;
  return {
    runID: x.bot_id ?? x.epoch,
    phase: released
      ? "STOPPED"
      : ended
        ? "PARKING"
        : incomplete
          ? "START_UNRESOLVED"
          : (bot?.phase ?? "OBSERVATION_UNAVAILABLE"),
    epoch: Number.isSafeInteger(native?.epoch) ? native.epoch : null,
    waypointIndex: Number.isSafeInteger(native?.waypointIndex)
      ? native.waypointIndex
      : Number.isSafeInteger(receipt?.patrolState?.index)
        ? receipt.patrolState.index
        : null,
    primaryID: Number.isSafeInteger(native?.primaryID) ? native.primaryID : null,
    ...(!released
      ? {
          holdReason: ended
            ? "Parking is confirmed; hosted release has not been observed."
            : incomplete
              ? "Start outcome is unresolved; no duplicate Start will be sent."
              : !bot
                ? "The exact hosted run is unavailable; custody remains retained."
                : undefined,
        }
      : {}),
    ...(!ended && count !== null
      ? { reason: `${count} native-confirmed missions reported for this run.` }
      : {}),
    ...(ended && receipt?.reason ? { stopReason: receipt.reason } : {}),
    members: [
      {
        characterID: x.character_id,
        shipID: null,
        state: released ? "RELEASED" : ended ? "PARKED" : (bot?.status ?? "UNKNOWN"),
      },
    ],
    ...(ended || progress
      ? {
          objective: {
            stage: progress?.phase ?? receipt?.phase ?? "UNKNOWN",
            identity: progress?.identity ?? receipt?.identity ?? undefined,
            completed,
          },
        }
      : {}),
    ...(!security
      ? {
          objective: {
            kind: native?.activity ?? d.mode,
            stage: native?.state ?? receipt?.phase ?? "UNKNOWN",
            identity: native?.site
              ? { ...native.site, name: native.site.label }
              : receipt?.site
                ? { ...receipt.site, name: receipt.site.label }
                : undefined,
            completed,
          },
          ...((native?.waypoint ?? receipt?.waypoint)
            ? { waypoint: native?.waypoint ?? receipt?.waypoint }
            : {}),
        }
      : {}),
    ...(!released ? { recoveryRequired: true } : {}),
  };
}
async function mappedGroup(x: any) {
  const observed = await Promise.all(
    (Array.isArray(x.members) ? x.members : []).map(async (m: any) => {
      let bot: ServerBot | null = null;
      if (typeof m.bot_id === "string")
        try {
          const own = await actor(m.owner, m.character_id),
            name =
              x.setup?.siteSearch || x.setup?.site
                ? "anomaly-fleet-member"
                : x.setup?.mode === "BELT_PATROL" || x.setup?.mode === "GATE_PATROL"
                  ? "combat-patrol-member"
                  : m.character_id === x.character_id
                    ? "security-fleet-owner"
                    : "security-fleet-assistant";
          const found = (await listServerBots(own)).filter(
            (b) =>
              b.botID === m.bot_id &&
              b.characterID === m.character_id &&
              b.kind === "plugin" &&
              b.plugin?.pluginID === "uoc" &&
              b.plugin.run === name,
          );
          if (found.length === 1) bot = found[0]!;
        } catch {
          /* Missing host evidence never proves release. */
        }
      return {
        m,
        bot,
        released: m.status === "PARKED" && (await pilotReleased(m.owner, m.character_id)),
      };
    }),
  );
  const ended = x.status === "ENDED",
    released =
      ended &&
      observed.length > 0 &&
      observed.every(({ m, released }: any) => m.status === "PARKED" && released);
  const ownerEntry = observed.find(({ m }: any) => m.character_id === x.character_id),
    owner = ownerEntry?.bot ?? null,
    ownerRun = ownerEntry?.m?.bot_id;
  const progress =
    typeof ownerRun === "string" && x.setup?.missionOwnerID
      ? await exactSecurityProgress(ownerEntry!.m.owner, x.character_id, ownerRun)
      : null;
  const base = mappedRun(x, {} as CombatDefinition, owner, progress, released),
    decisions = x.nativeStatus?.memberDecisions ?? x.receipt?.memberDecisions ?? [];
  const anchor =
    x.nativeStatus?.anchor ?? (owner?.plugin?.readout as any)?.anchor ?? x.receipt?.anchor;
  const verifiedAnchor =
    anchor &&
    Number.isSafeInteger(anchor.size) &&
    anchor.size > 0 &&
    observed.some(
      ({ m }: any) => m.character_id === anchor.characterID && m.ship_id === anchor.shipID,
    ) &&
    (ended || !decisions.some((d: any) => d.characterID === anchor.characterID))
      ? anchor
      : null;
  const active = observed.find(({ bot }: any) => bot && !bot.endedAt)?.bot,
    unknownStart = observed.some(({ m }: any) => m.status === "DISPATCHED"),
    unavailable = observed.some(
      ({ m, bot }: any) => m.status === "RUNNING" && (!bot || !!bot.endedAt),
    );
  const recoveryRequired =
    !released && (ended || unknownStart || unavailable || decisions.length > 0);
  const holdReason = released
    ? undefined
    : ended
      ? "Native Parking is recorded; independent hosted/session release is not yet confirmed."
      : unknownStart
        ? "A fleet Start outcome is unresolved; no member will be replayed."
        : unavailable
          ? "An exact hosted owner is unavailable. Retained native journals require reconciliation; no release or second Start is inferred."
          : undefined;
  const members = observed.map(({ m, bot, released }: any) => {
    const decision = decisions.find((d: any) => d.characterID === m.character_id);
    return {
      characterID: m.character_id,
      shipID: m.ship_id,
      required: m.required !== 0,
      fittingName: m.preparation?.fittingName ?? null,
      reason: bot?.why ?? decision?.reason ?? m.receipt?.reason ?? null,
      parkingDestination: m.receipt?.parking?.destinationID
        ? { name: String(m.receipt.parking.destinationID) }
        : undefined,
      state:
        m.status === "PARKED"
          ? released
            ? "RELEASED"
            : "PARKED"
          : decision
            ? "RETIRING_UNCONFIRMED"
            : (bot?.status ?? m.status),
    };
  });
  return {
    ...base,
    runID: typeof ownerRun === "string" ? ownerRun : base.runID,
    anchor: verifiedAnchor,
    phase: released
      ? "STOPPED"
      : ended
        ? "PARKING"
        : (active?.phase ??
          (unknownStart ? "START_UNRESOLVED" : unavailable ? "RECOVERY_REQUIRED" : "FORMING")),
    holdReason,
    recoveryRequired,
    members,
    ...(recoveryRequired
      ? {
          recoveryReceipt: {
            runID: typeof ownerRun === "string" ? ownerRun : base.runID,
            verified: false,
            reason: holdReason ?? "A retained member still needs native reconciliation.",
            members: observed.map(({ m, released }: any) => ({
              characterID: m.character_id,
              verified: m.status === "PARKED" && released,
              reason:
                m.status === "PARKED"
                  ? released
                    ? "Native Parking and independent release verified."
                    : "Native Parking recorded; release remains unconfirmed."
                  : "Native custody or dispatch remains retained; no replay.",
            })),
          },
        }
      : {}),
  };
}
export async function listCombatOperations(
  options: ApiOptions,
): Promise<{ operations: CombatRow[]; hostedRunPolicy: HostedRunPolicy | null }> {
  const value = await authenticatedJson(base, options);
  if (!Array.isArray(value.operations) || !("hostedRunPolicy" in value))
    throw new Error("Combat operation registry returned an invalid response.");
  if (value.hostedRunPolicy === null) {
    const bots = await authenticatedJson("/api/bots", options);
    const policy = bots?.hostedRunPolicy;
    if (
      !policy ||
      !Number.isSafeInteger(policy.maxRuntimeMinutes) ||
      policy.maxRuntimeMinutes < 1 ||
      !Number.isSafeInteger(policy.defaultRuntimeMinutes) ||
      !Array.isArray(policy.durationChoices) ||
      !policy.durationChoices.every(
        (n: unknown) =>
          Number.isSafeInteger(n) && (n as number) > 0 && (n as number) <= policy.maxRuntimeMinutes,
      )
    )
      throw new Error("Hosted runtime policy is unavailable.");
    value.hostedRunPolicy = policy;
  }
  const rows = await Promise.all(
    value.operations.map(async (row: any) => {
      const executions = Array.isArray(row.executions) ? row.executions : [],
        latest = executions[0];
      if (!latest) return { definition: row.definition, run: null };
      let bot: ServerBot | null = null;
      if (
        (latest.status === "RUNNING" || latest.status === "ENDED") &&
        typeof latest.bot_id === "string"
      )
        try {
          const opts = await actor(latest.owner, latest.character_id),
            matches = (await listServerBots(opts)).filter(
              (b) =>
                b.botID === latest.bot_id &&
                b.characterID === latest.character_id &&
                b.kind === "plugin" &&
                b.plugin?.pluginID === "uoc" &&
                b.plugin.run === "coc-security",
            );
          if (matches.length === 1) bot = matches[0]!;
        } catch {
          /* Unreadable is not stopped. */
        }
      const progress =
        latest.setup?.registry !== true &&
        typeof latest.bot_id === "string" &&
        row.definition.mode === "SECURITY_MISSION"
          ? await exactSecurityProgress(latest.owner, latest.character_id, latest.bot_id)
          : null;
      return {
        definition: row.definition,
        run:
          latest.setup?.registry === true
            ? await mappedGroup(latest)
            : mappedRun(
                latest,
                row.definition,
                bot,
                progress,
                latest.status === "ENDED" &&
                  (await pilotReleased(latest.owner, latest.character_id)),
              ),
        operationHistory:
          row.definition.mode !== "SECURITY_MISSION"
            ? executions
                .slice(1)
                .filter((x: any) => x.status === "ENDED")
                .map((x: any) => ({
                  runID: x.bot_id ?? x.epoch,
                  activity: row.definition.mode,
                  reason: x.receipt?.reason ?? null,
                  completedCount:
                    row.definition.mode === "COMBAT_ANOMALY" &&
                    Array.isArray(x.receipt?.completed) &&
                    x.receipt.completed.every(
                      (v: any) => v.receipt?.source === "native-dungeon-completed",
                    )
                      ? x.receipt.completed.length
                      : null,
                }))
            : undefined,
        securityRunHistory:
          row.definition.mode === "SECURITY_MISSION"
            ? executions
                .slice(1)
                .filter((x: any) => x.status === "ENDED")
                .map((x: any) => ({
                  runID: x.bot_id,
                  reason: x.receipt?.reason,
                  completed: Array.isArray(x.receipt?.completed)
                    ? x.receipt.completed.map(mapSecurityReceipt)
                    : [],
                }))
            : undefined,
      };
    }),
  );
  return {
    operations: rows as CombatRow[],
    hostedRunPolicy: value.hostedRunPolicy as HostedRunPolicy,
  };
}
export async function saveCombatOperation(
  definition: CombatDefinition,
  options: ApiOptions,
): Promise<void> {
  await authenticatedJson(base, options, definition);
}
export async function reviewCombatOperation(
  id: string,
  options: ApiOptions,
): Promise<CombatReview> {
  reviewed.delete(id);
  const value = await authenticatedJson(route(id, "review"), options, {}),
    r = value.review;
  if (!r || typeof r !== "object" || Array.isArray(r) || typeof r.reviewHash !== "string")
    throw new Error("Combat operation review is unavailable.");
  const candidate = r.launchCandidate as Candidate | null;
  if (!candidate) return r as CombatReview;
  try {
    let opts = options;
    const operationRunID = nextLocalID();
    let maximum = 4320;
    if (candidate.runName === "coc-security" || candidate.runName === "security-fleet-owner") {
      opts = await actor(candidate.accountName, candidate.characterID);
      maximum = await runtimeAllowed(opts, r.definition.durationMinutes);
      await assertPilotFree(opts, candidate.characterID);
    }
    const proofs: FittingProof[] = [],
      prepared = new Map<number, { fittingName: string | null; reason: string | null }>(),
      skipped = new Map<number, string>();
    for (const member of r.definition.members as CombatDefinition["members"])
      if (member.preparation?.fittingID !== undefined) {
        let dispatched = false;
        try {
          const fittingID = member.preparation.fittingID;
          if (!Number.isSafeInteger(fittingID) || fittingID <= 0)
            throw Error("Selected fitting identity is unavailable.");
          const own = await actor(member.accountName, member.characterID);
          await assertPilotFree(own, member.characterID);
          dispatched = true;
          const result = await runHosted(
            member.characterID,
            "mcc-prepare",
            {
              operationID: id,
              operationRunID,
              role: "COMBAT",
              reviewOnly: true,
              verifyEquipment: true,
              preparation: { source: { kind: "hangar" }, fittingID, suppliesRequired: false },
            },
            own,
          );
          dispatched = false;
          const v = result.readout as any;
          if (
            result.phase !== "Mining member prepared" ||
            !v ||
            v.characterID !== member.characterID ||
            v.operationID !== id ||
            v.operationRunID !== operationRunID ||
            v.equipment !== "VERIFIED" ||
            !["VERIFIED", "DEGRADED"].includes(v.state)
          )
            throw Error("The selected fitting could not be verified on its own pilot.");
          if (
            !Number.isSafeInteger(v.shipID) ||
            v.shipID <= 0 ||
            typeof v.definitionFingerprint !== "string" ||
            !v.definitionFingerprint
          )
            throw Error("Exact selected fitting fingerprint and ship are unavailable.");
          proofs.push({
            characterID: member.characterID,
            fittingID,
            shipID: v.shipID,
            fingerprint: v.definitionFingerprint,
          });
          prepared.set(member.characterID, {
            fittingName: typeof v.fittingName === "string" ? v.fittingName : null,
            reason: typeof v.reason === "string" ? v.reason : null,
          });
        } catch (error) {
          if (
            dispatched ||
            member.required !== false ||
            (candidate.runName === "security-fleet-owner" &&
              member.characterID === candidate.characterID)
          )
            throw error;
          skipped.set(member.characterID, error instanceof Error ? error.message : String(error));
        }
      }
    let selectedSetup = candidate.setup;
    const parking = candidate.setup.parking as Record<string, JsonValue> | undefined;
    if (parking?.mode === "selected") {
      if (typeof parking.destinationID !== "number")
        throw Error("Parking destination is unavailable.");
      const destination =
        parking.kind === "structure" ? null : await resolveDestination(parking.destinationID, opts);
      if (
        destination &&
        (destination.lookupFailed ||
          destination.kind !== parking.kind ||
          destination.stationID !== parking.destinationID ||
          !Number.isSafeInteger(destination.solarSystemID) ||
          !destination.solarSystemID ||
          destination.solarSystemID <= 0)
      )
        throw Error("The selected parking destination could not be verified.");
      if (destination)
        selectedSetup = {
          ...candidate.setup,
          parking: { ...parking, systemID: destination.solarSystemID },
        };
      else if (candidate.runName === "coc-security") {
        const dock = await resolveAccessibleStructure(
          parking.destinationID,
          opts,
          candidate.characterID,
        );
        selectedSetup = {
          ...candidate.setup,
          parking: { ...parking, systemID: dock.solarSystemID },
        };
      }
    }
    let setup: JsonValue,
      actors: CheckedActor[] | undefined,
      fleetMoves: ReturnType<typeof planFleetMoves> = [];
    if (
      candidate.runName === "security-fleet-owner" ||
      candidate.runName === "anomaly-fleet-member" ||
      candidate.runName === "combat-patrol-member"
    ) {
      if (
        !candidate.members ||
        candidate.members.length < (candidate.runName === "security-fleet-owner" ? 2 : 1)
      )
        throw Error("Fleet roster is unavailable.");
      const inspected: {
        characterID: number;
        accountName: string;
        shipID: number;
        shipClass: number | null;
        fleet: any;
        observedAt: number;
      }[] = [];
      for (const member of candidate.members) {
        if (skipped.has(member.characterID)) continue;
        let dispatched = false;
        try {
          const o = await actor(member.accountName, member.characterID);
          maximum = Math.min(maximum, await runtimeAllowed(o, r.definition.durationMinutes));
          await assertPilotFree(o, member.characterID);
          if (parking?.mode === "selected" && parking.kind === "structure") {
            const dock = await resolveAccessibleStructure(
              Number(parking.destinationID),
              o,
              member.characterID,
            );
            if (!Number.isSafeInteger(dock.solarSystemID) || Number(dock.solarSystemID) <= 0)
              throw Error("Pilot-specific structure system is unverified.");
            const prior = (selectedSetup.parking as any)?.systemID;
            if (prior !== null && prior !== undefined && prior !== dock.solarSystemID)
              throw Error("Selected structure observations disagree.");
            selectedSetup = {
              ...selectedSetup,
              parking: { ...parking, systemID: dock.solarSystemID },
            };
          }
          const inspectionRun =
            candidate.runName === "anomaly-fleet-member"
              ? "anomaly-fleet-inspect"
              : "coc-fleet-inspect";
          dispatched = true;
          const result = await runHosted(member.characterID, inspectionRun, {}, o);
          dispatched = false;
          const v = result.readout as any;
          if (
            result.phase !==
              (candidate.runName === "anomaly-fleet-member"
                ? "Combat anomaly inspection complete"
                : "Fleet Security pilot inspected") ||
            !v ||
            v.characterID !== member.characterID ||
            ![v.shipID, v.stationID, v.systemID].every(
              (n: any) => Number.isSafeInteger(n) && n > 0,
            ) ||
            (!v.fleet && candidate.members!.length > 1) ||
            !Number.isFinite(v.observedAt)
          )
            throw Error("A fleet pilot ship, dock or native fleet inspection is unavailable.");
          if (candidate.runName === "combat-patrol-member" && v.systemID !== selectedSetup.systemID)
            throw Error("A patrol pilot is outside the selected system.");
          if (
            candidate.runName === "anomaly-fleet-member" &&
            (v.systemID !== selectedSetup.systemID ||
              v.nativeResources?.fits !== true ||
              !(
                (Array.isArray(v.droneBay) && v.droneBay.length > 0) ||
                (Number.isSafeInteger(v.combatModules?.weapons) && v.combatModules.weapons > 0) ||
                (candidate.members!.length > 1 &&
                  Number.isSafeInteger(v.combatModules?.remoteRepair) &&
                  v.combatModules.remoteRepair > 0)
              ))
          )
            throw Error(
              "An anomaly pilot is outside the selected system or lacks verified drones, weapons or fleet repair.",
            );
          const proof = proofs.find((p) => p.characterID === member.characterID);
          if (proof && proof.shipID !== v.shipID)
            throw Error("Prepared ship changed before combat inspection.");
          inspected.push({
            ...member,
            shipID: v.shipID,
            shipClass: Number.isSafeInteger(v.shipClass) && v.shipClass > 0 ? v.shipClass : null,
            fleet: v.fleet,
            observedAt: v.observedAt,
          });
        } catch (error) {
          if (
            dispatched ||
            member.required ||
            (candidate.runName === "security-fleet-owner" &&
              member.characterID === candidate.characterID)
          )
            throw error;
          skipped.set(member.characterID, error instanceof Error ? error.message : String(error));
        }
      }
      if (inspected.length < (candidate.runName === "security-fleet-owner" ? 2 : 1))
        throw Error("Not enough verified pilots remain for this fleet.");
      if (new Set(inspected.map((m) => m.shipID)).size !== inspected.length)
        throw Error("Fleet pilots must have distinct ships.");
      if (
        inspected.some(
          (m) => m.observedAt > Date.now() + 5000 || Date.now() - m.observedAt > 120000,
        )
      )
        throw Error("Fleet observations expired; inspect again.");
      const autonomousAnchor = selectCombatAnchor(inspected);
      if (!autonomousAnchor)
        throw Error("No selected ship has a verified supported anchor hull class.");
      selectedSetup =
        candidate.runName === "security-fleet-owner"
          ? { ...selectedSetup, anchorID: autonomousAnchor.characterID }
          : { ...selectedSetup, leaderID: autonomousAnchor.characterID };
      if (candidate.runName !== "security-fleet-owner") {
        candidate.characterID = autonomousAnchor.characterID;
        candidate.accountName = autonomousAnchor.accountName;
        opts = await actor(candidate.accountName, candidate.characterID);
      }
      fleetMoves =
        inspected.length > 1
          ? planFleetMoves(inspected, autonomousAnchor?.characterID ?? candidate.characterID)
          : [];
      setup = {
        operationID: id,
        operationRunID,
        ...(candidate.runName === "security-fleet-owner"
          ? { missionOwnerID: candidate.characterID }
          : {}),
        ...selectedSetup,
        ...(fleetMoves.length ? { fleetMoves } : {}),
        members: inspected.map((m) => ({
          characterID: m.characterID,
          shipID: m.shipID,
          required: candidate.members!.find((p) => p.characterID === m.characterID)!.required,
        })),
        registry: true,
      } as unknown as JsonValue;
      actors = [];
      for (const m of inspected) {
        const o = await actor(m.accountName, m.characterID),
          runName =
            candidate.runName === "anomaly-fleet-member"
              ? "anomaly-fleet-member"
              : candidate.runName === "combat-patrol-member"
                ? "combat-patrol-member"
                : m.characterID === candidate.characterID
                  ? "security-fleet-owner"
                  : "security-fleet-assistant",
          check = await checkPluginRun("uoc", runName, setup, o);
        if (JSON.stringify(check.setup) !== JSON.stringify(setup))
          throw Error("The inspected fleet setup changed.");
        actors.push({ ...m, runName, policy: check.policy });
      }
    } else setup = { ...selectedSetup, operationID: id, operationRunID } as JsonValue;
    const check = await checkPluginRun("uoc", candidate.runName, setup, opts);
    if (JSON.stringify(check.setup) !== JSON.stringify(setup))
      throw Error("Hosted Security canonical setup differs; review again.");
    const requested = r.definition.durationMinutes,
      timed = candidate.setup.missionCount === null,
      timePolicy = timed ? securityTimePolicy(requested, maximum) : undefined,
      grantDuration = timePolicy?.grantMinutes ?? requested;
    if (grantDuration < 4)
      throw Error("Security hosting requires at least four minutes including cleanup.");
    createPluginRunGrant(check.policy, grantDuration);
    for (const a of actors ?? []) createPluginRunGrant(a.policy, grantDuration);
    reviewed.set(id, {
      id,
      hash: r.reviewHash,
      candidate,
      setup: check.setup,
      policy: check.policy,
      duration: requested,
      grantDuration,
      preparations: proofs.filter(
        (p) => !actors || actors.some((a) => a.characterID === p.characterID),
      ),
      ...(actors ? { actors } : {}),
      ...(fleetMoves.length ? { fleetMoves } : {}),
    });
    return {
      ...r,
      ...(timePolicy ? { timePolicy } : {}),
      ...(fleetMoves.length ? { fleetMoves } : {}),
      canStart: true,
      blockers: [],
      preparation: {
        state: "CHECKED",
        members: [
          ...(actors ?? [{ characterID: candidate.characterID }]).map((a) => ({
            characterID: a.characterID,
            state: "CHECKED",
            fittingName: prepared.get(a.characterID)?.fittingName ?? null,
            reason:
              prepared.get(a.characterID)?.reason ??
              (actors
                ? "Docked ship inspected; hosted fleet policy verified."
                : "Pilot account and hosted run policy verified. Ship and mission eligibility are verified by the host after Start."),
          })),
          ...[...skipped].map(([characterID, reason]) => ({
            characterID,
            state: "BLOCKED",
            fittingName: null,
            reason: `Optional pilot omitted: ${reason}`,
          })),
        ],
      },
    } as CombatReview;
  } catch (error) {
    return {
      ...r,
      canStart: false,
      blockers: [error instanceof Error ? error.message : String(error)],
    } as CombatReview;
  }
}
export async function startCombatOperation(
  id: string,
  reviewHash: string,
  approval?: { fleetMovesApproved?: boolean },
): Promise<void> {
  const r = reviewed.get(id);
  if (!r || r.hash !== reviewHash) throw Error("Review this exact operation again.");
  if (r.fleetMoves?.length && approval?.fleetMovesApproved !== true)
    throw Error(
      "Explicit approval is required before moving the named pilots from their current fleets.",
    );
  reviewed.delete(id);
  const o = await actor(r.candidate.accountName, r.candidate.characterID),
    setup = r.setup as Record<string, JsonValue>;
  for (const proof of r.preparations ?? []) {
    const member = r.actors?.find((a) => a.characterID === proof.characterID) ?? r.candidate,
      own = await actor(member.accountName, proof.characterID);
    await assertPilotFree(own, proof.characterID);
    const result = await runHosted(
        proof.characterID,
        "mcc-prepare",
        {
          operationID: id,
          operationRunID: setup.operationRunID,
          role: "COMBAT",
          reviewOnly: true,
          verifyEquipment: true,
          preparation: {
            source: { kind: "hangar" },
            fittingID: proof.fittingID,
            suppliesRequired: false,
          },
        } as JsonValue,
        own,
      ),
      v = result.readout as any;
    if (
      result.status !== "stopped" ||
      result.phase !== "Mining member prepared" ||
      v?.equipment !== "VERIFIED" ||
      v.characterID !== proof.characterID ||
      v.shipID !== proof.shipID ||
      v.definitionFingerprint !== proof.fingerprint ||
      v.operationID !== id ||
      v.operationRunID !== setup.operationRunID
    )
      throw Error("Selected fitting or ship changed since Review; no fleet Start was sent.");
  }
  if (r.actors) {
    const checked: {
      actor: CheckedActor;
      options: Awaited<ReturnType<typeof ownerOptions>>;
      grant: ReturnType<typeof createPluginRunGrant>;
    }[] = [];
    for (const a of r.actors) {
      const opts = await actor(a.accountName, a.characterID),
        maximum = await runtimeAllowed(opts, r.duration);
      if (r.grantDuration > maximum) throw Error("Hosted runtime policy changed; review again.");
      await assertPilotFree(opts, a.characterID);
      const check = await checkPluginRun("uoc", a.runName, r.setup, opts);
      if (
        JSON.stringify(check.setup) !== JSON.stringify(r.setup) ||
        JSON.stringify(check.policy) !== JSON.stringify(a.policy)
      )
        throw Error("Fleet setup or policy changed; review again.");
      checked.push({
        actor: a,
        options: opts,
        grant: createPluginRunGrant(check.policy, r.grantDuration),
      });
    }
    await authenticatedJson(route(id, "group/start"), o, {
      confirm: true,
      reviewHash,
      operationRunID: setup.operationRunID,
      setup,
      actors: r.actors.map((a) => ({
        accountName: a.accountName,
        characterID: a.characterID,
        shipID: a.shipID,
      })),
    });
    const started: { botID: string; options: Awaited<ReturnType<typeof ownerOptions>> }[] = [];
    try {
      for (const item of checked) {
        await authenticatedJson(
          `${base}/${encodeURIComponent(id)}/group/${encodeURIComponent(String(setup.operationRunID))}/${item.actor.characterID}/dispatch`,
          item.options,
          {},
        );
        const bot = await startPluginRun(
          item.actor.characterID,
          "uoc",
          item.actor.runName,
          r.setup,
          item.grant,
          item.options,
        );
        if (
          !bot.botID ||
          bot.characterID !== item.actor.characterID ||
          bot.kind !== "plugin" ||
          bot.plugin?.pluginID !== "uoc" ||
          bot.plugin.run !== item.actor.runName
        )
          throw Error("A fleet member Start is unconfirmed.");
        started.push({ botID: bot.botID, options: item.options });
      }
    } catch (error) {
      try {
        await authenticatedJson(route(id, "stop"), o, { operationRunID: setup.operationRunID });
      } catch {
        /* Unknown controllers and native dispatches remain retained; no login or replay. */
      }
      throw Error(
        `Fleet Start requires reconciliation; no member Start was replayed. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return;
  }
  const maximum = await runtimeAllowed(o, r.duration);
  if (r.grantDuration > maximum) throw Error("Hosted runtime policy changed; review again.");
  await assertPilotFree(o, r.candidate.characterID);
  const check = await checkPluginRun("uoc", r.candidate.runName, r.setup, o);
  if (
    JSON.stringify(check.setup) !== JSON.stringify(r.setup) ||
    JSON.stringify(check.policy) !== JSON.stringify(r.policy)
  )
    throw Error("Hosted run policy or setup changed; review again.");
  const grant = createPluginRunGrant(check.policy, r.grantDuration);
  await authenticatedJson(route(id, "start"), o, {
    confirm: true,
    reviewHash,
    operationRunID: setup.operationRunID,
    setup,
  });
  try {
    const bot = await startPluginRun(
      r.candidate.characterID,
      "uoc",
      r.candidate.runName,
      r.setup,
      grant,
      o,
    );
    if (
      !bot.botID ||
      bot.characterID !== r.candidate.characterID ||
      bot.kind !== "plugin" ||
      bot.plugin?.pluginID !== "uoc" ||
      bot.plugin.run !== r.candidate.runName
    )
      throw Error("The exact hosted run was not confirmed.");
  } catch (error) {
    throw Error(
      `Start outcome requires reconciliation; no second Start was sent. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
export async function stopCombatOperation(id: string, options: ApiOptions): Promise<void> {
  const value = await authenticatedJson(base, options),
    row = value.operations?.find((x: any) => x.definition?.operationID === id),
    run = row?.executions?.[0];
  if (!run || typeof run.epoch !== "string" || typeof run.owner !== "string")
    throw Error("Exact COC generation is unavailable; no Stop was sent.");
  const own = await actor(run.owner, run.character_id);
  await authenticatedJson(route(id, "stop"), own, { operationRunID: run.epoch });
}
export async function deleteCombatOperation(
  id: string,
  revision: number,
  options: ApiOptions,
): Promise<void> {
  await authenticatedJson(route(id, "delete"), options, { revision });
}
