// A2 — the codec is the untrusted-input gate, so its tests are adversarial by
// design. A clean document must round-trip byte-for-meaning; a hostile one must
// refuse with a plain sentence or be safely fixed with a spoken warning, and
// NEVER crash, pollute, or quietly drop an action.

import test from "node:test";
import assert from "node:assert/strict";

import {
  decodeScriptText,
  decodeScriptValue,
  encodeScriptDoc,
} from "./scriptCodec.ts";
import {
  MAX_DOC_BYTES,
  MAX_ORE_LIST,
  ROCK_PICKS,
  SCRIPT_FORMAT,
  SCRIPT_VERSION,
  type BotScript,
} from "./botScript.ts";
import { validateScript } from "./validateScript.ts";

// A clean, warning-free document — the design's "Belt runner". Each test that
// needs a malformed one clones this and breaks exactly one thing.
function golden(): BotScript {
  return {
    format: SCRIPT_FORMAT,
    version: SCRIPT_VERSION,
    name: "Belt runner",
    notes: "Mines until 90% then hauls.",
    home: { entity: "station", id: 60000004, name: "Home Station", systemName: "Aunia" },
    interrupts: [
      { id: "i0", when: { kind: "health-below", fraction: 0.5 }, respond: "dock-and-pause" },
      { id: "i1", when: { kind: "shield-below", fraction: 0.3 }, respond: "dock-and-pause" },
    ],
    program: [
      {
        id: "s1",
        kind: "loop",
        repeat: { kind: "times", count: 50 },
        body: [
          {
            id: "s2",
            kind: "macro",
            macro: "mine-at-belt",
            args: {
              belt: { kind: "belt", belt: { mode: "nearest" } },
              equipment: { kind: "equipment", equipment: { groupID: 17482, label: "Strip Miners" } },
            },
            until: { kind: "ore-hold-at-least", fraction: 0.9 },
          },
          {
            id: "s3",
            kind: "macro",
            macro: "deliver-ore",
            args: {
              station: {
                kind: "station",
                ref: { entity: "station", id: 60000004, name: "Home Station", systemName: "Aunia" },
              },
            },
          },
        ],
      },
    ],
  };
}

// A deep, deliberately UNTYPED clone. These tests break one field at a time into
// shapes the type system would reject on purpose (an unknown macro, a garbage
// condition, an out-of-range number) — the whole point is to feed the codec what
// a hostile file could. `any` is the right tool for adversarial input; every
// RESULT is still read back through the typed `mustAccept`/`mustRefuse`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function clone(): any {
  return structuredClone(golden());
}

function mustRefuse(result: ReturnType<typeof decodeScriptValue>): string {
  assert.equal(result.ok, false, "expected a refusal");
  assert.ok(!result.ok);
  return result.refusal;
}

function mustAccept(result: ReturnType<typeof decodeScriptValue>): { doc: BotScript; warnings: readonly string[] } {
  assert.equal(result.ok, true, result.ok ? "" : `unexpected refusal: ${result.refusal}`);
  assert.ok(result.ok);
  return { doc: result.doc, warnings: result.warnings };
}

// ─── The happy path ──────────────────────────────────────────────────────────

test("a clean document decodes with no warnings and equals itself", () => {
  const { doc, warnings } = mustAccept(decodeScriptValue(golden()));
  assert.deepStrictEqual(doc, golden());
  assert.deepStrictEqual([...warnings], []);
});

test("encode then decode is a lossless round trip", () => {
  const text = encodeScriptDoc(golden());
  const { doc, warnings } = mustAccept(decodeScriptText(text));
  assert.deepStrictEqual(doc, golden());
  assert.deepStrictEqual([...warnings], []);
});
test("dockable structure refs round-trip in v1 while old station refs and NPC-only slots stay distinct", () => {
  const old = mustAccept(decodeScriptValue(golden())).doc;
  assert.equal(old.home.entity, "station");
  const structure = { entity: "structure", id: 1_000_000_000_001, name: "QA Astrahus", systemName: "Nonni" };
  const raw = clone();
  raw.home = structure;
  raw.program[0].body[1].args.station.ref = structure;
  const doc = mustAccept(decodeScriptValue(raw)).doc;
  assert.equal(doc.version, 1);
  assert.deepEqual(mustAccept(decodeScriptText(encodeScriptDoc(doc))).doc, doc);
  raw.program[0].body[1].args.station.ref = { ...structure, id: 60000004 };
  mustRefuse(decodeScriptValue(raw));
  raw.program[0].body[1].args.station.ref = structure;
  raw.home = { entity: "station", id: structure.id, name: "Bad", systemName: null };
  mustRefuse(decodeScriptValue(raw));
  raw.home = structure;
  raw.program[0].body[1].args.station.ref = { ...structure, slot: "agent-station" };
  mustRefuse(decodeScriptValue(raw));
});

test("legacy Distribution finder remains level 1 without fallback; explicit policy round-trips in v1", () => {
  const legacy = { ...golden(), program: [{ id: "find", kind: "macro", macro: "find-distribution-agent", args: {} }] };
  const old = mustAccept(decodeScriptValue(legacy)).doc;
  assert.deepEqual(old.program[0], legacy.program[0]);
  const explicit = { ...golden(), program: [{ id: "find", kind: "macro", macro: "find-distribution-agent", args: {
    level: { kind: "count", value: 4 }, fallback: { kind: "toggle", enabled: true },
  } }] };
  const newer = mustAccept(decodeScriptValue(explicit)).doc;
  assert.equal(newer.version, 1);
  assert.deepEqual(mustAccept(decodeScriptText(encodeScriptDoc(newer))).doc, newer);
});

test("malformed explicit Distribution policy is refused, not converted to a different search", () => {
  for (const level of [0, 5, "4", null]) {
    const raw = { ...golden(), program: [{ id: "find", kind: "macro", macro: "find-distribution-agent", args: {
      level: { kind: "count", value: level },
    } }] };
    assert.match(mustRefuse(decodeScriptValue(raw)), /level|argument/i);
  }
  for (const fallback of [{ kind: "toggle", enabled: "yes" }, { kind: "count", value: 1 }]) {
    const raw = { ...golden(), program: [{ id: "find", kind: "macro", macro: "find-distribution-agent", args: { fallback } }] };
    mustRefuse(decodeScriptValue(raw));
  }
});

