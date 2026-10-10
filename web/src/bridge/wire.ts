// TypeScript view of docs/bridge-wire-contract.md (goal R1b).
//
// The unit the bridge mirrors is the retail call tuple
// (service, method, args, kwargs). These types cover the browser -> BFF hop
// (POST /api/bridge/call) plus the marshaled value encodings retail-shaped
// handler results use on the wire (list / dict / util.KeyVal / long).

// --- JSON building blocks --------------------------------------------------

export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | readonly JsonValue[] | { readonly [key: string]: JsonValue };

// --- Call tuple ------------------------------------------------------------

export type CallArgs = readonly JsonValue[];
export type CallKwargs = Readonly<Record<string, JsonValue>> | null;

/**
 * Non-authoritative presentation preferences accepted by the BFF. Identity,
 * authority, character, corporation, role, ship and location state is held or
 * created server-side; browser-supplied fields outside this list are ignored.
 */
export interface SessionFields {
  readonly languageID?: string;
  readonly languageId?: string;
  readonly languageid?: string;
  readonly language?: string;
}

export interface BridgeCallRequestBody {
  readonly service: string;
  readonly method: string;
  readonly args: CallArgs;
  readonly kwargs: CallKwargs;
  readonly session?: SessionFields;
  /**
   * The call is a pilot's: one the page makes in place of a route that needed a pilot held. With none held, the
   * BFF says so (NO_LIVE_SESSION), as that route did, and does not take the call for the account's.
   */
  readonly pilot?: true;
  /**
   * The page means this write: what a write's route took as its confirmation. A write the page makes for its
   * pilot says both this and `pilot`; the BFF makes it only if it is one of the writes the page makes itself.
   */
  readonly confirm?: true;
  /**
   * What the object this call is made on is for: the client's Moniker(service, what), a planet's ID for a call on
   * the planet manager's object for that planet. Said only for the page's own calls that are made on such an
   * object (src/bridgeCallPolicy.js, PAGE_OBJECT_CALLS), which are not made without it.
   */
  readonly of?: JsonValue;
}

// --- Response envelopes ----------------------------------------------------

/** One captured sendServiceNotification call, in handler order. */
export interface BridgeNotification {
  readonly service: string;
  readonly method: string;
  readonly args: readonly JsonValue[];
  readonly kwargs: Readonly<Record<string, JsonValue>> | null;
}

export interface BridgeCallSuccessBody<TResult = JsonValue> {
  readonly ok: true;
  readonly service: string;
  readonly method: string;
  readonly result: TResult;
  readonly notifications: readonly BridgeNotification[];
  /**
   * The server's clock, in milliseconds, with a pilot's answer: as the pilot's session has it on the game port,
   * and the BFF's own through the web gateway. A retail client reads its own clock, which its connection keeps
   * set; the page is told with each answer.
   */
  readonly serverNowMs?: number;
}

export interface BridgeErrorBody {
  readonly ok: false;
  readonly error: string;
  readonly message?: string;
}

/**
 * Error codes the BFF route can return (docs/bridge-wire-contract.md).
 * Gateway codes pass through with their status. The (string & {}) arm keeps
 * the union open for codes added later without breaking narrowing on these.
 */
export type BridgeErrorCode =
  | "CALL_INVALID"
  | "CALL_NOT_ALLOWED"
  | "BRIDGE_WRITE_REQUIRES_DEDICATED_ROUTE"
  | "CALL_SERVICE_UNAVAILABLE"
  | "CALL_FAILED"
  | "UNAUTHORIZED"
  | "GATEWAY_RUNTIME_NOT_READY"
  | "AUTH_REQUIRED"
  | "EVE_GATEWAY_UNREACHABLE"
  | "EVE_GATEWAY_TIMEOUT"
  | (string & {});

// --- Marshaled value encodings ---------------------------------------------
// Retail-shaped results carry these wrappers (built by eve.js service
// helpers, JSON-encoded by the gateway).

// These are type aliases (not interfaces) on purpose: aliases get implicit
// index signatures, so marshaled wrappers stay assignable to JsonValue.

