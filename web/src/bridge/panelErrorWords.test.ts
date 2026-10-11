import test from "node:test";
import assert from "node:assert/strict";
import { panelErrorWords } from "./refusals.ts";
import { BridgeCallError } from "./callMethod.ts";

test("a transport failure is worded plainly, then explained", () => {
  const error = new BridgeCallError(
    "BRIDGE_NETWORK_ERROR",
    "/api/bridge/journal could not reach the BFF: signal timed out",
    0,
    "All 4 request lanes were busy and the oldest had been waiting 41s.",
  );
  const words = panelErrorWords(error);
  assert.match(words, /connection to the server dropped/);
  assert.match(words, /oldest had been waiting 41s/, "the evidence must survive");
  assert.doesNotMatch(words, /api\/bridge/, "a player must not be shown an internal route");
  assert.doesNotMatch(words, /BRIDGE_NETWORK_ERROR/, "nor a wire code");
});

test("a game refusal keeps its plain words and gains no noise", () => {
  const error = new BridgeCallError("NOT_IN_SPACE", "whatever the wire said", 409);
  assert.equal(panelErrorWords(error), "Your ship is docked. Undock before doing that.");
});

test("something that is not one of ours still says SOMETHING", () => {
  assert.equal(panelErrorWords(new Error("decode blew up")), "decode blew up");
  assert.ok(panelErrorWords(null).length > 0, "an empty panel is worse than a clumsy sentence");
  assert.ok(panelErrorWords(new Error("   ")).length > 0);
});

test("a call the server refused is worded by its reason, which rides in the message: the envelope is no reason", () => {
  const refused = (message: string) => panelErrorWords(new BridgeCallError("CALL_REFUSED", message, 409));
  // A key the table has a sentence for.
  assert.equal(refused("CrpAccessDenied"), "Your corporation roles do not let you do that.");
  // The server's own sentence stands as it came.
  assert.equal(refused("You do not have the required roles."), "You do not have the required roles.");
  // A key nobody has put into words is still a sentence, and shows neither the key nor the envelope.
  for (const message of ["SomeKeyNobodyWorded", "", "   ", "CALL_REFUSED"]) {
    const words = refused(message);
    assert.ok(words.length > 0, JSON.stringify(message));
    assert.doesNotMatch(words, /CALL_REFUSED|SomeKeyNobodyWorded/, JSON.stringify(message));
  }
  // What was learnt of the lanes still follows the sentence.
  assert.equal(
    panelErrorWords(new BridgeCallError("CALL_REFUSED", "CrpAccessDenied", 409, "The oldest request had been waiting 41s.")),
    "Your corporation roles do not let you do that. The oldest request had been waiting 41s.",
  );
});

test("a code that is a reason is worded by itself, whatever its message says", () => {
  // A message that reads as a sentence must not stand in for the code's own: only the refusal's envelope hands
  // its message on.
  assert.equal(panelErrorWords(new BridgeCallError("NOT_IN_SPACE", "You do not have the required roles.", 409)), "Your ship is docked. Undock before doing that.");
  // Nor does a code nobody has words for: its message may name a route, and is not shown.
  const unworded = panelErrorWords(new BridgeCallError("SOMETHING_NEW" as never, "The journal could not be reached.", 502));
  assert.doesNotMatch(unworded, /journal|SOMETHING_NEW/);
  assert.equal(unworded, panelErrorWords(new BridgeCallError("SOMETHING_NEW" as never, "", 502)));
});
