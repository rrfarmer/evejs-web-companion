// The retail client's own words, filled in.
//
// The BFF hands over the client's text for a label as a TEMPLATE (POST
// /api/words; src/clientData/clientWords.js): the text with its parameters
// still in it, written the way the client's localisation writes them
// (localization/parser.py, _Tokenize):
//
//   {name}                                  a value as it is
//   {[type]name}                            a value of a kind
//   {[type]name.property}                   something about it
//   {[type]name.property -> "a", "b"}       one of several words, chosen by it
//   {[type]name, modifier, key=value}       with modifiers and settings
//
// The kinds are the client's: generic, character, npcOrganization, item,
// location, characterlist, messageid, datetime, formattedtime, timeinterval,
// numeric. The modifiers: capitalize, uppercase, lowercase, titlecase,
// linkify, useGrouping.
//
// ⚠ THE CLIENT RENDERS THESE IN A COMPILED MODULE (eveLocalization) that has
// not been read. What each kind and property comes out as below is this
// client's reading of the game, not a copy of that module: an item, a
// character, an organisation and a place by name; a number plainly, grouped
// only when the template says useGrouping; a time in the game's
// YYYY.MM.DD HH:MM. What it cannot do is said where it is not done.

import type { NameKind, NameRef } from "../store/names.ts";
import type { JsonValue } from "./wire.ts";
import { DISTANCE_LABELS } from "../space/overview.ts";

export interface TemplateToken {
  /** The whole tag as written, braces and all. */
  readonly raw: string;
  /** The kind, lower case; "generic" when the tag names none. */
  readonly type: string;
  readonly name: string;
  readonly property: string | null;
  /** The words to choose among, for a conditional. */
  readonly conditionals: readonly string[];
  readonly modifiers: readonly string[];
  readonly settings: Readonly<Record<string, string>>;
}

export interface FormatContext {
  /** A name from the page's cache, or a plain stand-in while it is not there. */
  readonly nameOf: (kind: NameKind, id: number) => string;
  /** The character the page is flying: the client's `player` in every message. */
  readonly playerID?: number | null;
  /**
   * An interval of the game's time written out in the client's own words (timeInterval.ts), for a tag
   * that asks for an interval's written form. `from` and `to` are the tag's settings, null where it
   * names none. Without it, or when it answers null, such a tag is written in this page's short form.
   */
  readonly writeInterval?: (ticks: bigint, from: string | null, to: string | null) => string | null;
  /** The same for a tag that asks for an interval's short written form ("6d 8h 57m"). */
  readonly writeShortInterval?: (ticks: bigint, from: string | null, to: string | null) => string | null;
  /** The same for an interval's written form in two units at most ("3 hours and 52 minutes"). */
  readonly writeIntervalTwoPart?: (ticks: bigint, from: string | null, to: string | null) => string | null;
  /** The same for an interval's clock form ("02:15:07"), which a tag naming no form asks for too. */
  readonly writeIntervalShortForm?: (ticks: bigint, from: string | null, to: string | null) => string | null;
  /**
   * A distance in metres written as the client writes one (NumericPropertyHandler._GetDistance: FmtDist(value,
   * maxdemicals=decimalPlaces, 3 where the tag says none)), for a numeric tag that asks for its distance. Without
   * it such a tag is written as a plain number.
   */
  readonly writeDistance?: (meters: number, decimalPlaces: number) => string;
  /**
   * An amount of ISK written as the client writes one (NumericPropertyHandler._GetIsk: FmtISK(value,
   * showFractionsAlways=decimalPlaces > 0), 2 places where the tag says none), for a numeric tag that asks for its
   * isk. Null, or without it, such a tag is written as a plain number.
   */
  readonly writeIsk?: (amount: number, decimalPlaces: number) => string | null;
}

/** A message's arguments by name: what the server sent with the label, and what the client adds. */
export type TemplateArguments = Readonly<Record<string, JsonValue | undefined>>;

