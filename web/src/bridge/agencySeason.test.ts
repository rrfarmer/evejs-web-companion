import test from "node:test";
import assert from "node:assert/strict";
import { decodeAgencySeason, decodeAgencySeasonChoices, decodeAgencySeasonProgress, decodeAgencySeasonReward,
  isVanguardTrackCompleted, seasonPageKind, seasonRewardClaimable, VANGUARD_TRACK_COMPLETED } from "./agencySeason.ts";

const keyVal = (entries: unknown[]) => ({ type: "object", name: "util.KeyVal", args: { type: "dict", entries } });

test("template 2216 selects the active Vanguard page; the previous template and no selection do not", () => {
  const end = "134500000000000000";
  const season = keyVal([["template_id", 2216], ["title", 125], ["end_time", { type: "long", value: end }]]);
  const decoded = decodeAgencySeason({ result: season });
  assert.equal(decoded?.titleID, 125);
  assert.equal(decoded?.autoClaim, false);
  assert.equal(decoded?.endMs, Number((BigInt(end) - 116444736000000000n) / 10000n));
  assert.equal(seasonPageKind(decoded?.templateID ?? null), "vanguard");
  assert.equal(seasonPageKind(2200), "season");
  assert.equal(decodeAgencySeason({ type: "list", items: [season] }), null);
  assert.equal(decodeAgencySeason(null), null);
});

test("automatic milestone and Vanguard notices use their native wire fields", () => {
  const season = keyVal([["template_id", 2216], ["is_auto_claim_enabled", true]]);
  assert.equal(decodeAgencySeason(season)?.autoClaim, true);
  const reward = { type: "dict", entries: [
    ["points_required", 50], ["reward_type_id", 92181], ["reward_amount", 1], ["omega_only", true], ["claimed", false],
  ] };
  assert.deepEqual(decodeAgencySeasonReward(0, reward),
    { index: 0, points: 50, typeID: 92181, quantity: 1, omegaOnly: true, claimed: false });
  assert.equal(decodeAgencySeasonReward(-1, reward), null);
  assert.equal(isVanguardTrackCompleted(VANGUARD_TRACK_COMPLETED, { instance: { sequential: 1337 } }), true);
  assert.equal(isVanguardTrackCompleted(VANGUARD_TRACK_COMPLETED, { instance: { sequential: 1338 } }), false);
  assert.equal(isVanguardTrackCompleted(VANGUARD_TRACK_COMPLETED, null), false);
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
    seasonID: null, rewards: [], challenges: [{ id: 101, name: 123, detail: 456, current: 1, target: 5, points: 20,
      isk: 0, typeID: null, quantity: 0, claimable: false, expiresMs: null }] });
});

test("season rewards preserve index zero, clone eligibility and the server's challenge claim date", () => {
  const dict = (entries: unknown[]) => ({ type: "dict", entries });
  const goal = (points: number, omega: boolean, claimed: boolean) => dict([
    ["points_required", points], ["reward_type_id", 92181], ["reward_amount", 1], ["omega_only", omega], ["claimed", claimed],
  ]);
  const timestamp = { type: "long", value: "134500000000000000" };
  const task = (id: number, rewardDate: unknown, finishDate: unknown) => ({ type: "objectex2", header: [
    [{ type: "token", value: "seasons.common.challenge.Challenge" }], dict([
      ["challenge_id", id], ["name", 123], ["progress", 1], ["max_progress", 1], ["points_awarded", 10],
      ["reward_date", rewardDate], ["finish_date", finishDate],
    ]),
  ], list: [], dict: [] });
  const progress = decodeAgencySeasonProgress(keyVal([
    ["season_id", 900129], ["seasonal_points", 90], ["max_seasonal_points", 1500],
    ["seasonal_goals", dict([[1, goal(90, true, false)], [2, goal(130, false, true)], [0, goal(50, false, false)]])],
    ["challenges", dict([[101, task(101, timestamp, null)], [102, task(102, null, null)], [103, task(103, timestamp, timestamp)]])],
  ]));
  assert.ok(progress);
  assert.equal(progress.seasonID, 900129);
  assert.deepEqual(progress.rewards.map((reward) => reward.index), [0, 1, 2]);
  assert.equal(seasonRewardClaimable(progress.rewards[0]!, 49, true), false);
  assert.equal(seasonRewardClaimable(progress.rewards[0]!, 50, false), true);
  assert.equal(seasonRewardClaimable(progress.rewards[1]!, 90, false), false);
  assert.equal(seasonRewardClaimable(progress.rewards[1]!, 90, true), true);
  assert.equal(seasonRewardClaimable(progress.rewards[2]!, 130, true), false);
  assert.deepEqual(progress.challenges.map((challenge) => challenge.claimable), [true, false, false]);
});