// The golden fixture only exercises belt/station/equipment args, so on its own it
// cannot catch a serialiser that forgets a kind. This document uses EVERY OTHER
// arg kind (count, corp, agent, fitting, itemType, place, bookmark, character,
// destination, rockPick) — if any is dropped on encode it round-trips lossily
// and this fails.
function everyArgKind(): BotScript {
  return {
    format: SCRIPT_FORMAT,
    version: SCRIPT_VERSION,
    name: "Every arg kind",
    notes: "",
    home: { entity: "station", id: null, name: null, systemName: null, starting: true },
    interrupts: [],
    program: [
      {
        id: "a1",
        kind: "macro",
        macro: "find-distribution-agent",
        args: {
          level: { kind: "count", value: 3 },
          corporation: { kind: "corp", id: 1000035, name: "Caldari Navy" },
        },
      },
      {
        id: "a2",
        kind: "macro",
        macro: "request-mission",
        args: { agent: { kind: "agent", ref: { entity: "agent", id: 3018770, name: "An Agent", systemName: "Jita" } } },
      },
      {
        id: "a3",
        kind: "macro",
        macro: "refit-ship",
        args: { fitting: { kind: "fitting", fittingID: 42, name: "PvE Fit" } },
      },
      {
        id: "a4",
        kind: "macro",
        macro: "move-items",
        args: {
          item: { kind: "itemType", typeID: 34, name: "Tritanium" },
          from: { kind: "place", place: "hangar" },
          to: { kind: "place", place: "cargo" },
          amount: { kind: "count", value: 100 },
        },
      },
      {
        id: "a5",
        kind: "macro",
        macro: "warp-to-bookmark",
        args: { bookmark: { kind: "bookmark", bookmarkID: 77, name: "Safe Spot" } },
      },
      {
        id: "a6",
        kind: "macro",
        macro: "buy-item",
        args: {
          item: { kind: "itemType", typeID: 34, name: "Tritanium" },
          quantity: { kind: "qty", value: 5000 },
          price: { kind: "isk", value: 6 },
        },
      },
      {
        id: "a7",
        kind: "macro",
        macro: "invite-to-fleet",
        args: { who: { kind: "character", charID: 90000001, name: "Alt Pilot" } },
      },
      {
        id: "a8",
        kind: "macro",
        macro: "set-destination",
        args: { destination: { kind: "destination", ref: { entity: "system", id: 30000142, name: "Jita", systemName: null } } },
      },
      {
        id: "a12",
        kind: "macro",
        macro: "travel-to-system",
        args: { system: { kind: "system", ref: { entity: "system", id: 30000144, name: "Far Away", systemName: null } } },
      },
      {
        id: "a13",
        kind: "macro",
        macro: "join-advertised-fleet",
        args: { fleetName: { kind: "text", text: "Mining Op" } },
      },
      {
        id: "a14",
        kind: "macro",
        macro: "deliver-ore",
        args: {
          station: { kind: "station", ref: { entity: "station", id: 60000004, name: "Home", systemName: null } },
          into: { kind: "corpDivision", division: 3, name: "Ore Buffer" },
        },
      },
      {
        id: "a11",
        kind: "macro",
        macro: "mine-at-belt",
        args: {
          belt: { kind: "belt", belt: { mode: "nearest" } },
          pick: { kind: "rockPick", pick: "biggest" },
          ores: { kind: "oreList", ores: [{ groupID: 462, name: "Veldspar" }] },
        },
        until: { kind: "ore-hold-at-least", fraction: 0.9 },
      },
    ],
  };
}

test("a corporation division is refused outside 1-7, never clamped into range", () => {
  // The one number in this file that is an ADDRESS rather than a quantity.
  // Clamping 9 to 7 would land a hold of ore in a corporation hangar nobody
  // chose, and the player would learn it from the wrong division filling up.
  const withDivision = (division: unknown): unknown => ({
    format: SCRIPT_FORMAT,
    version: SCRIPT_VERSION,
    name: "t",
    notes: "",
    home: { entity: "station", id: 60000004, name: "Home", systemName: null },
    interrupts: [],
    program: [
      {
        id: "d1",
        kind: "macro",
        macro: "deliver-ore",
        args: {
          station: { kind: "station", ref: { entity: "station", id: 60000004, name: "Home", systemName: null } },
          into: { kind: "corpDivision", division, name: null },
        },
      },
    ],
  });
  for (const division of [0, 8, 9, -1, 1.5, "3", null]) {
    assert.equal(decodeScriptValue(withDivision(division)).ok, false, `division ${String(division)} must refuse`);
  }
  for (const division of [1, 7]) {
    mustAccept(decodeScriptValue(withDivision(division)));
  }
});

test("a delivery with no corporation division stays absent, not null", () => {
  // Absence is what "the pilot's own hangar" IS. A block that saved an explicit
  // null would export differently from the one the player never touched.
  const doc = decodeScriptValue({
    format: SCRIPT_FORMAT,
    version: SCRIPT_VERSION,
    name: "t",
    notes: "",
    home: { entity: "station", id: 60000004, name: "Home", systemName: null },
    interrupts: [],
    program: [
      {
        id: "d1",
        kind: "macro",
        macro: "deliver-ore",
        args: { station: { kind: "station", ref: { entity: "station", id: 60000004, name: "Home", systemName: null } } },
      },
    ],
  });
  const accepted = mustAccept(doc);
  const step = accepted.doc.program[0] as { args: Record<string, unknown> };
  assert.ok(!("into" in step.args));
});

test("every rock order the editor can offer survives a round trip", () => {
  // The codec validates the pick against ROCK_PICKS, so this is what stops a new
  // order being offered in the editor and then REFUSED on the next import.
  for (const pick of ROCK_PICKS) {
    const doc: BotScript = {
      format: "evejs-bot-script",
      version: 1,
      name: "t",
      notes: "",
      home: { entity: "station", id: 60000004, name: "Home", systemName: null },
      interrupts: [],
      program: [
        {
          id: "m1",
          kind: "macro",
          macro: "mine-at-belt",
          args: {
            belt: { kind: "belt", belt: { mode: "nearest" } },
            pick: { kind: "rockPick", pick },
          },
          until: { kind: "ore-hold-at-least", fraction: 0.9 },
        },
      ],
    };
    const round = mustAccept(decodeScriptText(encodeScriptDoc(doc))).doc;
    const step = round.program[0];
    assert.ok(step !== undefined && step.kind === "macro");
    const arg = step.args["pick"];
    assert.ok(arg !== undefined && arg.kind === "rockPick", `the ${pick} order was dropped`);
    assert.equal(arg.pick, pick);
  }
});