const TAG = /\{(?!\{)[^{}]*\}/g;
const PIECES = /(""|"[^"]+"|->|[:.,=[\]])/;

/** One tag, read as the client's tokenizer reads it; null when it is not a tag the client would accept. */
export function parseTag(raw: string): TemplateToken | null {
  const tokens = raw.slice(1, -1).split(PIECES).map((token) => token.trim()).filter((token) => token !== "");
  let type = "generic";
  let name = tokens.shift();
  if (name === "[") {
    type = (tokens.shift() ?? "").toLowerCase();
    if (tokens.shift() !== "]") {
      return null;
    }
    name = tokens.shift();
  }
  if (name === undefined || !/^[A-Za-z_]\w*$/.test(name) || type === "") {
    return null;
  }
  let property: string | null = null;
  const conditionals: string[] = [];
  const modifiers: string[] = [];
  const settings: Record<string, string> = {};
  let next = tokens.shift();
  if (next === ".") {
    const named = tokens.shift();
    if (named === undefined || !/^[A-Za-z_]\w*$/.test(named)) {
      return null;
    }
    property = named;
    next = tokens.shift();
  }
  const unquoted = (token: string | undefined): string | null =>
    token !== undefined && /^"[^"]*"$/.test(token) ? token.slice(1, -1) : null;
  if (next === "->") {
    for (;;) {
      const value = unquoted(tokens.shift());
      if (value === null) {
        return null;
      }
      conditionals.push(value);
      const separator = tokens.shift();
      if (separator === undefined) {
        break;
      }
      if (separator !== ",") {
        return null;
      }
    }
  } else if (next === ",") {
    while (tokens.length > 0) {
      const word = tokens.shift() as string;
      const after = tokens.shift();
      if (after === undefined || after === ",") {
        modifiers.push(word);
      } else if (after === "=") {
        const value = tokens.shift();
        if (value === undefined) {
          return null;
        }
        settings[word] = unquoted(value) ?? value;
        const separator = tokens.shift();
        if (separator !== undefined && separator !== ",") {
          return null;
        }
      } else {
        return null;
      }
    }
  } else if (next !== undefined) {
    return null;
  }
  return { raw, type, name, property, conditionals, modifiers, settings };
}

/** A template as text and tags, in order. A brace run the client would not accept stays text. */
export function parseTemplate(template: string): Array<string | TemplateToken> {
  const parts: Array<string | TemplateToken> = [];
  let from = 0;
  for (const match of template.matchAll(TAG)) {
    const at = match.index ?? 0;
    if (at > from) {
      parts.push(template.slice(from, at));
    }
    parts.push(parseTag(match[0]) ?? match[0]);
    from = at + match[0].length;
  }
  if (from < template.length) {
    parts.push(template.slice(from));
  }
  return parts;
}

/** A Python int as the wire gives one ({type: "long", value: its digits}). */
function isLongValue(value: JsonValue | undefined): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, JsonValue>;
  return record.type === "long" && typeof record.value === "string" && /^-?\d+$/.test(record.value);
}

/** A number the server sent, however the bridge spelled it; null when it is not one. */
function numberOf(value: JsonValue | undefined): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, JsonValue>;
    if (record.type === "long" && typeof record.value === "string" && /^-?\d+$/.test(record.value)) {
      return Number(record.value);
    }
  }
  return null;
}

const idOf = (value: JsonValue | undefined): number | null => {
  const number = numberOf(value);
  return number !== null && Number.isSafeInteger(number) && number > 0 ? number : null;
};

/** Which of the page's name kinds a place's ID belongs to, by the game's ID ranges. */
export function locationKind(id: number): NameKind {
  if (id >= 10_000_000 && id < 20_000_000) return "region";
  if (id >= 20_000_000 && id < 30_000_000) return "constellation";
  if (id >= 30_000_000 && id < 40_000_000) return "system";
  if (id >= 60_000_000 && id < 64_000_000) return "station";
  return "structure";
}

/** The name kind a tag's value is looked up under, or null when the tag is not a name. */
function nameKindOf(token: TemplateToken, id: number): NameKind | null {
  switch (token.type) {
    case "item": return "type";
    case "character":
    case "npcorganization": return "owner";
    case "location": return locationKind(id);
    default: return null;
  }
}

const two = (value: number): string => String(value).padStart(2, "0");
/** 100 ns ticks since 1601 (the server's clock) to milliseconds since 1970. */
const filetimeToMs = (filetime: number): number => filetime / 10_000 - 11_644_473_600_000;

function formatDateTime(filetime: number, settings: Readonly<Record<string, string>>): string {
  const when = new Date(filetimeToMs(filetime));
  if (Number.isNaN(when.getTime())) {
    return "";
  }
  const date = `${when.getUTCFullYear()}.${two(when.getUTCMonth() + 1)}.${two(when.getUTCDate())}`;
  // dateTimeFormatters.FormatDateTime (11 to 18): a full, long or medium time has its seconds, a short one not.
  const seconds = settings.time === "medium" || settings.time === "long" || settings.time === "full" ? `:${two(when.getUTCSeconds())}` : "";
  const time = `${two(when.getUTCHours())}:${two(when.getUTCMinutes())}${seconds}`;
  if (settings.date === "none") return time;
  if (settings.time === "none") return date;
  return `${date} ${time}`;
}

/** time.strftime(format) of the moment, in UTC (the server's clock): the year, month, day, hours, minutes and seconds. */
function formatStrftime(filetime: number, format: string): string {
  const when = new Date(filetimeToMs(filetime));
  if (Number.isNaN(when.getTime())) {
    return "";
  }
  const parts: Readonly<Record<string, string>> = {
    Y: String(when.getUTCFullYear()),
    y: two(when.getUTCFullYear() % 100),
    m: two(when.getUTCMonth() + 1),
    d: two(when.getUTCDate()),
    H: two(when.getUTCHours()),
    M: two(when.getUTCMinutes()),
    S: two(when.getUTCSeconds()),
    "%": "%",
  };
  return format.replace(/%(.)/g, (code: string, letter: string) => parts[letter] ?? code);
}

