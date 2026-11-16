// What the account may redeem, as the retail client's redeem service has it (eve/client/script/ui/services/redeemsvc.py),
// and the redeem window's claim of it (eve/client/script/ui/shared/redeem/redeemItemsContainer.py).
//
// THE TOKENS. sm.RemoteSvc('userSvc').GetRedeemTokens() (63 to 65), asked with nothing, answers a rowset of the
// account's tokens: tokenID, massTokenID, typeID, quantity, the blueprint's runs and levels, label, description,
// dateTime, expireDateTime, availableDateTime, stationID and soulbound. The service fetches it as the neocom is set up,
// at the server's OnRedeemingQueueUpdated (162 to 169) and after a claim (127), and keeps it. The window keys a token by
// its tokenID and massTokenID (token_key, 401 to 402), and the neocom's count is how many there are (56 to 61).
//
// The queue is the ACCOUNT's, not the character's: every pilot of one account sees the same tokens.
//
// THE CLAIM. ClaimRedeemTokens(tokens, charID, useHomeStation=...) (99 to 131), made by the window's Redeem to Current
// Station and Redeem to Home Station (343 to 356) with the selected tokens, answers a dict: `errors`, a list of
// (tokenID, error) where the error is a util.KeyVal of msg and dict; `itemsCreated`, a dict for each item made; and
// `stationID`, where they were made. Skill points, ISK and the like go onto the character and make no item.

import { isListValue, readDictEntry, readKeyVal, readRowField, readRowsetRows, unwrapBool, unwrapLong, type JsonValue } from "./wire.ts";
import { filetimeToUnixMs } from "./activity.ts";

/** The server's notice that what the account may redeem has changed. */
export const REDEEM_NOTICE = "OnRedeemingQueueUpdated";

export interface RedeemToken {
  readonly tokenID: number;
  /** null where the token is its own (the server says none where it is the tokenID). */
  readonly massTokenID: number | null;
  readonly typeID: number;
  readonly quantity: number;
  /** Above nought for a blueprint copy: its runs. */
  readonly blueprintRuns: number;
  /** The token's label as text, "" where it is none or a message the page cannot word. */
  readonly label: string;
  readonly description: string;
  /** When it came, in Unix ms; null where it is not said. */
  readonly addedAt: number | null;
  /** When it runs out, in Unix ms; null where it never does. */
  readonly expiresAt: number | null;
  readonly soulbound: boolean;
}

/** The retail redeem service diverts typeSoulboundMultiTrainingToken to its activation window. */
export const TRAINING_CERTIFICATE_NOTICE = "Activate this training certificate in the EVE client.";

export function canRedeemOrdinarily(token: Pick<RedeemToken, "typeID">): boolean {
  return token.typeID !== 63188;
}

// 3698585 redeem.data.get_redeem_data: these types redeem directly into skill points.
const SKILL_POINT_TYPES = new Set([
  54652, 54653, 63303, 63304, 54650, 63305, 63306, 63307, 63308, 54654, 63309, 63310,
  52520, 63311, 63312, 63313, 63314, 63315, 63316, 63317, 63318, 63623, 63624, 63319,
  63320, 63321, 63322, 49756, 63323, 63324, 63325, 57003, 63326, 63327, 63328, 63329,
  63330, 63331, 63332, 63333, 63334, 63335, 63336, 63337, 63338, 49809, 63339, 63340,
  63824, 49810, 63825, 54648, 43680, 52269, 89839, 52270, 52318, 52263, 56707,
]);

export function isSkillPointRedeem(typeID: number): boolean {
  return SKILL_POINT_TYPES.has(typeID);
}

/** What a claim made and what it could not. */
export interface RedeemOutcome {
  /** The tokens that were not redeemed, each with the server's message name (RedeemNoDestination, ...). */
  readonly errors: readonly { readonly tokenID: number; readonly message: string }[];
  /** How many items were made in a hangar. */
  readonly itemsCreated: number;
  /** Where they were made; null where nothing was. */
  readonly stationID: number | null;
}

/** A token's key as the claim sends it (token_key): its tokenID and its massTokenID. */
export function tokenKey(token: RedeemToken): [number, number | null] {
  return [token.tokenID, token.massTokenID];
}

