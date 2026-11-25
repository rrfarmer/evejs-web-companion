import type { PluginRunContext } from "../../../web/src/plugin-api/backend.ts";
import type { CivilianIndexRow } from "./index.ts";

// Metadata on the existing executor, never another pilot/session controller.
const scopes = new WeakMap<PluginRunContext, () => CivilianIndexRow>();
type Service = {
  run: PluginRunContext;
  row: () => CivilianIndexRow;
  inspect: () => Promise<unknown>;
  resume?: () => Promise<void>;
  work?: Promise<unknown>;
};
const services = new Map<string, Service>();
export function bindCivilianScope(run: PluginRunContext, row: () => CivilianIndexRow) {
  scopes.set(run, row);
}
export function civilianProvenance(run: PluginRunContext) {
  return scopes.get(run)?.() ?? null;
}
export function registerCivilianRecovery(
  run: PluginRunContext,
  inspect: () => Promise<unknown>,
  resume?: () => Promise<void>,
) {
  const row = scopes.get(run);
  if (!row) return () => {};
  if (services.has(run.botID)) throw Error("The exact Civilian recovery service already exists.");
  const entry: Service = { run, row, inspect, resume };
  services.set(run.botID, entry);
  return () => {
    if (services.get(run.botID) === entry) services.delete(run.botID);
  };
}
export async function inspectCivilianOwner(row: CivilianIndexRow) {
  const service = services.get(row.botID),
    scope = service?.row();
  if (
    !service ||
    !scope ||
    scope.worldID !== row.worldID ||
    scope.owner !== row.owner ||
    scope.characterID !== row.characterID ||
    scope.kind !== row.kind
  )
    return {
      scope: "STORED_ONLY",
      nativeReconciled: false,
      reason:
        "The exact original owner service is unavailable. Stored evidence is retained; no login, displacement or native action was attempted.",
    };
  if (!service.work) {
    service.work = service.inspect();
    void service.work
      .finally(() => {
        service.work = undefined;
      })
      .catch(() => {});
  }
  return { scope: "EXISTING_OWNER", ...((await service.work) as object) };
}
export function civilianOwnerAvailable(row: CivilianIndexRow) {
  const e = services.get(row.botID),
    r = e?.row();
  return (
    !!r &&
    r.worldID === row.worldID &&
    r.owner === row.owner &&
    r.characterID === row.characterID &&
    r.kind === row.kind
  );
}

/** Continue the original paused executor; it performs fresh native reconciliation before any action. */
export async function continueCivilianOwner(row: CivilianIndexRow) {
  const service = services.get(row.botID),
    scope = service?.row();
  if (
    !service?.resume ||
    !scope ||
    scope.worldID !== row.worldID ||
    scope.owner !== row.owner ||
    scope.characterID !== row.characterID
  )
    throw Error(
      "The original owner cannot continue here; release it through Stop or use the reviewed offline continuation.",
    );
  await service.resume();
  return { continued: true, botID: row.botID };
}
