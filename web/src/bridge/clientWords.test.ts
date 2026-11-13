// The client's message templates, parsed and filled.
//
// The grammar is the client's own tokenizer's (localization/parser.py,
// _Tokenize). The templates below are made up, but written with the tags the
// client's real texts carry for the labels the server sends (seen with
// scripts/client-words.js): {[datetime]when}, {[item]skillID.name},
// {[numeric]skillLevel}, {[numeric]rpAmount}, {[character]player.name}.

import test from "node:test";
import assert from "node:assert/strict";

import {
  LIST_DELIMITER,
  QUANTITY_AND_ITEM,
  convertTyped,
  formatTemplate,
  parseTag,
  parseTemplate,
  plainText,
  prepareArguments,
  templateNameRefs,
  typedLabels,
  typedNameRefs,
} from "./clientWords.ts";
import type { NameKind } from "../store/names.ts";

const NAMES: Record<string, string> = {
  "type:11448": "Electromagnetic Physics",
  "type:20424": "Datacore - Electronic Engineering",
  "type:34": "Tritanium",
  // A name that reads as a number, for a typed value inside a typed value.
  "type:99": "34",
  "owner:140000002": "Test Two",
  "owner:1000043": "Corporate Police Force",
  "station:60000004": "Muvolailen X - Moon 3 - CBD Corporation Storage",
  "system:30002780": "Muvolailen",
  "region:10000002": "The Forge",
  "structure:1030000000001": "A Citadel",
};
const nameOf = (kind: NameKind, id: number): string => NAMES[`${kind}:${id}`] ?? `${kind} ${id}`;
const context = { nameOf, playerID: 140000002 };
const fill = (template: string, args: Record<string, unknown> = {}) => formatTemplate(template, args as never, context);

// ── the grammar ──────────────────────────────────────────────────────────────

test("a tag is read as the client's tokenizer reads it", () => {
  assert.deepEqual(parseTag("{name}"), { raw: "{name}", type: "generic", name: "name", property: null, conditionals: [], modifiers: [], settings: {} });
  assert.deepEqual(parseTag("{[item]skillID.name}"), { raw: "{[item]skillID.name}", type: "item", name: "skillID", property: "name", conditionals: [], modifiers: [], settings: {} });
  assert.deepEqual(parseTag("{[numeric]amount, useGrouping, decimalPlaces=2}"), {
    raw: "{[numeric]amount, useGrouping, decimalPlaces=2}", type: "numeric", name: "amount", property: null, conditionals: [], modifiers: ["useGrouping"], settings: { decimalPlaces: "2" },
  });
  assert.deepEqual(parseTag('{[numeric]count.quantity -> "item", "items"}'), {
    raw: '{[numeric]count.quantity -> "item", "items"}', type: "numeric", name: "count", property: "quantity", conditionals: ["item", "items"], modifiers: [], settings: {},
  });
  assert.deepEqual(parseTag('{[datetime]when, date="short", time=none}')?.settings, { date: "short", time: "none" });
  // The kind's name is taken without regard to case, as the client's table is.
  assert.equal(parseTag("{[npcOrganization]corp.name}")?.type, "npcorganization");
  // An empty word among the choices is a choice.
  assert.deepEqual(parseTag('{[character]who.gender -> "", "x"}')?.conditionals, ["", "x"]);
});

test("what the client's tokenizer would refuse is not a tag", () => {
  for (const wrong of ["{}", "{ }", "{[item}", "{[item]}", "{[]name}", "{9lives}", "{name.}", "{name.9}", "{[item.name}", '{a -> b}', '{a -> "x" "y"}', '{a -> "x" : "y"}', "{a, b=}", "{a b}", "{a = b}"]) {
    assert.equal(parseTag(wrong), null, wrong);
  }
});