/**
 * Retail long/FILETIME. Handlers that hold a BigInt cross the gateway as a
 * decimal string; handlers that used plain numbers still emit numbers.
 * Clients must accept both (wire contract, value encoding).
 */
export type LongValue = {
  readonly type: "long";
  readonly value: number | string;
};

export type ListValue<TItem = JsonValue> = {
  readonly type: "list";
  readonly items: readonly TItem[];
};

export type DictEntry = readonly [string, JsonValue];

export type DictValue = {
  readonly type: "dict";
  readonly entries: readonly DictEntry[];
};

/** util.KeyVal row: {type:"object", name:"util.KeyVal", args:{type:"dict", entries:[[k,v],...]}} */
export type KeyValValue = {
  readonly type: "object";
  readonly name: "util.KeyVal";
  readonly args: DictValue;
};

/**
 * A blue.DBRow — the OTHER row shape on this wire, and the one that has bitten
 * us. `buildPackedRow` (eve.js server/src/services/_shared/serviceHelpers.js:110)
 * emits `{type:"packedrow", header, columns:[[name, typeCode], …], fields}`
 * where `fields` is a plain name-keyed object; `buildPackedRowFromRowsetLine`
 * emits the POSITIONAL variant instead, carrying `values` parallel to
 * `columns`. Both are read here so a caller never has to care which it got.
 *
 * ⚠ A PACKEDROW IS NOT A KeyVal AND FAILS `isKeyValValue`. Reading one with
 * `readKeyVal` returns undefined for EVERY field, which does not throw and does
 * not log — the row simply decodes to nothing and the panel shows an absence.
 * Whether a given handler builds KeyVals or packed rows is a per-method choice
 * on the server (contractProxy builds LIST rows as KeyVals and DETAIL rows as
 * packed rows), so decoders should read rows through `readRowField` below
 * rather than committing to one shape.
 */
export type PackedRowValue = {
  readonly type: "packedrow";
  readonly columns?: readonly JsonValue[];
  readonly fields?: Readonly<Record<string, JsonValue>>;
  readonly values?: readonly JsonValue[];
};

// --- Decoding helpers ------------------------------------------------------

export function isListValue(value: unknown): value is ListValue {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "list" &&
    Array.isArray((value as { items?: unknown }).items)
  );
}

export function isKeyValValue(value: unknown): value is KeyValValue {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { type?: unknown; name?: unknown; args?: unknown };
  if (candidate.type !== "object" || candidate.name !== "util.KeyVal") {
    return false;
  }
  const args = candidate.args as { type?: unknown; entries?: unknown } | null | undefined;
  return (
    typeof args === "object" &&
    args !== null &&
    args.type === "dict" &&
    Array.isArray(args.entries)
  );
}

/** Read one key from a util.KeyVal row; undefined when absent or malformed. */
export function readKeyVal(row: unknown, key: string): JsonValue | undefined {
  if (!isKeyValValue(row)) {
    return undefined;
  }
  const entry = row.args.entries.find(
    (candidate) => Array.isArray(candidate) && candidate[0] === key,
  );
  return entry ? entry[1] : undefined;
}

/**
 * Read one own property from a plain JSON object.
 *
 * BFF HTTP envelopes are ordinary objects produced by Express `res.json`; they
 * are not retail `util.KeyVal` values. This reader deliberately does not descend
 * into marshaled wrappers and rejects arrays/null. Keep `readKeyVal` for nested
 * gateway results that are explicitly encoded as `util.KeyVal`.
 */
export function readPlainJsonField(value: unknown, key: string): JsonValue | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Readonly<Record<string, JsonValue>>;
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

export function isPackedRowValue(value: unknown): value is PackedRowValue {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === "packedrow"
  );
}

/**
 * Read one column from a packed row by NAME, from either variant: the
 * name-keyed `fields` object, or `values` positioned against `columns`.
 * undefined when absent or malformed — never a substituted default.
 */
