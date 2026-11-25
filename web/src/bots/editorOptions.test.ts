import test from "node:test";
import assert from "node:assert/strict";

import {
  ARG_KIND_LABEL,
  ARG_KIND_WIDGET,
  CONDITION_FRACTION_BOUNDS,
  CONDITION_NOUN_LABEL,
  CONDITION_UNTIL_LABEL,
  COUNT_ARG_BOUNDS,
  ISK_ARG_BOUNDS,
  MACRO_ARG_DESCRIPTORS,
  argBounds,
  clampConditionFraction,
  clampConditionIsk,
  conditionFractionCap,
  conditionUsesFraction,
  conditionUsesIsk,
  conditionPercent,
  freshCondition,
  numericArgBounds,
  PLACE_LABEL,
  PLACE_OPTIONS,
  QTY_ARG_BOUNDS,
  RESPONSE_LABEL,
  RESPONSE_OPTIONS,
  UNTIL_CONDITION_KINDS,
  WATCH_CONDITION_KINDS,
} from "./editorOptions.ts";
import { CONDITION_KINDS, conditionAllowedAt, INTERRUPT_RESPONSES, ITEM_PLACES, MACRO_IDS, type Arg } from "./botScript.ts";
import { MACRO_SPECS } from "./macroSpecs.ts";

// ─── Every macro is covered, every arg has a widget ─────────────────────────

test("every MacroID has argument descriptors", () => {
  for (const id of MACRO_IDS) {
    assert.ok(MACRO_ARG_DESCRIPTORS[id], `missing descriptors for ${id}`);
  }
});

test("every arg in MACRO_SPECS is covered with a widget kind and a label", () => {
  for (const id of MACRO_IDS) {
    const spec = MACRO_SPECS[id];
    const desc = MACRO_ARG_DESCRIPTORS[id];
    assert.equal(desc.all.length, spec.args.length, `arg count mismatch for ${id}`);
    for (const arg of spec.args) {
      const found = desc.all.find((a) => a.key === arg.key);
      assert.ok(found, `missing descriptor for ${id}.${arg.key}`);
      assert.equal(found!.kind, arg.kind);
      assert.equal(found!.required, arg.required);
      assert.ok(found!.widget.length > 0, `no widget kind for ${id}.${arg.key}`);
      assert.ok(found!.label.length > 0, `no label for ${id}.${arg.key}`);
    }
  }
});

test("required and optional split covers every arg exactly once", () => {
  for (const id of MACRO_IDS) {
    const desc = MACRO_ARG_DESCRIPTORS[id];
    assert.equal(desc.required.length + desc.optional.length, desc.all.length, id);
    for (const a of desc.required) assert.equal(a.required, true, `${id}.${a.key}`);
    for (const a of desc.optional) assert.equal(a.required, false, `${id}.${a.key}`);
  }
});

test("untilRequired matches MACRO_SPECS (mine-at-belt must require until)", () => {
  assert.equal(MACRO_ARG_DESCRIPTORS["mine-at-belt"].untilRequired, true);
  for (const id of MACRO_IDS) {
    assert.equal(MACRO_ARG_DESCRIPTORS[id].untilRequired, MACRO_SPECS[id].untilRequired, id);
  }
});

// ─── The three previously-missing widgets ───────────────────────────────────

test("equipment, agent and corp each resolve to a real widget kind", () => {
  const kinds: Arg["kind"][] = ["equipment", "agent", "corp"];
  for (const k of kinds) {
    assert.ok(ARG_KIND_WIDGET[k], `no widget for arg kind ${k}`);
    assert.ok(ARG_KIND_WIDGET[k].length > 0);
  }
});

test("request-mission (previously editor-less) has a real editor descriptor for its agent arg", () => {
  const desc = MACRO_ARG_DESCRIPTORS["request-mission"];
  const agent = desc.all.find((a) => a.key === "agent");
  assert.ok(agent);
  assert.equal(agent!.kind, "agent");
  assert.equal(agent!.widget, "agent-picker");
  assert.equal(agent!.required, false);
});

