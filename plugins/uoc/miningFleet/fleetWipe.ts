import { isListValue, readRowField, unwrapLong } from "../shared/wire.ts";
import type { OperationRecord } from "./operation.ts";
import { targetKey, type Target } from "./targetBoard.ts";
import type { FleetTelemetry } from "./telemetry.ts";

export interface ShipLoss {
  readonly killID: number;
  readonly characterID: number;
  readonly shipID: number;
  readonly systemID: number;
  readonly at: number;
}

const windowMs = 20 * 60_000;
const FILETIME_UNIX_EPOCH = 116444736000000000n;

function filetimeToUnixMs(value: bigint | null): number | null {
  if (value === null || value <= FILETIME_UNIX_EPOCH) return null;
  const ms = Number((value - FILETIME_UNIX_EPOCH) / 10_000n);
  return Number.isSafeInteger(ms) ? ms : null;
}
const positive = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;

export function readShipLoss(
  raw: unknown,
  ship: { characterID: number; shipID: number; shipTypeID: number },
  lastSeenAt: number,
  capsuleSeenAt: number,
): ShipLoss | null {
  if (!isListValue(raw)) return null;
  const matches: ShipLoss[] = [];
  for (const row of raw.items) {
    if (
      readRowField(row, "victimCharacterID") !== ship.characterID ||
      readRowField(row, "victimShipTypeID") !== ship.shipTypeID
    )
      continue;
    const killID = readRowField(row, "killID"),
      systemID = readRowField(row, "solarSystemID");
    const at = filetimeToUnixMs(unwrapLong(readRowField(row, "killTime")));
    if (
      positive(killID) &&
      positive(systemID) &&
      at !== null &&
      at >= lastSeenAt &&
      at <= capsuleSeenAt
    )
      matches.push({ killID, characterID: ship.characterID, shipID: ship.shipID, systemID, at });
  }
  return matches.length === 1 ? matches[0]! : null;
}

/** Target history and the exact selected site locate the confirmed losses. */
export function confirmFleetWipe(
  operation: OperationRecord,
  telemetry: FleetTelemetry,
  losses: readonly ShipLoss[],
  currentTarget?: Target | null,
) {
  if (
    operation.operationID !== telemetry.operationID ||
    operation.runID !== telemetry.runID ||
    operation.relocation ||
    !telemetry.history?.length ||
    !Array.isArray(operation.members) ||
    !Array.isArray(operation.manifests) ||
    !operation.settledAt
  )
    return null;
  const deployed = operation.members.filter(
    (m) => !operation.neverStarted?.includes(m.characterID),
  );
  if (
    !deployed.length ||
    deployed.some(
      (m) =>
        !telemetry.members.some(
          (t) => t.characterID === m.characterID && t.shipID === m.shipID && t.botID,
        ),
    )
  )
    return null;

  const matched: ShipLoss[] = [];
  for (const ship of deployed) {
    const member = telemetry.members.find((t) => t.characterID === ship.characterID)!;
    const found = losses.filter(
      (l) =>
        positive(l?.killID) &&
        l.characterID === ship.characterID &&
        l.shipID === ship.shipID &&
        l.at >= (member.deployedAt ?? telemetry.startedAt) &&
        l.at <= (telemetry.stoppedAt ?? telemetry.observedAt) &&
        l.at <= (operation.settledAt[String(ship.characterID)] ?? Infinity),
    );
    if (found.length === 1 && found[0]!.systemID === operation.systemID) matched.push(found[0]!);
  }
  const threshold = Math.ceil((deployed.length * 7) / 10);
  if (
    matched.length < threshold ||
    new Set(matched.map((loss) => loss.killID)).size !== matched.length
  )
    return null;
  matched.sort((a, b) => a.at - b.at);

  const history = telemetry.history
    .filter((h) => h.kind === "TARGET_SELECTION")
    .map((h) => ({ at: Date.parse(h.at), target: h.target }));
  if (
    history.some(
      ({ at, target }) =>
        !Number.isFinite(at) || !target || target.claimedByOperationID !== operation.operationID,
    )
  )
    return null;
  history.sort((a, b) => a.at - b.at);
  if (operation.claim && history.at(-1)?.target.targetKey !== operation.claim.key) return null;

  for (let i = threshold - 1; i < matched.length; i++) {
    const first = matched[i - threshold + 1]!.at,
      last = matched[i]!.at;
    if (last - first > windowMs) continue;
    const atFirst = history.filter((h) => h.at <= first).at(-1);
    if (!atFirst || atFirst.target.systemID !== operation.systemID) continue;
    const { targetType, targetName } = atFirst.target;
    const target: Target | null =
      targetType === "BELT" && typeof targetName === "string" && targetName.trim()
        ? { kind: "BELT", systemID: operation.systemID, name: targetName }
        : currentTarget &&
            currentTarget.kind !== "BELT" &&
            currentTarget.kind === targetType &&
            currentTarget.systemID === operation.systemID
          ? currentTarget
          : null;
    if (!target) continue;
    const key = targetKey(target);
    if (
      atFirst.target.targetKey !== key ||
      history.some((h) => h.at >= atFirst.at && h.at <= last && h.target.targetKey !== key)
    )
      continue;

    // A transition can leave the Hauler on the old grid while the group moves.
    const unsafeMove = operation.relocationHistory?.some(
      (move) =>
        move.oldClaim.key !== move.newClaim.key &&
        ((move.completedAt >= first && move.completedAt <= last) ||
          (move.completedAt < first &&
            move.oldBeltID &&
            operation.manifests.some(
              (m) =>
                m.targetKey === move.oldClaim.key &&
                m.claimGeneration === move.oldClaim.generation &&
                (!m.delivered || !(m.deliveredAt !== undefined && m.deliveredAt < first)),
            ))),
    );
    if (!unsafeMove)
      return { target, operationID: operation.operationID, runID: operation.runID, lostAt: last };
  }
  return null;
}
