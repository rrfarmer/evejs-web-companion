// Domain row types shared by the client-state store and the bridge decoders.
// These are the *decoded* browser-side shapes; the marshaled wire shapes
// (util.KeyVal rows, {type:"long"} wrappers, ...) live in ../bridge/wire.ts.

import type { BoundDogmaAllInfo } from "../bridge/boundDogma.ts";
import type { MissionTimes } from "../bridge/missionTime.ts";
import type { MissionObjectives } from "../bridge/missionObjectives.ts";
import type { MiningBurstServices, CompressionServiceObservation } from "../bridge/miningSupportServices.ts";
import type { CoreMobilityFuelObservation } from "../bridge/miningSupportCore.ts";
import type { ModuleReachObservation } from "../bridge/moduleReach.ts";
import type { BoundFleet } from "../bridge/boundFleet.ts";
import type { FleetBroadcast } from "../bridge/fleetBroadcasts.ts";
import type { ActiveJam } from "../bridge/jamNotifications.ts";
import type { PiRecipeBook } from "../bridge/piRecipes.ts";
import type {
  FleetAvailability,
  FleetPendingInvite,
} from "../bridge/fleetCenter.ts";
import type { ShipStats } from "../bridge/shipStats.ts";
import type { ScanFullState } from "../bridge/boundSmallServices.ts";
import type {
  ScannerDataState,
  ScannerOperationsSnapshot,
} from "../scanner/scannerCenter.ts";
import type { GateLink } from "../space/gateLinks.ts";
import type { CrimewatchReading } from "../space/crimewatch.ts";
import type { BotID, ShipControllerID } from "../nav/botRegistry.ts";
import type { MiningRungID, MiningStepID } from "../nav/miningLadder.ts";
import type {
  CompanionAbandonmentRecord,
  CompanionOrderAuthority,
  FleetCompanionRunState,
} from "../nav/fleetCompanionLoop.ts";

export type { GateLink };
export type { BotID };

/**
 * One character row from the reference call
 * charUnboundMgr.GetCharacterSelectionData (docs/bridge-wire-contract.md),
 * decoded from its util.KeyVal wire row. FILETIME fields arrive as
 * {type:"long"} wrappers (BigInt encoded as decimal string, or plain number)
 * and are decoded to bigint.
 */
/**
 * The character brought online on the persistent browser-backed session
 * (goal R2): the session echo the BFF returns from POST /api/bridge/select.
 */
export interface OnlineCharacterState {
  readonly characterID: number;
  readonly characterName: string;
  readonly stationID: number | null;
  readonly structureID: number | null;
  readonly solarSystemID: number | null;
  readonly corporationID: number | null;
}

/**
 * Client-local static station identity (names stay client-side, exactly as
 * the retail client resolves station names from its static DB). Provided by
 * the BFF's read-only static reference data in the select response.
 */
export interface StationStatic {
  readonly stationID: number;
  readonly stationName: string;
  readonly solarSystemName: string;
  readonly regionName: string;
  readonly stationTypeID: number | null;
  readonly stationTypeName: string | null;
  readonly operationID: number | null;
  readonly security: number | null;
}

/**
 * The docked station-services row from stationSvc.GetStationItemBits:
 * retail builds Row(ownerID, itemID, operationID, stationTypeID) from this
 * tuple (eve/client/script/ui/station/base.py:575).
 */
export interface StationServiceBits {
  readonly ownerID: number | null;
  readonly stationID: number | null;
  readonly operationID: number | null;
  readonly stationTypeID: number | null;
}

/**
 * The lobby's offices where the pilot is docked (dockedUI/offices.py): the
 * corporations with an office there, and how many offices are free.
 */
export interface StationOffices {
  /** False where the pilot's transport does not carry the read. */
  readonly available: boolean;
  readonly corporationIDs: readonly number[];
  /** Null where there is no count: a structure has none. */
  readonly freeOffices: number | null;
  /** Whether the pilot's corporation has an office here. */
  readonly ownOffice: boolean;
  /** Whether the pilot's corporation, with no office here, has items impounded here. */
  readonly impounded: boolean;
  /** The retail lobby's two checks of the session's roles: the renting role, and a director. */
  readonly canRent: boolean;
  readonly canGiveUp: boolean;
}

/** What an office in the station costs the pilot's corporation, and the days that pays for. */
export interface StationOfficeQuote {
  readonly cost: number;
  readonly days: number;
}

/** One docked guest from station.GetGuests: (charID, corp, alliance, warFaction). */
export interface StationGuest {
  readonly characterID: number;
  readonly corporationID: number | null;
  readonly allianceID: number | null;
  readonly warFactionID: number | null;
}

/**
 * One decoded inventory row from an invbroker List (goal R3), from either a
 * packedrow list or an (empty) python set. The bound OID that produced it never
 * reaches the browser; the BFF holds it and the browser addresses items by
 * these game IDs.
 */
export interface InventoryItemRow {
  readonly itemID: number;
  readonly typeID: number;
  readonly groupID: number | null;
  readonly categoryID: number | null;
  readonly flagID: number | null;
  readonly quantity: number;
  readonly singleton: boolean;
  /**
   * m³ PER UNIT, from static reference data (attached to the hangar/cargo read
   * the same way the assets route attaches it). Lets the browser work out how
   * much of a stack fits in a hold before trying the move. `null`/absent means
   * the static tables do not know the type OR the row came from a read that does
   * not carry volume (ship-bay contents) — the UI treats that as "unknown", never
   * zero, and falls back to letting the server judge the fit.
   */
  readonly volume?: number | null;
}

/** Decoded invbroker.GetCapacity result (util.KeyVal {capacity, used}). */
export interface CapacityInfo {
  readonly capacity: number;
  readonly used: number;
}

/** One inventory container's decoded reads (hangar or active-ship cargo). */
export interface InventoryContainerState {
  readonly rows: readonly InventoryItemRow[];
  readonly capacity: CapacityInfo | null;
  /** Non-null when this container's read failed (the other container still shows). */
  readonly error: string | null;
}

/**
 * The Inventory & Ship page state (goal R3): the docked station hangar and the
 * active ship's cargo, plus which ships in the hangar can be boarded (derived
 * from the hangar rows: category 6 items that are not already active).
 */
export interface InventoryState {
  readonly stationID: number | null;
  readonly structureID?: number | null;
  readonly activeShipID: number | null;
  readonly hangar: InventoryContainerState;
  readonly cargo: InventoryContainerState;
  /** True once a panel load has populated the slice. */
  readonly loaded: boolean;
  /** Non-null when the last mutation (move/stack/board) failed. */
  readonly actionError: string | null;
  // --- R14 inventory depth ---
  /** The items ticked for a bulk move / trash, by itemID. */
  readonly selection: readonly number[];
  /** The container currently open, or null when browsing the top level. */
  readonly container: OpenContainerState | null;
  /** The corporation hangar at this station. */
  readonly corp: CorpHangarState;
  /**
   * What the LAST mutation actually did, re-read from the server rather than
   * echoed from the request. `applied: false` with no reason is a silent
   * decline — the server refused without saying why, and the UI says exactly
   * that instead of inventing a cause.
   */
  readonly lastOutcome: MutationOutcome | null;
  // --- R40 ship bays ---
  /**
   * Which ship the Ships card has open, and what its bays turned out to be.
   * Null when no ship is expanded.
   */
  readonly openShip: OpenShipState | null;
}

// --- R40 ship bays ----------------------------------------------------------

/**
 * ONE bay on a hull — cargo hold, ore hold, drone bay, fleet hangar, and the
 * two dozen others a hull might have. A bay IS an inventory flag, but the flag
 * number never reaches the browser: the BFF hands over a key and a LABEL (R7d).
 *
 * The three-valued `present` is the whole point of this type. A hull that has
 * no ore hold, and a hull whose ore hold could not be read, must not render
 * identically — so "absent" and "unknown" are different values, and neither is
 * an empty `items` list.
 */
export interface ShipBay {
  /** Stable identity for this bay, e.g. "cargo", "ore", "drone". Not shown. */
  readonly key: string;
  /** What the player reads: "Ore hold", "Drone bay". Never a flag number. */
  readonly label: string;
  /**
   * true — the hull has this bay · false — it does not · null — the read
   * FAILED, so we genuinely do not know. Only `true` gets drawn as a bay.
   */
  readonly present: boolean | null;
  /** Used / capacity in m³, or null when the ship reported none. */
  readonly capacity: CapacityInfo | null;
  /** `[]` is "we looked, and it is empty"; `null` is "we could not look". */
  readonly items: readonly InventoryItemRow[] | null;
  readonly error: string | null;
}

/** The ship whose bays the Ships card is showing. */
export interface OpenShipState {
  readonly itemID: number;
  readonly typeID: number;
  readonly bays: readonly ShipBay[];
  /** True once a bay read has answered for this ship. */
  readonly loaded: boolean;
  /** Non-null when the bay read failed outright (no bay was read at all). */
  readonly error: string | null;
}

// --- R14 inventory depth ----------------------------------------------------

/**
 * A place items can live. The browser names a place; the retail flagIDs that
 * back them (4 hangar, 5 cargo, 0 container contents, 115-121 corporation
 * divisions, and the specialised-bay flags behind a `shipBay`) live on the BFF
 * and never reach here.
 *
 * A `shipBay` names one specialised bay of the ACTIVE ship by its bay KEY
 * ("ore", "drone", "fleet", …) — the same key R40's /bays route hands over. The
 * BFF maps the key to the bay's flag, so a stack in the ore hold can be moved
 * out without the browser ever learning the ore hold is flag 134.
 */
export type InventoryPlace =
  | { readonly kind: "hangar" }
  | { readonly kind: "cargo" }
  | { readonly kind: "shipBay"; readonly bay: string }
  | { readonly kind: "container"; readonly itemID: number }
  | { readonly kind: "corp"; readonly division: number };

/**
 * An open container. Its contents are read with a NO-FLAG List on the BFF
 * (container contents carry flagID 0), but that is a wire detail — here it is
 * just another set of rows.
 */
export interface OpenContainerState {
  readonly itemID: number;
  readonly typeID: number;
  readonly rows: readonly InventoryItemRow[];
  readonly capacity: CapacityInfo | null;
  readonly error: string | null;
}

/** One corporation hangar division, addressed by ordinal and shown by NAME. */
export interface CorpDivisionState {
  /** 1-7. Never rendered — it selects the division, the name labels it. */
  readonly division: number;
  /**
   * The corporation's own name for this division, or null when it was never
   * renamed (the UI then falls back to "Division N" — never a flag number).
   */
  readonly name: string | null;
  readonly rows: readonly InventoryItemRow[];
  readonly error: string | null;
}

/**
 * The corporation hangar at the docked station. `available: false` is the
 * ordinary case of a character whose corporation rents no office here — not an
 * error state.
 */
export interface CorpHangarState {
  readonly available: boolean;
  /** Why the hangar is unavailable, when it is. */
  readonly reason: string | null;
  readonly divisions: readonly CorpDivisionState[];
  /** Which division the panel is showing. */
  readonly selectedDivision: number;
  readonly loaded: boolean;
}

/**
 * The honest result of a mutation. The BFF re-reads after every call because
 * invbroker declines silently — it returns null WITHOUT raising — so a 200 is
 * never proof. `declinedSilently` means the server refused and gave no reason.
 */
export interface MutationOutcome {
  readonly applied: boolean;
  readonly declinedSilently: boolean;
  /** A short player-facing summary of what actually happened. */
  readonly message: string;
}

// --- R12 Ship fitting ------------------------------------------------------

/** The slot families a fitting window groups modules into. */
export type SlotFamily = "high" | "mid" | "low" | "rig" | "subsystem";

/** A module sitting in a slot. Named in the UI by typeID via the name cache. */
/** What is loaded in a module right now — a round of ammunition, a crystal. */
export interface LoadedCharge {
  /** Active-ship ListByFlags may identify loaded ammo by its ship/slot/type. */
  readonly itemID: number | readonly [number, number, number];
  readonly typeID: number;
  /** How many are loaded. */
  readonly quantity: number;
}

export interface FittedModule {
  readonly itemID: number;
  readonly typeID: number;
  readonly groupID: number | null;
  /** True when the server reports this module as currently online. */
  readonly online: boolean;
  /**
   * The charge loaded in this module, or null when it holds none.
   *
   * ⚠ A CHARGE SHARES ITS MODULE'S SLOT FLAG on the wire, which is what once
   * made the panel draw the ammunition INSTEAD of the gun. It belongs to the
   * module, never beside it — see bridge/fitting.ts.
   */
  readonly charge: LoadedCharge | null;
}

/**
 * One slot of the active ship, empty or filled. `index` is the slot's position
 * within its family — the browser addresses a slot by (family, index) and
 * never by its flagID, which lives only on the BFF and in bridge/fitting.ts.
 */
export interface FittingSlot {
  readonly family: SlotFamily;
  readonly index: number;
  readonly module: FittedModule | null;
}

/** One used-vs-total reading (CPU, powergrid, capacitor, calibration). */
export interface FittingResource {
  readonly used: number;
  readonly total: number;
  /** False when the ship reported no total; the bar renders as unknown. */
  readonly known: boolean;
}

export interface FittingResources {
  readonly cpu: FittingResource;
  readonly powergrid: FittingResource;
  readonly capacitor: FittingResource;
  readonly calibration: FittingResource;
}

/**
 * The Fitting page state (goal R12): the active ship's slots by family with
 * what is fitted in each, plus the ship's resource readings. Every read is
 * independent on the BFF, so a failed one carries its own error and never
 * blanks the rest.
 */
export interface FittingState {
  readonly activeShipID: number | null;
  /**
   * Per-module-type charge fitment, keyed by module typeID — used ONLY to sort
   * the ammo picker so likely charges come first.
   *
   * ⚠ ADVISORY, NEVER A FILTER. The server is the authority on what loads and
   * it declines silently, so the picker offers everything; `{}` means "we cannot
   * sort", which is the same as a module whose charges we cannot determine.
   */
  readonly chargeFits: Readonly<Record<number, import("../bridge/fitting.ts").ChargeFitment>>;
  readonly slots: readonly FittingSlot[];
  readonly resources: FittingResources;
  /**
   * R21 — the ship's derived statistics (resists, EHP, align time, speed,
   * targeting, bays), promoted from the SAME `ShipGetInfo` attribute map the
   * resource bars already read. Anything that could not be sourced carries
   * its reason instead of a number; see `bridge/shipStats.ts`.
   */
  readonly stats: ShipStats;
  /**
   * R21 slice B — the bound-dogma snapshot that rides alongside the fit: the
   * active ship and every fitted module with the SERVER's post-dogma attribute
   * map, so a clicked module can show its EFFECTIVE stats. Null until the
   * companion read lands (or when it failed) — a fit always renders without it.
   */
  readonly dogma: BoundDogmaAllInfo | null;
  /** True once a fitting read has populated the slice. */
  readonly loaded: boolean;
  /** Non-null when the slot read failed (the resource bars still show). */
  readonly slotsError: string | null;
  /** Non-null when the resource read failed (the slots still show). */
  readonly resourcesError: string | null;
  /** Non-null when the dogma companion read failed (the fit still shows). */
  readonly dogmaError: string | null;
  /** Non-null when the last fitting action failed or was declined. */
  readonly actionError: string | null;
  /**
   * Reloads the SERVER announced (`OnChargeBeingLoadedToModule`), by module
   * itemID. In space a load is queued for the module's reload time, so the fit
   * read straight after the call still shows the old charge; this is how the
   * page knows the charges are on their way. An entry outlives its window
   * harmlessly — readers compare it against the clock.
   */
  readonly reloads: Readonly<Record<number, ModuleReload>>;
}

