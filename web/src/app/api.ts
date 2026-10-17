// Typed BFF endpoints for the R2 page flow: who-cares login, persistent-
// session select/release. The bridge call tuple itself goes through
// bridge/callMethod.ts; these are the BFF's own session routes
// (docs/bridge-wire-contract.md, "BFF routes").
//
// The opaque bridgeSessionID never appears here: the BFF holds it server-side
// in its cookie-session store and attaches it to bridge calls itself.

import { BridgeCallError, callMethod } from "../bridge/callMethod.ts";
import type { Ask } from "../bridge/ask.ts";
import { decodeBoundDogma, type BoundDogma } from "../bridge/boundDogma.ts";
import { decodeNameValidation, decodeValidRandomName } from "../bridge/charAccount.ts";
import { decodeBeyonceWriteAck, type BeyonceWriteAck } from "../bridge/boundBeyonceWrites.ts";
import { type DroneEngageOutcome, type DroneEngageRefusal } from "../bridge/drones.ts";
import {
  decodeCharCreationTables,
  type CharCreationTables,
} from "../bridge/charCreation.ts";
import {
  clearSessionToken,
  getSessionToken,
  sessionAuthHeaders,
  setSessionToken,
  tokenAuthHeaders,
  withSessionTokenQuery,
  withTokenQuery,
} from "./sessionToken.ts";
import {
  TransportQueueError,
  bridgeLane,
  type RequestPriority,
} from "./transport.ts";
import { pageCarries, pageFetch, pageSocket } from "./pageFetch.ts";
import type { JsonValue } from "../bridge/wire.ts";
import type { ExpertSystemData } from "../bridge/expertSystems.ts";
import type { HullFacts, ShipTraitBonus, ShipTraits } from "../bridge/hullBrowser.ts";
import type { ComparisonTypeData, DogmaAttributeRecord } from "../bridge/typeComparison.ts";
import { decodeJobFee, decodeJobMaterials, type IndustryJobFee } from "../bridge/industry.ts";
import type { SafetyLevel } from "../space/crimewatch.ts";
import type { MinerTrainingRead, StageFittingSelection, TrainingCharacter, QueueReview, QueueApplyOutcome } from "../training/types.ts";
import type {
  IndustryActivity,
  InventoryPlace,
  OnlineCharacterState,
  SlotFamily,
  StationOffices,
  StationStatic,
  QuestionAnswer,
} from "../store/types.ts";
import type { NameRef } from "../store/names.ts";
import type { BotLaunchGrant, BotRiskClass } from "../bots/runPolicy.ts";
import {
  type CompanionSetup,
  type CompanionOrderAuthority,
  type FleetCompanionRequest,
} from "../nav/fleetCompanionLoop.ts";
import type {
  ScannerOperationsSnapshot,
  ScannerProbeOperation,
} from "../scanner/scannerCenter.ts";
import type { MiningOperationAssignment, MiningOperationTarget, MiningTargetType } from "../nav/scriptConditions.ts";
import { decodeMiningSupportAnchor, decodeMiningSupportAnchorRead } from "../bridge/miningSupportAnchor.ts";
import type { MiningSupportAnchor, MiningSupportAnchorRead } from "../nav/miningSupportAnchor.ts";

export interface LoginResult {
  readonly accountID: number;
  readonly username: string;
  /** R2: true when this login auto-created the account on the server. */
  readonly accountCreated: boolean;
  /**
   * R107 — the signed session token the BFF handed back, so a per-session flow
   * can capture it onto its own call options instead of the per-tab global.
   * Null when the BFF returned no token (it always does on success today).
   */
  readonly sessionToken: string | null;
}

export interface SelectResult {
  readonly character: OnlineCharacterState;
  readonly station: StationStatic | null;
  readonly notifications: readonly JsonValue[];
  readonly droneRecoveryCheckID: string | null;
}

export interface ApiOptions {
  /** Base URL prefix; default "" (same-origin against the BFF). */
  readonly baseUrl?: string;
  /** Injectable fetch for tests; default globalThis.fetch. */
  readonly fetch?: typeof fetch;
  /**
   * R107 multibox — this call's OWN session token, threaded per flow so several
   * live characters can share one browser tab. When the `token` KEY is present
   * (even as null), this call is per-session: it authenticates with exactly this
   * token (Bearer when a non-empty string, no auth header when null) and NEVER
   * falls back to the per-tab global. When the key is ABSENT, the call keeps the
   * pre-R107 behavior and rides the global `sessionAuthHeaders()` / cookie. The
   * presence of the key — not its value — is what selects the mode.
   */
  readonly token?: string | null;
  /**
   * R92 — how this request competes for the client's request lanes. Defaults to
   * "read". Background polling should pass "poll" and anything the player just
   * clicked should pass "user"; see app/transport.ts for why a click must never
   * queue behind a poll.
   */
  readonly priority?: RequestPriority;
  /** Capture the current flow/session before awaiting a response drain. */
  readonly captureNotificationSink?: () => (notifications: readonly JsonValue[]) => void;
  /** Reject queued dispatch or late replies after this flow's session retires. */
  readonly captureRequestGuard?: () => () => void;
}

// R42/R107 — THE one place every BFF request in this file picks up its session
// token. Two modes, chosen by whether `options.token` is present:
//   • per-session (R107 multibox, key present): this flow's OWN token goes on as
//     `Authorization: Bearer`, and it NEVER falls back to the global — so a
//     backgrounded pilot's self-refresh can never ride the active pilot's token.
//   • single-session (pre-R107, key absent): the per-tab global token
//     (sessionStorage) rides as before, with the cookie under
//     `credentials: "same-origin"` as the migration fallback.
// Attaching it here rather than at each call site is the point: there are well
// over a hundred callers below and none of them should know about it.
/**
 * The browser-side deadline on every BFF request. The BFF's own longest legal
 * wait is a session-change route: the ten-second next-mutation cooldown plus
 * the forty-five-second readiness barrier — so this sits safely above that.
 * Without ANY deadline, a half-dead socket (sleeping laptop, wedged proxy)
 * froze a bot mid-tick forever with the panel saying "running": the await
 * simply never settled, and no bound can count a tick that never ends. The
 * abort surfaces as BRIDGE_NETWORK_ERROR, which the loops already treat as
 * transport-transient (settle, re-observe, bounded retry).
 */
const REQUEST_DEADLINE_MS = 65_000;

/**
 * What actually went wrong with a request that never produced a response.
 *
 * ⚠ THE POINT IS THE STATE OF THE LANE, NOT THE REQUEST THAT FAILED. The field
 * reports this was written for named a journal read, the space snapshot and a
 * location read — three unrelated routes failing in the same moment, which is
 * never three faults. It is one: the server stopped answering, everything piled
 * up behind it, and the request the player happened to make was a bystander.
 * Naming the bystander sends whoever reads the report to the wrong route, so the
 * lane's own verdict is appended to every transport failure.
 */
export function transportFailureWords(path: string, cause: unknown): string {
  if (cause instanceof TransportQueueError) {
    // It never left the browser, so there is nothing to say about the server.
    return cause.message;
  }
  const detail = cause instanceof Error ? cause.message : String(cause);
  return `${path} could not reach the BFF: ${detail} — ${bridgeLane.diagnose().verdict}`;
}

async function requestJson(
  path: string,
  init: RequestInit,
  options: ApiOptions,
): Promise<Record<string, JsonValue>> {
  // Over HTTP, or on the tab's socket where the page is set to (app/pageFetch.ts). A fetch handed in is used as it is.
  const doFetch = options.fetch ?? pageFetch();
  const notificationSink = options.captureNotificationSink?.();
  const assertCurrent = options.captureRequestGuard?.();
  const authHeaders = "token" in options ? tokenAuthHeaders(options.token) : sessionAuthHeaders();
  const credentials = "token" in options ? "omit" : "same-origin";
  let response: Response;
  try {
    // ⚠ THE DEADLINE IS ARMED INSIDE THE LANE, NOT OUTSIDE IT. A request that
    // waited for a free lane must arrive at the server with its full budget; if
    // the clock started when the call was made, a queued request would time out
    // against a server that answered promptly. See app/transport.ts.
    const url = `${options.baseUrl ?? ""}${path}`;
    const request: RequestInit = {
      ...init,
      credentials,
      headers: {
        ...authHeaders,
        ...((init.headers as Record<string, string> | undefined) ?? {}),
      },
    };
    response = await bridgeLane.run(options.priority ?? "read", path, () => {
      assertCurrent?.();
      return doFetch(url, { signal: AbortSignal.timeout(REQUEST_DEADLINE_MS), ...request });
      // A request that goes on the tab's open socket holds none of the browser's connections, and so no lane.
    }, { carried: options.fetch === undefined && pageCarries(url, request) });
  } catch (cause) {
    assertCurrent?.();
    if (cause instanceof BridgeCallError && cause.code === "SESSION_REQUEST_RETIRED") throw cause;
    throw new BridgeCallError(
      "BRIDGE_NETWORK_ERROR",
      transportFailureWords(path, cause),
      0,
      cause instanceof TransportQueueError
        ? cause.diagnosis.verdict
        : bridgeLane.diagnose().verdict,
    );
  }
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    assertCurrent?.();
    throw new BridgeCallError(
      "BRIDGE_BAD_RESPONSE",
      `${path} returned a non-JSON response (HTTP ${response.status}).`,
      response.status,
    );
  }
  assertCurrent?.();
  if (
    typeof data !== "object" ||
    data === null ||
    (data as { ok?: unknown }).ok !== true ||
    !response.ok
  ) {
    const errorBody = (data ?? {}) as { error?: unknown; message?: unknown };
    throw new BridgeCallError(
      typeof errorBody.error === "string" ? errorBody.error : "BRIDGE_BAD_RESPONSE",
      typeof errorBody.message === "string"
        ? errorBody.message
        : `${path} failed (HTTP ${response.status}).`,
      response.status,
    );
  }
  const body = data as Record<string, JsonValue>;
  notificationSink?.(readNotifications(body));
  return body;
}

async function postJson(
  path: string,
  body: unknown,
  options: ApiOptions,
): Promise<Record<string, JsonValue>> {
  return requestJson(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    options,
  );
}

async function getJson(
  path: string,
  options: ApiOptions,
): Promise<Record<string, JsonValue>> {
  return requestJson(path, { method: "GET" }, options);
}

/**
 * GET /api/roster/characters: an account's characters as its selection screen lists them, for the Pilot Hangar, read
 * with no game login (a launcher's listing: a login would close the account's other client). The answer is
 * charUnboundMgr.GetCharacterSelectionData's, undecoded.
 */
export async function readRosterCharacters(options: ApiOptions = {}): Promise<JsonValue> {
  const data = await getJson("/api/roster/characters", options);
  return data.result ?? null;
}

/** What the game server closed a pilot's connection with, where it said (another login of its account). */
export interface ClosedByServer {
  readonly reasonCode: string;
  readonly reason: string;
}

/** GET /api/bridge/closed-by-server: what closed this account's pilot, or null where the server closed nothing. */
export async function readClosedByServer(characterID: number, options: ApiOptions = {}): Promise<ClosedByServer | null> {
  const data = await getJson(`/api/bridge/closed-by-server?characterID=${characterID}`, options);
  const closed = data.closed;
  if (typeof closed !== "object" || closed === null || Array.isArray(closed)) return null;
  const { reasonCode, reason } = closed as Record<string, JsonValue>;
  return typeof reasonCode === "string" && typeof reason === "string" ? { reasonCode, reason } : null;
}

/**
 * GET /api/bridge/pocket-timer: the Abyssal pocket's timer as the pilot was last told it (the end_time of
 * OnAddExpiryDurationForAbyssalContent, as the wire carries it), or null; `known` false where nothing is kept.
 */
export async function readPocketTimer(options: ApiOptions = {}): Promise<{ readonly known: boolean; readonly endTime: JsonValue | null; readonly room: JsonValue | null }> {
  const data = await getJson("/api/bridge/pocket-timer", options);
  return { known: data.known === true, endTime: (data.endTime ?? null) as JsonValue | null, room: (data.room ?? null) as JsonValue | null };
}

/** GET /api/objectives/chain: an objective chain, its objectives' and tasks' types and its type lists, as the client reads them. */
export async function loadObjectiveChain(chainID: number, options: ApiOptions = {}): Promise<Readonly<Record<string, JsonValue>>> {
  return await getJson(`/api/objectives/chain?chainID=${chainID}`, options);
}

/** GET /api/dungeons/ship-restrictions: a dungeon's ship restrictions from a gate of it, as the BFF answers them. */
export async function loadShipRestrictions(dungeonID: number, gateID: number | null, options: ApiOptions = {}): Promise<Readonly<Record<string, JsonValue>>> {
  return await getJson(`/api/dungeons/ship-restrictions?dungeonID=${dungeonID}${gateID !== null ? `&gateID=${gateID}` : ""}`, options);
}

export async function provisioningOptions(providerCharacterID: number | null, options: ApiOptions = {}): Promise<import("../bridge/provisioning.ts").ProvisioningOptions> {
  const data = await getJson(`/api/bridge/provisioning/options${providerCharacterID ? `?providerCharacterID=${providerCharacterID}` : ""}`, options);
  return data as unknown as import("../bridge/provisioning.ts").ProvisioningOptions;
}
export async function reviewProvisioning(input: import("../bridge/provisioning.ts").ProvisioningInput, options: ApiOptions = {}): Promise<import("../bridge/provisioning.ts").ProvisioningReview> {
  return await postJson("/api/bridge/provisioning/review", input, options) as unknown as import("../bridge/provisioning.ts").ProvisioningReview;
}
export async function replenishProvisioning(reviewID: string, reviewHash: string, options: ApiOptions = {}): Promise<import("../bridge/provisioning.ts").ReplenishmentResult> {
  return await postJson("/api/bridge/provisioning/replenish", { reviewID, reviewHash, confirm: true }, options) as unknown as import("../bridge/provisioning.ts").ReplenishmentResult;
}
export async function reconcileProvisioning(operationID: string, options: ApiOptions = {}): Promise<import("../bridge/provisioning.ts").ReplenishmentResult> {
  return await postJson("/api/bridge/provisioning/reconcile", { operationID }, options) as unknown as import("../bridge/provisioning.ts").ReplenishmentResult;
}
export async function reviewShipProvisioning(input: import("../bridge/provisioning.ts").ProvisioningInput, operationID: string | null = null, options: ApiOptions = {}): Promise<import("../bridge/provisioning.ts").ShipReview> {
  return await postJson("/api/bridge/provisioning/ship-review", { ...input, operationID }, options) as unknown as import("../bridge/provisioning.ts").ShipReview;
}
export async function provisionShip(reviewID: string, reviewHash: string, options: ApiOptions = {}): Promise<import("../bridge/provisioning.ts").ShipResult> {
  return await postJson("/api/bridge/provisioning/provision-ship", { reviewID, reviewHash, confirm: true }, options) as unknown as import("../bridge/provisioning.ts").ShipResult;
}

function asNumberOrNull(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Who-cares login (roadmap section 6): any password signs an existing account in. */
export async function login(
  username: string,
  password: string,
  options: ApiOptions = {},
): Promise<LoginResult> {
  const data = await postJson("/api/login", { username, password }, options);
  const sessionToken =
    typeof data.sessionToken === "string" && data.sessionToken.length > 0
      ? data.sessionToken
      : null;
  // R42/R107: where the token lands depends on the mode.
  //   • single-session (no `token` key): take it into this TAB's global storage
  //     so every later request — and the SSE stream — carries this identity
  //     rather than whichever account last wrote the shared cookie.
  //   • per-session (key present): do NOT touch the global, or a second login in
  //     the same tab would collapse every flow onto the last account. The caller
  //     captures the returned token onto its own call options instead.
  if (sessionToken !== null && !("token" in options)) {
    setSessionToken(sessionToken);
  }
  const account = (data.account ?? {}) as { accountID?: JsonValue; username?: JsonValue };
  return {
    accountID: asNumberOrNull(account.accountID) ?? 0,
    username: typeof account.username === "string" ? account.username : username,
    accountCreated: data.accountCreated === true,
    sessionToken,
  };
}

export async function logout(options: ApiOptions = {}): Promise<void> {
  await postJson("/api/logout", {}, options);
  // A rejected logout keeps the pilot held on the BFF. Preserve the carrier
  // so the exact same owner can finish recovery or retry a failed release.
  // Per-session flows clear their own token after this confirmed response.
  if (!("token" in options)) clearSessionToken();
}

/**
 * Bring a character online on a persistent browser-backed session:
 * POST /api/bridge/select dispatches the retail tuple
 * charUnboundMgr.SelectCharacterID on a gateway-minted live session and
 * returns the docked entry state (plus client-local static station identity).
 */
export async function selectCharacter(
  characterID: number,
  options: ApiOptions = {},
): Promise<SelectResult> {
  const data = await postJson("/api/bridge/select", { characterID }, options);
  const character = (data.character ?? {}) as Record<string, JsonValue>;
  const station = data.station;
  return {
    character: {
      characterID: asNumberOrNull(character.characterID) ?? characterID,
      characterName:
        typeof character.characterName === "string" ? character.characterName : "",
      stationID: asNumberOrNull(character.stationID),
      structureID: asNumberOrNull(character.structureID),
      solarSystemID: asNumberOrNull(character.solarSystemID),
      corporationID: asNumberOrNull(character.corporationID),
      allianceID: asNumberOrNull(character.allianceID),
      corpRole: typeof character.corpRole === "string" && /^\d+$/.test(character.corpRole) ? character.corpRole : null,
      role: typeof character.role === "string" && /^\d+$/.test(character.role) ? character.role : null,
      corpAccountKey: asNumberOrNull(character.corpAccountKey),
      raceID: asNumberOrNull(character.raceID),
    },
    station:
      typeof station === "object" && station !== null && !Array.isArray(station)
        ? (station as unknown as StationStatic)
        : null,
    notifications: Array.isArray(data.notifications) ? data.notifications : [],
    droneRecoveryCheckID: typeof data.droneRecoveryCheckID === "string" ? data.droneRecoveryCheckID : null,
  };
}

/** Completes the selected session's lost-flight gate after authoritative return. */
export async function markDroneRecoveryReady(checkID: string, options: ApiOptions = {}): Promise<void> {
  await postJson("/api/bridge/drone-recovery/ready", { checkID }, options);
}

// --- character creation -------------------------------------------------------
//
// All four of these run with NO CHARACTER ONLINE, which is the whole point: this
// is the screen a fresh account lands on. The two bridge reads go through the
// generic /api/bridge/call route, which falls back to a userid-only session when
// the BFF holds none; the picker read and the create write have their own
// account-level BFF routes (see accountLevelCall in src/server.js).

/** What the create screen asks for. Everything not named here the server rolls. */
export interface CreateCharacterRequest {
  readonly name: string;
  readonly raceID: number;
  /** 0 = female, 1 = male (carbon's genderFemale/genderMale). */
  readonly genderID: number;
  /** Omit to have the server roll one within the race. */
  readonly bloodlineID?: number;
  /** Omit to have the server roll one within the bloodline. */
  readonly ancestryID?: number;
}

export interface CreateCharacterResult {
  readonly characterID: number | null;
  /** What the rolls landed on, so the screen can say what it made. */
  readonly bloodlineID: number | null;
  readonly ancestryID: number | null;
}

/**
 * The create screen's picker tables: the world's own races and bloodlines
 * (retail, authoritative) joined with the SDE's ancestries.
 */
export async function loadCharCreationInfo(
  options: ApiOptions = {},
): Promise<CharCreationTables> {
  const data = await getJson("/api/bridge/char-creation-info", options);
  return decodeCharCreationTables(data as JsonValue);
}

/**
 * Create a character. CONFIRM-GATED at the BFF — `confirm: true` is not
 * ceremony, it is the difference between this route being reachable and being
 * fired, and the BFF refuses without it.
 *
 * The retail tuple is composed server-side from these named fields; a bloodline
 * that does not belong to the race, or an ancestry that does not belong to the
 * bloodline, is REFUSED there rather than corrected.
 */
export async function createCharacter(
  request: CreateCharacterRequest,
  options: ApiOptions = {},
): Promise<CreateCharacterResult> {
  const data = await postJson(
    "/api/bridge/character/create-with-doll",
    {
      name: request.name,
      raceID: request.raceID,
      genderID: request.genderID,
      ...(request.bloodlineID ? { bloodlineID: request.bloodlineID } : {}),
      ...(request.ancestryID ? { ancestryID: request.ancestryID } : {}),
      confirm: true,
    },
    options,
  );
  return {
    characterID: asNumberOrNull(data.characterID),
    bloodlineID: asNumberOrNull(data.bloodlineID),
    ancestryID: asNumberOrNull(data.ancestryID),
  };
}

/**
 * Ask the server whether a name is acceptable (charUnboundMgr.ValidateNameEx).
 *
 * ⚠ THE SERVER HAS THE LAST WORD ANYWAY — CreateCharacterWithDoll runs the same
 * validateCharacterName and rejects with CharNameInvalid. This read exists so a
 * refusal arrives while the player is typing rather than after they commit, and
 * so uniqueness (which no client-side rule can know) is checked against the real
 * roster. A null code means the read itself did not answer; that is not a
 * verdict, and the screen must not treat it as one.
 *
 * `namesChecked` is the client's second argument (chooseNameSection.IsNameValid: ValidateNameEx(charName,
 * len(self.namesChecked))), how many names the screen has checked before this one.
 */
export async function validateCharacterName(
  name: string,
  options: ApiOptions = {},
  namesChecked = 0,
): Promise<number | null> {
  const outcome = await callMethod("charUnboundMgr", "ValidateNameEx", [name, namesChecked], null, options);
  return decodeNameValidation(outcome.result);
}

/** A random valid name for a race (charUnboundMgr.GetValidRandomName). */
export async function rollRandomCharacterName(
  raceID: number,
  options: ApiOptions = {},
): Promise<string | null> {
  const outcome = await callMethod(
    "charUnboundMgr",
    "GetValidRandomName",
    [raceID],
    null,
    options,
  );
  return decodeValidRandomName(outcome.result);
}

/**
 * Read-only static station identity by ID (goal R6b): the same client-local
 * StationStatic the select route returns, fetched so the Station panel can
 * refresh its identity after the docked station changes (autopilot arrival /
 * manual dock). Not a gateway/bridge call — read-only static reference data.
 */
export async function loadStationStatic(
  stationID: number,
  options: ApiOptions = {},
): Promise<StationStatic | null> {
  const data = await getJson(`/api/map/station/${stationID}`, options);
  const station = data.station;
  return typeof station === "object" && station !== null && !Array.isArray(station)
    ? (station as unknown as StationStatic)
    : null;
}

/** Release the persistent session (character goes offline via the retail disconnect path). */
export async function releaseSession(
  options: ApiOptions = {},
): Promise<{ released: boolean }> {
  const data = await postJson("/api/bridge/release", {}, options);
  return { released: data.released === true };
}

// --- R3 Inventory & Ship (bound-object bridge) -----------------------------
// The browser addresses items/ships by their game IDs; the BFF holds the
// bound-object handles and returns the raw retail-shaped List/GetCapacity
// results, which app/flow.ts decodes with bridge/inventoryShip.ts.

/** One inventory container's raw reads (retail-shaped; decoded in the flow). */
export interface RawContainer {
  readonly list: JsonValue;
  readonly capacity: JsonValue;
  readonly error: string | null;
}

export interface RawInventoryPanel {
  readonly stationID: number | null;
  readonly structureID: number | null;
  readonly activeShipID: number | null;
  readonly hangar: RawContainer;
  readonly cargo: RawContainer & { readonly shipID: number | null };
  /** Per-type m³ from static data (typeID → volume); a type it does not know is absent. */
  readonly volumes: Readonly<Record<string, number>>;
}

function readRawContainer(value: JsonValue | undefined): RawContainer {
  const container = (value ?? {}) as Record<string, JsonValue>;
  return {
    list: container.list ?? null,
    capacity: container.capacity ?? null,
    error: typeof container.error === "string" ? container.error : null,
  };
}

/** Load the full Inventory & Ship panel (station hangar + active-ship cargo). */
export async function loadInventory(
  options: ApiOptions = {},
): Promise<RawInventoryPanel> {
  const data = await getJson("/api/bridge/inventory", options);
  const cargo = (data.cargo ?? {}) as Record<string, JsonValue>;
  const volumes =
    data.volumes && typeof data.volumes === "object" && !Array.isArray(data.volumes)
      ? (data.volumes as Record<string, number>)
      : {};
  return {
    stationID: asNumberOrNull(data.stationID),
    structureID: asNumberOrNull(data.structureID),
    activeShipID: asNumberOrNull(data.activeShipID),
    hangar: readRawContainer(data.hangar),
    cargo: { ...readRawContainer(data.cargo), shipID: asNumberOrNull(cargo.shipID) },
    volumes,
  };
}

// (A thing moved between the hangar and the ship's hold had a route of its own, POST /api/bridge/inventory/move,
// which nothing of the page asked: the page moves things by the transfer. It went on 2026-10-13.)

// (Stack All of the hangar or the ship's hold is the page's own call since 2026-10-14, the client's StackAll on the
// place's own inventory: bridge/inventoryWrites.ts. Its route, POST /api/bridge/inventory/stack, is gone.)

// A ship is boarded by the page itself, with the client's own call (bridge/shipWrites.ts, boardShip): it left its
// route (POST /api/bridge/ship/board) on 2026-10-14.

// --- R14 Inventory depth + corporation hangars ------------------------------
// The browser names a PLACE — the hangar, the ship's cargo, a container, a
// corporation division by its ordinal — and the BFF maps that to the retail
// flagIDs. No flag number is ever sent from here.

/**
 * What a mutation ACTUALLY did, re-read by the BFF after the call. invbroker
 * declines silently in several branches (a source location that no longer
 * matches, no room, a division the character cannot take from): it returns null
 * WITHOUT raising, so a 200 is not proof anything moved. `declinedSilently`
 * means the server refused and gave no reason — which is reported as exactly
 * that rather than dressed up as a cause.
 */
export interface TransferResult {
  readonly applied: boolean;
  readonly moved: readonly number[];
  readonly declined: readonly number[];
  readonly declinedSilently: boolean;
  readonly notFound: readonly number[];
}

function asNumberList(value: JsonValue | undefined): readonly number[] {
  return Array.isArray(value) ? value.map((entry) => Number(entry) || 0).filter((id) => id > 0) : [];
}

/**
 * Move items between any two places. One call carries them all, because they
 * are the same retail call with different arguments: a single item with a
 * `qty` is a SPLIT (a partial-quantity Add), several items are one MultiAdd.
 */
export async function transferItems(
  itemIDs: readonly number[],
  from: InventoryPlace,
  to: InventoryPlace,
  qty: number | null = null,
  options: ApiOptions = {},
  authority?: {
    readonly claimRunID?: string;
    readonly expectedScope?: { readonly shipID: number; readonly solarSystemID: number };
    readonly haulContract?: {
      readonly stationID: number; readonly locationKind?: "station" | "structure";
      readonly corporationID: number; readonly division: number;
      readonly typeID: number; readonly sourceQuantity: number;
    };
  },
): Promise<TransferResult> {
  const body: Record<string, JsonValue> = {
    itemIDs: [...itemIDs],
    from: from as unknown as JsonValue,
    to: to as unknown as JsonValue,
  };
  if (qty !== null) {
    body.qty = qty;
  }
  if (authority?.claimRunID) body.claimRunID = authority.claimRunID;
  if (authority?.expectedScope) body.expectedScope = authority.expectedScope as unknown as JsonValue;
  if (authority?.haulContract) body.haulContract = authority.haulContract as unknown as JsonValue;
  const data = await postJson("/api/bridge/inventory/transfer", body, options);
  return {
    applied: data.applied === true,
    moved: asNumberList(data.moved),
    declined: asNumberList(data.declined),
    declinedSilently: data.declinedSilently === true,
    notFound: asNumberList(data.notFound),
  };
}

// A stack is merged into another by the page itself, with the client's own call on the inventory the target lies in
// (bridge/inventoryWrites.ts, mergeStacks): it left its route (POST /api/bridge/inventory/merge) on 2026-10-14, the
// corporation's hangar the last of its places.

// Items are destroyed by the page itself, with the client's own call on the inventory manager of where the pilot
// is (bridge/inventoryWrites.ts, trashItems): it left its route (POST /api/bridge/inventory/trash) on 2026-10-13.

export interface RawContainerReads {
  readonly containerID: number;
  readonly list: JsonValue;
  readonly capacity: JsonValue;
  /** False where the client's controller for it has no capacity (a wreck); a capacity unread is still true. */
  readonly hasCapacity: boolean;
  /** Per-type m³ for the rows above, so a caller can work out what FITS. */
  readonly volumes: Readonly<Record<string, number>>;
}

/**
 * Open a container and read its contents.
 *
 * `typeID` is what the container IS, from the row it was opened by. The retail
 * client knows the type of what it opens and works the container's capacity out
 * from that, without a word to the server; said here, the bridge can do the
 * same. A caller after the contents alone leaves it out, and on the game port
 * gets no capacity and costs the server none.
 */
export async function openContainer(
  containerID: number,
  options: ApiOptions = {},
  typeID: number | null = null,
): Promise<RawContainerReads> {
  const said = typeID !== null && typeID > 0 ? `?typeID=${typeID}` : "";
  const data = await getJson(`/api/bridge/inventory/container/${containerID}${said}`, options);
  return {
    containerID: asNumberOrNull(data.containerID) ?? containerID,
    list: data.list ?? null,
    capacity: data.capacity ?? null,
    hasCapacity: data.hasCapacity !== false,
    // Normalised here, exactly as the inventory panel's read does it: a bridge
    // that does not send the field yields an empty map, which reads downstream
    // as "no volume known for this type" rather than as zero.
    volumes:
      data.volumes && typeof data.volumes === "object" && !Array.isArray(data.volumes)
        ? (data.volumes as Record<string, number>)
        : {},
  };
}

/** A ship's bays as the BFF reports them (goal R40); still to be decoded. */
export interface RawShipBaysResult {
  readonly shipID: number;
  readonly bays: JsonValue;
}

/**
 * Read which bays a ship has, how full each is, and what is in it. Works for
 * ANY ship the character can see — the one they are flying and the ones sitting
 * in the hangar alike.
 */
export async function getShipBays(
  shipID: number,
  options: ApiOptions = {},
  keys: readonly string[] = [],
): Promise<RawShipBaysResult> {
  // Naming the bays turns 27 capacity calls into as many as were asked for,
  // which is what makes this affordable on a bot's loot path rather than only
  // once for a panel.
  const query = keys.length > 0 ? `?keys=${encodeURIComponent(keys.join(","))}` : "";
  const data = await getJson(`/api/bridge/ship/${shipID}/bays${query}`, options);
  return {
    shipID: asNumberOrNull(data.shipID) ?? shipID,
    bays: data.bays ?? null,
  };
}

/** One corporation hangar division as the BFF reports it (rows still raw). */
export interface RawCorpDivision {
  readonly division: number;
  readonly name: string | null;
  readonly list: JsonValue;
  readonly error: string | null;
  readonly volumes: Readonly<Record<string, number>>;
}

export interface CharacterCreationState {
  slots: number; freeSlots: number; pendingName: string | null; recoveredCharacterID: number | null;
  characters: readonly { characterID: number; name: string }[];
}
export async function loadCharacterCreationState(options: ApiOptions = {}): Promise<CharacterCreationState> {
  const data = await getJson("/api/bridge/character/creation-state", options);
  if (!Number.isSafeInteger(data.slots) || !Number.isSafeInteger(data.freeSlots) || !Array.isArray(data.characters))
    throw new BridgeCallError("CREATION_STATE_UNKNOWN", "Account slot authority is unreadable.", 502);
  return data as unknown as CharacterCreationState;
}

export interface RawCorpHangar {
  readonly available: boolean;
  readonly stationID: number | null;
  readonly reason: string | null;
  readonly divisions: readonly RawCorpDivision[];
}

/**
 * Read the corporation hangar at the docked station: which divisions exist,
 * what they are CALLED, and what is in each. A division the character lacks
 * the query role for simply reads empty — the server filters it, and that
 * filtering is the authority (the UI's own greying-out is cosmetic).
 */
export async function loadCorpHangar(options: ApiOptions = {}): Promise<RawCorpHangar> {
  const data = await getJson("/api/bridge/inventory/corp", options);
  const divisions = Array.isArray(data.divisions) ? data.divisions : [];
  return {
    available: data.available === true,
    stationID: asNumberOrNull(data.stationID),
    reason: typeof data.reason === "string" ? data.reason : null,
    divisions: divisions.map((entry) => {
      const row = (entry ?? {}) as Record<string, JsonValue>;
      return {
        division: Number(row.division) || 0,
        name: typeof row.name === "string" && row.name !== "" ? row.name : null,
        list: row.list ?? null,
        error: typeof row.error === "string" ? row.error : null,
        volumes: typeof row.volumes === "object" && row.volumes !== null && !Array.isArray(row.volumes)
          ? Object.fromEntries(Object.entries(row.volumes).filter(([, value]) => typeof value === "number" && Number.isFinite(value))) as Record<string, number>
          : {},
      };
    }),
  };
}

// Crimewatch's states and the account's clone grade are read by the page
// itself, each with the client's own call (bridge/crimewatchReads.ts,
// bridge/cloneGradeReads.ts; the plan's Phase 6b). Until 2026-10-10 each was one
// route's (GET /api/bridge/crimewatch, GET /api/bridge/clone-grade).

// The ship's safety level is set by the page itself, with the client's own call
// (bridge/crimewatchWrites.ts; the plan's Phase 6b): the fourth of its writes to
// leave its route (POST /api/bridge/safety/set-level), on 2026-10-10.

/**
 * The lobby's offices where the pilot is docked: the corporations with an
 * office there, and how many offices are free. The BFF asks them as the retail
 * client's lobby does, of the station's own office object, for a pilot on the
 * game port; for one on the gateway it answers `available: false`.
 */
export async function loadStationOffices(options: ApiOptions = {}): Promise<StationOffices> {
  const data = await getJson("/api/bridge/station/offices", options);
  const listed = Array.isArray(data.corporationIDs) ? data.corporationIDs : [];
  const free = data.freeOffices;
  return {
    available: data.available === true,
    corporationIDs: listed.filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0),
    freeOffices: typeof free === "number" && Number.isSafeInteger(free) && free >= 0 ? free : null,
    ownOffice: data.ownOffice === true,
    impounded: data.impounded === true,
    canRent: data.canRent === true,
    canGiveUp: data.canGiveUp === true,
  };
}

