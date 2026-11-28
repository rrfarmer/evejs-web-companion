import { isListValue } from "./wire.ts";

type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scalar(value: unknown): unknown {
  return isRecord(value) && "value" in value ? value.value : value;
}

function items(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? value : isListValue(value) ? value.items : null;
}

function namedCells(header: unknown, line: unknown): Fields | null {
  const columns = items(header)?.map(scalar);
  const cells = items(line);
  if (!columns || !cells || columns.length !== cells.length || !columns.every(key => typeof key === "string")) return null;
  return Object.fromEntries(columns.map((key, index) => [key, scalar(cells[index])]));
}

/** Read corpRegistry's Row, keyed object or packed row from either bridge transport. */
export function readCorporationRow(row: unknown): Fields | null {
  if (!isRecord(row)) return null;
  if (row.type === "objectex2") {
    const header = row.header;
    if (!Array.isArray(header) || !Array.isArray(header[0]) ||
        scalar(header[0][0]) !== "carbon.common.script.sys.row.Row" || !Array.isArray(header[1])) return null;
    return namedCells(header[1][0], header[1][1]);
  }

  if (row.type === "packedrow" && isRecord(row.fields)) {
    return Object.fromEntries(Object.entries(row.fields).map(([key, value]) => [key, scalar(value)]));
  }
  if (row.type !== "object" || !isRecord(row.args) || !Array.isArray(row.args.entries)) return null;
  const entries = row.args.entries;
  if (!entries.every(entry => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string")) return null;
  const fields = Object.fromEntries(entries.map(([key, value]) => [key, scalar(value)]));
  if ("header" in fields || "line" in fields) return namedCells(fields.header, fields.line);
  return fields;
}
