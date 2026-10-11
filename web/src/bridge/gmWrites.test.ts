// A GM's command sent by the page itself.

import test from "node:test";
import assert from "node:assert/strict";

import { runSlashCommand } from "./gmWrites.ts";

function harness(reply: unknown = "Gave 1 x Tritanium.", refusal: Error | null = null) {
  const asked: unknown[][] = [];
  const act = async (...call: unknown[]) => { asked.push(call); if (refusal) throw refusal; return reply as never; };
  return { asked, act };
}

test("a command is sent by one call of the slash service: its one line, as it was typed", async () => {
  for (const line of ["/giveitem Phased Plasma S 5000", ".container1", "/"]) {
    const { asked, act } = harness();
    assert.equal(await runSlashCommand(act, line), "Gave 1 x Tritanium.");
    // sm.RemoteSvc('slash').SlashCmd(line).
    assert.deepEqual(asked, [["slash", "SlashCmd", [line]]], line);
  }
});

test("the space round a command is taken off, and the command itself is not touched", async () => {
  const { asked, act } = harness();

  await runSlashCommand(act, "   /giveitem   Phased Plasma S   5000  ");

  assert.deepEqual(asked, [["slash", "SlashCmd", ["/giveitem   Phased Plasma S   5000"]]]);
});

test("the world's reply is handed on as it came, its refusals among them; a reply that is no text is none", async () => {
  // eve.js answers a command it could not run with a sentence, and does not refuse the call.
  assert.equal(await runSlashCommand(harness("Command failed: Unknown item 'Nonexistent Thing'.").act, "/giveitem Nonexistent Thing"), "Command failed: Unknown item 'Nonexistent Thing'.");
  for (const reply of [null, undefined, 42, true, ["Gave"], { message: "Gave" }]) {
    // (Answered here and not by the harness, whose answer of nothing is its usual one.)
    assert.equal(await runSlashCommand(async () => reply as never, "/heal"), "", JSON.stringify(reply));
  }
});

test("what is no command is refused here and asks nothing: the server would answer it with its whole list", async () => {
  for (const [line, words] of [
    ["", /A command is required\./],
    ["   ", /A command is required\./],
    ["giveitem Phased Plasma S", /A GM command starts with \/ \(or \. for the container commands\)\./],
    ["hello", /A GM command starts with \//],
    ["  help /me", /A GM command starts with \//],
  ] as const) {
    const { asked, act } = harness();
    await assert.rejects(runSlashCommand(act, line), words, JSON.stringify(line));
    assert.deepEqual(asked, [], JSON.stringify(line));
  }
});

test("a call the server refuses is the caller's, as it came", async () => {
  await assert.rejects(runSlashCommand(harness(null, new Error("Commands: ['/help']")).act, "/"), /Commands: \['\/help'\]/);
});
