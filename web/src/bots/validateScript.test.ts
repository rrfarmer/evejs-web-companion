// C2 — the editor's draft validator. A complete draft has no problems; each way
// of being incomplete produces one plain sentence anchored to the right row.

import test from "node:test";
import assert from "node:assert/strict";

import type { BotScript, CoreMacroID, MacroID, MacroStep, ProgramNode } from "./botScript.ts";
import { MACRO_SPECS } from "./macroSpecs.ts";
import { validateScript, type ScriptProblem } from "./validateScript.ts";

// A complete, ready-to-start draft: a loop of [mine until full, haul], with the
// safety floor and a bound home.
function ready(): BotScript {
  return {
    format: "evejs-bot-script", version: 1, name: "Belt runner", notes: "",
    home: { entity: "station", id: 60000004, name: "Home", systemName: "Aunia" },
    interrupts: [{ id: "floor", when: { kind: "health-below", fraction: 0.5 }, respond: "dock-and-pause" }],
    program: [
      {
        id: "L", kind: "loop", repeat: { kind: "times", count: 50 },
        body: [
          {
            id: "m", kind: "macro", macro: "mine-at-belt",
            args: {
              belt: { kind: "belt", belt: { mode: "nearest" } },
              equipment: { kind: "equipment", equipment: { groupID: 17482, label: "Strip Miners" } },
            },
            until: { kind: "ore-hold-at-least", fraction: 0.9 },
          },
          {
            id: "h", kind: "macro", macro: "deliver-ore",
            args: { station: { kind: "station", ref: { entity: "station", id: 60000004, name: "Home", systemName: "Aunia" } } },
          },
        ],
      },
    ],
  };
}

function paths(problems: readonly ScriptProblem[]): string[] {
  return problems.map((p) => p.path);
}

test("a complete draft has no problems", () => {
  assert.deepEqual(validateScript(ready()), []);
});

test("Distribution finder accepts legacy defaults and blocks invalid explicit policy", () => {
  const finder = (args: MacroStep["args"]): BotScript => ({ ...ready(), program: [
    { id: "finder", kind: "macro", macro: "find-distribution-agent", args },
  ] });
  assert.deepEqual(validateScript(finder({})), []);
  assert.deepEqual(validateScript(finder({ level: { kind: "count", value: 4 },
    fallback: { kind: "toggle", enabled: true } })), []);
  assert.ok(validateScript(finder({ level: { kind: "count", value: 5 } }))
    .some((problem) => problem.path === "finder" && problem.severity === "blocking"));
  assert.ok(validateScript(finder({ fallback: { kind: "toggle", enabled: "yes" } as unknown as MacroStep["args"][string] }))
    .some((problem) => problem.path === "finder" && problem.severity === "blocking"));
});

test("a blank name and unbound home are each flagged, and both are blocking", () => {
  const draft = { ...ready(), name: "  ", home: { entity: "station" as const, id: null, name: null, systemName: null } };
  const problems = validateScript(draft);
  assert.deepEqual(paths(problems).sort(), ["home", "name"]);
  assert.ok(problems.every((p) => p.severity === "blocking"));
});

test("a board-slot home is a runtime binding, not an unbound home", () => {
  const draft: BotScript = {
    ...ready(),
    home: {
      entity: "station",
      id: null,
      name: null,
      systemName: null,
      slot: "dropoff-station",
    },
  };
  assert.equal(validateScript(draft).some((problem) => problem.path === "home"), false);
});

test("an exact sub-bot scriptID is sufficient even if its display hint is absent", () => {
  const draft: BotScript = {
    ...ready(),
    program: [{ id: "include", kind: "sub-bot", scriptID: "script-123", name: null }],
  };
  assert.equal(validateScript(draft).some((problem) => problem.path === "include"), false);
});

test("an empty program is flagged, and it is blocking", () => {
  const draft = { ...ready(), program: [] };
  const problem = validateScript(draft).find((p) => p.path === "program");
  assert.ok(problem);
  assert.equal(problem.severity, "blocking");
});

