import test from "node:test";
import assert from "node:assert/strict";

import { combatSiteSuggestions, decodeSiteList, encodeSiteList, siteBaseName, siteListHas, siteListWords, siteNameAllowed } from "./siteNames.ts";

test("the faction word comes off, longest first", () => {
  assert.equal(siteBaseName("Angel Haven"), "haven");
  assert.equal(siteBaseName("Serpentis Forsaken Sanctum"), "forsaken sanctum");
  assert.equal(siteBaseName("Blood Raider Forlorn Den"), "forlorn den", "both words of Blood Raider, not just Blood");
  assert.equal(siteBaseName("Blood Burrow"), "burrow");
  assert.equal(siteBaseName("  Guristas   Rally  Point "), "rally point");
  assert.equal(siteBaseName("Drone Patrol"), "drone patrol", "a rogue drone site has no faction word");
  assert.equal(siteBaseName("Angel"), "angel", "a bare faction word is kept whole");
});

test("only: one name covers every faction's site of that name", () => {
  const list = { mode: "only" as const, names: ["Haven"] };
  assert.equal(siteNameAllowed("Angel Haven", list), true);
  assert.equal(siteNameAllowed("Serpentis Haven", list), true);
  assert.equal(siteNameAllowed("Angel Sanctum", list), false);
  assert.equal(siteNameAllowed("Drone Patrol", list), false);
});

test("a name is matched WHOLE: Sanctum is not Forsaken Sanctum, Den is not a harder Den", () => {
  const sanctum = { mode: "only" as const, names: ["Sanctum"] };
  assert.equal(siteNameAllowed("Guristas Sanctum", sanctum), true);
  assert.equal(siteNameAllowed("Guristas Forsaken Sanctum", sanctum), false);
  const den = { mode: "only" as const, names: ["den"] };
  for (const harder of ["Angel Hidden Den", "Angel Forsaken Den", "Angel Forlorn Den"]) {
    assert.equal(siteNameAllowed(harder, den), false, harder);
  }
  assert.equal(siteNameAllowed("Angel Den", den), true, "and case does not matter");
});

test("a full name typed with its faction still means every faction", () => {
  assert.equal(siteNameAllowed("Sansha Haven", { mode: "only", names: ["Angel Haven"] }), true);
});

test("skip: every site but the listed ones", () => {
  const list = { mode: "skip" as const, names: ["Den", "Drone Gathering"] };
  assert.equal(siteNameAllowed("Angel Den", list), false);
  assert.equal(siteNameAllowed("Drone Gathering", list), false);
  assert.equal(siteNameAllowed("Angel Hidden Den", list), true);
  assert.equal(siteNameAllowed("Angel Haven", list), true);
});

test("no list, or an empty one, allows everything, named or not", () => {
  assert.equal(siteNameAllowed("Angel Haven", null), true);
  assert.equal(siteNameAllowed(null, null), true);
  assert.equal(siteNameAllowed(null, { mode: "only", names: [] }), true);
});

test("with a list set, a site with no name is never allowed, in either mode", () => {
  assert.equal(siteNameAllowed(null, { mode: "only", names: ["Haven"] }), null);
  assert.equal(siteNameAllowed(null, { mode: "skip", names: ["Den"] }), null);
  assert.equal(siteNameAllowed("   ", { mode: "skip", names: ["Den"] }), null);
});

test("the list in words keeps the player's spelling", () => {
  assert.equal(siteListWords({ mode: "only", names: ["Haven"] }), "only Haven");
  assert.equal(siteListWords({ mode: "only", names: ["Haven", "Sanctum", "Drone Patrol"] }), "only Haven, Sanctum or Drone Patrol");
  assert.equal(siteListWords({ mode: "skip", names: ["Den", "Hub"] }), "except Den and Hub");
});

test("the board copy round-trips, and anything else reads as no list", () => {
  const list = { mode: "skip" as const, names: ["Den", "Hub"] };
  assert.deepEqual(decodeSiteList(encodeSiteList(list)), list);
  assert.equal(encodeSiteList(null), "");
  assert.equal(encodeSiteList({ mode: "only", names: [] }), "");
  assert.equal(decodeSiteList(""), null);
  assert.equal(decodeSiteList(undefined), null);
  assert.equal(decodeSiteList("not json"), null);
  assert.equal(decodeSiteList(JSON.stringify({ mode: "sometimes", names: ["Den"] })), null);
  assert.equal(decodeSiteList(JSON.stringify({ mode: "only", names: [" ", 3] })), null);
});

test("the picker suggests ladder sites by what was typed, and none for an empty box", () => {
  assert.deepEqual(combatSiteSuggestions("", []), []);
  const sanctums = combatSiteSuggestions("sanct", []).map((hit) => hit.name);
  assert.deepEqual(sanctums, ["Sanctum", "Forsaken Sanctum"]);
  assert.equal(combatSiteSuggestions("patrol", [])[0]?.note, "level 9 rogue drone site");
  assert.equal(combatSiteSuggestions("teeming", [])[0]?.note, "level 10+ rogue drone site");
});

test("a site already listed is not suggested again, however it was spelled", () => {
  assert.deepEqual(combatSiteSuggestions("haven", ["Angel Haven"]), []);
  assert.equal(siteListHas(["Angel Haven"], "serpentis haven"), true);
  assert.equal(siteListHas(["Sanctum"], "Forsaken Sanctum"), false);
});
