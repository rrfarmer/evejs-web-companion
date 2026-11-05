// A3 — the sentence register. Two guarantees are pinned: EVERY macro and EVERY
// condition has a plain sentence (the exhaustiveness the compiler enforces, made
// visible), and NO sentence ever renders a world id (R7d).

import test from "node:test";
import assert from "node:assert/strict";

import {
  CONDITION_KINDS,
  INTERRUPT_RESPONSES,
  MACRO_IDS,
  type Condition,
  type ConditionKind,
  type MacroStep,
  type RockPick,
} from "./botScript.ts";
import {
  conditionAdvice,
  conditionSentence,
  interruptSentence,
  macroName,
  repeatSentence,
  responseSentence,
  stepSentence,
} from "./scriptText.ts";

function sampleCondition(kind: ConditionKind): Condition {
  switch (kind) {
    case "ore-hold-at-least":
      return { kind, fraction: 0.9 };
    case "shield-below":
    case "armor-below":
    case "hull-below":
    case "health-below":
    case "capacitor-below":
      return { kind, fraction: 0.3 };
    case "wallet-below":
    case "wallet-above":
      return { kind, isk: 100_000_000 };
    case "cargo-full":
      return { kind, fraction: 0.9 };
    case "drone-health-below":
      return { kind, fraction: 0.4 };
    case "hold-empty":
    case "hostile-on-grid":
    case "targeted-by-player":
    case "tackled":
      return { kind };
  }
}

// A run of five or more digits is almost certainly a rendered id — the thing R7d
// forbids. Percentages (30%) and small counts (50) never trip this.
const LOOKS_LIKE_ID = /\d{5,}/;

test("every macro has a plain name with no numbers in it", () => {
  for (const macro of MACRO_IDS) {
    const name = macroName(macro);
    assert.ok(name.length > 0, `${macro} has no name`);
    assert.doesNotMatch(name, /\d/, `${macro} name should not carry a number`);
  }
});

test("Distribution finder sentence makes default and explicit level policy visible", () => {
  const base: MacroStep = { id: "find", kind: "macro", macro: "find-distribution-agent", args: {} };
  assert.match(stepSentence(base), /level 1.*no lower-level fallback/i);
  assert.match(stepSentence({ ...base, args: { level: { kind: "count", value: 4 },
    fallback: { kind: "toggle", enabled: true } } }), /level 4.*fallback to lower levels/i);
});

test("every condition has a non-empty sentence and never renders an id", () => {
  for (const kind of CONDITION_KINDS) {
    const sentence = conditionSentence(sampleCondition(kind));
    assert.ok(sentence.length > 0, `${kind} has no sentence`);
    assert.doesNotMatch(sentence, LOOKS_LIKE_ID);
  }
});

test("every interrupt response has a non-empty sentence", () => {
  for (const response of INTERRUPT_RESPONSES) {
    assert.ok(responseSentence(response).length > 0, `${response} has no sentence`);
  }
});

test("percentages read with their unit", () => {
  assert.match(conditionSentence({ kind: "shield-below", fraction: 0.3 }), /30%/);
  assert.match(conditionSentence({ kind: "ore-hold-at-least", fraction: 0.9 }), /90%/);
});

test("a repeat reads as forever, once, or a bounded count", () => {
  assert.equal(repeatSentence({ kind: "forever" }), "Repeat forever");
  assert.equal(repeatSentence({ kind: "times", count: 1 }), "Repeat once");
  assert.match(repeatSentence({ kind: "times", count: 50 }), /up to 50 times/);
});

test("an interrupt row reads as a whole sentence", () => {
  const sentence = interruptSentence({
    id: "i1",
    when: { kind: "shield-below", fraction: 0.3 },
    respond: "dock-and-pause",
  });
  assert.match(sentence, /shields drop below 30%/);
  assert.match(sentence, /dock at home and stop/);
});

test("a mining step reads with its belt and its until", () => {
  const step: MacroStep = {
    id: "s1",
    kind: "macro",
    macro: "mine-at-belt",
    args: {
      belt: { kind: "belt", belt: { mode: "nearest" } },
      equipment: { kind: "equipment", equipment: { groupID: 17482, label: "Strip Miners" } },
    },
    until: { kind: "ore-hold-at-least", fraction: 0.9 },
  };
  const sentence = stepSentence(step);
  assert.match(sentence, /Mine at the nearest belt/);
  assert.match(sentence, /until the ore hold is 90% full/);
});

// ⚠ THIS IS THE REGRESSION TEST FOR THE 2026-09-19 RUN. `BeltArg`'s "site"
// mode exists because "nearest" toured the system's asteroid BELTS the moment
// a mining bot's anomaly ran dry, contradicting a blurb that promised ore
// sites — so the one thing these sentences must never do is say "belt".

