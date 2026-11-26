import { loadWords, publicGatewayRequest, type ApiOptions } from "../app/api.ts";
import { plainText } from "./clientWords.ts";
import type { JsonValue } from "./wire.ts";

const API = "eve_public.plex.vault.transaction.api.";
export const PLEX_HISTORY_PAGE_SIZE = 50;
export const PLEX_HISTORY_LIMIT = 2000;

function record(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, JsonValue>> : null;
}

function integer(value: JsonValue | undefined): bigint | null {
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  return typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : null;
}

function currency(value: JsonValue | undefined): bigint | null {
  const amount = record(value);
  return amount ? integer(amount.total_in_cents ?? 0) : null;
}

function messageID(value: JsonValue | undefined): number | null {
  const id = Number(integer(record(record(value)?.identifier)?.sequential));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function request(method: string, payload: Record<string, JsonValue>, options: ApiOptions) {
  const answer = await publicGatewayRequest(API + method + "Request", payload, options);
  const result = record(answer.payload);
  if (answer.statusCode !== 200 || !result) throw new Error("The PLEX transactions could not be read.");
  return result;
}

export async function readPlexHistoryIDs(options: ApiOptions): Promise<readonly string[]> {
  const reply = await request("GetAllLoggedForUser", {}, options);
  const rows = reply.transactions ?? [];
  if (!Array.isArray(rows)) throw new Error("The PLEX transaction list was invalid.");
  const ids = rows.slice(0, PLEX_HISTORY_LIMIT).map(row => integer(record(row)?.sequential));
  if (ids.some(id => id === null || id <= 0n)) throw new Error("The PLEX transaction list was invalid.");
  return [...new Set(ids.map(String))];
}

interface WirePlexTransaction {
  readonly date: Date;
  readonly amount: bigint;
  readonly balance: bigint;
  readonly categoryID: number | null;
  readonly summaryID: number | null;
}

export interface PlexTransaction extends Pick<WirePlexTransaction, "date" | "amount" | "balance"> {
  readonly category: string;
  readonly summary: string;
}

async function readLog(id: string, options: ApiOptions): Promise<WirePlexTransaction | null> {
  const reply = await request("GetLog", { identifier: { sequential: id } }, options);
  if (reply.unavailable === true) return null;
  const attributes = record(reply.transaction);
  const timestamp = record(attributes?.timestamp);
  const seconds = integer(timestamp?.seconds ?? 0);
  const nanos = integer(timestamp?.nanos ?? 0);
  const date = new Date(Number(seconds) * 1000 + Number(nanos) / 1000000);
  const amount = currency(attributes?.amount_transferred);
  const balance = currency(attributes?.resulting_balance);
  if (!timestamp || seconds === null || nanos === null || !Number.isFinite(date.getTime()) || amount === null || balance === null) {
    throw new Error("A PLEX transaction could not be read.");
  }
  const invoice = record(record(reply.invoice_entry)?.attributes);
  return { date, amount, balance, categoryID: messageID(invoice?.category) ?? 1022601,
    summaryID: messageID(invoice?.summary_message) };
}

export function plexHistoryReader(options: ApiOptions) {
  const details = new Map<string, Promise<WirePlexTransaction | null>>();
  const words = new Map<number, string>();

  function detail(id: string) {
    const known = details.get(id);
    if (known) return known;
    const pending = readLog(id, options).then(row => {
      if (row === null) details.delete(id);
      return row;
    }).catch(error => {
      details.delete(id);
      throw error;
    });
    details.set(id, pending);
    return pending;
  }

  return async (ids: readonly string[], current: () => boolean): Promise<readonly (PlexTransaction | null)[]> => {
    const rows: (WirePlexTransaction | null)[] = [];
    for (let start = 0; start < ids.length && current(); start += 10) {
      const batch = await Promise.all(ids.slice(start, start + 10).map(detail));
      if (!current()) break;
      const missing = [...new Set(batch.flatMap(row => row ? [row.categoryID, row.summaryID] : []))]
        .filter((id): id is number => id !== null && !words.has(id));
      if (missing.length) {
        const { messages } = await loadWords([], missing, [], options);
        for (const id of missing) words.set(id, plainText(messages[String(id)] ?? "").trim());
      }
      rows.push(...batch);
    }
    return rows.map(row => row && ({
      date: row.date, amount: row.amount, balance: row.balance,
      category: row.categoryID === null ? "" : words.get(row.categoryID) ?? "",
      summary: row.summaryID === null ? "" : words.get(row.summaryID) ?? "",
    }));
  };
}

function exportPlex(cents: bigint): string {
  // The native CSV uses Python 2 integer division. The visible cells truncate toward zero.
  return String(cents / 100n - (cents % 100n < 0n ? 1n : 0n));
}

export function plexHistoryCsv(headers: readonly string[], rows: readonly PlexTransaction[]): string {
  const quote = (value: string) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  const entries = rows.map(row => [
    row.date.toISOString().slice(0, 19).replace("T", " "),
    row.category, exportPlex(row.amount), exportPlex(row.balance), row.summary,
  ]);
  return [headers, ...entries].map(row => row.map(quote).join(",")).join("\r\n") + "\r\n";
}