test("a template is its text and its tags in order, and a brace run that is no tag stays text", () => {
  const parts = parseTemplate("Before {[item]thing.name} between {count} after {not a tag} end");
  assert.deepEqual(parts.map((part) => (typeof part === "string" ? part : `<${part.type}:${part.name}>`)), [
    "Before ", "<item:thing>", " between ", "<generic:count>", " after ", "{not a tag}", " end",
  ]);
  assert.deepEqual(parseTemplate("no tags at all"), ["no tags at all"]);
  assert.deepEqual(parseTemplate(""), []);
  // A doubled brace does not start a tag; the one after it does, as in the client's own pattern.
  const doubled = parseTemplate("{{literal}");
  assert.equal(doubled.length, 2);
  assert.equal(doubled[0], "{");
  assert.equal(typeof doubled[1] === "string" ? null : doubled[1]?.name, "literal");
});

// ── filling ──────────────────────────────────────────────────────────────────

test("an item, a character, an organisation and a place are filled by name", () => {
  assert.equal(fill("{[item]skillID.name} level {[numeric]skillLevel}", { skillID: 11448, skillLevel: 2 }), "Electromagnetic Physics level 2");
  assert.equal(fill("Greetings, {[character]who.name}.", { who: 140000002 }), "Greetings, Test Two.");
  assert.equal(fill("{[npcOrganization]corp.name}", { corp: 1000043 }), "Corporate Police Force");
  // A place is looked up as what its ID says it is.
  assert.equal(fill("{[location]a.name} / {[location]b.name} / {[location]c.name} / {[location]d.name}", { a: 60000004, b: 30002780, c: 10000002, d: 1030000000001 }),
    "Muvolailen X - Moon 3 - CBD Corporation Storage / Muvolailen / The Forge / A Citadel");
  // With no property at all the name is still what is shown.
  assert.equal(fill("{[item]t}", { t: 34 }), "Tritanium");
  assert.equal(fill("{[item]t.nameWithArticle} and {[item]e.nameWithArticle}", { t: 34, e: 11448 }), "a Tritanium and an Electromagnetic Physics");
  // A name the page does not have yet is the stand-in the page gives, not a blank.
  assert.equal(fill("{[item]t.name}", { t: 999 }), "type 999");
});

test("the player is the character the page is flying, unless the message names another", () => {
  assert.equal(fill("Greetings, {[character]player.name}."), "Greetings, Test Two.");
  assert.equal(fill("Greetings, {[character]player.name}.", { player: 1000043 }), "Greetings, Corporate Police Force.");
  assert.equal(formatTemplate("Greetings, {[character]player.name}.", {}, { nameOf }), "Greetings, .");
});

test("a number is plain unless the template asks for grouping, and takes the decimal places it asks for", () => {
  assert.equal(fill("{[numeric]rp} RP + {[numeric]isk} ISK", { rp: 100, isk: 10000 }), "100 RP + 10000 ISK");
  assert.equal(fill("{[numeric]isk, useGrouping}", { isk: 1234567 }), "1,234,567");
  assert.equal(fill("{[numeric]isk, useGrouping, decimalPlaces=2}", { isk: 1234567.5 }), "1,234,567.50");
  assert.equal(fill("{[numeric]x, decimalPlaces=1}", { x: 2.25 }), "2.3");
  // However the bridge spelled it.
  assert.equal(fill("{[numeric]a} {[numeric]b}", { a: "42", b: { type: "long", value: "9000000000" } }), "42 9000000000");
  // A string that is no number is written as given (the client's GetMessageByID, measured: Legend's numeric tag with
  // FmtISK's "0.00 ISK" gave "0.00 ISK").
  assert.equal(fill("{[numeric]x}", { x: "many" }), "many");
  assert.equal(fill("{[numeric]legend, decimalPlaces=0}", { legend: "0.00 ISK" }), "0.00 ISK");
});

