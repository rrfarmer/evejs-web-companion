import type { ChargeFitment } from "../bridge/fitting.ts";
// Feed adapter seam (goal R1b, roadmap section 5).
//
// The client-state store is fed by whatever event transport exists at the
// time: initially the legacy sequenced WS event stream
// (public/eventClient.js), transitioning to bridge-forwarded session
// notifications (roadmap section 9 / G6) as the legacy machinery retires. The
// store never sees the transport — an adapter normalizes whichever wire
// events it speaks into `FeedEvent`s and reports connectivity via `FeedSink`.
// Swapping the transport means swapping the adapter; the store, the UI
// readers, and (later) the autopilot loop are unchanged.
//
// R1b ships the interface plus an in-memory adapter (tests and the scaffold
// smoke page). The legacy-WS adapter and the bridge-notification adapter are
// R2+ work and implement this same interface.

import type {
  ActivityCalendarEventRow,
  BotRefusal,
  ActivityCalendarResponseRow,
  ActivityNotificationRow,
  ActivityRead,
  AgentConversation,
  AgentFinderRow,
  AgentFinderTarget,
  AgentRow,
  ChatChannel,
  ChatChannelState,
  ChatMessage,
  CharacterSummary,
  CharStanding,
  Colony,
  CorpDivisionState,
  CourierBriefing,
  FlightStatus,
  DroneBayStack,
  DroneInSpace,
  DroneLimits,
  DroneOrderReport,
  MiningHold,
  ReprocessingQuote,
  SkillRow,
  SkillQueueState,
  SurveyResult,
  FittingResources,
  FittingSlot,
  FleetAction,
  ScannerCenterState,
  IndustryBlueprintRow,
  IndustryDefinition,
  IndustryFacilityRow,
  IndustryJobRow,
  IndustrySlotUsage,
  MarketActionOutcome,
  MarketEscrow,
  MarketOrderRow,
  MarketOwnOrderRow,
  MarketPriceHistoryRow,
  MarketTransactionRow,
  MailActionOutcome,
  MailHeaderRow,
  MailOpenMessage,
  MailStatusRow,
  ContractDetail,
  ContractRow,
  ContractSummary,
  AssetItemRow,
  AssetStationRow,
  InventoryContainerState,
  JournalState,
  ClientQuestion,
  LiveNotification,
  LiveStreamStatus,
  MutationOutcome,
  OnlineCharacterState,
  OpenContainerState,
  ShipBay,
  GateLink,
  SpaceSnapshot,
  StationGuest,
  StationOffices,
  StationServiceBits,
  StationStatic,
  MiningBotRunState,
  TravelRouteStep,
  TravelStatus,
  WalletLPBalance,
  CorpWalletDivision,
  LedgerEntry,
  StandingComposition,
  StandingTransaction,
  CharacterIdentity,
  CloneSummary,
  FleetJumpBeacon,
} from "./types.ts";
import type { BoundDogmaAllInfo } from "../bridge/boundDogma.ts";
import type { SkillHistoryLine } from "../bridge/skillHistoryPanel.ts";
import type { EmploymentHistory } from "../bridge/employmentHistory.ts";
import type { SkillNotification } from "../bridge/skillNotifications.ts";
import type { MailLabel, MailingList } from "../bridge/mail.ts";
import type { BoundFleet } from "../bridge/boundFleet.ts";
import type { FleetBroadcast } from "../bridge/fleetBroadcasts.ts";
import type { JamEvent } from "../bridge/jamNotifications.ts";
import type { PiRecipeBook } from "../bridge/piRecipes.ts";
import type { TargetEvent, TargeterEvent } from "../bridge/targetNotifications.ts";
import type { FleetAvailability, FleetPendingInvite } from "../bridge/fleetCenter.ts";
import type { ShipStats } from "../bridge/shipStats.ts";
import type { CrimewatchReading } from "../space/crimewatch.ts";
import type { CloneGrade } from "../bridge/cloneGrade.ts";
import type { MiningRungID, MiningStepID } from "../nav/miningLadder.ts";
import type {
  CompanionAbandonmentRecord,
  CompanionOrderAuthority,
  FleetCompanionRunState,
} from "../nav/fleetCompanionLoop.ts";

export type FeedStatus = "idle" | "connecting" | "connected" | "disconnected";

/**
 * Normalized store events. Transport-agnostic: a legacy WS payload or a
 * bridge-forwarded session notification must be mapped into one of these by
 * its adapter before it reaches the store. The union grows page by page on
 * the R2-R6 rail (inventory, journal, space, ... slices arrive with their
 * pages).
 */
/** Server reachability as the login screen sees it: unknown until the boot
 * health ping answers, then online (BFF up + gateway runtime ready) or offline. */
export type HealthStatus = "unknown" | "online" | "offline";

