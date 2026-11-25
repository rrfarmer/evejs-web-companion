import {
  checkPluginRun,
  createPluginRunGrant,
  startPluginRun,
  listServerBots,
} from "../../../../web/src/plugin-api/index.ts";
import { isListValue, readKeyVal } from "../../shared/wire.ts";
import { authenticatedJson, ownerOptions, type ApiOptions } from "../app/context.ts";
import type { MiningRecovery, StopUnload } from "../../operations/miningRecovery.ts";

export async function pilotDockedAtHome(
  characterID: number,
  parking: StopUnload["parking"],
  options: ApiOptions,
) {
  const { result } = await authenticatedJson("/api/roster/characters", options);
  if (!Array.isArray(result) || result.length !== 4 || !isListValue(result[2]))
    throw Error("The character selection roster is unreadable.");
  return result[2].items.some(
    (row) =>
      readKeyVal(row, "characterID") === characterID &&
      readKeyVal(row, "stationID") === parking.destinationID &&
      readKeyVal(row, "solarSystemID") === parking.systemID,
  );
}

/** Explicit retained-generation reconciliation. No productive Start or original inventory action is replayed. */
export async function recoverMiningOperation(
  operationID: string,
  options: ApiOptions = {},
  onProgress?: (message: string) => void,
  expectedRunID?: string,
): Promise<string[]> {
  const path = `/api/plugins/uoc/mining-operations/${encodeURIComponent(operationID)}/recovery`;
  const initial = await authenticatedJson(path, options),
    review = initial.recovery as MiningRecovery;
  if (
    review?.operationID !== operationID ||
    !review.operationRunID ||
    !Array.isArray(review.members) ||
    !Array.isArray(review.attempts)
  )
    throw Error("Retained recovery evidence is unavailable.");
  if (
    expectedRunID !== undefined &&
    (review.operationRunID !== expectedRunID || !review.stopUnload)
  )
    throw Error("The retained home unload changed. Refresh the operation and try again.");
  if (review.observeOfflineParking) {
    const observePilots = await Promise.all(
      review.members
        .filter((m) => m.status !== "PREPARED")
        .map(async (member) => {
          const { token } = await ownerOptions(member.accountName);
          if (!token)
            throw Error("Pilot " + member.characterID + " requires its authorized account.");
          return { characterID: member.characterID, token };
        }),
    );
    const result = await authenticatedJson(path + "/finalize", options, {
      recoveryHash: review.recoveryHash,
      observePilots,
    });
    if (result.state !== "STOPPED") throw Error("Retained Stop completion could not be verified.");
    const message = "Original fleet settlement finalized from verified docks and offline release.";
    onProgress?.(message);
    return [message];
  }
  const messages: string[] = [],
    issues: string[] = [];
  let progressed = false;
  const record = (message: string, problem = false) => {
    (problem ? issues : messages).push(message);
    if (!problem) progressed = true;
    onProgress?.(message);
  };
  for (const member of review.members) {
    const label = "Pilot " + member.characterID;
    if (review.stopUnload && !review.stopUnload.characterIDs.includes(member.characterID)) continue;
    if (member.status === "PREPARED") {
      messages.push(label + ": no original Start was dispatched.");
      continue;
    }
    let dispatchStarted = false;
    try {
      const owned = await ownerOptions(member.accountName),
        bots = await listServerBots(owned);
      const current = await authenticatedJson("/api/plugins/uoc/runs/current", owned);
      if (!Array.isArray(current.runs)) throw Error("Current owner authority is unavailable.");
      const owners = current.runs.filter((r: any) => r.characterID === member.characterID);
      const active = bots.filter((b) => b.characterID === member.characterID && !b.endedAt);
      const attempt = review.attempts.find((x) => x.characterID === member.characterID);
      const complete = review.completedMembers?.includes(member.characterID) === true;
      const accept = async (botID: string, dispatchedAt?: number) =>
        authenticatedJson(path + "/accept", options, {
          recoveryHash: review.recoveryHash,
          characterID: member.characterID,
          botID,
          dispatchedAt,
        });
      if (attempt) {
        const liveFinish = (botID: string) =>
          owners.some(
            (r: any) =>
              r.botID === botID &&
              r.operationID === operationID &&
              r.operationRunID === review.operationRunID,
          );
        const matches = bots.filter(
          (b) =>
            b.characterID === member.characterID &&
            b.kind === "plugin" &&
            b.plugin?.pluginID === "uoc" &&
            b.plugin.run === "mcc-finish" &&
            (attempt.botID
              ? b.botID === attempt.botID ||
                (!!review.stopUnload && !b.endedAt && liveFinish(b.botID))
              : !attempt.beforeIDs.includes(b.botID) &&
                (liveFinish(b.botID) ||
                  (b.endedAt &&
                    b.status === "stopped" &&
                    [
                      "Docked; retained freight settled",
                      "Settled in place; retained freight settled",
                    ].includes(b.phase ?? "") &&
                    (b.plugin.readout as any)?.operationID === operationID &&
                    (b.plugin.readout as any)?.operationRunID === review.operationRunID &&
                    (b.plugin.readout as any)?.characterID === member.characterID))),
        );
        const running = matches.filter((b) => !b.endedAt);
        if (running.length > 1 || (!running.length && matches.length > 1))
          throw Error("The current FINISH owner is ambiguous.");
        const bot = running[0] ?? matches[0];
        if (bot && !attempt.botID) await accept(bot.botID, attempt.dispatchedAt);
        if (bot && !bot.endedAt) {
          if (
            owners.length !== 1 ||
            active.length !== 1 ||
            !owners.some(
              (r: any) =>
                r.botID === bot.botID &&
                r.operationID === operationID &&
                r.operationRunID === review.operationRunID,
            )
          )
            throw Error("The exact current FINISH owner is unavailable.");
          await authenticatedJson(
            `/api/plugins/uoc/runs/${encodeURIComponent(bot.botID)}/stop`,
            owned,
            {},
          );
          record(
            label +
              (review.stopUnload
                ? ": current session is rechecking the unload."
                : ": existing FINISH owner asked to reconcile."),
          );
          continue;
        }
      }
      if (owners.length || active.length)
        throw Error("A current owner is still present. Stop it through its original controller.");
      if (review.stopUnload && bots.some((b) => !b.endedAt))
        throw Error("This account is already hosting another pilot.");
      const status = await authenticatedJson(
        `/api/pilot-training/ownership?characterID=${member.characterID}`,
        owned,
      );
      if (
        status.ownership?.characterID !== member.characterID ||
        status.ownership.owner !== "OFF" ||
        status.ownership.online !== false
      )
        throw Error(
          "An offline free owner is not proven. Verify the current session and dock in game if needed.",
        );
      if (complete) {
        record(label + ": native settlement and offline release verified.");
        continue;
      }
      if (
        review.stopUnload &&
        review.stopUnload.parking.kind === "station" &&
        !(await pilotDockedAtHome(member.characterID, review.stopUnload.parking, owned))
      )
        throw Error("The pilot is not confirmed docked at the configured home.");
      const setup = { operationID, operationRunID: review.operationRunID },
        check = await checkPluginRun("uoc", "mcc-finish", setup, owned);
      const policy = await authenticatedJson("/api/bots", owned),
        maximum = policy.hostedRunPolicy?.maxRuntimeMinutes;
      if (!Number.isSafeInteger(maximum) || maximum < 1)
        throw Error("Hosted recovery duration authority is unavailable.");
      dispatchStarted = true;
      const dispatch = await authenticatedJson(path + "/dispatch", options, {
        recoveryHash: review.recoveryHash,
        characterID: member.characterID,
        beforeIDs: bots.map((b) => b.botID),
        ...(attempt ? { retry: { dispatchedAt: attempt.dispatchedAt, botID: attempt.botID } } : {}),
      });
      const next = dispatch.recovery?.attempts.find(
        (a: any) => a.characterID === member.characterID,
      );
      if (!Number.isFinite(next?.dispatchedAt) || next.botID !== null)
        throw Error("The new FINISH dispatch could not be verified.");
      const bot = await startPluginRun(
        member.characterID,
        "uoc",
        "mcc-finish",
        check.setup,
        createPluginRunGrant(check.policy, Math.min(60, maximum)),
        owned,
      );
      if (
        bot.characterID !== member.characterID ||
        bot.kind !== "plugin" ||
        bot.plugin?.pluginID !== "uoc" ||
        bot.plugin.run !== "mcc-finish"
      )
        throw Error("FINISH Start identity is uncertain; its original dispatch is retained.");
      await accept(bot.botID, next.dispatchedAt);
      record(
        label +
          (review.stopUnload
            ? ": temporary unload session started."
            : ": retained FINISH started. Waiting for native settlement and Parking."),
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // A new hosted dispatch can lose its answer. Do not advance to another
      // acquisition in that invocation; a later review rechecks native ownership.
      record(label + ": " + detail, true);
      if (dispatchStarted) break;
    }
  }
  if (
    !issues.length &&
    review.members.some((m) => m.status !== "PREPARED") &&
    review.members.every(
      (m) => m.status === "PREPARED" || review.completedMembers?.includes(m.characterID),
    )
  ) {
    const result = await authenticatedJson(path + "/finalize", options, {
      recoveryHash: review.recoveryHash,
    });
    if (result.state !== "STOPPED") throw Error("Retained Stop completion could not be verified.");
    record("Original fleet settlement finalized.");
  }
  if (issues.length && !progressed) throw Error(issues.join(" "));
  return [...messages, ...issues];
}
