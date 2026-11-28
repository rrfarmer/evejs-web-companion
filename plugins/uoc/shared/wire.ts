// Pure wire helpers copied from WC75 web/src/bridge/wire.ts (40904 baseline).

export type JsonScalar = string | number | boolean | null;

export type JsonValue = JsonScalar | readonly JsonValue[] | { readonly [key: string]: JsonValue };

// --- Call tuple ------------------------------------------------------------

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
    typeof args === "object" && args !== null && args.type === "dict" && Array.isArray(args.entries)
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