test("every Arg kind has a widget and a generic label", () => {
  const kinds: Arg["kind"][] = [
    "belt",
    "station",
    "equipment",
    "agent",
    "count",
    "corp",
    "fitting",
    "itemType",
    "place",
    "bookmark",
    "isk",
    "qty",
    "character",
    "destination",
    "rockPick",
  ];
  for (const k of kinds) {
    assert.ok(ARG_KIND_WIDGET[k], k);
    assert.ok(ARG_KIND_LABEL[k] && ARG_KIND_LABEL[k].length > 0, k);
  }
});

// ─── Condition option lists: the exact 7-vs-10 / 11-vs-14 gaps ──────────────

test("the until list contains exactly the kinds conditionAllowedAt admits", () => {
  const expected = CONDITION_KINDS.filter((k) => conditionAllowedAt(k, "until"));
  assert.deepEqual([...UNTIL_CONDITION_KINDS].sort(), [...expected].sort());
  // Pin the count so a silent narrowing (or widening) of the format is caught.
  assert.equal(UNTIL_CONDITION_KINDS.length, 10);
});

test("wallet-below, wallet-above and cargo-full are reachable as until conditions", () => {
  for (const k of ["wallet-below", "wallet-above", "cargo-full"] as const) {
    assert.ok(UNTIL_CONDITION_KINDS.includes(k), k);
  }
});

test("the watch list covers every interrupt-legal kind, health-below included", () => {
  const expected = CONDITION_KINDS.filter((k) => conditionAllowedAt(k, "interrupt"));
  assert.deepEqual([...WATCH_CONDITION_KINDS].sort(), [...expected].sort());
  assert.ok(WATCH_CONDITION_KINDS.includes("health-below"));
  assert.ok(WATCH_CONDITION_KINDS.includes("ore-hold-at-least"));
  assert.ok(WATCH_CONDITION_KINDS.includes("hold-empty"));
});

test("a grid read (hostile-on-grid) is watch-only, never offered as until", () => {
  assert.ok(WATCH_CONDITION_KINDS.includes("hostile-on-grid"));
  assert.ok(!UNTIL_CONDITION_KINDS.includes("hostile-on-grid"));
});

// ─── Labels are never empty or undefined for any value of their key type ────

test("no condition noun label is empty or undefined", () => {
  for (const k of CONDITION_KINDS) {
    const label = CONDITION_NOUN_LABEL[k];
    assert.ok(label, k);
    assert.ok(label.length > 0, k);
  }
});

test("no until-clause label is empty or undefined", () => {
  for (const k of CONDITION_KINDS) {
    const label = CONDITION_UNTIL_LABEL[k];
    assert.ok(label, k);
    assert.ok(label.length > 0, k);
  }
});

test("no interrupt response label is empty or undefined", () => {
  for (const r of INTERRUPT_RESPONSES) {
    const label = RESPONSE_LABEL[r];
    assert.ok(label, r);
    assert.ok(label.length > 0, r);
  }
});

test("no item place label is empty or undefined", () => {
  for (const p of ITEM_PLACES) {
    const label = PLACE_LABEL[p];
    assert.ok(label, p);
    assert.ok(label.length > 0, p);
  }
});

// ─── Derived option lists match their source enums ──────────────────────────

test("RESPONSE_OPTIONS is derived from INTERRUPT_RESPONSES, in order", () => {
  assert.deepEqual(
    RESPONSE_OPTIONS.map((o) => o.value),
    INTERRUPT_RESPONSES,
  );
  for (const o of RESPONSE_OPTIONS) {
    assert.equal(o.label, RESPONSE_LABEL[o.value]);
  }
});

test("PLACE_OPTIONS is derived from ITEM_PLACES, in order", () => {
  assert.deepEqual(
    PLACE_OPTIONS.map((o) => o.value),
    ITEM_PLACES,
  );
  for (const o of PLACE_OPTIONS) {
    assert.equal(o.label, PLACE_LABEL[o.value]);
  }
});