/** One reload the server announced: what is going in, and when it lands. */
export interface ModuleReload {
  readonly chargeTypeID: number | null;
  /** Local clock, like ModuleCycle — the announcement's arrival time. */
  readonly startedAtMs: number;
  readonly durationMs: number;
}

/**
 * The bound-dogma snapshot for the Fitting window (goal R21, slice B): the
 * active ship followed by every fitted module, each carrying the SERVER's
 * post-dogma attribute map (skills + hull bonuses + in-space effects already
 * applied). Clicking a module socket looks that module up here by itemID and
 * renders its EFFECTIVE stats — see bridge/moduleAttributes.ts. Refreshed
 * alongside the fitting slice; a failed read keeps its own error and never
 * blanks the fit itself.
 */
export interface DogmaState {
  readonly allInfo: BoundDogmaAllInfo | null;
  /** True once a bound-dogma read has populated the slice. */
  readonly loaded: boolean;
  /** Non-null when the bound-dogma read failed (the fit still shows). */
  readonly error: string | null;
}

// --- R15 Industry ----------------------------------------------------------

/**
 * The industry activities a blueprint can be put to. The browser works in
 * these NAMES throughout — an activityID is decoded to one of these the moment
 * it comes off the wire and never appears in rendered text (R7d).
 */
export type IndustryActivity =
  | "manufacturing"
  | "research_time"
  | "research_material"
  | "copying"
  | "invention"
  | "reaction";

/**
 * What a job is doing right now, as the SERVER computed it. `ready` is derived
 * server-side from the job's end date (an installed job whose clock ran out
 * reads back as ready), so the browser never does that arithmetic itself.
 */
export type IndustryJobStatus =
  | "unsubmitted"
  | "running"
  | "paused"
  | "ready"
  | "completed"
  | "delivered"
  | "cancelled"
  | "reverted";

/** One material line of a recipe: how much of a type an activity consumes. */
export interface IndustryMaterial {
  readonly typeID: number;
  readonly quantity: number;
}

/** One activity of a blueprint DEFINITION (static data): what it costs in
 * materials and time for a single run, and what it yields. */
export interface IndustryRecipe {
  readonly activity: IndustryActivity;
  readonly materials: readonly IndustryMaterial[];
  readonly products: readonly IndustryMaterial[];
  /** Base seconds for one run, before efficiency and facility modifiers. */
  readonly timeSeconds: number;
}

/** A blueprint DEFINITION from static data — the same for every player. */
export interface IndustryDefinition {
  readonly blueprintTypeID: number;
  readonly blueprintName: string | null;
  readonly productTypeID: number | null;
  readonly productName: string | null;
  readonly maxProductionLimit: number | null;
  readonly recipes: readonly IndustryRecipe[];
}

/**
 * One blueprint the PLAYER owns (blueprintManager.GetBlueprintDataByOwner).
 * Everything here is live and per-instance; the name and the recipe come from
 * the matching IndustryDefinition.
 */
export interface IndustryBlueprintRow {
  readonly itemID: number;
  readonly typeID: number;
  /** Percent of material saved. Shown as "Material efficiency", never "ME". */
  readonly materialEfficiency: number;
  /** Percent of time saved. Shown as "Time efficiency", never "TE". */
  readonly timeEfficiency: number;
  /** Runs left on a copy. Meaningless for an original, which never runs out. */
  readonly runs: number;
  /** True for an original (unlimited runs), false for a copy. */
  readonly original: boolean;
  readonly locationID: number;
  readonly facilityID: number | null;
  /** The system it sits in, as the server states it; null when unstated (0). */
  readonly solarSystemID: number | null;
  /** Non-null when this blueprint is busy in a job right now. */
  readonly jobID: number | null;
}

/** One of the player's industry jobs (industryManager.GetJobsByOwner). */
export interface IndustryJobRow {
  readonly jobID: number;
  readonly activity: IndustryActivity | null;
  readonly status: IndustryJobStatus;
  readonly blueprintID: number;
  readonly blueprintTypeID: number;
  readonly productTypeID: number;
  readonly facilityID: number;
  readonly runs: number;
  readonly successfulRuns: number;
  /** Installation cost the server charged, in ISK. */
  readonly cost: number;
  /** Retail FILETIME; the panel renders these as a finish time / countdown. */
  readonly startDate: bigint | null;
  readonly endDate: bigint | null;
  readonly timeSeconds: number;
}

/** A facility the player's region offers (facilityManager.GetFacilities). */
export interface IndustryFacilityRow {
  readonly facilityID: number;
  readonly solarSystemID: number;
  readonly typeID: number;
  readonly ownerID: number;
  readonly online: boolean;
  /** Facility tax as a FRACTION (0.01 = 1%); the panel renders a percentage. */
  readonly tax: number | null;
  /** Which activities this facility will host, by name. */
  readonly activities: readonly IndustryActivity[];
  /**
   * Per activity, the facility's own time and material modifiers, as the
   * server prices a job with them (bridge/industryFacility.ts). Absent for an
   * activity it lists none for.
   */
  readonly modifiers: Readonly<Partial<Record<IndustryActivity, IndustryFacilityModifiers>>>;
}

/** One facility modifier: a factor, and what it applies to (null: anything). */
export interface IndustryFacilityModifier {
  readonly value: number;
  readonly categoryID: number | null;
  readonly groupID: number | null;
  readonly typeID: number | null;
}

export interface IndustryFacilityModifiers {
  readonly time: readonly IndustryFacilityModifier[];
  readonly material: readonly IndustryFacilityModifier[];
}

/** How many job slots of each activity the character currently has in use. */
export type IndustrySlotUsage = Partial<Record<IndustryActivity, number>>;

/**
 * The Industry page state (goal R15). Each of the five BFF reads is
 * independent, so each carries its own error and a failed one never blanks the
 * rest — a player with no facilities in range still sees their blueprints.
 */
export interface IndustryState {
  readonly ownerID: number | null;
  readonly stationID: number | null;
  readonly solarSystemID: number | null;
  readonly blueprints: readonly IndustryBlueprintRow[];
  readonly jobs: readonly IndustryJobRow[];
  readonly facilities: readonly IndustryFacilityRow[];
  readonly slotsUsed: IndustrySlotUsage;
  /** Static recipes keyed by blueprintTypeID, filled in after the live read. */
  readonly definitions: Readonly<Record<number, IndustryDefinition | null>>;
  readonly loaded: boolean;
  readonly blueprintsError: string | null;
  readonly jobsError: string | null;
  readonly facilitiesError: string | null;
  /** Non-null when the last install/deliver/cancel failed or was declined. */
  readonly actionError: string | null;
}

// --- R16 Market ------------------------------------------------------------
//
// ⚠ MONEY IS A DECIMAL STRING HERE, NEVER A NUMBER. ISK in EveJS routinely
// exceeds 2^53, so every price, escrow figure and balance below is the exact
// decimal string the server sent (R7d), formatted for display by
// bridge/market.ts. Quantities and jump counts are small integers and stay
// numbers.
//
// ⚠ AN ORDER IS IDENTIFIED BY ITS orderID, WHICH IS NEVER RENDERED. It is a
// handle the panel passes back to cancel or modify; the player sees the item,
// the place and the price instead.

/** Which side of the book an order sits on. */
export type MarketSide = "buy" | "sell";

/** One order in an item's public order book (marketProxy.GetOrders). */
export interface MarketOrderRow {
  /** Bigint-safe handle. Passed back to the server; never shown (R7d). */
  readonly orderID: string;
  readonly side: MarketSide;
  readonly typeID: number;
  readonly stationID: number;
  readonly solarSystemID: number;
  readonly regionID: number;
  /** ISK per unit, as a decimal string. */
  readonly price: string;
  readonly volumeRemaining: number;
  readonly volumeEntered: number;
  /** The smallest quantity this order will trade in one go. */
  readonly minimumVolume: number;
  /** How far the order REACHES, in jumps (-1 station, 32767 region). */
  readonly range: number;
  /** How far AWAY it is from the player — computed by the SERVER. */
  readonly jumps: number;
  readonly durationDays: number;
  /** Retail FILETIME; rendered as a date, never as a number. */
  readonly issuedAt: bigint | null;
}

/** What became of one of the player's own orders. */
export type MarketOwnFillState = "open" | "filled" | "expired" | "cancelled";

/** One of the player's own orders (GetCharOrders / GetMarketOrderHistory). */
export interface MarketOwnOrderRow {
  readonly orderID: string;
  readonly side: MarketSide;
  readonly typeID: number;
  readonly stationID: number;
  readonly solarSystemID: number;
  readonly price: string;
  readonly volumeRemaining: number;
  readonly volumeEntered: number;
  readonly minimumVolume: number;
  readonly range: number;
  readonly durationDays: number;
  /** ISK the SERVER has locked behind a buy order, as a decimal string. */
  readonly escrow: string;
  readonly state: MarketOwnFillState;
  readonly issuedAt: bigint | null;
  /** True for a corporation order. Out of scope to place, but shown if present
   * so the player is never given a partial picture of their own market. */
  readonly isCorp: boolean;
}

/** One completed trade (marketProxy.CharGetTransactions). */
export interface MarketTransactionRow {
  readonly transactionID: string;
  readonly typeID: number;
  readonly quantity: number;
  /** ISK per unit, as a decimal string. */
  readonly price: string;
  readonly stationID: number;
  /** Derived by comparing buyerID/sellerID with the character's own id. */
  readonly side: "bought" | "sold" | null;
  readonly transactedAt: bigint | null;
}

/** What the player currently has locked up behind open orders. */
export interface MarketEscrow {
  /** ISK locked behind buy orders, as a decimal string. */
  readonly isk: string;
  /** Units of goods locked behind sell orders. */
  readonly items: number;
}

/** One day of an item's price history. */
export interface MarketPriceHistoryRow {
  readonly day: bigint | null;
  readonly low: string;
  readonly high: string;
  readonly average: string;
  readonly volume: number;
  readonly orders: number;
}

/**
 * The Market page state (goal R16). The reads are INDEPENDENT — a failure to
 * read the public order book must not hide the player's own orders, and vice
 * versa — so each carries its own error.
 */
export interface MarketState {
  /** The item currently being looked at; null before one is chosen. */
  readonly typeID: number | null;
  readonly stationID: number | null;
  readonly solarSystemID: number | null;
  /** The broker's fee rate the pilot pays where it is docked, as a fraction; null where it is not known. */
  readonly brokersFeeRate: number | null;
  readonly sells: readonly MarketOrderRow[];
  readonly buys: readonly MarketOrderRow[];
  readonly ownOrders: readonly MarketOwnOrderRow[];
  readonly orderHistory: readonly MarketOwnOrderRow[];
  readonly transactions: readonly MarketTransactionRow[];
  readonly escrow: MarketEscrow | null;
  readonly priceHistory: readonly MarketPriceHistoryRow[];
  /** Personal ISK balance, decimal string (bigint-safe); null until read. */
  readonly cashBalance: string | null;
  readonly loaded: boolean;
  readonly bookError: string | null;
  readonly ownOrdersError: string | null;
  readonly transactionsError: string | null;
  /** Non-null when the market daemon itself is not answering. */
  readonly marketUnavailable: string | null;
  /** Non-null when the last place/cancel/modify failed or was declined. */
  readonly actionError: string | null;
  /**
   * What the LAST write actually did, read back from the server afterwards.
   * Never a prediction — see `MarketActionOutcome`.
   */
  readonly lastOutcome: MarketActionOutcome | null;
}

/**
 * The verdict on a completed write, assembled from RE-READS.
 *
 * ⚠ `charged` is the wallet balance BEFORE minus the balance AFTER — the only
 * authoritative statement about what an order cost. The estimated broker fee
 * shown at confirm time never appears here.
 */
export interface MarketActionOutcome {
  readonly kind: "buy" | "sell" | "cancel" | "modify";
  /** Did the server actually change anything? From the re-read, not the 200. */
  readonly applied: boolean;
  /** True when the server answered success and nothing moved. */
  readonly declinedSilently: boolean;
  /** ISK actually taken from (positive) or returned to (negative) the wallet. */
  readonly charged: string | null;
  /** The wallet balance after the write, as the server reports it. */
  readonly balanceAfter: string | null;
}

// --- R17 Mail ---------------------------------------------------------------

/**
 * One message HEADER from the delta sync.
 *
 * ⚠ `toCharacterIDs` is a COMMA-JOINED STRING on the wire and a real list on
 * the way back in (SendMail's args[0]). The two directions are not symmetric;
 * bridge/mail.ts splits the string in exactly one place, and by the time a row
 * reaches here it is already a proper list of ids.
 *
 * ⚠ `sentDate` is a retail FILETIME (100 ns ticks since 1601-01-01), which
 * exceeds 2^53 — so it stays a bigint until the moment it is rendered.
 */
export interface MailHeaderRow {
  readonly messageID: number;
  readonly senderID: number;
  readonly toCharacterIDs: readonly number[];
  /** Set when the message went to a mailing list (a surface out of this slice). */
  readonly toListID: number | null;
  /** Set when it went to a whole corporation or alliance. */
  readonly toCorpOrAllianceID: number | null;
  readonly title: string;
  readonly sentDate: bigint | null;
}

/** One status row: whether a message has been opened, and how it is filed. */
export interface MailStatusRow {
  readonly messageID: number;
  readonly statusMask: number;
  readonly labelMask: number;
  /** The read bit of statusMask, pulled out because it is the one that shows. */
  readonly read: boolean;
}

/** The body of the message currently open, as TEXT. */
export interface MailOpenMessage {
  readonly messageID: number;
  /**
   * ⚠ Already INFLATED. mailMgr.GetBody answers a zlib-DEFLATED buffer; the BFF
   * inflates it (src/server.js, mailBodyText) so this is plain text and the
   * browser never handles a compressed byte.
   */
  readonly body: string | null;
  /** True when the body arrived but would not inflate — say so, show no garbage. */
  readonly unreadable: boolean;
  /**
   * Whether the server now holds this message as read, from a RE-READ after
   * opening it. null when that re-read failed — in which case no claim is made.
   */
  readonly markedRead: boolean | null;
}

/**
 * The Mail page state (goal R17, Slice A).
 *
 * ⚠ The inbox arrives as a DELTA SYNC, not a list: SyncMail answers only what
 * falls outside the window the caller holds. The browser caches nothing across
 * a page load, so it is permanently cold and `messages` is always the whole
 * mailbox rather than a page of it.
 */
export interface MailState {
  readonly messages: readonly MailHeaderRow[];
  readonly statuses: readonly MailStatusRow[];
  /** How many are unread — what the tab badge shows. */
  readonly unreadCount: number;
  /** The message currently open, if any. */
  readonly open: MailOpenMessage | null;
  readonly loaded: boolean;
  readonly inboxError: string | null;
  /** Non-null when the last open/send failed or was declined. */
  readonly actionError: string | null;
  readonly lastOutcome: MailActionOutcome | null;
}

// --- Activity Center -------------------------------------------------------

/**
 * One independent Activity Center read. A successful empty answer is `ready`
 * with an empty value; it is never collapsed into an unavailable or failed
 * read. That distinction matters for notificationMgr/calendar, whose BFF
 * envelope deliberately returns null plus a per-arm error when one call fails.
 */
