import { isListValue, readDictPairs, readKeyVal, readPlainJsonField, unwrapLong, type JsonValue } from "./wire.ts";

export interface AgencySeason {
  readonly seasonID: number | null;
  readonly titleID: number | null;
  readonly newsID: number | null;
  readonly templateID: number | null;
  readonly cardPicture: string | null;
  readonly banner: string | null;
  readonly endMs: number | null;
  readonly cardTitleID: number | null;
  readonly cardDescriptionID: number | null;
  readonly cardHintID: number | null;
  readonly multiple: boolean;
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
  return { seasonID: integer(field("season_id")), titleID: integer(field("title")), newsID: integer(field("news")), templateID,
    cardPicture: string(field("navigation_card_picture_path")), banner: string(field("background_no_logo")),
    endMs: ticks && ticks > 116444736000000000n ? Number((ticks - 116444736000000000n) / 10000n) : null,
    cardTitleID: integer(field("agency_card_title")), cardDescriptionID: integer(field("agency_card_description")),
    cardHintID: integer(field("agency_card_hint")), multiple: field("multiple_season_running") === true };
}

/** seasonService._fetch_season_data distinguishes a genuine list from a selected season. */
export function decodeAgencySeasonChoices(answer: unknown): AgencySeason[] {
  const row = unwrap(answer);
  if (!isListValue(row)) return [];
  return row.items.flatMap((item) => {
    const season = decodeAgencySeason(item);
    return season?.seasonID && season.seasonID > 0 ? [season] : [];
  });
}

export function decodeSeasonSelectionDefinition(answer: unknown) {
  const field = (name: string) => readPlainJsonField(answer, name);
  return {
    titleID: integer(field("seasonSelectionTitleID")),
    descriptionID: integer(field("seasonSelectionDescriptionID")),
    hintID: integer(field("seasonSelectionHintID")),
    headingID: integer(field("agencyLargeSeasonSelectionTitleID")),
    image: string(field("navigation_card_picture_path")),
  };
}

export function seasonPageKind(templateID: number | null): "vanguard" | "season" {
  // 24.02 SeasonsContentGroup.GetContentPageClass uses 2216; 2200 was 24.01.
  return templateID === 2216 ? "vanguard" : "season";
}

export interface AgencySeasonReward {
  readonly index: number;
  readonly points: number;
  readonly typeID: number;
  readonly quantity: number;
  readonly omegaOnly: boolean;
  readonly claimed: boolean;
}

export function seasonRewardClaimable(reward: AgencySeasonReward, points: number, omega: boolean): boolean {
  return !reward.claimed && points >= reward.points && (!reward.omegaOnly || omega);
}

export function decodeAgencySeasonProgress(answer: unknown) {
  const row = unwrap(answer);
  const points = integer(readKeyVal(row, "seasonal_points"));
  if (points === null) return null;
  const rewards = readDictPairs(readKeyVal(row, "seasonal_goals")).flatMap(([key, value]): AgencySeasonReward[] => {
    const goal = new Map(readDictPairs(value));
    const index = integer(key), required = integer(goal.get("points_required"));
    const typeID = integer(goal.get("reward_type_id")), quantity = integer(goal.get("reward_amount"));
    if (index === null || index < 0 || required === null || required < 0 || !typeID || !quantity) return [];
    return [{ index, points: required, typeID, quantity, omegaOnly: goal.get("omega_only") === true, claimed: goal.get("claimed") === true }];
  }).sort((a, b) => a.points - b.points || a.index - b.index);
  const challenges = readDictPairs(readKeyVal(row, "challenges")).flatMap(([id, value]) => {
    // The native Challenge restores its attribute dictionary from the ObjectEx2 reduce header.
    const header = readPlainJsonField(value, "header");
    const items = readPlainJsonField(value, "dict");
    const fields = new Map(Array.isArray(header)
      ? readDictPairs(header[1]).flatMap(([key, field]) => typeof key === "string" ? [[key, field] as const] : []) : []);
    if (Array.isArray(items)) {
      for (const pair of items) if (Array.isArray(pair) && typeof pair[0] === "string" && pair[1] !== undefined) fields.set(pair[0], pair[1]);
    }
    const name = integer(fields.get("name"));
    const challengeID = integer(fields.get("challenge_id")) ?? integer(id);
    if (!name || !challengeID || fields.get("is_expired") === true || fields.get("is_dormant") === true) return [];
    const points = integer(fields.get("points_awarded")) ?? 0, isk = integer(fields.get("isk_awarded")) ?? 0;
    const typeID = integer(fields.get("reward_type")), quantity = integer(fields.get("reward_amount")) ?? 0;
    const current = integer(fields.get("progress")) ?? 0, target = integer(fields.get("max_progress")) ?? 0;
    // ChallengeEntry draws its claim control at completion. The season service waits for reward_date.
    const claimable = current >= target && (points > 0 || isk > 0 || (typeID !== null && quantity > 0))
      && fields.get("reward_date") != null && fields.get("finish_date") == null;
    const expires = unwrapLong(fields.get("expiration_date"));
    const expiresMs = expires === null ? null : Number((expires - 116444736000000000n) / 10000n);
    return [{ id: challengeID, name, detail: integer(fields.get("message_text")), points, isk, typeID, quantity,
      current, target, claimable, expiresMs }];
  });
  return { seasonID: integer(readKeyVal(row, "season_id")), points, target: integer(readKeyVal(row, "max_seasonal_points")), rewards, challenges };
}