// ─── Numeric bounds come from the shared constants, not retyped numbers ────

test("count/isk/qty bounds resolve through numericArgBounds", () => {
  assert.deepEqual(numericArgBounds("count"), COUNT_ARG_BOUNDS);
  assert.deepEqual(numericArgBounds("isk"), ISK_ARG_BOUNDS);
  assert.deepEqual(numericArgBounds("qty"), QTY_ARG_BOUNDS);
  assert.equal(numericArgBounds("belt"), null);
});

test("bounds are sane (min below max, min at least 1)", () => {
  for (const b of [COUNT_ARG_BOUNDS, ISK_ARG_BOUNDS, QTY_ARG_BOUNDS, CONDITION_FRACTION_BOUNDS]) {
    assert.ok(b.min < b.max);
    assert.ok(b.min >= 0);
  }
});

// ─── No player-facing string carries a raw token or developer jargon ────────

test("no label reads like a raw enum/token (kebab-case, underscores)", () => {
  const allLabels = [
    ...Object.values(CONDITION_NOUN_LABEL),
    ...Object.values(CONDITION_UNTIL_LABEL),
    ...Object.values(RESPONSE_LABEL),
    ...Object.values(PLACE_LABEL),
    ...Object.values(ARG_KIND_LABEL),
  ];
  for (const label of allLabels) {
    assert.ok(!/_/.test(label), `underscore in label: ${label}`);
    assert.ok(!/^[a-z]+(-[a-z]+)+$/.test(label), `looks like a raw token: ${label}`);
  }
});

// ─── Per-argument numeric bounds ────────────────────────────────────────────
//
// `MIN/MAX_COUNT_ARG` is 1..500 for every `count` argument, because that is all
// the codec can say about a number whose meaning it does not know. These are
// what the INSPECTOR knows on top of that, and they are the ranges the editor
// shipped with before the redesign moved them out of the component.

test("argBounds narrows a count argument to what that argument actually means", () => {
  const level = MACRO_ARG_DESCRIPTORS["find-distribution-agent"].all.find((a) => a.key === "level");
  assert.ok(level, "find-distribution-agent has no level argument");
  assert.deepEqual(argBounds("find-distribution-agent", level), { min: 1, max: 4 }, "Distribution levels run 1-4");
  const fallback = MACRO_ARG_DESCRIPTORS["find-distribution-agent"].all.find((a) => a.key === "fallback");
  assert.equal(fallback?.kind, "toggle");
  assert.equal(fallback?.required, false);

  const seconds = MACRO_ARG_DESCRIPTORS["wait"].all.find((a) => a.key === "seconds");
  assert.ok(seconds);
  assert.deepEqual(argBounds("wait", seconds), { min: 1, max: 500 });
});

test("argBounds falls back to the format's own bounds, and is null for a non-number", () => {
  const price = MACRO_ARG_DESCRIPTORS["buy-item"].all.find((a) => a.key === "price");
  assert.ok(price);
  assert.deepEqual(argBounds("buy-item", price), ISK_ARG_BOUNDS);

  const belt = MACRO_ARG_DESCRIPTORS["mine-at-belt"].all.find((a) => a.key === "belt");
  assert.ok(belt);
  assert.equal(argBounds("mine-at-belt", belt), null, "a belt is not a number");
});

test("every numeric argument of every macro has bounds a widget can show", () => {
  for (const id of MACRO_IDS) {
    for (const arg of MACRO_ARG_DESCRIPTORS[id].all) {
      if (arg.kind !== "count" && arg.kind !== "isk" && arg.kind !== "qty") continue;
      const bounds = argBounds(id, arg);
      assert.ok(bounds, `${id}.${arg.key} has no bounds`);
      assert.ok(bounds.min < bounds.max, `${id}.${arg.key} has an empty range`);
    }
  }
});