export type ActivityRead<T> =
  | { readonly status: "ready"; readonly value: T; readonly error: null }
  | { readonly status: "unavailable"; readonly value: null; readonly error: null }
  | { readonly status: "error"; readonly value: null; readonly error: string };

/** A recent notification, reduced to the fields the read-only panel presents. */
export interface ActivityNotificationRow {
  /** Store/key data only; the panel never renders game IDs. */
  readonly notificationID: number;
  /** Resolved through the shared owner-name cache before it reaches the player. */
  readonly senderID: number;
  readonly processed: boolean;
  readonly created: bigint | null;
  /** Player-facing notification category; never a raw typeID. */
  readonly title: string;
}

/** One upcoming calendar event from the requested UTC month. */
export interface ActivityCalendarEventRow {
  /** Store/key data only; the panel never renders game IDs. */
  readonly eventID: number;
  readonly ownerID: number;
  readonly eventDateTime: bigint | null;
  readonly eventDuration: number | null;
  readonly title: string;
  readonly importance: number;
}

/** This character's response to a calendar event. */
export interface ActivityCalendarResponseRow {
  /** Used only to join to an event; never rendered. */
  readonly eventID: number;
  readonly status: number;
}

/**
 * Read-only Activity Center state. Mail and the live tail remain authoritative
 * in their existing slices; this state records the two additional bridge reads
 * and whether the mail refresh performed alongside them failed.
 */
export interface ActivityState {
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly notifications: ActivityRead<readonly ActivityNotificationRow[]>;
  readonly unprocessedCount: ActivityRead<number>;
  readonly calendarEvents: ActivityRead<readonly ActivityCalendarEventRow[]>;
  readonly calendarResponses: ActivityRead<readonly ActivityCalendarResponseRow[]>;
  readonly mailError: string | null;
  readonly refreshedAtMs: number | null;
}

// --- Fleet Center ----------------------------------------------------------

export type FleetAction = "form" | "invite" | "accept" | "leave";

/**
 * Player-facing fleet state. `fleet` is the last authoritative bound read;
 * `availability` keeps a real FleetNotFound distinct from a failed read. The
 * pending invite comes from the existing OnFleetInvite live payload because an
 * invitee cannot discover the fleetID through the own-fleet read before joining.
 *
 * `lastBroadcast` and `targetTags` (below) live on THIS slice rather than a
 * new one on purpose: `fleet.set(INITIAL_FLEET)` in clientStore.ts already
 * fires from every place a fleet resets (logout, character online/offline,
 * fleet/cleared), so folding these fields into `INITIAL_FLEET` inherits that
 * reset wiring for free. A dedicated slice would need each of those call
 * sites updated by hand, and would silently drift the first time one of them
 * was missed.
 */
export interface FleetCenterState {
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly availability: FleetAvailability | "unknown";
  readonly fleet: BoundFleet | null;
  readonly pendingInvite: FleetPendingInvite | null;
  readonly activeAction: FleetAction | null;
  readonly readError: string | null;
  readonly actionError: string | null;
  readonly refreshedAtMs: number | null;
  /** The most recent OnFleetBroadcast call ("shoot that"). Last-write-wins. */
  readonly lastBroadcast: FleetBroadcast | null;
  /**
   * itemID -> standing target tag, from the last OnFleetStateChange.
   * ⚠ `null` and an empty map mean different things and must stay distinct:
   * `null` = never received (or unreadable) this fleet; an empty map =
   * received, and the fleet has tagged nothing. Same convention
   * `authoritativeFleetMemberCharacterIDs` uses in bridge/fleetCenter.ts — a
   * pilot that may WRITE tags reads "received, nothing tagged" as permission
   * to assign a letter, so collapsing the two would let it collide with a tag
   * that was really there.
   */
  readonly targetTags: ReadonlyMap<number, string> | null;
  /**
   * The fleet id of the last read that could actually SEE the fleet, used only
   * to decide whether the tags and the broadcast above still belong to the
   * fleet this pilot is in.
   *
   * ⚠ IT EXISTS BECAUSE `fleet.fleetID` CANNOT DO THIS JOB, and the reason is
   * subtle enough that it was got wrong once. An "unavailable" read (every
   * bridge call failed) is stored like any other: `fleet` is overwritten with
   * the decoded-but-empty value, whose `fleetID` is `null`. Refusing to CLEAR
   * on that read is not enough, because the read still destroys the id the
   * NEXT read compares against -- so a recovery to the very same fleet then
   * looks like a switch, and wipes tags nobody ever left behind.
   *
   * Updated only by an authoritative read, so a transport blip cannot move it.
   */
  readonly authoritativeFleetID: number | null;
}

// --- Scanner / Exploration Center -----------------------------------------

/**
 * Current-system scanner state. Each source keeps loading/unavailable/ready
 * separate so a failed bound read can never masquerade as an empty system.
 * Probe operations come from EveJS's held-session authority. The panel never
 * manufactures action prerequisites from scan results.
 */
export interface ScannerCenterState {
  readonly loaded: boolean;
  readonly loading: boolean;
  /** System whose authoritative scan produced `scan`; null before a successful read. */
  readonly solarSystemID: number | null;
  readonly scan: ScannerDataState<ScanFullState>;
  readonly operations: ScannerDataState<ScannerOperationsSnapshot>;
  readonly refreshedAtMs: number | null;
}

/** The verdict on a completed send, assembled from a RE-READ. */
export interface MailActionOutcome {
  readonly kind: "send";
  /** Did the message really land? From the sender-copy re-read, not the 200. */
  readonly applied: boolean;
  /** True when the server answered success and nothing was written. */
  readonly declinedSilently: boolean;
  /** How many people it went to. */
  readonly recipientCount: number;
  /**
   * What the server said, when it declined without giving a reason. Never a
   * cause this client invented.
   */
  readonly message: string | null;
}

// --- R17 Contracts ----------------------------------------------------------

/**
 * One contract.
 *
 * ⚠ `price`, `reward` and `collateral` are DECIMAL STRINGS, not numbers: ISK
 * exceeds 2^53 in ordinary play and routing it through a JS number would round
 * it on the way to the screen (R7d).
 *
 * ⚠ The four dates are retail FILETIMEs (100 ns ticks since 1601-01-01), which
 * exceed 2^53 — so they stay bigints until they are rendered.
 */
export interface ContractRow {
  readonly contractID: number;
  /** 1 item trade, 2 auction (stubbed server-side), 3 delivery job. */
  readonly type: number;
  readonly status: number;
  readonly availability: number;
  readonly issuerID: number;
  readonly issuerCorpID: number;
  readonly forCorp: boolean;
  /** Who it is reserved for; null when it is open to anyone. */
  readonly assigneeID: number | null;
  /** Who took it; null while nobody has. */
  readonly acceptorID: number | null;
  readonly dateIssued: bigint | null;
  readonly dateExpired: bigint | null;
  readonly dateAccepted: bigint | null;
  readonly dateCompleted: bigint | null;
  readonly numDays: number;
  readonly startStationID: number;
  readonly endStationID: number;
  readonly startSolarSystemID: number;
  readonly endSolarSystemID: number;
  readonly price: string | null;
  readonly reward: string | null;
  readonly collateral: string | null;
  /** Cubic metres of cargo. */
  readonly volume: number;
  readonly title: string;
  readonly description: string;
}

/** One item attached to a contract. */
export interface ContractItemRow {
  readonly typeID: number;
  readonly quantity: number;
  /**
   * True when the item is being HANDED OVER, false when it is being ASKED FOR
   * — the difference between a gift and a trade.
   */
  readonly inCrate: boolean;
}

/** One contract in full: the row, its items, and its route endpoints. */
export interface ContractDetail {
  readonly contract: ContractRow;
  readonly items: readonly ContractItemRow[];
  readonly startSolarSystemID: number;
  readonly endSolarSystemID: number;
}

/** The headline counts from GetLoginInfo. */
export interface ContractSummary {
  readonly needsAttention: number;
  readonly inProgress: number;
  readonly assignedToMe: number;
}

/**
 * The Contracts page state (goal R17, Slice B).
 *
 * The reads are INDEPENDENT: a public browse that fails must not hide the
 * player's own contracts, so each keeps its own error.
 */
export interface ContractsState {
  /** The public courier browse. Legitimately EMPTY in a world with no contracts. */
  readonly browse: readonly ContractRow[];
  readonly numFound: number;
  readonly page: number;
  readonly pageSize: number;
  /** The player's own: issued and waiting, taken on, and expired. */
  readonly outstanding: readonly ContractRow[];
  readonly accepted: readonly ContractRow[];
  readonly expired: readonly ContractRow[];
  /**
   * Contracts SOMEONE ELSE reserved for this character (or their corp, or
   * their alliance) and that are still waiting to be taken on.
   *
   * ⚠ THESE ARE IN NO OTHER LIST. `outstanding` is what you ISSUED,
   * `accepted` what you TOOK ON, and the browse only ever holds PUBLIC
   * contracts — a contract reserved for you is none of those. Without this the
   * summary counts one waiting for you and nothing on the page can show it.
   */
  readonly assigned: readonly ContractRow[];
  /**
   * How many are assigned in total. Greater than `assigned.length` means the
   * BFF's fan-out limit cut the list short — the panel says so rather than
   * showing fewer than the count promised.
   */
  readonly numAssigned: number;
  readonly summary: ContractSummary | null;
  /** The contract currently opened in full, if any. */
  readonly detail: ContractDetail | null;
  readonly loaded: boolean;
  readonly browseError: string | null;
  readonly mineError: string | null;
  readonly assignedError: string | null;
  readonly detailError: string | null;
  /**
   * Set while a contract is being taken on, and cleared when the reload that
   * follows has landed. The panel disables the action rather than letting a
   * second click fire a second irreversible transfer.
   */
  readonly accepting: number | null;
  /** What the server said about the last accept, in the words it used. */
  readonly acceptError: string | null;
  /** The contract most recently taken on, for the panel to confirm by name. */
  readonly acceptedContractID: number | null;
  /**
   * ⚠ TRUE ONLY WHEN THE BROWSE SUCCEEDED AND FOUND NOTHING — never inferred
   * from an absence. EveJS has no NPC/seed contract generator, so an empty
   * public browse is EXPECTED, and the panel says so plainly. "The browse
   * failed" and "this world has no contracts yet" must never look alike.
   */
  readonly worldHasNoContracts: boolean;
}

// --- R4 Agents & Missions --------------------------------------------------

/**
 * One agent at the docked station (agentMgr.GetAgents, decoded + filtered to
 * the station by the BFF). The browser addresses the agent by agentID.
 */
export interface AgentRow {
  readonly agentID: number;
  readonly agentTypeID: number | null;
  readonly divisionID: number | null;
  readonly level: number | null;
  readonly stationID: number | null;
  readonly corporationID: number | null;
  readonly missionKind: string | null;
  readonly missionTypeLabel: string | null;
}

/**
 * One available conversation action from a DoAction result. `actionID` is the
 * server-assigned dialogue token the UI sends back to DoAction; `buttonType` is
 * the retail dialogue-button constant (2=Request, 3=Accept, 6=Complete,
 * 9=Decline, 11=Quit, ...) that selects the presentation/label.
 */
export interface AgentAction {
  readonly actionID: number;
  readonly buttonType: number;
  readonly label: string;
}

/** The last-action-info flags a DoAction result carries. */
export interface AgentLastActionInfo {
  readonly missionCompleted: boolean | null;
  readonly missionDeclined: boolean | null;
  readonly missionQuit: boolean | null;
  /** How long until the agent will offer the mission again, when that is why there is none: any amount means "not yet". */
  readonly missionCantReplay?: number | null;
  readonly loyaltyPoints: number | null;
}

/** A decoded agent conversation: what the agent says + the action buttons. */
export interface AgentConversation {
  readonly agentSays: string;
  /**
   * What the agent says as the server sent it: a localisation label with its
   * parameters, plain text, or a message's number (a mission's own text).
   * Null when it is none of those.
   */
  readonly agentSaysWords: QuestionWords | null;
  readonly contentID: number | null;
  readonly actions: readonly AgentAction[];
  /**
   * Whether the agent offers one of its special interactions: an action whose data is a briefing and
   * not a button's number. The client draws those as links under what the agent says, in the place
   * of the mission's time.
   */
  readonly specialInteractions?: boolean;
  readonly lastActionInfo: AgentLastActionInfo;
}

/**
 * The courier briefing decoded from GetMissionBriefingInfo +
 * GetMissionObjectiveInfo. ISK amounts and FILETIMEs are kept as decimal
 * strings (bigint-safe — ISK can exceed 2^53), decoded with unwrapLong; never
 * the lossy `typeof === "number" ? … : 0` pattern.
 */
export interface CourierBriefing {
  readonly missionTitleID: number | null;
  readonly cargoTypeID: number | null;
  readonly cargoQuantity: number | null;
  readonly cargoVolume: number | null;
  readonly pickupLocationID: number | null;
  readonly pickupSystemID: number | null;
  readonly destinationLocationID: number | null;
  readonly destinationSystemID: number | null;
  readonly rewardISK: string | null;
  readonly bonusISK: string | null;
  readonly loyaltyPoints: number | null;
  readonly expirationTime: string | null;
  readonly acceptTimestamp: string | null;
}

/** One journal mission row (active or offered) from GetMyJournalDetails. */
export interface JournalMission {
  readonly missionState: number | null;
  /** Whether the server marks the mission important (the client then says so beside its type). */
  readonly importantMission?: boolean;
  readonly missionTypeLabel: string | null;
  readonly missionTitleID: number | null;
  /** The mission's name when the server sent text and not a message's number. */
  readonly missionTitle?: string | null;
  readonly agentID: number | null;
  readonly missionID: number | null;
  readonly expirationTime: string | null;
}

/**
 * A mission's page, as the retail client's job board holds the job it is drawn from: what the journal's
 * line said when the page was opened, the mission's own objectives as last read, and the client's own
 * record of the mission.
 */
export interface MissionPageState {
  readonly agentID: number;
  readonly contentID: number | null;
  readonly missionState: number | null;
  readonly important: boolean;
  readonly expirationTime: string | null;
  readonly missionTitleID: number | null;
  readonly missionTitle: string | null;
  readonly objectives: MissionObjectives | null;
  readonly record: import("../bridge/missionPage.ts").ClientMission | null;
}

/** The decoded mission journal: active + offered missions. */
export interface JournalState {
  readonly active: readonly JournalMission[];
  readonly offered: readonly JournalMission[];
}

/**
 * The Agents & Missions page state (goal R4): the station's agents, the open
 * conversation, the accepted-courier briefing, and the mission journal. The
 * browser addresses agents by game ID; the BFF holds the bound agent handles.
 */