test("a belt SAVED BY THE OLD EDITOR still opens, id and system name and all", () => {
  // ⚠ WHAT THIS PINS. The editor used to pick a belt off the live grid and
  // store its entity id and the system it was read in; it now stores the NAME
  // alone (see BotInspector.svelte), because the id is grid-local and the
  // runtime never matched on it. Bots saved before that change are still in
  // players' libraries, and the codec must keep taking them: the two dead
  // fields ride along untouched, and nothing downstream reads them.
  const doc = JSON.parse(encodeScriptDoc(golden())) as Record<string, unknown>;
  const program = structuredClone(doc["program"]) as Record<string, unknown>[];
  const loop = program.find((n) => n["kind"] === "loop") as Record<string, unknown>;
  const body = loop["body"] as Record<string, unknown>[];
  const mine = body.find((n) => n["macro"] === "mine-at-belt") as Record<string, unknown>;
  (mine["args"] as Record<string, unknown>)["belt"] = {
    kind: "belt",
    belt: {
      mode: "chosen",
      ref: {
        entity: "belt",
        id: 40000001,
        name: "Test System VI - Asteroid Belt 1",
        systemName: "Test System",
      },
    },
  };
  doc["program"] = program;

  const { doc: decoded, warnings } = mustAccept(decodeScriptValue(doc));
  assert.deepStrictEqual([...warnings], [], "an old document must not be warned about");
  const decodedLoop = decoded.program.find((n) => n.kind === "loop");
  assert.ok(decodedLoop !== undefined && decodedLoop.kind === "loop");
  const step = decodedLoop.body.find((n) => n.kind === "macro" && n.macro === "mine-at-belt");
  assert.ok(step !== undefined && step.kind === "macro");
  const arg = step.args["belt"];
  assert.ok(arg !== undefined && arg.kind === "belt" && arg.belt.mode === "chosen");
  // The NAME is the part the editor shows and the runtime matches on, so it is
  // the part that has to survive.
  assert.equal(arg.belt.ref.name, "Test System VI - Asteroid Belt 1");
  // And the document is not blocked for having the two dead fields on it.
  assert.deepStrictEqual(
    validateScript(decoded).filter((p) => p.severity === "blocking"),
    [],
    "an old set-belt bot cannot be opened only to be refused",
  );
});

test("a SYSTEM destination keeps its own entity; a belt in that slot is refused", () => {
  const doc = everyArgKind();
  const round = mustAccept(decodeScriptText(encodeScriptDoc(doc))).doc;
  const dest = round.program.find((n) => n.kind === "macro" && n.macro === "set-destination");
  assert.ok(dest !== undefined && dest.kind === "macro");
  const arg = dest.args["destination"];
  assert.ok(arg !== undefined && arg.kind === "destination");
  assert.equal(arg.ref.entity, "system", "a system destination must not come back as a station");
  assert.equal(arg.ref.id, 30000142);

  // The slot takes a station or a system and nothing else.
  const withBelt = JSON.parse(encodeScriptDoc(doc)) as Record<string, unknown>;
  const program = structuredClone(withBelt["program"]) as Record<string, unknown>[];
  const node = program.find((n) => n["macro"] === "set-destination") as Record<string, unknown>;
  node["args"] = { destination: { kind: "destination", ref: { entity: "belt", id: 40001, name: "Belt", systemName: null } } };
  withBelt["program"] = program;
  const refused = decodeScriptValue(withBelt);
  assert.equal(refused.ok, false, "a belt is not somewhere the autopilot can be sent");
});

test("a travel-to-system slot takes SYSTEMS ONLY — a station in it is refused", () => {
  // The narrower twin of the destination slot above. This block has no way to
  // dock, so a station here would be a trip it could never make; the codec is
  // where that is settled, because only the codec sees a hand-edited file.
  const doc = everyArgKind();
  const round = mustAccept(decodeScriptText(encodeScriptDoc(doc))).doc;
  const trip = round.program.find((n) => n.kind === "macro" && n.macro === "travel-to-system");
  assert.ok(trip !== undefined && trip.kind === "macro");
  const arg = trip.args["system"];
  assert.ok(arg !== undefined && arg.kind === "system");
  assert.equal(arg.ref.entity, "system");
  assert.equal(arg.ref.id, 30000144);

  for (const entity of ["station", "belt", "agent"] as const) {
    const edited = JSON.parse(encodeScriptDoc(doc)) as Record<string, unknown>;
    const program = structuredClone(edited["program"]) as Record<string, unknown>[];
    const node = program.find((n) => n["macro"] === "travel-to-system") as Record<string, unknown>;
    node["args"] = { system: { kind: "system", ref: { entity, id: 60000004, name: "Somewhere", systemName: null } } };
    edited["program"] = program;
    assert.equal(decodeScriptValue(edited).ok, false, `a ${entity} is not a solar system`);
  }
});

test("a fleet name round-trips verbatim, and never carries a newline through", () => {
  // The name is matched against a live advert at run time, so every character of
  // it matters: a codec that quietly trimmed or case-folded here would make the
  // saved script and the block disagree about what it is looking for.
  const doc = everyArgKind();
  const round = mustAccept(decodeScriptText(encodeScriptDoc(doc))).doc;
  const join = round.program.find((n) => n.kind === "macro" && n.macro === "join-advertised-fleet");
  assert.ok(join !== undefined && join.kind === "macro");
  const arg = join.args["fleetName"];
  assert.ok(arg !== undefined && arg.kind === "text");
  assert.equal(arg.text, "Mining Op");

  // A hand-edited file cannot smuggle a line break into a fleet name.
  const edited = JSON.parse(encodeScriptDoc(doc)) as Record<string, unknown>;
  const program = structuredClone(edited["program"]) as Record<string, unknown>[];
  const node = program.find((n) => n["macro"] === "join-advertised-fleet") as Record<string, unknown>;
  const NEWLINE = String.fromCharCode(10);
  node["args"] = { fleetName: { kind: "text", text: `Mining${NEWLINE}Op` } };
  edited["program"] = program;
  const decoded = decodeScriptValue(edited);
  if (decoded.ok) {
    const step = decoded.doc.program.find((n) => n.kind === "macro" && n.macro === "join-advertised-fleet");
    assert.ok(step !== undefined && step.kind === "macro");
    const cleaned = step.args["fleetName"];
    assert.ok(cleaned !== undefined && cleaned.kind === "text");
    assert.ok(!cleaned.text.includes(NEWLINE), "a newline must not survive into a fleet name");
  }
});

test("the current watch kinds round-trip", () => {
  const doc: BotScript = {
    format: SCRIPT_FORMAT,
    version: SCRIPT_VERSION,
    name: "Watches",
    notes: "",
    home: { entity: "station", id: null, name: null, systemName: null, starting: true },
    interrupts: [
      { id: "w1", when: { kind: "health-below", fraction: 0.5 }, respond: "dock-and-pause" },
      { id: "w2", when: { kind: "targeted-by-player" }, respond: "alert" },
      { id: "w3", when: { kind: "drone-health-below", fraction: 0.4 }, respond: "pause" },
      { id: "w4", when: { kind: "cargo-full", fraction: 0.85 }, respond: "pause" },
    ],
    program: [{ id: "s1", kind: "macro", macro: "undock", args: {} }],
  };
  const round = mustAccept(decodeScriptText(encodeScriptDoc(doc))).doc;
  assert.deepStrictEqual(round, doc);
});

test("an interrupt-only condition is refused as a step's stop-when", () => {
  const bad = {
    format: SCRIPT_FORMAT,
    version: SCRIPT_VERSION,
    name: "Bad",
    notes: "",
    home: { entity: "station", id: null, name: null, systemName: null, starting: true },
    interrupts: [{ id: "w1", when: { kind: "health-below", fraction: 0.5 }, respond: "dock-and-pause" }],
    program: [{ id: "s1", kind: "macro", macro: "undock", args: {}, until: { kind: "targeted-by-player" } }],
  };
  assert.equal(decodeScriptValue(bad).ok, false);
});