// ─── Which macros offer a "stop when" at all ────────────────────────────────

test("untilOffered covers what must have one, plus wait, and nothing else", () => {
  const offered = MACRO_IDS.filter((id) => MACRO_ARG_DESCRIPTORS[id].untilOffered);
  assert.deepEqual([...offered].sort(), ["mine-at-belt", "wait"]);
  // Required implies offered — a macro that cannot end on its own must be
  // able to say when it does.
  for (const id of MACRO_IDS) {
    const d = MACRO_ARG_DESCRIPTORS[id];
    assert.ok(!d.untilRequired || d.untilOffered, `${id} needs an until but is not offered one`);
  }
});

// ─── Fresh conditions keep the number the player already set ────────────────

test("freshCondition keeps a threshold of the same SHAPE when the kind changes", () => {
  const shields = freshCondition("shield-below");
  assert.deepEqual(shields, { kind: "shield-below", fraction: 0.3 });
  // Switching the subject is not a change of amount.
  const armor = freshCondition("armor-below", { kind: "shield-below", fraction: 0.45 });
  assert.deepEqual(armor, { kind: "armor-below", fraction: 0.45 });
});

test("freshCondition re-clamps a kept threshold into the new kind's own range", () => {
  // 95% is legal on shields and impossible on an ore hold.
  const oreHold = freshCondition("ore-hold-at-least", { kind: "shield-below", fraction: 0.95 });
  assert.deepEqual(oreHold, { kind: "ore-hold-at-least", fraction: 0.9 });
});

test("freshCondition starts a hold at 'nearly full' and a defence at a low line", () => {
  assert.deepEqual(freshCondition("cargo-full"), { kind: "cargo-full", fraction: 0.9 });
  assert.deepEqual(freshCondition("hull-below"), { kind: "hull-below", fraction: 0.3 });
});

test("freshCondition does not carry a number across shapes", () => {
  const wallet = freshCondition("wallet-below", { kind: "shield-below", fraction: 0.3 });
  assert.deepEqual(wallet, { kind: "wallet-below", isk: 10_000_000 });
  assert.deepEqual(freshCondition("hostile-on-grid"), { kind: "hostile-on-grid" });
});

test("every condition kind produces a condition the shape helpers agree with", () => {
  for (const kind of CONDITION_KINDS) {
    const condition = freshCondition(kind);
    assert.equal(condition.kind, kind);
    assert.equal("fraction" in condition, conditionUsesFraction(kind), `${kind}: fraction disagreement`);
    assert.equal("isk" in condition, conditionUsesIsk(kind), `${kind}: isk disagreement`);
  }
});

// ─── Clamps ─────────────────────────────────────────────────────────────────

test("the ore hold's ceiling is lower than every other fraction's", () => {
  assert.equal(conditionFractionCap("ore-hold-at-least"), 0.9);
  assert.equal(conditionFractionCap("shield-below"), CONDITION_FRACTION_BOUNDS.max);
  assert.equal(clampConditionFraction(0.99, "ore-hold-at-least"), 0.9);
  assert.equal(clampConditionFraction(0.99, "shield-below"), CONDITION_FRACTION_BOUNDS.max);
  // Never zero: a watch that can never fire is not a watch.
  assert.equal(clampConditionFraction(0, "shield-below"), CONDITION_FRACTION_BOUNDS.min);
});

test("conditionPercent is what a player types, both ways round", () => {
  assert.equal(conditionPercent(0.3), 30);
  assert.equal(conditionPercent(0.9), 90);
});

test("an ISK threshold clamps to what the codec accepts", () => {
  assert.equal(clampConditionIsk(0), ISK_ARG_BOUNDS.min);
  assert.equal(clampConditionIsk(Number.MAX_SAFE_INTEGER), ISK_ARG_BOUNDS.max);
  assert.equal(clampConditionIsk(5_000_000), 5_000_000);
});