export interface AgentsState {
  readonly stationID: number | null;
  readonly agents: readonly AgentRow[];
  readonly activeAgentID: number | null;
  readonly conversation: AgentConversation | null;
  /**
   * Each mission's keywords, by "<agentID>:<contentID>": what the agent
   * answers to GetMissionKeywords, which the client adds to the arguments of
   * everything that agent says about that mission (its places and its things).
   */
  readonly missionKeywords: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly briefing: CourierBriefing | null;
  /**
   * The mission's objectives as read for the layout on show (the window's right-hand pane); null with
   * no mission, and after an action that ended it.
   */
  readonly objectives: MissionObjectives | null;
  /** What the mission's briefing says of time, as read for the layout on show; null with no briefing. */
  readonly missionTimes: MissionTimes | null;
  /** The mission's page on show (the journal's Read Details); null when none is. */
  readonly missionPage: MissionPageState | null;
  /**
   * What the client's agents service knows of each agent asked about, by its ID: null for an agent the
   * server does not list, and no entry at all for one not yet answered.
   */
  readonly agentRecords: Readonly<Record<number, import("../bridge/agents.ts").AgentRecord | null>>;
  /**
   * The solar system each agent asked about is in, by the agent's ID, as the server answers
   * agentMgr.GetSolarSystemOfAgent: null for none, and no entry at all for one not yet answered.
   */
  readonly agentSolarSystems: Readonly<Record<number, number | null>>;
  readonly journal: JournalState | null;
  /** True once the agent list has loaded. */
  readonly loaded: boolean;
  /** Non-null when the last agent action/read failed (non-fatally). */
  readonly actionError: string | null;
}

// --- R6 Courier completion reward readout (Step 12) ------------------------

/**
 * One character loyalty-point balance from
 * LPSvc.GetAllMyCharacterWalletLPBalances: the issuing corp and the amount.
 * LP is kept as a bigint-safe decimal string (the decoder rule for LP/ISK).
 */
export interface WalletLPBalance {
  readonly issuerCorpID: number;
  readonly loyaltyPoints: string;
}

/**
 * One character standing row from standingMgr.GetCharStandings: the standing
 * the character holds toward `fromID`. `standing` is a small float (‑10..10),
 * kept as a number.
 */
export interface CharStanding {
  readonly fromID: number;
  readonly standing: number;
}

/**
 * The post-completion reward readout (goal R6, inventory Step 12): the pull
 * reads a wallet/LP/standings panel issues after Complete pays out
 * (account.GetCashBalance / LPSvc.GetAllMyCharacterWalletLPBalances /
 * standingMgr.GetCharStandings). The mission journal (the fourth Step-12 read)
 * lives in the agents slice (`agents.journal`) and refreshes on the same
 * Complete. Each read is independent (Promise.allSettled on the BFF); a failed
 * read carries its own error code. ISK/LP are decimal strings (bigint-safe).
 */
export interface RewardsState {
  /** Personal ISK balance (account.GetCashBalance), decimal string; null until read. */
  readonly cashBalance: string | null;
  readonly lpBalances: readonly WalletLPBalance[];
  readonly standings: readonly CharStanding[];
  /** True once a reward read has populated the slice. */
  readonly loaded: boolean;
  /** Non-null when one or more of the reward reads failed (non-fatally). */
  readonly error: string | null;
}

// --- R50 Wallet + Corp Wallet ----------------------------------------------

/**
 * One corporation wallet division from account.GetWalletDivisionsInfo (goal
 * R50): the balance the retail corp-wallet window shows per division. `key` is
 * the retail ACCOUNT KEY (1000..1006, never rendered); `division` is its 1..7
 * ordinal (key - 999); `name` is the corporation's player-authored division
 * name, or null when it was never renamed (the panel then shows "Division N").
 * `balance` is a bigint-safe decimal string in ISK — 0 ISK is a real balance,
 * not an absence.
 */
export interface CorpWalletDivision {
  readonly key: number;
  readonly division: number;
  readonly name: string | null;
  readonly balance: string;
}

/**
 * One wallet ledger entry (goal R54) — a row of account.GetJournal (a Rowset)
 * or account.GetTransactions (a list<KeyVal>), both decoded to the same shape.
 * What money moved (`amount`, signed ISK), when (`date`, a FILETIME), and why
 * (`refType`, the human ref-type label resolved from account.GetEntryTypes).
 *
 * ⚠ R7d: NO raw id is carried into rendered text. `id` is the transactionID kept
 * ONLY as a bigint-safe key for a keyed list (never printed); the row's
 * referenceID/ownerIDs and the server's free-text description (which embeds
 * typeIDs/systemIDs) are deliberately NOT decoded, so nothing numeric-but-not-a-
 * quantity can leak. `amount` is a bigint-safe decimal string (ISK exceeds
 * 2^53); `date` is a FILETIME bigint (100 ns ticks since 1601), null when absent.
 */
export interface LedgerEntry {
  readonly id: string;
  readonly date: bigint | null;
  readonly amount: string;
  readonly refType: string;
}

/**
 * The Wallet + Corp Wallet nav tabs (goal R50, extended R54). Every half reads
 * from one BFF pull (/api/bridge/wallet): the PERSONAL ISK balance
 * (account.GetCashBalance) and the CORP division balances
 * (account.GetWalletDivisionsInfo), plus — R54 — the personal LEDGER
 * (account.GetJournal + account.GetTransactions, ref-types labelled from
 * account.GetEntryTypes). Each read keeps its own error so one failure never
 * blanks the others.
 *
 * ⚠ null-vs-`[]` is load-bearing on every list: `corpDivisions`/`journal`/
 * `transactions` are null when the read has not answered yet OR FAILED (see the
 * matching `*Error`); an empty list `[]` is a real "no divisions / no ledger
 * entries yet" answer. The two must never look alike (the worldHasNoContracts
 * precedent). ISK is a bigint-safe decimal string.
 */
export interface WalletState {
  readonly cashBalance: string | null;
  readonly cashError: string | null;
  readonly corpDivisions: readonly CorpWalletDivision[] | null;
  readonly corpError: string | null;
  /** The wallet's activity, as the client reads it (account.GetTransactions): what it lists as "Transactions". */
  readonly journal: readonly LedgerEntry[] | null;
  readonly journalError: string | null;
  /** True once a wallet read has populated the slice. */
  readonly loaded: boolean;
}

// --- R55 Standings ----------------------------------------------------------

/**
 * One row of a standing COMPOSITION (standingMgr.GetStandingCompositions): a
 * corporation member (`ownerID`, a player character) and the standing THEY hold
 * toward the selected NPC entity — the per-member breakdown the retail panel
 * shows for a corp-standing row. `ownerID` is an entity id and is NEVER rendered
 * as a number (R7d); it is resolved to a name, degrading to "Unknown entity".
 */
export interface StandingComposition {
  readonly ownerID: number;
  readonly standing: number;
}

/**
 * One row of a standing's HISTORY (standingMgr.GetStandingTransactions): a dated
 * event that changed the standing. `eventTypeID` is mapped to a plain label
 * (R9a); `modification` is the recorded raw change (a small server-owned float,
 * shown as-is — the client does not recompute standing math). `id` is a stable
 * list key only and is never rendered; the row's own fromID/toID/int_* fields
 * are entity ids and are NOT decoded, so no raw id can reach the panel (R7d).
 */
export interface StandingTransaction {
  readonly id: string;
  readonly date: bigint | null;
  readonly eventTypeID: number;
  readonly modification: number;
}

/**
 * The Standings page (goal R55). Two lists, each read with its own call
 * (bridge/standingsReads.ts): the character's own standings toward NPC entities
 * (standingMgr.GetCharStandings) and the character's CORPORATION's standings
 * (standingMgr.GetCorpStandings). Each keeps its own error so one failed read
 * never blanks the other. A `fromID` is ALWAYS resolved to a name (R7d) — the
 * page never renders a numeric entity id.
 *
 * ⚠ empty vs failed. `char`/`corp` start NULL (unread / read FAILED — the reason
 * rides in the matching *Error); a SUCCESSFUL read with no rows decodes to [] —
 * a real "no standings with anyone yet" (worldHasNoContracts precedent).
 *
 * The drill-down is loaded on demand for one selected entity: a character-row's
 * standing HISTORY (`transactions`) or a corp-row's per-member COMPOSITION
 * (`compositions`). `detailFromID`/`detailScope` say which row (and section) the
 * loaded detail belongs to, so a late read never repaints the wrong row.
 */
export interface StandingsState {
  readonly char: readonly CharStanding[] | null;
  readonly charError: string | null;
  readonly corp: readonly CharStanding[] | null;
  readonly corpError: string | null;
  readonly loaded: boolean;
  readonly detailFromID: number | null;
  readonly detailScope: "char" | "corp" | null;
  readonly transactions: readonly StandingTransaction[] | null;
  readonly compositions: readonly StandingComposition[] | null;
  readonly detailError: string | null;
}

// --- R56 Character Sheet ----------------------------------------------------

/**
 * Who this character is, from charMgr.GetPublicInfo3 (goal R56). Public identity
 * only — the same fields any character can see about another. Every id here is
 * kept ONLY to be resolved to a name (R7d): `corporationID`/`allianceID` are
 * name-resolved by the page and NEVER rendered as numbers; a PLAYER corp that
 * static data cannot name degrades to "Unknown corporation" (Farmer's own corp
 * does exactly this). `securityStatus` is a FLOAT, not an id, and is shown as-is.
 *
 * ⚠ bloodlineID / raceID / ancestryID are NOT here on purpose: they have no name
 * path (no /api/names kind, no staticData resolver), so decoding them would only
 * create a number with nowhere to resolve. They are omitted, not rendered raw.
 */
export interface CharacterIdentity {
  readonly characterID: number;
  readonly characterName: string;
  /** 0 when absent; resolved to a name by the page (R7d). */
  readonly corporationID: number;
  /** null when the character is in no alliance. */
  readonly allianceID: number | null;
  /** A signed float on the −10..+10 security scale. Shown as-is, never an id. */
  readonly securityStatus: number;
}

/**
 * One implant in the active clone (charMgr.GetCloneInfo). `typeID` is resolved to
 * a name by the page (R7d); `slot` is the 1..10 implant slot, a plain ordinal.
 */
export interface CharacterImplant {
  readonly typeID: number;
  readonly slot: number;
}

/**
 * The clone summary from charMgr.GetCloneInfo (goal R56): the active clone's
 * implants and how many jump clones the character has installed. Farmer measured
 * live has NEITHER — a "clean" clone with an empty implants dict — which is a
 * REAL answer the page renders honestly, not a failure.
 */
export interface CloneSummary {
  /** Null where the answer does not say: the client's own read of the implants carries none of the three. */
  readonly homeStationID: number | null;
  readonly cloneStationID: number | null;
  readonly implants: readonly CharacterImplant[];
  readonly jumpCloneCount: number | null;
}

/**
 * The Character Sheet page (goal R56): who the character is, where home is, and
 * their clone. Four independent reads, each asked by its own call
 * (bridge/characterSheetReads.ts), each with its own error so one failure never
 * blanks the rest.
 *
 * ⚠ empty vs failed, per field. `identity`/`clone` are null while unread OR when
 * that read FAILED (the reason rides in the matching `*Error`). `description` is
 * null unread/failed but "" is a REAL empty bio (a character who wrote none).
 * `homeStationID` is null unread/failed; a resolved station NAME comes from
 * /api/names, never the id.
 */
export interface CharacterSheetState {
  readonly identity: CharacterIdentity | null;
  readonly identityError: string | null;
  readonly description: string | null;
  readonly descriptionError: string | null;
  readonly homeStationID: number | null;
  readonly homeStationError: string | null;
  readonly clone: CloneSummary | null;
  readonly cloneError: string | null;
  readonly loaded: boolean;
}

// --- R6a Agent Finder ------------------------------------------------------

/**
 * One agent from the static agentAuthority reference table (goal R6a), with its
 * station/system names resolved server-side and its jump distance from the
 * player's current system computed client-side (a single BFS — distancesFrom).
 * `jumps` is null when the agent's system is unreachable or the origin is
 * unknown; the finder sorts those last. The browser addresses the agent by
 * agentID (to bind it on arrival via the R4 agent flow) and by stationID (for
 * the R5b "Set destination" autopilot).
 */
export interface AgentFinderRow {
  readonly agentID: number;
  readonly name: string;
  readonly level: number | null;
  readonly missionKind: string | null;
  readonly missionTypeLabel: string | null;
  readonly corporationID: number | null;
  readonly factionID: number | null;
  readonly stationID: number | null;
  readonly stationName: string | null;
  readonly solarSystemID: number | null;
  readonly solarSystemName: string | null;
  /** Jumps from the player's current system; null = unreachable / unknown origin. */
  readonly jumps: number | null;
}

/**
 * The agent the player set the autopilot to (so the panel can show who they are
 * flying to). A projection of the chosen AgentFinderRow.
 */
export interface AgentFinderTarget {
  readonly agentID: number;
  readonly name: string;
  readonly level: number | null;
  readonly stationID: number | null;
  readonly stationName: string | null;
  readonly solarSystemID: number | null;
  readonly solarSystemName: string | null;
  readonly jumps: number | null;
}

/**
 * The Agent Finder page state (goal R6a): the filtered/capped agents (already
 * annotated with jumps and sorted nearest-first by the flow), the filter echo,
 * and the currently-selected destination agent. The full ~11k-agent dataset is
 * never held here — the BFF filters by kind/level and caps; `total`/`capped`
 * report how much was matched vs returned so the UI can prompt for a narrower
 * filter. The rendered rows are further capped in the view (like R6's roster).
 */
export interface AgentFinderState {
  readonly kind: string;
  readonly level: number | null;
  readonly originSystemID: number | null;
  readonly agents: readonly AgentFinderRow[];
  /** Full match count before the server cap. */
  readonly total: number;
  /** True when the server cap dropped some matches (narrow the filter). */
  readonly capped: boolean;
  /** True once a find has populated the slice. */
  readonly loaded: boolean;
  readonly target: AgentFinderTarget | null;
  /** Non-null when the last find failed (non-fatally). */
  readonly error: string | null;
}

// --- R5a Flight (manually-stepped space movement) --------------------------

/**
 * The flight status snapshot (goal R5a): the persistent session's current
 * location + ship movement state, read from the gateway's
 * session/flight-status. IDs decode with unwrapLong (long-aware); system,
 * station, and ship IDs all fit in 2^53, so they are kept as `number`.
 * `shipMode` is the scene entity's movement mode (e.g. WARP / STOP), null when
 * docked or unavailable.
 */
export type FlightTransitionKind = "idle" | "undock" | "dock" | "stargate" | "board" | "clone" | "other-session";
export type FlightTransitionPhase =
  | "requested"
  | "accepted"
  | "session-changing"
  | "ready"
  | "failed";

/** Readiness is separate from the ten-second next-mutation cooldown. */
export interface FlightTransition {
  readonly epoch: number;
  readonly kind: FlightTransitionKind;
  readonly phase: FlightTransitionPhase;
  readonly startedAtMs: number | null;
  readonly cooldownUntilMs: number | null;
  readonly fromSolarSystemID: number | null;
  readonly toSolarSystemID: number | null;
  readonly stationID: number | null;
  readonly shipID: number | null;
  readonly sessionStable: boolean;
  readonly locationReady: boolean;
  readonly sceneReady: boolean;
  readonly egoReady: boolean;
  readonly shipReady: boolean;
  readonly boundContextReady: boolean;
  readonly failure: string | null;
}

