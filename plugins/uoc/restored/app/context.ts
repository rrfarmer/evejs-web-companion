import { cockpitTraining } from "../adapters/cockpitTraining.ts";
import { cockpitProvisioning } from "../adapters/cockpitProvisioning.ts";
import {
  BridgeCallError,
  checkPluginRun,
  createPluginRunGrant,
  startPluginRun,
  listServerBots,
  loadKnownAccounts,
  loadKnownCharacters,
  type ApiOptions,
  type JsonValue,
  type ServerBot,
  type Session,
} from "../../../../web/src/plugin-api/index.ts";
import { type AccountPass } from "../../compat/accounts.ts";
import { whilePageVisible } from "./pageVisibility.ts";
import type { PluginPagePilot } from "../../../../web/src/plugin-api/index.ts";
export type { ApiOptions };
export type AuthenticatedAccount = {
  readonly accountID: number;
  readonly username: string;
  readonly options: ApiOptions;
};
export class UocRequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
let getSessions: () => readonly Session[] = () => [],
  transport: typeof fetch = (...args) => globalThis.fetch(...args);
let readWorkspaceAccounts: () => readonly AuthenticatedAccount[] = () => [];
let readPagePilots: () => readonly PluginPagePilot[] = () => [];
export const linkedPagePilots = () => readPagePilots();
const workspaceAccountNames = () => [
  ...readPagePilots().map((p) => p.accountName),
  ...loadKnownAccounts(),
];
let accountPass: AccountPass | undefined;
let readObservationSignal: (() => AbortSignal) | undefined;
const refusedTokens = new Set<string>();
const accountKey = (name: string) => name.trim().toLowerCase();
export const farmerSignInMessage =
  "No saved WC account could be authorized. Check the browser’s Pilot Hangar roster.";

export function installPageContext(value: {
  sessions?: readonly Session[] | (() => readonly Session[]);
  readAccounts?: () => readonly AuthenticatedAccount[];
  readPagePilots?: () => readonly PluginPagePilot[];
  fetch?: typeof fetch;
  accountPass?: AccountPass;
  observationSignal?: () => AbortSignal;
}) {
  accountPass = value.accountPass;
  readObservationSignal = value.observationSignal;
  const sessions = value.sessions;
  getSessions = typeof sessions === "function" ? sessions : () => sessions ?? [];
  readWorkspaceAccounts = value.readAccounts ?? (() => []);
  readPagePilots = value.readPagePilots ?? (() => []);
  transport = value.fetch ?? ((...args) => globalThis.fetch(...args));
}

function farmerAccess() {
  const byToken = new Map<string, { username: string; options: ApiOptions }>();
  const accounts = [...readWorkspaceAccounts()];
  for (const { username, options } of accounts.reverse()) {
    if (options.token && !byToken.has(options.token))
      byToken.set(options.token, { username, options });
  }
  for (const session of getSessions()) {
    const username = session.store.get().session?.username,
      token = session.flow.sessionToken();
    if (!username || !token) continue;
    const options = session.flow.requestOptions();
    if (!byToken.has(token))
      byToken.set(token, {
        username,
        options: options.token === token ? options : { ...options, token },
      });
  }
  return [...byToken].filter(([token]) => !refusedTokens.has(token)).map(([, access]) => access);
}

export function farmerAccounts(): string[] {
  return [...new Set(farmerAccess().map((access) => access.username))].sort((a, b) =>
    a.localeCompare(b),
  );
}

export function workspaceAccounts(): string[] {
  const accounts = [
    ...new Set([...farmerAccounts(), ...readPagePilots().map((p) => p.accountName)]),
  ];
  return accountPass ? [...new Set([...accounts, ...workspaceAccountNames()])] : accounts;
}

export function savedWorkspacePilots() {
  return accountPass ? loadKnownCharacters() : [];
}

export function matchAccountName(names: readonly string[], account: string): string | undefined {
  const name = account.trim();
  if (names.includes(name)) return name;
  const matches = names.filter((candidate) => accountKey(candidate) === accountKey(name));
  return matches.length === 1 ? matches[0] : undefined;
}

function accountAccess(account: string) {
  const access = farmerAccess();
  const saved = workspaceAccountNames();
  const names = [...new Set([...saved, ...access.map((row) => row.username)])];
  const name = matchAccountName(names, account);
  if (!name && names.some((candidate) => accountKey(candidate) === accountKey(account)))
    throw Error("Choose the exact WC Account name.");
  return {
    access: access.filter((row) => row.username === name),
    savedName: name && saved.includes(name) ? name : undefined,
  };
}