// An office's price, its rent and its giving up are the page's own calls of the
// station's office manager (bridge/officeWrites.ts; the plan's Phase 6b): they
// left their three routes on 2026-10-10.

/**
 * WHERE the corporation has offices and what its divisions are CALLED — the
 * planning read, answered from anywhere, for any station.
 *
 * `loadCorpHangar` above is the docked-station read: what is IN the office you
 * are standing in. This one answers the question a bot script asks while it is
 * being written, about a station on the far side of the map: is there an office
 * there at all, and what would the divisions be called if I picked one?
 */
export interface CorpOfficeDivision {
  readonly division: number;
  readonly name: string | null;
}

export interface CorpOfficesResult {
  /** Station ids where the corporation rents an office. Empty is an ordinary
   * answer (a corporation with no offices), told apart from a failed read by
   * `error`. */
  readonly stationIDs: readonly number[];
  /** All seven divisions with their corporation-given names, so a picker can
   * label them without a second read. */
  readonly divisions: readonly CorpOfficeDivision[];
  readonly error: string | null;
}

export async function loadCorpOffices(options: ApiOptions = {}): Promise<CorpOfficesResult> {
  const data = await getJson("/api/bridge/corp-offices", options);
  const divisions = Array.isArray(data.divisions) ? data.divisions : [];
  return {
    stationIDs: Array.isArray(data.stationIDs)
      ? data.stationIDs.map((entry) => Number(entry) || 0).filter((id) => id > 0)
      : [],
    divisions: divisions.map((entry) => {
      const row = (entry ?? {}) as Record<string, JsonValue>;
      return {
        division: Number(row.division) || 0,
        name: typeof row.name === "string" && row.name !== "" ? row.name : null,
      };
    }),
    error: typeof data.error === "string" ? data.error : null,
  };
}

// --- R12 Ship fitting ------------------------------------------------------
// The BFF drives the same bound-object two-step as the inventory routes (a
// slot flag instead of hangar/cargo) and returns the raw retail-shaped reads,
// decoded in the flow with bridge/fitting.ts. The browser addresses a SLOT by
// family + index ("the third high slot") — slot flagIDs live on the BFF only.

/** The raw fitting reads (retail-shaped; decoded in the flow). */
export interface RawFittingReads {
  readonly activeShipID: number | null;
  readonly slots: JsonValue;
  readonly shipInfo: JsonValue;
  readonly online: JsonValue;
  readonly errors: {
    readonly slots: string | null;
    readonly shipInfo: string | null;
    readonly online: string | null;
  };
  /**
   * Per-module-type charge fitment, for SORTING the ammo picker only. Advisory:
   * the server decides what actually loads.
   */
  readonly chargeFits: JsonValue;
}

/** Read the active ship's fitting: slots, resources, and online state. */
export async function loadFitting(options: ApiOptions = {}): Promise<RawFittingReads> {
  const data = await getJson("/api/bridge/fitting", options);
  const errors = (data.errors ?? {}) as Record<string, JsonValue>;
  return {
    activeShipID: asNumberOrNull(data.activeShipID),
    slots: data.slots ?? null,
    shipInfo: data.shipInfo ?? null,
    online: data.online ?? null,
    chargeFits: data.chargeFits ?? null,
    errors: {
      slots: typeof errors.slots === "string" ? errors.slots : null,
      shipInfo: typeof errors.shipInfo === "string" ? errors.shipInfo : null,
      online: typeof errors.online === "string" ? errors.online : null,
    },
  };
}

/** As many types as one request for types' facts asks of: under the route's own limit of 500. */
const COMBAT_UTILITY_TYPES_PER_REQUEST = 400;

/**
 * What the combat classifier wants to know of each of these types (nav/combatUtilities.ts), from the BFF's static
 * data: GET /api/types/combat-utility. Not a bridge call, and no live session: it cannot vary by player. A type
 * the tables do not know is not among what is answered. Fails where a request fails, and where an answer has no
 * types in it: that is the facts unread, and not no facts known.
 */
export async function combatUtilityTypes(typeIDs: readonly number[], options: ApiOptions = {}):
  Promise<Readonly<Record<number, import("../nav/combatUtilities.ts").UtilityType>>> {
  const asked = [...new Set(typeIDs)];
  const types: Record<number, import("../nav/combatUtilities.ts").UtilityType> = {};
  for (let at = 0; at < asked.length; at += COMBAT_UTILITY_TYPES_PER_REQUEST) {
    const data = await getJson(
      `/api/types/combat-utility?typeIDs=${encodeURIComponent(asked.slice(at, at + COMBAT_UTILITY_TYPES_PER_REQUEST).join(","))}`,
      options,
    );
    if (typeof data.types !== "object" || data.types === null || Array.isArray(data.types)) {
      throw new Error("The types' facts could not be read (the BFF did not answer with them).");
    }
    for (const [key, value] of Object.entries(data.types as Record<string, JsonValue>)) {
      const typeID = Number(key);
      if (Number.isSafeInteger(typeID) && typeID > 0 && typeof value === "object" && value !== null && !Array.isArray(value)) {
        types[typeID] = value as unknown as import("../nav/combatUtilities.ts").UtilityType;
      }
    }
  }
  return types;
}

// A module is fitted and unfitted by the page's own call on an inventory's own object (bridge/fitModule.ts), by
// the page's own read of the slots before and after: the two routes (POST /api/bridge/fitting/fit and .../unfit)
// went on 2026-10-13.

// A fitted module is put online and taken offline by the page's own call (bridge/dogmaWrites.ts,
// setModuleOnline): its route (POST /api/bridge/fitting/state) went on 2026-10-13.

// A fitted rig is destroyed by the page's own call on the ship's own inventory (bridge/fitModule.ts, destroyRig),
// judged by the page's own read of the slots: its route (POST /api/bridge/fitting/destroy-rig) went on 2026-10-14.

/**
 * R21 slice B — the bound-dogma snapshot: the active ship and every fitted
 * module, each with the SERVER's post-dogma attribute map (skills + hull +
 * in-space effects already applied). Read alongside the fitting panel so a
 * clicked module can show its EFFECTIVE stats; decoded by bridge/boundDogma.ts,
 * which folds each of the 11 independent reads' {result}/{error} envelopes into
 * typed cells. The Fitting window consumes only `allInfo`.
 */
/**
 * The client's own static dogma data for types (GET /api/client-data/dogma-types): each type's attributes, effects,
 * group, category and required skills; the effects' categories and modifierInfo; the attributes' records. What the
 * page's own dogma reckons with (bridge/dogma/location.ts). At most 50 types and 200 further attributes at once.
 */
export async function getDogmaTypes(
  typeIDs: readonly number[],
  attributeIDs: readonly number[],
  options: ApiOptions = {},
): Promise<import("../bridge/dogma/location.ts").DogmaStatic & { readonly available: boolean }> {
  const query = `typeIDs=${typeIDs.join(",")}&attributeIDs=${attributeIDs.join(",")}`;
  const data = (await getJson(`/api/client-data/dogma-types?${query}`, options)) as Record<string, unknown>;
  return {
    available: data.available === true,
    types: (data.types ?? {}) as import("../bridge/dogma/location.ts").DogmaStatic["types"],
    effects: (data.effects ?? {}) as import("../bridge/dogma/location.ts").DogmaStatic["effects"],
    attributes: (data.attributes ?? {}) as import("../bridge/dogma/location.ts").DogmaStatic["attributes"],
  };
}

export async function boundDogma(options: ApiOptions = {}): Promise<BoundDogma> {
  const data = await getJson("/api/bridge/bound-dogma", options);
  return decodeBoundDogma(data);
}

// --- R15 Industry ----------------------------------------------------------
// Industry needs no bound-object machinery: the whole retail surface is
// top-level, so the BFF simply issues five independent calls and hands back
// their raw retail-shaped results, decoded in the flow with bridge/industry.ts.
// Names and recipes come separately from static data, which never varies by
// player and so never needs the live session at all.

/** One of the five industry reads, with its own error (they are independent). */
export interface RawIndustryRead {
  readonly result: JsonValue;
  readonly error: string | null;
}

export interface RawIndustryReads {
  readonly ownerID: number | null;
  readonly stationID: number | null;
  readonly solarSystemID: number | null;
  readonly blueprints: RawIndustryRead;
  readonly jobs: RawIndustryRead;
  readonly jobCounts: RawIndustryRead;
  readonly facilities: RawIndustryRead;
  readonly activityModifiers: RawIndustryRead;
}

function asIndustryRead(value: JsonValue | undefined): RawIndustryRead {
  const row = (value ?? {}) as Record<string, JsonValue>;
  return {
    result: row.result ?? null,
    error: typeof row.error === "string" ? row.error : null,
  };
}

/** Read the player's blueprints, jobs, job slots, and available facilities. */
export async function loadIndustry(options: ApiOptions = {}): Promise<RawIndustryReads> {
  const data = await getJson("/api/bridge/industry", options);
  return {
    ownerID: asNumberOrNull(data.ownerID),
    stationID: asNumberOrNull(data.stationID),
    solarSystemID: asNumberOrNull(data.solarSystemID),
    blueprints: asIndustryRead(data.blueprints),
    jobs: asIndustryRead(data.jobs),
    jobCounts: asIndustryRead(data.jobCounts),
    facilities: asIndustryRead(data.facilities),
    activityModifiers: asIndustryRead(data.activityModifiers),
  };
}

/**
 * The static recipes for a set of blueprint types: which activities each one
 * supports, what they consume, and how long they take. Read-only reference
 * data — no live session is involved, so this survives a lost bridge session.
 */
export async function loadIndustryDefinitions(
  blueprintTypeIDs: readonly number[],
  options: ApiOptions = {},
): Promise<Readonly<Record<string, JsonValue>>> {
  if (blueprintTypeIDs.length === 0) {
    return {};
  }
  const data = await postJson(
    "/api/industry/blueprints",
    { blueprintTypeIDs: [...blueprintTypeIDs] },
    options,
  );
  const definitions = data.definitions;
  return typeof definitions === "object" && definitions !== null && !Array.isArray(definitions)
    ? (definitions as Readonly<Record<string, JsonValue>>)
    : {};
}

/** What an install would draw on: the request the preview and the install share. */
export interface IndustryJobRequest {
  readonly blueprintItemID: number;
  readonly blueprintTypeID: number;
  /** An activity NAME. The activityID lives only on the BFF. */
  readonly activity: IndustryActivity;
  readonly facilityID: number;
  readonly runs: number;
  readonly licensedRuns?: number;
  readonly productTypeID?: number;
  /** Invention only: a decryptor, used one per run. */
  readonly decryptorTypeID?: number;
  /** The blueprint's own time research, as it was read of the blueprint: a job's time is reckoned from it. */
  readonly timeEfficiency?: number;
  /** And its material research: a manufacturing job's materials are reckoned from it. */
  readonly materialEfficiency?: number;
}

export interface IndustryPreviewResult {
  /** typeID -> how much of it the player HAS at the input hangar (server-read). */
  readonly available: Readonly<Record<string, number>>;
  /**
   * The seconds the job will take, reckoned as the game's own client reckons them and sent with the job, which
   * the server holds against its own. Null where they were not reckoned: the server then works the time out alone.
   */
  readonly timeSeconds: number | null;
  /**
   * What the job costs to start, reckoned as the game's own client reckons it: the job's cost, the facility's
   * tax, the SCC's surcharge and a safe system's security tax, and their total. Null where it was not reckoned:
   * what is charged is then the server's to work out.
   */
  readonly fee: IndustryJobFee | null;
  /**
   * typeID -> how much of it the job will USE, reckoned as the game's own client reckons it and sent with the job,
   * which the server holds against its own. Null where they were not reckoned: the server then works them out alone.
   */
  readonly materials: Readonly<Record<string, number>> | null;
  /**
   * The number of the monitor the server keeps for the job, where the pilot's transport keeps it open: the
   * server's notice of what the job's place has names it (OnIndustryMaterials). Null where it was let go.
   */
  readonly monitorID: number | null;
}

// What a job will take and what its place has: the page's own since 2026-10-14 (app/flow.ts, previewIndustryJob;
// bridge/industryMonitor.ts). Until then POST /api/bridge/industry/preview, whose answer this was.

// A job is installed by the page's own call since 2026-10-14 (app/flow.ts, installIndustryJob;
// bridge/industryMonitor.ts, installJob). Until then POST /api/bridge/industry/install.

// The Industry window's events are the page's own since 2026-10-14 (app/flow.ts, industryWindowClosed and
// industryJobLetGo): until then POST /api/bridge/industry/window told the transport.

// A finished job is delivered, and a job stopped, by the page's own calls (bridge/industryWrites.ts:
// industryManager.CompleteJob and CancelJob, each with the job's own solar system, and judged by the job the
// server answers). Each left its route (POST /api/bridge/industry/deliver, POST /api/bridge/industry/cancel)
// on 2026-10-11.

// --- R16 Market ------------------------------------------------------------
// Like industry, the whole retail market surface is top-level, so the BFF
// issues independent calls and hands back their raw retail-shaped results,
// decoded in the flow with bridge/market.ts. All of it is `marketProxy` — the
// `market` service is a dead stub (see src/server.js) — and the sorting /
// filtering / best-price logic is CLIENT-side, because in retail it is too.

/** One market read, with its own error (they are independent). */
export interface RawMarketRead {
  readonly result: JsonValue;
  readonly error: string | null;
}

export interface RawMarketReads {
  readonly typeID: number | null;
  readonly characterID: number | null;
  readonly stationID: number | null;
  /** The structure the pilot is docked in; null in a station and in space. */
  readonly structureID: number | null;
  readonly solarSystemID: number | null;
  /** The broker's fee rate the pilot pays where it is docked, as a fraction; null where the BFF cannot work it out. */
  readonly brokersFeeRate: number | null;
  readonly book: RawMarketRead;
  readonly ownOrders: RawMarketRead;
  readonly orderHistory: RawMarketRead;
  readonly transactions: RawMarketRead;
  readonly escrow: RawMarketRead;
  readonly cashBalance: RawMarketRead;
  /** The type's price history, in the two halves the game asks it in: this is the new half, and the old one is beside it. */
  readonly priceHistory: RawMarketRead;
  readonly priceHistoryOld: RawMarketRead;
  /** Non-null when the market DAEMON is not answering (≠ "no orders"). */
  readonly marketUnavailable: string | null;
}

function asMarketRead(value: JsonValue | undefined): RawMarketRead {
  const row = (value ?? {}) as Record<string, JsonValue>;
  return {
    result: row.result ?? null,
    error: typeof row.error === "string" ? row.error : null,
  };
}

/**
 * Read the market: an item's order book (when a type is chosen), the player's
 * own orders, their closed-order history, their trades, their escrow, their
 * price history and their ISK.
 */
export async function loadMarket(
  typeID: number | null,
  options: ApiOptions = {},
): Promise<RawMarketReads> {
  const query = typeID && typeID > 0 ? `?typeID=${encodeURIComponent(String(typeID))}` : "";
  const data = await getJson(`/api/bridge/market${query}`, options);
  return {
    typeID: asNumberOrNull(data.typeID),
    characterID: asNumberOrNull(data.characterID),
    stationID: asNumberOrNull(data.stationID),
    structureID: asNumberOrNull(data.structureID),
    solarSystemID: asNumberOrNull(data.solarSystemID),
    brokersFeeRate: typeof data.brokersFeeRate === "number" && Number.isFinite(data.brokersFeeRate) && data.brokersFeeRate >= 0 ? data.brokersFeeRate : null,
    book: asMarketRead(data.book),
    ownOrders: asMarketRead(data.ownOrders),
    orderHistory: asMarketRead(data.orderHistory),
    transactions: asMarketRead(data.transactions),
    escrow: asMarketRead(data.escrow),
    cashBalance: asMarketRead(data.cashBalance),
    priceHistory: asMarketRead(data.priceHistory),
    priceHistoryOld: asMarketRead(data.priceHistoryOld),
    marketUnavailable:
      typeof data.marketUnavailable === "string" ? data.marketUnavailable : null,
  };
}

/**
 * What a market write ACTUALLY did.
 *
 * ⚠ `applied` is the page's own RE-READ (of the wallet, of the player's own
 * orders: bridge/marketOrderWrites.ts), never an echo of the request — the
 * R12/R14/R15 lesson. ⚠ `charged` is the wallet balance BEFORE minus the balance
 * AFTER: the only authoritative statement about what an order cost. The
 * estimated broker fee the confirm step showed never appears here, and is never
 * compared against this.
 */
export interface MarketChangeResult {
  readonly applied: boolean;
  readonly declinedSilently: boolean;
  /** ISK taken (positive) or returned (negative), as a decimal string. */
  readonly charged: string | null;
  readonly balanceAfter: string | null;
  /** The re-read own-orders rowset (raw; decoded by bridge/market.ts), where one was kept. */
  readonly ownOrders: JsonValue;
}

// Orders are placed, repriced and taken down by the page's own calls (bridge/marketOrderWrites.ts), with the page's
// own reads of the pilot's orders and wallet for each verdict: the cancel's route (POST /api/bridge/market/cancel)
// went on 2026-10-13, and the buy's, the sale's and the reprice's (.../buy, .../sell, .../modify) on 2026-10-14. A
// cancel returns what the order was holding; the broker's fee already paid is NOT returned, which is why the UI
// says so before asking.

// --- Fleet management writes + the fleet-state read (fleet-mgmt bot blocks) ---
// The writes are confirm-gated server-side; the reader passes `confirm:true` as the
// second gate. Each returns the uniform ack; callers re-read /bound-fleet to prove
// the mutation (⚠ these decoders are fast-mode educated guesses — never fired live,
// so a live QA pass is owed). The bound-fleet READ, by contrast, is verified live:
// a char with no fleet gets a FleetNotFound per read (a real "not in a fleet"), so
// a null fleetID after decode is authoritative, not a blanking failure.

/** Raw /api/bridge/bound-fleet envelope; decode with bridge/boundFleet.decodeBoundFleet. */
export async function loadBoundFleet(options: ApiOptions = {}): Promise<Record<string, JsonValue>> {
  return getJson("/api/bridge/bound-fleet", options);
}

// A pilot is invited to the fleet by the page itself, with the client's own
// call on the fleet's object (bridge/fleetWrites.ts): it left its route
// (POST /api/bridge/fleet/invite) on 2026-10-11.

// The fleet finder is read by the page itself, with the client's own two calls
// (bridge/fleetFinderReads.ts: fleetProxy.GetAvailableFleetAds and
// GetMyFleetFinderAdvert): it left its route (GET /api/bridge/fleet-ads) on
// 2026-10-11.

// A fleet is applied to by the page itself, with the client's own call
// (bridge/fleetWrites.ts; the plan's Phase 6b): the seventh of its writes to
// leave its route (POST /api/bridge/fleet/apply), on 2026-10-10.

// A fleet is left by the page itself too, with the client's own call on the
// fleet's object (bridge/fleetWrites.ts): it left its route
// (POST /api/bridge/fleet/leave) on 2026-10-10.

// A broadcast to the fleet in the pilot's bubble is made by the page itself,
// with the client's own call and the client's own wait before it
// (bridge/fleetWrites.ts): the eighth of its writes to leave its route
// (POST /api/bridge/fleet/broadcast/bubble), on 2026-10-10.

// --- R17 Mail ---------------------------------------------------------------
// The mailbox and the bodies of its messages the page asks and keeps itself, by the generic call (app/flow.ts,
// syncMail and openMail), inflating a body as the client does (bridge/mail.ts, inflateMailBody).

// A mail is sent by the page itself, with the client's own call (bridge/mailWrites.ts, sendMail), held to the
// compose window's own checks: it left its route (POST /api/bridge/mail/send) on 2026-10-14.

// --- R17 Contracts ----------------------------------------------------------
// The BFF issues five independent reads plus a fan-out for the contracts
// ASSIGNED to this character, and hands back their raw retail-shaped results,
// decoded in the flow with bridge/contracts.ts.
//
// One WRITE: accepting a contract. It is confirm-gated at the BFF and guarded
// again in the game server, which refuses a contract you cannot accept and your
// own unassigned contract. Everything else on the contract surface — creating,
// completing, deleting, bidding — has a route but no caller here yet.

export interface RawContractRead {
  readonly result: JsonValue;
  readonly error: string | null;
}

/** The contracts assigned to this character, each fetched in full. */
export interface RawAssignedContracts {
  /** One GetContract bundle per contract, decoded in the flow. */
  readonly results: readonly JsonValue[];
  /**
   * How many are assigned in total — BEFORE the BFF's fan-out limit. Larger
   * than `results.length` means the list was cut short, not that contracts went
   * missing.
   */
  readonly numAssigned: number;
  readonly error: string | null;
}

export interface RawContractReads {
  readonly characterID: number | null;
  readonly page: number;
  readonly pageSize: number;
  readonly browse: RawContractRead;
  readonly outstanding: RawContractRead;
  readonly accepted: RawContractRead;
  readonly expired: RawContractRead;
  readonly summary: RawContractRead;
  readonly assigned: RawAssignedContracts;
  /**
   * ⚠ True ONLY when the browse SUCCEEDED and found nothing. EveJS has no
   * NPC/seed contract generator, so an empty public browse is EXPECTED — but
   * "the browse failed" and "this world has no contracts yet" are different
   * facts and the panel must never confuse them.
   */
  readonly worldHasNoContracts: boolean;
}

function asContractRead(value: JsonValue | undefined): RawContractRead {
  const row = (value ?? {}) as Record<string, JsonValue>;
  return {
    result: row.result ?? null,
    error: typeof row.error === "string" ? row.error : null,
  };
}

function asAssignedContracts(value: JsonValue | undefined): RawAssignedContracts {
  const row = (value ?? {}) as Record<string, JsonValue>;
  const results = Array.isArray(row.results) ? (row.results as readonly JsonValue[]) : [];
  return {
    results,
    // An older BFF sends no count at all; the rows themselves are then the
    // whole truth, so nothing claims the list was cut short.
    numAssigned: Number(row.numAssigned) || results.length,
    error: typeof row.error === "string" ? row.error : null,
  };
}

export async function loadContracts(
  page: number,
  options: ApiOptions = {},
): Promise<RawContractReads> {
  const query = page > 0 ? `?page=${encodeURIComponent(String(page))}` : "";
  const data = await getJson(`/api/bridge/contracts${query}`, options);
  return {
    characterID: asNumberOrNull(data.characterID),
    page: Number(data.page) || 0,
    pageSize: Number(data.pageSize) || 100,
    browse: asContractRead(data.browse),
    outstanding: asContractRead(data.outstanding),
    accepted: asContractRead(data.accepted),
    expired: asContractRead(data.expired),
    summary: asContractRead(data.summary),
    assigned: asAssignedContracts(data.assigned),
    worldHasNoContracts: data.worldHasNoContracts === true,
  };
}

/** One contract in full. */
export async function loadContractDetail(
  contractID: number,
  options: ApiOptions = {},
): Promise<JsonValue> {
  const data = await getJson(
    `/api/bridge/contracts/detail?contractID=${encodeURIComponent(String(contractID))}`,
    options,
  );
  return data.detail ?? null;
}

// A contract is taken on by the page itself, with the client's own call
// (bridge/contractWrites.ts; the plan's Phase 6b): the fifth of its writes to
// leave its route (POST /api/bridge/contracts/accept), on 2026-10-10.

// --- R37 Personal Assets ----------------------------------------------------
// READS ONLY. Raw retail shapes out; decoding is bridge/personalAssets.ts's
// job, as everywhere else.

// (Where the pilot's things are, and what is at one station, are the page's own reads since 2026-10-11:
// bridge/assetReads.ts. What each type measures is asked of the BFF's static data: loadTypeVolumes, below.)

/** One person match from /api/characters/find. */
export interface CharacterMatch {
  readonly characterID: number;
  readonly name: string;
}

/**
 * Find someone to write to, by NAME. ⚠ The one place the names rule runs
 * backwards (see the route): the player types a name, the panel carries the id
 * invisibly, and no numeric ID is ever shown.
 */
export async function findCharacters(
  q: string,
  options: ApiOptions = {},
): Promise<readonly CharacterMatch[]> {
  const trimmed = q.trim();
  if (trimmed.length < 2) {
    return [];
  }
  const data = await getJson(`/api/characters/find?q=${encodeURIComponent(trimmed)}`, options);
  return Array.isArray(data.matches)
    ? (data.matches as unknown as readonly CharacterMatch[])
    : [];
}

/** One tradable-item match from /api/market/find. */
export interface MarketTypeMatch {
  readonly typeID: number;
  readonly name: string;
  readonly groupName: string;
}

/** One branch of the market tree. */
export interface MarketGroupNode {
  readonly marketGroupID: number;
  readonly name: string;
  /**
   * Whether it holds items DIRECTLY. A group can have both children and types,
   * so this is not "is a leaf" — the panel shows items here as well as letting
   * you descend.
   */
  readonly hasTypes: boolean;
}

/**
 * Browse the market tree. `parentGroupID` of 0 (or absent) returns the roots.
 *
 * Static reference data, like `findMarketTypes` — so browsing works even when
 * the market daemon is not answering, and a player can find out what EXISTS
 * before asking what it costs.
 */
export async function loadMarketGroups(
  parentGroupID: number,
  options: ApiOptions = {},
): Promise<readonly MarketGroupNode[]> {
  const data = await getJson(`/api/market/groups?parent=${encodeURIComponent(String(parentGroupID))}`, options);
  const rows = Array.isArray((data as { groups?: unknown }).groups)
    ? ((data as { groups: unknown[] }).groups)
    : [];
  return rows.map((row) => {
    const entry = row as Record<string, unknown>;
    return {
      marketGroupID: Number(entry.marketGroupID) || 0,
      name: String(entry.name ?? ""),
      hasTypes: entry.hasTypes === true,
    };
  });
}