test("a time is the game's own form, in its own clock", () => {
  // 2026-10-08 11:30:15 UTC as the server writes a time: 100 ns ticks since 1601.
  const when = { type: "long", value: String((BigInt(Date.UTC(2026, 9, 8, 11, 30, 15)) + 11644473600000n) * 10000n) };
  assert.equal(fill("before {[datetime]when} you", { when }), "before 2026.10.08 11:30 you");
  assert.equal(fill("{[datetime]when, time=none}", { when }), "2026.10.08");
  assert.equal(fill("{[datetime]when, date=none}", { when }), "11:30");
  assert.equal(fill("{[formattedtime]when}", { when }), "2026.10.08 11:30");
  // A formatted time's format is strftime's (the install's DateLongNone and HoursAndMinutes labels).
  assert.equal(fill('{[formattedtime]when, format="%Y.%m.%d"}', { when }), "2026.10.08");
  assert.equal(fill('{[formattedtime]when, format="%H:%M"}', { when }), "11:30");
  assert.equal(fill("{[datetime]when}", { when: "soon" }), "");
  // A length of time, in the same ticks.
  assert.equal(fill("{[timeinterval]t}", { t: 10_000_000 * (86_400 + 2 * 3_600 + 5 * 60 + 7) }), "1d 2h 5m 7s");
  assert.equal(fill("{[timeinterval]t}", { t: 10_000_000 * 3_600 }), "1h");
  assert.equal(fill("{[timeinterval]t}", { t: 0 }), "0s");
});

test("a word chosen by a count takes the first for one and the last for any other", () => {
  const template = '{[numeric]n} {[numeric]n.quantity -> "datacore", "datacores"}';
  assert.equal(fill(template, { n: 1 }), "1 datacore");
  assert.equal(fill(template, { n: 3 }), "3 datacores");
  assert.equal(fill(template, { n: 0 }), "0 datacores");
  // Chosen by gender, which the page does not know: the first.
  assert.equal(fill('{[character]who.gender -> "his", "her"} ship', { who: 140000002 }), "his ship");
});

test("the modifiers change the case, and linkify changes nothing here", () => {
  assert.equal(fill("{[item]t.name, uppercase} {[item]t.name, lowercase} {word, capitalize} {phrase, titlecase} {[item]t.name, linkify}", { t: 34, word: "hello there", phrase: "the forge" }),
    "TRITANIUM tritanium Hello there The Forge Tritanium");
});

test("a plain value is shown as it is; one that was not sent, or is of a kind not done, shows nothing", () => {
  assert.equal(fill("{who} has {count}", { who: "Someone", count: 7 }), "Someone has 7");
  assert.equal(fill("[{missing}] [{[item]missing.name}] [{[characterlist]them}] [{[messageid]m}]", { them: [1, 2], m: 5 }), "[] [] [] []");
  assert.equal(fill("{flag}", { flag: true }), "");
  // What is not a tag is left exactly as written.
  assert.equal(fill("keep {this one} and {}", {}), "keep {this one} and {}");
});

// ── the names a template needs ───────────────────────────────────────────────

test("the names a template needs are asked for under the kinds they are shown by", () => {
  const key = (template: string, args: Record<string, unknown>, ctx = {}) => templateNameRefs(template, args as never, ctx).map((ref) => `${ref.kind}:${ref.id}`);
  assert.deepEqual(key("{[item]skillID.name} {[numeric]skillLevel} {[location]where.name} {[npcOrganization]corp.name}", { skillID: 11448, skillLevel: 2, where: 60000004, corp: 1000043 }),
    ["type:11448", "station:60000004", "owner:1000043"]);
  assert.deepEqual(key("{[character]player.name}", {}, { playerID: 140000002 }), ["owner:140000002"]);
  assert.deepEqual(key("{[character]player.name}", {}), []);
  // Nothing for a value that was not sent, is not an ID, or only chooses a word.
  assert.deepEqual(key('{[item]a.name} {[item]b.name} {[character]c.gender -> "x", "y"} {plain}', { b: "x", c: 140000002, plain: 5 }), []);
});

// ── the client's markup ──────────────────────────────────────────────────────

