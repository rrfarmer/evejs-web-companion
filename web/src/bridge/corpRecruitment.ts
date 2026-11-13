// The corporation finder's recruitment ads (recruitment/corpRecruitmentContainer.py CorpRecruitmentContainerSearch;
// base_corporation GetRecruitmentAdsByCriteria / GetRecruitmentAdsForCorpID): corpRecProxy.SearchCorpAds answers
// (grade, advert) pairs (GetRecruitementEntryDataList: "for grade, advert in ads"), GetRecruitmentAdsByCorpID bare
// adverts (the client pairs them with None). An advert: adID, corporationID, allianceID, channelID, typeMask,
// langMask, description, title, createDateTime, expiryDateTime, hourMask1, minSP, otherMask, memberCount.
import { isListValue, readDictEntry, readRowField as readPackedOrKeyVal, unwrapLong, unwrapReal, type JsonValue } from "./wire.ts";
import { filetimeToUnixMs } from "./activity.ts";

/** GetSearchResults' criteria, in SearchCorpAds' order. */
export interface RecruitmentSearch {
  readonly typeMask: number;
  readonly langMask: number;
  readonly excludeAlliances: boolean;
  readonly excludeFriendlyFire: boolean;
  readonly spRestriction: number | null;
  readonly minMembers: number;
  readonly maxMembers: number;
  readonly maxISKTaxRate: number;
  readonly maxLPTaxRate: number;
  readonly searchTimeMask: number;
  readonly otherMask: number;
}

export interface RecruitmentAd {
  readonly adID: number;
  readonly corporationID: number;
  readonly allianceID: number | null;
  readonly title: string;
  readonly description: string;
  readonly typeMask: number;
  readonly langMask: number;
  readonly hourMask1: number;
  readonly minSP: number;
  readonly otherMask: number;
  readonly memberCount: number;
  readonly createDateTimeMs: number | null;
  readonly expiryDateTimeMs: number | null;
  /** The search's match percentage, where the server grades (None: not shown). */
  readonly grade: number | null;
}

/** A row's field: a util.Row (its header and line, as corpRecProxy's buildRow sends one), a packed row or a KeyVal. */
function readRowField(row: JsonValue, key: string): JsonValue | undefined {
  const record = row as { type?: unknown; name?: unknown; args?: unknown } | null;
  if (record && typeof record === "object" && record.type === "object" && record.name === "util.Row") {
    const header = readDictEntry(record.args, "header"), line = readDictEntry(record.args, "line");
    const columns = isListValue(header) ? header.items : [], cells = isListValue(line) ? line.items : Array.isArray(line) ? line : [];
    const at = columns.indexOf(key);
    return at < 0 ? undefined : (cells[at] as JsonValue | undefined);
  }
  return readPackedOrKeyVal(row, key);
}

const numberOf = (v: JsonValue | undefined): number => {
  if (typeof v === "number") return v;
  const l = unwrapLong(v);
  if (l !== null) return Number(l);
  const r = unwrapReal(v);
  return r ?? 0;
};

function pairOf(item: JsonValue): readonly [JsonValue | null, JsonValue] {
  if (Array.isArray(item) && item.length === 2) return [item[0] ?? null, item[1] as JsonValue];
  const tuple = item as { type?: unknown; items?: unknown } | null;
  if (tuple && typeof tuple === "object" && tuple.type === "tuple" && Array.isArray(tuple.items) && tuple.items.length === 2) {
    return [(tuple.items[0] ?? null) as JsonValue | null, tuple.items[1] as JsonValue];
  }
  return [null, item];
}

export function decodeRecruitmentAds(answer: JsonValue | null | undefined, now = Date.now()): RecruitmentAd[] {
  const items: readonly JsonValue[] = isListValue(answer) ? answer.items : Array.isArray(answer) ? answer : [];
  const out: RecruitmentAd[] = [];
  for (const item of items) {
    const [gradeValue, row] = pairOf(item);
    const adID = numberOf(readRowField(row, "adID"));
    if (adID <= 0) continue;
    const expiry = filetimeToUnixMs(unwrapLong(readRowField(row, "expiryDateTime")));
    // MakeRecruitmentEntriesFromAdList: an advert past its expiry is left out
    if (expiry !== null && expiry < now) continue;
    const alliance = numberOf(readRowField(row, "allianceID"));
    const title = readRowField(row, "title"), description = readRowField(row, "description");
    out.push({
      adID, corporationID: numberOf(readRowField(row, "corporationID")), allianceID: alliance > 0 ? alliance : null,
      title: typeof title === "string" ? title : "", description: typeof description === "string" ? description : "",
      typeMask: numberOf(readRowField(row, "typeMask")), langMask: numberOf(readRowField(row, "langMask")),
      hourMask1: numberOf(readRowField(row, "hourMask1")), minSP: numberOf(readRowField(row, "minSP")),
      otherMask: numberOf(readRowField(row, "otherMask")), memberCount: numberOf(readRowField(row, "memberCount")),
      createDateTimeMs: filetimeToUnixMs(unwrapLong(readRowField(row, "createDateTime"))), expiryDateTimeMs: expiry,
      grade: gradeValue === null || gradeValue === undefined ? null : numberOf(gradeValue),
    });
  }
  return out;
}