/** The tradable items sitting directly in one market group. */
export async function loadMarketGroupTypes(
  marketGroupID: number,
  options: ApiOptions = {},
): Promise<{ readonly types: readonly MarketTypeMatch[]; readonly total: number; readonly capped: boolean }> {
  const data = await getJson(`/api/market/group-types?group=${encodeURIComponent(String(marketGroupID))}`, options);
  const rows = Array.isArray((data as { types?: unknown }).types)
    ? ((data as { types: unknown[] }).types)
    : [];
  return {
    types: rows.map((row) => {
      const entry = row as Record<string, unknown>;
      return {
        typeID: Number(entry.typeID) || 0,
        name: String(entry.name ?? ""),
        groupName: String(entry.groupName ?? "Unknown"),
      };
    }),
    total: Number((data as { total?: unknown }).total) || 0,
    capped: (data as { capped?: unknown }).capped === true,
  };
}

/**
 * Search tradable items by NAME. Static reference data, so it works before the
 * market itself answers — and it is the only way the panel ever obtains a
 * typeID, because the player must never be asked for one (R7d).
 */
export async function findMarketTypes(
  q: string,
  options: ApiOptions = {},
): Promise<readonly MarketTypeMatch[]> {
  const trimmed = q.trim();
  if (trimmed.length < 2) {
    return [];
  }
  const data = await getJson(
    `/api/market/find?q=${encodeURIComponent(trimmed)}`,
    options,
  );
  return Array.isArray(data.matches)
    ? (data.matches as unknown as readonly MarketTypeMatch[])
    : [];
}

/** One ore family (a type group in the Asteroid category) from /api/ore/families. */
export interface OreFamily {
  readonly groupID: number;
  readonly name: string;
}

/**
 * List the ore families the bot editor's ore picker can offer. Static
 * reference data, like `findMarketTypes` — no gateway call, so it works even
 * before a character is selected.
 */
export async function listOreFamilies(options: ApiOptions = {}): Promise<readonly OreFamily[]> {
  const data = await getJson("/api/ore/families", options);
  return Array.isArray((data as { families?: unknown }).families)
    ? ((data as { families: unknown }).families as unknown as readonly OreFamily[])
    : [];
}

/** One belt the BFF's shared belt memory says is dry, from /api/bots/belt-memory. */
export interface DryBeltRow {
  readonly beltName: string;
  readonly all: boolean;
  readonly families: readonly number[];
}

/**
 * Read the shared belt memory for one solar system, by NAME (belt entity ids
 * are grid-local — see src/beltMemory.js). In-process on the BFF, never
 * persisted, and shared by every pilot's mining bot.
 */
export async function readBeltMemory(
  system: string,
  options: ApiOptions = {},
): Promise<readonly DryBeltRow[]> {
  const data = await getJson(`/api/bots/belt-memory?system=${encodeURIComponent(system)}`, options);
  return Array.isArray((data as { belts?: unknown }).belts)
    ? ((data as { belts: unknown }).belts as unknown as readonly DryBeltRow[])
    : [];
}

/**
 * Tell the shared belt memory that `beltName` in `system` has no rocks left
 * (`groupID` null) or none of one ore family (`groupID` = the family's type
 * group).
 */
export async function rememberBeltDry(
  system: string,
  beltName: string,
  groupID: number | null,
  options: ApiOptions = {},
): Promise<void> {
  await postJson("/api/bots/belt-memory", { system, beltName, groupID }, options);
}

/**
 * Which wrecks and cans in `solarSystemID` somebody has already emptied, from
 * the BFF's shared loot memory (src/lootMemory.js). In-process, never
 * persisted, and shared by every pilot on this BFF — including the hand-flown
 * client, whose own loot verb reports into it through the same path a bot uses.
 *
 * ⚠ THIS EXISTS BECAUSE "IS THERE ANYTHING IN THAT WRECK" CANNOT BE ASKED FROM
 * ACROSS THE GRID. The server refuses to list a can's contents past 2,500 m and
 * the slim item's `isEmpty` never reaches a web session, so the answer costs a
 * pilot the flight there. Reading this is how the SECOND pilot gets it free.
 */
export async function readEmptiedContainers(
  solarSystemID: number,
  options: ApiOptions = {},
): Promise<readonly number[]> {
  const data = await getJson(
    `/api/bots/loot-memory?system=${encodeURIComponent(String(solarSystemID))}`,
    options,
  );
  return asNumberList(data.itemIDs);
}

/**
 * Tell the shared loot memory that `itemID` came up empty — it held nothing, or
 * everything in it was taken.
 *
 * ⚠ ONLY THOSE TWO OUTCOMES. "It did not all fit aboard" is a fact about the
 * hull that looked, not about the can, and reporting it here would send a pilot
 * with room straight past a full wreck.
 */
export async function rememberContainerEmptied(
  solarSystemID: number,
  itemID: number,
  options: ApiOptions = {},
): Promise<void> {
  await postJson("/api/bots/loot-memory", { system: solarSystemID, itemID }, options);
}

/** The fleet's standing call, from /api/bots/squad-board. */
export interface SquadPrimary {
  readonly targetID: number;
  readonly calledByCharacterID: number | null;
}

/** Server derives membership and returns a fresh roster with separate publishers. */
export async function readMiningSupportAnchors(options: ApiOptions = {}): Promise<MiningSupportAnchorRead> {
  return decodeMiningSupportAnchorRead(await getJson("/api/bots/mining-support-anchors", options));
}

/** Only observation guards cross the wire. Identity/services come from BFF reads. */
export async function publishMiningSupportAnchor(observedShipID: number, observedAtMs: number, options: ApiOptions = {}, guards: { expectedCharacterID?: number; expectedFleetID?: number | string } = {}): Promise<MiningSupportAnchor> {
  const data = await postJson("/api/bots/mining-support-anchors", { observedShipID, observedAtMs, ...guards }, options);
  const anchor = decodeMiningSupportAnchor(data.anchor);
  if (anchor === null) throw new Error("Mining support anchor publication could not be decoded.");
  return anchor;
}

/**
 * The primary this character's FLEET has called, or null when nobody has called
 * anything (or the call has gone stale). BFF-local, shared by every pilot in
 * that fleet — see src/squadBoard.js.
 *
 * ⚠ THE FLEET IS THE SERVER'S ANSWER, NOT A PARAMETER. The route keys on the
 * fleet the BFF resolved for this session, so there is nothing to pass and no
 * way to read another fleet's call. A session whose fleet is unknown is refused
 * (409 FLEET_UNKNOWN), which the caller reads as "no call" — never as an error
 * worth stopping a bot for.
 */
export async function readSquadPrimary(options: ApiOptions = {}): Promise<SquadPrimary | null> {
  const data = await getJson("/api/bots/squad-board", options);
  const primary = data.primary;
  if (typeof primary !== "object" || primary === null || Array.isArray(primary)) {
    return null;
  }
  const row = primary as Record<string, JsonValue>;
  const targetID = asNumberOrNull(row.targetID);
  return targetID === null ? null : { targetID, calledByCharacterID: asNumberOrNull(row.calledByCharacterID) };
}

/** Call a primary for this character's fleet, or clear the call with null. */
export async function callSquadPrimary(
  targetID: number | null,
  options: ApiOptions = {},
): Promise<void> {
  await postJson("/api/bots/squad-board", { targetID }, options);
}

/**
 * Ship a batch of flight-recorder lines to THIS character's log (the BFF keys
 * on the held session's character, so there is nothing to name here). Fire and
 * forget by design: the caller drops the batch if this throws.
 */
export async function appendBotLog(
  entries: readonly unknown[],
  options: ApiOptions = {},
): Promise<void> {
  await postJson("/api/bots/bot-log", { entries }, options);
}

/** One character's bot log — the current run, or one of the two before it. */
export async function readBotLog(
  which: "current" | "previous" | "previous2" = "current",
  options: ApiOptions = {},
): Promise<readonly JsonValue[]> {
  const data = await getJson(`/api/bots/bot-log?which=${which}`, options);
  return Array.isArray(data.lines) ? (data.lines as readonly JsonValue[]) : [];
}

// --- R4 Agents & Missions (agentMgr bridge) --------------------------------
// The BFF holds the bound agent handle; the browser addresses agents by game ID
// and decodes the raw retail-shaped conversation/briefing/journal results with
// bridge/agents.ts.

// (A station's agents are the page's own read since 2026-10-11: the whole table by bridge/agentReads.ts, kept by
// the flow, and those at the pilot's station picked from it.)

// What is said to an agent (DoAction) and the journal's "Remove Offer" are the page's own calls on the agent's
// object (bridge/agentWrites.ts): their routes (POST /api/bridge/agents/:agentID/action and .../remove-offer)
// went on 2026-10-13.

/** The security of these solar systems, by ID: a number, or null for an ID that is not a system's. */
export async function loadSystemSecurity(ids: readonly number[], options: ApiOptions = {}): Promise<Record<number, number | null>> {
  const data = await postJson("/api/map/security", { ids }, options);
  const raw = typeof data.security === "object" && data.security !== null && !Array.isArray(data.security) ? (data.security as Record<string, JsonValue>) : {};
  const security: Record<number, number | null> = {};
  for (const id of ids) {
    const value = raw[String(id)];
    security[id] = typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  return security;
}

/** What the client's agents service knows of one agent (raw; decoded in the flow). Null for an agent the server does not list. */
export async function loadAgentRecord(agentID: number, options: ApiOptions = {}): Promise<JsonValue> {
  const data = await getJson(`/api/bridge/agents/${agentID}/record`, options);
  return data.agent ?? null;
}

/** The solar system an agent is in, as the server answers agentMgr.GetSolarSystemOfAgent: its ID, or null for none. */
export async function loadAgentSolarSystem(agentID: number, options: ApiOptions = {}): Promise<number | null> {
  const data = await getJson(`/api/bridge/agents/${agentID}/solar-system`, options);
  const id = data.solarSystemID;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** A mission's objectives as the job board's page of it reads them (raw; decoded in the flow). */
export async function loadMissionObjectives(agentID: number, options: ApiOptions = {}): Promise<JsonValue> {
  const data = await getJson(`/api/bridge/agents/${agentID}/mission-objectives`, options);
  return data.objective ?? null;
}

/** The retail client's own record of a mission; null when the BFF cannot read the client's data, or the client has no such mission. */
export async function loadClientMission(missionID: number, options: ApiOptions = {}): Promise<JsonValue> {
  const data = await getJson(`/api/client-data/missions/${missionID}`, options);
  return data.mission ?? null;
}

/**
 * Each wallet journal entry kind's journal message, from the client's own built data (eveaccounting
 * get_entry_format_localization_id). `available` is false where the table could not be read.
 */
export async function loadAccountingEntryTypes(options: ApiOptions = {}): Promise<{ readonly available: boolean; readonly journalMessageIDs: Readonly<Record<string, number>> }> {
  const data = await getJson("/api/client-data/accounting-entry-types", options);
  return { available: data.available === true, journalMessageIDs: (data.journalMessageIDs ?? {}) as Record<string, number> };
}

/**
 * Each NPC corporation's faction, from the client's own built data (npccorporations get_corporation_faction_id), by
 * the corporation. `available` is false where the table could not be read.
 */
export async function loadCorporationFactions(options: ApiOptions = {}): Promise<{ readonly available: boolean; readonly factions: Readonly<Record<string, number>> }> {
  const data = await getJson("/api/client-data/corporation-factions", options);
  const raw = typeof data.factions === "object" && data.factions !== null && !Array.isArray(data.factions) ? (data.factions as Record<string, JsonValue>) : {};
  const factions: Record<string, number> = {};
  for (const [corporationID, factionID] of Object.entries(raw)) if (typeof factionID === "number") factions[corporationID] = factionID;
  return { available: data.available === true, factions };
}

/** How the client words each kind of notification, as its own code answers (null where it cannot be read). */
export async function loadNotificationFormats(options: ApiOptions = {}): Promise<unknown> {
  const data = await getJson("/api/client-data/notification-formats", options);
  return data.formats ?? null;
}

/**
 * Answer a question the SERVER asked (a `question` event on the live channel).
 * The BFF hands the answer to the game server, which has been waiting for it.
 */
export async function answerClientQuestion(
  questionID: string,
  answer: QuestionAnswer,
  options: ApiOptions = {},
): Promise<void> {
  await postJson(`/api/bridge/questions/${encodeURIComponent(questionID)}/answer`, { answer }, options);
}

export interface RawBriefingReads {
  readonly briefing: JsonValue;
  readonly objective: JsonValue;
  readonly location: JsonValue;
  readonly errors: {
    readonly briefing: string | null;
    readonly objective: string | null;
    readonly location: string | null;
  };
}

/** The bound-agent mission briefing reads (raw; decoded in the flow). */
export async function loadBriefing(
  agentID: number,
  options: ApiOptions = {},
): Promise<RawBriefingReads> {
  const data = await getJson(`/api/bridge/agents/${agentID}/briefing`, options);
  const errors = (data.errors ?? {}) as Record<string, JsonValue>;
  return {
    briefing: data.briefing ?? null,
    objective: data.objective ?? null,
    location: data.location ?? null,
    errors: {
      briefing: typeof errors.briefing === "string" ? errors.briefing : null,
      objective: typeof errors.objective === "string" ? errors.objective : null,
      location: typeof errors.location === "string" ? errors.location : null,
    },
  };
}

// The mission journal is read by the page itself, with the client's own call
// (bridge/journalReads.ts; the plan's Phase 6b). Until 2026-10-10 it was one
// route's (GET /api/bridge/journal).

// --- R6a Agent Finder (static agent reference data) ------------------------
// The Agent Finder lists agents from the static agentAuthority reference table
// (GET /api/agents/find) — read-only static data like /api/map/graph, NOT a
// gateway/bridge call. The BFF filters by kind/level and caps; the browser
// annotates each row with jumps from the current system (client-side BFS) and
// sorts nearest-first. This raw result carries the server-resolved names.

/** One agent from /api/agents/find (station/system names resolved server-side). */
export interface FoundAgent {
  readonly agentID: number;
  readonly name: string;
  readonly level: number | null;
  readonly divisionID: number | null;
  readonly agentTypeID: number | null;
  readonly missionKind: string | null;
  readonly missionTypeLabel: string | null;
  readonly corporationID: number | null;
  readonly factionID: number | null;
  readonly stationID: number | null;
  readonly stationName: string | null;
  readonly solarSystemID: number | null;
  readonly solarSystemName: string | null;
}

export interface FindAgentsResult {
  readonly kind: string;
  readonly level: number | null;
  readonly total: number;
  readonly capped: boolean;
  readonly agents: readonly FoundAgent[];
}

export interface FindAgentsFilters {
  /** Mission kind (default "courier"; "all" disables the kind filter). */
  readonly kind?: string;
  readonly level?: number | null;
  /** Server-side result cap (default 500 on the BFF; clamped to [1, 5000]). */
  readonly limit?: number;
}

function asFoundAgent(value: JsonValue): FoundAgent {
  const row = (value ?? {}) as Record<string, JsonValue>;
  return {
    agentID: asNumberOrNull(row.agentID) ?? 0,
    name: typeof row.name === "string" ? row.name : `Agent ${asNumberOrNull(row.agentID) ?? 0}`,
    level: asNumberOrNull(row.level),
    divisionID: asNumberOrNull(row.divisionID),
    agentTypeID: asNumberOrNull(row.agentTypeID),
    missionKind: typeof row.missionKind === "string" ? row.missionKind : null,
    missionTypeLabel: typeof row.missionTypeLabel === "string" ? row.missionTypeLabel : null,
    corporationID: asNumberOrNull(row.corporationID),
    factionID: asNumberOrNull(row.factionID),
    stationID: asNumberOrNull(row.stationID),
    stationName: typeof row.stationName === "string" ? row.stationName : null,
    solarSystemID: asNumberOrNull(row.solarSystemID),
    solarSystemName: typeof row.solarSystemName === "string" ? row.solarSystemName : null,
  };
}

/** Find agents from the static reference table (filtered + capped server-side). */
export async function findAgents(
  filters: FindAgentsFilters = {},
  options: ApiOptions = {},
): Promise<FindAgentsResult> {
  const params = new URLSearchParams();
  if (filters.kind !== undefined) {
    params.set("kind", filters.kind);
  }
  if (filters.level !== undefined && filters.level !== null) {
    params.set("level", String(filters.level));
  }
  if (filters.limit !== undefined) {
    params.set("limit", String(filters.limit));
  }
  const query = params.toString();
  const data = await getJson(`/api/agents/find${query ? `?${query}` : ""}`, options);
  return {
    kind: typeof data.kind === "string" ? data.kind : "courier",
    level: asNumberOrNull(data.level),
    total: asNumberOrNull(data.total) ?? 0,
    capped: data.capped === true,
    agents: Array.isArray(data.agents) ? data.agents.map(asFoundAgent) : [],
  };
}

// --- R6 Courier-completion reward readout (Step 12) ------------------------
// The post-completion wallet / LP / standings pull reads (account.GetCashBalance,
// LPSvc.GetAllMyCharacterWalletLPBalances, standingMgr.GetCharStandings). The
// BFF returns the raw retail-shaped results, decoded in the flow with
// bridge/rewards.ts. The journal (the fourth Step-12 read) uses loadJournal.

export interface RawRewardReads {
  readonly cash: JsonValue;
  readonly lp: JsonValue;
  readonly standings: JsonValue;
  readonly errors: {
    readonly cash: string | null;
    readonly lp: string | null;
    readonly standings: string | null;
  };
}

/** The wallet / LP / standings reward reads (raw; decoded in the flow). */
export async function loadRewards(options: ApiOptions = {}): Promise<RawRewardReads> {
  const data = await getJson("/api/bridge/rewards", options);
  const errors = (data.errors ?? {}) as Record<string, JsonValue>;
  return {
    cash: data.cash ?? null,
    lp: data.lp ?? null,
    standings: data.standings ?? null,
    errors: {
      cash: typeof errors.cash === "string" ? errors.cash : null,
      lp: typeof errors.lp === "string" ? errors.lp : null,
      standings: typeof errors.standings === "string" ? errors.standings : null,
    },
  };
}

// --- R50 Wallet + Corp Wallet ----------------------------------------------
// The wallet's reads are made by the page itself, call by call, as the client's
// wallet and account services make them (bridge/walletReads.ts; the plan's
// Phase 6b). Until 2026-10-10 they were one route's (GET /api/bridge/wallet).
// What is here is the asking they are made with.

export type { RawWalletReads } from "../bridge/walletReads.ts";

/**
 * One call of the server's, asked by the generic route (bridge/callMethod.ts)
 * with a flow's own options: its token, its fetch, its guard. The answer is the
 * call's result; the notifications that came with it are handed on, as a
 * route's answer's are. It is asked as a pilot's call: where the BFF holds no
 * pilot for the session it says so, as the route this asking stands in for did.
 *
 * `clock` is told the server's clock where an answer says it (wire.ts,
 * `serverNowMs`: a pilot on the game port). A route's sheet came with the time
 * it was made at; what the page makes itself it makes from this.
 */
export function bridgeAsk(options: ApiOptions = {}, clock?: (serverNowMs: number) => void): Ask {
  return asking(options, clock, false);
}

/**
 * One write of the server's, made by the generic route as `bridgeAsk` makes a
 * read: a pilot's call, and one the page says it means (`confirm`), which is
 * what a write's own route took as its confirmation. The BFF makes it only
 * where it is one of the writes the page makes itself
 * (src/bridgeCallPolicy.js); any other is refused, and has its route.
 */
export function bridgeDo(options: ApiOptions = {}, clock?: (serverNowMs: number) => void): Ask {
  return asking(options, clock, true);
}

function asking(options: ApiOptions, clock: ((serverNowMs: number) => void) | undefined, write: boolean): Ask {
  return async (service, method, args, kwargs = null, of) => {
    const notificationSink = options.captureNotificationSink?.();
    // (The options are read as they stand now: a flow's token is another one after another pilot is chosen.)
    const outcome = await callMethod(service, method, args, kwargs, { ...options, pilot: true, ...(write ? { confirm: true } : {}), ...(of !== undefined ? { of } : {}) });
    if (outcome.serverNowMs !== null) clock?.(outcome.serverNowMs);
    notificationSink?.(outcome.notifications as unknown as readonly JsonValue[]);
    return outcome.result;
  };
}

// --- R55 Standings ----------------------------------------------------------
// The standings' reads are made by the page itself, call by call, as the
// client's standings service and its panel make them (bridge/standingsReads.ts;
// the plan's Phase 6b). Until 2026-10-10 they were one route's
// (GET /api/bridge/standings).

// --- R56 Character Sheet ----------------------------------------------------
// The Character Sheet's reads are made by the page itself, call by call, as the
// client's windows make them (bridge/characterSheetReads.ts; the plan's Phase
// 6b). Until 2026-10-10 they were one route's (GET /api/bridge/character-sheet).

// --- R7 Local + Corp chat --------------------------------------------------
// The BFF holds the bridgeSessionID; the browser addresses channels by name.
// READ is a backlog poll (chat delivery bypasses the notification drain), so
// the panel polls /api/bridge/chat/:channel while open. The raw `chat` object
// (roster + backlog) is decoded in the flow with bridge/chat.ts.

/** Read a chat channel's roster + recent backlog (raw; decoded in the flow). */
export async function readChat(
  channel: "local" | "corp",
  options: ApiOptions = {},
): Promise<JsonValue> {
  const data = await getJson(`/api/bridge/chat/${channel}`, options);
  return data.chat ?? null;
}

/** Send a message to a chat channel; returns the raw send echo. */
export async function sendChat(
  channel: "local" | "corp",
  message: string,
  options: ApiOptions = {},
): Promise<JsonValue> {
  const data = await postJson(`/api/bridge/chat/${channel}/send`, { message }, options);
  return data.chat ?? null;
}

// --- R10 Live event channel (SSE) ------------------------------------------
// The BFF republishes its gateway push WebSocket to the browser as Server-Sent
// Events on GET /api/bridge/events (same-origin, cookie-authed). Frames are
// either gateway frames (`source: "evejs-web-gateway"`) or BFF status frames
// (`source: "evejs-web-bff"`, `type: "stream-status"`).
//
// EventSource handles reconnection itself, so this is deliberately thin. It is
// a LIVENESS channel only — every bridge response still carries its notification
// drain — so a browser without EventSource, or one whose stream never connects,
// simply keeps polling.
//
// Where the page is set to the tab's socket (app/pageFetch.ts), the same frames
// come on the session's socket and no EventSource is opened: the BFF runs this
// same route for as long as the page listens (src/pilotSocket.js). The
// EventSource is the way back, opened if the socket is not to be had.

export interface BridgeEventSubscription {
  close(): void;
}

export interface BridgeEventHandlers {
  readonly onFrame: (frame: JsonValue) => void;
  readonly onOpen?: () => void;
  readonly onError?: () => void;
}

/** Minimal EventSource surface, so tests can inject a fake. */
export interface EventSourceLike {
  onmessage: ((event: { data: string }) => void) | null;
  onopen: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  close(): void;
}

export interface BridgeEventOptions extends ApiOptions {
  /** Injectable EventSource factory for tests; default globalThis.EventSource. */
  readonly eventSource?: (url: string) => EventSourceLike;
}

/**
 * Subscribe to the live bridge event channel. Returns a handle whose `close()`
 * detaches; call it when the character goes offline or the page unmounts.
 */
export function subscribeBridgeEvents(
  handlers: BridgeEventHandlers,
  options: BridgeEventOptions = {},
): BridgeEventSubscription {
  // Native EventSource still sends same-origin cookies. Without an explicit
  // token in the URL, a tokenless flow would subscribe as another pilot.
  if ("token" in options && !options.token) {
    handlers.onError?.();
    return { close() {} };
  }
  // R42/R107 — `EventSource` cannot set request headers, so this is the one URL
  // in the client that carries the session token in its query string. Without it
  // the stream would fall back to the shared cookie and a second character would
  // watch the first's account go about its business: a per-session subscription
  // with a shared push channel is half a feature. Per-session (key present)
  // carries this flow's OWN token; otherwise the per-tab global. See
  // `requireStreamAuth` in src/server.js for why the query carrier is bounded to
  // this route alone.
  const eventsPath = `${options.baseUrl ?? ""}/api/bridge/events`;
  const url =
    "token" in options ? withTokenQuery(eventsPath, options.token) : withSessionTokenQuery(eventsPath);
  const factory =
    options.eventSource ??
    (typeof globalThis.EventSource === "function"
      ? (target: string) =>
          new globalThis.EventSource(target, {
            withCredentials: true,
          }) as unknown as EventSourceLike
      : null);

  let closed = false;
  let source: EventSourceLike | null = null;
  /** The event stream over HTTP: the only way where the page is not on its socket, and the way back where it is. */
  const overHttp = (): void => {
    if (!factory) {
      // No EventSource in this environment: report the failure once so the caller
      // stays on its polls rather than waiting for events that cannot arrive.
      handlers.onError?.();
      return;
    }
    let made: EventSourceLike;
    try {
      made = factory(url);
    } catch {
      handlers.onError?.();
      return;
    }
    source = made;
    made.onopen = () => {
      if (!closed) {
        handlers.onOpen?.();
      }
    };
    made.onmessage = (event) => {
      if (closed) {
        return;
      }
      let frame: JsonValue;
      try {
        frame = JSON.parse(event.data) as JsonValue;
      } catch {
        return; // A malformed frame is ignored, never thrown at the page.
      }
      handlers.onFrame(frame);
    };
    made.onerror = () => {
      if (!closed) {
        handlers.onError?.();
      }
    };
  };

  // On the session's socket, where the page is set to it and the session has a token to say hello with. An
  // event source handed in is used as it is, as a fetch handed in is.
  const token = "token" in options ? options.token : getSessionToken();
  const socket = options.eventSource === undefined && typeof token === "string" ? pageSocket() : null;
  const pushes =
    socket === null
      ? null
      : socket.listen(token as string, {
          onOpen: () => {
            if (!closed) {
              handlers.onOpen?.();
            }
          },
          onFrame: (frame) => {
            if (!closed) {
              handlers.onFrame(frame as JsonValue);
            }
          },
          // Refused or ended by the BFF: as an event stream that failed says it. It is not asked for again here;
          // the page listens anew each time a pilot is chosen.
          onEnded: () => {
            if (!closed) {
              handlers.onError?.();
            }
          },
          onUnavailable: overHttp,
        });
  if (socket === null) {
    overHttp();
  }

  return {
    close() {
      closed = true;
      pushes?.close();
      try {
        source?.close();
      } catch {
        // Already closed.
      }
    },
  };
}

// --- R5a Flight (manually-stepped space movement) --------------------------
// The BFF holds the beyonce bound park handle server-side and returns the raw
// flight-status snapshot (decoded in the flow with bridge/flight.ts). Movement
// refusals pass through as the handler's own CALL_REFUSED message.

/** One flight step's outcome: the raw flight snapshot after the step + notifications. */
export interface FlightStepResult {
  readonly flight: JsonValue;
  readonly notifications: readonly JsonValue[];
}

function readFlightStep(data: Record<string, JsonValue>): FlightStepResult {
  return {
    flight: data.flight ?? null,
    notifications: Array.isArray(data.notifications) ? data.notifications : [],
  };
}

/** Read the current flight status (location + ship movement state). */
export async function getFlightStatus(options: ApiOptions = {}): Promise<FlightStepResult> {
  return readFlightStep(await getJson("/api/bridge/flight/status", options));
}

export interface HealthResult {
  /** The BFF answered AND the EveJS gateway RUNTIME is up, so a login can land. */
  readonly ready: boolean;
}

function asObject(value: JsonValue | undefined): Record<string, JsonValue> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : null;
}

/**
 * The boot health ping (GET /api/health). "Ready" = the BFF answered ok AND the
 * EveJS gateway RUNTIME reports ready (`gateway.runtime.ready`) — which is all a
 * login needs (it only reads `/account` off the gateway).
 *
 * ⚠ NOT the top-level `gateway.ready`: that flag is stricter than login — it
 * also demands the optional characterEvents gateway TOKEN, so a perfectly usable
 * server with that token unset (the normal dev setup) reports `gateway.ready:
 * false` while `gateway.runtime.ready: true`. Gating on the top-level flag is
 * what made login refuse against a live server. `gateway.ready` is still honored
 * as a fallback for fully-configured deployments.
 *
 * Deliberately never throws: an unreachable BFF/gateway (getStatus rejects → the
 * route 500s), or a not-ready runtime, all resolve to `{ ready: false }`.
 */
export async function getHealth(options: ApiOptions = {}): Promise<HealthResult> {
  try {
    const data = await getJson("/api/health", options);
    if (data.ok !== true) {
      return { ready: false };
    }
    const gateway = asObject(data.gateway);
    const runtime = asObject(gateway?.runtime);
    return { ready: runtime?.ready === true || gateway?.ready === true };
  } catch {
    return { ready: false };
  }
}

// The pilot undocks by the page's own call (bridge/placeChanges.ts): ship.Undock(shipID, ignoreContraband) through
// the generic call, under the BFF's keeping of the session change, since 2026-10-14; its route
// (POST /api/bridge/flight/undock) is gone. With `ignoreContraband` false, a ship carrying what the local law
// forbids is refused with CONTRABAND_WARNING and stays docked. The retail client asks its player then (OK /
// Cancel) and undocks again with the flag set (eve/client/script/ui/station/base.py, _DoUndockAttempt). A caller
// with no player to ask sends true, as the client does once that warning is suppressed.

/** Whether an undock was refused only to warn about contraband aboard. */
export function isContrabandWarning(error: unknown): error is BridgeCallError {
  return error instanceof BridgeCallError && String(error.code) === "CONTRABAND_WARNING";
}

// (A thing, the autopilot's destination and a fleet member are warped to by the page itself, with the client's own
// calls: bridge/movementWrites.ts, warpToItem, autopilotWarp and warpToFleetMember. Their routes are flight/warp
// and flight/warp-member.)

// The pilot jumps through a stargate by the page's own call since 2026-10-14 (bridge/placeChanges.ts, jump):
// beyonce.CmdStargateJump(the gate, its far gate or nought, the pilot's ship) through the generic call, under the BFF's
// keeping of the session change; its route (POST /api/bridge/flight/jump) is gone. A far gate of nought is resolved:
// the game port names the gate's own off its slim item, as the client does, and the server works it out from the gate
// (jumpSessionViaStargate rejects only a far gate that contradicts it).

// A station and a player structure are docked at by the page's own calls since 2026-10-14 (bridge/placeChanges.ts,
// dock and dockAtStructure): the dock route (POST /api/bridge/flight/dock) is gone.

// A fleet's target tag is set and cleared by the page itself, with the client's
// own call on its ballpark (bridge/fleetWrites.ts; the plan's Phase 6b): the
// seventeenth of its writes to leave its route (POST
// /api/bridge/flight/fleet-tag-target), on 2026-10-10.

/**
 * JUMP through a fleet-mate's cyno bridge (beyonce.CmdJumpThroughFleet).
 * Confirm-gated at the BFF; consumes bridge fuel and transitions the session
 * to a new system, so it also waits out the route-transition handshake there.
 *
 * `otherCharID`/`otherShipID` name the bridge owner's character and ship; the
 * BFF validates both against the session's own fleet membership server-side,
 * so a foreign (non-fleet) ship cannot be named here to hijack a bridge.
 */
export async function jumpThroughFleet(
  otherCharID: number,
  otherShipID: number,
  beaconID: number,
  solarSystemID: number,
  options: ApiOptions = {},
): Promise<BeyonceWriteAck> {
  const data = await postJson(
    "/api/bridge/flight/jump-through-fleet",
    { otherCharID, otherShipID, beaconID, solarSystemID, confirm: true },
    options,
  );
  return decodeBeyonceWriteAck(data as unknown as JsonValue);
}

// --- R11 Space overview + ship HUD -----------------------------------------
// A read-only snapshot of what the ship can see plus the active ship's
// shield/armor/hull/capacitor (decoded in the flow with bridge/space.ts). The
// page polls it ~1s while in space; distance/sorting/filtering are computed in
// the browser, exactly as the retail client does.

/** One space-snapshot read: the raw snapshot + the drained notifications. */
export interface SpaceSnapshotResult {
  readonly space: JsonValue;
  readonly notifications: readonly JsonValue[];
}

/** Read what is currently around the ship (and the ship's own condition). */
export async function getSpaceSnapshot(
  options: ApiOptions = {},
): Promise<SpaceSnapshotResult> {
  const data = await getJson("/api/bridge/space/snapshot", options);
  return {
    space: data.space ?? null,
    notifications: Array.isArray(data.notifications) ? data.notifications : [],
  };
}

// --- R23 slice A: targeting + module activation -----------------------------
//
// THE GENERIC IN-SPACE ACTION LAYER. Nothing here names mining, combat,
// salvaging or ewar. A target is a target; a module is a module; the effect
// name is an argument the caller supplies (or omits, in which case the SERVER
// resolves the module's own default activation effect from its typeID — the
// browser never guesses which effect a module runs). Slice B drives a mining
// laser through these five functions; a later combat goal drives a turret
// through the same five unchanged.

/** What the server says is locked right now — the only authority. */
export interface TargetsResult {
  readonly targetIDs: JsonValue;
  /** The ships that have the pilot's locked (dogmaIM.GetTargeters); null where the read could not say. */
  readonly targeterIDs: JsonValue;
  readonly notifications: readonly JsonValue[];
}

// A target is locked and let go by the page itself, with the client's own
// calls of the dogma location (bridge/targetWrites.ts), and what is locked is
// read after each by the read above: the two left their routes
// (POST /api/bridge/targets/lock and /api/bridge/targets/unlock) on 2026-10-11.

/**
 * One module activate/deactivate outcome, verified against the space snapshot's
 * activeModuleIDs. `active` / `stopped` are NULL when the snapshot could not
 * answer — "unknown", never "off".
 */
function readNotifications(data: Record<string, JsonValue>): readonly JsonValue[] {
  return Array.isArray(data.notifications) ? data.notifications : [];
}

/** Read the locked-target list (dogmaIM.GetTargets) and what has the pilot's ship locked (GetTargeters). */
export async function getTargets(options: ApiOptions = {}): Promise<TargetsResult> {
  const data = await getJson("/api/bridge/targets", options);
  return {
    targetIDs: data.targetIDs ?? null,
    targeterIDs: data.targeterIDs ?? null,
    notifications: readNotifications(data),
  };
}

// A module is switched on and off by the page's own calls since 2026-10-14 (bridge/dogmaWrites.ts: dogmaIM.Activate and
// Deactivate, as godma makes them); their routes (POST /api/bridge/modules/activate and .../deactivate) are gone. What
// the page reads for them is below.

/**
 * A module's state as the server's ship has it (GET /api/bridge/modules/:itemID/state): whether it has stopped,
 * the running modules, and with `cycle` its cycle's length where it is still running. The ship must be the one the
 * pilot is flying, or the read is refused.
 */
export async function getModuleState(
  itemID: number,
  shipID: number,
  cycle: boolean,
  options: ApiOptions = {},
): Promise<Record<string, JsonValue>> {
  return getJson(`/api/bridge/modules/${itemID}/state?shipID=${shipID}${cycle ? "&cycle=1" : ""}`, options);
}

/**
 * typeID -> the type's default effect by name, or null for a type with none or more than one
 * (GET /api/types/default-effects: the game's data, no call of the server's). A type the answer does not speak of,
 * or speaks of with anything but a name or null, is left out: it was not answered.
 */
export async function loadDefaultEffects(
  typeIDs: readonly number[],
  options: ApiOptions = {},
): Promise<Readonly<Record<number, string | null>>> {
  const data = await getJson(`/api/types/default-effects?typeIDs=${encodeURIComponent(typeIDs.join(","))}`, options);
  const raw = typeof data.defaultEffect === "object" && data.defaultEffect !== null && !Array.isArray(data.defaultEffect)
    ? (data.defaultEffect as Record<string, JsonValue>)
    : {};
  const effects: Record<number, string | null> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || (typeof value === "string" && value !== "")) effects[Number(key)] = value;
  }
  return effects;
}

