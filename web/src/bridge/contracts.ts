// R17 Slice B — decoding the retail CONTRACT surface (contractProxy).
//
// ⚠ THE SERVICE IS `contractProxy`. `contractMgr` is 86 lines of DEAD STUBS
// whose every method answers empty. Nothing in the browser names a service —
// the BFF does — but the distinction matters here because a page fed by the
// dead service and a page fed by the real one IN AN EMPTY WORLD look
// identical. That is why the BFF reports `worldHasNoContracts` as a fact
// derived from a SUCCESSFUL browse rather than letting the panel infer it from
// an absence.
//
// ⚠ A PUBLIC BROWSE IS LEGITIMATELY EMPTY. There is no NPC/seed contract
// generator in EveJS, so until a player creates a contract there is nothing to
// find. The panel says so plainly. This is expected, not a defect.
//
// ⚠ THE LIST AND THE DETAIL SEND DIFFERENT ROW SHAPES. contractProxy builds
// LIST rows with buildKeyVal (`buildContractRow`) but DETAIL rows with
// buildPackedRow (`buildContractDetailContractRow`) — and the detail item rows
// with buildPackedRow too, while the LIST's item rows are KeyVals again. The
// same packed detail row also rides inside every SEARCH entry's `contract`.
// Reading a packedrow with readKeyVal yields undefined for every field, so the
// row decodes to nothing and the panel shows a blank that looks exactly like
// "no such contract". Rows are therefore read through readRowField, which
// accepts both shapes; only the surrounding BUNDLE is read as a KeyVal.
//
// ⚠ ISK FIELDS (price / reward / collateral) ARE KEPT AS DECIMAL STRINGS the
// whole way. They exceed 2^53 in ordinary play, so routing them through a JS
// number would round them on the way to the screen (R7d).
//
// ⚠ DATES ARE FILETIMEs (100 ns ticks since 1601-01-01), not Unix timestamps,
// and they exceed 2^53 — so they stay bigints until they are rendered.

import type {
  ContractDetail,
  ContractItemRow,
  ContractRow,
  ContractSummary,
} from "../store/types.ts";
import type { JsonValue } from "./wire.ts";
import { isListValue, readKeyVal, readRowField, unwrapLong } from "./wire.ts";

/** contractType 3 = courier; 1 = item exchange; 2 = auction (stubbed server-side). */
export const CONTRACT_TYPE_ITEM_EXCHANGE = 1;
export const CONTRACT_TYPE_AUCTION = 2;
export const CONTRACT_TYPE_COURIER = 3;
export const CONTRACT_AVAILABILITY = { public: 0, personal: 1, corporation: 2, alliance: 3 } as const;
export type ContractAvailability = (typeof CONTRACT_AVAILABILITY)[keyof typeof CONTRACT_AVAILABILITY];

/**
 * The one status that can still be taken on. Every other status means somebody
 * already did, or the contract is over.
 */
export const CONTRACT_STATUS_OUTSTANDING = 0;

/** What kind of contract this is, in words. */
export const CONTRACT_TYPE_LABELS: Readonly<Record<number, string>> = {
  [CONTRACT_TYPE_ITEM_EXCHANGE]: "Item trade",
  [CONTRACT_TYPE_AUCTION]: "Auction",
  [CONTRACT_TYPE_COURIER]: "Delivery job",
};

/**
 * Contract status codes (contractRuntimeState.CONTRACT_STATUS), in words a
 * player can act on. -1 is REQUIRES_ATTENTION.
 */
export const CONTRACT_STATUS_LABELS: Readonly<Record<number, string>> = {
  [-1]: "Needs your attention",
  0: "Waiting for someone to take it",
  1: "Being delivered",
  2: "Finished by the person who issued it",
  3: "Finished by the person who took it",
  4: "Finished",
  5: "Called off",
  6: "Turned down",
  7: "Failed",
  8: "Deleted",
  9: "Reversed",
  10: "Has a bid on it",
};

export function contractTypeLabel(type: number): string {
  return CONTRACT_TYPE_LABELS[type] ?? "Contract";
}

export function contractStatusLabel(status: number): string {
  return CONTRACT_STATUS_LABELS[status] ?? "Unknown";
}

function listItems(value: JsonValue | undefined): readonly JsonValue[] {
  return isListValue(value) ? (value.items as readonly JsonValue[]) : [];
}