function formatInterval(ticks: number): string {
  let seconds = Math.max(0, Math.floor(ticks / 10_000_000));
  const parts: string[] = [];
  for (const [unit, size] of [["d", 86_400], ["h", 3_600], ["m", 60]] as const) {
    if (seconds >= size) {
      parts.push(`${Math.floor(seconds / size)}${unit}`);
      seconds %= size;
    }
  }
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds}s`);
  }
  return parts.join(" ");
}

/**
 * eveLocalization.FormatNumeric (the client's _evelocalization.dll, measured through its python27.dll): a float with
 * decimalPlaces written to that many places (5.0 is "5.0", 0.25 "0.3"), an int as itself whatever the places (5 is
 * "5"). A JavaScript number cannot say which it was, so it is taken for a float; a value given as a long (the wire's
 * {type: "long"}, a Python int) is written as an int (`whole`).
 */
function formatNumber(value: number, token: TemplateToken, whole = false): string {
  const places = whole ? null : /^\d+$/.test(token.settings.decimalPlaces ?? "") ? Number(token.settings.decimalPlaces) : null;
  if (token.modifiers.includes("useGrouping")) {
    return value.toLocaleString("en-US", places === null ? {} : { minimumFractionDigits: places, maximumFractionDigits: places });
  }
  const text = places === null ? String(value) : value.toFixed(places);
  // leadingZeroes: the whole part written to at least that many digits (format.py 122 to 124: an hour as "05").
  const zeroes = /^\d+$/.test(token.settings.leadingZeroes ?? "") ? Number(token.settings.leadingZeroes) : 0;
  const [sign, digits] = text.startsWith("-") ? ["-", text.slice(1)] : ["", text];
  const [wholePart = "", fraction] = digits.split(".");
  return zeroes > wholePart.length ? `${sign}${wholePart.padStart(zeroes, "0")}${fraction === undefined ? "" : `.${fraction}`}` : text;
}

function applyModifiers(text: string, modifiers: readonly string[]): string {
  let out = text;
  for (const modifier of modifiers) {
    if (modifier === "capitalize") out = out.charAt(0).toUpperCase() + out.slice(1);
    else if (modifier === "uppercase") out = out.toUpperCase();
    else if (modifier === "lowercase") out = out.toLowerCase();
    else if (modifier === "titlecase") out = out.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
  }
  return out;
}

const withArticle = (name: string): string => `${/^[aeiou]/i.test(name) ? "an" : "a"} ${name}`;

function renderToken(token: TemplateToken, args: TemplateArguments, context: FormatContext): string {
  const given = args[token.name] ?? (token.name === "player" ? context.playerID ?? undefined : undefined);
  if (given === undefined || given === null) {
    // The client logs a missing argument and shows nothing for it.
    return "";
  }
  if (token.conditionals.length > 0) {
    // A word chosen by a count ("item", "items"): one takes the first, any other the last. A word chosen by
    // gender is not chosen here (the page does not know anyone's): the first is taken.
    const count = token.property === "quantity" || token.type === "numeric" ? numberOf(given) : null;
    return count === null || count === 1 ? token.conditionals[0] ?? "" : token.conditionals[token.conditionals.length - 1] ?? "";
  }
  let text: string;
  switch (token.type) {
    case "numeric": {
      // A string given to a numeric tag is written as it is (the client's _evelocalization GetMessageByID, measured
      // through its python27.dll: Legend's {[numeric]legend, decimalPlaces=0} with "0.00 ISK" gave "0.00 ISK", with
      // 10.0 "10") - warReportKillGroups passes FmtISK's text. (A string of digits is the page's own way of giving a
      // number, read below.)
      if (typeof given === "string" && numberOf(given) === null) { text = given; break; }
      const value = numberOf(given);
      const places = (fallback: number): number => {
        const said = Number(token.settings.decimalPlaces ?? fallback);
        return Number.isInteger(said) && said >= 0 ? said : fallback;
      };
      const isk = value !== null && token.property === "isk" && context.writeIsk ? context.writeIsk(value, places(2)) : null;
      text = value === null
        ? ""
        : token.property === "distance" && context.writeDistance
          ? context.writeDistance(value, places(3))
          : isk ?? formatNumber(value, token, isLongValue(given));
      break;
    }
    case "item":
    case "character":
    case "npcorganization":
    case "location": {
      const id = idOf(given);
      // A bare npcOrganization (no property) is its number: the install's English texts have it nine times, every one
      // inside a <url=showinfo:...//{[npcOrganization]ownerID}> link whose words are its .name (529886, 530146).
      if (token.type === "npcorganization" && !token.property) { text = id === null ? "" : String(id); break; }
      const kind = id === null ? null : nameKindOf(token, id);
      const name = id === null || kind === null ? "" : context.nameOf(kind, id);
      text = token.property === "nameWithArticle" && name !== "" ? withArticle(name) : name;
      break;
    }
    case "datetime":
    case "formattedtime": {
      const value = numberOf(given);
      // A formattedtime tag's format is strftime's (localization/parser.py 227 to 228: its one setting; the labels FmtDate
      // words a moment with, "%Y.%m.%d" alone for a date, "%H:%M" alone for a time).
      const format = token.type === "formattedtime" ? token.settings.format : undefined;
      text = value === null ? "" : format !== undefined ? formatStrftime(value, format) : formatDateTime(value, token.settings);
      break;
    }
    case "timeinterval": {
      const value = numberOf(given);
      // timeIntervalPropertyHandler: writtenForm is FormatTimeIntervalWritten, writtenFormTwoPart the same in two
      // units at most, shortWrittenForm is FormatTimeIntervalShortWritten, and shortForm, which is also what a tag with
      // no form gets (_GetDefault), FormatTimeIntervalShort; from and to as the tag sets them.
      const writer = token.property === "writtenForm" ? context.writeInterval
        : token.property === "shortWrittenForm" ? context.writeShortInterval
        : token.property === "writtenFormTwoPart" ? context.writeIntervalTwoPart
        : token.property === "shortForm" || token.property === null ? context.writeIntervalShortForm
        : undefined;
      const written = value !== null && writer ? writer(BigInt(Math.trunc(value)), token.settings.from ?? null, token.settings.to ?? null) : null;
      text = value === null ? "" : written ?? formatInterval(value);
      break;
    }
    case "generic": {
      const value = numberOf(given);
      text = typeof given === "string" ? given : value === null ? "" : String(value);
      break;
    }
    default:
      // characterlist and messageid: a list of names and a message inside a message are not done.
      text = "";
  }
  return applyModifiers(text, token.modifiers);
}

/** A template with its tags filled from `args`. Tags the client would not accept are left as written. */
export function formatTemplate(template: string, args: TemplateArguments, context: FormatContext): string {
  return parseTemplate(template)
    .map((part) => (typeof part === "string" ? part : renderToken(part, args, context)))
    .join("");
}

// ── a dialog's typed values ──────────────────────────────────────────────────
//
// A dialog's parameters may be TYPED: a tuple (code, value[, value2]) that the
// client turns into text before it fills the dialog's words (cfg.__prepdict
// and FormatConvert, carbon/common/script/sys/cfg.py 324 and 370; what each
// code means, eveCfg.py 165 on). The codes done here:
//
//     2  UE_OWNERID            an owner's name
//     3  UE_LOCID              a place's name
//     4  UE_TYPEID             a type's name
//    24  UE_TYPEIDANDQUANTITY  (24, typeID, quantity): the client's label
//                              UI/Common/QuantityAndItem, filled with both
//   103  UE_LIST               (103, [entries], separator): each entry
//                              converted, and joined by the separator, or by
//                              the client's list delimiter when there is none
//
//     5  UE_TYPEID2            a type's description: not done (the page's tables have no descriptions), nothing
//     6  UE_BPTYPEID           a blueprint's name (cfg.blueprints' blueprintTypeID: the type itself)
//     7  UE_GROUPID            a group's name;  8 UE_GROUPID2, nothing
//     9  UE_CATID              a category's name;  10 UE_CATID2, nothing
//    14  UE_DATETIME           FmtDate(value): its label for 'll'; 15 UE_DATE 'ln', 16 UE_TIME 'nl', 17 UE_TIMESHRT
//                              'ns' (carbon format.py FmtDate 71 to 114: below the year 1800 a length of time,
//                              written out, short for 'ns')
//    18  UE_AMT                FmtAmt(value): the whole number, grouped
//    19, 20, 28  UE_AMT2, UE_AMT3, UE_ISK   FmtISK(value): ISK with its fractions (UI/Util/FmtIsk)
//    21  UE_DIST               FmtDist(value), two places at most
//    22  UE_MSGARGS            a dialog's text by its name, with its own parameters (cfg.GetMessage(name, args))
//    25  UE_OWNERIDNICK        an owner's name to its first space
//    29  UE_TYPEIDL            a list of types' names (UE_LIST of UE_TYPEID)
//    30  UE_AUR                FmtAUR(value): Aurum with no fractions (UI/Util/FmtAurNoDecimal), rounded
//   102  UE_MESSAGEID          a message by its number, with its own parameters (cfg._GetLocalizationByID)
//
// Any other code is what the client makes of one it has no format for: "INVALID FORMAT TYPE" with the code and the
// value (FormatConvert, 377 to 380).
//
// The bridge keeps a tuple as an array and a list as {type: "list", items},
// and the client tells them apart: FormatConvert reads a tuple given as a
// VALUE as one more typed value, to be converted first. So a list's entries
// have to arrive in a list. (A tuple of entries, which the client cannot word
// at all, is read here as the list it was meant to be.)

/** The label the client words a quantity of an item with (eveCfg.__FormatTypeIDAndQuantity). */
export const QUANTITY_AND_ITEM = "UI/Common/QuantityAndItem";
/** The label of what the client joins a list with when it is given no separator (FormatGenericList). */
export const LIST_DELIMITER = "UI/Common/Formatting/ListGenericDelimiter";

const UE_OWNERID = 2;
const UE_LOCID = 3;
const UE_TYPEID = 4;
const UE_TYPEIDANDQUANTITY = 24;
const UE_LIST = 103;
/** carbon/common/lib/const.py 273: one of the client's labels, worded with its own arguments (cfg.py 125, _GetLocalization). */
const UE_LOC = 101;
/** eveexceptions/const.py and carbon/common/lib/const.py 268 to 274: the rest of the client's codes. */
const UE_TYPEID2 = 5;
const UE_BPTYPEID = 6;
const UE_GROUPID = 7;
const UE_GROUPID2 = 8;
const UE_CATID = 9;
const UE_CATID2 = 10;
const UE_DATETIME = 14;
const UE_DATE = 15;
const UE_TIME = 16;
const UE_TIMESHRT = 17;
const UE_AMT = 18;
const UE_AMT2 = 19;
const UE_AMT3 = 20;
const UE_DIST = 21;
const UE_MSGARGS = 22;
const UE_OWNERIDNICK = 25;
const UE_ISK = 28;
const UE_TYPEIDL = 29;
const UE_AUR = 30;
const UE_MESSAGEID = 102;

/** cfg.py 120 to 123: the date codes' FmtDate formats. */
const DATE_FORMAT_BY_CODE: Readonly<Record<number, string>> = { [UE_DATETIME]: "ll", [UE_DATE]: "ln", [UE_TIME]: "nl", [UE_TIMESHRT]: "ns" };
/** The client's clock: 100 ns ticks. appConst.YEAR365 * 199, below which FmtDate takes the value for a length of time. */
export const YEAR_1800_TICKS = 365n * 24n * 3600n * 10_000_000n * 199n;
/** carbon's format.FmtDate (71 to 114): the label for each format, by its two letters. */
export const DATE_LABELS: Readonly<Record<string, string>> = {
  ll: "/Carbon/UI/Common/DateTime/SimpleDateUTC", sl: "/Carbon/UI/Common/DateTime/SimpleDateUTC", xs: "/Carbon/UI/Common/DateTime/SimpleDateUTC",
  ls: "/Carbon/UI/Common/DateTime/DateLongShort", ss: "/Carbon/UI/Common/DateTime/DateLongShort",
  ln: "/Carbon/UI/Common/DateTime/DateLongNone", sn: "/Carbon/UI/Common/DateTime/DateLongNone", xn: "/Carbon/UI/Common/DateTime/DateLongNone",
  nl: "/Carbon/UI/Common/DateTime/Time",
  ns: "/Carbon/UI/Common/DateTime/HoursAndMinutes",
  xl: "/Carbon/UI/Common/DateTime/SimpleDateUTC",
  el: "/Carbon/UI/Common/DateTime/DateExtendedLong",
  es: "/Carbon/UI/Common/DateTime/DateExtendedShort",
  en: "/Carbon/UI/Common/DateTime/DateExtendedNone",
};
/** eveFormat.CURRENCY_FORMAT_TRANSLATIONS: ISK with fractions, and Aurum without. */
export const ISK_LABEL = "UI/Util/FmtIsk";
export const AUR_NO_DECIMAL_LABEL = "UI/Util/FmtAurNoDecimal";
/** carbon's format.FmtDist: its three units' labels. */
const DIST_LABELS: readonly string[] = Object.values(DISTANCE_LABELS);
/** Where the words store keeps a dialog's text (questions.ts wordsKey) and a message's, by its number. */
const dialogBodyKey = (name: string): string => `dialog:${name}/body`;
const messageKey = (messageID: number): string => `#${messageID}`;