export interface FlightStatus {
  readonly inSpace: boolean;
  readonly docked: boolean;
  readonly solarSystemID: number | null;
  readonly stationID: number | null;
  readonly structureID: number | null;
  readonly shipID: number | null;
  readonly shipTypeID: number | null;
  /**
   * The hull's group, as godma's own item of the ship has it; `null`, or absent, where the BFF did not say (the
   * gateway's flight does not). The client's lobby tells a corvette by it (idCheckers.IsNewbieShip: group 237).
   */
  readonly shipGroupID?: number | null;
  /**
   * Whether the hull being flown is a capsule — i.e. the ship was lost and the
   * pilot is in a pod. TRI-STATE: `null` is "the gateway did not say", which is
   * never a verdict either way (an older BFF omits it entirely).
   *
   * ⚠ THIS IS THE ONLY HONEST SOURCE. `snapshot.ship.typeID` looks like it would
   * do, but the space snapshot is exactly the read that comes back empty while a
   * session change settles — see bridge/space.ts `decodeSpaceSnapshot`, which
   * manufactures a confident-empty snapshot rather than a null one. Flight
   * status is authoritative and survives that window.
   */
  readonly shipIsCapsule: boolean | null;
  readonly shipMode: string | null;
  readonly shipSpeedFraction: number | null;
  /** Present on current BFFs; absent only when talking to an older one. */
  readonly transition?: FlightTransition;
}

/**
 * The Flight page state (goal R5a): the current flight status plus the last
 * movement step issued and any refusal reason. Manual single-step movement —
 * the browser sequences undock/warp/jump/dock via buttons; the autopilot
 * decide-loop is R5b.
 */
export interface FlightState {
  readonly status: FlightStatus | null;
  /** True once a flight-status read has populated the slice. */
  readonly loaded: boolean;
  /** The last movement step issued (for the status readout). */
  readonly lastAction: string | null;
  /** Non-null when the last movement step failed (the handler's refusal reason). */
  readonly actionError: string | null;
  /**
   * Resolved location names for the current status (goal R7a), so the readout
   * shows "Jita" not "30000142". Resolved from the static /api/map routes and
   * cached client-side by the flow; null until resolved (the UI falls back to
   * the raw ID) and cleared whenever the corresponding ID changes.
   */
  readonly solarSystemName: string | null;
  readonly stationName: string | null;
  readonly structureName: string | null;
  /** The pilot's combat timers and its ship's safety level, as crimewatch last said them; null until read. */
  readonly crimewatch: CrimewatchReading | null;
}

// --- R11 Space overview + ship HUD -----------------------------------------

