// Client-state store skeleton (goal R1b, roadmap section 5).
//
// One store is the single source of truth mirroring the relevant EveJS
// session/character state in the browser. The UI pages and, later, the
// browser autopilot loop are *pure readers*: they read via `get()` or the
// per-slice signals and subscribe for changes; they never write slices
// directly. State enters through `apply(event)` — normally called by the
// feed adapter attached with `attachFeed` (see feed.ts), which hides whether
// the events came from the legacy WS stream or from bridge-forwarded session
// notifications.
//
// R1b ships the session/character skeleton. Further slices (inventory,
// journal, space, ...) arrive with their pages on the R2-R6 rail.

import {
  createSignal,
  readonlySignal,
  type ReadableSignal,
  type Unsubscribe,
} from "./signals.ts";
import type { FeedAdapter, FeedEvent, FeedSink, FeedStatus, HealthStatus } from "./feed.ts";
import { MAX_BROADCAST_HISTORY } from "../bridge/fleetBroadcasts.ts";
// R43 — the bot registry owns the BotID union and what "holding the ship"
// means, so the store and flow.ts can never disagree about either.
import {
  SHIP_CONTROLLER_IDS,
  holdsTheShip,
  type ShipControllerID,
} from "../nav/botRegistry.ts";
import type {
  ActivityState,
  AgentFinderState,
  BotsState,
  AgentsState,
  ChatChannelState,
  ChatState,
  CharacterSummary,
  FlightState,
  FleetCenterState,
  ScannerCenterState,
  FittingResources,
  FittingSlot,
  FittingState,
  ModuleReload,
  DogmaState,
  IndustryBlueprintRow,
  IndustryDefinition,
  IndustryFacilityRow,
  IndustryJobRow,
  IndustrySlotUsage,
  IndustryState,
  MarketActionOutcome,
  MarketEscrow,
  MarketOrderRow,
  MarketOwnOrderRow,
  MarketPriceHistoryRow,
  MarketState,
  MailActionOutcome,
  MailHeaderRow,
  MailOpenMessage,
  MailState,
  MailStatusRow,
  ContractDetail,
  ContractRow,
  ContractSummary,
  ContractsState,
  AssetStationContents,
  AssetStationRow,
  PersonalAssetsState,
  MarketTransactionRow,
  InventoryContainerState,
  CorpHangarState,
  InventoryState,
  LiveState,
  OnlineCharacterState,
  RewardsState,
  AddressBookState,
  GateLink,
  SpaceState,
  DamageEvent,
  ModuleCycle,
  TargetingState,
  DronesState,
  DroneOrderReport,
  MiningState,
  MiningHold,
  SurveyResult,
  ReprocessingQuote,
  StationGuest,
  StationOffices,
  StationServiceBits,
  StationStatic,
  CustomBotState,
  MiningBotState,
  FleetCompanionState,
  MissionBotState,
  SkillsState,
  PlanetsState,
  TravelState,
  WalletState,
  StandingsState,
  CharacterSheetState,
} from "./types.ts";
import type { NamesState, WordsState } from "./names.ts";
import type { CloneGrade } from "../bridge/cloneGrade.ts";
import { deriveShipStats } from "../bridge/shipStats.ts";
import { applyJamEvent, type ActiveJam } from "../bridge/jamNotifications.ts";
import { EMPTY_RECIPE_BOOK } from "../bridge/piRecipes.ts";
import { applyTargetEvent, applyTargeterEvent } from "../bridge/targetNotifications.ts";
import { applyChargeQuantityChanges } from "../bridge/reloadNotifications.ts";

// --- Typed state slices ----------------------------------------------------

/** Who is logged in to the web BFF (which pins bridge session identity). */
export interface SessionSlice {
  readonly phase: "logged-out" | "logged-in";
  readonly accountID: number | null;
  readonly username: string | null;
  /** R2: true when THIS login auto-created the account on the server. */
  readonly accountCreated: boolean;
}

/** Character context: the account's characters and the selected one. */
export interface CharacterSlice {
  readonly selectedCharacterID: number | null;
  readonly characters: readonly CharacterSummary[];
}

/**
 * The docked station panel (goal R2): who is online on the persistent
 * browser-backed session and what the docked-entry reads returned.
 */
export interface StationSlice {
  readonly online: OnlineCharacterState | null;
  readonly station: StationStatic | null;
  readonly bits: StationServiceBits | null;
  /** Access-scoped, online structure services; null means unreadable. */
  readonly structureServiceIDs: readonly number[] | null;
  readonly guests: readonly StationGuest[];
  /** The lobby's offices here; null until the player has them listed, and again in another station. */
  readonly offices: StationOffices | null;
  /** The account's clone grade (0 an alpha clone's, 1 an omega's); null until read, and where it cannot be. */
  readonly cloneGrade: CloneGrade | null;
  /**
   * The pilot's own security status as crimewatchSvc keeps it (GetMySecurityStatus, 590 to 593: asked once, where
   * something wants it; OnSecurityStatusUpdate from then on). null until asked.
   */
  readonly ownSecurityStatus: number | null;
  /** Non-null when the last docked-read refresh had a (non-fatal) failure. */
  readonly readError: string | null;
}

/** Which feed adapter is attached and its connectivity — not the transport itself. */
export interface FeedSlice {
  readonly adapter: string | null;
  readonly status: FeedStatus;
}

/** Server reachability from the boot health ping — gates the login screen. */
export interface HealthSlice {
  readonly status: HealthStatus;
}

export interface ClientState {
  readonly session: SessionSlice;
  readonly character: CharacterSlice;
  readonly station: StationSlice;
  readonly inventory: InventoryState;
  readonly fitting: FittingState;
  readonly dogma: DogmaState;
  readonly industry: IndustryState;
  readonly market: MarketState;
  readonly mail: MailState;
  readonly activity: ActivityState;
  readonly fleet: FleetCenterState;
  readonly scanner: ScannerCenterState;
  readonly contracts: ContractsState;
  readonly assets: PersonalAssetsState;
  readonly agents: AgentsState;
  readonly finder: AgentFinderState;
  readonly rewards: RewardsState;
  readonly addressBook: AddressBookState;
  readonly wallet: WalletState;
  readonly standings: StandingsState;
  readonly characterSheet: CharacterSheetState;
  readonly flight: FlightState;
  readonly space: SpaceState;
  readonly targeting: TargetingState;
  readonly mining: MiningState;
  readonly drones: DronesState;
  readonly skills: SkillsState;
  readonly planets: PlanetsState;
  readonly travel: TravelState;
  readonly bot: MiningBotState;
  readonly missionBot: MissionBotState;
  readonly companion: FleetCompanionState;
  readonly customBot: CustomBotState;
  readonly bots: BotsState;
  readonly chat: ChatState;
  readonly live: LiveState;
  readonly names: NamesState;
  readonly words: WordsState;
  readonly feed: FeedSlice;
  readonly health: HealthSlice;
}

const INITIAL_SESSION: SessionSlice = Object.freeze({
  phase: "logged-out",
  accountID: null,
  username: null,
  accountCreated: false,
});

const INITIAL_CHARACTER: CharacterSlice = Object.freeze({
  selectedCharacterID: null,
  characters: Object.freeze([]) as readonly CharacterSummary[],
});

const INITIAL_STATION: StationSlice = Object.freeze({
  online: null,
  station: null,
  bits: null,
  structureServiceIDs: null,
  guests: Object.freeze([]) as readonly StationGuest[],
  offices: null,
  cloneGrade: null,
  ownSecurityStatus: null,
  readError: null,
});

const EMPTY_CONTAINER: InventoryContainerState = Object.freeze({
  rows: Object.freeze([]) as InventoryContainerState["rows"],
  capacity: null,
  error: null,
});

// A corporation hangar starts unavailable: most characters, most of the time,
// have no corp office at the station they are docked in, and that is an
// ordinary state rather than an error.
const EMPTY_CORP_HANGAR: CorpHangarState = Object.freeze({
  available: false,
  reason: null,
  divisions: Object.freeze([]),
  selectedDivision: 1,
  loaded: false,
});

const INITIAL_INVENTORY: InventoryState = Object.freeze({
  stationID: null,
  structureID: null,
  activeShipID: null,
  hangar: EMPTY_CONTAINER,
  cargo: EMPTY_CONTAINER,
  loaded: false,
  actionError: null,
  selection: Object.freeze([]),
  container: null,
  corp: EMPTY_CORP_HANGAR,
  lastOutcome: null,
  openShip: null,
});

// A resource reading with no total: `known: false` renders as an unknown bar
// rather than a misleading 0 / 0.
const UNKNOWN_RESOURCE = Object.freeze({ used: 0, total: 0, known: false });
const EMPTY_RESOURCES: FittingResources = Object.freeze({
  cpu: UNKNOWN_RESOURCE,
  powergrid: UNKNOWN_RESOURCE,
  capacitor: UNKNOWN_RESOURCE,
  calibration: UNKNOWN_RESOURCE,
});

const INITIAL_FITTING: FittingState = Object.freeze({
  activeShipID: null,
  // Empty before any read: "we cannot sort the ammo picker", never "nothing fits".
  chargeFits: Object.freeze({}),
  slots: Object.freeze([]) as readonly FittingSlot[],
  resources: EMPTY_RESOURCES,
  // Before any read, every statistic is honestly unavailable rather than zero
  // — deriving from an empty attribute map produces exactly that.
  stats: deriveShipStats(new Map()),
  dogma: null,
  loaded: false,
  slotsError: null,
  resourcesError: null,
  dogmaError: null,
  actionError: null,
  reloads: Object.freeze({}),
});

// R21 slice B — the bound-dogma snapshot. Empty until the Fitting window loads
// it; a failed read keeps its own error so the fit still shows.
const INITIAL_DOGMA: DogmaState = Object.freeze({
  allInfo: null,
  loaded: false,
  error: null,
});

const INITIAL_INDUSTRY: IndustryState = Object.freeze({
  ownerID: null,
  stationID: null,
  solarSystemID: null,
  blueprints: Object.freeze([]) as readonly IndustryBlueprintRow[],
  jobs: Object.freeze([]) as readonly IndustryJobRow[],
  facilities: Object.freeze([]) as readonly IndustryFacilityRow[],
  slotsUsed: Object.freeze({}) as IndustrySlotUsage,
  definitions: Object.freeze({}) as Readonly<Record<number, IndustryDefinition | null>>,
  loaded: false,
  blueprintsError: null,
  jobsError: null,
  facilitiesError: null,
  actionError: null,
  materialsSaid: null,
});

// R16 market. Every read is independent, so each keeps its own error: a public
// order book that fails to load must never hide the player's own orders.
const INITIAL_MARKET: MarketState = Object.freeze({
  typeID: null,
  stationID: null,
  structureID: null,
  solarSystemID: null,
  brokersFeeRate: null,
  sells: Object.freeze([]) as readonly MarketOrderRow[],
  buys: Object.freeze([]) as readonly MarketOrderRow[],
  ownOrders: Object.freeze([]) as readonly MarketOwnOrderRow[],
  orderHistory: Object.freeze([]) as readonly MarketOwnOrderRow[],
  transactions: Object.freeze([]) as readonly MarketTransactionRow[],
  escrow: null as MarketEscrow | null,
  priceHistory: Object.freeze([]) as readonly MarketPriceHistoryRow[],
  cashBalance: null,
  loaded: false,
  bookError: null,
  ownOrdersError: null,
  transactionsError: null,
  marketUnavailable: null,
  actionError: null,
  lastOutcome: null as MarketActionOutcome | null,
});

// R17 mail. The inbox arrives as a DELTA SYNC the BFF cold-starts, so
// `messages` is always the WHOLE mailbox — the browser holds no window across a
// page load and therefore never syncs against one.
const INITIAL_MAIL: MailState = Object.freeze({
  messages: Object.freeze([]) as readonly MailHeaderRow[],
  labels: null,
  lists: null,
  externalLists: Object.freeze([]),
  statuses: Object.freeze([]) as readonly MailStatusRow[],
  unreadCount: 0,
  open: null as MailOpenMessage | null,
  loaded: false,
  inboxError: null,
  actionError: null,
  lastOutcome: null as MailActionOutcome | null,
});

const INITIAL_ACTIVITY: ActivityState = Object.freeze({
  loaded: false,
  loading: false,
  notifications: Object.freeze({
    status: "unavailable",
    value: null,
    error: null,
  }) as ActivityState["notifications"],
  unprocessedCount: Object.freeze({
    status: "unavailable",
    value: null,
    error: null,
  }) as ActivityState["unprocessedCount"],
  calendarEvents: Object.freeze({
    status: "unavailable",
    value: null,
    error: null,
  }) as ActivityState["calendarEvents"],
  calendarResponses: Object.freeze({
    status: "unavailable",
    value: null,
    error: null,
  }) as ActivityState["calendarResponses"],
  skillNotifications: Object.freeze({
    status: "unavailable",
    value: null,
    error: null,
  }) as ActivityState["skillNotifications"],
  mailError: null,
  refreshedAtMs: null,
});