/** A value of the client's clock, as the bridge carries one (a number, or {type: "long", value}); null for anything else. */
function ticksOf(value: JsonValue | undefined): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const inner = (value as { value?: unknown }).value;
    if (typeof inner === "string" && /^-?\d+$/.test(inner)) return BigInt(inner);
    if (typeof inner === "number" && Number.isSafeInteger(inner)) return BigInt(inner);
  }
  return null;
}

/**
 * FmtDate(value, fmt) (carbon format.py 71 to 114): a moment as its format's label words it; a value below the year
 * 1800 as a length of time written out from days to seconds (short for a format whose second letter is 's'); a
 * negative one as its size. Nothing where the words are not to hand.
 */
function dateWords(value: JsonValue | undefined, fmt: string, context: TypedContext): string {
  const ticks = ticksOf(value);
  if (ticks === null) return "";
  const size = ticks < 0n ? -ticks : ticks;
  if (size < YEAR_1800_TICKS) {
    const write = fmt[1] === "s" ? context.writeShortInterval : context.writeInterval;
    return write?.(size, "day", "second") ?? "";
  }
  const template = context.templates?.[DATE_LABELS[fmt] ?? ""];
  return typeof template === "string" ? formatTemplate(template, { datetime: { type: "long", value: size.toString() } }, context) : "";
}