test("encode then decode round-trips EVERY arg kind losslessly", () => {
  const text = encodeScriptDoc(everyArgKind());
  const { doc, warnings } = mustAccept(decodeScriptText(text));
  assert.deepStrictEqual(doc, everyArgKind());
  assert.deepStrictEqual([...warnings], []);
});

test("retired web-companion constructs are refused rather than stripped", () => {
  for (const macro of ["attack-player", "hunt-player", "send-chat", "fleet-mine", "mining-support"]) {
    const legacy = clone();
    legacy.program = [{ id: `legacy-${macro}`, kind: "macro", macro, args: {} }];
    assert.equal(
      mustRefuse(decodeScriptValue(legacy)),
      `This script uses "${macro}", which is no longer available in the web companion.`,
    );
  }

  const legacyCondition = clone();
  legacyCondition.interrupts.push({
    id: "legacy-local-watch",
    when: { kind: "players-in-system-above", count: 0 },
    respond: "alert",
  });
  assert.equal(
    mustRefuse(decodeScriptValue(legacyCondition)),
    "This script uses \"players-in-system-above\", which is no longer available in the web companion.",
  );
});

test("a valid branch decodes; nested / all-empty / off-site branches are refused", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base = (): any => ({
    format: "evejs-bot-script",
    version: 1,
    name: "B",
    notes: "",
    home: { entity: "station", id: 1, name: "H", systemName: null },
    interrupts: [],
    program: [
      {
        id: "br",
        kind: "branch",
        when: { kind: "shield-below", fraction: 0.5 },
        then: [{ id: "t", kind: "macro", macro: "undock", args: {} }],
        else: [{ id: "e", kind: "macro", macro: "refine-ore", args: {} }],
      },
    ],
  });
  mustAccept(decodeScriptValue(base()));

  const nested = base(); // a branch inside a branch side — one level only
  nested.program[0].then[0] = { id: "n", kind: "branch", when: { kind: "shield-below", fraction: 0.5 }, then: [{ id: "x", kind: "macro", macro: "undock", args: {} }], else: [] };
  mustRefuse(decodeScriptValue(nested));

  const bothEmpty = base();
  bothEmpty.program[0].then = [];
  bothEmpty.program[0].else = [];
  mustRefuse(decodeScriptValue(bothEmpty));

  const offSite = base(); // hostile-on-grid is a grid read — never a branch's `when`
  offSite.program[0].when = { kind: "hostile-on-grid" };
  mustRefuse(decodeScriptValue(offSite));
});

test("a branch INSIDE a loop decodes and round-trips; a loop inside one is refused", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const withLoopBranch = (): any => ({
    format: "evejs-bot-script",
    version: 1,
    name: "Loop fork",
    notes: "",
    home: { entity: "station", id: null, name: null, systemName: null, starting: true },
    interrupts: [],
    program: [
      {
        id: "L",
        kind: "loop",
        repeat: { kind: "forever" },
        body: [
          { id: "s", kind: "macro", macro: "undock", args: {} },
          {
            id: "br",
            kind: "branch",
            when: { kind: "hold-empty" },
            then: [{ id: "t", kind: "macro", macro: "refine-ore", args: {} }],
            else: [{ id: "e", kind: "macro", macro: "unload-cargo", args: {} }],
          },
        ],
      },
    ],
  });
  const { doc } = mustAccept(decodeScriptValue(withLoopBranch()));
  const loop = doc.program[0];
  assert.ok(loop && loop.kind === "loop");
  assert.equal(loop.body[1]?.kind, "branch", "the branch survives inside the loop body");
  // And it round-trips through the text encoder unchanged.
  const again = mustAccept(decodeScriptText(encodeScriptDoc(doc)));
  assert.deepStrictEqual(again.doc, doc);

  // A LOOP nested in a loop body is still refused (only branches may nest).
  const nestedLoop = withLoopBranch();
  nestedLoop.program[0].body[1] = { id: "n", kind: "loop", repeat: { kind: "forever" }, body: [{ id: "x", kind: "macro", macro: "undock", args: {} }] };
  mustRefuse(decodeScriptValue(nestedLoop));
});

test("a named board slot round-trips; an unknown slot name is refused", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const withSlot = (): any => ({
    format: "evejs-bot-script",
    version: 1,
    name: "Slots",
    notes: "",
    home: { entity: "station", id: null, name: null, systemName: null, starting: true },
    interrupts: [],
    program: [
      {
        id: "t",
        kind: "macro",
        macro: "travel-to-station",
        args: { station: { kind: "station", ref: { entity: "station", id: null, name: null, systemName: null, slot: "dropoff-station" } } },
      },
    ],
  });
  const { doc } = mustAccept(decodeScriptValue(withSlot()));
  const step = doc.program[0];
  assert.ok(step && step.kind === "macro");
  const arg = step.args["station"];
  assert.ok(arg && arg.kind === "station");
  assert.equal(arg.ref.slot, "dropoff-station");
  assert.deepStrictEqual(mustAccept(decodeScriptText(encodeScriptDoc(doc))).doc, doc);

  const bogus = withSlot();
  bogus.program[0].args.station.ref.slot = "wherever";
  mustRefuse(decodeScriptValue(bogus));
});

test("encoded output is stable and pretty-printed", () => {
  assert.equal(encodeScriptDoc(golden()), encodeScriptDoc(golden()));
  assert.match(encodeScriptDoc(golden()), /\n {2}"format": "evejs-bot-script"/);
});

// ─── Transport-level refusals (before the shape is even read) ─────────────────

test("an oversized file is refused before it is parsed", () => {
  const huge = "x".repeat(MAX_DOC_BYTES + 1);
  assert.match(mustRefuse(decodeScriptText(huge)), /too big/i);
});

test("text that is not JSON is refused", () => {
  assert.match(mustRefuse(decodeScriptText("{ not json")), /not a bot script/i);
});

test("a non-object top level is refused", () => {
  assert.equal(decodeScriptValue([]).ok, false);
  assert.equal(decodeScriptValue(5).ok, false);
  assert.equal(decodeScriptValue(null).ok, false);
});

// ─── Envelope refusals ───────────────────────────────────────────────────────

test("the wrong format tag is refused", () => {
  const bad = { ...clone(), format: "something-else" } as unknown;
  assert.match(mustRefuse(decodeScriptValue(bad)), /not a bot script/i);
});

test("a newer version is refused with the update sentence", () => {
  const bad = { ...clone(), version: SCRIPT_VERSION + 998 } as unknown;
  assert.match(mustRefuse(decodeScriptValue(bad)), /newer version/i);
});

test("a non-integer version is refused", () => {
  assert.equal(decodeScriptValue({ ...clone(), version: 0 }).ok, false);
  assert.equal(decodeScriptValue({ ...clone(), version: 1.5 }).ok, false);
  assert.equal(decodeScriptValue({ ...clone(), version: "1" }).ok, false);
});