// --- R23 slice B: the mining loop -------------------------------------------
//
// mine -> haul -> refine -> sell. There is no "start mining" call here and no
// mining cycle: mining a rock IS the generic lockTarget + activateModule above
// with a mining laser, flying to the belt is warpTo/orbit, and selling the
// minerals is the market functions. These five are only what was missing — a
// place to see the ore, a way to get it home, the scanner, and the refinery.

/** The ship's mining holds, each already named by the BFF (never a flagID). */
export interface MiningHoldsResult {
  readonly activeShipID: number | null;
  readonly holds: JsonValue;
}

/** What the scanner saw: `[[entityID, yieldTypeID, remainingQuantity]]`. */
export interface SurveyScanResult {
  /**
   * False where the BFF asked the server nothing, because the retail client would not have asked from this ship:
   * it has no mining scanner upgrade (asteroid_scanning_service.py 103). `results` is then null, and is no scan.
   */
  readonly asked: boolean;
  /** The ship's mining scanner upgrade as godma has it, where the BFF could read it; null where it is not known. */
  readonly scannerUpgrade: number | null;
  readonly results: JsonValue;
  readonly notifications: readonly JsonValue[];
}

/** The refinery's quote, with the station's ISK TAX RATE reported separately. */
export interface ReprocessingQuoteResult {
  readonly stationID: number | null;
  readonly taxRate: JsonValue;
  readonly quotes: JsonValue;
}

/**
 * What an unload or a reprocess ACTUALLY did, verified by re-reading. `moved` /
 * `processed` are null when the verification read itself failed — "we could not
 * check", which the page reports as such and never as success.
 */
export interface MiningActionResult {
  readonly requested: readonly number[];
  readonly moved: readonly number[] | null;
  readonly remaining: readonly number[] | null;
  readonly notifications: readonly JsonValue[];
}

/**
 * An unload, which additionally reports WHERE the load went. Kept apart from
 * the shared shape above because reprocessing has no destination to report and
 * would have to carry three fields it can never fill.
 */
export interface UnloadResult extends MiningActionResult {
  /**
   * The corporation division that took something, when the unload was aimed at
   * one and it worked. Null on every ordinary hangar unload — and also when the
   * corporation refused, which is what `fellBack` then explains.
   */
  readonly corpDivision: number | null;
  readonly movedToCorp: readonly number[];
  /**
   * Why a corporation delivery landed in the pilot's own hangar instead: the
   * server's own refusal code ("CrpAccessDenied" for a missing role),
   * "NO_CORP_OFFICE" when the corporation rents none here, or "CORP_REFUSED"
   * when it declined without saying why. Null when nothing fell back.
   */
  readonly fellBack: string | null;
}

function readIDArray(value: JsonValue | undefined): readonly number[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.map((entry) => Number(entry) || 0).filter((entry) => entry > 0);
}

/** Read the ship's ore / gas / ice holds (falling back to cargo). */
export async function getMiningHolds(options: ApiOptions = {}): Promise<MiningHoldsResult> {
  const data = await getJson("/api/bridge/ship/ore-hold", options);
  return {
    activeShipID: Number(data.activeShipID) || null,
    holds: data.holds ?? null,
  };
}

/**
 * Move mined ore from the ship's holds into the station hangar (docked only).
 *
 * `division` (1-7) aims the load at a CORPORATION hangar division instead. It
 * is a request, not a guarantee: no office at this station, or no role for that
 * division, and the BFF puts the load in the pilot's own hangar and says so in
 * `fellBack`. That is deliberate — the ore ends up somewhere the pilot can still
 * reach, at the station they flew to, rather than stuck aboard a ship that
 * cannot finish its lap.
 */
// (An unloading into the pilot's own hangar is the page's own call since 2026-10-14: app/flow.ts, unloadToOwnHangar,
// by bridge/inventoryWrites.ts, moveItems. This route is asked for a corporation division's delivery and an
// operation's strict one, which the bot host keeps.)
export async function unloadMiningHolds(
  itemIDs: readonly number[],
  options: ApiOptions = {},
  division: number | null = null,
  strictCorp = false,
): Promise<UnloadResult> {
  const body: Record<string, JsonValue> = { itemIDs: [...itemIDs] };
  if (division !== null) {
    body.division = division;
  }
  if (strictCorp) body.strictCorp = true;
  const data = await postJson("/api/bridge/ship/ore-hold/unload", body, options);
  return {
    requested: readIDArray(data.requested) ?? [],
    moved: readIDArray(data.moved),
    remaining: readIDArray(data.remaining),
    notifications: Array.isArray(data.notifications) ? data.notifications : [],
    corpDivision: asNumberOrNull(data.corpDivision),
    movedToCorp: readIDArray(data.movedToCorp) ?? [],
    fellBack: typeof data.fellBack === "string" ? data.fellBack : null,
  };
}

/** Run the survey scanner (miningScanMgr.perform_scan). Read-only. */
export async function runSurveyScan(options: ApiOptions = {}): Promise<SurveyScanResult> {
  const data = await getJson("/api/bridge/mining/scan", options);
  return {
    asked: data.asked !== false,
    scannerUpgrade: typeof data.scannerUpgrade === "number" && Number.isFinite(data.scannerUpgrade) ? data.scannerUpgrade : null,
    results: data.results ?? null,
    notifications: Array.isArray(data.notifications) ? data.notifications : [],
  };
}

/**
 * Ask the station's refinery what these stacks WOULD yield, and what it will
 * take. A pure read: nothing is consumed and no ISK is charged by this call.
 */
export async function getReprocessingQuote(
  itemIDs: readonly number[],
  options: ApiOptions = {},
): Promise<ReprocessingQuoteResult> {
  const query = encodeURIComponent(itemIDs.join(","));
  const data = await getJson(`/api/bridge/reprocessing/quote?itemIDs=${query}`, options);
  return {
    stationID: Number(data.stationID) || null,
    taxRate: data.taxRate ?? null,
    quotes: data.quotes ?? null,
  };
}

// Stacks are reprocessed at the refinery by the page itself, with the client's own call (bridge/reprocessWrites.ts),
// each item's place read by the page (app/flow.ts, reprocessNow): it left its route
// (POST /api/bridge/reprocessing/reprocess) on 2026-10-14.

// --- R5b Travel (client-side route solver static data) ---------------------
// The system-adjacency graph the browser route solver runs BFS over is served
// as read-only static reference data (GET /api/map/graph) — NOT a gateway call
// and NOT a server-side travel job (roadmap §7 / G2).

/** The compact system-adjacency graph payload (systems name map + edge tuples). */
export interface SystemGraphResult {
  readonly systems: Readonly<Record<string, string>>;
  readonly edges: ReadonlyArray<readonly [number, number, number, number]>;
  /** Each system's security as it was made, by its ID. */
  readonly security: Readonly<Record<string, number>>;
  /** The systems of the Triglavian Collective (idCheckers.IsTriglavianSystem). */
  readonly triglavian: readonly number[];
  /** Each system's constellation and region, by the system's ID. */
  readonly within: Readonly<Record<string, readonly [number, number]>>;
}

/** Fetch the system-adjacency graph for the client-side route solver. */
export async function loadSystemGraph(options: ApiOptions = {}): Promise<SystemGraphResult> {
  const data = await getJson("/api/map/graph", options);
  return {
    systems:
      typeof data.systems === "object" && data.systems !== null && !Array.isArray(data.systems)
        ? (data.systems as Record<string, string>)
        : {},
    edges: Array.isArray(data.edges)
      ? (data.edges as ReadonlyArray<readonly [number, number, number, number]>)
      : [],
    security:
      typeof data.security === "object" && data.security !== null && !Array.isArray(data.security)
        ? (data.security as Record<string, number>)
        : {},
    triglavian: Array.isArray(data.triglavian) ? data.triglavian.filter((id): id is number => typeof id === "number") : [],
    within:
      typeof data.within === "object" && data.within !== null && !Array.isArray(data.within)
        ? (data.within as Record<string, readonly [number, number]>)
        : {},
  };
}

/**
 * A destination resolved to its solar system — a station or system from static
 * reference data, or (R38) a player-owned structure from the live world.
 */
export interface ResolvedDestination {
  readonly id: number;
  readonly kind: "station" | "system" | "structure" | "unknown";
  readonly solarSystemID: number | null;
  readonly systemName: string | null;
  readonly stationID: number | null;
  readonly stationName: string | null;
  /**
   * R38 — true when this came back `unknown` because a player-structure lookup
   * could not be completed, rather than because nothing bears the ID. A caller
   * must not cache the miss when this is set.
   */
  readonly lookupFailed: boolean;
  /** A station's type (idCheckers.IsDeprecatedStation reads it); null for anything else, or where it is not known. */
  readonly stationTypeID: number | null;
}

/**
 * Resolve a picked destination ID to its solar system (a courier destination is
 * a station; the route solver works on systems).
 *
 * R38 — mostly static reference data, but a player-owned structure is a legal
 * destination that exists only at runtime, so the route answers `kind:"structure"`
 * for one. The structure's name and system are echoed into `stationName` /
 * `stationID` as well, because a structure IS a dockable place and every
 * existing caller already reads those fields; a caller that needs to tell the
 * two apart reads `kind`.
 */
export async function resolveDestination(
  id: number,
  options: ApiOptions = {},
): Promise<ResolvedDestination> {
  const data = await getJson(`/api/map/resolve/${id}`, options);
  return {
    id,
    kind:
      data.kind === "station" || data.kind === "system" || data.kind === "structure"
        ? data.kind
        : "unknown",
    solarSystemID: asNumberOrNull(data.solarSystemID),
    systemName: typeof data.systemName === "string" ? data.systemName : null,
    stationID: asNumberOrNull(data.stationID),
    stationName: typeof data.stationName === "string" ? data.stationName : null,
    lookupFailed: data.lookupFailed === true,
    stationTypeID: asNumberOrNull(data.stationTypeID),
  };
}

// --- R7a Map name search (set a destination by name) -----------------------
// The Travel tab searches the static solar-system + station tables by name
// (GET /api/map/find) so a player can set a destination without knowing EVE IDs.
// Read-only static reference data like /api/map/graph — NOT a gateway/bridge
// call. The chosen match's `id` is handed to startRoute (the R5b route solver +
// autopilot); the flow annotates jumps-away client-side from the map graph.

/** One name-search match from /api/map/find (a solar system or a station). */
export interface MapLocation {
  readonly id: number;
  readonly name: string;
  readonly kind: "system" | "station" | "structure";
  readonly solarSystemID: number | null;
  readonly solarSystemName: string | null;
}

export interface FindMapLocationsResult {
  readonly q: string;
  readonly kind: string | null;
  readonly total: number;
  readonly capped: boolean;
  readonly matches: readonly MapLocation[];
}

function asMapLocation(value: JsonValue): MapLocation {
  const row = (value ?? {}) as Record<string, JsonValue>;
  const kind = row.kind === "station" ? "station" : row.kind === "structure" ? "structure" : "system";
  return {
    id: asNumberOrNull(row.id) ?? 0,
    name: typeof row.name === "string" ? row.name : `Location ${asNumberOrNull(row.id) ?? 0}`,
    kind,
    solarSystemID: asNumberOrNull(row.solarSystemID),
    solarSystemName: typeof row.solarSystemName === "string" ? row.solarSystemName : null,
  };
}

/** Search the static map by name (systems + stations, or narrowed by kind). */
export async function findMapLocations(
  q: string,
  kind: "system" | "station" | null = null,
  options: ApiOptions = {},
): Promise<FindMapLocationsResult> {
  const params = new URLSearchParams();
  params.set("q", q);
  if (kind) {
    params.set("kind", kind);
  }
  const data = await getJson(`/api/map/find?${params.toString()}`, options);
  return {
    q: typeof data.q === "string" ? data.q : q,
    kind: typeof data.kind === "string" ? data.kind : null,
    total: asNumberOrNull(data.total) ?? 0,
    capped: data.capped === true,
    matches: Array.isArray(data.matches) ? data.matches.map(asMapLocation) : [],
  };
}

// ─── Player Bot Builder library (goal D2/D3) ─────────────────────────────────
// Platform-wide CRUD over the BFF's data/bot-scripts.json (src/botScriptStore.js)
// — the library is shared by every account, so a row may be someone else's.
// Web-app data, NOT a bridge/gateway call. The caller decodes a loaded `doc`
// through the browser codec (decode-on-read) before trusting it.

export interface BotScriptSummary {
  readonly scriptID: string;
  readonly name: string;
  readonly rev: number;
  readonly updatedAt: string;
  /**
   * Which account SAVED this bot. The library is platform-wide, so a row here
   * may well have been written by another account — this says who, and nothing
   * more. It confers no rights: authority over characters and running bots is
   * checked server-side and is still per account. Null when the server did not
   * say. NEVER RENDER THIS (R7d — a raw id never reaches a screen); show
   * `authorName` instead.
   */
  readonly authorAccountID: number | null;
  /**
   * The name that account went by when the bot was saved — the renderable half
   * of authorship, recorded at save time rather than looked up, so the library
   * never has to enumerate accounts to draw a list. Null for bots saved before
   * the library went platform-wide; render those as "—", never as a blank.
   */
  readonly authorName: string | null;
  /**
   * The category this bot is filed in, or null for Uncategorized. A bot is in
   * at most one category (a folder, not a tag).
   */
  readonly categoryID: string | null;
}

function asBotScriptSummary(value: JsonValue): BotScriptSummary {
  const row = (value ?? {}) as Record<string, JsonValue>;
  return {
    scriptID: typeof row.scriptID === "string" ? row.scriptID : "",
    name: typeof row.name === "string" ? row.name : "Untitled bot",
    rev: asNumberOrNull(row.rev) ?? 1,
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : "",
    authorAccountID: asNumberOrNull(row.authorAccountID),
    authorName: typeof row.authorName === "string" && row.authorName.length > 0 ? row.authorName : null,
    categoryID: typeof row.categoryID === "string" && row.categoryID.length > 0 ? row.categoryID : null,
  };
}

export async function listBotScripts(options: ApiOptions = {}): Promise<BotScriptSummary[]> {
  const data = await getJson("/api/botscripts", options);
  return Array.isArray(data.scripts) ? data.scripts.map(asBotScriptSummary) : [];
}