export type FeedEvent =
  | { readonly type: "health/status"; readonly status: HealthStatus }
  // `accountCreated` (R2): true when this login auto-created the account on
  // the server, so the UI can say so. Optional — absent means an ordinary
  // sign-in to an existing account.
  | { readonly type: "session/logged-in"; readonly accountID: number; readonly username: string; readonly accountCreated?: boolean }
  | { readonly type: "session/logged-out" }
  | { readonly type: "character/list"; readonly characters: readonly CharacterSummary[] }
  | { readonly type: "character/selected"; readonly characterID: number | null }
  // Goal R2 — the persistent browser-backed session and its docked entry:
  // a character came online (select-character succeeded) with its client-local
  // static station identity...
  | {
      readonly type: "character/online";
      readonly character: OnlineCharacterState;
      readonly station: StationStatic | null;
    }
  // ...or went offline (release, TTL expiry, session lost).
  | { readonly type: "character/offline" }
  // The client's online status service primed (GetInitialState), and a watched contact logged on or off
  // (OnContactLoggedOn, OnContactLoggedOff).
  | { readonly type: "address-book/online-primed"; readonly online: Readonly<Record<number, boolean>> }
  | { readonly type: "address-book/online-changed"; readonly contactID: number; readonly online: boolean }
  // The session's corporation, alliance or corporation roles changed (OnSessionChanged: corpid, allianceid,
  // corprole), each given where it changed, as the client's session takes them.
  | {
      readonly type: "character/session-changed";
      readonly corporationID?: number | null;
      readonly allianceID?: number | null;
      readonly corpRole?: string | null;
      readonly corpAccountKey?: number | null;
      readonly role?: string | null;
    }
  // Goal R6b — the docked station changed on the SAME live session (autopilot
  // arrival / manual dock), learned from a flight-status snapshot. Re-points the
  // docked identity (online station/system + static station identity) and clears
  // the previous station's panel reads so the flow's re-fetch repopulates them.
  | {
      readonly type: "station/relocated";
      readonly stationID: number | null;
      readonly structureID?: number | null;
      readonly solarSystemID: number | null;
      readonly station: StationStatic | null;
    }
  // Docked station-panel reads on the live session.
  | { readonly type: "station/bits"; readonly bits: StationServiceBits }
  | { readonly type: "station/structure-services"; readonly serviceIDs: readonly number[] | null }
  | { readonly type: "station/guests"; readonly guests: readonly StationGuest[] }
  // The lobby's offices, once the player has asked for them listed.
  | { readonly type: "station/offices"; readonly offices: StationOffices }
  // One or more docked reads failed non-fatally:
  // surfaced so the panel shows the reason instead of a perpetual "Loading…".
  // A null message clears the error after a clean refresh.
  | { readonly type: "station/read-error"; readonly message: string | null }
  // Goal R3 — the Inventory & Ship page (bound-object bridge). A full panel
  // load: the docked station hangar and the active ship's cargo, each already
  // decoded (its own error preserved, so one failed container never blanks the
  // other).
  | {
      readonly type: "inventory/loaded";
      readonly stationID: number | null;
      readonly structureID?: number | null;
      readonly activeShipID: number | null;
      readonly hangar: InventoryContainerState;
      readonly cargo: InventoryContainerState;
    }
  // A mutation (move/stack/board) failed; null clears the error after success.
  | { readonly type: "inventory/action-error"; readonly message: string | null; readonly said?: boolean }
  // Drop the inventory state (character offline / logged out).
  | { readonly type: "inventory/cleared" }
  // Goal R14 — the items ticked for a bulk move or trash. Replaces the whole
  // selection; an empty list clears it.
  | { readonly type: "inventory/selection"; readonly itemIDs: readonly number[] }
  // A container was opened (its contents decoded) or closed (null).
  | {
      readonly type: "inventory/container";
      readonly container: OpenContainerState | null;
    }
  // The corporation hangar was read: which divisions exist, what they are
  // CALLED, and what is in each. A division the character cannot query simply
  // reads empty — the server stays authoritative.
  | {
      readonly type: "inventory/corp-loaded";
      readonly available: boolean;
      readonly reason: string | null;
      readonly divisions: readonly CorpDivisionState[];
    }
  // Which corporation division the panel is showing.
  | { readonly type: "inventory/corp-division"; readonly division: number }
  // What the last mutation ACTUALLY did, re-read from the server. Null clears
  // the report before the next action.
  | {
      readonly type: "inventory/outcome";
      readonly outcome: MutationOutcome | null;
    }
  // Goal R40 — which ship the Ships card has expanded. `itemID: null` collapses
  // it. Opening a ship does NOT carry its bays: those arrive separately, so the
  // card can say "looking…" instead of showing an empty hull.
  | {
      readonly type: "inventory/ship-open";
      readonly itemID: number | null;
      readonly typeID: number;
    }
  // The bays that ship turned out to have. Each bay carries its own three-valued
  // `present` and its own error, so one unreadable bay never blanks the rest —
  // and an absent bay is never mistaken for an empty one.
  | {
      readonly type: "inventory/ship-bays";
      readonly itemID: number;
      readonly bays: readonly ShipBay[];
      readonly error: string | null;
    }
  // Goal R12 — the Fitting page. A full panel load: the active ship's slots by
  // family with what is fitted in each, plus its CPU / powergrid / capacitor /
  // calibration readings. The two reads are independent on the BFF, so each
  // carries its own error and one failure never blanks the other.
  | {
      readonly type: "fitting/loaded";
      readonly activeShipID: number | null;
      readonly slots: readonly FittingSlot[];
      readonly resources: FittingResources;
      /** The ship's attributes by ID, that `resources` and `stats` were made of. */
      readonly shipAttributes?: Readonly<Record<number, number | null>>;
      /** R21 — the derived statistics, from the same attribute map. */
      readonly stats: ShipStats;
      /**
       * Per-module-type charge fitment, for SORTING the ammo picker. Advisory
       * only — the server decides what actually loads, so this never filters.
       */
      readonly chargeFits?: Readonly<Record<number, ChargeFitment>>;
      readonly slotsError: string | null;
      readonly resourcesError: string | null;
    }
  // The server told of the active ship's attributes changing (OnModuleAttributeChange, its batch, or an
  // OnMultiEvent): the attributes as they are now, and the figures made of them again.
  | {
      readonly type: "fitting/ship-attributes";
      readonly shipID: number;
      readonly shipAttributes: Readonly<Record<number, number | null>>;
      readonly resources: FittingResources;
      readonly stats: ShipStats;
    }
  // The Fitting window's figures as the page's own dogma reckons the active ship (flow.reckonActiveShip).
  | {
      readonly type: "fitting/reckoned";
      readonly shipID: number;
      readonly resources: FittingResources;
      readonly stats: ShipStats;
    }
  // The Fitting window's simulation of the active ship: its figures and its modules' states (flow.showSimulation).
  | {
      readonly type: "fitting/simulated";
      readonly shipID: number | null;
      readonly shipTypeID: number;
      readonly name: string | null;
      readonly resources: FittingResources;
      readonly stats: ShipStats;
      readonly moduleStates: Readonly<Record<number, number>>;
      readonly moduleKinds: Readonly<Record<number, number>>;
      readonly slots: readonly FittingSlot[];
      readonly drones: readonly { readonly typeID: number; readonly total: number; readonly active: number }[];
    }
  // The simulation left (flow.exitSimulation).
  | { readonly type: "fitting/simulation-ended" }
  // R21 slice B — the bound-dogma snapshot that accompanies the fit: the active
  // ship and every fitted module with the SERVER's post-dogma attributes. Its
  // own event because it rides a SEPARATE read that is a companion to the fit,
  // never a gate on it: a failure carries `allInfo: null` plus its reason and
  // leaves the slots and resource bars exactly as they were.
  | {
      readonly type: "dogma/loaded";
      readonly allInfo: BoundDogmaAllInfo | null;
      readonly error: string | null;
    }
  // A fitting action (fit/unfit/online/offline/destroy) failed or was declined;
  // null clears the error after a clean action.
  | { readonly type: "fitting/action-error"; readonly message: string | null; readonly said?: boolean }
  // Round counts the server pushed as guns fired (`OnModuleAttributeChanges`).
  | {
      readonly type: "fitting/charge-quantity";
      readonly changes: readonly import("../bridge/reloadNotifications.ts").ChargeQuantityChange[];
    }
  // The server announced a reload (`OnChargeBeingLoadedToModule`).
  | {
      readonly type: "fitting/reload-started";
      readonly moduleIDs: readonly number[];
      readonly chargeTypeID: number | null;
      readonly durationMs: number;
      readonly atMs: number;
    }
  // Drop the fitting state (character offline / logged out).
  | { readonly type: "fitting/cleared" }
  // R21 slice B — the bound-dogma snapshot (active ship + fitted modules with
  // their SERVER-effective attributes), loaded alongside the fitting slice. A
  // failed read carries its own error and never blanks the fit.
  | {
      readonly type: "dogma/loaded";
      readonly allInfo: BoundDogmaAllInfo | null;
      readonly error: string | null;
    }
  // Drop the dogma snapshot (character offline / logged out).
  | { readonly type: "dogma/cleared" }
  // Goal R15 — the Industry page. A full panel load: the player's blueprints
  // with their efficiencies and runs, their jobs with the status the SERVER
  // computed, how many job slots each activity is using, and the facilities
  // their region offers. The five reads are independent on the BFF, so each
  // carries its own error and one failure never blanks the rest.
  | {
      readonly type: "industry/loaded";
      readonly ownerID: number | null;
      readonly stationID: number | null;
      readonly solarSystemID: number | null;
      readonly blueprints: readonly IndustryBlueprintRow[];
      readonly jobs: readonly IndustryJobRow[];
      readonly facilities: readonly IndustryFacilityRow[];
      readonly slotsUsed: IndustrySlotUsage;
      readonly blueprintsError: string | null;
      readonly jobsError: string | null;
      readonly facilitiesError: string | null;
    }
  // Static blueprint recipes, merged in after the live read named the types.
  | {
      readonly type: "industry/definitions";
      readonly definitions: Readonly<Record<number, IndustryDefinition | null>>;
    }
  // An industry action (install/deliver/cancel) failed or was declined; null
  // clears the error after a clean action.
  | { readonly type: "industry/action-error"; readonly message: string | null; readonly said?: boolean }
  // The server's word of what a monitored job's place has (OnIndustryMaterials).
  | {
      readonly type: "industry/materials-said";
      readonly monitorID: number;
      readonly available: Readonly<Record<string, number>>;
    }
  // Drop the industry state (character offline / logged out).
  | { readonly type: "industry/cleared" }
  // Goal R16 — the Market page. One event carries all six reads; each keeps
  // its own error so a failed public order book never hides the player's own
  // orders, and `marketUnavailable` distinguishes "the market daemon is not
  // answering" from "nobody is trading this item".
  | {
      readonly type: "market/loaded";
      readonly typeID: number | null;
      readonly stationID: number | null;
      /** The structure the pilot is docked in; left out or null where it is in none. */
      readonly structureID?: number | null;
      readonly solarSystemID: number | null;
      /** The broker's fee rate the pilot pays where it is docked; left out or null where it is not known. */
      readonly brokersFeeRate?: number | null;
      readonly sells: readonly MarketOrderRow[];
      readonly buys: readonly MarketOrderRow[];
      readonly ownOrders: readonly MarketOwnOrderRow[];
      readonly orderHistory: readonly MarketOwnOrderRow[];
      readonly transactions: readonly MarketTransactionRow[];
      readonly escrow: MarketEscrow | null;
      readonly priceHistory: readonly MarketPriceHistoryRow[];
      readonly cashBalance: string | null;
      readonly bookError: string | null;
      readonly ownOrdersError: string | null;
      readonly transactionsError: string | null;
      readonly marketUnavailable: string | null;
    }
  // A market write failed or was declined; null clears the error.
  | { readonly type: "market/action-error"; readonly message: string | null; readonly said?: boolean }
  // What the last write ACTUALLY did, assembled from re-reads (never a
  // prediction, and never the estimated fee shown at confirm time).
  | { readonly type: "market/outcome"; readonly outcome: MarketActionOutcome | null }
  // The pilot's escrow as the client's market progression keeps it (flow.watchMarketProgression).
  | { readonly type: "market/escrow"; readonly escrow: MarketEscrow | null }
  // Drop the market state (character offline / logged out).
  | { readonly type: "market/cleared" }
  // Read-only Activity Center. Each bridge arm keeps its own ready / empty /
  // unavailable / error state, so a partial aggregate response stays useful.
  | { readonly type: "activity/loading" }
  | {
      readonly type: "activity/loaded";
      readonly notifications: ActivityRead<readonly ActivityNotificationRow[]>;
      readonly unprocessedCount: ActivityRead<number>;
      readonly calendarEvents: ActivityRead<readonly ActivityCalendarEventRow[]>;
      readonly calendarResponses: ActivityRead<readonly ActivityCalendarResponseRow[]>;
      // The skill history's notifications; where a reading says nothing of them, they are not to be had in it.
      readonly skillNotifications?: ActivityRead<readonly SkillNotification[]>;
      readonly mailError: string | null;
      readonly refreshedAtMs: number;
    }
  | { readonly type: "activity/cleared" }
  // Fleet Center. The read uses the dedicated session-scoped bound-fleet BFF
  // route; every consequential write is confirmed in the panel and followed by
  // another authoritative read before the action settles.
  | { readonly type: "fleet/loading" }
  | {
      readonly type: "fleet/loaded";
      readonly availability: FleetAvailability;
      readonly fleet: BoundFleet;
      readonly readError: string | null;
      readonly refreshedAtMs: number;
    }
  | { readonly type: "fleet/action-started"; readonly action: FleetAction }
  | { readonly type: "fleet/action-finished"; readonly error: string | null; readonly said?: boolean }
  | { readonly type: "fleet/pending-invite"; readonly invite: FleetPendingInvite }
  | { readonly type: "fleet/watchlist"; readonly members: readonly number[] }
  | { readonly type: "fleet/jump-beacon"; readonly characterID: number; readonly beacon: FleetJumpBeacon | null }
  | { readonly type: "fleet/broadcast-history-cleared" }
  // An invitation answered or turned down: the window's no longer, where it is the one held.
  | { readonly type: "fleet/invite-settled"; readonly fleetID: number }
  // A one-shot fleet call (OnFleetBroadcast). Pure push-to-store, same shape
  // as fleet/pending-invite: last-write-wins, no reducer-side interpretation.
  | { readonly type: "fleet/broadcast"; readonly broadcast: FleetBroadcast }
  // The standing itemID -> tag dict from OnFleetStateChange. `tags` is
  // whatever decodeFleetStateChangeNotification produced — an empty map is a
  // legitimate "received, nothing tagged" answer, not "not received".
  | { readonly type: "fleet/target-tags"; readonly tags: ReadonlyMap<number, string> }
  | { readonly type: "fleet/cleared" }
  // Scanner / Exploration Center. Both reads are independent; a failed scan is
  // unknown, never a successful empty current system.
  | { readonly type: "scanner/loading" }
  | {
      readonly type: "scanner/loaded";
      readonly solarSystemID: number | null;
      readonly scan: ScannerCenterState["scan"];
      readonly operations: ScannerCenterState["operations"];
      readonly refreshedAtMs: number;
    }
  | { readonly type: "scanner/cleared" }
  // The probe scanner's results for the session's system, as its scan handler keeps them (bridge/probeResults.ts).
  | { readonly type: "scanner/probe-results"; readonly probeResults: ScannerCenterState["probeResults"] }
  // Goal R17 (Slice A) — the Mail page. The inbox is a DELTA SYNC cold-started
  // by the BFF, so `messages` is always the WHOLE mailbox rather than a page of
  // it: the browser caches nothing across a page load and therefore holds no
  // window to sync against.
  | {
      readonly type: "mail/loaded";
      readonly messages: readonly MailHeaderRow[];
      readonly statuses: readonly MailStatusRow[];
      readonly unreadCount: number;
      readonly inboxError: string | null;
    }
  // One message opened. The body is already plain TEXT — the BFF inflated the
  // zlib buffer mailMgr.GetBody answers.
  | { readonly type: "mail/opened"; readonly open: MailOpenMessage | null }
  // A mail action failed or was declined; null clears the error.
  | { readonly type: "mail/action-error"; readonly message: string | null; readonly said?: boolean }
  // What a send ACTUALLY did, from a re-read of the sender's own mailbox.
  | { readonly type: "mail/outcome"; readonly outcome: MailActionOutcome | null }
  // Drop the mail state (character offline / logged out).
  | { readonly type: "mail/cleared" }
  // The pilot's own labels, as the mail service keeps them (mailSvc.GetLabels; a label made elsewhere added).
  | { readonly type: "mail/labels"; readonly labels: readonly MailLabel[] }
  // The mailing lists joined, as the mailing lists service keeps them (GetJoinedLists; its notices).
  | { readonly type: "mail/lists"; readonly lists: readonly MailingList[] }
  | { readonly type: "mail/external-list"; readonly list: MailingList }
  // Goal R17 (Slice B) — the Contracts page. READS ONLY: every contract mutator
  // is refused at the gateway, so there is no action event here. Each read
  // keeps its own error, so a public browse that failed never hides the
  // player's own contracts.
  | {
      readonly type: "contracts/loaded";
      readonly browse: readonly ContractRow[];
      readonly numFound: number;
      readonly page: number;
      readonly pageSize: number;
      readonly outstanding: readonly ContractRow[];
      readonly accepted: readonly ContractRow[];
      readonly expired: readonly ContractRow[];
      // Contracts someone else reserved for this character. They appear in NO
      // other list -- not the browse (public only), not `outstanding` (what you
      // issued), not `accepted` (what you took on) -- so without these the
      // summary's "waiting for you" count refers to nothing on the page.
      readonly assigned: readonly ContractRow[];
      readonly numAssigned: number;
      readonly summary: ContractSummary | null;
      readonly browseError: string | null;
      readonly mineError: string | null;
      readonly assignedError: string | null;
      // ⚠ True ONLY when the browse SUCCEEDED and found nothing. EveJS has no
      // contract generator, so that is expected — and it must never be
      // confused with a browse that failed.
      readonly worldHasNoContracts: boolean;
    }
  // One contract opened in full; null closes it.
  | { readonly type: "contracts/detail"; readonly detail: ContractDetail | null }
  | { readonly type: "contracts/detail-error"; readonly message: string | null }
  // Taking a contract on. `contractID` while the write is in flight, null once
  // it has settled either way -- a second click must not fire a second
  // irreversible transfer.
  | { readonly type: "contracts/accepting"; readonly contractID: number | null }
  // The write landed. `contractID` is what the server said it accepted.
  | { readonly type: "contracts/accepted"; readonly contractID: number }
  // The server refused, in the words it used.
  | { readonly type: "contracts/accept-error"; readonly message: string | null }
  // Drop the contracts state (character offline / logged out).
  | { readonly type: "contracts/cleared" }
  // Goal R37 — the Personal Assets page (charMgr global assets). READS ONLY:
  // the bound global-assets object implements no write at all.
  | {
      readonly type: "assets/loaded";
      readonly stations: readonly AssetStationRow[];
      readonly error: string | null;
      // ⚠ True ONLY when ListStations SUCCEEDED and was empty. "You own
      // nothing anywhere" and "that read failed" must never look alike.
      readonly ownsNothing: boolean;
    }
  // One station's contents, from expanding it.
  | {
      readonly type: "assets/station-items";
      readonly stationID: number;
      readonly items: readonly AssetItemRow[];
      readonly hasNoItems: boolean;
      readonly error: string | null;
    }
  // Which station is open; null collapses it. Touches no server.
  | { readonly type: "assets/expanded"; readonly stationID: number | null }
  // Drop the assets state (character offline / logged out).
  | { readonly type: "assets/cleared" }
  // Goal R4 — the Agents & Missions page (agentMgr bridge). The station's
  // agent roster (decoded + filtered to the docked station by the BFF).
  | { readonly type: "agents/list"; readonly stationID: number | null; readonly agents: readonly AgentRow[] }
  // An open agent conversation: what the agent says + the action buttons.
  | {
      readonly type: "agents/conversation";
      readonly agentID: number;
      readonly conversation: AgentConversation;
    }
  // The conversation is closed, and what was laid out beside it goes with it.
  | { readonly type: "agents/conversation-closed" }
  // A mission's keywords, as its agent gave them (kept by "<agentID>:<contentID>").
  | {
      readonly type: "agents/mission-keywords";
      readonly key: string;
      readonly keywords: Readonly<Record<string, unknown>>;
    }
  // The accepted-courier briefing (null clears it, e.g. after a decline).
  | { readonly type: "agents/briefing"; readonly briefing: CourierBriefing | null }
  // The mission's objectives read for this layout (null with no mission, or when the client shows none).
  | { readonly type: "agents/objectives"; readonly objectives: import("../bridge/missionObjectives.ts").MissionObjectives | null }
  // What the briefing read for this layout says of the mission's time (null with no briefing).
  | { readonly type: "agents/mission-times"; readonly times: import("../bridge/missionTime.ts").MissionTimes | null }
  // Where the agent is, as GetAgentLocationWrap answered it for this layout (null: no place named).
  | { readonly type: "agents/agent-location"; readonly location: import("../bridge/agentHeader.ts").AgentLocationWrap | null }
  /** What the client's agents service knows of one agent, as answered (null: the server lists no such agent). */
  | { readonly type: "agents/record"; readonly agentID: number; readonly record: import("../bridge/agents.ts").AgentRecord | null }
  /** The solar system the server says an agent is in (null: none). */
  | { readonly type: "agents/solar-system"; readonly agentID: number; readonly solarSystemID: number | null }
  /** The mission's page on show: opened, read again, or (null) closed. */
  | { readonly type: "agents/mission-page"; readonly page: import("./types.ts").MissionPageState | null }
  // The mission journal (active + offered missions).
  | { readonly type: "agents/journal"; readonly journal: JournalState }
  // An agent action/read failed; null clears the error after success.
  | { readonly type: "agents/action-error"; readonly message: string | null; readonly said?: boolean }
  // Drop the agents state (character offline / logged out).
  | { readonly type: "agents/cleared" }
  // Goal R6 — the post-completion reward readout (inventory Step 12). The
  // wallet/LP/standings pull reads after Complete pays out (the journal, the
  // fourth Step-12 read, refreshes into the agents slice on the same Complete).
  | {
      readonly type: "rewards/loaded";
      readonly cashBalance: string | null;
      readonly lpBalances: readonly WalletLPBalance[];
      readonly standings: readonly CharStanding[];
      readonly error: string | null;
    }
  // Drop the reward readout (character offline / logged out).
  | { readonly type: "rewards/cleared" }
  // Goal R50 (extended R54) — the Wallet + Corp Wallet tabs. One BFF pull carries
  // the personal ISK balance (account.GetCashBalance), the corporation division
  // balances (account.GetWalletDivisionsInfo), and the personal LEDGER
  // (account.GetJournal + account.GetTransactions). Each read keeps its own
  // error. Every list is null when its read failed (see the matching `*Error`)
  // or has not answered yet; [] is a real "no divisions / no ledger entries yet".
  | {
      readonly type: "wallet/loaded";
      readonly cashBalance: string | null;
      readonly cashError: string | null;
      readonly corpDivisions: readonly CorpWalletDivision[] | null;
      readonly corpError: string | null;
      readonly journal: readonly LedgerEntry[] | null;
      readonly journalError: string | null;
    }
  // Drop the wallet readout (character offline / logged out).
  | { readonly type: "wallet/cleared" }
  // Goal R55 — the Standings page. One BFF pull carries the character's own
  // standings (standingMgr.GetCharStandings) and the corporation's standings
  // (standingMgr.GetCorpStandings). Each keeps its own error; a list is null when
  // its read failed (see the matching `*Error`) or has not answered, [] a real
  // "no standings yet".
  | {
      readonly type: "standings/loaded";
      readonly char: readonly CharStanding[] | null;
      readonly charError: string | null;
      readonly corp: readonly CharStanding[] | null;
      readonly corpError: string | null;
    }
  // The pilot's own standings as the server has just changed them (bridge/standingChanges.ts): the list
  // alone, with everything else about the standings left as it is.
  | { readonly type: "standings/char"; readonly char: readonly CharStanding[] }
  // A drill-down for one selected entity: a char row's standing HISTORY
  // (transactions) or a corp row's per-member breakdown (compositions). `scope`
  // says which section the row came from so a late read can't repaint the wrong
  // one.
  | {
      readonly type: "standings/detail";
      readonly fromID: number;
      readonly scope: "char" | "corp";
      readonly transactions: readonly StandingTransaction[] | null;
      readonly compositions: readonly StandingComposition[] | null;
    }
  | {
      readonly type: "standings/detail-error";
      readonly fromID: number;
      readonly scope: "char" | "corp";
      readonly message: string;
    }
  // Close the open drill-down without loading another.
  | { readonly type: "standings/detail-cleared" }
  // Drop the standings readout (character offline / logged out).
  | { readonly type: "standings/cleared" }
  // Goal R56 — the Character Sheet page. One BFF pull carries four independent
  // charMgr reads (public info, description, home station, clone info); each
  // keeps its OWN error so one failure never blanks the rest. `identity`/`clone`
  // are null when unread or FAILED (see the matching `*Error`); `description` is
  // null unread/failed but "" is a real empty bio; `homeStationID` is the id only
  // (the page resolves its NAME through /api/names, R7d).
  | {
      readonly type: "character-sheet/loaded";
      readonly identity: CharacterIdentity | null;
      readonly identityError: string | null;
      readonly description: string | null;
      readonly descriptionError: string | null;
      readonly homeStationID: number | null;
      readonly homeStationError: string | null;
      readonly clone: CloneSummary | null;
      readonly cloneError: string | null;
    }
  // The character sheet's skill history was read: its lines, or why it was not read.
  | {
      readonly type: "character-sheet/skill-history";
      readonly lines: readonly SkillHistoryLine[] | null;
      readonly error: string | null;
    }
  // The character sheet's employment history was read: its lines and transfers, or why it was not read.
  | {
      readonly type: "character-sheet/employment-history";
      readonly history: EmploymentHistory | null;
      readonly error: string | null;
    }
  // Drop the character sheet (character offline / logged out).
  | { readonly type: "character-sheet/cleared" }
  // Goal R6a — the Agent Finder. A find completed: the filtered/capped agents,
  // already annotated with jumps from the current system and sorted
  // nearest-first by the flow, plus the filter echo and match/cap counts.
  | {
      readonly type: "finder/results";
      readonly kind: string;
      readonly level: number | null;
      readonly originSystemID: number | null;
      readonly agents: readonly AgentFinderRow[];
      readonly total: number;
      readonly capped: boolean;
    }
  // The player set the autopilot to an agent (or cleared it): who they're flying
  // to. null clears the target.
  | { readonly type: "finder/target"; readonly target: AgentFinderTarget | null }
  // A find failed non-fatally; null clears the error after a clean find.
  | { readonly type: "finder/error"; readonly message: string | null }
  // Drop the finder state (character offline / logged out).
  | { readonly type: "finder/cleared" }
  // Goal R5a — the Flight page (manually-stepped space movement). A flight-
  // status snapshot: the session's current location + ship movement state.
  | { readonly type: "flight/status"; readonly status: FlightStatus }
  // Goal R7a — resolved location NAMES for the current status (system / station /
  // structure), so the readout shows "Jita" not "30000142". Carries the IDs the
  // names were resolved for; the reducer applies each name only if the current
  // status still has that ID (so a stale resolve can never mislabel a new one).
  | {
      readonly type: "flight/location";
      readonly forSolarSystemID: number | null;
      readonly forStationID: number | null;
      readonly forStructureID: number | null;
      readonly solarSystemName: string | null;
      readonly stationName: string | null;
      readonly structureName: string | null;
    }
  // The last movement step issued (undock / warp / jump / dock) — for the
  // status readout. A successful step clears any stale action error.
  | { readonly type: "flight/action"; readonly action: string }
  // A movement step failed (the handler's own refusal reason); null clears it.
  | { readonly type: "flight/action-error"; readonly message: string | null; readonly said?: boolean }
  // Drop the flight state (character offline / logged out).
  | { readonly type: "flight/cleared" }
  // crimewatchSvc's client states, read again at each of the server's notices of them.
  | { readonly type: "flight/crimewatch"; readonly crimewatch: CrimewatchReading }
  // The account's clone grade, as read when the pilot came online or as the server's notice said it.
  | { readonly type: "character/clone-grade"; readonly cloneGrade: CloneGrade | null }
  // The pilot's own security status, as read (crimewatch.GetMySecurityStatus) or as OnSecurityStatusUpdate said it.
  | { readonly type: "character/security-status"; readonly securityStatus: number | null }
  // Goal R11 — the Overview panel. A space snapshot read completed: everything
  // the ship can see right now plus the active ship's shield/armor/hull/cap.
  // The flow polls this ~1s while in space with the panel open; the panel is a
  // pure reader that derives distances, sorting and filtering itself.
  | {
      readonly type: "space/snapshot";
      readonly snapshot: SpaceSnapshot;
      /**
       * R30 slice A — the stargate links for this snapshot's system, when the
       * producer could compute them. `undefined` means "no answer this time"
       * (the route graph has not loaded yet) and the slice keeps what it had;
       * an empty array is a real answer meaning "this grid has no gates".
       */
      readonly gateLinks?: readonly GateLink[];
    }
  | { readonly type: "space/gate-map-error"; readonly message: string }
  // Fleet-companion phase 7 — one `OnJamStart` / `OnJamEnd` push, already
  // decoded. Carries the event rather than the folded set on purpose: the fold
  // is identity-sensitive (a jam IS the source/module pair) and belongs in one
  // place, beside the decoder that knows the wire, not in each producer.
  | { readonly type: "space/jam"; readonly event: JamEvent }
  // Goal R23 slice A — the GENERIC in-space action layer. Nothing here names
  // mining or combat: these five events carry a target, a module and an effect
  // name, and a later combat goal reuses them unchanged.
  //
  // The server's answer to dogmaIM.GetTargets — the ONLY authority on what is
  // locked. Every lock/unlock re-reads and lands here, because a 200 from a
  // lock call is not proof that anything locked.
  | {
      readonly type: "targeting/targets";
      readonly targetIDs: readonly number[];
      /** The ships that have the pilot's locked (GetTargeters), read with it; absent or null leaves the list as it is. */
      readonly targeterIDs?: readonly number[] | null;
    }
  // The server ACCEPTED a lock attempt and is still acquiring it. Not a claim
  // about server state — the entry disappears as soon as the target shows up in
  // targeting/targets, or when the lock is abandoned.
  | { readonly type: "targeting/acquiring"; readonly targetID: number }
  // The last targeting/activation action issued, for the status readout. A
  // successful action clears any stale refusal and silent-decline note.
  | { readonly type: "targeting/action"; readonly action: string }
  // An action was REFUSED, carrying the server's own reason verbatim; null
  // clears it.
  | { readonly type: "targeting/action-error"; readonly message: string | null; readonly said?: boolean }
  // An action returned 200, the re-read showed nothing changed, and the server
  // gave no reason. Deliberately separate from action-error: "refused, here is
  // why" and "quietly did nothing" are different and the page says which.
  | { readonly type: "targeting/silent-decline"; readonly message: string | null }
  // Drop the targeting state (docked / character offline / logged out).
  | { readonly type: "targeting/cleared" }
  // One `OnTarget` push — this ship's own lock landing, dropping, or being
  // wiped. Carries the event rather than the folded list, the same shape and
  // the same reason as `space/jam` above: the fold belongs beside the decoder
  // that knows the wire, not in each producer.
  //
  // ⚠ IT DOES NOT DISPLACE `targeting/targets`. That one is the server's answer
  // to `GetTargets` and stays the authority; this only lets a lock become
  // visible in the moment it completes instead of on the next poll. See
  // `applyTargetEvent`.
  | { readonly type: "targeting/lock-event"; readonly event: TargetEvent }
  // One `OnTarget` push about a ship locking this one (`otheradd`) or letting it go (`otherlost`): the client's
  // targetedBy, kept from the push as the client keeps it.
  | { readonly type: "targeting/targeter-event"; readonly event: TargeterEvent }
  // R24 slice C — the BASE cycle length for a module type (attribute 73, off
  // static reference data). Applied to every fitted module of that type that
  // has no better figure; a server-sourced duration is never overwritten by it.
  | {
      readonly type: "targeting/base-cycles";
      /** moduleItemID -> milliseconds, or null where the type has no duration. */
      readonly cycles: Readonly<Record<number, number | null>>;
    }
  // R24 slice C — a cycle event the SERVER pushed (`OnGodmaShipEffect`). This
  // carries the EFFECTIVE duration, which is the only way the browser can know
  // it. `running: false` is the stop event: the length is remembered, the
  // running cycle is not.
  | {
      readonly type: "targeting/cycle";
      readonly moduleID: number;
      readonly durationMs: number | null;
      readonly running: boolean;
      readonly repeating: boolean;
      readonly observedAtMs: number;
    }
  // R29 — one shot, pushed as `OnDamageMessage`. Both directions arrive on this
  // channel; the payload's own attackType says which, and the flow decodes it
  // rather than guessing from the ids.
  | {
      readonly type: "targeting/damage";
      readonly direction: "dealt" | "taken";
      readonly otherPartyID: number | null;
      readonly weaponTypeID: number | null;
      readonly amount: number;
      readonly quality: number | null;
      readonly atMs: number;
    }
  // Goal R23 slice B — the mining loop. The ship's mining holds, by NAME (the
  // retail flagIDs never reach the browser), each with its own read error so one
  // failed hold never blanks the rest.
  | { readonly type: "mining/holds"; readonly holds: readonly MiningHold[] }
  | { readonly type: "mining/holds-error"; readonly message: string | null }
  // A survey scan completed: what the scanner saw in each rock in range. The
  // panel MERGES this into the overview by itemID; nothing is computed here.
  | {
      readonly type: "mining/survey";
      readonly survey: readonly SurveyResult[];
      readonly atMs: number;
    }
  | { readonly type: "mining/survey-error"; readonly message: string | null }
  // The refinery quoted the chosen stacks. `taxRate` is null for "not known"
  // rather than 0 — reprocessing DEBITS the tax, so a confident zero would tell
  // the player the refinery is free.
  | {
      readonly type: "mining/quotes";
      readonly quotes: readonly ReprocessingQuote[];
      readonly taxRate: number | null;
      readonly quotesFor: readonly number[];
    }
  | { readonly type: "mining/quotes-error"; readonly message: string | null }
  // The last mining action issued (unload / scan / reprocess), its refusal
  // reason, and the separate "succeeded but changed nothing" case.
  | { readonly type: "mining/action"; readonly action: string }
  | { readonly type: "mining/action-error"; readonly message: string | null }
  | { readonly type: "mining/silent-decline"; readonly message: string | null }
  // Drop the mining state (character offline / logged out).
  | { readonly type: "mining/cleared" }
  // Goal R25 slice A — drones. The bay, the drones actually in space, and the
  // two launch limits the server enforces, all from ONE read.
  //
  // ⚠ `bay` and `inSpace` are NULLABLE and null means "we could not look". An
  // empty array means the bay is empty / nothing is out there. Collapsing the
  // two would invite a player to launch a second flight on top of the one
  // already flying.
  | {
      readonly type: "drones/loaded";
      readonly bay: readonly DroneBayStack[] | null;
      readonly inSpace: readonly DroneInSpace[] | null;
      readonly limits: DroneLimits;
    }
  | { readonly type: "drones/error"; readonly message: string | null }
  // What is in space after a launch / engage / mine / recall. The server's own
  // return values prove nothing, so this always carries a fresh re-read.
  | { readonly type: "drones/in-space"; readonly inSpace: readonly DroneInSpace[] | null }
  | { readonly type: "drones/action"; readonly action: string }
  | { readonly type: "drones/action-error"; readonly message: string | null; readonly said?: boolean }
  // A drone call that answered success and changed nothing — the ONLY way a
  // refused launch can surface, because the handler returns an empty dict.
  | { readonly type: "drones/silent-decline"; readonly message: string | null }
  // R34 — the server's own reason for each drone it refused. A LIST, not a
  // message: an order fans out over several drones and each gets its own
  // answer, so one slot would let a later drone erase an earlier refusal.
  | {
      readonly type: "drones/order-reports";
      readonly reports: readonly DroneOrderReport[];
    }
  | { readonly type: "drones/cleared" }
  // Goal R28 — the skill sheet and the training queue.
  //
  // ⚠ `skills` and `queue` are NULLABLE and null means "we could not read it".
  // An empty queue is [] with active:false, which is a real and common state
  // (nothing is training); collapsing the two would show a player a queue we
  // never actually looked at.
  | {
      readonly type: "skills/loaded";
      readonly characterName: string;
      readonly totalSkillPoints: number;
      readonly freeSkillPoints: number;
      readonly skills: readonly SkillRow[] | null;
      readonly queue: SkillQueueState | null;
      /** serverNowMs minus the browser clock at read time. */
      readonly clockOffsetMs: number;
    }
  | { readonly type: "skills/error"; readonly message: string | null }
  // A queue edit the server ACCEPTED — landed only after the re-read confirmed
  // it, never on the strength of the call returning.
  | { readonly type: "skills/action"; readonly action: string }
  | { readonly type: "skills/action-error"; readonly message: string | null; readonly said?: boolean }
  | { readonly type: "skills/cleared" }
  // Goal R41 — the character's planetary colonies.
  //
  // ⚠ `colonies` is NULLABLE and null means "we could not read them".
  // `coloniesReadable` is the OTHER half of the distinction: false says the
  // gateway reported no colony table at all, which is not the same statement as
  // "you have built nothing". Only readable + empty may tell a player that.
  | {
      readonly type: "planets/loaded";
      readonly colonies: readonly Colony[];
      readonly coloniesReadable: boolean;
      /** serverNowMs minus the browser clock at read time. */
      readonly clockOffsetMs: number;
    }
  | { readonly type: "planets/error"; readonly message: string | null }
  | { readonly type: "planets/selected"; readonly planetID: number | null }
  | { readonly type: "planets/cleared" }
  /**
   * The planetary recipe table (goal R108). Static reference data, not the
   * player's — read once and kept across character changes.
   */
  | { readonly type: "planets/recipes"; readonly recipes: PiRecipeBook }
  // A snapshot read failed non-fatally; null clears it after a clean read.
  | { readonly type: "space/error"; readonly message: string | null }
  // Drop the space state (docked / character offline / logged out).
  | { readonly type: "space/cleared" }
  // Goal R5b — the Travel panel (browser autopilot decide-loop). A route was
  // computed (client-side solver) and the loop started.
  | {
      readonly type: "travel/planned";
      readonly destinationSystemID: number;
      readonly destinationStationID: number | null;
      readonly destinationName: string | null;
      readonly route: readonly TravelRouteStep[];
      readonly totalJumps: number;
      readonly startedAt: number;
    }
  // A live progress push from the decide-loop (system/next/phase/remaining/…).
  | {
      readonly type: "travel/progress";
      readonly status: TravelStatus;
      readonly action: string | null;
      readonly phase: string | null;
      readonly currentSystemID: number | null;
      readonly currentSystemName: string | null;
      readonly nextSystemID: number | null;
      readonly nextSystemName: string | null;
      readonly remainingJumps: number;
      readonly totalJumps: number;
      readonly failureReason: string | null;
    }
  // Starting a route failed before the loop began (unreachable / not in space /
  // graph load); null clears a stale plan error.
  | { readonly type: "travel/plan-error"; readonly message: string | null }
  // Drop the travel state (character offline / logged out / new route).
  | { readonly type: "travel/cleared" }
  // Goal R26 — the mining bot (a browser decide-loop, like the autopilot). The
  // player started it on a belt, hauling to a station.
  | {
      readonly type: "bot/started";
      readonly beltName: string | null;
      readonly stationName: string | null;
      readonly startedAt: number;
    }
  // A live readout push from the bot's loop. `why` is not optional decoration:
  // the player must always be able to see why it did the last thing it did.
  | {
      readonly type: "bot/progress";
      readonly status: MiningBotRunState;
      readonly phase: string | null;
      readonly action: string | null;
      readonly why: string | null;
      /**
       * R44 — the rung of the ladder that fired, or null for a tick the ladder
       * never answered. REQUIRED, not optional, on purpose: an optional field
       * on a feed event is exactly the shape that goes quietly missing and
       * leaves a readout dark while everything still compiles.
       */
      readonly rung: MiningRungID | null;
      /**
       * R46 — the leaf that rung called. REQUIRED for the same reason `rung`
       * is: an optional field on a feed event is the shape that goes quietly
       * missing, and this one going missing is how the panel would go back to
       * claiming the equipment was switched on when it was not.
       */
      readonly step: MiningStepID | null;
      readonly rockName: string | null;
      readonly cyclesCompleted: number;
      readonly oreUnitsMined: number;
      readonly holdUsed: number | null;
      readonly holdCapacity: number | null;
      readonly failureReason: string | null;
    }
  // Starting failed before the loop began (nothing picked, not in space);
  // null clears a stale message.
  | { readonly type: "bot/start-error"; readonly message: string | null }
  // Drop the bot state (character offline / logged out).
  | { readonly type: "bot/cleared" }
  // Goal R36 — the distribution-mission bot. The player started it on an agent.
  | {
      readonly type: "mission-bot/started";
      readonly agentName: string | null;
      readonly stationName: string | null;
      readonly startedAt: number;
    }
  // A live readout push from the mission bot's loop. As with the mining bot,
  // `why` is not optional decoration — it is the whole point of the panel.
  | {
      readonly type: "mission-bot/progress";
      readonly status: MiningBotRunState;
      readonly phase: string | null;
      readonly action: string | null;
      readonly why: string | null;
      readonly agentName: string | null;
      readonly missionName: string | null;
      readonly cargoText: string | null;
      readonly destinationName: string | null;
      readonly jumpsRemaining: number | null;
      readonly missionsCompleted: number;
      readonly iskEarned: string | null;
      readonly lpEarned: string | null;
      readonly caution: string | null;
      readonly failureReason: string | null;
    }
  | { readonly type: "mission-bot/start-error"; readonly message: string | null }
  | { readonly type: "mission-bot/cleared" }
  // The fleet companion's readout (fleet-companion phase 0). Same construction
  // as the two bots above: the loop pushes, this slice records.
  | {
      readonly type: "companion/started";
      readonly startedAt: number;
      /** What is missing or unusable about this pilot's fit. Advisory, never fatal. */
      readonly fitWarnings: readonly string[];
    }
  | {
      readonly type: "companion/progress";
      readonly status: FleetCompanionRunState;
      readonly phase: string | null;
      readonly action: string | null;
      readonly why: string | null;
      readonly inFleet: boolean | null;
      readonly followingOrderFrom: CompanionOrderAuthority | null;
      readonly lastOrderHeard: string | null;
      readonly targetMode: "called" | "all";
      readonly canTag: boolean | null;
      /**
       * Decision 5's abandonment, or null. Carried through the slice rather
       * than kept in the loop because the BFF's bot host reads it off the
       * store to persist the thirty-minute clock — see
       * FLEET_COMPANION_ABANDONMENT_WAIT_MS.
       */
      readonly abandonment: CompanionAbandonmentRecord | null;
      readonly failureReason: string | null;
      readonly selfPaused: boolean;
    }
  | { readonly type: "companion/start-error"; readonly message: string | null }
  | { readonly type: "companion/cleared" }
  // The player Bot Builder runner's readout (pushed each tick; survives the shell switch).
  | { readonly type: "custom-bot/started"; readonly name: string }
  | {
      readonly type: "custom-bot/progress";
      readonly status: "idle" | "running" | "paused" | "stopped" | "error";
      readonly phase: string | null;
      readonly why: string | null;
      readonly stepPath: string | null;
      readonly interruptID: string | null;
      readonly pauseReason: string | null;
      /** The run board as one line ("Working with <agent>"), or null. */
      readonly note?: string | null;
      /** What the server is turning down, worst first. Absent reads as none. */
      readonly refusals?: readonly BotRefusal[];
    }
  | { readonly type: "custom-bot/start-error"; readonly message: string | null }
  /** An "alert me" watch fired: what it said, and when (epoch ms). */
  | { readonly type: "custom-bot/alert"; readonly message: string; readonly atMs: number }
  | { readonly type: "custom-bot/cleared" }
  // Goal R7 — the Chat panel (Local + Corp). A channel read completed (roster +
  // recent backlog) — the panel polls while open (READ is a backlog poll).
  | {
      readonly type: "chat/loaded";
      readonly channel: ChatChannel;
      readonly channelState: ChatChannelState;
    }
  // The active channel tab changed (Local <-> Corp).
  | { readonly type: "chat/active"; readonly channel: ChatChannel }
  // A chat read/send failed non-fatally; null clears it after success.
  | { readonly type: "chat/error"; readonly message: string | null }
  // Drop the chat state (character offline / logged out).
  | { readonly type: "chat/cleared" }
  // Goal R10 — one chat message pushed over the live channel (gateway chat
  // emitter -> WS -> BFF SSE), appended to the channel's backlog. Deduplicated
  // against what a poll already delivered, so live and poll can coexist.
  | {
      readonly type: "chat/message";
      readonly channel: ChatChannel;
      readonly message: ChatMessage;
    }
  // Goal R10 — the live push channel's connection state. Drives poll cadence
  // (fast when the channel is down, slow safety net when it is live); it is not
  // a correctness signal, since every bridge response still drains
  // notifications.
  | { readonly type: "live/status"; readonly status: LiveStreamStatus }
  // Goal R10 — a session notification pushed over the live channel, with the
  // cursor it arrived at so a reconnect can resume from it. This is where the
  // notifications the page used to throw away now land.
  | {
      readonly type: "live/notification";
      readonly notification: LiveNotification;
      readonly epoch: string | null;
      readonly sequence: number;
    }
  // Goal R10 — the live channel could not be replayed from the held cursor
  // (gateway restart or a cursor past the replay horizon); the consumer must
  // re-read rather than assume continuity.
  | {
      readonly type: "live/resynchronize";
      readonly epoch: string | null;
      readonly sequence: number;
    }
  // The server asked the player something and is waiting (game-port pilots).
  | {
      readonly type: "live/question";
      readonly question: ClientQuestion;
      readonly epoch: string | null;
      readonly sequence: number;
    }
  // A question was answered, ran out of time, or its session ended. Without a
  // cursor when the page closes it itself, having just answered it.
  | {
      readonly type: "live/question-closed";
      readonly id: string;
      readonly epoch?: string | null;
      readonly sequence?: number;
    }
  // Drop the live-channel state (character offline / logged out).
  | { readonly type: "live/cleared" }
  // Goal R7c — the names-everywhere cache. A batch of `{kind, id}` refs resolved
  // (through the static /api/names route): each entry is a name string, or null
  // for a definitive "unknown". Merged into the `names` slice so pure-reader
  // components render names in place of raw IDs. Static reference data, so these
  // are never cleared on offline/logout (they can't change and are safe to keep).
  | {
      readonly type: "names/resolved";
      readonly entries: Readonly<Record<string, string | null>>;
    }
  // The security of some solar systems has been read (null: no such system).
  | { readonly type: "names/system-security"; readonly security: Readonly<Record<number, number | null>> }
  // The jumps on the autopilot's route between some pairs of systems, by "<from>:<to>" (null: no route).
  | { readonly type: "names/autopilot-jumps"; readonly jumps: Readonly<Record<string, number | null>> }
  // The autopilot's settings changed, or the pilot did: what was worked out before is forgotten.
  | { readonly type: "names/autopilot-jumps-cleared" }
  // The retail client's text for some labels has been read (or found missing).
  | {
      readonly type: "words/loaded";
      readonly available: boolean;
      readonly templates: Readonly<Record<string, string | null>>;
    };