test("an unknown top-level key is refused", () => {
  const bad = { ...clone(), surprise: true } as unknown;
  assert.match(mustRefuse(decodeScriptValue(bad)), /does not recognise/i);
});

test("a missing name is refused; an empty program is refused", () => {
  const noName = clone() as Record<string, unknown>;
  delete noName["name"];
  assert.equal(decodeScriptValue(noName).ok, false);

  const empty = { ...clone(), program: [] } as unknown;
  assert.match(mustRefuse(decodeScriptValue(empty)), /no steps/i);
});

// ─── Prototype pollution ─────────────────────────────────────────────────────

test("a __proto__ key is treated as an unknown key and pollutes nothing", () => {
  const text =
    '{"format":"evejs-bot-script","version":1,"__proto__":{"polluted":true},' +
    '"name":"x","notes":"","home":{"entity":"station","id":1,"name":null,"systemName":null},' +
    '"interrupts":[],"program":[{"id":"s1","kind":"macro","macro":"undock","args":{}}]}';
  assert.equal(decodeScriptText(text).ok, false);
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
});

// ─── Program-shape refusals ──────────────────────────────────────────────────

test("an unknown macro is refused, and the echoed name is sanitised", () => {
  const bad = clone();
  const loop = bad.program[0];
  assert.ok(loop && loop.kind === "loop");
  const step = loop.body[0] as Record<string, unknown>;
  // A hostile macro name carrying a bidi override and HTML-ish junk.
  step["macro"] = "mine‮evil<script>alert";
  const refusal = mustRefuse(decodeScriptValue(bad));
  assert.match(refusal, /does not have/i);
  assert.match(refusal, /mineevil/i, "the safe token survives");
  assert.doesNotMatch(refusal, /[<>‮]/, "no hostile characters reach the sentence");
});

test("an unknown condition kind is refused", () => {
  const bad = clone();
  const loop = bad.program[0];
  assert.ok(loop && loop.kind === "loop");
  (loop.body[0] as Record<string, unknown>)["until"] = { kind: "moon-is-full" };
  assert.match(mustRefuse(decodeScriptValue(bad)), /does not have/i);
});

test("a grid-only condition in an until is refused (the belt-empty class)", () => {
  const bad = clone();
  const loop = bad.program[0];
  assert.ok(loop && loop.kind === "loop");
  (loop.body[0] as Record<string, unknown>)["until"] = { kind: "hostile-on-grid" };
  assert.match(mustRefuse(decodeScriptValue(bad)), /out in space/i);
});

test("a mining step with no until is refused", () => {
  const bad = clone();
  const loop = bad.program[0];
  assert.ok(loop && loop.kind === "loop");
  delete (loop.body[0] as Record<string, unknown>)["until"];
  assert.match(mustRefuse(decodeScriptValue(bad)), /when to stop/i);
});

test("a missing required argument is refused; an unknown argument key is refused", () => {
  const noBelt = clone();
  let loop = noBelt.program[0];
  assert.ok(loop && loop.kind === "loop");
  delete (loop.body[0] as { args: Record<string, unknown> }).args["belt"];
  assert.match(mustRefuse(decodeScriptValue(noBelt)), /missing something/i);

  const strayArg = clone();
  loop = strayArg.program[0];
  assert.ok(loop && loop.kind === "loop");
  (loop.body[0] as { args: Record<string, unknown> }).args["gadget"] = { kind: "belt", belt: { mode: "nearest" } };
  assert.match(mustRefuse(decodeScriptValue(strayArg)), /does not recognise/i);
});

test("a loop with no repeat, an empty loop, and a nested loop are each refused", () => {
  const noRepeat = clone();
  delete (noRepeat.program[0] as Record<string, unknown>)["repeat"];
  assert.match(mustRefuse(decodeScriptValue(noRepeat)), /how many times/i);

  const emptyLoop = clone();
  (emptyLoop.program[0] as { body: unknown[] }).body = [];
  assert.match(mustRefuse(decodeScriptValue(emptyLoop)), /no steps inside/i);

  const nested = clone();
  (nested.program[0] as { body: unknown[] }).body = [
    { id: "n1", kind: "loop", repeat: { kind: "forever" }, body: [{ id: "n2", kind: "macro", macro: "undock", args: {} }] },
  ];
  assert.match(mustRefuse(decodeScriptValue(nested)), /cannot contain another loop/i);
});

test("too many nodes and too many steps are refused", () => {
  const step = { kind: "macro", macro: "undock", args: {} };
  const manyNodes = { ...clone(), program: Array.from({ length: 33 }, (_, i) => ({ id: `s${i}`, ...step })) } as unknown;
  assert.match(mustRefuse(decodeScriptValue(manyNodes)), /too many steps/i);

  const bigBody = Array.from({ length: 65 }, (_, i) => ({ id: `b${i}`, ...step }));
  const manySteps = {
    ...clone(),
    program: [{ id: "loop", kind: "loop", repeat: { kind: "forever" }, body: bigBody }],
  } as unknown;
  assert.match(mustRefuse(decodeScriptValue(manySteps)), /too many steps/i);
});

// ─── Numbers: clamp with a spoken warning, or refuse the truly broken ─────────

test("an out-of-range ore-hold fraction is clamped to 90% with a warning", () => {
  const bad = clone();
  const loop = bad.program[0];
  assert.ok(loop && loop.kind === "loop");
  (loop.body[0] as { until: { fraction: number } }).until.fraction = 2.4;
  const { doc, warnings } = mustAccept(decodeScriptValue(bad));
  const outLoop = doc.program[0];
  assert.ok(outLoop && outLoop.kind === "loop");
  const first = outLoop.body[0];
  assert.ok(first && first.kind === "macro");
  const until = first.until;
  assert.ok(until && until.kind === "ore-hold-at-least");
  assert.equal(until.fraction, 0.9);
  assert.ok(warnings.some((w) => /brought back to 90%/i.test(w)));
});

test("a shield threshold below the floor is clamped up to 5%", () => {
  const bad = clone();
  bad.interrupts[1] = { id: "i1", when: { kind: "shield-below", fraction: -3 }, respond: "dock-and-pause" };
  const { doc, warnings } = mustAccept(decodeScriptValue(bad));
  const row = doc.interrupts[1];
  assert.ok(row && row.when.kind === "shield-below");
  assert.equal(row.when.fraction, 0.05);
  assert.ok(warnings.some((w) => /brought back to 5%/i.test(w)));
});

test("an out-of-range repeat count is clamped into range with a warning", () => {
  const bad = clone();
  (bad.program[0] as { repeat: { kind: "times"; count: number } }).repeat.count = 9999;
  const { doc, warnings } = mustAccept(decodeScriptValue(bad));
  const loop = doc.program[0];
  assert.ok(loop && loop.kind === "loop" && loop.repeat.kind === "times");
  assert.equal(loop.repeat.count, 500);
  assert.ok(warnings.some((w) => /into range/i.test(w)));
});