/** recruitmentUtil.BuildMask: the hours from..to (wrapping past midnight where from > to) as bits. */
export function buildHourMask(from: number, to: number): number {
  let mask = 0;
  for (let i = 0; i < 24; i++) {
    if (from > to ? i < to || i >= from : i >= from && i < to) mask += 2 ** i;
  }
  return mask;
}

/** A set of recruitment types as a mask (each type's bit 2 ** typeID; up to bit 44, past 32-bit operators). */
export function typesMask(typeIDs: Iterable<number>): number {
  let mask = 0;
  for (const id of new Set(typeIDs)) mask += 2 ** id;
  return mask;
}

// corp_ui_recruitment_const
export const AREA_OF_OPERATIONS_GROUPID = 6;
export const PLAYSTYLE_GROUPID = 11;
export const LANGUAGE_GROUPID = 10;
export const PLAYSTYLE_GROUPS = [
  { label: "UI/Corporations/CorporationWindow/Recruitment/PVE", typeIDs: [28, 25, 2, 43, 35, 36, 44, 40, 41] },
  { label: "UI/Corporations/CorporationWindow/Recruitment/PVP", typeIDs: [26, 31, 16, 17, 18, 19, 20, 21] },
  { label: "UI/Corporations/CorporationWindow/Recruitment/Trade", typeIDs: [24, 29, 13, 22] },
] as const;
export const NEWPILOTFRIENDLY_TYPEID = 34, NEWPILOTFOCUSED_TYPEID = 23, ROLEPLAY_TYPEID = 0;
export const EXPLORATION_TYPEID = 28, MISSIONRUNNING_TYPEID = 25;
export const HIGHSEC_TYPEID = 12, LOWSEC_TYPEID = 37, NULLSEC_TYPEID = 38, WORMHOLESPACE_TYPEID = 39;
export const ENGLISH_TYPEID = 7;
/** A new ad as UpdateAdvert sends it. */
export interface RecruitmentAdForm {
  readonly days: number;
  readonly typeMask: number;
  readonly langMask: number;
  readonly description: string;
  readonly recruiters: readonly number[];
  readonly title: string;
  readonly hourMask1: number;
  readonly minSP: number;
  readonly otherMask: number;
}

/** The type numbers a mask holds (bits 0 to 62). */
export function typesInMask(mask: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < 63; i++) if (Math.floor(mask / 2 ** i) % 2 === 1) out.push(i);
  return out;
}

export const MAX_SELECTED_TYPES = 4, MAX_SELECTED_AREAS = 2, MAX_HOURS = 8;
export const AREA_TYPEIDS = [12, 37, 38, 39] as const;
/** COMBINED_GROUP_BY_TYPEID: each play style's group (0 PVE, 1 PVP, 2 Trade). */
export function combinedGroupOf(typeID: number): number | null {
  const at = PLAYSTYLE_GROUPS.findIndex((g) => (g.typeIDs as readonly number[]).includes(typeID));
  return at < 0 ? null : at;
}

/** UpdateAdvert's refusals, in its order (recruitmentUtil IsNumPlaystyleMaskValid, IsOnlyOnePlaystyleType,
 * IsNumAreaOfOperationsValid, IsTimezoneValid); null where the ad may be made. */
export function recruitmentAdRefusal(form: RecruitmentAdForm): { dialog: string; values: Record<string, number>; fallback: string } | null {
  if (!form.title.trim()) return { dialog: "CustomInfo", values: {}, fallback: "Please enter a title for your ad." };
  const types = typesInMask(form.typeMask);
  const playStyles = types.filter((id) => combinedGroupOf(id) !== null);
  if (playStyles.length > MAX_SELECTED_TYPES) return { dialog: "CorpRecruitmentNumPlaystyleMaskInvalid", values: { numOptions: MAX_SELECTED_TYPES }, fallback: `Select at most ${MAX_SELECTED_TYPES} play styles.` };
  if (new Set(playStyles.map(combinedGroupOf)).size > 1) return { dialog: "CorpRecruitmentTooManyPlaystyleTypesSelected", values: {}, fallback: "Select play styles of one kind only." };
  if (types.filter((id) => (AREA_TYPEIDS as readonly number[]).includes(id)).length > MAX_SELECTED_AREAS) return { dialog: "CorpRecruitmentTooManyAreasSelected", values: { numOptions: MAX_SELECTED_AREAS }, fallback: `Select at most ${MAX_SELECTED_AREAS} areas.` };
  if (typesInMask(form.hourMask1).length > MAX_HOURS) return { dialog: "CorpRecruitmentTooManyHoursSelected", values: { numHours: MAX_HOURS }, fallback: `Select at most ${MAX_HOURS} hours.` };
  return null;
}

/** const.corporationAdvertisementFlatFee, DailyRate, corporationMaxRecruitmentAdDuration, corporationMaxRecruitmentAds,
 * corporationRecMaxTitleLength, corporationRecMaxMessageLength. */
export const AD_FLAT_FEE = 500000, AD_DAILY_RATE = 250000, AD_MAX_DAYS = 28, MAX_CORP_ADS = 3, AD_MAX_TITLE = 40, AD_MAX_MESSAGE = 1000;

/** CorporationSize's increments; the last, infinity, const.corpMaxSize. */
export const CORP_SIZES = [0, 10, 50, 100, 200, 500, 1000, 12600] as const;