test("a site-mode mining step never says the word belt", () => {
  const step: MacroStep = {
    id: "s1",
    kind: "macro",
    macro: "mine-at-belt",
    args: { belt: { kind: "belt", belt: { mode: "site" } } },
    until: { kind: "ore-hold-at-least", fraction: 0.9 },
  };
  const sentence = stepSentence(step);
  assert.match(sentence, /Mine at the ore site the scanner shows/);
  assert.doesNotMatch(sentence, /\bbelt\b/i);
});

test("a site-mode travel-to-belt step reads as a trip, not an arrival, and never says belt", () => {
  // travel-to-belt only ever WARPS somewhere and stops; it never mines, so a
  // site-mode sentence has to say where the ship is headed, not where it
  // already is — "the ship is in" would be a lie for a block that has not
  // arrived yet.
  const step: MacroStep = {
    id: "s1",
    kind: "macro",
    macro: "travel-to-belt",
    args: { belt: { kind: "belt", belt: { mode: "site" } } },
  };
  const sentence = stepSentence(step);
  assert.match(sentence, /Fly to the ore site the scanner shows/);
  assert.doesNotMatch(sentence, /\bbelt\b/i);
});

test("mine-at-belt's palette name no longer promises just a belt", () => {
  // It used to read "Mine at a belt" — accurate when "nearest" and "chosen"
  // were the only two modes, and a lie of omission now that "site" tours the
  // scanner's ore sites and never sits down on a belt at all.
  assert.match(macroName("mine-at-belt"), /belt/i);
  assert.match(macroName("mine-at-belt"), /ore site/i);
});

test("each rock order says which one it is, in the player's own words", () => {
  const mine = (pick: RockPick): string =>
    stepSentence({
      id: "s1",
      kind: "macro",
      macro: "mine-at-belt",
      args: { belt: { kind: "belt", belt: { mode: "nearest" } }, pick: { kind: "rockPick", pick } },
      until: { kind: "ore-hold-at-least", fraction: 0.9 },
    });
  assert.match(mine("biggest"), /Mine at the nearest belt, biggest rocks first/);
  assert.match(mine("valuable"), /Mine at the nearest belt, most valuable ore first/);
  // The default says nothing extra: it is what the block always did.
  assert.match(mine("nearest"), /Mine at the nearest belt until/);
});

test("a mining step with an ore priority list names it, in order", () => {
  const step: MacroStep = {
    id: "s1",
    kind: "macro",
    macro: "mine-at-belt",
    args: {
      belt: { kind: "belt", belt: { mode: "nearest" } },
      ores: {
        kind: "oreList",
        ores: [
          { groupID: 462, name: "Veldspar" },
          { groupID: 465, name: "Kernite" },
        ],
      },
    },
    until: { kind: "ore-hold-at-least", fraction: 0.9 },
  };
  const sentence = stepSentence(step);
  assert.match(sentence, /Mine at the nearest belt, Veldspar then Kernite first/);
});

test("a mining step with no ore priority list (or an empty one) says nothing about ore order", () => {
  const withoutOres: MacroStep = {
    id: "s1",
    kind: "macro",
    macro: "mine-at-belt",
    args: { belt: { kind: "belt", belt: { mode: "nearest" } } },
    until: { kind: "ore-hold-at-least", fraction: 0.9 },
  };
  assert.doesNotMatch(stepSentence(withoutOres), /first/);

  const withEmptyOres: MacroStep = {
    id: "s1",
    kind: "macro",
    macro: "mine-at-belt",
    args: {
      belt: { kind: "belt", belt: { mode: "nearest" } },
      ores: { kind: "oreList", ores: [] },
    },
    until: { kind: "ore-hold-at-least", fraction: 0.9 },
  };
  assert.doesNotMatch(stepSentence(withEmptyOres), /first/);
});

test("a chosen world slot shows its name, never its id (R7d)", () => {
  const named: MacroStep = {
    id: "s1",
    kind: "macro",
    macro: "deliver-ore",
    args: {
      station: { kind: "station", ref: { entity: "station", id: 60000004, name: "Home Station", systemName: "Aunia" } },
    },
  };
  assert.match(stepSentence(named), /Home Station/);
  assert.doesNotMatch(stepSentence(named), LOOKS_LIKE_ID);

  // A reference with an id but no resolved name must fall back to words, not the number.
  const unnamed: MacroStep = {
    id: "s2",
    kind: "macro",
    macro: "deliver-ore",
    args: {
      station: { kind: "station", ref: { entity: "station", id: 60000004, name: null, systemName: null } },
    },
  };
  assert.doesNotMatch(stepSentence(unnamed), LOOKS_LIKE_ID);
  assert.match(stepSentence(unnamed), /a station you pick/);
});