const INITIAL_FLEET: FleetCenterState = Object.freeze({
  loaded: false,
  loading: false,
  availability: "unknown",
  fleet: null,
  pendingInvite: null,
  activeAction: null,
  readError: null,
  actionError: null,
  refreshedAtMs: null,
  lastBroadcast: null,
  targetTags: null,
  watchlist: [],
  broadcastHistory: [],
  authoritativeFleetID: null,
});

const INITIAL_SCANNER: ScannerCenterState = Object.freeze({
  loaded: false,
  loading: false,
  solarSystemID: null,
  scan: Object.freeze({ status: "loading" }),
  operations: Object.freeze({ status: "loading" }),
  refreshedAtMs: null,
  probeResults: null,
});

// R17 contracts. READS ONLY — every mutator is refused at the gateway, so
// there is no action state here. Each read keeps its own error, so a public
// browse that failed never hides the player's own contracts.
//
// ⚠ worldHasNoContracts starts FALSE and only ever becomes true from a
// SUCCESSFUL empty browse. "Nothing loaded yet" and "this world has no
// contracts" are different statements and must never look alike.
const INITIAL_CONTRACTS: ContractsState = Object.freeze({
  browse: Object.freeze([]) as readonly ContractRow[],
  numFound: 0,
  page: 0,
  pageSize: 100,
  outstanding: Object.freeze([]) as readonly ContractRow[],
  accepted: Object.freeze([]) as readonly ContractRow[],
  expired: Object.freeze([]) as readonly ContractRow[],
  assigned: Object.freeze([]) as readonly ContractRow[],
  numAssigned: 0,
  summary: null as ContractSummary | null,
  detail: null as ContractDetail | null,
  loaded: false,
  browseError: null,
  mineError: null,
  assignedError: null,
  detailError: null,
  accepting: null as number | null,
  acceptError: null,
  acceptedContractID: null as number | null,
  worldHasNoContracts: false,
});

// R37 personal assets. READS ONLY — the bound global-assets object implements
// no write at all.
//
// ⚠ ownsNothing starts FALSE and only ever becomes true from a SUCCESSFUL
// empty ListStations. "Nothing loaded yet", "that read failed" and "you own
// nothing anywhere" are three different statements and must not look alike.
const INITIAL_ASSETS: PersonalAssetsState = Object.freeze({
  stations: Object.freeze([]) as readonly AssetStationRow[],
  contents: Object.freeze({}) as Readonly<Record<number, AssetStationContents>>,
  expandedStationID: null as number | null,
  loaded: false,
  error: null,
  ownsNothing: false,
});

const INITIAL_AGENTS: AgentsState = Object.freeze({
  stationID: null,
  agents: Object.freeze([]) as AgentsState["agents"],
  activeAgentID: null,
  conversation: null,
  missionKeywords: Object.freeze({}) as AgentsState["missionKeywords"],
  briefing: null,
  objectives: null,
  missionTimes: null,
  agentLocation: null,
  missionPage: null,
  agentRecords: Object.freeze({}) as AgentsState["agentRecords"],
  agentSolarSystems: Object.freeze({}) as AgentsState["agentSolarSystems"],
  journal: null,
  loaded: false,
  actionError: null,
});

const INITIAL_FINDER: AgentFinderState = Object.freeze({
  kind: "courier",
  level: null,
  originSystemID: null,
  agents: Object.freeze([]) as AgentFinderState["agents"],
  total: 0,
  capped: false,
  loaded: false,
  target: null,
  error: null,
});

const INITIAL_ADDRESS_BOOK: AddressBookState = Object.freeze({ online: null });

const INITIAL_REWARDS: RewardsState = Object.freeze({
  cashBalance: null,
  lpBalances: Object.freeze([]) as RewardsState["lpBalances"],
  standings: Object.freeze([]) as RewardsState["standings"],
  loaded: false,
  error: null,
});

// R50 wallet (extended R54). Every list starts NULL, not 0/[]: a balance not yet
// read must not render as 0 ISK, and an unread corp wallet / ledger must not look
// like a corporation with no divisions or a wallet with no history. An empty
// `corpDivisions`/`journal`/`transactions` list becomes a real answer only from a
// SUCCESSFUL read that carried no rows.
const INITIAL_WALLET: WalletState = Object.freeze({
  cashBalance: null,
  cashError: null,
  corpDivisions: null,
  corpError: null,
  journal: null,
  journalError: null,
  loaded: false,
});

// R55 standings. `char`/`corp` start NULL, not []: an unread standings list must
// not look like a character who stands with no one. An empty list becomes a real
// answer only from a SUCCESSFUL read that carried no rows (worldHasNoContracts
// precedent). The drill-down (transactions/compositions) is loaded on demand and
// tagged with the row it belongs to.
const INITIAL_STANDINGS: StandingsState = Object.freeze({
  char: null,
  charError: null,
  corp: null,
  corpError: null,
  loaded: false,
  detailFromID: null,
  detailScope: null,
  transactions: null,
  compositions: null,
  detailError: null,
});

// R56 character sheet. Every read starts null/unloaded: an unread sheet must not
// look like a character with no corp, no bio and no home. `identity`/`clone`
// become non-null only from a SUCCESSFUL read; `description` "" is a real empty
// bio and is distinct from null (unread/failed). Cleared with the character.
const INITIAL_CHARACTER_SHEET: CharacterSheetState = Object.freeze({
  identity: null,
  identityError: null,
  description: null,
  descriptionError: null,
  homeStationID: null,
  homeStationError: null,
  clone: null,
  cloneError: null,
  skillHistory: null,
  skillHistoryError: null,
  employmentHistory: null,
  employmentHistoryError: null,
  loaded: false,
});

const INITIAL_FLIGHT: FlightState = Object.freeze({
  status: null,
  loaded: false,
  lastAction: null,
  actionError: null,
  solarSystemName: null,
  stationName: null,
  structureName: null,
  crimewatch: null,
});

const INITIAL_SPACE: SpaceState = Object.freeze({
  snapshot: null,
  loaded: false,
  error: null,
  gateLinks: Object.freeze([]) as readonly GateLink[],
  gateLinksError: null,
  jams: Object.freeze([]) as readonly ActiveJam[],
});

// R23 slice A — the generic in-space action layer. Reset alongside the space
// slice: a docked ship has no locks and nothing cycling, so carrying either
// across a dock would be a lie the moment the page rendered it.
const INITIAL_TARGETING: TargetingState = Object.freeze({
  lockedTargetIDs: Object.freeze([]) as readonly number[],
  acquiringTargetIDs: Object.freeze([]) as readonly number[],
  lockedByIDs: Object.freeze([]) as readonly number[],
  loaded: false,
  lastAction: null,
  actionError: null,
  silentDecline: null,
  moduleCycles: Object.freeze({}) as Readonly<Record<number, ModuleCycle>>,
  damageLog: Object.freeze([]) as readonly DamageEvent[],
});

// R29 how many shots to keep. A bounded TAIL of what the push channel told us,
// deliberately the same shape as the live-notification cap above: the stream is
// allowed to drop and resynchronise, so a longer buffer would only make the
// gaps less obvious, not less real.
// ⚠ EXPORTED so the Shots panel can NAME the number instead of keeping its own
// copy of it. That panel's totals are a sum over this buffer and nothing more,
// so it has to say "over the last N shots" — and an N written down twice is an
// N that goes wrong in one place, silently, the first time this cap moves.
export const DAMAGE_LOG_LIMIT = 40;

// R23 slice B — the mining loop. `taxRate` starts NULL, not 0: reprocessing
// debits the station's tax from the wallet, and a confident zero before any
// quote has been read would tell the player the refinery is free.
const INITIAL_MINING: MiningState = Object.freeze({
  holds: Object.freeze([]) as readonly MiningHold[],
  holdsLoaded: false,
  holdsError: null,
  survey: Object.freeze([]) as readonly SurveyResult[],
  surveyAtMs: null,
  surveyError: null,
  quotes: Object.freeze([]) as readonly ReprocessingQuote[],
  taxRate: null,
  quotesFor: Object.freeze([]) as readonly number[],
  quotesError: null,
  lastAction: null,
  actionError: null,
  silentDecline: null,
});

// R25 slice A — drones. `bay` and `inSpace` start NULL, not []: until a read
// succeeds we do not know whether the bay is empty or whether we simply could
// not look, and those two facts pull a player in opposite directions.
const INITIAL_DRONES: DronesState = Object.freeze({
  bay: null,
  inSpace: null,
  limits: Object.freeze({ maxActiveDrones: null, droneBandwidth: null }),
  loaded: false,
  error: null,
  lastAction: null,
  actionError: null,
  silentDecline: null,
  // R34 — empty means "the server refused nothing", never "everything worked".
  orderReports: Object.freeze([]) as readonly DroneOrderReport[],
});

// R26 — the mining bot readout. `holdUsed`/`holdCapacity` start NULL, not 0:
// a hull that has not reported a capacity must not render as an empty hold
// with room to spare.
const INITIAL_BOT: MiningBotState = Object.freeze({
  status: "idle" as MiningBotState["status"],
  phase: null,
  action: null,
  why: null,
  rung: null,
  step: null,
  rockName: null,
  beltName: null,
  stationName: null,
  cyclesCompleted: 0,
  oreUnitsMined: 0,
  holdUsed: null,
  holdCapacity: null,
  failureReason: null,
  startError: null,
  startedAt: null,
});

const INITIAL_CUSTOM_BOT: CustomBotState = Object.freeze({
  status: "idle" as CustomBotState["status"],
  name: null,
  phase: null,
  why: null,
  stepPath: null,
  interruptID: null,
  pauseReason: null,
  note: null,
  refusals: [],
  startError: null,
  lastAlert: null,
});

// R36 — the mission bot's readout. Every "unknown" is null, never 0 or "": an
// unmeasured payout must not render as "earned nothing", and a job whose name
// has not been read must not render as a job with no name.
const INITIAL_FLEET_COMPANION: FleetCompanionState = Object.freeze({
  status: "idle" as FleetCompanionState["status"],
  phase: null,
  action: null,
  why: null,
  inFleet: null,
  followingOrderFrom: null,
  lastOrderHeard: null,
  targetMode: null,
  canTag: null,
  fitWarnings: Object.freeze([]),
  abandonment: null,
  startedAt: null,
  startError: null,
  failureReason: null,
  selfPaused: false,
});

const INITIAL_MISSION_BOT: MissionBotState = Object.freeze({
  status: "idle" as MissionBotState["status"],
  phase: null,
  action: null,
  why: null,
  agentName: null,
  missionName: null,
  cargoText: null,
  destinationName: null,
  jumpsRemaining: null,
  missionsCompleted: 0,
  iskEarned: null,
  lpEarned: null,
  caution: null,
  failureReason: null,
  startError: null,
  startedAt: null,
});

/**
 * R43 — nothing holds the ship until a loop says otherwise. There is no
 * `bots/…` event: this slice is RECOMPUTED from the loops' own statuses (see
 * `syncBotClaim`), which is what makes it incapable of disagreeing with them.
 */
const INITIAL_BOTS: BotsState = Object.freeze({
  runningBotID: null as ShipControllerID | null,
});

// R28 skills. Every "unknown" is null and never an empty list: a failed read
// must not look like a character who knows nothing, and an unread queue must
// not look like a queue with nothing in it.
const INITIAL_SKILLS: SkillsState = Object.freeze({
  characterName: null,
  totalSkillPoints: null,
  freeSkillPoints: null,
  skills: null,
  queue: null,
  // No read yet, so the browser's clock is all we have; the first read
  // replaces this with the real offset from the server's.
  clockOffsetMs: 0,
  loaded: false,
  error: null,
  lastAction: null,
  actionError: null,
});

// R41 planets. `colonies: null` is "we have not read them / the read failed";
// an empty list is a real answer only alongside `hasNoColonies`, which is set
// ONLY when the read succeeded AND the gateway carried a colony table.
const INITIAL_PLANETS: PlanetsState = Object.freeze({
  colonies: null,
  selectedPlanetID: null,
  clockOffsetMs: 0,
  loaded: false,
  error: null,
  hasNoColonies: false,
  // Unread, and honest about it: EMPTY_RECIPE_BOOK carries `readable: false`,
  // which is NOT the same as a table that makes nothing.
  recipes: EMPTY_RECIPE_BOOK,
});

/**
 * Wipe a character's colonies while KEEPING the recipe book.
 *
 * ⚠ THE TWO HAVE DIFFERENT OWNERS. Colonies belong to the character that just
 * went away and must not be shown to the next one. The recipes are static
 * reference data that is the same for every character on this server, so
 * dropping them would only buy a pointless re-read on every character switch.
 */
function clearedPlanets(previous: PlanetsState): PlanetsState {
  return { ...INITIAL_PLANETS, recipes: previous.recipes };
}