export async function getBotScript(
  scriptID: string,
  options: ApiOptions = {},
): Promise<{
  scriptID: string;
  rev: number;
  authorAccountID: number | null;
  authorName: string | null;
  categoryID: string | null;
  doc: JsonValue;
} | null> {
  try {
    const data = await getJson(`/api/botscripts/${encodeURIComponent(scriptID)}`, options);
    return {
      scriptID: typeof data.scriptID === "string" ? data.scriptID : scriptID,
      rev: asNumberOrNull(data.rev) ?? 1,
      authorAccountID: asNumberOrNull(data.authorAccountID),
      authorName: typeof data.authorName === "string" && data.authorName.length > 0 ? data.authorName : null,
      categoryID: typeof data.categoryID === "string" && data.categoryID.length > 0 ? data.categoryID : null,
      doc: data.doc ?? null,
    };
  } catch (error) {
    if (error instanceof BridgeCallError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * `categoryID` files the new bot: null or absent saves it Uncategorized.
 */
export async function createBotScript(
  doc: unknown,
  options: ApiOptions = {},
  categoryID: string | null = null,
): Promise<{ scriptID: string; rev: number }> {
  const data = await postJson("/api/botscripts", { doc, categoryID }, options);
  return { scriptID: typeof data.scriptID === "string" ? data.scriptID : "", rev: asNumberOrNull(data.rev) ?? 1 };
}

export async function updateBotScript(
  scriptID: string,
  doc: unknown,
  baseRev: number,
  options: ApiOptions = {},
  categoryID?: string | null,
): Promise<{ rev: number }> {
  // `categoryID` undefined leaves the bot where it is filed; null uncategorizes it.
  const body = categoryID === undefined ? { doc, baseRev } : { doc, baseRev, categoryID };
  const data = await postJson(`/api/botscripts/${encodeURIComponent(scriptID)}`, body, options);
  return { rev: asNumberOrNull(data.rev) ?? 1 };
}

export async function deleteBotScript(scriptID: string, options: ApiOptions = {}): Promise<void> {
  await postJson(`/api/botscripts/${encodeURIComponent(scriptID)}/delete`, {}, options);
}

// ─── Bot library categories (src/botScriptStore.js) ──────────────────────────
// Folders over the same shared library. Filing a bot is bookkeeping, not an
// edit: it never bumps the bot's revision. Deleting a category never deletes
// a bot; its bots become Uncategorized.

export interface BotCategory {
  readonly categoryID: string;
  readonly name: string;
}

/** Every category, in display order. */
export async function listBotCategories(options: ApiOptions = {}): Promise<BotCategory[]> {
  const data = await getJson("/api/botcategories", options);
  if (!Array.isArray(data.categories)) {
    return [];
  }
  return data.categories.flatMap((value) => {
    const row = (value ?? {}) as Record<string, JsonValue>;
    return typeof row.categoryID === "string" && typeof row.name === "string"
      ? [{ categoryID: row.categoryID, name: row.name }]
      : [];
  });
}

export async function createBotCategory(name: string, options: ApiOptions = {}): Promise<{ categoryID: string }> {
  const data = await postJson("/api/botcategories", { name }, options);
  return { categoryID: typeof data.categoryID === "string" ? data.categoryID : "" };
}

export async function renameBotCategory(categoryID: string, name: string, options: ApiOptions = {}): Promise<void> {
  await postJson(`/api/botcategories/${encodeURIComponent(categoryID)}`, { name }, options);
}

/** Move a category to `index` in the display order. */
export async function moveBotCategory(categoryID: string, index: number, options: ApiOptions = {}): Promise<void> {
  await postJson(`/api/botcategories/${encodeURIComponent(categoryID)}`, { index }, options);
}

/** Delete a category; answers how many bots became Uncategorized. */
export async function deleteBotCategory(
  categoryID: string,
  options: ApiOptions = {},
): Promise<{ uncategorized: number }> {
  const data = await postJson(`/api/botcategories/${encodeURIComponent(categoryID)}/delete`, {}, options);
  return { uncategorized: asNumberOrNull(data.uncategorized) ?? 0 };
}

/** File bots in a category; null files them as Uncategorized. */
export async function setBotScriptsCategory(
  scriptIDs: readonly string[],
  categoryID: string | null,
  options: ApiOptions = {},
): Promise<void> {
  await postJson("/api/botscripts/category", { scriptIDs, categoryID }, options);
}

// ─── Saved PI plans (src/piPlanStore.js) ─────────────────────────────────────
// Rows from the companion's own database. The answers are handed back RAW:
// app/piPlans.ts decodes them, so a stored row and a fresh one go through the
// same door.

/** The fields a plan may carry on create or update. */
export interface PiPlanFields {
  readonly typeID?: number;
  readonly quantity?: number;
  readonly note?: string;
  readonly status?: "active" | "done";
}

export async function listPiPlans(options: ApiOptions = {}): Promise<JsonValue> {
  return (await getJson("/api/pi/plans", options)).plans ?? null;
}

export async function createPiPlan(fields: PiPlanFields, options: ApiOptions = {}): Promise<JsonValue> {
  return (await postJson("/api/pi/plans", fields, options)).plan ?? null;
}

export async function updatePiPlan(
  planID: string,
  fields: PiPlanFields,
  baseRev: number,
  options: ApiOptions = {},
): Promise<JsonValue> {
  const data = await postJson(`/api/pi/plans/${encodeURIComponent(planID)}`, { ...fields, baseRev }, options);
  return data.plan ?? null;
}

export async function deletePiPlan(planID: string, options: ApiOptions = {}): Promise<void> {
  await postJson(`/api/pi/plans/${encodeURIComponent(planID)}/delete`, {}, options);
}

// ─── Saved PI expansion plans (src/piExpansionStore.js) ──────────────────────
// Handed back RAW: app/piExpansions.ts decodes them.

export interface PiExpansionFields {
  readonly settings?: {
    readonly homeSystemID: number;
    readonly maxJumps: number;
    readonly nullsecTolerance: number;
    readonly characterIDs: readonly number[];
  };
  readonly rows?: readonly {
    readonly characterID: number;
    readonly planetID: number;
    readonly resourceTypeID: number;
    readonly productTypeID: number;
  }[];
  readonly note?: string;
  readonly status?: "active" | "done";
}

export async function listPiExpansions(options: ApiOptions = {}): Promise<JsonValue> {
  return (await getJson("/api/pi/expansions", options)).plans ?? null;
}

export async function createPiExpansion(fields: PiExpansionFields, options: ApiOptions = {}): Promise<JsonValue> {
  return (await postJson("/api/pi/expansions", fields, options)).plan ?? null;
}

export async function updatePiExpansion(
  planID: string,
  fields: PiExpansionFields,
  baseRev: number,
  options: ApiOptions = {},
): Promise<JsonValue> {
  const data = await postJson(`/api/pi/expansions/${encodeURIComponent(planID)}`, { ...fields, baseRev }, options);
  return data.plan ?? null;
}

export async function deletePiExpansion(planID: string, options: ApiOptions = {}): Promise<void> {
  await postJson(`/api/pi/expansions/${encodeURIComponent(planID)}/delete`, {}, options);
}

/** Every planet within `jumps` of a system, from static data (raw; bridge/piExpansion.ts decodes). */
export async function getPlanetsNear(systemID: number, jumps: number, options: ApiOptions = {}): Promise<JsonValue> {
  return await getJson(`/api/pi/planets-near?systemID=${encodeURIComponent(systemID)}&jumps=${encodeURIComponent(jumps)}`, options) as JsonValue;
}

/** Each planet's GetPlanetResourceInfo on the HELD session these options carry (raw). */
export async function getPlanetRichness(planetIDs: readonly number[], options: ApiOptions = {}): Promise<JsonValue> {
  return await getJson(`/api/pi/planet-richness?planetIDs=${planetIDs.map((id) => encodeURIComponent(id)).join(",")}`, options) as JsonValue;
}

// ─── Saved Industry Manager plans (src/industryPlanStore.js) ─────────────────
// Handed back RAW, as for PI plans: app/industryPlans.ts decodes them.

/** The player's choices for a plan, as the server stores them. */
export interface IndustryPlanChoices {
  readonly buy: readonly number[];
  /** productTypeID -> number of jobs. */
  readonly jobs: Readonly<Record<string, number>>;
  /** blueprintTypeID -> assumed efficiencies. */
  readonly blueprints: Readonly<Record<string, { readonly materialEfficiency: number; readonly timeEfficiency: number }>>;
  /** blueprintTypeID -> the decryptor its copies are invented with (R109 slice 6). */
  readonly decryptors?: Readonly<Record<string, number>>;
  /** Where jobs without an owned copy are built, per activity; absent when none is chosen. */
  readonly facilities?: Readonly<{ manufacturing?: number; reaction?: number }>;
}

/** The fields an industry plan may carry on create or update. */
export interface IndustryPlanFields {
  readonly productTypeID?: number;
  readonly runs?: number;
  readonly choices?: IndustryPlanChoices;
  readonly note?: string;
  readonly status?: "active" | "done";
}

export async function listIndustryPlans(options: ApiOptions = {}): Promise<JsonValue> {
  return (await getJson("/api/industry/plans", options)).plans ?? null;
}

export async function createIndustryPlan(fields: IndustryPlanFields, options: ApiOptions = {}): Promise<JsonValue> {
  return (await postJson("/api/industry/plans", fields, options)).plan ?? null;
}

export async function updateIndustryPlan(
  planID: string,
  fields: IndustryPlanFields,
  baseRev: number,
  options: ApiOptions = {},
): Promise<JsonValue> {
  const data = await postJson(`/api/industry/plans/${encodeURIComponent(planID)}`, { ...fields, baseRev }, options);
  return data.plan ?? null;
}

export async function deleteIndustryPlan(planID: string, options: ApiOptions = {}): Promise<void> {
  await postJson(`/api/industry/plans/${encodeURIComponent(planID)}/delete`, {}, options);
}

// ─── Server-side bots (src/botHost.js) ───────────────────────────────────────
// A bot the SERVER flies on a session of its own, so it keeps running when
// this tab goes away. These calls are the remote control: start a saved
// script on a character, watch its readout, stop it. Account-scoped like the
// script library above.

/**
 * What a running fleet companion is DOING, as the Bot Manager badge shows it.
 *
 * ⚠ THIS EXISTS BECAUSE A HEADLESS COMPANION HAS NO STORE TO READ. A companion
 * running in a tab reports through that tab's `companion` slice; one running on
 * the bot host has no session here at all, so without these five fields its row
 * can say only "running" and the player cannot tell a pilot obeying its fleet
 * from one sitting in an empty one.
 *
 * Null on this type means "not reported", NEVER "no" -- see `canTag`.
 */
export interface ServerBotCompanion {
  /** Whether the pilot is in a fleet at all. Null while the roster is unread. */
  readonly inFleet: boolean | null;
  /** Which authority its last decision came from. Null before it decided one. */
  readonly followingOrderFrom: CompanionOrderAuthority | null;
  readonly lastOrderHeard: string | null;
  /** `targets called|all`. Null when not reported. */
  readonly targetMode: "called" | "all" | null;
  /**
   * Whether this pilot's tag write would land.
   *
   * ⚠ THREE STATES, AND FLATTENING THEM IS THE BUG. The server drops a
   * non-commander's tag write while answering ok, so `false` (the write would
   * be dropped) and `null` (the roster has not been read) are different facts,
   * and a row that showed both as "no" would state a confident falsehood on
   * every tick before the first roster read.
   */
  readonly canTag: boolean | null;
  /**
   * What was missing or unusable about this pilot's fit when it started.
   *
   * ⚠ ADVISORY, AND THIS IS THEIR ONLY ROUTE TO A PLAYER ON A HEADLESS RUN.
   * Nothing here refused the start: a human loads the missing thing or ignores
   * it and flies. Empty means nothing worth saying, which is also what an
   * unreadable fit produces.
   */
  readonly fitWarnings: readonly string[];
}

export interface ServerBot {
  readonly botID: string;
  readonly characterID: number;
  readonly characterName: string | null;
  readonly scriptID: string;
  readonly scriptName: string;
  readonly scriptRev: number;
  readonly scriptHash: string;
  readonly restartSafe: boolean;
  readonly riskClasses: readonly BotRiskClass[];
  readonly maxRuntimeMinutes: number;
  readonly expiresAt: string | null;
  readonly status: string;
  readonly phase: string | null;
  readonly why: string | null;
  readonly stepPath: string | null;
  readonly pauseReason: string | null;
  readonly note: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  /** Set when the server restarted this bot after coming back up. */
  readonly resumedAt: string | null;
  /**
   * The last thing an "alert me" watch said on this bot, and when. A server bot has
   * no browser to notify, so this readout IS the alert's delivery.
   */
  readonly lastAlert: { readonly message: string; readonly atMs: number } | null;
  /**
   * What this run IS, as against what it is doing.
   *
   * ⚠ THE HOST HAS ALWAYS SENT THIS AND THIS TYPE ALWAYS DROPPED IT.
   * `publicBot()` in src/botHost.js has carried `kind` since the companion
   * first ran headless; `asServerBot` never decoded it, so the browser could
   * not tell a companion run from a script run except by the convention that
   * `scriptID` happens to be the literal "companion".
   */
  readonly kind: "companion" | "script";
  /**
   * The companion badge's facts, or null.
   *
   * ⚠ NULL MEANS TWO DIFFERENT THINGS AND `kind` SEPARATES THEM: on a script
   * run it means "not a companion at all"; on a companion run it means "this
   * companion has not pushed progress yet". Reading this alone would merge the
   * two.
   */
  readonly companion: ServerBotCompanion | null;
}

function asServerBot(value: JsonValue): ServerBot {
  const row = (value ?? {}) as Record<string, JsonValue>;
  return {
    botID: typeof row.botID === "string" ? row.botID : "",
    characterID: asNumberOrNull(row.characterID) ?? 0,
    characterName: typeof row.characterName === "string" ? row.characterName : null,
    scriptID: typeof row.scriptID === "string" ? row.scriptID : "",
    scriptName: typeof row.scriptName === "string" ? row.scriptName : "Untitled bot",
    scriptRev: asNumberOrNull(row.scriptRev) ?? 0,
    scriptHash: typeof row.scriptHash === "string" ? row.scriptHash : "",
    restartSafe: row.restartSafe === true,
    riskClasses: Array.isArray(row.riskClasses)
      ? row.riskClasses.filter((risk): risk is BotRiskClass => typeof risk === "string") as BotRiskClass[]
      : [],
    maxRuntimeMinutes: asNumberOrNull(row.maxRuntimeMinutes) ?? 0,
    expiresAt: typeof row.expiresAt === "string" ? row.expiresAt : null,
    status: typeof row.status === "string" ? row.status : "unknown",
    phase: typeof row.phase === "string" ? row.phase : null,
    why: typeof row.why === "string" ? row.why : null,
    stepPath: typeof row.stepPath === "string" ? row.stepPath : null,
    pauseReason: typeof row.pauseReason === "string" ? row.pauseReason : null,
    note: typeof row.note === "string" ? row.note : null,
    startedAt: typeof row.startedAt === "string" ? row.startedAt : "",
    endedAt: typeof row.endedAt === "string" ? row.endedAt : null,
    resumedAt: typeof row.resumedAt === "string" ? row.resumedAt : null,
    lastAlert: asLastAlert(row.lastAlert),
    // Anything that is not the companion literal is a script, matching the
    // host's own default for a roster row written before `kind` existed.
    kind: row.kind === "companion" ? "companion" : "script",
    companion: asServerBotCompanion(row.companion),
  };
}

/**
 * One companion's badge facts off the wire.
 *
 * ⚠ EVERY FIELD FAILS TO NULL, NEVER TO A CONFIDENT VALUE. A field this decoder
 * cannot read is one the badge must report as "not known" -- the alternative is
 * a row that says "not in a fleet" because a key was missing.
 */
function asServerBotCompanion(value: JsonValue | undefined): ServerBotCompanion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, JsonValue>;
  return {
    inFleet: typeof row.inFleet === "boolean" ? row.inFleet : null,
    followingOrderFrom: asCompanionOrderAuthority(row.followingOrderFrom),
    lastOrderHeard: typeof row.lastOrderHeard === "string" ? row.lastOrderHeard : null,
    targetMode: row.targetMode === "called" || row.targetMode === "all" ? row.targetMode : null,
    canTag: typeof row.canTag === "boolean" ? row.canTag : null,
    fitWarnings: Array.isArray(row.fitWarnings)
      ? row.fitWarnings.filter((line): line is string => typeof line === "string")
      : [],
  };
}

/**
 * An authority we actually know, or null.
 *
 * ⚠ CHECKED AGAINST A LIST, NOT `typeof === "string"`. The readout turns this
 * into a phrase with a `switch`, and an unrecognised value would fall through
 * that switch to "nothing yet" -- reporting a pilot as taking no orders at the
 * precise moment it started taking them from something this build cannot name.
 * Null says the same thing honestly and does it here, once.
 */
function asCompanionOrderAuthority(value: JsonValue | undefined): CompanionOrderAuthority | null {
  return value === "broadcast" ||
    value === "tag" ||
    value === "chat" ||
    // ⚠ `squad-board` USED TO BE ACCEPTED HERE AND IS NOT ANY MORE. Nothing in
    // the companion ever emitted it -- it was a settings checkbox no decision
    // rung read -- so a row carrying it is a row from an older build, and null
    // ("not reported") is the honest reading of it.
    value === "own-ladder"
    ? value
    : null;
}

/** Decode a bot's last alert; a malformed or absent one reads as no alert. */
function asLastAlert(value: JsonValue | undefined): { message: string; atMs: number } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, JsonValue>;
  const message = typeof row.message === "string" ? row.message : null;
  if (message === null || message.length === 0) {
    return null;
  }
  return { message, atMs: asNumberOrNull(row.atMs) ?? 0 };
}

/**
 * The bot rosters several of the page's windows poll at once: the hangar's and the landing's markers every five
 * seconds (GET /api/bots/active), the Bot Manager's, the Companions' and the server list's rosters every three
 * (GET /api/bots, each account's own). Measured with the four windows open on the hangar page: 38 rosters and 6
 * marker reads in 30 seconds, of the same few answers. Here one asking per roster, account and BFF is shared:
 * whoever asks while it is on its way, or within ROSTER_SHARE_MS of its asking, is given the same answer. A start or
 * stop of a bot lets every answer go, so that a window reading after its own press sees the press. A call with its
 * own fetch (a test's) is never shared.
 */
const ROSTER_SHARE_MS = 2_000;
const rosterReads = new Map<string, { readonly at: number; readonly answer: Promise<unknown> }>();

function sharedRosterRead<T>(path: string, options: ApiOptions, read: () => Promise<T>): Promise<T> {
  if (options.fetch) return read();
  const key = `${options.baseUrl ?? ""} ${path} ${"token" in options ? `token:${options.token ?? ""}` : "tab"}`;
  const now = Date.now();
  const kept = rosterReads.get(key);
  if (kept && now - kept.at < ROSTER_SHARE_MS) return kept.answer as Promise<T>;
  const answer = read();
  rosterReads.set(key, { at: now, answer });
  // A failed asking is not handed on to the next asker: it asks for itself.
  answer.catch(() => {
    if (rosterReads.get(key)?.answer === answer) rosterReads.delete(key);
  });
  return answer;
}

export async function listServerBots(options: ApiOptions = {}): Promise<ServerBot[]> {
  const data = await sharedRosterRead("/api/bots", options, () => getJson("/api/bots", options));
  return Array.isArray(data.bots) ? data.bots.map(asServerBot) : [];
}

/** One hold's fill level in a bot-flown ship's vitals sample. */
export interface ActiveBotHold {
  readonly label: string;
  readonly used: number | null;
  readonly capacity: number | null;
}

/** The last ship-state sample the host took for a running bot (~15s cadence). */
export interface ActiveBotVitals {
  readonly sampledAt: string | null;
  /** null = not known yet; true = docked (health bars don't apply). */
  readonly docked: boolean | null;
  readonly shield: number | null;
  readonly armor: number | null;
  readonly hull: number | null;
  readonly holds: readonly ActiveBotHold[];
}

/** A running server bot as the UNAUTHENTICATED landing screens see it. */
export interface ActiveServerBot {
  readonly characterID: number;
  readonly status: string;
  readonly phase: string | null;
  readonly why: string | null;
  readonly note: string | null;
  readonly vitals: ActiveBotVitals | null;
}

function asActiveServerBot(value: JsonValue): ActiveServerBot {
  const row = (value ?? {}) as Record<string, JsonValue>;
  const rawVitals =
    typeof row.vitals === "object" && row.vitals !== null && !Array.isArray(row.vitals)
      ? (row.vitals as Record<string, JsonValue>)
      : null;
  return {
    characterID: asNumberOrNull(row.characterID) ?? 0,
    status: typeof row.status === "string" ? row.status : "unknown",
    phase: typeof row.phase === "string" ? row.phase : null,
    why: typeof row.why === "string" ? row.why : null,
    note: typeof row.note === "string" ? row.note : null,
    vitals: rawVitals
      ? {
          sampledAt: typeof rawVitals.sampledAt === "string" ? rawVitals.sampledAt : null,
          docked: typeof rawVitals.docked === "boolean" ? rawVitals.docked : null,
          shield: asNumberOrNull(rawVitals.shield),
          armor: asNumberOrNull(rawVitals.armor),
          hull: asNumberOrNull(rawVitals.hull),
          holds: Array.isArray(rawVitals.holds)
            ? rawVitals.holds.map((hold) => {
                const entry = (hold ?? {}) as Record<string, JsonValue>;
                return {
                  label: typeof entry.label === "string" ? entry.label : "Hold",
                  used: asNumberOrNull(entry.used),
                  capacity: asNumberOrNull(entry.capacity),
                };
              })
            : [],
        }
      : null,
  };
}

/**
 * The running server bots as the landing screens see them. Unauthenticated by
 * design — the login/character screens mark bot-flown pilots and show their
 * ship vitals before any sign-in exists.
 */
export async function listActiveServerBots(options: ApiOptions = {}): Promise<ActiveServerBot[]> {
  const data = await sharedRosterRead("/api/bots/active", options, () => getJson("/api/bots/active", options));
  return Array.isArray(data.bots) ? data.bots.map(asActiveServerBot) : [];
}

export async function startServerBot(
  characterID: number,
  scriptID: string,
  grant: BotLaunchGrant,
  options: ApiOptions = {},
): Promise<ServerBot> {
  rosterReads.clear();
  const data = await postJson(
    "/api/bots/start",
    { characterID, scriptID, grant: grant as unknown as JsonValue },
    options,
  ).finally(() => rosterReads.clear());
  return asServerBot(data.bot ?? null);
}

/**
 * The companion sibling of `startServerBot` — same route, same shape, same
 * grant handling; only what is being launched differs. A companion request
 * has no script library entry to name by id, so this carries the flat
 * request itself in place of a `scriptID`, and `kind: "companion"` tells
 * `/api/bots/start` (src/server.js) which branch to take. `botHost.start()`
 * (src/botHost.js) is the one place that decodes and trusts it.
 */
export async function startServerCompanion(
  characterID: number,
  // ⚠ A SETUP, NOT A REQUEST. What is sent over the wire and persisted in the
  // BFF's roster is only what an operator saved; the eight module lists are
  // filled in by the HOST, from the hull the pilot turns out to be sitting in,
  // because a squad start has nobody to ask and a list saved earlier would be
  // stale the moment that pilot refits.
  request: CompanionSetup,
  grant: BotLaunchGrant,
  options: ApiOptions = {},
): Promise<ServerBot> {
  rosterReads.clear();
  const data = await postJson(
    "/api/bots/start",
    {
      characterID,
      kind: "companion",
      request: request as unknown as JsonValue,
      grant: grant as unknown as JsonValue,
    },
    options,
  ).finally(() => rosterReads.clear());
  return asServerBot(data.bot ?? null);
}

export async function stopServerBot(botID: string, options: ApiOptions = {}): Promise<ServerBot> {
  rosterReads.clear();
  const data = await postJson(`/api/bots/${encodeURIComponent(botID)}/stop`, {}, options).finally(() => rosterReads.clear());
  return asServerBot(data.bot ?? null);
}

// --- R7c Batch name resolution (names everywhere) --------------------------
// Turn raw IDs into names across every tab in ONE round-trip. POST /api/names
// takes { items: [{kind, id}] } and returns { names: { "kind:id": name|null } }
// over the static reference getters — read-only, like /api/map/find, NOT a
// gateway/bridge call. A null value is a definitive "unknown" (an NPC/type not
// in the static tables); the client name-cache caches it so it never refetches.

export interface ResolveNamesResult {
  /** Keyed by `${kind}:${id}`; value is the resolved name or null (unknown). */
  readonly names: Readonly<Record<string, string | null>>;
  /**
   * R38 — keys whose lookup could NOT be completed (no character online, a
   * gateway error, or past the per-request structure cap).
   *
   * ⚠ NOT THE SAME AS A null IN `names`. A null there is the server's definite
   * finding that nothing bears that ID; a key listed here means the question
   * was never answered. The name cache must not store these, or one lookup
   * failure would pin a place to its fallback for the rest of the session.
   */
  readonly unresolved: readonly string[];
}

/** Batch-resolve a set of `{kind, id}` refs to names (kind:id → name | null). */
export async function resolveNames(
  items: readonly NameRef[],
  options: ApiOptions = {},
): Promise<ResolveNamesResult> {
  const data = await postJson("/api/names", { items }, options);
  const raw =
    typeof data.names === "object" && data.names !== null && !Array.isArray(data.names)
      ? (data.names as Record<string, JsonValue>)
      : {};
  const names: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(raw)) {
    names[key] = typeof value === "string" ? value : null;
  }
  const unresolved = Array.isArray(data.unresolved)
    ? (data.unresolved as JsonValue[]).filter(
        (key): key is string => typeof key === "string",
      )
    : [];
  return { names, unresolved };
}

/**
 * Corporations' tickers as the client's cfg.corptickernames has them (POST /api/corp-tickers): an NPC
 * corporation's from the static tables, a player corporation's asked of the game server by the pilot's game-port
 * transport where it has not been asked yet (config.GetMultiCorpTickerNamesEx), in one call, or in one for each
 * where `each` is said. A ticker is null where the server answered none; one in `unresolved` was not asked.
 */
export async function corpTickers(
  corpIDs: readonly number[],
  each: boolean,
  options: ApiOptions = {},
): Promise<{ tickers: Record<string, string | null>; unresolved: readonly number[] }> {
  const data = await postJson("/api/corp-tickers", { corpIDs, each }, options);
  return tickersRead(data);
}

/**
 * Alliances' tickers as the client's cfg.allianceshortnames has them (POST /api/alliance-tickers): asked of the game
 * server by the pilot's game-port transport where it has not been asked yet (config.GetMultiAllianceShortNamesEx), in
 * one call, or in one for each where `each` is said. A ticker is null where the server answered none; one in
 * `unresolved` was not asked.
 */
export async function allianceTickers(
  allianceIDs: readonly number[],
  each: boolean,
  options: ApiOptions = {},
): Promise<{ tickers: Record<string, string | null>; unresolved: readonly number[] }> {
  const data = await postJson("/api/alliance-tickers", { allianceIDs, each }, options);
  return tickersRead(data);
}

function tickersRead(data: Record<string, JsonValue>): { tickers: Record<string, string | null>; unresolved: readonly number[] } {
  const raw = typeof data.tickers === "object" && data.tickers !== null && !Array.isArray(data.tickers)
    ? (data.tickers as Record<string, JsonValue>)
    : {};
  const tickers: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(raw)) tickers[key] = typeof value === "string" ? value : null;
  const unresolved = Array.isArray(data.unresolved)
    ? (data.unresolved as JsonValue[]).filter((id): id is number => typeof id === "number")
    : [];
  return { tickers, unresolved };
}

/**
 * The retail client's own text for localisation labels, as templates with
 * their parameters left in (POST /api/words). `available` is false when the
 * BFF has no client install to read; a label the client does not have is null.
 */
export async function loadWords(
  labels: readonly string[],
  messageIDs: readonly number[] = [],
  dialogs: readonly string[] = [],
  options: ApiOptions = {},
): Promise<{
  available: boolean;
  words: Record<string, string | null>;
  messages: Record<string, string | null>;
  /**
   * A dialog by its name: its title and its body, each the client's text or null, whether the install lets its
   * answer be kept ("1", else null), which answer ("any", "yes" or "no", else null), and its type (dialogType: "info",
   * "notify" and the others). Null for a dialog it has not.
   */
  dialogs: Record<string, { title: string | null; body: string | null; suppressable: string | null; suppress: string | null; type: string | null } | null>;
}> {
  const data = await postJson(
    "/api/words",
    { labels, ...(messageIDs.length > 0 ? { messageIDs } : {}), ...(dialogs.length > 0 ? { dialogs } : {}) },
    options,
  );
  const texts = (value: JsonValue | undefined): Record<string, string | null> => {
    const raw = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, JsonValue>) : {};
    const out: Record<string, string | null> = {};
    for (const [key, text] of Object.entries(raw)) {
      out[key] = typeof text === "string" ? text : null;
    }
    return out;
  };
  const named: Record<string, { title: string | null; body: string | null; suppressable: string | null; suppress: string | null; type: string | null } | null> = {};
  const rawDialogs = typeof data.dialogs === "object" && data.dialogs !== null && !Array.isArray(data.dialogs)
    ? (data.dialogs as Record<string, JsonValue>)
    : {};
  for (const [name, dialog] of Object.entries(rawDialogs)) {
    // Anything that is not a dialog has neither text, which the checks below find for themselves.
    const record = dialog as Record<string, JsonValue> | null;
    named[name] = record === null
      ? null
      : {
          title: typeof record.title === "string" ? record.title : null,
          body: typeof record.body === "string" ? record.body : null,
          suppressable: record.suppressable === true ? "1" : null,
          suppress: record.suppress === "any" || record.suppress === "yes" || record.suppress === "no" ? record.suppress : null,
          type: typeof record.type === "string" ? record.type : null,
        };
  }
  return { available: data.available === true, words: texts(data.words), messages: texts(data.messages), dialogs: named };
}

/**
 * A mission's keywords from its agent (agentMgr.GetMissionKeywords on the
 * bound agent), raw: the names and values the client adds to the arguments of
 * everything that agent says about the mission.
 */
export async function loadMissionKeywords(
  agentID: number,
  contentID: number,
  options: ApiOptions = {},
): Promise<JsonValue> {
  const data = await getJson(`/api/bridge/agents/${agentID}/keywords?contentID=${contentID}`, options);
  return data.keywords ?? null;
}

// --- R108 slice 3: the PI Manager's read, with no character selected ---------
// GET /api/roster/planets?characterIDs=a,b,c answers each of those pilots'
// colonies through the gateway's ownership check alone. The body goes back RAW:
// the PI roster stores each pilot's entry as it arrived and decodes it with
// bridge/piRoster.ts on the way out, so a live answer and a stored one pass
// through one decoder.

/** At most this many pilots per ask — the route refuses more. */
export const ROSTER_PLANETS_MAX_IDS = 12;

export async function loadRosterPlanets(
  characterIDs: readonly number[],
  options: ApiOptions = {},
): Promise<Record<string, JsonValue>> {
  const ids = characterIDs.filter((id) => Number.isSafeInteger(id) && id > 0);
  if (ids.length === 0) {
    return { ok: true, pilots: [] };
  }
  return getJson(
    `/api/roster/planets?characterIDs=${encodeURIComponent(ids.join(","))}`,
    options,
  );
}

/**
 * What these pilots hold of these types (R109 slice 4): the roster planets
 * read's stock walk, pointed at one build tree. No session; at most
 * ROSTER_PLANETS_MAX_IDS pilots per call.
 */
export async function loadRosterStock(
  characterIDs: readonly number[],
  typeIDs: readonly number[],
  options: ApiOptions = {},
): Promise<Record<string, JsonValue>> {
  const ids = characterIDs.filter((id) => Number.isSafeInteger(id) && id > 0);
  const types = typeIDs.filter((id) => Number.isSafeInteger(id) && id > 0);
  if (ids.length === 0 || types.length === 0) {
    return { ok: true, pilots: [] };
  }
  return postJson("/api/roster/stock", { characterIDs: ids, typeIDs: types }, options);
}

// --- R108 slice 5: a corporation's hangars, read through a held session -----
// GET /api/bridge/corp-assets (the R61 corpmgr reads). Without a locationID it
// answers where the corp has offices (`inventory`); with one it also answers
// what is in that office (`locationInventory`). The body goes back RAW, for
// bridge/corpAssets.ts to unwrap. It rides the HELD session of `options`: corp
// goods are in no pilot's snapshot, so a pilot of that corp must be online.

export async function loadCorpAssets(
  locationID: number | null,
  options: ApiOptions = {},
): Promise<Record<string, JsonValue>> {
  const query = locationID !== null && Number.isSafeInteger(locationID) && locationID > 0
    ? `?which=offices&locationID=${locationID}`
    : "?which=offices";
  return getJson(`/api/bridge/corp-assets${query}`, options);
}

// The same corpmgr reads, made on the game session a RUNNING SERVER BOT of the
// caller's account holds for `characterID` (GET /api/bots/corp-assets). Only a
// read beside the bot: the route never selects, releases or stops anything,
// and answers 409 NO_BOT_SESSION when no bot of this account flies the pilot.
/**
 * What a corporation's seven hangar divisions are called, read on the session
 * a running server bot of the caller's account holds for `characterID`
 * (GET /api/bots/corp-division-names). A 409 means no bot is flying the pilot.
 */
export async function loadBotCorpDivisionNames(
  characterID: number,
  options: ApiOptions = {},
): Promise<{ corporationID: number | null; divisions: readonly { division: number; name: string | null }[] }> {
  const data = await getJson(`/api/bots/corp-division-names?characterID=${characterID}`, options);
  const divisions = Array.isArray(data.divisions) ? data.divisions : [];
  return {
    corporationID: asNumberOrNull(data.corporationID),
    divisions: divisions.map((entry) => {
      const row = (entry ?? {}) as Record<string, JsonValue>;
      return {
        division: Number(row.division) || 0,
        name: typeof row.name === "string" && row.name !== "" ? row.name : null,
      };
    }).filter((row) => row.division > 0),
  };
}

export async function loadBotCorpAssets(
  characterID: number,
  locationID: number | null,
  options: ApiOptions = {},
): Promise<Record<string, JsonValue>> {
  const location = locationID !== null && Number.isSafeInteger(locationID) && locationID > 0
    ? `&locationID=${locationID}`
    : "";
  return getJson(`/api/bots/corp-assets?characterID=${characterID}&which=offices${location}`, options);
}

// --- A module type's overload effect (static reference data) -----------------
// GET /api/types/overload-effects?typeIDs=... answers { overloadEffectID }: for
// each type the ID of its effect of the overload category, or null where it has
// none. It is what the client's module button names when it overloads a module,
// and the page asks it once for a type (bridge/dogmaWrites.ts). Like the cycle
// times below it is static data and no bridge call.

/**
 * typeID -> the ID of the type's overload effect, or null for a type that has
 * none. A type the answer does not speak of, or speaks of with anything but an
 * effect's ID or null, is left out: it was not answered.
 */
export async function loadOverloadEffects(
  typeIDs: readonly number[],
  options: ApiOptions = {},
): Promise<Readonly<Record<number, number | null>>> {
  const data = await getJson(
    `/api/types/overload-effects?typeIDs=${encodeURIComponent(typeIDs.join(","))}`,
    options,
  );
  const raw =
    typeof data.overloadEffectID === "object" && data.overloadEffectID !== null && !Array.isArray(data.overloadEffectID)
      ? (data.overloadEffectID as Record<string, JsonValue>)
      : {};
  const effects: Record<number, number | null> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0)) {
      effects[Number(key)] = value;
    }
  }
  return effects;
}

// --- Whether a module type can be switched on (static reference data) --------
// GET /api/types/activation?typeIDs=... answers { activatable }: for each type
// the eve.js server's own test of whether it has an effect a pilot switches on
// (nav/moduleActivation.ts), or null where the tables have no dogma for it. Like
// the overload effects above it is static data and no bridge call.

/**
 * typeID -> true (can be switched on), false (passive: the server refuses it)
 * or null (not known). A type the answer does not speak of, or speaks of with
 * anything else, is left out: it was not answered.
 */
export async function loadTypeActivation(
  typeIDs: readonly number[],
  options: ApiOptions = {},
): Promise<Readonly<Record<number, boolean | null>>> {
  const data = await getJson(
    `/api/types/activation?typeIDs=${encodeURIComponent(typeIDs.join(","))}`,
    options,
  );
  const raw =
    typeof data.activatable === "object" && data.activatable !== null && !Array.isArray(data.activatable)
      ? (data.activatable as Record<string, JsonValue>)
      : {};
  const activatable: Record<number, boolean | null> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || typeof value === "boolean") {
      activatable[Number(key)] = value;
    }
  }
  return activatable;
}

// --- The client type lists that hold a type (static reference data) --------------
// GET /api/types/type-lists?typeIDs=...&listIDs=... answers { lists }: for each type, the lists among those asked that
// hold it (the client's evetypes.GetTypeIDsByListID), or null where the tables lack the type or a list.

export async function loadTypeListsHolding(
  typeIDs: readonly number[],
  listIDs: readonly number[],
  options: ApiOptions = {},
): Promise<Readonly<Record<number, readonly number[] | null>>> {
  const data = await getJson(
    `/api/types/type-lists?typeIDs=${encodeURIComponent(typeIDs.join(","))}&listIDs=${encodeURIComponent(listIDs.join(","))}`,
    options,
  );
  const raw = typeof data.lists === "object" && data.lists !== null && !Array.isArray(data.lists)
    ? (data.lists as Record<string, JsonValue>)
    : {};
  const lists: Record<number, readonly number[] | null> = {};
  for (const [key, value] of Object.entries(raw)) {
    const typeID = Number(key);
    if (!Number.isSafeInteger(typeID) || typeID <= 0) continue;
    lists[typeID] = Array.isArray(value)
      ? value.filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && listIDs.includes(id))
      : null;
  }
  return lists;
}

// --- A type's compressed form (static reference data) -------------------------
// GET /api/types/compressed?typeIDs=... answers { compressedTypeIDs }: each type's compressed form, or null where it
// has none, as the server compresses. The client has it in its own static data (itemcompression/data.py) and offers
// to compress in space only a type that has one. A type the answer does not speak of is absent, never "none".

export interface CompressedTypesResult {
  /** typeID -> its compressed form's typeID, or null where it has none. A type not answered for is absent. */
  readonly compressedTypeIDs: Readonly<Record<number, number | null>>;
}

export async function loadCompressedTypes(
  typeIDs: readonly number[],
  options: ApiOptions = {},
): Promise<CompressedTypesResult> {
  const compressedTypeIDs: Record<number, number | null> = {};
  for (let at = 0; at < typeIDs.length; at += TYPE_VOLUMES_PER_REQUEST) {
    const data = await getJson(
      `/api/types/compressed?typeIDs=${encodeURIComponent(typeIDs.slice(at, at + TYPE_VOLUMES_PER_REQUEST).join(","))}`,
      options,
    );
    const raw =
      typeof data.compressedTypeIDs === "object" && data.compressedTypeIDs !== null && !Array.isArray(data.compressedTypeIDs)
        ? (data.compressedTypeIDs as Record<string, JsonValue>)
        : {};
    for (const [key, value] of Object.entries(raw)) {
      const typeID = Number(key);
      if (!Number.isSafeInteger(typeID) || typeID <= 0) {
        continue;
      }
      compressedTypeIDs[typeID] = typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
    }
  }
  return { compressedTypeIDs };
}

// --- A type's volume (static reference data) ---------------------------------
// GET /api/types/volumes?typeIDs=... answers { volumes }: each type's volume in m³ (nought where it is nought, as
// the client has it), or null where the static tables do not know the type. A client has it in its own static data; the page asks here, once for a type, where it lists
// what the server listed by its own call (the BFF's routes that list items send it beside their answer still).
// Not a bridge call, and no live session: it cannot vary by player.

/** As many types as one request asks of: under the route's own limit of 500. */
const TYPE_VOLUMES_PER_REQUEST = 400;

export interface TypeVolumesResult {
  /** typeID -> m³, or null where the tables have no volume for the type. A type not answered for is absent. */
  readonly volumes: Readonly<Record<number, number | null>>;
  /** typeID -> its packaged volume in m³ (GetPackagedVolume), or null where it is not known. */
  readonly packaged: Readonly<Record<number, number | null>>;
}

