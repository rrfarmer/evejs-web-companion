import test from "node:test";
import assert from "node:assert/strict";
import { decodeAgencySeason, decodeAgencySeasonChoices, decodeAgencySeasonProgress, seasonPageKind } from "./agencySeason.ts";

const keyVal = (entries: unknown[]) => ({ type: "object", name: "util.KeyVal", args: { type: "dict", entries } });

test("template 2216 selects the active Vanguard page; the previous template and no selection do not", () => {
  const end = "134500000000000000";
  const season = keyVal([["template_id", 2216], ["title", 125], ["end_time", { type: "long", value: end }]]);
  const decoded = decodeAgencySeason({ result: season });
  assert.equal(decoded?.titleID, 125);
  assert.equal(decoded?.endMs, Number((BigInt(end) - 116444736000000000n) / 10000n));
  assert.equal(seasonPageKind(decoded?.templateID ?? null), "vanguard");
  assert.equal(seasonPageKind(2200), "season");
  assert.equal(decodeAgencySeason({ type: "list", items: [season] }), null);
  assert.equal(decodeAgencySeason(null), null);
});

test("a real season selection list keeps the wire IDs and candidate card rather than selecting it", () => {
  const choice = keyVal([["season_id", 900129], ["template_id", 900128], ["agency_card_title", 1900128101],
    ["agency_card_hint", 1900128102], ["multiple_season_running", true],
    ["navigation_card_picture_path", "res:/UI/Texture/classes/Seasons/Agency/NavigationCard/season-selectioncard-soraya_250x666.png"]]);
  const list = { type: "list", items: [choice, keyVal([["template_id", 900128]])] };
  assert.equal(decodeAgencySeason(list), null);
  const choices = decodeAgencySeasonChoices({ result: list });
  assert.equal(choices.length, 1);
  assert.equal(choices[0]?.seasonID, 900129);
  assert.equal(choices[0]?.cardTitleID, 1900128101);
  assert.equal(choices[0]?.cardHintID, 1900128102);
  assert.equal(choices[0]?.multiple, true);
  assert.deepEqual(decodeAgencySeasonChoices([choice]), []);
});

test("season progress decodes the ObjectEx2 challenge state and leaves expired challenges out", () => {
  const fields = [["name", 123], ["message_text", 456], ["progress", 1], ["max_progress", 5], ["points_awarded", 20]];
  const challenge = (entries: unknown[]) => ({ type: "objectex2", header: [
    [{ type: "token", value: "seasons.common.challenge.Challenge" }], { type: "dict", entries },
  ], list: [], dict: [] });
  const progress = keyVal([["seasonal_points", 40], ["max_seasonal_points", 300], ["challenges", {
    type: "dict", entries: [[101, challenge(fields)], [102, challenge([...fields, ["is_expired", true]])],
      [103, challenge([...fields, ["is_dormant", true]])]],
  }]]);
  assert.deepEqual(decodeAgencySeasonProgress(progress), { points: 40, target: 300,
    challenges: [{ id: 101, name: 123, detail: 456, current: 1, target: 5, points: 20 }] });
});