test("a mining step without equipment is fine — the bot auto-uses fitted miners", () => {
  const draft = ready();
  const loop = draft.program[0];
  assert.ok(loop && loop.kind === "loop");
  const mine = loop.body[0] as MacroStep;
  const stripped = { ...mine, args: { belt: mine.args["belt"] } } as MacroStep;
  const withStripped: BotScript = {
    ...draft,
    program: [{ ...loop, body: [stripped, loop.body[1] as MacroStep] }],
  };
  assert.deepEqual(validateScript(withStripped), [], "equipment is optional now");
});

test("a mining step with no until is flagged — blocking, since mine-at-belt declares untilRequired", () => {
  const draft = ready();
  const loop = draft.program[0];
  assert.ok(loop && loop.kind === "loop");
  const mine = loop.body[0] as MacroStep;
  const noUntil: MacroStep = { id: mine.id, kind: "macro", macro: "mine-at-belt", args: mine.args };
  const draft2: BotScript = { ...draft, program: [{ ...loop, body: [noUntil, loop.body[1] as MacroStep] }] };
  const problem = validateScript(draft2).find((p) => p.path === "m" && /stop it/i.test(p.sentence));
  assert.ok(problem);
  assert.equal(problem.severity, "blocking");
  assert.equal(MACRO_SPECS["mine-at-belt"].untilRequired, true, "the blocking classification tracks this flag");
});

// ⚠ A PINNED BELT IS IDENTIFIED BY ITS NAME, NOT ITS ID, and the validator has
// to ask for the same thing the runtime uses. Belt entity ids are grid-local,
// so `beltTarget` re-matches the NAME against the grid the bot arrives at — and
// a belt the player names by hand has no id at all. This used to demand an id,
// which would have blocked every typed belt.

function withBelt(draft: BotScript, belt: unknown): BotScript {
  const loop = draft.program[0];
  assert.ok(loop && loop.kind === "loop");
  const mine = loop.body[0] as MacroStep;
  const step: MacroStep = { ...mine, args: { ...mine.args, belt: belt as MacroStep["args"][string] } };
  return { ...draft, program: [{ ...loop, body: [step, loop.body[1] as MacroStep] }] };
}

function beltProblem(draft: BotScript) {
  return validateScript(draft).find((p) => p.path === "m" && /belt/i.test(p.sentence) && p.severity === "blocking");
}

test("a belt pinned with no name asks for one, but nearest does not", () => {
  const unnamed = withBelt(ready(), {
    kind: "belt",
    belt: { mode: "chosen", ref: { entity: "belt", id: null, name: null, systemName: null } },
  });
  const problem = beltProblem(unnamed);
  assert.ok(problem);
  assert.equal(problem.severity, "blocking");

  // Blank and whitespace-only are the same thing to a player, so they are the
  // same thing here: neither could ever match a belt on the grid.
  assert.ok(beltProblem(withBelt(ready(), {
    kind: "belt",
    belt: { mode: "chosen", ref: { entity: "belt", id: null, name: "   ", systemName: null } },
  })));

  assert.equal(beltProblem(ready()), undefined, "the nearest belt needs nothing picked");
});

test("a belt named by hand is complete, with no id and no system", () => {
  // What the editor writes when a player types a belt name: the name alone.
  // Nothing else is knowable while configuring a bot for a system the pilot is
  // not in, and nothing else is used when it gets there.
  const typed = withBelt(ready(), {
    kind: "belt",
    belt: {
      mode: "chosen",
      ref: { entity: "belt", id: null, name: "Test System VI - Asteroid Belt 1", systemName: null },
    },
  });
  assert.equal(beltProblem(typed), undefined);
});

test("an out-of-range threshold is flagged", () => {
  const draft = ready();
  const loop = draft.program[0];
  assert.ok(loop && loop.kind === "loop");
  const mine = loop.body[0] as MacroStep;
  const tooFull: MacroStep = { ...mine, until: { kind: "ore-hold-at-least", fraction: 0.99 } };
  const draft2: BotScript = { ...draft, program: [{ ...loop, body: [tooFull, loop.body[1] as MacroStep] }] };
  const problem = validateScript(draft2).find((p) => p.path === "m" && /between/i.test(p.sentence));
  assert.ok(problem);
  assert.equal(problem.severity, "blocking");
});