function toNumber(value: JsonValue | undefined): number {
  const long = unwrapLong(value);
  if (long !== null) {
    return Number(long);
  }
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toText(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

/** An ISK amount as a DECIMAL STRING — never a JS number (it exceeds 2^53). */
function toAmount(value: JsonValue | undefined): string | null {
  const long = unwrapLong(value);
  if (long !== null) {
    return long.toString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) {
    return value;
  }
  return null;
}

/**
 * A FILETIME instant, kept as a bigint; null when absent or zero.
 *
 * ⚠ THE DATES ARRIVE AS BARE DECIMAL STRINGS, NOT `{type:"long"}` WRAPPERS.
 * The server holds them as BigInt (`buildFiletime` -> `toFileTimeBigInt`), and
 * the gateway's `encodeJsonSafeCallValue`
 * (evejsWebGatewayRuntime.js:1058) turns every BigInt into a plain decimal
 * STRING on the way out — so `dateIssued` is `"134291089691370000"`, not
 * `{type:"long", value:…}`. `unwrapLong` rejects a bare string, which silently
 * dated every contract to null. Verified against a payload captured from the
 * real contractProxy.GetContract handler (R32).
 */
function toFiletime(value: JsonValue | undefined): bigint | null {
  const long =
    typeof value === "string" && /^-?\d+$/.test(value)
      ? BigInt(value)
      : unwrapLong(value);
  return long !== null && long > 0n ? long : null;
}

export function decodeContractRow(row: JsonValue): ContractRow | null {
  const contractID = toNumber(readRowField(row, "contractID"));
  if (contractID <= 0) {
    return null;
  }
  const assigneeID = toNumber(readRowField(row, "assigneeID"));
  const acceptorID = toNumber(readRowField(row, "acceptorID"));
  return {
    contractID,
    type: toNumber(readRowField(row, "type")),
    status: toNumber(readRowField(row, "status")),
    availability: toNumber(readRowField(row, "availability")),
    issuerID: toNumber(readRowField(row, "issuerID")),
    issuerCorpID: toNumber(readRowField(row, "issuerCorpID")),
    forCorp: readRowField(row, "forCorp") === true,
    // 0 means "nobody", which is a real state (a public contract), not a bad id.
    assigneeID: assigneeID > 0 ? assigneeID : null,
    acceptorID: acceptorID > 0 ? acceptorID : null,
    dateIssued: toFiletime(readRowField(row, "dateIssued")),
    dateExpired: toFiletime(readRowField(row, "dateExpired")),
    dateAccepted: toFiletime(readRowField(row, "dateAccepted")),
    dateCompleted: toFiletime(readRowField(row, "dateCompleted")),
    numDays: toNumber(readRowField(row, "numDays")),
    startStationID: toNumber(readRowField(row, "startStationID")),
    endStationID: toNumber(readRowField(row, "endStationID")),
    startSolarSystemID: toNumber(readRowField(row, "startSolarSystemID")),
    endSolarSystemID: toNumber(readRowField(row, "endSolarSystemID")),
    // ⚠ DECIMAL STRINGS. ISK exceeds 2^53.
    price: toAmount(readRowField(row, "price")),
    reward: toAmount(readRowField(row, "reward")),
    collateral: toAmount(readRowField(row, "collateral")),
    volume: toNumber(readRowField(row, "volume")),
    title: toText(readRowField(row, "title")),
    description: toText(readRowField(row, "description")),
  };
}

/**
 * Decode a contract LIST BUNDLE — the shape GetMyCurrentContractList,
 * GetMyExpiredContractList and GetContractListForOwner all answer:
 * {contracts: list, items: dict keyed by contractID}.
 */
export function decodeContractList(result: JsonValue): readonly ContractRow[] {
  const rows: ContractRow[] = [];
  for (const row of listItems(readKeyVal(result, "contracts"))) {
    const decoded = decodeContractRow(row);
    if (decoded) {
      rows.push(decoded);
    }
  }
  // Newest first: a contract just issued matters more than one from last month.
  return rows.sort((left, right) => {
    if (left.dateIssued !== null && right.dateIssued !== null && left.dateIssued !== right.dateIssued) {
      return right.dateIssued > left.dateIssued ? 1 : -1;
    }
    return right.contractID - left.contractID;
  });
}

export interface DecodedBrowse {
  readonly contracts: readonly ContractRow[];
  /** How many the search matched in total, across every page. */
  readonly numFound: number;
}

/**
 * Decode a SearchContracts result: {contracts:[{contract, items, bids}], …}.
 *
 * ⚠ THE SEARCH ENTRY IS NESTED. Unlike a list bundle, whose `contracts` are
 * contract rows directly, a search entry WRAPS the row: the contract itself
 * rides `entry.contract`. Reading a search entry as a row finds no contractID
 * and drops every result — an empty browse that looks exactly like the empty
 * world.
 *
 * ⚠ `maxResults` IS DELIBERATELY NOT READ. It reports 1000
 * (MAX_CONTRACTS_PER_SEARCH) while the server actually slices by 100
 * (CONTRACTS_PER_PAGE); paging by it would skip 900 contracts per page. The
 * BFF owns the page stride.
 */
export function decodeContractSearch(result: JsonValue): DecodedBrowse {
  const contracts: ContractRow[] = [];
  for (const entry of listItems(readKeyVal(result, "contracts"))) {
    // Accept both shapes: the wrapped search entry, and a bare row if one ever
    // arrives. The wrapped one is what the server sends.
    const inner = readKeyVal(entry, "contract");
    const decoded = decodeContractRow(inner === undefined ? entry : inner);
    if (decoded) {
      contracts.push(decoded);
    }
  }
  return { contracts, numFound: toNumber(readKeyVal(result, "numFound")) };
}

function decodeItemRow(row: JsonValue): ContractItemRow | null {
  const typeID = toNumber(readRowField(row, "typeID")) || toNumber(readRowField(row, "itemTypeID"));
  if (typeID <= 0) {
    return null;
  }
  return {
    typeID,
    quantity: toNumber(readRowField(row, "quantity")),
    // `inCrate` distinguishes what is BEING HANDED OVER from what is being
    // ASKED FOR — the difference between a gift and a trade.
    inCrate: readRowField(row, "inCrate") === true,
  };
}

/** A search's entry as the client's result list reads one (ContractEntrySearch): the contract, its items, its bids. */
export interface ContractSearchEntry {
  readonly contract: ContractRow;
  readonly items: readonly ContractItemRow[];
  readonly numBids: number;
}

/**
 * A SearchContracts result read with each entry's items (the search entry's `items`: itemTypeID, quantity, inCrate),
 * which an item exchange's or an auction's row is named by (GetContractTitle).
 */
export function decodeContractSearchEntries(result: JsonValue): { readonly entries: readonly ContractSearchEntry[]; readonly numFound: number } {
  const entries: ContractSearchEntry[] = [];
  for (const entry of listItems(readKeyVal(result, "contracts"))) {
    const inner = readKeyVal(entry, "contract");
    const contract = decodeContractRow(inner === undefined ? entry : inner);
    if (!contract) continue;
    const items: ContractItemRow[] = [];
    for (const row of listItems(readKeyVal(entry, "items"))) {
      const decoded = decodeItemRow(row);
      if (decoded) items.push(decoded);
    }
    entries.push({ contract, items, numBids: toNumber(readKeyVal(entry, "numBids")) });
  }
  return { entries, numFound: toNumber(readKeyVal(result, "numFound")) };
}

/**
 * eveformat.truncate_text_ignoring_tags (tags.py 88 to 109): the text's letters counted outside its tags, cut at
 * `length` with the trail after; the trail is put on at the `length`-th letter even where nothing more follows.
 */
export function truncateIgnoringTags(text: string, length: number, trail: string): string {
  let result = "";
  let counter = 0;
  let done = false;
  for (const part of text.split(/(<.*?>)/)) {
    if (part.startsWith("<")) {
      result += part;
      continue;
    }
    if (done) continue;
    const plain = part.split("&gt;").join(">").split("&lt;").join("<").split("&amp;").join("&");
    for (const letter of plain) {
      result += letter === "&" ? "&amp;" : letter === "<" ? "&lt;" : letter === ">" ? "&gt;" : letter;
      counter += 1;
      if (counter === length) {
        done = true;
        result += trail;
        break;
      }
    }
  }
  return result;
}

/**
 * contractscommon.GetContractTitle (133 to 161): an item exchange or an auction with items by them (a trade where it
 * asks for some and gives some, MultipleItems where it gives several, the one type with its quantity where one), one
 * with none by what it wants (WantAGift with no reward, else WantToBuy); a courier by its route and volume; any other
 * by its title. Cut at 60 letters with MoreTrail; Unknown where nothing is left. `word` fills a label of the client's.
 */
export function contractTitle(contract: ContractRow, items: readonly ContractItemRow[], word: (label: string, args?: Readonly<Record<string, JsonValue>>) => string): string {
  const ITEM_EXCHANGE = 1;
  const AUCTION = 2;
  const COURIER = 3;
  let text = "";
  if ((contract.type === ITEM_EXCHANGE || contract.type === AUCTION) && items.length > 0) {
    const given = items.filter((item) => item.inCrate).length;
    const asked = items.length - given;
    if (contract.type === ITEM_EXCHANGE && asked > 0 && given > 0) text = word("UI/Contracts/ContractsWindow/WantToTrade");
    else if (given > 1) text = word("UI/Contracts/ContractsWindow/MultipleItems");
    else if (given === 1) {
      text = items[0]!.quantity > 1
        ? word("UI/Contracts/ContractsWindow/TypeNameWithQuantity", { typeID: items[0]!.typeID, quantity: items[0]!.quantity })
        : word("UI/Contracts/ContractsWindow/TypeName", { typeID: items[0]!.typeID });
    } else if (contract.type === ITEM_EXCHANGE) {
      text = Number(contract.reward ?? 0) === 0 ? word("UI/Contracts/ContractsWindow/WantAGift") : word("UI/Contracts/ContractEntry/WantToBuy");
    }
  } else if (contract.type === COURIER) {
    text = word("UI/Contracts/ContractsWindow/CourierContractTitleWIthVolume", { startSolarSystem: contract.startSolarSystemID, endSolarSystem: contract.endSolarSystemID, volume: contract.volume });
  } else {
    text = contract.title;
  }
  text = truncateIgnoringTags(text, 60, word("UI/Common/MoreTrail"));
  return text.length === 0 ? word("UI/Common/Unknown") : text;
}

/** The labels contractTitle may use, for the page to ask the client's words of. */
export const CONTRACT_TITLE_LABELS: readonly string[] = Object.freeze([
  "UI/Contracts/ContractsWindow/WantToTrade",
  "UI/Contracts/ContractsWindow/MultipleItems",
  "UI/Contracts/ContractsWindow/TypeNameWithQuantity",
  "UI/Contracts/ContractsWindow/TypeName",
  "UI/Contracts/ContractsWindow/WantAGift",
  "UI/Contracts/ContractEntry/WantToBuy",
  "UI/Contracts/ContractsWindow/CourierContractTitleWIthVolume",
  "UI/Common/MoreTrail",
  "UI/Common/Unknown",
]);

/** Decode a GetContract detail bundle: the row, its items, its endpoints. */
export function decodeContractDetail(result: JsonValue): ContractDetail | null {
  const contract = decodeContractRow(readKeyVal(result, "contract") ?? null);
  if (!contract) {
    return null;
  }
  const items: ContractItemRow[] = [];
  for (const row of listItems(readKeyVal(result, "items"))) {
    const decoded = decodeItemRow(row);
    if (decoded) {
      items.push(decoded);
    }
  }
  return {
    contract,
    items,
    startSolarSystemID: toNumber(readKeyVal(result, "startSolarSystemID")),
    endSolarSystemID: toNumber(readKeyVal(result, "endSolarSystemID")),
  };
}

/**
 * Decode GetLoginInfo's three summary rowsets into counts.
 *
 * ⚠ THESE ARE ROWSETS, NOT KeyVals: {columns, lines}. Only the row COUNT is
 * needed, so this reads `lines` and does not care about the columns.
 */
export function decodeContractSummary(result: JsonValue): ContractSummary {
  const countOf = (key: string): number => {
    const rowset = readKeyVal(result, key);
    const entries =
      rowset && typeof rowset === "object" && "args" in rowset
        ? (rowset as { args?: { entries?: readonly (readonly [string, JsonValue])[] } }).args?.entries
        : undefined;
    const lines = Array.isArray(entries)
      ? entries.find((entry) => Array.isArray(entry) && entry[0] === "lines")?.[1]
      : undefined;
    return isListValue(lines) ? lines.items.length : 0;
  };
  return {
    needsAttention: countOf("needsAttention"),
    inProgress: countOf("inProgress"),
    assignedToMe: countOf("assignedToMe"),
  };
}

// --- Money formatting -------------------------------------------------------

/**
 * Format an ISK amount held as a DECIMAL STRING, with thousands separators and
 * exactly two decimal places — never via a JS number, so an amount beyond 2^53
 * is not rounded on its way to the screen (R7d).
 */
export function formatIsk(amount: string | null | undefined): string {
  if (amount === null || amount === undefined || amount === "") {
    return "—";
  }
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(String(amount).trim());
  if (!match) {
    return "—";
  }
  const sign = match[1];
  const whole = (match[2] || "0").replace(/^0+(?=\d)/, "");
  const fraction = (match[3] || "").padEnd(2, "0").slice(0, 2);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${grouped}.${fraction} ISK`;
}

/** A volume in cubic metres, for the size of a delivery. */
export function formatVolume(volume: number): string {
  if (!Number.isFinite(volume) || volume <= 0) {
    return "—";
  }
  return `${volume.toLocaleString(undefined, { maximumFractionDigits: 2 })} m³`;
}

// --- Refusals ---------------------------------------------------------------

/**
 * Turn a server refusal into a sentence a player can act on. An UNMAPPED
 * refusal is passed through verbatim rather than reworded: inventing a cause
 * the server never gave is exactly the failure mode this ladder avoids.
 */
const REFUSAL_SENTENCES: Readonly<Record<string, string>> = {
  CONTRACT_INVALID: "No contract was named.",
  CONTRACT_NOT_FOUND: "That contract is no longer available.",
};

export function contractRefusalMessage(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  if (code && code in REFUSAL_SENTENCES) {
    return REFUSAL_SENTENCES[code] as string;
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (message && message in REFUSAL_SENTENCES) {
    return REFUSAL_SENTENCES[message] as string;
  }
  return message || "Those contracts could not be loaded.";
}