const INITIAL_TRAVEL: TravelState = Object.freeze({
  status: "idle" as TravelState["status"],
  destinationSystemID: null,
  destinationStationID: null,
  destinationName: null,
  route: Object.freeze([]) as TravelState["route"],
  currentSystemID: null,
  currentSystemName: null,
  nextSystemID: null,
  nextSystemName: null,
  action: null,
  phase: null,
  remainingJumps: 0,
  totalJumps: 0,
  startedAt: null,
  failureReason: null,
});

const EMPTY_CHAT_CHANNEL: ChatChannelState = Object.freeze({
  roomName: null,
  corporationID: null,
  solarSystemID: null,
  roster: Object.freeze([]) as ChatChannelState["roster"],
  messages: Object.freeze([]) as ChatChannelState["messages"],
  loaded: false,
});

const INITIAL_CHAT: ChatState = Object.freeze({
  activeChannel: "local" as ChatState["activeChannel"],
  local: EMPTY_CHAT_CHANNEL,
  corp: EMPTY_CHAT_CHANNEL,
  error: null,
});

// Static reference names (goal R7c): resolved once, kept for the app's life
// (they can't change). Not reset on offline/logout — the flow's name cache is
// kept in step, and re-resolving immutable data would only cause needless
// refetches.
const INITIAL_NAMES: NamesState = Object.freeze({
  resolved: Object.freeze({}) as NamesState["resolved"],
  systemSecurity: Object.freeze({}) as NamesState["systemSecurity"],
  autopilotJumps: Object.freeze({}) as NamesState["autopilotJumps"],
});

// The retail client's text for the server's labels. Like names: read once,
// kept for the app's life, not reset on offline or logout.
const INITIAL_WORDS: WordsState = Object.freeze({
  available: null,
  templates: Object.freeze({}) as WordsState["templates"],
});

// R10 live channel: how many pushed session notifications to keep. A bounded
// tail — this is a liveness record for the page to react to, not a log.
const LIVE_NOTIFICATION_LIMIT = 50;
// How many messages a channel backlog keeps once live pushes start appending.
// Matches the gateway's default backlog read so live and polled state converge.
const CHAT_BACKLOG_LIMIT = 50;

const INITIAL_LIVE: LiveState = Object.freeze({
  status: "idle" as LiveState["status"],
  epoch: null,
  sequence: 0,
  notifications: Object.freeze([]) as LiveState["notifications"],
  lastEventAtMs: null,
  questions: Object.freeze([]) as LiveState["questions"],
});

const INITIAL_FEED: FeedSlice = Object.freeze({
  adapter: null,
  status: "idle" as FeedStatus,
});

const INITIAL_HEALTH: HealthSlice = Object.freeze({
  status: "unknown" as HealthStatus,
});

// --- Store -----------------------------------------------------------------

export interface ClientStore {
  /** Per-slice read/subscribe API for pure readers. */
  readonly session: ReadableSignal<SessionSlice>;
  readonly character: ReadableSignal<CharacterSlice>;
  readonly station: ReadableSignal<StationSlice>;
  readonly inventory: ReadableSignal<InventoryState>;
  readonly fitting: ReadableSignal<FittingState>;
  readonly dogma: ReadableSignal<DogmaState>;
  readonly industry: ReadableSignal<IndustryState>;
  readonly market: ReadableSignal<MarketState>;
  readonly mail: ReadableSignal<MailState>;
  readonly activity: ReadableSignal<ActivityState>;
  readonly fleet: ReadableSignal<FleetCenterState>;
  readonly scanner: ReadableSignal<ScannerCenterState>;
  readonly contracts: ReadableSignal<ContractsState>;
  readonly assets: ReadableSignal<PersonalAssetsState>;
  readonly agents: ReadableSignal<AgentsState>;
  readonly finder: ReadableSignal<AgentFinderState>;
  readonly rewards: ReadableSignal<RewardsState>;
  readonly addressBook: ReadableSignal<AddressBookState>;
  readonly wallet: ReadableSignal<WalletState>;
  readonly standings: ReadableSignal<StandingsState>;
  readonly characterSheet: ReadableSignal<CharacterSheetState>;
  readonly flight: ReadableSignal<FlightState>;
  readonly space: ReadableSignal<SpaceState>;
  readonly targeting: ReadableSignal<TargetingState>;
  readonly mining: ReadableSignal<MiningState>;
  readonly drones: ReadableSignal<DronesState>;
  readonly skills: ReadableSignal<SkillsState>;
  readonly planets: ReadableSignal<PlanetsState>;
  readonly travel: ReadableSignal<TravelState>;
  readonly bot: ReadableSignal<MiningBotState>;
  readonly missionBot: ReadableSignal<MissionBotState>;
  readonly companion: ReadableSignal<FleetCompanionState>;
  readonly customBot: ReadableSignal<CustomBotState>;
  readonly bots: ReadableSignal<BotsState>;
  readonly chat: ReadableSignal<ChatState>;
  readonly live: ReadableSignal<LiveState>;
  readonly names: ReadableSignal<NamesState>;
  readonly words: ReadableSignal<WordsState>;
  readonly feed: ReadableSignal<FeedSlice>;
  readonly health: ReadableSignal<HealthSlice>;

  /** Whole-state snapshot. */
  get(): ClientState;
  /**
   * Whole-store subscription: called synchronously with the current state,
   * then exactly once per applied event / feed-status change (slice updates
   * from one event are batched into one notification).
   */
  subscribe(listener: (state: ClientState) => void): Unsubscribe;

  /** Reduce one normalized feed event into the state. */
  apply(event: FeedEvent): void;

  /**
   * Attach a feed adapter (detaching any previous one) and start it. Returns
   * a detach function that stops the adapter; events published by a detached
   * adapter are ignored.
   */
  attachFeed(adapter: FeedAdapter): Unsubscribe;
}