test("the client's markup becomes plain text: a break is a new line, and other tags leave their words", () => {
  assert.equal(plainText("First line.<br>Second line.<br><br>After a gap."), "First line.\nSecond line.\n\nAfter a gap.");
  assert.equal(plainText("a<BR>b<br/>c<br />d"), "a\nb\nc\nd");
  assert.equal(plainText("<b>Bold</b> and <i>slanted</i> and <color=0xff00ff00>green</color>"), "Bold and slanted and green");
  assert.equal(plainText("Go to <url=showinfo:5//30002780>Muvolailen</url> now"), "Go to Muvolailen now");
  assert.equal(plainText('<a href="showinfo:1373//3008416">An Agent</a>, <font size=14>big</font>'), "An Agent, big");
  // What is not a tag is left alone.
  assert.equal(plainText("5 < 7 and 9 > 2, <3, a<b, x <> y"), "5 < 7 and 9 > 2, <3, a<b, x <> y");
  assert.equal(plainText("no markup at all"), "no markup at all");
  // The four entities the client's label parser reads, in any letter case; no others.
  assert.equal(plainText("0.7&nbsp;Somewhere&NBSP;Else"), "0.7 Somewhere Else");
  assert.equal(plainText("Fish &amp; Chips &AMP; peas"), "Fish & Chips & peas");
  assert.equal(plainText("a &lt; b &GT; c &Lt;b&gT;"), "a < b > c <b>");
  assert.equal(plainText("&quot;quoted&quot; &apos; &#160; &copy; &nbsp &amp"), "&quot;quoted&quot; &apos; &#160; &copy; &nbsp &amp");
  // Each is read once, and after the tags have gone: an entity never makes a tag, nor another entity.
  assert.equal(plainText("&amp;lt; &amp;amp; &amp;nbsp;"), "&lt; &amp; &nbsp;");
  assert.equal(plainText("<b>&lt;b&gt;</b>"), "<b>");
  assert.equal(plainText(""), "");
});

// ── a dialog's typed values ──────────────────────────────────────────────────
//
// (code, value[, value2]) as the client's cfg.FormatConvert turns them to
// text. A tuple is an array here and a list is {type: "list", items}, as the
// bridge spells them. The two templates are made up, with the tags the
// client's own carry for those labels (scripts/client-words.js shows them).

const TYPED_TEMPLATES = { [QUANTITY_AND_ITEM]: "{[numeric]quantity, useGrouping} of {[item]item.name}", [LIST_DELIMITER]: "; " };
const typed = { ...context, templates: TYPED_TEMPLATES };
const list = (...items: unknown[]) => ({ type: "list", items });
const convert = (tuple: unknown[], with_: Parameters<typeof convertTyped>[3] = typed) =>
  convertTyped(tuple[0] as never, tuple[1] as never, (tuple.length >= 3 ? tuple[2] : null) as never, with_);

test("an owner, a place and a type by their codes are their names", () => {
  assert.equal(convert([2, 1000043]), "Corporate Police Force");
  assert.equal(convert([4, 34]), "Tritanium");
  assert.equal(convert([3, 30002780]), "Muvolailen");
  assert.equal(convert([3, 60000004]), "Muvolailen X - Moon 3 - CBD Corporation Storage");
  assert.equal(convert([3, 10000002]), "The Forge");
  assert.equal(convert([3, 1030000000001]), "A Citadel");
  // What is not an ID names nothing.
  for (const tuple of [[2, null], [2, "Somebody"], [3, 0], [4, -34], [4, 1.5], [4]]) {
    assert.equal(convert(tuple), "", JSON.stringify(tuple));
  }
});

test("a quantity of a type is the client's own label for it, filled with both", () => {
  assert.equal(convert([24, 34, 1500]), "1,500 of Tritanium");
  // Without the client's label, this client's own way of saying it; without a quantity, the name.
  assert.equal(convert([24, 34, 1500], context), "1,500 × Tritanium");
  assert.equal(convert([24, 34, 1500], { ...context, templates: { [QUANTITY_AND_ITEM]: null } }), "1,500 × Tritanium");
  assert.equal(convert([24, 34], context), "Tritanium");
  assert.equal(convert([24, null, 5]), "");
});

