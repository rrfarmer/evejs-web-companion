import type { BackendRoute, PluginRunContext } from "../../web/src/plugin-api/backend.ts";

const runs = new Map<
  string,
  {
    username: string;
    stop: () => void;
    requested: boolean;
    purpose?: "mcc-finish" | "mcc-resumed-stop";
    characterID?: number;
    operationID?: string;
    operationRunID?: string;
    context?: PluginRunContext;
  }
>();

/** The host-held account is read through its normal authenticated roster API. */
export async function runOwner(run: PluginRunContext): Promise<string> {
  const response = await run.fetch(new URL("/api/pilot-training/characters", run.baseUrl));
  const body = await response.json();
  if (
    !response.ok ||
    body.ok !== true ||
    typeof body.account !== "string" ||
    !body.account ||
    !Array.isArray(body.characters) ||
    !body.characters.some((c: any) => c.characterID === run.characterID)
  )
    throw new Error("The hosted pilot's account identity could not be verified.");
  return body.account;
}

export function registerRun(
  run: Pick<PluginRunContext, "botID"> & Partial<PluginRunContext>,
  ownerUsername: string,
  requestStop: () => void,
  purpose?: "mcc-finish" | "mcc-resumed-stop",
): () => void {
  if (!ownerUsername || runs.has(run.botID))
    throw new Error("This UOC run already has a controller.");
  const setup = run.setup as { operationID?: unknown; operationRunID?: unknown } | null | undefined;
  const metadata =
    Number.isSafeInteger(run.characterID) &&
    run.characterID! > 0 &&
    typeof setup?.operationID === "string" &&
    setup.operationID.length > 0 &&
    typeof setup.operationRunID === "string" &&
    setup.operationRunID.length > 0
      ? {
          characterID: run.characterID,
          operationID: setup.operationID,
          operationRunID: setup.operationRunID,
        }
      : {};
  const context =
    typeof run.fetch === "function" &&
    typeof run.baseUrl === "string" &&
    run.held?.characterID === run.characterID
      ? (run as PluginRunContext)
      : undefined;
  const entry = {
    username: ownerUsername.toLowerCase(),
    stop: requestStop,
    requested: false,
    purpose,
    ...metadata,
    ...(context ? { context } : {}),
  };
  runs.set(run.botID, entry);
  return () => {
    if (runs.get(run.botID) === entry) runs.delete(run.botID);
  };
}

/** Independent character services use this exact existing UOC owner, never a new login. */
export function pilotServiceOwner(
  characterID: number,
  username: string,
): { run: PluginRunContext; current: () => void } | null {
  const matches = [...runs.entries()].filter(
    ([, r]) => r.username === username.toLowerCase() && r.context?.characterID === characterID,
  );
  if (matches.length !== 1) return null;
  const [botID, entry] = matches[0]!;
  if (entry.requested) return null;
  const current = () => {
    if (runs.get(botID) !== entry || entry.context?.characterID !== characterID)
      throw Error("The original pilot owner has ended; pending training receipts are retained.");
  };
  return { run: entry.context!, current };
}

const stopRoute: BackendRoute = (request) => {
  const run = runs.get(request.params.botID ?? "");
  if (!run || run.username !== request.account.username.toLowerCase())
    return { status: 404, body: { ok: false, error: "UOC_RUN_NOT_FOUND" } };
  // The controller coalesces its own pending settlement. A later request may
  // reconcile/retry a failed parking read; the registry must not trap it.
  run.requested = true;
  run.stop();
  return { status: 202, body: { ok: true, state: "STOP_REQUESTED" } };
};

// Ask the plugin to settle and park while the host still permits native reads
// and movement. Only after verified docking does it end its hosted run.
const currentRoute: BackendRoute = (request) => ({
  body: {
    ok: true,
    runs: [...runs.entries()]
      .filter(
        ([, r]) =>
          r.username === request.account.username.toLowerCase() && r.characterID !== undefined,
      )
      .map(([botID, r]) => ({
        botID,
        characterID: r.characterID,
        operationID: r.operationID,
        operationRunID: r.operationRunID,
        purpose: r.purpose ?? null,
      })),
  },
});
export const runControlRoutes = {
  "POST /runs/:botID/stop": stopRoute,
  "GET /runs/current": currentRoute,
};

/** A saved editor never changes a definition while any current member controller owns it. */
export function operationHasController(operationID: string, operationRunID?: string): boolean {
  return [...runs.values()].some(
    (r) =>
      r.operationID === operationID &&
      (operationRunID === undefined || r.operationRunID === operationRunID),
  );
}
/** Only independently held FINISH actors of this same generation may coexist. */
export function operationAllowsFinish(
  operationID: string,
  operationRunID: string,
  characterID?: number,
): boolean {
  return [...runs.values()]
    .filter((r) => r.operationID === operationID)
    .every(
      (r) =>
        (r.purpose === "mcc-finish" || r.purpose === "mcc-resumed-stop") &&
        r.operationRunID === operationRunID &&
        (characterID === undefined || r.characterID !== characterID),
    );
}

export async function runExpiry(
  run: PluginRunContext,
  requireExclusiveOwner = false,
): Promise<number> {
  const response = await run.fetch(new URL("/api/bots", run.baseUrl));
  const body = await response.json();
  const matches = Array.isArray(body.bots)
    ? body.bots.filter((b: any) => b.botID === run.botID && b.characterID === run.characterID)
    : [];
  const expires = matches.length === 1 ? Date.parse(matches[0].expiresAt) : NaN;
  if (!response.ok || !Number.isFinite(expires) || expires <= Date.now())
    throw new Error("The hosted runtime expiry could not be verified.");
  if (
    requireExclusiveOwner &&
    (body.ok !== true ||
      matches[0].endedAt !== null ||
      !["starting", "running", "paused"].includes(matches[0].status) ||
      body.bots.some(
        (bot: any) =>
          bot.characterID === run.characterID && bot.botID !== run.botID && !bot.endedAt,
      ))
  )
    throw new Error("Current exclusive hosted pilot lease is not verified.");
  return expires;
}