test("Infinity (from 1e999) is refused as not a real number", () => {
  const text = encodeScriptDoc(golden()).replace('"fraction": 0.9', '"fraction": 1e999');
  assert.match(mustRefuse(decodeScriptText(text)), /not a real number/i);
});

// ─── World references ────────────────────────────────────────────────────────

test("an absurd world id is forgotten (nulled) with a warning, not a crash", () => {
  const bad = clone();
  bad.home = { entity: "station", id: -5, name: "Home", systemName: "Aunia" };
  const { doc, warnings } = mustAccept(decodeScriptValue(bad));
  assert.equal(doc.home.id, null);
  assert.equal(doc.home.name, "Home");
  assert.ok(warnings.some((w) => /forgotten/i.test(w)));
});

// ─── Control characters ──────────────────────────────────────────────────────

test("bidi and control characters are stripped from a name with a warning", () => {
  const bad = { ...clone(), name: "Belt‮runner" } as unknown;
  const { doc, warnings } = mustAccept(decodeScriptValue(bad));
  assert.equal(doc.name, "Beltrunner");
  assert.ok(warnings.some((w) => /cannot be shown/i.test(w)));
});

// ─── Interrupts are the player's now ─────────────────────────────────────────

test("interrupts are read exactly as given — no floor is injected", () => {
  const bad = clone();
  bad.interrupts = [
    { id: "w1", when: { kind: "shield-below", fraction: 0.3 }, respond: "dock-and-pause" },
    { id: "w2", when: { kind: "armor-below", fraction: 0.4 }, respond: "dock-and-pause" },
  ];
  const { doc, warnings } = mustAccept(decodeScriptValue(bad));
  assert.equal(doc.interrupts.length, 2, "nothing added, nothing dropped");
  assert.deepEqual(doc.interrupts.map((r) => r.when.kind), ["shield-below", "armor-below"]);
  assert.deepEqual([...warnings], []);
});

test("an old document's legacy builtIn flag still loads, and is simply dropped", () => {
  // Old saved bots may carry the retired auto-injected safety-floor flag. The
  // codec must still LOAD such a document (no import-with-holes refusal for a
  // key that no longer means anything) — it just drops the flag rather than
  // preserving it, since nothing in the current format reads it any more.
  const bad = clone();
  bad.interrupts = [
    { id: "w1", when: { kind: "health-below", fraction: 0.5 }, respond: "dock-and-pause" },
  ];
  const { doc, warnings } = mustAccept(decodeScriptValue(bad));
  assert.equal(doc.interrupts.length, 1);
  assert.deepEqual(doc.interrupts[0], {
    id: "w1",
    when: { kind: "health-below", fraction: 0.5 },
    respond: "dock-and-pause",
  });
  assert.ok(!("builtIn" in doc.interrupts[0]), "the flag does not survive into the loaded document");
  assert.deepEqual([...warnings], []);

  // And a re-export never writes the retired key back out.
  const text = encodeScriptDoc(doc);
  assert.doesNotMatch(text, /builtIn/);
});

test("an empty interrupt list stays empty", () => {
  const bad = { ...clone(), interrupts: [] } as unknown;
  const { doc } = mustAccept(decodeScriptValue(bad));
  assert.equal(doc.interrupts.length, 0);
});

// ─── Ids ─────────────────────────────────────────────────────────────────────

test("duplicate or missing ids are reassigned to unique handles, with a warning", () => {
  const bad = clone();
  const loop = bad.program[0];
  assert.ok(loop && loop.kind === "loop");
  (loop.body[1] as { id: string }).id = "s2"; // collide with body[0]
  const { doc, warnings } = mustAccept(decodeScriptValue(bad));
  const ids: string[] = [];
  for (const row of doc.interrupts) ids.push(row.id);
  for (const node of doc.program) {
    ids.push(node.id);
    if (node.kind === "loop") for (const s of node.body) ids.push(s.id);
  }
  assert.equal(new Set(ids).size, ids.length, "all ids unique after fix");
  assert.ok(warnings.some((w) => /Renamed some step handles/i.test(w)));
});

// ─── Parity: stored bytes are as untrusted as a paste ────────────────────────

test("decodeScriptValue and decodeScriptText agree on a clean document", () => {
  const fromValue = mustAccept(decodeScriptValue(golden()));
  const fromText = mustAccept(decodeScriptText(encodeScriptDoc(golden())));
  assert.deepStrictEqual(fromValue.doc, fromText.doc);
});

// ─── Ore priority list ───────────────────────────────────────────────────────

/** The golden document's mine step, narrowed the way tsc can follow (a throw, not assert.ok). */
function mineStepOf(doc: BotScript) {
  const loop = doc.program[0];
  if (loop === undefined || loop.kind !== "loop") throw new Error("fixture: first node is not a loop");
  const mine = loop.body[0];
  if (mine === undefined || mine.kind !== "macro") throw new Error("fixture: first step is not a macro");
  return { loop, mine };
}

function withOreList(ores: readonly { groupID: number; name: string }[]): BotScript {
  const doc = clone() as BotScript;
  const { loop, mine } = mineStepOf(doc);
  return {
    ...doc,
    program: [
      {
        ...loop,
        body: [
          {
            ...mine,
            args: { ...mine.args, ores: { kind: "oreList", ores } },
          },
          ...loop.body.slice(1),
        ],
      },
    ],
  };
}

test("an ore priority list round-trips through encode/decode with no warnings", () => {
  const doc = withOreList([
    { groupID: 462, name: "Veldspar" },
    { groupID: 465, name: "Kernite" },
  ]);
  const { doc: round, warnings } = mustAccept(decodeScriptText(encodeScriptDoc(doc)));
  assert.deepStrictEqual(round, doc);
  assert.deepStrictEqual([...warnings], []);
});

test("an empty ore priority list is valid (any rock)", () => {
  const doc = withOreList([]);
  const { doc: round, warnings } = mustAccept(decodeScriptValue(doc));
  const { mine } = mineStepOf(round);
  const ores = mine.args["ores"];
  assert.ok(ores !== undefined && ores.kind === "oreList");
  assert.deepStrictEqual(ores.ores, []);
  assert.deepStrictEqual([...warnings], []);
});

test("a duplicate groupID in an ore priority list is dropped, keeping the first, with a warning", () => {
  const doc = withOreList([
    { groupID: 462, name: "Veldspar" },
    { groupID: 465, name: "Kernite" },
    { groupID: 462, name: "Veldspar (dup)" },
  ]);
  const { doc: round, warnings } = mustAccept(decodeScriptValue(doc));
  const { mine } = mineStepOf(round);
  const ores = mine.args["ores"];
  assert.ok(ores !== undefined && ores.kind === "oreList");
  assert.deepStrictEqual(ores.ores, [
    { groupID: 462, name: "Veldspar" },
    { groupID: 465, name: "Kernite" },
  ]);
  assert.ok(warnings.some((w) => /repeated entries/i.test(w)));
});