export async function loadTypeVolumes(
  typeIDs: readonly number[],
  options: ApiOptions = {},
): Promise<TypeVolumesResult> {
  const volumes: Record<number, number | null> = {};
  const packaged: Record<number, number | null> = {};
  for (let at = 0; at < typeIDs.length; at += TYPE_VOLUMES_PER_REQUEST) {
    const data = await getJson(
      `/api/types/volumes?typeIDs=${encodeURIComponent(typeIDs.slice(at, at + TYPE_VOLUMES_PER_REQUEST).join(","))}`,
      options,
    );
    const raw =
      typeof data.volumes === "object" && data.volumes !== null && !Array.isArray(data.volumes)
        ? (data.volumes as Record<string, JsonValue>)
        : {};
    for (const [key, value] of Object.entries(raw)) {
      const typeID = Number(key);
      if (!Number.isSafeInteger(typeID) || typeID <= 0) {
        continue;
      }
      volumes[typeID] = typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
    }
    const packedRaw =
      typeof data.packaged === "object" && data.packaged !== null && !Array.isArray(data.packaged)
        ? (data.packaged as Record<string, JsonValue>)
        : {};
    for (const [key, value] of Object.entries(packedRaw)) {
      const typeID = Number(key);
      if (!Number.isSafeInteger(typeID) || typeID <= 0) continue;
      packaged[typeID] = typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
    }
  }
  return { volumes, packaged };
}

// --- R24 slice C: module cycle times (static reference data) ----------------
// POST /api/types/cycle-times takes { typeIDs } and returns { baseCycleMs }.
// Read-only static data over attribute 73 (`duration`) — like /api/names, NOT a
// gateway/bridge call. The wire name says `base` because that is what it is:
// the type's duration before skills, bonuses, rigs or heat. Where the server
// has pushed a real cycle event, THAT figure wins.

export interface CycleTimesResult {
  /** typeID -> milliseconds, or null where the type has no duration at all. */
  readonly baseCycleMs: Readonly<Record<number, number | null>>;
}

export async function loadBaseCycleTimes(
  typeIDs: readonly number[],
  options: ApiOptions = {},
): Promise<CycleTimesResult> {
  const data = await getJson(
    `/api/types/cycle-times?typeIDs=${encodeURIComponent(typeIDs.join(","))}`,
    options,
  );
  const raw =
    typeof data.baseCycleMs === "object" && data.baseCycleMs !== null && !Array.isArray(data.baseCycleMs)
      ? (data.baseCycleMs as Record<string, JsonValue>)
      : {};
  const baseCycleMs: Record<number, number | null> = {};
  for (const [key, value] of Object.entries(raw)) {
    const typeID = Number(key) || 0;
    if (typeID <= 0) {
      continue;
    }
    const ms = Number(value);
    baseCycleMs[typeID] = Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  return { baseCycleMs };
}

// --- NPC threat dogma (static reference data) --------------------------------
// POST /api/types/dogma takes { typeIDs, attributeIDs } and answers the raw
// attribute values each of those types carries — the static half of the
// drone-boat block's target priority (docs/drone-boat-block-spec.md section 6):
// 504 entityWarpScrambleChance / 103 warpScrambleRange (scram), 20 speedFactor
// (web, negative), 931 neut / 932 damp / 935 paint (ewar). Read-only, like
// resolveNames and loadBaseCycleTimes: NOT a gateway/bridge call, so it costs
// nothing but a round trip and works with no character in space.
//
// ⚠ NUMBERS, NOT A CLASS. The BFF deliberately has no opinion about what a
// value means; turning 504 > 0 into "tackle" belongs to the one pure
// classifier module and must stay in exactly one place.
//
// ⚠ ZERO IS A READING. A Pithi Arrogator carries 504 = 0 and a Dire Pithi
// Arrogator carries 0.25 — same family, and only that number separates the one
// that lets you leave from the one that does not. Never treat a 0 here as
// "absent".
//
// ⚠ NO CACHE IN THIS FUNCTION, ON PURPOSE. The caller owns the per-type cache,
// because only it knows which typeIDs it has already seen on the grid. An
// EMPTY object for a typeID is a real answer ("the static tables do not know
// this type") and is cached the same way a null from resolveNames is.

/**
 * The skills each of these types needs and at what level, and every skill those lead to, as the client's own data has
 * them (GET /api/client-data/required-skills; evetypes/skills.py get_dogma_required_skills). `available` is false where
 * the BFF could not read the client's table.
 */
export async function getRequiredSkills(
  typeIDs: readonly number[],
  options: ApiOptions = {},
): Promise<{
  readonly available: boolean;
  readonly required: Readonly<Record<number, Readonly<Record<number, number>>>>;
  /** Each type's needs as [skill, level] in the order the client's table iterates them (get_dogma_required_skills). */
  readonly order: Readonly<Record<number, readonly (readonly [number, number])[]>>;
}> {
  const data = await getJson(`/api/client-data/required-skills?typeIDs=${typeIDs.join(",")}`, options);
  const raw =
    typeof data.required === "object" && data.required !== null && !Array.isArray(data.required)
      ? (data.required as Record<string, JsonValue>)
      : {};
  const required: Record<number, Record<number, number>> = {};
  for (const [typeKey, skills] of Object.entries(raw)) {
    const typeID = Number(typeKey);
    if (!Number.isSafeInteger(typeID) || typeID <= 0 || typeof skills !== "object" || skills === null || Array.isArray(skills)) continue;
    const bySkill: Record<number, number> = {};
    for (const [skillKey, level] of Object.entries(skills as Record<string, JsonValue>)) {
      const skillID = Number(skillKey);
      if (Number.isSafeInteger(skillID) && skillID > 0 && typeof level === "number" && Number.isSafeInteger(level)) bySkill[skillID] = level;
    }
    required[typeID] = bySkill;
  }
  const rawOrder =
    typeof data.order === "object" && data.order !== null && !Array.isArray(data.order)
      ? (data.order as Record<string, JsonValue>)
      : {};
  const order: Record<number, (readonly [number, number])[]> = {};
  for (const [typeKey, pairs] of Object.entries(rawOrder)) {
    const typeID = Number(typeKey);
    if (!Number.isSafeInteger(typeID) || typeID <= 0 || !Array.isArray(pairs)) continue;
    order[typeID] = pairs.flatMap((pair) => {
      if (!Array.isArray(pair)) return [];
      const [skillID, level] = pair;
      return typeof skillID === "number" && Number.isSafeInteger(skillID) && skillID > 0 && typeof level === "number" && Number.isSafeInteger(level)
        ? [[skillID, level] as const]
        : [];
    });
  }
  return { available: data.available === true, required, order };
}

/**
 * Each type's base price and whether it is published, as the client's own data has them (GET
 * /api/client-data/type-prices: evetypes.GetBasePrice and IsPublished). Null for a type the data lacks; `available`
 * false where the client's data could not be read.
 */
export async function getTypePrices(
  typeIDs: readonly number[],
  options: ApiOptions = {},
): Promise<{
  readonly available: boolean;
  readonly basePrice: Readonly<Record<number, number | null>>;
  readonly published: Readonly<Record<number, boolean | null>>;
  /** Each type's portion size (evetypes.GetPortionSize), or null. */
  readonly portionSize: Readonly<Record<number, number | null>>;
  /** Each type's group (evetypes.GetGroupID), or null. */
  readonly groupID: Readonly<Record<number, number | null>>;
  /** Each type's category (evetypes.GetCategoryID), or null. */
  readonly categoryID: Readonly<Record<number, number | null>>;
  /** Whether each type is a dynamic one, made by a mutaplasmid (evetypes.IsDynamicType), or null. */
  readonly dynamic: Readonly<Record<number, boolean | null>>;
}> {
  const data = await getJson(`/api/client-data/type-prices?typeIDs=${typeIDs.join(",")}`, options);
  const record = (value: JsonValue | undefined): Record<string, JsonValue> =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, JsonValue>) : {};
  const basePrice: Record<number, number | null> = {};
  const published: Record<number, boolean | null> = {};
  for (const [key, value] of Object.entries(record(data.basePrice))) basePrice[Number(key)] = typeof value === "number" && Number.isFinite(value) ? value : null;
  for (const [key, value] of Object.entries(record(data.published))) published[Number(key)] = typeof value === "boolean" ? value : null;
  const portionSize: Record<number, number | null> = {};
  for (const [key, value] of Object.entries(record(data.portionSize))) portionSize[Number(key)] = typeof value === "number" && Number.isFinite(value) ? value : null;
  const groupID: Record<number, number | null> = {};
  for (const [key, value] of Object.entries(record(data.groupID))) groupID[Number(key)] = typeof value === "number" && Number.isSafeInteger(value) ? value : null;
  const categoryID: Record<number, number | null> = {};
  for (const [key, value] of Object.entries(record(data.categoryID))) categoryID[Number(key)] = typeof value === "number" && Number.isSafeInteger(value) ? value : null;
  const dynamic: Record<number, boolean | null> = {};
  for (const [key, value] of Object.entries(record(data.dynamic))) dynamic[Number(key)] = typeof value === "boolean" ? value : null;
  return { available: data.available === true, basePrice, published, portionSize, groupID, categoryID, dynamic };
}

/**
 * The fitting browser's hulls (GET /api/client-data/hull-browser): every hull the market sells, the special edition
 * ships, each hull's facts and those of each type asked (null for a type the client has not), and each race's name as
 * the number of its message; `available` false where the client's data could not be read.
 */
export async function getHullBrowser(
  typeIDs: readonly number[],
  options: ApiOptions = {},
): Promise<{
  readonly available: boolean;
  readonly hullTypeIDs: readonly number[];
  readonly specialTypeIDs: readonly number[];
  readonly types: Readonly<Record<number, HullFacts | null>>;
  readonly raceNameIDs: Readonly<Record<number, number | null>>;
}> {
  const data = await getJson(`/api/client-data/hull-browser?typeIDs=${typeIDs.join(",")}`, options);
  const numbers = (value: JsonValue | undefined): number[] => (Array.isArray(value) ? value.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0) : []);
  const orNull = (value: JsonValue | undefined): number | null => (typeof value === "number" && Number.isSafeInteger(value) ? value : null);
  const record = (value: JsonValue | undefined): Record<string, JsonValue> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, JsonValue>) : {});
  const types: Record<number, HullFacts | null> = {};
  for (const [key, value] of Object.entries(record(data.types))) {
    const typeID = Number(key);
    if (!Number.isSafeInteger(typeID) || typeID <= 0) continue;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      types[typeID] = null;
      continue;
    }
    const facts = value as Record<string, JsonValue>;
    types[typeID] = { groupID: orNull(facts.groupID), categoryID: orNull(facts.categoryID), factionID: orNull(facts.factionID), metaGroupID: orNull(facts.metaGroupID), published: facts.published === true, marketGroupID: orNull(facts.marketGroupID) };
  }
  const raceNameIDs: Record<number, number | null> = {};
  for (const [key, value] of Object.entries(record(data.raceNameIDs))) {
    const raceID = Number(key);
    if (Number.isSafeInteger(raceID) && raceID > 0) raceNameIDs[raceID] = orNull(value);
  }
  return { available: data.available === true, hullTypeIDs: numbers(data.hullTypeIDs), specialTypeIDs: numbers(data.specialTypeIDs), types, raceNameIDs };
}

/**
 * Ships' traits (GET /api/client-data/ship-traits, the client's infobubbles): each type's bonuses per skill, its role's and
 * the others (null for a type with none), and each unit's name as the number of its message. At most 50 at once.
 */
export async function getShipTraits(
  typeIDs: readonly number[],
  options: ApiOptions = {},
): Promise<{ readonly available: boolean; readonly traits: Readonly<Record<number, ShipTraits | null>>; readonly unitNameIDs: Readonly<Record<number, number | null>> }> {
  const data = await getJson(`/api/client-data/ship-traits?typeIDs=${typeIDs.join(",")}`, options);
  const record = (value: JsonValue | undefined): Record<string, JsonValue> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, JsonValue>) : {});
  const orNull = (value: JsonValue | undefined): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const bonuses = (value: JsonValue | undefined): ShipTraitBonus[] => (Array.isArray(value) ? value : []).map((each) => {
    const bonus = record(each);
    return { bonus: orNull(bonus.bonus), importance: orNull(bonus.importance) ?? 0, nameID: orNull(bonus.nameID), unitID: orNull(bonus.unitID) };
  });
  const traits: Record<number, ShipTraits | null> = {};
  for (const [key, value] of Object.entries(record(data.traits))) {
    const typeID = Number(key);
    if (!Number.isSafeInteger(typeID) || typeID <= 0) continue;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      traits[typeID] = null;
      continue;
    }
    const entry = value as Record<string, JsonValue>;
    const skills = (Array.isArray(entry.skills) ? entry.skills : []).map((each) => {
      const skill = record(each);
      return { skillTypeID: Number(skill.skillTypeID), bonuses: bonuses(skill.bonuses) };
    }).filter((skill) => Number.isSafeInteger(skill.skillTypeID) && skill.skillTypeID > 0);
    traits[typeID] = { skills, role: bonuses(entry.role), misc: bonuses(entry.misc) };
  }
  const unitNameIDs: Record<number, number | null> = {};
  for (const [key, value] of Object.entries(record(data.unitNameIDs))) {
    const unitID = Number(key);
    if (Number.isSafeInteger(unitID) && unitID > 0) unitNameIDs[unitID] = orNull(value);
  }
  return { available: data.available === true, traits, unitNameIDs };
}

/**
 * A solar system's region and its NPC stations, each with its celestialIndex and orbitIndex (GET
 * /api/map/system-stations/:id: the client's map data, cfg.GetLocationsLocalBySystem). Static reference data.
 */
export async function getSystemStations(
  solarSystemID: number,
  options: ApiOptions = {},
): Promise<{ readonly regionID: number | null; readonly stations: readonly { readonly stationID: number; readonly celestialIndex: number | null; readonly orbitIndex: number | null }[] }> {
  const data = await getJson(`/api/map/system-stations/${solarSystemID}`, options);
  const orNull = (value: JsonValue | undefined): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const stations = (Array.isArray(data.stations) ? data.stations : []).flatMap((each) => {
    if (each === null || typeof each !== "object" || Array.isArray(each)) return [];
    const row = each as Record<string, JsonValue>;
    const stationID = orNull(row.stationID);
    return stationID === null ? [] : [{ stationID, celestialIndex: orNull(row.celestialIndex), orbitIndex: orNull(row.orbitIndex) }];
  });
  return { regionID: orNull(data.regionID), stations };
}

/** A type's facts from the client's types record (GET /api/client-data/type-meta). */
export interface TypeMetaFacts {
  readonly metaLevel: number | null;
  readonly metaGroupID: number | null;
  readonly techLevel: number | null;
  readonly marketGroupID: number | null;
  readonly published: boolean;
  /** evetypes.GetDescriptionID: the message its description is; null where it has none. */
  readonly descriptionID: number | null;
  readonly groupID: number | null;
  readonly categoryID: number | null;
}

/** Types' meta level, meta group, tech level, market group, group and category, and the meta groups' names' messages. */
export interface TypeMetaRead {
  readonly available: boolean;
  readonly types: ReadonlyMap<number, TypeMetaFacts | null>;
  readonly metaGroupNameIDs: ReadonlyMap<number, number | null>;
}

/** The client's types records' meta level, meta group and tech level, at most 500 types at once. */
export async function getTypeMeta(typeIDs: readonly number[], options: ApiOptions = {}): Promise<TypeMetaRead> {
  const data = await getJson(`/api/client-data/type-meta?typeIDs=${typeIDs.join(",")}`, options);
  const record = (value: JsonValue | undefined): Record<string, JsonValue> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, JsonValue>) : {});
  const numberOrNull = (value: JsonValue | undefined): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const types = new Map<number, TypeMetaFacts | null>();
  for (const [key, value] of Object.entries(record(data.types))) {
    const typeID = Number(key);
    if (!Number.isSafeInteger(typeID) || typeID <= 0) continue;
    const row = value === null || typeof value !== "object" || Array.isArray(value) ? null : (value as Record<string, JsonValue>);
    types.set(typeID, row === null ? null : {
      metaLevel: numberOrNull(row.metaLevel),
      metaGroupID: numberOrNull(row.metaGroupID),
      techLevel: numberOrNull(row.techLevel),
      marketGroupID: numberOrNull(row.marketGroupID),
      published: row.published === true,
      descriptionID: numberOrNull(row.descriptionID),
      groupID: numberOrNull(row.groupID),
      categoryID: numberOrNull(row.categoryID),
    });
  }
  const metaGroupNameIDs = new Map<number, number | null>();
  for (const [key, value] of Object.entries(record(data.metaGroupNameIDs))) {
    const metaGroupID = Number(key);
    if (Number.isSafeInteger(metaGroupID) && metaGroupID > 0) metaGroupNameIDs.set(metaGroupID, numberOrNull(value));
  }
  return { available: data.available === true, types, metaGroupNameIDs };
}

/**
 * Dogma attributes as the client draws one by itself (GET /api/client-data/attribute-display): its name as the number
 * of its message, and its picture's res: path; null for one the client's tables have not. At most 32 at once.
 */
export async function getAttributeDisplay(
  attributeIDs: readonly number[],
  options: ApiOptions = {},
): Promise<{ readonly available: boolean; readonly attributes: ReadonlyMap<number, { readonly displayNameID: number | null; readonly iconFile: string | null } | null> }> {
  const data = await getJson(`/api/client-data/attribute-display?attributeIDs=${attributeIDs.join(",")}`, options);
  const raw = typeof data.attributes === "object" && data.attributes !== null && !Array.isArray(data.attributes)
    ? (data.attributes as Record<string, JsonValue>)
    : {};
  const attributes = new Map<number, { readonly displayNameID: number | null; readonly iconFile: string | null } | null>();
  for (const [key, value] of Object.entries(raw)) {
    const attributeID = Number(key);
    if (!Number.isSafeInteger(attributeID) || attributeID <= 0) continue;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      attributes.set(attributeID, null);
      continue;
    }
    const row = value as Record<string, JsonValue>;
    attributes.set(attributeID, {
      displayNameID: typeof row.displayNameID === "number" && Number.isSafeInteger(row.displayNameID) ? row.displayNameID : null,
      iconFile: typeof row.iconFile === "string" ? row.iconFile : null,
    });
  }
  return { available: data.available === true, attributes };
}

/** The expert systems as the client's data has them (GET /api/client-data/expert-systems); null where not read. */
export async function getExpertSystems(options: ApiOptions = {}): Promise<ReadonlyMap<number, ExpertSystemData> | null> {
  const data = await getJson("/api/client-data/expert-systems", options);
  if (data.available !== true) return null;
  const raw = typeof data.expertSystems === "object" && data.expertSystems !== null && !Array.isArray(data.expertSystems)
    ? (data.expertSystems as Record<string, JsonValue>)
    : {};
  const out = new Map<number, ExpertSystemData>();
  for (const [key, value] of Object.entries(raw)) {
    const typeID = Number(key);
    if (!Number.isSafeInteger(typeID) || typeID <= 0 || value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, JsonValue>;
    const skills = (Array.isArray(row.skills) ? row.skills : []).flatMap((pair) =>
      Array.isArray(pair) && Number.isSafeInteger(Number(pair[0])) ? [[Number(pair[0]), Number(pair[1]) || 0] as const] : []);
    const ships = (Array.isArray(row.ships) ? row.ships : []).map(Number).filter((ship) => Number.isSafeInteger(ship) && ship > 0);
    out.set(typeID, { typeID, durationDays: Number(row.durationDays) || 0, hidden: row.hidden === true, retired: row.retired === true, skills, ships });
  }
  return out;
}

/**
 * The certificates filed under skill groups (GET /api/client-data/skill-group-certificates): by group, each
 * certificate's skills with the level each of its five grades asks (nought where it asks none).
 */
export async function getSkillGroupCertificates(
  groupIDs: readonly number[],
  options: ApiOptions = {},
): Promise<ReadonlyMap<number, readonly { readonly certificateID: number; readonly skills: readonly (readonly [number, readonly number[]])[] }[]>> {
  const data = await getJson("/api/client-data/skill-group-certificates?groupIDs=" + groupIDs.join(","), options);
  const raw = typeof data.certificates === "object" && data.certificates !== null && !Array.isArray(data.certificates)
    ? (data.certificates as Record<string, JsonValue>)
    : {};
  const out = new Map<number, { readonly certificateID: number; readonly skills: readonly (readonly [number, readonly number[]])[] }[]>();
  for (const [key, value] of Object.entries(raw)) {
    const groupID = Number(key);
    if (!Number.isSafeInteger(groupID) || groupID <= 0 || !Array.isArray(value)) continue;
    out.set(groupID, value.flatMap((certificate) => {
      if (certificate === null || typeof certificate !== "object" || Array.isArray(certificate)) return [];
      const record = certificate as Record<string, JsonValue>;
      const skills = (Array.isArray(record.skills) ? record.skills : []).flatMap((skill) => {
        if (!Array.isArray(skill) || !Array.isArray(skill[1])) return [];
        const typeID = Number(skill[0]);
        return Number.isSafeInteger(typeID) && typeID > 0 ? [[typeID, (skill[1] as JsonValue[]).map((level) => Number(level) || 0)] as const] : [];
      });
      return [{ certificateID: Number(record.certificateID) || 0, skills }];
    }));
  }
  return out;
}

/** What the compare tool reads of some types (GET /api/client-data/type-attributes). */
export interface TypeAttributesRead {
  readonly available: boolean;
  /** By type: its dogma attributes and facts, or null for a type the client's tables have not. */
  readonly types: ReadonlyMap<number, ComparisonTypeData | null>;
  /** The records of the attributes they carry and of those the tool adds or a value names; null for one not had. */
  readonly attributes: ReadonlyMap<number, DogmaAttributeRecord | null>;
  /** Each unit's name as the number of its message. */
  readonly unitNameIDs: ReadonlyMap<number, number | null>;
}

/**
 * Types as the compare tool reads them, from the client's own tables: each type's dogma attributes (get_type_attributes'
 * rows), group, category, published and dynamic; the attributes' records; the units' names. At most 50 at once.
 */
export async function getTypeAttributes(typeIDs: readonly number[], options: ApiOptions = {}): Promise<TypeAttributesRead> {
  const data = await getJson(`/api/client-data/type-attributes?typeIDs=${typeIDs.join(",")}`, options);
  const record = (value: JsonValue | undefined): Record<string, JsonValue> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, JsonValue>) : {});
  const numberOrNull = (value: JsonValue | undefined): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const types = new Map<number, ComparisonTypeData | null>();
  for (const [key, value] of Object.entries(record(data.types))) {
    const typeID = Number(key);
    if (!Number.isSafeInteger(typeID) || typeID <= 0) continue;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      types.set(typeID, null);
      continue;
    }
    const entry = value as Record<string, JsonValue>;
    const attributes = (Array.isArray(entry.attributes) ? entry.attributes : []).flatMap((row) => {
      if (!Array.isArray(row)) return [];
      const attributeID = Number(row[0]);
      return Number.isSafeInteger(attributeID) && attributeID > 0 ? [[attributeID, numberOrNull(row[1])] as const] : [];
    });
    types.set(typeID, {
      attributes,
      groupID: numberOrNull(entry.groupID),
      categoryID: numberOrNull(entry.categoryID),
      published: entry.published === true,
      dynamic: entry.dynamic === true,
    });
  }
  const attributes = new Map<number, DogmaAttributeRecord | null>();
  for (const [key, value] of Object.entries(record(data.attributes))) {
    const attributeID = Number(key);
    if (!Number.isSafeInteger(attributeID) || attributeID <= 0) continue;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      attributes.set(attributeID, null);
      continue;
    }
    const row = value as Record<string, JsonValue>;
    attributes.set(attributeID, {
      name: typeof row.name === "string" ? row.name : null,
      displayNameID: numberOrNull(row.displayNameID),
      tooltipDescriptionID: numberOrNull(row.tooltipDescriptionID),
      unitID: numberOrNull(row.unitID),
      iconID: numberOrNull(row.iconID),
      published: row.published === true,
      displayWhenZero: row.displayWhenZero === true,
      highIsGood: row.highIsGood === true,
      dataType: numberOrNull(row.dataType),
      defaultValue: numberOrNull(row.defaultValue),
    });
  }
  const unitNameIDs = new Map<number, number | null>();
  for (const [key, value] of Object.entries(record(data.unitNameIDs))) {
    const unitID = Number(key);
    if (Number.isSafeInteger(unitID) && unitID > 0) unitNameIDs.set(unitID, numberOrNull(value));
  }
  return { available: data.available === true, types, attributes, unitNameIDs };
}

/**
 * Dogma effects' names as the numbers of their messages (GET /api/client-data/effect-names: the effect's displayNameID),
 * null for an effect with none; `available` false where the client's data could not be read.
 */