/** What the store hands an adapter: publish events, report connectivity. */
export interface FeedSink {
  publish(event: FeedEvent): void;
  setStatus(status: FeedStatus): void;
}

/** A transport adapter. Constructed with its transport details; started with a sink. */
export interface FeedAdapter {
  /** Stable name surfaced in the store's feed slice (e.g. "legacy-ws", "bridge", "memory"). */
  readonly name: string;
  start(sink: FeedSink): void;
  stop(): void;
}

/**
 * In-memory adapter: the minimal transport used by unit tests and the R1b
 * scaffold smoke page. `emit` throws when the adapter is not started so test
 * bugs surface instead of silently dropping events.
 */
export class MemoryFeedAdapter implements FeedAdapter {
  readonly name: string;
  private sink: FeedSink | null = null;

  constructor(name = "memory") {
    this.name = name;
  }

  start(sink: FeedSink): void {
    this.sink = sink;
    sink.setStatus("connected");
  }

  stop(): void {
    if (this.sink) {
      this.sink.setStatus("disconnected");
      this.sink = null;
    }
  }

  get started(): boolean {
    return this.sink !== null;
  }

  emit(event: FeedEvent): void {
    if (!this.sink) {
      throw new Error("MemoryFeedAdapter.emit called before start()");
    }
    this.sink.publish(event);
  }
}