export function readPackedRow(row: unknown, key: string): JsonValue | undefined {
  if (!isPackedRowValue(row)) {
    return undefined;
  }
  const fields = row.fields;
  if (typeof fields === "object" && fields !== null && !Array.isArray(fields)) {
    if (key in fields) {
      return fields[key];
    }
  }
  if (Array.isArray(row.columns) && Array.isArray(row.values)) {
    // A column is [name, typeCode]; a bare string name is tolerated too.
    const index = row.columns.findIndex((column) =>
      Array.isArray(column) ? column[0] === key : column === key,
    );
    if (index >= 0) {
      return row.values[index];
    }
  }
  return undefined;
}

/**
 * Read one field from a server ROW, whichever shape it arrived in — util.KeyVal
 * or packedrow.
 *
 * ⚠ PREFER THIS OVER `readKeyVal` FOR ANYTHING THE SERVER CALLS A ROW. The two
 * shapes are chosen per handler and are not visible from the call site; a
 * decoder that hardcodes one of them fails SILENTLY against the other, drops
 * every field, and renders an empty panel that is indistinguishable from an
 * empty world. Use `readKeyVal` directly only for a value that is genuinely a
 * KeyVal and never a row — a result BUNDLE, say.
 */
export function readRowField(row: unknown, key: string): JsonValue | undefined {
  return isPackedRowValue(row) ? readPackedRow(row, key) : readKeyVal(row, key);
}

/**
 * Read one key from a BARE marshaled dict — `{type:"dict", entries:[[k,v],…]}`.
 *
 * Distinct from readKeyVal above, which only understands the util.KeyVal
 * WRAPPER around such a dict. Some pushed notifications carry the bare form
 * (OnDamageMessage's single argument is one), so both readers exist and neither
 * pretends to handle the other's shape.
 *
 * Returns undefined when the value is not a dict or the key is absent — never a
 * substituted default, so a caller can tell "absent" from "present and zero".
 */
export function readDictEntry(value: unknown, key: string): JsonValue | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as { type?: unknown; entries?: unknown };
  if (candidate.type !== "dict" || !Array.isArray(candidate.entries)) {
    return undefined;
  }
  const entry = (candidate.entries as readonly unknown[]).find(
    (row) => Array.isArray(row) && row[0] === key,
  );
  return Array.isArray(entry) ? (entry[1] as JsonValue) : undefined;
}

/** A token/rawstr wrapper's text, or a bare string; "" otherwise. */
function tokenText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && value !== null) {
    const inner = (value as { value?: unknown }).value;
    if (typeof inner === "string") {
      return inner;
    }
  }
  return "";
}

/**
 * Read the rows of a marshaled Rowset as {column: value} records.
 *
 * A util.Rowset / eve.common.script.sys.rowset.Rowset is
 *   {type:"object", name:<…Rowset…>, args:{type:"dict", entries:[
 *     ["header",  {type:"list", items:[colName, …]}],
 *     ["columns", {type:"list", items:[colName, …]}],
 *     ["RowClass",{type:"token", value:"util.Row"}],
 *     ["lines",   {type:"list", items:[<line>, …]}]]}}
 *
 * ⚠ A `<line>` is EITHER a bare JSON array of cells (the shape charMgr's
 * GetContactList / GetOwnerNoteLabels emit — their rows are plain arrays) OR a
 * `{type:"list"}` wrapper (util.Row); both are read, because a decoder that
 * assumes one silently reads zero rows of the other. Columns come from
 * `columns` (falling back to `header`); an absent column reads as null, never a
 * substituted default. `[]` when the value is not a rowset or carries no
 * columns — a real "no rows" answer.
 */
