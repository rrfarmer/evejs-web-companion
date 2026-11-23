// Pure journal/tax decoding from WC75 core-prototype web/src/bridge/walletJournal.ts.
import { isListValue, readRowField, unwrapLong, type JsonValue } from "../wire.ts";
const REF = { agentMissionReward: 33, agentMissionTimeBonusReward: 34 } as const;
/** One of the journal's entries as the server sent it (a row of GetTransactions). */
export interface JournalEntry {
  readonly transactionID: number;
  readonly transactionDate: bigint | null;
  readonly referenceID: number | null;
  readonly entryTypeID: number;
  readonly ownerID1: number;
  readonly ownerID2: number;
  readonly amount: number;
  readonly balance: number;
  /** The server's description: free text, or YAML for a mapping. Null for none. */
  readonly description: string | null;
}

/** A line of the tab: an entry, or one the client derives from it. */
export interface JournalLine extends JournalEntry {
  /** GetTransactionKeyVal's sortValue: the entry's number, a derived line's beside it. */
  readonly sortValue: number;
  readonly derived: boolean;
}

function numberOf(value: JsonValue | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const long = unwrapLong(value);
  if (long !== null) return Number(long);
  return typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : null;
}

/** GetTransactions' rows, a DBRow or a KeyVal each. */
export function decodeJournalEntries(result: JsonValue | null | undefined): readonly JournalEntry[] {
  if (result === null || result === undefined || !isListValue(result)) return [];
  return result.items.map((row): JournalEntry => {
    const date = unwrapLong(readRowField(row, "transactionDate") as JsonValue);
    const description = readRowField(row, "description");
    return {
      transactionID: numberOf(readRowField(row, "transactionID")) ?? 0,
      transactionDate: date !== null && date > 0n ? date : null,
      referenceID: numberOf(readRowField(row, "referenceID")),
      entryTypeID: numberOf(readRowField(row, "entryTypeID")) ?? 0,
      ownerID1: numberOf(readRowField(row, "ownerID1")) ?? 0,
      ownerID2: numberOf(readRowField(row, "ownerID2")) ?? 0,
      amount: numberOf(readRowField(row, "amount")) ?? 0,
      balance: numberOf(readRowField(row, "balance")) ?? 0,
      description: typeof description === "string" && description !== "" ? description : null,
    };
  });
}

// --- YAML, as much of it as the server's descriptions are written in ------------------------------------------------

type Yaml = string | number | boolean | null | readonly Yaml[] | { readonly [key: string]: Yaml };

function scalarOf(text: string): Yaml {
  const t = text.trim();
  if (t === "" || t === "~" || t === "null") return null;
  if (t === "true" || t === "false") return t === "true";
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(t)) return Number(t);
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return t.slice(1, -1).replace(/''/g, "'");
  if (t.startsWith("\"") && t.endsWith("\"") && t.length >= 2) return t.slice(1, -1).replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c));
  if (t.startsWith("[") || t.startsWith("{")) return flowOf(t);
  return t;
}

/** A flow collection: [a, b] or {k: v}, nested, quotes kept whole. */
function flowOf(text: string): Yaml {
  const inner = text.trim().slice(1, -1);
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i]!;
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === "\"") quote = c;
    else if (c === "[" || c === "{") depth += 1;
    else if (c === "]" || c === "}") depth -= 1;
    else if (c === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  if (inner.slice(start).trim() !== "") parts.push(inner.slice(start));
  if (text.trim().startsWith("[")) return parts.map(scalarOf);
  const mapping: Record<string, Yaml> = {};
  for (const part of parts) {
    const at = part.indexOf(":");
    if (at < 0) continue;
    mapping[String(scalarOf(part.slice(0, at)))] = scalarOf(part.slice(at + 1));
  }
  return mapping;
}

interface YamlLine {
  readonly indent: number;
  readonly text: string;
}

function blockOf(lines: readonly YamlLine[], from: number, indent: number): { value: Yaml; next: number } {
  const first = lines[from];
  if (first === undefined) return { value: null, next: from };
  if (first.text.startsWith("- ") || first.text === "-") {
    const items: Yaml[] = [];
    let at = from;
    while (at < lines.length && lines[at]!.indent === indent && (lines[at]!.text.startsWith("- ") || lines[at]!.text === "-")) {
      items.push(scalarOf(lines[at]!.text.slice(1)));
      at += 1;
    }
    return { value: items, next: at };
  }
  const mapping: Record<string, Yaml> = {};
  let at = from;
  while (at < lines.length && lines[at]!.indent === indent) {
    const line = lines[at]!;
    const colon = line.text.search(/:(\s|$)/);
    if (colon < 0) return { value: mapping, next: at };
    const key = String(scalarOf(line.text.slice(0, colon)));
    const rest = line.text.slice(colon + 1).trim();
    at += 1;
    if (rest !== "") {
      // A plain scalar the dump wrapped onto lines indented under it.
      let value = rest;
      while (at < lines.length && lines[at]!.indent > indent && !/:(\s|$)/.test(lines[at]!.text) && !lines[at]!.text.startsWith("- ")) {
        value += ` ${lines[at]!.text}`;
        at += 1;
      }
      mapping[key] = scalarOf(value);
    } else if (at < lines.length && (lines[at]!.indent > indent || (lines[at]!.indent === indent && lines[at]!.text.startsWith("- ")))) {
      const nested = blockOf(lines, at, lines[at]!.indent);
      mapping[key] = nested.value;
      at = nested.next;
    } else {
      mapping[key] = null;
    }
  }
  return { value: mapping, next: at };
}

/** yaml.load of a description, where it is a mapping (the only shape the client reads anything from); else null. */
export function descriptionMapping(description: string | null): Readonly<Record<string, Yaml>> | null {
  if (description === null || description.trim() === "") return null;
  const trimmed = description.trim();
  if (trimmed.startsWith("{")) {
    const flow = flowOf(trimmed);
    return flow !== null && typeof flow === "object" && !Array.isArray(flow) ? (flow as Record<string, Yaml>) : null;
  }
  const lines: YamlLine[] = description.split(/\r?\n/)
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"))
    .map((line) => ({ indent: line.length - line.trimStart().length, text: line.trim() }));
  if (lines.length === 0 || !/:(\s|$)/.test(lines[0]!.text)) return null;
  const parsed = blockOf(lines, 0, lines[0]!.indent);
  return parsed.next === lines.length && parsed.value !== null && typeof parsed.value === "object" && !Array.isArray(parsed.value)
    ? (parsed.value as Record<string, Yaml>)
    : null;
}

/** The tax withheld from a native mission payout or time bonus. */
export function missionRewardTaxISK(entry: Pick<JournalEntry, "entryTypeID" | "description">): number | null {
  const key = entry.entryTypeID === REF.agentMissionReward ? "93" :
    entry.entryTypeID === REF.agentMissionTimeBonusReward ? "94" : null;
  if (key === null) return null;
  const mapping = descriptionMapping(entry.description);
  const description = entry.description?.trimStart() ?? "";
  if (!mapping && (/^9[34]:/.test(description) || description.startsWith("{"))) return null;
  if (mapping?.[key === "93" ? "94" : "93"] !== undefined) return null;
  const tax = mapping?.[key];
  if (tax === undefined) return 0;
  return Array.isArray(tax) && tax.length === 2 && typeof tax[0] === "number" &&
    Number.isSafeInteger(tax[0]) && tax[0] > 0 && typeof tax[1] === "number" &&
    Number.isFinite(tax[1]) && tax[1] >= 0 ? tax[1] : null;
}
