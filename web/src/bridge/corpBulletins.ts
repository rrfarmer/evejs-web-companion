// The corporation's bulletins (corp_ui_bulletins.py CorpUIBulletins; base_corporation GetBulletins): corpRegistry.
// GetBulletins() - a CRowset (bulletinID, ownerID, createCharacterID, createDateTime, editCharacterID, editDateTime,
// title, body, sortOrder), ordered as the client orders them: by (sortOrder, -editDateTime).
import { isListValue, readRowField, unwrapLong, type JsonValue } from "./wire.ts";
import { unwrapCachedResult } from "./market.ts";
import { filetimeToUnixMs } from "./activity.ts";

export interface CorpBulletin {
  readonly bulletinID: number;
  readonly title: string;
  readonly body: string;
  readonly editCharacterID: number | null;
  /** The last edit's time as a FILETIME (the template's postTime), and in ms. */
  readonly editDateTime: bigint | null;
  readonly editDateTimeMs: number | null;
  readonly sortOrder: number;
}

const numberOf = (v: JsonValue | undefined): number => {
  if (typeof v === "number") return v;
  const l = unwrapLong(v);
  return l === null ? 0 : Number(l);
};
const textOf = (v: JsonValue | undefined): string => (typeof v === "string" ? v : "");

export function decodeBulletins(result: JsonValue | null | undefined): CorpBulletin[] {
  const rowset = unwrapCachedResult((result ?? null) as JsonValue) as { list?: unknown } | null;
  // the corporation's a CRowset; the alliance's (EveJS: a list of rows) read by attribute just the same
  // (base_corporation.GetBulletins: utillib.KeyVal(dbrow) of each)
  const list = isListValue(rowset) ? (rowset.items as JsonValue[])
    : rowset && typeof rowset === "object" && !Array.isArray(rowset) && Array.isArray(rowset.list) ? (rowset.list as JsonValue[]) : [];
  const out: CorpBulletin[] = [];
  for (const row of list) {
    const bulletinID = numberOf(readRowField(row, "bulletinID"));
    if (bulletinID <= 0) continue;
    const edit = unwrapLong(readRowField(row, "editDateTime"));
    const editor = numberOf(readRowField(row, "editCharacterID"));
    out.push({
      bulletinID, title: textOf(readRowField(row, "title")), body: textOf(readRowField(row, "body")),
      editCharacterID: editor > 0 ? editor : null, editDateTime: edit, editDateTimeMs: filetimeToUnixMs(edit),
      sortOrder: numberOf(readRowField(row, "sortOrder")),
    });
  }
  // GetBulletins: sorted by (sortOrder, -editDateTime)
  return out.sort((a, b) => a.sortOrder - b.sortOrder || (b.editDateTimeMs ?? 0) - (a.editDateTimeMs ?? 0));
}