/** A position or velocity in space (metres, metres/second). */
export interface SpaceVector {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * One object the ship can see (goal R11). This is the browser's half of the
 * structure retail's overview reads: the server hands over identity, position
 * and velocity, and the CLIENT computes distance, sorting and filtering — the
 * same division the real client uses. `typeID`/`groupID`/`categoryID` exist so
 * the name cache can resolve a TYPE and GROUP name; they are never rendered
 * (R7d). Health fields are remaining fractions (0-1) or null for an object with
 * no damageable health (a planet, a stargate).
 */
export interface SpaceEntity {
  /** Absent velocity must not become a stopped-object proof. */
  readonly motionAvailable?: boolean;
  /** True only when position and radius were supplied as finite measurements. */
  readonly geometryAvailable?: boolean;
  /** Coarse runtime kind ("ship", "structure", "celestial", …), or null. */
  readonly kind: string | null;
  /** The object's own id — used only as a row key and as a move target. */
  readonly itemID: number;
  readonly typeID: number | null;
  readonly groupID: number | null;
  readonly categoryID: number | null;
  /** The object's own name where it has one (a celestial, a named ship). */
  readonly name: string | null;
  readonly ownerID: number | null;
  readonly radius: number;
  readonly position: SpaceVector;
  readonly velocity: SpaceVector;
  /** True for the player's own ship (excluded from the overview list). */
  readonly isSelf: boolean;
  readonly shieldRatio: number | null;
  readonly armorRatio: number | null;
  readonly hullRatio: number | null;
  readonly characterID: number | null;
  readonly corporationID: number | null;
  readonly allianceID: number | null;
  readonly securityStatus: number | null;
  readonly maxVelocity: number | null;
  readonly mode: string | null;
  readonly capacitorRatio: number | null;
  /**
   * R23 slice B — asteroid rows only (null on everything else).
   *
   * `name`/`typeID` already resolve to the ORE, because the server stamps a
   * rock's display name and slim type from the ore it holds. These three add
   * what a miner actually needs: which ore the laser yields, which belt the rock
   * belongs to, and HOW MUCH IS LEFT.
   *
   * `remainingQuantity` is null for "unknown" — either the row is not a rock, or
   * the server had no mining record for it. It is NEVER 0 to mean unknown: a
   * zero reads as a mined-out rock and would send a player past a full belt.
   */
  readonly remainingQuantity: number | null;
  readonly miningYieldTypeID: number | null;
  /**
   * A customs office's planet, as its slim item says it (the retail client
   * opens the office's window for that planet's colony). null on every other
   * row, and on an office where the transport did not say: the web gateway's
   * snapshot does not.
   */
  readonly planetID?: number | null;
  readonly miningResourceFamily?: "ore" | "ice" | "gas" | null;
  readonly beltID: number | null;
  /**
   * The rock's ORE GRADE — dogma attribute 2699 (asteroid meta level), read by
   * the BFF from static data: 0-Grade = 0, plain = 1, II-Grade = 2, III = 3,
   * IV = 4. Higher is richer. null when the row is not a rock or the type has
   * no such attribute; a null is NOT a zero (an unknown grade sorts last, it is
   * never treated as the worst).
   */
  readonly oreGrade: number | null;
  /**
   * What the rock's ore is WORTH, in ISK per cubic metre — the number behind the
   * retail client's Mining Surveyor "Ore Value" gradient, computed by the BFF
   * from static data (reprocessed material value ÷ portion size ÷ unit volume).
   *
   * Per m³ and not per unit, because a hold is a volume: this is what one trip
   * is worth, which is the only ranking a miner can act on. null when the row is
   * not a rock, or when a price, a portion size or a volume was missing — and a
   * null is never a zero, which would rank a rock as worthless.
   */
  readonly oreValuePerM3: number | null;
  /**
   * R25 slice B — SHIP rows only. The only thing that separates a pirate from a
   * person.
   *
   * ⚠ A belt rat is `kind: "ship"`. It is built through the same entity path as
   * the player parked next to you and carries the same name, position, health
   * and velocity fields, so `kind` cannot tell them apart and neither can
   * anything else this row carried before R25.
   *
   * `isNpc` is the runtime's own "nobody is flying this" flag. `npcEntityType`
   * is which KIND of NPC, verbatim from the runtime: "npc" (pirates — the thing
   * that shoots a miner), "concord" (law enforcement, which does not),
   * "drifter". Both are null/false on rows the gateway does not project them
   * for, so a non-ship row is never mistaken for a friendly ship.
   */
  readonly isNpc: boolean;
  readonly npcEntityType: string | null;
  /**
   * R25 slice A — DRONE rows only (null on everything else).
   *
   * `ownerID` (above) already says whose drone it is; `controllerID` says which
   * HULL is flying it, which is the question that matters after a ship swap.
   * `droneActivity` is what it is doing as a word ("idle", "fighting",
   * "mining", …) — NULL means the gateway could not tell, never "idle".
   * `targetEntityID` is the ball it is busy with, so the panel can name the rock
   * or the rat instead of reporting a bare "mining".
   */
  readonly controllerID: number | null;
  readonly droneActivity: string | null;
  readonly targetEntityID: number | null;
  /**
   * SHIP rows only — this hull is an ORE-COMPRESSION FACILITY right now: a mining
   * support ship running an Industrial Core plus a compression module. Null on
   * every other row and on a support ship whose modules are off, so it doubles as
   * the "can I compress against this ship?" test. Being your own ship or a
   * FLEET-MATE's, and being inside `rangeMeters`, are still the server's checks —
   * this only says the facility is live.
   *
   * ⚠ OPTIONAL so a server that does not project it yet still decodes, and
   * ABSENT MUST READ AS "NOT A FACILITY" — never as an unknown worth trying.
   * Read it as `entity.compressionFacility ?? null`.
   */
  readonly compressionFacility?: CompressionFacility | null;
  /** Exact service projection; absent on older gateways, never inferred from the legacy max range. */
  readonly compressionService?: CompressionServiceObservation;
}

/** A live ore-compression facility's reach, and which ore families it handles. */
export interface CompressionFacility {
  /** The widest live range in metres — the one the server's own check applies. */
  readonly rangeMeters: number;
  /** The facility's type-list ids (empty when the gateway sent none). */
  readonly typeListIDs: readonly number[];
}

/**
 * The active ship's HUD numbers (goal R11). A DIFFERENT source from the
 * overview: shield / armor / hull / capacitor for the player's own ship come
 * from the ship item's dogma-backed state, not from the ballpark the overview
 * enumerates. Ratios are remaining fractions (0-1); capacities are the max HP
 * behind each bar (null when unavailable).
 */
/** What the pilot last aligned to: a thing in space, or a bookmark. */
export interface ShipAlignTarget {
  /** The thing, or null for a bookmark. */
  readonly itemID: number | null;
  readonly bookmark: boolean;
}

/** What the retail client's HUD words a warp from. */
export interface ShipWarp {
  /** Still lining up: the warp proper has not begun. */
  readonly preparing: boolean;
  /** The point the server's warp is aimed at, or null when it has not said. */
  readonly point: SpaceVector | null;
  /** The thing the pilot asked to warp to, when the warp is aimed at it; else null. */
  readonly destinationID: number | null;
}

export interface SpaceShipStatus {
  /** True only when all velocity components are measured finite values. */
  readonly motionAvailable?: boolean;
  /** True only when position and radius were supplied as finite measurements. */
  readonly geometryAvailable?: boolean;
  /** Own facility identity even when the overview omits the self row. */
  readonly characterID?: number | null;
  readonly ownerID?: number | null;
  /** null/absent means the authoritative active-effect map was unavailable. */
  readonly miningBurstServices?: MiningBurstServices | null;
  readonly coreMobilityFuel?: CoreMobilityFuelObservation | null;
  readonly moduleReach?: ModuleReachObservation | null;
  readonly compressionService?: CompressionServiceObservation;
  readonly itemID: number | null;
  readonly typeID: number | null;
  readonly name: string | null;
  readonly mode: string | null;
  readonly maxVelocity: number | null;
  /**
   * The ship's own hull radius, so the client can measure SURFACE distance the
   * way the server does — max(0, centre-to-centre - rA - rB). The autopilot
   * decides jump / dock / approach / warp from that measure (goal R13).
   */
  readonly radius: number;
  readonly position: SpaceVector;
  readonly velocity: SpaceVector;
  readonly shieldRatio: number | null;
  readonly armorRatio: number | null;
  readonly hullRatio: number | null;
  readonly capacitorRatio: number | null;
  readonly shieldCapacity: number | null;
  readonly armorCapacity: number | null;
  readonly hullCapacity: number | null;
  /**
   * The fitted modules the SERVER says are cycling right now (goal R23). Read
   * from the ship entity's own active-effect map, never from the browser's
   * memory of what it clicked — otherwise the page would keep claiming a module
   * is running after the server short-cycled it (target lost, hold full, out of
   * range). Empty means nothing is running; null means the read could not
   * answer and the page must say "unknown", not "off".
   */
  readonly activeModuleIDs: readonly number[] | null;
  /**
   * Which fitted modules are OVERLOADED, from the ship entity's own overload
   * map — the same contract as `activeModuleIDs` above and for the same reason.
   *
   * ⚠ IT OUTLIVES THE CLICK. Overloading persists across calls and the SERVER
   * ends it on its own when a module burns out, so a page that remembered what
   * it clicked would keep showing heat on a module that stopped minutes ago.
   * Empty means nothing is overloaded; null means the read could not answer.
   */
  readonly overloadedModuleIDs: readonly number[] | null;
  /**
   * How damaged each module is, keyed by itemID — 0 exclusive to 1, where 1 is
   * burnt out. Only DAMAGED modules appear.
   *
   * ⚠ `{}` AND `null` ARE DIFFERENT. `{}` is "every module is intact"; `null` is
   * "we could not read the fit". Overloading is what causes this damage, so a
   * page that treated the second as the first would hide the cost of the very
   * feature that produces it.
   */
  readonly moduleDamage: Readonly<Record<number, number>> | null;
  /**
   * Weapon banks as `{masterID: [slaveID, …]}`.
   *
   * ⚠ ACTIVATING A SLAVE FIRES THE WHOLE BANK, through its master — the server
   * redirects it silently, and `activeModuleIDs` then names only the master. A
   * rack that did not know this shows a slave tile that never lights however
   * many times it is clicked. `{}` is "nothing banked"; `null` is "unknown".
   */
  readonly weaponBanks: Readonly<Record<number, readonly number[]>> | null;
  /**
   * The range the ship was told to follow or orbit at, in metres, when the
   * transport says (the game port does: it is the ball's own). With the mode
   * and whom the ship follows it is what the retail client's HUD words the
   * ship's action from. Null or absent: not known, or it follows nothing.
   */
  readonly followRange?: number | null;
  /**
   * The point the ship is flying to, when it is flying to one and the
   * transport says (the game port does: the ball's goto point). Null or
   * absent: not known, or it is doing something else.
   */
  readonly gotoPoint?: SpaceVector | null;
  /**
   * The ship's warp, while it is in one or lining up for one and the transport
   * says (the game port does). Null or absent: not in warp, or not known.
   */
  readonly warp?: ShipWarp | null;
  /**
   * What the pilot last aligned to, while the ship flies that course and the
   * transport says (the game port does). Null or absent: nothing, or not known.
   */
  readonly alignTarget?: ShipAlignTarget | null;
  /**
   * How hot each rack is running, 0 to 1 of its heat capacity, as the retail
   * client's own heat gauges read it. Null when the transport does not say
   * (the gateway does not), which is not the same as cold.
   */
  readonly rackHeat?: Readonly<Partial<Record<"high" | "mid" | "low", number>>> | null;
}

/** One decoded space snapshot: everything visible plus the active ship. */
export interface SpaceSnapshot {
  readonly inSpace: boolean;
  readonly solarSystemID: number | null;
  readonly shipID: number | null;
  /** Server sim time the snapshot was taken at (tells two polls apart). */
  readonly sampledAtMs: number | null;
  readonly entities: readonly SpaceEntity[];
  readonly ship: SpaceShipStatus | null;
  /**
   * The pace the pilot's own clock is meant to hold, 1 being the wall's: what the client's time
   * dilation indicator reads (blue.os.desiredSimDilation). Only a pilot on the game port has a clock
   * of its own; null or absent when it is not known.
   */
  readonly timeDilation?: number | null;
}

/**
 * The Overview panel state (goal R11). The flow polls the snapshot ~1s while
 * the ship is in space and the panel is open, and pushes each read here; the
 * panel is a pure reader that derives distances, sorting and filtering itself.
 */
export interface SpaceState {
  readonly snapshot: SpaceSnapshot | null;
  /** True once a snapshot read has populated the slice. */
  readonly loaded: boolean;
  /** Non-null when the last snapshot read failed (non-fatally). */
  readonly error: string | null;
  /**
   * R30 slice A — the stargates in the system this snapshot was taken in, and
   * where each one leads. Computed from the client-side route graph the
   * autopilot already caches (no server call of its own) and delivered WITH the
   * snapshot on purpose: the links describe the same grid the entities do, so
   * they can never label a gate using a different system's map.
   *
   * Empty until the graph has loaded, and empty for a system the graph does not
   * reach. Empty is not an error — a grid with no gates is ordinary.
   */
  readonly gateLinks: readonly GateLink[];
  /**
   * Non-null only when the star map itself could not be read. Distinct from an
   * empty `gateLinks`: "there are no gates here" and "I could not tell where
   * these gates go" are different facts and a player acts differently on each.
   */
  readonly gateLinksError: string | null;
  /**
   * Fleet-companion phase 7 — every hostile module cycle currently landing on
   * THIS ship, folded from the `OnJamStart` / `OnJamEnd` pushes
   * (`bridge/jamNotifications.ts`). The aggressor names itself in each one,
   * which is the only read anywhere that says who is holding this ship down.
   *
   * ⚠ EVERY JAM TYPE, NOT JUST TACKLE. Webs, paints, damps and neuts land here
   * too. Narrowing to the two tackle types is `tacklersHolding`'s job, at read
   * time, so a later reader that wants to know it is being neuted does not have
   * to re-plumb the wire.
   *
   * ⚠ NOT SELF-EXPIRING. The slice keeps what the wire said; whether a jam is
   * still believed is answered by `isJamLive` when somebody ASKS — the same
   * split `lastBroadcast` and `isFleetBroadcastFresh` make on the fleet slice.
   *
   * Cleared with the rest of the slice on `space/cleared`, which is right: a
   * docked ship is not being scrambled by anything.
   */
  readonly jams: readonly ActiveJam[];
}

// --- R23 slice A: targeting + module activation ----------------------------
//
// THE GENERIC IN-SPACE ACTION LAYER. Nothing here names mining, combat,
// salvaging or ewar, and nothing should: a target is a target, a module is a
// module, and which effect a module runs is an ARGUMENT the caller passes.
// Slice B drives a mining laser through this slice; a later combat goal drives
// a turret through the same slice unchanged.

/**
 * One target the ship has locked, or is still locking (goal R23).
 *
 * `name` is resolved from the space snapshot — the same row the overview shows
 * — so the locked list reads "Veldspar" or "Ibis", never an itemID (R7d). It is
 * null only while the target is not in the current snapshot (it warped off, or
 * the poll has not caught up), and the page shows a plain "out of view" label
 * rather than falling back to the number.
 */
export interface LockedTarget {
  readonly itemID: number;
  readonly name: string | null;
  /** The type behind the ball, so the panel can resolve a TYPE name. */
  readonly typeID: number | null;
  /** True while the server is still acquiring the lock (it is not usable yet). */
  readonly acquiring: boolean;
}

/**
 * The targeting + activation slice (goal R23 slice A).
 *
 * `lockedTargetIDs` is the server's answer to dogmaIM.GetTargets and is the
 * ONLY authority on what is locked — a 200 from a lock call is not proof, so
 * every mutation re-reads and lands here.
 *
 * `acquiringTargetIDs` is the browser's short-lived note of locks the server
 * ACCEPTED but has not finished acquiring. It is not a claim about server
 * state: an entry is dropped the moment the target appears in
 * `lockedTargetIDs`, and cleared outright when the ship leaves space.
 */
export interface TargetingState {
  readonly lockedTargetIDs: readonly number[];
  readonly acquiringTargetIDs: readonly number[];
  /** True once a GetTargets read has populated the slice. */
  readonly loaded: boolean;
  /** The last lock/unlock/activate action issued, for the status readout. */
  readonly lastAction: string | null;
  /** Non-null when the last action failed — the SERVER's own refusal reason. */
  readonly actionError: string | null;
  /**
   * Non-null when a call returned 200 but the re-read showed nothing changed
   * and the server gave no reason. This is deliberately a DIFFERENT field from
   * actionError: "it was refused, and here is why" and "it quietly did nothing"
   * are different things and the page says so.
   */
  readonly silentDecline: string | null;
  /**
   * R24 slice C — WHAT EACH MODULE'S CYCLE LOOKS LIKE, keyed by module itemID.
   *
   * Two independent facts live here and they are NOT interchangeable, which is
   * why `source` is on the record rather than in a comment:
   *
   *   "server"  the server told us, in an `OnGodmaShipEffect` cycle event
   *             (runtime.js:13012). That duration is the EFFECTIVE one — skills,
   *             role bonuses, rigs and heat already in it — and it is the only
   *             way the browser can ever know it, because there is still no
   *             allowlisted call returning effective per-module attributes.
   *   "base"    nobody has told us yet, so this is attribute 73 off the type,
   *             before any of that. A real number, but the STARTING point, and
   *             the page must say so.
   *
   * A module with no entry has no cycle we can speak to. That is not the same
   * as "instant" and must never render as one.
   */
  readonly moduleCycles: Readonly<Record<number, ModuleCycle>>;
  /**
   * R29 — THE SHOTS, newest last, as they were pushed.
   *
   * A survey concluded that no NPC emits damage and that this client therefore
   * could never show one. That was WRONG, and R29 settled it on the live wire:
   * sitting in a Perimeter belt with a rat shooting and nothing of ours firing,
   * 16 `OnDamageMessage` frames arrived naming the rat as source and our ship
   * as target. Killing it produced the mirror image. Both directions are real
   * and both are here.
   *
   * A BOUNDED TAIL, not a ledger. The push channel is lossy by design — the
   * gateway trims and blanks its buffer on resynchronise — so this is what we
   * were told about, never a running total to be trusted as arithmetic. Nothing
   * in the page sums it into a "total damage" figure, because a dropped frame
   * would make that figure quietly wrong forever.
   */
  readonly damageLog: readonly DamageEvent[];
}

/**
 * One shot, as `OnDamageMessage` reported it (R29).
 *
 * The direction is taken from the payload's own `attackType`, not inferred:
 * "me" is a shot WE fired, anything else is a shot fired at us. Measured
 * live — outgoing frames carry attackType "me" with a null attackerID, and
 * incoming carry "otherPlayerWeapons" with the attacker's id populated.
 */
export interface DamageEvent {
  /** Monotonic within the session, for keyed rendering only. Never shown. */
  readonly id: number;
  readonly direction: "dealt" | "taken";
  /** Who we hit, or who hit us. Named via the name cache — never shown raw. */
  readonly otherPartyID: number | null;
  /** The weapon's typeID, for naming. Null when the payload did not say. */
  readonly weaponTypeID: number | null;
  /** Damage this shot did. 0 is a real, meaningful value: a clean miss. */
  readonly amount: number;
  /**
   * The server's own hit-quality band, or null when absent. NOT translated to
   * retail's "Grazes"/"Wrecks" wording here: the mapping is not sourced from
   * this server, and inventing it would be fabricated detail.
   */
  readonly quality: number | null;
  /** Browser clock reading for when the frame arrived. */
  readonly atMs: number;
}

/** One module's cycle, and where the figure came from (R24 slice C). */
export interface ModuleCycle {
  /** One cycle's length in milliseconds. */
  readonly durationMs: number;
  /** "server" = the effective duration; "base" = attribute 73 off the type. */
  readonly source: "server" | "base";
  /**
   * Browser clock reading for when the running cycle was observed to start, or
   * null when the module is not known to be running. Deliberately the LOCAL
   * clock: the server's stamp is a Windows FILETIME on the server's clock, and
   * pretending we can line the two up would be fabricated precision. What we
   * honestly know is "the cycle had just started when this reached us".
   */
  readonly startedAtMs: number | null;
  /** True when the server said the effect repeats (a laser left running). */
  readonly repeating: boolean;
}

// --- R23 slice B: the mining loop ------------------------------------------
//
// mine -> haul -> refine -> sell. Note what is NOT modelled here: there is no
// mining cycle, no yield prediction and no rock countdown. Mining a rock is the
// GENERIC targeting slice above with a mining laser; this slice is only the
// places ore lives, what the scanner saw, and what the refinery quoted.

/** One reading of a hold: how much is in it, out of how much it holds. */
export interface HoldCapacity {
  /** Cubic metres the hold can take, or null when the ship did not say. */
  readonly capacity: number | null;
  readonly used: number | null;
}

/** One item sitting in a hold. Named in the UI by typeID via the name cache. */
export interface HoldItem {
  readonly itemID: number;
  readonly typeID: number;
  /**
   * What KIND of thing this is, as the game classifies it. `null` is "the read
   * did not say" and is never a verdict — a delivery that cannot tell ore from
   * a mining crystal leaves the stack alone rather than guessing.
   */
  readonly groupID: number | null;
  readonly categoryID: number | null;
  readonly quantity: number;
}

/**
 * One of the ship's mining holds (goal R23).
 *
 * The browser works in NAMES throughout: "Ore hold", "Ice hold", "Cargo hold".
 * The retail flagIDs behind them (134 / 135 / 181 / 182, falling back to cargo)
 * live only on the BFF and never reach here — R7d, and R9a's "ore hold, not
 * flag 134".
 */
export interface MiningHold {
  readonly key: string;
  readonly label: string;
  /** null when the read failed — "we could not look" is not "it is empty". */
  readonly items: readonly HoldItem[] | null;
  readonly capacity: HoldCapacity | null;
  /** False for a hull that simply does not have this hold; it is not shown. */
  readonly present: boolean;
  readonly error: string | null;
}

/**
 * One stack sitting in the ship's drone bay (goal R25). Named in the UI by
 * typeID via the name cache — the bay's flagID (87) lives only on the BFF, so
 * the browser has no idea that number exists (R7d).
 */
export interface DroneBayStack {
  readonly itemID: number;
  readonly typeID: number;
  readonly quantity: number;
}

/**
 * One drone the SERVER says is in space under this ship's control (goal R25).
 *
 * `activity` is a WORD ("idle", "fighting", "mining", …), never the runtime's
 * activity enum, and null means "we could not tell" — never "idle". A player
 * told their drones are idle when nobody looked will not launch the ones that
 * would have saved them.
 */
export interface DroneInSpace {
  readonly itemID: number;
  readonly typeID: number | null;
  readonly name: string | null;
  readonly activity: string | null;
  /** The ball it is busy with, so the panel can NAME the rock or the rat. */
  readonly targetID: number | null;
  readonly shieldRatio: number | null;
  readonly armorRatio: number | null;
  readonly hullRatio: number | null;
  /**
   * Whether THIS ship currently controls the drone.
   *
   * ⚠ A LISTED DRONE IS NOT NECESSARILY A FLYABLE ONE. The read keeps drones
   * this CHARACTER owns even when this hull does not fly them, so an orphaned
   * drone (session lost, ship swapped, podded and reboarded) stays visible
   * rather than quietly becoming someone else's salvage. Recall and Engage only
   * work on controlled drones; an uncontrolled one has to be reconnected or
   * scooped first. `false` is a real answer, not "unknown".
   */
  readonly controlled: boolean;
}

/**
 * The two limits the SERVER enforces on a launch (goal R25): how many drones
 * may be in space at once, and the hull's drone bandwidth.
 *
 * Shown so a player can see why a launch was refused — and NOT used to
 * pre-refuse one. Both are null for "unknown", which is also what a hull with
 * no drone bay reports; the panel says "unknown" rather than showing a
 * confident 0 it did not read.
 */
export interface DroneLimits {
  readonly maxActiveDrones: number | null;
  readonly droneBandwidth: number | null;
}

/**
 * One survey-scanner result (goal R23): what the scanner saw in a rock. The
 * browser MERGES these into the overview by itemID and computes nothing itself.
 */
export interface SurveyResult {
  readonly itemID: number;
  readonly yieldTypeID: number | null;
  readonly remainingQuantity: number | null;
}

/** What reprocessing one stack would yield, as the SERVER quoted it. */
export interface ReprocessingQuote {
  readonly itemID: number;
  readonly typeID: number | null;
  readonly quantityToProcess: number | null;
  readonly leftOvers: number | null;
  /** What this stack costs in ISK, as the station computed it. null = unknown. */
  readonly iskCost: number | null;
  /**
   * The minerals the PLAYER receives. The server's quote also carries the
   * station's own share; that is deliberately not here, because presenting it
   * as the player's yield would be a confidently wrong number.
   */
  readonly outputs: readonly { readonly typeID: number; readonly quantity: number }[];
}

/**
 * The mining panel state (goal R23 slice B).
 *
 * `taxRate` is null for "not known" rather than 0. Reprocessing DEBITS the
 * station's tax from the wallet, so showing a confident 0 for a rate the server
 * never gave would understate what the player is about to pay.
 */
export interface MiningState {
  readonly holds: readonly MiningHold[];
  readonly holdsLoaded: boolean;
  readonly holdsError: string | null;
  /** The last survey scan, newest first read; empty until the player scans. */
  readonly survey: readonly SurveyResult[];
  readonly surveyAtMs: number | null;
  readonly surveyError: string | null;
  readonly quotes: readonly ReprocessingQuote[];
  readonly taxRate: number | null;
  readonly quotesFor: readonly number[];
  readonly quotesError: string | null;
  readonly lastAction: string | null;
  readonly actionError: string | null;
  /** A call that succeeded, changed nothing, and gave no reason (see R23). */
  readonly silentDecline: string | null;
}

/**
 * The Drones panel's slice (goal R25).
 *
 * ⚠ EVERY "we could not look" IS A NULL, and that is load-bearing here in a way
 * it is nowhere else in this store. "You have no drones in space" and "the
 * snapshot did not answer" are the same pixels and opposite facts: the first
 * invites a player to launch, the second invites them to launch a SECOND flight
 * on top of the one already out there. `bay` and `inSpace` are null until a
 * successful read fills them, and the panel renders null as "not known".
 */
/**
 * One drone's own answer to the order it was just given (goal R34).
 *
 * ⚠ THERE IS NO ID IN THIS TYPE, AND THAT IS THE POINT (R7d). The server's
 * reasons arrive in a dict keyed by droneID; `flow.ts` resolves that key to a
 * name the moment it decodes it, and the id gets no further. A report the panel
 * cannot render an id from is a report that cannot leak one.
 *
 * `label` is null when the drone has no name we can show — the re-read failed,
 * or it is gone from space. The panel words that as "one of your drones"; it
 * never falls back to the id.
 */
export interface DroneOrderReport {
  readonly label: string | null;
  /** The server's own sentence, already through `describeRefusal` (R31). */
  readonly text: string;
}

export interface DronesState {
  /** null until read; null again if a read fails. NEVER [] for "unknown". */
  readonly bay: readonly DroneBayStack[] | null;
  readonly inSpace: readonly DroneInSpace[] | null;
  /** The launch limits the SERVER enforces — shown, never used to pre-refuse. */
  readonly limits: DroneLimits;
  readonly loaded: boolean;
  readonly error: string | null;
  readonly lastAction: string | null;
  readonly actionError: string | null;
  /**
   * A drone call that answered success and changed nothing. The server's launch
   * handler returns an empty dict when it refuses, so this is the ONLY way a
   * refused launch can be reported at all.
   */
  readonly silentDecline: string | null;
  /**
   * R34 — what the SERVER said about each drone in the last order, one entry
   * per refused drone.
   *
   * ⚠ IT IS A LIST BECAUSE A DRONE ORDER IS A FAN-OUT. `actionError` and
   * `silentDecline` above are single slots, and R30 measured what a single slot
   * does to a fan-out: a later success overwrites an earlier refusal and the
   * player is told everything worked. The server answers per drone, so this
   * keeps per drone.
   *
   * Empty means "nothing was refused", which is NOT "everything worked" — the
   * fresh `inSpace` read above remains the only authority on what happened.
   */
  readonly orderReports: readonly DroneOrderReport[];
}

// --- R5b Travel (browser autopilot decide-loop) ----------------------------

/**
 * One hop of a planned route for the travel panel: the systems and, per hop,
 * the source stargate to warp to (and jump through) and the gate on the far
 * side, with names resolved for display. Mirrors the route solver's RouteHop.
 */
export interface TravelRouteStep {
  readonly fromSystemID: number;
  readonly toSystemID: number;
  readonly gateToWarpID: number;
  readonly jumpToGateID: number;
  readonly fromSystemName: string | null;
  readonly toSystemName: string | null;
}

export type TravelStatus =
  | "idle"
  | "running"
  | "paused"
  | "arrived"
  | "aborted"
  | "error";

/**
 * The travel-panel state (goal R5b): the destination, the computed route, and
 * the live autopilot readout (current/next system, travel state, remaining
 * jumps, elapsed time, failure reason). The decide-loop runs in the browser and
 * pushes progress here; the panel is a pure reader. `startedAt` is the loop's
 * start epoch (the panel ticks elapsed time locally so the store stays quiet).
 */
export interface TravelState {
  readonly status: TravelStatus;
  readonly destinationSystemID: number | null;
  readonly destinationStationID: number | null;
  readonly destinationName: string | null;
  readonly route: readonly TravelRouteStep[];
  readonly currentSystemID: number | null;
  readonly currentSystemName: string | null;
  readonly nextSystemID: number | null;
  readonly nextSystemName: string | null;
  /** The current action label (e.g. "Warp to gate 50000802", "Docking"). */
  readonly action: string | null;
  /** The travel-state text (e.g. "In warp", "Jumping", "Docked"). */
  readonly phase: string | null;
  readonly remainingJumps: number;
  readonly totalJumps: number;
  readonly startedAt: number | null;
  /** Actionable failure reason (the handler's own refusal, or a plan error). */
  readonly failureReason: string | null;
}

// --- R26: the mining bot ----------------------------------------------------

export type MiningBotRunState = "idle" | "running" | "paused" | "stopped" | "error";

/**
 * The mining bot's panel state (goal R26).
 *
 * The decide-loop runs in the BROWSER and pushes its readout here; the panel is
 * a pure reader, exactly as the Travel panel is for the autopilot.
 *
 * `why` is the field this slice exists for. A bot you cannot interrogate is one
 * you cannot trust, so the reason for the LAST thing it did is always on screen
 * — not only when something goes wrong. It is plain player language and carries
 * no numeric ids (R9a / R7d).
 *
 * `holdUsed` / `holdCapacity` are null for UNKNOWN, never 0: a hull that did not
 * report a capacity must not render as an empty hold with room to spare.
 */
/**
 * The player Bot Builder runner's live readout (a browser loop pushes it here so
 * it survives dock/undock and the shell switch — the bug the first cut hit when
 * this lived in the docked-only editor component).
 */
/** One thing the run keeps being refused, in words a player reads. */
export interface BotRefusal {
  readonly key: string;
  readonly count: number;
  readonly firstAt: number;
  readonly lastAt: number;
  readonly words: string;
  readonly kind: "refused" | "unreachable" | "gone" | "no-room";
}

export interface CustomBotState {
  readonly status: "idle" | "running" | "paused" | "stopped" | "error";
  readonly name: string | null;
  readonly phase: string | null;
  readonly why: string | null;
  readonly stepPath: string | null;
  readonly interruptID: string | null;
  readonly pauseReason: string | null;
  /** The run board as one line ("Working with <agent>"), or null. */
  readonly note: string | null;
  /**
   * What the server is currently turning down, worst first — empty on a healthy
   * run. Held on the slice rather than shown once, for the same reason
   * `lastAlert` is: the player this matters to is the one who was not watching.
   */
  readonly refusals: readonly BotRefusal[];
  readonly startError: string | null;
  /**
   * The last thing an "alert me" watch said, and when. HELD rather than fired and
   * forgotten, because the whole point of the alert is to reach a player who was
   * not watching — a phone with the tab asleep, or a server bot with no tab at
   * all. Null until one fires.
   */
  readonly lastAlert: { readonly message: string; readonly atMs: number } | null;
}

export interface MiningBotState {
  readonly status: MiningBotRunState;
  /** Where in the loop it is ("Mining", "Hauling", "Docking"). */
  readonly phase: string | null;
  /** What it last did. */
  readonly action: string | null;
  /** WHY it did that — always present while running. */
  readonly why: string | null;
  /**
   * R44 — WHICH RUNG of the bot's ladder fired last, so the panel can show the
   * whole ladder with that one lit. Null means no rung fired: the loop was in a
   * settle window, waiting on a read, or the player paused it.
   *
   * ⚠ R7d — this identifier NEVER renders. `nav/miningLadder.ts` maps it to the
   * plain-language name a player reads, and a panel test sweeps for every id.
   */
  readonly rung: MiningRungID | null;
  /**
   * R46 — the LEAF of the sub-ladder that rung called, so the panel lights the
   * row that fired and the thing it actually did at the same time. Null when the
   * rung answered on its own, when it called the travel steps (which have no
   * rows), or when no rung fired at all.
   *
   * ⚠ THIS FIELD IS WHY THE READOUT CANNOT LIE. With one row per tick the adopt
   * shortcut could light "…go straight to the equipment" while the equipment was
   * not touched. Two names cannot be made to compete for one slot.
   *
   * ⚠ R7d — this identifier NEVER renders, exactly like `rung`.
   */
  readonly step: MiningStepID | null;
  /** The rock it is working, by NAME (R7d). */
  readonly rockName: string | null;
  /** The belt and station the player picked, by name. */
  readonly beltName: string | null;
  readonly stationName: string | null;
  /** Loads actually unloaded into the hangar this run. */
  readonly cyclesCompleted: number;
  /** Ore units this run, counted from the HOLD growing — never from a yield sum. */
  readonly oreUnitsMined: number;
  readonly holdUsed: number | null;
  readonly holdCapacity: number | null;
  /** Set when it stopped — always a sentence a player can act on. */
  readonly failureReason: string | null;
  /** A problem starting it (nothing picked, not in space); null clears it. */
  readonly startError: string | null;
  readonly startedAt: number | null;
}

/**
 * The R36 distribution-mission bot's readout. Like `MiningBotState`, this slice
 * is a pure record of what the browser-side loop said — nothing here decides
 * anything, and the panel over it is a pure reader.
 *
 * `why` is the field it exists for: the player must always be able to interrogate
 * the LAST decision, not only a failure. Every string here is plain player
 * language and carries no numeric ids (R9a / R7d).
 *
 * `caution` is deliberately separate from `failureReason`. It is not a stop — it
 * is the bot declaring that a step it took could not be made certain (a hangar
 * holding two stacks identical in type AND quantity to the mission package,
 * which no client can tell apart). Reporting that as success would be a lie;
 * reporting it as a failure would be wrong too.
 */
/**
 * The fleet companion's panel state (fleet-companion phase 0).
 *
 * The companion is a sibling decide-loop, not a bot script, so this slice is
 * shaped like `MiningBotState`/`MissionBotState` and for the same reason: the
 * loop lives in the browser and pushes its readout here, and this slice records
 * it without deciding anything.
 *
 * The last four fields are the Bot Manager badge the plan doc asks for — in
 * fleet, following whom, last order heard, and whether this pilot can tag.
 *
 * ⚠ `canTag` IS THREE-STATE, and the third state matters. `null` means the fleet
 * roster could not be read; `false` means this pilot genuinely holds no
 * commander role. A pilot silently unable to tag looks identical to one with
 * nothing to tag, which is exactly why the readout carries it.
 */
export interface FleetCompanionState {
  readonly status: FleetCompanionRunState;
  /** Where in the ladder it is ("In warp", "Standing by"). */
  readonly phase: string | null;
  /** What it last did. */
  readonly action: string | null;
  /** WHY it did that — always present while running. */
  readonly why: string | null;
  readonly inFleet: boolean | null;
  /** Which authority the last decision came from, for the readout. */
  readonly followingOrderFrom: CompanionOrderAuthority | null;
  readonly lastOrderHeard: string | null;
  readonly canTag: boolean | null;
  /**
   * What was missing or unusable about this pilot's fit when it started: no
   * ammunition loaded, an empty drone bay, nothing that defends the ship.
   *
   * ⚠ ADVISORY, AND MEASURED ONCE AT START. Nothing here ever refused a start
   * -- the operator's rule is that a human loads the missing thing or ignores
   * it and flies. Empty means nothing worth saying, which is ALSO what an
   * unreadable fit produces: this list only speaks when it is confident.
   */
  readonly fitWarnings: readonly string[];
  /**
   * Non-null while decision 5's abandonment protocol is running: nobody in the
   * fleet this host is not flying, so the pilot got safe, dropped fleet, and is
   * waiting out a bounded thirty minutes for a human to invite it back.
   *
   * ⚠ IT IS HERE SO IT CAN BE PERSISTED. The BFF's bot host projects this slice
   * onto its durable roster row; without the clock on the row, a restart hands
   * the companion a fresh thirty minutes and the bound stops being one.
   */
  readonly abandonment: CompanionAbandonmentRecord | null;
  readonly startedAt: number | null;
  readonly startError: string | null;
  readonly failureReason: string | null;
}

export interface MissionBotState {
  readonly status: MiningBotRunState;
  /** Where in the loop it is ("Flying", "Loading", "Handing it in"). */
  readonly phase: string | null;
  /** What it last did. */
  readonly action: string | null;
  /** WHY it did that — always present while running. */
  readonly why: string | null;
  /** The agent it is working with, by NAME (R7d). */
  readonly agentName: string | null;
  /** The job in hand, and what it is hauling, in the briefing's own terms. */
  readonly missionName: string | null;
  readonly cargoText: string | null;
  /** Where it is headed, and how far there is left to go. */
  readonly destinationName: string | null;
  readonly jumpsRemaining: number | null;
  /** Jobs actually confirmed complete (missionCompleted === true), never assumed. */
  readonly missionsCompleted: number;
  /** Earned this run, measured as a BALANCE DIFFERENCE. Decimal strings. */
  readonly iskEarned: string | null;
  readonly lpEarned: string | null;
  /** Non-null when a step could not be made certain. Not a failure. */
  readonly caution: string | null;
  /** Set when it stopped — always a sentence a player can act on. */
  readonly failureReason: string | null;
  /** A problem starting it (no agent picked, not docked); null clears it. */
  readonly startError: string | null;
  readonly startedAt: number | null;
}

/**
 * Which bot is holding the ship (goal R43).
 *
 * ⚠ THIS IS A VIEW, NOT A SECOND SOURCE OF TRUTH. The store recomputes it from
 * the loops' OWN statuses after every event (see `syncBotClaim` in
 * clientStore.ts), so it cannot drift away from them the way a separately-set
 * flag would. Nothing writes it directly and there is no event that carries it.
 *
 * It exists because a player who starts a bot and switches panels has, until
 * now, had nowhere to find out that anything is running at all. `null` means
 * no loop holds the ship; a paused bot still holds it (see `holdsTheShip`).
 */
export interface BotsState {
  readonly runningBotID: ShipControllerID | null;
}

/**
 * One destination match from the Travel-tab name search (goal R7a): a solar
 * system or station resolved from the static /api/map/find route, annotated with
 * jumps from the current system (best-effort, like the Agent Finder). `id` is
 * the ID handed to flow.startRoute (the R5b route solver + autopilot). This is a
 * transient search result (not held in the store); the Travel component keeps it
 * in local state.
 */
export interface DestinationMatch {
  readonly id: number;
  readonly name: string;
  readonly kind: "system" | "station" | "structure";
  readonly solarSystemID: number | null;
  readonly solarSystemName: string | null;
  /** Jumps from the player's current system; null = unreachable / unknown origin. */
  readonly jumps: number | null;
}

// --- R7 Local + Corp chat --------------------------------------------------

/** One member of a chat channel (Local occupants / Corp members). */
export interface ChatMember {
  readonly characterID: number;
  readonly name: string;
  readonly corporationID: number | null;
  readonly allianceID: number | null;
  readonly solarSystemID: number | null;
}

/** One backlog message in a chat channel. */
export interface ChatMessage {
  readonly characterID: number;
  readonly characterName: string;
  readonly message: string;
  readonly createdAtMs: number;
}

/** One channel's decoded state: its room, roster, and recent backlog. */
export interface ChatChannelState {
  readonly roomName: string | null;
  readonly corporationID: number | null;
  readonly solarSystemID: number | null;
  readonly roster: readonly ChatMember[];
  readonly messages: readonly ChatMessage[];
  readonly loaded: boolean;
}

export type ChatChannel = "local" | "corp";

/**
 * The Chat panel state (goal R7): Local and Corp sub-channels, each with a
 * member roster + message backlog, plus the active tab and any send/read error.
 * READ is a backlog poll (chat delivery bypasses the notification drain), so the
 * panel polls while open and the flow pushes each fresh read here; the panel is
 * a pure reader.
 */
export interface ChatState {
  readonly activeChannel: ChatChannel;
  readonly local: ChatChannelState;
  readonly corp: ChatChannelState;
  readonly error: string | null;
}

// --- R10 live event channel ------------------------------------------------

/**
 * How the live push channel (gateway WebSocket -> BFF SSE -> browser) is doing.
 * "live" means events are arriving; anything else means the page is back on its
 * safety-net polls. Nothing about correctness depends on this — every bridge
 * response still carries its notification drain — so it drives poll cadence,
 * not what the player is shown.
 */
export type LiveStreamStatus = "idle" | "connecting" | "live" | "degraded" | "ended";

/**
 * One session notification pushed over the live channel: the same shape the
 * response drain carries (`kind` is the ClientSession surface that produced it).
 */
export interface LiveNotification {
  readonly kind: string;
  readonly service: string | null;
  readonly method: string | null;
  readonly receivedAtMs: number;
  /**
   * R24 — the notification's own payload, as the gateway JSON-encoded it.
   *
   * R10 kept only the metadata, because liveness was all the page needed then:
   * "something happened, go and re-read". The in-space cockpit needs more than
   * that from two of these — `OnGodmaShipEffect` carries the only effective
   * cycle duration the browser will ever see, and `OnItemsChanged` carries what
   * changed. The gateway has always pushed the whole notification
   * (`encodeJsonSafeCallValue`, evejsWebGatewayRuntime.js:2672); this is the
   * page finally keeping it. Empty when the frame carried no args.
   */
  readonly args: readonly unknown[];
}

/**
 * The live channel slice (goal R10). Holds the connection status, the cursor
 * last seen (so a reconnect can resume), and a bounded tail of the session
 * notifications that arrived — which is where the drained `notifications` the
 * page used to discard now actually land.
 */
export interface LiveState {
  readonly status: LiveStreamStatus;
  readonly epoch: string | null;
  readonly sequence: number;
  readonly notifications: readonly LiveNotification[];
  readonly lastEventAtMs: number | null;
  /** Questions the server has asked and is waiting on, oldest first. */
  readonly questions: readonly ClientQuestion[];
}

/**
 * A title, a body or an agent's line as the server words it: a localisation
 * label with its parameters, plain text, or a message's number (a mission's
 * own text, which the client fills with the mission's keywords).
 */
export interface QuestionWords {
  readonly label: string | null;
  readonly parameters: unknown;
  readonly text: string | null;
  readonly messageID?: number | null;
  /**
   * A dialog by its name (the key the server gives the client's eve.Message),
   * and which of the dialog's two texts these words are. The parameters are
   * the dialog's, some of them typed values the client turns to text first.
   */
  readonly dialog?: string | null;
  readonly part?: "title" | "body";
}

/**
 * A question the SERVER has asked the player and is waiting on. The retail
 * client shows a window for it; here it arrives on the live channel (game-port
 * pilots only) and is answered through the BFF. See web/src/bridge/questions.ts.
 */
export interface ClientQuestion {
  readonly id: string;
  readonly service: string;
  readonly method: string;
  /**
   * Which window the retail client would raise: a Yes/No, radio buttons with
   * OK / Cancel, or a number box with OK / Cancel.
   */
  readonly kind: "yesNo" | "choice" | "quantity";
  readonly title: QuestionWords;
  readonly body: QuestionWords;
  readonly agentID: number | null;
  readonly contentID: number | null;
  readonly suppressID: string | null;
  readonly askedAtMs: number;
  readonly expiresAtMs: number;
  /** What there is to choose from, in the server's order; empty unless `kind` is "choice". */
  readonly choices: readonly QuestionWords[];
  /** The number box's limits; null unless `kind` is "quantity". */
  readonly quantity: {
    readonly min: number;
    readonly max: number | null;
    readonly initial: number | null;
    /** Decimal places allowed; 0 asks for a whole number. */
    readonly digits: number;
  } | null;
}

/**
 * An answer to a ClientQuestion, by its kind: Yes or No; which choice, and
 * whether OK was pressed rather than Cancel; a number, or null for Cancel.
 */
export type QuestionAnswer =
  | boolean
  | { readonly confirmed: boolean; readonly index: number }
  | number
  | null;

export interface CharacterSummary {
  readonly characterID: number;
  readonly characterName: string;
  readonly gender: number | null;
  readonly typeID: number | null;
  readonly corporationID: number | null;
  readonly allianceID: number | null;
  readonly stationID: number | null;
  readonly solarSystemID: number | null;
  readonly regionID: number | null;
  readonly balance: number | null;
  readonly skillPoints: number | null;
  readonly shipTypeID: number | null;
  readonly shipName: string | null;
  readonly securityStatus: number | null;
  readonly title: string | null;
  readonly unreadMailCount: number | null;
  readonly logoffDate: bigint | null;
  readonly skillTypeID: number | null;
  readonly toLevel: number | null;
  readonly trainingStartTime: bigint | null;
  readonly trainingEndTime: bigint | null;
  readonly queueEndTime: bigint | null;
}

// --- R28 Skills: the character sheet and the training queue -----------------
//
// Every number in here came from the server already evaluated (the gateway's
// GET /skills): the SP threshold for each level, the SP a queue entry starts
// and ends at, and the instants it starts and ends. Nothing in the client
// re-derives them — see bridge/skills.ts.

/** One skill the character has, with the server's thresholds for all 5 levels. */
export interface SkillRow {
  readonly typeID: number;
  readonly name: string;
  readonly groupName: string;
  /** The level the character HAS. Partial progress rides in skillPoints. */
  readonly level: number;
  readonly rank: number;
  readonly skillPoints: number;
  /** SP needed for levels I..V. The server's curve, not ours. */
  readonly levelSkillPoints: readonly number[];
  readonly inTraining: boolean;
}

/** One skill group as the sheet reads it. */
export interface SkillGroup {
  readonly groupName: string;
  readonly skills: readonly SkillRow[];
  readonly skillCount: number;
  readonly totalSkillPoints: number;
  readonly maxedCount: number;
}

/** One planned step of training, exactly as the server scheduled it. */
export interface SkillQueueEntry {
  readonly typeID: number;
  readonly toLevel: number;
  readonly startSP: number;
  readonly destinationSP: number;
  /** Epoch ms, or null when the server gave none. Never coerced to 0. */
  readonly startTimeMs: number | null;
  readonly endTimeMs: number | null;
  /** Non-zero only for the head: a later entry's rate is not knowable yet. */
  readonly skillPointsPerMinute: number;
}

export interface SkillQueueState {
  readonly active: boolean;
  readonly entries: readonly SkillQueueEntry[];
  readonly endTimeMs: number | null;
  /** The server's own cap on queue length, shown rather than enforced here. */
  readonly maxEntries: number;
}

/** The decoded GET /api/bridge/skills payload. */
export interface SkillSheet {
  readonly characterName: string;
  readonly totalSkillPoints: number;
  readonly freeSkillPoints: number;
  readonly skills: readonly SkillRow[];
  /** null when the gateway could not read the queue — NOT an empty queue. */
  readonly queue: SkillQueueState | null;
  /** serverNowMs minus the browser's clock at read time. */
  readonly clockOffsetMs: number;
}

/** The live readout for whatever is training, interpolated between reads. */
export interface SkillTrainingReadout {
  readonly typeID: number;
  readonly toLevel: number;
  readonly skillPoints: number;
  readonly startSP: number;
  readonly destinationSP: number;
  readonly fraction: number;
  readonly remainingMs: number;
  readonly finishAtMs: number;
  readonly skillPointsPerMinute: number;
}

export interface SkillsState {
  readonly characterName: string | null;
  readonly totalSkillPoints: number | null;
  readonly freeSkillPoints: number | null;
  /** null until read; null again if a read fails. NEVER [] for "unknown". */
  readonly skills: readonly SkillRow[] | null;
  readonly queue: SkillQueueState | null;
  readonly clockOffsetMs: number;
  readonly loaded: boolean;
  readonly error: string | null;
  readonly lastAction: string | null;
  readonly actionError: string | null;
}

// --- R37 Personal Assets ---------------------------------------------------

/**
 * One station holding some of this character's items
 * (charMgr.ListStations, decoded from the CRowset's POSITIONAL packedrows).
 *
 * The server resolved every item up its container chain to get here — the
 * browser never aggregates assets itself.
 */
export interface AssetStationRow {
  readonly stationID: number;
  readonly solarSystemID: number;
  /** The station's own type, for its icon. null when the world does not know it. */
  readonly typeID: number | null;
  /** How many top-level stacks are here, per the server's own count. */
  readonly itemCount: number;
}

/**
 * One stack at one station (charMgr.ListStationItems, decoded from the
 * NAME-KEYED packedrows — a different variant from the station rows above).
 */
export interface AssetItemRow {
  readonly itemID: number;
  readonly typeID: number;
  /**
   * How many. ⚠ NOT the row's raw `quantity`, which is -1 for an assembled
   * item; this is the server's own rule (singleton -> 1, else stacksize).
   */
  readonly units: number;
  /** An assembled, unique thing (a ship, a fitted module) rather than a stack. */
  readonly singleton: boolean;
  readonly categoryID: number;
  readonly groupID: number;
  /** m³ per unit from static data; null when the type's volume is unknown. */
  readonly volume: number | null;
}

/** What one expanded station is holding, and whether that read worked. */
export interface AssetStationContents {
  readonly items: readonly AssetItemRow[];
  /**
   * ⚠ TRUE ONLY WHEN THE READ SUCCEEDED AND THE STATION WAS EMPTY. "Nothing
   * here" and "that read failed" must not render alike.
   */
  readonly hasNoItems: boolean;
  readonly error: string | null;
}

/**
 * The Personal Assets page state (goal R37). READS ONLY — the bound
 * global-assets object implements no write at all. The one ACTION the page
 * offers is setting a destination, which is `travel` state, not asset state.
 */
export interface PersonalAssetsState {
  /** Every station holding something. Empty is meaningful only with `ownsNothing`. */
  readonly stations: readonly AssetStationRow[];
  /** Contents keyed by stationID, for the stations the player has expanded. */
  readonly contents: Readonly<Record<number, AssetStationContents>>;
  /** Which station is expanded right now; null when none is. */
  readonly expandedStationID: number | null;
  readonly loaded: boolean;
  readonly error: string | null;
  /**
   * ⚠ TRUE ONLY WHEN ListStations SUCCEEDED AND WAS EMPTY — never inferred
   * from an absence. "You own nothing anywhere" is a strong claim and only a
   * successful read may make it; a failed read leaves this false and sets
   * `error` instead (the worldHasNoContracts precedent).
   */
  readonly ownsNothing: boolean;
}

// --- R41 Planetary Interaction: the character's colonies --------------------
//
// READS ONLY. Nothing in this slice models a mechanic: the cycle time, the
// quantity per cycle, the install and expiry instants and every stored quantity
// are the emulator's own numbers, copied across by the BFF. The one thing the
// client decides is whether an instant has PASSED, and it decides that against
// `serverNowMs` sampled in the same read (see clockOffsetMs), never against the
// browser's unguarded clock.

/** One commodity sitting in a pin, already named by the BFF. */
export interface ColonyStoredItem {
  /** For the icon only — R7d forbids showing it. */
  readonly typeID: number;
  readonly typeName: string;
  readonly quantity: number;
}

/**
 * The extraction program installed in an Extractor Control Unit, or absent when
 * the unit has never been programmed. Every field is the server's.
 */
export interface ColonyExtractionProgram {
  readonly resourceTypeID: number;
  /** null when the world could not name the resource. */
  readonly resourceTypeName: string | null;
  readonly cycleTimeSeconds: number;
  readonly quantityPerCycle: number;
  /** Epoch ms, or null when the server gave none. Never coerced to 0 (= 1601). */
  readonly installedAtMs: number | null;
  readonly expiresAtMs: number | null;
  readonly headCount: number;
  /**
   * The most one cycle can yield, which is what this extractor's routes must
   * reserve between them before the game calls it settled (retail
   * EcuPin.GetMaxOutput). Null or absent when the BFF could not say.
   */
  readonly maxOutputPerCycle?: number | null;
  /**
   * The drill area the program was installed with — which is also what sets
   * how long it runs. A restart sends it back unchanged. Null or absent when
   * the server gave none (an older BFF), and then nothing may guess one.
   */
  readonly headRadius?: number | null;
  /**
   * Where the unit's heads are, as the server has them: (the head's number, latitude, longitude). What the planet
   * is asked a programme's yield with. Null or absent when the reading had none it could read; an empty list is a
   * unit with no heads.
   */
  readonly heads?: readonly (readonly [number, number, number])[] | null;
  /**
   * The unit's noise (attribute 1687): the most a cycle can yield is the whole of one more than this, times what
   * the programme yields (retail EcuPin.GetMaxOutput). Null or absent when the BFF could not say.
   */
  readonly noiseFactor?: number | null;
}

/** What a pin IS, decided by the BFF from the type's group. */
export type ColonyPinKind =
  | "command"
  | "extractor-control"
  | "extractor"
  | "factory"
  | "storage"
  | "launchpad"
  | "other";

/** One structure on a planet. */
export interface ColonyPin {
  readonly pinID: number;
  readonly typeID: number;
  readonly typeName: string;
  readonly kind: ColonyPinKind;
  readonly contents: readonly ColonyStoredItem[];
  /**
   * What this pin holds and what it can hold, in m³ — EITHER may be null when
   * the static table could not say. Null is never 0: an unknown capacity that
   * read as 0 would make every pin look full.
   */
  readonly usedM3: number | null;
  readonly capacityM3: number | null;
  /** A factory's recipe. The id is for the name beside it, nothing else. */
  readonly schematicID: number | null;
  readonly schematicName: string | null;
  /**
   * Whether the emulator's last simulated cycles fed this processor. Null on
   * every pin that is not a factory — the emulator sets these flags only on
   * process pins, so null means "no such state", NOT "starved".
   */
  readonly hasReceivedInputs: boolean | null;
  readonly receivedInputsLastCycle: boolean | null;
  /**
   * Whether the pin is running right now (retail BasePin.IsActive). A factory
   * set to a recipe but waiting for inputs is false. Null or absent when the
   * server gave no state, which is NOT "idle".
   */
  readonly active?: boolean | null;
  /** When this pin last ran, and (launchpads, command centres) last launched. */
  readonly lastRunAtMs: number | null;
  readonly lastLaunchAtMs: number | null;
  /** Only ever set on an extractor control unit. */
  readonly program: ColonyExtractionProgram | null;
}

/** One link between two pins. Endpoints are pin ids, for matching, not display. */
export interface ColonyLink {
  readonly endpoint1: number;
  readonly endpoint2: number;
  /** The upgrade level the emulator multiplies the link's bandwidth by. */
  readonly level: number;
}

/** One route moving a commodity between two pins. */
export interface ColonyRoute {
  readonly routeID: number;
  readonly path: readonly number[];
  readonly commodityTypeID: number;
  readonly commodityTypeName: string | null;
  readonly commodityQuantity: number;
}

/** One colony: a planet this character has built on. */
export interface Colony {
  readonly planetID: number;
  /** "Tanoo I". null when the static map cannot name it — NEVER the id. */
  readonly planetName: string | null;
  readonly solarSystemID: number;
  readonly solarSystemName: string | null;
  /** The planet's own type, for its icon. */
  readonly planetTypeID: number;
  readonly planetTypeName: string | null;
  readonly commandCenterLevel: number;
  /** When the server last ran this colony forward. Epoch ms, or null. */
  readonly lastSimulatedAtMs: number | null;
  readonly pins: readonly ColonyPin[];
  readonly linkCount: number;
  readonly links: readonly ColonyLink[];
  readonly routes: readonly ColonyRoute[];
  /**
   * What the planet carries and how rich each resource is, as the server
   * states it (R108 slice 5). Null or absent when the read carried no record
   * for the planet: unknown, never "carries nothing".
   */
  readonly resources?: readonly PlanetResource[] | null;
}

/** One resource a planet carries. `quality` is the server's number, unscaled. */
export interface PlanetResource {
  readonly typeID: number;
  readonly typeName: string | null;
  readonly quality: number | null;
}

/** The decoded GET /api/bridge/planets payload. */
export interface ColonyReport {
  readonly colonies: readonly Colony[];
  /** False when the gateway reported no colony table AT ALL — see below. */
  readonly coloniesReadable: boolean;
  /** serverNowMs minus the browser's clock at read time. */
  readonly clockOffsetMs: number;
}

export interface PlanetsState {
  /** null until read, and null again if a read fails. NEVER [] for "unknown". */
  readonly colonies: readonly Colony[] | null;
  /** Which colony is open; null when none is. */
  readonly selectedPlanetID: number | null;
  readonly clockOffsetMs: number;
  readonly loaded: boolean;
  readonly error: string | null;
  /**
   * ⚠ TRUE ONLY WHEN THE READ SUCCEEDED, CARRIED A COLONY TABLE, AND IT HELD
   * NOTHING OF THIS CHARACTER'S. A gateway that reported no colony table at all
   * has not told us the character has none, and a failed read has told us
   * nothing whatsoever — both leave this false (the worldHasNoContracts rule).
   */
  readonly hasNoColonies: boolean;
  /**
   * The planetary production recipes (goal R108 slice 1).
   *
   * ⚠ NOT THE PLAYER'S DATA, which is why it lives here but does not follow
   * the rest of this slice's lifetime. Colonies belong to one character and
   * are dropped the moment that character goes away; the recipe table is the
   * same for everybody and is kept across a character change rather than
   * re-read for each one.
   *
   * ⚠ ITS `readable` FLAG IS NOT `loaded`. An unread book and a book the
   * server could not supply both leave every factory rendering exactly as it
   * did before this slice — see bridge/piFactoryWords.ts, which degrades to
   * the colony read's own name rather than blanking a line.
   */
  readonly recipes: PiRecipeBook;
}