const wholeOf = (value: JsonValue | undefined): number | null => {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  const long = unwrapLong(value);
  return long !== null && long >= BigInt(Number.MIN_SAFE_INTEGER) && long <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(long) : null;
};

/** A wstring wrapper's text, or a bare string; "" otherwise. */
const textOf = (value: JsonValue | undefined): string => {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const inner = (value as { value?: unknown }).value;
    if (typeof inner === "string") return inner;
  }
  return "";
};

/**
 * redeemsvc.py _GetMessageOrLabel (187 to 197): a label is a message ID or a localization label, worded by the client,
 * or the text itself. The page has not the client's messages: those two are no words here, and the text is its own.
 */
function wordsOf(value: JsonValue | undefined): string {
  const text = textOf(value).trim();
  return /^\d+$/.test(text) || /^UI\/\S+$/.test(text) ? "" : text;
}

const msOf = (value: JsonValue | undefined): number | null => filetimeToUnixMs(unwrapLong(value));

/** A rowset's rows: a CRowset's (its packed rows on `list`), or a util.Rowset's records. */
function rowsOf(rowset: JsonValue): readonly unknown[] {
  if (typeof rowset === "object" && rowset !== null && !Array.isArray(rowset)) {
    const list = (rowset as { list?: unknown }).list;
    if (Array.isArray(list)) return list;
  }
  return readRowsetRows(rowset);
}

/** A row's column, whether the row is a packed row or a util.Rowset's record. */
function fieldOf(row: unknown, key: string): JsonValue | undefined {
  const read = readRowField(row, key);
  if (read !== undefined) return read;
  return typeof row === "object" && row !== null && !Array.isArray(row) && key in row ? (row as Record<string, JsonValue>)[key] : undefined;
}

/** userSvc.GetRedeemTokens' answer as the page keeps it; null for an answer that is no rowset. */
export function decodeRedeemTokens(result: JsonValue): readonly RedeemToken[] | null {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return null;
  const tokens: RedeemToken[] = [];
  for (const row of rowsOf(result)) {
    const tokenID = wholeOf(fieldOf(row, "tokenID"));
    const typeID = wholeOf(fieldOf(row, "typeID"));
    if (tokenID === null || tokenID <= 0 || typeID === null || typeID <= 0) continue;
    const mass = wholeOf(fieldOf(row, "massTokenID"));
    tokens.push({
      tokenID,
      massTokenID: mass !== null && mass > 0 ? mass : null,
      typeID,
      quantity: Math.max(1, wholeOf(fieldOf(row, "quantity")) ?? 1),
      blueprintRuns: Math.max(0, wholeOf(fieldOf(row, "blueprintRuns")) ?? 0),
      label: wordsOf(fieldOf(row, "label")),
      description: wordsOf(fieldOf(row, "description")),
      addedAt: msOf(fieldOf(row, "dateTime")),
      expiresAt: msOf(fieldOf(row, "expireDateTime")),
      soulbound: unwrapBool(fieldOf(row, "soulbound")) === true,
    });
  }
  return tokens;
}

/** userSvc.ClaimRedeemTokens' answer. An answer that is no dict made nothing and refused nothing. */
export function decodeRedeemOutcome(result: JsonValue): RedeemOutcome {
  const errorsValue = readDictEntry(result, "errors");
  const errors = (isListValue(errorsValue) ? errorsValue.items : Array.isArray(errorsValue) ? errorsValue : []).flatMap((pair) => {
    const items = Array.isArray(pair) ? pair : isListValue(pair) ? pair.items : null;
    if (items === null) return [];
    const tokenID = wholeOf(items[0]);
    const message = textOf(readKeyVal(items[1], "msg"));
    return tokenID === null ? [] : [{ tokenID, message }];
  });
  const made = readDictEntry(result, "itemsCreated");
  const itemsCreated = isListValue(made) ? made.items.length : Array.isArray(made) ? made.length : 0;
  const stationID = wholeOf(readDictEntry(result, "stationID"));
  return { errors, itemsCreated, stationID: stationID !== null && stationID > 0 ? stationID : null };
}