/** What Python's %s makes of a value, for the client's words for a code it has no format for. */
function pythonText(value: JsonValue | undefined): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "True" : "False";
  const ticks = ticksOf(value);
  return ticks !== null ? ticks.toString() : JSON.stringify(value);
}

/** A dict as the bridge carries one ({type: "dict", entries}), as a label's arguments; anything else gives none. */
function dictArguments(value: JsonValue | undefined): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, JsonValue>;
    if (record.type === "dict" && Array.isArray(record.entries)) {
      for (const entry of record.entries) {
        if (Array.isArray(entry) && typeof entry[0] === "string") out[entry[0]] = entry[1] ?? null;
      }
    }
  }
  return out;
}

export interface TypedContext extends FormatContext {
  /** The client's templates by label, for the two the conversion words with. */
  readonly templates?: Readonly<Record<string, string | null | undefined>>;
}

/** A typed value given as a value: a tuple that starts with a code. */
const nestedTyped = (value: JsonValue | undefined): value is JsonValue[] => Array.isArray(value) && typeof value[0] === "number";

/** A list's entries: a list as the bridge spells one, or a tuple of entries. */
function listEntries(value: JsonValue | undefined): readonly JsonValue[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, JsonValue>;
    if (record.type === "list" && Array.isArray(record.items)) {
      return record.items;
    }
  }
  return [];
}

