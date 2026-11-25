// C3 — the palette metadata. Every macro has an entry, the copy matches the
// sentence register, and nothing on a palette card is an id or an engineering
// word (R7d / R9a).

import test from "node:test";
import assert from "node:assert/strict";

import { MACRO_IDS } from "./botScript.ts";
import { MACRO_SPECS } from "./macroSpecs.ts";
import { macroName } from "./scriptText.ts";
import {
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  MACRO_CATALOG_LIST,
  categoriesInUse,
  macroEntry,
} from "./macroCatalogView.ts";

const JARGON = /\b(typeGroup|groupID|macro|args?|until|stationID|beltID|kind|null)\b/i;
const DIGITS = /\d/;

test("every macro has a catalog entry, in menu order", () => {
  assert.equal(MACRO_CATALOG_LIST.length, MACRO_IDS.length);
  assert.deepEqual(
    MACRO_CATALOG_LIST.map((e) => e.id),
    [...MACRO_IDS],
  );
});

test("the Bot Builder offers standalone mining and fleet membership after Core MCC retirement", () => {
  const offered = new Set<string>(MACRO_CATALOG_LIST.map(entry => entry.id));
  for (const retired of ["fleet-mine", "mining-support"]) assert.equal(offered.has(retired), false);
  for (const active of ["mine-at-belt", "join-support-fleet", "jettison-ore", "deliver-ore"]) assert.ok(offered.has(active));
});

test("each entry's name matches the sentence register", () => {
  for (const id of MACRO_IDS) {
    assert.equal(macroEntry(id).name, macroName(id));
  }
});

test("the does/needs/name copy carries no ids or engineering words", () => {
  for (const e of MACRO_CATALOG_LIST) {
    for (const text of [e.name, e.does, e.needs ?? ""]) {
      assert.doesNotMatch(text, DIGITS, `"${text}" should have no digits`);
      assert.doesNotMatch(text, JARGON, `"${text}" should read plainly`);
    }
    assert.ok(e.does.length > 0, `${e.id} needs a "what it does"`);
  }
});

test("parameters are derived from the shared macro spec", () => {
  for (const id of MACRO_IDS) {
    const entry = macroEntry(id);
    const spec = MACRO_SPECS[id];
    assert.deepEqual(
      entry.params.map((p) => p.key),
      spec.args.map((a) => a.key),
    );
    assert.equal(entry.untilRequired, spec.untilRequired);
  }
});

test("undock needs nothing; mine-at-belt needs a belt, equipment, and an until", () => {
  const undock = macroEntry("undock");
  assert.equal(undock.needs, null);
  assert.deepEqual(undock.params, []);
  assert.equal(undock.untilRequired, false);

  const mine = macroEntry("mine-at-belt");
  assert.deepEqual(mine.params.map((p) => p.key).sort(), ["belt", "equipment", "ores", "pick"]);
  assert.equal(mine.params.find((p) => p.key === "belt")?.required, true);
  assert.equal(mine.params.find((p) => p.key === "equipment")?.required, false, "equipment is optional (auto)");
  assert.equal(mine.params.find((p) => p.key === "pick")?.required, false, "the rock order is optional (nearest)");
  assert.equal(mine.params.find((p) => p.key === "ores")?.required, false, "the ore priority list is optional (any rock)");
  assert.equal(mine.untilRequired, true);
});

test("mine-at-belt's blurb covers all three ways to pick where, not just a belt", () => {
  // The belt argument grew a "site" mode (tour the scanner's ore sites,
  // never a belt) beside "nearest" and a belt named by hand, and the catalog
  // card used to promise only belt-to-belt rotation — which undersold two of
  // the block's three ways to run.
  const mine = macroEntry("mine-at-belt");
  assert.match(mine.does, /nearest belt/i);
  assert.match(mine.does, /ore site/i);
  // "locks rocks" is load-bearing for editorView.test.ts's search-by-does-text
  // coverage (filterMacroPicker("locks rocks", ...)) — pinned here too so a
  // future rewrite of this blurb notices it before that test does.
  assert.match(mine.does, /locks rocks/);
});

test("every macro has a category with a label, and the filter offers no empty bucket", () => {
  for (const e of MACRO_CATALOG_LIST) {
    assert.ok(CATEGORY_LABEL[e.category], `${e.id} has category "${e.category}" with no label`);
    assert.ok(CATEGORY_ORDER.includes(e.category), `${e.category} is missing from CATEGORY_ORDER`);
  }
  const inUse = categoriesInUse();
  // Every offered category must have at least one block behind it…
  const present = new Set(MACRO_CATALOG_LIST.map((e) => e.category));
  for (const c of inUse) {
    assert.ok(present.has(c), `${c} is offered but has no block`);
  }
  // …and every block's category must be offered.
  for (const e of MACRO_CATALOG_LIST) {
    assert.ok(inUse.includes(e.category), `${e.category} has a block but is not offered`);
  }
  // The chips read in CATEGORY_ORDER (a stable, deduped subsequence).
  assert.deepEqual(inUse, CATEGORY_ORDER.filter((c) => inUse.includes(c)));
});

test("travel and deliver both take a station picker", () => {
  for (const id of ["travel-to-station", "deliver-ore"] as const) {
    const params = macroEntry(id).params;
    assert.equal(params[0]?.picker, "station");
    assert.equal(params[0]?.required, true);
  }
});

test("deliver's corporation hangar is an OPTIONAL second parameter", () => {
  // Optional is the load-bearing half: a hauling block that could not run
  // without naming a corporation division would have broken every script
  // written before offices existed.
  const params = macroEntry("deliver-ore").params;
  assert.equal(params.length, 2);
  assert.equal(params[1]?.picker, "corpDivision");
  assert.equal(params[1]?.required, false);
  assert.equal(macroEntry("travel-to-station").params.length, 1);
});
