import { readDictPairs, readKeyVal, readPlainJsonField, unwrapLong, type JsonValue } from "./wire.ts";

export interface AgencySeason {
  readonly titleID: number | null;
  readonly newsID: number | null;
  readonly templateID: number | null;
  readonly cardPicture: string | null;
  readonly banner: string | null;
  readonly endMs: number | null;
}

const unwrap = (answer: unknown) => readPlainJsonField(answer, "result") ?? answer;
function integer(v: JsonValue | undefined): number | null {
  const long = unwrapLong(v);
  const n = long === null ? v : Number(long);
  return typeof n === "number" && Number.isSafeInteger(n) ? n : null;
}
const string = (v: JsonValue | undefined): string | null => typeof v === "string" && v.length ? v : null;

/** The character's selected season. A selection list has no active season. */
export function decodeAgencySeason(answer: unknown): AgencySeason | null {
  const row = unwrap(answer);
  const field = (name: string) => readKeyVal(row, name);
  const templateID = integer(field("template_id"));
  if (templateID === null) return null;
  const end = field("end_time");
  const ticks = unwrapLong(end) ?? (typeof end === "number" && Number.isSafeInteger(end) ? BigInt(end) : null);
  return { titleID: integer(field("title")), newsID: integer(field("news")), templateID,
    cardPicture: string(field("navigation_card_picture_path")), banner: string(field("background_no_logo")),
    endMs: ticks && ticks > 116444736000000000n ? Number((ticks - 116444736000000000n) / 10000n) : null };
}

export function seasonPageKind(templateID: number | null): "vanguard" | "season" {
  // 24.02 SeasonsContentGroup.GetContentPageClass uses 2216; 2200 was 24.01.
  return templateID === 2216 ? "vanguard" : "season";
}

export function decodeAgencySeasonProgress(answer: unknown) {
  const row = unwrap(answer);
  const points = integer(readKeyVal(row, "seasonal_points"));
  if (points === null) return null;
  const challenges = readDictPairs(readKeyVal(row, "challenges")).flatMap(([id, value]) => {
    // The challenge's persisted attributes are the dict half of its ObjectEx2.
    const attributes = Array.isArray(readPlainJsonField(value, "dict")) ? readPlainJsonField(value, "dict") as readonly JsonValue[] : [];
    const fields = new Map(attributes.flatMap(pair => Array.isArray(pair) && typeof pair[0] === "string" ? [[pair[0], pair[1]] as const] : []));
    const name = integer(fields.get("name"));
    if (!name || fields.get("is_expired") === true) return [];
    return [{ id: integer(id) ?? name, name, detail: integer(fields.get("message_text")),
      points: integer(fields.get("points_awarded")) ?? 0, current: integer(fields.get("progress")) ?? 0, target: integer(fields.get("max_progress")) ?? 0 }];
  });
  return { points, target: integer(readKeyVal(row, "max_seasonal_points")), challenges };
}