const third = (tuple: readonly JsonValue[]): JsonValue => (tuple.length >= 3 ? tuple[2] ?? null : null);

/** One typed value as the text the client makes of it; nothing for a code that is not done. */
export function convertTyped(code: JsonValue | undefined, value: JsonValue | undefined, value2: JsonValue | undefined, context: TypedContext): string {
  let inner: JsonValue | undefined = value;
  let second: JsonValue | undefined = value2;
  if (nestedTyped(inner)) {
    // The client converts it first, and its third member (or nothing) takes value2's place.
    second = third(inner);
    inner = convertTyped(inner[0], inner[1], second, context);
  }
  switch (code) {
    case UE_OWNERID: {
      const id = idOf(inner);
      return id === null ? "" : context.nameOf("owner", id);
    }
    case UE_LOCID: {
      const id = idOf(inner);
      return id === null ? "" : context.nameOf(locationKind(id), id);
    }
    case UE_TYPEID: {
      const id = idOf(inner);
      return id === null ? "" : context.nameOf("type", id);
    }
    case UE_TYPEIDANDQUANTITY: {
      const typeID = idOf(inner);
      if (typeID === null) {
        return "";
      }
      const quantity = numberOf(second);
      const template = context.templates?.[QUANTITY_AND_ITEM];
      if (typeof template === "string") {
        return formatTemplate(template, { quantity, item: typeID }, context);
      }
      const name = context.nameOf("type", typeID);
      return quantity === null ? name : `${quantity.toLocaleString("en-US")} × ${name}`;
    }
    case UE_LIST: {
      const texts = listEntries(inner).map((entry) => (Array.isArray(entry) ? convertTyped(entry[0], entry[1], third(entry), context) : ""));
      const separator = typeof second === "string" ? second : context.templates?.[LIST_DELIMITER] ?? ", ";
      return texts.join(separator);
    }
    case UE_LOC: {
      // cfg._GetLocalization (264 to 284): the label's own text, filled with its arguments, each typed one worded first.
      const template = typeof inner === "string" ? context.templates?.[inner] : undefined;
      return typeof template === "string" ? formatTemplate(template, prepareArguments(dictArguments(second), context), context) : "";
    }
    case UE_MESSAGEID: {
      // cfg._GetLocalizationByID (287 to 309): the message by its number, filled the same way.
      const id = idOf(inner);
      const template = id === null ? undefined : context.templates?.[messageKey(id)];
      return typeof template === "string" ? formatTemplate(template, prepareArguments(dictArguments(second), context), context) : "";
    }
    case UE_MSGARGS: {
      // cfg.GetMessage(value[0], value[1]).text: a dialog's text by its name, with its parameters prepared. Given as a
      // list (a tuple the client would have taken for one more typed value, and worded as nonsense).
      const parts = listEntries(value !== undefined && !Array.isArray(value) ? value : undefined);
      const name = typeof parts[0] === "string" ? parts[0] : null;
      const template = name === null ? undefined : context.templates?.[dialogBodyKey(name)];
      return typeof template === "string" ? formatTemplate(template, prepareArguments(dictArguments(parts[1]), context), context) : "";
    }
    case UE_OWNERIDNICK: {
      const id = idOf(inner);
      return id === null ? "" : context.nameOf("owner", id).split(" ")[0] ?? "";
    }
    case UE_TYPEID2:
      return "";
    case UE_TYPEIDL: {
      // FormatConvert(UE_LIST, [(UE_TYPEID, x) for x in value], value2).
      const texts = listEntries(inner).map((entry) => {
        const id = idOf(entry);
        return id === null ? "" : context.nameOf("type", id);
      });
      const separator = typeof second === "string" ? second : context.templates?.[LIST_DELIMITER] ?? ", ";
      return texts.join(separator);
    }
    case UE_BPTYPEID: {
      const id = idOf(inner);
      return id === null ? "" : context.nameOf("type", id);
    }
    case UE_GROUPID: {
      const id = idOf(inner);
      return id === null ? "" : context.nameOf("group", id);
    }
    case UE_CATID: {
      const id = idOf(inner);
      return id === null ? "" : context.nameOf("category", id);
    }
    case UE_GROUPID2:
    case UE_CATID2:
      return "";
    case UE_DATETIME:
    case UE_DATE:
    case UE_TIME:
    case UE_TIMESHRT:
      return dateWords(inner, DATE_FORMAT_BY_CODE[code]!, context);
    case UE_AMT: {
      // FmtAmt(value): long(amount), grouped, no places.
      const amount = numberOf(inner);
      return amount === null ? "" : Math.trunc(amount).toLocaleString("en-US");
    }
    case UE_AMT2:
    case UE_AMT3:
    case UE_ISK: {
      // FmtISK(value): FmtCurrency(value, showFractionsAlways=1), UI/Util/FmtIsk.
      const amount = numberOf(inner);
      if (amount === null) return "";
      const written = context.writeIsk?.(amount, 2);
      if (typeof written === "string") return written;
      const template = context.templates?.[ISK_LABEL];
      return typeof template === "string" ? formatTemplate(template, { amount }, context) : amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    case UE_AUR: {
      // FmtAUR(value): FmtCurrency(value, 0, Aurum), the amount rounded, UI/Util/FmtAurNoDecimal.
      const amount = numberOf(inner);
      if (amount === null) return "";
      const rounded = Math.sign(amount) * Math.round(Math.abs(amount));
      const template = context.templates?.[AUR_NO_DECIMAL_LABEL];
      return typeof template === "string" ? formatTemplate(template, { amount: rounded }, context) : rounded.toLocaleString("en-US");
    }
    case UE_DIST: {
      // FmtDist(value): two places at most.
      const metres = numberOf(inner);
      if (metres === null) return "";
      return context.writeDistance?.(metres, 2) ?? `${Math.round(metres).toLocaleString("en-US")} m`;
    }
    default:
      // A tuple with no code at all is nothing; any other code is what the client says of one it has no format for.
      return code === undefined ? "" : `INVALID FORMAT TYPE ${pythonText(code)}, value is ${pythonText(inner)}`;
  }
}

/** A dialog's arguments as the client prepares them: every tuple among them turned to its text. */
export function prepareArguments(args: TemplateArguments, context: TypedContext): TemplateArguments {
  const out: Record<string, JsonValue | undefined> = {};
  for (const [name, value] of Object.entries(args)) {
    out[name] = Array.isArray(value) ? convertTyped(value[0], value[1], third(value), context) : value;
  }
  return out;
}

/** What a typed value needs before it can be worded: the names, and the client's labels. */
function typedNeeds(tuple: readonly JsonValue[], refs: NameRef[], labels: string[], templates?: TypedContext["templates"]): void {
  const [code, value] = tuple;
  if (nestedTyped(value)) {
    typedNeeds(value, refs, labels, templates);
    return;
  }
  const id = idOf(value);
  if (code === UE_LOC && typeof value === "string") {
    labels.push(value);
    const args = dictArguments(third(tuple));
    for (const each of Object.values(args)) {
      if (Array.isArray(each)) typedNeeds(each, refs, labels, templates);
    }
    const template = templates?.[value];
    if (typeof template === "string") refs.push(...templateNameRefs(template, args));
  } else if (code === UE_LIST) {
    for (const entry of listEntries(value)) {
      if (Array.isArray(entry)) {
        typedNeeds(entry, refs, labels, templates);
      }
    }
    if (typeof third(tuple) !== "string") {
      labels.push(LIST_DELIMITER);
    }
  } else if (code === UE_TYPEIDANDQUANTITY) {
    labels.push(QUANTITY_AND_ITEM);
    if (id !== null) refs.push({ kind: "type", id });
  } else if (id !== null && (code === UE_TYPEID || code === UE_BPTYPEID)) {
    refs.push({ kind: "type", id });
  } else if (id !== null && (code === UE_OWNERID || code === UE_OWNERIDNICK)) {
    refs.push({ kind: "owner", id });
  } else if (id !== null && code === UE_LOCID) {
    refs.push({ kind: locationKind(id), id });
  } else if (id !== null && code === UE_GROUPID) {
    refs.push({ kind: "group", id });
  } else if (id !== null && code === UE_CATID) {
    refs.push({ kind: "category", id });
  } else if (code === UE_TYPEIDL) {
    for (const entry of listEntries(value)) {
      const typeID = idOf(entry);
      if (typeID !== null) refs.push({ kind: "type", id: typeID });
    }
    if (typeof third(tuple) !== "string") labels.push(LIST_DELIMITER);
  } else if (typeof code === "number" && code in DATE_FORMAT_BY_CODE) {
    labels.push(DATE_LABELS[DATE_FORMAT_BY_CODE[code]!]!);
  } else if (code === UE_AMT2 || code === UE_AMT3 || code === UE_ISK) {
    labels.push(ISK_LABEL);
  } else if (code === UE_AUR) {
    labels.push(AUR_NO_DECIMAL_LABEL);
  } else if (code === UE_DIST) {
    labels.push(...DIST_LABELS);
  } else if ((code === UE_MESSAGEID && id !== null) || code === UE_MSGARGS) {
    // The message's or the dialog's text, and what its own parameters need.
    const parts = code === UE_MSGARGS ? listEntries(value !== undefined && !Array.isArray(value) ? value : undefined) : [];
    const key = code === UE_MESSAGEID ? messageKey(id!) : typeof parts[0] === "string" ? dialogBodyKey(parts[0]) : null;
    if (key === null) return;
    labels.push(key);
    const args = dictArguments(code === UE_MESSAGEID ? third(tuple) : parts[1]);
    for (const each of Object.values(args)) {
      if (Array.isArray(each)) typedNeeds(each, refs, labels, templates);
    }
    const template = templates?.[key];
    if (typeof template === "string") refs.push(...templateNameRefs(template, args));
  }
}

/**
 * The names a dialog's typed arguments need, for the page's name cache to fetch. A label's own names (UE_LOC) are
 * known only from its text, where `templates` has it.
 */
export function typedNameRefs(args: TemplateArguments, templates?: TypedContext["templates"]): NameRef[] {
  const refs: NameRef[] = [];
  for (const value of Object.values(args)) {
    if (Array.isArray(value)) {
      typedNeeds(value, refs, [], templates);
    }
  }
  return refs;
}

/** The client's labels a dialog's typed arguments are worded with, each once. */
export function typedLabels(args: TemplateArguments): string[] {
  const labels: string[] = [];
  for (const value of Object.values(args)) {
    if (Array.isArray(value)) {
      typedNeeds(value, [], labels);
    }
  }
  return [...new Set(labels)];
}

/**
 * The client's text as plain text. Its texts carry the client's own markup
 * (`<br>` for a new line; `<b>`, `<color=...>`, `<url=...>` and the like
 * around words), which the client's own text renderer draws. Here a `<br>`
 * is a line break and any other tag is dropped, leaving the words it
 * wrapped. A "<" that does not open a tag is left alone.
 *
 * In what is left, the client's label parser turns four entities into the
 * characters they stand for, in any letter case, and no others (CCP's trinity,
 * Tr2LabelTextParser.cpp, STATE_GT_AMPSTART): `&amp;`, `&lt;`, `&gt;`, and
 * `&nbsp;`, which it writes as an ordinary space. Each is read once: what
 * `&amp;lt;` leaves is `&lt;`.
 */
export function plainText(marked: string): string {
  return marked
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?[A-Za-z][^<>]*>/g, "")
    .replace(/&(amp|lt|gt|nbsp);/gi, (_whole, name: string) => LABEL_ENTITIES[name.toLowerCase()]!);
}
const LABEL_ENTITIES: Readonly<Record<string, string>> = Object.freeze({ amp: "&", lt: "<", gt: ">", nbsp: " " });

/** The names a template's tags need for these arguments, for the page's name cache to fetch. */
export function templateNameRefs(template: string, args: TemplateArguments, context: Pick<FormatContext, "playerID"> = {}): NameRef[] {
  const refs: NameRef[] = [];
  for (const part of parseTemplate(template)) {
    if (typeof part === "string" || part.conditionals.length > 0) {
      continue;
    }
    const id = idOf(args[part.name] ?? (part.name === "player" ? context.playerID ?? undefined : undefined));
    const kind = id === null ? null : nameKindOf(part, id);
    if (id !== null && kind !== null) {
      refs.push({ kind, id });
    }
  }
  return refs;
}