test("an ore priority list over MAX_ORE_LIST is truncated, not refused, with a warning", () => {
  const many = Array.from({ length: MAX_ORE_LIST + 5 }, (_, i) => ({ groupID: 1000 + i, name: `Ore ${i}` }));
  const doc = withOreList(many);
  const { doc: round, warnings } = mustAccept(decodeScriptValue(doc));
  const { mine } = mineStepOf(round);
  const ores = mine.args["ores"];
  assert.ok(ores !== undefined && ores.kind === "oreList");
  assert.equal(ores.ores.length, MAX_ORE_LIST);
  assert.deepStrictEqual(ores.ores, many.slice(0, MAX_ORE_LIST));
  assert.ok(warnings.some((w) => /cut down/i.test(w)));
});

test("a malformed ore priority list entry refuses the whole document", () => {
  // Missing groupID.
  const badMissingGroup = clone();
  const loopA = badMissingGroup.program[0];
  loopA.body[0].args["ores"] = { kind: "oreList", ores: [{ name: "Veldspar" }] };
  assert.equal(decodeScriptValue(badMissingGroup).ok, false, "an entry with no groupID must refuse");

  // Non-integer groupID.
  const badGroupType = clone();
  const loopB = badGroupType.program[0];
  loopB.body[0].args["ores"] = { kind: "oreList", ores: [{ groupID: "462", name: "Veldspar" }] };
  assert.equal(decodeScriptValue(badGroupType).ok, false, "a non-numeric groupID must refuse");

  // Negative groupID.
  const badGroupNeg = clone();
  const loopC = badGroupNeg.program[0];
  loopC.body[0].args["ores"] = { kind: "oreList", ores: [{ groupID: -1, name: "Veldspar" }] };
  assert.equal(decodeScriptValue(badGroupNeg).ok, false, "a non-positive groupID must refuse");

  // `ores` not an array.
  const badShape = clone();
  const loopD = badShape.program[0];
  loopD.body[0].args["ores"] = { kind: "oreList", ores: "not-an-array" };
  assert.equal(decodeScriptValue(badShape).ok, false, "ores must be an array");

  // Non-string name.
  const badName = clone();
  const loopE = badName.program[0];
  loopE.body[0].args["ores"] = { kind: "oreList", ores: [{ groupID: 462, name: 123 }] };
  assert.equal(decodeScriptValue(badName).ok, false, "a non-string name must refuse");
});

// ─── Target priority (a ranking, over a closed vocabulary) ───────────────────

function withTargetList(classes: unknown): any {
  const doc = clone();
  doc.program.push({
    id: "s9",
    kind: "macro",
    macro: "fight-the-rats",
    args: { targets: { kind: "targetList", classes } },
  });
  return doc;
}

function targetsOf(doc: BotScript): unknown {
  const step = doc.program[doc.program.length - 1];
  if (step === undefined || step.kind !== "macro") throw new Error("fixture: last node is not a macro");
  return step.args["targets"];
}

test("a target priority list round-trips through encode/decode with no warnings", () => {
  const doc = withTargetList(["tackle", "logi"]) as BotScript;
  const { doc: round, warnings } = mustAccept(decodeScriptText(encodeScriptDoc(doc)));
  assert.deepStrictEqual(round, doc);
  assert.deepStrictEqual([...warnings], []);
});

test("a class this app does not know is dropped, with a spoken warning", () => {
  const { doc, warnings } = mustAccept(decodeScriptValue(withTargetList(["tackle", "capitals", "logi"])));
  assert.deepStrictEqual(targetsOf(doc), { kind: "targetList", classes: ["tackle", "logi"] });
  assert.ok(warnings.some((w) => /kinds of target/i.test(w)), warnings.join(" | "));
});

test("a class named twice is one rung, not two", () => {
  const { doc, warnings } = mustAccept(decodeScriptValue(withTargetList(["tackle", "tackle", "other"])));
  assert.deepStrictEqual(targetsOf(doc), { kind: "targetList", classes: ["tackle", "other"] });
  assert.deepStrictEqual([...warnings], [], "a repeat is tidied silently — nothing was lost");
});

test("an empty target priority list is valid (the shipped ladder)", () => {
  const { doc } = mustAccept(decodeScriptValue(withTargetList([])));
  assert.deepStrictEqual(targetsOf(doc), { kind: "targetList", classes: [] });
});

test("a target priority list that is not a list of words is refused", () => {
  assert.match(mustRefuse(decodeScriptValue(withTargetList("tackle"))), /not set up correctly/i);
  assert.match(mustRefuse(decodeScriptValue(withTargetList([{ cls: "tackle" }]))), /not set up correctly/i);
});

// ─── Which sites a site-warp block may fly to (issue 182) ────────────────────

function withSiteList(sites: unknown): any {
  const doc = clone();
  doc.program.push({ id: "s9", kind: "macro", macro: "warp-to-anomaly", args: { sites } });
  return doc;
}

function sitesOf(doc: BotScript): unknown {
  const step = doc.program[doc.program.length - 1];
  if (step === undefined || step.kind !== "macro") throw new Error("fixture: last node is not a macro");
  return step.args["sites"];
}

test("a site list round-trips through encode/decode with no warnings, in both modes", () => {
  for (const mode of ["only", "skip"]) {
    const doc = withSiteList({ kind: "siteList", mode, names: ["Haven", "Forsaken Sanctum"] }) as BotScript;
    const { doc: round, warnings } = mustAccept(decodeScriptText(encodeScriptDoc(doc)));
    assert.deepStrictEqual(round, doc, mode);
    assert.deepStrictEqual([...warnings], [], mode);
  }
});

test("a site list drops blank names and repeats, compared ignoring case", () => {
  const { doc } = mustAccept(decodeScriptValue(withSiteList({ kind: "siteList", mode: "only", names: ["Haven", " ", "haven", " Den "] })));
  assert.deepStrictEqual(sitesOf(doc), { kind: "siteList", mode: "only", names: ["Haven", "Den"] });
});

test("a site list whose mode is not only or skip is refused, never guessed", () => {
  assert.match(mustRefuse(decodeScriptValue(withSiteList({ kind: "siteList", mode: "sometimes", names: ["Den"] }))), /not set up correctly/i);
  assert.match(mustRefuse(decodeScriptValue(withSiteList({ kind: "siteList", mode: "only", names: "Den" }))), /not set up correctly/i);
});

test("a site list past the cap is cut down, and says so", () => {
  const names = Array.from({ length: 15 }, (_, i) => `Site ${i}`);
  const { doc, warnings } = mustAccept(decodeScriptValue(withSiteList({ kind: "siteList", mode: "skip", names })));
  assert.equal((sitesOf(doc) as { names: string[] }).names.length, 12);
  assert.ok(warnings.some((w) => /site list was cut down to 12/i.test(w)), warnings.join(" | "));
});

// ─── Flying with the fleet (a closed vocabulary of three) ────────────────────

function withSquadRole(role: unknown): any {
  const doc = clone();
  doc.program.push({
    id: "s9",
    kind: "macro",
    macro: "fight-the-rats",
    args: { squad: { kind: "squadRole", role } },
  });
  return doc;
}