test("a deliver step with an unbound station is flagged", () => {
  const draft = ready();
  const loop = draft.program[0];
  assert.ok(loop && loop.kind === "loop");
  const haul = loop.body[1] as MacroStep;
  const unbound: MacroStep = { ...haul, args: { station: { kind: "station", ref: { entity: "station", id: null, name: null, systemName: null } } } };
  const draft2: BotScript = { ...draft, program: [{ ...loop, body: [loop.body[0] as MacroStep, unbound] }] };
  const problem = validateScript(draft2).find((p) => p.path === "h" && /pick the station/i.test(p.sentence));
  assert.ok(problem);
  assert.equal(problem.severity, "blocking");
});

// ── Advisories (bot-builder-interface.md §5.4: two severities) ──────────────
// Advisories describe a bot that runs as written but looks unwise. None of
// them may ever disable Start, so every assertion below checks `severity`
// explicitly rather than just presence.

test("a bot that runs once and never leaves the station is NOT nagged about watches", () => {
  // Deliberately no blanket "you have no watches" advisory. Watches are the
  // wrong answer for a bot that docks, unloads and stops — the shipped
  // "Operations closeout" example is exactly that, and warning on correct work
  // teaches a player to ignore advisories. The real risk (repeating with no way
  // to stop) is caught per-loop instead, where it can be said precisely.
  const draft: BotScript = { ...ready(), interrupts: [] };
  assert.equal(
    validateScript(draft).some((p) => p.path === "watches"),
    false,
    "no blanket watches advisory",
  );
});

test("a forever loop with no until and no watch anywhere is advisory", () => {
  const draft: BotScript = {
    ...ready(),
    interrupts: [],
    program: [
      { id: "L", kind: "loop", repeat: { kind: "forever" }, body: [{ id: "u", kind: "macro", macro: "undock", args: {} }] },
    ],
  };
  const problems = validateScript(draft);
  const loopProblem = problems.find((p) => p.path === "L");
  assert.ok(loopProblem);
  assert.equal(loopProblem.severity, "advisory");
  assert.ok(problems.every((p) => p.severity === "advisory"), "nothing about this draft is fatal");
});

test("a forever loop with its own until does not need a watch to stop it", () => {
  const draft: BotScript = {
    ...ready(),
    interrupts: [],
    program: [
      {
        id: "L",
        kind: "loop",
        repeat: { kind: "forever" },
        until: { kind: "hold-empty" },
        body: [{ id: "u", kind: "macro", macro: "undock", args: {} }],
      },
    ],
  };
  const problems = validateScript(draft);
  assert.equal(problems.some((p) => p.path === "L"), false, "the loop's own until can stop it");
});

test("a forever loop is fine when the bot has a watch elsewhere", () => {
  const draft: BotScript = {
    ...ready(),
    program: [
      { id: "L", kind: "loop", repeat: { kind: "forever" }, body: [{ id: "u", kind: "macro", macro: "undock", args: {} }] },
    ],
  };
  assert.deepEqual(validateScript(draft), []);
});

// ── ARG_LABEL sweep — the bug this pass fixes ────────────────────────────────
// ARG_LABEL used to be missing `fitting`, `bookmark`, `from` and `to`, so a
// draft missing one of those produced the literal, useless sentence "This step
// needs something it needs." This sweep drives every required arg of every
// macro in MACRO_SPECS through the missing-arg path and asserts a real label
// came out — so the next macro added with a required arg and no label fails
// here instead of reaching a player.
test("every required arg on every macro gets a real label, never 'something it needs'", () => {
  for (const macro of Object.keys(MACRO_SPECS) as CoreMacroID[]) {
    const spec = MACRO_SPECS[macro];
    const requiredKeys = spec.args.filter((a) => a.required).map((a) => a.key);
    if (requiredKeys.length === 0) continue;

    const step: MacroStep = { id: `step-${macro}`, kind: "macro", macro, args: {} };
    const draft: BotScript = { ...ready(), program: [step] };
    const stepProblems = validateScript(draft).filter((p) => p.path === step.id);

    assert.ok(
      stepProblems.length >= requiredKeys.length,
      `${macro}: expected a problem per required arg (${requiredKeys.join(", ")}), got ${stepProblems.length}`,
    );
    for (const problem of stepProblems) {
      assert.ok(problem.sentence.trim().length > 0, `${macro} produced an empty sentence`);
      assert.doesNotMatch(problem.sentence, /something it needs/, `${macro}: "${problem.sentence}"`);
    }
  }
});