export async function getEffectDisplayNameIDs(
  effectIDs: readonly number[],
  options: ApiOptions = {},
): Promise<{ readonly available: boolean; readonly displayNameIDs: Readonly<Record<number, number | null>> }> {
  const data = await getJson(`/api/client-data/effect-names?effectIDs=${effectIDs.join(",")}`, options);
  const raw = typeof data.displayNameIDs === "object" && data.displayNameIDs !== null && !Array.isArray(data.displayNameIDs)
    ? (data.displayNameIDs as Record<string, JsonValue>)
    : {};
  const displayNameIDs: Record<number, number | null> = {};
  for (const [key, value] of Object.entries(raw)) {
    const effectID = Number(key);
    if (Number.isSafeInteger(effectID) && effectID > 0) displayNameIDs[effectID] = typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  return { available: data.available === true, displayNameIDs };
}

/**
 * An alpha clone's skills and their highest levels for a race (GET /api/client-data/clone-grade): each skill's level, a
 * skill not listed 0; `available` false where the client's data could not be read.
 */
export async function getCloneGrade(
  raceID: number,
  options: ApiOptions = {},
): Promise<{ readonly available: boolean; readonly levels: ReadonlyMap<number, number> }> {
  const data = await getJson(`/api/client-data/clone-grade?raceID=${raceID}`, options);
  const raw = typeof data.levels === "object" && data.levels !== null && !Array.isArray(data.levels) ? (data.levels as Record<string, JsonValue>) : {};
  const levels = new Map<number, number>();
  for (const [key, value] of Object.entries(raw)) {
    const skill = Number(key);
    if (Number.isSafeInteger(skill) && skill > 0 && typeof value === "number") levels.set(skill, value);
  }
  return { available: data.available === true, levels };
}

/**
 * A fitting read from text as the client's fitting window reads one from the clipboard (POST
 * /api/client-data/fitting-import; fittingSvc.ImportFittingFromClipboard, shipfitting/importFittingUtil.py): the ship's
 * type, the fitting's name, its entries and the lines it could not read; or the client's ImportingErrorFromClipboard.
 */
export async function importFitting(
  text: string,
  options: ApiOptions = {},
): Promise<
  | { readonly error: string }
  | { readonly shipTypeID: number; readonly name: string; readonly fitData: readonly (readonly [number, number, number])[]; readonly errorLines: readonly string[] }
> {
  const data = await postJson("/api/client-data/fitting-import", { text }, options);
  const shipTypeID = Number(data.shipTypeID);
  if (typeof data.error === "string" || !Number.isSafeInteger(shipTypeID) || shipTypeID <= 0) {
    return { error: typeof data.error === "string" ? data.error : "ImportingErrorFromClipboard" };
  }
  const fitData: (readonly [number, number, number])[] = [];
  for (const entry of Array.isArray(data.fitData) ? (data.fitData as JsonValue[]) : []) {
    if (!Array.isArray(entry)) continue;
    const typeID = Number(entry[0]);
    const flagID = Number(entry[1]);
    const qty = Number(entry[2]);
    if (Number.isSafeInteger(typeID) && typeID > 0 && Number.isSafeInteger(flagID) && Number.isSafeInteger(qty)) fitData.push([typeID, flagID, qty]);
  }
  const errorLines = Array.isArray(data.errorLines) ? (data.errorLines as JsonValue[]).map((line) => String(line)) : [];
  return { shipTypeID, name: typeof data.name === "string" ? data.name : "", fitData, errorLines };
}

/**
 * A list of skills read as the client's skill plan editor reads one from the clipboard (POST
 * /api/client-data/skillplan-import; textImporting.importSkillplan GetSkillsAndLevelsFromText): each line's skill and
 * level, in order, and the lines it could not read.
 */
export async function importSkillPlanText(
  text: string,
  options: ApiOptions = {},
): Promise<{ readonly skillsAndLevels: readonly (readonly [number, number])[]; readonly failed: readonly string[] }> {
  const data = await postJson("/api/client-data/skillplan-import", { text }, options);
  const skillsAndLevels: (readonly [number, number])[] = [];
  for (const entry of Array.isArray(data.skillsAndLevels) ? (data.skillsAndLevels as JsonValue[]) : []) {
    if (!Array.isArray(entry)) continue;
    const typeID = Number(entry[0]);
    const level = Number(entry[1]);
    if (Number.isSafeInteger(typeID) && typeID > 0 && Number.isSafeInteger(level) && level >= 1 && level <= 5) skillsAndLevels.push([typeID, level]);
  }
  const failed = Array.isArray(data.failed) ? (data.failed as JsonValue[]).map((line) => String(line)) : [];
  return { skillsAndLevels, failed };
}

/**
 * A shopping list read as the client's multibuy window reads one from the clipboard (POST
 * /api/client-data/multibuy-import; textImporting.importMultibuy): each market type it names with its quantity, in the
 * order the client adds them, and the lines it could not read.
 */
export async function importMultibuy(
  text: string,
  options: ApiOptions = {},
): Promise<{ readonly found: readonly (readonly [number, number])[]; readonly failedLines: readonly string[] }> {
  const data = await postJson("/api/client-data/multibuy-import", { text }, options);
  const found: (readonly [number, number])[] = [];
  for (const entry of Array.isArray(data.found) ? (data.found as JsonValue[]) : []) {
    if (!Array.isArray(entry)) continue;
    const typeID = Number(entry[0]);
    const qty = Number(entry[1]);
    if (Number.isSafeInteger(typeID) && typeID > 0 && Number.isSafeInteger(qty)) found.push([typeID, qty]);
  }
  const failedLines = Array.isArray(data.failedLines) ? (data.failedLines as JsonValue[]).map((line) => String(line)) : [];
  return { found, failedLines };
}

/**
 * The global config the game server gave the pilot's client at its login, for the names asked (GET
 * /api/bridge/global-config): each value as given, or null. `available` false where the pilot's transport does not
 * carry it (the web gateway): then the client's defaults stand.
 */
export async function getGlobalConfig(
  names: readonly string[],
  options: ApiOptions = {},
): Promise<{ readonly available: boolean; readonly values: Readonly<Record<string, JsonValue>> }> {
  const data = await getJson(`/api/bridge/global-config?names=${encodeURIComponent(names.join(","))}`, options);
  const values = typeof data.values === "object" && data.values !== null && !Array.isArray(data.values) ? (data.values as Record<string, JsonValue>) : {};
  return { available: data.available === true, values };
}

/**
 * GET /api/types/passive-effects?typeIDs=...: each type's passive effects as the client's dogma static service
 * filters them (GetPassiveFilteredEffectsByType), or null where the tables do not know the type.
 */
export async function loadPassiveEffects(
  typeIDs: readonly number[],
  options: ApiOptions = {},
): Promise<Readonly<Record<number, readonly number[] | null>>> {
  if (typeIDs.length === 0) return {};
  const data = await getJson(`/api/types/passive-effects?typeIDs=${encodeURIComponent(typeIDs.join(","))}`, options);
  const raw = typeof data.effects === "object" && data.effects !== null && !Array.isArray(data.effects) ? (data.effects as Record<string, JsonValue>) : {};
  const effects: Record<number, readonly number[] | null> = {};
  for (const [key, value] of Object.entries(raw)) {
    const typeID = Number(key);
    if (!Number.isSafeInteger(typeID) || typeID <= 0) continue;
    effects[typeID] = Array.isArray(value) ? value.map(Number).filter((id) => Number.isSafeInteger(id)) : null;
  }
  return effects;
}

export async function fetchTypeDogma(
  typeIDs: readonly number[],
  attributeIDs: readonly number[],
  options: ApiOptions = {},
): Promise<Readonly<Record<number, Readonly<Record<number, number>>>>> {
  const data = await postJson("/api/types/dogma", { typeIDs, attributeIDs }, options);
  const raw =
    typeof data.attributes === "object" &&
    data.attributes !== null &&
    !Array.isArray(data.attributes)
      ? (data.attributes as Record<string, JsonValue>)
      : {};
  const attributes: Record<number, Record<number, number>> = {};
  for (const [typeKey, values] of Object.entries(raw)) {
    const typeID = Number(typeKey) || 0;
    if (typeID <= 0) {
      continue;
    }
    const byAttribute: Record<number, number> = {};
    if (typeof values === "object" && values !== null && !Array.isArray(values)) {
      for (const [attributeKey, value] of Object.entries(values as Record<string, JsonValue>)) {
        const attributeID = Number(attributeKey) || 0;
        // Number.isFinite, never a truthiness test — see the zero warning above.
        if (attributeID > 0 && typeof value === "number" && Number.isFinite(value)) {
          byAttribute[attributeID] = value;
        }
      }
    }
    // Kept even when empty: "asked and got nothing" is what the caller caches.
    attributes[typeID] = byAttribute;
  }
  return attributes;
}

// --- R25 slice A: drones -----------------------------------------------------
//
// Four routes, and NOT ONE of them can be trusted on its own return value. The
// server's launch handler answers 200 with an empty dict when it refuses, and
// all three entity orders answer an empty dict on SUCCESS and error tuples
// otherwise. So every function below reports what the BFF read back OUT OF
// SPACE afterwards, and `inSpace: null` means the re-read failed — never "you
// have no drones".

/** The whole Drones panel in one read: bay, space, and the server's limits. */
export interface DronesResult {
  readonly activeShipID: number | null;
  /** null when the bay could not be read — NOT an empty bay. */
  readonly bay: JsonValue;
  /** null when the snapshot could not be read — NOT "no drones in space". */
  readonly inSpace: JsonValue;
  /** Raw dogmaIM.ShipGetInfo, decoded by bridge/drones.ts (no new call). */
  readonly shipInfo: JsonValue;
  readonly errors: Readonly<Record<string, string | null>>;
}

export async function getDrones(options: ApiOptions = {}): Promise<DronesResult> {
  const data = await getJson("/api/bridge/drones", options);
  return readDronesResult(data);
}

/** Access-scoped Upwell identity. A failed authority read rejects, not []. */
export async function findAccessibleStructures(q: string, options: ApiOptions = {}, characterID?: number): Promise<readonly MapLocation[]> {
  const data = await getJson(`/api/dockable-structures/find?q=${encodeURIComponent(q)}${characterID ? `&characterID=${characterID}` : ""}`, options);
  if (!Array.isArray(data.matches)) throw new Error("Structure search authority is unreadable.");
  return data.matches.map((raw) => {
    const row = (raw ?? {}) as Record<string, JsonValue>;
    const id = asNumberOrNull(row.id), solarSystemID = asNumberOrNull(row.solarSystemID);
    if (row.kind !== "structure" || id === null || id < 1_000_000_000_000 || solarSystemID === null ||
        typeof row.name !== "string" || !row.name) throw new Error("Structure search response is malformed.");
    return { kind: "structure" as const, id, name: row.name, solarSystemID,
      solarSystemName: typeof row.solarSystemName === "string" ? row.solarSystemName : null };
  });
}

/** Revalidate this pilot's access and structure identity immediately before routing. */
export async function resolveAccessibleStructure(id: number, options: ApiOptions = {}, characterID?: number): Promise<import("../nav/dockableLocation.ts").DockableLocation> {
  const data = await getJson(`/api/dockable-structures/${id}${characterID ? `?characterID=${characterID}` : ""}`, options);
  const row = (data.location ?? {}) as Record<string, JsonValue>;
  const solarSystemID = asNumberOrNull(row.solarSystemID);
  if (row.kind !== "structure" || asNumberOrNull(row.id) !== id || solarSystemID === null ||
      typeof row.name !== "string" || !row.name) throw new Error("Structure access is unreadable.");
  return { kind: "structure", id, name: row.name, solarSystemID,
    solarSystemName: typeof row.solarSystemName === "string" ? row.solarSystemName : null };
}

export async function readAccessibleStructureServices(id: number, options: ApiOptions = {}, characterID?: number): Promise<readonly number[]> {
  const data = await getJson(`/api/dockable-structures/${id}/services${characterID ? `?characterID=${characterID}` : ""}`, options);
  if (asNumberOrNull(data.structureID) !== id || !Array.isArray(data.serviceIDs) ||
      data.serviceIDs.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error("Structure service authority is unreadable.");
  }
  return data.serviceIDs as number[];
}

export async function listDockableAccessPilots(options: ApiOptions = {}): Promise<readonly { characterID: number; characterName: string }[]> {
  const data = await getJson("/api/dockable-structures/pilots", options);
  if (!Array.isArray(data.pilots)) throw new Error("Dockable access pilots are unreadable.");
  return data.pilots.map(row => ({ characterID: asNumberOrNull((row as Record<string, JsonValue>).characterID) ?? 0,
    characterName: String((row as Record<string, JsonValue>).characterName ?? "") }))
    .filter(row => row.characterID > 0 && row.characterName);
}

/** One authenticated script generation's BFF-owned container lease. */
export async function claimContainer(
  runID: string, solarSystemID: number, itemID: number, renewOnly = false,
  options: ApiOptions = {},
): Promise<boolean> {
  const data = await postJson("/api/bots/loot-memory/claim", { runID, system: solarSystemID, itemID, renewOnly }, options);
  if (typeof data.claimed !== "boolean") throw new Error("Container claim authority did not return a verdict.");
  return data.claimed;
}

export async function readClaimedContainers(
  runID: string, solarSystemID: number, options: ApiOptions = {},
): Promise<readonly number[]> {
  const data = await getJson(`/api/bots/loot-memory/claims?system=${solarSystemID}&runID=${encodeURIComponent(runID)}`, options);
  if (!Array.isArray(data.itemIDs)) throw new Error("Container claim authority is unreadable.");
  return asNumberList(data.itemIDs);
}

export async function releaseContainerClaims(runID: string, options: ApiOptions = {}): Promise<void> {
  await postJson("/api/bots/loot-memory/release", { runID }, options);
}

/** One fresh scene read, also projected as this observation's in-space drones. */
export async function getScriptObservation(options: ApiOptions = {}): Promise<SpaceSnapshotResult & DronesResult> {
  const data = await getJson("/api/bridge/script/observation", options);
  return {
    ...readDronesResult(data),
    space: data.space ?? null,
    notifications: Array.isArray(data.notifications) ? data.notifications : [],
  };
}

function readDronesResult(data: Record<string, JsonValue>): DronesResult {
  const rawErrors =
    typeof data.errors === "object" && data.errors !== null && !Array.isArray(data.errors)
      ? (data.errors as Record<string, JsonValue>)
      : {};
  const errors: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(rawErrors)) {
    errors[key] = typeof value === "string" && value.length > 0 ? value : null;
  }
  return {
    activeShipID: Number(data.activeShipID) || null,
    bay: data.bay ?? null,
    inSpace: data.inSpace ?? null,
    shipInfo: data.shipInfo ?? null,
    errors,
  };
}

// Drones are launched by the page itself, with the client's own call of the ship (bridge/boundEntityWrites.ts,
// launchDrones), and read before and after by the read above (app/flow.ts, launchedThenRead): it left its route
// (POST /api/bridge/drones/launch) on 2026-10-14. (An idle combat drone engages what shoots the ship it came from:
// the server's own behaviour, so a miner who launches is defended without another click.)

// Drones are set on a target, set to mine and sent home by the page itself, with the client's own calls of the
// entity service (bridge/boundEntityWrites.ts), and the drones are read after by the read above: the three left
// their routes (POST /api/bridge/drones/engage, .../mine and .../recall) on 2026-10-14.

/** A per-drone answer, retained even when only part of an order was accepted. */
export class DroneEngageOutcomeError extends BridgeCallError {
  readonly acceptedDroneIDs: readonly number[];
  readonly refusedDroneIDs: readonly number[];
  readonly uncertainDroneIDs: readonly number[];
  readonly refusals: readonly DroneEngageRefusal[];

  constructor(outcome: DroneEngageOutcome) {
    super(outcome.status === "refused" ? "CALL_REFUSED" : "BRIDGE_BAD_RESPONSE",
      outcome.status === "refused" ? `The server refused drone engagement: ${[...new Set(outcome.refusals.map((refusal) => refusal.raw))].join(" ")}`
        : "Could not confirm every drone engagement order.", 200);
    this.acceptedDroneIDs = outcome.acceptedDroneIDs;
    this.refusedDroneIDs = outcome.refusedDroneIDs;
    this.uncertainDroneIDs = outcome.uncertainDroneIDs;
    this.refusals = outcome.refusals;
  }
}

// (An engagement a bot must see settled is the flow's since 2026-10-14: app/flow.ts, engageDronesConfirmed.)

/**
 * Take control of drones this ship is not flying (entity.CmdReconnectToDrones).
 *
 * The recovery path for an ORPHANED drone — one this character owns that the
 * current hull does not control, after a lost session, a ship swap, or a pod
 * and reboard. Until this existed a web-client player had no way to get such a
 * drone back at all: Recall and Engage both need control the ship does not have.
 */
// (It is the page's own call of the entity service since 2026-10-13 (bridge/boundEntityWrites.ts,
// reconnectToDrones), with the drones read after by the read above: its route,
// POST /api/bridge/entity/drones/reconnect, is gone.)

// Drones are scooped into the bay by the page itself, with the client's own
// call of the ship (bridge/boundEntityWrites.ts), and the drones are read after
// by the read above: it left its route (POST /api/bridge/drones/scoop) on
// 2026-10-11.

// Free skill points are put into a skill by the page itself, with the client's
// own call (bridge/skillWrites.ts; the plan's Phase 6b): the third of its writes
// to leave its route (POST /api/bridge/skills/apply-free-points), on 2026-10-10.

// A module is overloaded and cooled by the page itself, with the client's own
// calls and the module's own overload effect named (bridge/dogmaWrites.ts; the
// plan's Phase 6b): the ninth and tenth of its writes to leave their routes
// (POST /api/bridge/dogma/module/overload and .../stop-overload), on 2026-10-10.
//
// ⚠ OVERLOADING DAMAGES THE MODULE. It runs harder and takes heat; a module left
// overloaded burns out and stops. Repair is the complement, below.

// A module's repair is begun and ended by the page itself, with godma's own two
// calls (bridge/dogmaWrites.ts; the plan's Phase 6b): the eleventh of its writes
// to leave its route (POST /api/bridge/dogma/module/repair/start), on 2026-10-10.
// The route for the ending (.../repair/stop) nothing of the page's ever asked,
// which is why a repair begun here took the paste and mended nothing: the server
// mends a module when its repair is ended, and a client ends its own.

// A ship's weapons are linked and unlinked by the page itself, with the client's
// own calls and the ship named as the client names it (bridge/dogmaWrites.ts; the
// plan's Phase 6b): the thirteenth and fourteenth of its writes to leave their
// routes (POST /api/bridge/dogma/weapons/link-all and .../unlink-all), on
// 2026-10-10.

// --- Ammunition ---------------------------------------------------------------
//
// Ammunition is loaded and unloaded by the page itself, with the client's own
// calls, the ship and the place named as the client names them
// (bridge/dogmaWrites.ts; the plan's Phase 6b): the fifteenth and sixteenth of
// its writes to leave their routes (POST /api/bridge/dogma/ammo/load and
// .../unload), on 2026-10-10. The routes took a WORD for the place and named
// the ship and the place themselves, because the server acted on whatever it
// was handed; it holds both calls to where the session is now.

// --- The GM console -----------------------------------------------------------
//
// A GM's command is the page's own call of the slash service
// (bridge/gmWrites.ts; the plan's Phase 6b): it left its route
// (POST /api/bridge/gm/slash) on 2026-10-10.

// The repair shop's quote and its repairs are the page's own calls of the
// repair service (bridge/repairShop.ts; the plan's Phase 6b): they left their
// routes (GET /api/bridge/station/repair-quotes, POST /api/bridge/station/repair)
// on 2026-10-10.

// A pilot's planetary launches are read by the page itself, with the client's
// own call (bridge/launchReads.ts: planetMgr.GetMyLaunchesDetails): the read
// left its route (GET /api/bridge/pi-colonies) on 2026-10-11.

// A planetary launch's record is removed by the page itself, with the client's
// own call (bridge/launchWrites.ts; the plan's Phase 6b): the sixth of its writes
// to leave its route (POST /api/bridge/planet/launch/delete), on 2026-10-10.

/** What one colony's launchpads did when the Haul button sent them up. */
export interface CustomsExportPlanet {
  readonly planetID: number;
  readonly planetName: string | null;
  readonly solarSystemID: number;
  readonly solarSystemName: string | null;
  /** The office the goods went into; null when none was reached. */
  readonly officeID: number | null;
  readonly exported: boolean;
  readonly units: number;
  /** Why not, in a word: "no-colony", "nothing-on-the-pads", "no-office", "refused". */
  readonly reason: string | null;
  /** The server's own sentence where it gave one. */
  readonly message: string | null;
}

export interface CustomsExportResult {
  /**
   * True when nothing was sent up here because the haul's own run will send
   * each colony's launchpads up at its customs office, as the retail client
   * does (a pilot on the game port). Each planet then reads "at-the-office".
   */
  readonly atTheOffices?: boolean;
  /** False when nothing needed sending, so nobody was logged out. */
  readonly connected: boolean;
  /** True/false when the caller's own pilot was re-selected; null when it was not ours. */
  readonly handedBack: boolean | null;
  readonly planets: readonly CustomsExportPlanet[];
}

/**
 * Send these colonies' launchpad goods up into their customs offices.
 *
 * ⚠ THIS BRIEFLY LOGS THE PILOT OUT. The call the retail client makes here
 * (invbroker.ImportExportWithPlanet) is not on the web gateway, so the BFF
 * makes it over the GAME PORT, which means selecting the character there — and
 * a character may be in game on one session. The BFF refuses a pilot a bot or
 * another tab is flying, and hands the caller's own pilot straight back.
 */
export async function exportToCustomsOffices(
  characterID: number,
  planetIDs: readonly number[],
  options: ApiOptions = {},
): Promise<CustomsExportResult> {
  const data = await postJson(
    "/api/pi/customs-export",
    { characterID, planetIDs: [...planetIDs], confirm: true },
    options,
  );
  const planets = Array.isArray(data.planets) ? data.planets : [];
  return {
    atTheOffices: data.atTheOffices === true,
    connected: data.connected === true,
    handedBack: typeof data.handedBack === "boolean" ? data.handedBack : null,
    planets: planets.map((row) => {
      const entry = row !== null && typeof row === "object" && !Array.isArray(row)
        ? (row as { readonly [key: string]: JsonValue })
        : {};
      return {
        planetID: asNumberOrNull(entry.planetID) ?? 0,
        planetName: typeof entry.planetName === "string" ? entry.planetName : null,
        solarSystemID: asNumberOrNull(entry.solarSystemID) ?? 0,
        solarSystemName: typeof entry.solarSystemName === "string" ? entry.solarSystemName : null,
        officeID: asNumberOrNull(entry.officeID),
        exported: entry.exported === true,
        units: asNumberOrNull(entry.units) ?? 0,
        reason: typeof entry.reason === "string" ? entry.reason : null,
        message: typeof entry.message === "string" ? entry.message : null,
      };
    }),
  };
}

// The saved fittings, the pilot's own and its corporation's, are read by the
// page itself, with the client's own call for each owner
// (bridge/fittingReads.ts): they left their routes (GET /api/bridge/fittings
// and GET /api/bridge/shared-fittings) on 2026-10-11.

// (A saved fitting is applied by the page itself since 2026-10-14, with the client's own call on the ship's own
// inventory: bridge/fitModule.ts, applyFitting. Its route, POST /api/bridge/inventory/fit-fitting, is gone.)

// The scanner's sites are the page's own call of the system's scan manager
// (bridge/scanFullState.ts; the plan's Phase 6b): they left their route
// (GET /api/bridge/scan-full-state) on 2026-10-10.

function scannerVector(value: JsonValue | undefined): readonly [number, number, number] {
  if (!Array.isArray(value)) {
    return [0, 0, 0];
  }
  return [0, 1, 2].map((index) => asNumberOrNull(value[index]) ?? 0) as unknown as readonly [number, number, number];
}

/**
 * The pilot's scanner as the transport keeps it: the launcher, the probes and whether a scan is under way. No call
 * of the server's is behind it. The scanner's orders are the page's own calls and go by it
 * (bridge/scannerWrites.ts): their routes (POST /api/bridge/scanner/launch, analyze, recover and reconnect) went
 * on 2026-10-13.
 */
export async function loadScannerOperations(
  options: ApiOptions = {},
): Promise<ScannerOperationsSnapshot> {
  const data = await getJson("/api/bridge/scanner/state", options);
  const scanner = data.scanner && typeof data.scanner === "object" && !Array.isArray(data.scanner)
    ? data.scanner as Record<string, JsonValue>
    : {};
  const launcherRow = scanner.launcher && typeof scanner.launcher === "object" && !Array.isArray(scanner.launcher)
    ? scanner.launcher as Record<string, JsonValue>
    : null;
  const probes: ScannerProbeOperation[] = Array.isArray(scanner.probes)
    ? scanner.probes.flatMap((value) => {
        if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
        const row = value as Record<string, JsonValue>;
        const probeID = asNumberOrNull(row.probeID);
        const typeID = asNumberOrNull(row.typeID);
        if (probeID === null || probeID <= 0 || typeID === null || typeID <= 0) return [];
        return [{
          probeID,
          typeID,
          pos: scannerVector(row.pos),
          destination: scannerVector(row.destination),
          scanRange: asNumberOrNull(row.scanRange) ?? 0,
          rangeStep: asNumberOrNull(row.rangeStep) ?? 0,
          rangeSteps: Array.isArray(row.rangeSteps)
            ? row.rangeSteps.map((range) => asNumberOrNull(range)).filter((range): range is number => range !== null && range > 0)
            : [],
          state: asNumberOrNull(row.state) ?? 0,
          expiry: typeof row.expiry === "string" ? row.expiry : "0",
        }];
      })
    : [];
  return {
    inSpace: scanner.inSpace === true,
    solarSystemID: asNumberOrNull(scanner.solarSystemID),
    shipID: asNumberOrNull(scanner.shipID),
    maxActiveProbes: Math.max(0, asNumberOrNull(scanner.maxActiveProbes) ?? 0),
    launcher: launcherRow === null || (asNumberOrNull(launcherRow.moduleID) ?? 0) <= 0
      ? null
      : {
          moduleID: asNumberOrNull(launcherRow.moduleID)!,
          typeID: asNumberOrNull(launcherRow.typeID),
          online: launcherRow.online === true,
          chargeTypeID: asNumberOrNull(launcherRow.chargeTypeID),
          loadedCount: Math.max(0, asNumberOrNull(launcherRow.loadedCount) ?? 0),
          launchCount: Math.max(0, asNumberOrNull(launcherRow.launchCount) ?? 0),
        },
    probes,
    // Said by a pilot on the game port; a transport that does not say holds no scan to be under way.
    scanning: scanner.scanning === true,
  };
}

/**
 * ⚠ JETTISON — dumps these cargo items into space as a container ANYONE can take.
 * A hosted bot's of a Mining Operation: the route finds the can it made and gives it
 * to the operation, and keeps a hosted miner's custody. Any other jettison is the
 * page's own call since 2026-10-14 (bridge/shipWrites.ts, jettison), and the route
 * refuses it.
 */
export async function jettisonItems(
  itemIDs: readonly number[],
  options: ApiOptions = {},
  invocation?: { readonly runID: string; readonly invocationID: number; readonly stepPath: string },
): Promise<HostedJettisonReceipt | null> {
  const data = await postJson("/api/bridge/ship/jettison", { itemIDs: [...itemIDs], confirm: true, ...(invocation ? { invocation } : {}) }, options);
  if (!invocation) return null;
  return hostedJettisonReceipt(data, false);
}

export type HostedJettisonReceipt = Readonly<Record<string, JsonValue>> & { readonly state: string };
export class JettisonCustodyError extends BridgeCallError {
  readonly custody: HostedJettisonReceipt | null;
  readonly notIssued: boolean;
  /** `words` is the route's own sentence for the refusal, which names its cause when one was thrown. */
  constructor(code: string, custody: HostedJettisonReceipt | null, notIssued = false, words: unknown = null) {
    super(code, typeof words === "string" && words.trim() !== "" ? words.trim() : "Jettison custody requires reconciliation before another mutation.", 409);
    this.custody = custody;
    this.notIssued = notIssued;
  }
}
export function recoverableHostedJettison(receipt: HostedJettisonReceipt): boolean {
  return ["not-issued", "refused-before-dispatch", "confirmed-created", "confirmed-no-ore-mutation"].includes(receipt.state);
}
function hostedJettisonReceipt(data: Record<string, JsonValue>, allowNone: boolean): HostedJettisonReceipt | null {
  const value = data["jettisonCustody"];
  if (value === null && allowNone && data["accepted"] === true) return null;
  const object = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : null;
  const custody = object && typeof object["state"] === "string" ? object as HostedJettisonReceipt : null;
  if (!custody || data["accepted"] !== true || !recoverableHostedJettison(custody))
    throw new JettisonCustodyError(typeof data["error"] === "string" ? data["error"] : "JETTISON_CUSTODY_UNKNOWN", custody, data["notIssued"] === true, data["message"]);
  return custody;
}
export async function reconcileHostedJettison(options: ApiOptions = {}): Promise<HostedJettisonReceipt | null> {
  return hostedJettisonReceipt(await postJson("/api/bridge/ship/jettison/reconcile", {}, options), true);
}


export interface CompressionCompatibility {
  readonly typeID: number; readonly compressedTypeID: number | null;
  readonly matchingTypeListIDs: readonly number[] | null; readonly availability: "available" | "unknown";
}
export async function getMiningCompressionCompatibility(typeIDs: readonly number[], typeListIDs: readonly number[], options: ApiOptions = {}): Promise<readonly CompressionCompatibility[] | null> {
  if (!typeIDs.length || typeIDs.length > 32 || !typeListIDs.length || typeListIDs.length > 16 ||
    [...typeIDs, ...typeListIDs].some(id => !Number.isSafeInteger(id) || id <= 0)) return null;
  const data = await getJson(`/api/mining/compression-compatibility?typeIDs=${typeIDs.join(",")}&typeListIDs=${typeListIDs.join(",")}`, options);
  if (!Array.isArray(data.compatibility)) return null;
  const rows = data.compatibility as unknown as readonly CompressionCompatibility[];
  return rows.length === new Set(typeIDs).size && new Set(rows.map(row => row?.typeID)).size === rows.length && rows.every(row =>
    row && typeIDs.includes(row.typeID) && (row.availability === "unknown" || row.availability === "available" &&
      (row.compressedTypeID === null || Number.isSafeInteger(row.compressedTypeID) && row.compressedTypeID > 0) &&
      Array.isArray(row.matchingTypeListIDs) && row.matchingTypeListIDs.every(id => typeListIDs.includes(id)))) ? rows : null;
}

// A stack is compressed in space by the page itself, with the client's own call
// (bridge/compressionWrites.ts): it left its route (POST /api/bridge/mining/compress)
// on 2026-10-14.

// (A bookmark and a launch are warped to by the page itself, with the client's own call: bridge/movementWrites.ts,
// warpToBookmark and warpToLaunch. Their routes are flight/warp-bookmark and flight/warp-launch.)

// A place in space is bookmarked by the page itself, with the client's own
// call of the ballpark (bridge/bookmarkWrites.ts): it left its route
// (POST /api/bridge/flight/bookmark-location) on 2026-10-11.

// A launchpad's goods are sent up into its planet's customs office by the page
// itself, with the client's own two calls (bridge/customsWrites.ts): it left its
// route (POST /api/bridge/planet/customs/export) on 2026-10-13.


// (A scan result is warped to by the page itself, with the client's own call: bridge/movementWrites.ts,
// warpToScanResult. Its route, flight/warp-scan, warped to every site by its label.)

// Drones are sent to salvage by the page itself, with the client's own call
// (bridge/boundEntityWrites.ts; the plan's Phase 6b): the eighteenth of its
// writes to leave its route (POST /api/bridge/entity/drones/salvage), on
// 2026-10-10.

// --- R28 Skills: the character sheet and the training queue -------------------
//
// ONE read and ONE write, because that is what the server has. Adding a skill,
// removing one and reordering are all "save this list" — the same call retail
// makes — so there is no add/remove/move endpoint to keep in step with three
// different server behaviours.
//
// The write's answer is NOT its own return value: the BFF re-reads the sheet
// after every save and returns THAT, so a caller cannot accidentally believe a
// queue edit that never landed.

/** The whole Skills panel in one read: sheet, queue, and the server's clock. */
export interface SkillsResult {
  /** Raw; decoded by bridge/skills.ts. Carries serverNowMs for the countdown. */
  readonly skills: JsonValue;
  readonly notifications: readonly JsonValue[];
}

function readSkills(data: Record<string, JsonValue>): SkillsResult {
  return {
    skills: data.skills ?? null,
    notifications: Array.isArray(data.notifications) ? data.notifications : [],
  };
}

/**
 * The route's sheet (GET /api/bridge/skills). The page makes the sheet itself where its pilot's transport carries
 * the reads (bridge/skillReads.ts; the plan's Phase 6b). This is read where it does not: through the web gateway.
 */
export async function getSkills(options: ApiOptions = {}): Promise<SkillsResult> {
  return readSkills(await getJson("/api/bridge/skills", options));
}

// The pause of training is made by the page itself, with the client's own call
// (bridge/skillWrites.ts; the plan's Phase 6b): the first of its writes to leave
// its route (POST /api/bridge/skills/abort-training), on 2026-10-10.

/**
 * Save the whole training queue by its route (skillMgr.SaveNewQueue), which answers the route's sheet. The page
 * saves a queue itself, with the client's own call, where its pilot's transport carries that
 * (bridge/skillWrites.ts; the plan's Phase 6b). This is asked where it does not: through the web gateway.
 *
 * Sending [] empties the queue. The server validates the list as a WHOLE and
 * refuses all of it with one of eleven public codes if any part is wrong — the
 * refusal arrives as a BridgeCallError whose message is that bare code, which
 * bridge/skills.ts turns into a sentence.
 */
export async function saveSkillQueue(
  entries: readonly { readonly typeID: number; readonly toLevel: number }[],
  options: ApiOptions = {},
): Promise<SkillsResult> {
  const body: JsonValue = entries.map((entry) => ({
    typeID: entry.typeID,
    toLevel: entry.toLevel,
  }));
  return readSkills(await postJson("/api/bridge/skills/queue", { entries: body }, options));
}


// --- R41 Planets: the character's colonies ------------------------------------
//
// ONE read and no write. This is not a bridge `callMethod` — the BFF answers it
// from the gateway's owner-scoped snapshot, so it costs the deny-by-default
// allowlist nothing. See src/server.js for why the planetMgr reads that would
// have needed allowlisting were declined.

/** The whole Planets panel in one read, decoded by bridge/planets.ts. */
export interface PlanetsResult {
  /** Raw colony rows; every id in them is for an icon, never for display. */
  readonly planets: JsonValue;
}

export async function getPlanets(options: ApiOptions = {}): Promise<PlanetsResult> {
  const data = await getJson("/api/bridge/planets", options);
  return { planets: data as JsonValue };
}

/** The planetary production recipes, decoded by bridge/piRecipes.ts. */
export interface PiSchematicsResult {
  /** The whole recipe table; ids in it are for lookups, never for display. */
  readonly recipes: JsonValue;
}

/**
 * Every planetary production recipe (goal R108 slice 1).
 *
 * ⚠ NOT A BRIDGE CALL. Like resolveNames and loadBaseCycleTimes this is static
 * reference data the BFF already has on disk: no gateway round trip, no held
 * session, nothing about the player in the question or the answer. It is the
 * same table for everyone, so a caller may read it once and keep it.
 */
export async function getPiSchematics(options: ApiOptions = {}): Promise<PiSchematicsResult> {
  const data = await getJson("/api/pi/schematics", options);
  return { recipes: data as JsonValue };
}

/**
 * Every recipe reachable from these products, for the Industry Manager's build
 * tree (goal R109). Decoded by bridge/industryRecipes.ts.
 *
 * NOT A BRIDGE CALL: static reference data, the same for everyone, answered
 * without a gateway round trip or a held session.
 */