function accessRequired(account: string) {
  return new UocRequestError(`${account}: ${farmerSignInMessage}`, 401, "FARMER_ACCOUNT_REQUIRED");
}

export function accountUnauthorized(error: unknown): boolean {
  return (
    (error instanceof UocRequestError || error instanceof BridgeCallError) && error.status === 401
  );
}

async function savedAccountOptions(pass: AccountPass, name: string): Promise<ApiOptions> {
  const options = await pass.optionsFor(name);
  if (!options.token || !refusedTokens.delete(options.token)) return options;
  pass.forget(name);
  return pass.optionsFor(name);
}

export async function ownerOptions(account: string): Promise<ApiOptions> {
  const { access, savedName } = accountAccess(account);
  if (access[0]) return access[0].options;
  if (accountPass && savedName) return savedAccountOptions(accountPass, savedName);
  throw accessRequired(account);
}

/** Try current workspace credentials first. Only an account read may fall back after a 401. */
export async function readAsFarmerAccount<T>(
  account: string,
  read: (options: ApiOptions) => Promise<T>,
): Promise<T> {
  const { access, savedName } = accountAccess(account);
  for (const existing of access) {
    try {
      return await read(existing.options);
    } catch (error) {
      if (!accountUnauthorized(error)) throw error;
    }
  }
  const pass = accountPass;
  if (pass && savedName) {
    const options = await savedAccountOptions(pass, savedName);
    try {
      return await read(options);
    } catch (error) {
      if (accountUnauthorized(error)) {
        if (options.token) refusedTokens.delete(options.token);
        pass.forget(savedName);
      }
      throw error;
    }
  }
  throw accessRequired(account);
}

/** The linked tab already has access for roster and workspace reads. Pilot commands use ownerOptions separately. */
export async function readAsHangarAccount<T>(
  account: string,
  read: (options: ApiOptions) => Promise<T>,
): Promise<T> {
  const pilots = readPagePilots();
  if (!pilots.length) return readAsFarmerAccount(account, read);
  const name = matchAccountName(workspaceAccounts(), account);
  const linked = pilots.find((p) => p.accountName === name && !refusedTokens.has(p.token));
  if (linked) {
    try {
      return await read({ token: linked.token });
    } catch (error) {
      if (!accountUnauthorized(error)) throw error;
    }
  }
  return readAsFarmerAccount(account, read);
}