test("a corporation hangar is named in the sentence, by NAME where there is one", () => {
  const station = { kind: "station", ref: { entity: "station", id: 60000004, name: "Home Station", systemName: null } } as const;
  const named: MacroStep = {
    id: "s1",
    kind: "macro",
    macro: "deliver-ore",
    args: { station, into: { kind: "corpDivision", division: 3, name: "Ore Buffer" } },
  };
  assert.match(stepSentence(named), /Home Station and put it in the corporation's Ore Buffer/);

  // No name learned yet — a script written elsewhere, an office never opened.
  // "division 3" is the division's own name in an office nobody renamed, which
  // is why it is words here and not a bare id.
  const unnamed: MacroStep = {
    id: "s2",
    kind: "macro",
    macro: "deliver-ore",
    args: { station, into: { kind: "corpDivision", division: 3, name: null } },
  };
  assert.match(stepSentence(unnamed), /the corporation's division 3/);

  // And a plain delivery says nothing about a corporation at all.
  const plain: MacroStep = { id: "s3", kind: "macro", macro: "deliver-ore", args: { station } };
  assert.doesNotMatch(stepSentence(plain), /corporation/);
});

test("a combat step with a target priority names it, in order and in play words", () => {
  const step: MacroStep = {
    id: "s1",
    kind: "macro",
    macro: "fight-the-rats",
    args: { targets: { kind: "targetList", classes: ["tackle", "ewar"] } },
  };
  assert.match(stepSentence(step), /Fight the rats until the grid is clear, tacklers then jammers first/);
  const hunt: MacroStep = {
    id: "s2",
    kind: "macro",
    macro: "fight-the-rats",
    args: { targets: { kind: "targetList", classes: ["logi"] } },
  };
  assert.match(stepSentence(hunt), /logistics first/);
});

test("a combat step at the default ladder says nothing about order", () => {
  const bare: MacroStep = { id: "s1", kind: "macro", macro: "fight-the-rats", args: {} };
  assert.doesNotMatch(stepSentence(bare), /first/);
  const emptied: MacroStep = {
    id: "s2",
    kind: "macro",
    macro: "fight-the-rats",
    args: { targets: { kind: "targetList", classes: [] } },
  };
  assert.doesNotMatch(stepSentence(emptied), /first/);
});

test("a combat step flying with the fleet says which part it plays", () => {
  const calling: MacroStep = {
    id: "s1",
    kind: "macro",
    macro: "fight-the-rats",
    args: { squad: { kind: "squadRole", role: "call" } },
  };
  assert.match(stepSentence(calling), /calling the primary for the fleet/);

  const following: MacroStep = {
    id: "s2",
    kind: "macro",
    macro: "fight-the-rats",
    args: { squad: { kind: "squadRole", role: "follow" } },
  };
  assert.match(stepSentence(following), /on the fleet's primary/);

  const alone: MacroStep = {
    id: "s3",
    kind: "macro",
    macro: "fight-the-rats",
    args: { squad: { kind: "squadRole", role: "off" } },
  };
  assert.doesNotMatch(stepSentence(alone), /fleet/, "flying alone is the default and says nothing");
});

test("a tackled watch names the consequence, so the wrong response reads wrong", () => {
  // ⚠ THIS IS THE STEER, AND IT IS THE ONLY ONE THERE IS. The format does not
  // police which response goes with which condition. What stops a player wiring
  // the row that killed a ship on 2026-09-14 is that the whole sentence gives
  // the game away: naming "cannot warp out" inside the condition makes a dock
  // response contradict itself in the same breath.
  const clause = conditionSentence({ kind: "tackled" });
  assert.match(clause, /cannot warp out/);

  const fights = interruptSentence({ id: "w1", when: { kind: "tackled" }, respond: "fight-back" });
  assert.match(fights, /cannot warp out, harden up, fight back/);

  // The pairing is still REPRESENTABLE — nothing here forbids it — and it reads
  // as the contradiction it is.
  const docks = interruptSentence({ id: "w2", when: { kind: "tackled" }, respond: "dock-and-repair" });
  assert.match(docks, /cannot warp out, dock at home/);
});

test("only the tackled check carries advice, and it points at fighting back", () => {
  const advice = conditionAdvice("tackled");
  assert.ok(advice !== null);
  assert.match(advice, /cannot warp/i);
  assert.match(advice, /Fight back/);
  // Plain ASCII, like every other player-facing string here: printable only, so
  // no dash or quote a screen reader has to spell out sneaks in.
  assert.doesNotMatch(advice, /[^ -~]/, "no decoration a screen reader has to spell out");
  for (const kind of CONDITION_KINDS) {
    if (kind !== "tackled") {
      assert.equal(conditionAdvice(kind), null, `${kind} should need no advice`);
    }
  }
});

test("a fight-back watch says how it fights, and an ordinary one still does not", () => {
  const coordinated = interruptSentence({
    id: "w1",
    when: { kind: "hostile-on-grid" },
    respond: "fight-back",
    squad: "call",
    targets: ["tackle"],
  });
  assert.match(coordinated, /If a pirate shows up/i);
  assert.match(coordinated, /tacklers first/);
  assert.match(coordinated, /calling the primary for the fleet/);

  const plain = interruptSentence({ id: "w2", when: { kind: "hostile-on-grid" }, respond: "fight-back" });
  assert.doesNotMatch(plain, /fleet|first/);
});