test("a list is its entries converted and joined by the separator it came with, or by the client's own", () => {
  const entries = list([24, 34, 10], [4, 20424], [2, 1000043]);
  assert.equal(convert([103, entries, "<br>"]), "10 of Tritanium<br>Datacore - Electronic Engineering<br>Corporate Police Force");
  assert.equal(convert([103, entries, ""]), "10 of TritaniumDatacore - Electronic EngineeringCorporate Police Force");
  // No separator: the client's list delimiter; and this client's, when the page has not the client's.
  assert.equal(convert([103, entries]), "10 of Tritanium; Datacore - Electronic Engineering; Corporate Police Force");
  assert.equal(convert([103, entries, null]), "10 of Tritanium; Datacore - Electronic Engineering; Corporate Police Force");
  assert.equal(convert([103, entries], context), "10 × Tritanium, Datacore - Electronic Engineering, Corporate Police Force");
  assert.equal(convert([103, list()]), "");
  assert.equal(convert([103, null, "<br>"]), "");
  // An entry that is not a typed value is nothing, and still has its place.
  assert.equal(convert([103, list([4, 34], 34, "x", [4, 20424]), "|"]), "Tritanium|||Datacore - Electronic Engineering");
  // A tuple of entries, which the client cannot word, is read as the list it was meant to be.
  assert.equal(convert([103, [[24, 34, 10], [4, 20424]], "<br>"]), "10 of Tritanium<br>Datacore - Electronic Engineering");
});

test("a typed value given as a value is converted first, and its own third member takes the second value's place", () => {
  // (24, (4, 34), 7): the inner value has no third member, so the quantity is gone, as in the client.
  assert.equal(convert([24, [4, 34], 7], context), "");
  // The inner value is converted before the outer code is applied to it: a type whose name reads as a number
  // names the type of that number, and the 7 is gone with it.
  assert.equal(convert([24, [4, 99], 7], context), "Tritanium");
  assert.equal(convert([24, [4, 99, 3], 7], context), "3 × Tritanium");
  // An owner whose value is a type's name is no owner.
  assert.equal(convert([2, [4, 34]]), "");
  // A list whose value is one typed value has nothing to list.
  assert.equal(convert([103, [24, 34, 10], "<br>"]), "");
});

// cfg.py FormatConvert (370 to 380): a code with no format is 'INVALID FORMAT TYPE %s, value is %s'.
test("a code the client has no format for is said as the client says it; a tuple with no code is nothing", () => {
  assert.equal(convert([999, "x"]), "INVALID FORMAT TYPE 999, value is x");
  assert.equal(convert(["4", 34]), "INVALID FORMAT TYPE 4, value is 34");
  assert.equal(convert([null, 34]), "INVALID FORMAT TYPE None, value is 34");
  assert.equal(convert([undefined, 34]), "");
});

test("a dialog's arguments are prepared as the client prepares them: every tuple to its text, the rest left alone", () => {
  const given = {
    empire: [2, 1000043],
    contraband: [103, list([24, 34, 10], [24, 20424, 2]), "<br>"],
    count: 3,
    note: "as written",
    when: { type: "long", value: "134359400000000000" },
    listed: list(1, 2),
    nothing: null,
    empty: [],
  };
  assert.deepEqual(prepareArguments(given as never, typed), {
    empire: "Corporate Police Force",
    contraband: "10 of Tritanium<br>2 of Datacore - Electronic Engineering",
    count: 3,
    note: "as written",
    when: { type: "long", value: "134359400000000000" },
    listed: list(1, 2),
    nothing: null,
    empty: "",
  });
});

test("the names and the client's labels a dialog's typed arguments need are found, through lists and typed values inside values", () => {
  const args = {
    empire: [2, 500001],
    contraband: [103, list([24, 3721, 10], [24, 3713, 5], [4, 34], "stray"), "<br>"],
    place: [3, 30002780],
    nested: [2, [3, 60000004]],
    plain: 34,
    undone: [14, 1],
    bad: [4, "34x"],
  };
  assert.deepEqual(typedNameRefs(args as never).map((ref) => `${ref.kind}:${ref.id}`), ["owner:500001", "type:3721", "type:3713", "type:34", "system:30002780", "station:60000004"]);
  assert.deepEqual(typedLabels(args as never), [QUANTITY_AND_ITEM]);
  // A list with no separator needs the client's delimiter; one label is asked for once.
  assert.deepEqual(typedLabels({ a: [103, list([24, 34, 1], [24, 35, 2])], b: [103, [[4, 34]], null] } as never), [QUANTITY_AND_ITEM, LIST_DELIMITER]);
  assert.deepEqual(typedLabels({ a: [4, 34], b: 7 } as never), []);
  assert.deepEqual(typedNameRefs({ a: 34, b: "x", c: null } as never), []);
  // A quantity of something that is no type still needs its label, and names nothing.
  assert.deepEqual(typedLabels({ a: [24, null, 5] } as never), [QUANTITY_AND_ITEM]);
  assert.deepEqual(typedNameRefs({ a: [24, null, 5] } as never), []);
});