export function readRowsetRows(
  rowset: unknown,
): readonly Readonly<Record<string, JsonValue>>[] {
  if (typeof rowset !== "object" || rowset === null) {
    return [];
  }
  const candidate = rowset as { type?: unknown; args?: unknown };
  if (candidate.type !== "object") {
    return [];
  }
  const args = candidate.args as { type?: unknown; entries?: unknown } | null | undefined;
  if (typeof args !== "object" || args === null || args.type !== "dict" || !Array.isArray(args.entries)) {
    return [];
  }
  const entries = args.entries as readonly unknown[];
  const byKey = (key: string): JsonValue | undefined => {
    const entry = entries.find((row) => Array.isArray(row) && tokenText(row[0]) === key);
    return Array.isArray(entry) ? (entry[1] as JsonValue) : undefined;
  };
  const columnsValue = byKey("columns") ?? byKey("header");
  const columns = isListValue(columnsValue) ? columnsValue.items.map(tokenText) : [];
  if (columns.length === 0) {
    return [];
  }
  const linesValue = byKey("lines");
  const lines = isListValue(linesValue) ? linesValue.items : [];
  return lines.map((line) => {
    const cells: readonly JsonValue[] = Array.isArray(line)
      ? line
      : isListValue(line)
        ? line.items
        : [];
    const record: Record<string, JsonValue> = {};
    columns.forEach((column, index) => {
      record[column] = (cells[index] ?? null) as JsonValue;
    });
    return record;
  });
}

/**
 * Read the entries of a BARE marshaled dict — `{type:"dict", entries:[[k,v],…]}`
 * — as the raw `[key, value]` pairs, in wire order.
 *
 * Distinct from readDictEntry (one key by name): this iterates the WHOLE dict, so
 * a caller can decode an id-keyed dict (mailMgr.GetLabels is labelID -> KeyVal;
 * mailingListsMgr.GetMembers is memberID -> accessLevel). Keys arrive as the wire
 * left them (numeric ids come through as JSON numbers), so a caller coerces the
 * key itself. `[]` when the value is not a dict — a real "no entries" answer,
 * never a substituted default.
 */
export function readDictPairs(value: unknown): readonly DictEntry[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const candidate = value as { type?: unknown; entries?: unknown };
  if (candidate.type !== "dict" || !Array.isArray(candidate.entries)) {
    return [];
  }
  return (candidate.entries as readonly unknown[]).filter(
    (entry): entry is DictEntry => Array.isArray(entry) && entry.length >= 2,
  );
}

/**
 * Unwrap a retail long to bigint. Accepts the {type:"long"} wrapper with a
 * number or decimal-string value (both are on the wire per the contract),
 * bare integers, and a bare string of digits; null for anything else
 * (including absent/null fields).
 *
 * The bare string is the web gateway's spelling of some timestamps (market
 * history days, dogma times), where the game port gives the wrapper for the
 * same long. Reading both here is what lets one decoder serve either.
 */
export function unwrapLong(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return BigInt(value);
  }
  if (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "long"
  ) {
    const inner = (value as { value?: unknown }).value;
    if (typeof inner === "number" && Number.isInteger(inner)) {
      return BigInt(inner);
    }
    if (typeof inner === "string" && /^-?\d+$/.test(inner)) {
      return BigInt(inner);
    }
  }
  return null;
}

/**
 * Read a retail boolean. Accepts true and false, and a bare 1 and 0; null for
 * anything else (including absent/null fields).
 *
 * A BOOL column of a packed row is a bit on the wire, and the game port gives
 * it as the boolean it is. The web gateway prints the server's own value for
 * the column, which is 0 or 1 (a corporation member's `blockRoles`, seen
 * 2026-10-09). Reading both here is what lets one decoder serve either.
 */
export function unwrapBool(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  return value === 1 ? true : value === 0 ? false : null;
}

/**
 * Unwrap a retail real (a double) to a number. Accepts the {type:"real"}
 * wrapper with a finite number value and bare finite numbers; null for
 * anything else (including absent/null fields). eve.js sends ISK money this
 * way (buildMarshalRealMoney), and the gateway forwards the wrapper as JSON.
 */
export function unwrapReal(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "real"
  ) {
    const inner = (value as { value?: unknown }).value;
    if (typeof inner === "number" && Number.isFinite(inner)) {
      return inner;
    }
  }
  return null;
}