export async function getIndustryRecipeClosure(
  productTypeIDs: readonly number[],
  options: ApiOptions = {},
): Promise<JsonValue> {
  const data = await postJson("/api/industry/recipe-closure", { productTypeIDs: [...productTypeIDs] }, options);
  return data as JsonValue;
}

/** What invention odds are made of: the lower-rate skills and every decryptor (R109 slice 6). Static. */
export async function getIndustryInventionTerms(options: ApiOptions = {}): Promise<JsonValue> {
  return (await getJson("/api/industry/invention-terms", options)) as JsonValue;
}

/** Published blueprints and reaction formulas by name (goal R109). Static. */
export async function searchIndustryBlueprints(query: string, options: ApiOptions = {}): Promise<JsonValue> {
  const data = await getJson(`/api/industry/blueprints/search?q=${encodeURIComponent(query)}&limit=25`, options);
  return data as JsonValue;
}

// --- Pilot Training: account-owned read-only qualification -------------------

/** Existing accounts only; no cookie/global-token change and no pilot selection. */
export async function loginFactoryAccount(username: string, options: ApiOptions = {}, password?: string): Promise<{ account: string; token: string }> {
  const data = await postJson("/api/pilot-training/login", { username, ...(password === undefined ? {} : { password }) }, { ...options, token: null });
  const account = data.account as { username?: unknown } | null;
  if (typeof data.sessionToken !== "string" || !data.sessionToken || typeof account?.username !== "string") {
    throw new BridgeCallError("BRIDGE_BAD_RESPONSE", "Account authentication is incomplete.", 502);
  }
  return { account: account.username, token: data.sessionToken };
}
export interface TrainingAccountOutcome { status: "ACCOUNT_CREATED" | "ACCOUNT_RECOVERED" | "ACCOUNT_CONFIRMED" | "RECOVERY_REQUIRED"; account: { username: string; accountID: number } | null; message?: string }
export async function trainingAccount(action: "create" | "recover", username: string, options: ApiOptions = {}): Promise<TrainingAccountOutcome> {
  return await postJson(`/api/pilot-training/accounts/${action}`, { username, ...(action === "create" ? { confirm: true } : {}) }, { ...options, token: null }) as unknown as TrainingAccountOutcome;
}

export async function reviewSkillAcquisition(body: unknown, options: ApiOptions = {}): Promise<import("../training/types.ts").AcquisitionReview> {
  return (await postJson("/api/pilot-training/skills/review", body, options)).outcome as unknown as import("../training/types.ts").AcquisitionReview;
}
export async function acquireFactorySkills(reviewID: string, funding: import("../training/types.ts").FactoryFunding | null, options: ApiOptions = {}): Promise<import("../training/types.ts").AcquisitionOutcome> {
  return (await postJson("/api/pilot-training/skills/acquire", { reviewID, funding, confirm: true }, options)).outcome as unknown as import("../training/types.ts").AcquisitionOutcome;
}
export async function trainingOnboarding(action: "review" | "apply", body: unknown, options: ApiOptions): Promise<Record<string, any>> {
  return (await postJson(`/api/pilot-training/onboarding/${action}`, body, options)).outcome as Record<string, any>;
}
export async function resolveTrainingHome(locationID: number, options: ApiOptions, characterID?: number): Promise<import("../training/settings.ts").TrainingSettings["home"]> {
  return (await getJson(`/api/pilot-training/home?locationID=${locationID}${characterID ? `&characterID=${characterID}` : ""}`, options)).home as unknown as import("../training/settings.ts").TrainingSettings["home"];
}
export async function loadTrainingSettingsContext(options: ApiOptions): Promise<import("../training/settings.ts").TrainingSettingsContext> {
  return await getJson("/api/pilot-training/settings-context", options) as unknown as import("../training/settings.ts").TrainingSettingsContext;
}
export async function searchTrainingHomes(query: string, options: ApiOptions, characterID?: number): Promise<{ matches: import("../training/settings.ts").TrainingHomeMatch[]; capped: boolean; structureWarning: string | null }> {
  const data = await getJson(`/api/pilot-training/homes?q=${encodeURIComponent(query)}${characterID ? `&characterID=${characterID}` : ""}`, options);
  if (!Array.isArray(data.matches)) throw new Error("Training Home search is unreadable.");
  const matches = data.matches.map(asMapLocation).filter(row =>
    (row.kind === "station" || row.kind === "structure") && row.id > 0 && !!row.name && row.solarSystemID !== null);
  return { matches: matches as import("../training/settings.ts").TrainingHomeMatch[], capped: data.capped === true,
    structureWarning: typeof data.structureWarning === "string" ? data.structureWarning : null };
}

export async function factoryOwnership(characterID: number, options: ApiOptions = {}): Promise<{ owner: string; online: boolean }> {
  return (await getJson(`/api/pilot-training/ownership?characterID=${characterID}`, options)).ownership as unknown as { owner: string; online: boolean };
}

/** Account-owned identities for a read-only training preview; no selection. */
export async function loadTrainingCharacters(options: ApiOptions = {}): Promise<{
  readonly account: string;
  readonly characters: readonly TrainingCharacter[];
}> {
  const data = await getJson("/api/pilot-training/characters", options);
  if (typeof data.account !== "string" || !Array.isArray(data.characters)) {
    throw new BridgeCallError("BRIDGE_BAD_RESPONSE", "Training roster is incomplete.", 502);
  }
  const characters = data.characters as unknown as TrainingCharacter[];
  if (characters.some((character) => !Number.isSafeInteger(character.characterID) ||
      character.characterID <= 0 || typeof character.name !== "string")) {
    throw new BridgeCallError("BRIDGE_BAD_RESPONSE", "Training roster is incomplete.", 502);
  }
  return { account: data.account, characters };
}

/** Gateway-owned skills plus static EveJS prerequisite closure, without a held session. */
export async function loadMinerTraining(
  characterID: number,
  selections: Readonly<Record<string, StageFittingSelection>> = {},
  options: ApiOptions = {},
  targetStage: string | null = null,
): Promise<MinerTrainingRead> {
  const query = new URLSearchParams({ characterID: String(characterID), selections: JSON.stringify(selections) });
  if (targetStage) query.set("targetStage", targetStage);
  const data = await getJson(`/api/pilot-training/miner?${query}`, options);
  const report = data.report as unknown as MinerTrainingRead["report"] | null;
  if (!report || report.role !== "MINER" || !Array.isArray(report.stages) ||
      !report.previews || report.pilot?.characterID !== characterID ||
      !Number.isSafeInteger(data.corporationID) || !Array.isArray(data.fittings)) {
    throw new BridgeCallError("BRIDGE_BAD_RESPONSE", "Training qualification read is incomplete.", 502);
  }
  return { report, corporationID: data.corporationID as number,
    queue: data.queue as unknown as MinerTrainingRead["queue"],
    fittings: data.fittings as unknown as MinerTrainingRead["fittings"] };
}

export async function loadQualification(characterID: number, role: string,
  configurations: readonly import("../training/configurations.ts").TrainingConfiguration[], options: ApiOptions,
  targetConfigurationID: string | null, equipmentSource: import("../training/types.ts").TrainingEquipmentSource = { kind: "hangar" }): Promise<MinerTrainingRead> {
  const query = new URLSearchParams({ characterID: String(characterID), role, configurations: JSON.stringify(configurations) });
  query.set("equipmentSource", JSON.stringify(equipmentSource));
  if (targetConfigurationID) query.set("targetConfigurationID", targetConfigurationID);
  const data = await getJson(`/api/pilot-training/qualification?${query}`, options);
  const report = data.report as unknown as MinerTrainingRead["report"];
  if (!report || report.role !== role || report.pilot?.characterID !== characterID || !Array.isArray(report.stages) ||
    !Array.isArray(data.fittings) || !Number.isSafeInteger(data.corporationID)) throw new BridgeCallError("BRIDGE_BAD_RESPONSE", "Qualification read is incomplete.", 502);
  return { report, corporationID: data.corporationID as number, fittings: data.fittings as unknown as MinerTrainingRead["fittings"], queue: data.queue as unknown as MinerTrainingRead["queue"] };
}

export async function reviewTrainingEquipment(request: { characterID: number; role: string; configurationID: string;
  configurations: readonly import("../training/configurations.ts").TrainingConfiguration[]; targetStage: string | null; source: import("../training/types.ts").TrainingEquipmentSource }, options: ApiOptions): Promise<import("../training/types.ts").TrainingEquipmentReview> {
  const data = await postJson("/api/pilot-training/equipment/review", request, options);
  const review = data.review as unknown as import("../training/types.ts").TrainingEquipmentReview;
  if (!review?.applyReview || review.fresh?.report.pilot.characterID !== request.characterID) throw new BridgeCallError("BRIDGE_BAD_RESPONSE", "Equipment plan is unreadable.", 502);
  return review;
}
export async function applyTrainingEquipment(reviewID: string, reviewHash: string, options: ApiOptions): Promise<import("../provisioning/centerClient.ts").ApplyOutcome> {
  const data = await postJson("/api/pilot-training/equipment/apply", { reviewID, reviewHash, confirm: true }, options);
  return data.outcome as unknown as import("../provisioning/centerClient.ts").ApplyOutcome;
}
export async function recoverTrainingEquipment(operationID: string, options: ApiOptions): Promise<import("../provisioning/centerClient.ts").ApplyOutcome> {
  const data = await postJson("/api/pilot-training/equipment/recover", { operationID }, options);
  return data.outcome as unknown as import("../provisioning/centerClient.ts").ApplyOutcome;
}

export async function reviewTrainingQueue(
  request: { characterID: number; role: string; configurations?: readonly import("../training/configurations.ts").TrainingConfiguration[]; mode: "FAST" | "BALANCED" | "MASTERY";
    stage: string | null; targetStage?: string | null; displayedTargets: readonly { typeID: number; level: number }[];
    selections: Readonly<Record<string, StageFittingSelection>> }, options: ApiOptions,
): Promise<QueueReview> {
  const data = await postJson("/api/pilot-training/queue/review", request, options);
  const review = data.review as unknown as QueueReview;
  if (!review || !Array.isArray(review.additions) || !Array.isArray(review.blockers) || review.fresh?.report?.pilot?.characterID !== request.characterID)
    throw new BridgeCallError("BRIDGE_BAD_RESPONSE", "Queue review is incomplete.", 502);
  return review;
}

export async function applyTrainingQueue(reviewID: string, options: ApiOptions): Promise<QueueApplyOutcome> {
  const data = await postJson("/api/pilot-training/queue/apply", { reviewID, confirm: true }, options);
  const outcome = data.outcome as unknown as QueueApplyOutcome;
  if (!outcome || !["APPLIED", "REFUSED", "APPLY_UNVERIFIED"].includes(outcome.status) || typeof outcome.verified !== "boolean")
    throw new BridgeCallError("BRIDGE_BAD_RESPONSE", "Apply outcome is unreadable; refresh the queue before reviewing again.", 502);
  return outcome;
}
/** Read this exact hosted bot's stored Mining Operation assignment. No space read. */
export async function readMiningOperationAssignment(
  options: ApiOptions = {},
): Promise<MiningOperationAssignment | null> {
  const data = await getJson("/api/mining-operations/assignment/current", options);
  const value = data.assignment;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as unknown as MiningOperationAssignment)
    : null;
}

export async function readMiningOperationSupportContext(options: ApiOptions = {}): Promise<{
  assignment: MiningOperationAssignment | null; fleets: readonly import("../nav/miningSupportFleet.ts").MiningSupportFleetObservation[];
}> {
  const data = await getJson("/api/mining-operations/support-context", options);
  if (!Array.isArray(data.fleets)) throw new Error("Operation fleet observations are unreadable.");
  return { assignment: data.assignment as unknown as MiningOperationAssignment | null,
    fleets: data.fleets as unknown as import("../nav/miningSupportFleet.ts").MiningSupportFleetObservation[] };
}
export async function reportMiningOperationSupport(value: { state: "READY" | "DEGRADED" | "RECOVERY" | "BLOCKED";
  core: "active" | "inactive" | "unknown"; reason: string | null; collection: string | null }, options: ApiOptions = {}): Promise<void> {
  await postJson("/api/mining-operations/support-status", value, options);
}
export async function stopMiningOperationForSupport(options: ApiOptions = {}, reason?: "emergency-health-floor"): Promise<void> {
  await postJson("/api/mining-operations/support-stop", reason ? { reason } : {}, options);
}
export async function releaseMiningSupportAnchor(options: ApiOptions = {}): Promise<void> {
  await postJson("/api/bots/mining-support-anchors/release", {}, options);
}

export interface MiningTargetCandidate {
  readonly candidates?: readonly MiningTargetCandidate[];
  readonly siteIdentity?: string;
  readonly siteID?: number;
  readonly instanceID?: number | null;
  readonly position?: import("../store/types.ts").SpaceVector;
  readonly targetType: MiningTargetType;
  readonly systemID: number;
  readonly systemName: string;
  readonly targetName: string;
}

export async function reserveMiningOperationTarget(
  candidate: MiningTargetCandidate,
  options: ApiOptions = {},
): Promise<boolean> {
  const data = await postJson(
    "/api/mining-operations/target/reserve",
    candidate as unknown as JsonValue,
    options,
  );
  return data.acquired === true;
}

export async function activateMiningOperationTarget(targetKey: string, options: ApiOptions = {}): Promise<void> {
  await postJson("/api/mining-operations/target/activate", { targetKey }, options);
}

export async function depleteMiningOperationTarget(
  targetKey: string,
  evidence: Readonly<Record<string, JsonValue>> = {},
  options: ApiOptions = {},
): Promise<void> {
  await postJson("/api/mining-operations/target/depleted", { targetKey, evidence }, options);
}

export async function markMiningOperationMemberReady(options: ApiOptions = {}): Promise<void> {
  await postJson("/api/mining-operations/member/ready", {}, options);
}

export async function finishMiningOperationDrain(targetKey: string, options: ApiOptions = {}): Promise<void> {
  await postJson("/api/mining-operations/member/drain-complete", { targetKey }, options);
}

export interface MiningOperationMemberDefinition {
  readonly preparation?: import("./miningPreparation.ts").MiningPreparationFitting;
  readonly characterID: number;
  readonly characterName: string;
  readonly accountName: string;
  readonly role: "MINER" | "HAULER" | "DEFENDER" | "COMMAND";
  readonly routineMode?: "STANDARD" | "CUSTOM";
  readonly automationID: string;
}

export interface MiningOperationDefinition {
  readonly preparation?: import("./miningPreparation.ts").MiningPreparationConfig;
  readonly support?: import("../nav/scriptConditions.ts").MiningSupportOptions;
  readonly policies?: {
    readonly version: 1;
    readonly parking: {
      readonly mode: "STAY_IN_PLACE" | "RETURN_HOME_DOCK" | "RETURN_HOME_UNLOAD_DOCK";
      readonly destination: { readonly stationID: number; readonly stationName: string; readonly systemName: string; readonly kind?: "station" } |
        import("../nav/dockableLocation.ts").DockableLocation | null;
      readonly corporationDivision: number | null;
      readonly corporationID?: number | null;
    };
    readonly travelAssist?: { readonly mode: "DISABLED" | "AUTO" };
    readonly resourceTarget?: { readonly mode: "ANY_ELIGIBLE" };
    readonly resourcePolicy?: import("../nav/resourcePriority.ts").ResourcePolicy;
    readonly scouting?: { readonly mode: "DISABLED" };
    readonly defense?: { readonly mode: "EXISTING_SELF_DEFENSE" };
  };
  readonly operationID?: string;
  readonly name: string;
  readonly area: {
    readonly anchorSystemID: number;
    readonly anchorSystemName: string | null;
    readonly reach: "CURRENT_SYSTEM" | "CURRENT_AND_ADJACENT";
    readonly targetClasses: readonly MiningTargetType[];
  };
  readonly targetPolicy: "ANY_ELIGIBLE";
  readonly unloadPolicy: "HAULER_SERVICE" | "SELF_UNLOAD";
  readonly unloadDestination?: {
    readonly stationID: number;
    readonly stationName: string;
    readonly systemName?: string;
    readonly corporationDivision: number | null;
    readonly corporationID?: number | null;
  } | {
    readonly kind: "structure";
    readonly id: number;
    readonly name: string;
    readonly solarSystemID: number;
    readonly solarSystemName: string | null;
    readonly corporationDivision: number | null;
    readonly corporationID?: number | null;
  } | null;
  readonly members: readonly MiningOperationMemberDefinition[];
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface MiningOperationRuntime {
  readonly operationRunID?: string | null;
  readonly preparation?: import("./miningPreparation.ts").MiningPreparationProjection;
  readonly operationID: string;
  readonly state: string;
  readonly statusReason?: string | null;
  readonly observedAt?: string;
  readonly recoveryRequired?: boolean;
  readonly currentTarget: MiningOperationTarget | null;
  readonly members: readonly (MiningOperationMemberDefinition & {
    readonly preparation?: import("./miningPreparation.ts").MiningMemberPreparation;
    readonly runtimeState: string;
    readonly phase: string | null;
    readonly reason: string | null;
    readonly failureCode?: string | null;
    readonly parkingState?: string | null;
    readonly botID: string | null;
    readonly expiresAt?: string | null;
    readonly maxRuntimeMinutes?: number | null;
    readonly hosted?: boolean;
    readonly hostStartedAt?: string | null;
    readonly hostResumedAt?: string | null;
    readonly lastHostReason?: string | null;
  })[];
  readonly logisticsTail: readonly {
    readonly target: MiningOperationTarget;
    readonly pendingHaulers: readonly number[];
  }[];
  readonly rendezvous: {
    readonly kind: "MINER_CLEARANCE" | "SELF_UNLOAD";
    readonly target: MiningOperationTarget;
    readonly required: readonly number[];
    readonly ready: readonly number[];
  } | null;
  readonly history: readonly {
    readonly kind: string;
    readonly at: string;
    readonly target: MiningOperationTarget | null;
    readonly evidence: unknown;
  }[];
  readonly startedAt: string | null;
  readonly stoppedAt: string | null;
  readonly stopFailures: readonly { readonly characterID: number; readonly message: string }[];
}

export interface MiningOperationsPayload {
  readonly results?: readonly { readonly characterID: number; readonly ok: boolean; readonly error?: string; readonly message?: string }[];
  readonly operations: readonly {
    readonly definition: MiningOperationDefinition & { readonly operationID: string };
    readonly runtime: MiningOperationRuntime;
  }[];
  readonly targetBoard: readonly MiningOperationTarget[];
  readonly capabilities: {
    readonly hostedRunPolicy?: import("../bots/hostedRunPolicy.ts").HostedRunPolicy;
    readonly targetClasses: Readonly<Record<MiningTargetType, { readonly executable: boolean; readonly note: string }>>;
    readonly reach: Readonly<Record<string, { readonly executable: boolean; readonly note?: string }>>;
    readonly defender: { readonly executable: boolean; readonly note: string };
    readonly operationOwnedContainers: { readonly executable: boolean; readonly note: string };
  };
}

function miningOperationsPayload(data: Record<string, JsonValue>): MiningOperationsPayload {
  return {
    ...(Array.isArray(data.results) ? { results: data.results as unknown as NonNullable<MiningOperationsPayload["results"]> } : {}),
    operations: (Array.isArray(data.operations) ? data.operations : []) as unknown as MiningOperationsPayload["operations"],
    targetBoard: (Array.isArray(data.targetBoard) ? data.targetBoard : []) as unknown as MiningOperationsPayload["targetBoard"],
    capabilities: (data.capabilities && typeof data.capabilities === "object" && !Array.isArray(data.capabilities)
      ? data.capabilities
      : { targetClasses: {}, reach: {}, defender: {}, operationOwnedContainers: {} }) as unknown as MiningOperationsPayload["capabilities"],
  };
}

/** Command Center read: definitions, botHost projection and target board only. */
export async function loadMiningOperations(options: ApiOptions = {}): Promise<MiningOperationsPayload> {
  return miningOperationsPayload(await getJson("/api/mining-operations", options));
}

export interface MiningResourceChoice { readonly typeID: number; readonly name: string; readonly family: "ore" | "ice"; }
export async function listMiningResources(options: ApiOptions = {}): Promise<readonly MiningResourceChoice[]> {
  const data = await getJson("/api/mining-operations/resources", options);
  return (data.resources ?? []) as unknown as readonly MiningResourceChoice[];
}

export async function extendMiningOperation(operationID: string, minutes: number, options: ApiOptions = {}): Promise<{ payload: MiningOperationsPayload; extension: { ok: boolean; message?: string; results?: { characterID: number; ok: boolean; error?: string; message?: string }[] } }> {
  const data = await postJson(`/api/mining-operations/${encodeURIComponent(operationID)}/extend`, { minutes }, options);
  return { payload: miningOperationsPayload(data), extension: data.extension as unknown as { ok: boolean; message?: string; results?: { characterID: number; ok: boolean; error?: string; message?: string }[] } };
}

export interface OperationRoutineSummary {
  readonly scriptID: string;
  readonly name: string;
  readonly rev: number;
  readonly roles: Readonly<Record<"MINER" | "HAULER" | "DEFENDER", { readonly compatible: boolean; readonly reason: string | null }>>;
}

export async function listOperationRoutines(
  classes: readonly MiningTargetType[],
  unloadPolicy: "HAULER_SERVICE" | "SELF_UNLOAD",
  options: ApiOptions = {},
): Promise<OperationRoutineSummary[]> {
  const params = new URLSearchParams({ classes: classes.join(","), unloadPolicy });
  const data = await getJson(`/api/mining-operations/routines?${params}`, options);
  return (Array.isArray(data.routines) ? data.routines : []) as unknown as OperationRoutineSummary[];
}

export interface OperationLaunchPlanMember {
  readonly characterID: number;
  readonly routineMode: "STANDARD" | "CUSTOM";
  readonly script: { readonly scriptID: string; readonly name: string; readonly rev: number; readonly doc: JsonValue };
}

export interface MiningOperationLaunchPlan {
  readonly planHash: string; readonly warnings: readonly string[]; readonly members: readonly OperationLaunchPlanMember[];
  readonly preparation?: import("./miningPreparation.ts").MiningPreparationProjection;
}
export async function getMiningOperationLaunchPlan(operationID: string, options: ApiOptions = {}): Promise<MiningOperationLaunchPlan> {
  const data = await getJson(`/api/mining-operations/${encodeURIComponent(operationID)}/launch-plan`, options);
  return { planHash: typeof data.planHash === "string" ? data.planHash : "",
    warnings: (Array.isArray(data.warnings) ? data.warnings : []).filter((row): row is string => typeof row === "string"),
    members: (Array.isArray(data.members) ? data.members : []) as unknown as OperationLaunchPlanMember[],
    ...(data.preparation && typeof data.preparation === "object" ? { preparation: data.preparation as unknown as import("./miningPreparation.ts").MiningPreparationProjection } : {}) };
}

/** Account-owned fitting observation only; never selects or acquires a pilot. */
export async function getMiningPreparationOptions(accountName: string, characterID: number, providerCharacterID: number | null = null,
  options: ApiOptions = {}): Promise<import("./miningPreparation.ts").MiningPreparationOptions> {
  const query = new URLSearchParams({ accountName, characterID: String(characterID), ...(providerCharacterID ? { providerCharacterID: String(providerCharacterID) } : {}) });
  return await getJson(`/api/mining-operations/preparation-options?${query}`, options) as unknown as import("./miningPreparation.ts").MiningPreparationOptions;
}

export interface OperationPilotChoice {
  readonly accountName: string;
  readonly characterID: number;
  readonly characterName: string;
}

export async function listOperationAccountPilots(accountName: string, options: ApiOptions = {}): Promise<OperationPilotChoice[]> {
  const data = await getJson(`/api/mining-operations/accounts/${encodeURIComponent(accountName)}/pilots`, options);
  return (Array.isArray(data.pilots) ? data.pilots : []) as unknown as OperationPilotChoice[];
}

export async function saveMiningOperation(
  definition: MiningOperationDefinition,
  options: ApiOptions = {},
): Promise<MiningOperationsPayload> {
  return miningOperationsPayload(await postJson("/api/mining-operations", definition as unknown as JsonValue, options));
}

export async function deleteMiningOperation(operationID: string, options: ApiOptions = {}): Promise<MiningOperationsPayload> {
  return miningOperationsPayload(await postJson(`/api/mining-operations/${encodeURIComponent(operationID)}/delete`, {}, options));
}

export async function startMiningOperation(
  operationID: string,
  grants: Readonly<Record<string, BotLaunchGrant>>,
  planHash: string | null = null,
  options: ApiOptions = {},
): Promise<MiningOperationsPayload> {
  return miningOperationsPayload(await postJson(
    `/api/mining-operations/${encodeURIComponent(operationID)}/start`,
    { grants: grants as unknown as JsonValue, planHash },
    options,
  ));
}

export async function stopMiningOperation(operationID: string, options: ApiOptions = {}): Promise<MiningOperationsPayload> {
  return miningOperationsPayload(await postJson(`/api/mining-operations/${encodeURIComponent(operationID)}/stop`, {}, options));
}

/** The public gateway's answer to one of the client's eve_public requests: its status and its payload, decoded. */
export interface PublicGatewayAnswer {
  readonly statusCode: number;
  readonly statusMessage: string;
  readonly typeName: string | null;
  readonly payload: JsonValue | null;
}

/**
 * One of the client's eve_public requests made on the public gateway for the page's pilot (the BFF's
 * POST /api/public-gateway/request), as its client makes it; a write with confirm said.
 */
export async function publicGatewayRequest(request: string, payload: Record<string, JsonValue>, options: ApiOptions & { confirm?: boolean } = {}): Promise<PublicGatewayAnswer> {
  const data = await postJson("/api/public-gateway/request", { request, payload, ...(options.confirm ? { confirm: true } : {}) }, options);
  return {
    statusCode: typeof data.statusCode === "number" ? data.statusCode : 0,
    statusMessage: typeof data.statusMessage === "string" ? data.statusMessage : "",
    typeName: typeof data.typeName === "string" ? data.typeName : null,
    payload: data.payload ?? null,
  };
}

/** A skill type as the server's static data has it (GET /api/static/skill-catalogue). */
export interface CatalogueSkill {
  readonly typeID: number;
  readonly name: string;
  readonly groupID: number;
  readonly groupName: string;
  readonly published: boolean;
}

/** Every skill type, for the skill plan editor's catalogue. */
export async function getSkillCatalogue(options: ApiOptions = {}): Promise<readonly CatalogueSkill[]> {
  const data = await getJson("/api/static/skill-catalogue", options);
  const skills = Array.isArray(data.skills) ? data.skills : [];
  return skills.flatMap((raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
    const row = raw as Record<string, JsonValue>;
    const typeID = Number(row.typeID);
    if (!Number.isSafeInteger(typeID) || typeID <= 0) return [];
    return [{
      typeID,
      name: typeof row.name === "string" ? row.name : "",
      groupID: Number(row.groupID) || 0,
      groupName: typeof row.groupName === "string" ? row.groupName : "",
      published: row.published === true,
    }];
  });
}

/**
 * The skills that need each of these skills at each level (skillPlanUtil.GetSkillsRequiring, the client's
 * requiredSkillsIndex): skill to level to the skills. `available` is false where the client's table could not be read.
 */
export async function getSkillsRequiring(typeIDs: readonly number[], options: ApiOptions = {}): Promise<{
  readonly available: boolean;
  readonly requiring: ReadonlyMap<number, ReadonlyMap<number, readonly number[]>>;
}> {
  const data = await getJson(`/api/client-data/skills-requiring?typeIDs=${typeIDs.join(",")}`, options);
  const raw = typeof data.requiring === "object" && data.requiring !== null && !Array.isArray(data.requiring) ? (data.requiring as Record<string, JsonValue>) : {};
  const requiring = new Map<number, ReadonlyMap<number, readonly number[]>>();
  for (const [typeKey, byLevel] of Object.entries(raw)) {
    const typeID = Number(typeKey);
    if (!Number.isSafeInteger(typeID) || typeof byLevel !== "object" || byLevel === null || Array.isArray(byLevel)) continue;
    const levels = new Map<number, readonly number[]>();
    for (const [levelKey, skills] of Object.entries(byLevel as Record<string, JsonValue>)) {
      if (Array.isArray(skills)) levels.set(Number(levelKey), skills.map(Number).filter((skill) => Number.isSafeInteger(skill)));
    }
    requiring.set(typeID, levels);
  }
  return { available: data.available === true, requiring };
}

/** The certified skill plans and the career paths, from the client's own data (GET /api/client-data/certified-skill-plans). */
export async function getCertifiedSkillPlans(options: ApiOptions = {}): Promise<{
  readonly available: boolean;
  readonly plans: readonly import("../bridge/certifiedSkillPlans.ts").CertifiedPlanData[];
  readonly careerPaths: readonly import("../bridge/certifiedSkillPlans.ts").CareerPath[];
}> {
  const data = await getJson("/api/client-data/certified-skill-plans", options);
  const num = (value: JsonValue | undefined): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const plans = (Array.isArray(data.plans) ? data.plans : []).flatMap((raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
    const row = raw as Record<string, JsonValue>;
    const planID = num(row.planID);
    if (planID === null) return [];
    return [{
      planID,
      nameID: num(row.nameID),
      descriptionID: num(row.descriptionID),
      careerPathID: num(row.careerPathID),
      factionID: num(row.factionID),
      npcCorporationDivision: num(row.npcCorporationDivision),
      requirements: (Array.isArray(row.requirements) ? row.requirements : []).flatMap((pair) =>
        Array.isArray(pair) && typeof pair[0] === "number" && typeof pair[1] === "number" ? [[pair[0], pair[1]] as const] : []),
      milestones: (Array.isArray(row.milestones) ? row.milestones : []).flatMap((m) => {
        if (typeof m !== "object" || m === null || Array.isArray(m)) return [];
        const typeID = num((m as Record<string, JsonValue>).typeID);
        return typeID === null ? [] : [{ typeID, level: num((m as Record<string, JsonValue>).level) }];
      }),
    }];
  });
  const careerPaths = (Array.isArray(data.careerPaths) ? data.careerPaths : []).flatMap((raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
    const row = raw as Record<string, JsonValue>;
    const careerPathID = num(row.careerPathID);
    return careerPathID === null ? [] : [{ careerPathID, nameID: num(row.nameID), descriptionID: num(row.descriptionID) }];
  });
  return { available: data.available === true, plans, careerPaths };
}