test("an interval's written form is the caller's to write, from and to as the tag sets them", () => {
  const asked: Array<[bigint, string | null, string | null]> = [];
  const context = { nameOf: () => "", writeInterval: (ticks: bigint, from: string | null, to: string | null) => { asked.push([ticks, from, to]); return "three hours"; } };
  const HOUR = 36_000_000_000;
  assert.equal(formatTemplate("In {[timeinterval]t.writtenForm, to=minute}.", { t: 3 * HOUR }, context), "In three hours.");
  assert.equal(formatTemplate("{[timeinterval]t.writtenForm, from=day, to=hour}", { t: 3 * HOUR + 0.5 }, context), "three hours");
  assert.equal(formatTemplate("{[timeinterval]t.writtenForm}", { t: { type: "long", value: String(3 * HOUR) } }, context), "three hours");
  assert.deepEqual(asked, [[BigInt(3 * HOUR), null, "minute"], [BigInt(3 * HOUR), "day", "hour"], [BigInt(3 * HOUR), null, null]]);
  // Any other form of an interval, and an interval with no form named, is not the written form.
  asked.length = 0;
  assert.equal(formatTemplate("{[timeinterval]t.shortWrittenForm}", { t: 3 * HOUR }, context), "3h");
  assert.equal(formatTemplate("{[timeinterval]t}", { t: 3 * HOUR }, context), "3h");
  assert.deepEqual(asked, []);
  // With nobody to write it, or when it cannot be written, the page's short form stands in.
  assert.equal(formatTemplate("{[timeinterval]t.writtenForm, to=minute}", { t: 3 * HOUR }, { nameOf: () => "" }), "3h");
  // The short written form has a writer of its own, asked the same way, and is not the other's business.
  const short: Array<[bigint, string | null, string | null]> = [];
  const both = {
    nameOf: () => "",
    writeInterval: () => "three hours",
    writeShortInterval: (ticks: bigint, from: string | null, to: string | null) => { short.push([ticks, from, to]); return "3hrs"; },
  };
  assert.equal(formatTemplate("In {[timeinterval]t.shortWrittenForm, from=day, to=second}.", { t: 3 * HOUR }, both), "In 3hrs.");
  assert.equal(formatTemplate("{[timeinterval]t.shortWrittenForm}", { t: 3 * HOUR + 0.5 }, both), "3hrs");
  assert.deepEqual(short, [[BigInt(3 * HOUR), "day", "second"], [BigInt(3 * HOUR), null, null]]);
  assert.equal(formatTemplate("{[timeinterval]t.writtenForm}", { t: 3 * HOUR }, both), "three hours");
  // Without a writer for it, or with one that has no words, the short form is this page's own.
  assert.equal(formatTemplate("{[timeinterval]t.shortWrittenForm}", { t: 3 * HOUR }, { nameOf: () => "", writeInterval: () => "three hours" }), "3h");
  assert.equal(formatTemplate("{[timeinterval]t.shortWrittenForm}", { t: 3 * HOUR }, { nameOf: () => "", writeShortInterval: () => null }), "3h");
  // A tag that asks for neither form gets neither writer.
  assert.equal(formatTemplate("{[timeinterval]t}", { t: 3 * HOUR }, both), "3h");
  assert.equal(formatTemplate("{[timeinterval]t.writtenForm, to=minute}", { t: 3 * HOUR }, { nameOf: () => "", writeInterval: () => null }), "3h");
  // No interval given: nothing, and nothing is asked.
  assert.equal(formatTemplate("[{[timeinterval]t.writtenForm}]", {}, context), "[]");
  assert.deepEqual(asked, []);
});