export async function authenticatedJson<T = any>(
  path: string,
  options: ApiOptions = {},
  body?: unknown,
): Promise<T> {
  options.signal?.throwIfAborted();
  const token = options.token;
  const native =
    token && (!options.fetch || options.baseUrl === undefined)
      ? cockpitRequestOptions(token)
      : null;
  const fetcher = options.fetch ?? native?.fetch ?? transport;
  const response = await fetcher(`${options.baseUrl ?? native?.baseUrl ?? ""}${path}`, {
    method: body === undefined ? "GET" : "POST",
    signal: options.signal,
    credentials: "omit",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let result: any;
  try {
    result = await response.json();
  } catch {
    options.signal?.throwIfAborted();
    throw new UocRequestError(
      "This UOC service returned an unreadable response.",
      response.status,
      "UOC_RESPONSE_UNREADABLE",
    );
  }
  options.signal?.throwIfAborted();
  if (
    !path.endsWith("/login") &&
    (response.status === 401 || result?.error === "ACCOUNT_NOT_FOUND")
  ) {
    if (token) refusedTokens.add(token);
    throw new UocRequestError(farmerSignInMessage, 401, result?.error ?? "AUTH_REQUIRED");
  }
  if (!response.ok || result?.ok === false)
    throw new UocRequestError(
      result?.message ?? result?.error ?? "The UOC request failed.",
      response.status,
      result?.error ?? "UOC_REQUEST_FAILED",
    );
  return result;
}
export async function worldID(options: ApiOptions = {}): Promise<string | null> {
  const r = await authenticatedJson("/api/plugins/uoc/world", options);
  return typeof r.worldID === "string" && r.worldID ? r.worldID : null;
}
export interface HostedResult {
  botID: string;
  phase: string;
  status: string;
  why: string | null;
  readout: unknown;
}
type Intent = {
  characterID: number;
  kind: string;
  issuedAt: number;
  setup: string;
  beforeIDs: string[];
  botID: string | null;
};
const pending = new Map<string, Promise<HostedResult>>();
const pilotRequests = new Map<string, Promise<HostedResult>>();
const rememberedIntents = new Map<string, Intent>();
/** Only read the result here. Starting a bot or an owner service belongs outside the visibility lifecycle. */
async function observeHosted<T>(
  lifetime: AbortSignal | undefined,
  read: (signal: AbortSignal) => Promise<T | null>,
  pendingMessage: string,
  initialDelay = 0,
): Promise<T> {
  lifetime?.throwIfAborted();
  const interval = 1200;
  let remaining = 600_000;
  let delay = globalThis.document?.hidden ? 0 : initialDelay;
  let stop: (() => void) | undefined, onAbort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      onAbort = () => reject(lifetime!.reason);
      lifetime?.addEventListener("abort", onAbort, { once: true });
      stop = whilePageVisible((signal) => {
        const deadline = Date.now() + remaining;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let next = delay > 0 && delay < interval ? interval - delay : interval;
        async function poll() {
          try {
            const result = await read(signal);
            if (signal.aborted) return;
            if (result !== null) {
              resolve(result);
              return;
            }
            if (Date.now() >= deadline) {
              reject(Error(pendingMessage));
              return;
            }
            timer = setTimeout(poll, next);
            next = interval;
          } catch (error) {
            if (!signal.aborted) reject(error);
          }
        }
        if (delay) timer = setTimeout(poll, delay);
        else void poll();
        delay = 0;
        return () => {
          clearTimeout(timer);
          remaining = Math.max(0, deadline - Date.now());
        };
      });
    });
  } finally {
    stop?.();
    if (onAbort) lifetime?.removeEventListener("abort", onAbort);
  }
}
/** Existing host owns acquisition, native actions, transactions and exact release. No competing login is made here. */
export function runHosted(
  characterID: number,
  kind: string,
  setup: JsonValue,
  options: ApiOptions = {},
): Promise<HostedResult> {
  const screen = readObservationSignal?.();
  const lifetime =
    screen && options.signal
      ? AbortSignal.any([screen, options.signal])
      : (screen ?? options.signal);
  if (lifetime?.aborted) return Promise.reject(lifetime.reason);
  const hrStage = kind === "training-hr" && (setup as any)?.stage;
  const readOnly =
    /(-inspect|-status|-checkpoint)$/.test(kind) ||
    hrStage === "inspect" ||
    hrStage === "member-inspect";
  const identity = JSON.stringify([options.token ?? null, characterID, kind, setup]);
  const active = pending.get(identity);
  if (active) return active;
  const provisioning = kind === "provision-inspect" || kind === "provision-apply";
  const training = kind === "training" || kind === "training-inspect";
  const trainingCenter = /^training(?:-|$)/.test(kind);
  const center = provisioning || trainingCenter,
    mccInspection = kind === "mcc-inspect";
  const lane = JSON.stringify([options.baseUrl ?? "", characterID]),
    previous = pilotRequests.get(lane);
  if (mccInspection && previous)
    return Promise.reject(
      Error("A pilot request is already in flight; no new MCC inspection was sent."),
    );
  const perform = async () => {
    lifetime?.throwIfAborted();
    const nativeOwner = cockpitSession(characterID);
    const ownedOptions =
      !center && nativeOwner
        ? {
            ...options,
            ...nativeOwner.flow.requestOptions(),
            token: nativeOwner.flow.sessionToken(),
          }
        : options;
    const readOptions = lifetime ? { ...ownedOptions, signal: lifetime } : ownedOptions;
    if (center) {
      const domain = kind.startsWith("provision-") ? "provisioning" : "training",
        hr = kind === "training-hr" && (setup as any)?.stage;
      const serviceKind =
        kind === "training"
          ? "train"
          : kind === "training-inspect" || kind === "provision-inspect"
            ? "inspect"
            : hr === "member-inspect"
              ? "member-inspect"
              : hr === "inspect"
                ? "hr-inspect"
                : null;
      const servicePath = `/api/plugins/uoc/${domain}/${characterID}/service`,
        status = await authenticatedJson(servicePath, readOptions);
      lifetime?.throwIfAborted();
      if (status.available === true) {
        if (!serviceKind)
          throw new UocRequestError(
            "The existing operation owner permits compatible Training and read-only Provisioning. Equipment Apply and corporation membership mutations require a separate authorized idle-owner contract.",
            409,
            "ACTIVE_OWNER_MUTATION_BLOCKED",
          );
        const { task: original } = await authenticatedJson(servicePath, ownedOptions, {
          kind: serviceKind,
          setup,
        });
        if (
          typeof original?.taskID !== "string" ||
          original.characterID !== characterID ||
          original.ownerBotID !== status.ownerBotID ||
          original.domain !== domain ||
          original.kind !== serviceKind
        )
          throw Error(
            "Exact owner-service task identity is unavailable. No replacement request was sent.",
          );
        lifetime?.throwIfAborted();
        const task = original.endedAt
          ? original
          : await observeHosted(
              lifetime,
              async (signal) => {
                const { task } = await authenticatedJson(servicePath, { ...ownedOptions, signal });
                if (
                  !task ||
                  task.taskID !== original.taskID ||
                  task.characterID !== characterID ||
                  task.ownerBotID !== original.ownerBotID ||
                  task.kind !== original.kind ||
                  task.domain !== domain ||
                  task.worldID !== original.worldID ||
                  task.owner !== original.owner ||
                  JSON.stringify(task.setup) !== JSON.stringify(original.setup)
                )
                  throw Error("The current pilot service changed.");
                return task.endedAt ? task : null;
              },
              "The current pilot service is still working.",
              1200,
            );
        if (task.status === "error")
          throw Error(task.why ?? "The original pilot service needs attention.");
        return {
          botID: task.taskID,
          phase: task.phase,
          status: task.status,
          why: task.why ?? null,
          readout: task.readout,
        };
      }
      if (nativeOwner && training)
        return cockpitTraining(nativeOwner, kind, setup, authenticatedJson);
      if (nativeOwner && kind.startsWith("provision-"))
        return cockpitProvisioning(nativeOwner, kind, setup, authenticatedJson);
      if (nativeOwner)
        throw new UocRequestError(
          "Use the existing Cockpit fitting and inventory controls for this pilot. Full Center replacement/source plans are not yet bound to that selected-session path.",
          409,
          "CENTER_COCKPIT_ADAPTER_UNCONNECTED",
        );
    }
    let key: string | null = null;
    if (!provisioning && !training) {
      const world = await worldID(readOptions);
      if (!world)
        throw Error(
          "Current EveJS world identity is unavailable; the exact training intent cannot be scoped.",
        );
      const intentKind = readOnly && hrStage ? `${kind}:${hrStage}` : kind;
      key = `uoc:restored:hosted:${encodeURIComponent(world)}:${characterID}:${intentKind}`;
    }
    let intent: Intent | null = key ? (rememberedIntents.get(key) ?? null) : null;
    if (key && !intent)
      try {
        const saved = sessionStorage.getItem(key);
        if (saved) intent = JSON.parse(saved);
      } catch {}
    const forgetIntent = () => {
      if (key) {
        rememberedIntents.delete(key);
        try {
          sessionStorage.removeItem(key);
        } catch {}
      }
      intent = null;
    };
    const rememberIntent = (value: Intent) => {
      if (key) {
        rememberedIntents.set(key, value);
        try {
          sessionStorage.setItem(key, JSON.stringify(value));
        } catch {}
      }
    };
    let confirmedHost: { beforeIDs: string[]; limit: unknown } | null = null;
    if (mccInspection && intent) {
      // MCC inspections only read native state. An ended inspection is not a receipt
      // the next fleet needs, but Farmer must confirm that it has released the pilot.
      const { ownership } = await authenticatedJson(
        `/api/pilot-training/ownership?characterID=${characterID}`,
        readOptions,
      );
      if (
        ownership?.characterID !== characterID ||
        ownership.owner !== "OFF" ||
        ownership.online !== false
      )
        throw Error(
          `Farmer has not confirmed this pilot is free (${ownership?.owner ?? "unknown"}); no new MCC inspection was sent.`,
        );
      const roster = await authenticatedJson("/api/bots", readOptions);
      if (
        !Array.isArray(roster.bots) ||
        roster.bots.some(
          (r: any) =>
            !r ||
            typeof r.botID !== "string" ||
            !r.botID ||
            !Number.isSafeInteger(r.characterID) ||
            (r.endedAt !== null && typeof r.endedAt !== "string"),
        )
      )
        throw Error("The current Farmer roster is unreadable; no new MCC inspection was sent.");
      if (roster.bots.some((r: any) => r.characterID === characterID && r.endedAt === null))
        throw Error(
          "Farmer still has an active hosted run for this pilot; no new MCC inspection was sent.",
        );
      confirmedHost = {
        beforeIDs: roster.bots.map((r: { botID: string }) => r.botID),
        limit: roster.hostedRunPolicy?.maxRuntimeMinutes,
      };
      forgetIntent();
    }
    const [preflight, trainingOwnership] =
      center && !intent
        ? await Promise.all([
            authenticatedJson<{
              bots: ServerBot[];
              hostedRunPolicy?: { maxRuntimeMinutes: number };
            }>("/api/bots", readOptions),
            trainingCenter
              ? authenticatedJson(
                  `/api/pilot-training/ownership?characterID=${characterID}`,
                  readOptions,
                )
              : null,
          ])
        : [null, null];
    if (
      preflight &&
      (!Array.isArray(preflight.bots) ||
        preflight.bots.some(
          (row) =>
            !row ||
            typeof row.botID !== "string" ||
            !row.botID ||
            (row.endedAt !== null && typeof row.endedAt !== "string"),
        ))
    )
      throw Error("The current Farmer roster is unreadable; no Start was sent.");
    const rows = confirmedHost
      ? []
      : (preflight?.bots ??
        (await listServerBots(ownedOptions.fetch ? readOptions : ownedOptions)));
    lifetime?.throwIfAborted();
    if (intent && intent.setup !== JSON.stringify(setup)) {
      const old = rows.filter(
        (r) =>
          r.characterID === characterID &&
          r.kind === "plugin" &&
          r.plugin?.pluginID === "uoc" &&
          r.plugin.run === kind &&
          (intent!.botID ? r.botID === intent!.botID : !intent!.beforeIDs.includes(r.botID)),
      );
      const value = old[0]?.plugin?.readout as any,
        pending = Array.isArray(value?.pending) ? value.pending.length > 0 : !!value?.pending;
      if (
        old.length === 1 &&
        old[0]!.endedAt &&
        (readOnly || (!pending && !/unresolved|reconciliation/i.test(old[0]!.phase ?? "")))
      )
        forgetIntent();
      else
        throw Error(
          "A previous hosted request belongs to another exact goal; its native outcome is still unresolved.",
        );
    }
    let botID = intent?.botID ?? null;
    let trainingStart: ServerBot | null = null;
    if (intent && !botID) {
      const candidates = rows.filter(
        (r) =>
          r.characterID === characterID &&
          r.kind === "plugin" &&
          r.plugin?.pluginID === "uoc" &&
          r.plugin.run === kind &&
          !intent!.beforeIDs.includes(r.botID),
      );
      if (candidates.length !== 1)
        throw Error(
          "The previous hosted Start requires read-only reconciliation; no new Start was sent.",
        );
      botID = candidates[0]!.botID;
    }
    if (!intent) {
      if (center) {
        const { ownership } =
          trainingOwnership ??
          (await authenticatedJson(
            `/api/pilot-training/ownership?characterID=${characterID}`,
            readOptions,
          ));
        const reason =
          ownership?.characterID !== characterID
            ? "Current pilot ownership could not be verified."
            : ownership.owner === "ACCOUNT_IN_USE_OR_UNVERIFIED"
              ? "Another pilot on this account is online or its native presence could not be verified."
              : ownership.owner !== "OFF" || ownership.online !== false
                ? `Pilot control is ${ownership.owner ?? "unknown"} (${ownership.online === true ? "online" : ownership.online === false ? "offline" : "presence unknown"}). A compatible held session is unavailable in this tab.`
                : rows.some((b) => !b.endedAt)
                  ? "A hosted operation still holds this account."
                  : null;
        if (reason)
          throw new UocRequestError(
            reason,
            409,
            kind.startsWith("provision-")
              ? "PROVISIONING_OWNER_LEASE_REQUIRED"
              : "TRAINING_OWNER_SERVICE_REQUIRED",
          );
      }
      const limit = confirmedHost
        ? confirmedHost.limit
        : preflight
          ? preflight.hostedRunPolicy?.maxRuntimeMinutes
          : (await authenticatedJson("/api/bots", readOptions)).hostedRunPolicy?.maxRuntimeMinutes;
      if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1)
        throw Error("The current hosted runtime policy is unavailable; no Start was sent.");
      const minutes = Math.min(limit, /(inspect|status|recover|checkpoint)$/.test(kind) ? 10 : 720);
      const check = await checkPluginRun("uoc", kind, setup, readOptions);
      lifetime?.throwIfAborted();
      intent = {
        characterID,
        kind,
        issuedAt: Date.now(),
        setup: JSON.stringify(setup),
        beforeIDs: confirmedHost?.beforeIDs ?? rows.map((r) => r.botID),
        botID: null,
      };
      rememberIntent(intent);
      const started = await startPluginRun(
        characterID,
        "uoc",
        kind,
        check.setup,
        createPluginRunGrant(check.policy, minutes),
        ownedOptions,
      );
      botID = started.botID;
      intent.botID = botID;
      rememberIntent(intent);
      if (trainingCenter) trainingStart = started;
    }
    lifetime?.throwIfAborted();
    const endedAtStart =
      trainingStart?.endedAt &&
      trainingStart.botID &&
      trainingStart.characterID === characterID &&
      trainingStart.kind === "plugin" &&
      trainingStart.plugin?.pluginID === "uoc" &&
      trainingStart.plugin.run === kind
        ? trainingStart
        : null;
    const row =
      endedAtStart ??
      (await observeHosted<ServerBot>(
        lifetime,
        async (signal) => {
          // Training needs a fresh receipt. Other centers share WC's roster read across windows.
          // Only an unshared request can be cancelled when this observer goes away.
          const bots = trainingCenter
            ? (
                await authenticatedJson<{ bots: ServerBot[] }>("/api/bots", {
                  ...ownedOptions,
                  signal,
                })
              ).bots
            : await listServerBots(ownedOptions.fetch ? { ...ownedOptions, signal } : ownedOptions);
          const row = Array.isArray(bots)
            ? bots.find((r) => r.botID === botID && r.characterID === characterID)
            : undefined;
          if (!row)
            throw Error(
              "The exact hosted pilot result is unavailable; its intent remains retained.",
            );
          if (
            row.endedAt ||
            (kind === "provision-apply" && row.phase === "Session release blocked")
          )
            return row;
          if (
            kind !== "provision-apply" &&
            /blocked|unresolved|needs attention/i.test(row.phase ?? "")
          )
            throw Error(row.why ?? "The hosted service retains an unresolved action.");
          return null;
        },
        "The pilot service is still running; its exact hosted intent is retained.",
        trainingStart ? 250 : 0,
      ));
    if (!(kind === "provision-apply" && row.phase === "Session release blocked")) {
      const v = row.plugin?.readout as any,
        retained = Array.isArray(v?.pending) ? v.pending.length > 0 : !!v?.pending;
      if (key && !readOnly && (retained || /unresolved|reconciliation/i.test(row.phase ?? "")))
        throw Error(
          row.why ?? "The exact hosted action is still unresolved; no new action was sent.",
        );
      forgetIntent();
      if (row.status === "error" && kind !== "provision-apply")
        throw Error(row.why ?? "The hosted pilot service needs attention.");
    }
    return {
      botID: row.botID,
      phase: row.phase ?? "",
      status: row.status,
      why: row.why ?? null,
      readout: row.plugin?.readout ?? null,
    };
  };
  const work = center && previous ? previous.catch(() => {}).then(perform) : perform();
  if (center || mccInspection) pilotRequests.set(lane, work);
  pending.set(identity, work);
  void work
    .finally(() => {
      pending.delete(identity);
      if (pilotRequests.get(lane) === work) pilotRequests.delete(lane);
    })
    .catch(() => {});
  return work;
}

export function cockpitSession(characterID: number) {
  return (
    getSessions().find((session) => {
      const token = session.flow.sessionToken();
      return (
        session.store.get().station.online?.characterID === characterID &&
        token &&
        !refusedTokens.has(token)
      );
    }) ?? null
  );
}

/** Preserve the original transport options when only an account token is carried. */
export function cockpitRequestOptions(token: string): ApiOptions | null {
  return farmerAccess().find((access) => access.options.token === token)?.options ?? null;
}