export function createClientStore(): ClientStore {
  const session = createSignal<SessionSlice>(INITIAL_SESSION);
  const character = createSignal<CharacterSlice>(INITIAL_CHARACTER);
  const station = createSignal<StationSlice>(INITIAL_STATION);
  const inventory = createSignal<InventoryState>(INITIAL_INVENTORY);
  const fitting = createSignal<FittingState>(INITIAL_FITTING);
  const dogma = createSignal<DogmaState>(INITIAL_DOGMA);
  const industry = createSignal<IndustryState>(INITIAL_INDUSTRY);
  const market = createSignal<MarketState>(INITIAL_MARKET);
  const mail = createSignal<MailState>(INITIAL_MAIL);
  const activity = createSignal<ActivityState>(INITIAL_ACTIVITY);
  const fleet = createSignal<FleetCenterState>(INITIAL_FLEET);
  const scanner = createSignal<ScannerCenterState>(INITIAL_SCANNER);
  const contracts = createSignal<ContractsState>(INITIAL_CONTRACTS);
  const assets = createSignal<PersonalAssetsState>(INITIAL_ASSETS);
  const agents = createSignal<AgentsState>(INITIAL_AGENTS);
  const finder = createSignal<AgentFinderState>(INITIAL_FINDER);
  const rewards = createSignal<RewardsState>(INITIAL_REWARDS);
  const addressBook = createSignal<AddressBookState>(INITIAL_ADDRESS_BOOK);
  const wallet = createSignal<WalletState>(INITIAL_WALLET);
  const standings = createSignal<StandingsState>(INITIAL_STANDINGS);
  const characterSheet = createSignal<CharacterSheetState>(INITIAL_CHARACTER_SHEET);
  const flight = createSignal<FlightState>(INITIAL_FLIGHT);
  const space = createSignal<SpaceState>(INITIAL_SPACE);
  const targeting = createSignal<TargetingState>(INITIAL_TARGETING);
  const mining = createSignal<MiningState>(INITIAL_MINING);
  const drones = createSignal<DronesState>(INITIAL_DRONES);
  const skills = createSignal<SkillsState>(INITIAL_SKILLS);
  const planets = createSignal<PlanetsState>(INITIAL_PLANETS);
  const travel = createSignal<TravelState>(INITIAL_TRAVEL);
  const bot = createSignal<MiningBotState>(INITIAL_BOT);
  const missionBot = createSignal<MissionBotState>(INITIAL_MISSION_BOT);
  const companion = createSignal<FleetCompanionState>(INITIAL_FLEET_COMPANION);
  const customBot = createSignal<CustomBotState>(INITIAL_CUSTOM_BOT);
  const bots = createSignal<BotsState>(INITIAL_BOTS);
  const chat = createSignal<ChatState>(INITIAL_CHAT);
  const live = createSignal<LiveState>(INITIAL_LIVE);
  const names = createSignal<NamesState>(INITIAL_NAMES);
  const words = createSignal<WordsState>(INITIAL_WORDS);
  const feed = createSignal<FeedSlice>(INITIAL_FEED);
  const health = createSignal<HealthSlice>(INITIAL_HEALTH);

  // Whole-store notification: bumped once per applied change so multi-slice
  // reducers still produce a single store-level notification.
  const version = createSignal(0);
  const bump = (): void => {
    version.set(version.get() + 1);
  };

  const get = (): ClientState => ({
    session: session.get(),
    character: character.get(),
    station: station.get(),
    inventory: inventory.get(),
    fitting: fitting.get(),
    dogma: dogma.get(),
    industry: industry.get(),
    market: market.get(),
    mail: mail.get(),
    activity: activity.get(),
    fleet: fleet.get(),
    scanner: scanner.get(),
    contracts: contracts.get(),
    assets: assets.get(),
    agents: agents.get(),
    finder: finder.get(),
    rewards: rewards.get(),
    addressBook: addressBook.get(),
    wallet: wallet.get(),
    standings: standings.get(),
    characterSheet: characterSheet.get(),
    flight: flight.get(),
    space: space.get(),
    targeting: targeting.get(),
    mining: mining.get(),
    drones: drones.get(),
    skills: skills.get(),
    planets: planets.get(),
    travel: travel.get(),
    bot: bot.get(),
    missionBot: missionBot.get(),
    companion: companion.get(),
    customBot: customBot.get(),
    bots: bots.get(),
    chat: chat.get(),
    live: live.get(),
    names: names.get(),
    words: words.get(),
    feed: feed.get(),
    health: health.get(),
  });

  const reduce = (event: FeedEvent): void => {
    switch (event.type) {
      case "health/status":
        health.set({ status: event.status });
        break;
      case "session/logged-in":
        session.set({
          phase: "logged-in",
          accountID: event.accountID,
          username: event.username,
          accountCreated: event.accountCreated === true,
        });
        break;
      case "session/logged-out":
        // Logging out drops the character and station context with the session.
        session.set(INITIAL_SESSION);
        character.set(INITIAL_CHARACTER);
        station.set(INITIAL_STATION);
        inventory.set(INITIAL_INVENTORY);
        fitting.set(INITIAL_FITTING);
        dogma.set(INITIAL_DOGMA);
        industry.set(INITIAL_INDUSTRY);
        market.set(INITIAL_MARKET);
        mail.set(INITIAL_MAIL);
        activity.set(INITIAL_ACTIVITY);
        fleet.set(INITIAL_FLEET);
        scanner.set(INITIAL_SCANNER);
        contracts.set(INITIAL_CONTRACTS);
    assets.set(INITIAL_ASSETS);
        agents.set(INITIAL_AGENTS);
        finder.set(INITIAL_FINDER);
        rewards.set(INITIAL_REWARDS);
        addressBook.set(INITIAL_ADDRESS_BOOK);
        wallet.set(INITIAL_WALLET);
        standings.set(INITIAL_STANDINGS);
        characterSheet.set(INITIAL_CHARACTER_SHEET);
        flight.set(INITIAL_FLIGHT);
        space.set(INITIAL_SPACE);
        targeting.set(INITIAL_TARGETING);
        mining.set(INITIAL_MINING);
        drones.set(INITIAL_DRONES);
        skills.set(INITIAL_SKILLS);
        planets.set(clearedPlanets(planets.get()));
        travel.set(INITIAL_TRAVEL);
        bot.set(INITIAL_BOT);
        customBot.set(INITIAL_CUSTOM_BOT);
        companion.set(INITIAL_FLEET_COMPANION);
        chat.set(INITIAL_CHAT);
        live.set(INITIAL_LIVE);
        break;
      case "character/list": {
        const characters = [...event.characters];
        const selected = character.get().selectedCharacterID;
        const stillPresent =
          selected !== null &&
          characters.some((row) => row.characterID === selected);
        character.set({
          selectedCharacterID: stillPresent ? selected : null,
          characters,
        });
        break;
      }
      case "character/selected": {
        const current = character.get();
        const requested = event.characterID;
        const known =
          requested !== null &&
          current.characters.some((row) => row.characterID === requested);
        character.set({
          ...current,
          selectedCharacterID: known ? requested : null,
        });
        break;
      }
      case "character/online":
        // A fresh docked entry: the panel reads (bits/guests/info) repopulate
        // from their own events on the new live session.
        station.set({
          ...INITIAL_STATION,
          online: event.character,
          station: event.station,
        });
        inventory.set(INITIAL_INVENTORY);
        fitting.set(INITIAL_FITTING);
        dogma.set(INITIAL_DOGMA);
        industry.set(INITIAL_INDUSTRY);
        market.set(INITIAL_MARKET);
        mail.set(INITIAL_MAIL);
        activity.set(INITIAL_ACTIVITY);
        fleet.set(INITIAL_FLEET);
        scanner.set(INITIAL_SCANNER);
        contracts.set(INITIAL_CONTRACTS);
    assets.set(INITIAL_ASSETS);
        agents.set(INITIAL_AGENTS);
        finder.set(INITIAL_FINDER);
        rewards.set(INITIAL_REWARDS);
        addressBook.set(INITIAL_ADDRESS_BOOK);
        wallet.set(INITIAL_WALLET);
        standings.set(INITIAL_STANDINGS);
        characterSheet.set(INITIAL_CHARACTER_SHEET);
        flight.set(INITIAL_FLIGHT);
        space.set(INITIAL_SPACE);
        targeting.set(INITIAL_TARGETING);
        mining.set(INITIAL_MINING);
        drones.set(INITIAL_DRONES);
        travel.set(INITIAL_TRAVEL);
        bot.set(INITIAL_BOT);
        customBot.set(INITIAL_CUSTOM_BOT);
        companion.set(INITIAL_FLEET_COMPANION);
        chat.set(INITIAL_CHAT);
        live.set(INITIAL_LIVE);
        break;
      case "character/session-changed": {
        const current = station.get();
        if (current.online === null) break;
        const { type: _type, ...changed } = event;
        station.set({ ...current, online: { ...current.online, ...changed } });
        break;
      }
      case "character/offline":
        // R28: the skill sheet belongs to the character who was selected, so it
        // goes with them. Leaving it behind would show the NEXT character
        // someone else's skills.
        skills.set(INITIAL_SKILLS);
        station.set(INITIAL_STATION);
        inventory.set(INITIAL_INVENTORY);
        fitting.set(INITIAL_FITTING);
        dogma.set(INITIAL_DOGMA);
        industry.set(INITIAL_INDUSTRY);
        market.set(INITIAL_MARKET);
        mail.set(INITIAL_MAIL);
        activity.set(INITIAL_ACTIVITY);
        fleet.set(INITIAL_FLEET);
        scanner.set(INITIAL_SCANNER);
        contracts.set(INITIAL_CONTRACTS);
    assets.set(INITIAL_ASSETS);
        agents.set(INITIAL_AGENTS);
        finder.set(INITIAL_FINDER);
        rewards.set(INITIAL_REWARDS);
        addressBook.set(INITIAL_ADDRESS_BOOK);
        wallet.set(INITIAL_WALLET);
        standings.set(INITIAL_STANDINGS);
        characterSheet.set(INITIAL_CHARACTER_SHEET);
        flight.set(INITIAL_FLIGHT);
        space.set(INITIAL_SPACE);
        targeting.set(INITIAL_TARGETING);
        mining.set(INITIAL_MINING);
        drones.set(INITIAL_DRONES);
        travel.set(INITIAL_TRAVEL);
        bot.set(INITIAL_BOT);
        customBot.set(INITIAL_CUSTOM_BOT);
        companion.set(INITIAL_FLEET_COMPANION);
        chat.set(INITIAL_CHAT);
        live.set(INITIAL_LIVE);
        break;
      case "station/relocated": {
        // The docked station changed on the same live session (autopilot
        // arrival / manual dock). Re-point the online location + static identity
        // and drop the prior station's reads (bits/guests/info/error) so the
        // flow's follow-up refresh repopulates them for the new station. No-op
        // if nobody is online.
        const current = station.get();
        if (!current.online) {
          break;
        }
        station.set({
          ...current,
          online: {
            ...current.online,
            stationID: event.stationID,
            structureID: event.structureID ?? null,
            solarSystemID: event.solarSystemID,
          },
          station: event.station,
          bits: null,
          structureServiceIDs: null,
          guests: [],
          offices: null,
          readError: null,
        });
        break;
      }
      case "station/bits":
        station.set({ ...station.get(), bits: event.bits });
        break;
      case "station/structure-services":
        station.set({ ...station.get(), structureServiceIDs: event.serviceIDs });
        break;
      case "station/guests":
        station.set({ ...station.get(), guests: [...event.guests] });
        break;
      case "station/offices":
        station.set({ ...station.get(), offices: { ...event.offices, corporationIDs: [...event.offices.corporationIDs] } });
        break;
      case "character/clone-grade":
        station.set({ ...station.get(), cloneGrade: event.cloneGrade });
        break;
      case "character/security-status":
        station.set({ ...station.get(), ownSecurityStatus: event.securityStatus });
        break;
      case "station/read-error":
        station.set({ ...station.get(), readError: event.message });
        break;
      case "inventory/loaded": {
        const previous = inventory.get();
        /**
         * R88 — WHICH HULL YOU ARE FLYING CHANGED, SO EVERYTHING KEYED TO THE
         * HULL IS NOW A LIE.
         *
         * R87 fixed boarding by having the board/leave flows re-read the
         * hull-scoped views. That worked, but it put the guarantee in the
         * CALLERS: any future action that changes the active ship — a server
         * push, a bot, an eject, a ship destroyed under you — would have to
         * remember to do the same, and the failure mode is silent. A stale fit
         * or a stale set of bays looks live, sits under the right heading, and
         * says nothing about describing a different ship.
         *
         * So the invalidation lives HERE, where the change is observed, and it
         * cannot be forgotten. The flows still re-read (so the panels refill
         * immediately rather than sitting empty); this is what makes the stale
         * state impossible rather than merely unlikely.
         *
         * ⚠ `previous.loaded` IS THE GUARD, AND IT IS NOT OPTIONAL. The first
         * load moves activeShipID from null to a real hull, which is not a
         * change of ship — it is the first time we looked. Without this, every
         * character coming online would throw away the fit it had just read.
         * (The dock transition needed the same three-valued reasoning for the
         * same reason; see ui/dockTransition.ts.)
         */
        const hullChanged = previous.loaded && previous.activeShipID !== event.activeShipID;
        if (hullChanged) {
          // The fit, its resources, its stats and its dogma snapshot all belong
          // to the hull. Clearing rather than re-reading here keeps the store
          // free of I/O; the panels that care watch `loaded` and refill.
          fitting.set(INITIAL_FITTING);
          dogma.set(INITIAL_DOGMA);
          // ⚠ AND SO DOES THE DRONE BAY — it was missed when R88 drew this
          // list, and the miss is the reported bug: the Drones window read the
          // bay ONCE per session (its effect is guarded on `loaded`, and the
          // guard survives the window being closed and reopened), so a pilot
          // who boarded a drone boat afterwards saw "Nothing in the drone bay"
          // for the rest of the session while Inventory & Ship listed the
          // drones plainly. Every field in the slice is hull-keyed: the bay's
          // stacks, the two launch limits (ship dogma), and whether a drone in
          // space is under THIS hull's control.
          drones.set(INITIAL_DRONES);
        }
        // A reload drops any selection whose item is no longer in the hangar or
        // cargo: acting on a stale tick would move something the player can no
        // longer see.
        const visible = new Set([
          ...event.hangar.rows.map((row) => row.itemID),
          ...event.cargo.rows.map((row) => row.itemID),
          ...(previous.container ? previous.container.rows.map((row) => row.itemID) : []),
          ...previous.corp.divisions.flatMap((division) =>
            division.rows.map((row) => row.itemID),
          ),
        ]);
        inventory.set({
          ...previous,
          stationID: event.stationID,
          structureID: event.structureID ?? null,
          activeShipID: event.activeShipID,
          hangar: event.hangar,
          cargo: event.cargo,
          loaded: true,
          selection: previous.selection.filter((itemID) => visible.has(itemID)),
          /**
           * ⚠ THE OPEN BAYS CARD FOLLOWS THE HULL, BUT ONLY WHEN IT WAS
           * TRACKING IT.
           *
           * The card is normally opened on the ship you are flying (the panel
           * does that on mount), so when the hull changes it must not keep
           * showing the one you stepped out of — that is the reported bug, and
           * at its sharpest it left a Procurer's 16,000 m³ ore hold on screen
           * after boarding a frigate.
           *
           * But a player can also open some OTHER ship's bays deliberately, to
           * look inside a hull sitting in the hangar. That card is still true
           * after boarding something else, and closing it would throw away a
           * pick they made on purpose. So only a card that was pointing at the
           * PREVIOUS active hull is dropped.
           */
          openShip:
            hullChanged && previous.openShip?.itemID === previous.activeShipID
              ? null
              : previous.openShip,
          // A successful load clears any stale mutation error.
          actionError: null,
        });
        break;
      }
      case "inventory/action-error":
        inventory.set({ ...inventory.get(), actionError: event.message, actionErrorSaid: event.message !== null && event.said === true });
        break;
      case "inventory/cleared":
        inventory.set(INITIAL_INVENTORY);
        break;
      case "inventory/selection":
        inventory.set({ ...inventory.get(), selection: [...event.itemIDs] });
        break;
      case "inventory/container":
        inventory.set({
          ...inventory.get(),
          container: event.container,
          // Leaving or entering a container clears the selection: a tick made
          // in one place must never be applied in another.
          selection: [],
        });
        break;
      case "inventory/corp-loaded":
        inventory.set({
          ...inventory.get(),
          corp: {
            ...inventory.get().corp,
            available: event.available,
            reason: event.reason,
            divisions: [...event.divisions],
            loaded: true,
          },
        });
        break;
      case "inventory/corp-division":
        inventory.set({
          ...inventory.get(),
          corp: { ...inventory.get().corp, selectedDivision: event.division },
          selection: [],
        });
        break;
      case "inventory/outcome":
        inventory.set({ ...inventory.get(), lastOutcome: event.outcome });
        break;
      case "inventory/ship-open":
        // Opening a DIFFERENT ship starts from nothing rather than showing the
        // previous ship's bays under the new ship's name. Re-opening the same
        // ship (a refresh) keeps what is on screen until the read answers.
        inventory.set({
          ...inventory.get(),
          openShip:
            event.itemID === null
              ? null
              : {
                  itemID: event.itemID,
                  typeID: event.typeID,
                  bays:
                    inventory.get().openShip && inventory.get().openShip!.itemID === event.itemID
                      ? inventory.get().openShip!.bays
                      : [],
                  loaded: false,
                  error: null,
                },
        });
        break;
      case "inventory/ship-bays": {
        const open = inventory.get().openShip;
        // A read that answers for a ship the player has already navigated away
        // from is dropped: a late reply must never repaint the wrong hull.
        if (!open || open.itemID !== event.itemID) {
          break;
        }
        inventory.set({
          ...inventory.get(),
          openShip: { ...open, bays: [...event.bays], loaded: true, error: event.error },
        });
        break;
      }
      case "fitting/loaded":
        fitting.set({
          activeShipID: event.activeShipID,
          // Advisory sorting data for the ammo picker; {} is "cannot sort".
          chargeFits: event.chargeFits ?? {},
          slots: [...event.slots],
          resources: event.resources,
          shipAttributes: event.shipAttributes,
          stats: event.stats,
          statsFrom: "server",
          // The dogma snapshot rides a separate read that lands just after this
          // one; carry the previous one through so a refresh never blanks the
          // module stats in between.
          dogma: fitting.get().dogma,
          loaded: true,
          slotsError: event.slotsError,
          resourcesError: event.resourcesError,
          dogmaError: fitting.get().dogmaError,
          // A successful load clears any stale action error.
          actionError: null,
          // A re-read does not end a reload; only the clock does.
          reloads: fitting.get().reloads,
        });
        break;
      // The ship's attributes as the server's notices keep them: only for the ship the fit was read for.
      case "fitting/ship-attributes": {
        const current = fitting.get();
        if (current.activeShipID !== event.shipID) break;
        fitting.set(current.statsFrom === "page"
          ? { ...current, shipAttributes: event.shipAttributes }
          : { ...current, shipAttributes: event.shipAttributes, resources: event.resources, stats: event.stats });
        break;
      }
      case "fitting/reckoned": {
        const current = fitting.get();
        if (current.activeShipID !== event.shipID) break;
        fitting.set({ ...current, resources: event.resources, stats: event.stats, statsFrom: "page" });
        break;
      }
      case "fitting/simulated": {
        const current = fitting.get();
        fitting.set({
          ...current,
          simulation: { shipID: event.shipID, shipTypeID: event.shipTypeID, name: event.name, resources: event.resources, stats: event.stats, moduleStates: event.moduleStates, moduleKinds: event.moduleKinds, slots: event.slots, drones: event.drones },
        });
        break;
      }
      case "fitting/simulation-ended": {
        const current = fitting.get();
        if (current.simulation) fitting.set({ ...current, simulation: null });
        break;
      }
      case "fitting/charge-quantity": {
        const current = fitting.get();
        const slots = applyChargeQuantityChanges(current.slots, current.activeShipID, event.changes);
        if (slots !== current.slots) {
          fitting.set({ ...current, slots });
        }
        break;
      }
      case "fitting/reload-started": {
        // Finished reloads are dropped here rather than on a timer: this is
        // the only place the record grows, so it never grows unbounded.
        const reloads: Record<number, ModuleReload> = {};
        for (const [key, reload] of Object.entries(fitting.get().reloads)) {
          if (event.atMs < reload.startedAtMs + reload.durationMs) {
            reloads[Number(key)] = reload;
          }
        }
        for (const moduleID of event.moduleIDs) {
          reloads[moduleID] = {
            chargeTypeID: event.chargeTypeID,
            startedAtMs: event.atMs,
            durationMs: event.durationMs,
          };
        }
        fitting.set({ ...fitting.get(), reloads });
        break;
      }
      case "dogma/loaded": {
        // The dedicated UI slice and the legacy fitting reader share one
        // snapshot. A failed refresh keeps the last reading and its new error.
        const allInfo = event.allInfo ?? dogma.get().allInfo;
        dogma.set({ allInfo, loaded: true, error: event.error });
        fitting.set({
          ...fitting.get(),
          dogma: allInfo,
          dogmaError: event.error,
        });
        break;
      }
      case "fitting/action-error":
        fitting.set({ ...fitting.get(), actionError: event.message, actionErrorSaid: event.message !== null && event.said === true });
        break;
      case "fitting/cleared":
        fitting.set(INITIAL_FITTING);
        dogma.set(INITIAL_DOGMA);
        break;
      case "dogma/cleared":
        dogma.set(INITIAL_DOGMA);
        break;
      case "industry/loaded":
        industry.set({
          ...industry.get(),
          ownerID: event.ownerID,
          stationID: event.stationID,
          solarSystemID: event.solarSystemID,
          blueprints: [...event.blueprints],
          jobs: [...event.jobs],
          facilities: [...event.facilities],
          slotsUsed: event.slotsUsed,
          loaded: true,
          blueprintsError: event.blueprintsError,
          jobsError: event.jobsError,
          facilitiesError: event.facilitiesError,
          // A successful load clears any stale action error.
          actionError: null,
        });
        break;
      case "industry/definitions":
        // Recipes MERGE rather than replace: they are static, so one already
        // fetched stays valid, and a later load only needs the new types.
        industry.set({
          ...industry.get(),
          definitions: { ...industry.get().definitions, ...event.definitions },
        });
        break;
      case "industry/action-error":
        industry.set({ ...industry.get(), actionError: event.message, actionErrorSaid: event.message !== null && event.said === true });
        break;
      case "industry/materials-said":
        // Each telling is counted: a window knows by the count what was said since it last asked.
        industry.set({
          ...industry.get(),
          materialsSaid: {
            monitorID: event.monitorID,
            available: event.available,
            seq: (industry.get().materialsSaid?.seq ?? 0) + 1,
          },
        });
        break;
      case "industry/cleared":
        industry.set(INITIAL_INDUSTRY);
        break;
      // R16 market. Each read lands with its own error, so a public order book
      // that failed never blanks the player's own orders (or the reverse).
      case "market/loaded":
        market.set({
          ...market.get(),
          typeID: event.typeID,
          stationID: event.stationID,
          structureID: event.structureID ?? null,
          solarSystemID: event.solarSystemID,
          brokersFeeRate: event.brokersFeeRate ?? null,
          sells: [...event.sells],
          buys: [...event.buys],
          ownOrders: [...event.ownOrders],
          orderHistory: [...event.orderHistory],
          transactions: [...event.transactions],
          escrow: event.escrow,
          priceHistory: [...event.priceHistory],
          cashBalance: event.cashBalance,
          loaded: true,
          bookError: event.bookError,
          ownOrdersError: event.ownOrdersError,
          transactionsError: event.transactionsError,
          marketUnavailable: event.marketUnavailable,
          // A successful load clears any stale action error, but NOT the last
          // outcome: what the server actually charged stays on screen until the
          // player does something else.
          actionError: null,
        });
        break;
      case "market/action-error":
        market.set({ ...market.get(), actionError: event.message, actionErrorSaid: event.message !== null && event.said === true });
        break;
      case "market/outcome":
        market.set({ ...market.get(), lastOutcome: event.outcome });
        break;
      case "market/escrow":
        market.set({ ...market.get(), escrow: event.escrow });
        break;
      case "market/cleared":
        market.set(INITIAL_MARKET);
        break;
      case "activity/loading":
        // Keep the last good rows visible while a manual refresh is running.
        activity.set({ ...activity.get(), loading: true, mailError: null });
        break;
      case "activity/loaded":
        activity.set({
          loaded: true,
          loading: false,
          notifications:
            event.notifications.status === "ready"
              ? { ...event.notifications, value: [...event.notifications.value] }
              : event.notifications,
          unprocessedCount: event.unprocessedCount,
          calendarEvents:
            event.calendarEvents.status === "ready"
              ? { ...event.calendarEvents, value: [...event.calendarEvents.value] }
              : event.calendarEvents,
          calendarResponses:
            event.calendarResponses.status === "ready"
              ? { ...event.calendarResponses, value: [...event.calendarResponses.value] }
              : event.calendarResponses,
          skillNotifications:
            event.skillNotifications === undefined
              ? INITIAL_ACTIVITY.skillNotifications
              : event.skillNotifications.status === "ready"
                ? { ...event.skillNotifications, value: [...event.skillNotifications.value] }
                : event.skillNotifications,
          mailError: event.mailError,
          refreshedAtMs: event.refreshedAtMs,
        });
        break;
      case "activity/cleared":
        activity.set(INITIAL_ACTIVITY);
        break;
      case "fleet/loading":
        // Keep the last authoritative roster visible during a refresh.
        fleet.set({ ...fleet.get(), loading: true, readError: null });
        break;
      case "fleet/loaded": {
        const current = fleet.get();
        // ⚠ Broadcasts and target tags are PER-FLEET: a dict left over from
        // the previous fleet, read as current in the window before the new
        // fleet's first OnFleetStateChange arrives, would point the guns at
        // ships that are not there. Keyed on the fleetID ITSELF changing, not
        // on availability changing — those are different events, and only a
        // real fleet swap is the hazard. A "ready" refresh of the SAME fleet
        // must not wipe out a broadcast or tag map that just arrived.
        //
        // ⚠ AND AN UNREADABLE FLEET IS NOT A FLEET SWITCH. "unavailable" is the
        // arm every read failed on — a gateway timeout, say — and it carries a
        // null `fleetID`, so comparing ids alone reads a blip as "you left
        // fleet 1 and joined nothing" and clears both fields.
        //
        // That is not a cosmetic wipe. `targetTags` back at `null` means "never
        // received", and tags only arrive again when the commander CHANGES one
        // — which may be many minutes into a fight. So a single failed read
        // would silently switch tag-following off and leave it off, with the
        // readout showing nothing wrong.
        //
        // Could-not-look is never evidence of a change, which is the same rule
        // `authoritativeFleetMemberCharacterIDs` applies one layer down and the
        // same one the companion's supervision gate fails open on. Only an
        // AUTHORITATIVE read ("ready" or "not-in-fleet") gets to say the fleet
        // changed.
        // ⚠ COMPARED AGAINST `authoritativeFleetID`, NEVER `current.fleet.fleetID`.
        // An unavailable read is stored like any other, so `current.fleet` is
        // already the decoded-but-empty value with a null id by the time the
        // NEXT read arrives. Comparing against it means a recovery to the very
        // same fleet reads as a switch and wipes tags nobody left behind --
        // which is exactly the bug that survived the first attempt at this
        // guard, because refusing to clear ON the blip does nothing about the
        // blip having already destroyed the basis.
        const authoritative = event.availability !== "unavailable";
        const switchedFleet =
          authoritative && current.authoritativeFleetID !== event.fleet.fleetID;
        fleet.set({
          ...current,
          loaded: true,
          loading: false,
          availability: event.availability,
          fleet: event.fleet,
          // Joining consumes the invite. Keeping it after a later leave would
          // falsely resurrect an already-used popup.
          pendingInvite: event.availability === "ready" ? null : current.pendingInvite,
          lastBroadcast: switchedFleet ? null : current.lastBroadcast,
          targetTags: switchedFleet ? null : current.targetTags,
          watchlist: switchedFleet || event.availability === "not-in-fleet" ? [] : current.watchlist,
          // Only an authoritative read moves the basis; a blip leaves it alone.
          authoritativeFleetID: authoritative
            ? event.fleet.fleetID
            : current.authoritativeFleetID,
          readError: event.readError,
          refreshedAtMs: event.refreshedAtMs,
        });
        break;
      }
      case "fleet/action-started":
        fleet.set({
          ...fleet.get(),
          activeAction: event.action,
          actionError: null,
          actionErrorSaid: false,
        });
        break;
      case "fleet/action-finished":
        fleet.set({
          ...fleet.get(),
          activeAction: null,
          actionError: event.error,
          actionErrorSaid: event.error !== null && event.said === true,
        });
        break;
      case "fleet/pending-invite":
        fleet.set({ ...fleet.get(), pendingInvite: event.invite });
        break;
      case "fleet/invite-settled":
        // An invitation the pilot has answered is the window's no longer. Another fleet's stays.
        if (fleet.get().pendingInvite?.fleetID === event.fleetID) {
          fleet.set({ ...fleet.get(), pendingInvite: null });
        }
        break;
      case "fleet/broadcast": {
        // fleetSvc.AddBroadcast (1493 to 1496): the newest first, and the oldest let go past five hundred.
        const history = [event.broadcast, ...(fleet.get().broadcastHistory ?? [])].slice(0, MAX_BROADCAST_HISTORY);
        fleet.set({ ...fleet.get(), lastBroadcast: event.broadcast, broadcastHistory: history });
        break;
      }
      case "fleet/broadcast-history-cleared":
        fleet.set({ ...fleet.get(), broadcastHistory: [] });
        break;
      case "fleet/target-tags":
        fleet.set({ ...fleet.get(), targetTags: event.tags });
        break;
      case "fleet/watchlist":
        fleet.set({ ...fleet.get(), watchlist: event.members });
        break;
      case "fleet/jump-beacon": {
        const beacons = { ...(fleet.get().jumpBeacons ?? {}) };
        if (event.beacon === null) delete beacons[String(event.characterID)];
        else beacons[String(event.characterID)] = event.beacon;
        fleet.set({ ...fleet.get(), jumpBeacons: beacons });
        break;
      }
      case "fleet/cleared":
        fleet.set(INITIAL_FLEET);
        break;
      case "scanner/loading":
        // Keep the last known sites visible while a manual refresh runs.
        scanner.set({ ...scanner.get(), loading: true });
        break;
      case "scanner/loaded": {
        const probeResults = scanner.get().probeResults;
        scanner.set({
          loaded: true,
          loading: false,
          solarSystemID: event.solarSystemID,
          scan: event.scan,
          operations: event.operations,
          refreshedAtMs: event.refreshedAtMs,
          probeResults: probeResults !== null && probeResults.solarSystemID === event.solarSystemID ? probeResults : null,
        });
        break;
      }
      case "scanner/probe-results":
        scanner.set({ ...scanner.get(), probeResults: event.probeResults });
        break;
      case "scanner/cleared":
        scanner.set(INITIAL_SCANNER);
        break;
      // R17 mail. A cold delta sync IS the whole mailbox, so the message list
      // is REPLACED rather than merged — an old row surviving a reload would be
      // a message the server no longer says the player has.
      case "mail/loaded":
        mail.set({
          ...mail.get(),
          messages: [...event.messages],
          statuses: [...event.statuses],
          unreadCount: event.unreadCount,
          loaded: true,
          inboxError: event.inboxError,
          // A successful load clears a stale action error but NOT the last
          // outcome: what the server did with the player's message stays on
          // screen until they do something else.
          actionError: null,
        });
        break;
      case "mail/opened":
        mail.set({ ...mail.get(), open: event.open });
        break;
      case "mail/labels":
        mail.set({ ...mail.get(), labels: [...event.labels] });
        break;
      case "mail/lists":
        mail.set({ ...mail.get(), lists: [...event.lists] });
        break;
      case "mail/external-list":
        mail.set({ ...mail.get(), externalLists: [...mail.get().externalLists.filter((each) => each.listID !== event.list.listID), event.list] });
        break;
      case "mail/action-error":
        mail.set({ ...mail.get(), actionError: event.message, actionErrorSaid: event.message !== null && event.said === true });
        break;
      case "mail/outcome":
        mail.set({ ...mail.get(), lastOutcome: event.outcome });
        break;
      case "mail/cleared":
        mail.set(INITIAL_MAIL);
        break;
      // R17 contracts. Reads only; each keeps its own error.
      case "contracts/loaded":
        contracts.set({
          ...contracts.get(),
          browse: [...event.browse],
          numFound: event.numFound,
          page: event.page,
          pageSize: event.pageSize,
          outstanding: [...event.outstanding],
          accepted: [...event.accepted],
          expired: [...event.expired],
          assigned: [...event.assigned],
          numAssigned: event.numAssigned,
          summary: event.summary,
          loaded: true,
          browseError: event.browseError,
          mineError: event.mineError,
          assignedError: event.assignedError,
          worldHasNoContracts: event.worldHasNoContracts,
        });
        break;
      case "contracts/detail": {
        // ⚠ THE ACCEPT VERDICT BELONGS TO THE CONTRACT THAT WAS OPEN. Opening
        // a different one must not leave "that was refused" — or worse, "you
        // have taken this on" — sitting under a contract it says nothing about.
        // The one detail that keeps it is the contract just taken on — which
        // is exactly the one the accept reopens, so the player sees the
        // outcome of what they pressed.
        const previous = contracts.get();
        const aboutThisContract =
          event.detail !== null &&
          previous.acceptedContractID !== null &&
          event.detail.contract.contractID === previous.acceptedContractID;
        contracts.set({
          ...previous,
          detail: event.detail,
          detailError: null,
          acceptError: aboutThisContract ? previous.acceptError : null,
          acceptedContractID: aboutThisContract ? previous.acceptedContractID : null,
        });
        break;
      }
      case "contracts/detail-error":
        contracts.set({ ...contracts.get(), detailError: event.message });
        break;
      case "contracts/accepting":
        // Starting an attempt clears the last one's verdict: a stale "that was
        // refused" next to a running accept says nothing true about either.
        contracts.set({
          ...contracts.get(),
          accepting: event.contractID,
          ...(event.contractID === null ? {} : { acceptError: null, acceptedContractID: null }),
        });
        break;
      case "contracts/accepted":
        contracts.set({
          ...contracts.get(),
          acceptedContractID: event.contractID,
          acceptError: null,
        });
        break;
      case "contracts/accept-error":
        contracts.set({ ...contracts.get(), acceptError: event.message });
        break;
      case "contracts/cleared":
        contracts.set(INITIAL_CONTRACTS);
        break;
      // R37 personal assets. Reads only.
      case "assets/loaded":
        assets.set({
          ...assets.get(),
          stations: [...event.stations],
          // A fresh station list invalidates whatever was expanded: the
          // contents under it may no longer exist.
          contents: {},
          expandedStationID: null,
          loaded: true,
          error: event.error,
          ownsNothing: event.ownsNothing,
        });
        break;
      case "assets/station-items":
        assets.set({
          ...assets.get(),
          contents: {
            ...assets.get().contents,
            [event.stationID]: {
              items: [...event.items],
              hasNoItems: event.hasNoItems,
              error: event.error,
            },
          },
        });
        break;
      case "assets/expanded":
        assets.set({ ...assets.get(), expandedStationID: event.stationID });
        break;
      case "assets/cleared":
        assets.set(INITIAL_ASSETS);
        break;
      case "agents/list":
        agents.set({
          ...agents.get(),
          stationID: event.stationID,
          agents: [...event.agents],
          loaded: true,
          actionError: null,
        });
        break;
      case "agents/conversation":
        agents.set({
          ...agents.get(),
          activeAgentID: event.agentID,
          conversation: event.conversation,
          actionError: null,
        });
        break;
      case "agents/conversation-closed":
        agents.set({ ...agents.get(), activeAgentID: null, conversation: null, briefing: null, objectives: null, missionTimes: null, agentLocation: null });
        break;
      case "agents/mission-keywords": {
        const current = agents.get();
        agents.set({ ...current, missionKeywords: { ...current.missionKeywords, [event.key]: event.keywords } });
        break;
      }
      case "agents/briefing":
        agents.set({ ...agents.get(), briefing: event.briefing });
        break;
      case "agents/objectives":
        agents.set({ ...agents.get(), objectives: event.objectives });
        break;
      case "agents/mission-times":
        agents.set({ ...agents.get(), missionTimes: event.times });
        break;
      case "agents/agent-location":
        agents.set({ ...agents.get(), agentLocation: event.location });
        break;
      case "agents/mission-page":
        agents.set({ ...agents.get(), missionPage: event.page });
        break;
      case "agents/record": {
        const current = agents.get();
        agents.set({ ...current, agentRecords: { ...current.agentRecords, [event.agentID]: event.record } });
        break;
      }
      case "agents/solar-system": {
        const current = agents.get();
        agents.set({ ...current, agentSolarSystems: { ...current.agentSolarSystems, [event.agentID]: event.solarSystemID } });
        break;
      }
      case "agents/journal":
        agents.set({ ...agents.get(), journal: event.journal });
        break;
      case "agents/action-error":
        agents.set({ ...agents.get(), actionError: event.message, actionErrorSaid: event.message !== null && event.said === true });
        break;
      case "agents/cleared":
        agents.set(INITIAL_AGENTS);
        break;
      case "finder/results":
        finder.set({
          ...finder.get(),
          kind: event.kind,
          level: event.level,
          originSystemID: event.originSystemID,
          agents: [...event.agents],
          total: event.total,
          capped: event.capped,
          loaded: true,
          // A fresh result clears any stale find error.
          error: null,
        });
        break;
      case "finder/target":
        finder.set({ ...finder.get(), target: event.target });
        break;
      case "finder/error":
        finder.set({ ...finder.get(), error: event.message });
        break;
      case "finder/cleared":
        finder.set(INITIAL_FINDER);
        break;
      case "rewards/loaded":
        rewards.set({
          cashBalance: event.cashBalance,
          lpBalances: [...event.lpBalances],
          standings: [...event.standings],
          loaded: true,
          error: event.error,
        });
        break;
      case "rewards/cleared":
        rewards.set(INITIAL_REWARDS);
        break;
      case "address-book/online-primed":
        addressBook.set({ ...addressBook.get(), online: { ...event.online } });
        break;
      case "address-book/online-changed": {
        const current = addressBook.get();
        addressBook.set({ ...current, online: { ...(current.online ?? {}), [event.contactID]: event.online } });
        break;
      }
      // R50 wallet. The two halves land together but keep their own errors, so a
      // failed corp read never blanks the personal balance. `corpDivisions`
      // stays NULL on a failed corp read (carried in `corpError`); a successful
      // empty read sets it to [] — a real "no corp wallet divisions".
      case "wallet/loaded":
        wallet.set({
          cashBalance: event.cashBalance,
          cashError: event.cashError,
          corpDivisions: event.corpDivisions,
          corpError: event.corpError,
          journal: event.journal,
          journalError: event.journalError,
          loaded: true,
        });
        break;
      case "wallet/cleared":
        wallet.set(INITIAL_WALLET);
        break;
      // R55 standings. The two lists land together but keep their own errors, so
      // a failed corp read never blanks the character's own standings. `char`/
      // `corp` stay NULL on a failed read (reason in the matching *Error); a
      // successful empty read sets [] — a real "no standings yet". A fresh load
      // drops any open drill-down: it described a row from the previous read.
      case "standings/char":
        standings.set({ ...standings.get(), char: event.char });
        break;
      case "standings/loaded":
        standings.set({
          ...standings.get(),
          char: event.char,
          charError: event.charError,
          corp: event.corp,
          corpError: event.corpError,
          loaded: true,
          detailFromID: null,
          detailScope: null,
          transactions: null,
          compositions: null,
          detailError: null,
        });
        break;
      case "standings/detail":
        standings.set({
          ...standings.get(),
          detailFromID: event.fromID,
          detailScope: event.scope,
          transactions: event.transactions,
          compositions: event.compositions,
          detailError: null,
        });
        break;
      case "standings/detail-error":
        standings.set({
          ...standings.get(),
          detailFromID: event.fromID,
          detailScope: event.scope,
          transactions: null,
          compositions: null,
          detailError: event.message,
        });
        break;
      case "standings/detail-cleared":
        standings.set({
          ...standings.get(),
          detailFromID: null,
          detailScope: null,
          transactions: null,
          compositions: null,
          detailError: null,
        });
        break;
      case "standings/cleared":
        standings.set(INITIAL_STANDINGS);
        break;
      // R56 character sheet. The four reads land together but keep their own
      // errors, so one failed read never blanks the rest. `identity`/`clone` stay
      // null on a failed read (reason in the matching *Error); `description` may be
      // "" (a real empty bio) on a successful read.
      case "character-sheet/loaded":
        characterSheet.set({
          identity: event.identity,
          identityError: event.identityError,
          description: event.description,
          descriptionError: event.descriptionError,
          homeStationID: event.homeStationID,
          homeStationError: event.homeStationError,
          clone: event.clone,
          cloneError: event.cloneError,
          // The skill history and the employment history are their own reads, and stay as those reads left them.
          skillHistory: characterSheet.get().skillHistory,
          skillHistoryError: characterSheet.get().skillHistoryError,
          employmentHistory: characterSheet.get().employmentHistory,
          employmentHistoryError: characterSheet.get().employmentHistoryError,
          loaded: true,
        });
        break;
      case "character-sheet/skill-history":
        characterSheet.set({ ...characterSheet.get(), skillHistory: event.lines, skillHistoryError: event.error });
        break;
      case "character-sheet/employment-history":
        characterSheet.set({ ...characterSheet.get(), employmentHistory: event.history, employmentHistoryError: event.error });
        break;
      case "character-sheet/cleared":
        characterSheet.set(INITIAL_CHARACTER_SHEET);
        break;
      case "flight/status": {
        // Preserve a resolved name only while its ID is unchanged; on any ID
        // change drop the stale name (the UI falls back to the raw ID) until the
        // flow resolves the new one (goal R7a).
        const prev = flight.get();
        const prevStatus = prev.status;
        const next = event.status;
        flight.set({
          ...prev,
          status: next,
          loaded: true,
          solarSystemName:
            prevStatus && prevStatus.solarSystemID === next.solarSystemID ? prev.solarSystemName : null,
          stationName:
            prevStatus && prevStatus.stationID === next.stationID ? prev.stationName : null,
          structureName:
            prevStatus && prevStatus.structureID === next.structureID ? prev.structureName : null,
        });
        // Scanner rows are scoped to one solar system. Drop them synchronously
        // on a confirmed system change so a slow refresh can never present the
        // previous system as the current one.
        const scannerState = scanner.get();
        if (
          scannerState.solarSystemID !== null &&
          next.solarSystemID !== null &&
          scannerState.solarSystemID !== next.solarSystemID
        ) {
          scanner.set(INITIAL_SCANNER);
        }
        break;
      }
      case "flight/location": {
        // Apply each resolved name only if the current status still carries the
        // ID it was resolved for, so a slow resolve landing after the ship moved
        // can never mislabel the new location (goal R7a).
        const cur = flight.get();
        const s = cur.status;
        flight.set({
          ...cur,
          solarSystemName:
            s && s.solarSystemID !== null && s.solarSystemID === event.forSolarSystemID
              ? event.solarSystemName
              : cur.solarSystemName,
          stationName:
            s && s.stationID !== null && s.stationID === event.forStationID
              ? event.stationName
              : cur.stationName,
          structureName:
            s && s.structureID !== null && s.structureID === event.forStructureID
              ? event.structureName
              : cur.structureName,
        });
        break;
      }
      case "flight/action":
        // A successful movement step: record it and clear any stale refusal.
        flight.set({ ...flight.get(), lastAction: event.action, actionError: null });
        break;
      case "flight/action-error":
        flight.set({ ...flight.get(), actionError: event.message, actionErrorSaid: event.message !== null && event.said === true });
        break;
      case "flight/crimewatch":
        flight.set({ ...flight.get(), crimewatch: event.crimewatch });
        break;
      case "flight/cleared":
        flight.set(INITIAL_FLIGHT);
        break;
      case "space/snapshot": {
        // A clean read clears any stale read error.
        //
        // R30 slice A — the gate links ride WITH the snapshot when the producer
        // has them, and are otherwise carried forward. Carrying forward matters:
        // the graph loads once, asynchronously, so the first snapshots arrive
        // before it is ready and every later one would otherwise wipe the links
        // the moment they landed.
        const previous = space.get();
        space.set({
          snapshot: event.snapshot,
          loaded: true,
          error: null,
          gateLinks: event.gateLinks ?? previous.gateLinks,
          gateLinksError: event.gateLinks !== undefined ? null : previous.gateLinksError,
          // ⚠ CARRIED FORWARD, for a different reason than the gate links
          // above. The jams are not part of a snapshot read at all — they are
          // folded from pushes that arrive on their own schedule, and the
          // snapshot poll runs ~1s. Rebuilding them from `event` would wipe a
          // live scram once a second and leave the tackle rung looking at an
          // empty set on most ticks.
          jams: previous.jams,
        });
        break;
      }
      case "space/jam":
        space.set({ ...space.get(), jams: applyJamEvent(space.get().jams, event.event) });
        break;
      case "space/gate-map-error":
        // The star map could not be read. Say so rather than rendering a grid
        // whose gates silently offer nothing.
        space.set({ ...space.get(), gateLinks: [], gateLinksError: event.message });
        break;
      case "space/error":
        space.set({ ...space.get(), error: event.message });
        break;
      case "space/cleared":
        space.set(INITIAL_SPACE);
        targeting.set(INITIAL_TARGETING);
        // The MINING slice deliberately survives a dock. Docking is where the
        // rest of the loop happens — unload the ore hold, quote it, reprocess it
        // — so wiping the holds the moment the ship docks would clear the panel
        // exactly when the player starts using it. Only the SURVEY is dropped:
        // it described rocks in a system the ship is no longer flying in.
        mining.set({
          ...mining.get(),
          survey: INITIAL_MINING.survey,
          surveyAtMs: null,
          surveyError: null,
        });
        break;
      // --- R23 slice A: targeting + module activation ---------------------
      case "targeting/targets": {
        const prev = targeting.get();
        const locked = event.targetIDs;
        // A target that has ARRIVED in the server's locked list is no longer
        // being acquired. This is the only place an acquiring note is retired
        // on success, so the page can never show "Locking…" for something that
        // is already locked.
        targeting.set({
          ...prev,
          lockedTargetIDs: locked,
          acquiringTargetIDs: prev.acquiringTargetIDs.filter((id) => !locked.includes(id)),
          ...(Array.isArray(event.targeterIDs) ? { lockedByIDs: event.targeterIDs } : {}),
          loaded: true,
        });
        break;
      }
      case "targeting/acquiring": {
        const prev = targeting.get();
        if (
          prev.acquiringTargetIDs.includes(event.targetID) ||
          prev.lockedTargetIDs.includes(event.targetID)
        ) {
          break;
        }
        targeting.set({
          ...prev,
          acquiringTargetIDs: [...prev.acquiringTargetIDs, event.targetID],
        });
        break;
      }
      case "targeting/action":
        // A successful action clears BOTH the stale refusal and the stale
        // silent-decline note — they describe the previous action, not this one.
        targeting.set({
          ...targeting.get(),
          lastAction: event.action,
          actionError: null,
          silentDecline: null,
        });
        break;
      case "targeting/action-error":
        targeting.set({ ...targeting.get(), actionError: event.message, actionErrorSaid: event.message !== null && event.said === true });
        break;
      case "targeting/silent-decline":
        targeting.set({ ...targeting.get(), silentDecline: event.message });
        break;
      case "targeting/cleared":
        targeting.set(INITIAL_TARGETING);
        break;
      // One `OnTarget` push, folded into the locked list so a lock is visible
      // the moment it completes rather than on the next `GetTargets` poll.
      //
      // ⚠ THE ACQUIRING NOTE IS RETIRED HERE TOO, on exactly the same rule
      // `targeting/targets` above applies: a lock that has ARRIVED is no longer
      // being acquired. Without this the page would go on saying "Locking…" for
      // a ship the server has just confirmed, until the next poll caught up --
      // which is precisely the tick of lag this event exists to remove.
      //
      // ⚠ AND A `lost` RETIRES IT AS WELL. An abandoned or refused lock is not
      // still being acquired either, and leaving the note would strand it: the
      // only other place it is cleared is a successful `targeting/targets`,
      // which by definition never names a target that failed to lock.
      case "targeting/lock-event": {
        const prev = targeting.get();
        const locked = applyTargetEvent(prev.lockedTargetIDs, event.event);
        const acquiring =
          event.event.kind === "cleared"
            ? []
            : prev.acquiringTargetIDs.filter((id) => id !== event.event.targetID);
        if (locked === prev.lockedTargetIDs && acquiring.length === prev.acquiringTargetIDs.length) {
          break;
        }
        targeting.set({ ...prev, lockedTargetIDs: locked, acquiringTargetIDs: acquiring });
        break;
      }
      // A ship locking this one, or letting it go (targetMgr.OnTargetByOther and its loss). An `OnTarget('clear')` of
      // the pilot's own locks leaves this list alone, as the client's OnTargetClear does.
      case "targeting/targeter-event": {
        const prev = targeting.get();
        const before = prev.lockedByIDs ?? [];
        const after = applyTargeterEvent(before, event.event);
        if (after !== before) {
          targeting.set({ ...prev, lockedByIDs: after });
        }
        break;
      }
      // --- R24 slice C: module cycle times ---------------------------------
      case "targeting/base-cycles": {
        // The base figure NEVER displaces one the server gave us. Attribute 73
        // is the type's starting point; an `OnGodmaShipEffect` duration is the
        // pilot's actual cycle. Downgrading the second to the first would be a
        // silent loss of accuracy on screen.
        const prev = targeting.get();
        const next: Record<number, ModuleCycle> = { ...prev.moduleCycles };
        for (const [key, ms] of Object.entries(event.cycles)) {
          const moduleID = Number(key);
          if (!(moduleID > 0) || ms === null || !(ms > 0)) {
            continue;
          }
          if (next[moduleID] && next[moduleID].source === "server") {
            continue;
          }
          next[moduleID] = {
            durationMs: ms,
            source: "base",
            startedAtMs: next[moduleID]?.startedAtMs ?? null,
            repeating: next[moduleID]?.repeating ?? false,
          };
        }
        targeting.set({ ...prev, moduleCycles: next });
        break;
      }
      case "targeting/cycle": {
        const prev = targeting.get();
        const existing = prev.moduleCycles[event.moduleID] ?? null;
        // A stop event tells us nothing new about the LENGTH, so keep whatever
        // we had; it only ends the running cycle.
        const durationMs =
          event.durationMs !== null && event.durationMs > 0
            ? event.durationMs
            : (existing?.durationMs ?? 0);
        if (!(durationMs > 0)) {
          break;
        }
        targeting.set({
          ...prev,
          moduleCycles: {
            ...prev.moduleCycles,
            [event.moduleID]: {
              durationMs,
              // A server figure, once seen, stays a server figure: the length
              // does not become less trustworthy when the module stops.
              source:
                event.durationMs !== null && event.durationMs > 0
                  ? "server"
                  : (existing?.source ?? "base"),
              startedAtMs: event.running ? event.observedAtMs : null,
              repeating: event.running ? event.repeating : false,
            },
          },
        });
        break;
      }
      case "targeting/damage": {
        const prev = targeting.get();
        targeting.set({
          ...prev,
          damageLog: [
            ...prev.damageLog,
            {
              // Position in the session's stream, used only as a render key.
              id: (prev.damageLog[prev.damageLog.length - 1]?.id ?? 0) + 1,
              direction: event.direction,
              otherPartyID: event.otherPartyID,
              weaponTypeID: event.weaponTypeID,
              amount: event.amount,
              quality: event.quality,
              atMs: event.atMs,
            },
          ].slice(-DAMAGE_LOG_LIMIT),
        });
        break;
      }
      // --- R23 slice B: the mining loop ------------------------------------
      case "mining/holds":
        // A clean read clears the panel-level error; each hold still carries
        // its OWN error, so one unreadable hold never blanks the rest.
        mining.set({ ...mining.get(), holds: event.holds, holdsLoaded: true, holdsError: null });
        break;
      case "mining/holds-error":
        mining.set({ ...mining.get(), holdsError: event.message });
        break;
      case "mining/survey":
        mining.set({
          ...mining.get(),
          survey: event.survey,
          surveyAtMs: event.atMs,
          surveyError: null,
        });
        break;
      case "mining/survey-error":
        mining.set({ ...mining.get(), surveyError: event.message });
        break;
      case "mining/quotes":
        mining.set({
          ...mining.get(),
          quotes: event.quotes,
          taxRate: event.taxRate,
          quotesFor: event.quotesFor,
          quotesError: null,
        });
        break;
      case "mining/quotes-error":
        // A failed quote must not leave the PREVIOUS quote on screen: the
        // player would arm a confirmation against numbers for other stacks.
        mining.set({
          ...mining.get(),
          quotes: INITIAL_MINING.quotes,
          taxRate: null,
          quotesFor: INITIAL_MINING.quotesFor,
          quotesError: event.message,
        });
        break;
      case "mining/action":
        mining.set({
          ...mining.get(),
          lastAction: event.action,
          actionError: null,
          silentDecline: null,
        });
        break;
      case "mining/action-error":
        mining.set({ ...mining.get(), actionError: event.message });
        break;
      case "mining/silent-decline":
        mining.set({ ...mining.get(), silentDecline: event.message });
        break;
      // --- R25 slice A: drones ---------------------------------------------
      //
      // Every one of these carries what the SERVER said, re-read after the
      // fact. Nothing here remembers what was clicked: the drone handlers
      // answer an empty dict on refusal, so this store's memory of a launch
      // would be a lie exactly when it mattered.
      case "drones/loaded":
        drones.set({
          ...drones.get(),
          bay: event.bay,
          inSpace: event.inSpace,
          limits: event.limits,
          loaded: true,
          error: null,
        });
        break;
      case "drones/error":
        drones.set({ ...drones.get(), error: event.message });
        break;
      case "drones/in-space":
        drones.set({ ...drones.get(), inSpace: event.inSpace });
        break;
      // A NEW order clears the LAST order's per-drone reasons along with the
      // two single slots. They describe the order that has just been replaced,
      // and leaving them up would attribute an old drone's refusal to a new
      // press (R34).
      case "drones/action":
        drones.set({
          ...drones.get(),
          lastAction: event.action,
          actionError: null,
          silentDecline: null,
          orderReports: [],
        });
        break;
      case "drones/action-error":
        drones.set({ ...drones.get(), actionError: event.message, actionErrorSaid: event.message !== null && event.said === true });
        break;
      case "drones/silent-decline":
        drones.set({ ...drones.get(), silentDecline: event.message });
        break;
      // R34 — the server's own per-drone reasons, REPLACED wholesale rather
      // than appended to. One order, one complete set of answers; merging two
      // orders' reports would leave a stale drone explaining a press it was
      // never part of.
      case "drones/order-reports":
        drones.set({ ...drones.get(), orderReports: event.reports });
        break;
      case "drones/cleared":
        drones.set(INITIAL_DRONES);
        break;
      case "mining/cleared":
        mining.set(INITIAL_MINING);
        drones.set(INITIAL_DRONES);
        break;
      // --- R28: the skill sheet and the training queue ------------------
      case "skills/loaded":
        skills.set({
          ...skills.get(),
          characterName: event.characterName,
          totalSkillPoints: event.totalSkillPoints,
          freeSkillPoints: event.freeSkillPoints,
          skills: event.skills,
          queue: event.queue,
          clockOffsetMs: event.clockOffsetMs,
          loaded: true,
          error: null,
        });
        break;
      case "skills/error":
        skills.set({ ...skills.get(), error: event.message });
        break;
      case "skills/action":
        skills.set({ ...skills.get(), lastAction: event.action, actionError: null });
        break;
      case "skills/action-error":
        skills.set({ ...skills.get(), actionError: event.message, actionErrorSaid: event.message !== null && event.said === true });
        break;
      case "skills/cleared":
        skills.set(INITIAL_SKILLS);
        break;
      // --- R41: planetary colonies --------------------------------------
      case "planets/loaded": {
        const previous = planets.get();
        // Keep the open colony open across a refresh, but only if it is still
        // there — a colony that has been abandoned must not stay selected.
        const stillThere = previous.selectedPlanetID !== null
          && event.colonies.some((colony) => colony.planetID === previous.selectedPlanetID);
        planets.set({
          ...previous,
          colonies: event.colonies,
          selectedPlanetID: stillThere ? previous.selectedPlanetID : null,
          clockOffsetMs: event.clockOffsetMs,
          loaded: true,
          error: null,
          // ⚠ The claim "you have no colonies" is made ONLY here, and only when
          // the gateway actually carried a colony table that held none of ours.
          hasNoColonies: event.coloniesReadable && event.colonies.length === 0,
        });
        break;
      }
      case "planets/error":
        planets.set({
          ...planets.get(),
          error: event.message,
          // A failed read tells us nothing about whether colonies exist.
          hasNoColonies: false,
        });
        break;
      case "planets/selected":
        planets.set({ ...planets.get(), selectedPlanetID: event.planetID });
        break;
      case "planets/cleared":
        planets.set(clearedPlanets(planets.get()));
        break;
      // The recipe table, read once and kept. It is not the player's data, so
      // it never arrives with a character and never leaves with one.
      case "planets/recipes":
        planets.set({ ...planets.get(), recipes: event.recipes });
        break;
      case "travel/planned":
        travel.set({
          ...INITIAL_TRAVEL,
          status: "running",
          destinationSystemID: event.destinationSystemID,
          destinationStationID: event.destinationStationID,
          destinationName: event.destinationName,
          route: [...event.route],
          remainingJumps: event.totalJumps,
          totalJumps: event.totalJumps,
          startedAt: event.startedAt,
        });
        break;
      case "travel/progress":
        travel.set({
          ...travel.get(),
          status: event.status,
          action: event.action,
          phase: event.phase,
          currentSystemID: event.currentSystemID,
          currentSystemName: event.currentSystemName,
          nextSystemID: event.nextSystemID,
          nextSystemName: event.nextSystemName,
          remainingJumps: event.remainingJumps,
          totalJumps: event.totalJumps,
          failureReason: event.failureReason,
        });
        break;
      case "travel/plan-error":
        travel.set({ ...travel.get(), status: "idle", failureReason: event.message });
        break;
      case "travel/cleared":
        travel.set(INITIAL_TRAVEL);
        break;
      // --- R26: the mining bot ------------------------------------------
      //
      // The loop lives in the browser and pushes its readout here; this slice
      // is a pure record of what it said. Nothing here decides anything.
      case "bot/started":
        bot.set({
          ...INITIAL_BOT,
          status: "running",
          beltName: event.beltName,
          stationName: event.stationName,
          startedAt: event.startedAt,
        });
        break;
      case "bot/progress":
        bot.set({
          ...bot.get(),
          status: event.status,
          phase: event.phase,
          action: event.action,
          why: event.why,
          rung: event.rung,
          step: event.step,
          rockName: event.rockName,
          cyclesCompleted: event.cyclesCompleted,
          oreUnitsMined: event.oreUnitsMined,
          holdUsed: event.holdUsed,
          holdCapacity: event.holdCapacity,
          failureReason: event.failureReason,
        });
        break;
      case "bot/start-error":
        bot.set({ ...bot.get(), status: "idle", startError: event.message });
        break;
      case "bot/cleared":
        bot.set(INITIAL_BOT);
        break;
      case "custom-bot/started":
        customBot.set({ ...INITIAL_CUSTOM_BOT, status: "running", name: event.name });
        break;
      case "custom-bot/progress":
        customBot.set({
          ...customBot.get(),
          status: event.status,
          phase: event.phase,
          why: event.why,
          stepPath: event.stepPath,
          interruptID: event.interruptID,
          pauseReason: event.pauseReason,
          note: event.note ?? null,
          refusals: event.refusals ?? [],
        });
        break;
      case "custom-bot/alert":
        // Kept on the slice (not just shown once) so a player who was away still
        // finds it, and so the server-bot host can fold it onto the bot's record.
        customBot.set({
          ...customBot.get(),
          lastAlert: { message: event.message, atMs: event.atMs },
        });
        break;
      case "custom-bot/start-error":
        customBot.set({ ...customBot.get(), status: "idle", startError: event.message });
        break;
      case "custom-bot/cleared":
        customBot.set(INITIAL_CUSTOM_BOT);
        break;
      // --- R36: the distribution-mission bot ----------------------------
      //
      // Same construction as the mining bot above and for the same reason: the
      // loop lives in the browser and pushes its readout here, and this slice
      // records it without deciding anything.
      case "mission-bot/started":
        missionBot.set({
          ...INITIAL_MISSION_BOT,
          status: "running",
          agentName: event.agentName,
          destinationName: event.stationName,
          startedAt: event.startedAt,
        });
        break;
      case "mission-bot/progress":
        missionBot.set({
          ...missionBot.get(),
          status: event.status,
          phase: event.phase,
          action: event.action,
          why: event.why,
          agentName: event.agentName,
          missionName: event.missionName,
          cargoText: event.cargoText,
          destinationName: event.destinationName,
          jumpsRemaining: event.jumpsRemaining,
          missionsCompleted: event.missionsCompleted,
          iskEarned: event.iskEarned,
          lpEarned: event.lpEarned,
          caution: event.caution,
          failureReason: event.failureReason,
        });
        break;
      case "mission-bot/start-error":
        missionBot.set({ ...missionBot.get(), status: "idle", startError: event.message });
        break;
      case "mission-bot/cleared":
        missionBot.set(INITIAL_MISSION_BOT);
        break;
      // The fleet companion. Same construction as the two bots above: the loop
      // decides, this slice records.
      case "companion/started":
        companion.set({
          ...INITIAL_FLEET_COMPANION,
          status: "running",
            startedAt: event.startedAt,
          fitWarnings: event.fitWarnings,
        });
        break;
      case "companion/progress":
        companion.set({
          ...companion.get(),
          status: event.status,
          phase: event.phase,
          action: event.action,
          why: event.why,
            inFleet: event.inFleet,
          followingOrderFrom: event.followingOrderFrom,
          lastOrderHeard: event.lastOrderHeard,
          targetMode: event.targetMode,
          canTag: event.canTag,
          abandonment: event.abandonment,
          failureReason: event.failureReason,
          selfPaused: event.selfPaused,
        });
        break;
      case "companion/start-error":
        companion.set({ ...companion.get(), status: "idle", startError: event.message });
        break;
      case "companion/cleared":
        companion.set(INITIAL_FLEET_COMPANION);
        break;
      case "chat/loaded": {
        const current = chat.get();
        chat.set({
          ...current,
          [event.channel]: event.channelState,
          // A successful read clears any stale read/send error.
          error: null,
        });
        break;
      }
      case "chat/active":
        chat.set({ ...chat.get(), activeChannel: event.channel });
        break;
      case "chat/error":
        chat.set({ ...chat.get(), error: event.message });
        break;
      case "chat/cleared":
        chat.set(INITIAL_CHAT);
        break;
      // R10 — a live-pushed message. The safety-net poll and the push channel
      // both deliver the same backlog entries, so an append that duplicates a
      // message already present is dropped: a message is identified by its
      // author, text, and timestamp (the gateway backlog entry has no ID).
      case "chat/message": {
        const current = chat.get();
        const channelState = current[event.channel];
        const incoming = event.message;
        const duplicate = channelState.messages.some(
          (existing) =>
            existing.createdAtMs === incoming.createdAtMs &&
            existing.characterID === incoming.characterID &&
            existing.message === incoming.message,
        );
        if (duplicate) {
          break;
        }
        const messages = [...channelState.messages, incoming];
        chat.set({
          ...current,
          [event.channel]: {
            ...channelState,
            messages: messages.slice(-CHAT_BACKLOG_LIMIT),
            // A live message proves the channel exists even before its first
            // read completes.
            loaded: true,
          },
        });
        break;
      }
      // R10 — the live push channel's own state.
      case "live/status":
        live.set({ ...live.get(), status: event.status });
        break;
      case "live/notification": {
        const current = live.get();
        live.set({
          ...current,
          status: "live",
          epoch: event.epoch ?? current.epoch,
          sequence: event.sequence,
          notifications: [...current.notifications, event.notification].slice(
            -LIVE_NOTIFICATION_LIMIT,
          ),
          lastEventAtMs: event.notification.receivedAtMs,
        });
        break;
      }
      // The gateway could not replay from the held cursor. Adopt the new cursor
      // and drop the buffered tail: continuing to show it would imply a
      // continuity the stream just told us it cannot provide.
      case "live/resynchronize": {
        const current = live.get();
        live.set({
          ...current,
          epoch: event.epoch ?? current.epoch,
          sequence: event.sequence,
          notifications: Object.freeze([]) as LiveState["notifications"],
          // A question may have closed in the gap; one that did not is asked again by nobody,
          // so it is dropped here and its answer route would say it was gone.
          questions: Object.freeze([]) as LiveState["questions"],
        });
        break;
      }
      case "live/question": {
        const current = live.get();
        live.set({
          ...current,
          status: "live",
          epoch: event.epoch ?? current.epoch,
          sequence: event.sequence,
          questions: [...current.questions.filter((question) => question.id !== event.question.id), event.question],
        });
        break;
      }
      case "live/question-closed": {
        const current = live.get();
        live.set({
          ...current,
          epoch: event.epoch ?? current.epoch,
          sequence: event.sequence ?? current.sequence,
          questions: current.questions.filter((question) => question.id !== event.id),
        });
        break;
      }
      case "live/cleared":
        live.set(INITIAL_LIVE);
        break;
      case "names/resolved": {
        // Merge the freshly-resolved batch into the names cache (static
        // reference data — a name only ever gets more resolved, never cleared).
        const current = names.get();
        names.set({ ...current, resolved: { ...current.resolved, ...event.entries } });
        break;
      }
      case "names/autopilot-jumps": {
        const current = names.get();
        names.set({ ...current, autopilotJumps: { ...current.autopilotJumps, ...event.jumps } });
        break;
      }
      case "names/autopilot-jumps-cleared":
        names.set({ ...names.get(), autopilotJumps: INITIAL_NAMES.autopilotJumps });
        break;
      case "names/system-security": {
        const current = names.get();
        names.set({ ...current, systemSecurity: { ...current.systemSecurity, ...event.security } });
        break;
      }
      case "words/loaded": {
        const current = words.get();
        words.set({ available: event.available, templates: { ...current.templates, ...event.templates } });
        break;
      }
    }
  };

  /**
   * Which bot holds the ship, recomputed from the loops themselves (goal R43).
   *
   * ⚠ THE READER RECORD IS THE POINT. `Record<BotID, …>` is exhaustive, so a
   * fourth bot cannot be added to the union without the compiler demanding its
   * status reader here — the running-bot readout picks it up on the day it
   * lands, rather than silently reporting "nothing is running" while it flies
   * the ship. `SHIP_CONTROLLER_IDS` gives the order, so a tie (which the ship
   * claim makes impossible) still resolves the same way every time.
   */
  const botStatus: Readonly<Record<ShipControllerID, () => string>> = {
    mining: () => bot.get().status,
    mission: () => missionBot.get().status,
    companion: () => companion.get().status,
    custom: () => customBot.get().status,
  };

  const syncBotClaim = (): void => {
    const holder = SHIP_CONTROLLER_IDS.find((id) => holdsTheShip(botStatus[id]())) ?? null;
    if (bots.get().runningBotID !== holder) {
      bots.set({ runningBotID: holder });
    }
  };

  const apply = (event: FeedEvent): void => {
    reduce(event);
    // ⚠ AFTER EVERY EVENT, not inside the eight bot cases. A per-case call is a
    // line each new bot has to remember; this one cannot be forgotten, and it
    // is a pair of status reads with an equality guard, so it costs nothing.
    syncBotClaim();
    bump();
  };

  // --- Feed attachment -----------------------------------------------------

  let activeDetach: Unsubscribe | null = null;

  const attachFeed = (adapter: FeedAdapter): Unsubscribe => {
    if (activeDetach) {
      activeDetach();
    }

    let attached = true;
    const sink: FeedSink = {
      publish(event) {
        if (attached) {
          apply(event);
        }
      },
      setStatus(status) {
        if (attached || status === "disconnected") {
          feed.set({ adapter: adapter.name, status });
          bump();
        }
      },
    };

    const detach = (): void => {
      if (!attached) {
        return;
      }
      attached = false;
      if (activeDetach === detach) {
        activeDetach = null;
      }
      adapter.stop();
    };

    activeDetach = detach;
    feed.set({ adapter: adapter.name, status: "connecting" });
    bump();
    adapter.start(sink);
    return detach;
  };

  const subscribe = (listener: (state: ClientState) => void): Unsubscribe =>
    version.subscribe(() => listener(get()));

  return {
    session: readonlySignal(session),
    character: readonlySignal(character),
    station: readonlySignal(station),
    inventory: readonlySignal(inventory),
    fitting: readonlySignal(fitting),
    dogma: readonlySignal(dogma),
    industry: readonlySignal(industry),
    market: readonlySignal(market),
    mail: readonlySignal(mail),
    activity: readonlySignal(activity),
    fleet: readonlySignal(fleet),
    scanner: readonlySignal(scanner),
    contracts: readonlySignal(contracts),
    assets: readonlySignal(assets),
    agents: readonlySignal(agents),
    finder: readonlySignal(finder),
    rewards: readonlySignal(rewards),
    addressBook: readonlySignal(addressBook),
    wallet: readonlySignal(wallet),
    standings: readonlySignal(standings),
    characterSheet: readonlySignal(characterSheet),
    flight: readonlySignal(flight),
    space: readonlySignal(space),
    targeting: readonlySignal(targeting),
    mining: readonlySignal(mining),
    drones: readonlySignal(drones),
    skills: readonlySignal(skills),
    planets: readonlySignal(planets),
    travel: readonlySignal(travel),
    bot: readonlySignal(bot),
    missionBot: readonlySignal(missionBot),
    companion: readonlySignal(companion),
    customBot: readonlySignal(customBot),
    bots: readonlySignal(bots),
    chat: readonlySignal(chat),
    live: readonlySignal(live),
    names: readonlySignal(names),
    words: readonlySignal(words),
    feed: readonlySignal(feed),
    health: readonlySignal(health),
    get,
    subscribe,
    apply,
    attachFeed,
  };
}