test("a fleet-fire role round-trips through encode/decode with no warnings", () => {
  for (const role of ["off", "call", "follow"]) {
    const doc = withSquadRole(role);
    const { doc: round, warnings } = mustAccept(decodeScriptText(encodeScriptDoc(doc)));
    assert.deepStrictEqual(round, doc, role);
    assert.deepStrictEqual([...warnings], []);
  }
});

test("a fleet-fire role this app does not know refuses the file", () => {
  assert.match(mustRefuse(decodeScriptValue(withSquadRole("boss"))), /not set up correctly/i);
  assert.match(mustRefuse(decodeScriptValue(withSquadRole(2))), /not set up correctly/i);
});

// ─── A watch that fights carries the same two combat settings ───────────────

function withWatch(row: any): any {
  const doc = clone();
  doc.interrupts.push(row);
  return doc;
}

function lastWatch(doc: BotScript): any {
  return doc.interrupts[doc.interrupts.length - 1];
}

test("a fight-back watch round-trips its fleet role and target order", () => {
  const doc = withWatch({ id: "w9", when: { kind: "hostile-on-grid" }, respond: "fight-back", squad: "call", targets: ["tackle", "logi"] }) as BotScript;
  const { doc: round, warnings } = mustAccept(decodeScriptText(encodeScriptDoc(doc)));
  assert.deepStrictEqual(round, doc);
  assert.deepStrictEqual([...warnings], []);
});

test("a watch left at the shipped ladder writes no settings at all", () => {
  const doc = withWatch({ id: "w9", when: { kind: "hostile-on-grid" }, respond: "fight-back" }) as BotScript;
  const { doc: round } = mustAccept(decodeScriptText(encodeScriptDoc(doc)));
  assert.deepStrictEqual(Object.keys(lastWatch(round)).sort(), ["id", "respond", "when"]);
});

test("combat settings on a watch that does not fight are dropped, with a warning", () => {
  const { doc, warnings } = mustAccept(
    decodeScriptValue(withWatch({ id: "w9", when: { kind: "hostile-on-grid" }, respond: "dock-and-pause", squad: "call", targets: ["tackle"] })),
  );
  assert.deepStrictEqual(Object.keys(lastWatch(doc)).sort(), ["id", "respond", "when"]);
  assert.ok(warnings.some((w) => /does not fight/i.test(w)), warnings.join(" | "));
});

test("a fleet role this app does not know refuses the file", () => {
  assert.match(
    mustRefuse(decodeScriptValue(withWatch({ id: "w9", when: { kind: "hostile-on-grid" }, respond: "fight-back", squad: "boss" }))),
    /does not know/i,
  );
});

test("a tackled watch round-trips as a bare, argument-free check", () => {
  const doc = withWatch({ id: "w9", when: { kind: "tackled" }, respond: "fight-back" }) as BotScript;
  const { doc: round, warnings } = mustAccept(decodeScriptText(encodeScriptDoc(doc)));
  assert.deepStrictEqual(round, doc);
  assert.deepStrictEqual([...warnings], []);
  assert.deepStrictEqual(Object.keys(lastWatch(round).when), ["kind"], "no threshold is invented");
});

test("a tackled check is refused as an until — it is a grid read like the rest", () => {
  const bad = clone();
  const loop = bad.program[0];
  assert.ok(loop && loop.kind === "loop");
  (loop.body[0] as Record<string, unknown>)["until"] = { kind: "tackled" };
  assert.match(mustRefuse(decodeScriptValue(bad)), /out in space/i);
});

test("a near-miss of the tackled kind is REFUSED, never defaulted into it", () => {
  // ⚠ THE PROPERTY THAT MATTERS FOR A SAFETY ROW. A file naming a check this app
  // cannot evaluate must be turned away at the door: decoded to "false" instead,
  // the row would sit in the ladder looking like protection and never fire.
  assert.match(
    mustRefuse(decodeScriptValue(withWatch({ id: "w9", when: { kind: "tackled?" }, respond: "fight-back" }))),
    /does not have/i,
  );
});

test("a target class this app does not know is dropped from a watch, with a warning", () => {
  const { doc, warnings } = mustAccept(
    decodeScriptValue(withWatch({ id: "w9", when: { kind: "hostile-on-grid" }, respond: "fight-back", targets: ["tackle", "capitals"] })),
  );
  assert.deepStrictEqual(lastWatch(doc).targets, ["tackle"]);
  assert.ok(warnings.some((w) => /kinds of target/i.test(w)), warnings.join(" | "));
});

test("every ITEM MATCH survives a round trip — a pattern must never come back as a group", () => {
  // ⚠ WHAT THIS PINS. The encoder used to be "type ? … : group", which was
  // total until a third match arrived — at which point a name pattern would
  // have been written out as a group id and read back as one, silently turning
  // "everything called Command Center" into "everything in group NaN".
  const doc: BotScript = {
    format: SCRIPT_FORMAT,
    version: SCRIPT_VERSION,
    name: "Hauler",
    notes: "",
    home: { entity: "station", id: 60000004, name: "Home Station", systemName: "Aunia" },
    interrupts: [],
    program: [
      {
        id: "l1",
        kind: "macro",
        macro: "load-cargo",
        args: {
          items: {
            kind: "itemList",
            items: [
              { match: "type", typeID: 2254, name: "Temperate Command Center" },
              { match: "group", groupID: 1027, name: "items like Temperate Command Center" },
              { match: "name", pattern: "Command Center", name: 'everything matching "Command Center"' },
            ],
          },
          exceptBays: { kind: "bayList", bays: ["ammo"] },
        },
      },
    ],
  };
  const round = mustAccept(decodeScriptText(encodeScriptDoc(doc))).doc;
  const step = round.program[0];
  assert.ok(step !== undefined && step.kind === "macro");
  const arg = step.args["items"];
  assert.ok(arg !== undefined && arg.kind === "itemList");
  assert.deepEqual(arg.items, [
    { match: "type", typeID: 2254, name: "Temperate Command Center" },
    { match: "group", groupID: 1027, name: "items like Temperate Command Center" },
    { match: "name", pattern: "Command Center", name: 'everything matching "Command Center"' },
  ]);
  assert.deepEqual(validateScript(round), [], "a fully-set load step has nothing left to fix");
});

test("a load step with an EMPTY selection is a fixable problem, not a refusal", () => {
  // The list is required, so a step carrying none can only ever load nothing —
  // but a half-made draft must still save and open, like every other unset arg.
  const doc = JSON.parse(encodeScriptDoc(golden())) as Record<string, unknown>;
  doc["program"] = [
    { id: "l1", kind: "macro", macro: "load-cargo", args: { items: { kind: "itemList", items: [] } } },
  ];
  const round = mustAccept(decodeScriptText(JSON.stringify(doc))).doc;
  const problems = validateScript(round);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!.sentence, /Pick what this step loads/);
});
